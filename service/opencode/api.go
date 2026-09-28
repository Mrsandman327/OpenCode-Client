// Package service 处理 OpenCode serve 进程管理、API 代理、SSE 事件流、会话 CRUD、项目树构建和终端启动。
package opencode

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
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
	} else if expectsJSONBody(method) {
		// v2 的写操作端点（如 POST /api/session）要求请求体是 JSON 对象，
		// 空 body 会得到 400 {"kind":"Payload","message":"Expected object"}。
		// 对无请求参数的调用（如 interrupt、revert/commit）统一补一个空对象。
		reader = strings.NewReader("{}")
		body = "{}"
	}
	req, err := http.NewRequest(method, urlstr, reader)
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	applyAuth(req, sess.password)

	resp, err := apiClient.Do(req)
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return model.APIResult{Status: resp.StatusCode, Error: err.Error()}
	}

	// v2 的 SPA 兜底路由会对任何未注册的路径返回 200 + text/html（首页 HTML）。
	// 若只看状态码，v1 时代遗留的路径会被误判为"请求成功"，随后把 HTML 交给
	// json.Unmarshal，报出难以定位的"解析失败"。这里按 Content-Type 显式拦截。
	if isHTMLResponse(resp.Header.Get("Content-Type")) {
		return model.APIResult{
			Status: resp.StatusCode,
			Error:  fmt.Sprintf("OpenCode v2 未提供该 API 路径（%s %s 返回了网页内容而非 JSON）。请更新 OC Manager 或检查 opencode 版本", method, path),
		}
	}

	return model.APIResult{Success: resp.StatusCode >= 200 && resp.StatusCode < 300, Status: resp.StatusCode, Body: string(data)}
}

// isHTMLResponse 判断响应是否为 HTML（而非预期中的 JSON）。
func isHTMLResponse(contentType string) bool {
	ct := strings.ToLower(strings.TrimSpace(contentType))
	return strings.HasPrefix(ct, "text/html")
}

// expectsJSONBody 判断该方法是否需要携带 JSON 请求体。
func expectsJSONBody(method string) bool {
	switch strings.ToUpper(method) {
	case http.MethodPost, http.MethodPatch, http.MethodPut:
		return true
	}
	return false
}

// apiGet 发起带 v2 认证的 GET 请求并返回响应体。
func apiGet(urlstr, password string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, urlstr, nil)
	if err != nil {
		return nil, err
	}
	applyAuth(req, password)
	resp, err := apiClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return readAPIResponse(resp, urlstr)
}

// apiPost 发起带 v2 认证的 JSON POST 请求。
func apiPost(urlstr, password string, payload []byte) model.APIResult {
	req, err := http.NewRequest(http.MethodPost, urlstr, strings.NewReader(string(payload)))
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	applyAuth(req, password)
	resp, err := apiClient.Do(req)
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}
	defer resp.Body.Close()
	data, err := readAPIResponse(resp, urlstr)
	if err != nil {
		return model.APIResult{Status: resp.StatusCode, Error: err.Error()}
	}
	return model.APIResult{Success: resp.StatusCode >= 200 && resp.StatusCode < 300, Status: resp.StatusCode, Body: string(data)}
}

// readAPIResponse 读取响应体，并对 v2 的 HTML 兜底与 401 做显式处理。
func readAPIResponse(resp *http.Response, urlstr string) ([]byte, error) {
	if isHTMLResponse(resp.Header.Get("Content-Type")) {
		return nil, fmt.Errorf("OpenCode v2 未提供该 API 路径（%s 返回了网页内容而非 JSON）", urlstr)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("OpenCode 服务需要口令（401），请重启服务或检查服务地址")
	}
	return data, nil
}

// sessionGet 取回单个会话对象（已拆开 v2 的 {data:...} 信封）。
func sessionGet(base, path, password string) (map[string]any, error) {
	body, err := apiGet(base+path, password)
	if err != nil {
		return nil, err
	}
	return unwrapSessionData(body), nil
}

// findSessionDirectory 根据 sessionID 反查当前会话所属工作目录。
// v2 的会话对象把目录放在 location.directory（v1 是顶层 directory）。
// question/form 接口按目录作用域隔离，因此必须先拿到目录再请求。
func findSessionDirectory(base, sessionID, password string) (string, error) {
	resp, err := sessionGet(base, "/api/session/"+url.QueryEscape(sessionID), password)
	if err != nil {
		return "", fmt.Errorf("获取会话目录失败: %v", err)
	}
	return sessionDirectory(resp), nil
}

// sessionDirectory 从 v2 会话对象中取工作目录。
func sessionDirectory(session map[string]any) string {
	if loc, ok := session["location"].(map[string]any); ok {
		if dir, ok := loc["directory"].(string); ok && dir != "" {
			return dir
		}
	}
	// 兼容仍返回顶层 directory 的形态
	if dir, ok := session["directory"].(string); ok {
		return dir
	}
	return ""
}

// unwrapSessionData 拆开 v2 的 {data: ...} 响应信封。
func unwrapSessionData(body []byte) map[string]any {
	var outer map[string]any
	if err := json.Unmarshal(body, &outer); err != nil {
		return nil
	}
	if inner, ok := outer["data"].(map[string]any); ok {
		return inner
	}
	return outer
}

// formInfo 描述 v2 的一个待填表单（v1 的 question 请求在 v2 中由 form 承担）。
type formInfo struct {
	ID        string           `json:"id"`
	SessionID string           `json:"sessionID"`
	Title     string           `json:"title"`
	Fields    []map[string]any `json:"fields"`
}

// findPendingForm 查找该会话下待回答的表单。
// v1 是 /question?directory=...（裸数组），v2 是 /api/form?location[directory]=...（{location,data} 信封）。
// 注意 location 是 deepObject 风格参数（style=deepObject, explode=true），
// 必须编码成 location[directory]=...，写成 location=... 会被服务端忽略。
func findPendingForm(base, sessionID, directory, password string) (*formInfo, error) {
	formURL := base + "/api/form?location%5Bdirectory%5D=" + url.QueryEscape(directory)
	body, err := apiGet(formURL, password)
	if err != nil {
		return nil, fmt.Errorf("获取待回答表单失败: %v", err)
	}

	var payload struct {
		Data []formInfo `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("解析待回答表单失败: %v", err)
	}

	for i := range payload.Data {
		if payload.Data[i].SessionID == sessionID {
			return &payload.Data[i], nil
		}
	}
	return nil, fmt.Errorf("未找到该会话的待回答表单")
}

// AnswerQuestion 回答表单（v1 形态的 question 工具）。
// answers 为按问题顺序的二维数组（每个问题一个 string[]，支持多选与自定义输入）；
// v2 的表单按字段 key 提交，因此这里按下标把 answers 映射到各字段的 key。
func AnswerQuestion(sessionID string, answers [][]string) model.APIResult {
	sess := getWebSession()
	if sess == nil {
		return model.APIResult{Error: "opencode 服务未启动"}
	}
	base, err := getWebSessionBase()
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}
	directory, err := findSessionDirectory(base, sessionID, sess.password)
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}

	form, err := findPendingForm(base, sessionID, directory, sess.password)
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}

	// 按字段顺序把二维答案数组映射为 {fieldKey: [选中的值]}
	answer := make(map[string]any, len(form.Fields))
	for i, field := range form.Fields {
		key, _ := field["key"].(string)
		if key == "" {
			continue
		}
		if i < len(answers) && len(answers[i]) > 0 {
			answer[key] = answers[i]
		} else if i < len(answers) {
			// 跳过的题提交空数组（v2 的 Form.Value 允许 string[]）
			answer[key] = []string{}
		}
	}

	payload, _ := json.Marshal(map[string]any{"answer": answer})
	// v2 的 form 回复端点只接受路径参数，不接收 location 查询参数
	replyURL := fmt.Sprintf("%s/api/session/%s/form/%s/reply",
		base, url.QueryEscape(sessionID), url.QueryEscape(form.ID))
	return apiPost(replyURL, sess.password, payload)
}

// RejectQuestion 忽略待回答表单。
// v1 有 /question/{id}/reject 端点；v2 的表单 API 只提供 /reply，没有取消端点
// （Form.State 虽有 cancelled 形态，但没有对应的写接口），因此这里明确报错，
// 由前端隐藏「跳过」入口，避免出现「点了没反应」。
func RejectQuestion(sessionID string) model.APIResult {
	return model.APIResult{
		Error: "OpenCode v2 的表单 API 未提供取消/跳过接口，无法忽略该提问；请直接回答或中断本次运行",
	}
}

// ProjectInfo 项目树中的项目信息。
// v2 把 v1 的 worktree 改名为 canonical，并取消了 name 字段；
// vcs 也从对象变成了字符串。故 name/root 需在解析后另行推导。
type ProjectInfo struct {
	ID        string      `json:"id"`
	Name      string      `json:"name"`
	Canonical string      `json:"canonical"`
	VCS       string      `json:"vcs"`
	Time      sessionTime `json:"time"`
}

type sessionTime struct {
	Created int64 `json:"created"`
	Updated int64 `json:"updated"`
}

// treeSession 会话列表项。
// v2 把 v1 的 directory 移到了 location.directory，故两者都声明，按需回退读取。
type treeSession struct {
	ID        string      `json:"id"`
	Title     string      `json:"title"`
	ProjectID string      `json:"projectID"`
	Directory string      `json:"directory"`
	Location  *struct {
		Directory string `json:"directory"`
	} `json:"location"`
	Time sessionTime `json:"time"`
}

// Dir 返回会话所属目录：优先 v2 的 location.directory，回退到 v1 的 directory。
func (s treeSession) Dir() string {
	if s.Location != nil && s.Location.Directory != "" {
		return s.Location.Directory
	}
	return s.Directory
}

// unmarshalSessionList 解析 v2 的会话列表：{data:[...], cursor:{...}} 信封。
// 若 data 缺失则尝试按裸数组解析（兼容旧形态）。
func unmarshalSessionList(body []byte) ([]treeSession, error) {
	var envelope struct {
		Data []treeSession `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err == nil && envelope.Data != nil {
		return envelope.Data, nil
	}
	var bare []treeSession
	if err := json.Unmarshal(body, &bare); err != nil {
		return nil, err
	}
	return bare, nil
}

// fetchSessionList 查询某目录下的会话。
// v1 用 ?directory=&roots=true 递归收集子目录会话；v2 去掉了 roots 参数，
// 目录作用域由 location/directory 表达，cursor 参数改为游标分页。
func fetchSessionList(base, directory, password string, limit int) []treeSession {
	urlstr := fmt.Sprintf("%s/api/session?directory=%s&limit=%d",
		base, url.QueryEscape(directory), limit)
	body, err := apiGet(urlstr, password)
	if err != nil {
		return nil
	}
	sessions, err := unmarshalSessionList(body)
	if err != nil {
		return nil
	}
	return sessions
}

// GetProjectTree 获取项目→目录→会话的树形结构 JSON。
// knownDirs 是前端记录的所有建过会话的目录（JSON 字符串数组），用于查询 global 项目会话。
func GetProjectTree(knownDirs string) string {
	base, err := getWebSessionBase()
	if err != nil {
		return "[]"
	}
	password := ""
	if sess := getWebSession(); sess != nil {
		password = sess.password
	}

	var projects []ProjectInfo
	var extraDirs []string
	if knownDirs != "" {
		json.Unmarshal([]byte(knownDirs), &extraDirs)
	}

	// 获取项目列表（v2：/api/project，v1：/project）
	if body, err := apiGet(base+"/api/project", password); err == nil {
		json.Unmarshal(body, &projects)
	} else {
		projects = []ProjectInfo{{ID: "global", Name: "全局项目", Canonical: "/"}}
	}

	var allSessions []treeSession
	seen := map[string]bool{}

	for _, project := range projects {
		extraDirs = append(extraDirs, project.Canonical)
	}

	// 自动发现所有会话目录：从全量会话列表提取目录。
	// 必要性：Web 端浏览器的 localStorage 与桌面 WebView2 隔离，knownDirs 为空；
	// 若不自动发现，未注册为 opencode 项目、但建过会话的目录（如当前工作目录）的会话将丢失。
	for _, s := range fetchSessionList(base, "", password, 1000) {
		if dir := s.Dir(); dir != "" {
			extraDirs = append(extraDirs, dir)
		}
	}
	//去重
	deduplicateInPlace := func(s []string) []string {
		if len(s) == 0 {
			return s
		}
		seen := make(map[string]struct{}, len(s)) // 预分配容量，避免 map 扩容
		j := 0
		for i := 0; i < len(s); i++ {
			v := s[i]
			if _, ok := seen[v]; !ok {
				seen[v] = struct{}{}
				s[j] = v
				j++
			}
		}
		return s[:j]
	}
	extraDirs = deduplicateInPlace(extraDirs)

	// 并发查询已知 global 目录下的会话
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, dir := range extraDirs {
		dir := strings.TrimSpace(dir)
		if dir == "" {
			continue
		}
		wg.Add(1)
		go func(d string) {
			defer wg.Done()
			batch := fetchSessionList(base, d, password, 200)
			mu.Lock()
			for _, s := range batch {
				if !seen[s.ID] {
					seen[s.ID] = true
					allSessions = append(allSessions, s)
				}
			}
			mu.Unlock()
		}(dir)
	}
	wg.Wait()

	return buildTreeJSON(projects, allSessions)
}

// projectDisplayName 从 canonical 路径推导可读的项目名。
// v2 的 Project 不含 name 字段，直接显示哈希 ID 对用户毫无意义。
func projectDisplayName(p ProjectInfo) string {
	canonical := strings.TrimRight(strings.ReplaceAll(p.Canonical, "\\", "/"), "/")
	if canonical == "" {
		if p.ID == "global" {
			return "全局项目"
		}
		return p.ID
	}
	if idx := strings.LastIndex(canonical, "/"); idx >= 0 && idx+1 < len(canonical) {
		return canonical[idx+1:]
	}
	return canonical
}

func buildTreeJSON(projects []ProjectInfo, sessions []treeSession) string {
	projectMap := make(map[string]*model.TreeNode)
	dirMap := make(map[string]*model.TreeNode) // key: projectID+"|"+directory

	for _, p := range projects {
		name := p.Name
		if name == "" {
			// v2 不再返回 name，改用 canonical 路径的末段作为可读名
			name = projectDisplayName(p)
		}
		if name == "global" {
			name = "全局项目"
		}
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
		dir := s.Dir()
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
