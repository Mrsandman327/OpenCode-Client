package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	iofs "io/fs"

	"oc-manager/config"
	"oc-manager/model"
	"oc-manager/service"
	"oc-manager/skill"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App 是 Wails 应用的核心结构体，所有绑定到前端的方法都定义在此。
type App struct {
	ctx context.Context
	sm  *skill.Manager
}

// NewApp 创建新的 App 实例。
func NewApp() *App {
	return &App{
		sm: skill.NewManager(),
	}
}

// startup 在应用启动时调用
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// domReady 在 DOM 加载完成后调用，通知前端开始初始化。
func (a *App) domReady(ctx context.Context) {
	wruntime.EventsEmit(a.ctx, "app-ready")
}

// shutdown 在应用关闭时调用，清理资源。
func (a *App) shutdown(ctx context.Context) {
	a.StopOpenCodeEvents()
	a.StopOpenCodeWeb()
	a.StopFrontendWeb()
}

// ========== 技能管理 ==========

// GetSkillConfig 返回技能管理页面需要的完整聚合数据（统一接口）。
func (a *App) GetSkillConfig() model.SkillConfigResult {
	dirs, _ := config.ListSourceDirs()
	var skills []model.SkillInfo

	if len(dirs) == 0 {
		skills = a.sm.GetAllSkills()
	} else {
		skills = a.sm.ScanWithGlobal(dirs)
	}

	return model.SkillConfigResult{
		SourceDirs: dirs,
		Skills:     skills,
		Stats: model.Stats{
			GlobalSkills: len(skills),
		},
	}
}

// GetSkills 返回所有技能及其在各平台的链接状态。
func (a *App) GetSkills() []model.SkillInfo {
	return a.sm.GetAllSkills()
}

// GetAggregatedSkills 返回所有技能的聚合列表：
// 1. 从配置读取来源目录
// 2. 扫描所有来源目录
// 3. 扫描全局目录
// 4. 合并返回完整列表
// 当没有配置来源目录时，回退到原有的 GetAllSkills 扫描逻辑。
func (a *App) GetAggregatedSkills() []model.SkillInfo {
	dirs, err := config.ListSourceDirs()
	if err != nil || len(dirs) == 0 {
		return a.sm.GetAllSkills()
	}
	return a.sm.ScanWithGlobal(dirs)
}

// GetSourceDir 返回技能源目录路径。
func (a *App) GetSourceDir() string {
	return a.sm.SourceDir()
}

// GetDirEnabledSkills 返回指定来源目录中当前已启用的技能名称列表。
// 前端删除目录前调用此接口以展示受影响技能列表供用户确认。
func (a *App) GetDirEnabledSkills(dir string) []string {
	return a.sm.GetEnabledSkillsInDir(dir)
}

// ListBrowsableDirs 返回目录浏览器当前层的目录列表。
func (a *App) ListBrowsableDirs(path string) ([]model.DirectoryEntry, error) {
	return service.ListBrowsableDirs(path)
}

// OpenDir 在文件资源管理器中打开指定目录。
func (a *App) OpenDir(path string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("explorer", path).Start()
	case "darwin":
		return exec.Command("open", path).Start()
	default:
		return exec.Command("xdg-open", path).Start()
	}
}

// GetStats 返回统计信息。
func (a *App) GetStats() model.Stats {
	return model.Stats{
		GlobalSkills: len(a.sm.GetAllSkills()),
	}
}

// ToggleSkill 切换技能链接状态。
func (a *App) ToggleSkill(skillPath, skillName string, enable bool) model.ToggleResult {
	newState, err := a.sm.ToggleSkill(skillPath, skillName, enable)
	result := model.ToggleResult{
		SkillName: skillName,
		Linked:    newState,
		Success:   err == nil,
	}
	if err != nil {
		errMsg := err.Error()
		result.Error = &errMsg
	}
	return result
}

// ReadSkillContent 读取技能 SKILL.md 内容。
func (a *App) ReadSkillContent(skillPath string) (string, error) {
	return a.sm.ReadSkillContent(skillPath)
}

// SaveSkillContent 保存技能 SKILL.md 内容。
func (a *App) SaveSkillContent(skillPath, content string) error {
	return a.sm.SaveSkillContent(skillPath, content)
}

// ListSkillFiles 返回技能目录树。
func (a *App) ListSkillFiles(skillPath string) (model.SkillFileNode, error) {
	return a.sm.ListSkillFiles(skillPath)
}

// ReadSkillFile 读取技能目录内的文本文件。
func (a *App) ReadSkillFile(skillPath, relativePath string) (model.SkillContent, error) {
	return a.sm.ReadSkillFile(skillPath, relativePath)
}

// SaveSkillFile 保存技能目录内的文本文件。
func (a *App) SaveSkillFile(skillPath, relativePath, content string) error {
	return a.sm.SaveSkillFile(skillPath, relativePath, content)
}

// Refresh 重新扫描技能目录并刷新状态。
func (a *App) Refresh() error {
	a.sm = skill.NewManager()
	return nil
}

// AddSkillSourceDir 添加技能源目录到配置。
// 通过 a.sm.SourceDir() 获取 opencode 全局技能目录路径用于排除检查。
func (a *App) AddSkillSourceDir(dir string) model.SaveResult {
	if _, err := config.AddSourceDir(dir, a.sm.SourceDir()); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// RemoveSkillSourceDir 从配置中移除指定的技能源目录。
// 同时会解除该目录下已启用的技能链接（清理托管链接）。
func (a *App) RemoveSkillSourceDir(dir string) model.SaveResult {
	// 先解除该目录下所有已启用的链接
	enabled := a.sm.GetEnabledSkillsInDir(dir)
	for _, name := range enabled {
		linkPath := filepath.Join(a.sm.SourceDir(), name)
		os.Remove(linkPath) // 忽略错误
	}

	// 从配置中移除
	if _, err := config.RemoveSourceDir(dir); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// GetSkillSourceDirs 返回当前配置中所有技能源目录。
func (a *App) GetSkillSourceDirs() []string {
	dirs, err := config.ListSourceDirs()
	if err != nil {
		return []string{}
	}
	return dirs
}

// SaveSkillScheme 保存当前已启用的技能为方案。
// 从聚合列表中筛选出 Linked=true 的技能，保存其名称列表。
func (a *App) SaveSkillScheme(name string) model.SaveResult {
	// 获取当前聚合技能列表
	skills := a.GetAggregatedSkills()
	var names []string
	for _, s := range skills {
		if s.Linked {
			names = append(names, s.Name)
		}
	}
	if err := config.SaveSkillScheme(name, names); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// ApplySkillScheme 应用指定名称的技能方案。
func (a *App) ApplySkillScheme(name string) model.SchemeApplyResult {
	// 1. 加载方案
	scheme, err := config.LoadSkillScheme(name)
	if err != nil {
		return model.SchemeApplyResult{
			Errors:  []string{err.Error()},
			Success: false,
		}
	}
	// 2. 获取聚合技能列表
	available := a.GetAggregatedSkills()
	// 3. 获取来源目录
	sourceDirs, _ := config.ListSourceDirs()
	// 4. 应用方案
	return a.sm.ApplySkillScheme(scheme, available, sourceDirs)
}

// ListSkillSchemes 返回所有技能方案名称列表。
func (a *App) ListSkillSchemes() []string {
	schemes, err := config.ListSkillSchemes()
	if err != nil {
		return []string{}
	}
	return schemes
}

// DeleteSkillScheme 删除指定技能方案。
func (a *App) DeleteSkillScheme(name string) model.SaveResult {
	if err := config.DeleteSkillScheme(name); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// ========== 模型配置 ==========

// GetModelConfig 读取所有 agent/category 的模型配置。
func (a *App) GetModelConfig() ([]model.ModelEntry, error) {
	cfg, _, _, err := config.LoadConfig()
	if err != nil {
		return nil, err
	}
	descs, _ := config.LoadAgentDescriptions()
	return config.ConfigToEntries(cfg, descs), nil
}

// GetAgentDescriptions 返回 agent/category 描述表。
func (a *App) GetAgentDescriptions() map[string]string {
	descs, err := config.LoadAgentDescriptions()
	if err != nil {
		return nil
	}
	return descs
}

// GetAvailableModels 通过 opencode models 获取所有可用模型。
func (a *App) GetAvailableModels() ([]string, error) {
	return service.GetAvailableModels()
}

// RefreshAvailableModels 强制刷新模型列表缓存。
func (a *App) RefreshAvailableModels() ([]string, error) {
	service.RefreshModels()
	return service.GetAvailableModels()
}

// UpdateModels 批量更新模型配置并保存到 JSONC 文件，同时将描述写入 agents-comments.json。
func (a *App) UpdateModels(entries []model.ModelEntry) model.ModelSaveResult {
	if err := config.SaveConfig(entries); err != nil {
		return model.ModelSaveResult{Success: false, Error: err.Error()}
	}
	// 同步 key-comment 到描述文件
	descEntries := make([]struct {
		Key     string
		Comment string
	}, len(entries))
	for i, e := range entries {
		descEntries[i].Key = e.Key
		descEntries[i].Comment = e.Comment
	}
	if err := config.ApplyDescriptions(descEntries); err != nil {
		// 描述写入失败不影响主流程
		fmt.Printf("写入描述文件失败: %v\n", err)
	}
	return model.ModelSaveResult{Success: true}
}

// AddModelEntry 添加 agent 或 category 条目。
func (a *App) AddModelEntry(key, modelName, entryType string) model.ModelSaveResult {
	if err := config.AddConfigEntry(key, modelName, entryType); err != nil {
		return model.ModelSaveResult{Success: false, Error: err.Error()}
	}
	return model.ModelSaveResult{Success: true}
}

// AddModelType 添加模型配置类型分组。
func (a *App) AddModelType(entryType string) model.ModelSaveResult {
	if err := config.AddModelType(entryType); err != nil {
		return model.ModelSaveResult{Success: false, Error: err.Error()}
	}
	return model.ModelSaveResult{Success: true}
}

// DeleteModelType 删除整个模型配置类型分组。
func (a *App) DeleteModelType(entryType string) model.ModelSaveResult {
	if err := config.DeleteModelType(entryType); err != nil {
		return model.ModelSaveResult{Success: false, Error: err.Error()}
	}
	return model.ModelSaveResult{Success: true}
}

// DeleteModelEntry 删除 agent 或 category 条目。
func (a *App) DeleteModelEntry(key, entryType string) model.ModelSaveResult {
	if err := config.DeleteConfigEntry(key, entryType); err != nil {
		return model.ModelSaveResult{Success: false, Error: err.Error()}
	}
	return model.ModelSaveResult{Success: true}
}

// GetConfigPath 返回模型配置文件路径。
func (a *App) GetConfigPath() string {
	return config.ConfigPath()
}

// GetProviderConfigPath 返回供应商配置文件路径。
func (a *App) GetProviderConfigPath() string {
	return config.OpenCodeConfigPath()
}

// GetFullConfig 返回完整 JSONC 字符串。
func (a *App) GetFullConfig() string {
	return config.GetFullConfig()
}

// SaveFullConfig 将前端修改后的完整 JSON 字符串直接写入文件。
func (a *App) SaveFullConfig(jsonStr string) model.SaveResult {
	return config.SaveFullConfig(jsonStr)
}

// ========== 供应商配置 ==========

// GetProviders 获取所有供应商配置。
func (a *App) GetProviders() ([]model.ProviderInfo, error) {
	return config.GetProviders(), nil
}

// SaveProvider 保存供应商配置。
func (a *App) SaveProvider(ps model.ProviderSave) model.SaveResult {
	if err := config.SaveProvider(ps); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// DeleteProvider 删除供应商。
func (a *App) DeleteProvider(key string) model.SaveResult {
	if err := config.DeleteProvider(key); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// ========== 方案管理 ==========

// GetSchemeDir 返回方案目录的绝对路径。
func (a *App) GetSchemeDir() string {
	dir, err := config.SchemeDir()
	if err != nil {
		return ""
	}
	return dir
}

// ListSchemes 扫描方案目录并返回所有方案文件信息。
func (a *App) ListSchemes() []model.SchemeInfo {
	schemes, err := config.ListSchemes()
	if err != nil {
		return []model.SchemeInfo{}
	}
	return schemes
}

// ReadScheme 读取指定方案文件的原始内容。
func (a *App) ReadScheme(name string) (string, error) {
	return config.ReadScheme(name)
}

// SaveScheme 将内容保存到方案文件（原子写入，JSONC 验证）。
func (a *App) SaveScheme(name string, content string) error {
	return config.SaveScheme(name, content)
}

// DeleteScheme 删除指定方案文件。
func (a *App) DeleteScheme(name string) error {
	return config.DeleteScheme(name)
}

// OpenSchemeDir 在文件资源管理器中打开方案目录。
func (a *App) OpenSchemeDir() error {
	dir, err := config.EnsureSchemeDir()
	if err != nil {
		return err
	}
	return a.OpenDir(dir)
}

// ExportConfig 将配置内容导出到指定目录。
func (a *App) ExportConfig(dir, filename, content string) (string, error) {
	return service.ExportConfig(dir, filename, content)
}

// ========== Web 服务（委托到 service 包）==========

// StartOpenCodeWeb 启动 opencode serve。
func (a *App) StartOpenCodeWeb(port int, hostname string, proxy model.ProxyConfig) model.WebResult {
	return service.StartOpenCodeWeb(port, hostname, proxy)
}

// StopOpenCodeWeb 停止 opencode web 服务。
func (a *App) StopOpenCodeWeb() model.WebResult {
	return service.StopOpenCodeWeb()
}

// GetWebStatus 返回当前 web 服务状态。
func (a *App) GetWebStatus(hostname string, port int) model.WebResult {
	return service.GetWebStatus(hostname, port)
}

// OpenCodeAPI 代理访问本机 opencode serve API。
func (a *App) OpenCodeAPI(method, path, body string) model.APIResult {
	return service.OpenCodeAPI(method, path, body)
}

// CreateSession 使用指定工作目录创建新会话。
func (a *App) CreateSession(workDir string) model.APIResult {
	return service.CreateSession(workDir)
}

// AnswerQuestion 回答 question 工具调用。
func (a *App) AnswerQuestion(sessionID, answerLabel string) model.APIResult {
	return service.AnswerQuestion(sessionID, answerLabel)
}

// RejectQuestion 忽略 question 工具调用。
func (a *App) RejectQuestion(sessionID string) model.APIResult {
	return service.RejectQuestion(sessionID)
}

// GetProjectTree 获取项目→目录→会话的树形结构 JSON。
func (a *App) GetProjectTree(knownDirs string) string {
	return service.GetProjectTree(knownDirs)
}

// StartOpenCodeEvents 连接 opencode 全局 SSE。
func (a *App) StartOpenCodeEvents() model.APIResult {
	return service.StartOpenCodeEvents(a.ctx)
}

// StopOpenCodeEvents 停止 SSE 转发。
func (a *App) StopOpenCodeEvents() model.APIResult {
	return service.StopOpenCodeEvents()
}

// LaunchWindowsTerminal 在外部终端中打开 opencode。
func (a *App) LaunchWindowsTerminal(mode, webURL, dir string) model.WebResult {
	return service.LaunchWindowsTerminal(mode, webURL, dir)
}

// OpenDirectoryDialog 打开目录选择对话框。
func (a *App) OpenDirectoryDialog() string {
	return service.OpenDirectoryDialog(a.ctx)
}

// ShowConfirmDialog 显示原生确认对话框，桌面端替代 window.confirm。
func (a *App) ShowConfirmDialog(title, message string) bool {
	return service.ShowConfirmDialog(a.ctx, title, message)
}

// GetOpenCodeCommands 从 opencode serve 获取所有可用命令。
func (a *App) GetOpenCodeCommands() []model.CmdPaletteItem {
	return service.GetOpenCodeCommands()
}

// GetSessions 获取最近 15 个 OpenCode 会话记录。
func (a *App) GetSessions() ([]model.SessionInfo, error) {
	return service.GetSessions()
}

// StartFrontendWeb 启动页面访问服务。
func (a *App) StartFrontendWeb(port int, hostname string) model.WebResult {
	frontendFS, err := iofs.Sub(assets, "frontend/dist")
	if err != nil {
		return model.WebResult{Error: "加载前端资源失败: " + err.Error()}
	}
	return service.StartFrontendWebServer(frontendFS, a, port, hostname)
}

// StopFrontendWeb 停止页面访问服务。
func (a *App) StopFrontendWeb() model.WebResult {
	return service.StopFrontendWebServer()
}

// GetFrontendWebStatus 返回页面访问服务状态。
func (a *App) GetFrontendWebStatus(hostname string, port int) model.WebResult {
	return service.FrontendWebStatus(hostname, port)
}

// AppCall 为前端 Web 统一分发调用。
func (a *App) AppCall(method string, args []json.RawMessage) (interface{}, error) {
	return a.callFrontendMethod(method, args)
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

func (a *App) callFrontendMethod(method string, args []json.RawMessage) (interface{}, error) {
	switch method {
	case "GetCommands":
		return a.GetCommands(), nil
	case "StartFrontendWeb":
		var port int
		var hostname string
		if err := decodeArgs(args, &port, &hostname); err != nil { return nil, err }
		return a.StartFrontendWeb(port, hostname), nil
	case "StopFrontendWeb":
		return a.StopFrontendWeb(), nil
	case "GetFrontendWebStatus":
		var hostname string
		var port int
		if err := decodeArgs(args, &hostname, &port); err != nil { return nil, err }
		return a.GetFrontendWebStatus(hostname, port), nil
	case "GetOpenCodeCommands":
		return a.GetOpenCodeCommands(), nil
	case "GetSkillConfig":
		return a.GetSkillConfig(), nil
	case "GetDirEnabledSkills":
		var dir string
		if err := decodeArgs(args, &dir); err != nil { return nil, err }
		return a.GetDirEnabledSkills(dir), nil
	case "GetSkills":
		return a.GetSkills(), nil
	case "GetAggregatedSkills":
		return a.GetAggregatedSkills(), nil
	case "GetStats":
		return a.GetStats(), nil
	case "GetSourceDir":
		return a.GetSourceDir(), nil
	case "ListBrowsableDirs":
		var path string
		if err := decodeArgs(args, &path); err != nil { return nil, err }
		return a.ListBrowsableDirs(path)
	case "ReadSkillContent":
		var skillPath string
		if err := decodeArgs(args, &skillPath); err != nil { return nil, err }
		return a.ReadSkillContent(skillPath)
	case "SaveSkillContent":
		var skillPath, content string
		if err := decodeArgs(args, &skillPath, &content); err != nil { return nil, err }
		return map[string]bool{"success": a.SaveSkillContent(skillPath, content) == nil}, nil
	case "ListSkillFiles":
		var skillPath string
		if err := decodeArgs(args, &skillPath); err != nil { return nil, err }
		return a.ListSkillFiles(skillPath)
	case "ReadSkillFile":
		var skillPath, relativePath string
		if err := decodeArgs(args, &skillPath, &relativePath); err != nil { return nil, err }
		return a.ReadSkillFile(skillPath, relativePath)
	case "SaveSkillFile":
		var skillPath, relativePath, content string
		if err := decodeArgs(args, &skillPath, &relativePath, &content); err != nil { return nil, err }
		return map[string]bool{"success": a.SaveSkillFile(skillPath, relativePath, content) == nil}, nil
	case "ToggleSkill":
		var skillPath, skillName string
		var enable bool
		if err := decodeArgs(args, &skillPath, &skillName, &enable); err != nil { return nil, err }
		return a.ToggleSkill(skillPath, skillName, enable), nil
	case "GetProviders":
		return a.GetProviders()
	case "GetAvailableModels":
		return a.GetAvailableModels()
	case "GetModelConfig":
		return a.GetModelConfig()
	case "GetProviderConfigPath":
		return a.GetProviderConfigPath(), nil
	case "SaveProvider":
		var provider model.ProviderSave
		if err := decodeArgs(args, &provider); err != nil { return nil, err }
		return a.SaveProvider(provider), nil
	case "DeleteProvider":
		var key string
		if err := decodeArgs(args, &key); err != nil { return nil, err }
		return a.DeleteProvider(key), nil
	case "GetFullConfig":
		return a.GetFullConfig(), nil
	case "GetConfigPath":
		return a.GetConfigPath(), nil
	case "GetAgentDescriptions":
		return a.GetAgentDescriptions(), nil
	case "AddModelType":
		var entryType string
		if err := decodeArgs(args, &entryType); err != nil { return nil, err }
		return a.AddModelType(entryType), nil
	case "DeleteModelType":
		var entryType string
		if err := decodeArgs(args, &entryType); err != nil { return nil, err }
		return a.DeleteModelType(entryType), nil
	case "GetSchemeDir":
		return a.GetSchemeDir(), nil
	case "ListSchemes":
		return a.ListSchemes(), nil
	case "ReadScheme":
		var name string
		if err := decodeArgs(args, &name); err != nil { return nil, err }
		return a.ReadScheme(name)
	case "SaveScheme":
		var name, content string
		if err := decodeArgs(args, &name, &content); err != nil { return nil, err }
		return map[string]bool{"success": a.SaveScheme(name, content) == nil}, nil
	case "SaveFullConfig":
		var jsonStr string
		if err := decodeArgs(args, &jsonStr); err != nil { return nil, err }
		return a.SaveFullConfig(jsonStr), nil
	case "RefreshAvailableModels":
		return a.RefreshAvailableModels()
	case "Refresh":
		return map[string]bool{"success": a.Refresh() == nil}, nil
	case "AddSkillSourceDir":
		var dir string
		if err := decodeArgs(args, &dir); err != nil { return nil, err }
		return a.AddSkillSourceDir(dir), nil
	case "RemoveSkillSourceDir":
		var dir string
		if err := decodeArgs(args, &dir); err != nil { return nil, err }
		return a.RemoveSkillSourceDir(dir), nil
	case "GetSkillSourceDirs":
		return a.GetSkillSourceDirs(), nil
	case "AnswerQuestion":
		var sessionID, answerLabel string
		if err := decodeArgs(args, &sessionID, &answerLabel); err != nil { return nil, err }
		return a.AnswerQuestion(sessionID, answerLabel), nil
	case "RejectQuestion":
		var sessionID string
		if err := decodeArgs(args, &sessionID); err != nil { return nil, err }
		return a.RejectQuestion(sessionID), nil
	case "OpenDirectoryDialog":
		return a.OpenDirectoryDialog(), nil
	case "ShowConfirmDialog":
		var title, message string
		if err := decodeArgs(args, &title, &message); err != nil { return nil, err }
		return a.ShowConfirmDialog(title, message), nil
	case "LaunchWindowsTerminal":
		var mode, webURL, dir string
		if err := decodeArgs(args, &mode, &webURL, &dir); err != nil { return nil, err }
		return a.LaunchWindowsTerminal(mode, webURL, dir), nil
	case "OpenDir":
		var path string
		if err := decodeArgs(args, &path); err != nil { return nil, err }
		return map[string]bool{"success": a.OpenDir(path) == nil}, nil
	case "OpenSchemeDir":
		return map[string]bool{"success": a.OpenSchemeDir() == nil}, nil
	case "ExportConfig":
		var dir, filename, content string
		if err := decodeArgs(args, &dir, &filename, &content); err != nil { return nil, err }
		return a.ExportConfig(dir, filename, content)
	case "SaveSkillScheme":
		var name string
		if err := decodeArgs(args, &name); err != nil { return nil, err }
		return a.SaveSkillScheme(name), nil
	case "ApplySkillScheme":
		var name string
		if err := decodeArgs(args, &name); err != nil { return nil, err }
		return a.ApplySkillScheme(name), nil
	case "ListSkillSchemes":
		return a.ListSkillSchemes(), nil
	case "DeleteSkillScheme":
		var name string
		if err := decodeArgs(args, &name); err != nil { return nil, err }
		return a.DeleteSkillScheme(name), nil
	default:
		return nil, fmt.Errorf("unsupported method: %s", method)
	}
}

func decodeArgs(args []json.RawMessage, targets ...interface{}) error {
	if len(args) < len(targets) {
		return fmt.Errorf("参数数量不足: need %d got %d", len(targets), len(args))
	}
	for i, target := range targets {
		if err := json.Unmarshal(args[i], target); err != nil {
			return fmt.Errorf("参数 %d 解析失败: %w", i, err)
		}
	}
	return nil
}

// ========== 数据传输类型（保留在 main 包用于 Wails bind）==========

// 类型定义已迁移至 model 子包。以下通过类型别名保持前端 bind 兼容。
type (
	SkillInfo          = model.SkillInfo
	SkillContent       = model.SkillContent
	Stats              model.Stats
	ToggleResult       = model.ToggleResult
	WebResult          = model.WebResult
	APIResult          = model.APIResult
	ProxyConfig        = model.ProxyConfig
	ModelEntry         = model.ModelEntry
	ModelSaveResult    = model.ModelSaveResult
	SaveResult         = model.SaveResult
	ProviderInfo       = model.ProviderInfo
	ModelInfo          = model.ModelInfo
	ProviderSave       = model.ProviderSave
	CmdInfo            = model.CmdInfo
	CmdGroup           = model.CmdGroup
	CmdPaletteItem     = model.CmdPaletteItem
	SessionInfo        = model.SessionInfo
	SchemeInfo         = model.SchemeInfo
	SchemeApplyResult  = model.SchemeApplyResult
)

// String 实现 Stringer 接口，便于调试。
func (s Stats) String() string {
	return fmt.Sprintf("Skills: %d", s.GlobalSkills)
}
