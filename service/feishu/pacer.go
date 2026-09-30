// pacer.go —— 流式卡片更新的节流与限流退避
//
// 直接移植 opencode-feishu-bot 的 src/feishu/stream-pacer.ts。
// 移植而非重写，是因为那个模块修的是一个**已实测确认**的缺陷：
// 逐 delta 发一次卡片更新 → 撞飞书 230020 限流 → 更新被静默丢弃
// → 卡片冻结在半途（用户看到的「回复半截」）。
//
// 飞书对同一消息的卡片更新限流为 5 次/秒。这里取 1 秒最小间隔，
// 留足余量；终态渲染 force，绕过节流。
package feishu

import (
	"context"
	"strings"
	"sync"
	"time"
)

// DefaultMinIntervalMs 是两次流式渲染之间的最小间隔。
const DefaultMinIntervalMs = 1000

// MaxRenderAttempts 是限流重试上限（含首次），避免无限重试。
const MaxRenderAttempts = 4

// RenderState 是一次流式回复的渲染节流状态。
type RenderState struct {
	mu sync.Mutex
	// lastRenderedAt 上次真正发出更新的时刻；零值表示还没发过
	lastRenderedAt time.Time
	// pending 有内容变化但因节流未发出
	pending bool
	// rateLimited 曾因限流失败，尚未成功补发
	rateLimited bool
}

// NewRenderState 建一个初始状态。
func NewRenderState() *RenderState { return &RenderState{} }

// Pending 是否有待渲染内容。
func (s *RenderState) Pending() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pending
}

// RateLimited 上一次是否因限流失败。
func (s *RenderState) RateLimited() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rateLimited
}

// Throttle 判断本次是否真的发更新。
//
// force=true 时无视间隔强制放行：终态渲染是保证内容正确的最后一次机会，
// 不能因为节流被跳过。
func (s *RenderState) Throttle(now time.Time, minInterval time.Duration, force bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	if force {
		// 强制渲染消费待发标记：本次发的是最新全量内容
		s.pending = false
		return true
	}

	if s.lastRenderedAt.IsZero() || now.Sub(s.lastRenderedAt) >= minInterval {
		s.pending = false
		return true
	}

	s.pending = true
	return false
}

// MarkRendered 记录一次成功发出的更新。
//
// 刻意不在 Throttle 里记时间：发送失败时应尽快重试，
// 而非被自己的「上次成功」挡住。
func (s *RenderState) MarkRendered(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastRenderedAt = now
	s.pending = false
	s.rateLimited = false
}

// MarkRateLimited 记录一次因限流失败的更新，保留待发标记等待补发。
func (s *RenderState) MarkRateLimited() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rateLimited = true
	s.pending = true
}

// backoffMs 是限流重试的指数退避（封顶 4s）。
func backoffMs(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	// 注意：基准必须是 400 * time.Millisecond。
	// 写成 time.Duration(400) 会被当作 400 纳秒，退避短 1000 倍，
	// 等于在已被限流的端点上继续锤——限流反而会延长。
	d := 400 * time.Millisecond * time.Duration(1<<uint(attempt))
	if d > 4*time.Second {
		d = 4 * time.Second
	}
	return d
}

// SendResult 是一次卡片更新的结果。
type SendResult struct {
	Success     bool
	RateLimited bool
}

// RenderFailure 是渲染失败的分类。
//
// UpdateCard 对**所有**失败都只返回不抛，而调用方很容易忽略返回值，
// 于是「超限(230025) / 无权限 / 消息已删」和「限流(230020)」被同等对待：
// 都只写一行日志、都不重试、都不告诉用户 —— 卡片静默冻结在半途。
// 两者必须区别对待：
//   - RenderFailureRateLimited：暂态，RenderWithRetry 已经退避重试过，
//     重试仍失败说明短时间内救不回来，用户也无需知道（他正在看别的内容）。
//   - RenderFailureHard：真失败（超限、无权限、消息被删）。内容**真的丢了**，
//     必须让用户知道，否则「半截」在他眼里就是机器人坏了。
type RenderFailure string

const (
	RenderFailureNone        RenderFailure = "none"
	RenderFailureRateLimited RenderFailure = "rate-limited"
	RenderFailureHard        RenderFailure = "hard"
)

// ClassifyRenderFailure 把一次更新的结果归类。
func ClassifyRenderFailure(res SendResult) RenderFailure {
	if res.Success {
		return RenderFailureNone
	}
	if res.RateLimited {
		return RenderFailureRateLimited
	}
	return RenderFailureHard
}

// IsUserVisibleFailure 是否需要让用户知道。只有真失败才打扰。
func IsUserVisibleFailure(f RenderFailure) bool {
	return f == RenderFailureHard
}

// RenderFailureNotice 是真失败时发给用户的话；返回空串表示不该打扰。
//
// 抽成纯函数而不是在渲染层里拼字符串：判断标准（「限流不打扰、
// 真失败必须说」）本身是产品决策，值得被单测钉住。
func RenderFailureNotice(f RenderFailure, subject, reason, recovery string) string {
	if !IsUserVisibleFailure(f) {
		return ""
	}
	if subject == "" {
		subject = "回复卡片"
	}
	if reason != "" {
		subject += "（" + reason + "）"
	}
	lines := []string{"⚠️ " + subject + "更新失败，上方内容可能不完整。"}
	if recovery != "" {
		lines = append(lines, recovery)
	}
	return strings.Join(lines, "\n\n")
}

// RateLimitError 是飞书限流的错误码。
const RateLimitError = 230020

// UpdateFunc 是一次卡片更新操作。
type UpdateFunc func(ctx context.Context) (SendResult, error)

// RenderWithRetry 带限流重试地执行一次渲染。
//
// 只对限流重试：其它失败（消息已删除、无权限等）重试无意义，立即返回。
// 睡眠函数可注入，便于测试。
func RenderWithRetry(ctx context.Context, send UpdateFunc, sleep func(context.Context, time.Duration) error) (bool, error) {
	if sleep == nil {
		sleep = defaultSleep
	}
	var lastErr error
	for attempt := 0; attempt < MaxRenderAttempts; attempt++ {
		res, err := send(ctx)
		if err != nil {
			// 抛错视为非限流失败，不重试
			return false, err
		}
		if res.Success {
			return true, nil
		}
		if !res.RateLimited {
			return false, nil
		}
		lastErr = err
		if attempt == MaxRenderAttempts-1 {
			break
		}
		if serr := sleep(ctx, backoffMs(attempt)); serr != nil {
			return false, serr
		}
	}
	// 重试耗尽仍限流：不是致命错误，调用方通常只需继续等下一次强制渲染
	return false, lastErr
}

func defaultSleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
