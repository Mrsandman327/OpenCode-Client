// Package executil 提供统一的子进程执行工具，封装 Windows HideWindow 和 Git 命令。
package executil

import (
	"fmt"
	"os/exec"
	"strings"
)

// Command 创建 exec.Cmd，在 Windows 上设置 HideWindow 防止控制台窗口闪烁。
func Command(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	SetHideWindow(cmd, true)
	return cmd
}

// RunGit 在指定目录中执行 Git 命令并返回组合输出。
func RunGit(dir string, args ...string) (string, error) {
	cmd := Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s 执行失败: %w\n输出: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}
