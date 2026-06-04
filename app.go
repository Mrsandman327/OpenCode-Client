package main

import (
	"context"
	"encoding/json"
	"fmt"
	iofs "io/fs"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"oc-manager/config/commands"
	"oc-manager/config/omo"
	"oc-manager/config/provider"
	"oc-manager/config/skill"
	"oc-manager/model"
	"oc-manager/service/filebrowser"
	"oc-manager/service/opencode"
	"oc-manager/service/projectconfig"
	"oc-manager/service/web"

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
	dirs, _ := skill.ListSourceDirs()
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
	dirs, err := skill.ListSourceDirs()
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
	return filebrowser.ListBrowsableDirs(path)
}

// ListBrowserFiles 返回站内文件浏览器目录列表。
func (a *App) ListBrowserFiles(rootDir, path string) (model.FileBrowserListResult, error) {
	return filebrowser.ListBrowserFiles(rootDir, path)
}

// StatBrowserFile 返回站内文件浏览器文件信息。
func (a *App) StatBrowserFile(rootDir, path string) (model.FileBrowserStatResult, error) {
	return filebrowser.StatBrowserFile(rootDir, path)
}

// ReadBrowserFile 返回站内文件浏览器文本文件内容。
func (a *App) ReadBrowserFile(rootDir, path string) (model.FileBrowserReadResult, error) {
	return filebrowser.ReadBrowserFile(rootDir, path)
}

// SaveBrowserFile 保存站内文件浏览器文本文件内容。
func (a *App) SaveBrowserFile(rootDir, path, content string) (model.SaveResult, error) {
	return filebrowser.SaveBrowserFile(rootDir, path, content)
}

// ReadBrowserRawBase64 返回原始文件 Base64 内容，供桌面端图片/PDF/下载使用。
func (a *App) ReadBrowserRawBase64(rootDir, path string) (model.FileBrowserRawResult, error) {
	return filebrowser.ReadBrowserRawBase64(rootDir, path)
}

// UploadBrowserFile 上传单个文件到当前文件浏览器目录。
func (a *App) UploadBrowserFile(rootDir, path, fileName, base64Data string, overwrite bool) (model.FileBrowserUploadResult, error) {
	return filebrowser.UploadBrowserFile(rootDir, path, fileName, base64Data, overwrite)
}

// CreateBrowserDir 在当前文件浏览器目录下创建文件夹。
func (a *App) CreateBrowserDir(rootDir, path, dirName string) (model.SaveResult, error) {
	return filebrowser.CreateBrowserDir(rootDir, path, dirName)
}

// DeleteBrowserEntry 删除文件浏览器中的文件或目录。
func (a *App) DeleteBrowserEntry(rootDir, path string) (model.SaveResult, error) {
	return filebrowser.DeleteBrowserEntry(rootDir, path)
}

// GetGitStatus 返回目录 Git 变更状态。
func (a *App) GetGitStatus(rootDir string) model.GitStatusResult {
	return filebrowser.ListGitChanges(rootDir)
}

// GetGitPreview 返回单文件 Git 预览结果。
func (a *App) GetGitPreview(rootDir, path string) (model.GitFilePreviewResult, error) {
	status := filebrowser.ListGitChanges(rootDir)
	for _, changed := range status.Files {
		if changed.Path == path {
			return filebrowser.BuildGitFilePreview(rootDir, changed)
		}
	}
	return model.GitFilePreviewResult{}, fmt.Errorf("未找到 Git 变更文件")
}

// GetGitHistory 返回目录提交历史列表。
func (a *App) GetGitHistory(rootDir string, offset, limit int) (model.GitHistoryResult, error) {
	return filebrowser.ListGitHistory(rootDir, offset, limit)
}

// GetGitHistoryFiles 返回指定提交的文件列表。
func (a *App) GetGitHistoryFiles(rootDir, commitHash string) (model.GitCommitFilesResult, error) {
	return filebrowser.ListGitCommitFiles(rootDir, commitHash)
}

// GetGitHistoryPreview 返回指定提交中文件的 diff 预览。
func (a *App) GetGitHistoryPreview(rootDir, commitHash, path string) (model.GitCommitFilePreviewResult, error) {
	return filebrowser.BuildGitCommitFilePreview(rootDir, commitHash, path)
}

// StageFile 暂存指定文件。
func (a *App) StageFile(rootDir, path string) model.GitActionResult {
	result, _ := filebrowser.StageFile(rootDir, path)
	return result
}

// UnstageFile 取消暂存指定文件。
func (a *App) UnstageFile(rootDir, path string) model.GitActionResult {
	result, _ := filebrowser.UnstageFile(rootDir, path)
	return result
}

// StageAllFiles 暂存所有未暂存文件。
func (a *App) StageAllFiles(rootDir string) model.GitActionResult {
	result, _ := filebrowser.StageAllFiles(rootDir)
	return result
}

// GitCommit 提交当前暂存区。
func (a *App) GitCommit(rootDir, message string) model.GitActionResult {
	result, _ := filebrowser.GitCommit(rootDir, message)
	return result
}

// GitPush 推送当前分支到远端。
func (a *App) GitPush(rootDir string, proxy model.ProxyConfig) model.GitActionResult {
	result, _ := filebrowser.GitPush(rootDir, proxy)
	return result
}

// GitPull 从远端拉取当前分支。
func (a *App) GitPull(rootDir string, proxy model.ProxyConfig) model.GitActionResult {
	result, _ := filebrowser.GitPull(rootDir, proxy)
	return result
}

// DiscardFile 撤销文件变更。
func (a *App) DiscardFile(rootDir, path string) model.GitActionResult {
	result, _ := filebrowser.DiscardFile(rootDir, path)
	return result
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

// Refresh 重新扫描技能目录并刷新状态。
func (a *App) Refresh() error {
	a.sm = skill.NewManager()
	return nil
}

// AddSkillSourceDir 添加技能源目录到配置。
// 通过 a.sm.SourceDir() 获取 opencode 全局技能目录路径用于排除检查。
func (a *App) AddSkillSourceDir(dir string) model.SaveResult {
	if _, err := skill.AddSourceDir(dir, a.sm.SourceDir()); err != nil {
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
	if _, err := skill.RemoveSourceDir(dir); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// GetSkillSourceDirs 返回当前配置中所有技能源目录。
func (a *App) GetSkillSourceDirs() []string {
	dirs, err := skill.ListSourceDirs()
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
	if err := skill.SaveSkillScheme(name, names); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// ApplySkillScheme 应用指定名称的技能方案。
func (a *App) ApplySkillScheme(name string) model.SchemeApplyResult {
	// 1. 加载方案
	scheme, err := skill.LoadSkillScheme(name)
	if err != nil {
		return model.SchemeApplyResult{
			Errors:  []string{err.Error()},
			Success: false,
		}
	}
	// 2. 获取聚合技能列表
	available := a.GetAggregatedSkills()
	// 3. 获取来源目录
	sourceDirs, _ := skill.ListSourceDirs()
	// 4. 应用方案
	return a.sm.ApplySkillScheme(scheme, available, sourceDirs)
}

// ListSkillSchemes 返回所有技能方案名称列表。
func (a *App) ListSkillSchemes() []string {
	schemes, err := skill.ListSkillSchemes()
	if err != nil {
		return []string{}
	}
	return schemes
}

// DeleteSkillScheme 删除指定技能方案。
func (a *App) DeleteSkillScheme(name string) model.SaveResult {
	if err := skill.DeleteSkillScheme(name); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// ========== 模型配置 ==========

// GetModelConfig 读取所有 agent/category 的模型配置。
func (a *App) GetModelConfig() ([]model.ModelEntry, error) {
	cfg, _, _, err := omo.LoadConfig()
	if err != nil {
		return nil, err
	}
	descs, _ := omo.LoadAgentDescriptions()
	return omo.ConfigToEntries(cfg, descs), nil
}

// GetAgentDescriptions 返回 agent/category 描述表。
func (a *App) GetAgentDescriptions() map[string]string {
	descs, err := omo.LoadAgentDescriptions()
	if err != nil {
		return nil
	}
	return descs
}

// UpdateModels 批量更新模型配置并保存到 JSONC 文件，同时将描述写入 agents-comments.json。
func (a *App) UpdateModels(entries []model.ModelEntry) model.SaveResult {
	if err := omo.SaveConfig(entries); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
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
	if err := omo.ApplyDescriptions(descEntries); err != nil {
		// 描述写入失败不影响主流程
		fmt.Printf("写入描述文件失败: %v\n", err)
	}
	return model.SaveResult{Success: true}
}

// AddModelEntry 添加 agent 或 category 条目。
func (a *App) AddModelEntry(key, modelName, entryType string) model.SaveResult {
	if err := omo.AddConfigEntry(key, modelName, entryType); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// AddModelType 添加模型配置类型分组。
func (a *App) AddModelType(entryType string) model.SaveResult {
	if err := omo.AddModelType(entryType); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// DeleteModelType 删除整个模型配置类型分组。
func (a *App) DeleteModelType(entryType string) model.SaveResult {
	if err := omo.DeleteModelType(entryType); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// DeleteModelEntry 删除 agent 或 category 条目。
func (a *App) DeleteModelEntry(key, entryType string) model.SaveResult {
	if err := omo.DeleteConfigEntry(key, entryType); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// GetConfigPath 返回模型配置文件路径。
func (a *App) GetConfigPath() string {
	return omo.ConfigPath()
}

// GetProviderConfigPath 返回供应商配置文件路径。
func (a *App) GetProviderConfigPath() string {
	return provider.OpenCodeConfigPath()
}

// GetFullConfig 返回完整 JSONC 字符串。
func (a *App) GetFullConfig() string {
	return omo.GetFullConfig()
}

// SaveFullConfig 将前端修改后的完整 JSON 字符串直接写入文件。
func (a *App) SaveFullConfig(jsonStr string) model.SaveResult {
	return omo.SaveFullConfig(jsonStr)
}

// ========== 供应商配置 ==========

// GetProviders 获取所有供应商配置。
func (a *App) GetProviders() ([]model.ProviderInfo, error) {
	return provider.GetProviders(), nil
}

// GetModelList 调用供应商 API 获取可用模型列表。
func (a *App) GetModelList(baseURL, apiKey string) []string {
	return provider.GetModelList(baseURL, apiKey)
}

// SaveProvider 保存供应商配置。
func (a *App) SaveProvider(ps model.ProviderSave) model.SaveResult {
	if err := provider.SaveProvider(ps); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// DeleteProvider 删除供应商。
func (a *App) DeleteProvider(key string) model.SaveResult {
	if err := provider.DeleteProvider(key); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// ========== 方案管理 ==========

// GetSchemeDir 返回方案目录的绝对路径。
func (a *App) GetSchemeDir() string {
	dir, err := omo.SchemeDir()
	if err != nil {
		return ""
	}
	return dir
}

// ListSchemes 扫描方案目录并返回所有方案文件信息。
func (a *App) ListSchemes() []model.SchemeInfo {
	schemes, err := omo.ListSchemes()
	if err != nil {
		return []model.SchemeInfo{}
	}
	return schemes
}

// ReadScheme 读取指定方案文件的原始内容。
func (a *App) ReadScheme(name string) (string, error) {
	return omo.ReadScheme(name)
}

// SaveScheme 将内容保存到方案文件（原子写入，JSONC 验证）。
func (a *App) SaveScheme(name string, content string) error {
	return omo.SaveScheme(name, content)
}

// DeleteScheme 删除指定方案文件。
func (a *App) DeleteScheme(name string) error {
	return omo.DeleteScheme(name)
}

// OpenSchemeDir 在文件资源管理器中打开方案目录。
func (a *App) OpenSchemeDir() error {
	dir, err := omo.EnsureSchemeDir()
	if err != nil {
		return err
	}
	return a.OpenDir(dir)
}

// ExportConfig 将配置内容导出到指定目录。
func (a *App) ExportConfig(dir, filename, content string) (string, error) {
	return omo.ExportConfig(dir, filename, content)
}

// ========== Web 服务（委托到 service 包）==========

// StartOpenCodeWeb 启动 opencode serve。
func (a *App) StartOpenCodeWeb(port int, hostname string, proxy model.ProxyConfig) model.WebResult {
	return opencode.StartOpenCodeWeb(port, hostname, proxy)
}

// StopOpenCodeWeb 停止 opencode web 服务。
func (a *App) StopOpenCodeWeb() model.WebResult {
	return opencode.StopOpenCodeWeb()
}

// GetWebStatus 返回当前 web 服务状态。
func (a *App) GetWebStatus(hostname string, port int) model.WebResult {
	return opencode.GetWebStatus(hostname, port)
}

// OpenCodeAPI 代理访问本机 opencode serve API。
func (a *App) OpenCodeAPI(method, path, body string) model.APIResult {
	return opencode.OpenCodeAPI(method, path, body)
}

// AnswerQuestion 回答 question 工具调用。
func (a *App) AnswerQuestion(sessionID, answerLabel string) model.APIResult {
	return opencode.AnswerQuestion(sessionID, answerLabel)
}

// RejectQuestion 忽略 question 工具调用。
func (a *App) RejectQuestion(sessionID string) model.APIResult {
	return opencode.RejectQuestion(sessionID)
}

// GetProjectTree 获取项目→目录→会话的树形结构 JSON。
func (a *App) GetProjectTree(knownDirs string) string {
	return opencode.GetProjectTree(knownDirs)
}

// StartOpenCodeEvents 连接 opencode 全局 SSE。
func (a *App) StartOpenCodeEvents() model.APIResult {
	return opencode.StartOpenCodeEvents(a.ctx)
}

// StopOpenCodeEvents 停止 SSE 转发。
func (a *App) StopOpenCodeEvents() model.APIResult {
	return opencode.StopOpenCodeEvents()
}

// LaunchWindowsTerminal 在外部终端中打开 opencode。
func (a *App) LaunchWindowsTerminal(mode, webURL, dir string) model.WebResult {
	return opencode.LaunchWindowsTerminal(mode, webURL, dir)
}

// OpenDirectoryDialog 打开目录选择对话框。
func (a *App) OpenDirectoryDialog() string {
	return opencode.OpenDirectoryDialog(a.ctx)
}

// ShowConfirmDialog 显示原生确认对话框，桌面端替代 window.confirm。
func (a *App) ShowConfirmDialog(title, message string) bool {
	return opencode.ShowConfirmDialog(a.ctx, title, message)
}

// StartFrontendWeb 启动页面访问服务。
func (a *App) StartFrontendWeb(port int, hostname string) model.WebResult {
	frontendFS, err := iofs.Sub(assets, "frontend/dist")
	if err != nil {
		return model.WebResult{Error: "加载前端资源失败: " + err.Error()}
	}
	return web.StartFrontendWebServer(frontendFS, a, port, hostname)
}

// StopFrontendWeb 停止页面访问服务。
func (a *App) StopFrontendWeb() model.WebResult {
	return web.StopFrontendWebServer()
}

// GetFrontendWebStatus 返回页面访问服务状态。
func (a *App) GetFrontendWebStatus(hostname string, port int) model.WebResult {
	return web.FrontendWebStatus(hostname, port)
}

// GetCommands 返回所有常用命令分组数据。
func (a *App) GetCommands() []CmdGroup {
	return commands.GetCommands()
}

// GetProjectConfigSummary 返回项目 .opencode/ 配置的四个 tab 聚合信息。
func (a *App) GetProjectConfigSummary(rootDir string) model.ProjectConfigSummary {
	return projectconfig.GetProjectConfigSummary(rootDir)
}

// ReadProjectConfigFile 读取项目配置文件内容。
func (a *App) ReadProjectConfigFile(rootDir, category, relPath string) (model.ProjectConfigFileResult, error) {
	return projectconfig.ReadProjectFile(rootDir, category, relPath)
}

// SaveProjectConfigFile 写入项目配置文件。
func (a *App) SaveProjectConfigFile(rootDir, category, relPath, content string) (model.ProjectConfigFileResult, error) {
	return projectconfig.SaveProjectFile(rootDir, category, relPath, content)
}

// GetGlobalOpenCodeConfig 返回全局 opencode 配置文件的路径和内容。
func (a *App) GetGlobalOpenCodeConfig() model.GlobalConfigInfo {
	return projectconfig.GetGlobalOpenCodeConfig()
}

// ListProjectConfigDir 列出项目配置目录下的文件列表。
func (a *App) ListProjectConfigDir(rootDir, category, relPath string) (model.ProjectConfigTab, error) {
	return projectconfig.ListProjectDir(rootDir, category, relPath)
}

// CreateProjectEntry 在项目配置目录下创建新文件。
func (a *App) CreateProjectEntry(rootDir, category, name string) (model.ProjectConfigFileEntry, error) {
	return projectconfig.CreateProjectEntry(rootDir, category, name)
}

// DeleteProjectEntry 删除项目配置目录下的文件或空目录。
func (a *App) DeleteProjectEntry(rootDir, category, relPath string) error {
	return projectconfig.DeleteProjectEntry(rootDir, category, relPath)
}

// GetImportableSkills 返回可导入到项目中的技能列表。
func (a *App) GetImportableSkills(rootDir string) []model.ImportableSkill {
	return projectconfig.GetImportableSkills(rootDir)
}

// ImportSkill 将技能通过软链接导入到项目 .opencode/skills/ 中。
func (a *App) ImportSkill(rootDir, sourcePath, skillName string) error {
	return projectconfig.ImportSkill(rootDir, sourcePath, skillName)
}

// CheckOpenCodeVersion 检测 opencode 最新版本。
func (a *App) CheckOpenCodeVersion(currentVersion string) model.VersionCheckResult {
	result := model.VersionCheckResult{CurrentVersion: currentVersion, IsLatest: true}

	resp, err := http.Get("https://api.github.com/repos/anomalyco/opencode/releases/latest")
	if err != nil {
		result.Error = "获取最新版本信息失败"
		return result
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		result.Error = "读取版本信息失败"
		return result
	}

	var release struct {
		TagName string `json:"tag_name"`
	}
	if err := json.Unmarshal(body, &release); err != nil {
		result.Error = "解析版本信息失败"
		return result
	}

	latest := strings.TrimPrefix(release.TagName, "v")
	current := strings.TrimPrefix(currentVersion, "v")
	result.LatestVersion = release.TagName
	result.IsLatest = current == latest
	return result
}
