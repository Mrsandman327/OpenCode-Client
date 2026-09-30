package provider

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"oc-manager/internal/fileutil"
	"oc-manager/model"
)

var providerWriteMu sync.Mutex

// defaultProviderPackage 是 OpenCode v2 中 OpenAI 兼容运行时的默认包名。
// v1 的 @ai-sdk/* 包在 v2 中统一加 aisdk: 前缀。
const defaultProviderPackage = "aisdk:@ai-sdk/openai-compatible"

// resolvePath 优先返回 .jsonc 路径，若不存在则回退到 .json。
func resolvePath(jsoncPath string) string {
	if _, err := os.Stat(jsoncPath); err == nil {
		return jsoncPath
	}
	jsonPath := strings.TrimSuffix(jsoncPath, ".jsonc") + ".json"
	if _, err := os.Stat(jsonPath); err == nil {
		return jsonPath
	}
	return jsoncPath
}

// ========== 供应商配置 ==========

// OpenCodeConfigPath 返回 opencode.jsonc 的完整路径。
func OpenCodeConfigPath() string {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir != "" {
		return resolvePath(filepath.Join(dir, "opencode", "opencode.jsonc"))
	}
	home, _ := os.UserHomeDir()
	return resolvePath(filepath.Join(home, ".config", "opencode", "opencode.jsonc"))
}

func loadOpenCodeConfig() (*model.OpenCodeConfig, error) {
	path := OpenCodeConfigPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取配置失败: %w", err)
	}

	var cfg model.OpenCodeConfig
	// opencode.jsonc 包含注释，需要先去除注释再解析
	if err := json.Unmarshal([]byte(fileutil.StripComments(string(data))), &cfg); err != nil {
		return nil, fmt.Errorf("解析配置失败: %w", err)
	}
	return &cfg, nil
}

func saveOpenCodeConfig(cfg *model.OpenCodeConfig) error {
	path := OpenCodeConfigPath()
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化失败: %w", err)
	}
	return fileutil.AtomicWrite(path, data, 0644)
}

// GetProviders 获取所有供应商信息。
// 读取时兼容 v2 的 providers 与 v1 的 provider 单数键；启用状态综合三源计算（见 isProviderEnabled）。
func GetProviders() []model.ProviderInfo {
	cfg, err := loadOpenCodeConfig()
	if err != nil || cfg.Providers == nil {
		return nil
	}

	result := make([]model.ProviderInfo, 0, len(cfg.Providers))
	for key, entry := range cfg.Providers {
		baseURL, apiKey := readConnection(entry)
		result = append(result, model.ProviderInfo{
			Key:     key,
			Name:    displayName(entry, key),
			BaseURL: baseURL,
			ApiKey:  apiKey,
			Package: readPackage(entry),
			Enabled: isProviderEnabled(key, cfg),
			Models:  readModels(entry),
		})
	}
	// cfg.Providers 是 map，遍历顺序随机；按键排序保证供应商卡片展示顺序稳定
	sort.Slice(result, func(i, j int) bool { return result[i].Key < result[j].Key })
	return result
}

// SaveProvider 保存单个供应商（新增或更新），并按 v2 规则重写启用策略。
func SaveProvider(ps model.ProviderSave) error {
	providerWriteMu.Lock()
	defer providerWriteMu.Unlock()

	cfg, err := loadOpenCodeConfig()
	if err != nil {
		return err
	}
	if cfg.Providers == nil {
		cfg.Providers = make(map[string]*model.ProviderEntry)
	}

	old := cfg.Providers[ps.Key]

	// 提交未带 package 时优先保留旧值，其次才套默认包（避免给未声明 package 的供应商强写默认）
	pkg := ps.Package
	if pkg == "" && old != nil {
		pkg = old.Package
	}
	if pkg == "" {
		pkg = defaultProviderPackage
	}

	// 组装 settings：保留旧 settings 的未建模键，并入 v1 options 迁移过来的键，再覆盖本次提交值。
	settings := map[string]interface{}{}
	if old != nil {
		for k, v := range old.Settings {
			settings[k] = v
		}
		if opts := rawToMap(old.Extra["options"]); opts != nil {
			for k, v := range opts {
				if _, exists := settings[k]; !exists {
					settings[k] = v
				}
			}
		}
		// v1 少数供应商把地址写在 api 字段；迁移为 settings.baseURL（若尚未提供）
		if _, exists := settings["baseURL"]; !exists {
			if api := rawToString(old.Extra["api"]); api != "" {
				settings["baseURL"] = api
			}
		}
	}
	// 连接信息仅在本次提交非空时覆盖；为空则保留旧值（避免误清空 env 型供应商或用户手改的配置）
	if ps.BaseURL != "" {
		settings["baseURL"] = ps.BaseURL
	}
	if ps.ApiKey != "" {
		settings["apiKey"] = ps.ApiKey
	}
	// 注意：不写 setCacheKey —— 它是 v1 的 options 字段，v2 的 Provider.Settings
	// schema 并不识别（源码仅见 packages/core/src/v1/config/provider.ts），写了没有语义。

	entry := &model.ProviderEntry{
		Name:     ps.Name,
		Package:  pkg,
		Settings: settings,
	}
	// 保留旧供应商的未建模字段（env / canonical / headers / body 等），剔除已迁移的 v1 键
	if old != nil {
		if extra := carryExtra(old.Extra, providerLegacyKeys); len(extra) > 0 {
			entry.Extra = extra
		}
	}
	// 组装模型：保留同 ID 旧模型的未建模字段（cost / limit / variants / disabled 等）
	if len(ps.Models) > 0 {
		entry.Models = make(map[string]*model.ModelDef, len(ps.Models))
		for _, m := range ps.Models {
			def := &model.ModelDef{Name: m.Name, ModelID: m.ModelID, Capabilities: normalizeCapabilities(m.Capabilities)}
			if old != nil {
				if oldDef := old.Models[m.ID]; oldDef != nil {
					// 保留真实 modelID：UI 只有单一「模型ID」输入，提交端可能把 modelID 写成 map key；
					// 若旧定义带有不同的真实 ID，则回填，避免覆盖。
					if prev := firstNonEmpty(oldDef.ModelID, rawToString(oldDef.Extra["id"])); prev != "" &&
						prev != m.ID && (def.ModelID == "" || def.ModelID == m.ID) {
						def.ModelID = prev
					}
					if extra := carryExtra(oldDef.Extra, modelLegacyKeys); len(extra) > 0 {
						def.Extra = extra
					}
				}
			}
			entry.Models[m.ID] = def
		}
	}

	cfg.Providers[ps.Key] = entry

	// 按 v2 规则重写启用策略（experimental.policies 的 provider.use）；
	// 本次保存的供应商以其提交的启用状态为准。
	if err := rewriteProviderPolicies(cfg, map[string]bool{ps.Key: ps.Enabled}); err != nil {
		return err
	}
	return saveOpenCodeConfig(cfg)
}

// DeleteProvider 删除供应商，并同步重写启用策略。
func DeleteProvider(key string) error {
	providerWriteMu.Lock()
	defer providerWriteMu.Unlock()

	cfg, err := loadOpenCodeConfig()
	if err != nil {
		return err
	}
	delete(cfg.Providers, key)
	if err := rewriteProviderPolicies(cfg, nil); err != nil {
		return err
	}
	return saveOpenCodeConfig(cfg)
}

// ========== 读取辅助 ==========

// readConnection 读取供应商的 baseURL 与 apiKey：v2 的 settings 优先，回退 v1 的 options。
func readConnection(entry *model.ProviderEntry) (baseURL, apiKey string) {
	if entry == nil {
		return "", ""
	}
	pick := func(m map[string]interface{}) {
		if m == nil {
			return
		}
		if baseURL == "" {
			if v, ok := m["baseURL"].(string); ok {
				baseURL = v
			}
		}
		if apiKey == "" {
			if v, ok := m["apiKey"].(string); ok {
				apiKey = v
			}
		}
	}
	pick(entry.Settings)
	if baseURL == "" || apiKey == "" {
		pick(rawToMap(entry.Extra["options"]))
	}
	return baseURL, apiKey
}

// readPackage 读取运行时包名：v2 的 package 优先，回退 v1 的 npm（补 aisdk: 前缀）。
func readPackage(entry *model.ProviderEntry) string {
	if entry == nil {
		return defaultProviderPackage
	}
	if entry.Package != "" {
		return entry.Package
	}
	if npm := rawToString(entry.Extra["npm"]); npm != "" {
		// v2 原生包名（@opencode/ai/providers/...）或已带前缀者原样返回
		if strings.HasPrefix(npm, "aisdk:") || strings.HasPrefix(npm, "@opencode/ai/providers/") {
			return npm
		}
		return "aisdk:" + npm
	}
	return defaultProviderPackage
}

// displayName 返回供应商展示名，空则回退到 key。
func displayName(entry *model.ProviderEntry, key string) string {
	if entry != nil && entry.Name != "" {
		return entry.Name
	}
	return key
}

// readModels 读取模型列表（按键排序），并兼容 v1 的字段写法。
func readModels(entry *model.ProviderEntry) []model.ModelInfo {
	if entry == nil || entry.Models == nil {
		return nil
	}
	keys := make([]string, 0, len(entry.Models))
	for id := range entry.Models {
		keys = append(keys, id)
	}
	sort.Strings(keys)

	out := make([]model.ModelInfo, 0, len(keys))
	for _, id := range keys {
		def := entry.Models[id]
		mi := model.ModelInfo{ID: id}
		if def != nil {
			mi.Name = def.Name
			mi.ModelID = def.ModelID
			if mi.ModelID == "" {
				// v1 模型把真实 ID 放在 id 字段
				mi.ModelID = rawToString(def.Extra["id"])
			}
			mi.Capabilities = def.Capabilities
			if mi.Capabilities == nil {
				mi.Capabilities = legacyCapabilities(def.Extra)
			}
		}
		out = append(out, mi)
	}
	return out
}

// legacyCapabilities 从 v1 模型的 modalities / tool_call 字段构造能力信息。
func legacyCapabilities(extra map[string]json.RawMessage) *model.Capabilities {
	if extra == nil {
		return nil
	}
	caps := &model.Capabilities{}
	found := false
	if raw, ok := extra["modalities"]; ok {
		var mod struct {
			Input  []string `json:"input"`
			Output []string `json:"output"`
		}
		if json.Unmarshal(raw, &mod) == nil {
			if mod.Input != nil {
				caps.Input = mod.Input
				found = true
			}
			if mod.Output != nil {
				caps.Output = mod.Output
				found = true
			}
		}
	}
	if raw, ok := extra["tool_call"]; ok {
		var b bool
		if json.Unmarshal(raw, &b) == nil {
			caps.Tools = &b
			found = true
		}
	}
	if !found {
		return nil
	}
	return caps
}

// ========== 启用状态：读三源兼容 ==========

// policyStatement 表示 experimental.policies 中的一条策略语句。
type policyStatement struct {
	Action   string `json:"action"`
	Resource string `json:"resource"`
	Effect   string `json:"effect"`
}

// experimentalMap 解析顶层 experimental 为键值映射；不存在或非法返回 nil。
func experimentalMap(cfg *model.OpenCodeConfig) map[string]json.RawMessage {
	if cfg == nil || cfg.Extra == nil {
		return nil
	}
	raw, ok := cfg.Extra["experimental"]
	if !ok {
		return nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	return m
}

// providerUseStatements 返回 experimental.policies 中所有 provider.use 语句（按出现顺序）。
func providerUseStatements(cfg *model.OpenCodeConfig) []policyStatement {
	exp := experimentalMap(cfg)
	if exp == nil {
		return nil
	}
	raw, ok := exp["policies"]
	if !ok {
		return nil
	}
	var list []json.RawMessage
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil
	}
	var out []policyStatement
	for _, item := range list {
		var st policyStatement
		if err := json.Unmarshal(item, &st); err != nil {
			continue
		}
		if st.Action == "provider.use" {
			out = append(out, st)
		}
	}
	return out
}

// isProviderEnabled 综合三种来源计算供应商是否启用（读兼容）：
//  1. enabled_providers：非空时视为 allowlist，仅列表内供应商可启用；
//  2. disabled_providers：命中即禁用，优先级高于 allowlist；
//  3. experimental.policies 的 provider.use：按数组顺序，最后匹配者胜出。
func isProviderEnabled(key string, cfg *model.OpenCodeConfig) bool {
	enabled := true
	if len(cfg.EnabledProviders) > 0 {
		enabled = containsFold(cfg.EnabledProviders, key)
	}
	if containsFold(cfg.DisabledProviders, key) {
		enabled = false
	}
	for _, st := range providerUseStatements(cfg) {
		if wildcardMatch(st.Resource, key) {
			enabled = strings.EqualFold(st.Effect, "allow")
		}
	}
	return enabled
}

// rewriteProviderPolicies 按 v2 规则重写 experimental.policies 中的 provider.use 语句：
//   - 收集所有启用供应商 key；
//   - 集合非空：写 [{action:provider.use,resource:*,effect:deny}] + 每个启用 key 一条 allow；
//   - 集合为空：移除全部 provider.use 语句（保持「不限制」）；
//   - 非 provider.use 语句原样保留，相对顺序不变；
//   - 不输出空的 policies / experimental 键。
//
// override 中的 key 以其给定值作为启用状态（覆盖三源计算结果），
// 用于让「正在保存的供应商」遵循本次提交的启用开关。
func rewriteProviderPolicies(cfg *model.OpenCodeConfig, override map[string]bool) error {
	enabledKeys := make([]string, 0, len(cfg.Providers))
	for key := range cfg.Providers {
		enabled := isProviderEnabled(key, cfg)
		if v, ok := override[key]; ok {
			enabled = v
		}
		if enabled {
			enabledKeys = append(enabledKeys, key)
		}
	}
	sort.Strings(enabledKeys)

	// 解析 experimental：存在但不是对象时直接报错中止，避免静默覆盖/删除用户配置。
	exp := map[string]json.RawMessage{}
	if raw, ok := cfg.Extra["experimental"]; ok {
		if err := json.Unmarshal(raw, &exp); err != nil {
			return fmt.Errorf("experimental 不是对象，无法安全重写策略: %w", err)
		}
	}
	var policies []json.RawMessage
	if raw, ok := exp["policies"]; ok {
		if err := json.Unmarshal(raw, &policies); err != nil {
			return fmt.Errorf("解析 experimental.policies 失败: %w", err)
		}
	}

	// 重写前是否已存在限制（三种来源任一），用于区分「用户主动过滤过」与「从未受限」。
	hadRestriction := len(cfg.EnabledProviders) > 0 || len(cfg.DisabledProviders) > 0 ||
		len(providerUseStatements(cfg)) > 0
	anyDisabled := len(enabledKeys) < len(cfg.Providers)

	// 保留非 provider.use 语句（provider.use 组将被整体重建）
	kept := make([]json.RawMessage, 0, len(policies))
	for _, item := range policies {
		var st policyStatement
		if json.Unmarshal(item, &st) == nil && st.Action == "provider.use" {
			continue
		}
		kept = append(kept, item)
	}

	// 三档写入规则：
	//  1) 有供应商但全部禁用 → 只写 deny *（表达「全禁用」）；
	//  2) 存在禁用项或原本已受限 → deny * + 逐项 allow（opt-in 的 deny-by-default）；
	//  3) 从未受限且全部启用 → 不写 provider.use（保持「不限制」，不误伤内置/未登记供应商）。
	switch {
	case len(cfg.Providers) > 0 && len(enabledKeys) == 0:
		b, err := json.Marshal(policyStatement{Action: "provider.use", Resource: "*", Effect: "deny"})
		if err != nil {
			return err
		}
		kept = append(kept, b)
	case len(enabledKeys) > 0 && (anyDisabled || hadRestriction):
		b, err := json.Marshal(policyStatement{Action: "provider.use", Resource: "*", Effect: "deny"})
		if err != nil {
			return err
		}
		kept = append(kept, b)
		for _, key := range enabledKeys {
			b, err := json.Marshal(policyStatement{Action: "provider.use", Resource: key, Effect: "allow"})
			if err != nil {
				return err
			}
			kept = append(kept, b)
		}
	}

	if len(kept) > 0 {
		b, err := json.Marshal(kept)
		if err != nil {
			return err
		}
		exp["policies"] = b
	} else {
		delete(exp, "policies")
	}

	if len(exp) > 0 {
		b, err := json.Marshal(exp)
		if err != nil {
			return err
		}
		if cfg.Extra == nil {
			cfg.Extra = map[string]json.RawMessage{}
		}
		cfg.Extra["experimental"] = b
	} else if cfg.Extra != nil {
		delete(cfg.Extra, "experimental")
	}
	return nil
}

// ========== 工具函数 ==========

// providerLegacyKeys 是供应商级中已迁移（或被新字段覆盖）的 v1 键，保存时不再作为 Extra 透传。
var providerLegacyKeys = map[string]bool{
	"npm": true, "options": true, "api": true,
	"name": true, "package": true, "settings": true, "models": true,
}

// modelLegacyKeys 是模型级中已迁移的 v1 键，保存时不再作为 Extra 透传。
var modelLegacyKeys = map[string]bool{
	"id": true, "modalities": true, "tool_call": true,
	"name": true, "modelID": true, "capabilities": true,
}

// carryExtra 复制 extra 中不在 drop 集合内的键；无剩余则返回 nil。
func carryExtra(extra map[string]json.RawMessage, drop map[string]bool) map[string]json.RawMessage {
	if len(extra) == 0 {
		return nil
	}
	out := make(map[string]json.RawMessage, len(extra))
	for k, v := range extra {
		if drop[k] {
			continue
		}
		out[k] = v
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// normalizeCapabilities 补全 capabilities 三件套。
//
// 为什么必须补全：OpenCode v2 的 Model.Capabilities schema 中 tools / input / output
// **均为必填**（源码 packages/schema/src/model.ts：三项都没有 optional）。只要某个模型的
// capabilities 缺任一字段，该模型就会被判 malformed，并导致**整个供应商被 v2 跳过**
// （packages/core/src/config/normalize.ts 的 invalid() → "skipped malformed recognized value"）。
// 因此落盘前统一补齐：tools 缺省 true，input/output 缺省 ["text"]。
func normalizeCapabilities(c *model.Capabilities) *model.Capabilities {
	if c == nil {
		return nil
	}
	if c.Tools == nil {
		t := true
		c.Tools = &t
	}
	if c.Input == nil {
		c.Input = []string{"text"}
	}
	if c.Output == nil {
		c.Output = []string{"text"}
	}
	return c
}

// firstNonEmpty 返回第一个非空字符串；全空返回 ""。
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// rawToString 把 json.RawMessage 解析为字符串；失败或空返回 ""。
func rawToString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

// rawToMap 把 json.RawMessage 解析为 map[string]interface{}；失败返回 nil。
func rawToMap(raw json.RawMessage) map[string]interface{} {
	if len(raw) == 0 {
		return nil
	}
	var m map[string]interface{}
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	return m
}

// containsFold 大小写不敏感地判断 key 是否在 list 中。
func containsFold(list []string, key string) bool {
	for _, v := range list {
		if strings.EqualFold(v, key) {
			return true
		}
	}
	return false
}

// wildcardMatch 大小写不敏感的通配匹配：
// * 匹配任意长度（含 /），? 匹配单个字符，其余按字面量。
func wildcardMatch(pattern, s string) bool {
	p := []rune(strings.ToLower(pattern))
	t := []rune(strings.ToLower(s))
	pi, ti := 0, 0
	star, mark := -1, 0
	for ti < len(t) {
		switch {
		case pi < len(p) && (p[pi] == '?' || p[pi] == t[ti]):
			pi++
			ti++
		case pi < len(p) && p[pi] == '*':
			star = pi
			mark = ti
			pi++
		case star != -1:
			pi = star + 1
			mark++
			ti = mark
		default:
			return false
		}
	}
	for pi < len(p) && p[pi] == '*' {
		pi++
	}
	return pi == len(p)
}

// 获取模型列表
func GetModelList(baseURL, apiKey string) []string {
	url := baseURL + "/models"
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return []string{}
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return []string{}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return []string{}
	}

	if resp.StatusCode != http.StatusOK {
		return []string{}
	}

	var result struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return []string{}
	}

	modelIDs := make([]string, 0, len(result.Data))
	for _, model := range result.Data {
		modelIDs = append(modelIDs, model.ID)
	}
	return modelIDs
}
