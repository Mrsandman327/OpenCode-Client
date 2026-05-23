package service

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// FilePreviewTypeConfig 描述单种文件预览分类规则。
type FilePreviewTypeConfig struct {
	Name        string   `json:"name"`
	PreviewKind string   `json:"previewKind"`
	Previewable bool     `json:"previewable"`
	Extensions  []string `json:"extensions"`
}

// FilePreviewConfig 表示完整的文件预览配置。
type FilePreviewConfig struct {
	Types []FilePreviewTypeConfig `json:"types"`
}

var (
	filePreviewConfigOnce sync.Once
	filePreviewTypeByExt  map[string]FilePreviewTypeConfig
)

// loadFilePreviewConfig 读取并缓存文件类型预览配置。
// 配置文件路径固定为可执行文件目录下的 configs/file-types/file-preview-types.json。
func loadFilePreviewConfig() map[string]FilePreviewTypeConfig {
	filePreviewConfigOnce.Do(func() {
		filePreviewTypeByExt = defaultFilePreviewTypeMap()
		exePath, err := os.Executable()
		if err != nil {
			return
		}
		configPath := filepath.Join(filepath.Dir(exePath), "configs", "file-types", "file-preview-types.json")
		data, err := os.ReadFile(configPath)
		if err != nil {
			return
		}
		var cfg FilePreviewConfig
		if err := json.Unmarshal(data, &cfg); err != nil {
			return
		}
		custom := make(map[string]FilePreviewTypeConfig)
		for _, item := range cfg.Types {
			for _, ext := range item.Extensions {
				custom[strings.ToLower(strings.TrimSpace(ext))] = item
			}
		}
		if len(custom) > 0 {
			filePreviewTypeByExt = custom
		}
	})
	return filePreviewTypeByExt
}

// detectPreviewMeta 根据扩展名返回统一的预览类别与是否可预览。
func detectPreviewMeta(path string) (string, bool) {
	ext := strings.ToLower(filepath.Ext(path))
	if ext == "" {
		return "", false
	}
	if item, ok := loadFilePreviewConfig()[ext]; ok {
		return item.PreviewKind, item.Previewable
	}
	return "binary", false
}

// defaultFilePreviewTypeMap 提供配置缺失时的内置默认规则。
func defaultFilePreviewTypeMap() map[string]FilePreviewTypeConfig {
	items := []FilePreviewTypeConfig{
		{Name: "markdown", PreviewKind: "markdown", Previewable: true, Extensions: []string{".md", ".markdown"}},
		{Name: "text", PreviewKind: "text", Previewable: true, Extensions: []string{".txt", ".log", ".ini", ".env", ".yaml", ".yml", ".xml", ".toml", ".conf"}},
		{Name: "code", PreviewKind: "code", Previewable: true, Extensions: []string{".js", ".jsx", ".ts", ".tsx", ".go", ".sum", ".mod", ".py", ".java", ".c", ".cpp", ".cc", ".rs", ".sh", ".bash", ".bat", ".vbs", ".css", ".scss", ".less", ".html", ".htm", ".sql"}},
		{Name: "json", PreviewKind: "code", Previewable: true, Extensions: []string{".json", ".jsonc"}},
		{Name: "csv", PreviewKind: "csv", Previewable: true, Extensions: []string{".csv"}},
		{Name: "spreadsheet", PreviewKind: "spreadsheet", Previewable: true, Extensions: []string{".xlsx", ".xls"}},
		{Name: "image", PreviewKind: "image", Previewable: true, Extensions: []string{".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}},
		{Name: "pdf", PreviewKind: "pdf", Previewable: true, Extensions: []string{".pdf"}},
		{Name: "binary", PreviewKind: "binary", Previewable: false, Extensions: []string{".zip", ".rar", ".7z", ".exe", ".dll", ".so", ".bin"}},
	}
	result := make(map[string]FilePreviewTypeConfig)
	for _, item := range items {
		for _, ext := range item.Extensions {
			result[ext] = item
		}
	}
	return result
}
