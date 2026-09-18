package skill

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"oc-manager/internal/fileutil"
	"oc-manager/model"
)

// skillConfigFileName 是技能源配置文件的名称。它与方案文件同存放在
// skill-schemes/ 目录下（见 source.go 的 SkillConfigPath），因此扫描方案时
// 必须显式排除，否则会被误当成一个名为 skill-config 的方案。
const skillConfigFileName = "skill-config.json"

// reservedSchemeName 是上述配置文件名去掉 .json 扩展名后的保留方案名，
// 保存 / 删除方案时禁止使用，防止覆盖或删除技能源配置文件。
const reservedSchemeName = "skill-config"

// isReservedSchemeName 判断方案名是否为保留名（skill-config）。
// 比较不区分大小写，以兼容大小写不敏感的 Windows 文件系统。
func isReservedSchemeName(name string) bool {
	return strings.EqualFold(strings.TrimSpace(name), reservedSchemeName)
}

// isSchemeFileName 判断目录项名称是否为合法的方案文件：
// 必须是非隐藏（不以 . 开头）的 .json 文件，且不是技能源配置文件。
// 隐藏名可一并排除原子写残留的临时文件（.xxx.json.*.tmp）与手动备份（.xxx.json.bak）。
func isSchemeFileName(name string) bool {
	if strings.HasPrefix(name, ".") {
		return false
	}
	if !strings.HasSuffix(name, ".json") {
		return false
	}
	return !strings.EqualFold(name, skillConfigFileName)
}

// SkillSchemeDir 返回技能方案存储目录。
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

// ListSkillSchemes 列出所有方案文件。
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
		if e.IsDir() || !isSchemeFileName(e.Name()) {
			continue
		}
		schemes = append(schemes, strings.TrimSuffix(e.Name(), ".json"))
	}
	return schemes, nil
}

// SaveSkillScheme 将技能名称列表保存为方案文件。
func SaveSkillScheme(name string, skillNames []string) error {
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("方案名称不能为空")
	}
	if isReservedSchemeName(name) {
		return fmt.Errorf("方案名 %q 为保留名称，请换一个", name)
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
	return fileutil.AtomicWrite(path, data, 0644)
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
	if isReservedSchemeName(name) {
		return fmt.Errorf("方案名 %q 为保留名称，不能删除", name)
	}
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
