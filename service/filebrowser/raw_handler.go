package filebrowser

import (
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// ServeRawFile 提供支持 HTTP Range 的原始文件读取。
//
// 用途：<video> / <audio> 播放时，浏览器会按需发送 Range 请求，
// 由 http.ServeContent 返回 206 Partial Content，实现边下边播和拖动进度，
// 不需要把整个文件读进内存。
//
// 查询参数：
//
//	root - 文件浏览器根目录
//	path - 相对路径
//
// 复用 resolveBrowserPath 做目录越界校验，避免访问根目录之外的文件。
func ServeRawFile(w http.ResponseWriter, r *http.Request) {
	rootDir := strings.TrimSpace(r.URL.Query().Get("root"))
	relPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if rootDir == "" || relPath == "" {
		http.Error(w, "missing root or path", http.StatusBadRequest)
		return
	}

	absPath, _, err := resolveBrowserPath(rootDir, normalizeBrowserRelPath(relPath))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	f, err := os.Open(absPath)
	if err != nil {
		http.Error(w, "open file failed", http.StatusNotFound)
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil || info.IsDir() {
		http.Error(w, "not a file", http.StatusBadRequest)
		return
	}

	// 优先按扩展名给出 Content-Type；未知类型交给 ServeContent 嗅探。
	if ct := mime.TypeByExtension(filepath.Ext(absPath)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}

	// ServeContent 会自动处理 Range、206、Accept-Ranges、Last-Modified。
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}
