// Package commands 提供 OpenCode CLI/TUI 命令参考数据。
package commands

import "oc-manager/model"

// GetCommands 返回所有常用命令分组数据（CLI 和 TUI）。
// 数据以 OpenCode V2（本地实测 v2.0.32）的 `--help` 与官方 V2 文档为准：
//   - CLI：https://opencode.ai/v2/docs/cli/
//   - TUI：https://opencode.ai/v2/docs/cli/tui/
//   - 快捷键：https://opencode.ai/v2/docs/cli/keybinds/
//
// V1 已移除的命令（agent / attach / github / pr / db / web / 顶层 export、import）
// 不再列出，避免界面误导；对应能力分别迁移到 debug、--server、serve、session 子命令。
func GetCommands() []model.CmdGroup {
	return []model.CmdGroup{
		// ========== CLI 命令 ==========
		{
			Title: "CLI - 会话",
			Cmds: []model.CmdInfo{
				{
					Name:    "run",
					Sub:     "",
					Options: "-m provider/model#variant, -c, -s ID, -f file, --format json, --fork, --thinking, --auto",
					Desc:    "非交互式运行提示词，适合脚本/CI；连接已有服务改用全局 --server",
				},
				{
					Name:    "session",
					Sub:     "list, delete, export, import",
					Options: "list: -n N --format json；export: --sanitize；import: --directory",
					Desc:    "会话管理（V1 的顶层 export/import 已收进本子命令）",
				},
				{
					Name:    "stats",
					Sub:     "",
					Options: "--days N, --year Y, --all, --project ID, --models, --tools, --cost, --full, --limit N, --json",
					Desc:    "会话用量统计：Token、费用、工具可靠性（对应 /api/experimental/session/stats）",
				},
			},
		},
		{
			Title: "CLI - 服务",
			Cmds: []model.CmdInfo{
				{
					Name:    "serve",
					Sub:     "",
					Options: "--hostname, --port, --cors, --service, --stdio",
					Desc:    "启动 v2 API 与 Web 服务（V2 已合并原 web 命令，移除 --mdns）",
				},
				{
					Name:    "service",
					Sub:     "start, restart, status, stop, get, set, unset",
					Options: "",
					Desc:    "管理共享后台服务；service set disabled true 可禁止自动拉起",
				},
				{
					Name:    "reload",
					Sub:     "",
					Options: "",
					Desc:    "重载配置：重建所有已加载 location（对应 POST /api/location/reload）",
				},
				{
					Name:    "pair",
					Sub:     "",
					Options: "--url, --remote, --yes",
					Desc:    "打印一次性配对链接；--remote 经隧道暴露服务到公网（需确认）",
				},
				{
					Name:    "api",
					Sub:     "<operationId | METHOD path>",
					Options: "-d body, -H name:value, --param key=value",
					Desc:    "按 OpenAPI 直接请求运行中的服务，调试接口比 Postman 更快",
				},
				{
					Name:    "mini",
					Sub:     "",
					Options: "-c, -s ID, --fork, -m, --agent, --prompt, --replay, --replay-limit",
					Desc:    "启动极简交互界面（非全屏 TUI）",
				},
				{
					Name:    "acp",
					Sub:     "",
					Options: "--login",
					Desc:    "启动 ACP（Agent Client Protocol）服务器",
				},
			},
		},
		{
			Title: "CLI - 配置",
			Cmds: []model.CmdInfo{
				{
					Name:    "auth",
					Sub:     "list, login, logout, export, import, switch",
					Options: "",
					Desc:    "管理集成与凭据（OAuth/账号）；V2 的 auth export 会输出含密钥的 JSON",
				},
				{
					Name:    "mcp",
					Sub:     "list, add, auth, logout",
					Options: "",
					Desc:    "管理 MCP 服务器；V2 移除了 debug 子命令",
				},
				{
					Name:    "plugin",
					Sub:     "list, add, check, update, remove",
					Options: "update 不带参数时更新全部过期插件",
					Desc:    "管理插件（add 会写入全局配置；check/update 对应 /api/plugin/check、/api/plugin/update）",
				},
				{
					Name:    "models",
					Sub:     "",
					Options: "--standalone, --server",
					Desc:    "列出可用模型；V2 移除了 --refresh / --verbose",
				},
			},
		},
		{
			Title: "CLI - 维护",
			Cmds: []model.CmdInfo{
				{
					Name:    "upgrade",
					Sub:     "",
					Options: "-m curl|npm|pnpm|bun|yarn|vp|brew|winget, [version]",
					Desc:    "升级到最新或指定版本",
				},
				{
					Name:    "uninstall",
					Sub:     "",
					Options: "--dry-run, --force",
					Desc:    "卸载 OpenCode；V2 始终保留会话数据、配置与状态，不再有 --keep-config",
				},
				{
					Name:    "debug",
					Sub:     "agents, config, paths",
					Options: "paths [db|home|data|config|cache|state|tmp|bin|log|repos]",
					Desc:    "诊断工具：列 agent、配置来源、各全局路径（替代 V1 的 db 命令）",
				},
			},
		},
		// ========== TUI 命令 ==========
		{
			Title: "TUI - 会话管理",
			IsTUI: true,
			Cmds: []model.CmdInfo{
				{Name: "/new", Sub: "/clear", Options: "ctrl+x n", Desc: "新建会话（V2 标签页默认开启）"},
				{Name: "/sessions", Sub: "/resume /continue", Options: "ctrl+x l", Desc: "列出/切换会话；ctrl+o 同时看最近会话与项目"},
				{Name: "/compact", Sub: "/summarize", Options: "ctrl+x c", Desc: "压缩会话上下文"},
				{Name: "/undo", Sub: "", Options: "ctrl+x u", Desc: "撤销最后一条消息及其文件改动（需 Git 仓库）"},
				{Name: "/redo", Sub: "", Options: "ctrl+x r", Desc: "重做已撤销的改动（需 Git 仓库）"},
				{Name: "/exit", Sub: "/quit /q", Options: "ctrl+c / ctrl+d / ctrl+x q", Desc: "退出 OpenCode"},
			},
		},
		{
			Title: "TUI - 信息查看",
			IsTUI: true,
			Cmds: []model.CmdInfo{
				{Name: "/models", Sub: "", Options: "ctrl+x m（F2 循环最近模型）", Desc: "选择模型；ctrl+t 切换模型变体"},
				{Name: "/agents", Sub: "", Options: "ctrl+x a（Shift+Tab 循环）", Desc: "选择 agent（V2 新增斜杠命令）"},
				{Name: "/themes", Sub: "", Options: "", Desc: "切换主题（V2 默认未绑定快捷键）"},
				{Name: "/thinking", Sub: "", Options: "", Desc: "切换思考块可见性（不改变模型推理开关）"},
				{Name: "/highlights", Sub: "", Options: "", Desc: "查看本次版本的更新亮点（V2 新增）"},
				{Name: "/help", Sub: "", Options: "ctrl+p 命令面板", Desc: "帮助与当前视图的全部动作"},
			},
		},
		{
			Title: "TUI - 操作",
			IsTUI: true,
			Cmds: []model.CmdInfo{
				{Name: "/init", Sub: "", Options: "", Desc: "引导创建/更新 AGENTS.md"},
				{Name: "/connect", Sub: "", Options: "", Desc: "连接提供商或集成"},
				{Name: "/editor", Sub: "", Options: "ctrl+x e", Desc: "用 $EDITOR/$VISUAL 编辑当前输入并回填"},
				{Name: "/export", Sub: "", Options: "ctrl+x x", Desc: "导出会话（V2 导出到编辑器；CLI 用 session export）"},
				{Name: "/btw", Sub: "<问题>", Options: "", Desc: "侧问：用当前上下文回答但不写入会话（V2 新增）"},
			},
		},
		{
			Title: "TUI - 快捷键（V2 变化）",
			IsTUI: true,
			Cmds: []model.CmdInfo{
				{Name: "命令面板", Sub: "", Options: "ctrl+p", Desc: "列出当前视图的全部可执行动作"},
				{Name: "排队 prompt", Sub: "", Options: "ctrl+x 然后 Enter；ctrl+x q 管理", Desc: "执行中继续提交：Enter 为 steer，入队则按此键（V2 新增）"},
				{Name: "工具转后台", Sub: "", Options: "ctrl+b", Desc: "把前台阻塞的工具调用转到后台观察（对应 session/background）"},
				{Name: "标签页", Sub: "", Options: "ctrl+tab / ctrl+shift+tab；ctrl+x w 关闭；ctrl+shift+t 重开", Desc: "V2 默认开启会话标签页"},
				{Name: "侧栏 / 终端 / 状态", Sub: "", Options: "ctrl+x b / ctrl+x t / ctrl+x s", Desc: "切换侧栏、终端面板、运行状态"},
				{Name: "diff 面板", Sub: "", Options: "d 切换范围；m 标记已读；v 分屏；s 单文件；n/p 切文件", Desc: "V2 新增 All/Committed/Uncommitted/Last turn/Base 范围"},
				{Name: "会话快速槽", Sub: "", Options: "ctrl+x 1..9", Desc: "快速切换到对应槽位（V2 新增）"},
				{Name: "子会话导航", Sub: "", Options: "方向键（上/下进入或返回子会话）", Desc: "在父会话与子 agent 会话之间跳转"},
			},
		},
	}
}
