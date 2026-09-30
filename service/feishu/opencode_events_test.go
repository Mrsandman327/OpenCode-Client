// opencode_events_test.go —— 事件订阅的生命周期
//
// 三条约束各有对应测试：必须重连、退订必须真的停、退订可重复调用。
// 任何一条漏掉，症状都是「第一天能收到回复，第二天开始机器人只发占位卡」。
package feishu

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeSubscribe 是一个可编排的订阅实现。
type fakeSubscribe struct {
	mu sync.Mutex
	// attempts 记录被调用的次数（每次调用 = 一次连接尝试）。
	attempts int
	// perAttempt 第 n 次调用（从 1 开始）要投递的载荷。
	perAttempt map[int][]string
	// block 为 true 时在投递完载荷后阻塞，直到 ctx 结束。
	block bool
	// observedCtx 记录最后一次调用看到的 ctx 是否已取消。
	sawCancel atomic.Bool
}

func (f *fakeSubscribe) call(ctx context.Context, onPayload func(string)) error {
	f.mu.Lock()
	f.attempts++
	n := f.attempts
	payloads := f.perAttempt[n]
	f.mu.Unlock()

	for _, p := range payloads {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		onPayload(p)
	}
	if f.block {
		<-ctx.Done()
		f.sawCancel.Store(true)
		return ctx.Err()
	}
	return fmt.Errorf("模拟断开 %d", n)
}

func (f *fakeSubscribe) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.attempts
}

// textDeltaPayload 造一条最小可翻译的载荷。
func textDeltaPayload(sid, delta string) string {
	return fmt.Sprintf(`{"type":"session.text.delta","data":{"sessionID":%q,"delta":%q}}`, sid, delta)
}

func newReal() *RealOpenCode { return NewRealOpenCode() }

// Test缺会话ID时报错 没有会话就没法过滤事件。
func Test缺会话ID时报错(t *testing.T) {
	_, err := newReal().subscribeEvents("", func(AgentEvent) {}, func(context.Context, func(string)) error {
		return nil
	})
	if err == nil {
		t.Error("缺会话 ID 时必须报错")
	}
}

// Test空回调报错 nil 回调会在第一条事件上 panic。
func Test空回调报错(t *testing.T) {
	_, err := newReal().subscribeEvents("ses_1", nil, func(context.Context, func(string)) error {
		return nil
	})
	if err == nil {
		t.Error("空回调必须报错")
	}
}

// Test空订阅实现报错
func Test空订阅实现报错(t *testing.T) {
	_, err := newReal().subscribeEvents("ses_1", func(AgentEvent) {}, nil)
	if err == nil {
		t.Error("nil 订阅实现必须报错")
	}
}

// Test事件按会话过滤 SSE 是全局流，一个进程上跑着所有会话的事件。
func Test事件按会话过滤(t *testing.T) {
	sub := &fakeSubscribe{
		perAttempt: map[int][]string{
			1: {
				textDeltaPayload("ses_1", "自己的"),
				textDeltaPayload("ses_2", "别人的"),
			},
		},
	}
	var got []string
	stop, err := newReal().subscribeEvents("ses_1", func(ev AgentEvent) {
		if ev.Type == EvMessageDelta {
			got = append(got, ev.Properties.Delta)
		}
	}, sub.call)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()

	waitFor(t, func() bool { return len(got) > 0 })
	stop()

	if len(got) != 1 || got[0] != "自己的" {
		t.Errorf("只应收到本会话的事件，实际 %v", got)
	}
}

// Test断开后自动重连 V2 的事件流是 live-only、无自动重连、无回放。
// 不重连的症状是「第一天能收到回复，第二天开始只发占位卡」。
func Test断开后自动重连(t *testing.T) {
	sub := &fakeSubscribe{
		perAttempt: map[int][]string{
			1: {textDeltaPayload("ses_1", "第一段连接")},
			2: {textDeltaPayload("ses_1", "第二段连接")},
		},
	}
	var mu sync.Mutex
	var got []string
	stop, err := newReal().subscribeEvents("ses_1", func(ev AgentEvent) {
		if ev.Type == EvMessageDelta {
			mu.Lock()
			got = append(got, ev.Properties.Delta)
			mu.Unlock()
		}
	}, sub.call)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()

	// 重连延迟是 1.5 秒，放宽到 3 秒
	waitFor(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(got) >= 2
	})
	stop()

	mu.Lock()
	defer mu.Unlock()
	if len(got) < 2 {
		t.Fatalf("断开后应自动重连并继续收事件，实际收到 %v（连接次数 %d）", got, sub.count())
	}
	if got[0] != "第一段连接" || got[1] != "第二段连接" {
		t.Errorf("重连后应继续消费新事件，实际 %v", got)
	}
}

// Test退订真的停掉底层读 只置标志位、让阻塞中的读继续跑到底，
// 等于没退订：goroutine 会一直挂在 http.Read 上。
func Test退订真的停掉底层读(t *testing.T) {
	sub := &fakeSubscribe{block: true}
	stop, err := newReal().subscribeEvents("ses_1", func(AgentEvent) {}, sub.call)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return sub.count() == 1 })
	stop()

	// 底层实现阻塞在 <-ctx.Done() 上；退订后必须被唤醒
	waitFor(t, func() bool { return sub.sawCancel.Load() })

	// 退订后不应再有新的连接尝试
	n := sub.count()
	time.Sleep(200 * time.Millisecond)
	if got := sub.count(); got != n {
		t.Errorf("退订后仍在重连：%d → %d", n, got)
	}
}

// Test退订可重复调用 StopFeishu 与回合结束的退订路径都会调它，
// 第二次调用必须安全（否则 panic 崩在关停路径上）。
func Test退订可重复调用(t *testing.T) {
	sub := &fakeSubscribe{block: true}
	stop, err := newReal().subscribeEvents("ses_1", func(AgentEvent) {}, sub.call)
	if err != nil {
		t.Fatal(err)
	}
	stop()
	stop()
	stop()
}

// Test重连延迟有值 立即重连会连着锤一个刚重启的服务。
func Test重连延迟有值(t *testing.T) {
	if EventReconnectDelay != 1500*time.Millisecond {
		t.Errorf("EventReconnectDelay = %v, 期望 1500ms（与 bot 侧一致）", EventReconnectDelay)
	}
}

// Test未翻译的事件不投递 中间边界（step.ended）与未识别类型
// 不应进入渲染层。
func Test未翻译的事件不投递(t *testing.T) {
	sub := &fakeSubscribe{
		perAttempt: map[int][]string{
			1: {
				`{"type":"session.step.ended","data":{"sessionID":"ses_1","finish":"stop"}}`,
				`{"type":"session.future.thing","data":{"sessionID":"ses_1"}}`,
			},
		},
	}
	var n atomic.Int32
	stop, err := newReal().subscribeEvents("ses_1", func(AgentEvent) {
		n.Add(1)
	}, sub.call)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()

	waitFor(t, func() bool { return sub.count() >= 1 })
	time.Sleep(100 * time.Millisecond)
	if got := n.Load(); got != 0 {
		t.Errorf("未翻译的事件不应进入回调，实际 %d 条", got)
	}
}

// waitFor 轮询直到 cond 为真或超时。
//
// 不用固定 sleep：本文件测的都是「后台 goroutine 干了什么」，
// 固定 sleep 会在慢机器上偶发失败。
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("等待条件超时")
}
