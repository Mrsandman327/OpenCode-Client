// Package executil 提供统一的子进程执行工具，封装 Windows HideWindow 和 Git 命令。
package executil

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Command 创建 exec.Cmd，在 Windows 上设置 HideWindow 防止控制台窗口闪烁。
func Command(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	SetHideWindow(cmd, true)
	return cmd
}

// gitEnv 是执行 git 时统一注入的环境变量：
//   - GIT_OPTIONAL_LOCKS=0：只读命令（status/diff/log）不再获取 index.lock，
//     避免与用户在终端里的 git 操作互相等待；
//   - GIT_TERMINAL_PROMPT=0 / GIT_ASKPASS= / GCM_INTERACTIVE=Never：
//     GUI 进程没有终端，认证失败应立刻返回错误，而不是挂起等待输入或弹出凭据窗口。
func gitEnv() []string {
	return append(os.Environ(),
		"GIT_OPTIONAL_LOCKS=0",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=",
		"GCM_INTERACTIVE=Never",
	)
}

// RunGit 在指定目录中执行 Git 命令并返回组合输出。
func RunGit(dir string, args ...string) (string, error) {
	cmd := Command("git", args...)
	cmd.Dir = dir
	cmd.Env = gitEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s 执行失败: %w\n输出: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}
