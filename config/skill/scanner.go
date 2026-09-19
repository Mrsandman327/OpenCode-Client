package skill

import (
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

// maxScanDepth 限制技能目录的递归深度：最多下探两层。
// 层数计数基准为「来源根目录的直接子目录 = 第 1 层」：
//   - 第 1 层技能：<来源根>/<技能名>/SKILL.md
//   - 第 2 层技能：<来源根>/<分组>/<技能名>/SKILL.md
//
// 第 3 层及更深不再扫描。设置上限的原因：来源目录由用户自由指定，
// 一旦误选为大目录（例如用户主目录），不设上限会全盘遍历，
// 既拖慢扫描又会扫出大量无关技能。
const maxScanDepth = 2

// GetAllSkills 扫描 opencode 技能目录，兼容软链接和真实目录。
func (m *Manager) GetAllSkills() []model.SkillInfo {
	skills := m.scanDir(m.globalDir, "global", "", 0)
	for i := range skills {
		skills[i].NoSources = true
		skills[i].Enableable = false
	}
	return skills
}

// ScanSourceDir 扫描单个来源目录并返回该目录下所有技能的来源信息。
func (m *Manager) ScanSourceDir(dir string, sourceName string) []model.AggregatedSourceInfo {
	return m.scanSourceRecursive(dir, sourceName, "", 0)
}

// scanSourceRecursive 递归扫描目录，查找所有包含 SKILL.md 的子目录。
// depth 为当前已下探的层数（来源根目录为 0）；达到 maxScanDepth 后立即返回，不再深入。
func (m *Manager) scanSourceRecursive(dir, sourceName, prefix string, depth int) []model.AggregatedSourceInfo {
	var result []model.AggregatedSourceInfo
	if depth >= maxScanDepth {
		return result
	}
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
		skillMD := filepath.Join(skillPath, "SKILL.md")
		if _, err := os.Stat(skillMD); err != nil {
			info, err2 := os.Stat(skillPath)
			if err2 == nil && info.IsDir() {
				subResults := m.scanSourceRecursive(skillPath, sourceName, relName, depth+1)
				result = append(result, subResults...)
			}
			continue
		}
		result = append(result, model.AggregatedSourceInfo{
			Path:   skillPath,
			Source: sourceName,
		})
		subResults := m.scanSourceRecursive(skillPath, sourceName, relName, depth+1)
		result = append(result, subResults...)
	}
	return result
}

// ScanMultipleDirs 扫描多个来源目录，聚合结果并检测冲突。
func (m *Manager) ScanMultipleDirs(dirs []string) []model.SkillInfo {
	type aggregate struct {
		sources []model.AggregatedSourceInfo
		primary model.AggregatedSourceInfo
	}
	aggregates := make(map[string]*aggregate)

	for _, dir := range dirs {
		infos := m.ScanSourceDir(dir, dir)
		for _, info := range infos {
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

	skills := make([]model.SkillInfo, 0, len(aggregates))
	for name, ag := range aggregates {
		conflict := len(ag.sources) > 1
		desc := ""
		skillMD := filepath.Join(ag.primary.Path, "SKILL.md")
		if data, err := os.ReadFile(skillMD); err == nil {
			fm, _ := parseFrontmatter(data)
			desc = fm.Description
		}
		linked := m.IsLinked(name)
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

	sort.Slice(skills, func(i, j int) bool {
		return skills[i].Name < skills[j].Name
	})
	return skills
}

// ScanWithGlobal 扫描来源目录和全局目录，返回完整聚合结果。
func (m *Manager) ScanWithGlobal(dirs []string) []model.SkillInfo {
	sourceSkills := m.ScanMultipleDirs(dirs)
	globalSkills := m.GetAllSkills()

	sourceNames := make(map[string]bool, len(sourceSkills))
	for _, s := range sourceSkills {
		sourceNames[s.Name] = true
	}

	for _, g := range globalSkills {
		if sourceNames[g.Name] {
			continue
		}
		sourceSkills = append(sourceSkills, model.SkillInfo{
			Name:        g.Name,
			Description: g.Description,
			Path:        g.Path,
			Linked:      true,
			Source:      "global",
			Conflict:    false,
			Sources:     []model.AggregatedSourceInfo{{Path: g.Path, Source: "global"}},
			Enableable:  true,
		})
	}

	sort.Slice(sourceSkills, func(i, j int) bool {
		return sourceSkills[i].Name < sourceSkills[j].Name
	})
	return sourceSkills
}

// scanDir 递归扫描目录，兼容软链接和真实目录。
// depth 语义与 scanSourceRecursive 一致：传入目录为 0，达到 maxScanDepth 后不再深入。
func (m *Manager) scanDir(dir, source, prefix string, depth int) []model.SkillInfo {
	skills := make([]model.SkillInfo, 0)
	if depth >= maxScanDepth {
		return skills
	}
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
		skillMD := filepath.Join(skillPath, "SKILL.md")
		if _, err := os.Stat(skillMD); err != nil {
			info, err2 := os.Stat(skillPath)
			if err2 == nil && info.IsDir() {
				subSkills := m.scanDir(skillPath, source, relName, depth+1)
				skills = append(skills, subSkills...)
			}
			continue
		}
		displayName := relName
		desc := ""
		if data, err := os.ReadFile(skillMD); err == nil {
			fm, _ := parseFrontmatter(data)
			desc = fm.Description
		}
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
		subSkills := m.scanDir(skillPath, source, relName, depth+1)
		skills = append(skills, subSkills...)
	}
	return skills
}

// GetEnabledSkillsInDir 返回指定来源目录中当前已启用的技能名称列表。
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
		rel, err := filepath.Rel(normalizedSource, absTarget)
		if err == nil && !strings.HasPrefix(rel, "..") {
			enabled = append(enabled, entry.Name())
		}
	}
	return enabled
}
