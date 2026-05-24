package skill

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"oc-manager/model"
)

// Manager 管理 opencode 技能。
type Manager struct {
	globalDir string
}

// NewManager 创建新的 Manager 实例，指向全局 opencode 技能目录。
func NewManager() *Manager {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir != "" {
		return &Manager{globalDir: filepath.Join(dir, "opencode", "skills")}
	}
	homeDir, _ := os.UserHomeDir()
	return &Manager{globalDir: filepath.Join(homeDir, ".config", "opencode", "skills")}
}

// NewManagerWithDir 创建指向指定技能目录的 Manager 实例。
func NewManagerWithDir(skillsDir string) *Manager {
	return &Manager{globalDir: skillsDir}
}

// SourceDir 返回 opencode 技能目录路径。
func (m *Manager) SourceDir() string {
	return m.globalDir
}

func (m *Manager) resolveSkillPath(skillPath string) (string, error) {
	root, err := filepath.Abs(skillPath)
	if err != nil {
		return "", fmt.Errorf("解析技能目录失败: %w", err)
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
