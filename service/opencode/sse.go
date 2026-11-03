// Package service 处理 OpenCode serve 进程管理、API 代理、SSE 事件流、会话 CRUD、项目树构建和终端启动。
package opencode

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"oc-manager/model"
)

var (
	eventMu           sync.Mutex
	eventStop         context.CancelFunc
	eventAlive        bool // 当前转发是否已成功连接（幂等判断依据）
	eventGen          int  // 转发代数：旧协程的迟到回调不再影响新连接
	browserSSEMu      sync.Mutex
	browserSSENextID  int
	browserSSEClients = map[int]chan BrowserSSEEvent{}
)

type BrowserSSEEvent struct {
	Name string
	Data string
}

// DesktopEmitter 抽象桌面端（Wails）的事件发射能力，避免本包直接依赖具体 GUI 框架。
// main 包在应用启动时通过 SetDesktopEmitter 注入实现（内部调用 application.App.Event.Emit）。
type DesktopEmitter interface {
	Emit(name string, data ...any)
}

// desktopEmitter 当前注入的桌面事件发射器；为 nil 时（纯 Web 模式）事件仅走浏览器通道。
var desktopEmitter DesktopEmitter

// SetDesktopEmitter 注入桌面事件发射器（由 main 包在 application.New 之后调用）。
func SetDesktopEmitter(e DesktopEmitter) {
	desktopEmitter = e
}

// emitToDesktop 向桌面端发射事件；未注入发射器时静默跳过，保证纯 Web 模式可用。
func emitToDesktop(name string, data any) {
	if desktopEmitter != nil {
		desktopEmitter.Emit(name, data)
	}
}

const (
	// browserSSEBufferSize 是每个浏览器 SSE 客户端的缓冲深度。
	// 原值 32 在消息密集时（思考/正文/工具会产生大量 part 事件）极易被填满：
	// 一旦消费端（浏览器网络）稍慢，缓冲即溢出，旧实现会静默剔除该客户端，
	// 造成前端丢事件却无从感知，残缺缓存（缺 text part）就此长期停留在界面上。
	// 提升到 256 显著降低触发概率；真正溢出时由 sse-lagged 通知 + 前端全量补齐兜底。
	browserSSEBufferSize = 256
	// sseLaggedEventName 是「客户端已滞后、事件即将丢失」的显式通知事件名。
	// 服务端在剔除慢客户端前尽力投递一条该事件，让前端明确知道自己丢过事件，
	// 从而主动触发一次 loadMessages() 全量补齐，而不是停在残缺缓存上。
	sseLaggedEventName = "sse-lagged"
)

// StartOpenCodeEvents 连接 opencode 全局 SSE，并通过桌面事件与浏览器 SSE 双通道转发给前端。
//
// 幂等：已有健康连接时直接返回，不掐断重建。前端每个窗口/页面各有一份
// backendStarted 标记（模块级），多窗口场景下若每次调用都重建，
// 重建间隙内的事件会丢失，表现为消息正文/思考过程残缺。
func StartOpenCodeEvents() model.APIResult {
	if getWebSession() == nil {
		return model.APIResult{Error: "opencode 服务未启动"}
	}

	eventMu.Lock()
	// 已连接：直接复用
	if eventStop != nil && eventAlive {
		eventMu.Unlock()
		return model.APIResult{Success: true, Status: 200}
	}
	// 存在但未连接（正在退避重试 / 已断开）：停掉旧协程后重建
	if eventStop != nil {
		eventStop()
	}
	sseCtx, cancel := context.WithCancel(context.Background())
	eventGen++
	gen := eventGen
	eventStop = cancel
	eventAlive = false
	eventMu.Unlock()

	go forwardEvents(sseCtx, gen)
	return model.APIResult{Success: true, Status: 200}
}

// forwardEvents 维护「OpenCode → 前端」的 SSE 转发，断线后指数退避重连。
// ctx 由 StartOpenCodeEvents / StopOpenCodeEvents 控制，取消后立即退出。
func forwardEvents(ctx context.Context, gen int) {
	backoff := time.Second
	// hasConnected 记录是否曾经成功连上：之后的成功连接视为「重连」，
	// 需要通知前端全量补齐断线期间丢失的事件。
	hasConnected := false
	for {
		if ctx.Err() != nil {
			return
		}
		// 每轮重新读取会话：OpenCode 被外部重启后端口/口令可能变化
		sess := getWebSession()
		if sess == nil {
			setEventAlive(gen, false)
			if !sleepWithContext(ctx, backoff) {
				return
			}
			backoff = nextEventBackoff(backoff)
			continue
		}

		connected := streamEventsOnce(ctx, sess, gen, hasConnected)
		if ctx.Err() != nil {
			return
		}
		if connected {
			hasConnected = true
		}
		setEventAlive(gen, false)
		// 曾成功连上：从最小间隔重新开始，避免正常断线后等很久
		if connected {
			backoff = time.Second
		}
		if !sleepWithContext(ctx, backoff) {
			return
		}
		backoff = nextEventBackoff(backoff)
	}
}

// streamEventsOnce 建立一次 SSE 连接并阻塞读取，返回是否成功连上过。
// isReconnect 为 true 表示此前已连上过：连接成功后广播 sse-lagged，
// 让前端全量补齐断线期间丢掉的事件（否则卡片会停在残缺状态）。
func streamEventsOnce(ctx context.Context, sess *webSession, gen int, isReconnect bool) bool {
	// v1 为 /global/event，v2 收拢到 /api/event，且与普通 API 一样需要 Basic 认证
	url := fmt.Sprintf("http://%s:%d/api/event", sess.hostname, sess.port)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		reportEventError(err.Error())
		return false
	}
	applyAuth(req, sess.password)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		reportEventError(err.Error())
		return false
	}
	defer resp.Body.Close()

	// 认证失败或路径不存在时 v2 会回落到 SPA 首页（200 + HTML），
	// 此时没有任何 data: 行，前端表现为「连上了但收不到事件」，需显式报错。
	if resp.StatusCode != http.StatusOK {
		reportEventError(fmt.Sprintf("事件流连接失败: HTTP %d", resp.StatusCode))
		return false
	}
	if isHTMLResponse(resp.Header.Get("Content-Type")) {
		reportEventError("事件流连接失败：OpenCode v2 未提供 /api/event 端点（返回了网页内容）")
		return false
	}

	setEventAlive(gen, true)

	// 重连成功：断线期间的事件已永久丢失，通知前端全量补齐一次。
	// 浏览器端已在 events.js 监听 sse-lagged；桌面端订阅同一事件名。
	if isReconnect {
		const reconnectPayload = `{"reason":"reconnected"}`
		emitToDesktop("sse-lagged", reconnectPayload)
		broadcastBrowserSSE("sse-lagged", reconnectPayload)
	}

	scanner := bufio.NewScanner(resp.Body)
	buf := make([]byte, 0, 64*1024)
	// 单行 SSE 数据可能携带大消息/大工具结果（如整文件内容、超长 JSON），
	// 默认 64KB 会频繁触发 token too long；上限放宽到 100MB。
	scanner.Buffer(buf, 100*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data:") {
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			emitToDesktop("oc-event", payload)
			broadcastBrowserSSE("oc-event", payload)
		}
	}
	if err := scanner.Err(); err != nil && ctx.Err() == nil {
		reportEventError(err.Error())
	}
	return true
}

// reportEventError 同时通知桌面与浏览器通道。
func reportEventError(msg string) {
	emitToDesktop("oc-event-error", msg)
	broadcastBrowserSSE("oc-event-error", msg)
}

// setEventAlive 仅在「当前代数」仍有效时更新连接状态，
// 避免旧协程退出过程中的迟到回调污染新连接的状态。
func setEventAlive(gen int, alive bool) {
	eventMu.Lock()
	if eventGen == gen {
		eventAlive = alive
	}
	eventMu.Unlock()
}

// nextEventBackoff 指数退避，上限 30 秒。
func nextEventBackoff(d time.Duration) time.Duration {
	next := d * 2
	if next > 30*time.Second {
		return 30 * time.Second
	}
	return next
}

// sleepWithContext 可被 ctx 取消的等待；返回 false 表示已被取消。
func sleepWithContext(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// StopOpenCodeEvents 停止 SSE 转发。
func StopOpenCodeEvents() model.APIResult {
	eventMu.Lock()
	if eventStop != nil {
		eventStop()
		eventStop = nil
	}
	eventAlive = false
	// 代数 +1：旧协程退出过程中若还有迟到回调，不再影响新状态
	eventGen++
	eventMu.Unlock()
	return model.APIResult{Success: true, Status: 200}
}

func SubscribeBrowserSSE() (int, <-chan BrowserSSEEvent) {
	browserSSEMu.Lock()
	defer browserSSEMu.Unlock()
	browserSSENextID++
	id := browserSSENextID
	ch := make(chan BrowserSSEEvent, browserSSEBufferSize)
	browserSSEClients[id] = ch
	return id, ch
}

func UnsubscribeBrowserSSE(id int) {
	browserSSEMu.Lock()
	ch := browserSSEClients[id]
	delete(browserSSEClients, id)
	browserSSEMu.Unlock()
	if ch != nil {
		close(ch)
	}
}

func broadcastBrowserSSE(name, data string) {
	browserSSEMu.Lock()
	defer browserSSEMu.Unlock()
	for id, ch := range browserSSEClients {
		select {
		case ch <- BrowserSSEEvent{Name: name, Data: data}:
		default:
			// 缓冲已满：该客户端消费过慢，已滞后，即将被剔除。
			// 剔除前必须先显式通知前端（否则它会拿着残缺缓存却毫不知情）。
			// 但由于缓冲此刻是满的，通知本身也塞不进去，因此先丢弃一条最旧的积压事件
			// 腾出槽位（丢弃的增量由前端随后的全量补齐覆盖，不会造成最终数据缺失），再投递通知。
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- BrowserSSEEvent{Name: sseLaggedEventName, Data: `{"reason":"buffer overflow"}`}:
			default:
			}
			close(ch)                     // 前端读到流结束会触发 EventSource 自动重连并重新订阅
			delete(browserSSEClients, id) // 直接剔除客户端
		}
	}
}

func FormatBrowserSSE(event BrowserSSEEvent) string {
	// browserSSENextID 由 browserSSEMu 保护（SubscribeBrowserSSE 中自增），
	// 此处读取必须持同一把锁，否则与订阅端的自增构成数据竞争。
	browserSSEMu.Lock()
	nextID := browserSSENextID
	browserSSEMu.Unlock()

	var b strings.Builder
	b.WriteString("event: ")
	b.WriteString(event.Name)
	b.WriteString("\n")
	for _, line := range strings.Split(event.Data, "\n") {
		b.WriteString("data: ")
		b.WriteString(line)
		b.WriteString("\n")
	}
	b.WriteString("id: ")
	b.WriteString(strconv.FormatInt(int64(nextID), 10))
	b.WriteString("\n\n")
	return b.String()
}
