package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// webSession 管理 opencode web 进程生命周期。
type webSession struct {
	cmd      *exec.Cmd
	port     int
	hostname string
}

const (
	defaultHostname = "127.0.0.1"
	defaultPort     = 4096
)

var (
	webSess     *webSession
	webSessMu   sync.Mutex
	eventMu     sync.Mutex
	eventStop   context.CancelFunc
	lastCfgHost = defaultHostname
	lastCfgPort = defaultPort
)

// WebResult 前端展示用的 web 状态。
type WebResult struct {
	Running bool   `json:"running"`
	Success bool   `json:"success"`
	URL     string `json:"url"`
	Health  string `json:"health"`
	Version string `json:"version"`
	Error   string `json:"error,omitempty"`
}

// APIResult 是 opencode serve API 的透传结果。
type APIResult struct {
	Success bool   `json:"success"`
	Status  int    `json:"status"`
	Body    string `json:"body"`
	Error   string `json:"error,omitempty"`
}

// ProxyConfig 是启动 opencode serve 时注入的代理配置。
type ProxyConfig struct {
	ProxyEnabled bool   `json:"proxyEnabled"`
	ProxyHost    string `json:"proxyHost"`
	ProxyPort    string `json:"proxyPort"`
}

// StartOpenCodeWeb 启动 opencode serve，等待端口就绪后返回。
func (a *App) StartOpenCodeWeb(port int, hostname string, proxy ProxyConfig) WebResult {
	if hostname == "" {
		hostname = defaultHostname
	}
	if port <= 0 {
		port = defaultPort
	}
	lastCfgHost = hostname
	lastCfgPort = port

	webSessMu.Lock()
	if webSess != nil {
		p := webSess.port
		h := webSess.hostname
		webSessMu.Unlock()
		if p != port || h != hostname {
			return WebResult{Error: "OpenCode 服务已启动；修改地址或端口前请先停止服务"}
		}
		health, version, _ := getOpenCodeHealth(h, p)
		return WebResult{Running: true, Success: true, URL: fmt.Sprintf("http://%s:%d", h, p), Health: health, Version: version}
	}
	webSessMu.Unlock()

	if isOpenCodeServerRunning(hostname, port) {
		return WebResult{Error: fmt.Sprintf("%s:%d 已有 OpenCode 服务运行，请先停止该服务", hostname, port)}
	}

	cmd := exec.Command("opencode", "serve",
		"--port", strconv.Itoa(port),
		"--hostname", hostname,
	)
	if proxy.ProxyEnabled {
		host := strings.TrimSpace(proxy.ProxyHost)
		proxyPort := strings.TrimSpace(proxy.ProxyPort)
		if host == "" {
			host = "127.0.0.1"
		}
		if proxyPort == "" {
			proxyPort = "7897"
		}
		proxyURL := fmt.Sprintf("http://%s:%s", host, proxyPort)
		cmd.Env = append(os.Environ(),
			"HTTP_PROXY="+proxyURL,
			"HTTPS_PROXY="+proxyURL,
			"ALL_PROXY="+proxyURL,
			"NO_PROXY=localhost,127.0.0.1",
		)
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}

	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		return WebResult{Error: fmt.Sprintf("启动 opencode web 失败: %v", err)}
	}

	addr := net.JoinHostPort(hostname, strconv.Itoa(port))
	ready := make(chan error, 1)
	go func() {
		for i := 0; i < 40; i++ {
			time.Sleep(250 * time.Millisecond)
			conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
			if err == nil {
				conn.Close()
				ready <- nil
				return
			}
		}
		ready <- fmt.Errorf("端口 %d 在 10 秒内未就绪", port)
	}()

	select {
	case err := <-ready:
		if err != nil {
			killProcTree(cmd.Process.Pid)
			detail := ""
			if stderr != nil {
				buf := make([]byte, 2048)
				n, _ := stderr.Read(buf)
				if n > 0 {
					detail = ": " + strings.TrimSpace(string(buf[:n]))
				}
			}
			return WebResult{Error: fmt.Sprintf("启动超时%s", detail)}
		}
	case <-time.After(12 * time.Second):
		killProcTree(cmd.Process.Pid)
		return WebResult{Error: "启动超时（超过 12 秒）"}
	}

	sess := &webSession{cmd: cmd, port: port, hostname: hostname}

	webSessMu.Lock()
	webSess = sess
	webSessMu.Unlock()

	go func() {
		_ = cmd.Wait()
		webSessMu.Lock()
		if webSess == sess {
			webSess = nil
		}
		webSessMu.Unlock()
	}()

	health, version, _ := getOpenCodeHealth(hostname, port)
	return WebResult{Running: true, Success: true, URL: fmt.Sprintf("http://%s:%d", hostname, port), Health: health, Version: version}
}

// StopOpenCodeWeb 停止 opencode web 服务（含子进程 bun）。
func (a *App) StopOpenCodeWeb() WebResult {
	a.StopOpenCodeEvents()

	webSessMu.Lock()
	sess := webSess
	webSess = nil
	webSessMu.Unlock()

	if sess != nil && sess.cmd != nil && sess.cmd.Process != nil {
		pid := sess.cmd.Process.Pid
		kill := exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(pid))
		kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		kill.Run()
		return WebResult{}
	}

	if sess != nil && sess.port > 0 {
		killByPort(sess.port)
	}
	return WebResult{}
}

func killByPort(port int) {
	find := exec.Command("cmd", "/c",
		fmt.Sprintf("netstat -ano | findstr :%d | findstr LISTENING", port))
	find.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := find.Output()
	if err != nil {
		return
	}
	fields := strings.Fields(string(out))
	if len(fields) < 5 {
		return
	}
	pid, err := strconv.Atoi(fields[len(fields)-1])
	if err != nil || pid <= 0 {
		return
	}
	killProcTree(pid)
}

// GetWebStatus 返回当前 web 服务状态。hostname/port 为前端配置的服务地址。
func (a *App) GetWebStatus(hostname string, port int) WebResult {
	if hostname == "" {
		hostname = defaultHostname
	}
	if port <= 0 {
		port = defaultPort
	}
	lastCfgHost = hostname
	lastCfgPort = port
	webSessMu.Lock()
	if webSess != nil {
		p := webSess.port
		h := webSess.hostname
		defer webSessMu.Unlock()
		health, version, _ := getOpenCodeHealth(h, p)
		return WebResult{Running: true, Success: true, URL: fmt.Sprintf("http://%s:%d", h, p), Health: health, Version: version}
	}
	webSessMu.Unlock()

	if isOpenCodeServerRunning(hostname, port) {
		log.Printf("[STATUS] GetWebStatus(%s:%d) detected running", hostname, port)
		webSessMu.Lock()
		webSess = &webSession{port: port, hostname: hostname}
		webSessMu.Unlock()
		health, version, _ := getOpenCodeHealth(hostname, port)
		return WebResult{Running: true, Success: true, URL: fmt.Sprintf("http://%s:%d", hostname, port), Health: health, Version: version}
	}

	return WebResult{URL: fmt.Sprintf("http://%s:%d", hostname, port), Health: "离线"}
}

// getWebSession 返回当前 webSession，未启动则尝试用最后已知配置自动检测。
func getWebSession() *webSession {
	webSessMu.Lock()
	sess := webSess
	webSessMu.Unlock()
	if sess != nil {
		return sess
	}
	if isOpenCodeServerRunning(lastCfgHost, lastCfgPort) {
		log.Printf("[STATUS] auto-detected serve at %s:%d", lastCfgHost, lastCfgPort)
		sess = &webSession{port: lastCfgPort, hostname: lastCfgHost}
		webSessMu.Lock()
		webSess = sess
		webSessMu.Unlock()
		return sess
	}
	return nil
}

// OpenCodeAPI 代理访问本机 opencode serve API，避免前端跨域限制。
func (a *App) OpenCodeAPI(method, path, body string) APIResult {
	sess := getWebSession()
	if sess == nil {
		return APIResult{Error: "opencode 服务未启动"}
	}

	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	url := fmt.Sprintf("http://%s:%d%s", sess.hostname, sess.port, path)

	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		return APIResult{Error: err.Error()}
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return APIResult{Error: err.Error()}
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return APIResult{Status: resp.StatusCode, Error: err.Error()}
	}
	return APIResult{Success: resp.StatusCode >= 200 && resp.StatusCode < 300, Status: resp.StatusCode, Body: string(data)}
}

// CreateSession 使用指定工作目录创建新会话（设置 x-opencode-directory 请求头）。
func (a *App) CreateSession(workDir string) APIResult {
	sess := getWebSession()
	if sess == nil {
		return APIResult{Error: "opencode 服务未启动"}
	}
	workDir = strings.TrimSpace(workDir)
	if workDir == "" {
		return APIResult{Error: "工作目录不能为空"}
	}

	url := fmt.Sprintf("http://%s:%d/session", sess.hostname, sess.port)
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader("{}"))
	if err != nil {
		return APIResult{Error: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-opencode-directory", workDir)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return APIResult{Error: err.Error()}
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return APIResult{Status: resp.StatusCode, Error: err.Error()}
	}
	return APIResult{Success: resp.StatusCode >= 200 && resp.StatusCode < 300, Status: resp.StatusCode, Body: string(data)}
}

// AnswerQuestion 回答 question 工具调用。
// 通过 /question API 查找待回答的问题，然后调用 /question/{id}/reply 发送答案。
func (a *App) AnswerQuestion(sessionID, answerLabel string) APIResult {
	sess := getWebSession()
	if sess == nil {
		return APIResult{Error: "opencode 服务未启动"}
	}

	// 1. 获取待回答的问题列表
	base := fmt.Sprintf("http://%s:%d", sess.hostname, sess.port)
	resp, err := http.Get(base + "/question")
	if err != nil {
		return APIResult{Error: fmt.Sprintf("获取问题列表失败: %v", err)}
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	type QuestionRequest struct {
		ID        string `json:"id"`
		SessionID string `json:"sessionID"`
	}
	var questions []QuestionRequest
	if err := json.Unmarshal(body, &questions); err != nil {
		return APIResult{Error: fmt.Sprintf("解析问题列表失败: %v", err)}
	}

	// 2. 找到匹配 sessionID 的问题
	var requestID string
	for _, q := range questions {
		if q.SessionID == sessionID {
			requestID = q.ID
			break
		}
	}
	if requestID == "" {
		return APIResult{Error: "未找到该会话的待回答问题"}
	}

	// 3. 发送答案
	replyBody := fmt.Sprintf(`{"answers":[["%s"]]}`, answerLabel)
	replyResp, err := http.Post(
		fmt.Sprintf("%s/question/%s/reply", base, requestID),
		"application/json",
		strings.NewReader(replyBody),
	)
	if err != nil {
		return APIResult{Error: fmt.Sprintf("回答问题失败: %v", err)}
	}
	defer replyResp.Body.Close()

	replyData, _ := io.ReadAll(replyResp.Body)
	return APIResult{
		Success: replyResp.StatusCode >= 200 && replyResp.StatusCode < 300,
		Status:  replyResp.StatusCode,
		Body:    string(replyData),
	}
}

// RejectQuestion 忽略 question 工具调用。
func (a *App) RejectQuestion(sessionID string) APIResult {
	sess := getWebSession()
	if sess == nil {
		return APIResult{Error: "opencode 服务未启动"}
	}

	base := fmt.Sprintf("http://%s:%d", sess.hostname, sess.port)
	resp, err := http.Get(base + "/question")
	if err != nil {
		return APIResult{Error: fmt.Sprintf("获取问题列表失败: %v", err)}
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	type QuestionRequest struct {
		ID        string `json:"id"`
		SessionID string `json:"sessionID"`
	}
	var questions []QuestionRequest
	if err := json.Unmarshal(body, &questions); err != nil {
		return APIResult{Error: fmt.Sprintf("解析问题列表失败: %v", err)}
	}

	var requestID string
	for _, q := range questions {
		if q.SessionID == sessionID {
			requestID = q.ID
			break
		}
	}
	if requestID == "" {
		return APIResult{Error: "未找到该会话的待回答问题"}
	}

	req, _ := http.NewRequest(http.MethodPost,
		fmt.Sprintf("%s/question/%s/reject", base, requestID), nil)
	rejectResp, err := http.DefaultClient.Do(req)
	if err != nil {
		return APIResult{Error: fmt.Sprintf("忽略问题失败: %v", err)}
	}
	defer rejectResp.Body.Close()

	rejectData, _ := io.ReadAll(rejectResp.Body)
	return APIResult{
		Success: rejectResp.StatusCode >= 200 && rejectResp.StatusCode < 300,
		Status:  rejectResp.StatusCode,
		Body:    string(rejectData),
	}
}

// TreeNode 项目-目录-会话树节点
type TreeNode struct {
	ID       string     `json:"id"`
	Title    string     `json:"title"`
	Type     string     `json:"type"` // "project", "directory", "session"
	Children []TreeNode `json:"children,omitempty"`
}

// GetProjectTree 获取项目→目录→会话的树形结构 JSON。
// knownDirs 是前端记录的所有建过会话的目录（JSON 字符串数组），用于查询 global 项目会话。
func (a *App) GetProjectTree(knownDirs string) string {
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
		body, _ := io.ReadAll(resp1.Body)
		resp1.Body.Close()
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
		var batch []treeSession
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
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
		var batch []treeSession
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
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

func buildTreeJSON(projects []ProjectInfo, sessions []treeSession) string {
	// 按 project 分组，再按 directory 分组
	projectMap := make(map[string]*TreeNode)
	dirMap := make(map[string]*TreeNode) // key: projectID+"|"+directory

	for _, p := range projects {
		name := p.Name
		if name == "" {
			name = p.ID
		}
		if name == "global" {
			name = "全局项目"
		}
		node := &TreeNode{ID: p.ID, Title: name, Type: "project"}
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
			proj = &TreeNode{ID: pid, Title: name, Type: "project"}
			projectMap[pid] = proj
		}

		// 确保 directory 节点存在
		dirNode, ok := dirMap[dirKey]
		if !ok {
			dirNode = &TreeNode{ID: dirKey, Title: dir, Type: "directory"}
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
				proj.Children[i].Children = append(proj.Children[i].Children, TreeNode{
					ID:    s.ID,
					Title: title,
					Type:  "session",
				})
			}
		}
	}

	// 转为数组
	tree := make([]TreeNode, 0, len(projectMap))
	for _, p := range projectMap {
		tree = append(tree, *p)
	}

	data, _ := json.Marshal(tree)
	return string(data)
}

// StartOpenCodeEvents 连接 opencode 全局 SSE，并通过 Wails 事件转发给前端。
func (a *App) StartOpenCodeEvents() APIResult {
	webSessMu.Lock()
	sess := webSess
	webSessMu.Unlock()
	if sess == nil {
		return APIResult{Error: "opencode 服务未启动"}
	}

	eventMu.Lock()
	if eventStop != nil {
		eventStop()
	}
	ctx, cancel := context.WithCancel(context.Background())
	eventStop = cancel
	eventMu.Unlock()

	url := fmt.Sprintf("http://%s:%d/global/event", sess.hostname, sess.port)
	go func() {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			runtime.EventsEmit(a.ctx, "oc-event-error", err.Error())
			return
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			runtime.EventsEmit(a.ctx, "oc-event-error", err.Error())
			return
		}
		defer resp.Body.Close()

		scanner := bufio.NewScanner(resp.Body)
		buf := make([]byte, 0, 64*1024)
		scanner.Buffer(buf, 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "data:") {
				runtime.EventsEmit(a.ctx, "oc-event", strings.TrimSpace(strings.TrimPrefix(line, "data:")))
			}
		}
		if err := scanner.Err(); err != nil && ctx.Err() == nil {
			runtime.EventsEmit(a.ctx, "oc-event-error", err.Error())
		}
	}()

	return APIResult{Success: true, Status: 200}
}

// StopOpenCodeEvents 停止 SSE 转发。
func (a *App) StopOpenCodeEvents() APIResult {
	eventMu.Lock()
	if eventStop != nil {
		eventStop()
		eventStop = nil
	}
	eventMu.Unlock()
	return APIResult{Success: true, Status: 200}
}

// LaunchWindowsTerminal 在外部终端中打开 opencode。
func (a *App) LaunchWindowsTerminal(mode, webURL, dir string) WebResult {
	var args []string
	if mode == "attach" && webURL != "" {
		args = []string{"opencode", "attach", webURL}
	} else {
		args = []string{"opencode"}
	}
	if dir != "" {
		args = append(args, "--dir", dir)
	}

	cmd, err := findWindowsTerminal(args...)
	if err == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: false}
		if err := cmd.Start(); err == nil {
			return WebResult{Success: true}
		}
	}

	cmdArgs := append([]string{"/c", "start", "opencode"}, args[1:]...)
	cmd = exec.Command("cmd", cmdArgs...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: false}
	if err := cmd.Start(); err != nil {
		return WebResult{Error: fmt.Sprintf("启动终端失败: %v", err)}
	}
	return WebResult{Success: true}
}

func findWindowsTerminal(args ...string) (*exec.Cmd, error) {
	for _, name := range []string{"wt", "WindowsTerminal"} {
		wtPath, err := exec.LookPath(name)
		if err == nil {
			wtArgs := []string{"-d", ".", "--"}
			wtArgs = append(wtArgs, args...)
			return exec.Command(wtPath, wtArgs...), nil
		}
	}
	for _, p := range []string{
		os.ExpandEnv("${LOCALAPPDATA}\\Microsoft\\WindowsApps\\wt.exe"),
		os.ExpandEnv("${ProgramFiles}\\WindowsApps\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\wt.exe"),
	} {
		if _, err := os.Stat(p); err == nil {
			wtArgs := append([]string{"-d", "."}, args...)
			return exec.Command(p, wtArgs...), nil
		}
	}
	return nil, fmt.Errorf("Windows Terminal 未安装")
}

func killProcTree(pid int) {
	kill := exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(pid))
	kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	kill.Run()
}

func isOpenCodeServerRunning(hostname string, port int) bool {
	_, _, ok := getOpenCodeHealth(hostname, port)
	return ok
}

func getOpenCodeHealth(hostname string, port int) (string, string, bool) {
	client := http.Client{Timeout: 2 * time.Second}
	url := fmt.Sprintf("http://%s:%d/global/health", hostname, port)
	resp, err := client.Get(url)
	if err != nil {
		return "离线", "", false
	}
	defer resp.Body.Close()

	version := ""
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "异常", "", false
	}
	if len(body) > 0 {
		var payload map[string]interface{}
		if err := json.Unmarshal(body, &payload); err == nil {
			version = stringValue(payload["version"])
			if version == "" {
				version = stringValue(payload["Version"])
			}
		}
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return "在线", version, true
	}
	if resp.StatusCode < 500 {
		return "未知", version, true
	}
	return "异常", version, false
}

func stringValue(value interface{}) string {
	switch v := value.(type) {
	case string:
		return v
	case fmt.Stringer:
		return v.String()
	default:
		return ""
	}
}

// ========== 命令面板 ==========

// CmdPaletteItem 命令面板展示项（精简自 opencode /command 接口）。
type CmdPaletteItem struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Source      string `json:"source"` // "builtin" | "skill"
}

// GetOpenCodeCommands 从 opencode serve 获取所有可用命令，返回精简数据。
func (a *App) GetOpenCodeCommands() []CmdPaletteItem {
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

	result := make([]CmdPaletteItem, 0, len(raw))
	for _, r := range raw {
		result = append(result, CmdPaletteItem{
			Name:        r.Name,
			Description: r.Description,
			Source:      r.Source,
		})
	}
	return result
}

// executablePath 返回当前进程可执行文件的路径。
func executablePath() string {
	p, err := os.Executable()
	if err != nil {
		return "."
	}
	return p
}

// OpenDirectoryDialog 打开目录选择对话框。
func (a *App) OpenDirectoryDialog() string {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            "选择工作目录",
		DefaultDirectory: filepath.Dir(executablePath()),
	})
	if err != nil {
		return ""
	}
	return dir
}

// ========== 会话列表（兼容旧接口） ==========

// SessionInfo 会话记录
type SessionInfo struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// GetSessions 获取最近 15 个 OpenCode 会话记录。
func (a *App) GetSessions() ([]SessionInfo, error) {
	sessions, err := fetchSessions()
	if err != nil {
		return []SessionInfo{{ID: "", Title: "加载失败: " + err.Error()[:50]}}, nil
	}
	return sessions, nil
}

func fetchSessions() ([]SessionInfo, error) {
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

	sessions := make([]SessionInfo, 0, len(raw))
	for _, r := range raw {
		title := strings.ReplaceAll(r.Title, "\n", " ")
		if len([]rune(title)) > 60 {
			title = string([]rune(title)[:60]) + "..."
		}
		sessions = append(sessions, SessionInfo{ID: r.ID, Title: title})
	}
	return sessions, nil
}
