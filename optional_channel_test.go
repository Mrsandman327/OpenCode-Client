package main

import (
	"context"
	"testing"
)

// stubChannel 是测试用的假通道。
type stubChannel struct {
	name      string
	autoErr   error
	shutCalls int
}

func (s *stubChannel) Name() string                      { return s.name }
func (s *stubChannel) AutoStart(_ context.Context) error { return s.autoErr }
func (s *stubChannel) Shutdown() error {
	s.shutCalls++
	return nil
}

// Test注册与构造 工厂注册后应能按序构造出通道。
func Test注册与构造(t *testing.T) {
	// 保存并恢复全局工厂表，避免污染同包其它测试。
	saved := optionalChannelFactories
	t.Cleanup(func() { optionalChannelFactories = saved })
	optionalChannelFactories = nil

	registerOptionalChannel(func(a *App) OptionalChannel { return &stubChannel{name: "a"} })
	registerOptionalChannel(func(a *App) OptionalChannel { return &stubChannel{name: "b"} })

	a := NewApp()
	got := buildOptionalChannels(a)
	if len(got) != 2 {
		t.Fatalf("构造出 %d 个通道，期望 2", len(got))
	}
	if got[0].Name() != "a" || got[1].Name() != "b" {
		t.Errorf("通道顺序/名称异常: %q %q", got[0].Name(), got[1].Name())
	}
}

// Test无注册通道时生命周期正常 默认（无任何带 tag 通道）情况下，
// 启动/关闭遍历空列表不应出错——这是「可拆」核心的基本行为。
func Test无注册通道时生命周期正常(t *testing.T) {
	saved := optionalChannelFactories
	t.Cleanup(func() { optionalChannelFactories = saved })
	optionalChannelFactories = nil

	a := NewApp()
	a.channels = buildOptionalChannels(a)
	for _, ch := range a.channels {
		if err := ch.AutoStart(context.Background()); err != nil {
			t.Fatalf("空注册表不应有错误: %v", err)
		}
	}
	for _, ch := range a.channels {
		_ = ch.Shutdown()
	}
}
