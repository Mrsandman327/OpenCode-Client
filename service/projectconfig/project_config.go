// Package projectconfig 提供项目级 .opencode/ 目录的配置管理功能。
package projectconfig

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"oc-manager/config/skill"
	"oc-manager/internal/symlink"
	"oc-manager/model"
)

// opencodeDir 返回项目下的 .opencode 目录路径。
func opencodeDir(rootDir string) string {
	return filepath.Join(rootDir, ".opencode")
}

// GetProjectConfigSummary 扫描项目 .opencode/ 目录，返回四个配置 tab 的聚合信息。
func GetProjectConfigSummary(rootDir string) model.ProjectConfigSummary {
	summary := model.ProjectConfigSummary{RootDir: rootDir}
	ocDir := opencodeDir(rootDir)

	// Tab 1: 核心配置 — .opencode/opencode.jsonc 或 opencode.json
	summary.CoreConfig = scanCoreConfig(ocDir)

	// Tab 2: 技能管理 — .opencode/skills/
	summary.Skills = scanSkillsDir(ocDir)

	// Tab 3: 项目准则 — 项目根 AGENTS.md
	summary.AgentsMd = scanAgentsMd(rootDir)

	// Tab 4: 用户命令 — .opencode/commands/
	summary.Commands = scanCommandsDir(ocDir)

	// Tab 5: 用户规则 — .opencode/rules/
	summary.Rules = scanRulesDir(ocDir)

	return summary
}

// ListProjectDir 列出项目配置目录下的文件和子目录。
func ListProjectDir(rootDir, category, relPath string) (model.ProjectConfigTab, error) {
	fullPath, err := resolveProjectFilePath(rootDir, category, relPath)
	if err != nil {
		return model.ProjectConfigTab{}, err
	}
	entries, err := os.ReadDir(fullPath)
	if err != nil {
		return model.ProjectConfigTab{Exists: false, Message: "目录不存在"}, nil
	}
	var files []model.ProjectConfigFileEntry
	for _, e := range entries {
		t := "file"
		if e.IsDir() {
			t = "dir"
		}
		files = append(files, model.ProjectConfigFileEntry{
			Name: e.Name(),
			Path: e.Name(),
			Type: t,
		})
	}
	if len(files) == 0 {
		return model.ProjectConfigTab{Exists: true, Message: "目录为空", Files: files}, nil
	}
	return model.ProjectConfigTab{Exists: true, Files: files}, nil
}

// ReadProjectFile 读取项目配置文件内容。category 为 coreConfig/skills/agentsMd/commands/rules。
func ReadProjectFile(rootDir, category, relPath string) (model.ProjectConfigFileResult, error) {
	fullPath, err := resolveProjectFilePath(rootDir, category, relPath)
	if err != nil {
		return model.ProjectConfigFileResult{}, err
	}
	data, err := os.ReadFile(fullPath)
	if err != nil {
		return model.ProjectConfigFileResult{}, fmt.Errorf("读取文件失败: %w", err)
	}
	return model.ProjectConfigFileResult{
		Path:    relPath,
		Content: string(data),
	}, nil
}

// SaveProjectFile 写入项目配置文件。category 为 coreConfig/agentsMd/commands/rules。
func SaveProjectFile(rootDir, category, relPath, content string) (model.ProjectConfigFileResult, error) {
	fullPath, err := resolveProjectFilePath(rootDir, category, relPath)
	if err != nil {
		return model.ProjectConfigFileResult{}, err
	}

	dir := filepath.Dir(fullPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return model.ProjectConfigFileResult{}, fmt.Errorf("创建目录失败: %w", err)
	}

	if err := os.WriteFile(fullPath, []byte(content), 0o644); err != nil {
		return model.ProjectConfigFileResult{}, fmt.Errorf("写入文件失败: %w", err)
	}

	return model.ProjectConfigFileResult{
		Path:    relPath,
		Content: content,
	}, nil
}

// CreateProjectEntry 在指定 category 目录下创建新文件或子目录。
// name 为文件名（如 "build.md"），isDir 为 true 时创建目录。
func CreateProjectEntry(rootDir, category, name string) (model.ProjectConfigFileEntry, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return model.ProjectConfigFileEntry{}, fmt.Errorf("名称不能为空")
	}
	// 安全检查：防止 ../ 等路径穿越
	if strings.Contains(name, "..") || strings.Contains(name, "/") || strings.Contains(name, "\\") {
		return model.ProjectConfigFileEntry{}, fmt.Errorf("名称不能包含路径分隔符")
	}

	fullPath, err := resolveProjectFilePath(rootDir, category, name)
	if err != nil {
		return model.ProjectConfigFileEntry{}, err
	}

	if _, err := os.Stat(fullPath); err == nil {
		return model.ProjectConfigFileEntry{}, fmt.Errorf("文件或目录已存在")
	}

	dir := filepath.Dir(fullPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return model.ProjectConfigFileEntry{}, fmt.Errorf("创建父目录失败: %w", err)
	}

	f, err := os.Create(fullPath)
	if err != nil {
		return model.ProjectConfigFileEntry{}, fmt.Errorf("创建文件失败: %w", err)
	}
	f.Close()

	return model.ProjectConfigFileEntry{
		Name: name,
		Path: name,
		Type: "file",
	}, nil
}

// DeleteProjectEntry 删除指定 category 下的文件、目录或软链接。
// 软链接/Junction 使用 symlink.Remove 安全删除，不跟随到目标目录。
func DeleteProjectEntry(rootDir, category, relPath string) error {
	fullPath, err := resolveProjectFilePath(rootDir, category, relPath)
	if err != nil {
		return err
	}

	// 先用 symlink.Remove（对软链接/Junction 安全，不跟随目标目录）
	// symlink.Remove 内部判断：Junction/dir → rmdir；Symlink → Remove；普通文件 → Remove
	// 对于非空的普通目录，rmdir 会失败，走后续 os.RemoveAll
	if err := symlink.Remove(fullPath); err == nil {
		return nil
	}

	// symlink.Remove 失败（可能是非空的普通目录），回退到常规删除
	info, err := os.Stat(fullPath)
	if err != nil {
		return fmt.Errorf("文件或目录不存在: %w", err)
	}
	if info.IsDir() {
		entries, err := os.ReadDir(fullPath)
		if err != nil {
			return fmt.Errorf("读取目录失败: %w", err)
		}
		if len(entries) > 0 {
			return fmt.Errorf("目录不为空，无法删除")
		}
	}
	return os.RemoveAll(fullPath)
}

// GetGlobalOpenCodeConfig 返回全局 ~/.config/opencode/opencode.jsonc 的路径和内容。
func GetGlobalOpenCodeConfig() model.GlobalConfigInfo {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}

	result := model.GlobalConfigInfo{}
	jsoncPath := filepath.Join(dir, "opencode", "opencode.jsonc")
	if data, err := os.ReadFile(jsoncPath); err == nil {
		result.Path = jsoncPath
		result.Content = string(data)
		return result
	}
	jsonPath := filepath.Join(dir, "opencode", "opencode.json")
	if data, err := os.ReadFile(jsonPath); err == nil {
		result.Path = jsonPath
		result.Content = string(data)
		return result
	}

	result.Path = jsoncPath
	result.Content = ""
	return result
}

// resolveProjectFilePath 根据 category 和相对路径解析出完整文件路径，并校验路径安全。
func resolveProjectFilePath(rootDir, category, relPath string) (string, error) {
	var base string
	switch category {
	case "coreConfig":
		base = opencodeDir(rootDir)
	case "agentsMd":
		base = rootDir
	case "skills":
		base = filepath.Join(opencodeDir(rootDir), "skills")
	case "commands":
		base = filepath.Join(opencodeDir(rootDir), "commands")
	case "rules":
		base = filepath.Join(opencodeDir(rootDir), "rules")
	default:
		return "", fmt.Errorf("未知的配置类别: %s", category)
	}

	clean := filepath.Clean(filepath.Join(base, relPath))

	// 防止路径穿越
	absBase, err := filepath.Abs(base)
	if err != nil {
		return "", fmt.Errorf("无法解析基础路径: %w", err)
	}
	absClean, err := filepath.Abs(clean)
	if err != nil {
		return "", fmt.Errorf("无法解析目标路径: %w", err)
	}
	if !strings.HasPrefix(absClean, absBase) {
		return "", fmt.Errorf("路径越界: %s", relPath)
	}

	return clean, nil
}

// ========== 扫描函数 ==========

func scanCoreConfig(ocDir string) model.ProjectConfigTab {
	jsoncPath := filepath.Join(ocDir, "opencode.jsonc")
	if _, err := os.Stat(jsoncPath); err == nil {
		return model.ProjectConfigTab{
			Exists:  true,
			Message: "opencode.jsonc",
			Files:   []model.ProjectConfigFileEntry{{Name: "opencode.jsonc", Path: "opencode.jsonc", Type: "file"}},
		}
	}
	jsonPath := filepath.Join(ocDir, "opencode.json")
	if _, err := os.Stat(jsonPath); err == nil {
		return model.ProjectConfigTab{
			Exists:  true,
			Message: "opencode.json",
			Files:   []model.ProjectConfigFileEntry{{Name: "opencode.json", Path: "opencode.json", Type: "file"}},
		}
	}
	return model.ProjectConfigTab{
		Exists:  false,
		Message: "无项目配置",
	}
}

func scanAgentsMd(rootDir string) model.ProjectConfigTab {
	path := filepath.Join(rootDir, "AGENTS.md")
	if _, err := os.Stat(path); err == nil {
		return model.ProjectConfigTab{
			Exists:  true,
			Message: "AGENTS.md",
			Files:   []model.ProjectConfigFileEntry{{Name: "AGENTS.md", Path: "AGENTS.md", Type: "file"}},
		}
	}
	return model.ProjectConfigTab{
		Exists:  false,
		Message: "项目未初始化，请先执行 /init 初始化项目",
	}
}

func scanCommandsDir(ocDir string) model.ProjectConfigTab {
	dir := filepath.Join(ocDir, "commands")
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) == 0 {
		return model.ProjectConfigTab{
			Exists:  false,
			Message: "无项目命令",
		}
	}
	var files []model.ProjectConfigFileEntry
	for _, e := range entries {
		if e.IsDir() {
			files = append(files, model.ProjectConfigFileEntry{
				Name: e.Name(), Path: e.Name(), Type: "dir",
			})
		} else {
			files = append(files, model.ProjectConfigFileEntry{
				Name: e.Name(), Path: e.Name(), Type: "file",
			})
		}
	}
	if len(files) == 0 {
		return model.ProjectConfigTab{Exists: false, Message: "无项目命令"}
	}
	return model.ProjectConfigTab{Exists: true, Message: "", Files: files}
}

func scanRulesDir(ocDir string) model.ProjectConfigTab {
	dir := filepath.Join(ocDir, "rules")
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) == 0 {
		return model.ProjectConfigTab{
			Exists:  false,
			Message: "无项目规则文件",
		}
	}
	var files []model.ProjectConfigFileEntry
	for _, e := range entries {
		if e.IsDir() {
			files = append(files, model.ProjectConfigFileEntry{
				Name: e.Name(), Path: e.Name(), Type: "dir",
			})
		} else {
			files = append(files, model.ProjectConfigFileEntry{
				Name: e.Name(), Path: e.Name(), Type: "file",
			})
		}
	}
	if len(files) == 0 {
		return model.ProjectConfigTab{Exists: false, Message: "无项目规则文件"}
	}
	return model.ProjectConfigTab{Exists: true, Message: "", Files: files}
}


func scanSkillsDir(ocDir string) model.ProjectConfigTab {
	dir := filepath.Join(ocDir, "skills")
	if _, err := os.Stat(dir); err != nil {
		return model.ProjectConfigTab{Exists: false, Message: "无项目技能"}
	}
	// 复用全局技能的扫描逻辑（支持软链接、嵌套技能等）
	mgr := skill.NewManagerWithDir(dir)
	skills := mgr.GetAllSkills()
	if len(skills) == 0 {
		return model.ProjectConfigTab{Exists: false, Message: "无项目技能"}
	}
	var files []model.ProjectConfigFileEntry
	for _, s := range skills {
		files = append(files, model.ProjectConfigFileEntry{
			Name:        s.Name,
			Path:        s.Name,
			Type:        "dir",
			Description: s.Description,
		})
	}
	return model.ProjectConfigTab{Exists: true, Message: "", Files: files}
}

// GetImportableSkills 返回可导入到项目中的技能列表。
func GetImportableSkills(rootDir string) []model.ImportableSkill {
	skillsDir := filepath.Join(opencodeDir(rootDir), "skills")
	globalMgr := skill.NewManager()
	sourceDirs, err := skill.ListSourceDirs()
	if err != nil || len(sourceDirs) == 0 {
		// 如果没有配置来源目录，用全局目录作为唯一来源
		sourceDirs = []string{globalMgr.SourceDir()}
	}

	// 收集已在项目中导入的技能
	imported := make(map[string]bool)
	if entries, err := os.ReadDir(skillsDir); err == nil {
		for _, e := range entries {
			imported[e.Name()] = true
		}
	}

	var result []model.ImportableSkill
	for _, srcDir := range sourceDirs {
		srcMgr := skill.NewManagerWithDir(srcDir)
		srcSkills := srcMgr.GetAllSkills()
		for _, s := range srcSkills {
			result = append(result, model.ImportableSkill{
				Name:        s.Name,
				Description: s.Description,
				SourceDir:   srcDir,
				SourcePath:  s.Path,
				Imported:    imported[s.Name],
				GlobalExist: globalMgr.IsLinked(s.Name),
			})
		}
	}
	return result
}

// ImportSkill 将技能通过软链接导入到项目 .opencode/skills/ 中。
// 复用 internal/symlink 包的跨平台软链接实现。
func ImportSkill(rootDir, sourcePath, skillName string) error {
	skillsDir := filepath.Join(opencodeDir(rootDir), "skills")
	if err := os.MkdirAll(skillsDir, 0755); err != nil {
		return fmt.Errorf("创建技能目录失败: %w", err)
	}

	// 处理嵌套技能 (superpowers/brainstorming → 顶层链接指向父目录)
	osName := filepath.FromSlash(skillName)
	depth := strings.Count(osName, string(filepath.Separator))
	topName := strings.SplitN(skillName, "/", 2)[0]
	linkDest := filepath.Join(skillsDir, topName)
	source := sourcePath
	for i := 0; i < depth; i++ {
		source = filepath.Dir(source)
	}

	if symlink.Exists(linkDest) {
		return fmt.Errorf("技能 %s 已存在", skillName)
	}

	return symlink.Create(source, linkDest)
}
