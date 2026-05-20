// Package model 定义所有跨包共享的数据类型。
package model

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

// ModelSaveResult 模型保存结果。
type ModelSaveResult struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
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
