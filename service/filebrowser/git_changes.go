package filebrowser

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"oc-manager/internal/executil"
	"oc-manager/model"
)

func runGitCommand(dir string, args ...string) (string, error) {
	return executil.RunGit(dir, args...)
}

// IsGitRepository 判断指定目录是否是 Git 仓库。
func IsGitRepository(dir string) bool {
	out, err := runGitCommand(dir, "rev-parse", "--is-inside-work-tree")
	if err != nil {
		return false
	}
	return strings.TrimSpace(out) == "true"
}

// ListGitChanges 返回指定目录下的当前 Git 变更文件列表。
func ListGitChanges(dir string) model.GitStatusResult {
	if !IsGitRepository(dir) {
		return model.GitStatusResult{IsGitRepo: false, Files: []model.GitChangedFile{}, Message: "当前目录未启用 Git 版本管理"}
	}
	out, err := runGitCommand(dir, "-c", "core.quotepath=false", "status", "--porcelain", "--untracked-files=all")
	if err != nil {
		return model.GitStatusResult{IsGitRepo: true, Files: []model.GitChangedFile{}, Message: err.Error()}
	}
	files := make([]model.GitChangedFile, 0)
	s := bufio.NewScanner(strings.NewReader(out))
	// 大仓库单行可能超长（超长路径/文件名），默认 64KB 会触发 token too long，放宽到 10MB
	s.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
	for s.Scan() {
		line := s.Text()
		if strings.TrimSpace(line) == "" || len(line) < 3 {
			continue
		}
		status := line[:2]
		rest := strings.TrimSpace(line[3:])
		if strings.Contains(rest, " -> ") {
			parts := strings.Split(rest, " -> ")
			rest = parts[len(parts)-1]
		}
		path := filepath.ToSlash(rest)
		tracked := status != "??"
		hasStaged := tracked && status[0] != ' ' && status[0] != '?'
		hasUnstaged := tracked && status[1] != ' ' && status[1] != '?'
		files = append(files, model.GitChangedFile{
			Path:        "/" + path,
			Name:        filepath.Base(rest),
			StatusCode:  strings.TrimSpace(status),
			Tracked:     tracked,
			HasStaged:   hasStaged,
			HasUnstaged: hasUnstaged,
		})
	}
	return model.GitStatusResult{IsGitRepo: true, Files: files, Message: ""}
}

// ListGitHistory 返回指定目录的 Git 提交历史，支持分页。
func ListGitHistory(dir string, offset, limit int) (model.GitHistoryResult, error) {
	result := model.GitHistoryResult{Items: []model.GitHistoryItem{}, Offset: offset, Limit: limit}
	if !IsGitRepository(dir) {
		return result, fmt.Errorf("当前目录未启用 Git 版本管理")
	}
	if offset < 0 {
		offset = 0
	}
	if limit <= 0 {
		limit = 30
	}
	result.Offset = offset
	result.Limit = limit
	fetchLimit := limit + 1
	format := "%H%x1f%h%x1f%an%x1f%aI%x1f%s"
	out, err := runGitCommand(dir, "-c", "core.quotepath=false", "log", fmt.Sprintf("--skip=%d", offset), fmt.Sprintf("-n%d", fetchLimit), "--date=iso-strict", "--format="+format)
	if err != nil {
		if strings.Contains(err.Error(), "does not have any commits yet") {
			return result, nil
		}
		return result, err
	}
	items := make([]model.GitHistoryItem, 0, fetchLimit)
	s := bufio.NewScanner(strings.NewReader(out))
	s.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\x1f", 5)
		if len(parts) < 5 {
			continue
		}
		items = append(items, model.GitHistoryItem{
			Hash:      parts[0],
			ShortHash: parts[1],
			Author:    parts[2],
			Date:      parts[3],
			Subject:   parts[4],
		})
	}
	if len(items) > limit {
		result.HasMore = true
		items = items[:limit]
	}
	// 计算未同步提交集合
	unsynced := make(map[string]bool)
	if upstream, err := runGitCommand(dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"); err == nil {
		revs, revErr := runGitCommand(dir, "rev-list", strings.TrimSpace(upstream)+"..HEAD")
		if revErr == nil {
			sc := bufio.NewScanner(strings.NewReader(revs))
			sc.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
			for sc.Scan() {
				if h := strings.TrimSpace(sc.Text()); h != "" {
					unsynced[h] = true
				}
			}
		}
	}
	for i := range items {
		if _, ok := unsynced[items[i].Hash]; ok {
			items[i].Synced = false
		} else {
			items[i].Synced = true
		}
	}
	// 如果没有上游分支，全部标记为未同步
	if _, err := runGitCommand(dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"); err != nil {
		for i := range items {
			items[i].Synced = false
		}
	}
	result.Items = items
	return result, nil
}

// ListGitCommitFiles 返回指定提交中发生变更的文件列表。
func ListGitCommitFiles(dir, commitHash string) (model.GitCommitFilesResult, error) {
	result := model.GitCommitFilesResult{CommitHash: commitHash, Files: []model.GitCommitChangedFile{}}
	if !IsGitRepository(dir) {
		return result, fmt.Errorf("当前目录未启用 Git 版本管理")
	}
	commitHash = strings.TrimSpace(commitHash)
	if commitHash == "" {
		return result, fmt.Errorf("提交哈希不能为空")
	}
	out, err := runGitCommand(dir, "-c", "core.quotepath=false", "show", "--format=", "--name-status", commitHash)
	if err != nil {
		return result, err
	}
	s := bufio.NewScanner(strings.NewReader(out))
	s.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 2 {
			continue
		}
		status := strings.TrimSpace(parts[0])
		path := filepath.ToSlash(parts[len(parts)-1])
		item := model.GitCommitChangedFile{
			Path:        path,
			DisplayName: filepath.Base(path),
			Status:      status,
		}
		if strings.HasPrefix(status, "R") && len(parts) >= 3 {
			item.OldPath = filepath.ToSlash(parts[1])
		}
		result.Files = append(result.Files, item)
	}
	return result, nil
}

// BuildGitCommitFilePreview 构建指定提交中单个文件的 diff 预览。
func BuildGitCommitFilePreview(dir, commitHash, filePath string) (model.GitCommitFilePreviewResult, error) {
	result := model.GitCommitFilePreviewResult{CommitHash: strings.TrimSpace(commitHash), FilePath: filepath.ToSlash(strings.TrimSpace(filePath)), Blocks: []model.GitDiffBlock{}}
	if !IsGitRepository(dir) {
		return result, fmt.Errorf("当前目录未启用 Git 版本管理")
	}
	if result.CommitHash == "" || result.FilePath == "" {
		return result, fmt.Errorf("提交哈希和文件路径不能为空")
	}
	relNative := filepath.FromSlash(result.FilePath)
	patch, err := runGitCommand(dir, "show", "--no-color", result.CommitHash, "--", relNative)
	if err != nil {
		return result, err
	}
	result.Blocks = parseUnifiedDiffToBlocks(patch)
	return result, nil
}

// BuildGitFilePreview 构建当前工作区中单个文件的 Git 变更预览（含暂存和未暂存 diff）。
func BuildGitFilePreview(repoDir string, changed model.GitChangedFile) (model.GitFilePreviewResult, error) {
	preview := model.GitFilePreviewResult{
		Path:        changed.Path,
		Tracked:     changed.Tracked,
		HasStaged:   changed.HasStaged,
		HasUnstaged: changed.HasUnstaged,
	}
	relPath := strings.TrimPrefix(changed.Path, "/")
	relNative := filepath.FromSlash(relPath)
	if !changed.Tracked {
		content, err := os.ReadFile(filepath.Join(repoDir, relNative))
		if err != nil {
			return preview, fmt.Errorf("读取未跟踪文件失败: %w", err)
		}
		preview.UntrackedContent = string(content)
		return preview, nil
	}
	if changed.HasStaged {
		patch, err := runGitCommand(repoDir, "diff", "--cached", "--no-color", "--", relNative)
		if err == nil {
			preview.StagedBlocks = parseUnifiedDiffToBlocks(patch)
		}
	}
	if changed.HasUnstaged {
		patch, err := runGitCommand(repoDir, "diff", "--no-color", "--", relNative)
		if err == nil {
			preview.UnstagedBlocks = parseUnifiedDiffToBlocks(patch)
		}
	}
	return preview, nil
}

func parseUnifiedDiffToBlocks(patch string) []model.GitDiffBlock {
	lines := strings.Split(strings.ReplaceAll(patch, "\r\n", "\n"), "\n")
	blocks := make([]model.GitDiffBlock, 0)
	var current *model.GitDiffBlock
	oldNo, newNo := 0, 0
	for _, line := range lines {
		if strings.HasPrefix(line, "@@") {
			if current != nil && (len(current.Left) > 0 || len(current.Right) > 0) {
				blocks = append(blocks, *current)
			}
			current = &model.GitDiffBlock{Left: []model.GitDiffLine{}, Right: []model.GitDiffLine{}}
			oldNo, newNo = parseUnifiedHeader(line)
			continue
		}
		if current == nil {
			continue
		}
		if strings.HasPrefix(line, "+++") || strings.HasPrefix(line, "---") || strings.HasPrefix(line, "diff --git") || strings.HasPrefix(line, "index ") {
			continue
		}
		if len(line) == 0 {
			appendPair(current, model.GitDiffLine{Kind: "context", OldNo: oldNo, NewNo: newNo, Text: ""}, model.GitDiffLine{Kind: "context", OldNo: oldNo, NewNo: newNo, Text: ""})
			oldNo++
			newNo++
			continue
		}
		switch line[0] {
		case ' ':
			text := line[1:]
			appendPair(current, model.GitDiffLine{Kind: "context", OldNo: oldNo, Text: text}, model.GitDiffLine{Kind: "context", NewNo: newNo, Text: text})
			oldNo++
			newNo++
		case '-':
			text := line[1:]
			appendPair(current, model.GitDiffLine{Kind: "del", OldNo: oldNo, Text: text}, model.GitDiffLine{Kind: "empty", Text: ""})
			oldNo++
		case '+':
			text := line[1:]
			appendPair(current, model.GitDiffLine{Kind: "empty", Text: ""}, model.GitDiffLine{Kind: "add", NewNo: newNo, Text: text})
			newNo++
		}
	}
	if current != nil && (len(current.Left) > 0 || len(current.Right) > 0) {
		blocks = append(blocks, *current)
	}
	return blocks
}

func appendPair(block *model.GitDiffBlock, left, right model.GitDiffLine) {
	block.Left = append(block.Left, left)
	block.Right = append(block.Right, right)
}

func parseUnifiedHeader(line string) (int, int) {
	// 例：@@ -12,7 +12,9 @@
	parts := strings.Split(line, " ")
	if len(parts) < 3 {
		return 1, 1
	}
	oldNo := parseHunkPart(parts[1])
	newNo := parseHunkPart(parts[2])
	return oldNo, newNo
}

func parseHunkPart(part string) int {
	part = strings.TrimPrefix(part, "-")
	part = strings.TrimPrefix(part, "+")
	if idx := strings.Index(part, ","); idx >= 0 {
		part = part[:idx]
	}
	n, err := strconv.Atoi(part)
	if err != nil {
		return 1
	}
	return n
}

// StageFile 将指定文件添加到 Git 暂存区。
func StageFile(dir, filePath string) (model.GitActionResult, error) {
	if !IsGitRepository(dir) {
		return model.GitActionResult{Success: false, Message: "当前目录未启用 Git 版本管理"}, nil
	}
	rel := strings.TrimPrefix(filePath, "/")
	_, err := runGitCommand(dir, "-c", "core.quotepath=false", "add", "--", rel)
	if err != nil {
		return model.GitActionResult{Success: false, Message: err.Error()}, nil
	}
	return model.GitActionResult{Success: true}, nil
}

// UnstageFile 将指定文件从 Git 暂存区移除。
func UnstageFile(dir, filePath string) (model.GitActionResult, error) {
	if !IsGitRepository(dir) {
		return model.GitActionResult{Success: false, Message: "当前目录未启用 Git 版本管理"}, nil
	}
	rel := strings.TrimPrefix(filePath, "/")
	_, err := runGitCommand(dir, "-c", "core.quotepath=false", "reset", "HEAD", "--", rel)
	if err != nil {
		return model.GitActionResult{Success: false, Message: err.Error()}, nil
	}
	return model.GitActionResult{Success: true}, nil
}

// StageAllFiles 暂存工作区中所有已修改的文件。
func StageAllFiles(dir string) (model.GitActionResult, error) {
	if !IsGitRepository(dir) {
		return model.GitActionResult{Success: false, Message: "当前目录未启用 Git 版本管理"}, nil
	}
	_, err := runGitCommand(dir, "-c", "core.quotepath=false", "add", "-u")
	if err != nil {
		return model.GitActionResult{Success: false, Message: err.Error()}, nil
	}
	return model.GitActionResult{Success: true}, nil
}

// GitCommit 使用指定提交信息创建 Git 提交。
func GitCommit(dir, message string) (model.GitActionResult, error) {
	if !IsGitRepository(dir) {
		return model.GitActionResult{Success: false, Message: "当前目录未启用 Git 版本管理"}, nil
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return model.GitActionResult{Success: false, Message: "请输入提交信息"}, nil
	}
	_, err := runGitCommand(dir, "-c", "core.quotepath=false", "commit", "-m", message)
	if err != nil {
		return model.GitActionResult{Success: false, Message: err.Error()}, nil
	}
	return model.GitActionResult{Success: true}, nil
}

// runGitRemoteOp 执行 git push/pull 操作，包含仓库和远端检查。
// proxy 用于配置 http.proxy/https.proxy，支持系统代理。
func runGitRemoteOp(dir, op string, proxy model.ProxyConfig) (model.GitActionResult, error) {
	if !IsGitRepository(dir) {
		return model.GitActionResult{Success: false, Message: "当前目录未启用 Git 版本管理"}, nil
	}
	remotes, err := runGitCommand(dir, "remote")
	if err != nil || strings.TrimSpace(remotes) == "" {
		return model.GitActionResult{Success: false, Message: "未配置远端仓库，请先执行 git remote add origin <url>"}, nil
	}

	// 构建 git 参数
	args := []string{op}
	if proxy.ProxyEnabled {
		host := strings.TrimSpace(proxy.ProxyHost)
		port := strings.TrimSpace(proxy.ProxyPort)
		if host != "" {
			if port == "" {
				port = "7897"
			}
			proxyURL := fmt.Sprintf("http://%s:%s", host, port)
			args = append([]string{"-c", "http.proxy=" + proxyURL, "-c", "https.proxy=" + proxyURL}, args...)
		}
	}

	out, err := runGitCommand(dir, args...)
	if err != nil {
		msg := strings.TrimSpace(out)
		if msg == "" {
			msg = err.Error()
		}
		return model.GitActionResult{Success: false, Message: msg}, nil
	}
	return model.GitActionResult{Success: true}, nil
}

// GitPush 推送提交到远端仓库。proxy 用于代理连接。
func GitPush(dir string, proxy model.ProxyConfig) (model.GitActionResult, error) {
	return runGitRemoteOp(dir, "push", proxy)
}

// GitPull 从远端仓库拉取提交。proxy 用于代理连接。
func GitPull(dir string, proxy model.ProxyConfig) (model.GitActionResult, error) {
	return runGitRemoteOp(dir, "pull", proxy)
}

// DiscardFile 丢弃指定文件的所有未提交修改，未跟踪文件将被删除。
func DiscardFile(dir, filePath string) (model.GitActionResult, error) {
	if !IsGitRepository(dir) {
		return model.GitActionResult{Success: false, Message: "当前目录未启用 Git 版本管理"}, nil
	}
	rel := strings.TrimPrefix(filePath, "/")
	// 先检查文件状态
	status := ListGitChanges(dir)
	var changed *model.GitChangedFile
	for i := range status.Files {
		if status.Files[i].Path == filePath {
			changed = &status.Files[i]
			break
		}
	}
	if changed == nil {
		return model.GitActionResult{Success: false, Message: "未找到该文件"}, nil
	}
	// 未跟踪文件：直接删除
	if !changed.Tracked {
		if _, err := runGitCommand(dir, "clean", "-f", "--", rel); err != nil {
			return model.GitActionResult{Success: false, Message: err.Error()}, nil
		}
		return model.GitActionResult{Success: true}, nil
	}
	// 已暂存：先取消暂存
	if changed.HasStaged {
		if _, err := runGitCommand(dir, "reset", "HEAD", "--", rel); err != nil {
			return model.GitActionResult{Success: false, Message: err.Error()}, nil
		}
	}
	// 撤销工作区改动
	if _, err := runGitCommand(dir, "checkout", "--", rel); err != nil {
		return model.GitActionResult{Success: false, Message: err.Error()}, nil
	}
	return model.GitActionResult{Success: true}, nil
}
