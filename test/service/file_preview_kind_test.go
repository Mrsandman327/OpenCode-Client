package service_test

import (
	"os"
	"path/filepath"
	"testing"

	"oc-manager/service"
)

func TestStatBrowserFileReturnsPreviewKindForMarkdown(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("# hi\n"), 0644); err != nil {
		t.Fatalf("写入 markdown 测试文件失败: %v", err)
	}
	stat, err := service.StatBrowserFile(root, "/README.md")
	if err != nil {
		t.Fatalf("读取文件信息失败: %v", err)
	}
	if stat.PreviewKind != "markdown" {
		t.Fatalf("previewKind 异常: %q", stat.PreviewKind)
	}
	if !stat.Previewable {
		t.Fatal("markdown 文件应可预览")
	}
}

func TestStatBrowserFileReturnsPreviewKindForImage(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "demo.png"), []byte{0x89, 0x50, 0x4E, 0x47}, 0644); err != nil {
		t.Fatalf("写入图片测试文件失败: %v", err)
	}
	stat, err := service.StatBrowserFile(root, "/demo.png")
	if err != nil {
		t.Fatalf("读取文件信息失败: %v", err)
	}
	if stat.PreviewKind != "image" {
		t.Fatalf("图片 previewKind 异常: %q", stat.PreviewKind)
	}
	if !stat.Previewable {
		t.Fatal("图片文件应可预览")
	}
}

func TestReadBrowserFileKeepsTextPreviewReadable(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "notes.txt"), []byte("hello world"), 0644); err != nil {
		t.Fatalf("写入文本测试文件失败: %v", err)
	}
	result, err := service.ReadBrowserFile(root, "/notes.txt")
	if err != nil {
		t.Fatalf("读取文本文件失败: %v", err)
	}
	if result.Content != "hello world" {
		t.Fatalf("文本文件内容异常: %q", result.Content)
	}
}
