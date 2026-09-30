// opencode_events.go —— 事件订阅的真实实现
//
// 对应 opencode-feishu-bot 的 src/opencode/client.ts 的 subscribeToEvents
// （含其「V2 事件流是 live-only、源断开即结束，因此必须自己重连」的结论）。
//
// 三条不可退让的约束（都是踩过的坑）：
//  1. **必须重连**。V2 的 /api/event 无自动重连、无回放：服务端重启或
//     网络抖动一次，流就永久结束。此前的症状是「第一天能收到回复，
//     第二天开始机器人只发占位卡」——不是逻辑错，是流早就死了而没人管。
//  2. **退订必须真的停**。返回一个只置标志位、让阻塞中的读继续跑到底的
//     函数，等于没退订：goroutine 会一直挂在 http.Read 上。
//     这里的做法是 cancel ctx——http 请求会被 ctx 立刻中断。
//  3. **退订可重复调用**。StopFeishu 与回合结束的退订路径都会调它，
//     第二次调用必须安全（否则 panic 崩在关停路径上）。
package feishu

import (
	"context"
	"sync"
	"time"

	"oc-manager/service/opencode"
)

// EventReconnectDelay 是断线后的重连等待。
//
// 取 1500ms（与 bot 侧一致）：OpenCode 服务重启通常在数秒内完成，
// 太短会连着锤一个刚起的服务，太长用户会明显感到「机器人不响应了」。
const EventReconnectDelay = 1500 * time.Millisecond

// subscribe is 可注入的底层订阅实现，便于测试重连与退订语义。
type subscribeFunc func(ctx context.Context, onPayload func(payload string)) error

// RealOpenCode.SubscribeEvents 订阅会话事件流。
func (r *RealOpenCode) SubscribeEvents(sessionID string, cb EventCallback) (func(), error) {
	return r.subscribeEvents(sessionID, cb, opencode.SubscribeOpenCodeEvents)
}

func (r *RealOpenCode) subscribeEvents(
	sessionID string,
	cb EventCallback,
	subscribe subscribeFunc,
) (func(), error) {
	if sessionID == "" {
		return nil, errMissingSessionID
	}
	if cb == nil {
		return nil, errNilCallback
	}
	if subscribe == nil {
		return nil, errNilSubscriber
	}

	ctx, cancel := context.WithCancel(context.Background())
	var once sync.Once
	stop := func() { once.Do(cancel) }

	go func() {
		for {
			if ctx.Err() != nil {
				return
			}
			err := subscribe(ctx, func(payload string) {
				// 翻译是纯函数、会按 sessionID 过滤；翻译不出来的
				// （别的会话 / 中间边界 / 未识别类型）直接丢。
				ev, ok := TranslateEvent(sessionID, []byte(payload))
				if !ok {
					return
				}
				cb(ev)
			})
			if ctx.Err() != nil {
				return
			}
			// 走到这里只有两种可能：服务端断开（要重连）或订阅实现返回错误
			// （同样要重连）。V2 不会「正常结束」流。
			if err != nil {
				logf("事件流中断，%.1fs 后重连: %v", EventReconnectDelay.Seconds(), err)
			} else {
				logf("事件流结束，%.1fs 后重连", EventReconnectDelay.Seconds())
			}
			if !sleepCtx(ctx, EventReconnectDelay) {
				return
			}
		}
	}()

	return stop, nil
}

// sleepCtx 睡 d 秒；ctx 提前结束返回 false。
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
