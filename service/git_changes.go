package service

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"oc-manager/model"
)

func runGitCommand(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s 执行失败: %w\n输出: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func IsGitRepository(dir string) bool {
	out, err := runGitCommand(dir, "rev-parse", "--is-inside-work-tree")
	if err != nil {
		return false
	}
	return strings.TrimSpace(out) == "true"
}

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

func (h *frontendWebHandler) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rootDir := strings.TrimSpace(r.URL.Query().Get("rootDir"))
	if rootDir == "" {
		http.Error(w, "rootDir 不能为空", http.StatusBadRequest)
		return
	}
	result := ListGitChanges(rootDir)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(result)
}

func (h *frontendWebHandler) handleGitHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rootDir := strings.TrimSpace(r.URL.Query().Get("rootDir"))
	if rootDir == "" {
		http.Error(w, "rootDir 不能为空", http.StatusBadRequest)
		return
	}
	offset, _ := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("offset")))
	limit, _ := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("limit")))
	result, err := ListGitHistory(rootDir, offset, limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(result)
}

func (h *frontendWebHandler) handleGitHistoryFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rootDir := strings.TrimSpace(r.URL.Query().Get("rootDir"))
	commitHash := strings.TrimSpace(r.URL.Query().Get("commitHash"))
	if rootDir == "" || commitHash == "" {
		http.Error(w, "参数错误", http.StatusBadRequest)
		return
	}
	result, err := ListGitCommitFiles(rootDir, commitHash)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(result)
}

func (h *frontendWebHandler) handleGitHistoryPreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rootDir := strings.TrimSpace(r.URL.Query().Get("rootDir"))
	commitHash := strings.TrimSpace(r.URL.Query().Get("commitHash"))
	filePath := strings.TrimSpace(r.URL.Query().Get("path"))
	if rootDir == "" || commitHash == "" || filePath == "" {
		http.Error(w, "参数错误", http.StatusBadRequest)
		return
	}
	result, err := BuildGitCommitFilePreview(rootDir, commitHash, filePath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(result)
}

func (h *frontendWebHandler) handleGitPreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rootDir := strings.TrimSpace(r.URL.Query().Get("rootDir"))
	path := normalizeBrowserRelPath(r.URL.Query().Get("path"))
	if rootDir == "" || path == "/" {
		http.Error(w, "参数错误", http.StatusBadRequest)
		return
	}
	status := ListGitChanges(rootDir)
	var changed *model.GitChangedFile
	for i := range status.Files {
		if status.Files[i].Path == path {
			changed = &status.Files[i]
			break
		}
	}
	if changed == nil {
		http.Error(w, "未找到 Git 变更文件", http.StatusNotFound)
		return
	}
	preview, err := BuildGitFilePreview(rootDir, *changed)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(preview)
}

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

func (h *frontendWebHandler) handleGitStage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct{ RootDir, Path string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "请求体解析失败", http.StatusBadRequest)
		return
	}
	result, _ := StageFile(req.RootDir, req.Path)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(result)
}

func (h *frontendWebHandler) handleGitUnstage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct{ RootDir, Path string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "请求体解析失败", http.StatusBadRequest)
		return
	}
	result, _ := UnstageFile(req.RootDir, req.Path)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(result)
}

func (h *frontendWebHandler) handleGitStageAll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct{ RootDir string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "请求体解析失败", http.StatusBadRequest)
		return
	}
	result, _ := StageAllFiles(req.RootDir)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(result)
}

func (h *frontendWebHandler) handleGitCommit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct{ RootDir, Message string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "请求体解析失败", http.StatusBadRequest)
		return
	}
	result, _ := GitCommit(req.RootDir, req.Message)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(result)
}

func GitPush(dir string) (model.GitActionResult, error) {
	if !IsGitRepository(dir) {
		return model.GitActionResult{Success: false, Message: "当前目录未启用 Git 版本管理"}, nil
	}
	// 检查是否有远端仓库
	remotes, err := runGitCommand(dir, "remote")
	if err != nil || strings.TrimSpace(remotes) == "" {
		return model.GitActionResult{Success: false, Message: "未配置远端仓库，请先执行 git remote add origin <url>"}, nil
	}
	// 先尝试直接 push
	out, err := runGitCommand(dir, "push")
	if err != nil {

		return model.GitActionResult{Success: false, Message: strings.TrimSpace(out)}, nil
	}
	return model.GitActionResult{Success: true}, nil
}

func (h *frontendWebHandler) handleGitPush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct{ RootDir string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "请求体解析失败", http.StatusBadRequest)
		return
	}
	result, _ := GitPush(req.RootDir)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(result)
}

func GitPull(dir string) (model.GitActionResult, error) {
	if !IsGitRepository(dir) {
		return model.GitActionResult{Success: false, Message: "当前目录未启用 Git 版本管理"}, nil
	}
	remotes, err := runGitCommand(dir, "remote")
	if err != nil || strings.TrimSpace(remotes) == "" {
		return model.GitActionResult{Success: false, Message: "未配置远端仓库"}, nil
	}
	out, err := runGitCommand(dir, "pull")
	if err != nil {
		return model.GitActionResult{Success: false, Message: strings.TrimSpace(out)}, nil
	}
	return model.GitActionResult{Success: true}, nil
}

func (h *frontendWebHandler) handleGitPull(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct{ RootDir string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "请求体解析失败", http.StatusBadRequest)
		return
	}
	result, _ := GitPull(req.RootDir)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(result)
}
