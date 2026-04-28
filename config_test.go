package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteConfigFileRejectsEmptyContent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.jsonc")
	original := []byte("{\n  \"agents\": {}\n}")
	if err := os.WriteFile(path, original, 0644); err != nil {
		t.Fatalf("seed config: %v", err)
	}

	if err := writeConfigFile(path, []byte("  \n\t"), 0644); err == nil {
		t.Fatal("expected empty content to be rejected")
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config after rejected write: %v", err)
	}
	if string(got) != string(original) {
		t.Fatalf("config changed after rejected write: got %q, want %q", got, original)
	}
}

func TestWriteConfigFileReplacesNonEmptyContent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.jsonc")
	if err := os.WriteFile(path, []byte("{}"), 0644); err != nil {
		t.Fatalf("seed config: %v", err)
	}

	next := []byte("{\n  \"categories\": {}\n}")
	if err := writeConfigFile(path, next, 0644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if string(got) != string(next) {
		t.Fatalf("got %q, want %q", got, next)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read temp dir: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".config.jsonc.") && strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("temporary file was not cleaned up: %s", entry.Name())
		}
	}
}

func TestWriteConfigFileRejectsInvalidJSONC(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.jsonc")
	original := []byte("{\n  \"agents\": {}\n}")
	if err := os.WriteFile(path, original, 0644); err != nil {
		t.Fatalf("seed config: %v", err)
	}

	if err := writeConfigFile(path, []byte(`{"agents":`), 0644); err == nil {
		t.Fatal("expected invalid JSONC to be rejected")
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config after rejected write: %v", err)
	}
	if string(got) != string(original) {
		t.Fatalf("config changed after rejected write: got %q, want %q", got, original)
	}
}

func TestSaveConfigPreservesCommentsUnknownFieldsAndSiblings(t *testing.T) {
	configPath := setupTempConfig(t, `{
  "agents": {
    "oracle": {
      "model": "old/oracle", // 分析师
      "temperature": 0.2
    },
    "librarian": {
      "model": "old/librarian"
    }
  },
  "categories": {
    "quick": {
      "model": "old/quick",
      "notes": "keep me"
    }
  },
  "mcp": {
    "enabled": true
  }
}`)

	err := saveConfig([]ModelEntry{
		{Key: "oracle", Type: "agent", Model: "new/oracle"},
		{Key: "librarian", Type: "agent", Model: "old/librarian"},
		{Key: "quick", Type: "category", Model: "new/quick"},
	})
	if err != nil {
		t.Fatalf("save config: %v", err)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	text := string(data)
	for _, want := range []string{
		`"model": "new/oracle", // 分析师`,
		`"temperature": 0.2`,
		`"model": "old/librarian"`,
		`"model": "new/quick",`,
		`"notes": "keep me"`,
		`"mcp": {`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("saved config missing %q:\n%s", want, text)
		}
	}
}

func TestSaveConfigInsertsNewModelEntry(t *testing.T) {
	configPath := setupTempConfig(t, `{
  "agents": {
    "oracle": {
      "model": "old/oracle"
    }
  },
  "categories": {
    "quick": {
      "model": "old/quick"
    }
  }
}`)

	err := saveConfig([]ModelEntry{
		{Key: "oracle", Type: "agent", Model: "new/oracle"},
		{Key: "quick", Type: "category", Model: "old/quick"},
		{Key: "custom-agent", Type: "agent", Model: "custom/model", Comment: "自定义 Agent"},
		{Key: "custom-category", Type: "category", Model: "custom/category", Comment: "自定义分类\n多行"},
	})
	if err != nil {
		t.Fatalf("save config with new entries: %v", err)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	text := string(data)
	for _, want := range []string{
		`"model": "new/oracle"`,
		`"custom-agent": {`,
		`"model": "custom/model" // 自定义 Agent`,
		`"custom-category": {`,
		`"model": "custom/category" // 自定义分类 多行`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("saved config missing %q:\n%s", want, text)
		}
	}
	if err := validateJSONC(data); err != nil {
		t.Fatalf("saved config is invalid JSONC: %v\n%s", err, text)
	}
}

func TestSaveConfigDeletesRemovedModelEntry(t *testing.T) {
	configPath := setupTempConfig(t, `{
  "agents": {
    "oracle": {
      "model": "old/oracle"
    },
    "obsolete": {
      "model": "old/obsolete"
    },
    "librarian": {
      "model": "old/librarian"
    }
  },
  "categories": {
    "quick": {
      "model": "old/quick"
    },
    "unused": {
      "model": "old/unused"
    }
  }
}`)

	err := saveConfig([]ModelEntry{
		{Key: "oracle", Type: "agent", Model: "new/oracle"},
		{Key: "librarian", Type: "agent", Model: "old/librarian"},
		{Key: "quick", Type: "category", Model: "old/quick"},
	})
	if err != nil {
		t.Fatalf("save config with deleted entries: %v", err)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	text := string(data)
	for _, gone := range []string{`"obsolete"`, `old/obsolete`, `"unused"`, `old/unused`} {
		if strings.Contains(text, gone) {
			t.Fatalf("saved config still contains deleted value %q:\n%s", gone, text)
		}
	}
	for _, want := range []string{`"model": "new/oracle"`, `"librarian": {`, `"quick": {`} {
		if !strings.Contains(text, want) {
			t.Fatalf("saved config missing %q:\n%s", want, text)
		}
	}
	if err := validateJSONC(data); err != nil {
		t.Fatalf("saved config is invalid JSONC: %v\n%s", err, text)
	}
}

func setupTempConfig(t *testing.T, content string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	dir := filepath.Join(home, ".config", "opencode")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("create config dir: %v", err)
	}
	path := filepath.Join(dir, "oh-my-openagent.jsonc")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("seed config: %v", err)
	}
	return path
}
