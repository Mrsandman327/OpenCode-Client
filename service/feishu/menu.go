// menu.go —— 卡片快捷操作
//
// 对应 bot 的 src/feishu/menu.ts。两边**动作名刻意保持一致**：
// 同一个 OpenCode 挂在两个客户端上时，交叉使用卡片时也能被对方认出来。
//
// 六个快捷操作全部映射到已有命令，不各自实现一套逻辑：
// 同一个动作出现两份实现，必然出现「改了命令没改按钮」的不一致。

package feishu

import (
	"fmt"
	"strings"
)

// 快捷按钮与菜单动作的标识。
//
// ⚠️ 快捷按钮必须走 ActionQuickCmdPrefix 前缀。bot 侧曾因为
// 「卡片用裸名 quick_compact、分发器只认带前缀的 opencode_quick_cmd:」
// 而让整张菜单卡的按钮全部静默失效——同一个仓里两套命名的教训。
// 这里从定义处就只提供一种形态，避免同样的分裂。
const (
	ActionQuickCmdPrefix = "opencode_quick_cmd:"
)

// 快捷按钮的动作标识（去掉前缀后的命令名）。
//
// 命名一律对应**命令名**而非自定义动作：这样
// 「卡上按钮」与「命令」永远一一对应，不存在映射表失配。
const (
	ActionQuickNewSession = "new_session"
	ActionQuickCompact    = "compact"
	ActionQuickAbort      = "abort"
	ActionQuickStatus     = "status"
	ActionQuickHelp       = "help"
	ActionQuickDiff       = "diff"
	ActionQuickSessions   = "sessions"
	ActionQuickUsage      = "usage"
)

// 菜单下拉的动作标识。
//
// 与 bot 侧同名（switch_model / switch_project_in_chat），便于交叉使用。
// 这两个动作**不带** QuickCmd 前缀——它们不是命令，而是带选项的动作，
// 分发时需要读 CardAction.Option 拿到用户选中的值。
const (
	ActionSwitchModel         = "switch_model"
	ActionSwitchProjectInChat = "switch_project_in_chat"
)

// QuickAction 是卡片上的一行快捷按钮。
type QuickAction struct {
	Label string
	// Command 是命令名（不含斜杠）。
	Command string
	// Danger 为 true 时用 danger 样式。
	Danger bool
}

// defaultQuickActions 是快捷区的默认动作集。
//
// 刻意**不含** clear/清除：那是解除会话绑定的破坏性操作，
// 混在一排按钮里容易被顺手点到。/clear 仍作为命令保留。
var defaultQuickActions = []QuickAction{
	{Label: "🆕 新建会话", Command: ActionQuickNewSession},
	{Label: "📂 会话列表", Command: ActionQuickSessions},
	{Label: "📖 帮助", Command: ActionQuickHelp},
	{Label: "📊 状态", Command: ActionQuickStatus},
	{Label: "📈 用量", Command: ActionQuickUsage},
	{Label: "🗜️ 压缩上下文", Command: ActionQuickCompact},
}

// MenuOptions 是快捷操作卡的参数。
type MenuOptions struct {
	// Projects 是可切换的项目目录，为空则不渲染项目下拉。
	Projects []string
	// Models 是可切换的模型（provider/model 形态），为空则不渲染模型下拉。
	Models []string
	// CurrentModel 用于在下拉里标出当前值。
	CurrentModel string
}

// QuickCommandAction 把命令名包装成卡片回调动作。
//
// 这是**唯一**允许产生快捷动作的地方：卡片与分发器共用同一个前缀常量，
// 两侧不可能再分裂。
func QuickCommandAction(command string) string {
	return ActionQuickCmdPrefix + "/" + command
}

// IsQuickCommandAction 判断是否为快捷命令动作。
//
// 只看前缀，**不要求**前缀后必须有命令：裸前缀是「命令名缺失」的畸形卡片，
// 让它进入 handleQuickCommand 才能报出「缺少命令名」这个准确原因；
// 在这里就判否的话，用户只会看到笼统的「旧版本卡片已失效」。
func IsQuickCommandAction(action string) bool {
	return strings.HasPrefix(action, ActionQuickCmdPrefix)
}

// QuickCommandOf 从快捷动作里取出命令名（含斜杠）。
//
// 非快捷动作返回空串。
func QuickCommandOf(action string) string {
	if !IsQuickCommandAction(action) {
		return ""
	}
	return action[len(ActionQuickCmdPrefix):]
}

// QuickActionsCard 生成快捷操作卡。
func QuickActionsCard(opts MenuOptions) *Card {
	c := NewCard().WithHeader("⚡ 快捷操作", TemplateWathet)

	for _, a := range defaultQuickActions {
		style := "default"
		if a.Danger {
			style = "danger"
		}
		c.Button(a.Label, style, map[string]any{
			"action": QuickCommandAction(a.Command),
		}, "")
	}

	// 中止是唯一放进快捷区的破坏性操作：它对应的是
	// 「用户刚看到任务跑飞了」这个当下诉求，藏起来反而不好用。
	c.HR()
	c.Button("⏹️ 中止任务", "danger", map[string]any{
		"action": QuickCommandAction(ActionQuickAbort),
	}, "")

	appendSelects(c, opts)

	c.HR()
	c.Note("也可以直接发 `/命令` 或普通消息。")
	return c
}

// appendSelects 渲染项目/模型下拉。
//
// 列表为空时**整个下拉不渲染**，并在卡片上说明走命令——
// 挂一个空的点不动的下拉比不显示更糟。
func appendSelects(c *Card, opts MenuOptions) {
	var hasAny bool

	if len(opts.Models) > 0 {
		sel := selectElement("🤖 切换模型", ActionSwitchModel, opts.Models, maxSelectOptions)
		sel.Required = false
		if opts.CurrentModel != "" {
			for _, m := range opts.Models {
				if m == opts.CurrentModel {
					sel.InitialOption = m
					break
				}
			}
		}
		c.Add(sel)
		hasAny = true
	}
	if len(opts.Projects) > 0 {
		c.Add(selectElement("📂 切换项目", ActionSwitchProjectInChat, opts.Projects, maxSelectOptions))
		hasAny = true
	}

	if !hasAny {
		c.Note("💡 未配置可切换的项目/模型，请用 `/model <provider/model>` 或 " +
			"`/switch_project <路径>`")
	}
}

// maxSelectOptions 是下拉最多列出的选项数。
// 超过这个量级在飞书里点选已经很难用了。
const maxSelectOptions = 10

// selectElement 构造一个静态下拉框。
func selectElement(placeholder, action string, options []string, limit int) Element {
	shown := options
	if len(shown) > limit {
		shown = shown[:limit]
	}
	opts := make([]SelectOption, 0, len(shown))
	for _, o := range shown {
		opts = append(opts, SelectOption{
			Text:  PlainText{Tag: "plain_text", Content: truncate(o, 40)},
			Value: o,
		})
	}
	return Element{
		Tag:         "select_static",
		Placeholder: &PlainText{Tag: "plain_text", Content: placeholder},
		// ⚠️ action 放在 value 里，与 bot 侧一致
		Behaviors: []ButtonBehavior{{
			Type:  BehaviorCallback,
			Value: map[string]any{"action": action},
		}},
		Options: opts,
	}
}

// NeedsArgument 列出需要额外参数、无法一键执行的快捷动作。
//
// 挂在菜单上但点了没反应的按钮比没有更糟——用户会以为功能坏了。
func NeedsArgument() []string {
	return []string{ActionSwitchModel, ActionSwitchProjectInChat}
}

// DescribeQuickActions 生成快捷操作说明（供 /help 附在命令表后面）。
//
// 零**生产**调用方（/help 目前没接这段），menu_test.go 用它断言
// 「需参数的动作会出现在说明里」——`NeedsArgument` 的语义由它兜着。
func DescribeQuickActions() string {
	return fmt.Sprintf("也可以点卡片上的快捷按钮操作；%v 需要参数，请直接用对应命令。", NeedsArgument())
}
