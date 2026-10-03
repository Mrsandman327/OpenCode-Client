//go:build feishu

// live_test.go —— 连通性集成测试
//
// 平时不跑：没有凭据时全部跳过。设置两个环境变量后即可验证真实链路：
//
//	$env:OC_FEISHU_APP_ID = "cli_xxx"
//	$env:OC_FEISHU_APP_SECRET = "xxx"
//	go test ./service/feishu/ -run Live -v
//
// 为什么留成测试而不是一次性脚本：长连接、鉴权、事件注册这三样东西
// 单测覆盖不到（它们只在真连上飞书之后才存在），而这类问题恰恰是
// 「编译通过、测试全绿、装到机器上就是不工作」的主要来源。
// 留一个能随时复跑的入口，比留一段用完即弃的探针代码有价值。

package feishu

import (
	"context"
	"os"
	"testing"
	"time"
)

// liveCreds 从环境变量取凭据；缺失时返回 ok=false。
func liveCreds() (appID, appSecret string, ok bool) {
	appID = os.Getenv("OC_FEISHU_APP_ID")
	appSecret = os.Getenv("OC_FEISHU_APP_SECRET")
	return appID, appSecret, appID != "" && appSecret != ""
}

// TestLive连接建立 验证凭据有效且长连接能建立。
func TestLive连接建立(t *testing.T) {
	appID, appSecret, ok := liveCreds()
	if !ok {
		t.Skip("未设置 OC_FEISHU_APP_ID / OC_FEISHU_APP_SECRET，跳过连通性测试")
	}

	client, err := New(Config{AppID: appID, AppSecret: appSecret})
	if err != nil {
		t.Fatalf("创建客户端失败（凭据格式问题）: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 状态变化通道：用来等 ready，而不是死等固定时长
	states := make(chan State, 16)
	client.OnState(func(s State) {
		select {
		case states <- s:
		default: // 满了就丢，状态只是通知不是数据
		}
	})

	if err := client.StartAsync(ctx); err != nil {
		t.Fatalf("启动长连接失败（凭据无效或网络不通）: %v", err)
	}
	t.Logf("已发起连接，等待 ready…")

	deadline := time.After(45 * time.Second)
	var last State
	for {
		select {
		case s := <-states:
			last = s
			t.Logf("状态变化: %s", s)
			if s == StateReady {
				t.Log("✅ 长连接建立成功，凭据有效")
				_ = client.Stop(context.Background())
				return
			}
			if s == StateFailed {
				_ = client.Stop(context.Background())
				t.Fatalf("❌ 长连接建立失败：凭据无效或网络不通（最后状态 %s）", last)
			}
		case <-deadline:
			_ = client.Stop(context.Background())
			t.Fatalf("⏱ 45 秒内未就绪（最后状态 %s）。可能是凭据无效，或长连接被限流/网络阻断", last)
		}
	}
}

// TestLive收发往返 端到端：往指定 chat 发一张卡片并确认不报错。
//
// 需要额外的 OC_FEISHU_TEST_CHAT（飞书会话 ID），因为发消息需要一个
// 真实会话——发给自己（p2p chatID）也能验证，但需要先从飞书侧拿到 ID。
func TestLive收发往返(t *testing.T) {
	appID, appSecret, ok := liveCreds()
	if !ok {
		t.Skip("未设置 OC_FEISHU_APP_ID / OC_FEISHU_APP_SECRET，跳过")
	}
	chatID := os.Getenv("OC_FEISHU_TEST_CHAT")
	if chatID == "" {
		t.Skip("未设置 OC_FEISHU_TEST_CHAT，跳过收发测试")
	}

	client, err := New(Config{AppID: appID, AppSecret: appSecret})
	if err != nil {
		t.Fatalf("创建客户端失败: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ready := make(chan struct{})
	var once bool
	client.OnState(func(s State) {
		if s == StateReady && !once {
			once = true
			close(ready)
		}
	})
	if err := client.StartAsync(ctx); err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	defer client.Stop(context.Background())

	select {
	case <-ready:
	case <-time.After(45 * time.Second):
		t.Fatal("长连接未就绪")
	}

	// 发一张小卡片：验证鉴权、消息发送与卡片 JSON 被飞书接受
	msgID, err := client.SendCard(ctx, chatID,
		TextCard("连通性测试", "OC Manager 飞书通道已连上 ✅"))
	if err != nil {
		t.Fatalf("发送卡片失败: %v", err)
	}
	t.Logf("✅ 卡片已发送，message_id=%s", msgID)

	// 再验证一次带按钮的卡片（交互元素更容易被飞书校验拒绝）
	card := NewCard().
		WithHeader("连通性测试", TemplateBlue).
		Markdown("按钮回执测试", "normal").
		Button("点我", "primary_filled", map[string]any{"action": ActionQuickStatus}, "")
	msgID2, err := client.SendCard(ctx, chatID, card)
	if err != nil {
		t.Fatalf("发送带按钮卡片失败: %v", err)
	}
	t.Logf("✅ 带按钮卡片已发送，message_id=%s", msgID2)
}
