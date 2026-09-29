// opencode_real.go —— OpenCode 接口的真实实现
//
// 走 service/opencode 已有的 OpenCodeAPI 通用出口，不重复实现 HTTP、
// 认证与错误体解析——那些 service/opencode 已经处理过
// （含非 2xx 转 error 的 describeV2Error）。
//
// ⚠️ 本文件的 body 字段名、query 参数名、响应解包方式全部取自本机
// v2.0.15 的 /openapi.json 与真机响应实测，不是推测。
//
// 四处反直觉契约（照抄会静默失败，详见各处注释）：
//  1. **单对象也是 {data: {...}} 包裹**。POST /api/session 与 /fork 都返回
//     {data: Session.Info}，不是裸 Session.Info。按顶层读 id 会永远拿到空串。
//  2. **tokens.cache 是嵌套对象**（{read,write}），不是扁平的 cacheRead/cacheWrite。
//     扁平 tag 不会报错，只是恒为 0——用量卡上缓存读/写永远不显示。
//  3. **时间是 time.{created,updated,idle}** 嵌套，不是顶层 updated。
//  4. **Model.Ref 必填 {id, providerID}**，字段名是 id 而非 modelID。
package feishu

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"oc-manager/service/opencode"
)

// RealOpenCode 是基于 service/opencode 的实现。
type RealOpenCode struct{}

// NewRealOpenCode 建真实实现。
func NewRealOpenCode() *RealOpenCode { return &RealOpenCode{} }

// call 发一次请求并把失败转成 error。
func call(method, path, body string) (string, error) {
	res := opencode.OpenCodeAPI(method, path, body)
	if res.Error != "" {
		return "", fmt.Errorf("%s %s: %s", method, path, res.Error)
	}
	if !res.Success {
		// Body 里是 V2 的 {message} 错误体；直接抛原文比包装更有用
		return "", fmt.Errorf("%s %s: 状态 %d %s", method, path, res.Status, summarizeErrBody(res.Body))
	}
	return res.Body, nil
}

// summarizeErrBody 把错误体压成一行，避免日志里出现整段 JSON。
func summarizeErrBody(body string) string {
	body = strings.TrimSpace(body)
	if body == "" {
		return "(空响应)"
	}
	var out struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal([]byte(body), &out); err == nil && out.Message != "" {
		return out.Message
	}
	r := []rune(body)
	if len(r) > 200 {
		return string(r[:200]) + "…"
	}
	return body
}

// ── 响应解包 ──

// unwrapData 剥掉 {data: ...} 包裹，把内层原样交给 out。
//
// V2 的这批端点**一律**用 {data:...} 包裹：列表是 {data:[...]},
// 单对象是 {data:{...}}。不同端点之间并不统一（/api/project、/api/worktree
// 返裸数组），因此这里兼容两种形态而不是假设其一——
// 假设错了的表现是「静默返回空」，最难查。
func unwrapData(raw string, out any) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return fmt.Errorf("响应为空")
	}
	if strings.HasPrefix(trimmed, "{") {
		var wrapper struct {
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal([]byte(trimmed), &wrapper); err == nil && len(wrapper.Data) > 0 {
			return json.Unmarshal(wrapper.Data, out)
		}
	}
	return json.Unmarshal([]byte(trimmed), out)
}

// ── 会话 ──

// CreateSession 新建会话。
//
// POST /api/session 的 location 是 deepObject 形态（实测契约），
// 与 query 参数那种 location[directory]= 写法不同。
func (r *RealOpenCode) CreateSession(directory, model string) (string, error) {
	body := map[string]any{}
	if directory != "" {
		body["location"] = map[string]any{"directory": directory}
	}
	if model != "" {
		body["model"] = ModelRef(model)
	}

	raw, err := call("POST", "/api/session", mustJSON(body))
	if err != nil {
		return "", err
	}
	var info sessionInfo
	if err := unwrapData(raw, &info); err != nil {
		return "", fmt.Errorf("解析新建会话响应失败: %w", err)
	}
	if info.ID == "" {
		return "", fmt.Errorf("新建会话未返回 ID: %s", summarizeErrBody(raw))
	}
	return info.ID, nil
}

// sessionInfo 是 V2 的 Session.Info 形状（只取本层用得到的字段）。
type sessionInfo struct {
	ID       string     `json:"id"`
	ParentID string     `json:"parentID"`
	Title    string     `json:"title"`
	Cost     float64    `json:"cost"`
	Tokens   tokenUsage `json:"tokens"`
	Time     timeInfo   `json:"time"`
	Location struct {
		Directory string `json:"directory"`
	} `json:"location"`
	Model struct {
		ID         string `json:"id"`
		ProviderID string `json:"providerID"`
		Variant    string `json:"variant"`
	} `json:"model"`
}

// tokenUsage 是 TokenUsage.Info 形状。
//
// ⚠️ cache 是**嵌套**对象 {read, write}。写成扁平的 cacheRead/cacheWrite
// 不会报错，只是恒为 0。
type tokenUsage struct {
	Input     int64 `json:"input"`
	Output    int64 `json:"output"`
	Reasoning int64 `json:"reasoning"`
	Cache     struct {
		Read  int64 `json:"read"`
		Write int64 `json:"write"`
	} `json:"cache"`
}

// timeInfo 是 Session.Info.time 形状：时间戳在**嵌套**对象里。
type timeInfo struct {
	Created int64 `json:"created"`
	Updated int64 `json:"updated"`
	Idle    int64 `json:"idle"`
	Viewed  int64 `json:"viewed"`
}

// ModelRef 把 "provider/model" 拆成 V2 的 Model.Ref。
//
// ⚠️ spec 实测：Model.Ref 必填字段是 **id + providerID**，
// 字段名是 `id` 而不是 `modelID`——写 modelID 会被 400 拒绝。
//
// 拆不开时按无 provider 处理：仍给 id，交给 V2 在模型解析阶段报错，
// 那时的错误信息比这里瞎猜 provider 更有价值。
func ModelRef(model string) map[string]any {
	if i := strings.Index(model, "/"); i > 0 && i < len(model)-1 {
		return map[string]any{
			"providerID": model[:i],
			"id":         model[i+1:],
		}
	}
	return map[string]any{"id": model}
}

// SendPrompt 发送用户消息。text 在 V2 侧是**必填**。
func (r *RealOpenCode) SendPrompt(sessionID, text, delivery string) error {
	if strings.TrimSpace(sessionID) == "" {
		return fmt.Errorf("缺少会话 ID")
	}
	if strings.TrimSpace(text) == "" {
		return fmt.Errorf("消息内容为空")
	}
	body := map[string]any{"text": text}
	if delivery != "" {
		body["delivery"] = delivery
	}
	_, err := call("POST", sessPath(sessionID)+"/prompt", mustJSON(body))
	return err
}

// ListSessions 列出会话。
//
// 实测：带 parentID 时只返回该父会话的子会话；不带则返回全部
// （子会话与主会话混在同一目录，实测最近 50 条里 39 条是子会话）。
// directory 走 deepObject query 写法。
func (r *RealOpenCode) ListSessions(directory, parentID string, limit int) ([]SessionSummary, error) {
	q := url.Values{}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	if parentID != "" {
		q.Set("parentID", parentID)
	}
	if directory != "" {
		q.Set("location[directory]", directory)
	}
	path := "/api/session"
	if len(q) > 0 {
		path += "?" + q.Encode()
	}

	raw, err := call("GET", path, "")
	if err != nil {
		return nil, err
	}
	var list []sessionInfo
	if err := unwrapData(raw, &list); err != nil {
		return nil, fmt.Errorf("解析会话列表失败: %w", err)
	}
	out := make([]SessionSummary, 0, len(list))
	for _, s := range list {
		out = append(out, SessionSummary{
			ID:       s.ID,
			Title:    s.Title,
			ParentID: s.ParentID,
			// 时间在嵌套 time 里；取不到就留 0，由调用方决定怎么显示
			Updated: s.Time.Updated,
			// idle 可能为 0（从未空闲过），HasIdle 区分「未知」与「忙碌」
			IsIdle:  s.Time.Idle > 0,
			HasIdle: s.Time.Idle > 0,
		})
	}
	return out, nil
}

func (r *RealOpenCode) Interrupt(sessionID string) error {
	if sessionID == "" {
		return fmt.Errorf("缺少会话 ID")
	}
	_, err := call("POST", sessPath(sessionID)+"/interrupt", "")
	return err
}

// RenameSession 重命名。V2 用 PATCH，不是 POST。
func (r *RealOpenCode) RenameSession(sessionID, title string) error {
	if sessionID == "" {
		return fmt.Errorf("缺少会话 ID")
	}
	if strings.TrimSpace(title) == "" {
		return fmt.Errorf("新名称为空")
	}
	body := map[string]any{"title": title}
	_, err := call("PATCH", sessPath(sessionID), mustJSON(body))
	return err
}

func (r *RealOpenCode) CompactSession(sessionID string) error {
	if sessionID == "" {
		return fmt.Errorf("缺少会话 ID")
	}
	// 实测：compact 的 body 可为空，也接受 {id, delivery}
	_, err := call("POST", sessPath(sessionID)+"/compact", "{}")
	return err
}

// DeleteSession 删除会话。
func (r *RealOpenCode) DeleteSession(sessionID string) error {
	if sessionID == "" {
		return fmt.Errorf("缺少会话 ID")
	}
	_, err := call("DELETE", sessPath(sessionID), "")
	return err
}

// ForkSession 分叉会话。before 为空表示从头分叉。
func (r *RealOpenCode) ForkSession(sessionID, before string) (string, error) {
	if sessionID == "" {
		return "", fmt.Errorf("缺少会话 ID")
	}
	body := map[string]any{}
	if before != "" {
		body["before"] = before
	}
	raw, err := call("POST", sessPath(sessionID)+"/fork", mustJSON(body))
	if err != nil {
		return "", err
	}
	// 单对象也是 {data:...} 包裹
	var info sessionInfo
	if err := unwrapData(raw, &info); err != nil {
		return "", fmt.Errorf("解析分叉响应失败: %w", err)
	}
	if info.ID == "" {
		return "", fmt.Errorf("分叉未返回新会话 ID: %s", summarizeErrBody(raw))
	}
	return info.ID, nil
}

// SetModel 切换模型。model 在 V2 侧**必填**，且形如 Model.Ref。
func (r *RealOpenCode) SetModel(sessionID, model string) error {
	if sessionID == "" {
		return fmt.Errorf("缺少会话 ID")
	}
	if model == "" {
		return fmt.Errorf("缺少模型名")
	}
	body := map[string]any{"model": ModelRef(model)}
	_, err := call("POST", sessPath(sessionID)+"/model", mustJSON(body))
	return err
}

// ── 权限 ──

// ListPermissions 列出待审批的权限请求。
func (r *RealOpenCode) ListPermissions(sessionID string) ([]PermissionRequest, error) {
	if sessionID == "" {
		return nil, fmt.Errorf("缺少会话 ID")
	}
	raw, err := call("GET", sessPath(sessionID)+"/permission", "")
	if err != nil {
		return nil, err
	}
	var list []permissionRequest
	if err := unwrapData(raw, &list); err != nil {
		return nil, fmt.Errorf("解析权限请求失败: %w", err)
	}
	out := make([]PermissionRequest, 0, len(list))
	for _, p := range list {
		out = append(out, PermissionRequest{
			ID:        p.ID,
			Action:    p.Action,
			Resources: p.Resources,
			// V2 叫 message，不叫 title
			Message: p.Message,
			Save:    p.Save,
		})
	}
	return out, nil
}

// permissionRequest 是 V2 的 Permission.Request 形状。
//
// spec 实测必填 id/sessionID/action/resources；可选 save/metadata/
// source/message。**没有 title 字段**——按 title 读会恒为空。
type permissionRequest struct {
	ID        string   `json:"id"`
	SessionID string   `json:"sessionID"`
	Action    string   `json:"action"`
	Resources []string `json:"resources"`
	Save      []string `json:"save"`
	Message   string   `json:"message"`
}

// ReplyPermission 回复权限请求。decision 在 V2 侧**必填**。
func (r *RealOpenCode) ReplyPermission(sessionID, requestID, decision string) error {
	if sessionID == "" {
		return fmt.Errorf("缺少会话 ID")
	}
	if requestID == "" {
		return fmt.Errorf("缺少请求 ID")
	}
	if decision == "" {
		return fmt.Errorf("缺少决策")
	}
	body := map[string]any{"decision": decision}
	path := sessPath(sessionID) + "/permission/" + url.PathEscape(requestID) + "/reply"
	_, err := call("POST", path, mustJSON(body))
	return err
}

// ── 只读查询 ──

// SessionUsage 取用量。
//
// 实测：**/context 端点不返回 token 占用**，token 在 Session.Info 的
// tokens 字段里。因此这里从会话对象读，而不是调 /context。
func (r *RealOpenCode) SessionUsage(sessionID string) (Usage, error) {
	if sessionID == "" {
		return Usage{}, fmt.Errorf("缺少会话 ID")
	}
	raw, err := call("GET", sessPath(sessionID), "")
	if err != nil {
		return Usage{}, err
	}
	var info sessionInfo
	if err := unwrapData(raw, &info); err != nil {
		return Usage{}, fmt.Errorf("解析用量失败: %w", err)
	}
	return Usage{
		Cost: info.Cost,
		Tokens: TokenUsage{
			Input:      info.Tokens.Input,
			Output:     info.Tokens.Output,
			Reasoning:  info.Tokens.Reasoning,
			CacheRead:  info.Tokens.Cache.Read,
			CacheWrite: info.Tokens.Cache.Write,
		},
	}, nil
}

// SessionDiff 取代码改动统计。
func (r *RealOpenCode) SessionDiff(sessionID string) ([]FileDiffStat, error) {
	if sessionID == "" {
		return nil, fmt.Errorf("缺少会话 ID")
	}
	raw, err := call("GET", sessPath(sessionID)+"/diff", "")
	if err != nil {
		return nil, err
	}
	var list []fileDiffInfo
	if err := unwrapData(raw, &list); err != nil {
		return nil, fmt.Errorf("解析改动失败: %w", err)
	}
	out := make([]FileDiffStat, 0, len(list))
	for _, f := range list {
		out = append(out, FileDiffStat{
			File:      f.File,
			Status:    f.Status,
			Additions: f.Additions,
			Deletions: f.Deletions,
		})
	}
	return out, nil
}

// fileDiffInfo 是 V2 的 FileDiff.Info 形状。
//
// spec 实测 status 枚举只有三个值：added / deleted / modified。
// （diffStatusIcon 里另认的新增/重命名等值是宽容处理，不影响正确性。）
type fileDiffInfo struct {
	File      string `json:"file"`
	Patch     string `json:"patch"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Status    string `json:"status"`
}

// sessPath 构造会话相关路径。转义 ID 防止注入到 URL 段。
func sessPath(sessionID string) string {
	return "/api/session/" + url.PathEscape(sessionID)
}

// mustJSON 序列化 body；出错时返回 "{}"——
// map[string]any 里装的都是 JSON 原生类型，实际不会失败。
func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}

// 确保 RealOpenCode 满足接口。编译期检查。
var _ OpenCode = (*RealOpenCode)(nil)
