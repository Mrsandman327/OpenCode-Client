// ext.go —— OpenCode v2 扩展能力端点
//
// 这里集中承载 v1 没有、v2 新增的一批端点。与 api.go 分开是因为两者性质不同：
// api.go 处理的是 v1→v2 的契约翻译，本文件处理的是「v2 才有」的能力。
//
// 全部端点契约均已对本机 opencode v2.0.15 实际探测确认，非照文档推断。
// 探测中确认的若干反直觉之处已在各处注明，勿凭直觉简化：
//
//  1. /api/session/{id}/view 的 body 里 idle **必填**，缺了返回
//     400 {"kind":"Payload","message":"Missing key [\"idle\"]"}。
//     它不是装饰字段，而是服务端判定「viewer 已观察到这次 idle 转换」的凭据。
//  2. /api/session/{id}/context **不返回 token 占用**。实测它返回的是
//     「最后一次压缩之后的全部消息」——首条即 compaction 类型消息。
//     token/cost 在 Session.Info.tokens / .cost 上。
//  3. /api/project 与 /api/worktree 返回**裸数组**（无 {data} 信封），
//     而 /api/integration、/api/vcs/branch、/api/pty 返回 {location, data}。
//     两种风格混用，逐个端点实测过，不要想当然统一拆封。
//  4. /api/worktree 用 **projectID**（项目哈希，如 32 位 hex）定位，
//     不是 location；projectID 也没有 prj_ 前缀。
//  5. /api/vcs/branch 的 data 是**扁平 string[]**（分支名），不是对象数组。
//  6. credential 的 PATCH 只能改 label；activate 声明「无 body」，
//     但实测空 body 与完全省略 body 均可（均返回 204），本实现按无 body 发。
//  7. 会话移动的 directory 目标是**项目目录**，不是目录树里的子路径。
package opencode

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"oc-manager/model"
)

// locationQuery 构造 deepObject 风格的 location 查询串。
//
// v2 的作用域参数是 style=deepObject, explode=true，必须编码成
// location[directory]=...；写成 location=... 会被服务端静默忽略，
// 于是拿到的是服务端默认 location 下的数据——不报错，只是答案不对。
func locationQuery(directory string) string {
	if directory == "" {
		return ""
	}
	return "?location%5Bdirectory%5D=" + url.QueryEscape(directory)
}

// locationRef 是 v2 响应里的 location 字段。
// 它是**对象**（{directory: "..."}），不是字符串——按 string 声明会导致
// 整个响应解析失败，且失败点离根因很远，故单列类型。
type locationRef struct {
	Directory string `json:"directory"`
	ProjectID string `json:"projectID,omitempty"`
	Subpath   string `json:"subpath,omitempty"`
}

// sessionScoped 取出 base + 口令，会话未启动时返回零值与错误。
func sessionScoped() (string, string, model.APIResult) {
	sess := getWebSession()
	if sess == nil {
		return "", "", model.APIResult{Error: "opencode 服务未启动"}
	}
	base, err := getWebSessionBase()
	if err != nil {
		return "", "", model.APIResult{Error: err.Error()}
	}
	return base, sess.password, model.APIResult{}
}

// ── 会话移动 ─────────────────────────────────────────────────────────────

// MoveSession 把会话移到另一个项目目录。
// delivery 决定目标目录已有待处理输入时新指令的投递方式：
// "steer" 插队、"queue" 排队；空字符串表示不指定（由服务端沿用默认）。
func MoveSession(sessionID, directory, delivery string) model.APIResult {
	if strings.TrimSpace(sessionID) == "" {
		return model.APIResult{Error: "缺少会话 ID"}
	}
	if strings.TrimSpace(directory) == "" {
		return model.APIResult{Error: "缺少目标目录"}
	}
	base, password, fail := sessionScoped()
	if fail.Error != "" {
		return fail
	}

	payload := map[string]any{"directory": directory}
	if delivery == "steer" || delivery == "queue" {
		payload["delivery"] = delivery
	}
	body, _ := json.Marshal(payload)
	return apiPost(base+"/api/session/"+url.QueryEscape(sessionID)+"/move", password, body)
}

// ── 标记已读 ─────────────────────────────────────────────────────────────

// MarkSessionViewed 标记「idle 转换已被客户端观察到」。
// idle 必须取会话当前的 Session.Info.time.idle 原值——它是服务端的对账凭据，
// 填 0 或当前时间戳都不对。返回值变化会触发 service 端的 session.viewed 事件。
func MarkSessionViewed(sessionID string, idle int64) model.APIResult {
	if strings.TrimSpace(sessionID) == "" {
		return model.APIResult{Error: "缺少会话 ID"}
	}
	if idle <= 0 {
		return model.APIResult{Error: "idle 必须为会话 time.idle 的原值，不能为 0"}
	}
	base, password, fail := sessionScoped()
	if fail.Error != "" {
		return fail
	}
	body, _ := json.Marshal(map[string]any{"idle": idle})
	return apiPost(base+"/api/session/"+url.QueryEscape(sessionID)+"/view", password, body)
}

// ── 活跃上下文 ───────────────────────────────────────────────────────────

// GetSessionContext 取回该会话「最后一次压缩之后的全部消息」。
//
// 命名容易误解：这**不是** token 占用。token/cost 在 Session.Info.tokens / .cost，
// 那两个字段是必填的，读取会话时顺带就能拿到，不需要额外请求。
// 响应为 {data: [消息]}，这里原样返回 JSON 交给前端处理。
func GetSessionContext(sessionID string) string {
	base, password, fail := sessionScoped()
	if fail.Error != "" {
		return failureJSON(fail.Error)
	}
	raw, err := apiGet(base+"/api/session/"+url.QueryEscape(sessionID)+"/context", password)
	if err != nil {
		return failureJSON(err.Error())
	}
	var payload struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return failureJSON("解析上下文失败: " + err.Error())
	}

	// 只回摘要所需字段，避免把整段对话搬进前端内存
	type brief struct {
		ID      string  `json:"id"`
		Type    string  `json:"type"`
		Created int64   `json:"created"`
		Text    string  `json:"text,omitempty"`
		Tokens  int64   `json:"tokens,omitempty"`
		Cost    float64 `json:"cost,omitempty"`
		Finish  string  `json:"finish,omitempty"`
		Error   string  `json:"error,omitempty"`
	}
	briefs := make([]brief, 0, len(payload.Data))
	for _, msg := range payload.Data {
		b := brief{ID: asString(msg["id"]), Type: asString(msg["type"])}
		if t, ok := msg["time"].(map[string]any); ok {
			b.Created = asInt64(t["created"])
		}
		if s, ok := msg["text"].(string); ok {
			b.Text = s
		}
		if c, ok := msg["content"].([]any); ok {
			for _, item := range c {
				im, ok := item.(map[string]any)
				if !ok {
					continue
				}
				switch im["type"] {
				case "text":
					if s, ok := im["text"].(string); ok && b.Text == "" {
						b.Text = s
					}
				case "reasoning":
					if s, ok := im["text"].(string); ok && b.Text == "" {
						b.Text = s
					}
				}
			}
		}
		b.Tokens = asInt64(msg["tokens"])
		b.Cost = asFloat64(msg["cost"])
		if f, ok := msg["finish"].(string); ok {
			b.Finish = f
		}
		if e, ok := msg["error"].(map[string]any); ok {
			b.Error = asString(e["name"])
			if b.Error == "" {
				b.Error = asString(e["message"])
			}
		}
		briefs = append(briefs, b)
	}

	out, _ := json.Marshal(map[string]any{"messages": briefs})
	return string(out)
}

// ── 导出 / 导入 ──────────────────────────────────────────────────────────

// ExportSession 导出会话（信息 + 全部消息），返回原始 JSON 字符串。
// sanitize 为 true 时服务端会抹掉可识别信息后再导出。
//
// 端点位于 /api/experimental 下，服务端自己标注为实验性，路径将来可能变。
func ExportSession(sessionID string, sanitize bool) string {
	if strings.TrimSpace(sessionID) == "" {
		return failureJSON("缺少会话 ID")
	}
	base, password, fail := sessionScoped()
	if fail.Error != "" {
		return failureJSON(fail.Error)
	}
	target := base + "/api/experimental/session/" + url.QueryEscape(sessionID) + "/export"
	if sanitize {
		target += "?sanitize=true"
	}
	raw, err := apiGet(target, password)
	if err != nil {
		return failureJSON(err.Error())
	}
	// 原样透出：导出内容要能被 import 原样吃回去，任何再包装都会破坏往返
	return string(raw)
}

// ImportSession 从导出的 JSON 导入会话，返回新会话对象。
//
// 两条必须遵守的约束（服务端会以 409 Conflict 拒绝）：
//  1. 若导出数据里的 info 带 parentID，父会话必须已存在于目标服务——
//     所以批量导入必须先导父再导子。
//  2. location 走请求体，不接受查询参数。
func ImportSession(exportJSON string) model.APIResult {
	trimmed := strings.TrimSpace(exportJSON)
	if trimmed == "" {
		return model.APIResult{Error: "导入内容为空"}
	}
	// 先本地校验结构，避免把明显不是导出数据的东西发给服务端
	var probe struct {
		Info     *map[string]any   `json:"info"`
		Messages *[]map[string]any `json:"messages"`
	}
	if err := json.Unmarshal([]byte(trimmed), &probe); err != nil {
		return model.APIResult{Error: "导入内容不是合法 JSON: " + err.Error()}
	}
	if probe.Info == nil || probe.Messages == nil {
		return model.APIResult{Error: "导入内容缺少 info 或 messages 字段，不是会话导出格式"}
	}
	if parent := asString((*probe.Info)["parentID"]); parent != "" {
		return model.APIResult{Error: fmt.Sprintf(
			"该会话是子会话（parentID=%s），需先导入父会话，否则服务端返回 409", parent)}
	}

	base, password, fail := sessionScoped()
	if fail.Error != "" {
		return fail
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return model.APIResult{Error: "解析导入内容失败: " + err.Error()}
	}
	body, _ := json.Marshal(payload)
	return apiPost(base+"/api/experimental/session/import", password, body)
}

// ── 集成与凭据 ───────────────────────────────────────────────────────────

// IntegrationInfo 是 /api/integration 返回的单条集成。
type IntegrationInfo struct {
	ID          string           `json:"id"`
	Name        string           `json:"name"`
	Methods     []map[string]any `json:"methods"`
	Connections []map[string]any `json:"connections"`
}

// ListIntegrations 列出某目录下可见的集成与其当前连接。
//
// 注意：v2 约有两百个集成条目，绝大多数 connections 为空——把全量丢给前端
// 既臃肿又无用。这里只保留「已配置凭据」的集成（connections 非空），
// 因为「有哪些可切换的凭据」才是这个面板要回答的问题。
// 完全未配置的集成可通过开关放开（includeEmpty）。
func ListIntegrations(directory string, includeEmpty bool) string {
	base, password, fail := sessionScoped()
	if fail.Error != "" {
		return failureJSON(fail.Error)
	}
	raw, err := apiGet(base+"/api/integration"+locationQuery(directory), password)
	if err != nil {
		return failureJSON(err.Error())
	}
	var payload struct {
		Location locationRef       `json:"location"`
		Data     []IntegrationInfo `json:"data"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return failureJSON("解析集成列表失败: " + err.Error())
	}

	kept := make([]IntegrationInfo, 0, len(payload.Data))
	total := len(payload.Data)
	for _, item := range payload.Data {
		if item.Connections == nil {
			item.Connections = []map[string]any{}
		}
		if !includeEmpty && len(item.Connections) == 0 {
			continue
		}
		kept = append(kept, item)
	}
	out, _ := json.Marshal(map[string]any{
		"integrations": kept,
		"total":        total,
		"shown":        len(kept),
		"filtered":     !includeEmpty,
	})
	return string(out)
}

// ActivateCredential 切换当前生效的凭据。
//
// 约定：connections[0] 即当前生效的连接。activate 无请求体（实测省略与空 body 均可）。
func ActivateCredential(credentialID string) model.APIResult {
	if strings.TrimSpace(credentialID) == "" {
		return model.APIResult{Error: "缺少凭据 ID"}
	}
	base, password, fail := sessionScoped()
	if fail.Error != "" {
		return fail
	}
	// 该端点声明无请求体。走通用 OpenCodeAPI 会自动补 {}（为的是 POST /api/session
	// 那类必须有对象的端点），这里显式发无 body 请求以贴合契约。
	return apiPostNoBody(base+"/api/credential/"+url.QueryEscape(credentialID)+"/activate", password)
}

// RenameCredential 修改凭据的显示名。
// v2 的凭据 PATCH 只能改 label，无法改动凭据内容——换 key 请在 opencode 侧操作。
func RenameCredential(credentialID, label string) model.APIResult {
	if strings.TrimSpace(credentialID) == "" {
		return model.APIResult{Error: "缺少凭据 ID"}
	}
	if strings.TrimSpace(label) == "" {
		return model.APIResult{Error: "凭据名称不能为空"}
	}
	base, password, fail := sessionScoped()
	if fail.Error != "" {
		return fail
	}
	body, _ := json.Marshal(map[string]any{"label": label})
	return apiPatch(base+"/api/credential/"+url.QueryEscape(credentialID), password, body)
}

// ── 工作树 ───────────────────────────────────────────────────────────────

// WorktreeInfo 是 /api/worktree 返回的单条工作树。
type WorktreeInfo struct {
	Directory string `json:"directory"`
	Strategy  string `json:"strategy,omitempty"`
}

// ListWorktrees 列出项目的所有工作树。
// 端点以 projectID（32 位 hex）定位，且返回**裸数组**（无 {data} 信封）。
func ListWorktrees(projectID string) string {
	if strings.TrimSpace(projectID) == "" {
		return failureJSON("缺少 projectID")
	}
	base, password, fail := sessionScoped()
	if fail.Error != "" {
		return failureJSON(fail.Error)
	}
	raw, err := apiGet(base+"/api/worktree?projectID="+url.QueryEscape(projectID), password)
	if err != nil {
		return failureJSON(err.Error())
	}
	// 裸数组：不要再套 {data:...}
	var list []WorktreeInfo
	if err := json.Unmarshal(raw, &list); err != nil {
		return failureJSON("解析工作树列表失败: " + err.Error())
	}
	out, _ := json.Marshal(map[string]any{"worktrees": list, "count": len(list)})
	return string(out)
}

// ── 分支 ─────────────────────────────────────────────────────────────────

// ListBranches 列出本地与远端分支名。
// v2 返回的是**扁平字符串数组**（含 origin/xxx 等远端分支），不是对象数组。
func ListBranches(directory, search string, limit int) string {
	base, password, fail := sessionScoped()
	if fail.Error != "" {
		return failureJSON(fail.Error)
	}
	query := locationQuery(directory)
	extra := []string{}
	if search != "" {
		extra = append(extra, "search="+url.QueryEscape(search))
	}
	if limit > 0 {
		extra = append(extra, "limit="+strconv.Itoa(limit))
	}
	if len(extra) > 0 {
		if query == "" {
			query = "?" + strings.Join(extra, "&")
		} else {
			query += "&" + strings.Join(extra, "&")
		}
	}
	raw, err := apiGet(base+"/api/vcs/branch"+query, password)
	if err != nil {
		return failureJSON(err.Error())
	}
	var payload struct {
		Location locationRef `json:"location"`
		Data     []string    `json:"data"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return failureJSON("解析分支列表失败: " + err.Error())
	}
	if payload.Data == nil {
		payload.Data = []string{}
	}
	out, _ := json.Marshal(map[string]any{
		"branches": payload.Data,
		"count":    len(payload.Data),
		"location": payload.Location.Directory,
	})
	return string(out)
}

// ── 持久终端 ─────────────────────────────────────────────────────────────

// PtyInfo 是 /api/pty 返回的单条终端。
type PtyInfo struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Command  string   `json:"command"`
	Args     []string `json:"args"`
	Cwd      string   `json:"cwd"`
	Status   string   `json:"status"`
	PID      int      `json:"pid"`
	ExitCode *int     `json:"exitCode,omitempty"`
}

// ListPtys 列出某目录下已存在的持久终端。
func ListPtys(directory string) string {
	base, password, fail := sessionScoped()
	if fail.Error != "" {
		return failureJSON(fail.Error)
	}
	raw, err := apiGet(base+"/api/pty"+locationQuery(directory), password)
	if err != nil {
		return failureJSON(err.Error())
	}
	var payload struct {
		Location locationRef `json:"location"`
		Data     []PtyInfo   `json:"data"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return failureJSON("解析终端列表失败: " + err.Error())
	}
	if payload.Data == nil {
		payload.Data = []PtyInfo{}
	}
	out, _ := json.Marshal(map[string]any{"ptys": payload.Data, "count": len(payload.Data)})
	return string(out)
}

// ── 小工具 ───────────────────────────────────────────────────────────────

// apiPostNoBody 发起不带请求体的 POST。
//
// 与 apiPost 的区别：apiPost 一定会写出 body。对声明「无请求体」的端点
// （如 credential/activate）多送一个 body 属于不贴合契约，虽然实测当前
// 服务端能容忍，但不应依赖这种容忍——服务端补上校验就会变成 400。
func apiPostNoBody(urlstr, password string) model.APIResult {
	req, err := http.NewRequest(http.MethodPost, urlstr, nil)
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}
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

// apiPatch 发起带 JSON 请求体的 PATCH（v2 的凭据改名用它）。
func apiPatch(urlstr, password string, payload []byte) model.APIResult {
	req, err := http.NewRequest(http.MethodPatch, urlstr, strings.NewReader(string(payload)))
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

// failureJSON 统一的失败响应，保证前端拿到的永远是可解析的 JSON。
func failureJSON(msg string) string {
	out, _ := json.Marshal(map[string]any{"error": msg})
	return string(out)
}

func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func asInt64(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	}
	return 0
}

func asFloat64(v any) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return 0
}
