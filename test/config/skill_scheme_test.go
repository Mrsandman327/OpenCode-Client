package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"oc-manager/config"
)

// setupTempSkillSchemeDir 准备隔离的测试环境——通过 SKILL_CONFIG_DIR 指向临时 configs 目录。
// 返回该 configs 目录路径，其中的 skill-schemes/ 子目录作为方案存储根。
func setupTempSkillSchemeDir(t *testing.T) string {
	t.Helper()
	tmpDir := t.TempDir()
	configDir := filepath.Join(tmpDir, "configs")
	if err := os.MkdirAll(configDir, 0755); err != nil {
		t.Fatalf("创建测试 configs 目录失败: %v", err)
	}
	t.Setenv("SKILL_CONFIG_DIR", configDir)
	return configDir
}

// ========== SaveSkillScheme 和 LoadSkillScheme 测试 ==========

func TestSaveAndLoadSkillScheme(t *testing.T) {
	_ = setupTempSkillSchemeDir(t)

	names := []string{"superpowers/brainstorming", "playwright", "git-master"}
	if err := config.SaveSkillScheme("daily-dev", names); err != nil {
		t.Fatalf("SaveSkillScheme() 返回错误: %v", err)
	}

	loaded, err := config.LoadSkillScheme("daily-dev")
	if err != nil {
		t.Fatalf("LoadSkillScheme() 返回错误: %v", err)
	}

	if len(loaded) != len(names) {
		t.Fatalf("期望 %d 个技能名称，实际得到 %d 个", len(names), len(loaded))
	}

	for i, want := range names {
		if loaded[i] != want {
			t.Fatalf("方案条目[%d] 不匹配: 期望 %q，实际 %q", i, want, loaded[i])
		}
	}
}

func TestSaveSkillSchemeEmptyName(t *testing.T) {
	_ = setupTempSkillSchemeDir(t)

	err := config.SaveSkillScheme("", []string{"some-skill"})
	if err == nil {
		t.Fatal("SaveSkillScheme() 对空名称应返回错误")
	}

	err = config.SaveSkillScheme("   ", []string{"some-skill"})
	if err == nil {
		t.Fatal("SaveSkillScheme() 对空白名称应返回错误")
	}
}

func TestSaveSkillSchemeEmptyList(t *testing.T) {
	_ = setupTempSkillSchemeDir(t)

	// 空列表是合法的——代表"清空所有技能"
	if err := config.SaveSkillScheme("empty-state", []string{}); err != nil {
		t.Fatalf("SaveSkillScheme() 对空列表应成功: %v", err)
	}

	loaded, err := config.LoadSkillScheme("empty-state")
	if err != nil {
		t.Fatalf("LoadSkillScheme() 返回错误: %v", err)
	}

	if len(loaded) != 0 {
		t.Fatalf("空方案加载后期望 0 个条目，实际有 %d 个", len(loaded))
	}
}

func TestListSkillSchemes(t *testing.T) {
	_ = setupTempSkillSchemeDir(t)

	// 保存多个方案
	if err := config.SaveSkillScheme("daily", []string{"playwright"}); err != nil {
		t.Fatalf("保存 daily 失败: %v", err)
	}
	if err := config.SaveSkillScheme("project-x", []string{"git-master"}); err != nil {
		t.Fatalf("保存 project-x 失败: %v", err)
	}
	if err := config.SaveSkillScheme("review", []string{"code-review"}); err != nil {
		t.Fatalf("保存 review 失败: %v", err)
	}

	schemes, err := config.ListSkillSchemes()
	if err != nil {
		t.Fatalf("ListSkillSchemes() 返回错误: %v", err)
	}

	if len(schemes) != 3 {
		t.Fatalf("期望 3 个方案，实际得到 %d 个: %v", len(schemes), schemes)
	}

	// 验证方案名称不包含 .json 后缀
	for _, name := range schemes {
		if filepath.Ext(name) == ".json" {
			t.Fatalf("方案名称不应包含 .json 后缀: %s", name)
		}
	}
}

func TestListSkillSchemesEmpty(t *testing.T) {
	_ = setupTempSkillSchemeDir(t)

	schemes, err := config.ListSkillSchemes()
	if err != nil {
		t.Fatalf("ListSkillSchemes() 返回错误: %v", err)
	}

	if len(schemes) != 0 {
		t.Fatalf("空目录期望 0 个方案，实际有 %d 个", len(schemes))
	}
}

func TestDeleteSkillScheme(t *testing.T) {
	_ = setupTempSkillSchemeDir(t)

	if err := config.SaveSkillScheme("temp", []string{"test-skill"}); err != nil {
		t.Fatalf("保存 temp 失败: %v", err)
	}

	if err := config.DeleteSkillScheme("temp"); err != nil {
		t.Fatalf("DeleteSkillScheme() 返回错误: %v", err)
	}

	// 删除后列表应变空
	schemes, err := config.ListSkillSchemes()
	if err != nil {
		t.Fatalf("ListSkillSchemes() 返回错误: %v", err)
	}

	for _, name := range schemes {
		if name == "temp" {
			t.Fatalf("删除后方案 'temp' 仍存在于列表中")
		}
	}

	// 再次删除应报错
	err = config.DeleteSkillScheme("temp")
	if err == nil {
		t.Fatal("DeleteSkillScheme() 对不存在的方案应返回错误")
	}
}

func TestLoadSkillSchemeNonExistent(t *testing.T) {
	_ = setupTempSkillSchemeDir(t)

	_, err := config.LoadSkillScheme("nonexistent-scheme")
	if err == nil {
		t.Fatal("LoadSkillScheme() 对不存在的方案应返回错误")
	}
}

func TestSaveSkillSchemeOverwrite(t *testing.T) {
	_ = setupTempSkillSchemeDir(t)

	// 先保存 v1
	if err := config.SaveSkillScheme("evolving", []string{"skill-a", "skill-b"}); err != nil {
		t.Fatalf("首次保存失败: %v", err)
	}

	// 再覆盖保存 v2
	if err := config.SaveSkillScheme("evolving", []string{"skill-x", "skill-y", "skill-z"}); err != nil {
		t.Fatalf("覆盖保存失败: %v", err)
	}

	loaded, err := config.LoadSkillScheme("evolving")
	if err != nil {
		t.Fatalf("LoadSkillScheme() 返回错误: %v", err)
	}

	if len(loaded) != 3 {
		t.Fatalf("覆盖后期望 3 个条目，实际有 %d 个", len(loaded))
	}
	if loaded[0] != "skill-x" {
		t.Fatalf("首个条目应为 skill-x，实际: %s", loaded[0])
	}
}
