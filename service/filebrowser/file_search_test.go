package filebrowser

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"oc-manager/model"
)

// writeSearchTestFile 在测试目录下写一个文件，自动创建父目录。
func writeSearchTestFile(t *testing.T, dir, name, content string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatalf("写入文件失败: %v", err)
	}
}

// collectMatches 把结果展开成「相对路径:行号」列表，便于断言。
func collectMatches(files []model.FileSearchFileResult) []string {
	var out []string
	for _, f := range files {
		for _, m := range f.Matches {
			out = append(out, f.RelPath+":"+itoa(m.Line))
		}
	}
	return out
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func TestSearchBrowserFilesCaseInsensitive(t *testing.T) {
	dir := t.TempDir()
	writeSearchTestFile(t, dir, "a.txt", "Hello World\nhello again\nTODO: fix\n")
	writeSearchTestFile(t, dir, "sub/b.md", "nothing here\nHELLO nested\n")
	writeSearchTestFile(t, dir, "c.go", "fmt.Println(\"hello\")\n")

	res, err := SearchBrowserFiles(dir, "/", "hello", false, false, false)
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if res.FileCount != 3 {
		t.Fatalf("期望命中 3 个文件，实际 %d：%v", res.FileCount, collectMatches(res.Files))
	}
	// a.txt 两行、sub/b.md 一行、c.go 一行
	if res.MatchCount != 4 {
		t.Fatalf("期望 4 处匹配，实际 %d：%v", res.MatchCount, collectMatches(res.Files))
	}
}

func TestSearchBrowserFilesCaseSensitive(t *testing.T) {
	dir := t.TempDir()
	writeSearchTestFile(t, dir, "a.txt", "Hello World\nhello again\n")
	writeSearchTestFile(t, dir, "b.txt", "HELLO upper\n")

	res, err := SearchBrowserFiles(dir, "/", "hello", true, false, false)
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	got := collectMatches(res.Files)
	want := []string{"/a.txt:2"}
	if len(got) != 1 || got[0] != want[0] {
		t.Fatalf("大小写敏感结果不符，期望 %v，实际 %v", want, got)
	}
}

func TestSearchBrowserFilesRegex(t *testing.T) {
	dir := t.TempDir()
	writeSearchTestFile(t, dir, "a.txt", "color\ncolour\ncoler\n")

	res, err := SearchBrowserFiles(dir, "/", `colou?r`, false, true, false)
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	got := collectMatches(res.Files)
	want := []string{"/a.txt:1", "/a.txt:2"}
	sort.Strings(want)
	if len(got) != 2 {
		t.Fatalf("正则结果不符，期望 %v，实际 %v", want, got)
	}
}

func TestSearchBrowserFilesWholeWord(t *testing.T) {
	dir := t.TempDir()
	writeSearchTestFile(t, dir, "a.txt", "cat\nconcatenate\nCat\n")

	res, err := SearchBrowserFiles(dir, "/", "cat", false, false, true)
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	got := collectMatches(res.Files)
	// 全词：cat、Cat 命中，concatenate 不命中（忽略大小写）
	if len(got) != 2 {
		t.Fatalf("全词结果不符，实际 %v", got)
	}
}

// 跨行正则：`foo\s+bar` 在逐行匹配下永远命中不了，整文本匹配才成立。
func TestSearchBrowserFilesCrossLineRegex(t *testing.T) {
	dir := t.TempDir()
	writeSearchTestFile(t, dir, "a.txt", "foo\nbar\nbaz\n")

	res, err := SearchBrowserFiles(dir, "/", `foo\s+bar`, false, true, false)
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if res.FileCount != 1 || len(res.Files[0].Matches) != 1 {
		t.Fatalf("跨行正则应命中 1 处，实际 %v", collectMatches(res.Files))
	}
	m := res.Files[0].Matches[0]
	if m.Line != 1 {
		t.Fatalf("应命中第 1 行，实际第 %d 行", m.Line)
	}
	if !strings.HasSuffix(m.Text, "…") {
		t.Fatalf("跨行匹配的文本应带省略号，实际 %q", m.Text)
	}
}

// 默认上限：配置文件缺失时应使用代码内默认值（2000 文件 / 300 行）。
func TestLoadFileSearchConfigDefaults(t *testing.T) {
	cfg := loadFileSearchConfig()
	if cfg.MaxFiles != defaultMaxFiles {
		t.Fatalf("MaxFiles 默认值应为 %d，实际 %d", defaultMaxFiles, cfg.MaxFiles)
	}
	if cfg.MaxFileMatches != defaultMaxFileMatches {
		t.Fatalf("MaxFileMatches 默认值应为 %d，实际 %d", defaultMaxFileMatches, cfg.MaxFileMatches)
	}
	if cfg.MaxFileSizeKB != defaultMaxFileSizeKB {
		t.Fatalf("MaxFileSizeKB 默认值应为 %d，实际 %d", defaultMaxFileSizeKB, cfg.MaxFileSizeKB)
	}
}

func TestSearchBrowserFilesSameLineOnce(t *testing.T) {
	dir := t.TempDir()
	writeSearchTestFile(t, dir, "a.txt", "foo foo foo\nbar\nfoo\n")

	res, err := SearchBrowserFiles(dir, "/", "foo", false, false, false)
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	// 第 1 行有三个匹配，但只输出一行
	if len(res.Files) != 1 || len(res.Files[0].Matches) != 2 {
		t.Fatalf("同一行应只输出一次，实际 %v", collectMatches(res.Files))
	}
}

func TestSearchBrowserFilesSortedByRelPath(t *testing.T) {
	dir := t.TempDir()
	// 故意用不稳定的写入顺序，验证结果按 rel 排序
	writeSearchTestFile(t, dir, "zzz.txt", "hit\n")
	writeSearchTestFile(t, dir, "aaa.txt", "hit\n")
	writeSearchTestFile(t, dir, "mmm.txt", "hit\n")
	writeSearchTestFile(t, dir, "sub/x.txt", "hit\n")

	res, err := SearchBrowserFiles(dir, "/", "hit", false, false, false)
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(res.Files) != 4 {
		t.Fatalf("期望 4 个文件，实际 %d", len(res.Files))
	}
	for i := 1; i < len(res.Files); i++ {
		if res.Files[i-1].RelPath >= res.Files[i].RelPath {
			t.Fatalf("结果未按相对路径排序: %v", []string{
				res.Files[i-1].RelPath, res.Files[i].RelPath,
			})
		}
	}
}

func TestSearchBrowserFilesSkipsBinary(t *testing.T) {
	dir := t.TempDir()
	// 含 \0 视为二进制
	if err := os.WriteFile(filepath.Join(dir, "bin.dat"), []byte("hello\x00world"), 0o644); err != nil {
		t.Fatal(err)
	}
	writeSearchTestFile(t, dir, "a.txt", "hello\n")

	res, err := SearchBrowserFiles(dir, "/", "hello", false, false, false)
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if res.FileCount != 1 || res.Files[0].RelPath != "/a.txt" {
		t.Fatalf("二进制文件应被跳过，实际 %v", collectMatches(res.Files))
	}
}

func TestSearchBrowserFilesEmptyQuery(t *testing.T) {
	dir := t.TempDir()
	writeSearchTestFile(t, dir, "a.txt", "hello\n")

	res, err := SearchBrowserFiles(dir, "/", "   ", false, false, false)
	if err != nil {
		t.Fatalf("空查询不应报错: %v", err)
	}
	if res.FileCount != 0 {
		t.Fatalf("空查询应返回空结果，实际 %d", res.FileCount)
	}
}

// BenchmarkSearchBrowserFilesNoMatch 测「所有文件都不含查询」时的开销——
// 这是实际使用中最常见的情况，整文件预筛的收益主要在这里。
func BenchmarkSearchBrowserFilesNoMatch(b *testing.B) {
	dir := b.TempDir()
	line := "some ordinary line of text without the needle\n"
	content := strings.Repeat(line, 40) // 每文件约 2KB
	for i := 0; i < 300; i++ {
		p := filepath.Join(dir, fmt.Sprintf("f%03d.txt", i))
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			b.Fatal(err)
		}
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := SearchBrowserFiles(dir, "/", "nonexistent-needle", false, false, false); err != nil {
			b.Fatal(err)
		}
	}
}
