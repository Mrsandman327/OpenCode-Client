// Package skill 管理技能的核心逻辑：扫描源目录、检测链接状态、创建/删除链接。
package skill

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"oc-manager/model"
)

// Manager 管理技能的核心逻辑：扫描源目录、检测链接状态、创建/删除链接。
type Manager struct {
	sourceDir string
	targets   []model.TargetInfo
}

// NewManager 创建新的 Manager 实例。
func NewManager() *Manager {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		homeDir = os.Getenv("USERPROFILE")
	}

	return &Manager{
		sourceDir: filepath.Join(homeDir, ".cc-switch", "skills"),
		targets: []model.TargetInfo{
			{Key: "opencode", Label: "OpenCode", Path: filepath.Join(homeDir, ".config", "opencode", "skills")},
			{Key: "claude", Label: "Claude Code", Path: filepath.Join(homeDir, ".claude", "skills")},
			{Key: "codex", Label: "Codex", Path: filepath.Join(homeDir, ".codex", "skills")},
		},
	}
}

// GetTargets 返回已配置的目标平台列表。
func (m *Manager) GetTargets() []model.TargetInfo {
	return m.targets
}

// SourceDir 返回技能源目录路径。
func (m *Manager) SourceDir() string {
	return m.sourceDir
}

// GetAllSkills 扫描源目录，返回所有技能及其在各平台的链接状态。
func (m *Manager) GetAllSkills() []model.SkillInfo {
	entries, err := os.ReadDir(m.sourceDir)
	if err != nil {
		return nil
	}

	skills := make([]model.SkillInfo, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		// 跳过隐藏目录
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}

		skillPath := filepath.Join(m.sourceDir, entry.Name())
		meta := parseSkillMeta(skillPath)

		// 始终以目录名作为技能主键（Name），保证文件系统操作正确
		// SKILL.md 的 frontmatter name 可能和目录名不一致（如 afsim vs afsim-scripts）
		displayName := meta.Name
		if displayName == "" || displayName == entry.Name() {
			displayName = entry.Name()
		}

		si := model.SkillInfo{
			Name:        entry.Name(), // 目录名 = 文件系统主键
			Description: meta.Description,
			SourcePath:  skillPath,
			Targets:     make(map[string]bool),
		}

		// 如果 frontmatter 名与目录名不同，在描述前追加显示名
		if meta.Name != "" && meta.Name != entry.Name() {
			if si.Description != "" {
				si.Description = "[" + meta.Name + "] " + si.Description
			} else {
				si.Description = "[" + meta.Name + "]"
			}
		}

		// 检测各平台的链接状态
		for _, t := range m.targets {
			si.Targets[t.Key] = isLinked(skillPath, t.Path)
		}

		skills = append(skills, si)
	}

	return skills
}

// skillMeta 从 SKILL.md 解析出的元数据。
type skillMeta struct {
	Name        string
	Description string
}

// parseSkillMeta 解析技能目录中 SKILL.md 的 YAML frontmatter。
func parseSkillMeta(skillPath string) skillMeta {
	skillMd := filepath.Join(skillPath, "SKILL.md")
	data, err := os.ReadFile(skillMd)
	if err != nil {
		return skillMeta{}
	}

	content := string(data)
	return skillMeta{
		Name:        extractFrontmatterField(content, "name"),
		Description: extractFrontmatterField(content, "description"),
	}
}

// extractFrontmatterField 从 YAML frontmatter 中提取指定字段的值。
// 简单解析，避免引入完整的 YAML 解析库依赖。
func extractFrontmatterField(content, field string) string {
	// 检查是否以 --- 开头（frontmatter 标记）
	if !strings.HasPrefix(content, "---") {
		return ""
	}

	// 找到第二个 --- 的位置
	lines := strings.Split(content, "\n")
	inFrontmatter := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "---" {
			if !inFrontmatter {
				inFrontmatter = true
				continue
			} else {
				break // frontmatter 结束
			}
		}
		if inFrontmatter {
			// 解析 "field: value" 格式
			if strings.HasPrefix(trimmed, field+":") {
				value := strings.TrimSpace(strings.TrimPrefix(trimmed, field+":"))
				// 去掉可能的引号
				value = strings.Trim(value, "\"'")
				return value
			}
		}
	}

	return ""
}

// ========== 技能链接操作 ==========

// ToggleSkill 切换某个技能在指定目标的链接状态。
func (m *Manager) ToggleSkill(skillName, target string, enable bool) (bool, error) {
	// 查找目标平台配置
	var targetPath string
	for _, t := range m.targets {
		if t.Key == target {
			targetPath = t.Path
			break
		}
	}
	if targetPath == "" {
		return false, fmt.Errorf("未知的目标平台: %s", target)
	}

	// 确保目标目录存在
	if err := os.MkdirAll(targetPath, 0755); err != nil {
		return false, fmt.Errorf("无法创建目标目录 %s: %w", targetPath, err)
	}

	skillPath := filepath.Join(m.sourceDir, skillName)
	if _, err := os.Stat(skillPath); os.IsNotExist(err) {
		return false, fmt.Errorf("技能目录不存在: %s", skillPath)
	}

	linkPath := filepath.Join(targetPath, skillName)

	if enable {
		// 如果已经链接，先移除再创建
		if isLinked(skillPath, targetPath) {
			if err := removeLink(linkPath); err != nil {
				return false, fmt.Errorf("移除已有链接失败: %w", err)
			}
		}
		if err := createLink(skillPath, linkPath); err != nil {
			return false, fmt.Errorf("创建链接失败: %w", err)
		}
		return true, nil
	} else {
		if err := removeLink(linkPath); err != nil {
			// 如果链接本就不存在，不算错误
			if os.IsNotExist(err) {
				return false, nil
			}
			return false, fmt.Errorf("移除链接失败: %w", err)
		}
		return false, nil
	}
}

// ToggleAll 批量切换某个目标平台下所有技能的链接状态。
func (m *Manager) ToggleAll(target string, enable bool) []error {
	skills := m.GetAllSkills()
	errs := make([]error, 0)

	for _, sk := range skills {
		_, err := m.ToggleSkill(sk.Name, target, enable)
		if err != nil {
			errs = append(errs, err)
		}
	}

	return errs
}

// ========== 符号链接操作 ==========

// createLink 创建从 source 到 dest 的目录符号链接。
// Windows 上优先使用 os.Symlink（需要开发者模式），
// 失败时回退到 mklink /J（目录联接，无需管理员权限）。
func createLink(source, dest string) error {
	// 确保目标父目录存在
	destDir := filepath.Dir(dest)
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return fmt.Errorf("创建目标目录失败: %w", err)
	}

	// 先尝试标准符号链接
	err := os.Symlink(source, dest)
	if err == nil {
		return nil
	}

	// Windows 回退：使用 mklink /J 创建目录联接
	if runtime.GOOS == "windows" {
		return createJunction(source, dest)
	}

	return fmt.Errorf("创建符号链接失败: %w", err)
}

// removeLink 安全地移除符号链接或目录联接。
// 只移除链接本身，不会删除源目录内容。
func removeLink(linkPath string) error {
	info, err := os.Lstat(linkPath)
	if err != nil {
		return err
	}

	// 符号链接：直接删除
	if info.Mode()&os.ModeSymlink != 0 {
		return os.Remove(linkPath)
	}

	// 目录联接：Windows 上需要用特殊方式删除
	if runtime.GOOS == "windows" && isReparsePoint(linkPath) {
		return removeJunction(linkPath)
	}

	// 普通目录不应该通过此函数删除，防止误删
	return fmt.Errorf("路径存在但不是链接，拒绝删除: %s", linkPath)
}

// createJunction 在 Windows 上创建目录联接（Junction）。
// 目录联接不要求管理员权限，且对大多数程序透明。
func createJunction(source, dest string) error {
	// mklink /J 在 cmd 中运行，需要绝对路径
	absSource, err := filepath.Abs(source)
	if err != nil {
		return fmt.Errorf("获取源目录绝对路径失败: %w", err)
	}
	absDest, err := filepath.Abs(dest)
	if err != nil {
		return fmt.Errorf("获取目标路径失败: %w", err)
	}

	// 如果目标已存在（且是联接点），先删除
	if isReparsePoint(absDest) {
		if err := removeJunction(absDest); err != nil {
			return err
		}
	}

	cmd := exec.Command("cmd", "/c", "mklink", "/J", absDest, absSource)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("mklink /J 失败: %w\n输出: %s", err, strings.TrimSpace(string(output)))
	}

	return nil
}

// removeJunction 在 Windows 上删除目录联接（Junction）。
// 使用 rmdir 而非 rd /s，因为 /s 会删除目录内容。
func removeJunction(junctionPath string) error {
	cmd := exec.Command("cmd", "/c", "rmdir", junctionPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("rmdir 失败: %w\n输出: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// isReparsePoint 检测路径是否为 Windows 重解析点（Reparse Point）。
// Go 1.23+ 的 os.Readlink 在 Windows 上通过 FSCTL_GET_REPARSE_POINT 实现，
// 能正确识别符号链接和目录联接（Junction）。
func isReparsePoint(path string) bool {
	if runtime.GOOS != "windows" {
		return false
	}
	_, err := os.Readlink(path)
	return err == nil
}

// isLinked 检查技能是否在目标目录中存在有效的链接（符号链接或目录联接）。
// 本函数在 skills.go 中通过 isReparsePoint 间接调用，此处提供备选实现。
func isLinked(skillPath, targetDir string) bool {
	skillName := filepath.Base(skillPath)
	linkPath := filepath.Join(targetDir, skillName)

	info, err := os.Lstat(linkPath)
	if err != nil {
		return false
	}

	// 符号链接
	if info.Mode()&os.ModeSymlink != 0 {
		return true
	}

	// Windows 目录联接
	if runtime.GOOS == "windows" && info.IsDir() {
		return isReparsePoint(linkPath)
	}

	return false
}
