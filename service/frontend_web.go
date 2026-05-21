package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"sync"
	"time"

	"oc-manager/model"
)

type FrontendWebBridge interface {
	GetProjectTree(string) string
	OpenCodeAPI(string, string, string) model.APIResult
	CreateSession(string) model.APIResult
	GetAvailableModels() ([]string, error)
	StartOpenCodeEvents() model.APIResult
	StopOpenCodeEvents() model.APIResult
	StartOpenCodeWeb(int, string, model.ProxyConfig) model.WebResult
	GetWebStatus(string, int) model.WebResult
	StopOpenCodeWeb() model.WebResult
	AppCall(string, []json.RawMessage) (interface{}, error)
}

type frontendWebSession struct {
	server   *http.Server
	listener net.Listener
	hostname string
	port     int
	url      string
}

var (
	frontendWebMu2   sync.Mutex
	frontendCurrent  *frontendWebSession
	frontendLastHost = "127.0.0.1"
	frontendLastPort = 8081
)

func StartFrontendWebServer(frontendFS fs.FS, bridge FrontendWebBridge, port int, hostname string) model.WebResult {
	if hostname == "" {
		hostname = frontendLastHost
	}
	if port < 0 {
		port = 0
	}

	frontendWebMu2.Lock()
	if frontendCurrent != nil {
		result := model.WebResult{Running: true, Success: true, URL: frontendCurrent.url, Health: "在线"}
		frontendWebMu2.Unlock()
		return result
	}
	frontendWebMu2.Unlock()

	handler := newFrontendWebHandler(frontendFS, bridge)
	addr := fmt.Sprintf("%s:%d", hostname, port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return model.WebResult{Error: fmt.Sprintf("启动页面 Web 服务失败: %v", err)}
	}
	actualPort := listener.Addr().(*net.TCPAddr).Port
	url := fmt.Sprintf("http://%s:%d", hostname, actualPort)
	server := &http.Server{Handler: handler}
	sess := &frontendWebSession{server: server, listener: listener, hostname: hostname, port: actualPort, url: url}

	frontendWebMu2.Lock()
	frontendCurrent = sess
	frontendLastHost = hostname
	frontendLastPort = actualPort
	frontendWebMu2.Unlock()

	go func() {
		_ = server.Serve(listener)
		frontendWebMu2.Lock()
		if frontendCurrent == sess {
			frontendCurrent = nil
		}
		frontendWebMu2.Unlock()
	}()

	return model.WebResult{Running: true, Success: true, URL: url, Health: "在线"}
}

func StopFrontendWebServer() model.WebResult {
	frontendWebMu2.Lock()
	sess := frontendCurrent
	frontendCurrent = nil
	frontendWebMu2.Unlock()
	if sess == nil {
		return model.WebResult{Success: true, URL: fmt.Sprintf("http://%s:%d", frontendLastHost, frontendLastPort), Health: "离线"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := sess.server.Shutdown(ctx); err != nil {
		return model.WebResult{Error: fmt.Sprintf("停止页面 Web 服务失败: %v", err), URL: sess.url}
	}
	return model.WebResult{Success: true, URL: sess.url, Health: "离线"}
}

func FrontendWebStatus(hostname string, port int) model.WebResult {
	frontendWebMu2.Lock()
	defer frontendWebMu2.Unlock()
	if frontendCurrent != nil {
		return model.WebResult{Running: true, Success: true, URL: frontendCurrent.url, Health: "在线"}
	}
	if hostname == "" {
		hostname = frontendLastHost
	}
	if port <= 0 {
		port = frontendLastPort
	}
	return model.WebResult{URL: fmt.Sprintf("http://%s:%d", hostname, port), Health: "离线"}
}

type frontendWebHandler struct {
	bridge FrontendWebBridge
	fs     fs.FS
}

func newFrontendWebHandler(frontendFS fs.FS, bridge FrontendWebBridge) http.Handler {
	h := &frontendWebHandler{bridge: bridge, fs: frontendFS}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/project-tree", h.handleProjectTree)
	mux.HandleFunc("/api/app-call", h.handleAppCall)
	mux.HandleFunc("/api/open-code", h.handleOpenCode)
	mux.HandleFunc("/api/session/create", h.handleCreateSession)
	mux.HandleFunc("/api/models", h.handleModels)
	mux.HandleFunc("/api/open-code-web/start", h.handleOpenCodeWebStart)
	mux.HandleFunc("/api/open-code-web/status", h.handleOpenCodeWebStatus)
	mux.HandleFunc("/api/open-code-web/stop", h.handleOpenCodeWebStop)
	mux.HandleFunc("/api/open-code-events/start", h.handleOpenCodeEventsStart)
	mux.HandleFunc("/api/open-code-events/stop", h.handleOpenCodeEventsStop)
	mux.HandleFunc("/api/files/list", h.handleFilesList)
	mux.HandleFunc("/api/files/stat", h.handleFilesStat)
	mux.HandleFunc("/api/files/read", h.handleFilesRead)
	mux.HandleFunc("/api/files/raw", h.handleFilesRaw)
	mux.HandleFunc("/api/git/status", h.handleGitStatus)
	mux.HandleFunc("/api/git/preview", h.handleGitPreview)
	mux.HandleFunc("/api/git/history", h.handleGitHistory)
	mux.HandleFunc("/api/git/history/files", h.handleGitHistoryFiles)
	mux.HandleFunc("/api/git/history/preview", h.handleGitHistoryPreview)
	mux.HandleFunc("/api/git/stage", h.handleGitStage)
	mux.HandleFunc("/api/git/unstage", h.handleGitUnstage)
	mux.HandleFunc("/api/git/stage-all", h.handleGitStageAll)
	mux.HandleFunc("/api/git/commit", h.handleGitCommit)
	mux.HandleFunc("/api/git/push", h.handleGitPush)
	mux.HandleFunc("/api/git/pull", h.handleGitPull)
	mux.HandleFunc("/events", h.handleEvents)
	mux.Handle("/", http.FileServer(http.FS(frontendFS)))
	//用户文件服务,支持热切换
	fs := NewSwitchableFileServer("./files")
	mux.Handle("/files/", fs)
	mux.HandleFunc("/api/switch-dir", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		newDir := r.FormValue("directory")
		if newDir == "" {
			http.Error(w, "directory parameter required", http.StatusBadRequest)
			return
		}

		fs.SetDirectory(newDir)
		w.Write([]byte("Directory switched to: " + newDir))
	})

	// 查询当前目录
	mux.HandleFunc("/api/current-dir", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("Current directory: " + fs.GetDirectory()))
	})
	return mux
}

func (h *frontendWebHandler) handleProjectTree(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
	knownDirs := r.URL.Query().Get("knownDirs")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = io.WriteString(w, h.bridge.GetProjectTree(knownDirs))
}

func (h *frontendWebHandler) handleOpenCode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
	var payload struct{ Method, Path, Body string }
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(model.APIResult{Error: fmt.Sprintf("请求体解析失败: %v", err)})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(h.bridge.OpenCodeAPI(payload.Method, payload.Path, payload.Body))
}

func (h *frontendWebHandler) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
	var payload struct{ Dir string `json:"dir"` }
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(model.APIResult{Error: fmt.Sprintf("请求体解析失败: %v", err)})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(h.bridge.CreateSession(payload.Dir))
}

func (h *frontendWebHandler) handleModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
	models, err := h.bridge.GetAvailableModels()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if err != nil { _ = json.NewEncoder(w).Encode([]string{}); return }
	_ = json.NewEncoder(w).Encode(models)
}

func (h *frontendWebHandler) handleOpenCodeEventsStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(h.bridge.StartOpenCodeEvents())
}
func (h *frontendWebHandler) handleOpenCodeEventsStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(h.bridge.StopOpenCodeEvents())
}
func (h *frontendWebHandler) handleOpenCodeWebStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
	var payload struct{ Port int `json:"port"`; Hostname string `json:"hostname"`; Proxy model.ProxyConfig `json:"proxy"` }
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(model.WebResult{Error: fmt.Sprintf("请求体解析失败: %v", err)})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(h.bridge.StartOpenCodeWeb(payload.Port, payload.Hostname, payload.Proxy))
}
func (h *frontendWebHandler) handleOpenCodeWebStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
	hostname := r.URL.Query().Get("hostname")
	port := 0
	if raw := r.URL.Query().Get("port"); raw != "" { fmt.Sscanf(raw, "%d", &port) }
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(h.bridge.GetWebStatus(hostname, port))
}
func (h *frontendWebHandler) handleOpenCodeWebStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(h.bridge.StopOpenCodeWeb())
}

func (h *frontendWebHandler) handleAppCall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
	var payload struct{ Method string `json:"method"`; Args []json.RawMessage `json:"args"` }
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil { http.Error(w, fmt.Sprintf("bad request: %v", err), http.StatusBadRequest); return }
	result, err := h.bridge.AppCall(payload.Method, payload.Args)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if err != nil { w.WriteHeader(http.StatusBadRequest); _ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()}); return }
	_ = json.NewEncoder(w).Encode(result)
}

func (h *frontendWebHandler) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok { http.Error(w, "streaming unsupported", http.StatusInternalServerError); return }
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	id, ch := SubscribeBrowserSSE()
	defer UnsubscribeBrowserSSE(id)
	_, _ = io.WriteString(w, ": connected\n\n")
	flusher.Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case event, ok := <-ch:
			if !ok { return }
			_, _ = io.WriteString(w, FormatBrowserSSE(event))
			flusher.Flush()
		}
	}
}
