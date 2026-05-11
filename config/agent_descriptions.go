package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// descriptionsFileName 描述文件相对于 exe 目录的路径。
const descriptionsFileName = "./configs/oh-my-openagent/agents-comments.json"

func descriptionsPath() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("获取可执行文件路径失败: %w", err)
	}
	return filepath.Join(filepath.Dir(exePath), descriptionsFileName), nil
}

// LoadAgentDescriptions 从可执行文件目录下的 agents-comments.json 加载描述表。
func LoadAgentDescriptions() (map[string]string, error) {
	path, err := descriptionsPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取描述文件失败: %w", err)
	}
	var descriptions map[string]string
	if err := json.Unmarshal(data, &descriptions); err != nil {
		return nil, fmt.Errorf("解析描述文件失败: %w", err)
	}
	return descriptions, nil
}

// ApplyDescriptions 将 entries 中的 key-comment 写入描述文件，保留已有条目。
// 只更新存在内容的条目，不清除已存在的其他条目。
func ApplyDescriptions(entries []struct {
	Key     string
	Comment string
}) error {
	path, err := descriptionsPath()
	if err != nil {
		return err
	}
	// 加载现有描述
	existing := map[string]string{}
	if data, err := os.ReadFile(path); err == nil {
		json.Unmarshal(data, &existing)
	}
	// 合并新的描述
	for _, e := range entries {
		if e.Key != "" && e.Comment != "" {
			existing[e.Key] = e.Comment
		}
	}
	// 写入
	data, err := json.MarshalIndent(existing, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0644)
}
