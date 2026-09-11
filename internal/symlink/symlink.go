// Package symlink 提供跨平台的符号链接创建与删除。
// Linux/macOS 使用 os.Symlink，Windows 优先尝试 os.Symlink，失败时回退到 mklink /J（目录联接）。
package symlink

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"

	"oc-manager/internal/executil"
)

// Create 在 linkPath 处创建指向 sourcePath 的符号链接或目录联接。
func Create(sourcePath, linkPath string) error {
	if runtime.GOOS == "windows" {
		return createWindows(sourcePath, linkPath)
	}
	return os.Symlink(sourcePath, linkPath)
}

// Remove 安全删除 linkPath 处的符号链接或目录联接。
// Windows 上使用 rmdir 删除联接，避免跟随目标目录。
func Remove(linkPath string) error {
	if runtime.GOOS == "windows" {
		return removeWindows(linkPath)
	}
	return os.Remove(linkPath)
}

// Exists 检查 linkPath 是否存在（包括断开的符号链接）。
func Exists(linkPath string) bool {
	_, err := os.Lstat(linkPath)
	return err == nil
}

func createWindows(sourcePath, linkPath string) error {
	// 先尝试 os.Symlink（需要管理员权限或开发者模式）
	err := os.Symlink(sourcePath, linkPath)
	if err == nil {
		return nil
	}

	// 回退到 mklink /J（目录联接，不需要管理员权限）
	cmd := exec.Command("cmd", "/c", "mklink", "/J", linkPath, sourcePath)
	executil.SetHideWindow(cmd, true)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("创建联接失败: %w\n输出: %s", err, string(out))
	}
	return nil
}

func removeWindows(linkPath string) error {
	fi, err := os.Lstat(linkPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	// 联接/Junction 用 rmdir 删除，避免跟随到目标目录删掉原始文件
	if fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
		cmd := exec.Command("cmd", "/c", "rmdir", linkPath)
		executil.SetHideWindow(cmd, true)
		out, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Errorf("删除联接失败: %w\n输出: %s", err, string(out))
		}
		return nil
	}

	return os.Remove(linkPath)
}
