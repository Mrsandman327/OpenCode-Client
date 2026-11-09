//go:build !windows

package filebrowser

import (
	"os"
	"sort"

	"oc-manager/model"
)

// listRootDirs 在 Linux/macOS 上列出 / 以及 / 下的全部一级目录。
// 和 Windows 列出盘符对应：根目录本身始终在第一位，其余按名称排序。
func listRootDirs() []model.DirectoryEntry {
	items := []model.DirectoryEntry{{Name: "/", Path: "/"}}

	entries, err := os.ReadDir("/")
	if err != nil {
		return items
	}

	var dirs []model.DirectoryEntry
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		if isHiddenOrSystemDir(entry, name) {
			continue
		}
		dirs = append(dirs, model.DirectoryEntry{Name: "/" + name, Path: "/" + name})
	}

	sort.Slice(dirs, func(i, j int) bool { return dirs[i].Name < dirs[j].Name })
	return append(items, dirs...)
}

// isSystemHiddenDir 在 Linux/macOS 上无系统/隐藏属性概念（点文件已在 isHiddenOrSystemDir 处理）。
func isSystemHiddenDir(entry os.DirEntry, name string) bool {
	_ = entry
	_ = name
	return false
}
