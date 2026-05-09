package main

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"

	"oc-manager/config"
	"oc-manager/model"
	"oc-manager/service"
	"oc-manager/skill"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// App 是 Wails 应用的核心结构体，所有绑定到前端的方法都定义在此。
type App struct {
	app *application.App
	sm  *skill.Manager
}

// NewApp 创建新的 App 实例。
func NewApp(app *application.App) *App {
	if app == nil {
		panic("Wails 应用实例不能为空")
	}
	return &App{
		app: app,
		sm:  skill.NewManager(),
	}
}

// ServiceStartup 在 Wails 服务启动时调用。
func (a *App) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	return nil
}

// ServiceShutdown 在应用关闭时调用，清理资源。
func (a *App) ServiceShutdown() error {
	a.StopOpenCodeWeb()
	return nil
}

func (a *App) emitEvent(event string, data ...interface{}) {
	if a.app == nil {
		panic("Wails 应用实例不能为空")
	}
	a.app.Event.Emit(event, data...)
}

func (a *App) openDirectory(title, defaultDirectory string) (string, error) {
	if a.app == nil {
		return "", fmt.Errorf("Wails 应用实例不能为空")
	}
	return a.app.Dialog.OpenFile().
		SetTitle(title).
		SetDirectory(defaultDirectory).
		CanChooseDirectories(true).
		CanChooseFiles(false).
		PromptForSingleSelection()
}

// ========== 技能管理 ==========

// GetSkills 返回所有技能及其在各平台的链接状态。
func (a *App) GetSkills() []model.SkillInfo {
	return a.sm.GetAllSkills()
}

// GetSourceDir 返回技能源目录路径。
func (a *App) GetSourceDir() string {
	return a.sm.SourceDir()
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

// Refresh 重新扫描技能目录并刷新状态。
func (a *App) Refresh() error {
	a.sm = skill.NewManager()
	return nil
}

// ========== 模型配置 ==========

// GetModelConfig 读取所有 agent/category 的模型配置。
func (a *App) GetModelConfig() ([]model.ModelEntry, error) {
	cfg, _, comments, err := config.LoadConfig()
	if err != nil {
		return nil, err
	}
	return config.ConfigToEntries(cfg, comments), nil
}

// GetAvailableModels 通过 opencode models 获取所有可用模型。
func (a *App) GetAvailableModels() ([]string, error) {
	return getAvailableModels()
}

// RefreshAvailableModels 强制刷新模型列表缓存。
func (a *App) RefreshAvailableModels() ([]string, error) {
	refreshModels()
	return getAvailableModels()
}

// UpdateModels 批量更新模型配置并保存到 JSONC 文件。
func (a *App) UpdateModels(entries []model.ModelEntry) model.ModelSaveResult {
	if err := config.SaveConfig(entries); err != nil {
		return model.ModelSaveResult{Success: false, Error: err.Error()}
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
	return service.StartOpenCodeEvents(a.emitEvent)
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
	return service.OpenDirectoryDialog(a.openDirectory)
}

// GetOpenCodeCommands 从 opencode serve 获取所有可用命令。
func (a *App) GetOpenCodeCommands() []model.CmdPaletteItem {
	return service.GetOpenCodeCommands()
}

// GetSessions 获取最近 15 个 OpenCode 会话记录。
func (a *App) GetSessions() ([]model.SessionInfo, error) {
	return service.GetSessions()
}

// ========== 数据传输类型（保留在 main 包用于 Wails bind）==========

// 类型定义已迁移至 model 子包。以下通过类型别名保持前端 bind 兼容。
type (
	SkillInfo       = model.SkillInfo
	SkillContent    = model.SkillContent
	Stats           model.Stats
	ToggleResult    = model.ToggleResult
	WebResult       = model.WebResult
	APIResult       = model.APIResult
	ProxyConfig     = model.ProxyConfig
	ModelEntry      = model.ModelEntry
	ModelSaveResult = model.ModelSaveResult
	SaveResult      = model.SaveResult
	ProviderInfo    = model.ProviderInfo
	ModelInfo       = model.ModelInfo
	ProviderSave    = model.ProviderSave
	CmdInfo         = model.CmdInfo
	CmdGroup        = model.CmdGroup
	CmdPaletteItem  = model.CmdPaletteItem
	SessionInfo     = model.SessionInfo
)

// String 实现 Stringer 接口，便于调试。
func (s Stats) String() string {
	return fmt.Sprintf("Skills: %d", s.GlobalSkills)
}
