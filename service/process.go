// Package service 处理 OpenCode serve 进程管理、API 代理、SSE 事件流、会话 CRUD、项目树构建和终端启动。
package service

import (
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
	if port <= 0 {
		port = defaultPort
	}
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

	if isOpenCodeServerRunning(hostname, port) {
		return model.WebResult{Error: fmt.Sprintf("%s:%d 已有 OpenCode 服务运行，请先停止该服务", hostname, port)}
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

	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		return model.WebResult{Error: fmt.Sprintf("启动 opencode web 失败: %v", err)}
	}

	addr := net.JoinHostPort(hostname, strconv.Itoa(port))
	ready := make(chan error, 1)
	go func() {
		for i := 0; i < 40; i++ {
			time.Sleep(250 * time.Millisecond)
			conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
			if err == nil {
				conn.Close()
				ready <- nil
				return
			}
		}
		ready <- fmt.Errorf("端口 %d 在 10 秒内未就绪", port)
	}()

	select {
	case err := <-ready:
		if err != nil {
			killProcTree(cmd.Process.Pid)
			detail := ""
			if stderr != nil {
				buf := make([]byte, 2048)
				n, _ := stderr.Read(buf)
				if n > 0 {
					detail = ": " + strings.TrimSpace(string(buf[:n]))
				}
			}
			return model.WebResult{Error: fmt.Sprintf("启动超时%s", detail)}
		}
	case <-time.After(12 * time.Second):
		killProcTree(cmd.Process.Pid)
		return model.WebResult{Error: "启动超时（超过 12 秒）"}
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
