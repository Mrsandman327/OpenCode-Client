package service_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"oc-manager/skill"
)

func TestSkillManagerReadSkillFileSupportsSymlinkSkillRoot(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	skillRoot := filepath.Join(configHome, "opencode", "skills")
	realSkillDir := filepath.Join(configHome, "real-skill")
	linkedSkillDir := filepath.Join(skillRoot, "linked-skill")
	if err := os.MkdirAll(realSkillDir, 0755); err != nil { t.Fatalf("创建真实技能目录失败: %v", err) }
	if err := os.MkdirAll(skillRoot, 0755); err != nil { t.Fatalf("创建技能根目录失败: %v", err) }
	if err := os.WriteFile(filepath.Join(realSkillDir, "SKILL.md"), []byte("# linked\n"), 0644); err != nil { t.Fatalf("写入 SKILL.md 失败: %v", err) }
	if runtime.GOOS == "windows" {
		cmd := exec.Command("cmd", "/c", "mklink", "/J", linkedSkillDir, realSkillDir)
		if err := cmd.Run(); err != nil { t.Skipf("当前环境不支持目录联接测试: %v", err) }
	} else {
		if err := os.Symlink(realSkillDir, linkedSkillDir); err != nil { t.Skipf("当前环境不支持技能软链接测试: %v", err) }
	}

	mgr := skill.NewManager()
	content, err := mgr.ReadSkillFile(linkedSkillDir, "SKILL.md")
	if err != nil { t.Fatalf("软链接技能目录读取 SKILL.md 失败: %v", err) }
	if content.Content != "# linked\n" { t.Fatalf("软链接技能文件内容异常: %q", content.Content) }
}

func TestSkillManagerListSkillFilesSupportsSymlinkSkillRoot(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	skillRoot := filepath.Join(configHome, "opencode", "skills")
	realSkillDir := filepath.Join(configHome, "real-skill")
	linkedSkillDir := filepath.Join(skillRoot, "linked-skill")
	if err := os.MkdirAll(realSkillDir, 0755); err != nil { t.Fatalf("创建真实技能目录失败: %v", err) }
	if err := os.MkdirAll(skillRoot, 0755); err != nil { t.Fatalf("创建技能根目录失败: %v", err) }
	if err := os.WriteFile(filepath.Join(realSkillDir, "SKILL.md"), []byte("# linked\n"), 0644); err != nil { t.Fatalf("写入 SKILL.md 失败: %v", err) }
	if runtime.GOOS == "windows" {
		cmd := exec.Command("cmd", "/c", "mklink", "/J", linkedSkillDir, realSkillDir)
		if err := cmd.Run(); err != nil { t.Skipf("当前环境不支持目录联接测试: %v", err) }
	} else {
		if err := os.Symlink(realSkillDir, linkedSkillDir); err != nil { t.Skipf("当前环境不支持技能软链接测试: %v", err) }
	}

	mgr := skill.NewManager()
	tree, err := mgr.ListSkillFiles(linkedSkillDir)
	if err != nil { t.Fatalf("软链接技能目录列树失败: %v", err) }
	if tree.Name != "linked-skill" { t.Fatalf("软链接技能目录根名称异常: %s", tree.Name) }
	if len(tree.Children) == 0 || tree.Children[0].Name != "SKILL.md" { t.Fatalf("软链接技能目录未正确列出 SKILL.md: %+v", tree.Children) }
}
