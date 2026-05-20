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
