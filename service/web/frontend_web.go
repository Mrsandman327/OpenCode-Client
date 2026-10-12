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
	StartOpenCodeWeb(int, string, string, model.ProxyConfig) model.WebResult
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

// GetLanIPv4 返回本机用于对外通信的局域网 IPv4 地址（供 Web 服务监听地址默认值与手机扫码访问使用）。
// 策略：
//  1. 优先用「默认路由出口法」探测：系统实际对外通信使用的本机 IP，
//     可自动排除 VMware / Hyper-V / WSL / 热点等虚拟网卡的干扰；
//  2. 若失败（如无默认路由），回退为遍历网卡取第一个私有网段 IPv4。
//
// 找不到时返回空字符串。
func GetLanIPv4() string {
	if ip := defaultRouteIPv4(); ip != "" {
		return ip
	}
	return firstPrivateIPv4()
}

// defaultRouteIPv4 通过 UDP Dial 探测默认路由对应的本机 IPv4。
// UDP 的 "connect" 不会真正发出数据包，仅让系统按路由表选择一个源地址，
// 因此不会产生任何网络流量，也不依赖目标地址可达。
func defaultRouteIPv4() string {
	conn, err := net.Dial("udp4", "223.5.5.5:80")
	if err != nil {
		return ""
	}
	defer conn.Close()
	if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok {
		ip := addr.IP.To4()
		if ip != nil && !ip.IsLoopback() {
			return ip.String()
		}
	}
	return ""
}

// firstPrivateIPv4 遍历网卡返回第一个私有网段 IPv4（回退策略）。
// 注意：接口遍历顺序不保证稳定，多虚拟网卡机器上可能取到虚拟地址，故仅作兜底。
func firstPrivateIPv4() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		// 跳过未启用（down）和回环接口，避免取到无效地址。
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipnet.IP.To4()
			// 仅接受私有网段 IPv4（10.x / 172.16-31.x / 192.168.x）。
			if ip == nil || !ip.IsPrivate() {
				continue
			}
			return ip.String()
		}
	}
	return ""
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
