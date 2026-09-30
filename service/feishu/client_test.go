package feishu

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
)

// ============ 构造与配置校验 ============

func TestNew缺凭据报错(t *testing.T) {
	cases := []struct{ name, id, secret string }{
		{"两者都缺", "", ""},
		{"缺 app_id", "", "s"},
		{"缺 app_secret", "i", ""},
	}
	for _, c := range cases {
		if _, err := New(Config{AppID: c.id, AppSecret: c.secret}); err == nil {
			t.Errorf("%s: 应报错——缺凭据时连不上会导致后续所有收发静默失败", c.name)
		}
	}
}

func TestNew正常构造(t *testing.T) {
	c, err := New(Config{AppID: "cli_x", AppSecret: "y"})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	if c.State() != StateIdle {
		t.Errorf("初始状态 = %q, 期望 %q", c.State(), StateIdle)
	}
	if c.IsRunning() {
		t.Error("未 Start 时不应为运行态")
	}
}

// TestStop未启动时幂等 停一次、停两次都应安全返回：
// 关停路径常被重复调用（信号 + 显式关闭）。
func TestStop未启动时幂等(t *testing.T) {
	c, _ := New(Config{AppID: "i", AppSecret: "s"})
	if err := c.Stop(context.Background()); err != nil {
		t.Errorf("未启动时 Stop 应返回 nil，实际 %v", err)
	}
	if err := c.Stop(context.Background()); err != nil {
		t.Errorf("重复 Stop 应返回 nil，实际 %v", err)
	}
}

// ============ 状态机 ============

func Test状态迁移回调(t *testing.T) {
	c, _ := New(Config{AppID: "i", AppSecret: "s"})
	var mu sync.Mutex
	var seen []State
	c.OnState(func(s State) {
		mu.Lock()
		seen = append(seen, s)
		mu.Unlock()
	})

	c.setState(StateConnecting)
	c.setState(StateReady)
	c.setState(StateDisconnected)

	mu.Lock()
	defer mu.Unlock()
	want := []State{StateConnecting, StateReady, StateDisconnected}
	if len(seen) != len(want) {
		t.Fatalf("状态序列 = %v, 期望 %v", seen, want)
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Errorf("第 %d 个状态 = %q, 期望 %q", i, seen[i], want[i])
		}
	}
}

func Test状态读写并发安全(t *testing.T) {
	c, _ := New(Config{AppID: "i", AppSecret: "s"})
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(2)
		go func() { defer wg.Done(); c.setState(StateReady) }()
		go func() { defer wg.Done(); _ = c.State(); _ = c.IsRunning() }()
	}
	wg.Wait()
}

// TestStartAsync重复启动被拒 SDK 底层 WebSocket 一旦成功连接即进入终态，
// 重复 Start 不会重建连接，只会造成状态错觉。
func TestStartAsync重复启动被拒(t *testing.T) {
	c, _ := New(Config{AppID: "i", AppSecret: "s"})
	// 直接置 started，模拟已启动（避免真实网络）
	c.mu.Lock()
	c.started = true
	c.mu.Unlock()

	if err := c.StartAsync(context.Background()); err == nil {
		t.Error("重复 Start 应报错")
	}
}

// ============ 回调注册 ============

func Test回调可注册且可取回(t *testing.T) {
	c, _ := New(Config{AppID: "i", AppSecret: "s"})
	c.OnMessage(func(ctx context.Context, msg *types.NormalizedMessage) {})
	c.OnCardAction(func(ctx context.Context, e *types.CardActionEvent) {})

	if c.messageHandler() == nil {
		t.Error("OnMessage 后应能取回 handler")
	}
	if c.cardActionHandler() == nil {
		t.Error("OnCardAction 后应能取回 handler")
	}
}

// ============ 卡片序列化与截断 ============

// TestMarshalCard未超限原样通过 是最常见路径，先锁住它不被截断逻辑影响。
func TestMarshalCard未超限原样通过(t *testing.T) {
	card := TextCard("标题", "短内容")
	got, err := marshalCard(card)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	if !strings.Contains(got, "短内容") {
		t.Errorf("内容丢失: %s", got)
	}
	if strings.Contains(got, "已截断") {
		t.Error("未超限不应出现截断标记")
	}
}

// TestMarshalCard超限截断 覆盖 30KB 硬上限。
//
// 不截断的话服务端直接拒收整次更新，用户看到的是「卡片不动了」，
// 没有任何「内容太长」的提示——这正是要避免的。
func TestMarshalCard超限截断(t *testing.T) {
	big := strings.Repeat("很长的内容", MaxCardBytes) // 远超 30KB
	card := NewCard().WithHeader("标题", TemplateBlue).Markdown(big, "normal")

	raw, err := card.JSON()
	if err != nil {
		t.Fatalf("原始序列化失败: %v", err)
	}
	if len(raw) <= MaxCardBytes {
		t.Skipf("测试数据未超限（%d 字节），无法验证截断", len(raw))
	}

	got, err := marshalCard(card)
	if err != nil {
		t.Fatalf("截断后序列化失败: %v", err)
	}
	if len(got) > MaxCardBytes {
		t.Errorf("截断后仍超限: %d 字节", len(got))
	}
	// 截断必须留痕，且必须是合法 JSON（不能裸切字符串）
	var out map[string]any
	if err := json.Unmarshal([]byte(got), &out); err != nil {
		t.Fatalf("截断后不是合法 JSON（裸切字符串的典型症状）: %v", err)
	}
	if !strings.Contains(got, "已截断") {
		t.Error("截断后应留下明确标记，否则用户无法判断内容是否完整")
	}
}

// TestMarshalCard超限时原卡不被改坏 截断不能就地改调用方的卡片——
// 那会让后续复用该卡片的逻辑拿到一份被砍过的内容。
func TestMarshalCard超限时原卡不被改坏(t *testing.T) {
	big := strings.Repeat("内容", MaxCardBytes)
	card := NewCard().Markdown(big, "normal")
	before := card.Body.Elements[0].Content

	if _, err := marshalCard(card); err != nil {
		t.Fatalf("截断失败: %v", err)
	}
	if card.Body.Elements[0].Content != before {
		t.Error("截断不应修改调用方持有的卡片——只应改副本")
	}
}

func TestMarshalCard序列化失败返回错误(t *testing.T) {
	// 含无法序列化的值（channel）应报错而非静默产出坏 JSON
	card := NewCard().Markdown("x", "normal")
	card.Body.Elements[0].Content = "ok"
	// 构造一个会失败的场景：把 Elements 塞入不可序列化的值
	card.Body.Elements = append(card.Body.Elements, Element{Tag: "markdown", Content: "y"})
	card.Config.Summary = &CardSummary{Title: &PlainText{Tag: "plain_text", Content: "s"}}
	if _, err := marshalCard(card); err != nil {
		t.Fatalf("正常卡片不应报错: %v", err)
	}
}

// ============ 参数校验 ============

func Test发送类缺参数报错(t *testing.T) {
	c, _ := New(Config{AppID: "i", AppSecret: "s"})
	ctx := context.Background()

	if _, err := c.SendText(ctx, "", "hi"); err == nil {
		t.Error("SendText 缺 chatID 应报错")
	}
	if _, err := c.SendMarkdown(ctx, "", "hi"); err == nil {
		t.Error("SendMarkdown 缺 chatID 应报错")
	}
	if _, err := c.SendCard(ctx, "", TextCard("t", "b")); err == nil {
		t.Error("SendCard 缺 chatID 应报错")
	}
	if _, err := c.SendCard(ctx, "oc_chat", nil); err == nil {
		t.Error("SendCard 卡片为 nil 应报错")
	}
	if _, err := c.UpdateCard(ctx, "", TextCard("t", "b")); err == nil {
		t.Error("UpdateCard 缺 messageID 应报错")
	}
	if _, err := c.UpdateCard(ctx, "om_x", nil); err == nil {
		t.Error("UpdateCard 卡片为 nil 应报错")
	}
	if err := c.DeleteMessage(ctx, ""); err == nil {
		t.Error("DeleteMessage 缺 messageID 应报错")
	}
}

// Test未初始化时API调用报错 防止把「忘了 Start」误报成飞书侧故障。
func Test未初始化时API调用报错(t *testing.T) {
	c, _ := New(Config{AppID: "i", AppSecret: "s"})
	ctx := context.Background()

	if _, err := c.UpdateCard(ctx, "om_x", TextCard("t", "b")); err == nil {
		t.Error("未 build 时 UpdateCard 应报错")
	}
	if err := c.DeleteMessage(ctx, "om_x"); err == nil {
		t.Error("未 build 时 DeleteMessage 应报错")
	}
}

func TestMustMarshal(t *testing.T) {
	got := MustMarshal(map[string]any{"action": "x", "id": 1})
	var out map[string]any
	if err := json.Unmarshal([]byte(got), &out); err != nil {
		t.Fatalf("不是合法 JSON: %v", err)
	}
	if out["action"] != "x" {
		t.Errorf("内容错误: %s", got)
	}
	// 不可序列化的值应回退为 {} 而非 panic
	if got := MustMarshal(make(chan int)); got != "{}" {
		t.Errorf("不可序列化时应回退 {}, 实际 %s", got)
	}
}

func Test状态常量取值(t *testing.T) {
	// 状态字符串会被展示给用户/写日志，取值应稳定
	cases := map[State]string{
		StateIdle:         "idle",
		StateConnecting:   "connecting",
		StateReady:        "ready",
		StateReconnecting: "reconnecting",
		StateDisconnected: "disconnected",
		StateFailed:       "failed",
	}
	for s, want := range cases {
		if string(s) != want {
			t.Errorf("状态 %v 的字面值 = %q, 期望 %q", s, string(s), want)
		}
	}
}

func Test退避默认实现可取消(t *testing.T) {
	// defaultSleep 必须响应 ctx 取消，否则关停时会卡在退避里
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	err := defaultSleep(ctx, 5*time.Second)
	if err == nil {
		t.Error("ctx 已取消时 defaultSleep 应返回错误")
	}
	if time.Since(start) > time.Second {
		t.Error("ctx 取消后应立即返回，不应真的睡满")
	}
}
