package opencode

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

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

// TestUnmarshalProjectCanonical 覆盖 Project 的 v2 形态：
// worktree → canonical，且不再有 name。
func TestUnmarshalProjectCanonical(t *testing.T) {
	var projects []ProjectInfo
	body := `[{"id":"p1","canonical":"C:\\work\\bmall","vcs":"git","time":{"created":1,"updated":2}}]`
	if err := json.Unmarshal([]byte(body), &projects); err != nil {
		t.Fatal(err)
	}
	if len(projects) != 1 {
		t.Fatalf("项目数 = %d, 期望 1", len(projects))
	}
	if projects[0].Canonical != `C:\work\bmall` {
		t.Errorf("Canonical = %q", projects[0].Canonical)
	}
	if projects[0].Name != "" {
		t.Errorf("v2 不应有 name，实际 %q", projects[0].Name)
	}
}

// TestProjectDisplayName 覆盖项目名从 canonical 末段推导。
func TestProjectDisplayName(t *testing.T) {
	cases := []struct {
		name    string
		project ProjectInfo
		want    string
	}{
		{"unix 路径", ProjectInfo{ID: "p", Canonical: "/home/u/bmall"}, "bmall"},
		{"windows 路径", ProjectInfo{ID: "p", Canonical: `C:\work\bmall\go-exCore`}, "go-exCore"},
		{"带尾斜杠", ProjectInfo{ID: "p", Canonical: "/home/u/bmall/"}, "bmall"},
		{"根路径 + global", ProjectInfo{ID: "global", Canonical: "/"}, "全局项目"},
		{"空 canonical + global", ProjectInfo{ID: "global"}, "全局项目"},
		{"空 canonical + 普通 id", ProjectInfo{ID: "abc123"}, "abc123"},
		{"已有 name 优先由调用方处理", ProjectInfo{ID: "p", Canonical: "/a/b"}, "b"},
	}
	for _, c := range cases {
		if got := projectDisplayName(c.project); got != c.want {
			t.Errorf("%s: projectDisplayName = %q, 期望 %q", c.name, got, c.want)
		}
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
