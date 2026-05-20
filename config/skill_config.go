package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"oc-manager/model"
)

// ========== 技能配置目录与路径 ==========

// SkillConfigDir 返回技能配置目录的绝对路径。
// 优先使用 SKILL_CONFIG_DIR 环境变量（用于测试），否则基于可执行文件路径解析。
// 返回值经过 filepath.Clean 规范化。
func SkillConfigDir() (string, error) {
	// 环境变量覆盖（用于测试隔离）
	if dir := os.Getenv("SKILL_CONFIG_DIR"); dir != "" {
		return filepath.Clean(dir), nil
	}

	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("获取可执行文件路径失败: %w", err)
	}
	// 解析符号链接以获取真实路径
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
	return filepath.Join(dir, "skill-config.json"), nil
}

// ========== 技能配置读写 ==========

// LoadSkillConfig 读取并解析 skill-sources.json（支持 .json 和 .jsonc 后缀）。
// 如果文件不存在，返回空的 SkillConfig 结构体，不返回错误。
func LoadSkillConfig() (*model.SkillConfig, error) {
	path, err := SkillConfigPath()
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			// 文件不存在时返回空配置，不报错
			return &model.SkillConfig{}, nil
		}
		return nil, fmt.Errorf("读取技能配置文件失败: %w", err)
	}

	// 支持 JSONC 注释：去除单行注释后再解析
	cleaned := stripComments(string(data))

	var cfg model.SkillConfig
	if err := json.Unmarshal([]byte(cleaned), &cfg); err != nil {
		return nil, fmt.Errorf("解析技能配置文件失败: %w", err)
	}

	return &cfg, nil
}

// SaveSkillConfig 原子写入技能配置文件。
// 使用 JSON 格式化输出（缩进 2 空格），写入前会验证 JSON 有效性。
// 复用 writeConfigFile 的原子写入模式（临时文件 + 重命名）。
func SaveSkillConfig(cfg *model.SkillConfig) error {
	if cfg == nil {
		return fmt.Errorf("配置不能为 nil")
	}

	path, err := SkillConfigPath()
	if err != nil {
		return err
	}

	// 序列化为格式化 JSON
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化技能配置失败: %w", err)
	}

	// 原子写入（复用 model_config.go 中的 writeConfigFile）
	return writeConfigFile(path, data, 0644)
}

// ========== 源目录管理 ==========

// NormalizePath 规范化路径：清理多余分隔符、转为绝对路径、解析符号链接。
// 返回规范化后的绝对路径。
func NormalizePath(path string) (string, error) {
	cleaned := filepath.Clean(path)
	abs, err := filepath.Abs(cleaned)
	if err != nil {
		return "", fmt.Errorf("解析绝对路径失败: %w", err)
	}
	// 解析符号链接以获取真实路径
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("解析符号链接失败: %w", err)
	}
	return resolved, nil
}

// pathsEqual 比较两个已规范化的路径是否相等。
// 在 Windows 上使用大小写不敏感比较。
func pathsEqual(a, b string) bool {
	cleanedA := filepath.Clean(a)
	cleanedB := filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(cleanedA, cleanedB)
	}
	return cleanedA == cleanedB
}

// hasSkillDir 检查目录（及其子目录）中是否包含 SKILL.md 文件。
func hasSkillDir(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		entryPath := filepath.Join(dir, entry.Name())
		if entry.IsDir() {
			skillMDPath := filepath.Join(entryPath, "SKILL.md")
			if _, err := os.Stat(skillMDPath); err == nil {
				return true
			}
			// 递归检查子目录
			if hasSkillDir(entryPath) {
				return true
			}
		}
	}
	return false
}

// AddSourceDir 添加技能源目录到配置。
// 进行路径验证：目录存在、非全局目录、无重复、包含有效技能。
// globalDir 参数为 opencode 全局技能目录路径，用于排除。
// 成功时保存配置并返回更新后的 SkillConfig。
func AddSourceDir(dir string, globalDir string) (*model.SkillConfig, error) {
	// 规范化输入路径
	normalized, err := NormalizePath(dir)
	if err != nil {
		return nil, err
	}

	// 检查目录是否存在
	if info, err := os.Stat(normalized); err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("目录不存在: %s", normalized)
		}
		return nil, fmt.Errorf("检查目录失败: %w", err)
	} else if !info.IsDir() {
		return nil, fmt.Errorf("路径不是目录: %s", normalized)
	}

	// 规范化全局目录路径
	normalizedGlobal, err := NormalizePath(globalDir)
	if err == nil && pathsEqual(normalized, normalizedGlobal) {
		return nil, fmt.Errorf("不能添加 opencode 全局技能目录: %s", normalized)
	}

	// 检查目录是否包含有效技能（至少一个 SKILL.md）
	if !hasSkillDir(normalized) {
		return nil, fmt.Errorf("该目录中未包含有效技能: %s", normalized)
	}

	// 加载现有配置
	cfg, err := LoadSkillConfig()
	if err != nil {
		return nil, err
	}

	// 检查重复
	for _, existingDir := range cfg.SourceDirs {
		existingNormalized, err := NormalizePath(existingDir)
		if err == nil && pathsEqual(normalized, existingNormalized) {
			return nil, fmt.Errorf("目录已存在: %s", normalized)
		}
	}

	// 添加新目录
	cfg.SourceDirs = append(cfg.SourceDirs, normalized)

	// 保存配置
	if err := SaveSkillConfig(cfg); err != nil {
		return nil, err
	}

	return cfg, nil
}

// RemoveSourceDir 从配置中移除指定的技能源目录。
// 使用规范化比较来匹配要移除的目录。
// 成功时保存配置并返回更新后的 SkillConfig。
func RemoveSourceDir(dir string) (*model.SkillConfig, error) {
	// 规范化输入路径
	normalized, err := NormalizePath(dir)
	if err != nil {
		return nil, err
	}

	// 加载现有配置
	cfg, err := LoadSkillConfig()
	if err != nil {
		return nil, err
	}

	// 查找匹配的目录
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

	// 移除目录
	cfg.SourceDirs = append(cfg.SourceDirs[:idx], cfg.SourceDirs[idx+1:]...)

	// 保存配置
	if err := SaveSkillConfig(cfg); err != nil {
		return nil, err
	}

	return cfg, nil
}

// ListSourceDirs 返回当前配置中的所有技能源目录。
// 如果配置为空或文件不存在，返回空切片而非 nil。
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
