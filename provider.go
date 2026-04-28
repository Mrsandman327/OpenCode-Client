package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// ========== 数据结构 ==========

// OpenCodeConfig opencode.jsonc 顶层结构
type OpenCodeConfig struct {
	Schema           string                    `json:"$schema,omitempty"`
	Plugin           []string                  `json:"plugin,omitempty"`
	Provider         map[string]*ProviderEntry `json:"provider,omitempty"`
	EnabledProviders []string                  `json:"enabled_providers,omitempty"`
	Server           map[string]interface{}    `json:"server,omitempty"`
}

// ProviderEntry 单个供应商配置
type ProviderEntry struct {
	Npm     string                 `json:"npm,omitempty"`
	Name    string                 `json:"name,omitempty"`
	Options map[string]interface{} `json:"options,omitempty"`
	Models  map[string]*ModelDef   `json:"models,omitempty"`
}

// ModelDef 模型定义
type ModelDef struct {
	Name string `json:"name"`
}

// ========== 前端数据结构 ==========

// ProviderInfo 前端展示用供应商信息
type ProviderInfo struct {
	Key     string      `json:"key"`     // 供应商 key（如 "deepseek"）
	Name    string      `json:"name"`    // 显示名称
	BaseURL string      `json:"baseURL"` // 请求地址
	ApiKey  string      `json:"apiKey"`  // API Key（脱敏显示后4位）
	Enabled bool        `json:"enabled"` // 是否启用
	Models  []ModelInfo `json:"models"`  // 模型列表
}

// ModelInfo 前端展示用模型信息
type ModelInfo struct {
	ID   string `json:"id"`   // 模型 ID
	Name string `json:"name"` // 模型名称
}

// ProviderSave 前端提交的供应商保存数据
type ProviderSave struct {
	Key     string      `json:"key"`
	Name    string      `json:"name"`
	BaseURL string      `json:"baseURL"`
	ApiKey  string      `json:"apiKey"`
	Enabled bool        `json:"enabled"`
	Models  []ModelInfo `json:"models"`
}

// ========== 配置路径 ==========

func opencodeConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "opencode", "opencode.jsonc")
}

// ========== 读取 ==========

func loadOpenCodeConfig() (*OpenCodeConfig, error) {
	path := opencodeConfigPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取配置失败: %w", err)
	}

	var cfg OpenCodeConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("解析配置失败: %w", err)
	}
	return &cfg, nil
}

// ========== 写入 ==========

func saveOpenCodeConfig(cfg *OpenCodeConfig) error {
	path := opencodeConfigPath()
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化失败: %w", err)
	}
	return writeConfigFile(path, data, 0644)
}

// ========== 业务逻辑 ==========

// getProviders 获取所有供应商信息
func getProviders() []ProviderInfo {
	cfg, err := loadOpenCodeConfig()
	if err != nil || cfg.Provider == nil {
		return nil
	}

	enabled := make(map[string]bool)
	for _, p := range cfg.EnabledProviders {
		enabled[p] = true
	}

	result := make([]ProviderInfo, 0, len(cfg.Provider))
	for key, entry := range cfg.Provider {
		baseURL := ""
		apiKey := ""
		if entry.Options != nil {
			if v, ok := entry.Options["baseURL"].(string); ok {
				baseURL = v
			}
			if v, ok := entry.Options["apiKey"].(string); ok {
				apiKey = v
			}
		}

		models := make([]ModelInfo, 0)
		if entry.Models != nil {
			for mid, m := range entry.Models {
				models = append(models, ModelInfo{ID: mid, Name: m.Name})
			}
		}

		displayName := entry.Name
		if displayName == "" {
			displayName = key
		}

		result = append(result, ProviderInfo{
			Key:     key,
			Name:    displayName,
			BaseURL: baseURL,
			ApiKey:  apiKey,
			Enabled: enabled[key],
			Models:  models,
		})
	}
	return result
}

// saveProvider 保存单个供应商（新增或更新）
func saveProvider(ps ProviderSave) error {
	configWriteMu.Lock()
	defer configWriteMu.Unlock()

	cfg, err := loadOpenCodeConfig()
	if err != nil {
		return err
	}
	if cfg.Provider == nil {
		cfg.Provider = make(map[string]*ProviderEntry)
	}

	entry := &ProviderEntry{
		Npm:  "@ai-sdk/openai-compatible",
		Name: ps.Name,
		Options: map[string]interface{}{
			"baseURL":     ps.BaseURL,
			"apiKey":      ps.ApiKey,
			"setCacheKey": true,
		},
	}
	if ps.Models != nil {
		entry.Models = make(map[string]*ModelDef)
		for _, m := range ps.Models {
			entry.Models[m.ID] = &ModelDef{Name: m.Name}
		}
	}

	cfg.Provider[ps.Key] = entry

	// 更新 enabled_providers
	if ps.Enabled {
		if !containsProvider(cfg.EnabledProviders, ps.Key) {
			cfg.EnabledProviders = append(cfg.EnabledProviders, ps.Key)
		}
	} else {
		cfg.EnabledProviders = removeProvider(cfg.EnabledProviders, ps.Key)
	}

	return saveOpenCodeConfig(cfg)
}

// deleteProvider 删除供应商
func deleteProvider(key string) error {
	configWriteMu.Lock()
	defer configWriteMu.Unlock()

	cfg, err := loadOpenCodeConfig()
	if err != nil {
		return err
	}
	delete(cfg.Provider, key)
	cfg.EnabledProviders = removeProvider(cfg.EnabledProviders, key)
	return saveOpenCodeConfig(cfg)
}

// ========== 工具函数 ==========

func containsProvider(list []string, key string) bool {
	for _, v := range list {
		if v == key {
			return true
		}
	}
	return false
}

func removeProvider(list []string, key string) []string {
	result := make([]string, 0, len(list))
	for _, v := range list {
		if v != key {
			result = append(result, v)
		}
	}
	return result
}
