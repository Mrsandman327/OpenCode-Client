package service_test

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"oc-manager/model"
	"oc-manager/skill"
)

// createTestSkillDir 在指定目录下创建一个包含 SKILL.md 的测试技能目录。
// 返回技能目录的完整路径。
func createTestSkillDir(t *testing.T, parent, name string) string {
	t.Helper()
	skillDir := filepath.Join(parent, name)
	if err := os.MkdirAll(skillDir, 0755); err != nil {
		t.Fatalf("创建技能目录 %s 失败: %v", name, err)
	}
	mdContent := "---\nname: " + name + "\ndescription: Test skill " + name + "\n---\n# " + name + "\n"
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(mdContent), 0644); err != nil {
		t.Fatalf("写入 SKILL.md 失败: %v", err)
	}
	return skillDir
}

// setupSkillManagerForTest 创建隔离的技能管理器环境。
// 返回 *skill.Manager 和 globalDir 路径。
func setupSkillManagerForTest(t *testing.T) (*skill.Manager, string) {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	globalDir := filepath.Join(configHome, "opencode", "skills")
	if err := os.MkdirAll(globalDir, 0755); err != nil {
		t.Fatalf("创建技能全局目录失败: %v", err)
	}
	return skill.NewManager(), globalDir
}

// ========== LinkSkill 测试 ==========

func TestLinkSkillCreatesLink(t *testing.T) {
	mgr, globalDir := setupSkillManagerForTest(t)

	tmpDir := t.TempDir()
	skillPath := createTestSkillDir(t, tmpDir, "test-skill")

	err := mgr.LinkSkill(skillPath, "test-skill")
	if err != nil {
		// 若当前环境不支持链接创建，跳过测试
		if runtime.GOOS == "windows" {
			t.Skipf("当前环境不支持链接创建: %v", err)
		}
		t.Fatalf("LinkSkill() 返回错误: %v", err)
	}

	linkPath := filepath.Join(globalDir, "test-skill")
	if _, err := os.Stat(linkPath); os.IsNotExist(err) {
		t.Fatalf("链接 %s 未创建", linkPath)
	}

	// 验证链接目标可达
	skillMD := filepath.Join(linkPath, "SKILL.md")
	if _, err := os.Stat(skillMD); err != nil {
		t.Fatalf("通过链接读取 SKILL.md 失败: %v", err)
	}
}

func TestLinkSkillOverwritesExistingLink(t *testing.T) {
	mgr, globalDir := setupSkillManagerForTest(t)

	tmpDir := t.TempDir()
	skillPath1 := createTestSkillDir(t, tmpDir, "skill-v1")
	skillPath2 := createTestSkillDir(t, tmpDir, "skill-v2")

	// 先创建指向 v1 的链接
	if err := mgr.LinkSkill(skillPath1, "dynamic-skill"); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("当前环境不支持链接创建: %v", err)
		}
		t.Fatalf("首次 LinkSkill() 返回错误: %v", err)
	}

	// 再覆盖为 v2
	if err := mgr.LinkSkill(skillPath2, "dynamic-skill"); err != nil {
		t.Fatalf("覆盖 LinkSkill() 返回错误: %v", err)
	}

	// 验证链接指向 v2（通过读取文件内容确认）
	linkPath := filepath.Join(globalDir, "dynamic-skill")
	mdPath := filepath.Join(linkPath, "SKILL.md")
	data, err := os.ReadFile(mdPath)
	if err != nil {
		t.Fatalf("读取链接目标 SKILL.md 失败: %v", err)
	}
	if string(data) != "---\nname: skill-v2\ndescription: Test skill skill-v2\n---\n# skill-v2\n" {
		t.Fatalf("链接未指向 v2，文件内容: %s", string(data))
	}
}

// ========== GetManagedLinks 测试 ==========

func TestGetManagedLinksDetectsManagedLinks(t *testing.T) {
	mgr, _ := setupSkillManagerForTest(t)

	tmpDir := t.TempDir()
	sourceDir := filepath.Join(tmpDir, "my-source-skills")
	if err := os.MkdirAll(sourceDir, 0755); err != nil {
		t.Fatalf("创建来源目录失败: %v", err)
	}

	skillPath := createTestSkillDir(t, sourceDir, "managed-skill")

	// 创建托管链接
	if err := mgr.LinkSkill(skillPath, "managed-skill"); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("当前环境不支持链接创建: %v", err)
		}
		t.Fatalf("LinkSkill() 返回错误: %v", err)
	}

	managed, err := mgr.GetManagedLinks([]string{sourceDir})
	if err != nil {
		t.Fatalf("GetManagedLinks() 返回错误: %v", err)
	}

	if len(managed) != 1 {
		t.Fatalf("期望 1 个托管链接，实际得到 %d 个: %v", len(managed), managed)
	}
	if managed[0] != "managed-skill" {
		t.Fatalf("托管链接名称不匹配: 期望 managed-skill，实际 %s", managed[0])
	}
}

func TestGetManagedLinksExcludesNonManaged(t *testing.T) {
	mgr, globalDir := setupSkillManagerForTest(t)

	tmpDir := t.TempDir()
	sourceDir := filepath.Join(tmpDir, "my-source-skills")
	externalDir := filepath.Join(tmpDir, "external-skills")
	if err := os.MkdirAll(sourceDir, 0755); err != nil {
		t.Fatalf("创建来源目录失败: %v", err)
	}
	if err := os.MkdirAll(externalDir, 0755); err != nil {
		t.Fatalf("创建外部目录失败: %v", err)
	}

	managedSkill := createTestSkillDir(t, sourceDir, "managed-skill")
	externalSkill := createTestSkillDir(t, externalDir, "external-skill")

	// 创建托管链接
	if err := mgr.LinkSkill(managedSkill, "managed-skill"); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("当前环境不支持链接创建: %v", err)
		}
		t.Fatalf("创建托管链接失败: %v", err)
	}

	// 创建非托管链接
	if err := mgr.LinkSkill(externalSkill, "external-skill"); err != nil {
		t.Fatalf("创建外部链接失败: %v", err)
	}

	// 同时创建一个普通目录（非链接）
	plainDir := filepath.Join(globalDir, "plain-dir")
	if err := os.MkdirAll(plainDir, 0755); err != nil {
		t.Fatalf("创建普通目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(plainDir, "SKILL.md"), []byte("# plain\n"), 0644); err != nil {
		t.Fatalf("写入普通文件失败: %v", err)
	}

	managed, err := mgr.GetManagedLinks([]string{sourceDir})
	if err != nil {
		t.Fatalf("GetManagedLinks() 返回错误: %v", err)
	}

	// 只应返回托管链接
	for _, name := range managed {
		if name != "managed-skill" {
			t.Fatalf("非托管条目出现在托管列表中: %s", name)
		}
	}

	if len(managed) != 1 || managed[0] != "managed-skill" {
		t.Fatalf("托管列表异常: %v", managed)
	}
}

func TestGetManagedLinksEmptySourceDirs(t *testing.T) {
	mgr, _ := setupSkillManagerForTest(t)

	managed, err := mgr.GetManagedLinks([]string{})
	if err != nil {
		t.Fatalf("GetManagedLinks() 对空来源应返回 nil 错误: %v", err)
	}
	if len(managed) != 0 {
		t.Fatalf("空来源目录时期望 0 个托管链接，实际有 %d 个", len(managed))
	}

	managed, err = mgr.GetManagedLinks(nil)
	if err != nil {
		t.Fatalf("GetManagedLinks() 对 nil 来源应返回 nil 错误: %v", err)
	}
	if len(managed) != 0 {
		t.Fatalf("nil 来源目录时期望 0 个托管链接，实际有 %d 个", len(managed))
	}
}

// ========== ClearManagedLinks 测试 ==========

func TestClearManagedLinksRemovesOnlyManaged(t *testing.T) {
	mgr, globalDir := setupSkillManagerForTest(t)

	tmpDir := t.TempDir()
	sourceDir := filepath.Join(tmpDir, "my-source-skills")
	externalDir := filepath.Join(tmpDir, "external-skills")
	if err := os.MkdirAll(sourceDir, 0755); err != nil {
		t.Fatalf("创建来源目录失败: %v", err)
	}
	if err := os.MkdirAll(externalDir, 0755); err != nil {
		t.Fatalf("创建外部目录失败: %v", err)
	}

	managedSkill := createTestSkillDir(t, sourceDir, "managed-skill")
	externalSkill := createTestSkillDir(t, externalDir, "external-skill")

	// 创建托管链接
	if err := mgr.LinkSkill(managedSkill, "managed-skill"); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("当前环境不支持链接创建: %v", err)
		}
		t.Fatalf("创建托管链接失败: %v", err)
	}

	// 创建外部链接
	if err := mgr.LinkSkill(externalSkill, "external-skill"); err != nil {
		t.Fatalf("创建外部链接失败: %v", err)
	}

	// 清除托管链接
	if err := mgr.ClearManagedLinks([]string{sourceDir}); err != nil {
		t.Fatalf("ClearManagedLinks() 返回错误: %v", err)
	}

	// 托管链接应被删除
	managedLinkPath := filepath.Join(globalDir, "managed-skill")
	if _, err := os.Stat(managedLinkPath); !os.IsNotExist(err) {
		t.Fatalf("托管链接 %s 未被删除", managedLinkPath)
	}

	// 外部链接应保留
	externalLinkPath := filepath.Join(globalDir, "external-skill")
	if _, err := os.Stat(externalLinkPath); os.IsNotExist(err) {
		t.Fatalf("外部链接 %s 被意外删除", externalLinkPath)
	}
}

// ========== ApplySkillScheme 测试 ==========

func TestApplySkillSchemeFullApply(t *testing.T) {
	mgr, globalDir := setupSkillManagerForTest(t)

	tmpDir := t.TempDir()
	sourceDir := filepath.Join(tmpDir, "my-source-skills")
	if err := os.MkdirAll(sourceDir, 0755); err != nil {
		t.Fatalf("创建来源目录失败: %v", err)
	}

	// 创建两个技能目录
	skillPathA := createTestSkillDir(t, sourceDir, "skill-a")
	skillPathB := createTestSkillDir(t, sourceDir, "skill-b")

	// 构建可用技能列表
	available := []model.SkillInfo{
		{Name: "skill-a", Path: skillPathA, Conflict: false},
		{Name: "skill-b", Path: skillPathB, Conflict: false},
	}

	// 应用方案
	scheme := model.SkillSchemeData{"skill-a", "skill-b"}
	result := mgr.ApplySkillScheme(scheme, available, []string{sourceDir})

	if !result.Success {
		t.Fatal("期望方案应用成功")
	}
	if len(result.Applied) != 2 {
		t.Fatalf("期望 2 个技能被应用，实际 %d 个", len(result.Applied))
	}
	if len(result.Missing) != 0 {
		t.Fatalf("期望 0 个缺失，实际 %d 个: %v", len(result.Missing), result.Missing)
	}
	if len(result.Conflicts) != 0 {
		t.Fatalf("期望 0 个冲突，实际 %d 个: %v", len(result.Conflicts), result.Conflicts)
	}
	if len(result.Errors) != 0 {
		t.Fatalf("期望 0 个错误，实际 %d 个: %v", len(result.Errors), result.Errors)
	}

	// 验证链接已创建（使用 os.Stat 跟踪符号链接/联接）
	for _, name := range []string{"skill-a", "skill-b"} {
		linkPath := filepath.Join(globalDir, name)
		if info, err := os.Stat(linkPath); err != nil {
			t.Fatalf("链接 %s 未创建: %v", name, err)
		} else if !info.IsDir() {
			t.Fatalf("链接 %s 不是目录", name)
		}
	}
}

func TestApplySkillSchemePartialApply(t *testing.T) {
	mgr, globalDir := setupSkillManagerForTest(t)

	tmpDir := t.TempDir()
	sourceDir := filepath.Join(tmpDir, "my-source-skills")
	if err := os.MkdirAll(sourceDir, 0755); err != nil {
		t.Fatalf("创建来源目录失败: %v", err)
	}

	skillPathA := createTestSkillDir(t, sourceDir, "skill-a")

	available := []model.SkillInfo{
		{Name: "skill-a", Path: skillPathA, Conflict: false},
		// skill-b 不在可用列表中 → 会被标记为 Missing
		{Name: "skill-c", Path: skillPathA, Conflict: true}, // 冲突技能
	}

	// 方案包含存在、缺失、冲突三种情况
	scheme := model.SkillSchemeData{"skill-a", "skill-b", "skill-c"}
	result := mgr.ApplySkillScheme(scheme, available, []string{sourceDir})

	if !result.Success {
		t.Fatal("部分成功应视为 Success=true")
	}
	if len(result.Applied) != 1 {
		t.Fatalf("期望 1 个技能被应用，实际 %d 个", len(result.Applied))
	}
	if result.Applied[0] != "skill-a" {
		t.Fatalf("期望应用 skill-a，实际: %s", result.Applied[0])
	}
	if len(result.Missing) != 1 {
		t.Fatalf("期望 1 个缺失，实际 %d 个", len(result.Missing))
	}
	if result.Missing[0] != "skill-b" {
		t.Fatalf("期望缺失 skill-b，实际: %s", result.Missing[0])
	}
	if len(result.Conflicts) != 1 {
		t.Fatalf("期望 1 个冲突，实际 %d 个", len(result.Conflicts))
	}
	if result.Conflicts[0] != "skill-c" {
		t.Fatalf("期望冲突 skill-c，实际: %s", result.Conflicts[0])
	}

	// skill-a 的链接应存在（使用 os.Stat 跟踪符号链接/联接）
	linkPath := filepath.Join(globalDir, "skill-a")
	if info, err := os.Stat(linkPath); err != nil {
		t.Fatalf("skill-a 链接未创建: %v", err)
	} else if !info.IsDir() {
		t.Fatalf("skill-a 链接目标不是目录")
	}
}

func TestApplySkillSchemePreservesNonManaged(t *testing.T) {
	mgr, globalDir := setupSkillManagerForTest(t)

	tmpDir := t.TempDir()
	sourceDir := filepath.Join(tmpDir, "my-source-skills")
	externalDir := filepath.Join(tmpDir, "external-skills")
	if err := os.MkdirAll(sourceDir, 0755); err != nil {
		t.Fatalf("创建来源目录失败: %v", err)
	}
	if err := os.MkdirAll(externalDir, 0755); err != nil {
		t.Fatalf("创建外部目录失败: %v", err)
	}

	managedSkill := createTestSkillDir(t, sourceDir, "managed-skill")
	externalSkill := createTestSkillDir(t, externalDir, "external-skill")

	// 创建外部链接（非托管）
	if err := mgr.LinkSkill(externalSkill, "external-skill"); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("当前环境不支持链接创建: %v", err)
		}
		t.Fatalf("创建外部链接失败: %v", err)
	}

	// 应用托管方案
	available := []model.SkillInfo{
		{Name: "managed-skill", Path: managedSkill, Conflict: false},
	}
	scheme := model.SkillSchemeData{"managed-skill"}
	result := mgr.ApplySkillScheme(scheme, available, []string{sourceDir})

	if !result.Success {
		t.Fatal("方案应用应成功")
	}

	// 外部链接应保留
	externalLinkPath := filepath.Join(globalDir, "external-skill")
	if _, err := os.Stat(externalLinkPath); os.IsNotExist(err) {
		t.Fatalf("外部链接 %s 被意外删除", externalLinkPath)
	}

	// 托管链接应存在
	managedLinkPath := filepath.Join(globalDir, "managed-skill")
	if _, err := os.Stat(managedLinkPath); err != nil {
		t.Fatalf("托管链接 %s 未创建: %v", managedLinkPath, err)
	}
}

func TestApplySkillSchemeAllMissingOrConflict(t *testing.T) {
	mgr, _ := setupSkillManagerForTest(t)

	available := []model.SkillInfo{
		{Name: "conflict-a", Path: "/nonexistent/a", Conflict: true},
		{Name: "conflict-b", Path: "/nonexistent/b", Conflict: true},
	}

	scheme := model.SkillSchemeData{"missing-x", "conflict-a", "missing-y", "conflict-b"}
	result := mgr.ApplySkillScheme(scheme, available, []string{"/some/source"})

	// Success 应为 false，因为没有技能被成功应用
	if result.Success {
		t.Fatal("全部失败时应为 Success=false")
	}
	if len(result.Applied) != 0 {
		t.Fatalf("期望 0 个技能被应用，实际 %d 个", len(result.Applied))
	}
	if len(result.Missing) != 2 {
		t.Fatalf("期望 2 个缺失，实际 %d 个", len(result.Missing))
	}
	if len(result.Conflicts) != 2 {
		t.Fatalf("期望 2 个冲突，实际 %d 个", len(result.Conflicts))
	}
}
