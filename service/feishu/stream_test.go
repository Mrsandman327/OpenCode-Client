//go:build feishu

// stream_test.go —— 流式渲染回合的契约测试
//
// 这些测试用假对象注入（fakeOut / fakeOC），不碰真机：
// 真实飞书通道在跑，任何真机验证都可能发出真实消息。
package feishu

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// fixedNow 是可手动推进的时钟（让节流行为可确定）。
type fixedNow struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fixedNow) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fixedNow) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// noSleepAny 让限流退避立即返回，测试不必真等。
func noSleepAny(ctx context.Context, d time.Duration) error { return nil }

// startTestTurn 起一个可控的流式回合。
func startTestTurn(t *testing.T, out Output) (*fakeOC, *streamTurn, *fixedNow) {
	t.Helper()
	oc := &fakeOC{}
	clock := &fixedNow{now: time.Unix(1790645535, 0)}
	turn, err := StartStreamTurn(out, "ses_1", "oc_1", StreamConfig{
		Subscribe:   oc.SubscribeEvents,
		Now:         clock.Now,
		Sleep:       noSleepAny,
		MinInterval: time.Second,
	})
	if err != nil {
		t.Fatalf("起流式回合失败: %v", err)
	}
	return oc, turn, clock
}

func delta(text string) AgentEvent {
	return AgentEvent{Type: EvMessageDelta, Properties: EventProps{Delta: text}}
}

func segment(text string) AgentEvent {
	return AgentEvent{Type: EvMessageSegmentComplete, Properties: EventProps{Text: text}}
}

func complete() AgentEvent {
	return AgentEvent{Type: EvMessageComplete}
}

// Test占位卡先发再更新 后续更新都打在占位卡的 messageID 上。
func Test占位卡先发再更新(t *testing.T) {
	out := &fakeOut{}
	_, turn, _ := startTestTurn(t, out)
	defer turn.Stop()

	if len(out.cards) != 1 {
		t.Fatalf("应发一张占位卡，实际 %d 张", len(out.cards))
	}
	out.mu.Lock()
	ids := append([]string(nil), out.updateIDs...)
	out.mu.Unlock()
	if len(ids) > 0 && ids[0] != "om_card_1" {
		t.Errorf("更新应打在占位卡的 messageID 上，实际 %q", ids[0])
	}
}

// Test订阅先于占位卡 事件流是 live-only 的：晚订阅会丢掉开头的事件。
func Test订阅先于占位卡(t *testing.T) {
	oc := &fakeOC{}
	out := &fakeOut{}
	turn, err := StartStreamTurn(out, "ses_1", "oc_1", StreamConfig{
		Subscribe: oc.SubscribeEvents,
		Now:       time.Now,
		Sleep:     noSleepAny,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer turn.Stop()

	// 订阅已建立（fakeOC 记录了 handlers）
	oc.mu.Lock()
	n := len(oc.handlers)
	oc.mu.Unlock()
	if n != 1 {
		t.Fatalf("订阅数 = %d, 期望 1", n)
	}
	// 补发一条事件，确认事件确实被消费（说明订阅在占位卡之前就绪）
	oc.emit(delta("你好"))
	if out.updateCount() == 0 {
		t.Error("订阅就绪后应能收到事件")
	}
}

// Testdelta逐字渲染 正文增量应出现在卡片上。
func TestDelta逐字渲染(t *testing.T) {
	out := &fakeOut{}
	oc, turn, clock := startTestTurn(t, out)
	defer turn.Stop()

	oc.emit(delta("第一段"))
	// 两次 delta 必须跨过最小间隔，否则第二次会被节流拦掉
	// （节流本身由 Test节流拦住高频delta 覆盖）
	clock.Advance(2 * time.Second)
	oc.emit(delta("第二段"))

	texts := out.updateTexts()
	if len(texts) < 2 {
		t.Fatalf("应有两次卡片更新，实际 %d 次", len(texts))
	}
	last := texts[len(texts)-1]
	if !strings.Contains(last, "第一段") || !strings.Contains(last, "第二段") {
		t.Errorf("卡片应含累加后的正文: %q", last)
	}
}

// Test节流拦住高频delta 这是「回复半截」缺陷的第一道防线：
// 逐 delta 发更新会撞飞书 230020 限流，更新被静默丢弃。
func Test节流拦住高频delta(t *testing.T) {
	out := &fakeOut{}
	oc, turn, clock := startTestTurn(t, out)
	defer turn.Stop()

	oc.emit(delta("a"))
	afterFirst := out.updateCount()
	// 100 个 delta 挤在同一毫秒里
	for i := 0; i < 100; i++ {
		oc.emit(delta("b"))
	}
	if got := out.updateCount(); got != afterFirst {
		t.Errorf("同一时刻的 100 个 delta 只应放行 1 次更新，实际发了 %d 次", got-afterFirst)
	}

	// 过了间隔后应恢复
	clock.Advance(2 * time.Second)
	oc.emit(delta("c"))
	if out.updateCount() == afterFirst {
		t.Error("过了最小间隔后应恢复更新")
	}
}

// Test段结束覆盖累加结果并强制渲染 delta 可能因限流或断线而缺失，
// 而 text.ended 每次都带完整正文。
func Test段结束覆盖累加结果并强制渲染(t *testing.T) {
	out := &fakeOut{}
	oc, turn, _ := startTestTurn(t, out)
	defer turn.Stop()

	oc.emit(delta("残缺的"))
	// 同一时刻（会被节流拦下），但段结束必须强制渲染
	oc.emit(segment("这是权威的完整正文"))

	texts := out.updateTexts()
	last := texts[len(texts)-1]
	if !strings.Contains(last, "这是权威的完整正文") {
		t.Errorf("段结束应以权威全文覆盖: %q", last)
	}
	if strings.Contains(last, "残缺的") {
		t.Errorf("累加的残缺内容应被覆盖掉: %q", last)
	}
}

// Test终态强制渲染 终态是保证内容正确的最后一次机会，不能被节流跳过。
func Test终态强制渲染(t *testing.T) {
	out := &fakeOut{}
	oc, turn, _ := startTestTurn(t, out)
	defer turn.Stop()

	oc.emit(complete())
	texts := out.updateTexts()
	last := texts[len(texts)-1]
	if last != placeholderText {
		t.Errorf("空正文终态应显示占位文案（证明终态确实渲染了）: %q", last)
	}
}

// Test终态不把空回复渲染成空白卡 用户看到一张空白卡会以为机器人坏了。
func Test终态不把空回复渲染成空白卡(t *testing.T) {
	out := &fakeOut{}
	oc, turn, _ := startTestTurn(t, out)
	defer turn.Stop()

	oc.emit(complete())
	if !strings.Contains(strings.Join(out.updateTexts(), "|"), placeholderText) {
		t.Error("空正文必须落到占位文案而不是空卡片")
	}
}

// Test终态收尾幂等 message.complete 与 session.idle 可能都到。
func Test终态收尾幂等(t *testing.T) {
	out := &fakeOut{}
	oc, turn, _ := startTestTurn(t, out)
	defer turn.Stop()

	oc.emit(complete())
	n := out.updateCount()
	oc.emit(complete())
	oc.emit(complete())
	if out.updateCount() != n {
		t.Errorf("重复终态不应重复渲染: %d → %d", n, out.updateCount())
	}
	if !turn.heartbeatStopped() {
		t.Error("终态后心跳必须停")
	}
}

// Test终态后退订事件流 不退订就是泄漏：订阅会自己重连并继续往
// 一张已经收尾的卡上渲染。
func Test终态后退订事件流(t *testing.T) {
	out := &fakeOut{}
	oc, turn, _ := startTestTurn(t, out)
	defer turn.Stop()

	oc.emit(complete())
	if oc.unsubCalls() == 0 {
		t.Error("终态后必须退订事件流")
	}
}

// TestStop可重复调用 收尾路径有多条，二次 Stop 崩在关停路径上。
func TestStop可重复调用(t *testing.T) {
	out := &fakeOut{}
	_, turn, _ := startTestTurn(t, out)
	turn.Stop()
	turn.Stop()
	turn.Stop()
	if !turn.heartbeatStopped() {
		t.Error("Stop 后心跳必须停")
	}
}

// Test权限卡住时停心跳 V2 是 inbox 式执行：本轮被权限卡住时
// message.complete / session.idle **永远不会来**。心跳若继续转，
// 卡片会永远显示「正在思考」，用户既看不到内容也看不到要他做什么。
func Test权限卡住时停心跳(t *testing.T) {
	out := &fakeOut{}
	oc, turn, _ := startTestTurn(t, out)
	defer turn.Stop()

	oc.emit(AgentEvent{Type: EvPermissionAsked, Properties: EventProps{PermissionID: "per_1"}})

	if !turn.heartbeatStopped() {
		t.Error("权限卡住时必须停心跳（否则永远转「正在思考」）")
	}
	texts := out.updateTexts()
	last := texts[len(texts)-1]
	if !strings.Contains(last, "等待你批准权限请求") {
		t.Errorf("卡片必须明说在等什么: %q", last)
	}
}

// TestForm卡住时停心跳 同上，只是文案不同。
func TestForm卡住时停心跳(t *testing.T) {
	out := &fakeOut{}
	oc, turn, _ := startTestTurn(t, out)
	defer turn.Stop()

	oc.emit(AgentEvent{Type: EvFormCreated, Properties: EventProps{FormID: "frm_1"}})
	if !turn.heartbeatStopped() {
		t.Error("form 卡住时必须停心跳")
	}
	if !strings.Contains(strings.Join(out.updateTexts(), "|"), "回答问题卡片") {
		t.Error("卡片必须明说在等回答")
	}
}

// Test流式期主卡只放第一段 全文塞进主卡会撞 230025 让每次更新都失败。
func Test流式期主卡只放第一段(t *testing.T) {
	out := &fakeOut{}
	oc, turn, _ := startTestTurn(t, out)
	defer turn.Stop()

	oc.emit(delta(strings.Repeat("很长的中文内容。", 4000)))
	oc.emit(segment(strings.Repeat("很长的中文内容。", 4000)))

	for i, txt := range out.updateTexts() {
		if cardBytes(txt) > CardSegmentBudgetBytes {
			t.Errorf("第 %d 次更新的卡片 %d 字节超预算", i, cardBytes(txt))
		}
	}
	// 提示必须是「完成后会续发」，不能引用尚不存在的续卡片
	last := out.updateTexts()
	if !strings.Contains(last[len(last)-1], "完成后以「续」卡片发出") {
		t.Errorf("流式期溢出提示文案不对: %q", last[len(last)-1])
	}
}

// Test终态段0进主卡续段作新消息 续卡片不走 UpdateCard：
// 新消息没有 5QPS 的单消息更新频控。
func Test终态段0进主卡续段作新消息(t *testing.T) {
	out := &fakeOut{}
	oc, turn, _ := startTestTurn(t, out)
	defer turn.Stop()

	oc.emit(segment(strings.Repeat("很长的中文内容。", 4000)))
	before := len(out.cards)
	oc.emit(complete())

	if len(out.cards) <= before {
		t.Fatal("超长内容应以新消息发出续卡片")
	}
	// 续卡片同样不许超预算
	for i := before; i < len(out.cards); i++ {
		if n := len([]byte(out.cards[i].MustJSON())); n > CardSegmentBudgetBytes {
			t.Errorf("第 %d 张续卡片 %d 字节超预算", i-before, n)
		}
	}
	// 段 0 必须进了主卡（带「已分段显示」提示）
	if !strings.Contains(strings.Join(out.updateTexts(), "|"), "已分段显示") {
		t.Error("段 0 应进主卡并带终态分段提示")
	}
}

// Test短回复不拆也不提示 回归：内容没被分段时说「见下方续卡片」是骗用户。
func Test短回复不拆也不提示(t *testing.T) {
	out := &fakeOut{}
	oc, turn, _ := startTestTurn(t, out)
	defer turn.Stop()

	oc.emit(segment("就一句话。"))
	oc.emit(complete())

	joined := strings.Join(out.updateTexts(), "|")
	if strings.Contains(joined, "已分段显示") {
		t.Errorf("未分段时不应出现分段提示: %s", joined)
	}
	if strings.Contains(joined, "续") {
		t.Errorf("未分段时不应提到续卡片: %s", joined)
	}
}

// Test错误终态带上错误详情 错误详情必须落在用户此刻唯一能看到的那张卡上。
func Test错误终态带上错误详情(t *testing.T) {
	out := &fakeOut{}
	oc, turn, _ := startTestTurn(t, out)
	defer turn.Stop()

	oc.emit(AgentEvent{Type: EvError, Properties: EventProps{Error: "上游超时"}})

	joined := strings.Join(out.updateTexts(), "|")
	if !strings.Contains(joined, "上游超时") {
		t.Errorf("错误详情必须落在卡上: %s", joined)
	}
	if !turn.heartbeatStopped() {
		t.Error("错误终态后心跳必须停")
	}
}

// TestOnFinish拿到结果 让长任务通知与真失败兜底有判据可用。
func TestOnFinish拿到结果(t *testing.T) {
	out := &fakeOut{}
	oc := &fakeOC{}
	var got TurnResult
	turn, err := StartStreamTurn(out, "ses_1", "oc_1", StreamConfig{
		Subscribe: oc.SubscribeEvents,
		Now:       time.Now,
		Sleep:     noSleepAny,
		OnFinish:  func(res TurnResult) { got = res },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer turn.Stop()

	oc.emit(segment("正文"))
	oc.emit(complete())

	if !got.Success {
		t.Error("正常收尾 Success 应为 true")
	}
	if got.Content != "正文" {
		t.Errorf("Content = %q", got.Content)
	}
	if !got.MainCardDelivered {
		t.Error("更新成功时 MainCardDelivered 应为 true")
	}
}

// Test限流失败降级为暂态 限流退避重试过仍失败 → 不打扰用户。
func Test限流失败降级为暂态(t *testing.T) {
	out := &fakeOut{updateFails: true, updateResult: SendResult{Success: false, RateLimited: true}}
	oc := &fakeOC{}
	var got TurnResult
	turn, err := StartStreamTurn(out, "ses_1", "oc_1", StreamConfig{
		Subscribe: oc.SubscribeEvents,
		Now:       time.Now,
		Sleep:     noSleepAny,
		OnFinish:  func(res TurnResult) { got = res },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer turn.Stop()

	oc.emit(complete())
	if got.Failure != RenderFailureRateLimited {
		t.Errorf("Failure = %q, 期望 %q", got.Failure, RenderFailureRateLimited)
	}
	if IsUserVisibleFailure(got.Failure) {
		t.Error("限流不该打扰用户")
	}
	if RenderFailureNotice(got.Failure, "回复卡片", "限流", "") != "" {
		t.Error("限流失败不应生成任何提示文案")
	}
}

// Test真失败标记为内容丢失 超限/无权限/消息被删：内容真的丢了，
// 必须让用户知道，否则「半截」在他眼里就是机器人坏了。
func Test真失败标记为内容丢失(t *testing.T) {
	out := &fakeOut{updateFails: true, updateResult: SendResult{Success: false, RateLimited: false}}
	oc := &fakeOC{}
	var got TurnResult
	turn, err := StartStreamTurn(out, "ses_1", "oc_1", StreamConfig{
		Subscribe: oc.SubscribeEvents,
		Now:       time.Now,
		Sleep:     noSleepAny,
		OnFinish:  func(res TurnResult) { got = res },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer turn.Stop()

	oc.emit(complete())
	if got.Failure != RenderFailureHard {
		t.Errorf("Failure = %q, 期望 %q", got.Failure, RenderFailureHard)
	}
	if got.MainCardDelivered {
		t.Error("真失败时 MainCardDelivered 必须为 false（通知卡据此决定要不要兜底正文）")
	}
	if !IsUserVisibleFailure(got.Failure) {
		t.Error("真失败必须让用户知道")
	}
}

// Test不支持更新卡片时明确失败 发一张永远不动的占位卡，
// 在用户眼里就是「机器人坏了」。
func Test不支持更新卡片时明确失败(t *testing.T) {
	oc := &fakeOC{}
	out := &noUpdateOut{}
	_, err := StartStreamTurn(out, "ses_1", "oc_1", StreamConfig{
		Subscribe: oc.SubscribeEvents,
		Now:       time.Now,
	})
	if err == nil {
		t.Fatal("不支持更新卡片时必须报错")
	}
	if !strings.Contains(err.Error(), "卡片更新") {
		t.Errorf("错误信息应说清原因: %v", err)
	}
}

// Test缺订阅时明确失败 没有事件订阅就收不到任何助手回复。
func Test缺订阅时明确失败(t *testing.T) {
	out := &fakeOut{}
	_, err := StartStreamTurn(out, "ses_1", "oc_1", StreamConfig{Now: time.Now})
	if err == nil {
		t.Fatal("缺订阅时必须报错")
	}
	if !strings.Contains(err.Error(), "事件订阅") {
		t.Errorf("错误信息应说清原因: %v", err)
	}
}

// Test缺会话ID时明确失败
func Test缺会话ID时明确失败(t *testing.T) {
	oc := &fakeOC{}
	out := &fakeOut{}
	_, err := StartStreamTurn(out, "", "oc_1", StreamConfig{
		Subscribe: oc.SubscribeEvents,
		Now:       time.Now,
	})
	if err == nil {
		t.Fatal("缺会话 ID 时必须报错")
	}
}

// Test占位卡发不出去时完整回滚 心跳与订阅都必须收掉。
func Test占位卡发不出去时完整回滚(t *testing.T) {
	oc := &fakeOC{}
	out := &fakeOut{failCard: true}
	_, err := StartStreamTurn(out, "ses_1", "oc_1", StreamConfig{
		Subscribe: oc.SubscribeEvents,
		Now:       time.Now,
		Sleep:     noSleepAny,
	})
	if err == nil {
		t.Fatal("占位卡发不出去时必须报错")
	}
	if oc.unsubCalls() == 0 {
		t.Error("失败时必须退订事件流（否则订阅会自己重连成孤儿）")
	}
}

// ============ 失败分类 ============

// Test渲染失败分类 区分暂态与真失败是产品决策，值得被钉住。
func Test渲染失败分类(t *testing.T) {
	cases := []struct {
		res  SendResult
		want RenderFailure
	}{
		{SendResult{Success: true}, RenderFailureNone},
		{SendResult{Success: false, RateLimited: true}, RenderFailureRateLimited},
		{SendResult{Success: false, RateLimited: false}, RenderFailureHard},
	}
	for _, tc := range cases {
		if got := ClassifyRenderFailure(tc.res); got != tc.want {
			t.Errorf("ClassifyRenderFailure(%+v) = %q, 期望 %q", tc.res, got, tc.want)
		}
	}
}

// Test只有真失败才生成提示 限流不打扰用户。
func Test只有真失败才生成提示(t *testing.T) {
	if got := RenderFailureNotice(RenderFailureRateLimited, "回复卡片", "限流", ""); got != "" {
		t.Errorf("限流不应打扰用户，实际 %q", got)
	}
	if got := RenderFailureNotice(RenderFailureNone, "回复卡片", "", ""); got != "" {
		t.Errorf("成功不应打扰用户，实际 %q", got)
	}
	got := RenderFailureNotice(RenderFailureHard, "回复卡片", "内容过长", "完整内容：见下一条")
	if !strings.Contains(got, "内容可能不完整") {
		t.Errorf("真失败必须提示内容可能不完整: %q", got)
	}
	if !strings.Contains(got, "内容过长") {
		t.Errorf("应带上原因: %q", got)
	}
	if !strings.Contains(got, "见下一条") {
		t.Errorf("应带上补救信息: %q", got)
	}
}
