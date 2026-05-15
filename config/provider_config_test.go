package config

import (
	"os"
	"path/filepath"
	"testing"

	"oc-manager/model"
)

func TestGetProvidersReturnsNpmField(t *testing.T) {
	setupTempOpenCodeProviderConfig(t, `{
		"provider": {
			"demo": {
				"npm": "@ai-sdk/google",
				"name": "Demo",
				"options": {
					"baseURL": "https://example.com",
					"apiKey": "secret"
				}
			}
		},
		"enabled_providers": ["demo"]
	}`)

	providers := GetProviders()
	if len(providers) != 1 {
		t.Fatalf("供应商数量不正确: got %d, want 1", len(providers))
	}
	if providers[0].Npm != "@ai-sdk/google" {
		t.Fatalf("供应商 npm 未返回: got %q, want %q", providers[0].Npm, "@ai-sdk/google")
	}
}

func TestGetProvidersFallsBackToDefaultNpmWhenMissing(t *testing.T) {
	setupTempOpenCodeProviderConfig(t, `{
		"provider": {
			"legacy": {
				"name": "Legacy",
				"options": {
					"baseURL": "https://legacy.example.com"
				}
			}
		}
	}`)

	providers := GetProviders()
	if len(providers) != 1 {
		t.Fatalf("供应商数量不正确: got %d, want 1", len(providers))
	}
	if providers[0].Npm != "@ai-sdk/openai-compatible" {
		t.Fatalf("旧供应商配置缺少 npm 时未回退默认值: got %q, want %q", providers[0].Npm, "@ai-sdk/openai-compatible")
	}
}

func TestSaveProviderPersistsProvidedNpm(t *testing.T) {
	setupTempOpenCodeProviderConfig(t, `{"provider": {}, "enabled_providers": []}`)

	err := SaveProvider(model.ProviderSave{
		Key:     "demo",
		Name:    "Demo",
		BaseURL: "https://example.com",
		ApiKey:  "secret",
		Npm:     "@ai-sdk/anthropic",
		Enabled: true,
	})
	if err != nil {
		t.Fatalf("保存供应商失败: %v", err)
	}

	cfg, err := loadOpenCodeConfig()
	if err != nil {
		t.Fatalf("读取配置失败: %v", err)
	}
	if cfg.Provider["demo"].Npm != "@ai-sdk/anthropic" {
		t.Fatalf("供应商 npm 未持久化传入值: got %q, want %q", cfg.Provider["demo"].Npm, "@ai-sdk/anthropic")
	}
}

func TestSaveProviderFallsBackToDefaultNpmWhenEmpty(t *testing.T) {
	setupTempOpenCodeProviderConfig(t, `{"provider": {}, "enabled_providers": []}`)

	err := SaveProvider(model.ProviderSave{
		Key:     "demo",
		Name:    "Demo",
		BaseURL: "https://example.com",
		ApiKey:  "secret",
		Npm:     "",
		Enabled: true,
	})
	if err != nil {
		t.Fatalf("保存供应商失败: %v", err)
	}

	cfg, err := loadOpenCodeConfig()
	if err != nil {
		t.Fatalf("读取配置失败: %v", err)
	}
	if cfg.Provider["demo"].Npm != "@ai-sdk/openai-compatible" {
		t.Fatalf("供应商 npm 默认值不正确: got %q, want %q", cfg.Provider["demo"].Npm, "@ai-sdk/openai-compatible")
	}
}

func setupTempOpenCodeProviderConfig(t *testing.T, content string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	dir := filepath.Join(home, ".config", "opencode")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("创建配置目录失败: %v", err)
	}
	path := filepath.Join(dir, "opencode.jsonc")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("写入测试配置失败: %v", err)
	}
	return path
}
