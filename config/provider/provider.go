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
func GetProviders() []model.ProviderInfo {
	cfg, err := loadOpenCodeConfig()
	if err != nil || cfg.Provider == nil {
		return nil
	}

	enabled := make(map[string]bool)
	for _, p := range cfg.EnabledProviders {
		enabled[p] = true
	}

	result := make([]model.ProviderInfo, 0, len(cfg.Provider))
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

		models := make([]model.ModelInfo, 0)
		if entry.Models != nil {
			// 模型是 map，遍历顺序随机；按键排序保证显示顺序稳定
			modelKeys := make([]string, 0, len(entry.Models))
			for mid := range entry.Models {
				modelKeys = append(modelKeys, mid)
			}
			sort.Strings(modelKeys)
			for _, mid := range modelKeys {
				models = append(models, model.ModelInfo{ID: mid, Name: entry.Models[mid].Name})
			}
		}

		displayName := entry.Name
		if displayName == "" {
			displayName = key
		}

		npm := entry.Npm
		if npm == "" {
			npm = "@ai-sdk/openai-compatible"
		}

		result = append(result, model.ProviderInfo{
			Key:     key,
			Name:    displayName,
			BaseURL: baseURL,
			ApiKey:  apiKey,
			Npm:     npm,
			Enabled: enabled[key],
			Models:  models,
		})
	}
	// cfg.Provider 是 map，遍历顺序随机；按键排序保证供应商卡片显示顺序稳定
	sort.Slice(result, func(i, j int) bool {
		return result[i].Key < result[j].Key
	})
	return result
}

// SaveProvider 保存单个供应商（新增或更新）。
func SaveProvider(ps model.ProviderSave) error {
	providerWriteMu.Lock()
	defer providerWriteMu.Unlock()

	cfg, err := loadOpenCodeConfig()
	if err != nil {
		return err
	}
	if cfg.Provider == nil {
		cfg.Provider = make(map[string]*model.ProviderEntry)
	}

	npm := ps.Npm
	if npm == "" {
		npm = "@ai-sdk/openai-compatible"
	}

	entry := &model.ProviderEntry{
		Npm:  npm,
		Name: ps.Name,
		Options: map[string]interface{}{
			"baseURL":     ps.BaseURL,
			"apiKey":      ps.ApiKey,
			"setCacheKey": true,
		},
	}
	if ps.Models != nil {
		entry.Models = make(map[string]*model.ModelDef)
		for _, m := range ps.Models {
			entry.Models[m.ID] = &model.ModelDef{Name: m.Name}
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

// DeleteProvider 删除供应商。
func DeleteProvider(key string) error {
	providerWriteMu.Lock()
	defer providerWriteMu.Unlock()

	cfg, err := loadOpenCodeConfig()
	if err != nil {
		return err
	}
	delete(cfg.Provider, key)
	cfg.EnabledProviders = removeProvider(cfg.EnabledProviders, key)
	return saveOpenCodeConfig(cfg)
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
