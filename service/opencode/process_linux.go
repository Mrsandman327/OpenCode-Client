//go:build linux

package opencode

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// launchTerminal 启动外部终端模拟器打开 opencode；依次探测常见终端。
// env 为追加到子进程的环境变量（如 OPENCODE_SERVER_PASSWORD）。
func launchTerminal(args []string, env []string) (*exec.Cmd, error) {
	cmdLine := "exec " + quoteArgs(args)
	for _, term := range []string{"x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal"} {
		path, err := exec.LookPath(term)
		if err != nil {
			continue
		}
		var cmd *exec.Cmd
		switch term {
		case "gnome-terminal", "konsole":
			// 新版 gnome-terminal/konsole 用 -- 分隔符
			cmd = exec.Command(path, "--", "bash", "-lc", cmdLine)
		default:
			// x-terminal-emulator / xfce4-terminal 用 -e
			cmd = exec.Command(path, "-e", "bash", "-lc", cmdLine)
		}
		if len(env) > 0 {
			cmd.Env = append(os.Environ(), env...)
		}
		return cmd, nil
	}
	return nil, fmt.Errorf("未找到可用的终端模拟器（尝试了 x-terminal-emulator/gnome-terminal/konsole/xfce4-terminal）")
}

// quoteArgs 对参数做 shell 安全转义后拼接为单条命令字符串。
func quoteArgs(args []string) string {
	quoted := make([]string, 0, len(args))
	for _, a := range args {
		quoted = append(quoted, strconv.Quote(a))
	}
	return strings.Join(quoted, " ")
}
