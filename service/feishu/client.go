//go:build feishu

// client.go —— 飞书长连接客户端
//
// 用 SDK 的 Channel 模块承载传输（WebSocket 长连接 + 事件分发 + 消息归一化），
// 不自己实现 WS 层：opencode-feishu-bot 里的 Lark.WSClient + EventDispatcher
// 在 Go 侧已有对应实现，且长连接不需要公网 webhook。
//
// 卡片更新走 SDK 原始 API（Channel 不暴露 update），并在此处做限流识别，
// 与 pacer.go 的退避配合。
package feishu

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	lark "github.com/larksuite/oapi-sdk-go/v3"
	"github.com/larksuite/oapi-sdk-go/v3/channel"
	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher"
	larkimv1 "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
)

// MaxCardBytes 是飞书对更新卡片消息的硬上限。
//
// 官方文档明确：更新的卡片消息最大不能超过 30 KB，且含大量样式标签时
// 实际消息体会大于输入的请求体长度。超限会导致整次更新失败——
// 而流式回复累积到长文时必然触顶，故必须在本地截断并显式标注，
// 不能指望服务端截断（那会得到一个残缺的卡片，且无任何提示）。
const MaxCardBytes = 30 * 1024

// Config 是飞书连接配置。
//
// 凭据与 opencode-feishu-bot **各用各的飞书应用**：两者同时对同一个
// OpenCode 服务工作，若共用同一 app_id，长连接会让两个程序各自收到
// 同一批消息并互相重复回复。
type Config struct {
	AppID     string
	AppSecret string
}

// MessageHandler 处理收到的消息。
type MessageHandler func(ctx context.Context, msg *types.NormalizedMessage)

// CardActionHandler 处理卡片按钮点击。
type CardActionHandler func(ctx context.Context, event *types.CardActionEvent)

// RejectHandler 处理被 SDK 策略丢弃的消息。
//
// ⚠️ 这类消息**不会**进 MessageHandler：不注册它，被丢弃的消息
// 就是彻底消失。SDK 在派发前有三道静默过滤，其中 PolicyGate 对群聊
// 默认要求 @机器人——不接这个回调，「群里发消息没反应」将无法诊断。
type RejectHandler func(ctx context.Context, event *types.RejectEvent)

// StateHandler 处理连接状态变化。
type StateHandler func(state State)

// State 是连接状态。
type State string

const (
	StateIdle         State = "idle"
	StateConnecting   State = "connecting"
	StateReady        State = "ready"
	StateReconnecting State = "reconnecting"
	StateDisconnected State = "disconnected"
	StateFailed       State = "failed"
)

// Client 是飞书长连接客户端。
//
// 生命周期：New → StartAsync → （收发）→ Stop。
// Start 不可重复调用；停止后需新建 Client（底层 WebSocket 进入终态）。
type Client struct {
	appID     string
	appSecret string

	api *lark.Client
	ws  *larkws.Client
	ch  types.Channel

	mu      sync.Mutex
	started bool
	state   State
	cancel  context.CancelFunc
	done    chan struct{}

	onMessage    MessageHandler
	onCardAction CardActionHandler
	onState      StateHandler
	onReject     RejectHandler

	// sleep 可注入，便于测试限流退避
	sleep func(ctx context.Context, d time.Duration) error
}

// New 建一个未启动的客户端。
func New(cfg Config) (*Client, error) {
	if cfg.AppID == "" || cfg.AppSecret == "" {
		return nil, fmt.Errorf("飞书应用凭据缺失（app_id / app_secret）")
	}
	return &Client{
		appID:     cfg.AppID,
		appSecret: cfg.AppSecret,
		state:     StateIdle,
		sleep:     defaultSleep,
	}, nil
}

// StartAsync 建立长连接并在后台维持。
//
// ch.Start 会阻塞整个 WebSocket 生命周期，因此必须放后台；
// 阻塞式调用会把 OC Manager 的主流程一起卡住。
func (c *Client) StartAsync(ctx context.Context) error {
	c.mu.Lock()
	if c.started {
		c.mu.Unlock()
		return fmt.Errorf("飞书客户端已启动，不可重复 Start")
	}
	c.started = true
	c.mu.Unlock()

	// 用独立 ctx：调用方传入的 ctx 常常是短生命周期的请求 ctx，
	// 不能让它决定长连接的存亡。
	connCtx, cancel := context.WithCancel(context.Background())
	c.mu.Lock()
	c.cancel = cancel
	c.done = make(chan struct{})
	done := c.done
	c.mu.Unlock()

	c.setState(StateConnecting)
	c.build()

	// 透传 app 级取消：调用方 ctx 结束时应一并关闭长连接
	go func() {
		select {
		case <-ctx.Done():
			_ = c.Stop(context.Background())
		case <-done:
		}
	}()

	go func() {
		defer close(done)
		if err := c.ch.Start(connCtx); err != nil && connCtx.Err() == nil {
			log.Printf("[feishu] 长连接异常结束: %v", err)
			c.setState(StateFailed)
		}
	}()

	return nil
}

// build 组装 SDK 客户端与 Channel，并挂上各类回调。
func (c *Client) build() {
	api := lark.NewClient(c.appID, c.appSecret)

	// ⚠️ 必须显式创建 dispatcher 并用 WithEventHandler 注入。
	//
	// larkws.NewClient 不传 option 时 eventHandler 为 nil，而
	// EventHandler() 只是原样返回它。于是 channel 的
	// ensureMessageHandler 里 `if dispatcher != nil` 判定失败，
	// **OnMessage 处理器永远不会被注册**——连接能建立、能鉴权、
	// 状态一切正常，但所有进来的事件都因找不到处理器被丢弃。
	// 症状是「日志干净、一条消息都收不到」，且没有任何报错指向这里。
	//
	// （SDK 自己的 channel_lifecycle_test.go 也没传 WithEventHandler，
	//  但那个测试只验 OnReady/OnDisconnected，不验消息派发，
	//  所以这条路径在 SDK 内部从未被覆盖。）
	//
	// 卡片回调同理：它走 dispatcher 的 callback 通道，
	// 没有 dispatcher 就一并失效。
	eventDispatcher := dispatcher.NewEventDispatcher("", "")
	ws := larkws.NewClient(c.appID, c.appSecret,
		larkws.WithEventHandler(eventDispatcher))
	ch := channel.NewChannel(api, ws)

	c.api = api
	c.ws = ws
	c.ch = ch

	ch.OnReady(func() { c.setState(StateReady) })
	ch.OnReconnecting(func() { c.setState(StateReconnecting) })
	ch.OnReconnected(func() { c.setState(StateReady) })
	ch.OnDisconnected(func() { c.setState(StateDisconnected) })
	ch.OnError(func(err error) {
		log.Printf("[feishu] 连接错误: %v", err)
		c.setState(StateFailed)
	})

	ch.OnMessage(func(ctx context.Context, msg *types.NormalizedMessage) error {
		if h := c.messageHandler(); h != nil {
			h(ctx, msg)
		}
		return nil
	})

	ch.OnCardAction(func(ctx context.Context, event *types.CardActionEvent) error {
		if h := c.cardActionHandler(); h != nil {
			h(ctx, event)
		}
		return nil
	})

	// ⚠️ 这条不是可选的。SDK 在派发给 OnMessage **之前**有三道静默过滤
	// （PolicyGate / IsStale / dedupCache），任一不满足就直接丢弃、
	// 不报错、不打日志。其中 PolicyGate 对**群聊默认要求 @机器人**
	// （RequireMention 为 nil 时按 true 处理），所以群里发一条没 @ 的
	// 消息会毫无征兆地消失——不接 OnReject 的话，现象就是
	// 「连接正常、日志干净、一条消息都收不到」，且无从下手查。
	ch.OnReject(func(ctx context.Context, event *types.RejectEvent) error {
		logf("消息被策略丢弃 chat=%s sender=%s reason=%s msg=%s",
			event.ChatID, event.SenderID, event.Reason, event.MessageID)
		if h := c.rejectHandler(); h != nil {
			h(ctx, event)
		}
		return nil
	})
}

// Stop 关闭长连接并等待其退出。
func (c *Client) Stop(ctx context.Context) error {
	c.mu.Lock()
	if !c.started {
		c.mu.Unlock()
		return nil
	}
	c.started = false
	cancel := c.cancel
	done := c.done
	c.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	c.setState(StateIdle)

	if done != nil {
		select {
		case <-done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

// IsRunning 是否已启动。
func (c *Client) IsRunning() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.started
}

// State 返回当前连接状态。
func (c *Client) State() State {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state
}

func (c *Client) setState(s State) {
	c.mu.Lock()
	c.state = s
	h := c.onState
	c.mu.Unlock()
	if h != nil {
		h(s)
	}
}

// OnMessage 注册消息回调。
func (c *Client) OnMessage(h MessageHandler) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onMessage = h
}

func (c *Client) messageHandler() MessageHandler {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.onMessage
}

// OnCardAction 注册卡片回调。
func (c *Client) OnCardAction(h CardActionHandler) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onCardAction = h
}

func (c *Client) cardActionHandler() CardActionHandler {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.onCardAction
}

// OnState 注册连接状态回调。
func (c *Client) OnState(h StateHandler) {
	c.mu.Lock()
	c.onState = h
	c.mu.Unlock()
}

// OnReject 注册「被策略丢弃的消息」回调。
//
// 不注册不是「少个功能」，而是这类消息彻底消失且无迹可寻。
func (c *Client) OnReject(h RejectHandler) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onReject = h
}

func (c *Client) rejectHandler() RejectHandler {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.onReject
}

// ============ 发送 ============

// SendText 发送纯文本，返回消息 ID。
func (c *Client) SendText(ctx context.Context, chatID, text string) (string, error) {
	if chatID == "" {
		return "", fmt.Errorf("缺少 chatID")
	}
	res, err := c.ch.Send(ctx, &types.SendInput{ChatID: chatID, Text: text})
	if err != nil {
		return "", fmt.Errorf("发送文本失败: %w", err)
	}
	if res == nil {
		return "", fmt.Errorf("发送文本失败：空响应")
	}
	if res.Error != nil {
		return "", fmt.Errorf("发送文本失败: %w", res.Error)
	}
	return res.MessageID, nil
}

// SendMarkdown 发送 markdown 文本。
//
// 零**生产**调用方（桥接层的回复一律走卡片），但 client_test.go 用它
// 锁「缺 chatID 必须报错」这条入参校验——删掉它那条校验就没了测法。
func (c *Client) SendMarkdown(ctx context.Context, chatID, md string) (string, error) {
	if chatID == "" {
		return "", fmt.Errorf("缺少 chatID")
	}
	res, err := c.ch.Send(ctx, &types.SendInput{ChatID: chatID, Markdown: md})
	if err != nil {
		return "", fmt.Errorf("发送 markdown 失败: %w", err)
	}
	if res == nil || res.Error != nil {
		return "", fmt.Errorf("发送 markdown 失败：%v", errorOf(res))
	}
	return res.MessageID, nil
}

// SendCard 发送卡片，返回消息 ID。
//
// 卡片超过 MaxCardBytes 时会**先截断并标注**再发送：超限的服务端表现为
// 整次请求失败，用户看到的是「没有反应」而不是「内容太长」。
func (c *Client) SendCard(ctx context.Context, chatID string, card *Card) (string, error) {
	if chatID == "" {
		return "", fmt.Errorf("缺少 chatID")
	}
	if card == nil {
		return "", fmt.Errorf("卡片为空")
	}
	payload, err := marshalCard(card)
	if err != nil {
		return "", err
	}
	res, err := c.ch.Send(ctx, &types.SendInput{ChatID: chatID, Card: payload})
	if err != nil {
		return "", fmt.Errorf("发送卡片失败: %w", err)
	}
	if res == nil || res.Error != nil {
		return "", fmt.Errorf("发送卡片失败：%v", errorOf(res))
	}
	return res.MessageID, nil
}

// UpdateCard 更新已发送的卡片。
//
// 返回的 SendResult 里 RateLimited 用于配合 RenderWithRetry 做退避重试——
// 飞书对同一消息的卡片更新限流为 5 次/秒，流式回复极易触发。
func (c *Client) UpdateCard(ctx context.Context, messageID string, card *Card) (SendResult, error) {
	if messageID == "" {
		return SendResult{}, fmt.Errorf("缺少 messageID")
	}
	if card == nil {
		return SendResult{}, fmt.Errorf("卡片为空")
	}
	payload, err := marshalCard(card)
	if err != nil {
		return SendResult{}, err
	}
	if c.api == nil {
		return SendResult{}, fmt.Errorf("客户端未初始化")
	}

	req := larkimv1.NewPatchMessageReqBuilder().
		MessageId(messageID).
		Body(&larkimv1.PatchMessageReqBody{Content: &payload}).
		Build()
	resp, err := c.api.Im.Message.Patch(ctx, req)
	if err != nil {
		return SendResult{}, err
	}
	if resp.Success() {
		return SendResult{Success: true}, nil
	}
	return SendResult{
		Success:     false,
		RateLimited: resp.Code == RateLimitError,
	}, fmt.Errorf("更新卡片失败: code=%d msg=%s", resp.Code, resp.Msg)
}

// DeleteMessage 撤回消息。
func (c *Client) DeleteMessage(ctx context.Context, messageID string) error {
	if messageID == "" {
		return fmt.Errorf("缺少 messageID")
	}
	if c.api == nil {
		return fmt.Errorf("客户端未初始化")
	}
	req := larkimv1.NewDeleteMessageReqBuilder().MessageId(messageID).Build()
	if _, err := c.api.Im.Message.Delete(ctx, req); err != nil {
		return fmt.Errorf("撤回消息失败: %w", err)
	}
	return nil
}

// ============ 内部工具 ============

// 截断标记。截断必须留痕：否则用户看到的是一段不完整的内容，
// 却以为这就是全部，会基于残缺信息做判断。
const truncationNote = "\n…（内容过长已截断）"

// marshalCard 序列化卡片，并在超限时截断正文后重新序列化。
//
// 截断策略：逐轮把**最长的** markdown 内容砍半，直到落进 30KB 上限。
// 不按元素遍历只试一轮——单条超长回复（常见的形态）砍一次一半仍可能超限，
// 那样会原样发出一个服务端必然拒收的卡片，用户看到的是「卡片不动了」。
//
// 截断只改副本，绝不就地修改调用方持有的卡片，否则复用该卡片的逻辑
// 会拿到一份被砍过的内容。
func marshalCard(card *Card) (string, error) {
	raw, err := card.JSON()
	if err != nil {
		return "", err
	}
	if len(raw) <= MaxCardBytes {
		return raw, nil
	}

	// 深拷贝 Body.Elements，避免改到调用方的切片
	trimmed := *card
	trimmed.Body = card.Body
	trimmed.Body.Elements = append([]Element(nil), card.Body.Elements...)

	// 每一轮砍掉当前最长的 markdown 的一半，直到落进限制。
	// 上限 20 轮是防御性的：即使内容全删也应早已落进限制。
	for round := 0; round < 20; round++ {
		idx := -1
		longest := 0
		for i := range trimmed.Body.Elements {
			el := &trimmed.Body.Elements[i]
			if el.Tag != "markdown" {
				continue
			}
			if n := len(el.Content); n > longest {
				longest, idx = n, i
			}
		}
		// 没有可砍的 markdown 了（仍超限说明是固定结构开销），放弃
		if idx < 0 {
			break
		}

		el := &trimmed.Body.Elements[idx]
		if longest <= len(truncationNote) {
			// 已经砍到只剩标记，再砍无意义
			break
		}
		el.Content = el.Content[:longest/2] + truncationNote

		out, err := trimmed.JSON()
		if err != nil {
			return "", err
		}
		if len(out) <= MaxCardBytes {
			return out, nil
		}
	}

	out, err := trimmed.JSON()
	if err != nil {
		return "", err
	}
	return out, nil
}

func errorOf(res *types.SendResult) error {
	if res == nil {
		return fmt.Errorf("空响应")
	}
	return res.Error
}

// MustMarshal 把任意值转成 JSON 字符串，失败返回 "{}"。
// 用于卡片按钮的 value —— 结构简单且已在调用处构造，不必层层传 error。
//
// 零**生产**调用方，client_test.go 里有一条专门锁它的测试
// （尤其是「不可序列化的值回退 {} 而不是 panic」这条）。
func MustMarshal(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}
