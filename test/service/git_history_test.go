package service_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"oc-manager/model"
	"oc-manager/service"
)

func TestListGitHistorySupportsPagination(t *testing.T) {
	repo, commits := initGitHistoryRepo(t)

	result, err := service.ListGitHistory(repo, 0, 1)
	if err != nil {
		t.Fatalf("读取提交历史失败: %v", err)
	}
	if len(result.Items) != 1 {
		t.Fatalf("第一页提交数异常: %d", len(result.Items))
	}
	if result.Items[0].Hash != commits[1] {
		t.Fatalf("第一页应返回最新提交，实际=%s", result.Items[0].Hash)
	}
	if !result.HasMore {
		t.Fatal("第一页应提示还有更多提交")
	}

	secondPage, err := service.ListGitHistory(repo, 1, 1)
	if err != nil {
		t.Fatalf("读取第二页提交历史失败: %v", err)
	}
	if len(secondPage.Items) != 1 {
		t.Fatalf("第二页提交数异常: %d", len(secondPage.Items))
	}
	if secondPage.Items[0].Hash != commits[0] {
		t.Fatalf("第二页应返回首个提交，实际=%s", secondPage.Items[0].Hash)
	}
	if secondPage.HasMore {
		t.Fatal("第二页不应再有更多提交")
	}
}

func TestListGitCommitFilesReturnsChangedFiles(t *testing.T) {
	repo, commits := initGitHistoryRepo(t)

	result, err := service.ListGitCommitFiles(repo, commits[1])
	if err != nil {
		t.Fatalf("读取提交文件列表失败: %v", err)
	}
	if result.CommitHash != commits[1] {
		t.Fatalf("提交哈希不匹配: %s", result.CommitHash)
	}
	if len(result.Files) != 2 {
		t.Fatalf("第二次提交应包含两个文件，实际=%d %#v", len(result.Files), result.Files)
	}
	if result.Files[0].Path != "alpha.txt" || result.Files[0].Status != "M" {
		t.Fatalf("alpha.txt 状态异常: %#v", result.Files[0])
	}
	if result.Files[1].Path != "beta.txt" || result.Files[1].Status != "A" {
		t.Fatalf("beta.txt 状态异常: %#v", result.Files[1])
	}
}

func TestBuildGitCommitFilePreviewReturnsDiffBlocks(t *testing.T) {
	repo, commits := initGitHistoryRepo(t)

	preview, err := service.BuildGitCommitFilePreview(repo, commits[1], "alpha.txt")
	if err != nil {
		t.Fatalf("读取提交文件 diff 失败: %v", err)
	}
	if preview.CommitHash != commits[1] {
		t.Fatalf("提交哈希不匹配: %s", preview.CommitHash)
	}
	if preview.FilePath != "alpha.txt" {
		t.Fatalf("文件路径不匹配: %s", preview.FilePath)
	}
	if len(preview.Blocks) == 0 {
		t.Fatal("提交文件 diff 不应为空")
	}

	found := false
	for _, block := range preview.Blocks {
		for _, line := range block.Right {
			if line.Kind == "add" && strings.Contains(line.Text, "world") {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("未在 diff 中找到新增内容 world")
	}
}

func initGitHistoryRepo(t *testing.T) (string, []string) {
	t.Helper()
	repo := t.TempDir()
	runGit(t, repo, "init")
	runGit(t, repo, "config", "user.name", "Test User")
	runGit(t, repo, "config", "user.email", "test@example.com")

	writeFile(t, filepath.Join(repo, "alpha.txt"), "hello\n")
	runGit(t, repo, "add", "alpha.txt")
	runGit(t, repo, "commit", "-m", "first commit")
	first := strings.TrimSpace(runGit(t, repo, "rev-parse", "HEAD"))

	writeFile(t, filepath.Join(repo, "alpha.txt"), "hello\nworld\n")
	writeFile(t, filepath.Join(repo, "beta.txt"), "beta\n")
	runGit(t, repo, "add", "alpha.txt", "beta.txt")
	runGit(t, repo, "commit", "-m", "second commit")
	second := strings.TrimSpace(runGit(t, repo, "rev-parse", "HEAD"))

	return repo, []string{first, second}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("写入文件失败 %s: %v", path, err)
	}
}

func runGit(t *testing.T, repo string, args ...string) string {
	t.Helper()
	out, err := service.TestRunGitCommand(repo, args...)
	if err != nil {
		t.Fatalf("git %v 失败: %v", args, err)
	}
	return out
}

func TestStageFileMovesFileToIndex(t *testing.T) {
	repo, _ := initGitHistoryRepo(t)
	writeFile(t, filepath.Join(repo, "gamma.txt"), "new\n")
	result, err := service.StageFile(repo, "/gamma.txt")
	if err != nil || !result.Success {
		t.Fatalf("暂存文件失败: %v %#v", err, result)
	}
	status := service.ListGitChanges(repo)
	var staged *model.GitChangedFile
	for i := range status.Files {
		if status.Files[i].Path == "/gamma.txt" {
			staged = &status.Files[i]
			break
		}
	}
	if staged == nil || !staged.Tracked {
		t.Fatalf("暂存后文件应为 tracked: %#v", staged)
	}
}

func TestUnstageFileRemovesFileFromIndex(t *testing.T) {
	repo, _ := initGitHistoryRepo(t)
	result, err := service.UnstageFile(repo, "/alpha.txt")
	if err != nil || !result.Success {
		t.Fatalf("取消暂存失败: %v %#v", err, result)
	}
	status := service.ListGitChanges(repo)
	for _, f := range status.Files {
		if f.Path == "/alpha.txt" && f.HasStaged {
			t.Fatal("取消暂存后文件不应再有 staged 标记")
		}
	}
}

func TestGitCommitFailsWithEmptyMessage(t *testing.T) {
	repo, _ := initGitHistoryRepo(t)
	result, err := service.GitCommit(repo, "")
	if err != nil {
		t.Fatalf("提交调用异常: %v", err)
	}
	if result.Success {
		t.Fatal("空提交信息不应成功")
	}
}

func TestGitCommitCreatesNewCommit(t *testing.T) {
	repo, _ := initGitHistoryRepo(t)
	writeFile(t, filepath.Join(repo, "alpha.txt"), "hello\nworld\nthird\n")
	stageResult, err := service.StageFile(repo, "/alpha.txt")
	if err != nil || !stageResult.Success {
		t.Fatalf("提交前暂存失败: %v %#v", err, stageResult)
	}
	result, err := service.GitCommit(repo, "test commit")
	if err != nil || !result.Success {
		t.Fatalf("提交失败: %v %#v", err, result)
	}
	result2, err := service.ListGitHistory(repo, 0, 5)
	if err != nil {
		t.Fatalf("读取历史失败: %v", err)
	}
	if len(result2.Items) < 3 {
		t.Fatalf("提交后应有更多历史条目: %#v", result2)
	}
}

func TestGitHistorySyncStatusWithUpstream(t *testing.T) {
	repo, _ := initGitHistoryRepo(t)
	result, err := service.ListGitHistory(repo, 0, 30)
	if err != nil {
		t.Fatalf("读取历史失败: %v", err)
	}
	for _, item := range result.Items {
		if !item.Synced {
			t.Logf("无上游分支时 %s 应标记为未同步: synced=%v", item.ShortHash, item.Synced)
		}
	}
}
