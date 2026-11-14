// Package model 定义所有跨包共享的数据类型。
package model

import (
	"encoding/json"
	"strings"
)

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
	SourceDirs []string    `json:"sourceDirs"`
	Skills     []SkillInfo `json:"skills"`
	Stats      Stats       `json:"stats"`
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

// DirectoryEntry 目录浏览器中的目录项。
type DirectoryEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// ========== 供应商配置相关 ==========

// OpenCodeConfig 是 opencode.json(c) 的顶层结构，采用 OpenCode v2 原生格式。
// 供应商写在 providers（v2 复数键）；读取时兼容 v1 的 provider 单数键。
type OpenCodeConfig struct {
	Schema    string                    `json:"$schema,omitempty"`
	Plugin    []string                  `json:"plugin,omitempty"`
	Providers map[string]*ProviderEntry `json:"providers,omitempty"`
	// Mcp 是 v2 的顶层 mcp 段（mcp.servers / mcp.timeout）。
	// 未建模的 mcp 子键（如 v1 的 mcp.<name> 条目）保留在 McpConfig.Extra 中。
	Mcp *McpConfig `json:"mcp,omitempty"`
	// EnabledProviders / DisabledProviders 仅用于读取兼容旧的 provider 过滤写法：
	// 写入时一律不再输出，启用状态改由顶层 policies 的 provider.use 表达。
	EnabledProviders  []string `json:"enabled_providers,omitempty"`
	DisabledProviders []string `json:"disabled_providers,omitempty"`
	// 注意：v1 的 server 在 v2 属于「accepted but unsupported」（被忽略并告警），
	// 因此不再显式建模，交由 Extra 原样透传（读保留、写输出，不丢用户配置）。
	// Extra 保留未建模的顶层键（如 experimental、permission、agents 等用户配置），
	// 避免结构化重建时丢失；json 序列化由自定义 MarshalJSON/UnmarshalJSON 处理。
	Extra map[string]json.RawMessage `json:"-"`
}

// UnmarshalJSON 自定义反序列化：分离已知字段，未知顶层键原样保留到 Extra。
func (c *OpenCodeConfig) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if v, ok := raw["$schema"]; ok {
		if err := json.Unmarshal(v, &c.Schema); err != nil {
			return err
		}
		delete(raw, "$schema")
	}
	if v, ok := raw["plugin"]; ok {
		if err := json.Unmarshal(v, &c.Plugin); err != nil {
			return err
		}
		delete(raw, "plugin")
	}
	// providers（v2 原生）优先；缺失或为空时回退读取 v1 的 provider 单数键。
	if v, ok := raw["providers"]; ok {
		if err := json.Unmarshal(v, &c.Providers); err != nil {
			return err
		}
		delete(raw, "providers")
	}
	if v, ok := raw["provider"]; ok {
		if len(c.Providers) == 0 {
			if err := json.Unmarshal(v, &c.Providers); err != nil {
				return err
			}
		}
		// 无论是否回退，都清理旧键：保存时不再写回 v1 结构。
		delete(raw, "provider")
	}
	if v, ok := raw["enabled_providers"]; ok {
		if err := json.Unmarshal(v, &c.EnabledProviders); err != nil {
			return err
		}
		delete(raw, "enabled_providers")
	}
	if v, ok := raw["disabled_providers"]; ok {
		if err := json.Unmarshal(v, &c.DisabledProviders); err != nil {
			return err
		}
		delete(raw, "disabled_providers")
	}
	// mcp 段：servers/timeout 建模，mcp 下的其它键（如 v1 旧格式条目）进 McpConfig.Extra。
	if v, ok := raw["mcp"]; ok {
		if err := json.Unmarshal(v, &c.Mcp); err != nil {
			return err
		}
		delete(raw, "mcp")
	}
	// 未列出的顶层键（含 v2 已不支持的 server）原样保留到 Extra。
	c.Extra = raw
	return nil
}

// MarshalJSON 自定义序列化：已知字段与保留的未知顶层键（Extra）合并输出。
func (c OpenCodeConfig) MarshalJSON() ([]byte, error) {
	out := make(map[string]json.RawMessage, len(c.Extra)+5)
	for k, v := range c.Extra {
		out[k] = v
	}
	if c.Schema != "" {
		b, err := json.Marshal(c.Schema)
		if err != nil {
			return nil, err
		}
		out["$schema"] = b
	}
	if c.Plugin != nil {
		b, err := json.Marshal(c.Plugin)
		if err != nil {
			return nil, err
		}
		out["plugin"] = b
	}
	// 只写 v2 的 providers；enabled_providers / disabled_providers 不再输出，
	// 启用状态由 config/provider 重写为顶层 policies 的 provider.use。
	if c.Providers != nil {
		b, err := json.Marshal(c.Providers)
		if err != nil {
			return nil, err
		}
		out["providers"] = b
	}
	if c.Mcp != nil {
		b, err := json.Marshal(c.Mcp)
		if err != nil {
			return nil, err
		}
		// 空的 mcp 对象没有语义，省略以免写回 "mcp": {}。
		if string(b) != "{}" {
			out["mcp"] = b
		}
	}
	return json.Marshal(out)
}

// ProviderEntry 单个供应商配置（OpenCode v2 的 providers.<id>）。
// 未建模的供应商级字段（env / canonical / headers / body 等）由 Extra 原样透传。
type ProviderEntry struct {
	Name     string                     `json:"name,omitempty"`
	Package  string                     `json:"package,omitempty"`
	Settings map[string]interface{}     `json:"settings,omitempty"`
	Models   map[string]*ModelDef       `json:"models,omitempty"`
	Extra    map[string]json.RawMessage `json:"-"`
}

// UnmarshalJSON 自定义反序列化：分离已知字段，未知键原样保留到 Extra。
func (e *ProviderEntry) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if v, ok := raw["name"]; ok {
		if err := json.Unmarshal(v, &e.Name); err != nil {
			return err
		}
		delete(raw, "name")
	}
	if v, ok := raw["package"]; ok {
		if err := json.Unmarshal(v, &e.Package); err != nil {
			return err
		}
		delete(raw, "package")
	}
	if v, ok := raw["settings"]; ok {
		if err := json.Unmarshal(v, &e.Settings); err != nil {
			return err
		}
		delete(raw, "settings")
	}
	if v, ok := raw["models"]; ok {
		if err := json.Unmarshal(v, &e.Models); err != nil {
			return err
		}
		delete(raw, "models")
	}
	e.Extra = raw
	return nil
}

// MarshalJSON 自定义序列化：已知字段与保留的未建模键（Extra）合并输出。
func (e ProviderEntry) MarshalJSON() ([]byte, error) {
	out := make(map[string]json.RawMessage, len(e.Extra)+4)
	for k, v := range e.Extra {
		out[k] = v
	}
	if e.Name != "" {
		b, err := json.Marshal(e.Name)
		if err != nil {
			return nil, err
		}
		out["name"] = b
	}
	if e.Package != "" {
		b, err := json.Marshal(e.Package)
		if err != nil {
			return nil, err
		}
		out["package"] = b
	}
	if e.Settings != nil {
		b, err := json.Marshal(e.Settings)
		if err != nil {
			return nil, err
		}
		out["settings"] = b
	}
	if e.Models != nil {
		b, err := json.Marshal(e.Models)
		if err != nil {
			return nil, err
		}
		out["models"] = b
	}
	return json.Marshal(out)
}

// Capabilities 模型能力（对应 OpenCode v2 的 models.<id>.capabilities）。
// 取代 v1 的 modalities 与 tool_call。
type Capabilities struct {
	Tools     *bool                `json:"tools,omitempty"`
	Input     []string             `json:"input,omitempty"`
	Output    []string             `json:"output,omitempty"`
	Reasoning *ReasoningCapability `json:"reasoning,omitempty"`
}

// ReasoningCapability 模型的思考强度声明（OpenCode v2 的 capabilities.reasoning）。
// 字段语义见 https://opencode.ai/v2/docs/models 的 Variants 一节：
//   - Supported：是否具备推理能力；false 或 true 但无控制项时不生成 variant
//   - Toggle：是否额外生成关闭推理的 none 档位
//   - Effort：可选的思考强度档位；OpenCode 会按模型 package 生成对应 variants
//   - Budget：可选的 token 预算（Effort 存在时忽略），原样透传
type ReasoningCapability struct {
	Supported *bool           `json:"supported,omitempty"`
	Toggle    *bool           `json:"toggle,omitempty"`
	Effort    []string        `json:"effort,omitempty"`
	Budget    json.RawMessage `json:"budget,omitempty"`
}

// ModelLimit 模型上下文/输出上限（OpenCode v2 的 models.<id>.limit）。
// 未设置时不写，交给 models.dev 目录或 OpenCode 默认值兜底。
type ModelLimit struct {
	Context *int `json:"context,omitempty"`
	Input   *int `json:"input,omitempty"`
	Output  *int `json:"output,omitempty"`
}

// ModelDef 模型定义（OpenCode v2 的 models.<id>）。
// 未建模字段（cost / variants / disabled 等）由 Extra 原样透传。
type ModelDef struct {
	Name         string                     `json:"name,omitempty"`
	ModelID      string                     `json:"modelID,omitempty"`
	Capabilities *Capabilities              `json:"capabilities,omitempty"`
	Limit        *ModelLimit                `json:"limit,omitempty"`
	Extra        map[string]json.RawMessage `json:"-"`
}

// UnmarshalJSON 自定义反序列化：分离已知字段，未知键原样保留到 Extra。
func (m *ModelDef) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if v, ok := raw["name"]; ok {
		if err := json.Unmarshal(v, &m.Name); err != nil {
			return err
		}
		delete(raw, "name")
	}
	if v, ok := raw["modelID"]; ok {
		if err := json.Unmarshal(v, &m.ModelID); err != nil {
			return err
		}
		delete(raw, "modelID")
	}
	if v, ok := raw["capabilities"]; ok {
		if err := json.Unmarshal(v, &m.Capabilities); err != nil {
			return err
		}
		delete(raw, "capabilities")
	}
	if v, ok := raw["limit"]; ok {
		if err := json.Unmarshal(v, &m.Limit); err != nil {
			return err
		}
		delete(raw, "limit")
	}
	m.Extra = raw
	return nil
}

// MarshalJSON 自定义序列化：已知字段与保留的未建模键（Extra）合并输出。
func (m ModelDef) MarshalJSON() ([]byte, error) {
	out := make(map[string]json.RawMessage, len(m.Extra)+3)
	for k, v := range m.Extra {
		out[k] = v
	}
	if m.Name != "" {
		b, err := json.Marshal(m.Name)
		if err != nil {
			return nil, err
		}
		out["name"] = b
	}
	if m.ModelID != "" {
		b, err := json.Marshal(m.ModelID)
		if err != nil {
			return nil, err
		}
		out["modelID"] = b
	}
	if m.Capabilities != nil {
		b, err := json.Marshal(m.Capabilities)
		if err != nil {
			return nil, err
		}
		out["capabilities"] = b
	}
	if m.Limit != nil {
		b, err := json.Marshal(m.Limit)
		if err != nil {
			return nil, err
		}
		out["limit"] = b
	}
	return json.Marshal(out)
}

// ProviderInfo 前端展示用供应商信息。
type ProviderInfo struct {
	Key     string      `json:"key"`
	Name    string      `json:"name"`
	BaseURL string      `json:"baseURL"`
	ApiKey  string      `json:"apiKey"`
	Package string      `json:"package"`
	Enabled bool        `json:"enabled"`
	Models  []ModelInfo `json:"models"`
}

// ModelInfo 前端展示用模型信息。
type ModelInfo struct {
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	ModelID      string        `json:"modelID,omitempty"`
	Capabilities *Capabilities `json:"capabilities,omitempty"`
	Limit        *ModelLimit   `json:"limit,omitempty"`
}

// ProviderSave 前端提交的供应商保存数据。
type ProviderSave struct {
	Key     string      `json:"key"`
	Name    string      `json:"name"`
	BaseURL string      `json:"baseURL"`
	ApiKey  string      `json:"apiKey"`
	Package string      `json:"package"`
	Enabled bool        `json:"enabled"`
	Models  []ModelInfo `json:"models"`
}

// ========== MCP 连接器配置相关 ==========

// McpConfig 是 opencode.json(c) 顶层 mcp 段（v2）。
// Extra 保留 mcp 下未建模的键（如 v1 旧格式 mcp.<name> 条目），写回时原样输出。
type McpConfig struct {
	Servers map[string]*McpServer      `json:"servers,omitempty"`
	Timeout *McpTimeout                `json:"timeout,omitempty"`
	Extra   map[string]json.RawMessage `json:"-"`
}

// UnmarshalJSON 自定义反序列化：分离 servers / timeout，其余键原样保留到 Extra。
func (c *McpConfig) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if v, ok := raw["servers"]; ok {
		if err := json.Unmarshal(v, &c.Servers); err != nil {
			return err
		}
		delete(raw, "servers")
	}
	if v, ok := raw["timeout"]; ok {
		if err := json.Unmarshal(v, &c.Timeout); err != nil {
			return err
		}
		delete(raw, "timeout")
	}
	c.Extra = raw
	return nil
}

// MarshalJSON 自定义序列化：先铺未建模键（Extra），再用已知字段覆盖同名键。
func (c McpConfig) MarshalJSON() ([]byte, error) {
	out := make(map[string]json.RawMessage, len(c.Extra)+2)
	for k, v := range c.Extra {
		out[k] = v
	}
	// 空 servers 对象没有语义，省略以免写回 "servers": {}。
	if len(c.Servers) > 0 {
		b, err := json.Marshal(c.Servers)
		if err != nil {
			return nil, err
		}
		out["servers"] = b
	}
	// 三项都为空的 timeout 对象没有语义（schema 要求每项为正整数），不输出空对象。
	if c.Timeout != nil && c.Timeout.Enabled() {
		b, err := json.Marshal(c.Timeout)
		if err != nil {
			return nil, err
		}
		out["timeout"] = b
	}
	return json.Marshal(out)
}

// McpServer 是 mcp.servers.<name> 的条目（v2）。
// Extra 保留未建模字段（未来版本新增字段、用户自定义字段），写回时原样输出。
type McpServer struct {
	Type        string                     `json:"type"`
	Command     []string                   `json:"command,omitempty"`
	Cwd         string                     `json:"cwd,omitempty"`
	Environment map[string]string          `json:"environment,omitempty"`
	URL         string                     `json:"url,omitempty"`
	Headers     map[string]string          `json:"headers,omitempty"`
	Disabled    bool                       `json:"disabled,omitempty"`
	Codemode    *bool                      `json:"codemode,omitempty"` // 必须指针：false 是有意义的值
	Pool        *bool                      `json:"pool,omitempty"`
	Protocol    string                     `json:"protocol,omitempty"`
	Timeout     *McpTimeout                `json:"timeout,omitempty"`
	OAuth       json.RawMessage            `json:"oauth,omitempty"` // false 或对象，原样承载
	Extra       map[string]json.RawMessage `json:"-"`
}

// UnmarshalJSON 自定义反序列化：分离已知字段，未知键原样保留到 Extra。
func (s *McpServer) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if v, ok := raw["type"]; ok {
		if err := json.Unmarshal(v, &s.Type); err != nil {
			return err
		}
		delete(raw, "type")
	}
	if v, ok := raw["command"]; ok {
		if err := json.Unmarshal(v, &s.Command); err != nil {
			return err
		}
		delete(raw, "command")
	}
	if v, ok := raw["cwd"]; ok {
		if err := json.Unmarshal(v, &s.Cwd); err != nil {
			return err
		}
		delete(raw, "cwd")
	}
	if v, ok := raw["environment"]; ok {
		if err := json.Unmarshal(v, &s.Environment); err != nil {
			return err
		}
		delete(raw, "environment")
	}
	if v, ok := raw["url"]; ok {
		if err := json.Unmarshal(v, &s.URL); err != nil {
			return err
		}
		delete(raw, "url")
	}
	if v, ok := raw["headers"]; ok {
		if err := json.Unmarshal(v, &s.Headers); err != nil {
			return err
		}
		delete(raw, "headers")
	}
	if v, ok := raw["disabled"]; ok {
		if err := json.Unmarshal(v, &s.Disabled); err != nil {
			return err
		}
		delete(raw, "disabled")
	}
	if v, ok := raw["codemode"]; ok {
		if err := json.Unmarshal(v, &s.Codemode); err != nil {
			return err
		}
		delete(raw, "codemode")
	}
	if v, ok := raw["pool"]; ok {
		if err := json.Unmarshal(v, &s.Pool); err != nil {
			return err
		}
		delete(raw, "pool")
	}
	if v, ok := raw["protocol"]; ok {
		if err := json.Unmarshal(v, &s.Protocol); err != nil {
			return err
		}
		delete(raw, "protocol")
	}
	if v, ok := raw["timeout"]; ok {
		if err := json.Unmarshal(v, &s.Timeout); err != nil {
			return err
		}
		delete(raw, "timeout")
	}
	if v, ok := raw["oauth"]; ok {
		// oauth 既可能是 false，也可能是对象；原样承载，不建模。
		s.OAuth = v
		delete(raw, "oauth")
	}
	s.Extra = raw
	return nil
}

// MarshalJSON 自定义序列化：先铺未建模键（Extra），再用已知字段覆盖同名键。
func (s McpServer) MarshalJSON() ([]byte, error) {
	out := make(map[string]json.RawMessage, len(s.Extra)+12)
	for k, v := range s.Extra {
		out[k] = v
	}
	put := func(key string, value any) error {
		b, err := json.Marshal(value)
		if err != nil {
			return err
		}
		out[key] = b
		return nil
	}
	if s.Type != "" {
		if err := put("type", s.Type); err != nil {
			return nil, err
		}
	}
	if len(s.Command) > 0 {
		if err := put("command", s.Command); err != nil {
			return nil, err
		}
	}
	if s.Cwd != "" {
		if err := put("cwd", s.Cwd); err != nil {
			return nil, err
		}
	}
	if len(s.Environment) > 0 {
		if err := put("environment", s.Environment); err != nil {
			return nil, err
		}
	}
	if s.URL != "" {
		if err := put("url", s.URL); err != nil {
			return nil, err
		}
	}
	if len(s.Headers) > 0 {
		if err := put("headers", s.Headers); err != nil {
			return nil, err
		}
	}
	if s.Disabled {
		if err := put("disabled", true); err != nil {
			return nil, err
		}
	}
	// codemode / pool 是指针：false 与「未设置」语义不同，必须原样写出。
	if s.Codemode != nil {
		if err := put("codemode", *s.Codemode); err != nil {
			return nil, err
		}
	}
	if s.Pool != nil {
		if err := put("pool", *s.Pool); err != nil {
			return nil, err
		}
	}
	if s.Protocol != "" {
		if err := put("protocol", s.Protocol); err != nil {
			return nil, err
		}
	}
	if s.Timeout != nil && s.Timeout.Enabled() {
		if err := put("timeout", s.Timeout); err != nil {
			return nil, err
		}
	}
	// oauth 原样输出（false 或对象），避免丢失用户手写的 OAuth 配置。
	if len(s.OAuth) > 0 {
		out["oauth"] = s.OAuth
	}
	return json.Marshal(out)
}

// McpTimeout 是超时对象。三项都用指针区分「未设置」和「0」，
// schema 约束是 exclusiveMinimum: 0，0 不是合法值。
type McpTimeout struct {
	Startup   *int `json:"startup,omitempty"`
	Catalog   *int `json:"catalog,omitempty"`
	Execution *int `json:"execution,omitempty"`
}

// Enabled 判断这个超时对象是否至少设置了一项。
func (t *McpTimeout) Enabled() bool {
	if t == nil {
		return false
	}
	return t.Startup != nil || t.Catalog != nil || t.Execution != nil
}

// McpServerInfo 是返回给前端展示的单条连接器信息。
type McpServerInfo struct {
	Name        string            `json:"name"`
	Type        string            `json:"type"`
	Command     []string          `json:"command,omitempty"`
	Cwd         string            `json:"cwd,omitempty"`
	Environment map[string]string `json:"environment,omitempty"`
	URL         string            `json:"url,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	Disabled    bool              `json:"disabled"`
	Codemode    *bool             `json:"codemode,omitempty"`
	Pool        *bool             `json:"pool,omitempty"`
	Protocol    string            `json:"protocol,omitempty"`
	Timeout     *McpTimeout       `json:"timeout,omitempty"`
	OAuth       json.RawMessage   `json:"oauth,omitempty"`
	// Extra 只用于前端提示「还有 N 个字段未展示」，保存时不回传。
	Extra map[string]json.RawMessage `json:"extra,omitempty"`
}

// McpConfigInfo 是 GetMcpConfig 的返回。
type McpConfigInfo struct {
	Path    string          `json:"path"`
	Servers []McpServerInfo `json:"servers"`
	Timeout *McpTimeout     `json:"timeout,omitempty"`
}

// McpServerSave 是前端保存单条连接器时的提交结构。
// 不包含 Extra：后端从原条目里保留未建模字段。
type McpServerSave struct {
	OldName     string            `json:"oldName"`
	Name        string            `json:"name"`
	Type        string            `json:"type"`
	Command     []string          `json:"command"`
	Cwd         string            `json:"cwd"`
	Environment map[string]string `json:"environment"`
	URL         string            `json:"url"`
	Headers     map[string]string `json:"headers"`
	Disabled    bool              `json:"disabled"`
	Codemode    *bool             `json:"codemode"`
	Pool        *bool             `json:"pool"`
	Protocol    string            `json:"protocol"`
	Timeout     *McpTimeout       `json:"timeout"`
	OAuth       json.RawMessage   `json:"oauth"`
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

// VersionCheckResult 版本检测结果。
type VersionCheckResult struct {
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion"`
	IsLatest       bool   `json:"isLatest"`
	Error          string `json:"error,omitempty"`
}

// OpenCode 更新任务阶段（与前端约定）。
const (
	UpdatePhaseIdle        = "idle"        // 无任务
	UpdatePhaseDownloading = "downloading" // 后台下载中
	UpdatePhasePreparing   = "preparing"   // 解压/准备中
	UpdatePhaseReady       = "ready"       // 已就绪，待完成更新
	UpdatePhaseApplying    = "applying"    // 正在停服/替换/重启
	UpdatePhaseDone        = "done"        // 更新完成
	UpdatePhaseFailed      = "failed"      // 失败（可重试）
)

// UpdateStatus 描述一次 OpenCode 自动更新任务的状态。
type UpdateStatus struct {
	Phase      string `json:"phase"`
	Version    string `json:"version"`              // 目标版本（不含 v 前缀）
	Downloaded int64  `json:"downloaded"`           // 已下载字节
	Total      int64  `json:"total"`                // 总字节（未知为 0）
	Error      string `json:"error,omitempty"`      // 失败原因
	RolledBack bool   `json:"rolledBack,omitempty"` // 应用失败且已自动回滚
}

// ProxyConfig 是启动 opencode serve 时注入的代理配置。
type ProxyConfig struct {
	ProxyEnabled bool   `json:"proxyEnabled"`
	ProxyHost    string `json:"proxyHost"`
	ProxyPort    string `json:"proxyPort"`
	// NoProxy 是追加到 NO_PROXY 的自定义排除项（逗号分隔），
	// 默认的 localhost,127.0.0.1 始终保留。
	NoProxy string `json:"noProxy"`
}

// ProxyURL 返回应用内代理配置对应的代理 URL。
// 未启用代理时返回空字符串；主机留空时回退到 127.0.0.1，端口留空时回退到 7897，
// 使 git、opencode 服务与更新下载三处共享同一套默认值。
func (p ProxyConfig) ProxyURL() string {
	if !p.ProxyEnabled {
		return ""
	}
	host := strings.TrimSpace(p.ProxyHost)
	if host == "" {
		host = "127.0.0.1"
	}
	port := strings.TrimSpace(p.ProxyPort)
	if port == "" {
		port = "7897"
	}
	return "http://" + host + ":" + port
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
	Editable    bool   `json:"editable"`
	DefaultMode string `json:"defaultMode"`
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

// ========== 文件内容搜索相关 ==========

// FileSearchLineMatch 表示搜索结果中的一行命中。
type FileSearchLineMatch struct {
	Line int    `json:"line"` // 行号（1 起）
	Text string `json:"text"` // 该行内容（超长已截断）
}

// FileSearchFileResult 表示一个文件内的全部命中。
type FileSearchFileResult struct {
	Path    string                `json:"path"`    // 绝对路径
	RelPath string                `json:"relPath"` // 相对搜索根目录（/ 开头）
	Matches []FileSearchLineMatch `json:"matches"`
}

// FileBrowserSearchResult 表示内容搜索接口返回。
type FileBrowserSearchResult struct {
	RootDir      string                 `json:"rootDir"`
	Query        string                 `json:"query"`
	Files        []FileSearchFileResult `json:"files"`
	FileCount    int                    `json:"fileCount"`    // 命中文件数
	MatchCount   int                    `json:"matchCount"`   // 总命中行数
	ScannedFiles int                    `json:"scannedFiles"` // 实际扫描文件数
	SkippedFiles int                    `json:"skippedFiles"` // 被排除规则跳过的文件数
	Truncated    bool                   `json:"truncated"`    // 是否因上限截断
	ElapsedMs    int64                  `json:"elapsedMs"`
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
	// LeftContent 左侧（HEAD 版本）全文，用于编辑器 diff 视图。
	LeftContent string `json:"leftContent"`
	// RightContent 右侧（工作区当前）全文，用于编辑器 diff 视图。
	RightContent string `json:"rightContent"`
	// FullBlocks 标明 StagedBlocks（已合并 HEAD↔工作区 diff）是否为全量行对：
	// true 时 blocks 覆盖整个文件，前端可据此重建左右逐行对齐的行对文档（占位补行）；
	// false 时 blocks 仅为片段（大文件回退 -U3），前端回退为独立双文档 + 比例同步滚动。
	FullBlocks bool `json:"fullBlocks"`
}

// GitHistoryItem 表示提交历史中的单条提交。
type GitHistoryItem struct {
	Hash      string `json:"hash"`
	ShortHash string `json:"shortHash"`
	Subject   string `json:"subject"`
	Author    string `json:"author"`
	Date      string `json:"date"`
	Synced    bool   `json:"synced"`
	// Tag 指向该提交的发布标签名（如 v1.9.0）；无标签时为空。
	// 同一提交有多个标签时只保留版本号最高的那个（与 GitHub Desktop 一致，每行只显示一个）。
	Tag string `json:"tag,omitempty"`
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
	// LeftContent 左侧（父提交）全文，用于编辑器 diff 视图。
	LeftContent string `json:"leftContent"`
	// RightContent 右侧（当前提交）全文，用于编辑器 diff 视图。
	RightContent string `json:"rightContent"`
	// FullBlocks 标明 Blocks 是否为全量行对（true=小文件全量 diff，
	// 前端可重建逐行对齐文档；false=大文件片段，前端回退双文档滚动同步）。
	FullBlocks bool `json:"fullBlocks"`
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
