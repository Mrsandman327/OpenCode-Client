package service_test

import (
	"os"
	"path/filepath"
	"testing"

	"oc-manager/service"
)

func TestListBrowsableDirsReturnsOnlyImmediateDirectories(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "alpha"), 0755); err != nil {
		t.Fatalf("创建 alpha 目录失败: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "beta"), 0755); err != nil {
		t.Fatalf("创建 beta 目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "note.txt"), []byte("x"), 0644); err != nil {
		t.Fatalf("创建文件失败: %v", err)
	}

	items, err := service.ListBrowsableDirs(root)
	if err != nil {
		t.Fatalf("列目录失败: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("应只返回一级目录，实际=%d %#v", len(items), items)
	}
	if items[0].Name != "alpha" || items[1].Name != "beta" {
		t.Fatalf("目录排序或筛选异常: %#v", items)
	}
}
