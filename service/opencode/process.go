// Package service 处理 OpenCode serve 进程管理、API 代理、SSE 事件流、会话 CRUD、项目树构建和终端启动。
package opencode

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"oc-manager/model"
)

// webSession 管理 opencode web 进程生命周期。
type webSession struct {
	cmd      *exec.Cmd
	port     int
	hostname string
	// external=true 表示服务不是本进程启动的（外部命令行启动 / 主动发现），
	// OC Manager 只负责连接使用，停止时不杀进程（用户自行管理其生命周期）。
	external bool
}

const (
	defaultHostname = "127.0.0.1"
	defaultPort     = 4096
)

var (
	WebSess     *webSession
	WebSessMu   sync.Mutex
	LastCfgHost = defaultHostname
	LastCfgPort = defaultPort
)

// StartOpenCodeWeb 启动 opencode serve，等待端口就绪后返回。
func StartOpenCodeWeb(port int, hostname string, proxy model.ProxyConfig) model.WebResult {
	if hostname == "" {
		hostname = defaultHostname
	}

	if port < 0 {
		port = defaultPort
	}
	randomPort := port == 0 // --port 0：OpenCode 随机分配端口
	LastCfgHost = hostname
	LastCfgPort = port

	WebSessMu.Lock()
	if WebSess != nil {
		p := WebSess.port
		h := WebSess.hostname
		WebSessMu.Unlock()
		if p != port || h != hostname {
			return model.WebResult{Error: "OpenCode 服务已启动；修改地址或端口前请先停止服务"}
		}
		health, version, _ := getOpenCodeHealth(h, p)
		return model.WebResult{Running: true, Success: true, URL: fmt.Sprintf("http://%s:%d", h, p), Health: health, Version: version}
	}
	WebSessMu.Unlock()

	if !randomPort {
		if isOpenCodeServerRunning(hostname, port) {
			return model.WebResult{Error: fmt.Sprintf("%s:%d 已有 OpenCode 服务运行，请先停止该服务", hostname, port)}
		}
		// 检查端口是否被其他进程占用
		if isPortInUse(hostname, port) {
			return model.WebResult{Error: fmt.Sprintf("端口 %s:%d 已被其他程序占用，请更换端口或关闭占用程序", hostname, port)}
		}
	}

	cmd := exec.Command("opencode", "serve",
		"--port", strconv.Itoa(port),
		"--hostname", hostname,
	)
	if proxy.ProxyEnabled {
		host := strings.TrimSpace(proxy.ProxyHost)
		proxyPort := strings.TrimSpace(proxy.ProxyPort)
		if host == "" {
			host = "127.0.0.1"
		}
		if proxyPort == "" {
			proxyPort = "7897"
		}
		proxyURL := fmt.Sprintf("http://%s:%s", host, proxyPort)
		cmd.Env = append(os.Environ(),
			"HTTP_PROXY="+proxyURL,
			"HTTPS_PROXY="+proxyURL,
			"ALL_PROXY="+proxyURL,
			"NO_PROXY=localhost,127.0.0.1",
		)
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}

	// opencode 将监听地址打印到 stdout（如 "opencode server listening on http://127.0.0.1:4869"），
	// 用 bytes.Buffer 收集输出：免去 pipe/goroutine/channel，且不阻塞 cmd.Wait
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf

	if err := cmd.Start(); err != nil {
		return model.WebResult{Error: fmt.Sprintf("启动 opencode web 失败: %v", err)}
	}

	if randomPort {
		// 随机端口（--port 0）：从启动输出解析实际监听端口
		p := waitForPortFromOutput(&outBuf, 10*time.Second)
		if p == 0 {
			killProcTree(cmd.Process.Pid)
			return model.WebResult{Error: "随机端口启动超时（10 秒内未检测到监听端口）"}
		}
		port = p
		LastCfgPort = port
	}

	// 就绪等待：固定端口探测指定端口；随机端口探测解析出的实际端口
	if err := waitPortReady(hostname, port, 12*time.Second); err != nil {
		killProcTree(cmd.Process.Pid)
		detail := ""
		if s := strings.TrimSpace(errBuf.String()); s != "" {
			detail = ": " + s
		}
		return model.WebResult{Error: fmt.Sprintf("%s%s", err.Error(), detail)}
	}

	sess := &webSession{cmd: cmd, port: port, hostname: hostname}

	WebSessMu.Lock()
	WebSess = sess
	WebSessMu.Unlock()

	go func() {
		_ = cmd.Wait()
		WebSessMu.Lock()
		if WebSess == sess {
			WebSess = nil
		}
		WebSessMu.Unlock()
	}()

	health, version, _ := getOpenCodeHealth(hostname, port)
	return model.WebResult{Running: true, Success: true, URL: fmt.Sprintf("http://%s:%d", hostname, port), Health: health, Version: version}
}

// waitForPortFromOutput 轮询命令输出，解析 opencode 打印的实际监听端口（--port 0 场景）。
// 返回 0 表示超时未解析到端口。
func waitForPortFromOutput(out *bytes.Buffer, timeout time.Duration) int {
	portRe := regexp.MustCompile(`http://[^\s:]*:(\d+)`)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if m := portRe.FindStringSubmatch(out.String()); m != nil {
			if p, e := strconv.Atoi(m[1]); e == nil && p > 0 && p < 65536 {
				return p
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	return 0
}

// waitPortReady 轮询探测端口可连接，直到超时。
func waitPortReady(hostname string, port int, timeout time.Duration) error {
	addr := net.JoinHostPort(hostname, strconv.Itoa(port))
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err == nil {
			conn.Close()
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("端口 %d 在 %v 内未就绪", port, timeout)
}

// StopOpenCodeWeb 停止 opencode web 服务（含子进程 bun）。
func StopOpenCodeWeb() model.WebResult {
	StopOpenCodeEvents()

	WebSessMu.Lock()
	sess := WebSess
	WebSess = nil
	WebSessMu.Unlock()

	if sess != nil && sess.cmd != nil && sess.cmd.Process != nil {
		pid := sess.cmd.Process.Pid
		kill := exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(pid))
		kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		kill.Run()
		return model.WebResult{}
	}

	if sess != nil && sess.external {
		// 外部启动/自动发现的服务：不管理其生命周期（用户命令行启动，不应被 OC Manager 杀掉）
		return model.WebResult{}
	}

	if sess != nil && sess.port > 0 {
		killByPort(sess.port)
	}
	return model.WebResult{}
}

func killByPort(port int) {
	find := exec.Command("cmd", "/c",
		fmt.Sprintf("netstat -ano | findstr :%d | findstr LISTENING", port))
	find.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := find.Output()
	if err != nil {
		return
	}
	fields := strings.Fields(string(out))
	if len(fields) < 5 {
		return
	}
	pid, err := strconv.Atoi(fields[len(fields)-1])
	if err != nil || pid <= 0 {
		return
	}
	killProcTree(pid)
}

// discoverOpenCodeServer 主动发现本机运行中的 opencode 服务：
// 枚举 opencode.exe 进程 → 查其监听端口 → 并行探测 /global/health 确认。
// 适用于随机端口（--port 0）及外部命令行启动、端口未知的场景。
// 返回 (hostname, port, ok)。
func discoverOpenCodeServer() (string, int, bool) {
	pids := listOpenCodePids()
	if len(pids) == 0 {
		return "", 0, false
	}
	pidSet := make(map[int]bool, len(pids))
	for _, p := range pids {
		pidSet[p] = true
	}
	ports := netstatListeningPorts(pidSet)
	if len(ports) == 0 {
		return "", 0, false
	}
	// 并行探测候选端口（严格 2xx：健康端点只响应真正的主服务端口，
	// 内部端口/其他 HTTP 服务返回 404 会被排除）
	type probeResult struct {
		port int
		ok   bool
	}
	ch := make(chan probeResult, len(ports))
	for _, p := range ports {
		go func(port int) {
			ch <- probeResult{port, probeOpenCodeHealth(defaultHostname, port)}
		}(p)
	}
	for range ports {
		r := <-ch
		if r.ok {
			return defaultHostname, r.port, true
		}
	}
	return "", 0, false
}

// probeOpenCodeHealth 严格探测 opencode 健康端点：仅 2xx 视为存活。
// 与 getOpenCodeHealth 不同——后者把 <500（含 404）也当作"在线"，
// 用于 discover 会误把内部端口/其他 HTTP 服务判为主服务。
func probeOpenCodeHealth(hostname string, port int) bool {
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://%s:%d/global/health", hostname, port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

// listOpenCodePids 枚举本机 opencode.exe 进程 PID（tasklist CSV 输出）。
func listOpenCodePids() []int {
	cmd := exec.Command("tasklist", "/FI", "IMAGENAME eq opencode.exe", "/FO", "CSV", "/NH")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var pids []int
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, "opencode.exe") {
			continue
		}
		fields := strings.Split(line, ",")
		if len(fields) < 2 {
			continue
		}
		pidStr := strings.Trim(fields[1], "\"")
		if pid, e := strconv.Atoi(pidStr); e == nil && pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids
}

// netstatListeningPorts 解析 netstat -ano 的 LISTENING 行，返回目标 PID 的监听端口列表。
func netstatListeningPorts(pidSet map[int]bool) []int {
	cmd := exec.Command("netstat", "-ano")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	re := regexp.MustCompile(`^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$`)
	var ports []int
	for _, line := range strings.Split(string(out), "\n") {
		m := re.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		pid, e1 := strconv.Atoi(m[3])
		port, e2 := strconv.Atoi(m[2])
		if e1 != nil || e2 != nil || !pidSet[pid] || port <= 0 {
			continue
		}
		ports = append(ports, port)
	}
	return ports
}

// GetWebStatus 返回当前 web 服务状态。hostname/port 为前端配置的服务地址。
// port==0 表示随机端口模式：不探测默认端口，改为主动发现本机 opencode 进程的监听端口。
func GetWebStatus(hostname string, port int) model.WebResult {
	if hostname == "" {
		hostname = defaultHostname
	}
	if port < 0 {
		port = defaultPort
	}
	randomMode := port == 0
	LastCfgHost = hostname
	if port > 0 {
		LastCfgPort = port
	}
	WebSessMu.Lock()
	if WebSess != nil {
		p := WebSess.port
		h := WebSess.hostname
		defer WebSessMu.Unlock()
		health, version, _ := getOpenCodeHealth(h, p)
		return model.WebResult{Running: true, Success: true, URL: fmt.Sprintf("http://%s:%d", h, p), Health: health, Version: version}
	}
	WebSessMu.Unlock()

	// 固定端口模式：先探测配置端口（随机模式跳过，避免误探默认端口）
	if !randomMode && isOpenCodeServerRunning(hostname, port) {
		log.Printf("[STATUS] GetWebStatus(%s:%d) detected running", hostname, port)
		WebSessMu.Lock()
		WebSess = &webSession{port: port, hostname: hostname, external: true}
		WebSessMu.Unlock()
		health, version, _ := getOpenCodeHealth(hostname, port)
		return model.WebResult{Running: true, Success: true, URL: fmt.Sprintf("http://%s:%d", hostname, port), Health: health, Version: version}
	}

	// 配置端口未命中（含随机模式 / 外部命令行随机端口启动）：主动发现本机 opencode 进程端口
	if h, p, ok := discoverOpenCodeServer(); ok {
		log.Printf("[STATUS] GetWebStatus discovered opencode at %s:%d", h, p)
		WebSessMu.Lock()
		WebSess = &webSession{port: p, hostname: h, external: true}
		WebSessMu.Unlock()
		health, version, _ := getOpenCodeHealth(h, p)
		return model.WebResult{Running: true, Success: true, URL: fmt.Sprintf("http://%s:%d", h, p), Health: health, Version: version}
	}

	return model.WebResult{URL: fmt.Sprintf("http://%s:%d", hostname, port), Health: "离线"}
}

// getWebSession 返回当前 webSession，未启动则尝试用最后已知配置自动检测，
// 检测不到再主动发现本机 opencode 进程的监听端口（随机端口 / 外部启动场景）。
func getWebSession() *webSession {
	WebSessMu.Lock()
	sess := WebSess
	WebSessMu.Unlock()
	if sess != nil {
		return sess
	}
	if isOpenCodeServerRunning(LastCfgHost, LastCfgPort) {
		log.Printf("[STATUS] auto-detected serve at %s:%d", LastCfgHost, LastCfgPort)
		sess = &webSession{port: LastCfgPort, hostname: LastCfgHost, external: true}
		WebSessMu.Lock()
		WebSess = sess
		WebSessMu.Unlock()
		return sess
	}
	if h, p, ok := discoverOpenCodeServer(); ok {
		log.Printf("[STATUS] auto-discovered opencode at %s:%d", h, p)
		sess = &webSession{port: p, hostname: h, external: true}
		WebSessMu.Lock()
		WebSess = sess
		WebSessMu.Unlock()
		return sess
	}
	return nil
}

// LaunchWindowsTerminal 在外部终端中打开 opencode。
func LaunchWindowsTerminal(mode, webURL, dir string) model.WebResult {
	var args []string
	if mode == "attach" && webURL != "" {
		args = []string{"opencode", "attach", webURL}
	} else {
		args = []string{"opencode"}
	}
	if dir != "" {
		args = append(args, "--dir", dir)
	}

	cmd, err := findWindowsTerminal(args...)
	if err == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: false}
		if err := cmd.Start(); err == nil {
			return model.WebResult{Success: true}
		}
	}

	cmdArgs := append([]string{"/c", "start", "opencode"}, args[1:]...)
	cmd = exec.Command("cmd", cmdArgs...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: false}
	if err := cmd.Start(); err != nil {
		return model.WebResult{Error: fmt.Sprintf("启动终端失败: %v", err)}
	}
	return model.WebResult{Success: true}
}

func findWindowsTerminal(args ...string) (*exec.Cmd, error) {
	for _, name := range []string{"wt", "WindowsTerminal"} {
		wtPath, err := exec.LookPath(name)
		if err == nil {
			wtArgs := []string{"-d", ".", "--"}
			wtArgs = append(wtArgs, args...)
			return exec.Command(wtPath, wtArgs...), nil
		}
	}
	for _, p := range []string{
		os.ExpandEnv("${LOCALAPPDATA}\\Microsoft\\WindowsApps\\wt.exe"),
		os.ExpandEnv("${ProgramFiles}\\WindowsApps\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\wt.exe"),
	} {
		if _, err := os.Stat(p); err == nil {
			wtArgs := append([]string{"-d", "."}, args...)
			return exec.Command(p, wtArgs...), nil
		}
	}
	return nil, fmt.Errorf("Windows Terminal 未安装")
}

func killProcTree(pid int) {
	kill := exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(pid))
	kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	kill.Run()
}

func isOpenCodeServerRunning(hostname string, port int) bool {
	_, _, ok := getOpenCodeHealth(hostname, port)
	return ok
}

// isPortInUse 检查端口是否已被占用（TCP 连接测试）
func isPortInUse(hostname string, port int) bool {
	addr := net.JoinHostPort(hostname, strconv.Itoa(port))
	conn, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func getOpenCodeHealth(hostname string, port int) (string, string, bool) {
	client := http.Client{Timeout: 2 * time.Second}
	url := fmt.Sprintf("http://%s:%d/global/health", hostname, port)
	resp, err := client.Get(url)
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

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return "在线", version, true
	}
	if resp.StatusCode < 500 {
		return "未知", version, true
	}
	return "异常", version, false
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

// executablePath 返回当前进程可执行文件的路径。
func executablePath() string {
	p, err := os.Executable()
	if err != nil {
		return "."
	}
	return p
}

// OpenDirectoryDialog 打开目录选择对话框。
func OpenDirectoryDialog(ctx context.Context) string {
	dir, err := wruntime.OpenDirectoryDialog(ctx, wruntime.OpenDialogOptions{
		Title:            "选择工作目录",
		DefaultDirectory: filepath.Dir(executablePath()),
	})
	if err != nil {
		return ""
	}
	return dir
}

// ShowConfirmDialog 显示原生确认对话框（QuestionDialog），返回 true=确定 / false=取消。
// Wails WebView2 禁用了 window.confirm，此方法通过 OS 原生对话框替代。
func ShowConfirmDialog(ctx context.Context, title, message string) bool {
	res, err := wruntime.MessageDialog(ctx, wruntime.MessageDialogOptions{
		Type:    wruntime.QuestionDialog,
		Title:   title,
		Message: message,
	})
	if err != nil {
		return false
	}
	return res == "Yes"
}
