// bridge_live_test.go —— 桥接层无头连通性测试
//
// 目的：在不启动 GUI、不动用户正在运行的 OC Manager 的前提下，
// 验证「飞书消息 → 门禁 → 命令分发 → 真实 OpenCode → 回飞书」整条链路。
//
// 用法：
//
//	$env:OC_FEISHU_APP_ID = "cli_xxx"
//	$env:OC_FEISHU_APP_SECRET = "xxx"
//	$env:OC_FEISHU_LIVE_SECONDS = "300"    # 监听时长，默认 60 秒
//	$env:OC_FEISHU_DEFAULT_PROJECT = "E:\work\bmall"
//	go test ./service/feishu/ -run TestBridgeLive -v -timeout 8m
//
// 之所以做成测试而不是命令行程序：它需要真实凭据与真实 opencode 服务，
// 放进 _test.go 就不会被打进发布二进制，也不会被误当成正式入口。

package feishu

import (
	"context"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
)

// liveOutput 把回执**真的发回飞书**，同时打进测试日志。
//
// ⚠️ 早期版本这里用的是纯 logger（只打日志、不发飞书）。于是测试输出里
// 明明写着「回文本 ✅」，用户在飞书里却什么都没收到，而我据此汇报成
// 「回执已发出」——那是一次误报。
//
// 根因是把「回执被构造出来」当成了「回执被送达」：两者之间隔着一次
// 网络调用，而那次调用当时根本没发生。教训是**验证送达就必须用真实传输**，
// 用替身验证发送等于没验证。
//
// 现在发送失败直接让测试失败：发不出去却报成功，等于用绿色日志掩盖断链。
type liveOutput struct {
	t      *testing.T
	client *Client
	mu     sync.Mutex
	count  int
	failed int
}

func newLiveOutput(t *testing.T, c *Client) *liveOutput {
	return &liveOutput{t: t, client: c}
}

func (l *liveOutput) SendText(ctx context.Context, chatID, text string) (string, error) {
	id, err := l.client.SendText(ctx, chatID, text)
	if err != nil {
		l.mu.Lock()
		l.failed++
		l.mu.Unlock()
		l.t.Errorf("❌ 发送文本失败 chat=%s: %v", chatID, err)
		return "", err
	}
	l.mu.Lock()
	l.count++
	l.mu.Unlock()
	l.t.Logf("✅ 已发送文本 chat=%s message_id=%s\n%s", chatID, id, text)
	return id, nil
}

func (l *liveOutput) SendCard(ctx context.Context, chatID string, card *Card) (string, error) {
	id, err := l.client.SendCard(ctx, chatID, card)
	if err != nil {
		l.mu.Lock()
		l.failed++
		l.mu.Unlock()
		l.t.Errorf("❌ 发送卡片失败 chat=%s: %v", chatID, err)
		return "", err
	}
	raw, _ := card.JSON()
	l.mu.Lock()
	l.count++
	l.mu.Unlock()
	l.t.Logf("✅ 已发送卡片 chat=%s message_id=%s\n%s", chatID, id, raw)
	return id, nil
}

func (l *liveOutput) counts() (n, failed int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.count, l.failed
}

func TestBridgeLive(t *testing.T) {
	appID, appSecret, ok := liveCreds()
	if !ok {
		t.Skip("未设置 OC_FEISHU_APP_ID / OC_FEISHU_APP_SECRET，跳过")
	}

	seconds := 60
	if v := os.Getenv("OC_FEISHU_LIVE_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			seconds = n
		}
	}
	project := os.Getenv("OC_FEISHU_DEFAULT_PROJECT")
	allowAll := os.Getenv("OC_FEISHU_ALLOW_ALL") != "0"

	client, err := New(Config{AppID: appID, AppSecret: appSecret})
	if err != nil {
		t.Fatalf("创建客户端失败: %v", err)
	}

	// ⚠️ Output 用**真实客户端**，不是日志替身——见 liveOutput 的说明。
	out := newLiveOutput(t, client)
	bridge := NewBridge(
		NewRealOpenCode(),
		out,
		NewSessionMap(""), // 内存态：测试不污染用户的真实映射
		NewWhitelist(""),
		BridgeConfig{
			AllowAllUsers:  allowAll,
			DefaultProject: project,
			DefaultModel:   os.Getenv("OC_FEISHU_DEFAULT_MODEL"),
		},
	)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ready := make(chan struct{})
	var once sync.Once
	client.OnState(func(s State) {
		t.Logf("连接状态: %s", s)
		if s == StateReady {
			once.Do(func() { close(ready) })
		}
	})

	var msgMu sync.Mutex
	var received []string

	client.OnMessage(func(ctx context.Context, msg *types.NormalizedMessage) {
		text := strings.TrimSpace(msg.Content)
		for _, m := range msg.Mentions {
			if m.IsBot {
				text = strings.ReplaceAll(text, m.Key, "")
				if m.Name != "" {
					text = strings.ReplaceAll(text, m.Name, "")
				}
			}
		}
		text = strings.TrimSpace(text)

		msgMu.Lock()
		received = append(received, text)
		msgMu.Unlock()

		t.Logf("◀ 收到 [chat=%s user=%s]: %q", msg.ChatID, msg.UserID, text)

		bridge.HandleMessage(ctx, IncomingMessage{
			ChatID:  msg.ChatID,
			UserID:  msg.UserID,
			Text:    text,
			IsGroup: msg.ChatType == "group",
		})
	})

	client.OnCardAction(func(ctx context.Context, ev *types.CardActionEvent) {
		t.Logf("◀ 卡片点击 [chat=%s user=%s] value=%v form=%v",
			ev.ChatID, ev.Operator.OpenID, ev.Action.Value, ev.Action.FormValue)
		bridge.HandleCardAction(ctx, CardAction{
			ChatID:    ev.ChatID,
			UserID:    ev.Operator.OpenID,
			MessageID: ev.MessageID,
			Value:     ev.Action.Value,
			FormValue: ev.Action.FormValue,
			FormName:  ev.Action.Name,
		})
	})

	if err := client.StartAsync(ctx); err != nil {
		t.Fatalf("启动长连接失败: %v", err)
	}
	defer client.Stop(context.Background())

	select {
	case <-ready:
		t.Log("✅ 长连接就绪，开始监听飞书消息")
	case <-time.After(45 * time.Second):
		t.Fatal("长连接未就绪")
	}

	if allowAll {
		t.Log("⚠️ 当前为放行态（allow_all_users=true）：任何能给本应用发消息的飞书用户都能驱动 OpenCode")
	}
	t.Logf("请在飞书里给本应用发送命令。监听 %d 秒。", seconds)

	heartbeat := time.NewTicker(30 * time.Second)
	defer heartbeat.Stop()
	deadline := time.After(time.Duration(seconds) * time.Second)

	// 收到第一条消息是否提前结束。默认否——
	// 上一轮默认开启，第一条进来就把进程关了，用户随后发的命令全打空。
	exitAfterFirst := os.Getenv("OC_FEISHU_EXIT_AFTER_FIRST") == "1"

loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case <-heartbeat.C:
			msgMu.Lock()
			n := len(received)
			msgMu.Unlock()
			sent, failed := out.counts()
			t.Logf("⏱ 仍在监听（收到 %d 条 / 已回执 %d 条 / 发送失败 %d 条）", n, sent, failed)
			if exitAfterFirst && n > 0 {
				break loop
			}
		case <-deadline:
			break loop
		}
	}

	msgMu.Lock()
	n := len(received)
	msgMu.Unlock()
	sent, failed := out.counts()
	t.Logf("── 结束：收到 %d 条消息，实际发出 %d 条回执，失败 %d 条 ──", n, sent, failed)

	// 有消息却没有回执 = 链路在某处静默断了
	if n > 0 && sent == 0 {
		t.Error("收到消息但没有任何回执：桥接链路存在静默中断")
	}
	if failed > 0 {
		t.Errorf("有 %d 条回执发送失败", failed)
	}
	if n == 0 {
		t.Log("（本次未收到任何消息——只验证了连接建立，消息链路未覆盖）")
	}
}
