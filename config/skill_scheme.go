package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"oc-manager/model"
)

// SkillSchemeDir 返回技能方案存储目录。
// 目录为 SkillConfigDir() 下的 skill-schemes/ 子目录。
func SkillSchemeDir() (string, error) {
	dir, err := SkillConfigDir()
	if err != nil {
		return "", err
	}
	schemeDir := filepath.Join(dir, "skill-schemes")
	if err := os.MkdirAll(schemeDir, 0755); err != nil {
		return "", fmt.Errorf("创建方案目录失败: %w", err)
	}
	return schemeDir, nil
}

// ListSkillSchemes 列出所有方案文件（去掉了 .json 后缀）。
func ListSkillSchemes() ([]string, error) {
	dir, err := SkillSchemeDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, err
	}
	var schemes []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		schemes = append(schemes, strings.TrimSuffix(e.Name(), ".json"))
	}
	return schemes, nil
}

// SaveSkillScheme 将技能名称列表保存为方案文件。
// 文件存储为 {schemeDir}/{name}.json，格式为 JSON 数组。
func SaveSkillScheme(name string, skillNames []string) error {
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("方案名称不能为空")
	}
	dir, err := SkillSchemeDir()
	if err != nil {
		return err
	}
	path := filepath.Join(dir, name+".json")
	data, err := json.MarshalIndent(skillNames, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化方案失败: %w", err)
	}
	return writeConfigFile(path, data, 0644)
}

// LoadSkillScheme 读取方案文件，返回技能名称列表。
func LoadSkillScheme(name string) (model.SkillSchemeData, error) {
	dir, err := SkillSchemeDir()
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, name+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取方案文件失败: %w", err)
	}
	var names model.SkillSchemeData
	if err := json.Unmarshal(data, &names); err != nil {
		return nil, fmt.Errorf("解析方案文件失败: %w", err)
	}
	return names, nil
}

// DeleteSkillScheme 删除方案文件。
func DeleteSkillScheme(name string) error {
	dir, err := SkillSchemeDir()
	if err != nil {
		return err
	}
	path := filepath.Join(dir, name+".json")
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("删除方案文件失败: %w", err)
	}
	return nil
}
