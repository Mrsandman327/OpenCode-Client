package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// webSession 管理 opencode web 进程生命周期。
type webSession struct {
	cmd  *exec.Cmd
	port int
}

var (
	webSess   *webSession
	webSessMu sync.Mutex
)

// WebResult 前端展示用的 web 状态。
type WebResult struct {
	Running bool   `json:"running"`
	Success bool   `json:"success"`
	Port    int    `json:"port"`
	URL     string `json:"url"`
	Error   string `json:"error,omitempty"`
}

// StartOpenCodeWeb 启动 opencode web 服务，等待端口就绪后返回。
func (a *App) StartOpenCodeWeb(port int) WebResult {
	webSessMu.Lock()
	if webSess != nil && webSess.cmd != nil {
		p := webSess.port
		webSessMu.Unlock()
		return WebResult{Running: true, Success: true, Port: p, URL: fmt.Sprintf("http://127.0.0.1:%d", p)}
	}
	webSessMu.Unlock()

	if port <= 0 {
		port = 4096
	}

	cmd := exec.Command("opencode", "serve",
		"--port", strconv.Itoa(port),
		"--hostname", "127.0.0.1",
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}

	// 捕获 stderr 以便诊断启动失败
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		return WebResult{Error: fmt.Sprintf("启动 opencode web 失败: %v", err)}
	}

	// 轮询等待端口就绪（最多 10 秒）
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
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
			// 服务器未就绪，终止进程树
			killProcTree(cmd.Process.Pid)
			detail := ""
			if stderr != nil {
				buf := make([]byte, 2048)
				n, _ := stderr.Read(buf)
				if n > 0 {
					detail = ": " + strings.TrimSpace(string(buf[:n]))
				}
			}
			return WebResult{Error: fmt.Sprintf("启动超时%s", detail)}
		}
	case <-time.After(12 * time.Second):
		killProcTree(cmd.Process.Pid)
		return WebResult{Error: "启动超时（超过 12 秒）"}
	}

	sess := &webSession{cmd: cmd, port: port}

	webSessMu.Lock()
	webSess = sess
	webSessMu.Unlock()

	// 后台等待进程退出
	go func() {
		_ = cmd.Wait()
		webSessMu.Lock()
		if webSess == sess {
			webSess = nil
		}
		webSessMu.Unlock()
	}()

	return WebResult{Running: true, Success: true, Port: port, URL: fmt.Sprintf("http://127.0.0.1:%d", port)}
}

// StopOpenCodeWeb 停止 opencode web 服务（含子进程 bun）。
func (a *App) StopOpenCodeWeb() WebResult {
	webSessMu.Lock()
	sess := webSess
	webSess = nil
	webSessMu.Unlock()

	if sess == nil || sess.cmd == nil || sess.cmd.Process == nil {
		return WebResult{}
	}

	pid := sess.cmd.Process.Pid
	// taskkill /T 终止进程树（opencode + 子进程 bun）
	kill := exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(pid))
	kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	kill.Run()
	return WebResult{}
}

// GetWorkDir 返回当前工作目录。
func (a *App) GetWorkDir() string {
	dir, _ := os.Getwd()
	return dir
}
// GetWebStatus 返回当前 web 服务状态。
func (a *App) GetWebStatus() WebResult {
	webSessMu.Lock()
	defer webSessMu.Unlock()

	if webSess != nil {
		return WebResult{Running: true, Port: webSess.port, URL: fmt.Sprintf("http://127.0.0.1:%d", webSess.port)}
	}
	return WebResult{}
}

// LaunchWindowsTerminal 在外部终端中打开 opencode。
// mode: "attach" → opencode attach <url>, dir 可选指定工作目录
func (a *App) LaunchWindowsTerminal(mode, webURL, dir string) WebResult {
	var args []string

	if mode == "attach" && webURL != "" {
		args = []string{"opencode", "attach", webURL}
	} else {
		args = []string{"opencode"}
	}

	if dir != "" {
		args = append(args, "--dir", dir)
	}

	// 优先使用 Windows Terminal
	cmd, err := findWindowsTerminal(args...)
	if err == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: false}
		if err := cmd.Start(); err == nil {
			return WebResult{Success: true}
		}
	}

	// 回退：start cmd /k
	cmdArgs := append([]string{"/c", "start", "opencode"}, args[1:]...)
	cmd = exec.Command("cmd", cmdArgs...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: false}
	if err := cmd.Start(); err != nil {
		return WebResult{Error: fmt.Sprintf("启动终端失败: %v", err)}
	}
	return WebResult{Success: true}
}

func findWindowsTerminal(args ...string) (*exec.Cmd, error) {
	// 按优先级查找 Windows Terminal
	for _, name := range []string{"wt", "WindowsTerminal"} {
		wtPath, err := exec.LookPath(name)
		if err == nil {
			wtArgs := []string{"-d", ".", "--"}
			wtArgs = append(wtArgs, args...)
			cmd := exec.Command(wtPath, wtArgs...)
			return cmd, nil
		}
	}
	// 常见安装路径
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

// killProcTree 终止指定 PID 及其所有子进程（taskkill /T）。
func killProcTree(pid int) {
	kill := exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(pid))
	kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	kill.Run()
}

// ========== 保留的原有方法 ==========

// OpenDirectoryDialog 打开目录选择对话框
func (a *App) OpenDirectoryDialog() string {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "选择 OpenCode 工作目录",
	})
	if err != nil {
		return ""
	}
	return dir
}

// ========== 会话管理 ==========

// SessionInfo 会话记录
type SessionInfo struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// GetSessions 获取最近 15 个 OpenCode 会话记录
func (a *App) GetSessions() ([]SessionInfo, error) {
	sessions, err := fetchSessions()
	if err != nil {
		return []SessionInfo{{ID: "", Title: "加载失败: " + err.Error()[:50]}}, nil
	}
	return sessions, nil
}

func fetchSessions() ([]SessionInfo, error) {
	cmd := exec.Command("opencode", "session", "list", "-n", "15", "--format", "json")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var raw []struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if err := json.Unmarshal(output, &raw); err != nil {
		return nil, err
	}

	sessions := make([]SessionInfo, 0, len(raw))
	for _, r := range raw {
		title := strings.ReplaceAll(r.Title, "\n", " ")
		if len([]rune(title)) > 60 {
			title = string([]rune(title)[:60]) + "..."
		}
		sessions = append(sessions, SessionInfo{ID: r.ID, Title: title})
	}
	return sessions, nil
}
