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

// GetWebStatus 返回当前 web 服务状态。hostname/port 为前端配置的服务地址。
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
		p := WebSess.port
		h := WebSess.hostname
		defer WebSessMu.Unlock()
		health, version, _ := getOpenCodeHealth(h, p)
		return model.WebResult{Running: true, Success: true, URL: fmt.Sprintf("http://%s:%d", h, p), Health: health, Version: version}
	}
	WebSessMu.Unlock()

	if isOpenCodeServerRunning(hostname, port) {
		log.Printf("[STATUS] GetWebStatus(%s:%d) detected running", hostname, port)
		WebSessMu.Lock()
		WebSess = &webSession{port: port, hostname: hostname}
		WebSessMu.Unlock()
		health, version, _ := getOpenCodeHealth(hostname, port)
		return model.WebResult{Running: true, Success: true, URL: fmt.Sprintf("http://%s:%d", hostname, port), Health: health, Version: version}
	}

	return model.WebResult{URL: fmt.Sprintf("http://%s:%d", hostname, port), Health: "离线"}
}

// getWebSession 返回当前 webSession，未启动则尝试用最后已知配置自动检测。
func getWebSession() *webSession {
	WebSessMu.Lock()
	sess := WebSess
	WebSessMu.Unlock()
	if sess != nil {
		return sess
	}
	if isOpenCodeServerRunning(LastCfgHost, LastCfgPort) {
		log.Printf("[STATUS] auto-detected serve at %s:%d", LastCfgHost, LastCfgPort)
		sess = &webSession{port: LastCfgPort, hostname: LastCfgHost}
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
