// menu.go —— 卡片快捷操作
//
// 对应 bot 的 src/feishu/menu.ts（那边同样不是平台菜单注册，
// 而是渲染在欢迎卡/状态卡上的快捷按钮）。
//
// 六个快捷操作**全部映射到已有命令**，不各自实现一套逻辑：
// 同一个动作出现两份实现，必然出现「改了命令没改按钮」的不一致。
package feishu

import "fmt"

// 快捷按钮的 action 标识。
const (
	ActionQuickNewSession = "quick_new_session"
	ActionQuickCompact    = "quick_compact"
	ActionQuickClear      = "quick_clear"
	ActionQuickAbort      = "quick_abort"
	ActionQuickStatus     = "quick_status"
	ActionQuickHelp       = "quick_help"
	ActionQuickSessions   = "quick_sessions"
	ActionQuickUsage      = "quick_usage"
	ActionQuickDiff       = "quick_diff"
	ActionQuickModel      = "quick_model"
	ActionQuickProject    = "quick_project"
)

// quickActionToCommand 把快捷按钮映射到命令名。
//
// ⚠️ 这里**只列卡片上真实存在的按钮**。映射表多留一项，就会让
// 「快捷动作都能执行」这个保证失效——而那条保证正是防止
// 挂出点了没反应的按钮的唯一手段。
//
// 空串表示该动作需要额外参数（如 /model 与 /switch_project），
// 不能一键执行——给这类按钮挂一个空实现只会让人点了没反应。
//
// 刻意不收录 ActionQuickClear：/clear 会解除会话绑定，
// 混在一排按钮里容易被顺手点到。语义保留，常量留着以示「曾考虑过」。
var quickActionToCommand = map[string]string{
	ActionQuickNewSession: "new_session",
	ActionQuickCompact:    "compact",
	ActionQuickAbort:      "abort",
	ActionQuickStatus:     "status",
	ActionQuickHelp:       "help",
	ActionQuickSessions:   "sessions",
	ActionQuickUsage:      "usage",
	ActionQuickDiff:       "diff",
}

// QuickActionsCard 生成快捷操作卡。
func QuickActionsCard() *Card {
	c := NewCard().WithHeader("⚡ 快捷操作", TemplateWathet)

	// 破坏性/需参数的操作不放一键区：/clear 会解绑、/abort 会中断，
	// 放在一排按钮里容易被顺手点到
	c.Button("🆕 新建会话", "primary_filled", map[string]any{"action": ActionQuickNewSession}, "")
	c.Button("📂 会话列表", "default", map[string]any{"action": ActionQuickSessions}, "")
	c.Button("📖 帮助", "default", map[string]any{"action": ActionQuickHelp}, "")
	c.Button("📊 状态", "default", map[string]any{"action": ActionQuickStatus}, "")
	c.Button("📈 用量", "default", map[string]any{"action": ActionQuickUsage}, "")
	c.Button("🗜️ 压缩上下文", "default", map[string]any{"action": ActionQuickCompact}, "")

	c.HR()
	// 中止是唯一放进快捷区的破坏性操作：它对应的是「用户刚看到任务
	// 跑飞了」这个当下诉求，藏起来反而不好用
	c.Button("⏹️ 中止任务", "danger", map[string]any{"action": ActionQuickAbort}, "")

	c.HR()
	c.Note("也可以直接发 `/命令` 或普通消息。")
	return c
}

// ResolveQuickAction 把快捷按钮解析为命令名与参数。
//
// @returns ok=false 表示该 action 不是快捷操作，或需要参数无法一键执行。
func ResolveQuickAction(action string) (command, args string, ok bool) {
	cmd, found := quickActionToCommand[action]
	if !found || cmd == "" {
		return "", "", false
	}
	return cmd, "", true
}

// NeedsArgument 列出需要额外参数、无法一键执行的快捷动作。
//
// 挂在菜单上但点了没反应的按钮比没有更糟——用户会以为功能坏了。
func NeedsArgument() []string {
	return []string{ActionQuickModel, ActionQuickProject}
}

// DescribeQuickActions 生成快捷操作说明（供 /help 附在命令表后面）。
func DescribeQuickActions() string {
	return fmt.Sprintf("也可以点卡片上的快捷按钮操作；%v 需要参数，请直接用对应命令。", NeedsArgument())
}
