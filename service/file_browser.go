package service

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"oc-manager/model"
)

const fileBrowserTextReadLimit = 2 * 1024 * 1024

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
	items, err := listBrowserDir(rootAbs, absPath, relPath)
	if err != nil {
		return model.FileBrowserListResult{}, err
	}
	return model.FileBrowserListResult{RootDir: rootAbs, CurrentPath: relPath, ParentPath: parentBrowserPath(relPath), Items: items}, nil
}

func StatBrowserFile(rootDir, relPath string) (model.FileBrowserStatResult, error) {
	relPath = normalizeBrowserRelPath(relPath)
	if relPath == "/" {
		return model.FileBrowserStatResult{}, fmt.Errorf("path must target a file")
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
	if info.IsDir() {
		itemType = "dir"
		mimeType = "inode/directory"
	} else {
		previewKind, previewable = detectPreviewMeta(absPath)
	}
	return model.FileBrowserStatResult{RootDir: rootAbs, Name: info.Name(), Path: relPath, Type: itemType, Ext: strings.ToLower(filepath.Ext(info.Name())), Size: info.Size(), ModifiedAt: info.ModTime().Format(time.RFC3339), Mime: mimeType, PreviewKind: previewKind, Previewable: previewable}, nil
}

func ReadBrowserFile(rootDir, relPath string) (model.FileBrowserReadResult, error) {
	relPath = normalizeBrowserRelPath(relPath)
	if relPath == "/" {
		return model.FileBrowserReadResult{}, fmt.Errorf("path must target a file")
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
	previewKind, previewable := detectPreviewMeta(absPath)
	if filepath.Ext(absPath) == "" {
		previewable = true
	}
	if !previewable {
		return model.FileBrowserReadResult{}, fmt.Errorf("该文件类型不支持文本读取")
	}
	if filepath.Ext(absPath) != "" {
		switch previewKind {
		case "markdown", "text", "code", "csv":
		default:
			return model.FileBrowserReadResult{}, fmt.Errorf("该文件类型不支持文本读取")
		}
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

func ReadBrowserRawBase64(rootDir, relPath string) (model.FileBrowserRawResult, error) {
	relPath = normalizeBrowserRelPath(relPath)
	if relPath == "/" {
		return model.FileBrowserRawResult{}, fmt.Errorf("path must target a file")
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
	if relPath == "/" {
		// 根目录本身允许上传，后面按目录处理
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

func (h *frontendWebHandler) handleFilesList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rootDir := strings.TrimSpace(r.URL.Query().Get("rootDir"))
	relPath := normalizeBrowserRelPath(r.URL.Query().Get("path"))
	absPath, rootAbs, err := resolveBrowserPath(rootDir, relPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	info, err := os.Stat(absPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("读取目录失败: %v", err), http.StatusBadRequest)
		return
	}
	if !info.IsDir() {
		http.Error(w, "目标不是目录", http.StatusBadRequest)
		return
	}
	items, err := listBrowserDir(rootAbs, absPath, relPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("列目录失败: %v", err), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(model.FileBrowserListResult{
		RootDir:     rootAbs,
		CurrentPath: relPath,
		ParentPath:  parentBrowserPath(relPath),
		Items:       items,
	})
}

func (h *frontendWebHandler) handleFilesStat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rootDir := strings.TrimSpace(r.URL.Query().Get("rootDir"))
	relPath := normalizeBrowserRelPath(r.URL.Query().Get("path"))
	if relPath == "/" {
		http.Error(w, "path must target a file", http.StatusBadRequest)
		return
	}
	absPath, rootAbs, err := resolveBrowserPath(rootDir, relPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	info, err := os.Stat(absPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("读取文件失败: %v", err), http.StatusBadRequest)
		return
	}
	itemType := "file"
	mimeType := detectBrowserMime(absPath, false)
	previewKind := ""
	previewable := false
	if info.IsDir() {
		itemType = "dir"
		mimeType = "inode/directory"
	} else {
		previewKind, previewable = detectPreviewMeta(absPath)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(model.FileBrowserStatResult{
		RootDir:    rootAbs,
		Name:       info.Name(),
		Path:       relPath,
		Type:       itemType,
		Ext:        strings.ToLower(filepath.Ext(info.Name())),
		Size:       info.Size(),
		ModifiedAt: info.ModTime().Format(time.RFC3339),
		Mime:       mimeType,
		PreviewKind: previewKind,
		Previewable: previewable,
	})
}

func (h *frontendWebHandler) handleFilesRead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rootDir := strings.TrimSpace(r.URL.Query().Get("rootDir"))
	relPath := normalizeBrowserRelPath(r.URL.Query().Get("path"))
	if relPath == "/" {
		http.Error(w, "path must target a file", http.StatusBadRequest)
		return
	}
	absPath, rootAbs, err := resolveBrowserPath(rootDir, relPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	info, err := os.Stat(absPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("读取文件失败: %v", err), http.StatusBadRequest)
		return
	}
	if info.IsDir() {
		http.Error(w, "目标不是文件", http.StatusBadRequest)
		return
	}
	previewKind, previewable := detectPreviewMeta(absPath)
	if filepath.Ext(absPath) == "" {
		previewable = true
	}
	if !previewable {
		http.Error(w, "该文件类型不支持文本读取", http.StatusBadRequest)
		return
	}
	if filepath.Ext(absPath) != "" {
		switch previewKind {
		case "markdown", "text", "code", "csv":
		default:
			http.Error(w, "该文件类型不支持文本读取", http.StatusBadRequest)
			return
		}
	}
	data, err := os.ReadFile(absPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("读取文件失败: %v", err), http.StatusInternalServerError)
		return
	}
	truncated := false
	if len(data) > fileBrowserTextReadLimit {
		data = data[:fileBrowserTextReadLimit]
		truncated = true
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(model.FileBrowserReadResult{
		RootDir:   rootAbs,
		Path:      relPath,
		Content:   string(data),
		Encoding:  "utf-8",
		Truncated: truncated,
	})
}

func (h *frontendWebHandler) handleFilesRaw(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rootDir := strings.TrimSpace(r.URL.Query().Get("rootDir"))
	relPath := normalizeBrowserRelPath(r.URL.Query().Get("path"))
	if relPath == "/" {
		http.Error(w, "path must target a file", http.StatusBadRequest)
		return
	}
	absPath, _, err := resolveBrowserPath(rootDir, relPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	info, err := os.Stat(absPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("读取文件失败: %v", err), http.StatusBadRequest)
		return
	}
	if info.IsDir() {
		http.Error(w, "目标不是文件", http.StatusBadRequest)
		return
	}
	mimeType := detectBrowserMime(absPath, false)
	if mimeType != "" {
		w.Header().Set("Content-Type", mimeType)
	}
	http.ServeFile(w, r, absPath)
}

// handleFilesUpload 处理 Web 端文件浏览器的单文件上传请求。
func (h *frontendWebHandler) handleFilesUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		RootDir   string `json:"rootDir"`
		Path      string `json:"path"`
		FileName  string `json:"fileName"`
		Base64    string `json:"base64"`
		Overwrite bool   `json:"overwrite"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "请求体解析失败", http.StatusBadRequest)
		return
	}
	result, err := UploadBrowserFile(req.RootDir, req.Path, req.FileName, req.Base64, req.Overwrite)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(result)
}

// handleFilesDelete 处理 Web 端文件/目录删除请求。
func (h *frontendWebHandler) handleFilesDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		RootDir string `json:"rootDir"`
		Path    string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "请求体解析失败", http.StatusBadRequest)
		return
	}
	result, err := DeleteBrowserEntry(req.RootDir, req.Path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(result)
}

func normalizeBrowserRelPath(rel string) string {
	rel = strings.TrimSpace(rel)
	if rel == "" || rel == "/" {
		return "/"
	}
	if !strings.HasPrefix(rel, "/") {
		rel = "/" + rel
	}
	if strings.HasSuffix(rel, "/") {
		return rel
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

func listBrowserDir(rootAbs, absPath, relPath string) ([]model.FileBrowserItem, error) {
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

func isTextPreviewFile(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	if ext == "" {
		return true
	}
	switch ext {
	case ".gitignore",".txt", ".log", ".json", ".jsonc", ".yaml", ".yml", ".ini", ".env", ".xml", ".md", ".markdown", ".js", ".ts", ".tsx", ".jsx", ".go", ".sum",".mod",".py", ".java", ".c", ".cpp", ".cc", ".rs", ".sh", ".bash",".bat", ".vbs",".css", ".scss", ".less", ".html", ".htm", ".sql", ".csv":
		return true
	default:
		return false
	}
}
