package main

import (
	"io"
	"os"
	"os/exec"

	"github.com/creack/pty"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// startTerminal 启动嵌入式终端 (cmd.exe)，通过 Wails Events 与前端 xterm.js 通信
func (a *App) startTerminal() {
	cmd := exec.Command("cmd")
	cmd.Env = append(os.Environ(), "TERM=xterm")

	tty, err := pty.Start(cmd)
	if err != nil {
		runtime.EventsEmit(a.ctx, "terminal-error", err.Error())
		return
	}

	// 读取 PTY 输出 → 发送到前端
	go func() {
		buf := make([]byte, 1024)
		for {
			n, err := tty.Read(buf)
			if n > 0 {
				runtime.EventsEmit(a.ctx, "terminal-output", string(buf[:n]))
			}
			if err != nil {
				if err != io.EOF {
					runtime.EventsEmit(a.ctx, "terminal-error", err.Error())
				}
				return
			}
		}
	}()

	// 接收前端输入 → 写入 PTY
	// 注意: 此方法在前端按键时调用
	runtime.EventsOn(a.ctx, "terminal-input", func(optionalData ...interface{}) {
		if len(optionalData) > 0 {
			if data, ok := optionalData[0].(string); ok {
				tty.Write([]byte(data))
			}
		}
	})
}

// runOpenCode 启动 opencode（外部终端窗口）
func (a *App) RunOpenCode(dir string, model string, agent string, continueFlag bool, sessionId string) error {
	args := []string{}
	if dir != "" {
		args = append(args, dir)
	}
	if model != "" {
		args = append(args, "-m", model)
	}
	if agent != "" {
		args = append(args, "--agent", agent)
	}
	if continueFlag {
		args = append(args, "-c")
	}
	if sessionId != "" {
		args = append(args, "-s", sessionId)
	}

	cmd := exec.Command("cmd", "/c", "start", "opencode")
	cmd.Args = append(cmd.Args, args...)
	return cmd.Start()
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
