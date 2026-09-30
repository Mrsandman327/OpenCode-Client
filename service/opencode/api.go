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

// readAPIResponse 读取响应体，并对 v2 的 HTML 兜底、401 与所有非 2xx 做显式处理。
//
// 非 2xx 必须在这里转成 error，而不是把响应体当正常数据返回。原因是 v2 的错误体
// 形如 {"_tag":"SessionNotFoundError","message":"..."}——**没有 error 键**，
// 调用方若按「响应里有没有 error 字段」判失败，永远判不出来，
// 404 的错误体会被当成正常数据继续解析，错误因此被推迟到更远、更难定位的地方。
// 曾经就踩过：导出会话失败时返回的是错误 JSON，被原样当作导出内容交给前端。
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
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("OpenCode 返回 %d: %s", resp.StatusCode, describeV2Error(data))
	}
	return data, nil
}

// describeV2Error 从 v2 错误体里取出可读信息。
// 已知形态：{"_tag":"XxxError","message":"..."}，message 可能缺省。
func describeV2Error(body []byte) string {
	var payload struct {
		Tag     string `json:"_tag"`
		Message string `json:"message"`
		Kind    string `json:"kind"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		// 不是 JSON 就原样给出一段截断文本，总比空消息好定位
		text := strings.TrimSpace(string(body))
		if len(text) > 200 {
			text = text[:200] + "…"
		}
		if text == "" {
			return "(无错误详情)"
		}
		return text
	}
	parts := make([]string, 0, 2)
	if payload.Tag != "" {
		parts = append(parts, payload.Tag)
	}
	if payload.Message != "" {
		parts = append(parts, payload.Message)
	}
	if payload.Kind != "" {
		parts = append(parts, "kind="+payload.Kind)
	}
	if len(parts) == 0 {
		return "(无错误详情)"
	}
	return strings.Join(parts, ": ")
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

	// 按字段类型构造答案：v2 的 Form.Value = string | number | boolean | string[]，
	// 其中**只有 multiselect 字段接受数组**；string/number/integer/boolean/external 都必须是标量。
	// 此前无条件提交 []string，导致单选类字段被判 FormInvalidAnswerError —— 也就是"提问无法提交"。
	// 跳过（前端传空数组）的字段：multiselect 提交空数组，其余类型**省略该键**（交给服务端按
	// required 语义校验，避免送出类型非法的空值）。
	answer := make(map[string]any, len(form.Fields))
	for i, field := range form.Fields {
		key, _ := field["key"].(string)
		if key == "" {
			continue
		}
		ftype, _ := field["type"].(string)
		var vals []string
		if i < len(answers) {
			vals = answers[i]
		}
		if ftype == "multiselect" {
			if vals == nil {
				vals = []string{}
			}
			answer[key] = vals
			continue
		}
		if len(vals) == 0 {
			continue // 跳过该题
		}
		first := vals[0]
		switch ftype {
		case "number", "integer":
			if n, err := strconv.Atoi(first); err == nil {
				answer[key] = n
			} else if f, err := strconv.ParseFloat(first, 64); err == nil {
				answer[key] = f
			} else {
				answer[key] = first
			}
		case "boolean":
			answer[key] = (first == "true" || first == "1")
		default:
			answer[key] = first
		}
	}

	payload, _ := json.Marshal(map[string]any{"answer": answer})
	// v2 的 form 回复端点只接受路径参数，不接收 location 查询参数
	replyURL := fmt.Sprintf("%s/api/session/%s/form/%s/reply",
		base, url.QueryEscape(sessionID), url.QueryEscape(form.ID))
	return apiPost(replyURL, sess.password, payload)
}

// RejectQuestion 忽略待回答表单。
//
// v1 有 /question/{id}/reject 端点；v2 的表单 API 只提供 /reply，没有取消端点
// （Form.State 虽有 cancelled 形态，但无对应写接口），故这里无法真正取消。
//
// 注意：前端「跳过此问题」并不调用本方法——它只在本地把该题标记为跳过，
// 提交时按位置传空数组。因此 v2 下跳过功能本身是可用的，本方法仅作占位保留。
func RejectQuestion(sessionID string) model.APIResult {
	return model.APIResult{Error: "OpenCode v2 的表单 API 未提供取消端点；请直接回答，或在提交时跳过该题"}
}

type sessionTime struct {
	Created int64 `json:"created"`
	Updated int64 `json:"updated"`
	// Idle 是该会话最后一次转为空闲的时刻。
	// POST /api/session/{id}/view 的 body 里 idle 必填，且必须是这个原值——
	// 它是服务端判定「viewer 已观察到这次 idle 转换」的对账凭据，
	// 填 0 或当前时间戳都会被判为无效。故必须随会话数据一起透给前端。
	Idle int64 `json:"idle,omitempty"`
}

// treeSession 会话列表项。
// v2 把 v1 的 directory 移到了 location.directory，故两者都声明，按需回退读取。
type treeSession struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	ProjectID string `json:"projectID"`
	Directory string `json:"directory"`
	Location  *struct {
		Directory string `json:"directory"`
	} `json:"location"`
	// ParentID 是 v2 引入的父子关系：子代理（subagent）会话指向其宿主会话。
	// v1 用 roots=true 让服务端只返回根会话；v2 改为 parentID=null 过滤，
	// 不加该参数时子会话会一并返回，必须在客户端剔除（见 IsRoot）。
	ParentID string      `json:"parentID"`
	Time     sessionTime `json:"time"`
}

// IsRoot 判断是否为根会话（无父会话）。
func (s treeSession) IsRoot() bool {
	return s.ParentID == ""
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

// fetchSessionList 查询会话列表。
//
// v1 是 ?directory=&roots=true，roots=true 表示「只要根会话」。
// v2 取消了 roots，改为 ?parentID=null（官方文档：Use null to return only root sessions）。
// 不加该参数时，子代理（subagent）会话会混在结果里——实测占比极高
// （本机 500 条会话里 444 条是子会话），若直接渲染会让会话树被子会话淹没。
//
// directory 为空串时**不拼 directory 参数**：实测 v2 在不传 directory 时返回全部根会话
// （本机 50 条、横跨 17 个目录，约 437ms），目录分组交给调用方在本地按 location.directory 完成。
// 不要依赖服务端的 directory= 过滤：它对路径格式敏感（会话里存的是 Windows 反斜杠，
// 用正斜杠查询会返回 0 条）；更不能用空 directory=（空路径会被按 CWD 解析）。
//
// 这里显式传 parentID=null 只取根会话，与 v1 的 roots=true 语义保持一致；
// 同时仍在客户端二次过滤，以防服务端忽略该参数。
func fetchSessionList(base, directory, password string, limit int) []treeSession {
	urlstr := fmt.Sprintf("%s/api/session?parentID=null&limit=%d", base, limit)
	if directory != "" {
		urlstr = fmt.Sprintf("%s/api/session?directory=%s&parentID=null&limit=%d",
			base, url.QueryEscape(directory), limit)
	}
	body, err := apiGet(urlstr, password)
	if err != nil {
		return nil
	}
	sessions, err := unmarshalSessionList(body)
	if err != nil {
		return nil
	}
	// 二次过滤：子会话（parentID 非空）不进会话树
	roots := sessions[:0]
	for _, s := range sessions {
		if s.IsRoot() {
			roots = append(roots, s)
		}
	}
	return roots
}

// GetProjectTree 获取「目录 → 会话」两层树形结构 JSON。
//
// 数据来源：GET /api/session?parentID=null&limit=1000（**不传 directory**）。
// 实测 v2 在不传 directory 时返回全部根会话（本机 50 条、横跨 17 个目录，约 437ms），
// 目录分组在本函数返回前由 buildTreeJSON 按 location.directory 在本地完成。
//
// 不再调用 /api/project：它的 location 中间件在不带 location 时以进程 CWD（共享服务的
// CWD 是 home）解析，会把 home 登记成一个多余项目；且 v2 的 projectID 是无含义哈希、
// 没有项目名字段，项目层对用户没有可展示的信息。
//
// knownDirs 参数为兼容既有绑定签名（app.go / app_dispatcher.go / 前端）而保留，
// v2 下 Go 侧已忽略它（会话目录从全量会话的 location.directory 自动发现）。
func GetProjectTree(knownDirs string) string {
	base, err := getWebSessionBase()
	if err != nil {
		return "[]"
	}
	password := ""
	if sess := getWebSession(); sess != nil {
		password = sess.password
	}

	sessions := fetchSessionList(base, "", password, 1000)
	return buildTreeJSON(sessions)
}

// buildTreeJSON 把根会话列表构建成「目录 → 会话」两层树 JSON。
//
// 顶层节点即目录：ID/Title 均为 location.directory 原值，Type 为 "directory"；
// 每个目录的子节点是会话：ID 为会话 id、Title 取 title（缺省回退 id）、
// Type 为 "session"、UpdatedAt 为 time.updated（缺省回退 time.created）的
// "2006-01-02 15:04" 格式、Directory 冗余一份目录路径供前端取用。
//
// 跳过条件：非根会话（子代理会话由侧栏的子任务面板单独呈现）、目录为空的会话。
// 输出顺序用「首次出现」保序切片固定，不能用 map 直接遍历——map 顺序随机，
// 会导致每次刷新树的位置跳动。
func buildTreeJSON(sessions []treeSession) string {
	dirMap := make(map[string]*model.TreeNode) // key: 目录路径，value: 该目录的两层树节点
	var dirOrder []string                      // 目录首次出现的顺序（保序输出用）

	for _, s := range sessions {
		// 子代理会话只在侧栏「子任务面板」呈现，不进会话树
		if !s.IsRoot() {
			continue
		}
		dir := s.Dir()
		if dir == "" {
			continue
		}

		node, ok := dirMap[dir]
		if !ok {
			node = &model.TreeNode{ID: dir, Title: dir, Type: "directory"}
			dirMap[dir] = node
			dirOrder = append(dirOrder, dir)
		}

		title := s.Title
		if title == "" {
			title = s.ID
		}

		// 取第一个可用的时间字段（updated 优先，其次 created）
		var updatedAt string
		if s.Time.Updated > 0 {
			updatedAt = time.UnixMilli(s.Time.Updated).Format("2006-01-02 15:04")
		} else if s.Time.Created > 0 {
			updatedAt = time.UnixMilli(s.Time.Created).Format("2006-01-02 15:04")
		}

		node.Children = append(node.Children, model.TreeNode{
			ID:        s.ID,
			Title:     title,
			Type:      "session",
			UpdatedAt: updatedAt,
			Directory: dir,
		})
	}

	// 按目录首次出现顺序输出，避免 map 随机序导致树的位置每次刷新都变
	tree := make([]model.TreeNode, 0, len(dirOrder))
	for _, dir := range dirOrder {
		tree = append(tree, *dirMap[dir])
	}

	data, _ := json.Marshal(tree)
	return string(data)
}
