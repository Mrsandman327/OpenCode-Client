// stream.go —— 流式回复的渲染回合
//
// 对应 opencode-feishu-bot 的 src/index.ts 的 render() / emitTerminalReply()
// 与 startWaitHeartbeat() 的接线。
//
// 移植而非重设计：这一层修的是三个**已实测确认**的缺陷，任何一个的
// 表现都是「用户在飞书上看不到完整回复」，而根因都不在本文件里：
//
//  1. 没有事件订阅 ⇒ 永远收不到助手回复（bridge.go 的 onReply 零调用方）。
//  2. 逐 delta 发一次卡片更新 ⇒ 撞飞书 230020 限流 ⇒ 更新被静默丢弃
//     ⇒ 卡片冻结在半途。因此必须走 pacer.go 的节流。
//  3. 全文塞进一张卡 ⇒ 撞 30KB 上限 230025 ⇒ 每次更新都失败 ⇒
//     同样冻结在半途。因此主卡只放第一段，尾巴在终态作为「续」卡片发出。
//
// 三个不可退让的约束：
//  1. 心跳**只产出 tick**，卡片更新仍走 render() 的节流路径——
//     另开一条直发 UpdateCard 的路径就是第二条绕过限流的更新路径。
//  2. 终态（段结束 / 整轮结束）force 渲染，不受节流限制：
//     那是保证内容正确的最后一次机会。
//  3. turn 的收尾（退订 + 停心跳）必须**恰好一次**。事件回调是每个
//     事件都跑一遍的，放 defer 会让第一条 thinking.delta 就把心跳停掉。
package feishu

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// CardUpdater 是能更新已发卡片的能力（*Client 满足它）。
//
// 刻意不并进 Output：Output 只有发消息的能力，而大部分测试替身
// （命令、权限卡那些测试）根本不需要更新卡片。做成独立窄接口后，
// 「本替身不支持流式」是一个可断言的事实而不是运行期 panic。
type CardUpdater interface {
	UpdateCard(ctx context.Context, messageID string, card *Card) (SendResult, error)
}

// SubscribeFunc 订阅会话事件流，返回退订函数。
type SubscribeFunc func(sessionID string, cb EventCallback) (func(), error)

// replyStatus 是回复卡的展示态。
type replyStatus string

const (
	statusPending   replyStatus = "pending"
	statusStreaming replyStatus = "streaming"
	statusCompleted replyStatus = "completed"
	statusError     replyStatus = "error"
)

// placeholderText 是正文一个字都还没有时的占位。
//
// 不能是空串：空卡片在飞书上只显示一条蓝线，用户无法判断「在跑」还是「坏了」。
const placeholderText = "（正在等待模型输出…）"

// StreamRenderInterval 是流式渲染的最小间隔。
//
// 飞书对同一消息的卡片更新限流为 5 次/秒；取 1 秒留足余量。
// 1 秒也是用户感知的「实时」上限，再快只是烧额度。
const StreamRenderInterval = time.Duration(DefaultMinIntervalMs) * time.Millisecond

// ReplyCard 生成一张回复卡。
//
// **这是分段计量的唯一口径**：reply_split.go 的 cardBytes 量的是本函数
// 的产物，因此「量出来的」与「发出去的」必然是同一个东西。
// 改这里的结构（加 header、加按钮）会同时改变预算语义——
// 这是刻意的：信封变大了，预算就该跟着变。
func ReplyCard(status replyStatus, content string) *Card {
	var head, template string
	switch status {
	case statusError:
		head, template = "❌ 出错了", TemplateRed
	case statusCompleted:
		head, template = "💬 回复", TemplateWathet
	default:
		head, template = "💬 回复", TemplateBlue
	}
	c := NewCard().WithHeader(head, template)
	if content == "" {
		content = placeholderText
	}
	c.Markdown(content, "normal")
	return c
}

// StreamConfig 是流式回合的配置。
type StreamConfig struct {
	// Subscribe 订阅事件流。缺省时 StartStreamTurn 直接报错——
	// 没有它就收不到任何助手回复，宁可明确失败也不要静默发占位卡。
	Subscribe SubscribeFunc
	// MinInterval 是流式渲染的最小间隔；为 0 时用 StreamRenderInterval。
	MinInterval time.Duration
	// Sleep 可注入，便于测试限流退避。
	Sleep func(ctx context.Context, d time.Duration) error
	// Now 可注入，便于测试控制 elapsed 与节流。
	Now func() time.Time
	// OnFinish 可选：整轮结束时回调一次（用于长任务通知等）。
	OnFinish func(res TurnResult)
	// OnFormCreated 可选：收到 form.created 时回调（参数是 formID）。
	//
	// 回合本身**只管渲染**，推问题卡是桥接层的活：它才有 chatID、
	// OpenCode 客户端与去重状态。回调在流式卡上写好「在等你回答」
	// **之后**才被调用，因此顺序天然正确——用户看到等待提示时，
	// 问题卡已经在路上。
	OnFormCreated func(formID string)
	// OnPermissionAsked 可选：收到 permission.asked 时回调（参数是请求 ID）。
	//
	// 同上：推审批卡由桥接层做。V2 是 inbox 式执行，被权限卡住时
	// message.complete / session.idle 永远不会来，只靠 `/permissions`
	// 补查等于用户永远看不到这张卡。
	OnPermissionAsked func(requestID string)
}

// TurnResult 是一轮结束后的结果摘要。
type TurnResult struct {
	// Elapsed 是本轮耗时。
	Elapsed time.Duration
	// Success 为 false 表示以错误收尾。
	Success bool
	// Content 是本轮的完整正文。
	Content string
	// MainCardDelivered 为 true 表示主卡确实显示了内容。
	MainCardDelivered bool
	// Failure 是终态渲染的失败分类。
	Failure RenderFailure
	// ErrText 是错误文本（Success=false 时有值）。
	ErrText string
}

// streamTurn 是一轮回复的渲染状态。
type streamTurn struct {
	chatID    string
	sessionID string
	// messageID 是占位卡的消息 ID；后续更新都打到它上面。
	messageID string

	out     Output
	updater CardUpdater
	cfg     StreamConfig
	now     func() time.Time

	mu sync.Mutex
	// fullContent 是正文累加结果。
	fullContent string
	// lastResult 是最近一次更新的原始结果，用于区分限流与真失败。
	lastResult SendResult
	finished   bool
	startedAt  time.Time

	state     *RenderState
	heartbeat *Heartbeat

	unsubscribe func()
	cancel      context.CancelFunc
	// ctx 是本回合的 ctx：SSE 读与所有渲染都用它。
	ctx context.Context

	// doneOnce 保证收尾只做一次。
	doneOnce sync.Once
}

// StartStreamTurn 开始一轮流式渲染。
//
// 流程：起订阅 → 发占位卡拿到 messageID → 起心跳。
// 订阅**必须在发消息之前**就绪：OpenCode 的事件流是 live-only 的，
// 事件不重放，晚订阅会丢掉开头的那一批。
//
// 返回的 turn 用于 /abort 与关停；Turn.Stop 可重复调用。
func StartStreamTurn(
	out Output,
	sessionID, chatID string,
	cfg StreamConfig,
) (*streamTurn, error) {
	updater, ok := out.(CardUpdater)
	if !ok {
		// 没有更新卡片的能力就没法流式。明确失败比发一张永远不动的
		// 占位卡好——后者在用户眼里就是「机器人坏了」。
		return nil, errNoCardUpdater
	}
	if cfg.Subscribe == nil {
		return nil, errNoEventSubscriber
	}
	if sessionID == "" {
		return nil, errMissingSessionID
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Sleep == nil {
		cfg.Sleep = defaultSleep
	}
	if cfg.MinInterval <= 0 {
		cfg.MinInterval = StreamRenderInterval
	}

	turnCtx, turnCancel := context.WithCancel(context.Background())
	t := &streamTurn{
		chatID:    chatID,
		sessionID: sessionID,
		out:       out,
		updater:   updater,
		cfg:       cfg,
		now:       cfg.Now,
		state:     NewRenderState(),
		cancel:    turnCancel,
		ctx:       turnCtx,
		startedAt: cfg.Now(),
	}

	unsub, err := cfg.Subscribe(sessionID, t.handleEvent)
	if err != nil {
		turnCancel()
		return nil, err
	}
	t.unsubscribe = unsub

	// 心跳对象在订阅**之后**才建（先订阅是为了不丢开头的事件），
	// 因此事件可能在 heartbeat 还是 nil 时就被投递。读侧一律走
	// noteEvent / stopHeartbeat，它们判空——把顺序依赖写进注释
	// 是不行的，那只是把 bug 挪到下一次重构。
	hb := StartWaitHeartbeat(HeartbeatOptions{
		Now: cfg.Now,
		OnTick: func(info HeartbeatInfo) {
			t.render(statusPending, false, WaitingCardText(info))
		},
	})
	t.mu.Lock()
	t.heartbeat = hb
	t.mu.Unlock()

	messageID, err := out.SendCard(turnCtx, chatID, ReplyCard(statusPending, ""))
	if err != nil {
		t.stop()
		return nil, fmt.Errorf("发送占位卡片失败: %w", err)
	}
	t.setMessageID(messageID)

	return t, nil
}

// noteEvent 喂事件给心跳；心跳还没建好时静默忽略。
func (t *streamTurn) noteEvent(eventType string) {
	t.mu.Lock()
	hb := t.heartbeat
	t.mu.Unlock()
	if hb != nil {
		hb.NoteEvent(eventType)
	}
}

// stopHeartbeat 停心跳；心跳还没建好时是空操作。
func (t *streamTurn) stopHeartbeat() {
	t.mu.Lock()
	hb := t.heartbeat
	t.mu.Unlock()
	if hb != nil {
		hb.Stop()
	}
}

// heartbeatStopped 心跳是否已停（可能还没建）。
func (t *streamTurn) heartbeatStopped() bool {
	t.mu.Lock()
	hb := t.heartbeat
	t.mu.Unlock()
	return hb == nil || hb.Stopped()
}

// setMessageID 记录占位卡的消息 ID。
func (t *streamTurn) setMessageID(id string) {
	t.mu.Lock()
	t.messageID = id
	t.mu.Unlock()
}

// targetID 取出占位卡的消息 ID。
//
// 读侧必须持锁：SSE goroutine 可能在 messageID 写入之前就开始投递事件。
func (t *streamTurn) targetID() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.messageID
}

// elapsed 是本轮已用时。
func (t *streamTurn) elapsed() time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.now().Sub(t.startedAt)
}

// Stop 停掉本回合：心跳 + 订阅 + ctx。幂等。
func (t *streamTurn) Stop() { t.stop() }

// stop 停掉本回合：心跳 + 订阅 + ctx。幂等。
//
// 置 finished 是必须的：退订之后仍可能有**已在途**的回调被投递
// （事件回调是同步调用，退订拦不住已经进来的那一个）。
// 不置的话 /abort 之后卡片还会被那批事件再改一次。
func (t *streamTurn) stop() {
	t.doneOnce.Do(func() {
		t.mu.Lock()
		t.finished = true
		t.mu.Unlock()
		t.stopHeartbeat()
		if t.unsubscribe != nil {
			t.unsubscribe()
		}
		if t.cancel != nil {
			t.cancel()
		}
	})
}

// render 发一次卡片更新。force=true 用于终态，不受节流限制。
//
// contentOverride 供等待期心跳塞「已用时 + 阶段」，覆盖掉占位文案。
func (t *streamTurn) render(status replyStatus, force bool, contentOverride string) {
	if t.targetID() == "" {
		return
	}
	if !t.state.Throttle(t.now(), t.cfg.MinInterval, force) {
		// 被节流跳过：内容会在下一次放行或终态时补上
		return
	}

	// 主卡只放得下第一段。超限的尾巴留到终态再作为「续」卡片发出——
	// 直接把全文塞进去会让每次 UpdateCard 都撞 230025 全被丢弃，
	// 那才是「半截」的真正成因。
	//
	// 流式期用 StreamOverflowNotice（明说「完成后会续发」）而不是
	// 终态的 SplitHeadNotice（说「见下方续卡片」）——流式期续卡片
	// 还不存在，照抄终态文案就是骗用户。
	visible := contentOverride
	if visible == "" {
		visible = FirstSegment(t.content(), cardBytes, FirstSegmentOptions{
			HeadNotice: StreamOverflowNotice,
		})
	}

	t.update(ReplyCard(status, visible))
}

// update 执行一次卡片更新并记账节流状态。
func (t *streamTurn) update(card *Card) {
	target := t.targetID()
	if target == "" {
		return
	}
	ok, _ := RenderWithRetry(t.ctx, func(ctx context.Context) (SendResult, error) {
		res, err := t.updater.UpdateCard(ctx, target, card)
		t.setResult(res)
		return res, err
	}, t.cfg.Sleep)

	if ok {
		t.state.MarkRendered(t.now())
	} else {
		t.state.MarkRateLimited()
	}
}

func (t *streamTurn) content() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.fullContent
}

func (t *streamTurn) setResult(res SendResult) {
	t.mu.Lock()
	t.lastResult = res
	t.mu.Unlock()
}

func (t *streamTurn) result() SendResult {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.lastResult
}

// handleEvent 处理一条内部事件。
func (t *streamTurn) handleEvent(ev AgentEvent) {
	t.mu.Lock()
	if t.finished {
		t.mu.Unlock()
		return
	}
	t.mu.Unlock()

	// 每个事件都喂给心跳：有进展就更新阶段文案，
	// 出现正文 delta 就可靠地停掉心跳。
	t.noteEvent(ev.Type)

	switch ev.Type {
	case EvThinkingStart, EvThinkingDelta, EvThinkingComplete:
		// 只推进阶段文案，不动正文，也**不停心跳**（见 wait_heartbeat.go）
		t.render(statusPending, false, "")

	case EvMessageDelta:
		t.appendContent(ev.Properties.Delta)
		t.render(statusStreaming, false, "")

	case EvMessageSegmentComplete:
		// 该段的权威完整正文。**覆盖**累加结果：delta 可能因限流或
		// 事件流断线而缺失，而 text.ended 每次都带完整内容。
		// 强制渲染——这是本段最后一次机会，不能被节流跳过。
		if ev.Properties.Text != "" {
			t.setContent(ev.Properties.Text)
		}
		t.render(statusStreaming, true, "")

	case EvMessageComplete:
		t.finish(true, "")

	case EvError:
		t.finish(false, ev.Properties.Error)

	case EvAbort:
		t.finish(false, "已中止")

	case EvPermissionAsked, EvFormCreated:
		// V2 是 inbox 式执行：本轮被权限/form 卡住时 message.complete /
		// session.idle **永远不会来**。这两类事件必须立刻有可见反应，
		// 且必须**停掉心跳**——否则卡片会永远转「正在思考」，
		// 用户既看不到内容也看不到要他做什么。
		//
		// 顺序很重要：先 force 渲染「在等你回答」把流式卡定住，
		// **再**回调推卡。反过来先推卡的话，用户可能在流式卡上
		// 仍看到「正在思考」就去点问题卡，两张卡自相矛盾。
		t.stopHeartbeat()
		t.render(statusPending, true, pendingActionNotice(ev.Type))

		// 推卡由桥接层做：它才有 chatID、OpenCode 客户端与去重状态。
		switch {
		case ev.Type == EvFormCreated && ev.Properties.FormID != "" && t.cfg.OnFormCreated != nil:
			t.cfg.OnFormCreated(ev.Properties.FormID)
		case ev.Type == EvPermissionAsked && ev.Properties.PermissionID != "" && t.cfg.OnPermissionAsked != nil:
			t.cfg.OnPermissionAsked(ev.Properties.PermissionID)
		}

	default:
		// 工具事件不改正文：文本段之间可能有很长的空窗（工具在跑），
		// 靠心跳撑着阶段文案即可
		t.render(statusPending, false, "")
	}
}

// pendingActionNotice 是被权限/form 卡住时卡片上的说明。
func pendingActionNotice(eventType string) string {
	if eventType == EvFormCreated {
		return "📝 正在等待你回答问题卡片…"
	}
	return "🔐 正在等待你批准权限请求…"
}

func (t *streamTurn) appendContent(delta string) {
	if delta == "" {
		return
	}
	t.mu.Lock()
	t.fullContent += delta
	t.mu.Unlock()
}

func (t *streamTurn) setContent(text string) {
	t.mu.Lock()
	t.fullContent = text
	t.mu.Unlock()
}

// finish 收尾。**必须幂等**：message.complete 与 session.idle 可能都到，
// 且 /abort 与关停也会走这里。
func (t *streamTurn) finish(success bool, errText string) {
	t.mu.Lock()
	if t.finished {
		t.mu.Unlock()
		return
	}
	t.finished = true
	t.mu.Unlock()

	t.stopHeartbeat()

	// 终态：把超长正文按卡片字节预算分段，主卡拿第一段，
	// 其余作为「续」卡片发出。
	//
	// render 会重算 FirstSegment，所以终态必须**直接传入**已算好的段 0——
	// 否则段 0 会被二次分段，切点落在别处，续卡片与主卡之间
	// 还会出现内容缺口或重叠。
	content := t.content()
	plan := PlanReplySegments(PlanOptions{
		Content:    content,
		Measure:    cardBytes,
		HeadNotice: SplitHeadNotice,
		DropNotice: TailDroppedNotice,
	})
	head := content
	if len(plan.Segments) > 0 {
		head = plan.Segments[0]
	}
	if head == "" {
		head = placeholderText
	}

	status := statusCompleted
	if !success {
		status = statusError
	}
	card := ReplyCard(status, head)
	if !success && errText != "" {
		// 错误详情必须落在**这张**卡上：它是用户此刻唯一能看到的地方。
		// 另发一条文本消息既多一次发送，又可能与主卡的更新竞态。
		card.Note(errText)
	}
	t.update(card)

	// 续卡片走**新消息**（SendCard），不走 UpdateCard：新消息没有
	// 5QPS 的单消息更新频控，也不受主卡节流状态影响。
	t.sendContinuation(plan)

	failure := ClassifyRenderFailure(t.result())
	if t.cfg.OnFinish != nil {
		t.cfg.OnFinish(TurnResult{
			Elapsed:           t.elapsed(),
			Success:           success,
			Content:           content,
			MainCardDelivered: failure == RenderFailureNone,
			Failure:           failure,
			ErrText:           errText,
		})
	}

	// 收尾后本回合不再需要事件流
	t.stop()
}

// sendContinuation 发出段 1..N 的「续」卡片。
func (t *streamTurn) sendContinuation(plan SegmentPlan) {
	if len(plan.Segments) <= 1 {
		return
	}
	for i := 1; i < len(plan.Segments); i++ {
		seg := plan.Segments[i]
		if strings.TrimSpace(seg) == "" {
			continue
		}
		if _, err := t.out.SendCard(t.ctx, t.chatID, ReplyCard(statusCompleted, seg)); err != nil {
			logf("发送续卡片失败 chat=%s index=%d: %v", t.chatID, i, err)
		}
	}
	if plan.DroppedTail != "" {
		logf("回复超长，已省略尾部 chat=%s segments=%d dropped=%d 字符",
			t.chatID, len(plan.Segments), len([]rune(plan.DroppedTail)))
	}
}
