package omo

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"oc-manager/internal/fileutil"
	"oc-manager/model"
)

// schemeWriteMu 保护方案文件操作的并发安全。
var schemeWriteMu sync.Mutex

// schemeDirOverride 仅供测试注入方案目录；生产环境保持 nil。
var schemeDirOverride string

// ========== 方案目录管理 ==========

// SchemeDir 返回方案目录的绝对路径。
func SchemeDir() (string, error) {
	if schemeDirOverride != "" {
		return schemeDirOverride, nil
	}
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("获取可执行文件路径失败: %w", err)
	}
	return filepath.Join(filepath.Dir(exePath), "configs", "omo-schemes"), nil
}

// ExportConfigEntries 将结构化模型条目导出为 omo.jsonc 兼容文件。
// 由后端生成 JSON 结构，前端只提供结构化数据。
func ExportConfigEntries(dir, filename string, entries []model.ModelEntry) (string, error) {
	if !strings.HasSuffix(filename, ".jsonc") && !strings.HasSuffix(filename, ".json") {
		filename += ".jsonc"
	}
	filename = filepath.Base(filename)
	path := filepath.Join(dir, filename)
	doc := buildOmoDocFromEntries(entries)
	return path, fileutil.AtomicWrite(path, []byte(doc), 0644)
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

// ========== 结构化方案存取 ==========

// SaveSchemeEntries 将方案保存到方案目录（JSONC）。
// 优先直接复制当前主配置文件（~/.omo/omo.jsonc / omo.json）作为完整快照，
// 保留 $schema、[opencode] 下非模型配置、_migrations 等全部内容；
// 主配置不存在时回退为用结构化 entries 重建基础方案文档。
func SaveSchemeEntries(name string, entries []model.ModelEntry) error {
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

	// 优先复制主配置完整快照
	if data, err := os.ReadFile(ConfigPath()); err == nil {
		return fileutil.AtomicWrite(path, data, 0644)
	}
	// 主配置不存在：回退为结构化重建
	doc := buildOmoDocFromEntries(entries)
	return fileutil.AtomicWrite(path, []byte(doc), 0644)
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

// ReadSchemeEntries 读取方案文件并解析为结构化模型条目列表。
// 兼容新格式（[opencode] 命名空间）与旧格式（顶层 agents/categories）。
func ReadSchemeEntries(name string) ([]model.ModelEntry, map[string]string, error) {
	content, err := ReadScheme(name)
	if err != nil {
		return nil, nil, err
	}
	cleaned := fileutil.StripComments(content)
	cfg, err := parseModelConfigSections(cleaned)
	if err != nil {
		return nil, nil, fmt.Errorf("解析方案配置失败: %w", err)
	}
	return ConfigToEntries(&cfg, nil), nil, nil
}

// buildOmoDocFromEntries 将结构化条目序列化为 omo.jsonc 兼容的完整文档。
// 生成 [opencode] 命名空间结构，每个条目含 model / reasoning / variant 字段。
func buildOmoDocFromEntries(entries []model.ModelEntry) string {
	grouped := make(map[string]map[string]model.ModelConfig)
	for _, e := range entries {
		t := normalizeModelEntryType(e.Type)
		if grouped[t] == nil {
			grouped[t] = make(map[string]model.ModelConfig)
		}
		grouped[t][e.Key] = model.ModelConfig{
			Model:     e.Model,
			Reasoning: e.Reasoning,
		}
	}

	// 按类型名排序，保证输出稳定
	typeNames := make([]string, 0, len(grouped))
	for t := range grouped {
		typeNames = append(typeNames, t)
	}
	sort.Strings(typeNames)

	var sb strings.Builder
	sb.WriteString("// OMO configuration (managed by OC Manager)\n")
	sb.WriteString("{\n")
	sb.WriteString("  \"$schema\": \"https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/assets/omo.schema.json\",\n")
	sb.WriteString("  \"[opencode]\": {\n")

	firstSection := true
	for _, t := range typeNames {
		if !firstSection {
			sb.WriteString(",\n")
		}
		firstSection = false
		sb.WriteString(fmt.Sprintf("    %q: {\n", t))

		keys := make([]string, 0, len(grouped[t]))
		for k := range grouped[t] {
			keys = append(keys, k)
		}
		sort.Strings(keys)

		firstEntry := true
		for _, k := range keys {
			mc := grouped[t][k]
			if !firstEntry {
				sb.WriteString(",\n")
			}
			firstEntry = false
			sb.WriteString(fmt.Sprintf("      %q: {\n", k))
			sb.WriteString(fmt.Sprintf("        \"model\": %q", mc.Model))
			if mc.Reasoning != "" {
				sb.WriteString(fmt.Sprintf(",\n        \"reasoning\": %q", mc.Reasoning))
			}
			sb.WriteString("\n      }")
		}
		sb.WriteString("\n    }")
	}
	sb.WriteString("\n  }\n}\n")
	return sb.String()
}
