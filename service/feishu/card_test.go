package feishu

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// ============ 卡片构建 ============

func TestNewCard默认结构(t *testing.T) {
	c := NewCard()
	if c.Schema != "2.0" {
		t.Errorf("schema = %q, 期望 2.0", c.Schema)
	}
	if !c.Config.UpdateMulti {
		t.Error("UpdateMulti 应默认为 true —— 流式回复依赖多次更新卡片")
	}
	if c.Body.Direction != "vertical" {
		t.Errorf("direction = %q, 期望 vertical", c.Body.Direction)
	}
	if c.Header != nil {
		t.Error("未调用 WithHeader 时不应有 header")
	}
}

func TestWithHeader缺省模板为蓝(t *testing.T) {
	c := NewCard().WithHeader("标题", "")
	if c.Header.Template != TemplateBlue {
		t.Errorf("template = %q, 期望 %q", c.Header.Template, TemplateBlue)
	}
	if c.Header.Title.Tag != "plain_text" {
		t.Errorf("title.tag = %q, 期望 plain_text", c.Header.Title.Tag)
	}
}

func TestButton带值自动挂Callback(t *testing.T) {
	c := NewCard().Button("点我", "", map[string]any{"action": "x", "id": "1"}, "")
	el := c.Body.Elements[0]
	if el.Tag != "button" {
		t.Fatalf("tag = %q", el.Tag)
	}
	if el.Behaviors == nil {
		t.Fatal("有 value 却未挂 behaviors —— 按钮点击会无响应")
	}
	if el.Behaviors[0].Type != BehaviorCallback {
		t.Errorf("behavior.type = %q, 期望 callback", el.Behaviors[0].Type)
	}
	if el.Behaviors[0].Value["action"] != "x" {
		t.Errorf("value 未透传: %+v", el.Behaviors[0].Value)
	}
}

func TestButton带URL自动挂OpenURL(t *testing.T) {
	c := NewCard().Button("打开", "", nil, "https://example.com")
	el := c.Body.Elements[0]
	if el.Behaviors == nil || el.Behaviors[0].Type != BehaviorOpenURL {
		t.Fatalf("应挂 OpenURL 行为，实际 %+v", el.Behaviors)
	}
	if el.Behaviors[0].DefaultURL != "https://example.com" {
		t.Errorf("url = %q", el.Behaviors[0].DefaultURL)
	}
}

// TestButton既无值也无URL 不挂行为 锁住「点了没反应」这一最常见坑：
// 无 behavior 的按钮点击后不会有任何反馈。
func TestButton既无值也无URL不挂行为(t *testing.T) {
	c := NewCard().Button("孤儿按钮", "", nil, "")
	el := c.Body.Elements[0]
	if len(el.Behaviors) != 0 {
		t.Errorf("无 value/url 时不应挂 behavior，实际 %+v", el.Behaviors)
	}
	// 这不是错误，但调用方应改用 ButtonDisabled
	if el.Disabled {
		t.Error("无行为的按钮应当被禁用，否则用户会点了没反应")
	}
}

func TestButtonDisabled(t *testing.T) {
	c := NewCard().ButtonDisabled("当前项")
	el := c.Body.Elements[0]
	if !el.Disabled {
		t.Error("ButtonDisabled 应设置 disabled")
	}
	if len(el.Behaviors) != 0 {
		t.Error("禁用按钮不应有 behavior")
	}
}

// Test序列化字段名正确 是关键：字段名写错编译期无感知，
// 只会在飞书侧渲染成空白。
func Test序列化字段名正确(t *testing.T) {
	c := NewCard().WithHeader("标题", TemplateRed).
		Markdown("**粗体**", "normal").
		Note("小字").
		HR().
		Button("去", "", map[string]any{"a": 1}, "")

	raw, err := c.JSON()
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}

	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("不是合法 JSON: %v", err)
	}
	if out["schema"] != "2.0" {
		t.Errorf("顶层 schema 缺失: %s", raw)
	}
	cfg, ok := out["config"].(map[string]any)
	if !ok || cfg["update_multi"] != true {
		t.Errorf("config.update_multi 缺失或不为 true: %s", raw)
	}
	header, ok := out["header"].(map[string]any)
	if !ok {
		t.Fatalf("header 缺失: %s", raw)
	}
	if header["template"] != TemplateRed {
		t.Errorf("header.template = %v", header["template"])
	}
	body, ok := out["body"].(map[string]any)
	if !ok {
		t.Fatalf("body 缺失: %s", raw)
	}
	elems, ok := body["elements"].([]any)
	if !ok || len(elems) != 4 {
		t.Fatalf("elements 数量 = %v, 期望 4", len(elems))
	}

	// 逐元素核对 tag
	wantTags := []string{"markdown", "markdown", "hr", "button"}
	for i, e := range elems {
		em, ok := e.(map[string]any)
		if !ok {
			t.Fatalf("第 %d 个元素不是对象", i)
		}
		if em["tag"] != wantTags[i] {
			t.Errorf("第 %d 个元素 tag = %v, 期望 %s", i, em["tag"], wantTags[i])
		}
	}

	// button 的 text 必须是 {tag, content} 结构
	btn := elems[3].(map[string]any)
	bt, ok := btn["text"].(map[string]any)
	if !ok || bt["tag"] != "plain_text" || bt["content"] != "去" {
		t.Errorf("button.text 结构错误: %v", btn["text"])
	}
	// 空的可选字段不应出现（如 hr 不该有 content）
	hr := elems[2].(map[string]any)
	if _, has := hr["content"]; has {
		t.Errorf("hr 不应带 content 字段: %v", hr)
	}
}

func TestColumns(t *testing.T) {
	c := NewCard().Columns(
		[]Element{{Tag: "markdown", Content: "左"}},
		[]Element{{Tag: "markdown", Content: "右"}},
	)
	el := c.Body.Elements[0]
	if el.Tag != "column_set" {
		t.Fatalf("tag = %q", el.Tag)
	}
	if len(el.Columns) != 2 {
		t.Fatalf("列数 = %d, 期望 2", len(el.Columns))
	}
	if el.Columns[0].Tag != "column" {
		t.Errorf("列 tag = %q", el.Columns[0].Tag)
	}
	if len(el.Columns[1].Elements) != 1 {
		t.Errorf("第二列元素数 = %d", len(el.Columns[1].Elements))
	}
}

func TestTextCard(t *testing.T) {
	c := TextCard("标题", "正文")
	raw := c.MustJSON()
	if !strings.Contains(raw, "正文") {
		t.Errorf("应包含正文: %s", raw)
	}
	if c.Header == nil || c.Header.Title.Content != "标题" {
		t.Error("TextCard 应带标题")
	}
}

// ============ 节流与限流 ============

func TestThrottle首次放行(t *testing.T) {
	s := NewRenderState()
	if !s.Throttle(time.Now(), time.Second, false) {
		t.Error("首次渲染应立即放行")
	}
}

func TestThrottle间隔内被抑制(t *testing.T) {
	s := NewRenderState()
	base := time.Now()
	s.Throttle(base, time.Second, false)
	s.MarkRendered(base)

	// 这正是修复前会撞 230020 的场景：短时间内连续请求
	if s.Throttle(base.Add(10*time.Millisecond), time.Second, false) {
		t.Error("间隔内应被抑制")
	}
	if s.Throttle(base.Add(500*time.Millisecond), time.Second, false) {
		t.Error("间隔内应被抑制")
	}
	if !s.Pending() {
		t.Error("被抑制时应记下待渲染")
	}
}

func TestThrottle超间隔恢复(t *testing.T) {
	s := NewRenderState()
	base := time.Now()
	s.Throttle(base, time.Second, false)
	s.MarkRendered(base)

	if s.Throttle(base.Add(time.Second-time.Millisecond), time.Second, false) {
		t.Error("差 1ms 仍应被抑制")
	}
	if !s.Throttle(base.Add(time.Second), time.Second, false) {
		t.Error("超过间隔应放行")
	}
}

func TestThrottleForce绕过节流(t *testing.T) {
	s := NewRenderState()
	base := time.Now()
	s.Throttle(base, time.Second, false)
	s.MarkRendered(base)

	if s.Throttle(base.Add(time.Millisecond), time.Second, false) {
		t.Fatal("非 force 时应被抑制")
	}
	if !s.Throttle(base.Add(time.Millisecond), time.Second, true) {
		t.Error("force 必须绕过节流 —— 终态渲染是保证内容正确的最后机会")
	}
	if s.Pending() {
		t.Error("force 渲染应消费待发标记")
	}
}

// Test发送失败不记时间 这是刻意的设计：失败要尽快重试，
// 而非被自己的「上次成功」挡住。
func Test发送失败不记时间(t *testing.T) {
	s := NewRenderState()
	now := time.Now()
	s.Throttle(now, time.Second, false)
	s.MarkRateLimited()

	if !s.RateLimited() {
		t.Error("应标记限流")
	}
	if !s.Pending() {
		t.Error("限流后应保留待发标记")
	}
	// 未调 MarkRendered，lastRenderedAt 仍为零值 → 立即可再试
	if !s.Throttle(now, time.Second, false) {
		t.Error("限流后应可立即重试")
	}
}

func TestMarkRendered清限流标记(t *testing.T) {
	s := NewRenderState()
	s.MarkRateLimited()
	s.MarkRendered(time.Now())
	if s.RateLimited() {
		t.Error("成功后应清除限流标记")
	}
	if s.Pending() {
		t.Error("成功后应清除待发标记")
	}
}

func TestBackoff递增并封顶(t *testing.T) {
	cases := map[int]time.Duration{
		0:  400 * time.Millisecond,
		1:  800 * time.Millisecond,
		2:  1600 * time.Millisecond,
		10: 4 * time.Second,
		-1: 400 * time.Millisecond,
	}
	for attempt, want := range cases {
		if got := backoffMs(attempt); got != want {
			t.Errorf("backoffMs(%d) = %v, 期望 %v", attempt, got, want)
		}
	}
}

// ============ 限流重试 ============

func noSleep(context.Context, time.Duration) error { return nil }

func TestRenderWithRetry首次成功(t *testing.T) {
	calls := 0
	ok, err := RenderWithRetry(context.Background(), func(context.Context) (SendResult, error) {
		calls++
		return SendResult{Success: true}, nil
	}, noSleep)
	if !ok || err != nil {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if calls != 1 {
		t.Errorf("调用次数 = %d, 期望 1（成功不应重试）", calls)
	}
}

func TestRenderWithRetry限流后成功(t *testing.T) {
	calls := 0
	ok, _ := RenderWithRetry(context.Background(), func(context.Context) (SendResult, error) {
		calls++
		if calls < 3 {
			return SendResult{RateLimited: true}, nil
		}
		return SendResult{Success: true}, nil
	}, noSleep)
	if !ok {
		t.Error("重试后应成功")
	}
	if calls != 3 {
		t.Errorf("调用次数 = %d, 期望 3", calls)
	}
}

func TestRenderWithRetry持续限流达上限(t *testing.T) {
	calls := 0
	ok, _ := RenderWithRetry(context.Background(), func(context.Context) (SendResult, error) {
		calls++
		return SendResult{RateLimited: true}, nil
	}, noSleep)
	if ok {
		t.Error("重试耗尽应返回失败")
	}
	if calls != MaxRenderAttempts {
		t.Errorf("调用次数 = %d, 期望上限 %d（必须有限，不能无限重试）", calls, MaxRenderAttempts)
	}
}

func TestRenderWithRetry非限流不重试(t *testing.T) {
	calls := 0
	ok, _ := RenderWithRetry(context.Background(), func(context.Context) (SendResult, error) {
		calls++
		return SendResult{Success: false, RateLimited: false}, nil
	}, noSleep)
	if ok {
		t.Error("非限流失败应直接返回失败")
	}
	if calls != 1 {
		t.Errorf("调用次数 = %d, 期望 1（非限流失败重试无意义）", calls)
	}
}

func TestRenderWithRetry按退避序列等待(t *testing.T) {
	var waits []time.Duration
	var mu sync.Mutex
	calls := 0
	_, _ = RenderWithRetry(context.Background(), func(context.Context) (SendResult, error) {
		calls++
		if calls < 3 {
			return SendResult{RateLimited: true}, nil
		}
		return SendResult{Success: true}, nil
	}, func(_ context.Context, d time.Duration) error {
		mu.Lock()
		waits = append(waits, d)
		mu.Unlock()
		return nil
	})

	if len(waits) != 2 {
		t.Fatalf("等待次数 = %d, 期望 2", len(waits))
	}
	if waits[0] != 400*time.Millisecond || waits[1] != 800*time.Millisecond {
		t.Errorf("退避序列 = %v, 期望 [400ms 800ms]", waits)
	}
}

func TestRenderWithRetry抛错传播(t *testing.T) {
	_, err := RenderWithRetry(context.Background(), func(context.Context) (SendResult, error) {
		return SendResult{}, context.Canceled
	}, noSleep)
	if err == nil {
		t.Error("send 抛错应向上传播而不是被吞掉")
	}
}
