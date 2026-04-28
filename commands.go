package main

// CmdInfo 命令展示信息
type CmdInfo struct {
	Name    string `json:"name"`    // 命令名
	Sub     string `json:"sub"`     // 子命令（可选）
	Options string `json:"options"` // 常用选项（可选）
	Desc    string `json:"desc"`    // 中文说明
}

// CmdGroup 命令分组
type CmdGroup struct {
	Title  string    `json:"title"`
	Cmds   []CmdInfo `json:"cmds"`
	IsTUI  bool      `json:"isTui"` // true=TUI命令, false=CLI命令
}

// GetCommands 返回所有常用命令分组数据
func (a *App) GetCommands() []CmdGroup {
	return []CmdGroup{
		// ========== CLI 命令 ==========
		{
			Title: "CLI - 会话",
			Cmds: []CmdInfo{
				{Name: "run", Sub: "", Options: "-m model, -c, -s ID, -f file, --agent", Desc: "非交互式运行提示词，适合脚本/自动化"},
				{Name: "session", Sub: "list", Options: "-n N, --format json", Desc: "列出所有会话，支持表格/JSON格式"},
				{Name: "stats", Sub: "", Options: "--days N, --models", Desc: "显示Token用量和费用统计"},
				{Name: "export", Sub: "", Options: "[sessionID]", Desc: "导出会话为JSON"},
				{Name: "import", Sub: "", Options: "file.json|url", Desc: "从JSON文件或分享链接导入会话"},
			},
		},
		{
			Title: "CLI - 代理",
			Cmds: []CmdInfo{
				{Name: "agent", Sub: "create, list", Options: "", Desc: "创建/列出自定义代理"},
				{Name: "github", Sub: "install, run", Options: "--event, --token", Desc: "GitHub仓库自动化代理"},
			},
		},
		{
			Title: "CLI - 服务",
			Cmds: []CmdInfo{
				{Name: "serve", Sub: "", Options: "--port, --hostname", Desc: "启动无界面API服务器"},
				{Name: "web", Sub: "", Options: "--port, --hostname", Desc: "启动Web界面"},
				{Name: "acp", Sub: "", Options: "--port, --cwd", Desc: "启动ACP(stdin/stdout)服务器"},
				{Name: "attach", Sub: "", Options: "url --dir --session", Desc: "连接远程OpenCode后端"},
			},
		},
		{
			Title: "CLI - 配置",
			Cmds: []CmdInfo{
				{Name: "auth", Sub: "login, list, logout", Options: "", Desc: "管理提供商API密钥(~/.local/share/opencode/auth.json)"},
				{Name: "mcp", Sub: "add, list, auth, logout, debug", Options: "", Desc: "管理MCP服务器配置"},
				{Name: "models", Sub: "", Options: "--refresh, --verbose, [provider]", Desc: "列出已配置提供商的可用模型"},
			},
		},
		{
			Title: "CLI - 维护",
			Cmds: []CmdInfo{
				{Name: "upgrade", Sub: "", Options: "-m curl|npm|brew, [version]", Desc: "更新到最新或指定版本"},
				{Name: "uninstall", Sub: "", Options: "-c, -d, --force, --dry-run", Desc: "卸载并删除相关文件"},
			},
		},
		// ========== TUI 命令 ==========
		{
			Title: "TUI - 会话管理",
			IsTUI: true,
			Cmds: []CmdInfo{
				{Name: "/new", Sub: "/clear", Options: "ctrl+x n", Desc: "开始新会话"},
				{Name: "/compact", Sub: "/summarize", Options: "ctrl+x c", Desc: "压缩会话上下文"},
				{Name: "/undo", Sub: "", Options: "ctrl+x u", Desc: "撤销最后消息(需Git仓库)"},
				{Name: "/redo", Sub: "", Options: "ctrl+x r", Desc: "重做撤销(需Git仓库)"},
				{Name: "/exit", Sub: "/quit /q", Options: "ctrl+x q", Desc: "退出OpenCode"},
			},
		},
		{
			Title: "TUI - 信息查看",
			IsTUI: true,
			Cmds: []CmdInfo{
				{Name: "/help", Sub: "", Options: "ctrl+x h", Desc: "显示帮助/命令面板"},
				{Name: "/models", Sub: "", Options: "ctrl+x m", Desc: "列出可用模型"},
				{Name: "/themes", Sub: "", Options: "ctrl+x t", Desc: "列出可用主题"},
				{Name: "/thinking", Sub: "", Options: "", Desc: "切换思考块可见性"},
				{Name: "/details", Sub: "", Options: "ctrl+x d", Desc: "切换工具执行详情"},
			},
		},
		{
			Title: "TUI - 操作",
			IsTUI: true,
			Cmds: []CmdInfo{
				{Name: "/init", Sub: "", Options: "ctrl+x i", Desc: "创建/更新AGENTS.md"},
				{Name: "/connect", Sub: "", Options: "", Desc: "添加提供商API密钥"},
				{Name: "/editor", Sub: "", Options: "ctrl+x e", Desc: "用外部编辑器编写消息($EDITOR)"},
				{Name: "/export", Sub: "", Options: "ctrl+x x", Desc: "导出对话为Markdown"},
				{Name: "/share", Sub: "", Options: "ctrl+x s", Desc: "分享当前会话"},
				{Name: "/unshare", Sub: "", Options: "", Desc: "取消分享"},
				{Name: "/sessions", Sub: "/resume /continue", Options: "ctrl+x l", Desc: "列出/切换会话"},
			},
		},
	}
}
