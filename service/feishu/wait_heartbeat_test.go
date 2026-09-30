// wait_heartbeat_test.go —— 等待期心跳的契约测试
//
// 缺陷根因（实测探针序列）：首个事件到达前有 7.2 秒静默。
//
// 本文件最关键的一条是 Test心跳间隔不超过一个周期：它断言的是
// **相邻两次更新的时间差**，不是 tick 次数。只断言次数的实现
// （比如「每次都 tick，但定时器周期写成 30 秒」）能轻松通过次数断言，
// 却在真实场景里完全无效——用户看到的还是「卡死了 30 秒」。
package feishu

import (
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeClock 是可手动推进的时钟。
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// manualTicker 是可手动触发的定时器。
type manualTicker struct {
	ch      chan time.Time
	stopped bool
	d       time.Duration
}

func newManualTicker(d time.Duration) *manualTicker {
	return &manualTicker{ch: make(chan time.Time, 64), d: d}
}

func (m *manualTicker) C() <-chan time.Time { return m.ch }

func (m *manualTicker) Stop() { m.stopped = true }

// Fire 手动触发一次。
func (m *manualTicker) Fire() { m.ch <- time.Now() }

// Test默认间隔是2500毫秒 数值本身是被产品决定的：
// 2~3 秒是用户能感知「还活着」又不至于刷屏的区间。
func Test默认间隔是2500毫秒(t *testing.T) {
	if HeartbeatInterval != 2500*time.Millisecond {
		t.Errorf("HeartbeatInterval = %v, 期望 2500ms", HeartbeatInterval)
	}
}

// Test心跳间隔不超过一个周期 用**真实时钟**跑，断言相邻两次
// OnTick 的时间差。这是本文件最重要的一条。
//
// 为什么用真实时钟而不是假 ticker：假 ticker 由测试自己按需触发，
// 定时器周期写错（30 秒）也照样「每次都触发」，测不出问题。
// 真实时钟下，周期写错直接表现为间隔超限。
func Test心跳间隔不超过一个周期(t *testing.T) {
	const interval = 15 * time.Millisecond
	var mu sync.Mutex
	var stamps []time.Time

	h := StartWaitHeartbeat(HeartbeatOptions{
		Interval: interval,
		OnTick: func(info HeartbeatInfo) {
			mu.Lock()
			stamps = append(stamps, time.Now())
			mu.Unlock()
		},
	})
	defer h.Stop()

	time.Sleep(320 * time.Millisecond)
	h.Stop()

	mu.Lock()
	defer mu.Unlock()
	if len(stamps) < 5 {
		t.Fatalf("320ms / %v 周期应至少 tick 5 次，实际 %d 次", interval, len(stamps))
	}
	// 容许 3 倍周期：留给调度抖动。周期写错 10 倍以上必被抓到。
	maxGap := 3 * interval
	for i := 1; i < len(stamps); i++ {
		gap := stamps[i].Sub(stamps[i-1])
		if gap > maxGap {
			t.Errorf("第 %d 次与第 %d 次心跳间隔 %v，超过一个周期 %v 的 3 倍", i+1, i, gap, maxGap)
		}
	}
}

// Test启动即先跳一次 用户按下发送后 0 秒就该看到带用时的卡片，
// 而不是等 2.5 秒才第一次动。
func Test启动即先跳一次(t *testing.T) {
	var got []HeartbeatInfo
	h := StartWaitHeartbeat(HeartbeatOptions{
		Interval: time.Hour, // 绝不该在这段时间内再跳
		OnTick:   func(info HeartbeatInfo) { got = append(got, info) },
	})
	defer h.Stop()

	if len(got) != 1 {
		t.Fatalf("启动时应立即跳一次，实际 %d 次", len(got))
	}
	if got[0].Ticks != 1 {
		t.Errorf("Ticks = %d, 期望 1", got[0].Ticks)
	}
}

// Test无事件时显示尚未收到模型输出 这是用户唯一能区分
// 「在跑」和「卡死」的信息，删掉它心跳就只是个会变的秒数。
func Test无事件时显示尚未收到模型输出(t *testing.T) {
	txt := WaitingCardText(HeartbeatInfo{Elapsed: 3 * time.Second, Stage: StageWaiting})
	if !strings.Contains(txt, "尚未收到模型输出") {
		t.Errorf("一个事件都没有时必须说明这一点: %q", txt)
	}
	if !strings.Contains(txt, "已用时 3 秒") {
		t.Errorf("必须带已用时: %q", txt)
	}
}

// Test有事件后不再显示尚未收到 有进展就不该再说「没动静」。
func Test有事件后不再显示尚未收到(t *testing.T) {
	first := time.Unix(1790645535, 0)
	txt := WaitingCardText(HeartbeatInfo{
		Elapsed:      5 * time.Second,
		Stage:        StageThinking,
		FirstEventAt: first,
		SeenEvents:   1,
	})
	if strings.Contains(txt, "尚未收到模型输出") {
		t.Errorf("已有事件时不应再说没动静: %q", txt)
	}
	if !strings.Contains(txt, "思考中") {
		t.Errorf("阶段文案应推进: %q", txt)
	}
}

// Test阶段文案纯函数 无 IO、无定时器，可直接断言。
func Test阶段文案纯函数(t *testing.T) {
	cases := []struct {
		stage WaitStage
		want  string
	}{
		{StageWaiting, "正在思考"},
		{StageThinking, "思考中"},
		{StageWriting, "组织回答中"},
		{StageDone, "已完成"},
	}
	for _, tc := range cases {
		got := WaitingCardText(HeartbeatInfo{Elapsed: time.Second, Stage: tc.stage, FirstEventAt: time.Unix(1, 0)})
		if !strings.Contains(got, tc.want) {
			t.Errorf("stage %q 文案 = %q, 期望含 %q", tc.stage, got, tc.want)
		}
	}
}

// Testthinking不停心跳 是与 bot 侧**有意不同**的判据。
//
// 实测序列的第一条事件常常就是 thinking.start；若一见到它就停心跳，
// 死区只是从「首事件前」平移到「思考期」——而思考期往往几十秒。
func TestThinking不停心跳(t *testing.T) {
	for _, ev := range []string{EvThinkingStart, EvThinkingDelta, EvThinkingComplete} {
		effect, ok := EffectOfEvent(ev)
		if !ok {
			t.Errorf("%s 应当与等待期相关", ev)
			continue
		}
		if effect.Stops {
			t.Errorf("%s 不应停心跳（否则死区平移到思考期）", ev)
		}
		if effect.Stage != StageThinking {
			t.Errorf("%s 阶段 = %q, 期望 %q", ev, effect.Stage, StageThinking)
		}
	}
}

// Testthinking事件后心跳仍在跑 端到端锁住上面那条判据。
func TestThinking事件后心跳仍在跑(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1790645535, 0)}
	ticker := newManualTicker(time.Hour)
	h := StartWaitHeartbeat(HeartbeatOptions{
		Interval:  time.Hour,
		Now:       clock.Now,
		NewTicker: func(d time.Duration) Ticker { return ticker },
		OnTick:    func(HeartbeatInfo) {},
	})
	defer h.Stop()

	if !h.Running() {
		t.Fatal("启动后心跳应在跑")
	}
	h.NoteEvent(EvThinkingStart)
	if !h.Running() {
		t.Error("thinking.start 后心跳必须继续跑")
	}
	if h.Stage() != StageThinking {
		t.Errorf("阶段 = %q, 期望 %q", h.Stage(), StageThinking)
	}
}

// Test工具事件推进阶段但不停 文本段之间有长空窗（工具在跑），
// 卡片同样没人驱动。
func Test工具事件推进阶段但不停(t *testing.T) {
	for _, ev := range []string{EvToolStart, EvToolDelta, EvToolComplete} {
		effect, ok := EffectOfEvent(ev)
		if !ok {
			t.Errorf("%s 应当与等待期相关", ev)
			continue
		}
		if effect.Stops {
			t.Errorf("%s 不应停心跳（工具执行期间卡片需要心跳撑着）", ev)
		}
		if effect.Stage != StageWriting {
			t.Errorf("%s 阶段 = %q, 期望 %q", ev, effect.Stage, StageWriting)
		}
	}
}

// Test正文delta才停心跳 只有正文真在动，才交给流式渲染接管。
func Test正文delta才停心跳(t *testing.T) {
	effect, ok := EffectOfEvent(EvMessageDelta)
	if !ok {
		t.Fatal("message.delta 应当与等待期相关")
	}
	if !effect.Stops {
		t.Error("message.delta 必须停心跳（正文由流式渲染驱动）")
	}

	h := StartWaitHeartbeat(HeartbeatOptions{
		Interval: time.Hour,
		OnTick:   func(HeartbeatInfo) {},
	})
	h.NoteEvent(EvMessageDelta)
	if h.Running() {
		t.Error("message.delta 后心跳必须停")
	}
	h.Stop() // 幂等
}

// Test终态事件停心跳
func Test终态事件停心跳(t *testing.T) {
	for _, ev := range []string{EvMessageComplete, EvError, EvAbort} {
		effect, ok := EffectOfEvent(ev)
		if !ok {
			t.Errorf("%s 应当与等待期相关", ev)
			continue
		}
		if !effect.Stops {
			t.Errorf("%s 必须停心跳", ev)
		}
	}
}

// Test权限与form事件不在等待期判据内 它们由桥接层推卡，
// 心跳的职责到不了那里。
func Test权限与form事件不在等待期判据内(t *testing.T) {
	for _, ev := range []string{EvPermissionAsked, EvFormCreated, EvSessionRenamed} {
		if _, ok := EffectOfEvent(ev); ok {
			t.Errorf("%s 不应参与等待期阶段判定", ev)
		}
	}
}

// TestStop幂等 收尾路径有多条（终态 / abort / 关停 / 处理出错），
// 二次 Stop 会 panic 崩在关停路径上。
func TestStop幂等(t *testing.T) {
	ticker := newManualTicker(time.Hour)
	h := StartWaitHeartbeat(HeartbeatOptions{
		Interval:  time.Hour,
		NewTicker: func(d time.Duration) Ticker { return ticker },
		OnTick:    func(HeartbeatInfo) {},
	})
	h.Stop()
	h.Stop()
	h.Stop()
	if h.Running() {
		t.Error("Stop 后不应仍在跑")
	}
}

// TestStop真的停掉底层定时器 只是把句柄置 nil 而不调 Ticker.Stop，
// 底层 time.Ticker 会一直挂在 runtime 的定时器堆上——
// 表现是「回合早就结束了，进程却退不出去」。
func TestStop真的停掉底层定时器(t *testing.T) {
	ticker := newManualTicker(time.Hour)
	h := StartWaitHeartbeat(HeartbeatOptions{
		Interval:  time.Hour,
		NewTicker: func(d time.Duration) Ticker { return ticker },
		OnTick:    func(HeartbeatInfo) {},
	})
	if ticker.stopped {
		t.Fatal("运行中的定时器不应已被停掉")
	}
	h.Stop()
	if !ticker.stopped {
		t.Error("Stop 必须调用底层 Ticker.Stop（只置 nil 会泄漏 runtime 定时器）")
	}
}

// TestStop后不再tick 这是「没有泄漏定时器」的可观测判据。
func TestStop后不再tick(t *testing.T) {
	var mu sync.Mutex
	ticks := 0
	ticker := newManualTicker(time.Hour)
	h := StartWaitHeartbeat(HeartbeatOptions{
		Interval:  time.Hour,
		NewTicker: func(d time.Duration) Ticker { return ticker },
		OnTick: func(HeartbeatInfo) {
			mu.Lock()
			ticks++
			mu.Unlock()
		},
	})
	before := h.Ticks()
	h.Stop()
	for i := 0; i < 5; i++ {
		ticker.Fire()
	}
	time.Sleep(80 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if ticks > 1 {
		t.Errorf("Stop 之后仍触发了 %d 次（启动那次之外）", ticks-1)
	}
	_ = before
}

// TestNoteEvent在Stop后无效 停掉之后不该再被事件复活。
func TestNoteEvent在Stop后无效(t *testing.T) {
	ticker := newManualTicker(time.Hour)
	h := StartWaitHeartbeat(HeartbeatOptions{
		Interval:  time.Hour,
		NewTicker: func(d time.Duration) Ticker { return ticker },
		OnTick:    func(HeartbeatInfo) {},
	})
	h.Stop()
	h.NoteEvent(EvThinkingStart)
	if h.Running() {
		t.Error("Stop 之后 NoteEvent 不应重启定时器")
	}
}

// Test已用时随注入时钟推进 已用时必须真在涨，
// 否则「已用时 0 秒」会永远停在那儿。
func Test已用时随注入时钟推进(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1790645535, 0)}
	ticker := newManualTicker(time.Hour)
	var last HeartbeatInfo
	h := StartWaitHeartbeat(HeartbeatOptions{
		Interval:  time.Hour,
		Now:       clock.Now,
		NewTicker: func(d time.Duration) Ticker { return ticker },
		OnTick:    func(info HeartbeatInfo) { last = info },
	})
	defer h.Stop()

	if last.Elapsed != 0 {
		t.Errorf("启动时已用时应为 0，实际 %v", last.Elapsed)
	}
	clock.Advance(7 * time.Second)
	ticker.Fire()
	// 手动 ticker 触发后 OnTick 在另一个 goroutine 里跑，等它落地
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if last.Elapsed >= 7*time.Second {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if last.Elapsed < 7*time.Second {
		t.Errorf("已用时应随时钟推进，实际 %v", last.Elapsed)
	}
}

// Test已用时格式化
func Test已用时格式化(t *testing.T) {
	cases := []struct {
		in   time.Duration
		want string
	}{
		{0, "0 秒"},
		{3500 * time.Millisecond, "4 秒"},
		{90 * time.Second, "1 分 30 秒"},
		{120 * time.Second, "2 分"},
		{3660 * time.Second, "1 小时 1 分"},
		{-5 * time.Second, "0 秒"},
	}
	for _, tc := range cases {
		if got := FormatWaitElapsed(tc.in); got != tc.want {
			t.Errorf("FormatWaitElapsed(%v) = %q, 期望 %q", tc.in, got, tc.want)
		}
	}
}
