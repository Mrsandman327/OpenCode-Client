//go:build !windows

package executil

import "os/exec"

// SetHideWindow 在 Linux/macOS 上为空操作（无控制台窗口概念）。
func SetHideWindow(cmd *exec.Cmd, hide bool) {
	_ = hide
}
