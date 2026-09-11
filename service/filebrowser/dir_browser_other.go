//go:build !windows

package filebrowser

import (
	"os"

	"oc-manager/model"
)

// listRootDirs 在 Linux/macOS 上根目录为 /。
func listRootDirs() []model.DirectoryEntry {
	return []model.DirectoryEntry{{Name: "/", Path: "/"}}
}

// isSystemHiddenDir 在 Linux/macOS 上无系统/隐藏属性概念（点文件已在 isHiddenOrSystemDir 处理）。
func isSystemHiddenDir(entry os.DirEntry, name string) bool {
	_ = entry
	_ = name
	return false
}
