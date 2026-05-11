// Package service 处理 OpenCode serve 进程管理、API 代理、SSE 事件流、会话 CRUD、项目树构建和方案管理。
package service

import (
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"oc-manager/model"
)

const schemeDirRel = ".sisyphus\\omo-schemes"

func getSchemeDir() string {
	return schemeDirRel
}

// GetSchemeDir 返回方案目录相对路径。
func GetSchemeDir() string {
	return getSchemeDir()
}

func ensureSchemeDir() error {
	dir := getSchemeDir()
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return os.MkdirAll(dir, 0755)
	}
	return nil
}

// ListSchemes 扫描方案目录并返回按名称排序的方案列表。
func ListSchemes() []model.SchemeInfo {
	_ = ensureSchemeDir()
	dir := getSchemeDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var schemes []model.SchemeInfo
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonc") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".jsonc")
		schemes = append(schemes, model.SchemeInfo{
			Name:     name,
			FileName: e.Name(),
			FullPath: filepath.Join(dir, e.Name()),
		})
	}
	sort.Slice(schemes, func(i, j int) bool {
		return schemes[i].Name < schemes[j].Name
	})
	return schemes
}

// ReadScheme 读取指定名称的方案文件内容。
func ReadScheme(name string) (string, error) {
	_ = ensureSchemeDir()
	path := filepath.Join(getSchemeDir(), name+".jsonc")
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// SaveScheme 将内容写入指定名称的方案文件。
func SaveScheme(name, content string) error {
	_ = ensureSchemeDir()
	path := filepath.Join(getSchemeDir(), name+".jsonc")
	return os.WriteFile(path, []byte(content), 0644)
}

// ExportConfig 将配置内容写入指定目录。
func ExportConfig(dir, filename, content string) (string, error) {
	if !strings.HasSuffix(filename, ".jsonc") && !strings.HasSuffix(filename, ".json") {
		filename += ".jsonc"
	}
	// 安全: 只取文件名部分，防止路径穿越
	filename = filepath.Base(filename)
	path := filepath.Join(dir, filename)
	return path, os.WriteFile(path, []byte(content), 0644)
}

// OpenSchemeDir 在资源管理器中打开方案目录。
func OpenSchemeDir() error {
	dir := getSchemeDir()
	_ = ensureSchemeDir()
	return exec.Command("explorer", dir).Start()
}
