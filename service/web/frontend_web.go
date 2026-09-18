package web

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
	"oc-manager/service/opencode"
)

type FrontendWebBridge interface {
	GetProjectTree(string) string
	OpenCodeAPI(string, string, string) model.APIResult
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
	frontendWebMu   sync.Mutex
	frontendCurrent  *frontendWebSession
	frontendLastHost = "127.0.0.1"
	frontendLastPort = 8081
	// sseHeartbeatInterval 是 SSE 事件流的心跳间隔。
	// 取 15 秒：远低于常见浏览器/反向代理/TCP keepalive 的空闲超时门槛(通常 30~120 秒)，
	// 又足够稀疏，不会给空闲连接带来明显流量负担。定义为变量便于测试缩短间隔。
	sseHeartbeatInterval = 15 * time.Second
)

func StartFrontendWebServer(frontendFS fs.FS, bridge FrontendWebBridge, port int, hostname string) model.WebResult {
	if hostname == "" {
		hostname = frontendLastHost
	}
	if port < 0 {
		port = 0
	}

	frontendWebMu.Lock()
	if frontendCurrent != nil {
		result := model.WebResult{Running: true, Success: true, URL: frontendCurrent.url, Health: "在线"}
		frontendWebMu.Unlock()
		return result
	}
	frontendWebMu.Unlock()

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

	frontendWebMu.Lock()
	frontendCurrent = sess
	frontendLastHost = hostname
	frontendLastPort = actualPort
	frontendWebMu.Unlock()

	go func() {
		_ = server.Serve(listener)
		frontendWebMu.Lock()
		if frontendCurrent == sess {
			frontendCurrent = nil
		}
		frontendWebMu.Unlock()
	}()

	return model.WebResult{Running: true, Success: true, URL: url, Health: "在线"}
}

func StopFrontendWebServer() model.WebResult {
	frontendWebMu.Lock()
	sess := frontendCurrent
	frontendCurrent = nil
	frontendWebMu.Unlock()
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
	frontendWebMu.Lock()
	defer frontendWebMu.Unlock()
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
	mux.HandleFunc("/api/app-call", h.handleAppCall)
	mux.HandleFunc("/events", h.handleEvents)
	mux.Handle("/", http.FileServer(http.FS(frontendFS)))
	return mux
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
	id, ch := opencode.SubscribeBrowserSSE()
	defer opencode.UnsubscribeBrowserSSE(id)
	_, _ = io.WriteString(w, ": connected\n\n")
	flusher.Flush()
	// 心跳：空闲时没有任何业务事件，连接上零流量会被浏览器/TCP keepalive/中间代理判定超时而切断。
	// 定期发送 SSE 注释行（以冒号开头）作为心跳，浏览器 EventSource 会自动忽略注释，不触发 oc-event。
	ticker := time.NewTicker(sseHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			// 写失败说明连接已经断开，直接退出以释放订阅与 goroutine 资源
			if _, err := io.WriteString(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case event, ok := <-ch:
			if !ok { return }
			_, _ = io.WriteString(w, opencode.FormatBrowserSSE(event))
			flusher.Flush()
		}
	}
}
