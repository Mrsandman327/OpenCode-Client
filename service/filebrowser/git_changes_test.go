package filebrowser

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestParseGitStatusV2 覆盖 porcelain=v2 -z 的四种记录：
// 普通修改、含空格的文件名、重命名（原路径是下一条记录）、未跟踪、冲突。
func TestParseGitStatusV2(t *testing.T) {
	out := strings.Join([]string{
		"1 .M N... 100644 100644 100644 abc def normal.txt",
		"1 A. N... 000000 100644 100644 abc def added file.txt",
		"2 R. N... 100644 100644 100644 abc def R100 renamed new.txt",
		"renamed old.txt", // 重命名的原路径，独立记录
		"? untracked with space.txt",
		"u UU N... 100644 100644 100644 100644 a b c conflict.txt",
	}, "\x00")

	files := parseGitStatus(out)
	if len(files) != 5 {
		t.Fatalf("期望 5 条记录，实际 %d：%+v", len(files), files)
	}

	check := func(i int, path, status string, tracked, staged, unstaged bool) {
		t.Helper()
		f := files[i]
		if f.Path != path {
			t.Errorf("#%d Path = %q, 期望 %q", i, f.Path, path)
		}
		if f.StatusCode != status {
			t.Errorf("#%d StatusCode = %q, 期望 %q", i, f.StatusCode, status)
		}
		if f.Tracked != tracked || f.HasStaged != staged || f.HasUnstaged != unstaged {
			t.Errorf("#%d 状态标记不符: tracked=%v staged=%v unstaged=%v", i, f.Tracked, f.HasStaged, f.HasUnstaged)
		}
	}

	check(0, "/normal.txt", ".M", true, false, true)
	check(1, "/added file.txt", "A.", true, true, false)
	check(2, "/renamed new.txt", "R.", true, true, false)
	check(3, "/untracked with space.txt", "??", false, false, false)
	check(4, "/conflict.txt", "UU", true, true, true)
}

// TestParseGitStatusEmpty 空输出应返回空切片而不是 nil，避免前端拿到 null。
func TestParseGitStatusEmpty(t *testing.T) {
	files := parseGitStatus("")
	if files == nil {
		t.Fatal("空输出应返回空切片")
	}
	if len(files) != 0 {
		t.Fatalf("空输出不应有记录，实际 %d", len(files))
	}
}

// TestGitMetaTime 至少能读到 .git/HEAD 的修改时间。
func TestGitMetaTime(t *testing.T) {
	dir := t.TempDir()
	gitDir := filepath.Join(dir, ".git")
	if err := os.MkdirAll(filepath.Join(gitDir, "logs"), 0o755); err != nil {
		t.Fatal(err)
	}
	head := filepath.Join(gitDir, "HEAD")
	if err := os.WriteFile(head, []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := gitMetaTime(gitDir, gitDir)
	if got.IsZero() {
		t.Fatal("应读到 HEAD 的修改时间")
	}
	if time.Since(got) > time.Minute {
		t.Fatalf("修改时间异常: %v", got)
	}
}
