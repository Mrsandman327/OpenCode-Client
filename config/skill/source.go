package skill

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"oc-manager/internal/fileutil"
	"oc-manager/internal/pathutil"
	"oc-manager/internal/portable"
	"oc-manager/model"
)

// SkillConfigDir 返回技能配置目录的绝对路径。
func SkillConfigDir() (string, error) {
	if dir := os.Getenv("SKILL_CONFIG_DIR"); dir != "" {
		return filepath.Clean(dir), nil
	}
	exeDir := portable.ExeDir()
	if exeDir == "" {
		return "", fmt.Errorf("获取可执行文件路径失败")
	}
	// 保持原有语义：解析符号链接，确保通过软链启动时仍定位到真实安装目录
	exeDir, err := filepath.EvalSymlinks(exeDir)
	if err != nil {
		return "", fmt.Errorf("解析可执行文件符号链接失败: %w", err)
	}
	return filepath.Join(exeDir, "configs"), nil
}

// SkillConfigPath 返回技能源配置文件（skill-config.json）的完整路径。
func SkillConfigPath() (string, error) {
	dir, err := SkillConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "skill-schemes", "skill-config.json"), nil
}

// LoadSkillConfig 读取并解析 skill-config.json，文件不存在时返回空配置。
// 文件损坏（空文件/非法 JSON）时自动备份损坏文件并回退为空配置，避免整个技能管理功能被永久卡死。
func LoadSkillConfig() (*model.SkillConfig, error) {
	path, err := SkillConfigPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &model.SkillConfig{}, nil
		}
		return nil, fmt.Errorf("读取技能配置文件失败: %w", err)
	}
	cleaned := fileutil.StripComments(string(data))
	var cfg model.SkillConfig
	if err := json.Unmarshal([]byte(cleaned), &cfg); err != nil {
		// 容错自愈：损坏的配置不应导致「添加目录/移除目录」等全部操作失败。
		// 备份损坏文件（保留现场供排查），随后返回空配置（下次保存时自动重建）。
		backup := path + ".corrupt-" + time.Now().Format("20060102-150405")
		_ = os.Rename(path, backup)
		return &model.SkillConfig{}, nil
	}
	return &cfg, nil
}

// SaveSkillConfig 原子写入技能配置文件。
func SaveSkillConfig(cfg *model.SkillConfig) error {
	if cfg == nil {
		return fmt.Errorf("配置不能为 nil")
	}
	path, err := SkillConfigPath()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化技能配置失败: %w", err)
	}
	return fileutil.AtomicWrite(path, data, 0644)
}

// hasSkillDir 检查目录下是否存在技能（即某个子目录中包含 SKILL.md）。
// depth 为已下探层数（传入目录为 0），最多下探 maxScanDepth 层，
// 与扫描逻辑（scanSourceRecursive / scanDir）保持一致：
// 只有落在允许层数内的技能才算有效，避免「添加时校验通过、扫描时却找不到」的割裂。
func hasSkillDir(dir string, depth int) bool {
	if depth >= maxScanDepth {
		return false
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if entry.IsDir() {
			entryPath := filepath.Join(dir, entry.Name())
			skillMDPath := filepath.Join(entryPath, "SKILL.md")
			if _, err := os.Stat(skillMDPath); err == nil {
				return true
			}
			if hasSkillDir(entryPath, depth+1) {
				return true
			}
		}
	}
	return false
}

// AddSourceDir 添加技能源目录到配置。
func AddSourceDir(dir string, globalDir string) (*model.SkillConfig, error) {
	normalized, err := pathutil.Norm(dir)
	if err != nil {
		return nil, err
	}
	if info, err := os.Stat(normalized); err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("目录不存在: %s", normalized)
		}
		return nil, fmt.Errorf("检查目录失败: %w", err)
	} else if !info.IsDir() {
		return nil, fmt.Errorf("路径不是目录: %s", normalized)
	}
	normalizedGlobal, err := pathutil.Norm(globalDir)
	if err == nil && pathutil.Equal(normalized, normalizedGlobal) {
		return nil, fmt.Errorf("不能添加 opencode 全局技能目录: %s", normalized)
	}
	if !hasSkillDir(normalized, 0) {
		return nil, fmt.Errorf("该目录中未包含有效技能: %s", normalized)
	}
	cfg, err := LoadSkillConfig()
	if err != nil {
		return nil, err
	}
	// 重复校验复用 findSourceDirIndex：配置里若有失效目录，
	// 用 pathutil.Norm 逐条归一化会因报错被跳过，导致误判「不重复」而重复添加。
	if findSourceDirIndex(cfg.SourceDirs, normalized) >= 0 {
		return nil, fmt.Errorf("目录已存在: %s", normalized)
	}
	cfg.SourceDirs = append(cfg.SourceDirs, normalized)
	if err := SaveSkillConfig(cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

// findSourceDirIndex 在来源目录配置列表中定位目标条目，返回下标（-1 表示未找到）。
//
// 匹配分两步，确保「当前系统上已不存在的目录」同样能被命中：
//  1. 原样比较：界面删除时传入的就是配置里存的原始字符串，绝大多数情况在这一步命中；
//  2. 宽松归一化比较：处理斜杠、大小写、相对/绝对等书写差异。
//     这里必须用 NormLoose 而不是 Norm——Norm 要求路径存在，
//     对失效条目会直接报错，导致这类条目永远删不掉。
func findSourceDirIndex(dirs []string, target string) int {
	for i, d := range dirs {
		if pathutil.Equal(d, target) {
			return i
		}
	}
	targetNorm, err := pathutil.NormLoose(target)
	if err != nil {
		return -1
	}
	for i, d := range dirs {
		if dNorm, err := pathutil.NormLoose(d); err == nil && pathutil.Equal(dNorm, targetNorm) {
			return i
		}
	}
	return -1
}

// RemoveSourceDir 从配置中移除指定的技能源目录。
// 该目录在当前系统上不存在（被删除、被移动，或配置来自其他机器）时也必须能移除，
// 否则这类历史条目会永久滞留，用户无法清理。
func RemoveSourceDir(dir string) (*model.SkillConfig, error) {
	cfg, err := LoadSkillConfig()
	if err != nil {
		return nil, err
	}
	idx := findSourceDirIndex(cfg.SourceDirs, dir)
	if idx < 0 {
		return nil, fmt.Errorf("目录不在配置中: %s", dir)
	}
	cfg.SourceDirs = append(cfg.SourceDirs[:idx], cfg.SourceDirs[idx+1:]...)
	if err := SaveSkillConfig(cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

// ListSourceDirs 返回当前配置中的所有技能源目录。
func ListSourceDirs() ([]string, error) {
	cfg, err := LoadSkillConfig()
	if err != nil {
		return nil, err
	}
	if cfg.SourceDirs == nil {
		return []string{}, nil
	}
	return cfg.SourceDirs, nil
}
