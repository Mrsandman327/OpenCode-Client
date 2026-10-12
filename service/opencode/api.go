// Package service 处理 OpenCode serve 进程管理、API 代理、SSE 事件流、会话 CRUD、项目树构建和终端启动。
package opencode

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"oc-manager/model"
)

// getWebSessionBase 返回 opencode serve 的基础 URL（http://host:port）。
func getWebSessionBase() (string, error) {
	sess := getWebSession()
	if sess == nil {
		return "", fmt.Errorf("opencode 服务未启动")
	}
	return fmt.Sprintf("http://%s:%d", sess.hostname, sess.port), nil
}

// apiClient 专用于普通 API 代理请求，带整体超时。
// 背景：原实现使用 http.DefaultClient，而它没有 Timeout —— 一旦 opencode serve 侧
// 迟迟不响应某个请求，此处会永久阻塞，进而让页面端 fetch 永久 pending，
// 最终卡死前端的在途锁（loadMessagesInflight / currentSessionRefreshPending），
// 表现为「点刷新毫无反应」。加超时保证请求必然返回。
// 注意：绝对不要给 http.DefaultClient 设置 Timeout —— sse.go 的全局事件流是长连接，
// 依赖它「无超时」，否则会被周期性地切断。
var apiClient = &http.Client{Timeout: 60 * time.Second}

// OpenCodeAPI 代理访问本机 opencode serve API，避免前端跨域限制。
func OpenCodeAPI(method, path, body string) model.APIResult {
	sess := getWebSession()
	if sess == nil {
		return model.APIResult{Error: "opencode 服务未启动"}
	}

	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	urlstr := fmt.Sprintf("http://%s:%d%s", sess.hostname, sess.port, path)

	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, urlstr, reader)
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := apiClient.Do(req)
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return model.APIResult{Status: resp.StatusCode, Error: err.Error()}
	}
	return model.APIResult{Success: resp.StatusCode >= 200 && resp.StatusCode < 300, Status: resp.StatusCode, Body: string(data)}
}

// findSessionDirectory 根据 sessionID 反查当前会话所属工作目录。
// question 接口是按 directory 作用域隔离的，因此必须先拿到目录再请求。
func findSessionDirectory(base, sessionID string) (string, error) {
	resp, err := http.Get(base + "/session/" + url.QueryEscape(sessionID))
	if err != nil {
		return "", fmt.Errorf("获取会话列表失败: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var sessions treeSession
	if err := json.Unmarshal(body, &sessions); err != nil {
		return "", fmt.Errorf("解析会话列表失败: %v", err)
	}

	return sessions.Directory , nil
}

// findQuestionID 从 /question API 查找匹配 sessionID 的待回答问题 ID。
func findQuestionID(base, sessionID, directory string) (string, error) {
	questionURL := base + "/question?directory=" + url.QueryEscape(directory)
	resp, err := http.Get(questionURL)
	if err != nil {
		return "", fmt.Errorf("获取问题列表失败: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	type QuestionRequest struct {
		ID        string `json:"id"`
		SessionID string `json:"sessionID"`
	}
	var questions []QuestionRequest
	if err := json.Unmarshal(body, &questions); err != nil {
		return "", fmt.Errorf("解析问题列表失败: %v", err)
	}

	for _, q := range questions {
		if q.SessionID == sessionID {
			return q.ID, nil
		}
	}
	return "", fmt.Errorf("未找到该会话的待回答问题")
}

// AnswerQuestion 回答 question 工具调用。
// answers 为按问题顺序的二维数组（每个问题一个 string[]），支持多问题一次提交。
func AnswerQuestion(sessionID string, answers [][]string) model.APIResult {
	base, err := getWebSessionBase()
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}
	directory, err := findSessionDirectory(base, sessionID)
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}

	requestID, err := findQuestionID(base, sessionID, directory)
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}

	payload, _ := json.Marshal(map[string]any{"answers": answers})
	replyURL := fmt.Sprintf("%s/question/%s/reply?directory=%s", base, requestID, url.QueryEscape(directory))
	replyResp, err := http.Post(
		replyURL,
		"application/json",
		strings.NewReader(string(payload)),
	)
	if err != nil {
		return model.APIResult{Error: fmt.Sprintf("回答问题失败: %v", err)}
	}
	defer replyResp.Body.Close()

	replyData, _ := io.ReadAll(replyResp.Body)
	return model.APIResult{
		Success: replyResp.StatusCode >= 200 && replyResp.StatusCode < 300,
		Status:  replyResp.StatusCode,
		Body:    string(replyData),
	}
}

// RejectQuestion 忽略 question 工具调用。
func RejectQuestion(sessionID string) model.APIResult {
	base, err := getWebSessionBase()
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}
	directory, err := findSessionDirectory(base, sessionID)
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}

	requestID, err := findQuestionID(base, sessionID, directory)
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}

	rejectURL := fmt.Sprintf("%s/question/%s/reject?directory=%s", base, requestID, url.QueryEscape(directory))
	req, _ := http.NewRequest(http.MethodPost,
		rejectURL, nil)
	rejectResp, err := http.DefaultClient.Do(req)
	if err != nil {
		return model.APIResult{Error: fmt.Sprintf("忽略问题失败: %v", err)}
	}
	defer rejectResp.Body.Close()

	rejectData, _ := io.ReadAll(rejectResp.Body)
	return model.APIResult{
		Success: rejectResp.StatusCode >= 200 && rejectResp.StatusCode < 300,
		Status:  rejectResp.StatusCode,
		Body:    string(rejectData),
	}
}

// ProjectInfo 项目树中的项目信息。
type ProjectInfo struct {
	ID       string      `json:"id"`
	Name     string      `json:"name"`
	Worktree string      `json:"worktree"`
	VCS      string      `json:"vcs"`
	Time     sessionTime `json:"time"`
}

type sessionTime struct {
	Created int64 `json:"created"`
	Updated int64 `json:"updated"`
}

// lastPathSegment 返回路径的最后一段（目录名）。
// 同时兼容 Windows 的 \ 与 Unix 的 /，并忽略结尾多余的分隔符，
// 例如 E:\code\git\foo → foo、/home/me/bar/ → bar。
func lastPathSegment(path string) string {
	// 先统一分隔符，再去掉结尾的 / 或 \
	normalized := strings.TrimRight(strings.ReplaceAll(path, "\\", "/"), "/")
	if normalized == "" {
		return ""
	}
	if idx := strings.LastIndex(normalized, "/"); idx >= 0 {
		return normalized[idx+1:]
	}
	// 路径中没有任何分隔符时，整段本身就是目录名
	return normalized
}

// projectDisplayName 返回项目的可读名称。
// v1 的 Project 可能没有 name（为空）。此时若像旧实现那样直接回退到 id，
// 界面上就会出现一串 40 位哈希，用户无从判断这是哪个项目；故改取 worktree
// （工作目录）路径的最后一段，例如 E:\code\git\foo → foo。
func projectDisplayName(p ProjectInfo) string {
	name := p.Name
	if name == "" {
		// v1 项目缺 name 时用工作目录名兜底
		name = lastPathSegment(p.Worktree)
	}
	// 仍然无名可读（如名称为 "global"，或连工作目录都为空）时才走最终兜底
	if name == "" || name == "global" {
		if p.ID == "global" {
			return "全局项目"
		}
		return p.ID
	}
	return name
}

type treeSession struct {
	ID        string      `json:"id"`
	Title     string      `json:"title"`
	ProjectID string      `json:"projectID"`
	Directory string      `json:"directory"`
	Time      sessionTime `json:"time"`
}

// projectSessionLimit 每个项目一次性拉取的会话上限。
// opencode /session 的默认 limit 是 100，超限会按 time_updated 倒序截断（丢掉最旧的），
// 因此这里显式给一个足够大的值（当前最大项目约 174 条，1000 有充足余量）。
const projectSessionLimit = 1000

// GetProjectTree 获取项目→目录→会话的树形结构 JSON。
//
// 算法：先取 /project，再对**每个项目**用其 worktree 作为锚点请求
// /session?directory=<worktree>&scope=project —— scope=project 会返回该项目下
// **所有目录**的会话（不再受单个 directory 精确匹配限制），从而覆盖全部目录，
// 包括未注册为项目、或历史遗留被归到 global 的目录；也不再依赖前端 knownDirs。
//
// knownDirs 参数仅为兼容既有 Wails 绑定签名而保留，当前实现不再使用。
func GetProjectTree(knownDirs string) string {
	_ = knownDirs // 保留入参以兼容绑定签名；按项目全量拉取后不再需要

	base, err := getWebSessionBase()
	if err != nil {
		return "[]"
	}
	client := http.Client{
		Timeout: 20 * time.Second,
		Transport: &http.Transport{
			MaxIdleConns:        20,
			MaxIdleConnsPerHost: 20,
			IdleConnTimeout:     90 * time.Second,
		},
	}

	// 获取项目列表
	var projects []ProjectInfo
	if resp, err := client.Get(base + "/project"); err == nil {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		json.Unmarshal(body, &projects)
	} else {
		// /project 不可用时退回 global，至少把 global 会话拉出来
		projects = []ProjectInfo{{ID: "global", Name: "全局项目", Worktree: "/"}}
	}

	// 并发按项目拉取会话：每个项目一次 scope=project 请求，覆盖其全部目录
	var mu sync.Mutex
	var wg sync.WaitGroup
	var allSessions []treeSession
	seen := map[string]bool{}

	for _, project := range projects {
		anchor := strings.TrimSpace(project.Worktree)
		if anchor == "" {
			continue
		}
		wg.Add(1)
		go func(dir string) {
			defer wg.Done()
			u := base + "/session?directory=" + url.QueryEscape(dir) +
				"&scope=project&roots=true&limit=" + strconv.Itoa(projectSessionLimit)
			resp, err := client.Get(u)
			if err != nil {
				return
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			var batch []treeSession
			if json.Unmarshal(body, &batch) != nil {
				return
			}
			mu.Lock()
			for _, s := range batch {
				if s.ID != "" && !seen[s.ID] {
					seen[s.ID] = true
					allSessions = append(allSessions, s)
				}
			}
			mu.Unlock()
		}(anchor)
	}
	wg.Wait()

	return buildTreeJSON(projects, allSessions)
}

func buildTreeJSON(projects []ProjectInfo, sessions []treeSession) string {
	// 按 project 分组，再按 directory 分组
	projectMap := make(map[string]*model.TreeNode)
	dirMap := make(map[string]*model.TreeNode) // key: projectID+"|"+directory

	for _, p := range projects {
		// 项目名统一走 projectDisplayName：name → worktree 末段 → id，并处理 global 中文名
		name := projectDisplayName(p)
		// 项目时间：updated 优先，其次 created
		var projectTime string
		if p.Time.Updated > 0 {
			projectTime = time.UnixMilli(p.Time.Updated).Format("2006-01-02 15:04")
		} else if p.Time.Created > 0 {
			projectTime = time.UnixMilli(p.Time.Created).Format("2006-01-02 15:04")
		}
		node := &model.TreeNode{ID: p.ID, Title: name, Type: "project", UpdatedAt: projectTime}
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
			// 项目未出现在 /project 列表中（例如 v1 遗留或已删除的项目），
			// 同样不能用 40 位哈希当标题，优先用会话所在目录名兜底
			name := pid
			if pid == "global" {
				name = "全局项目"
			} else if seg := lastPathSegment(dir); seg != "" {
				name = seg
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

		// 取第一个可用的时间字段（updated 优先，其次 created）
		var sessionTime string
		if s.Time.Updated > 0 {
			sessionTime = time.UnixMilli(s.Time.Updated).Format("2006-01-02 15:04")
		} else if s.Time.Created > 0 {
			sessionTime = time.UnixMilli(s.Time.Created).Format("2006-01-02 15:04")
		}
		for i := range proj.Children {
			if proj.Children[i].ID == dirKey {
				proj.Children[i].Children = append(proj.Children[i].Children, model.TreeNode{
					ID:        s.ID,
					Title:     title,
					Type:      "session",
					UpdatedAt: sessionTime,
					Directory: dir,
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
