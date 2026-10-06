// Package service 处理 OpenCode 服务管理、API 代理、SSE 事件流、会话 CRUD、项目树构建和终端启动。
//
// 说明：自 OpenCode v2 起，服务由「用户级共享后台服务（daemon）」托管，通过
// `opencode service` 子命令启停，OC Manager 不再自己 spawn `opencode serve`
// 进程，而是调用 service 命令 + 读取服务注册文件 state/service.json 来连接。
package opencode

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"oc-manager/internal/executil"
	"oc-manager/model"
)

// webSession 记录当前连接的 OpenCode v2 共享服务。
// v2 服务由 `opencode service start` 以 detached 方式托管，OC Manager 只负责
// 调用命令与连接，不持有进程句柄，因此这里不再有 cmd 字段。
type webSession struct {
	port     int
	hostname string
	// password 是 v2 Basic 认证口令，来自服务注册文件 state/service.json。
	password string
}

const (
	defaultHostname = "127.0.0.1"
	// defaultPort 是 OpenCode v2 共享后台服务的默认端口（渠道 latest/dev/beta/next 均为 49374）。
	defaultPort = 49374
)

var (
	WebSess     *webSession
	WebSessMu   sync.Mutex
	LastCfgHost = defaultHostname
	LastCfgPort = defaultPort
)

// ========== opencode service 命令封装 ==========

// resolveOpencodeBin 返回 ocmanger 要启动的 opencode 可执行文件路径。
// 优先使用程序目录下 tools/opencode.exe（便携模式，与 configs/ 同级），
// 不存在时回退到 PATH 上的 opencode（开发环境、未放置便携版时保持可用）。
func resolveOpencodeBin() string {
	if exePath, err := os.Executable(); err == nil {
		toolsDir := filepath.Join(filepath.Dir(exePath), "tools")
		// 按平台常见命名依次探测：Windows 为 opencode.exe，类 Unix 为 opencode
		for _, name := range []string{"opencode.exe", "opencode"} {
			candidate := filepath.Join(toolsDir, name)
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				return candidate
			}
		}
	}
	return "opencode"
}

// runOpencodeService 执行 `opencode service <args...>`，返回合并后的输出。
// 可执行文件优先取程序目录下的 tools/opencode.exe（见 resolveOpencodeBin）。
func runOpencodeService(args ...string) (string, error) {
	cmd := exec.Command(resolveOpencodeBin(), append([]string{"service"}, args...)...)
	executil.SetHideWindow(cmd, true)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// setSession 更新当前会话。
func setSession(hostname string, port int, password string) {
	WebSessMu.Lock()
	WebSess = &webSession{hostname: hostname, port: port, password: password}
	WebSessMu.Unlock()
}

// ensureServiceConfig 保证共享服务配置与期望一致：
// 先读 $XDG_CONFIG_HOME/opencode/service.json，仅在存在差异时执行 service set
// （service set 会停掉正在运行的服务，因此值相同就跳过）。
func ensureServiceConfig(hostname string, port int, password string) error {
	cur := readServiceConfig()
	if cur == nil {
		cur = &serviceConfig{}
	}
	if cur.Hostname != hostname {
		if _, err := runOpencodeService("set", "hostname", hostname); err != nil {
			return fmt.Errorf("设置服务 hostname 失败: %v", err)
		}
	}
	if cur.Port != port {
		if _, err := runOpencodeService("set", "port", strconv.Itoa(port)); err != nil {
			return fmt.Errorf("设置服务端口失败: %v", err)
		}
	}
	if password != "" && cur.Password != password {
		if _, err := runOpencodeService("set", "password", password); err != nil {
			return fmt.Errorf("设置服务口令失败: %v", err)
		}
	}
	return nil
}

// StartOpenCodeWeb 启动 OpenCode v2 共享后台服务。
//
// 流程：
//  1. 若本进程已连接同一地址的服务，直接返回其状态；
//  2. 启动前拦截：机器上已有 opencode 服务在运行（v1 的 serve / v2 的 service，
//     含外部启动与上次残留）→ 一律要求先关闭，避免并存两套服务/两套数据；
//  3. 端口预检：被占用则立即报错（避免 service start 等到 120 秒超时）；
//  4. 与目标配置有差异时，service set hostname/port/password；
//  5. opencode service start；
//  6. 读取注册文件 state/service.json 拿到 url/password 并连接。
//
// 说明：本程序不再自动连接"已经运行的服务"——必须由本程序自己启动（见步骤 2 拦截）。
func StartOpenCodeWeb(port int, hostname string, password string, proxy model.ProxyConfig) model.WebResult {
	if hostname == "" {
		hostname = defaultHostname
	}
	if port <= 0 {
		port = defaultPort
	}
	LastCfgHost = hostname
	LastCfgPort = port

	// 1) 本会话已连接的服务
	WebSessMu.Lock()
	if WebSess != nil {
		h, p, pwd := WebSess.hostname, WebSess.port, WebSess.password
		WebSessMu.Unlock()
		if h != hostname || p != port {
			return model.WebResult{Error: "OpenCode 服务已启动；修改地址或端口前请先停止服务"}
		}
		health, version, _ := getOpenCodeHealthWithAuth(h, p, pwd)
		return model.WebResult{Running: true, Success: true, URL: fmt.Sprintf("http://%s:%d", h, p), Health: health, Version: version}
	}
	WebSessMu.Unlock()

	// 2) 启动前拦截：机器上只要存在运行中的 opencode 服务（v1 的 serve / v2 的
	//    service，含外部启动与上次崩溃残留），就要求用户先关闭，不再自动连接。
	if running, desc := findRunningOpencodeService(); running {
		if desc != "" {
			return model.WebResult{Error: "检测到已有 OpenCode 服务正在运行（" + desc + "），请先关闭后再启动"}
		}
		return model.WebResult{Error: "检测到已有 OpenCode 服务正在运行，请先关闭后再启动"}
	}

	// 3) 端口预检：被占用立即报错
	if isPortInUse(hostname, port) {
		return model.WebResult{Error: fmt.Sprintf("端口 %s:%d 已被占用，请更换端口或关闭占用程序", hostname, port)}
	}

	// 4) 配置共享服务（有差异时才 set）
	if err := ensureServiceConfig(hostname, port, password); err != nil {
		return model.WebResult{Error: err.Error()}
	}
	// 代理设置（best effort）：写入服务进程环境变量
	applyProxyToService(proxy)

	// 5) 启动共享服务
	if out, err := runOpencodeService("start"); err != nil {
		msg := out
		if msg == "" {
			msg = err.Error()
		}
		return model.WebResult{Error: "启动 OpenCode 服务失败: " + msg}
	}

	// 6) 读取注册文件连接
	info := readServiceRegistration()
	if info == nil || info.URL == "" {
		return model.WebResult{Error: "服务已启动但未找到注册文件，请稍后重试"}
	}
	h, p := serviceHostPort(info.URL)
	if p == 0 {
		h, p = hostname, port
	}
	setSession(h, p, info.Password)
	health, version, ok := getOpenCodeHealthWithAuth(h, p, info.Password)
	if !ok {
		return model.WebResult{Error: "服务已启动但健康检查失败"}
	}
	return model.WebResult{Running: true, Success: true, URL: fmt.Sprintf("http://%s:%d", h, p), Health: health, Version: version}
}

// applyProxyToService 把代理设置写入共享服务的环境变量（best effort，不阻断启动）。
func applyProxyToService(proxy model.ProxyConfig) {
	if !proxy.ProxyEnabled {
		return
	}
	host := strings.TrimSpace(proxy.ProxyHost)
	proxyPort := strings.TrimSpace(proxy.ProxyPort)
	if host == "" {
		host = "127.0.0.1"
	}
	if proxyPort == "" {
		proxyPort = "7897"
	}
	proxyURL := fmt.Sprintf("http://%s:%s", host, proxyPort)
	for _, kv := range [][2]string{
		{"HTTP_PROXY", proxyURL},
		{"HTTPS_PROXY", proxyURL},
		{"ALL_PROXY", proxyURL},
		{"NO_PROXY", "localhost,127.0.0.1"},
	} {
		_, _ = runOpencodeService("set", "env", kv[0], kv[1])
	}
}

// StopOpenCodeWeb 停止 OpenCode 共享后台服务（真停止并清理注册文件）。
func StopOpenCodeWeb() model.WebResult {
	StopOpenCodeEvents()

	WebSessMu.Lock()
	WebSess = nil
	WebSessMu.Unlock()

	if out, err := runOpencodeService("stop"); err != nil {
		msg := out
		if msg == "" {
			msg = err.Error()
		}
		return model.WebResult{Error: msg}
	}
	return model.WebResult{}
}

// discoverOpenCodeServer 通过读取 V2 服务注册文件（state/service.json）发现运行中的服务，
// 并用 /api/info 严格探活。返回 (hostname, port, password, ok)。
func discoverOpenCodeServer() (string, int, string, bool) {
	info := readServiceRegistration()
	if info == nil || info.URL == "" {
		return "", 0, "", false
	}
	h, p := serviceHostPort(info.URL)
	if p == 0 {
		return "", 0, "", false
	}
	if probeOpenCodeHealth(h, p, info.Password) {
		return h, p, info.Password, true
	}
	return "", 0, "", false
}

// probeOpenCodeHealth 严格探测 /api/info：仅 2xx 视为存活。
func probeOpenCodeHealth(hostname string, port int, password string) bool {
	client := http.Client{Timeout: 2 * time.Second}
	req, err := http.NewRequest(http.MethodGet, serverInfoURL(hostname, port), nil)
	if err != nil {
		return false
	}
	applyAuth(req, password)
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

// GetWebStatus 返回当前服务状态。hostname/port 为前端配置的服务地址。
func GetWebStatus(hostname string, port int) model.WebResult {
	if hostname == "" {
		hostname = defaultHostname
	}
	if port <= 0 {
		port = defaultPort
	}
	LastCfgHost = hostname
	LastCfgPort = port

	WebSessMu.Lock()
	if WebSess != nil {
		h, p, pwd := WebSess.hostname, WebSess.port, WebSess.password
		WebSessMu.Unlock()
		health, version, _ := getOpenCodeHealthWithAuth(h, p, pwd)
		return model.WebResult{Running: true, Success: true, URL: fmt.Sprintf("http://%s:%d", h, p), Health: health, Version: version}
	}
	WebSessMu.Unlock()

	// 自动发现注册文件描述的服务
	if h, p, pwd, ok := discoverOpenCodeServer(); ok {
		setSession(h, p, pwd)
		health, version, _ := getOpenCodeHealthWithAuth(h, p, pwd)
		return model.WebResult{Running: true, Success: true, URL: fmt.Sprintf("http://%s:%d", h, p), Health: health, Version: version}
	}

	return model.WebResult{URL: fmt.Sprintf("http://%s:%d", hostname, port), Health: "离线"}
}

// getWebSession 返回当前会话；未连接时尝试从注册文件自动发现。
func getWebSession() *webSession {
	WebSessMu.Lock()
	sess := WebSess
	WebSessMu.Unlock()
	if sess != nil {
		return sess
	}
	if h, p, pwd, ok := discoverOpenCodeServer(); ok {
		setSession(h, p, pwd)
		return &webSession{hostname: h, port: p, password: pwd}
	}
	return nil
}

// LaunchWindowsTerminal 在外部终端中打开 opencode（v2 命令形态）。
func LaunchWindowsTerminal(mode, webURL, dir string) model.WebResult {
	// 与 runOpencodeService 保持一致：优先使用程序目录下的 tools/opencode.exe
	args := []string{resolveOpencodeBin()}
	if mode == "attach" && webURL != "" {
		// v2 移除了 `attach` 子命令，改用顶层 --server 连接指定服务
		args = append(args, "--server", webURL)
	}
	if dir != "" {
		// v2 目录为位置参数（不再是 --dir）
		args = append(args, dir)
	}

	// v2 服务强制 Basic 认证：终端客户端用 --server 连接时不会自动带口令，
	// 需通过环境变量 OPENCODE_SERVER_PASSWORD 提供（用户名固定 opencode）。
	var env []string
	if info := readServiceRegistration(); info != nil && info.Password != "" {
		env = append(env, "OPENCODE_SERVER_PASSWORD="+info.Password)
	}

	cmd, err := launchTerminal(args, env)
	if err != nil {
		return model.WebResult{Error: err.Error()}
	}
	if err := cmd.Start(); err != nil {
		return model.WebResult{Error: fmt.Sprintf("启动终端失败: %v", err)}
	}
	return model.WebResult{Success: true}
}

// isPortInUse 检查端口是否已被占用（TCP 连接测试）。
func isPortInUse(hostname string, port int) bool {
	addr := net.JoinHostPort(hostname, strconv.Itoa(port))
	conn, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// getOpenCodeHealth 探测服务健康状态（口令从注册文件获取）。
func getOpenCodeHealth(hostname string, port int) (string, string, bool) {
	return getOpenCodeHealthWithAuth(hostname, port, discoverServerPassword(hostname, port))
}

// getOpenCodeHealthWithAuth 探测 v2 的 /api/info 取版本号与存活状态。
// v1 的 /global/health 在 v2 中不存在，v2 未注册的路径会回落到 SPA 首页并
// 返回 200 + text/html，因此必须改用 /api/info 这种真实端点来判定。
func getOpenCodeHealthWithAuth(hostname string, port int, password string) (string, string, bool) {
	client := http.Client{Timeout: 2 * time.Second}
	req, err := http.NewRequest(http.MethodGet, serverInfoURL(hostname, port), nil)
	if err != nil {
		return "离线", "", false
	}
	applyAuth(req, password)
	resp, err := client.Do(req)
	if err != nil {
		return "离线", "", false
	}
	defer resp.Body.Close()

	version := ""
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "异常", "", false
	}
	if len(body) > 0 {
		var payload map[string]interface{}
		if err := json.Unmarshal(body, &payload); err == nil {
			version = stringValue(payload["version"])
			if version == "" {
				version = stringValue(payload["Version"])
			}
		}
	}

	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		// 服务在线但缺口令：提示用户，而不是伪装成"未知"
		return "需口令", version, true
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return "在线", version, true
	case resp.StatusCode < 500:
		return "未知", version, true
	default:
		return "异常", version, false
	}
}

// serverInfoURL 返回 v2 的服务信息端点（v1 为 /global/health，v2 已改为 /api/info）。
func serverInfoURL(hostname string, port int) string {
	return fmt.Sprintf("http://%s:%d/api/info", hostname, port)
}

// serviceHostPort 从注册文件的 url（如 http://127.0.0.1:49374）解析 host 与 port。
func serviceHostPort(rawURL string) (string, int) {
	u := strings.TrimSpace(rawURL)
	for _, prefix := range []string{"http://", "https://"} {
		u = strings.TrimPrefix(u, prefix)
	}
	u = strings.TrimSuffix(u, "/")
	host, portStr, ok := strings.Cut(u, ":")
	if !ok {
		return "", 0
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port <= 0 {
		return "", 0
	}
	return host, port
}

func stringValue(value interface{}) string {
	switch v := value.(type) {
	case string:
		return v
	case fmt.Stringer:
		return v.String()
	default:
		return ""
	}
}

// 获取模型列表
func GetModelList(baseURL, apiKey string) []string {
	url := baseURL + "/models"
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return []string{}
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return []string{}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return []string{}
	}

	if resp.StatusCode != http.StatusOK {
		return []string{}
	}

	var result struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return []string{}
	}

	modelIDs := make([]string, 0, len(result.Data))
	for _, model := range result.Data {
		modelIDs = append(modelIDs, model.ID)
	}
	return modelIDs
}
