package main

import (
	"context"
	"fmt"
	iofs "io/fs"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"oc-manager/config/commands"
	"oc-manager/config/mcp"
	"oc-manager/config/omo"
	"oc-manager/config/provider"
	"oc-manager/config/skill"
	"oc-manager/internal/logger"
	"oc-manager/internal/portable"
	"oc-manager/internal/reveal"
	"oc-manager/model"
	"oc-manager/service/filebrowser"
	"oc-manager/service/knowledge"
	"oc-manager/service/opencode"
	"oc-manager/service/projectconfig"
	"oc-manager/service/web"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// App 是 Wails 应用的核心结构体，所有绑定到前端的方法都定义在此。
type App struct {
	ctx context.Context
	app *application.App // v3 应用引用（由 main 注入），供事件/对话框/浏览器调用
	sm  *skill.Manager

	// 文件浏览器「独立窗口」登记表：Shift+X 隐藏/显示主窗口时需要一并处理。
	// 这些窗口由 OpenFileBrowserWindow 创建，不在主窗口的父子关系里，
	// 所以主窗口 Hide/Show 不会自动带上它们。
	fileBrowserMu   sync.Mutex
	fileBrowserWins map[*application.WebviewWindow]struct{}
}

// NewApp 创建新的 App 实例。
func NewApp() *App {
	return &App{
		sm: skill.NewManager(),
	}
}

// setApplication 注入 v3 应用引用（在 application.New 之后、app.Run 之前由 main 调用）。
// 同时把桌面事件发射器注入 service 层，供 SSE 事件转发使用。
func (a *App) setApplication(app *application.App) {
	a.app = app
	opencode.SetDesktopEmitter(&eventEmitter{app: app})
}

// eventEmitter 把 v3 的 Event.Emit 适配为 service 层的 DesktopEmitter 接口。
type eventEmitter struct {
	app *application.App
}

// Emit 实现 opencode.DesktopEmitter：向桌面端（WebView）转发事件。
func (e *eventEmitter) Emit(name string, data ...any) {
	e.app.Event.Emit(name, data...)
}

// ServiceStartup 在应用启动时调用（v3 Service 生命周期，替代 v2 的 OnStartup）。
func (a *App) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	a.ctx = ctx
	return nil
}

// emitAppReady 在窗口运行时（页面 DOM）就绪后通知前端开始初始化。
// 由 main 包在窗口的 WindowRuntimeReady 事件中调用（替代 v2 的 OnDomReady）。
func (a *App) emitAppReady() {
	if a.app != nil {
		a.app.Event.Emit("app-ready")
	}
}

// ServiceShutdown 在应用关闭时调用（v3 Service 生命周期，替代 v2 的 OnShutdown），清理资源。
func (a *App) ServiceShutdown() error {
	// 结束所有内嵌终端，避免应用退出后留下无人观察的 shell 进程
	opencode.PtyCloseAll()
	a.StopOpenCodeEvents()
	a.StopOpenCodeWeb()
	a.StopFrontendWeb()
	return nil
}

// ========== 技能管理 ==========

// GetSkillConfig 返回技能管理页面需要的完整聚合数据（统一接口）。
// 技能列表复用 getAggregatedSkills，来源目录仍单独读取用于返回给前端。
func (a *App) GetSkillConfig() model.SkillConfigResult {
	dirs, _ := skill.ListSourceDirs()
	skills := a.getAggregatedSkills()

	return model.SkillConfigResult{
		SourceDirs: dirs,
		Skills:     skills,
		Stats: model.Stats{
			GlobalSkills: len(skills),
		},
	}
}

// getAggregatedSkills 返回所有技能的聚合列表（仅 App 内部使用）：
// 1. 从配置读取来源目录
// 2. 扫描所有来源目录
// 3. 扫描全局目录
// 4. 合并返回完整列表
// 当没有配置来源目录时，回退到原有的 GetAllSkills 扫描逻辑。
func (a *App) getAggregatedSkills() []model.SkillInfo {
	dirs, err := skill.ListSourceDirs()
	if err != nil || len(dirs) == 0 {
		return a.sm.GetAllSkills()
	}
	return a.sm.ScanWithGlobal(dirs)
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

// ========== 文件浏览器内嵌终端（PTY） ==========

// PtyCreate 在 rootDir 下创建一个终端（PowerShell/默认 shell）。
// 前端不能直连上游 WebSocket（浏览器无法携带 Authorization），因此由后端中转。
func (a *App) PtyCreate(rootDir, command, title string) (opencode.PtyInfo, error) {
	return opencode.PtyCreate(rootDir, command, title)
}

// PtyRead 取走终端自上次调用以来累积的输出（base64 块）。
func (a *App) PtyRead(id string) (opencode.PtyReadResult, error) {
	return opencode.PtyRead(id)
}

// PtyInput 把键盘输入写入终端。
func (a *App) PtyInput(id, data string) error {
	return opencode.PtyInput(id, data)
}

// PtyResize 同步终端行列数。
func (a *App) PtyResize(id string, rows, cols int) error {
	return opencode.PtyResize(id, rows, cols)
}

// PtyDelete 关闭终端并结束其进程（关闭标签即杀进程）。
func (a *App) PtyDelete(id string) error {
	return opencode.PtyDelete(id)
}

// PtyShells 返回当前平台可选的终端 shell（Windows 为 CMD / PowerShell）。
func (a *App) PtyShells() []opencode.PtyShell {
	return opencode.PtyShells()
}

// SearchBrowserFiles 在会话目录内做文件内容搜索（类 VSCode 全局搜索）。
func (a *App) SearchBrowserFiles(rootDir, path, query string, caseSensitive, useRegex, wholeWord bool) (model.FileBrowserSearchResult, error) {
	return filebrowser.SearchBrowserFiles(rootDir, path, query, caseSensitive, useRegex, wholeWord)
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

// CreateBrowserFile 在文件浏览器指定目录下创建空文件。
func (a *App) CreateBrowserFile(rootDir, path, dirName string) (model.SaveResult, error) {
	return filebrowser.CreateBrowserFile(rootDir, path, dirName)
}

// RenameBrowserEntry 重命名文件浏览器中的文件或目录。
func (a *App) RenameBrowserEntry(rootDir, path, newName string) (model.SaveResult, error) {
	return filebrowser.RenameBrowserEntry(rootDir, path, newName)
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

// SyncGitTags 首次打开仓库的 Git 面板时同步一次远程标签。
// proxy 与推送/拉取使用同一份代理配置，保证联网行为一致。
// 每个仓库目录在进程内只同步一次；失败会允许下次重试。
// 只更新 refs/tags，不触碰远程分支和本地分支。
func (a *App) SyncGitTags(rootDir string, proxy model.ProxyConfig) bool {
	return filebrowser.SyncGitTagsOnce(rootDir, proxy)
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

// RevealInFileManager 在系统文件管理器中打开指定路径：
// 目录直接打开；文件则打开其所在目录并选中该文件。
// Linux 上「选中文件」依赖文件管理器的 FileManager1 接口，不支持时回退为打开父目录。
func (a *App) RevealInFileManager(path string, isDir bool) error {
	return reveal.Open(path, isDir)
}

// OpenURL 用系统默认浏览器打开指定 URL（外部链接统一走这里，避免 WebView 导航离开工作台）。
func (a *App) OpenURL(url string) {
	if a.app != nil {
		_ = a.app.Browser.OpenURL(url)
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

// SaveSkillScheme 保存当前已启用的技能为方案。
// 从聚合列表中筛选出 Linked=true 的技能，保存其名称列表。
func (a *App) SaveSkillScheme(name string) model.SaveResult {
	// 获取当前聚合技能列表
	skills := a.getAggregatedSkills()
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
	available := a.getAggregatedSkills()
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

// ========== OMO Slim 配置（oh-my-opencode-slim.jsonc） ==========

// GetSlimConfig 读取 oh-my-opencode-slim 配置并转为前端结构。
// projectDir 非空时额外检测项目级配置（用于"编辑可能不生效"的覆盖提示）。
func (a *App) GetSlimConfig(projectDir string) (*omo.SlimConfigResult, error) {
	return omo.LoadSlimConfig(projectDir)
}

// SaveSlimConfig 保存前端编辑结果到 oh-my-opencode-slim 配置文件。
func (a *App) SaveSlimConfig(payload omo.SlimSavePayload) model.SaveResult {
	if err := omo.SaveSlimConfig(payload); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// GetProviderConfigPath 返回供应商配置文件路径。
func (a *App) GetProviderConfigPath() string {
	return provider.OpenCodeConfigPath()
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

// ========== MCP 连接器配置 ==========

// GetMcpConfig 获取 MCP 连接器列表、全局超时和配置文件路径。
func (a *App) GetMcpConfig() model.McpConfigInfo {
	return mcp.GetMcpConfig()
}

// SaveMcpServer 新增或更新单条 MCP 连接器。
func (a *App) SaveMcpServer(p model.McpServerSave) model.SaveResult {
	return mcp.SaveMcpServer(p)
}

// DeleteMcpServer 删除单条 MCP 连接器。
func (a *App) DeleteMcpServer(name string) model.SaveResult {
	return mcp.DeleteMcpServer(name)
}

// SaveMcpTimeouts 保存 MCP 全局默认超时。
func (a *App) SaveMcpTimeouts(t model.McpTimeout) model.SaveResult {
	return mcp.SaveMcpTimeouts(t)
}

// ========== Web 服务（委托到 service 包）==========

// StartOpenCodeWeb 启动（或连接）OpenCode v2 共享后台服务。
func (a *App) StartOpenCodeWeb(port int, hostname string, password string, proxy model.ProxyConfig) model.WebResult {
	return opencode.StartOpenCodeWeb(port, hostname, password, proxy)
}

// StopOpenCodeWeb 停止 opencode web 服务。
func (a *App) StopOpenCodeWeb() model.WebResult {
	return opencode.StopOpenCodeWeb()
}

// GetWebStatus 返回当前 web 服务状态。
func (a *App) GetWebStatus(hostname string, port int) model.WebResult {
	return opencode.GetWebStatus(hostname, port)
}

// SetServerPassword 设置外部 opencode 服务的访问口令。
// OpenCode v2 起 serve 默认开启 Basic 认证；当连接的不是本进程拉起的服务
// （如用户自行启动的 opencode）时，其口令无法自动获得，需由用户从
// 启动日志里复制过来填入。
func (a *App) SetServerPassword(password string) {
	opencode.SetServerPassword(password)
}

// OpenCodeAPI 代理访问本机 opencode serve API。
func (a *App) OpenCodeAPI(method, path, body string) model.APIResult {
	return opencode.OpenCodeAPI(method, path, body)
}

// AnswerQuestion 回答 question 工具调用（answers 为按问题顺序的二维数组）。
func (a *App) AnswerQuestion(sessionID string, answers [][]string) model.APIResult {
	return opencode.AnswerQuestion(sessionID, answers)
}

// GetProjectTree 获取项目→目录→会话的树形结构 JSON。
func (a *App) GetProjectTree(knownDirs string) string {
	return opencode.GetProjectTree(knownDirs)
}

// StartOpenCodeEvents 连接 opencode 全局 SSE。
func (a *App) StartOpenCodeEvents() model.APIResult {
	return opencode.StartOpenCodeEvents()
}

// StopOpenCodeEvents 停止 SSE 转发。
func (a *App) StopOpenCodeEvents() model.APIResult {
	return opencode.StopOpenCodeEvents()
}

// LaunchWindowsTerminal 在外部终端中打开 opencode。
func (a *App) LaunchWindowsTerminal(mode, webURL, dir string) model.WebResult {
	return opencode.LaunchWindowsTerminal(mode, webURL, dir)
}

// OpenDirectoryDialog 打开目录选择对话框，返回所选目录路径（取消时返回空字符串）。
func (a *App) OpenDirectoryDialog() string {
	return a.OpenDirectoryDialogAt("")
}

// OpenDirectoryDialogAt 打开目录选择对话框，并以 initialDir 作为起始位置。
// initialDir 为空或无效时回退到可执行文件目录（与 OpenDirectoryDialog 原来的行为一致）。
// 单独开一个方法而不是改 OpenDirectoryDialog 的签名：后者还有多处调用，
// 改签名会让那些入口在 Wails 绑定时需要额外传参。
func (a *App) OpenDirectoryDialogAt(initialDir string) string {
	if a.app == nil {
		return ""
	}
	// 起始目录：优先用调用方给的路径；为空时退回可执行文件目录，再退回当前目录
	start := strings.TrimSpace(initialDir)
	if start == "" {
		start = portable.ExeDir()
	}
	if start == "" {
		start = "."
	}
	dir, err := a.app.Dialog.OpenFile().
		SetTitle("选择工作目录").
		SetDirectory(start).
		CanChooseDirectories(true).
		CanChooseFiles(false).
		PromptForSingleSelection()
	if err != nil {
		return ""
	}
	return dir
}

// OpenFileBrowserWindow 打开独立的文件浏览器窗口（桌面端 Wails 多窗口）。
// 窗口加载同一份前端资源，通过 URL 参数（?view=filebrowser&root=...&git=1）进入独立窗口模式：
// 前端启动时检测到该参数即自动全屏打开文件浏览器。浏览器（Web）端由前端直接 window.open 新标签页实现。
func (a *App) OpenFileBrowserWindow(rootDir string, withGit bool) {
	logger.Printf("[popout] OpenFileBrowserWindow 被调用: root=%q git=%v appNil=%v", rootDir, withGit, a.app == nil)
	if a.app == nil || strings.TrimSpace(rootDir) == "" {
		logger.Printf("[popout] 参数无效（app 为空或 rootDir 为空），跳过创建")
		return
	}
	url := "/?view=filebrowser&root=" + url.QueryEscape(rootDir)
	if withGit {
		url += "&git=1"
	}
	// 初始尺寸用保守值：窗口创建前拿不到可靠的屏幕信息，若直接按大尺寸创建，
	// 在 1366×768 这类小屏上会超出屏幕。真正的自适应在 WindowRuntimeReady 之后进行。
	win := a.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "文件浏览 - " + rootDir,
		Width:     900,
		Height:    600,
		MinWidth:  720,
		MinHeight: 480,
		URL:       url,
	})
	// 页面就绪后按「该窗口所在屏幕」的工作区调整尺寸并居中，避免小屏超出、大屏过小。
	// 文件浏览器比主窗口需要更宽的内容区（文件树 + 预览），因此采用更高的宽高占比。
	win.OnWindowEvent(events.Common.WindowRuntimeReady, func(event *application.WindowEvent) {
		adaptWindowToScreen(win, 0.85, 0.88, 720, 480, 1800, 1100)
	})
	// 登记到独立窗口表：Shift+X 隐藏/显示主窗口时，这些窗口需要一起处理。
	a.trackFileBrowserWindow(win)
	logger.Printf("[popout] 窗口已创建: id=%d url=%s", win.ID(), url)
}

// trackFileBrowserWindow 登记文件浏览器独立窗口，并在窗口关闭时移除。
// 窗口由 a.app.Window.NewWithOptions 创建，与主窗口没有父子关系，
// 因此必须自行维护列表，Shift+X 才能同步隐藏/恢复。
func (a *App) trackFileBrowserWindow(win *application.WebviewWindow) {
	if win == nil {
		return
	}
	a.fileBrowserMu.Lock()
	if a.fileBrowserWins == nil {
		a.fileBrowserWins = make(map[*application.WebviewWindow]struct{})
	}
	a.fileBrowserWins[win] = struct{}{}
	a.fileBrowserMu.Unlock()

	win.OnWindowEvent(events.Common.WindowClosing, func(event *application.WindowEvent) {
		a.fileBrowserMu.Lock()
		delete(a.fileBrowserWins, win)
		a.fileBrowserMu.Unlock()
	})
}

// HideFileBrowserWindows 隐藏所有已登记的文件浏览器独立窗口。
// 由全局快捷键 Shift+X 在隐藏主窗口时调用。
func (a *App) HideFileBrowserWindows() {
	a.fileBrowserMu.Lock()
	wins := make([]*application.WebviewWindow, 0, len(a.fileBrowserWins))
	for win := range a.fileBrowserWins {
		wins = append(wins, win)
	}
	a.fileBrowserMu.Unlock()
	for _, win := range wins {
		// IsVisible 对已销毁窗口返回 false，顺带挡掉「刚关闭、登记还没来得及移除」的窗口：
		// WebviewWindow.Hide 内部没有销毁检查，对已销毁窗口调用会出问题。
		if win.IsVisible() {
			win.Hide()
		}
	}
}

// ShowFileBrowserWindows 恢复所有已登记的文件浏览器独立窗口。
// 由全局快捷键 Shift+X 在显示主窗口时调用。
func (a *App) ShowFileBrowserWindows() {
	a.fileBrowserMu.Lock()
	wins := make([]*application.WebviewWindow, 0, len(a.fileBrowserWins))
	for win := range a.fileBrowserWins {
		wins = append(wins, win)
	}
	a.fileBrowserMu.Unlock()
	for _, win := range wins {
		win.Show()
	}
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

// GetLanIPv4 返回本机局域网 IPv4 地址（Web服务默认监听地址与二维码使用）。
func (a *App) GetLanIPv4() string {
	return web.GetLanIPv4()
}

// GetCommands 返回所有常用命令分组数据。
func (a *App) GetCommands() []model.CmdGroup {
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

// CheckOpenCodeVersion 检测 opencode 最新版本（v2 渠道：npm @opencode/cli）。
// 实现位于 service/opencode/updater.go 的 CheckLatestVersion：固定直连、无 proxy 参数。
func (a *App) CheckOpenCodeVersion(currentVersion string) model.VersionCheckResult {
	return opencode.CheckLatestVersion(currentVersion)
}

// ========== OpenCode 自动更新 ==========

// StartOpenCodeUpdate 启动后台下载（不阻塞界面）；进度经 GetOpenCodeUpdateStatus 轮询。
func (a *App) StartOpenCodeUpdate(version string, proxy model.ProxyConfig) model.UpdateStatus {
	return opencode.StartUpdate(version, proxy)
}

// GetOpenCodeUpdateStatus 查询更新任务状态（含跨启动恢复的「就绪待更新」）。
func (a *App) GetOpenCodeUpdateStatus() model.UpdateStatus {
	return opencode.GetUpdateStatus()
}

// CancelOpenCodeUpdate 取消后台下载（保留已下载部分，重试可续传）。
func (a *App) CancelOpenCodeUpdate() model.UpdateStatus {
	return opencode.CancelUpdate()
}

// ApplyOpenCodeUpdate 完成更新：停服 → 替换 → 校验 → 重启；失败自动回滚。
func (a *App) ApplyOpenCodeUpdate(hostname string, port int, password string, proxy model.ProxyConfig) model.UpdateStatus {
	return opencode.ApplyUpdate(hostname, port, password, proxy)
}

// ========== 知识库 ==========

// knowledgeStore 返回默认知识库存储实例。
func (a *App) knowledgeStore() (*knowledge.Store, error) {
	return knowledge.Default()
}

// KnowledgeList 返回知识库条目元数据列表（不含正文）。
func (a *App) KnowledgeList() ([]model.KnowledgeEntry, error) {
	store, err := a.knowledgeStore()
	if err != nil {
		return nil, err
	}
	return store.List()
}

// KnowledgeGet 返回单个知识库条目（含正文）。
func (a *App) KnowledgeGet(id string) (*model.KnowledgeEntry, error) {
	store, err := a.knowledgeStore()
	if err != nil {
		return nil, err
	}
	return store.Get(id)
}

// KnowledgeSave 新建或更新知识库条目，返回最终条目 ID。
func (a *App) KnowledgeSave(entry model.KnowledgeEntry) (string, error) {
	store, err := a.knowledgeStore()
	if err != nil {
		return "", err
	}
	return store.Save(entry)
}

// KnowledgeDelete 删除知识库条目。
func (a *App) KnowledgeDelete(id string) error {
	store, err := a.knowledgeStore()
	if err != nil {
		return err
	}
	return store.Delete(id)
}

// KnowledgeCategories 返回完整知识库分类树。
func (a *App) KnowledgeCategories() ([]model.KnowledgeCategory, error) {
	store, err := a.knowledgeStore()
	if err != nil {
		return nil, err
	}
	return store.LoadCategories()
}

// KnowledgeSaveCategories 整树覆盖写入知识库分类。
func (a *App) KnowledgeSaveCategories(cats []model.KnowledgeCategory) error {
	store, err := a.knowledgeStore()
	if err != nil {
		return err
	}
	return store.SaveCategories(cats)
}

// knowledgeConverter 返回默认知识库转化器。
func (a *App) knowledgeConverter() (*knowledge.Converter, error) {
	store, err := a.knowledgeStore()
	if err != nil {
		return nil, err
	}
	return knowledge.NewConverter(store)
}

// KnowledgeConvertPreview 预览知识库条目转化为 OpenCode 资产的结果（不产生任何写入）。
func (a *App) KnowledgeConvertPreview(req model.ConvertRequest) (*model.ConvertPreview, error) {
	converter, err := a.knowledgeConverter()
	if err != nil {
		return nil, err
	}
	preview, err := converter.Preview(req)
	if err != nil {
		return nil, err
	}
	return &preview, nil
}

// KnowledgeConvert 执行知识库条目转化，返回写入目标的完整路径。
func (a *App) KnowledgeConvert(req model.ConvertRequest) (string, error) {
	converter, err := a.knowledgeConverter()
	if err != nil {
		return "", err
	}
	return converter.Convert(req)
}

// MoveSession 把会话移动到另一个项目目录。
// delivery 取值 "steer"（插队）或 "queue"（排队），空串表示服务端默认。
func (a *App) MoveSession(sessionID, directory, delivery string) model.APIResult {
	return opencode.MoveSession(sessionID, directory, delivery)
}

// MarkSessionViewed 标记该会话的 idle 转换已被客户端观察到。
// idle 必须是会话 time.idle 的原值。
func (a *App) MarkSessionViewed(sessionID string, idle int64) model.APIResult {
	return opencode.MarkSessionViewed(sessionID, idle)
}

// ── 导入导出 ─────────────────────────────────────────────────────────────

// ExportSession 导出会话为 JSON 字符串。
func (a *App) ExportSession(sessionID string, sanitize bool) string {
	return opencode.ExportSession(sessionID, sanitize)
}

// ImportSession 从导出的 JSON 导入会话。
func (a *App) ImportSession(exportJSON string) model.APIResult {
	return opencode.ImportSession(exportJSON)
}


// appVersion 是 OC Manager 客户端自身的版本号（与右侧服务面板展示的 opencode 服务端版本区分）。
// 单一来源：前端通过 GetAppVersion 读取；build/config.yml 的 info.version 保持同步。
const appVersion = "2.0.5"

// GetAppVersion 返回 OC Manager 客户端版本号（右侧服务面板"客户端"行显示）。
func (a *App) GetAppVersion() string {
	return appVersion
}
