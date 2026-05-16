package service

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"

	"oc-manager/model"
)

func ListBrowsableDirs(path string) ([]model.DirectoryEntry, error) {
	if path == "" {
		return listRootDirs(), nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("读取目录失败: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("目标不是目录")
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, fmt.Errorf("读取目录失败: %w", err)
	}
	items := make([]model.DirectoryEntry, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		items = append(items, model.DirectoryEntry{Name: entry.Name(), Path: filepath.Join(path, entry.Name())})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	return items, nil
}

func listRootDirs() []model.DirectoryEntry {
	if runtime.GOOS != "windows" {
		return []model.DirectoryEntry{{Name: "/", Path: "/"}}
	}
	items := make([]model.DirectoryEntry, 0, 8)
	for ch := 'A'; ch <= 'Z'; ch++ {
		path := fmt.Sprintf("%c:\\", ch)
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			items = append(items, model.DirectoryEntry{Name: path, Path: path})
		}
	}
	return items
}
