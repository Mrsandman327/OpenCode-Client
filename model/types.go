// Package model 定义所有跨包共享的数据类型。
package model

// ========== 技能管理相关 ==========

// SkillInfo 技能信息。
type SkillInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Path        string `json:"path"`
	Linked      bool   `json:"linked"`
	Source      string `json:"source"` // "global" 或 "project"
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
