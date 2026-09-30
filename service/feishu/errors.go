//go:build feishu

// errors.go —— 飞书通道的哨兵错误
//
// 单独成文件而不是散在各处的 errors.New：这些错误的**判据是
// 「有没有发生」而不是「错误信息长什么样」——测试要断言的是
// 「不支持流式的替身会失败」这件事，而不是某句文案。
// 集中一处也让调用方能用 errors.Is 精确判别。
package feishu

import "errors"

var (
	// errNoCardUpdater 表示 Output 不支持更新卡片，无法流式渲染。
	errNoCardUpdater = errors.New("输出通道不支持卡片更新，无法流式渲染")
	// errNoEventSubscriber 表示没有可用的 OpenCode 事件订阅。
	errNoEventSubscriber = errors.New("缺少 OpenCode 事件订阅，无法流式渲染")
	// errMissingSessionID 表示缺少会话 ID。
	errMissingSessionID = errors.New("缺少会话 ID")
	// errNilCallback 表示事件回调为 nil。
	errNilCallback = errors.New("事件回调为空")
	// errNilSubscriber 表示底层订阅实现为 nil。
	errNilSubscriber = errors.New("事件流订阅实现为空")
	// errBridgeClosed 表示桥接层已关闭（StopFeishu 之后）。
	errBridgeClosed = errors.New("飞书通道已停止")
)
