package filebrowser

import (
	"encoding/base64"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"oc-manager/model"
)

const fileBrowserTextReadLimit = 2 * 1024 * 1024

// ListBrowserFiles 列出指定目录下的文件和子目录。
func ListBrowserFiles(rootDir, relPath string) (model.FileBrowserListResult, error) {
	relPath = normalizeBrowserRelPath(relPath)
	absPath, rootAbs, err := resolveBrowserPath(rootDir, relPath)
	if err != nil {
		return model.FileBrowserListResult{}, err
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return model.FileBrowserListResult{}, fmt.Errorf("读取目录失败: %w", err)
	}
	if !info.IsDir() {
		return model.FileBrowserListResult{}, fmt.Errorf("目标不是目录")
	}
	items, err := listBrowserDir(absPath, relPath)
	if err != nil {
		return model.FileBrowserListResult{}, err
	}
	return model.FileBrowserListResult{RootDir: rootAbs, CurrentPath: relPath, ParentPath: parentBrowserPath(relPath), Items: items}, nil
}

// StatBrowserFile 返回文件或目录的元信息（大小、类型、预览类型等）。
func StatBrowserFile(rootDir, relPath string) (model.FileBrowserStatResult, error) {
	relPath = normalizeBrowserRelPath(relPath)
	if relPath == "/" {
		return model.FileBrowserStatResult{}, fmt.Errorf("路径必须指向文件而非目录")
	}
	absPath, rootAbs, err := resolveBrowserPath(rootDir, relPath)
	if err != nil {
		return model.FileBrowserStatResult{}, err
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return model.FileBrowserStatResult{}, fmt.Errorf("读取文件失败: %w", err)
	}
	itemType := "file"
	mimeType := detectBrowserMime(absPath, false)
	previewKind := ""
	previewable := false
	editable := false
	defaultMode := "preview"
	if info.IsDir() {
		itemType = "dir"
		mimeType = "inode/directory"
	} else {
		previewKind, previewable, defaultMode, editable = detectPreviewMeta(absPath)
	}
	return model.FileBrowserStatResult{RootDir: rootAbs, Name: info.Name(), Path: relPath, Type: itemType, Ext: strings.ToLower(filepath.Ext(info.Name())), Size: info.Size(), ModifiedAt: info.ModTime().Format(time.RFC3339), Mime: mimeType, PreviewKind: previewKind, Previewable: previewable, Editable: editable, DefaultMode: defaultMode}, nil
}

// ReadBrowserFile 以文本方式读取文件内容，超过 2MB 的文件将被截断。
func ReadBrowserFile(rootDir, relPath string) (model.FileBrowserReadResult, error) {
	relPath = normalizeBrowserRelPath(relPath)
	if relPath == "/" {
		return model.FileBrowserReadResult{}, fmt.Errorf("路径必须指向文件而非目录")
	}
	absPath, rootAbs, err := resolveBrowserPath(rootDir, relPath)
	if err != nil {
		return model.FileBrowserReadResult{}, err
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return model.FileBrowserReadResult{}, fmt.Errorf("读取文件失败: %w", err)
	}
	if info.IsDir() {
		return model.FileBrowserReadResult{}, fmt.Errorf("目标不是文件")
	}
	previewKind, previewable, _, editable := detectPreviewMeta(absPath)
	if !previewable {
		return model.FileBrowserReadResult{}, fmt.Errorf("该文件类型不支持文本读取")
	}
	if !editable && previewKind != "markdown" && previewKind != "text" && previewKind != "code" && previewKind != "csv" {
		return model.FileBrowserReadResult{}, fmt.Errorf("该文件类型不支持文本读取")
	}
	data, err := os.ReadFile(absPath)
	if err != nil {
		return model.FileBrowserReadResult{}, fmt.Errorf("读取文件失败: %w", err)
	}
	truncated := false
	if len(data) > fileBrowserTextReadLimit {
		data = data[:fileBrowserTextReadLimit]
		truncated = true
	}
	return model.FileBrowserReadResult{RootDir: rootAbs, Path: relPath, Content: string(data), Encoding: "utf-8", Truncated: truncated}, nil
}

// SaveBrowserFile 保存文件浏览器中的文本文件内容。
func SaveBrowserFile(rootDir, relPath, content string) (model.SaveResult, error) {
	relPath = normalizeBrowserRelPath(relPath)
	if relPath == "/" {
		return model.SaveResult{Success: false, Error: "路径必须指向文件而非目录"}, nil
	}
	absPath, _, err := resolveBrowserPath(rootDir, relPath)
	if err != nil {
		return model.SaveResult{}, err
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return model.SaveResult{}, fmt.Errorf("读取文件失败: %w", err)
	}
	if info.IsDir() {
		return model.SaveResult{Success: false, Error: "目标不是文件"}, nil
	}
	_, _, _, editable := detectPreviewMeta(absPath)
	if !editable {
		return model.SaveResult{Success: false, Error: "该文件类型不支持编辑保存"}, nil
	}
	if err := os.WriteFile(absPath, []byte(content), info.Mode().Perm()); err != nil {
		return model.SaveResult{}, fmt.Errorf("写入文件失败: %w", err)
	}
	return model.SaveResult{Success: true}, nil
}

// ReadBrowserRawBase64 以 base64 编码返回文件的原始字节，用于图片/PDF 等二进制预览。
func ReadBrowserRawBase64(rootDir, relPath string) (model.FileBrowserRawResult, error) {
	relPath = normalizeBrowserRelPath(relPath)
	if relPath == "/" {
		return model.FileBrowserRawResult{}, fmt.Errorf("路径必须指向文件而非目录")
	}
	absPath, rootAbs, err := resolveBrowserPath(rootDir, relPath)
	if err != nil {
		return model.FileBrowserRawResult{}, err
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return model.FileBrowserRawResult{}, fmt.Errorf("读取文件失败: %w", err)
	}
	if info.IsDir() {
		return model.FileBrowserRawResult{}, fmt.Errorf("目标不是文件")
	}
	data, err := os.ReadFile(absPath)
	if err != nil {
		return model.FileBrowserRawResult{}, fmt.Errorf("读取文件失败: %w", err)
	}
	return model.FileBrowserRawResult{
		RootDir: rootAbs,
		Path:    relPath,
		Name:    info.Name(),
		Mime:    detectBrowserMime(absPath, false),
		Base64:  base64.StdEncoding.EncodeToString(data),
	}, nil
}

// UploadBrowserFile 将单个文件上传到当前文件浏览器目录。
// overwrite=false 且存在同名文件时，返回 Conflict=true 供前端弹出覆盖/重命名选择。
func UploadBrowserFile(rootDir, relPath, fileName, base64Data string, overwrite bool) (model.FileBrowserUploadResult, error) {
	relPath = normalizeBrowserRelPath(relPath)
	if strings.TrimSpace(fileName) == "" {
		return model.FileBrowserUploadResult{Success: false, Error: "文件名不能为空"}, nil
	}
	absDir, _, err := resolveBrowserPath(rootDir, relPath)
	if err != nil {
		return model.FileBrowserUploadResult{}, err
	}
	info, err := os.Stat(absDir)
	if err != nil {
		return model.FileBrowserUploadResult{}, fmt.Errorf("读取目录失败: %w", err)
	}
	if !info.IsDir() {
		return model.FileBrowserUploadResult{}, fmt.Errorf("目标不是目录")
	}
	targetPath := filepath.Join(absDir, fileName)
	// 若目标文件已存在且当前不允许覆盖，则返回冲突结果，由前端决定覆盖或重命名。
	if existing, err := os.Stat(targetPath); err == nil && !existing.IsDir() && !overwrite {
		return model.FileBrowserUploadResult{Success: false, Conflict: true, Name: fileName, Error: "文件已存在"}, nil
	}
	// 前端使用 base64 传输文件内容，后端在写入前先解码回原始字节。
	data, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return model.FileBrowserUploadResult{Success: false, Error: "文件内容解析失败"}, nil
	}
	if err := os.WriteFile(targetPath, data, 0644); err != nil {
		return model.FileBrowserUploadResult{}, fmt.Errorf("写入文件失败: %w", err)
	}
	return model.FileBrowserUploadResult{Success: true, Name: fileName}, nil
}

// CreateBrowserDir 在文件浏览器当前目录下创建子目录。
func CreateBrowserDir(rootDir, relPath, dirName string) (model.SaveResult, error) {
	relPath = normalizeBrowserRelPath(relPath)
	dirName = strings.TrimSpace(dirName)
	if dirName == "" {
		return model.SaveResult{Success: false, Error: "文件夹名称不能为空"}, nil
	}
	if strings.ContainsAny(dirName, `\\/:*?"<>|`) {
		return model.SaveResult{Success: false, Error: "文件夹名称包含非法字符（\\ / : * ? \" < > |）"}, nil
	}
	if dirName == "." || dirName == ".." {
		return model.SaveResult{Success: false, Error: "文件夹名称不合法"}, nil
	}
	absDir, _, err := resolveBrowserPath(rootDir, relPath)
	if err != nil {
		return model.SaveResult{}, err
	}
	info, err := os.Stat(absDir)
	if err != nil {
		return model.SaveResult{}, fmt.Errorf("读取目录失败: %w", err)
	}
	if !info.IsDir() {
		return model.SaveResult{Success: false, Error: "目标不是目录"}, nil
	}
	targetPath := filepath.Join(absDir, dirName)
	if _, err := os.Stat(targetPath); err == nil {
		return model.SaveResult{Success: false, Error: "同名文件或文件夹已存在"}, nil
	} else if !os.IsNotExist(err) {
		return model.SaveResult{}, fmt.Errorf("检查目录失败: %w", err)
	}
	if err := os.Mkdir(targetPath, 0755); err != nil {
		return model.SaveResult{}, fmt.Errorf("创建文件夹失败: %w", err)
	}
	return model.SaveResult{Success: true}, nil
}

// DeleteBrowserEntry 删除文件浏览器中的单个文件或目录。
// 为了避免误删根目录，本函数禁止删除 relPath == "/" 的目标。
func DeleteBrowserEntry(rootDir, relPath string) (model.SaveResult, error) {
	relPath = normalizeBrowserRelPath(relPath)
	if relPath == "/" {
		return model.SaveResult{Success: false, Error: "禁止删除根目录"}, nil
	}
	absPath, _, err := resolveBrowserPath(rootDir, relPath)
	if err != nil {
		return model.SaveResult{}, err
	}
	if _, err := os.Stat(absPath); err != nil {
		return model.SaveResult{}, fmt.Errorf("目标不存在: %w", err)
	}
	if err := os.RemoveAll(absPath); err != nil {
		return model.SaveResult{}, fmt.Errorf("删除失败: %w", err)
	}
	return model.SaveResult{Success: true}, nil
}

func normalizeBrowserRelPath(rel string) string {
	rel = strings.TrimSpace(rel)
	if rel == "" || rel == "/" {
		return "/"
	}
	if !strings.HasPrefix(rel, "/") {
		rel = "/" + rel
	}
	return rel
}

func resolveBrowserPath(rootDir, relPath string) (string, string, error) {
	if strings.TrimSpace(rootDir) == "" {
		return "", "", fmt.Errorf("rootDir 不能为空")
	}
	rootAbs, err := filepath.Abs(filepath.Clean(rootDir))
	if err != nil {
		return "", "", fmt.Errorf("解析根目录失败: %w", err)
	}
	info, err := os.Stat(rootAbs)
	if err != nil {
		return "", "", fmt.Errorf("根目录不存在: %w", err)
	}
	if !info.IsDir() {
		return "", "", fmt.Errorf("rootDir 不是目录")
	}
	relPath = normalizeBrowserRelPath(relPath)
	cleanRel := strings.TrimPrefix(relPath, "/")
	joined := filepath.Join(rootAbs, filepath.FromSlash(cleanRel))
	absPath, err := filepath.Abs(filepath.Clean(joined))
	if err != nil {
		return "", "", fmt.Errorf("解析目标路径失败: %w", err)
	}
	relCheck, err := filepath.Rel(rootAbs, absPath)
	if err != nil {
		return "", "", fmt.Errorf("路径校验失败: %w", err)
	}
	if relCheck == ".." || strings.HasPrefix(relCheck, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("禁止访问根目录之外的路径")
	}
	return absPath, rootAbs, nil
}

func listBrowserDir(absPath, relPath string) ([]model.FileBrowserItem, error) {
	entries, err := os.ReadDir(absPath)
	if err != nil {
		return nil, err
	}
	items := make([]model.FileBrowserItem, 0, len(entries))
	for _, entry := range entries {
		entryPath := filepath.Join(absPath, entry.Name())
		info, err := entry.Info()
		if err != nil {
			continue
		}
		itemPath := joinBrowserPath(relPath, entry.Name(), info.IsDir())
		itemType := "file"
		mimeType := detectBrowserMime(entryPath, info.IsDir())
		size := info.Size()
		if info.IsDir() {
			itemType = "dir"
			size = 0
		}
		items = append(items, model.FileBrowserItem{
			Name:       info.Name(),
			Path:       itemPath,
			Type:       itemType,
			Ext:        strings.ToLower(filepath.Ext(info.Name())),
			Size:       size,
			ModifiedAt: info.ModTime().Format(time.RFC3339),
			Mime:       mimeType,
		})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Type != items[j].Type {
			return items[i].Type == "dir"
		}
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})
	return items, nil
}

func joinBrowserPath(currentPath, name string, isDir bool) string {
	base := normalizeBrowserRelPath(currentPath)
	if base == "/" {
		base = ""
	}
	p := base + "/" + name
	p = strings.ReplaceAll(p, "//", "/")
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	if isDir && !strings.HasSuffix(p, "/") {
		p += "/"
	}
	return p
}

func parentBrowserPath(currentPath string) string {
	currentPath = normalizeBrowserRelPath(currentPath)
	if currentPath == "/" {
		return "/"
	}
	p := strings.TrimSuffix(currentPath, "/")
	idx := strings.LastIndex(p, "/")
	if idx <= 0 {
		return "/"
	}
	parent := p[:idx+1]
	if parent == "" {
		return "/"
	}
	return parent
}

func detectBrowserMime(path string, isDir bool) string {
	if isDir {
		return "inode/directory"
	}
	ext := strings.ToLower(filepath.Ext(path))
	if ext == "" {
		return "application/octet-stream"
	}
	if mt := mime.TypeByExtension(ext); mt != "" {
		return mt
	}
	return "application/octet-stream"
}
