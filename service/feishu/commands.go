// commands.go —— 斜杠命令
//
// 命令解析是纯函数，便于单测；执行逻辑在 bridge.go，通过 OpenCode 接口
// 调用——这样桥接层可以在没有真实 opencode 服务的情况下被测试。
package feishu

import "strings"

// Command 是一个斜杠命令的定义。
type Command struct {
	Name        string
	Usage       string
	Description string
	// AdminOnly 为 true 时仅管理员可见/可用。
	AdminOnly bool
	// Aliases 是额外的触发名。
	Aliases []string
}

// commands 是全部命令。顺序即 `/help` 的展示顺序。
//
// 刻意与 bot 侧的核心命令保持一致：用户不需要记两套。
var commands = []Command{
	{Name: "help", Usage: "/help", Description: "显示可用命令"},
	{Name: "status", Usage: "/status", Description: "显示当前会话状态"},
	{Name: "new", Usage: "/new [项目路径]", Description: "新建会话"},
	{Name: "sessions", Usage: "/sessions", Description: "列出历史会话（按主/子分层）"},
	{Name: "use", Usage: "/use <会话ID或序号>", Description: "切换到指定会话"},
	{Name: "title", Usage: "/title <名称>", Description: "重命名当前会话"},
	{Name: "abort", Usage: "/abort", Description: "中止当前运行的任务"},
	{Name: "compact", Usage: "/compact", Description: "压缩当前会话上下文"},
	{Name: "usage", Usage: "/usage", Description: "查看 token 用量与费用"},
	{Name: "diff", Usage: "/diff", Description: "查看本次会话的代码改动"},
	{Name: "clear", Usage: "/clear", Description: "解除当前会话绑定（不删服务端会话）"},
	{Name: "permissions", Usage: "/permissions", Description: "列出待审批的权限请求"},
	{
		Name: "whitelist_add", Usage: "/whitelist_add <用户ID>",
		Description: "将用户加入白名单", AdminOnly: true,
	},
	{
		Name: "whitelist_remove", Usage: "/whitelist_remove <用户ID>",
		Description: "从白名单移除用户", AdminOnly: true,
	},
	{
		Name: "whitelist_list", Usage: "/whitelist_list",
		Description: "列出白名单用户", AdminOnly: true,
	},
}

// lookupCommand 按名称或别名查命令。
func lookupCommand(name string) (Command, bool) {
	name = strings.ToLower(strings.TrimSpace(name))
	for _, c := range commands {
		if c.Name == name {
			return c, true
		}
		for _, a := range c.Aliases {
			if a == name {
				return c, true
			}
		}
	}
	return Command{}, false
}

// ParseCommand 解析一条斜杠命令。
//
// 必须是**整条消息**都是命令（可带参数）才算命令；句中出现 /xxx
// 只是普通文本，不应被误当命令吞掉。
//
// @returns isCommand=false 表示这不是命令，应按普通消息处理。
func ParseCommand(text string) (cmd Command, args string, isCommand bool) {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "/") {
		return Command{}, "", false
	}
	body := strings.TrimPrefix(trimmed, "/")
	// 命令名与参数用首个空白分隔
	name := body
	rest := ""
	if idx := strings.IndexAny(body, " \t\n"); idx >= 0 {
		name = body[:idx]
		rest = strings.TrimSpace(body[idx:])
	}
	if name == "" {
		return Command{}, "", false
	}
	c, ok := lookupCommand(name)
	if !ok {
		// 未识别的命令不吞掉：交回调用方按普通消息处理，
		// 用户更可能想说的是一句话而不是命令
		return Command{}, "", false
	}
	return c, rest, true
}

// CommandsFor 按是否管理员过滤可见命令。
func CommandsFor(isAdmin bool) []Command {
	out := make([]Command, 0, len(commands))
	for _, c := range commands {
		if c.AdminOnly && !isAdmin {
			continue
		}
		out = append(out, c)
	}
	return out
}

// IsAdmin 判断某用户是否为管理员。
func IsAdmin(userID string, adminUserIDs []string) bool {
	if userID == "" {
		return false
	}
	for _, id := range adminUserIDs {
		if id == userID {
			return true
		}
	}
	return false
}
