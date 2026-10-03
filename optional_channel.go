package main

import "context"

// OptionalChannel 是可选外部通道（如飞书）的中立接口。
//
// 核心只认这个接口，不认任何具体通道的类型与配置。
// 具体实现在带 build tag 的文件里通过 init() 注册自己的构造工厂；
// 不带对应 tag 编译时，注册表为空，核心照常编译运行。
type OptionalChannel interface {
	// Name 返回通道标识（用于日志）。
	Name() string
	// AutoStart 读取通道自己的配置，条件满足才启动；
	// 「未配置 / 未启用」不是错误，应返回 nil。
	AutoStart(ctx context.Context) error
	// Shutdown 关闭通道，必须可重复调用。
	Shutdown() error
}

// optionalChannelFactory 用 *App 构造一个通道实例。
//
// 通道可能需要向 WebView 推送事件，因此在 ServiceStartup
// （此时 App 已完成装配）时才由核心调用工厂，而不是在 init 阶段
// 就创建脱离 App 的单例。
type optionalChannelFactory func(a *App) OptionalChannel

// optionalChannelFactories 是各可选通道自注册的工厂列表。
var optionalChannelFactories []optionalChannelFactory

// registerOptionalChannel 供带 tag 的通道文件在 init() 中调用。
func registerOptionalChannel(f optionalChannelFactory) {
	optionalChannelFactories = append(optionalChannelFactories, f)
}

// buildOptionalChannels 用已注册的工厂构造全部可选通道。
func buildOptionalChannels(a *App) []OptionalChannel {
	channels := make([]OptionalChannel, 0, len(optionalChannelFactories))
	for _, f := range optionalChannelFactories {
		channels = append(channels, f(a))
	}
	return channels
}
