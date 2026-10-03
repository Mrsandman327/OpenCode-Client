//go:build feishu

// bridge_stream_test.go —— 桥接层与流式回合的接线
//
// 这些测试的价值在于「构造层面」：一个真实的缺陷曾让整条回复链路
// 完全失效（全仓单测全绿、日志干净、连接正常），根因是 onReply
// 全仓零调用方。这类「输入→输出」式测试覆盖不到，
// 必须直接断言装配结果。
package feishu

import (
	"context"
	"strings"
	"testing"
	"time"
)

// currentTurn 返回某 chat 当前进行中的回合；没有则返回 nil。
//
// 仅供测试断言「回合确实在登记表里」。放在 _test.go 而不是 bridge.go：
// 同包方法这样声明完全合法，同时避免在生产面上留一个零引用的导出方法
// （生产路径要么直接遍历 turns，要么走 abortTurn）。
func (b *Bridge) currentTurn(chatID string) *streamTurn {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.turns[chatID]
}

// backdateStartedAt 把本轮起点往前挪，用于测试「长任务」分支。
//
// 走 setter 而不是让测试直接改字段：直接改会绕过 mutex，
// 而读侧（elapsed）是持锁的——那是一个真实的数据竞争。
func (t *streamTurn) backdateStartedAt(d time.Duration) {
	t.mu.Lock()
	t.startedAt = t.startedAt.Add(-d)
	t.mu.Unlock()
}

// bindSession 建一个已绑定会话的桥，返回桥与它的输出替身。
//
// 刻意返回 out 而不是让调用方传入：newBridgeWith 自己会建一个 fakeOut，
// 调用方传进来的那个会被桥忽略——这类「替身没接上」的错最容易被
// 误读成「功能没实现」。
func bindSession(t *testing.T, oc *fakeOC, sessionID string) (*Bridge, *fakeOut) {
	t.Helper()
	b, out, sm, _ := newBridgeWith(t, oc, BridgeConfig{AllowAllUsers: true, DefaultProject: "/proj"})
	sm.Bind("oc_chat", sessionID, "/proj", "")
	return b, out
}

// Test普通消息会起流式回合 这是整条链路的生死判据：
// 此前 onReply 零调用方，助手回复**永远**收不到。
func Test普通消息会起流式回合(t *testing.T) {
	oc := &fakeOC{}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("帮我看看代码"))

	if len(oc.prompts) != 1 {
		t.Fatalf("消息应被发进 OpenCode，实际 %d 条", len(oc.prompts))
	}
	if len(oc.subscribed) != 1 || oc.subscribed[0] != "ses_1" {
		t.Fatalf("应订阅该会话的事件流，实际订阅 %v", oc.subscribed)
	}
	if len(out.cards) != 1 {
		t.Fatalf("应发一张占位卡，实际 %d 张", len(out.cards))
	}
	// 关键回归：占位卡不是把**用户自己的消息**复读一遍
	if strings.Contains(out.cards[0].MustJSON(), "帮我看看代码") {
		t.Error("占位卡不应复读用户输入")
	}
	if !strings.Contains(out.cards[0].MustJSON(), placeholderText) {
		t.Errorf("占位卡应显示占位文案: %s", out.cards[0].MustJSON())
	}
}

// Test流式回复出现在卡片上 端到端：事件 → 渲染。
func Test流式回复出现在卡片上(t *testing.T) {
	oc := &fakeOC{}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	oc.emit(delta("助手说："))
	oc.emit(complete())

	joined := strings.Join(out.updateTexts(), "|")
	if !strings.Contains(joined, "助手说：") {
		t.Errorf("助手回复应出现在卡片上: %s", joined)
	}
}

// Test起流式失败要明确告知 静默失败是这一层最糟的表现：
// 用户只看到自己发的消息，之后永远等不到回复且没有任何线索。
func Test起流式失败要明确告知(t *testing.T) {
	oc := &fakeOC{subscribeErr: errNoEventSubscriber}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))

	text := out.lastText()
	if !strings.Contains(text, "无法接收回复") {
		t.Errorf("起流式失败必须明确告知: %s", text)
	}
	if !strings.Contains(text, "server_status") {
		t.Errorf("应给出可操作的下一步: %s", text)
	}
}

// TestClose收掉进行中的回合 不收就是泄漏：订阅会自己重连、
// 心跳会一直跳，进程退出前持续空转。
func TestClose收掉进行中的回合(t *testing.T) {
	oc := &fakeOC{}
	b, _ := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	if !oc.hasSub() {
		t.Fatal("应有活跃订阅")
	}

	b.Close()
	if oc.hasSub() {
		t.Error("Close 后必须退订事件流")
	}
	b.Close() // 幂等
	b.Close()
}

// TestClose后不再开新回合 关停期间进来的消息不该再起订阅。
func TestClose后不再开新回合(t *testing.T) {
	oc := &fakeOC{}
	b, out := bindSession(t, oc, "ses_1")
	b.Close()

	b.HandleMessage(context.Background(), msg("hi"))
	if len(oc.subscribed) != 0 {
		t.Errorf("Close 后不应再订阅，实际 %d 次", len(oc.subscribed))
	}
	if !strings.Contains(out.lastText(), "已停止") {
		t.Errorf("应明确说明通道已停止: %s", out.lastText())
	}
}

// TestAbort停掉心跳 /abort 之后卡片继续跳「正在思考」，
// 是「明明按了中止，卡片还在动」的直接成因。
func TestAbort停掉心跳(t *testing.T) {
	oc := &fakeOC{}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	if len(oc.interrupts) != 0 {
		t.Fatal("还没中止过")
	}
	b.HandleMessage(context.Background(), msg("/abort"))

	if len(oc.interrupts) != 1 {
		t.Fatalf("/abort 应调 Interrupt，实际 %d 次", len(oc.interrupts))
	}
	if !strings.Contains(out.lastText(), "流式卡片已停止更新") {
		t.Errorf("应明确告知流式卡片已停: %s", out.lastText())
	}
	if oc.hasSub() {
		t.Error("/abort 后必须退订事件流")
	}
	// 再来一条事件也不该被渲染（回合已收尾）
	before := out.updateCount()
	oc.emit(delta("不该出现"))
	if out.updateCount() != before {
		t.Error("/abort 后不应再渲染任何事件")
	}
}

// Test没有在跑的回合时abort照常回话 没有流式回合时不应报错。
func Test没有在跑的回合时abort照常回话(t *testing.T) {
	oc := &fakeOC{}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("/abort"))
	if !strings.Contains(out.lastText(), "已中止当前运行的任务。") {
		t.Errorf("无回合时走普通文案: %s", out.lastText())
	}
}

// Test新回合顶掉旧回合 同一 chat 连续发两条消息时，
// 旧回合不收尾会与新回合往同一张卡上抢。
func Test新回合顶掉旧回合(t *testing.T) {
	oc := &fakeOC{}
	b, _ := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("第一条"))
	b.HandleMessage(context.Background(), msg("第二条"))

	if len(oc.subscribed) != 2 {
		t.Errorf("应订阅两次，实际 %d 次", len(oc.subscribed))
	}
	if oc.unsubCalls() == 0 {
		t.Error("起新回合时必须停掉旧回合")
	}
}

// Test长任务才推通知卡 短任务再推一条是噪音。
func Test长任务才推通知卡(t *testing.T) {
	oc := &fakeOC{}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	before := len(out.cards)
	oc.emit(delta("很快的回复"))
	oc.emit(complete())

	if len(out.cards) != before {
		t.Errorf("短任务不应额外推通知卡，实际多发了 %d 张", len(out.cards)-before)
	}
}

// Test长任务通知卡不带正文 通知卡只承载元信息——正文已在流式卡上
// 逐字显示过，再放一遍就是「同一份正文发两遍」。
func Test长任务通知卡不带正文(t *testing.T) {
	oc := &fakeOC{}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	// 把回合的起点往前推，模拟长任务
	turn := b.currentTurn("oc_chat")
	if turn == nil {
		t.Fatal("应有进行中的回合")
	}
	turn.backdateStartedAt(2 * time.Minute)

	oc.emit(delta("这是一段很长的回复正文"))
	oc.emit(complete())

	// 最后一张卡是通知卡
	out.mu.Lock()
	if len(out.cards) == 0 {
		out.mu.Unlock()
		t.Fatal("应至少发出占位卡")
	}
	last := out.cards[len(out.cards)-1].MustJSON()
	out.mu.Unlock()
	if !strings.Contains(last, "任务完成") {
		t.Fatalf("应推任务完成通知: %s", last)
	}
	if strings.Contains(last, "这是一段很长的回复正文") {
		t.Errorf("通知卡不应重复正文: %s", last)
	}
	if !strings.Contains(last, "完整回复见上方卡片") {
		t.Errorf("应指引用户看上方卡片: %s", last)
	}
}

// Test主卡真失败时通知卡兜底正文 上方卡片没送达时，
// 通知卡是唯一载体，必须带正文。
func Test主卡真失败时通知卡兜底正文(t *testing.T) {
	oc := &fakeOC{}
	b, out := bindSession(t, oc, "ses_1")
	// 让这一轮的更新全部失败
	out.mu.Lock()
	out.updateFails = true
	out.updateResult = SendResult{Success: false}
	out.mu.Unlock()

	b.HandleMessage(context.Background(), msg("hi"))
	turn := b.currentTurn("oc_chat")
	turn.backdateStartedAt(2 * time.Minute)

	oc.emit(delta("主卡没能送达的正文"))
	oc.emit(complete())

	out.mu.Lock()
	if len(out.cards) == 0 {
		out.mu.Unlock()
		t.Fatal("应至少发出占位卡")
	}
	last := out.cards[len(out.cards)-1].MustJSON()
	out.mu.Unlock()
	if !strings.Contains(last, "上方回复卡片未能更新") {
		t.Errorf("兜底时必须说明原因: %s", last)
	}
	if !strings.Contains(last, "主卡没能送达的正文") {
		t.Errorf("兜底时必须带正文: %s", last)
	}
}

// Test终态后回合出登记表 不出表的话 /abort 与 Close 就找不到它，
// 变成孤儿订阅。
func Test终态后回合出登记表(t *testing.T) {
	oc := &fakeOC{}
	b, _ := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	if b.currentTurn("oc_chat") == nil {
		t.Fatal("应有进行中的回合")
	}
	oc.emit(complete())
	if b.currentTurn("oc_chat") != nil {
		t.Error("终态后回合应出登记表")
	}
}

// Test未绑定会话不发占位卡 没有会话就没法订阅。
func Test未绑定会话不发占位卡(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})

	b.HandleMessage(context.Background(), msg("hi"))

	if len(out.cards) != 0 {
		t.Error("未绑定会话时不应发卡")
	}
	if !strings.Contains(out.lastText(), "还没有绑定会话") {
		t.Errorf("应提示先建会话: %s", out.lastText())
	}
}

// Test命令不走流式 命令没有助手回复，不该起占位卡。
func Test命令不走流式(t *testing.T) {
	oc := &fakeOC{}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("/status"))

	if len(oc.subscribed) != 0 {
		t.Error("命令不应订阅事件流")
	}
	if len(out.cards) != 0 {
		t.Error("命令不应发占位卡")
	}
}
