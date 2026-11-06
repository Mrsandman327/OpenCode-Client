//go:build darwin

package opencode

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"oc-manager/internal/portable"
)

// launchTerminal 在 macOS 上通过 Terminal.app 启动 opencode。
//
// 实现方式：用 osascript 让 Terminal 执行一条 shell 命令：
//  1. 先 cd 到当前进程的工作目录（Terminal 新窗口默认落在 home）；
//  2. 再 exec 目标命令，保证进程信号和退出码直接传给 opencode。
//
// env 为追加到子进程的环境变量（例如 OPENCODE_SERVER_PASSWORD）；
// 与 Windows/Linux 实现一致，子进程继续使用便携数据目录。
//
// 注意：首次调用会触发 macOS 的「自动化」授权弹窗，需要用户允许控制 Terminal。
func launchTerminal(args []string, env []string) (*exec.Cmd, error) {
	if len(args) == 0 {
		return nil, fmt.Errorf("启动命令为空")
	}

	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}

	// Terminal 的 do script 接收的是完整 shell 命令字符串，
	// 因此每个参数都要做 POSIX shell 转义，避免路径中的空格/引号被拆开。
	cmdLine := "cd " + shellQuote(cwd) + " && exec " + quoteArgs(args)
	script := `tell application "Terminal" to do script ` + strconv.Quote(cmdLine)

	cmd := exec.Command("osascript", "-e", script)
	cmd.Env = portable.ChildEnvFrom(append(os.Environ(), env...))
	return cmd, nil
}

// shellQuote 用单引号包裹字符串，内部单引号按 POSIX shell 规则转义：
// abc'd → 'abc'\''d'
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// quoteArgs 把参数逐个做 shell 转义后拼接成一条命令。
func quoteArgs(args []string) string {
	quoted := make([]string, 0, len(args))
	for _, a := range args {
		quoted = append(quoted, shellQuote(a))
	}
	return strings.Join(quoted, " ")
}
