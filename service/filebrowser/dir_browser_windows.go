//go:build windows

package filebrowser

import (
	"fmt"
	"os"
	"syscall"

	"oc-manager/model"
)

// listRootDirs 枚举 Windows 盘符根目录。
func listRootDirs() []model.DirectoryEntry {
	items := make([]model.DirectoryEntry, 0, 8)
	for ch := 'A'; ch <= 'Z'; ch++ {
		path := fmt.Sprintf("%c:\\", ch)
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			items = append(items, model.DirectoryEntry{Name: path, Path: path})
		}
	}
	return items
}

// isSystemHiddenDir Windows 上判断系统/隐藏目录：$ 前缀（系统卷信息）或文件属性标记。
func isSystemHiddenDir(entry os.DirEntry, name string) bool {
	if len(name) > 0 && name[0] == '$' {
		return true
	}
	info, err := entry.Info()
	if err != nil {
		return false
	}
	if stat, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		const fileAttributeHidden = 0x2
		const fileAttributeSystem = 0x4
		return stat.FileAttributes&(fileAttributeHidden|fileAttributeSystem) != 0
	}
	return false
}
