//go:build feishu

// wait_heartbeat.go —— 等待期心跳
//
// 对应 opencode-feishu-bot 的 src/feishu/wait-heartbeat.ts。
//
// 缺陷根因（实测确证，探针事件序列）：
//
//	7203ms  thinking.start
//	7306ms  thinking.delta
//	...
//	7715ms  message.delta / message.segment.complete / message.complete
//
// 事件层流式是通的，但**首个事件到达前有 7.2 秒静默**：卡片停在
// 「正在思考…」，用户无法区分「在跑」还是「卡死」。
//
// 三条不可退让的约束：
//  1. 心跳**不得**自己发 UpdateCard。它只产生一个 tick，具体的卡片更新
//     仍由调用方交给渲染层的节流/重试路径，与流式渲染共用同一套节流。
//     否则就是第二条绕过限流的更新路径，会重演 230020 限流 + 内容被静默丢弃。
//  2. NoteEvent 之外任何路径停止心跳，都必须真正停掉定时器。
//  3. 阶段判定与文案必须是纯函数，测试要能在不启动定时器的情况下断言。
//
// 判据上与 bot 侧**有意不同**：thinking.* 只推进阶段文案，**不停心跳**。
// 首事件常常就是 thinking.start（实测序列的第一条），一见到它就停，
// 死区只是从「首事件前」平移到「思考期」——而思考期往往几十秒。
// 只有 message.delta 出现（正文真的在动）才停。
package feishu

import (
	"fmt"
	"sync"
	"time"
)

// WaitStage 是等待期的阶段。
type WaitStage string

const (
	// StageWaiting 还没收到任何事件——最需要安抚的状态（最坏情况：上游卡住）。
	StageWaiting WaitStage = "waiting"
	// StageThinking 模型在思考。
	StageThinking WaitStage = "thinking"
	// StageWriting 模型在组织回答 / 执行工具（此时已不再是「空白等待」）。
	StageWriting WaitStage = "writing"
	// StageDone 本轮结束。
	StageDone WaitStage = "done"
)

// HeartbeatInterval 是心跳间隔。
//
// 2~3 秒是用户能感知「还活着」又不至于刷屏的区间。
// 取值上限受飞书卡片更新频控（同一消息 5 次/秒）约束，本值远低于它，
// 真正拦住超频的是渲染层的节流，而不是这里。
const HeartbeatInterval = 2500 * time.Millisecond

// stageLabel 是各阶段的中文标签。
var stageLabel = map[WaitStage]string{
	StageWaiting:  "⏳ 正在思考…",
	StageThinking: "🤔 思考中…",
	StageWriting:  "✍️ 组织回答中…",
	StageDone:     "✅ 已完成",
}

// noEventHint 是收到第一个事件前的额外说明。
//
// 这是用户唯一能判断「是不是卡了」的信息，去掉它心跳就退化成
// 一个只会变的秒数。
const noEventHint = "（尚未收到模型输出）"

// FormatWaitElapsed 是紧凑的已用时文案。
func FormatWaitElapsed(ms time.Duration) string {
	totalSec := int64(ms.Round(time.Second) / time.Second)
	if totalSec < 0 {
		totalSec = 0
	}
	if totalSec < 60 {
		return fmt.Sprintf("%d 秒", totalSec)
	}
	min := totalSec / 60
	sec := totalSec % 60
	if min < 60 {
		if sec > 0 {
			return fmt.Sprintf("%d 分 %d 秒", min, sec)
		}
		return fmt.Sprintf("%d 分", min)
	}
	hour := min / 60
	return fmt.Sprintf("%d 小时 %d 分", hour, min%60)
}

// HeartbeatInfo 是心跳的对外快照。
type HeartbeatInfo struct {
	// Elapsed 是自本轮开始已用时。
	Elapsed time.Duration
	// Stage 是当前阶段。
	Stage WaitStage
	// FirstEventAt 是首个有意义事件的时刻；IsZero 表示一个事件都还没收到。
	FirstEventAt time.Time
	// SeenEvents 是已收到的事件数。
	SeenEvents int
	// Ticks 是已心跳次数（供测试断言节流确实生效）。
	Ticks int
}

// WaitingCardText 是等待期卡片正文。
//
// 纯函数：无 IO、无定时器，可直接单测。
func WaitingCardText(info HeartbeatInfo) string {
	label := stageLabel[info.Stage]
	elapsed := "已用时 " + FormatWaitElapsed(info.Elapsed)
	// 一个事件都没有时额外提示：这是用户唯一能判断「是不是卡了」的信息
	if info.FirstEventAt.IsZero() && info.Stage == StageWaiting {
		return label + " · " + elapsed + "\n" + noEventHint
	}
	return label + " · " + elapsed
}

// EventEffect 是 NoteEvent 的处理结果：只更新阶段，还是应当停心跳。
type EventEffect struct {
	Stage WaitStage
	// Stops 为 true 表示本事件会带来**可见的正文变化**，卡片此后由内容
	// delta 驱动，心跳必须停（否则与流式渲染抢更新额度）。
	Stops bool
}

// EffectOfEvent 给出事件类型对等待期的影响。
//
// 关键取舍：thinking.* **不停止**心跳。首事件常常是 thinking.start，
// 若一见到它就停，随后长达几十秒的思考期卡片又会纹丝不动——
// 那等于把要修的死区从「首事件前」平移到「思考期」。
// 只有 message.delta 出现后，正文才真的在动，才交给流式渲染接管。
//
// 返回 ok=false 表示与等待期无关（form / permission / session 等）。
func EffectOfEvent(eventType string) (EventEffect, bool) {
	switch eventType {
	case EvThinkingStart, EvThinkingDelta, EvThinkingComplete:
		return EventEffect{Stage: StageThinking}, true
	case EvMessageStart, EvMessageSegmentComplete:
		return EventEffect{Stage: StageWriting}, true
	// 工具执行发生在文本段之间，卡片同样没人驱动，靠心跳撑着
	case EvToolStart, EvToolDelta, EvToolComplete:
		return effectWriting()
	case EvMessageDelta:
		return EventEffect{Stage: StageWriting, Stops: true}, true
	case EvMessageComplete, EvError, EvAbort:
		return EventEffect{Stage: StageDone, Stops: true}, true
	default:
		return EventEffect{}, false
	}
}

// effectWriting 是「工具执行 / 段开始」这类只推进阶段、不停心跳的效果。
func effectWriting() (EventEffect, bool) {
	return EventEffect{Stage: StageWriting}, true
}

// Ticker 是可停止的定时器，抽象出来便于测试注入。
type Ticker interface {
	C() <-chan time.Time
	Stop()
}

type realTicker struct{ t *time.Ticker }

func (r realTicker) C() <-chan time.Time { return r.t.C }
func (r realTicker) Stop()               { r.t.Stop() }

// Heartbeat 是等待期心跳。
type Heartbeat struct {
	mu   sync.Mutex
	opts HeartbeatOptions

	// startedAt 是本轮起点（用 opts.now 取，保证与注入时钟同源）。
	startedAt time.Time
	stage     WaitStage
	firstAt   time.Time
	seen      int
	ticks     int
	running   bool
	// stopped 为 true 表示已经 Stop 过。此后 NoteEvent 不得再启动定时器——
	// 复活一个已收尾的回合会让卡片在用户已经离开后继续跳「正在思考」。
	stopped   bool
	ticker    Ticker
	stopTimer chan struct{}
	stopOnce  sync.Once
}

// HeartbeatOptions 是心跳的参数。
type HeartbeatOptions struct {
	// OnTick 是心跳回调。**不得**在这里直接调 UpdateCard——
	// 交给调用方的渲染层走节流路径。
	OnTick func(info HeartbeatInfo)
	// Interval 为 0 时用 HeartbeatInterval。
	Interval time.Duration
	// Now 可注入，供测试控制已用时；为 nil 用 time.Now。
	Now func() time.Time
	// NewTicker 可注入，供测试手动触发；为 nil 用真实 time.Ticker。
	NewTicker func(d time.Duration) Ticker
}

func (o *HeartbeatOptions) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

func (o *HeartbeatOptions) interval() time.Duration {
	if o.Interval > 0 {
		return o.Interval
	}
	return HeartbeatInterval
}

func (o *HeartbeatOptions) newTicker(d time.Duration) Ticker {
	if o.NewTicker != nil {
		return o.NewTicker(d)
	}
	return realTicker{t: time.NewTicker(d)}
}

// StartWaitHeartbeat 启动等待期心跳。
//
// 定时器句柄只保存在本对象内，Stop() 一定停掉它并且置 nil——
// 重复调用 Stop() 安全，不会二次停。
func StartWaitHeartbeat(opts HeartbeatOptions) *Heartbeat {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	h := &Heartbeat{
		opts:      opts,
		startedAt: opts.Now(),
		stage:     StageWaiting,
		stopTimer: make(chan struct{}),
	}
	// 立即跑一次：用户按下发送后 0 秒就该看到带用时的卡片，
	// 而不是等 2.5 秒才第一次动。
	h.fire()
	h.start()
	return h
}

func (h *Heartbeat) fire() {
	h.mu.Lock()
	h.ticks++
	info := HeartbeatInfo{
		Elapsed:      h.opts.now().Sub(h.startedAt),
		Stage:        h.stage,
		FirstEventAt: h.firstAt,
		SeenEvents:   h.seen,
		Ticks:        h.ticks,
	}
	cb := h.opts.OnTick
	h.mu.Unlock()
	if cb != nil {
		cb(info)
	}
}

// NoteEvent 喂一个事件进来：更新阶段，必要时停/起心跳。
func (h *Heartbeat) NoteEvent(eventType string) {
	effect, ok := EffectOfEvent(eventType)
	if !ok {
		return
	}

	h.mu.Lock()
	// 首个有意义事件：记时刻，供文案区分「完全没动静」与「有进展」
	if h.firstAt.IsZero() {
		h.firstAt = h.opts.now()
	}
	h.seen++
	h.stage = effect.Stage
	stop := effect.Stops
	h.mu.Unlock()

	if stop {
		h.Stop()
		return
	}
	h.start()
}

// Stop 主动停止（整轮结束、异常、/abort）。可重复调用。
func (h *Heartbeat) Stop() {
	h.stopOnce.Do(func() { close(h.stopTimer) })
	h.mu.Lock()
	defer h.mu.Unlock()
	h.running = false
	h.stopped = true
	if h.ticker != nil {
		h.ticker.Stop()
		h.ticker = nil
	}
}

// Running 定时器是否在跑。用于测试断言「没有泄漏定时器」。
func (h *Heartbeat) Running() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.running
}

// Stopped 是否已经被 Stop 过。Stop 后 NoteEvent 不得再复活它。
func (h *Heartbeat) Stopped() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.stopped
}

// Stage 当前阶段。
func (h *Heartbeat) Stage() WaitStage {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.stage
}

// Ticks 已心跳次数。
func (h *Heartbeat) Ticks() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.ticks
}

// start 幂等地启动定时器。
func (h *Heartbeat) start() {
	h.mu.Lock()
	if h.ticker != nil || h.stopped {
		h.mu.Unlock()
		return
	}
	t := h.opts.newTicker(h.opts.interval())
	h.ticker = t
	h.running = true
	h.mu.Unlock()

	go func() {
		ch := t.C()
		for {
			select {
			case <-ch:
				h.mu.Lock()
				done := h.ticker == nil
				h.mu.Unlock()
				if done {
					return
				}
				h.fire()
			case <-h.stopTimer:
				return
			}
		}
	}()
}
