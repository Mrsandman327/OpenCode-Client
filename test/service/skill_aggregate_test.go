package service_test

import (
	"os"
	"path/filepath"
	"testing"

	"oc-manager/skill"
)

// skillFrontmatterContent 生成一个包含指定描述的 SKILL.md 内容。
func skillFrontmatterContent(desc string) string {
	return "---\nname: test-skill\ndescription: " + desc + "\n---\n# Test Skill\n"
}

// createSkillDir 在指定目录下创建技能子目录并写入 SKILL.md。
// dir: 父目录路径, skillName: 技能目录名, desc: 技能描述。
func createSkillDir(dir, skillName, desc string) error {
	skillDir := filepath.Join(dir, skillName)
	if err := os.MkdirAll(skillDir, 0755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(skillFrontmatterContent(desc)), 0644)
}

// ========== TestScanMultipleDirsNoConflict ==========

func TestScanMultipleDirsNoConflict(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)

	sourceDir1 := filepath.Join(t.TempDir(), "source1")
	sourceDir2 := filepath.Join(t.TempDir(), "source2")
	if err := os.MkdirAll(sourceDir1, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(sourceDir2, 0755); err != nil {
		t.Fatal(err)
	}

	// 在两个不同来源目录中创建不同名称的技能
	if err := createSkillDir(sourceDir1, "skill-a", "第一个来源的技能A"); err != nil {
		t.Fatal(err)
	}
	if err := createSkillDir(sourceDir2, "skill-b", "第二个来源的技能B"); err != nil {
		t.Fatal(err)
	}

	mgr := skill.NewManager()
	skills := mgr.ScanMultipleDirs([]string{sourceDir1, sourceDir2})

	// 验证：两个技能都应该存在
	if len(skills) != 2 {
		t.Fatalf("期望 2 个技能，实际得到 %d 个", len(skills))
	}

	// 验证 skill-a
	skillA := skills[0]
	if skillA.Name != "skill-a" {
		t.Errorf("skill-a 名称错误: %s", skillA.Name)
	}
	if skillA.Conflict {
		t.Errorf("skill-a 不应标记为冲突")
	}
	if !skillA.Enableable {
		t.Errorf("skill-a 应可启用")
	}
	if len(skillA.Sources) != 1 {
		t.Errorf("skill-a 应有 1 个来源，实际有 %d 个", len(skillA.Sources))
	}
	if skillA.Sources[0].Source != sourceDir1 {
		t.Errorf("skill-a 来源错误: %s", skillA.Sources[0].Source)
	}
	if skillA.Description != "第一个来源的技能A" {
		t.Errorf("skill-a 描述错误: %s", skillA.Description)
	}

	// 验证 skill-b
	skillB := skills[1]
	if skillB.Name != "skill-b" {
		t.Errorf("skill-b 名称错误: %s", skillB.Name)
	}
	if skillB.Conflict {
		t.Errorf("skill-b 不应标记为冲突")
	}
	if !skillB.Enableable {
		t.Errorf("skill-b 应可启用")
	}
}

// ========== TestScanMultipleDirsWithConflict ==========

func TestScanMultipleDirsWithConflict(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)

	sourceDir1 := filepath.Join(t.TempDir(), "source1")
	sourceDir2 := filepath.Join(t.TempDir(), "source2")
	if err := os.MkdirAll(sourceDir1, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(sourceDir2, 0755); err != nil {
		t.Fatal(err)
	}

	// 两个来源目录中创建同名技能
	if err := createSkillDir(sourceDir1, "common-skill", "来源1的通用技能"); err != nil {
		t.Fatal(err)
	}
	if err := createSkillDir(sourceDir2, "common-skill", "来源2的通用技能"); err != nil {
		t.Fatal(err)
	}

	mgr := skill.NewManager()
	skills := mgr.ScanMultipleDirs([]string{sourceDir1, sourceDir2})

	// 验证：只有一个技能条目，标记为冲突
	if len(skills) != 1 {
		t.Fatalf("期望 1 个技能，实际得到 %d 个", len(skills))
	}

	skill := skills[0]
	if skill.Name != "common-skill" {
		t.Errorf("技能名称错误: %s", skill.Name)
	}
	if !skill.Conflict {
		t.Errorf("同名技能应标记为冲突")
	}
	if skill.Enableable {
		t.Errorf("冲突的技能不应可启用")
	}
	if len(skill.Sources) != 2 {
		t.Errorf("应有 2 个来源，实际有 %d 个", len(skill.Sources))
	}

	// 验证两个来源都已记录
	sourceSet := make(map[string]bool)
	for _, s := range skill.Sources {
		sourceSet[s.Source] = true
	}
	if !sourceSet[sourceDir1] {
		t.Errorf("缺少来源: %s", sourceDir1)
	}
	if !sourceSet[sourceDir2] {
		t.Errorf("缺少来源: %s", sourceDir2)
	}
}

// ========== TestScanMultipleDirsEmptyDirs ==========

func TestScanMultipleDirsEmptyDirs(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)

	mgr := skill.NewManager()
	skills := mgr.ScanMultipleDirs([]string{})

	if len(skills) != 0 {
		t.Fatalf("空目录列表应返回空结果，实际得到 %d 个技能", len(skills))
	}
}

// ========== TestScanMultipleDirsMixed ==========

func TestScanMultipleDirsMixed(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)

	sourceDir1 := filepath.Join(t.TempDir(), "source1")
	sourceDir2 := filepath.Join(t.TempDir(), "source2")
	if err := os.MkdirAll(sourceDir1, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(sourceDir2, 0755); err != nil {
		t.Fatal(err)
	}

	// source1: skill-a 和 shared
	if err := createSkillDir(sourceDir1, "skill-a", "独占技能A"); err != nil {
		t.Fatal(err)
	}
	if err := createSkillDir(sourceDir1, "shared", "来源1的共享技能"); err != nil {
		t.Fatal(err)
	}

	// source2: skill-b 和 shared
	if err := createSkillDir(sourceDir2, "skill-b", "独占技能B"); err != nil {
		t.Fatal(err)
	}
	if err := createSkillDir(sourceDir2, "shared", "来源2的共享技能"); err != nil {
		t.Fatal(err)
	}

	mgr := skill.NewManager()
	skills := mgr.ScanMultipleDirs([]string{sourceDir1, sourceDir2})

	if len(skills) != 3 {
		t.Fatalf("期望 3 个技能，实际得到 %d 个", len(skills))
	}

	// 验证独占技能没有冲突
	for _, s := range skills {
		switch s.Name {
		case "skill-a":
			if s.Conflict {
				t.Errorf("skill-a 不应有冲突")
			}
			if !s.Enableable {
				t.Errorf("skill-a 应可启用")
			}
			if len(s.Sources) != 1 {
				t.Errorf("skill-a 应有 1 个来源，实际有 %d 个", len(s.Sources))
			}
		case "skill-b":
			if s.Conflict {
				t.Errorf("skill-b 不应有冲突")
			}
			if !s.Enableable {
				t.Errorf("skill-b 应可启用")
			}
			if len(s.Sources) != 1 {
				t.Errorf("skill-b 应有 1 个来源，实际有 %d 个", len(s.Sources))
			}
		case "shared":
			if !s.Conflict {
				t.Errorf("shared 应有冲突")
			}
			if s.Enableable {
				t.Errorf("shared 不应可启用")
			}
			if len(s.Sources) != 2 {
				t.Errorf("shared 应有 2 个来源，实际有 %d 个", len(s.Sources))
			}
		default:
			t.Errorf("未知技能名称: %s", s.Name)
		}
	}
}

// ========== TestScanWithGlobalMergesCorrectly ==========

func TestScanWithGlobalMergesCorrectly(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)

	// 全局技能目录
	globalSkillsDir := filepath.Join(configHome, "opencode", "skills")
	if err := os.MkdirAll(globalSkillsDir, 0755); err != nil {
		t.Fatal(err)
	}

	// 来源目录
	sourceDir := filepath.Join(t.TempDir(), "source1")
	if err := os.MkdirAll(sourceDir, 0755); err != nil {
		t.Fatal(err)
	}

	// 在来源目录中创建一个技能
	if err := createSkillDir(sourceDir, "source-skill", "来源目录中的技能"); err != nil {
		t.Fatal(err)
	}

	// 在全局目录中创建一个技能
	if err := createSkillDir(globalSkillsDir, "global-skill", "全局目录中的技能"); err != nil {
		t.Fatal(err)
	}

	// 在全局目录中创建 source-skill 的链接目录（使 IsLinked 返回 true）
	if err := os.MkdirAll(filepath.Join(globalSkillsDir, "source-skill"), 0755); err != nil {
		t.Fatal(err)
	}
	// 在链接目录中也写入 SKILL.md，使 GetAllSkills 能找到它
	if err := os.WriteFile(filepath.Join(globalSkillsDir, "source-skill", "SKILL.md"),
		[]byte(skillFrontmatterContent("链接版本的技能")), 0644); err != nil {
		t.Fatal(err)
	}

	mgr := skill.NewManager()
	skills := mgr.ScanWithGlobal([]string{sourceDir})

	// 应返回 2 个技能：source-skill 和 global-skill
	if len(skills) != 2 {
		t.Fatalf("期望 2 个技能，实际得到 %d 个", len(skills))
	}

	// 验证 global-skill 来自全局
	var globalSkill, sourceSkill bool
	for _, s := range skills {
		switch s.Name {
		case "global-skill":
			globalSkill = true
			if s.Source != "global" {
				t.Errorf("global-skill 来源应为 'global'，实际为 '%s'", s.Source)
			}
			if !s.Linked {
				t.Errorf("global-skill 应标记为已链接")
			}
			if !s.Enableable {
				t.Errorf("global-skill 应可启用")
			}
			if s.Conflict {
				t.Errorf("global-skill 不应有冲突")
			}
		case "source-skill":
			sourceSkill = true
			if s.Source != sourceDir {
				t.Errorf("source-skill 来源应为 '%s'，实际为 '%s'", sourceDir, s.Source)
			}
			if !s.Linked {
				t.Errorf("source-skill 在全局目录有链接，应标记为已链接")
			}
			if !s.Enableable {
				t.Errorf("source-skill 应可启用")
			}
			if s.Conflict {
				t.Errorf("source-skill 不应有冲突")
			}
		default:
			t.Errorf("未知技能名称: %s", s.Name)
		}
	}

	if !globalSkill {
		t.Errorf("结果中缺少 global-skill")
	}
	if !sourceSkill {
		t.Errorf("结果中缺少 source-skill")
	}
}

// ========== TestAggregatedSourceInfo ==========

func TestAggregatedSourceInfo(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)

	sourceDir1 := filepath.Join(t.TempDir(), "source1")
	sourceDir2 := filepath.Join(t.TempDir(), "source2")
	if err := os.MkdirAll(sourceDir1, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(sourceDir2, 0755); err != nil {
		t.Fatal(err)
	}

	// 两个来源中都有同名技能（冲突场景）
	if err := createSkillDir(sourceDir1, "my-skill", "独有技能"); err != nil {
		t.Fatal(err)
	}
	if err := createSkillDir(sourceDir2, "my-skill", "共享技能"); err != nil {
		t.Fatal(err)
	}

	mgr := skill.NewManager()
	skills := mgr.ScanMultipleDirs([]string{sourceDir1, sourceDir2})

	if len(skills) != 1 {
		t.Fatalf("期望 1 个技能，实际得到 %d 个", len(skills))
	}

	skill := skills[0]
	if len(skill.Sources) != 2 {
		t.Fatalf("期望 2 个来源，实际有 %d 个", len(skill.Sources))
	}

	// 验证每个 AggregatedSourceInfo 的字段
	for _, src := range skill.Sources {
		if src.Path == "" {
			t.Errorf("来源路径不应为空")
		}
		if src.Source == "" {
			t.Errorf("来源标记不应为空")
		}
		// 验证 SKILL.md 确实存在于来源路径
		skillMD := filepath.Join(src.Path, "SKILL.md")
		if _, err := os.Stat(skillMD); err != nil {
			t.Errorf("来源路径中缺少 SKILL.md: %s", src.Path)
		}
	}

	// 验证主 Path 是第一个来源的路径
	if skill.Path != skill.Sources[0].Path {
		t.Errorf("主路径应与第一个来源路径一致")
	}
}

// ========== TestIsLinkedMethod ==========

func TestIsLinkedMethod(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)

	globalSkillsDir := filepath.Join(configHome, "opencode", "skills")
	if err := os.MkdirAll(globalSkillsDir, 0755); err != nil {
		t.Fatal(err)
	}

	mgr := skill.NewManager()

	// 不存在的技能不应被视为已链接
	if mgr.IsLinked("non-existent-skill") {
		t.Errorf("不存在的技能不应被标记为已链接")
	}

	// 创建目录后应被视为已链接
	if err := os.MkdirAll(filepath.Join(globalSkillsDir, "linked-skill"), 0755); err != nil {
		t.Fatal(err)
	}
	if !mgr.IsLinked("linked-skill") {
		t.Errorf("全局目录中存在的技能目录应被标记为已链接")
	}
}

// ========== TestScanSourceDirReturnsCorrectInfo ==========

func TestScanSourceDirReturnsCorrectInfo(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)

	sourceDir := filepath.Join(t.TempDir(), "source")
	if err := os.MkdirAll(sourceDir, 0755); err != nil {
		t.Fatal(err)
	}

	// 创建多个技能
	if err := createSkillDir(sourceDir, "skill-1", "技能1"); err != nil {
		t.Fatal(err)
	}
	if err := createSkillDir(sourceDir, "skill-2", "技能2"); err != nil {
		t.Fatal(err)
	}

	mgr := skill.NewManager()
	infos := mgr.ScanSourceDir(sourceDir, sourceDir)

	if len(infos) != 2 {
		t.Fatalf("期望 2 个来源信息，实际得到 %d 个", len(infos))
	}

	for _, info := range infos {
		if info.Source != sourceDir {
			t.Errorf("来源标记错误: 期望 '%s'，实际 '%s'", sourceDir, info.Source)
		}
		if info.Path == "" {
			t.Errorf("路径不应为空")
		}
		// 验证路径中包含技能目录名
		dirName := filepath.Base(info.Path)
		if dirName != "skill-1" && dirName != "skill-2" {
			t.Errorf("技能路径包含意外的目录名: %s", dirName)
		}
	}
}

// ========== TestScanMultipleDirsWithLinkedStatus ==========

func TestScanMultipleDirsWithLinkedStatus(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)

	globalSkillsDir := filepath.Join(configHome, "opencode", "skills")
	if err := os.MkdirAll(globalSkillsDir, 0755); err != nil {
		t.Fatal(err)
	}

	sourceDir := filepath.Join(t.TempDir(), "source")
	if err := os.MkdirAll(sourceDir, 0755); err != nil {
		t.Fatal(err)
	}

	// 在来源中创建两个技能
	if err := createSkillDir(sourceDir, "linked-skill", "已链接技能"); err != nil {
		t.Fatal(err)
	}
	if err := createSkillDir(sourceDir, "unlinked-skill", "未链接技能"); err != nil {
		t.Fatal(err)
	}

	// 在全局目录中为 linked-skill 创建链接目录
	if err := os.MkdirAll(filepath.Join(globalSkillsDir, "linked-skill"), 0755); err != nil {
		t.Fatal(err)
	}

	mgr := skill.NewManager()
	skills := mgr.ScanMultipleDirs([]string{sourceDir})

	for _, s := range skills {
		switch s.Name {
		case "linked-skill":
			if !s.Linked {
				t.Errorf("linked-skill 应标记为已链接")
			}
		case "unlinked-skill":
			if s.Linked {
				t.Errorf("unlinked-skill 不应标记为已链接")
			}
		}
	}
}
