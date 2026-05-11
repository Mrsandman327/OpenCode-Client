package config

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"oc-manager/model"
)

// schemeWriteMu 保护方案文件操作的并发安全。
var schemeWriteMu sync.Mutex

// ========== 方案目录管理 ==========

// SchemeDir 返回方案目录的绝对路径。方案目录固定在项目根目录下的 .sisyphus/omo-schemes/。
func SchemeDir() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("获取工作目录失败: %w", err)
	}
	return filepath.Join(wd, "./configs", "omo-schemes"), nil
}

// EnsureSchemeDir 确保方案目录存在，返回其绝对路径。
func EnsureSchemeDir() (string, error) {
	return ensureSchemeDir()
}

// ensureSchemeDir 确保方案目录存在（内部版本，返回路径）。
func ensureSchemeDir() (string, error) {
	dir, err := SchemeDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("创建方案目录失败: %w", err)
	}
	return dir, nil
}

// ========== 方案列表与读写 ==========

// ListSchemes 扫描方案目录，返回所有 .jsonc 方案文件的信息列表。
// 如果目录不存在，返回空列表而非错误。
func ListSchemes() ([]model.SchemeInfo, error) {
	dir, err := SchemeDir()
	if err != nil {
		return nil, err
	}

	// 目录不存在则返回空列表
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return []model.SchemeInfo{}, nil
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("读取方案目录失败: %w", err)
	}

	schemes := make([]model.SchemeInfo, 0)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".jsonc") {
			continue
		}
		fullPath := filepath.Join(dir, name)
		// 去掉 .jsonc 后缀作为显示名
		displayName := strings.TrimSuffix(name, ".jsonc")
		schemes = append(schemes, model.SchemeInfo{
			Name:     displayName,
			FileName: name,
			FullPath: fullPath,
		})
	}

	// 按名称排序（不区分大小写）
	sort.Slice(schemes, func(i, j int) bool {
		return strings.ToLower(schemes[i].Name) < strings.ToLower(schemes[j].Name)
	})

	return schemes, nil
}

// ReadScheme 读取指定方案文件的原始内容（字符串形式）。
// name 参数可带或不带 .jsonc 后缀。
func ReadScheme(name string) (string, error) {
	dir, err := SchemeDir()
	if err != nil {
		return "", err
	}

	fileName := name
	if !strings.HasSuffix(fileName, ".jsonc") {
		fileName += ".jsonc"
	}
	path := filepath.Join(dir, fileName)

	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("读取方案文件失败: %w", err)
	}
	return string(data), nil
}

// SaveScheme 将内容保存到方案文件。写入采用原子方式（临时文件 + 重命名），
// 并验证内容的 JSON/JSONC 有效性。name 参数可带或不带 .jsonc 后缀。
func SaveScheme(name string, content string) error {
	schemeWriteMu.Lock()
	defer schemeWriteMu.Unlock()

	dir, err := ensureSchemeDir()
	if err != nil {
		return err
	}

	fileName := name
	if !strings.HasSuffix(fileName, ".jsonc") {
		fileName += ".jsonc"
	}
	path := filepath.Join(dir, fileName)

	// 复用 model_config.go 中的原子写入与验证逻辑
	return writeConfigFile(path, []byte(content), 0644)
}

// DeleteScheme 删除指定的方案文件。name 参数可带或不带 .jsonc 后缀。
func DeleteScheme(name string) error {
	schemeWriteMu.Lock()
	defer schemeWriteMu.Unlock()

	dir, err := SchemeDir()
	if err != nil {
		return err
	}

	fileName := name
	if !strings.HasSuffix(fileName, ".jsonc") {
		fileName += ".jsonc"
	}
	path := filepath.Join(dir, fileName)

	if err := os.Remove(path); err != nil {
		return fmt.Errorf("删除方案文件失败: %w", err)
	}
	return nil
}
