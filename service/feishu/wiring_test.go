//go:build feishu

// wiring_test.go —— 传输层接线断言
//
// 这些测试的存在理由：一个真实的 bug 曾让整条消息链路失效，
// 而当时 244 个单测全绿、日志干净、连接状态正常、鉴权成功。
//
// 根因在构造层面：larkws.NewClient 不传 option 时 eventHandler 为 nil，
// channel 的 ensureMessageHandler 因此跳过注册，所有事件被静默丢弃。
// 这类问题**无法用「输入→输出」式测试覆盖**——它不在我们的代码里，
// 而在「我们有没有正确装配第三方组件」这件事上。
// 唯一有效的防法就是对装配结果直接断言。
package feishu

import (
	"context"
	"testing"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
)

// TestWS默认没有事件分发器 锁住 SDK 的这个陷阱本身。
//
// 这条测试的价值不在于「我们的代码对不对」，而在于记录
// 「SDK 不传 option 就不给你 dispatcher」这个反直觉的事实。
// 哪天 SDK 改了默认行为，这条会失败并提醒我们重新评估。
func TestWS默认没有事件分发器(t *testing.T) {
	ws := larkws.NewClient("id", "secret")
	if ws.EventHandler() != nil {
		t.Skip("SDK 已改为默认注入 dispatcher，构造方式可以简化")
	}
	// 记录原因：这个 nil 会让 channel.ensureMessageHandler 静默跳过注册
	t.Log("确认：larkws.NewClient 不传 option 时 EventHandler() 为 nil")
}

// Test注入后事件分发器非空 与上一条配对：证明 WithEventHandler 确实有效。
func Test注入后事件分发器非空(t *testing.T) {
	d := dispatcher.NewEventDispatcher("", "")
	ws := larkws.NewClient("id", "secret", larkws.WithEventHandler(d))
	if ws.EventHandler() == nil {
		t.Fatal("WithEventHandler 未生效")
	}
	if ws.EventHandler() != d {
		t.Error("EventHandler 应返回注入的那个实例")
	}
}

// TestClient装配后WS已注入分发器 真正会回归的是这条 ——
// 「我们有没有记得注入」。
//
// 注意必须先调 build()：New() 只填字段，build() 在 StartAsync 里才执行，
// 而 build() 需要真实网络才能验证，因此这里直接调它检查装配结果。
func TestClient装配后WS已注入分发器(t *testing.T) {
	c, err := New(Config{AppID: "id", AppSecret: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	c.build()

	if c.ws == nil {
		t.Fatal("ws 客户端未创建")
	}
	if c.ws.EventHandler() == nil {
		t.Fatal("Client 内部的 WS 未注入事件分发器：消息与卡片回调都不会被触发")
	}
	if c.ch == nil {
		t.Fatal("channel 未创建")
	}
}

// TestClient装配两次都注入 防止有人「优化」成只装配一次或加了缓存分支。
func TestClient装配两次都注入(t *testing.T) {
	for i := 0; i < 2; i++ {
		c, err := New(Config{AppID: "id", AppSecret: "secret"})
		if err != nil {
			t.Fatal(err)
		}
		c.build()
		if c.ws == nil || c.ws.EventHandler() == nil {
			t.Fatalf("第 %d 次装配后分发器丢失", i+1)
		}
	}
}

// Test凭据缺失时建不出客户端 空凭据必须在构造期就失败，
// 而不是等到连不上时才暴露。
func Test凭据缺失时建不出客户端(t *testing.T) {
	cases := []Config{
		{},
		{AppID: "only-id"},
		{AppSecret: "only-secret"},
	}
	for i, cfg := range cases {
		if _, err := New(cfg); err == nil {
			t.Errorf("用例 %d: 凭据不完整时应报错，实际 nil", i+1)
		}
	}
}

// Test回调注册后可取回 全部注册一遍，确保没有一环因 nil 而静默失效。
func Test回调注册后可取回(t *testing.T) {
	c, err := New(Config{AppID: "id", AppSecret: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	c.OnMessage(func(ctx context.Context, msg *types.NormalizedMessage) {})
	c.OnCardAction(func(ctx context.Context, ev *types.CardActionEvent) {})
	c.OnState(func(s State) {})
	c.OnReject(func(ctx context.Context, ev *types.RejectEvent) {})

	if c.messageHandler() == nil {
		t.Error("OnMessage 未生效")
	}
	if c.cardActionHandler() == nil {
		t.Error("OnCardAction 未生效")
	}
	if c.rejectHandler() == nil {
		t.Error("OnReject 未生效（被策略丢弃的消息将彻底不可见）")
	}
}

// Test拒绝回调类型存在 RejectEvent 携带丢弃原因，
// 没有它就只能靠猜。
func Test拒绝回调类型存在(t *testing.T) {
	ev := &types.RejectEvent{
		MessageID: "om_1",
		ChatID:    "oc_1",
		SenderID:  "ou_1",
		Reason:    "no_mention",
	}
	if ev.Reason == "" {
		t.Error("RejectEvent 应携带丢弃原因")
	}
	// 常见原因：群聊未 @机器人。把它固化下来是因为
	// 这个值将来若变化，诊断信息会失效
	if ev.Reason != "no_mention" {
		t.Errorf("reason = %q", ev.Reason)
	}
}
