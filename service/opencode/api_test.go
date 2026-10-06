package opencode

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

)

// TestDescribeV2Error 覆盖 v2 错误体的解析。
//
// 关键背景：v2 的错误体是 {"_tag":"XxxError","message":"..."}，
// **没有 error 键**。因此调用方不能靠「响应里有没有 error 字段」判失败，
// 必须由本层在收到非 2xx 时就转成 error。
func TestDescribeV2Error(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			name: "tag + message",
			body: `{"_tag":"SessionNotFoundError","message":"Session not found: ses_x"}`,
			want: "SessionNotFoundError: Session not found: ses_x",
		},
		{
			name: "仅 tag",
			body: `{"_tag":"UnknownError"}`,
			want: "UnknownError",
		},
		{
			name: "仅 message",
			body: `{"message":"boom"}`,
			want: "boom",
		},
		{
			// 实测 view 缺 idle 的响应
			name: "带 kind 的 payload 错误",
			body: `{"_tag":"InvalidRequestError","message":"Missing key\n at [\"idle\"]","kind":"Payload"}`,
			want: "InvalidRequestError: Missing key\n at [\"idle\"]: kind=Payload",
		},
		{
			name: "空对象",
			body: `{}`,
			want: "(无错误详情)",
		},
		{
			name: "非 JSON 原样截断",
			body: "plain text failure",
			want: "plain text failure",
		},
		{
			name: "非 JSON 超长截断",
			body: strings.Repeat("x", 500),
			want: strings.Repeat("x", 200) + "…",
		},
	}
	for _, c := range cases {
		if got := describeV2Error([]byte(c.body)); got != c.want {
			t.Errorf("%s: describeV2Error(%s) = %q, 期望 %q", c.name, c.body, got, c.want)
		}
	}
}

// TestReadAPIResponse非2xx转错误 确认 4xx/5xx 的 JSON 错误体不会被当成功数据返回。
// 这是实测发现的问题：原先只拦 HTML 与 401，404 的错误体会被原样返回，
// 调用方随后把 {"_tag":...} 当正常数据解析。
func TestReadAPIResponse非2xx转错误(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   string
	}{
		{http.StatusBadRequest, `{"_tag":"InvalidRequestError","message":"Missing key"}`, "400"},
		{http.StatusNotFound, `{"_tag":"SessionNotFoundError","message":"nope"}`, "404"},
		{http.StatusConflict, `{"_tag":"ConflictError","message":"parent missing"}`, "409"},
		{http.StatusInternalServerError, `{"_tag":"UnknownError","message":"boom"}`, "500"},
	}
	for _, c := range cases {
		resp := &http.Response{
			StatusCode: c.status,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(c.body)),
		}
		data, err := readAPIResponse(resp, "http://x/api/test")
		if err == nil {
			t.Errorf("状态 %d 应转成 error，实际返回了数据 %q", c.status, string(data))
			continue
		}
		if !strings.Contains(err.Error(), c.want) {
			t.Errorf("状态 %d 的错误信息应含 %q，实际 %q", c.status, c.want, err.Error())
		}
		if !strings.Contains(err.Error(), "_tag") && c.status != http.StatusInternalServerError {
			t.Logf("提示：错误信息未带出 _tag —— %q", err.Error())
		}
	}
}

// TestReadAPIResponse2xx放行 确认正常响应不被误判为错误。
func TestReadAPIResponse2xx放行(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusNoContent, http.StatusCreated, 299} {
		resp := &http.Response{
			StatusCode: status,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"data":[]}`)),
		}
		data, err := readAPIResponse(resp, "http://x/api/test")
		if err != nil {
			t.Errorf("状态 %d 不应报错，实际 %v", status, err)
		}
		if len(data) == 0 {
			t.Errorf("状态 %d 应返回数据体", status)
		}
	}
}

// TestReadAPIResponse401 特判 401 给出可操作的口令提示。
func TestReadAPIResponse401(t *testing.T) {
	resp := &http.Response{
		StatusCode: http.StatusUnauthorized,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(`{"_tag":"UnauthorizedError"}`)),
	}
	_, err := readAPIResponse(resp, "http://x/api/test")
	if err == nil || !strings.Contains(err.Error(), "口令") {
		t.Errorf("401 应给出口令相关提示，实际 %v", err)
	}
}

// ============ HTML 兜底拦截 ============

// TestIsHTMLResponse 覆盖本次修复的核心问题：
// v2 的 SPA 会对未注册路径返回 200 + text/html，若只看 2xx 会误判成功。
func TestIsHTMLResponse(t *testing.T) {
	cases := []struct {
		ct   string
		want bool
	}{
		{"text/html", true},
		{"text/html; charset=utf-8", true},
		{"TEXT/HTML", true},
		{"  text/html  ", true},
		{"application/json", false},
		{"application/json; charset=utf-8", false},
		{"text/event-stream", false},
		{"", false},
	}
	for _, c := range cases {
		if got := isHTMLResponse(c.ct); got != c.want {
			t.Errorf("isHTMLResponse(%q) = %v, 期望 %v", c.ct, got, c.want)
		}
	}
}

// TestExpectsJSONBody 覆盖 v2 对空 body 的 400 Expected object。
func TestExpectsJSONBody(t *testing.T) {
	cases := []struct {
		method string
		want   bool
	}{
		{http.MethodPost, true},
		{"post", true},
		{http.MethodPatch, true},
		{http.MethodPut, true},
		{http.MethodGet, false},
		{http.MethodDelete, false},
		{"", false},
	}
	for _, c := range cases {
		if got := expectsJSONBody(c.method); got != c.want {
			t.Errorf("expectsJSONBody(%q) = %v, 期望 %v", c.method, got, c.want)
		}
	}
}

// ============ 会话结构适配 ============

// TestSessionDirectory 覆盖 v2 把 directory 移到 location 的改动。
func TestSessionDirectory(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"v2 location.directory", `{"id":"ses_1","location":{"directory":"C:\\work"}}`, `C:\work`},
		{"v1 顶层 directory（兼容）", `{"id":"ses_1","directory":"C:\\old"}`, `C:\old`},
		{"location 为空对象", `{"id":"ses_1","location":{}}`, ""},
		{"都没有", `{"id":"ses_1"}`, ""},
	}
	for _, c := range cases {
		var s map[string]any
		if err := json.Unmarshal([]byte(c.body), &s); err != nil {
			t.Fatalf("%s: 解析失败 %v", c.name, err)
		}
		if got := sessionDirectory(s); got != c.want {
			t.Errorf("%s: sessionDirectory = %q, 期望 %q", c.name, got, c.want)
		}
	}
}

// TestUnwrapSessionData 覆盖 v2 的 {data:...} 信封。
func TestUnwrapSessionData(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"带 data 信封", `{"data":{"id":"ses_1"}}`, "ses_1"},
		{"裸对象（兼容）", `{"id":"ses_2"}`, "ses_2"},
	}
	for _, c := range cases {
		got := unwrapSessionData([]byte(c.body))
		id, _ := got["id"].(string)
		if id != c.want {
			t.Errorf("%s: id = %q, 期望 %q", c.name, id, c.want)
		}
	}

	// 非法 JSON 不应 panic
	if got := unwrapSessionData([]byte("not json")); got != nil {
		t.Errorf("非法 JSON 应返回 nil，实际 %v", got)
	}
}

// TestUnmarshalSessionList 覆盖 v2 列表信封与裸数组两种形态。
// TestUnmarshalSessionListKeepsIdle 锁定 time.idle 必须透出。
//
// POST /api/session/{id}/view 的 body 里 idle 必填，且必须是该值原值——
// 它是服务端判定「viewer 已观察到这次 idle 转换」的对账凭据。实测缺 idle
// 返回 400 Missing key ["idle"]。前端要调该端点就得从这里拿到 idle，
// 因此这里锁住「idle 会被解析并透出」，避免有人精简结构时把它删掉。
func TestUnmarshalSessionListKeepsIdle(t *testing.T) {
	body := `{"data":[{"id":"ses_1","time":{"created":1000,"updated":2000,"idle":1790605979558}}]}`
	got, err := unmarshalSessionList([]byte(body))
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("长度 = %d, 期望 1", len(got))
	}
	if got[0].Time.Idle != 1790605979558 {
		t.Errorf("Time.Idle = %d, 期望 1790605979558（idle 丢失会导致 view 端点 400）", got[0].Time.Idle)
	}
}

// TestUnmarshalSessionListIdleOmitted 缺 idle 时应为 0 而非报错：
// 从未空闲过的会话本来就没有 idle 值。
func TestUnmarshalSessionListIdleOmitted(t *testing.T) {
	body := `{"data":[{"id":"ses_1","time":{"created":1000,"updated":2000}}]}`
	got, err := unmarshalSessionList([]byte(body))
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if got[0].Time.Idle != 0 {
		t.Errorf("Time.Idle = %d, 缺省应为 0", got[0].Time.Idle)
	}
}

func TestUnmarshalSessionList(t *testing.T) {
	cases := []struct {
		name string
		body string
		want int
	}{
		{"{data,cursor} 信封", `{"data":[{"id":"ses_1"},{"id":"ses_2"}],"cursor":{"next":"x"}}`, 2},
		{"裸数组（兼容）", `[{"id":"ses_1"}]`, 1},
		{"空信封", `{"data":[]}`, 0},
	}
	for _, c := range cases {
		got, err := unmarshalSessionList([]byte(c.body))
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if len(got) != c.want {
			t.Errorf("%s: 长度 = %d, 期望 %d", c.name, len(got), c.want)
		}
	}

	if _, err := unmarshalSessionList([]byte("not json")); err == nil {
		t.Errorf("非法 JSON 应返回错误")
	}
}

// TestTreeSessionDir 覆盖 Dir() 的 v1/v2 回退。
func TestTreeSessionDir(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"v2 location 优先", `{"id":"s","directory":"v1dir","location":{"directory":"v2dir"}}`, "v2dir"},
		{"仅有 v1 directory", `{"id":"s","directory":"v1dir"}`, "v1dir"},
		{"仅有 v2 location", `{"id":"s","location":{"directory":"v2dir"}}`, "v2dir"},
		{"都没有", `{"id":"s"}`, ""},
	}
	for _, c := range cases {
		var s treeSession
		if err := json.Unmarshal([]byte(c.body), &s); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got := s.Dir(); got != c.want {
			t.Errorf("%s: Dir() = %q, 期望 %q", c.name, got, c.want)
		}
	}
}



// ============ 会话树：父子（子代理）关系 ============

// TestTreeSessionIsRoot 覆盖 v2 的 parentID 过滤。
// 背景：v1 用 roots=true 只取根会话；v2 改为 parentID=null。
// 不加该参数时子代理会话会混入（本机实测 500 条里 444 条是子会话）。
func TestTreeSessionIsRoot(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{"无 parentID 字段（v1 形态）", `{"id":"ses_1"}`, true},
		{"parentID 为空串", `{"id":"ses_1","parentID":""}`, true},
		{"parentID 为 null", `{"id":"ses_1","parentID":null}`, true},
		{"有父会话", `{"id":"ses_1","parentID":"ses_0"}`, false},
	}
	for _, c := range cases {
		var s treeSession
		if err := json.Unmarshal([]byte(c.body), &s); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got := s.IsRoot(); got != c.want {
			t.Errorf("%s: IsRoot() = %v, 期望 %v", c.name, got, c.want)
		}
	}
}

// TestUnmarshalSessionListKeepsParentID 确认解析后仍能识别子会话。
func TestUnmarshalSessionListKeepsParentID(t *testing.T) {
	body := `{"data":[
		{"id":"ses_root","title":"主会话"},
		{"id":"ses_kid","title":"子代理会话","parentID":"ses_root"},
		{"id":"ses_grand","title":"孙会话","parentID":"ses_kid"}
	]}`
	list, err := unmarshalSessionList([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 {
		t.Fatalf("长度 = %d, 期望 3", len(list))
	}
	roots := 0
	for _, s := range list {
		if s.IsRoot() {
			roots++
		}
	}
	if roots != 1 {
		t.Errorf("根会话数 = %d, 期望 1（其余为子会话，不应进树）", roots)
	}
	// 父 id 链应完整可回溯
	byID := map[string]treeSession{}
	for _, s := range list {
		byID[s.ID] = s
	}
	if p, ok := byID[list[1].ParentID]; !ok || p.ID != "ses_root" {
		t.Errorf("子会话的 parentID 应指向存在的根会话，实际 %q", list[1].ParentID)
	}
}


// ============ 认证 ============

// TestBasicAuthValue 覆盖 v2 的 Basic 认证（用户名固定为 opencode）。
func TestBasicAuthValue(t *testing.T) {
	if got := basicAuthValue(""); got != "" {
		t.Errorf("空口令应返回空串（不加认证头），实际 %q", got)
	}
	got := basicAuthValue("secret")
	want := "Basic b3BlbmNvZGU6c2VjcmV0" // base64("opencode:secret")
	if got != want {
		t.Errorf("basicAuthValue = %q, 期望 %q", got, want)
	}
}

// TestServiceInfoMatches 覆盖注册文件与目标地址的匹配。
func TestServiceInfoMatches(t *testing.T) {
	cases := []struct {
		name string
		info *serviceInfo
		host string
		port int
		want bool
	}{
		{"完全匹配", &serviceInfo{URL: "http://127.0.0.1:49374"}, "127.0.0.1", 49374, true},
		{"端口不同", &serviceInfo{URL: "http://127.0.0.1:49374"}, "127.0.0.1", 4096, false},
		{"主机大小写不同", &serviceInfo{URL: "http://LocalHost:4096"}, "localhost", 4096, true},
		{"https 协议", &serviceInfo{URL: "https://127.0.0.1:4096"}, "127.0.0.1", 4096, true},
		{"尾斜杠", &serviceInfo{URL: "http://127.0.0.1:4096/"}, "127.0.0.1", 4096, true},
		{"URL 为空", &serviceInfo{}, "127.0.0.1", 4096, false},
		{"info 为 nil", nil, "127.0.0.1", 4096, false},
		{"无端口", &serviceInfo{URL: "http://127.0.0.1"}, "127.0.0.1", 4096, false},

		// ↓↓ v2.0.24 兼容：service.json 的 url 改写成绑定地址 0.0.0.0 ↓↓
		// 回归用例：真实故障是「会话列表全空」——口令取不到 → 401 → 什么都读不出。
		{"绑定地址 0.0.0.0 对回环探测（v2.0.24 实测场景）",
			&serviceInfo{URL: "http://0.0.0.0:4096"}, "127.0.0.1", 4096, true},
		{"绑定地址 0.0.0.0 对 localhost", &serviceInfo{URL: "http://0.0.0.0:4096"}, "localhost", 4096, true},
		// IPv6 未指定地址
		{"绑定地址 [::] 对回环", &serviceInfo{URL: "http://[::]:4096"}, "127.0.0.1", 4096, true},
		{"绑定地址 [::] 对 ::1", &serviceInfo{URL: "http://[::]:4096"}, "::1", 4096, true},
		// 回环族互认（旧实现的注释声称支持、代码并未实现）
		{"localhost 对 127.0.0.1", &serviceInfo{URL: "http://localhost:4096"}, "127.0.0.1", 4096, true},
		{"127.0.0.1 对 localhost", &serviceInfo{URL: "http://127.0.0.1:4096"}, "localhost", 4096, true},
		{"127.0.0.2 仍是回环", &serviceInfo{URL: "http://127.0.0.2:4096"}, "127.0.0.1", 4096, true},
		// 反例：绑定地址不得匹配远程主机，否则会把本机口令用到远端同端口服务上
		{"绑定地址 0.0.0.0 对远程 IP（必须不匹配）",
			&serviceInfo{URL: "http://0.0.0.0:4096"}, "192.168.1.50", 4096, false},
		{"绑定地址 0.0.0.0 对远程域名（必须不匹配）",
			&serviceInfo{URL: "http://0.0.0.0:4096"}, "example.com", 4096, false},
		{"不同远程主机（必须不匹配）",
			&serviceInfo{URL: "http://10.0.0.5:4096"}, "10.0.0.6", 4096, false},
		{"端口不同时绑定地址也不匹配", &serviceInfo{URL: "http://0.0.0.0:4096"}, "127.0.0.1", 5000, false},
	}
	for _, c := range cases {
		if got := serviceInfoMatches(c.info, c.host, c.port); got != c.want {
			t.Errorf("%s: serviceInfoMatches = %v, 期望 %v", c.name, got, c.want)
		}
	}
}

// TestStartPasswordRe 覆盖从 serve 启动输出解析口令。
func TestStartPasswordRe(t *testing.T) {
	out := "server listening on http://127.0.0.1:41999\nserver password xWV63BgTpM11QtDql1YXVN33MU5XVM_l3iNEafmL-Q0\n"
	m := startPasswordRe.FindStringSubmatch(out)
	if m == nil {
		t.Fatal("未匹配到 server password")
	}
	if m[1] != "xWV63BgTpM11QtDql1YXVN33MU5XVM_l3iNEafmL-Q0" {
		t.Errorf("口令 = %q", m[1])
	}
	// 未打印口令时不应误匹配（例如把 URL 当口令）
	if startPasswordRe.FindStringSubmatch("server listening on http://127.0.0.1:41999\n") != nil {
		t.Errorf("仅有 listening 行时不应匹配出口令")
	}
}

// TestSetServerPasswordFallback 覆盖用户手工口令的优先级。
// 通过 XDG_STATE_HOME 注入一份真实的注册文件，不使用测试专用钩子。
func TestSetServerPasswordFallback(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_STATE_HOME", dir)
	t.Cleanup(func() { SetServerPassword("") })

	regPath := serviceRegistrationPath()
	if err := os.MkdirAll(filepath.Dir(regPath), 0o755); err != nil {
		t.Fatal(err)
	}
	reg := `{"id":"x","version":"2.0.15","url":"http://127.0.0.1:4096","pid":1,"password":"from-registry"}`
	if err := os.WriteFile(regPath, []byte(reg), 0o644); err != nil {
		t.Fatal(err)
	}

	// 1) 未设手工口令时从注册文件取
	SetServerPassword("")
	if got := discoverServerPassword("127.0.0.1", 4096); got != "from-registry" {
		t.Errorf("应从注册文件取到口令，实际 %q", got)
	}
	// 2) 地址不匹配则不返回
	if got := discoverServerPassword("127.0.0.1", 9999); got != "" {
		t.Errorf("地址不匹配应返回空，实际 %q", got)
	}
	// 3) 手工口令优先于注册文件
	SetServerPassword("  user-provided  ")
	if got := configuredPassword(); got != "user-provided" {
		t.Errorf("手工口令应去除首尾空白，实际 %q", got)
	}
	if got := discoverServerPassword("127.0.0.1", 4096); got != "user-provided" {
		t.Errorf("手工口令应优先，实际 %q", got)
	}
	// 4) 清空后回落到注册文件
	SetServerPassword("")
	if got := discoverServerPassword("127.0.0.1", 4096); got != "from-registry" {
		t.Errorf("清空后应回落到注册文件，实际 %q", got)
	}
}

// TestReadServiceRegistrationMissingFile 注册文件不存在时应返回 nil 而非报错。
func TestReadServiceRegistrationMissingFile(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	if got := readServiceRegistration(); got != nil {
		t.Errorf("文件不存在时应返回 nil，实际 %+v", got)
	}
}

// TestReadServiceRegistrationCorrupt 文件损坏时应返回 nil 而非 panic。
func TestReadServiceRegistrationCorrupt(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_STATE_HOME", dir)
	p := serviceRegistrationPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("{ not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readServiceRegistration(); got != nil {
		t.Errorf("损坏文件应返回 nil，实际 %+v", got)
	}
}
