//go:build windows

package executil

import (
	"os/exec"
	"syscall"
)

// SetHideWindow 在 Windows 上设置/清除子进程控制台窗口隐藏属性。
func SetHideWindow(cmd *exec.Cmd, hide bool) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: hide}
}
