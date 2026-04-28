package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"

	"github.com/UserExistsError/conpty"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

var (
	globalTty    *conpty.ConPty
	globalTtyMu  sync.Mutex
	terminalCols = 120
	terminalRows = 36
)

func (a *App) StartTerminal() string {
	globalTtyMu.Lock()
	if globalTty != nil {
		globalTtyMu.Unlock()
		return "already started"
	}
	globalTtyMu.Unlock()

	startPTY(a)
	return "ok"
}

func startPTY(a *App) {
	cmdPath := os.Getenv("COMSPEC")
	if cmdPath == "" {
		cmdPath = "cmd.exe"
	}

	globalTtyMu.Lock()
	cols := terminalCols
	rows := terminalRows
	globalTtyMu.Unlock()

	// /k 保持 cmd 进程存活，子进程退出后不关闭。
	cpty, err := conpty.Start(fmt.Sprintf(`%s /k`, cmdPath), conpty.ConPtyDimensions(cols, rows))
	if err != nil {
		runtime.EventsEmit(a.ctx, "terminal-output", "\r\n\x1b[31m[PTY启动失败]\x1b[0m\r\n")
		return
	}

	globalTtyMu.Lock()
	globalTty = cpty
	globalTtyMu.Unlock()

	go func() {
		defer markTerminalClosed(a, cpty, "终端已退出，按任意键自动重启")
		buf := make([]byte, 1024)
		for {
			n, err := cpty.Read(buf)
			if n > 0 {
				runtime.EventsEmit(a.ctx, "terminal-output", string(buf[:n]))
			}
			if err != nil {
				return
			}
		}
	}()

	go func() {
		_, _ = cpty.Wait(context.Background())
		markTerminalClosed(a, cpty, "终端进程已结束，按任意键自动重启")
	}()
}

func markTerminalClosed(a *App, cpty *conpty.ConPty, message string) {
	globalTtyMu.Lock()
	if globalTty != cpty {
		globalTtyMu.Unlock()
		return
	}
	globalTty = nil
	globalTtyMu.Unlock()

	_ = cpty.Close()
	if a != nil && a.ctx != nil {
		runtime.EventsEmit(a.ctx, "terminal-closed", message)
	}
}

// TerminalWrite 向终端写入数据
func (a *App) TerminalWrite(data string) error {
	globalTtyMu.Lock()
	cpty := globalTty
	globalTtyMu.Unlock()
	if cpty == nil {
		startPTY(a)
		globalTtyMu.Lock()
		cpty = globalTty
		globalTtyMu.Unlock()
	}
	if cpty != nil {
		_, err := cpty.Write([]byte(data))
		if err != nil {
			markTerminalClosed(a, cpty, "终端写入失败，按任意键自动重启")
			return err
		}
	}
	return nil
}

// ResizeTerminal 调整终端大小
func (a *App) ResizeTerminal(cols int, rows int) {
	globalTtyMu.Lock()
	if cols > 0 {
		terminalCols = cols
	}
	if rows > 0 {
		terminalRows = rows
	}
	cpty := globalTty
	globalTtyMu.Unlock()
	if cpty != nil {
		cpty.Resize(cols, rows)
	}
}

// runOpenCode 在嵌入式终端中启动 opencode
// sessionId 优先，其次 continueFlag
func (a *App) RunOpenCode(sessionId string, continueFlag bool) error {
	globalTtyMu.Lock()
	cpty := globalTty
	globalTtyMu.Unlock()

	if cpty == nil {
		return nil
	}

	var cmd string
	if sessionId != "" {
		cmd = "opencode -s " + sessionId + "\r\n"
	} else if continueFlag {
		cmd = "opencode -c\r\n"
	} else {
		cmd = "opencode\r\n"
	}

	_, err := cpty.Write([]byte(cmd))
	return err
}

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
