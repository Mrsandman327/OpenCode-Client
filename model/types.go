// Package model 定义所有跨包共享的数据类型。
package model

import "fmt"

// ========== 技能管理相关 ==========

// AggregatedSourceInfo 聚合技能来源信息，记录单个技能在某来源目录中的位置。
type AggregatedSourceInfo struct {
	Path   string `json:"path"`
	Source string `json:"source"` // 来源目录路径或 "global"
}

// SkillInfo 技能信息。
type SkillInfo struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Path        string                 `json:"path"`
	Linked      bool                   `json:"linked"`
	Source      string                 `json:"source"`     // "global" 或来源目录路径
	Conflict    bool                   `json:"conflict"`   // 是否存在同名冲突
	NoSources   bool                   `json:"noSources"`  // 是否无来源目录模式
	Sources     []AggregatedSourceInfo `json:"sources"`    // 该技能的所有来源
	Enableable  bool                   `json:"enableable"` // 是否可启用（冲突或无来源时为false）
}

// SkillConfigResult 前端技能页面加载所需的完整数据。
type SkillConfigResult struct {
	SourceDirs []string   `json:"sourceDirs"`
	Skills     []SkillInfo `json:"skills"`
	Stats      Stats       `json:"stats"`
}

// RemoveSourceDirResult 删除来源目录时的返回结果，包含可能受影响的已启用技能。
type RemoveSourceDirResult struct {
	Success         bool     `json:"success"`
	Error           string   `json:"error,omitempty"`
	AffectedSkills  []string `json:"affectedSkills,omitempty"` // 该目录下已启用的技能名称
}

// Stats 统计信息。
type Stats struct {
	GlobalSkills int `json:"globalSkills"`
}

// String 实现 Stringer 接口，便于调试。
func (s Stats) String() string {
	return fmt.Sprintf("Skills: %d", s.GlobalSkills)
}

// ToggleResult 单个技能切换结果。
type ToggleResult struct {
	SkillName string  `json:"skillName"`
	Linked    bool    `json:"linked"`
	Success   bool    `json:"success"`
	Error     *string `json:"error,omitempty"`
}

// SkillContent 技能文件内容。
type SkillContent struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// SkillFileNode 技能目录浏览树节点。
type SkillFileNode struct {
	Name     string          `json:"name"`
	Path     string          `json:"path"`
	Type     string          `json:"type"`
	Children []SkillFileNode `json:"children,omitempty"`
}

// DirectoryEntry 目录浏览器中的目录项。
type DirectoryEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// ========== 模型配置相关 ==========

// OpenAgentConfig 表示 oh-my-openagent.jsonc 的顶层模型配置结构。
type OpenAgentConfig map[string]map[string]ModelConfig

// ModelConfig 单个 agent/category 的模型配置。
type ModelConfig struct {
	Model   string `json:"model"`
	Variant string `json:"variant"`
}

// ModelEntry 前端展示用的模型条目。
type ModelEntry struct {
	Key     string `json:"key"`
	Type    string `json:"type"`
	Model   string `json:"model"`
	Variant string `json:"variant"`
	Comment string `json:"comment"`
}

// ========== 供应商配置相关 ==========

// OpenCodeConfig opencode.jsonc 顶层结构。
type OpenCodeConfig struct {
	Schema           string                    `json:"$schema,omitempty"`
	Plugin           []string                  `json:"plugin,omitempty"`
	Provider         map[string]*ProviderEntry `json:"provider,omitempty"`
	EnabledProviders []string                  `json:"enabled_providers,omitempty"`
	Server           map[string]interface{}    `json:"server,omitempty"`
}

// ProviderEntry 单个供应商配置。
type ProviderEntry struct {
	Npm     string                 `json:"npm,omitempty"`
	Name    string                 `json:"name,omitempty"`
	Options map[string]interface{} `json:"options,omitempty"`
	Models  map[string]*ModelDef   `json:"models,omitempty"`
}

// ModelDef 模型定义。
type ModelDef struct {
	Name string `json:"name"`
}

// ProviderInfo 前端展示用供应商信息。
type ProviderInfo struct {
	Key     string      `json:"key"`
	Name    string      `json:"name"`
	BaseURL string      `json:"baseURL"`
	ApiKey  string      `json:"apiKey"`
	Npm     string      `json:"npm"`
	Enabled bool        `json:"enabled"`
	Models  []ModelInfo `json:"models"`
}

// ModelInfo 前端展示用模型信息。
type ModelInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ProviderSave 前端提交的供应商保存数据。
type ProviderSave struct {
	Key     string      `json:"key"`
	Name    string      `json:"name"`
	BaseURL string      `json:"baseURL"`
	ApiKey  string      `json:"apiKey"`
	Npm     string      `json:"npm"`
	Enabled bool        `json:"enabled"`
	Models  []ModelInfo `json:"models"`
}

// ========== Web 服务相关 ==========

// WebResult 前端展示用的 web 状态。
type WebResult struct {
	Running bool   `json:"running"`
	Success bool   `json:"success"`
	URL     string `json:"url"`
	Health  string `json:"health"`
	Version string `json:"version"`
	Error   string `json:"error,omitempty"`
}

// APIResult 是 opencode serve API 的透传结果。
type APIResult struct {
	Success bool   `json:"success"`
	Status  int    `json:"status"`
	Body    string `json:"body"`
	Error   string `json:"error,omitempty"`
}

// ProxyConfig 是启动 opencode serve 时注入的代理配置。
type ProxyConfig struct {
	ProxyEnabled bool   `json:"proxyEnabled"`
	ProxyHost    string `json:"proxyHost"`
	ProxyPort    string `json:"proxyPort"`
}

// SessionInfo 会话记录。
type SessionInfo struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// TreeNode 项目-目录-会话树节点。
type TreeNode struct {
	ID        string     `json:"id"`
	Title     string     `json:"title"`
	Type      string     `json:"type"`
	Children  []TreeNode `json:"children,omitempty"`
	UpdatedAt string     `json:"updatedAt,omitempty"`
	Directory string     `json:"directory,omitempty"`
}

// CmdPaletteItem 命令面板展示项。
type CmdPaletteItem struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Source      string `json:"source"`
}

// SaveResult 保存操作结果。
type SaveResult struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

// ========== 命令参考相关 ==========

// CmdInfo 命令展示信息。
type CmdInfo struct {
	Name    string `json:"name"`
	Sub     string `json:"sub"`
	Options string `json:"options"`
	Desc    string `json:"desc"`
}

// CmdGroup 命令分组。
type CmdGroup struct {
	Title string    `json:"title"`
	Cmds  []CmdInfo `json:"cmds"`
	IsTUI bool      `json:"isTui"`
}

// ========== 方案管理相关 ==========

// SchemeInfo 方案文件信息。
type SchemeInfo struct {
	Name     string `json:"name"`
	FileName string `json:"fileName"`
	FullPath string `json:"fullPath"`
}

// ========== 技能项目配置相关 ==========

// SkillConfig 技能源目录配置，对应 skill-sources.json 文件内容。
type SkillConfig struct {
	// SourceDirs 技能源目录列表，包含全局和项目级技能目录路径。
	SourceDirs []string `json:"sourceDirs"`
	// Version 配置模式版本号，用于未来的兼容性扩展。
	Version string `json:"version,omitempty"`
}

// SkillSchemeData 方案文件内容，即技能名称列表。
type SkillSchemeData []string

// SchemeApplyResult 方案应用结果。
type SchemeApplyResult struct {
	Applied   []string `json:"applied"`   // 成功应用的技能名称
	Missing   []string `json:"missing"`   // 方案中存在但聚合列表中找不到的技能
	Conflicts []string `json:"conflicts"` // 存在冲突无法启用的技能
	Errors    []string `json:"errors"`    // 链接创建失败的错误信息
	Success   bool     `json:"success"`   // 至少有一个技能被成功应用
}

// ========== 文件浏览器相关 ==========

// FileBrowserItem 表示文件浏览器中的单个条目。
type FileBrowserItem struct {
	Name       string `json:"name"`
	Path       string `json:"path"`       // 相对根目录的路径，以 / 开头；目录以 / 结尾
	Type       string `json:"type"`       // dir / file
	Ext        string `json:"ext"`        // 扩展名，如 .md
	Size       int64  `json:"size"`       // 文件大小，目录为 0
	ModifiedAt string `json:"modifiedAt"` // RFC3339 时间
	Mime       string `json:"mime"`       // mime 类型或 inode/directory
}

// FileBrowserListResult 表示列目录接口返回。
type FileBrowserListResult struct {
	RootDir     string            `json:"rootDir"`
	CurrentPath string            `json:"currentPath"`
	ParentPath  string            `json:"parentPath"`
	Items       []FileBrowserItem `json:"items"`
}

// FileBrowserStatResult 表示文件信息接口返回。
type FileBrowserStatResult struct {
	RootDir     string `json:"rootDir"`
	Name        string `json:"name"`
	Path        string `json:"path"`
	Type        string `json:"type"`
	Ext         string `json:"ext"`
	Size        int64  `json:"size"`
	ModifiedAt  string `json:"modifiedAt"`
	Mime        string `json:"mime"`
	PreviewKind string `json:"previewKind"`
	Previewable bool   `json:"previewable"`
}

// FileBrowserReadResult 表示文本文件读取接口返回。
type FileBrowserReadResult struct {
	RootDir   string `json:"rootDir"`
	Path      string `json:"path"`
	Content   string `json:"content"`
	Encoding  string `json:"encoding"`
	Truncated bool   `json:"truncated"`
}

// FileBrowserRawResult 表示原始文件内容（Base64）返回。
type FileBrowserRawResult struct {
	RootDir string `json:"rootDir"`
	Path    string `json:"path"`
	Name    string `json:"name"`
	Mime    string `json:"mime"`
	Base64  string `json:"base64"`
}

// FileBrowserUploadResult 表示文件浏览器上传结果。
type FileBrowserUploadResult struct {
	Success  bool   `json:"success"`
	Conflict bool   `json:"conflict"`
	Name     string `json:"name,omitempty"`
	Error    string `json:"error,omitempty"`
}

// ========== Git 变更查看相关 ==========

// GitChangedFile 表示 Git 变更列表中的单个文件。
type GitChangedFile struct {
	Path        string `json:"path"`
	Name        string `json:"name"`
	StatusCode  string `json:"statusCode"`
	Tracked     bool   `json:"tracked"`
	HasStaged   bool   `json:"hasStaged"`
	HasUnstaged bool   `json:"hasUnstaged"`
}

// GitStatusResult 表示 Git 状态接口返回。
type GitStatusResult struct {
	IsGitRepo bool             `json:"isGitRepo"`
	Files     []GitChangedFile `json:"files"`
	Message   string           `json:"message"`
}

// GitDiffLine 表示对比视图中的一行。
type GitDiffLine struct {
	Kind  string `json:"kind"` // context / add / del / empty
	OldNo int    `json:"oldNo"`
	NewNo int    `json:"newNo"`
	Text  string `json:"text"`
}

// GitDiffBlock 表示左右对比的一个 block。
type GitDiffBlock struct {
	Left  []GitDiffLine `json:"left"`
	Right []GitDiffLine `json:"right"`
}

// GitFilePreviewResult 表示单文件 Git 预览结果。
type GitFilePreviewResult struct {
	Path             string         `json:"path"`
	Tracked          bool           `json:"tracked"`
	HasStaged        bool           `json:"hasStaged"`
	HasUnstaged      bool           `json:"hasUnstaged"`
	StagedBlocks     []GitDiffBlock `json:"stagedBlocks"`
	UnstagedBlocks   []GitDiffBlock `json:"unstagedBlocks"`
	UntrackedContent string         `json:"untrackedContent"`
}

// GitHistoryItem 表示提交历史中的单条提交。
type GitHistoryItem struct {
	Hash      string `json:"hash"`
	ShortHash string `json:"shortHash"`
	Subject   string `json:"subject"`
	Author    string `json:"author"`
	Date      string `json:"date"`
	Synced    bool   `json:"synced"`
}

// GitHistoryResult 表示提交历史列表接口返回。
type GitHistoryResult struct {
	Items   []GitHistoryItem `json:"items"`
	HasMore bool             `json:"hasMore"`
	Offset  int              `json:"offset"`
	Limit   int              `json:"limit"`
}

// GitCommitChangedFile 表示某次提交中变更的文件。
type GitCommitChangedFile struct {
	Path        string `json:"path"`
	DisplayName string `json:"displayName"`
	Status      string `json:"status"`
	OldPath     string `json:"oldPath,omitempty"`
}

// GitCommitFilesResult 表示某次提交的文件列表接口返回。
type GitCommitFilesResult struct {
	CommitHash string                 `json:"commitHash"`
	Files      []GitCommitChangedFile `json:"files"`
}

// GitCommitFilePreviewResult 表示某次提交中单个文件的 diff 预览结果。
type GitCommitFilePreviewResult struct {
	CommitHash string         `json:"commitHash"`
	FilePath   string         `json:"filePath"`
	Blocks     []GitDiffBlock `json:"blocks"`
}

// GitActionResult 表示 Git 操作结果。
type GitActionResult struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

// ========== 项目配置管理 ==========

// ProjectConfigFileEntry 表示项目配置目录下的单个文件或目录条目。
type ProjectConfigFileEntry struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Type        string `json:"type"`
	Description string `json:"description,omitempty"`
}

// ProjectConfigTab 表示项目配置单个 tab 的状态。
type ProjectConfigTab struct {
	Exists  bool                     `json:"exists"`
	Message string                   `json:"message"`
	Files   []ProjectConfigFileEntry `json:"files"`
}

// ProjectConfigSummary 表示四个配置 tab 的聚合信息。
type ProjectConfigSummary struct {
	RootDir    string           `json:"rootDir"`
	CoreConfig ProjectConfigTab `json:"coreConfig"`
	Skills     ProjectConfigTab `json:"skills"`
	AgentsMd   ProjectConfigTab `json:"agentsMd"`
	Commands   ProjectConfigTab `json:"commands"`
	Rules      ProjectConfigTab `json:"rules"`
}

// ProjectConfigFileResult 表示项目配置文件的读写结果。
type ProjectConfigFileResult struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// GlobalConfigInfo 全局配置信息。
type GlobalConfigInfo struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// ImportableSkill 可导入技能信息。
type ImportableSkill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	SourceDir   string `json:"sourceDir"`
	SourcePath  string `json:"sourcePath"`
	Imported    bool   `json:"imported"`
	GlobalExist bool   `json:"globalExist"`
}
