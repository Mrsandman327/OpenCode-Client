// Package service 处理 OpenCode serve 进程管理、API 代理、SSE 事件流、会话 CRUD、项目树构建和终端启动。
package service

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"oc-manager/model"
)

// ProjectInfo 项目树中的项目信息。
type ProjectInfo struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Worktree string `json:"worktree"`
	VCS      string `json:"vcs"`
}

type treeSession struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	ProjectID string `json:"projectID"`
	Directory string `json:"directory"`
}

// GetProjectTree 获取项目→目录→会话的树形结构 JSON。
// knownDirs 是前端记录的所有建过会话的目录（JSON 字符串数组），用于查询 global 项目会话。
func GetProjectTree(knownDirs string) string {
	sess := getWebSession()
	if sess == nil {
		return "[]"
	}
	base := fmt.Sprintf("http://%s:%d", sess.hostname, sess.port)
	client := http.Client{Timeout: 10 * time.Second}

	var projects []ProjectInfo
	var extraDirs []string
	if knownDirs != "" {
		json.Unmarshal([]byte(knownDirs), &extraDirs)
	}

	// 获取项目列表
	resp1, err := client.Get(base + "/project")
	if err == nil {
		defer resp1.Body.Close()
		body, _ := io.ReadAll(resp1.Body)
		json.Unmarshal(body, &projects)
	} else {
		projects = []ProjectInfo{{ID: "global", Name: "全局项目", Worktree: "/"}}
	}

	var allSessions []treeSession
	seen := map[string]bool{}

	// 获取所有项目会话（all=true 会返回当前实例目录所属项目的全部会话）
	// 当前实例目录是 exe 所在目录，属于 git 项目，因此能获取 git 项目的所有会话
	resp, err := client.Get(base + "/session?all=true&roots=true&limit=500")
	if err == nil {
		defer resp.Body.Close()
		var batch []treeSession
		body, _ := io.ReadAll(resp.Body)
		json.Unmarshal(body, &batch)
		for _, s := range batch {
			if !seen[s.ID] {
				seen[s.ID] = true
				allSessions = append(allSessions, s)
			}
		}
	}

	// 查询已知 global 目录下的会话
	for _, dir := range extraDirs {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			continue
		}
		resp, err := client.Get(base + "/session?directory=" + url.QueryEscape(dir) + "&roots=true&limit=200")
		if err != nil {
			continue
		}
		defer resp.Body.Close()
		var batch []treeSession
		body, _ := io.ReadAll(resp.Body)
		json.Unmarshal(body, &batch)
		for _, s := range batch {
			if !seen[s.ID] {
				seen[s.ID] = true
				allSessions = append(allSessions, s)
			}
		}
	}

	return buildTreeJSON(projects, allSessions)
}

func buildTreeJSON(projects []ProjectInfo, sessions []treeSession) string {
	// 按 project 分组，再按 directory 分组
	projectMap := make(map[string]*model.TreeNode)
	dirMap := make(map[string]*model.TreeNode) // key: projectID+"|"+directory

	for _, p := range projects {
		name := p.Name
		if name == "" {
			name = p.ID
		}
		if name == "global" {
			name = "全局项目"
		}
		node := &model.TreeNode{ID: p.ID, Title: name, Type: "project"}
		projectMap[p.ID] = node
	}

	for _, s := range sessions {
		pid := s.ProjectID
		if pid == "" {
			pid = "global"
		}
		dir := s.Directory
		if dir == "" {
			continue
		}
		dirKey := pid + "|" + dir

		// 确保 project 存在
		proj, ok := projectMap[pid]
		if !ok {
			name := pid
			if pid == "global" {
				name = "全局项目"
			}
			proj = &model.TreeNode{ID: pid, Title: name, Type: "project"}
			projectMap[pid] = proj
		}

		// 确保 directory 节点存在
		dirNode, ok := dirMap[dirKey]
		if !ok {
			dirNode = &model.TreeNode{ID: dirKey, Title: dir, Type: "directory"}
			dirMap[dirKey] = dirNode
			proj.Children = append(proj.Children, *dirNode)
		}

		// 找到刚添加的 directory 节点引用
		title := s.Title
		if title == "" {
			title = s.ID
		}
		if len([]rune(title)) > 40 {
			title = string([]rune(title)[:40]) + "..."
		}
		for i := range proj.Children {
			if proj.Children[i].ID == dirKey {
				proj.Children[i].Children = append(proj.Children[i].Children, model.TreeNode{
					ID:    s.ID,
					Title: title,
					Type:  "session",
				})
			}
		}
	}

	// 转为数组
	tree := make([]model.TreeNode, 0, len(projectMap))
	for _, p := range projectMap {
		tree = append(tree, *p)
	}

	data, _ := json.Marshal(tree)
	return string(data)
}

// ========== 命令面板 ==========

// GetOpenCodeCommands 从 opencode serve 获取所有可用命令，返回精简数据。
func GetOpenCodeCommands() []model.CmdPaletteItem {
	sess := getWebSession()
	if sess == nil {
		return nil
	}

	url := fmt.Sprintf("http://%s:%d/command", sess.hostname, sess.port)
	client := http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil
	}

	var raw []struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Source      string `json:"source"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}

	result := make([]model.CmdPaletteItem, 0, len(raw))
	for _, r := range raw {
		result = append(result, model.CmdPaletteItem{
			Name:        r.Name,
			Description: r.Description,
			Source:      r.Source,
		})
	}
	return result
}

// ========== 会话列表（兼容旧接口） ==========

// GetSessions 获取最近 15 个 OpenCode 会话记录。
func GetSessions() ([]model.SessionInfo, error) {
	sessions, err := fetchSessions()
	if err != nil {
		return []model.SessionInfo{{ID: "", Title: "加载失败: " + err.Error()[:50]}}, nil
	}
	return sessions, nil
}

func fetchSessions() ([]model.SessionInfo, error) {
	cmd := exec.Command("opencode", "session", "list", "-n", "15", "--format", "json")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var raw []struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if err := json.Unmarshal(output, &raw); err != nil {
		return nil, err
	}

	sessions := make([]model.SessionInfo, 0, len(raw))
	for _, r := range raw {
		title := strings.ReplaceAll(r.Title, "\n", " ")
		if len([]rune(title)) > 60 {
			title = string([]rune(title)[:60]) + "..."
		}
		sessions = append(sessions, model.SessionInfo{ID: r.ID, Title: title})
	}
	return sessions, nil
}
