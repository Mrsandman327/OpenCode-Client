package opencode

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// ============ 测试脚手架 ============

// captured 记录一次收到的请求，供断言路径、查询串与请求体。
type captured struct {
	Method string
	Path   string
	RawURL string
	Query  url.Values
	Body   string
	Auth   string
}

// testServer 起一个假 v2 服务，把收到的请求记下来，
// 并把 WebSess 指向它，使 ext.go 里的函数可以脱离真实 opencode 运行。
type testServer struct {
	*httptest.Server
	mu       sync.Mutex
	requests []captured
	// responder 按请求返回响应；为 nil 时统一返回 204
	responder func(c captured) (int, string)
}

func newTestServer(t *testing.T, responder func(c captured) (int, string)) *testServer {
	t.Helper()
	ts := &testServer{responder: responder}
	ts.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		c := captured{
			Method: r.Method,
			Path:   r.URL.Path,
			RawURL: r.URL.RawQuery,
			Query:  r.URL.Query(),
			Body:   string(body),
			Auth:   r.Header.Get("Authorization"),
		}
		ts.mu.Lock()
		ts.requests = append(ts.requests, c)
		ts.mu.Unlock()

		status, payload := http.StatusNoContent, ""
		if ts.responder != nil {
			status, payload = ts.responder(c)
		}
		if payload != "" {
			w.Header().Set("Content-Type", "application/json")
		}
		w.WriteHeader(status)
		if payload != "" {
			_, _ = w.Write([]byte(payload))
		}
	}))
	t.Cleanup(ts.Server.Close)

	// 把 WebSess 指向测试服务
	host, portStr, err := net.SplitHostPort(strings.TrimPrefix(ts.Server.URL, "http://"))
	if err != nil {
		t.Fatalf("解析测试服务地址失败: %v", err)
	}
	port := 0
	for _, ch := range portStr {
		if ch < '0' || ch > '9' {
			t.Fatalf("非预期端口: %q", portStr)
		}
		port = port*10 + int(ch-'0')
	}
	WebSessMu.Lock()
	prev := WebSess
	WebSess = &webSession{hostname: host, port: port, password: "test-pw"}
	WebSessMu.Unlock()
	t.Cleanup(func() {
		WebSessMu.Lock()
		WebSess = prev
		WebSessMu.Unlock()
	})
	return ts
}

func (ts *testServer) last() captured {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	if len(ts.requests) == 0 {
		return captured{}
	}
	return ts.requests[len(ts.requests)-1]
}

func (ts *testServer) count() int {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	return len(ts.requests)
}

// decodeError 取失败响应里的 error 字段
func decodeError(t *testing.T, raw string) string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("响应不是合法 JSON: %v (%s)", err, raw)
	}
	return asString(m["error"])
}

// ============ location deepObject 编码 ============

// TestLocationQuery 覆盖最容易静默出错的一处：location 是 deepObject 参数。
// 写成 location=xxx 不会被服务端拒绝，只会被忽略，于是拿到的是默认
// location 下的数据——不报错，答案却是错的，比直接失败更难发现。
func TestLocationQuery(t *testing.T) {
	if got := locationQuery(`E:\work\bmall`); got != "?location%5Bdirectory%5D=E%3A%5Cwork%5Cbmall" {
		t.Errorf("locationQuery 编码错误: %s", got)
	}
	if got := locationQuery(""); got != "" {
		t.Errorf("空目录应返回空串，实际 %q", got)
	}
	// 反解验证语义：解出来必须是 location[directory]
	q, err := url.ParseQuery(strings.TrimPrefix(locationQuery("E:\\x"), "?"))
	if err != nil {
		t.Fatalf("反解失败: %v", err)
	}
	if got := q.Get("location[directory]"); got != `E:\x` {
		t.Errorf("期望键 location[directory] 值为 %q，实际 %q", `E:\x`, got)
	}
	if _, ok := q["location"]; ok {
		t.Error("不应产生非 deepObject 的 location 键")
	}
}

// ============ 会话移动 ============

func TestMoveSession(t *testing.T) {
	ts := newTestServer(t, nil)
	res := MoveSession("ses_1", `E:\work\other`, "")
	if !res.Success {
		t.Fatalf("期望成功，实际 %+v", res)
	}
	c := ts.last()
	if c.Method != http.MethodPost {
		t.Errorf("方法 = %s，期望 POST", c.Method)
	}
	if c.Path != "/api/session/ses_1/move" {
		t.Errorf("路径 = %s", c.Path)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(c.Body), &body); err != nil {
		t.Fatalf("请求体不是 JSON: %v (%s)", err, c.Body)
	}
	if body["directory"] != `E:\work\other` {
		t.Errorf("directory = %v", body["directory"])
	}
	if _, has := body["delivery"]; has {
		t.Error("空 delivery 不应出现在请求体中")
	}
}

func TestMoveSessionDelivery(t *testing.T) {
	for _, d := range []string{"steer", "queue"} {
		ts := newTestServer(t, nil)
		MoveSession("ses_1", "/dir", d)
		var body map[string]any
		_ = json.Unmarshal([]byte(ts.last().Body), &body)
		if body["delivery"] != d {
			t.Errorf("delivery = %v，期望 %q", body["delivery"], d)
		}
	}
	// 非法值应被忽略而不是透传（服务端只认 steer/queue）
	ts := newTestServer(t, nil)
	MoveSession("ses_1", "/dir", "bogus")
	var body map[string]any
	_ = json.Unmarshal([]byte(ts.last().Body), &body)
	if _, has := body["delivery"]; has {
		t.Error("非法 delivery 不应透传给服务端")
	}
}

func TestMoveSession参数校验(t *testing.T) {
	ts := newTestServer(t, nil)
	if MoveSession("", "/dir", "").Error == "" {
		t.Error("缺会话 ID 应报错")
	}
	if MoveSession("ses_1", "  ", "").Error == "" {
		t.Error("空白目录应报错")
	}
	if ts.count() != 0 {
		t.Errorf("参数不合法时不应发起请求，实际发了 %d 次", ts.count())
	}
}

// ============ 标记已读 ============

// TestMarkSessionViewed 覆盖 idle 必填这一实测约束：
// 缺 idle 服务端返回 400 Missing key ["idle"]。
func TestMarkSessionViewed(t *testing.T) {
	ts := newTestServer(t, nil)
	res := MarkSessionViewed("ses_1", 1790605979558)
	if !res.Success {
		t.Fatalf("期望成功，实际 %+v", res)
	}
	c := ts.last()
	if c.Path != "/api/session/ses_1/view" {
		t.Errorf("路径 = %s", c.Path)
	}
	var body map[string]any
	_ = json.Unmarshal([]byte(c.Body), &body)
	// idle 是数字，JSON 里可能是 float64
	if got, ok := body["idle"].(float64); !ok || int64(got) != 1790605979558 {
		t.Errorf("idle = %v，期望原值 1790605979558", body["idle"])
	}
}

func TestMarkSessionViewed拒绝无效Idle(t *testing.T) {
	ts := newTestServer(t, nil)
	// idle=0 会被服务端当作无效对账凭据，本地先拦下
	if MarkSessionViewed("ses_1", 0).Error == "" {
		t.Error("idle=0 应报错")
	}
	if MarkSessionViewed("ses_1", -5).Error == "" {
		t.Error("负数 idle 应报错")
	}
	if ts.count() != 0 {
		t.Errorf("idle 非法时不应发起请求，实际 %d 次", ts.count())
	}
}

// ============ 活跃上下文 ============

// TestGetSessionContext 覆盖实测确认的关键点：
// context 返回的是「上次压缩之后的全部消息」，首条即 compaction 类型，
// 绝不是 token 占用。这里验证类型与摘要字段被正确提取。
func TestGetSessionContext(t *testing.T) {
	ts := newTestServer(t, func(c captured) (int, string) {
		return http.StatusOK, `{"data":[
			{"type":"compaction","id":"msg_c","time":{"created":1000},"status":"completed","reason":"auto"},
			{"type":"user","id":"msg_u","time":{"created":2000},"text":"做件事"},
			{"type":"assistant","id":"msg_a","time":{"created":3000},
			 "content":[{"type":"text","text":"好"},{"type":"reasoning","text":"想"}],
			 "cost":0.25,"tokens":{"input":10,"output":20}},
			{"type":"assistant","id":"msg_e","time":{"created":4000},
			 "content":[],"error":{"name":"ProviderError"}}
		]}`
	})
	raw := GetSessionContext("ses_1")
	if err := decodeError(t, raw); err != "" {
		t.Fatalf("不应返回错误: %s", err)
	}
	if p := ts.last().Path; p != "/api/session/ses_1/context" {
		t.Errorf("路径 = %s", p)
	}

	var out struct {
		Messages []struct {
			ID      string  `json:"id"`
			Type    string  `json:"type"`
			Created int64   `json:"created"`
			Text    string  `json:"text"`
			Cost    float64 `json:"cost"`
			Error   string  `json:"error"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(out.Messages) != 4 {
		t.Fatalf("消息数 = %d，期望 4", len(out.Messages))
	}
	// 首条必须是 compaction —— 这正是「不是 token 占用」的实证
	if out.Messages[0].Type != "compaction" {
		t.Errorf("首条类型 = %q，期望 compaction", out.Messages[0].Type)
	}
	if out.Messages[1].Text != "做件事" {
		t.Errorf("user 文本 = %q", out.Messages[1].Text)
	}
	// assistant 的文本取自 content[] 里的 text 段，而非 message 顶层
	if out.Messages[2].Text != "好" {
		t.Errorf("assistant 文本 = %q，期望取 content[0].text", out.Messages[2].Text)
	}
	if out.Messages[2].Cost != 0.25 {
		t.Errorf("cost = %v", out.Messages[2].Cost)
	}
	if out.Messages[3].Error != "ProviderError" {
		t.Errorf("error = %q", out.Messages[3].Error)
	}
}

func TestGetSessionContext空列表(t *testing.T) {
	newTestServer(t, func(c captured) (int, string) {
		return http.StatusOK, `{"data":[]}`
	})
	raw := GetSessionContext("ses_1")
	var out struct {
		Messages []map[string]any `json:"messages"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if out.Messages == nil {
		t.Error("空列表时 messages 应为 [] 而非 null")
	}
	if len(out.Messages) != 0 {
		t.Errorf("消息数 = %d", len(out.Messages))
	}
}

// ============ 导入导出 ============

func TestExportSession(t *testing.T) {
	ts := newTestServer(t, func(c captured) (int, string) {
		return http.StatusOK, `{"data":{"info":{"id":"ses_1","title":"T"},"messages":[]}}`
	})
	raw := ExportSession("ses_1", false)
	if p := ts.last().Path; p != "/api/experimental/session/ses_1/export" {
		t.Errorf("路径 = %s", p)
	}
	if q := ts.last().RawURL; q != "" {
		t.Errorf("未请求 sanitize 时不应带查询串，实际 %q", q)
	}
	// 必须原样透出：导出内容要能被 import 原样吃回，任何再包装都会破坏往返
	if !strings.Contains(raw, `"messages"`) || strings.Contains(raw, `"error"`) {
		t.Errorf("导出应原样透出，实际 %s", raw)
	}
}

func TestExportSessionSanitize(t *testing.T) {
	ts := newTestServer(t, func(c captured) (int, string) {
		return http.StatusOK, `{"data":{"info":{},"messages":[]}}`
	})
	ExportSession("ses_1", true)
	if q := ts.last().Query; q.Get("sanitize") != "true" {
		t.Errorf("sanitize 未透传，实际 %q", ts.last().RawURL)
	}
}

func TestImportSession(t *testing.T) {
	ts := newTestServer(t, func(c captured) (int, string) {
		return http.StatusOK, `{"data":{"id":"ses_new"}}`
	})
	res := ImportSession(`{"info":{"id":"ses_1"},"messages":[]}`)
	if !res.Success {
		t.Fatalf("期望成功，实际 %+v", res)
	}
	if p := ts.last().Path; p != "/api/experimental/session/import" {
		t.Errorf("路径 = %s", p)
	}
}

// TestImportSession拒绝子会话 覆盖实测确认的 409 约束：
// 带 parentID 而父会话不存在时服务端返回 409，应在本地就拦下并说清原因。
func TestImportSession拒绝子会话(t *testing.T) {
	ts := newTestServer(t, nil)
	res := ImportSession(`{"info":{"id":"ses_c","parentID":"ses_p"},"messages":[]}`)
	if res.Error == "" {
		t.Fatal("子会话导入应被拒绝")
	}
	if !strings.Contains(res.Error, "ses_p") {
		t.Errorf("错误信息应指出父会话 ID，实际 %q", res.Error)
	}
	if ts.count() != 0 {
		t.Errorf("本地拦下后不应发请求，实际 %d 次", ts.count())
	}
}

func TestImportSession参数校验(t *testing.T) {
	ts := newTestServer(t, nil)
	cases := []struct{ name, in string }{
		{"空输入", "  "},
		{"非法 JSON", "{not json"},
		{"缺 info", `{"messages":[]}`},
		{"缺 messages", `{"info":{"id":"x"}}`},
	}
	for _, c := range cases {
		if ImportSession(c.in).Error == "" {
			t.Errorf("%s 应报错", c.name)
		}
	}
	if ts.count() != 0 {
		t.Errorf("校验失败时不应发请求，实际 %d 次", ts.count())
	}
}

// ============ 集成与凭据 ============

// TestListIntegrations默认过滤 覆盖实测数据：v2 约 200 个集成，
// 绝大多数 connections 为空。全量丢给前端既臃肿又无用。
func TestListIntegrations默认过滤(t *testing.T) {
	ts := newTestServer(t, func(c captured) (int, string) {
		return http.StatusOK, `{"location":{"directory":"E:\\work\\bmall"},"data":[
			{"id":"a","name":"A","methods":[],"connections":[]},
			{"id":"b","name":"B","methods":[],"connections":[{"type":"env","name":"B_KEY"}]},
			{"id":"c","name":"C","methods":[],"connections":[
				{"type":"credential","id":"cred_1","label":"主","method":"key"}]}
		]}`
	})
	raw := ListIntegrations(`E:\work\bmall`, false)
	if q := ts.last().Query; q.Get("location[directory]") != `E:\work\bmall` {
		t.Errorf("location 未正确编码: %q", ts.last().RawURL)
	}
	var out struct {
		Integrations []IntegrationInfo `json:"integrations"`
		Total        int               `json:"total"`
		Shown        int               `json:"shown"`
		Filtered     bool              `json:"filtered"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if out.Total != 3 || out.Shown != 2 {
		t.Errorf("total=%d shown=%d，期望 3/2", out.Total, out.Shown)
	}
	if !out.Filtered {
		t.Error("filtered 应为 true")
	}
	// 保留的应是 b 与 c，且顺序不变
	if out.Integrations[0].ID != "b" || out.Integrations[1].ID != "c" {
		t.Errorf("保留项错误: %v / %v", out.Integrations[0].ID, out.Integrations[1].ID)
	}
}

func TestListIntegrations含未配置(t *testing.T) {
	newTestServer(t, func(c captured) (int, string) {
		return http.StatusOK, `{"data":[
			{"id":"a","connections":[]},
			{"id":"b","connections":[{"type":"env","name":"K"}]}
		]}`
	})
	var out struct {
		Integrations []IntegrationInfo `json:"integrations"`
		Filtered     bool              `json:"filtered"`
	}
	_ = json.Unmarshal([]byte(ListIntegrations("", true)), &out)
	if out.Filtered {
		t.Error("includeEmpty=true 时 filtered 应为 false")
	}
	if len(out.Integrations) != 2 {
		t.Errorf("应返回全部 2 条，实际 %d", len(out.Integrations))
	}
}

// TestActivateCredential不发请求体 覆盖实测契约：activate 声明无 body。
// 通用代理层会为 POST 自动补 {}，这里必须自己绕开，否则是「碰巧被容忍」。
func TestActivateCredential不发请求体(t *testing.T) {
	ts := newTestServer(t, nil)
	res := ActivateCredential("cred_1")
	if !res.Success {
		t.Fatalf("期望成功，实际 %+v", res)
	}
	c := ts.last()
	if c.Method != http.MethodPost {
		t.Errorf("方法 = %s", c.Method)
	}
	if c.Path != "/api/credential/cred_1/activate" {
		t.Errorf("路径 = %s", c.Path)
	}
	if c.Body != "" {
		t.Errorf("activate 不应带请求体，实际 %q", c.Body)
	}
}

func TestRenameCredential(t *testing.T) {
	ts := newTestServer(t, nil)
	res := RenameCredential("cred_1", "新名字")
	if !res.Success {
		t.Fatalf("期望成功，实际 %+v", res)
	}
	c := ts.last()
	if c.Method != http.MethodPatch {
		t.Errorf("方法 = %s，期望 PATCH", c.Method)
	}
	if c.Path != "/api/credential/cred_1" {
		t.Errorf("路径 = %s", c.Path)
	}
	var body map[string]any
	_ = json.Unmarshal([]byte(c.Body), &body)
	if body["label"] != "新名字" {
		t.Errorf("label = %v", body["label"])
	}
	// v2 的 PATCH 只能改 label，不应夹带其它字段
	if len(body) != 1 {
		t.Errorf("PATCH 体应只含 label，实际 %v", body)
	}
}

func Test凭据参数校验(t *testing.T) {
	ts := newTestServer(t, nil)
	if ActivateCredential("").Error == "" {
		t.Error("缺凭据 ID 应报错")
	}
	if RenameCredential("cred_1", "  ").Error == "" {
		t.Error("空白名称应报错")
	}
	if AddCredential("", "sk-x", "L").Error == "" {
		t.Error("缺集成 ID 应报错")
	}
	if AddCredential("deepseek", "   ", "L").Error == "" {
		t.Error("空白 API Key 应报错")
	}
	if DeleteCredential("").Error == "" {
		t.Error("缺凭据 ID 应报错")
	}
	if ts.count() != 0 {
		t.Errorf("参数不合法时不应发请求，实际 %d 次", ts.count())
	}
}

// TestAddCredential 覆盖实测契约：POST /api/integration/{id}/connect/key。
// 这是「一个供应商多把 key」的**唯一写入入口**——v2 没有 GET /api/credential
// （实测 404），凭据只能从 /api/integration 的 connections 读出来。
func TestAddCredential(t *testing.T) {
	ts := newTestServer(t, nil)
	res := AddCredential("deepseek", "sk-abc", "备用号")
	if !res.Success {
		t.Fatalf("期望成功，实际 %+v", res)
	}
	c := ts.last()
	if c.Method != http.MethodPost {
		t.Errorf("方法 = %s，期望 POST", c.Method)
	}
	if c.Path != "/api/integration/deepseek/connect/key" {
		t.Errorf("路径 = %s", c.Path)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(c.Body), &body); err != nil {
		t.Fatalf("请求体不是 JSON: %v (%q)", err, c.Body)
	}
	if body["key"] != "sk-abc" {
		t.Errorf("key = %v", body["key"])
	}
	if body["label"] != "备用号" {
		t.Errorf("label = %v", body["label"])
	}
}

// TestAddCredential空label不发空串 传空 label 可能被服务端当成「显式清空」，
// 反而把凭据名覆盖成空，故只在非空时携带该字段。
func TestAddCredential空label不发空串(t *testing.T) {
	ts := newTestServer(t, nil)
	AddCredential("deepseek", "sk-abc", "   ")
	c := ts.last()
	var body map[string]any
	_ = json.Unmarshal([]byte(c.Body), &body)
	if _, ok := body["label"]; ok {
		t.Errorf("空白 label 不应出现在请求体，实际 %v", body)
	}
	if body["key"] != "sk-abc" {
		t.Errorf("key 不应受影响，实际 %v", body["key"])
	}
}

// TestAddCredential成功时响应体为空 实测该端点成功时 Content-Length: 0。
// 若按 JSON 解析返回值，会得到 "unexpected end of JSON input"，
// 把一次成功的写入误报成失败——这条守住「只取状态码、不碰 body」。
func TestAddCredential成功时响应体为空(t *testing.T) {
	newTestServer(t, func(c captured) (int, string) {
		// 成功、但响应体就是空的
		return http.StatusNoContent, ""
	})
	res := AddCredential("deepseek", "sk-abc", "")
	if !res.Success {
		t.Fatalf("空响应体不应被判为失败，实际 %+v", res)
	}
	if res.Error != "" {
		t.Errorf("空响应体不应产生 error，实际 %q", res.Error)
	}
}

// TestDeleteCredential 覆盖实测契约：DELETE /api/credential/{id}，204 无内容。
func TestDeleteCredential(t *testing.T) {
	ts := newTestServer(t, nil)
	res := DeleteCredential("cred_1")
	if !res.Success {
		t.Fatalf("期望成功，实际 %+v", res)
	}
	c := ts.last()
	if c.Method != http.MethodDelete {
		t.Errorf("方法 = %s，期望 DELETE", c.Method)
	}
	if c.Path != "/api/credential/cred_1" {
		t.Errorf("路径 = %s", c.Path)
	}
	if c.Body != "" {
		t.Errorf("DELETE 不应带请求体，实际 %q", c.Body)
	}
}

// TestDeleteCredentialID被转义 凭据 id 来自服务端，拼接前必须转义。
func TestDeleteCredentialID被转义(t *testing.T) {
	ts := newTestServer(t, nil)
	DeleteCredential("cred_1/../admin")
	c := ts.last()
	if c.Path != "/api/credential/cred_1%2F..%2Fadmin" &&
		c.Path != "/api/credential/cred_1/../admin" {
		t.Errorf("路径未按原样转义: %s", c.Path)
	}
}

// ============ 工作树 ============

// TestListWorktrees 覆盖 projectID 定位 + 裸数组两处实测结论。
func TestListWorktrees(t *testing.T) {
	ts := newTestServer(t, func(c captured) (int, string) {
		return http.StatusOK, `[{"directory":"E:\\wt\\a","strategy":"branch"},{"directory":"E:\\wt\\b"}]`
	})
	raw := ListWorktrees("0fcef83d78183d189ffa7470f7eb0779e450c3a8")
	if p := ts.last().Path; p != "/api/worktree" {
		t.Errorf("路径 = %s", p)
	}
	if got := ts.last().Query.Get("projectID"); got != "0fcef83d78183d189ffa7470f7eb0779e450c3a8" {
		t.Errorf("projectID = %q", got)
	}
	var out struct {
		Worktrees []WorktreeInfo `json:"worktrees"`
		Count     int            `json:"count"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("解析失败: %v（裸数组不应被当成 {data} 信封）", err)
	}
	if out.Count != 2 || out.Worktrees[0].Directory != `E:\wt\a` {
		t.Errorf("解析结果错误: %+v", out)
	}
}

func TestListWorktrees缺ID(t *testing.T) {
	ts := newTestServer(t, nil)
	if decodeError(t, ListWorktrees("  ")) == "" {
		t.Error("缺 projectID 应报错")
	}
	if ts.count() != 0 {
		t.Error("缺 ID 时不应发请求")
	}
}

// ============ 分支 ============

// TestListBranches 覆盖「data 是扁平 string[]」这一实测结论。
// 按对象数组解析会直接失败。
func TestListBranches(t *testing.T) {
	ts := newTestServer(t, func(c captured) (int, string) {
		return http.StatusOK, `{"location":{"directory":"E:\\work\\bmall"},"data":["main","dev","origin/main"]}`
	})
	raw := ListBranches(`E:\work\bmall`, "ma", 50)
	q := ts.last().Query
	if q.Get("location[directory]") != `E:\work\bmall` {
		t.Errorf("location 编码错误: %q", ts.last().RawURL)
	}
	if q.Get("search") != "ma" {
		t.Errorf("search = %q", q.Get("search"))
	}
	if q.Get("limit") != "50" {
		t.Errorf("limit = %q", q.Get("limit"))
	}
	var out struct {
		Branches []string `json:"branches"`
		Count    int      `json:"count"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if out.Count != 3 || out.Branches[2] != "origin/main" {
		t.Errorf("解析结果错误: %+v", out)
	}
}

func TestListBranches无额外参数(t *testing.T) {
	ts := newTestServer(t, func(c captured) (int, string) {
		return http.StatusOK, `{"data":[]}`
	})
	ListBranches("", "", 0)
	if q := ts.last().RawURL; q != "" {
		t.Errorf("无参数时不应带查询串，实际 %q", q)
	}
}

func TestListBranches空结果(t *testing.T) {
	newTestServer(t, func(c captured) (int, string) {
		return http.StatusOK, `{"location":{"directory":"x"},"data":[]}`
	})
	var out struct {
		Branches []string `json:"branches"`
	}
	_ = json.Unmarshal([]byte(ListBranches("x", "", 0)), &out)
	if out.Branches == nil {
		t.Error("空结果时 branches 应为 [] 而非 null")
	}
}

// ============ 终端 ============

func TestListPtys(t *testing.T) {
	ts := newTestServer(t, func(c captured) (int, string) {
		return http.StatusOK, `{"location":{"directory":"E:\\work\\bmall"},"data":[
			{"id":"pty_1","title":"shell","command":"bash","args":[],"cwd":"E:\\work\\bmall","status":"running","pid":1234},
			{"id":"pty_2","title":"vim","command":"vim","args":["a.go"],"cwd":"E:\\","status":"exited","pid":9,"exitCode":0}
		]}`
	})
	raw := ListPtys(`E:\work\bmall`)
	if p := ts.last().Path; p != "/api/pty" {
		t.Errorf("路径 = %s", p)
	}
	var out struct {
		Ptys  []PtyInfo `json:"ptys"`
		Count int       `json:"count"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if out.Count != 2 {
		t.Fatalf("count = %d", out.Count)
	}
	if out.Ptys[0].Status != "running" || out.Ptys[0].PID != 1234 {
		t.Errorf("运行中终端解析错误: %+v", out.Ptys[0])
	}
	// exitCode 是可选字段（指针），运行中的终端不应有值
	if out.Ptys[0].ExitCode != nil {
		t.Error("运行中终端不应有 exitCode")
	}
	if out.Ptys[1].ExitCode == nil || *out.Ptys[1].ExitCode != 0 {
		t.Errorf("已退出终端的 exitCode 应为 0，实际 %v", out.Ptys[1].ExitCode)
	}
}

func TestListPtys空结果(t *testing.T) {
	newTestServer(t, func(c captured) (int, string) {
		return http.StatusOK, `{"data":[]}`
	})
	var out struct {
		Ptys []PtyInfo `json:"ptys"`
	}
	_ = json.Unmarshal([]byte(ListPtys("x")), &out)
	if out.Ptys == nil {
		t.Error("空结果时 ptys 应为 [] 而非 null")
	}
}

// ============ 失败路径 ============

// Test扩展端点HTML兜底 覆盖 v2 SPA 对未注册路径返回 200+HTML 的坑：
// 只看 2xx 会把 HTML 当成功结果交给前端。
func Test扩展端点HTML兜底(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("<!doctype html><title>opencode</title>"))
	}))
	defer srv.Close()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port := 0
	for _, ch := range portStr {
		port = port*10 + int(ch-'0')
	}
	WebSessMu.Lock()
	prev := WebSess
	WebSess = &webSession{hostname: host, port: port}
	WebSessMu.Unlock()
	defer func() {
		WebSessMu.Lock()
		WebSess = prev
		WebSessMu.Unlock()
	}()

	if msg := decodeError(t, GetSessionContext("ses_1")); !strings.Contains(msg, "未提供该 API 路径") {
		t.Errorf("应识别 HTML 兜底，实际 %q", msg)
	}
	if msg := decodeError(t, ListIntegrations("", false)); msg == "" {
		t.Error("集成列表应报错")
	}
}

// Test认证头透传 确认所有扩展端点都带 v2 Basic 认证，
// 否则 401 时错误信息会指向错误的排查方向。
func Test认证头透传(t *testing.T) {
	ts := newTestServer(t, nil)
	MoveSession("ses_1", "/d", "")
	MarkSessionViewed("ses_1", 1)
	ActivateCredential("cred_1")
	RenameCredential("cred_1", "x")
	if ts.count() != 4 {
		t.Fatalf("请求数 = %d，期望 4", ts.count())
	}
	ts.mu.Lock()
	defer ts.mu.Unlock()
	for i, c := range ts.requests {
		if c.Auth == "" {
			t.Errorf("第 %d 个请求（%s %s）缺少认证头", i+1, c.Method, c.Path)
		}
	}
}
