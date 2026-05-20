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
	"syscall"

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
// 返回的技能标记 NoSources=true（无来源目录模式）。
func (m *Manager) GetAllSkills() []model.SkillInfo {
	skills := m.scanDir(m.globalDir, "global", "")
	for i := range skills {
		skills[i].NoSources = true
		skills[i].Enableable = false
	}
	return skills
}

// ScanSourceDir 扫描单个来源目录并返回该目录下所有技能的来源信息。
// sourceName 为来源目录路径，用于标记技能来自哪个来源。
func (m *Manager) ScanSourceDir(dir string, sourceName string) []model.AggregatedSourceInfo {
	return m.scanSourceRecursive(dir, sourceName, "")
}

// scanSourceRecursive 递归扫描目录，查找所有包含 SKILL.md 的子目录，
// 返回每个技能路径及其来源信息。
// prefix 为相对路径前缀，用于嵌套技能名称拼接。
func (m *Manager) scanSourceRecursive(dir, sourceName, prefix string) []model.AggregatedSourceInfo {
	var result []model.AggregatedSourceInfo

	entries, err := os.ReadDir(dir)
	if err != nil {
		return result
	}

	for _, entry := range entries {
		entryName := entry.Name()
		skillPath := filepath.Join(dir, entryName)
		relName := entryName
		if prefix != "" {
			relName = prefix + "/" + entryName
		}

		// 检查该路径下是否有 SKILL.md
		skillMD := filepath.Join(skillPath, "SKILL.md")
		if _, err := os.Stat(skillMD); err != nil {
			// 没有 SKILL.md，如果是目录则递归扫描子目录
			info, err2 := os.Stat(skillPath)
			if err2 == nil && info.IsDir() {
				subResults := m.scanSourceRecursive(skillPath, sourceName, relName)
				result = append(result, subResults...)
			}
			continue
		}

		// 找到一个技能
		result = append(result, model.AggregatedSourceInfo{
			Path:   skillPath,
			Source: sourceName,
		})

		// 递归扫描子目录（技能目录内可能嵌套子技能）
		subResults := m.scanSourceRecursive(skillPath, sourceName, relName)
		result = append(result, subResults...)
	}

	return result
}

// ScanMultipleDirs 扫描多个来源目录，聚合结果并检测冲突。
// dirs: 来源目录路径列表
// 返回聚合后的技能列表，包含冲突标记和来源信息。
func (m *Manager) ScanMultipleDirs(dirs []string) []model.SkillInfo {
	// 按技能名称聚合：skillName -> 来源列表
	type aggregate struct {
		sources []model.AggregatedSourceInfo
		primary model.AggregatedSourceInfo // 第一个发现的来源作为主来源
	}
	aggregates := make(map[string]*aggregate)

	for _, dir := range dirs {
		infos := m.ScanSourceDir(dir, dir)
		for _, info := range infos {
			// 计算技能名称：技能路径相对于来源目录的相对路径
			relPath, err := filepath.Rel(dir, info.Path)
			if err != nil {
				continue
			}
			name := filepath.ToSlash(relPath)

			if ag, ok := aggregates[name]; ok {
				ag.sources = append(ag.sources, info)
			} else {
				aggregates[name] = &aggregate{
					sources: []model.AggregatedSourceInfo{info},
					primary: info,
				}
			}
		}
	}

	// 构建 SkillInfo 列表
	skills := make([]model.SkillInfo, 0, len(aggregates))
	for name, ag := range aggregates {
		conflict := len(ag.sources) > 1

		// 从主来源的 SKILL.md 读取描述信息
		desc := ""
		skillMD := filepath.Join(ag.primary.Path, "SKILL.md")
		if data, err := os.ReadFile(skillMD); err == nil {
			fm, _ := parseFrontmatter(data)
			desc = fm.Description
		}

		// 检查是否已在全局目录中链接
		linked := m.IsLinked(name)

		// 冲突时不可启用，无来源时也不可启用
		enableable := !conflict && len(ag.sources) > 0

		skills = append(skills, model.SkillInfo{
			Name:        name,
			Description: desc,
			Path:        ag.primary.Path,
			Linked:      linked,
			Source:      ag.primary.Source,
			Conflict:    conflict,
			Sources:     ag.sources,
			Enableable:  enableable,
		})
	}

	// 按名称排序
	sort.Slice(skills, func(i, j int) bool {
		return skills[i].Name < skills[j].Name
	})

	return skills
}

// IsLinked 检查指定技能名称是否已在全局目录中存在链接（符号链接或 Junction 目录）。
func (m *Manager) IsLinked(skillName string) bool {
	linkPath := filepath.Join(m.globalDir, skillName)
	if info, err := os.Lstat(linkPath); err == nil {
		return (info.Mode()&os.ModeSymlink != 0) || info.IsDir()
	}
	return false
}

// ScanWithGlobal 扫描来源目录和全局目录，返回完整聚合结果。
// 按"来源→全局"顺序扫描，全局目录的技能默认链接态为 true。
// 来源目录中的技能优先显示，全局独有技能附加在末尾。
func (m *Manager) ScanWithGlobal(dirs []string) []model.SkillInfo {
	// 1. 扫描所有来源目录并聚合
	sourceSkills := m.ScanMultipleDirs(dirs)

	// 2. 扫描全局目录
	globalSkills := m.GetAllSkills()

	// 3. 构建来源技能名称集合，用于快速判断是否已存在
	sourceNames := make(map[string]bool, len(sourceSkills))
	for _, s := range sourceSkills {
		sourceNames[s.Name] = true
	}

	// 4. 将全局独有的技能追加到结果中
	for _, g := range globalSkills {
		if sourceNames[g.Name] {
			continue
		}
		sourceSkills = append(sourceSkills, model.SkillInfo{
			Name:        g.Name,
			Description: g.Description,
			Path:        g.Path,
			Linked:      true, // 全局目录中的技能始终视为已链接
			Source:      "global",
			Conflict:    false,
			Sources:     []model.AggregatedSourceInfo{{Path: g.Path, Source: "global"}},
			Enableable:  true,
		})
	}

	// 5. 按名称排序
	sort.Slice(sourceSkills, func(i, j int) bool {
		return sourceSkills[i].Name < sourceSkills[j].Name
	})

	return sourceSkills
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
			//displayName = fm.Name
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
// Windows 上优先用 os.Symlink，失败回退到 mklink /J（目录联接），窗口隐藏。
// 禁用时使用 rmdir 安全删除联接（避免 os.Remove 误删内容）。
// 嵌套技能（如 superpowers/using-git-worktrees）取其顶层目录做链接，
// 整个文件夹启用后 opencode 递归扫描，所有子技能自动可用。
func (m *Manager) ToggleSkill(skillPath, skillName string, enable bool) (bool, error) {
	topName, topSource := resolveTopLevelLink(skillPath, skillName)
	linkPath := filepath.Join(m.globalDir, topName)

	if enable {
		// 如果目标已存在（且是联接点），先安全删除
		if _, err := os.Readlink(linkPath); err == nil {
			if runtime.GOOS == "windows" {
				rmdirCmd := exec.Command("cmd", "/c", "rmdir", linkPath)
				rmdirCmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
				rmdirCmd.Run()
			} else {
				os.Remove(linkPath)
			}
		}

		// 先尝试标准符号链接
		if err := os.Symlink(topSource, linkPath); err == nil {
			return true, nil
		}

		// Windows 回退：mklink /J 目录联接（隐藏窗口）
		if runtime.GOOS == "windows" {
			absSource, _ := filepath.Abs(topSource)
			absDest, _ := filepath.Abs(linkPath)
			cmd := exec.Command("cmd", "/c", "mklink", "/J", absDest, absSource)
			cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
			if output, err := cmd.CombinedOutput(); err != nil {
				return false, fmt.Errorf("创建链接失败: %w\n输出: %s", err, strings.TrimSpace(string(output)))
			}
			return true, nil
		}

		return false, fmt.Errorf("创建符号链接失败")
	} else {
		// 禁用：检测联接类型，安全删除
		if runtime.GOOS == "windows" {
			if _, err := os.Readlink(linkPath); err == nil {
				// 是符号链接或联接，用 rmdir 删除（对符号链接也安全）
				rmCmd := exec.Command("cmd", "/c", "rmdir", linkPath)
				rmCmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
				if output, err := rmCmd.CombinedOutput(); err != nil {
					return false, fmt.Errorf("删除链接失败: %w\n输出: %s", err, strings.TrimSpace(string(output)))
				}
				return false, nil
			}
		}
		if err := os.Remove(linkPath); err != nil && !os.IsNotExist(err) {
			return false, fmt.Errorf("删除链接失败: %w", err)
		}
		return false, nil
	}
}

// resolveTopLevelLink 解析嵌套技能的顶层链接信息。
// 如 skillName="superpowers/using-git-worktrees"、skillPath="E:\skills\official\superpowers/using-git-worktrees"
// 则返回 topName="superpowers"、topSource="E:\skills\official\superpowers"。
// 非嵌套技能直接返回原值。
func resolveTopLevelLink(skillPath, skillName string) (topName, topSource string) {
	osName := filepath.FromSlash(skillName)
	depth := strings.Count(osName, string(filepath.Separator))
	if depth == 0 {
		return skillName, skillPath
	}
	topName = strings.SplitN(skillName, "/", 2)[0]
	topSource = skillPath
	for i := 0; i < depth; i++ {
		topSource = filepath.Dir(topSource)
	}
	return topName, topSource
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
	// 校验路径存在且为目录（不再限制必须在全局目录下，以支持来源目录中的技能）
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

// ========== 托管链接与方案应用 ==========

// normalizeComparePath 规范化路径用于前缀比较。
// 在 Windows 上处理 \\?\ 前缀和大小写问题。
func normalizeComparePath(p string) string {
	cleaned := filepath.Clean(p)
	// Windows 上 EvalSymlinks 可能返回 \\?\C:\... 格式的路径
	cleaned = strings.TrimPrefix(cleaned, `\\?\`)
	if runtime.GOOS == "windows" {
		cleaned = strings.ToLower(cleaned)
	}
	return cleaned
}

// isSubPath 判断 child 是否在 parent 目录下（或等于 parent）。
func isSubPath(child, parent string) bool {
	if !strings.HasPrefix(child, parent) {
		return false
	}
	if len(child) == len(parent) {
		return true // 完全相等
	}
	// 确保 parent 后紧跟路径分隔符
	sep := child[len(parent)]
	return sep == filepath.Separator || sep == '/'
}

// GetEnabledSkillsInDir 返回指定来源目录中当前已启用的技能名称列表。
// 判断标准：技能在全局目录中有对应链接，且链接目标指向该来源目录内的路径。
func (m *Manager) GetEnabledSkillsInDir(sourceDir string) []string {
	normalizedSource, err := filepath.Abs(filepath.Clean(sourceDir))
	if err != nil {
		return nil
	}

	entries, err := os.ReadDir(m.globalDir)
	if err != nil {
		return nil
	}

	var enabled []string
	for _, entry := range entries {
		entryPath := filepath.Join(m.globalDir, entry.Name())

		// 尝试解析链接目标
		var target string
		if linkTarget, err := os.Readlink(entryPath); err == nil && linkTarget != "" {
			if filepath.IsAbs(linkTarget) {
				target = linkTarget
			} else {
				target = filepath.Join(m.globalDir, linkTarget)
			}
		} else {
			if t, err := filepath.EvalSymlinks(entryPath); err == nil && t != entryPath {
				target = t
			}
		}
		if target == "" {
			continue
		}

		absTarget, err := filepath.Abs(filepath.Clean(target))
		if err != nil {
			continue
		}

		// 检查目标是否在 sourceDir 内
		rel, err := filepath.Rel(normalizedSource, absTarget)
		if err == nil && !strings.HasPrefix(rel, "..") {
			enabled = append(enabled, entry.Name())
		}
	}
	return enabled
}

// GetManagedLinks 获取全局目录中所有被本应用托管的链接。
// 托管链接判定：该链接的目标路径指向任何一个已配置的来源目录内的路径。
// 返回 managed 目录条目列表（路径在 globalDir 下）。
func (m *Manager) GetManagedLinks(sourceDirs []string) ([]string, error) {
	if len(sourceDirs) == 0 {
		return nil, nil
	}

	// 规范化来源目录路径
	var normalizedSourceDirs []string
	for _, d := range sourceDirs {
		// 获取绝对路径并规范化
		absD, err := filepath.Abs(filepath.Clean(d))
		if err != nil {
			continue
		}
		normalizedSourceDirs = append(normalizedSourceDirs, normalizeComparePath(absD))
	}

	entries, err := os.ReadDir(m.globalDir)
	if err != nil {
		return nil, err
	}

	var managed []string
	for _, entry := range entries {
		entryPath := filepath.Join(m.globalDir, entry.Name())
		// 尝试多种方式解析链接目标
		var target string
		resolved := false

		// 方式 1: os.Readlink 获取符号链接目标（Windows 支持符号链接）
		if linkTarget, err := os.Readlink(entryPath); err == nil && linkTarget != "" {
			// 如果是相对路径，相对于 globalDir 拼接
			if filepath.IsAbs(linkTarget) {
				target = linkTarget
			} else {
				target = filepath.Join(m.globalDir, linkTarget)
			}
			resolved = true
		}

		// 方式 2: filepath.EvalSymlinks 解析 Junction 和其他重解析点
		if !resolved {
			if t, err := filepath.EvalSymlinks(entryPath); err == nil && t != entryPath {
				target = t
				resolved = true
			}
		}

		if !resolved {
			continue
		}

		target = normalizeComparePath(target)

		// 检查目标是否在任何一个来源目录内
		for _, src := range normalizedSourceDirs {
			if isSubPath(target, src) {
				managed = append(managed, entry.Name())
				break
			}
		}
	}
	return managed, nil
}

// ClearManagedLinks 删除全局目录中的所有托管链接。
func (m *Manager) ClearManagedLinks(sourceDirs []string) error {
	managed, err := m.GetManagedLinks(sourceDirs)
	if err != nil {
		return err
	}
	for _, name := range managed {
		linkPath := filepath.Join(m.globalDir, name)
		os.Remove(linkPath) // ignore error if already gone
	}
	return nil
}

// LinkSkill 创建单个技能链接到全局目录。与 ToggleSkill 的 enable 逻辑相同。
// 如果链接已存在，先安全删除再重建。Windows 上隐藏 cmd 窗口。
// 嵌套技能取其顶层目录做链接。
func (m *Manager) LinkSkill(skillPath, skillName string) error {
	topName, topSource := resolveTopLevelLink(skillPath, skillName)
	linkPath := filepath.Join(m.globalDir, topName)
	// 如果已存在（联接/符号链接），先安全删除
	if _, err := os.Lstat(linkPath); err == nil {
		if runtime.GOOS == "windows" {
			if _, err := os.Readlink(linkPath); err == nil {
				// 是重解析点（联接或符号链接），用 rmdir 安全删除
				rmCmd := exec.Command("cmd", "/c", "rmdir", linkPath)
				rmCmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
				rmCmd.Run()
			} else {
				os.Remove(linkPath)
			}
		}
	}
	// 先尝试标准符号链接
	if err := os.Symlink(topSource, linkPath); err == nil {
		return nil
	}
	// Windows 回退：mklink /J 目录联接（隐藏窗口）
	if runtime.GOOS == "windows" {
		absSource, _ := filepath.Abs(topSource)
		absDest, _ := filepath.Abs(linkPath)
		cmd := exec.Command("cmd", "/c", "mklink", "/J", absDest, absSource)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if output, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("创建链接失败: %w\n输出: %s", err, strings.TrimSpace(string(output)))
		}
		return nil
	}
	return fmt.Errorf("创建链接失败")
}

// ApplySkillScheme 应用技能方案。
// 1. 删除全局目录中所有托管链接
// 2. 遍历方案中的技能名称，在 availableSkills 中查找匹配项
// 3. 成功项重建链接
// 4. 缺失/冲突项汇总到结果中
func (m *Manager) ApplySkillScheme(scheme model.SkillSchemeData, availableSkills []model.SkillInfo, sourceDirs []string) model.SchemeApplyResult {
	result := model.SchemeApplyResult{}

	// 1. 构建技能名 → SkillInfo 查找表
	skillMap := make(map[string]model.SkillInfo)
	for _, s := range availableSkills {
		skillMap[s.Name] = s
	}

	// 2. 清除托管链接
	if err := m.ClearManagedLinks(sourceDirs); err != nil {
		// non-fatal, continue
	}

	// 3. 遍历方案中的每个技能名称并应用
	for _, name := range scheme {
		skill, found := skillMap[name]
		if !found {
			result.Missing = append(result.Missing, name)
			continue
		}
		if skill.Conflict {
			result.Conflicts = append(result.Conflicts, name)
			continue
		}
		if err := m.LinkSkill(skill.Path, name); err != nil {
			result.Errors = append(result.Errors, fmt.Sprintf("%s: %s", name, err.Error()))
			continue
		}
		result.Applied = append(result.Applied, name)
	}

	result.Success = len(result.Applied) > 0
	return result
}
