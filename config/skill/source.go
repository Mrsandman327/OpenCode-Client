package skill

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"oc-manager/internal/fileutil"
	"oc-manager/model"
)

// SkillConfigDir 返回技能配置目录的绝对路径。
func SkillConfigDir() (string, error) {
	if dir := os.Getenv("SKILL_CONFIG_DIR"); dir != "" {
		return filepath.Clean(dir), nil
	}
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("获取可执行文件路径失败: %w", err)
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return "", fmt.Errorf("解析可执行文件符号链接失败: %w", err)
	}
	return filepath.Join(filepath.Dir(exePath), "configs"), nil
}

// SkillConfigPath 返回技能源配置文件（skill-config.json）的完整路径。
func SkillConfigPath() (string, error) {
	dir, err := SkillConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "skill-schemes", "skill-config.json"), nil
}

// LoadSkillConfig 读取并解析 skill-sources.json，文件不存在时返回空配置。
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
		return nil, fmt.Errorf("解析技能配置文件失败: %w", err)
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

// NormalizePath 规范化路径：清理多余分隔符、转为绝对路径、解析符号链接。
func NormalizePath(path string) (string, error) {
	cleaned := filepath.Clean(path)
	abs, err := filepath.Abs(cleaned)
	if err != nil {
		return "", fmt.Errorf("解析绝对路径失败: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("解析符号链接失败: %w", err)
	}
	return resolved, nil
}

// pathsEqual 比较两个已规范化的路径是否相等。
func pathsEqual(a, b string) bool {
	cleanedA := filepath.Clean(a)
	cleanedB := filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(cleanedA, cleanedB)
	}
	return cleanedA == cleanedB
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
	normalized, err := NormalizePath(dir)
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
	normalizedGlobal, err := NormalizePath(globalDir)
	if err == nil && pathsEqual(normalized, normalizedGlobal) {
		return nil, fmt.Errorf("不能添加 opencode 全局技能目录: %s", normalized)
	}
	if !hasSkillDir(normalized, 0) {
		return nil, fmt.Errorf("该目录中未包含有效技能: %s", normalized)
	}
	cfg, err := LoadSkillConfig()
	if err != nil {
		return nil, err
	}
	for _, existingDir := range cfg.SourceDirs {
		existingNormalized, err := NormalizePath(existingDir)
		if err == nil && pathsEqual(normalized, existingNormalized) {
			return nil, fmt.Errorf("目录已存在: %s", normalized)
		}
	}
	cfg.SourceDirs = append(cfg.SourceDirs, normalized)
	if err := SaveSkillConfig(cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

// RemoveSourceDir 从配置中移除指定的技能源目录。
func RemoveSourceDir(dir string) (*model.SkillConfig, error) {
	normalized, err := NormalizePath(dir)
	if err != nil {
		return nil, err
	}
	cfg, err := LoadSkillConfig()
	if err != nil {
		return nil, err
	}
	idx := -1
	for i, existingDir := range cfg.SourceDirs {
		existingNormalized, err := NormalizePath(existingDir)
		if err == nil && pathsEqual(normalized, existingNormalized) {
			idx = i
			break
		}
	}
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
