// Package skill 管理 opencode 技能：扫描技能目录、检测链接状态、读写 SKILL.md。
package skill

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"oc-manager/model"
)

// Manager 管理 opencode 技能。
type Manager struct {
	globalDir string // ~/.config/opencode/skills/
}

// NewManager 创建新的 Manager 实例。
func NewManager() *Manager {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir != "" {
		return &Manager{
			globalDir: filepath.Join(dir, "opencode", "skills"),
		}
	}

	homeDir, _ := os.UserHomeDir()
	return &Manager{
		globalDir: filepath.Join(homeDir, ".config", "opencode", "skills"),
	}
}

// SourceDir 返回 opencode 技能目录路径。
func (m *Manager) SourceDir() string {
	return m.globalDir
}

// skillFrontmatter SKILL.md frontmatter 解析结果。
type skillFrontmatter struct {
	Name        string
	Description string
}

// GetAllSkills 扫描 opencode 技能目录，兼容软链接和真实目录。
func (m *Manager) GetAllSkills() []model.SkillInfo {
	return m.scanDir(m.globalDir, "global", "")
}

// scanDir 递归扫描目录，兼容软链接（Junction）和真实目录。
// prefix 为相对路径前缀，用于递归时拼接完整技能名称（如 "superpowers/brainstorming"）。
func (m *Manager) scanDir(dir, source, prefix string) []model.SkillInfo {
	skills := make([]model.SkillInfo, 0)

	entries, err := os.ReadDir(dir)
	if err != nil {
		return skills
	}

	for _, entry := range entries {
		entryName := entry.Name()
		skillPath := filepath.Join(dir, entryName)
		relName := entryName
		if prefix != "" {
			relName = prefix + "/" + entryName
		}

		// 检查该路径下是否有 SKILL.md（os.Stat 会跟随 Junction 到目标目录）
		skillMD := filepath.Join(skillPath, "SKILL.md")
		if _, err := os.Stat(skillMD); err != nil {
			// 没有 SKILL.md，但如果路径是目录（或 Junction）则递归扫描子目录
			info, err2 := os.Stat(skillPath)
			if err2 == nil && info.IsDir() {
				subSkills := m.scanDir(skillPath, source, relName)
				skills = append(skills, subSkills...)
			}
			continue
		}
		// 解析 SKILL.md 获取 frontmatter 信息（name 用于标题，但显示名仍用路径）
		displayName := relName
		desc := ""
		if data, err := os.ReadFile(skillMD); err == nil {
			fm, _ := parseFrontmatter(data)
			desc = fm.Description
		}

		// 检测链接状态
		linked := true
		linkPath := filepath.Join(m.globalDir, relName)
		if info, err := os.Lstat(linkPath); err == nil {
			linked = (info.Mode()&os.ModeSymlink != 0) || info.IsDir()
		}

		skills = append(skills, model.SkillInfo{
			Name:        displayName,
			Description: desc,
			Path:        skillPath,
			Linked:      linked,
			Source:      source,
		})

		// 递归扫描子目录
		subSkills := m.scanDir(skillPath, source, relName)
		skills = append(skills, subSkills...)
	}

	return skills
}

// ReadSkillContent 读取指定技能目录下的 SKILL.md 完整内容。
func (m *Manager) ReadSkillContent(skillPath string) (string, error) {
	mdPath := filepath.Join(skillPath, "SKILL.md")
	data, err := os.ReadFile(mdPath)
	if err != nil {
		return "", fmt.Errorf("读取 SKILL.md 失败: %w", err)
	}
	return string(data), nil
}

// SaveSkillContent 保存 SKILL.md 内容到指定技能目录。
func (m *Manager) SaveSkillContent(skillPath, content string) error {
	root, err := m.resolveSkillPath(skillPath)
	if err != nil {
		return err
	}
	mdPath := filepath.Join(root, "SKILL.md")
	return os.WriteFile(mdPath, []byte(content), 0644)
}

// ListSkillFiles 返回技能根目录下的只读文件树。
func (m *Manager) ListSkillFiles(skillPath string) (model.SkillFileNode, error) {
	root, err := m.resolveSkillPath(skillPath)
	if err != nil {
		return model.SkillFileNode{}, err
	}
	node, err := m.buildSkillFileTree(root, root, true)
	if err != nil {
		return model.SkillFileNode{}, err
	}
	node.Name = filepath.Base(filepath.Clean(skillPath))
	return node, nil
}

// ReadSkillFile 读取技能根目录内的文本文件。
func (m *Manager) ReadSkillFile(skillPath, relativePath string) (model.SkillContent, error) {
	root, err := m.resolveSkillPath(skillPath)
	if err != nil {
		return model.SkillContent{}, err
	}
	target, rel, err := m.resolveSkillRelativePath(root, relativePath)
	if err != nil {
		return model.SkillContent{}, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return model.SkillContent{}, fmt.Errorf("读取技能文件失败: %w", err)
	}
	if info.IsDir() {
		return model.SkillContent{}, fmt.Errorf("目标不是文本文件")
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return model.SkillContent{}, fmt.Errorf("读取技能文件失败: %w", err)
	}
	if !isTextContent(data) {
		return model.SkillContent{}, fmt.Errorf("仅支持预览文本文件")
	}
	return model.SkillContent{Path: rel, Content: string(data)}, nil
}

// SaveSkillFile 保存技能根目录内的文本文件。
func (m *Manager) SaveSkillFile(skillPath, relativePath, content string) error {
	root, err := m.resolveSkillPath(skillPath)
	if err != nil {
		return err
	}
	target, _, err := m.resolveSkillRelativePath(root, relativePath)
	if err != nil {
		return err
	}
	info, err := os.Stat(target)
	if err != nil {
		return fmt.Errorf("读取技能文件失败: %w", err)
	}
	if info.IsDir() {
		return fmt.Errorf("目标不是文本文件")
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return fmt.Errorf("读取技能文件失败: %w", err)
	}
	if !isTextContent(data) {
		return fmt.Errorf("仅支持编辑文本文件")
	}
	return os.WriteFile(target, []byte(content), info.Mode().Perm())
}

// ToggleSkill 切换技能链接状态。
func (m *Manager) ToggleSkill(skillPath, skillName string, enable bool) (bool, error) {
	linkPath := filepath.Join(m.globalDir, skillName)

	if enable {
		if runtime.GOOS == "windows" {
			cmd := exec.Command("cmd", "/c", "mklink", "/J", linkPath, skillPath)
			if err := cmd.Run(); err != nil {
				if err := os.Symlink(skillPath, linkPath); err != nil {
					return false, fmt.Errorf("创建符号链接失败: %w", err)
				}
			}
		} else {
			if err := os.Symlink(skillPath, linkPath); err != nil {
				return false, fmt.Errorf("创建符号链接失败: %w", err)
			}
		}
		return true, nil
	} else {
		if err := os.Remove(linkPath); err != nil && !os.IsNotExist(err) {
			return false, fmt.Errorf("删除符号链接失败: %w", err)
		}
		return false, nil
	}
}

// parseFrontmatter 手动解析 Markdown YAML frontmatter。
// func parseFrontmatter(data []byte) (skillFrontmatter, error) {
// 	content := string(data)
// 	if len(content) < 4 || content[:3] != "---" {
// 		return skillFrontmatter{}, fmt.Errorf("无 frontmatter")
// 	}
// 	rest := content[3:]
// 	end := strings.Index(rest, "\n---")
// 	if end == -1 {
// 		// 尝试 "---" 紧跟 rest
// 		end = strings.Index(rest, "---")
// 	}
// 	if end == -1 {
// 		return skillFrontmatter{}, fmt.Errorf("frontmatter 未闭合")
// 	}
// 	fmText := rest[:end]
// 	var fm skillFrontmatter
// 	for _, line := range strings.Split(fmText, "\n") {
// 		line = strings.TrimSpace(line)
// 		if line == "" || strings.HasPrefix(line, "#") {
// 			continue
// 		}
// 		parts := strings.SplitN(line, ":", 2)
// 		if len(parts) != 2 {
// 			continue
// 		}
// 		key := strings.TrimSpace(parts[0])
// 		val := strings.TrimSpace(parts[1])
// 		val = strings.Trim(val, `"`)
// 		switch key {
// 		case "name":
// 			fm.Name = val
// 		case "description":
// 			fm.Description = val
// 		}
// 	}
// 	return fm, nil
// }

func parseFrontmatter(data []byte) (skillFrontmatter, error) {
    content := string(data)
    if len(content) < 4 || content[:3] != "---" {
        return skillFrontmatter{}, fmt.Errorf("无 frontmatter")
    }
    rest := content[3:]
    end := strings.Index(rest, "\n---")
    if end == -1 {
        end = strings.Index(rest, "---")
    }
    if end == -1 {
        return skillFrontmatter{}, fmt.Errorf("frontmatter 未闭合")
    }
    yamlText := rest[:end]

    var fm skillFrontmatter
    lines := strings.Split(yamlText, "\n")
    var currentKey string
    var currentValue []string

    for i := 0; i < len(lines); i++ {
        line := lines[i]
        // 判断是否为缩进行（以空格或 tab 开头，且不是空行）
        if (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")) && currentKey != "" {
            // 多行值续接
            trimmed := strings.TrimSpace(line)
            if trimmed != "" {
                currentValue = append(currentValue, trimmed)
            }
            continue
        }

        // 新键值对
        line = strings.TrimSpace(line)
        if line == "" || strings.HasPrefix(line, "#") {
            continue
        }
        parts := strings.SplitN(line, ":", 2)
        if len(parts) != 2 {
            continue
        }
        key := strings.TrimSpace(parts[0])
        val := strings.TrimSpace(parts[1])

        // 保存上一个字段（如果正在处理）
        if currentKey != "" {
            switch currentKey {
            case "name":
                fm.Name = strings.Join(currentValue, " ")
            case "description":
                fm.Description = strings.Join(currentValue, " ")
            }
        }

        // 重置当前状态
        currentKey = key
        currentValue = []string{val}
    }

    // 处理最后一个字段
    if currentKey != "" {
        switch currentKey {
        case "name":
            fm.Name = strings.Join(currentValue, " ")
        case "description":
            fm.Description = strings.Join(currentValue, " ")
        }
    }

	return fm, nil
}

func (m *Manager) resolveSkillPath(skillPath string) (string, error) {
	root, err := filepath.Abs(skillPath)
	if err != nil {
		return "", fmt.Errorf("解析技能目录失败: %w", err)
	}
	base, err := filepath.Abs(m.globalDir)
	if err != nil {
		return "", fmt.Errorf("解析技能根目录失败: %w", err)
	}
	declaredRel, err := filepath.Rel(base, root)
	if err != nil {
		return "", fmt.Errorf("校验技能目录失败: %w", err)
	}
	if declaredRel == "." || declaredRel == "" || declaredRel == ".." || strings.HasPrefix(declaredRel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("仅允许访问技能根目录内的技能")
	}
	info, err := os.Stat(root)
	if err != nil {
		return "", fmt.Errorf("读取技能目录失败: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("技能路径不是目录")
	}
	return root, nil
}

func (m *Manager) resolveSkillRelativePath(root, relativePath string) (string, string, error) {
	cleanRel := filepath.Clean(relativePath)
	if cleanRel == "." || cleanRel == "" {
		return "", "", fmt.Errorf("文件路径不能为空")
	}
	if cleanRel == ".." || strings.HasPrefix(cleanRel, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("仅允许访问技能根目录内的文件")
	}
	target := filepath.Join(root, cleanRel)
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return "", "", fmt.Errorf("解析技能文件失败: %w", err)
	}
	rel, err := filepath.Rel(root, absTarget)
	if err != nil {
		return "", "", fmt.Errorf("校验技能文件失败: %w", err)
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("仅允许访问技能根目录内的文件")
	}
	return absTarget, filepath.ToSlash(rel), nil
}

func (m *Manager) buildSkillFileTree(root, current string, isRoot bool) (model.SkillFileNode, error) {
	info, err := os.Stat(current)
	if err != nil {
		return model.SkillFileNode{}, fmt.Errorf("读取技能目录失败: %w", err)
	}
	rel := "."
	if !isRoot {
		rel, err = filepath.Rel(root, current)
		if err != nil {
			return model.SkillFileNode{}, fmt.Errorf("计算技能相对路径失败: %w", err)
		}
	}
	node := model.SkillFileNode{
		Name: info.Name(),
		Path: filepath.ToSlash(rel),
		Type: "file",
	}
	if isRoot {
		node.Name = filepath.Base(root)
		node.Path = "."
	}
	if !info.IsDir() {
		return node, nil
	}
	node.Type = "dir"
	entries, err := os.ReadDir(current)
	if err != nil {
		return model.SkillFileNode{}, fmt.Errorf("读取技能目录失败: %w", err)
	}
	sort.Slice(entries, func(i, j int) bool {
		leftName := entries[i].Name()
		rightName := entries[j].Name()
		if leftName == "SKILL.md" || rightName == "SKILL.md" {
			return leftName == "SKILL.md"
		}
		leftDir := entries[i].IsDir()
		rightDir := entries[j].IsDir()
		if leftDir != rightDir {
			return leftDir
		}
		return leftName < rightName
	})
	for _, entry := range entries {
		childPath := filepath.Join(current, entry.Name())
		childInfo, err := os.Stat(childPath)
		if err != nil {
			continue
		}
		if childInfo.IsDir() {
			child, err := m.buildSkillFileTree(root, childPath, false)
			if err == nil {
				node.Children = append(node.Children, child)
			}
			continue
		}
		childRel, err := filepath.Rel(root, childPath)
		if err != nil {
			continue
		}
		node.Children = append(node.Children, model.SkillFileNode{
			Name: entry.Name(),
			Path: filepath.ToSlash(childRel),
			Type: "file",
		})
	}
	return node, nil
}

func isTextContent(data []byte) bool {
	for _, b := range data {
		if b == 0 {
			return false
		}
	}
	return true
}
