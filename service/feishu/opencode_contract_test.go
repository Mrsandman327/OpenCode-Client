package feishu

import (
	"encoding/json"
	"strings"
	"testing"
)

// 以下 fixture 全部是从本机 v2.0.15 真机抓下来的真实响应片段，
// **不是手写的理想结构**。
//
// 这一点很重要：本文件在修复前抓出的四个反直觉契约，全部是靠手写 fixture
// 永远测不出来的——手写时人会照着自己以为的结构写，于是测试全绿、
// 线上静默失败。

// realSessionList 是 GET /api/session?limit=1 的真实响应（截断到一���）。
const realSessionList = `{"data":[{"id":"ses_f26a34d29ffeK6tzMLNBEcmQhG","projectID":"0fcef83d78183d189ffa7470f7eb0779e450c3a8","agent":"build","model":{"id":"space-bunny-free","providerID":"opencode-go","variant":"max"},"cost":0,"tokens":{"input":37147232,"output":1486393,"reasoning":622285,"cache":{"read":772714444,"write":0}},"outcome":"succeeded","time":{"created":1790353126212,"updated":1790645535868,"idle":1790645529626,"viewed":1790645254229},"title":"review","location":{"directory":"E:\\work\\bmall"}}],"cursor":{"previous":null,"next":null}}`

// realSessionCreate 是 POST /api/session 的真实响应形态。
const realSessionCreate = `{"data":{"id":"ses_NEW1","parentID":null,"title":"","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1790645535868,"updated":1790645535868,"idle":0}},"cursor":{"previous":null,"next":null}}`

// Test列表是data包裹 最初按裸数组写解析。真实是 {data:[...]}——
// 照裸数组写，列表会恒为空，且不报错。
func Test列表是data包裹(t *testing.T) {
	var list []sessionInfo
	if err := unwrapData(realSessionList, &list); err != nil {
		t.Fatalf("解包失败: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("会话数 = %d, 期望 1", len(list))
	}
	if list[0].ID != "ses_f26a34d29ffeK6tzMLNBEcmQhG" {
		t.Errorf("ID = %q", list[0].ID)
	}
}

// Test单对象也是data包裹 这条最容易漏：POST /api/session 与 /fork 返回
// {data:{...}}，按顶层读 id 恒为空，于是「新建会话未返回 ID」。
func Test单对象也是data包裹(t *testing.T) {
	var info sessionInfo
	if err := unwrapData(realSessionCreate, &info); err != nil {
		t.Fatalf("解包失败: %v", err)
	}
	if info.ID != "ses_NEW1" {
		t.Errorf("ID = %q, 期望 ses_NEW1（单对象同样是 data 包裹）", info.ID)
	}
}

// Test解包兼容裸数组 /api/project、/api/worktree 返裸数组，
// V2 不同端点之间并不统一。假设其一就会在另一类端点上静默失败。
func Test解包兼容裸数组(t *testing.T) {
	var list []sessionInfo
	if err := unwrapData(`[{"id":"ses_X"}]`, &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != "ses_X" {
		t.Errorf("裸数组应能解包: %+v", list)
	}
}

func Test解包空响应报错(t *testing.T) {
	var v sessionInfo
	if err := unwrapData("   ", &v); err == nil {
		t.Error("空响应应报错而不是静默返回零值（零值会让上层以为「无数据」而非「取失败」）")
	}
}

// Test缓存token是嵌套的 真实结构是 cache:{read,write}。
// 写成扁平 cacheRead/cacheWrite 不报错，只是恒为 0——
// 用量卡上缓存读/写永远不显示，且没有任何迹象表明出错了。
func Test缓存token是嵌套的(t *testing.T) {
	// realSessionList 是列表 fixture，须解成切片
	var list []sessionInfo
	if err := unwrapData(realSessionList, &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("会话数 = %d", len(list))
	}
	info := list[0]
	if info.Tokens.Cache.Read != 772714444 {
		t.Errorf("cache.read = %d, 期望 772714444（嵌套结构）", info.Tokens.Cache.Read)
	}
	if info.Tokens.Input != 37147232 {
		t.Errorf("input = %d", info.Tokens.Input)
	}
	if info.Tokens.Output != 1486393 {
		t.Errorf("output = %d", info.Tokens.Output)
	}
	if info.Tokens.Reasoning != 622285 {
		t.Errorf("reasoning = %d", info.Tokens.Reasoning)
	}
}

// Test时间戳是嵌套的 真实结构是 time:{created,updated,idle,viewed}。
// 按顶层 updated 读恒为 0，会话列表的「几小时前」全部显示不出来。
func Test时间戳是嵌套的(t *testing.T) {
	var list []sessionInfo
	if err := unwrapData(realSessionList, &list); err != nil {
		t.Fatal(err)
	}
	info := list[0]
	if info.Time.Updated != 1790645535868 {
		t.Errorf("time.updated = %d, 期望 1790645535868（嵌套结构）", info.Time.Updated)
	}
	if info.Time.Idle == 0 {
		t.Error("time.idle 应解析出值")
	}
	if info.Time.Created == 0 {
		t.Error("time.created 应解析出值")
	}
}

// TestModelRef用id而非modelID spec 实测 Model.Ref 必填 {id, providerID}。
// 写 modelID 会被 400 拒绝——这是会报错的，属于好的失败方式。
func TestModelRef用id而非modelID(t *testing.T) {
	got := ModelRef("opencode-go/space-bunny-free")
	if got["providerID"] != "opencode-go" {
		t.Errorf("providerID = %v", got["providerID"])
	}
	if got["id"] != "space-bunny-free" {
		t.Errorf("id = %v", got["id"])
	}
	if _, bad := got["modelID"]; bad {
		t.Error("不应出现 modelID：spec 里字段名是 id，modelID 会被 400 拒绝")
	}
}

func TestModelRef无斜杠时只给id(t *testing.T) {
	got := ModelRef("gpt-5.4")
	if got["id"] != "gpt-5.4" {
		t.Errorf("id = %v", got["id"])
	}
	if _, ok := got["providerID"]; ok {
		t.Error("拆不出 provider 时不应凭空造一个")
	}
}

func TestModelRef空斜杠边界(t *testing.T) {
	for _, m := range []string{"/leading", "trailing/", "/"} {
		if got := ModelRef(m); got["id"] == "" && got["providerID"] == "" {
			t.Errorf("ModelRef(%q) 产出空引用", m)
		}
	}
}

// Test权限请求字段名 V2 的 Permission.Request 没有 title 字段，
// 说明文字在 message。spec 实测必填 id/sessionID/action/resources。
func Test权限请求字段名(t *testing.T) {
	raw := `{"data":[{"id":"per_1","sessionID":"ses_1","action":"bash","resources":["ls"],"save":["shell:ls"],"message":"执行 ls"}]}`
	var list []permissionRequest
	if err := unwrapData(raw, &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("条数 = %d", len(list))
	}
	p := list[0]
	if p.ID != "per_1" || p.Action != "bash" {
		t.Errorf("必填字段未解析: %+v", p)
	}
	if len(p.Resources) != 1 || p.Resources[0] != "ls" {
		t.Errorf("resources = %v", p.Resources)
	}
	if p.Message != "执行 ls" {
		t.Errorf("message = %q（V2 用 message，不是 title）", p.Message)
	}
	if len(p.Save) != 1 {
		t.Errorf("save = %v", p.Save)
	}
}

// Test无title字段 这是「按不存在的字段读」的反例：
// 解析不会报错，只是该字段恒为空。
func Test无title字段(t *testing.T) {
	raw := `{"data":[{"id":"per_1","sessionID":"ses_1","action":"bash","resources":[]}]}`
	var list []permissionRequest
	if err := unwrapData(raw, &list); err != nil {
		t.Fatal(err)
	}
	// 反序列化后 Message 为空是正确的：真实响应里就没这个字段
	if list[0].Message != "" {
		t.Error("样本里没有 message，应为空")
	}
	// 确认结构体里确实没有 title 字段（防止有人后来加回来）
	if strings.Contains(fieldNames(permissionRequest{}), "Title") {
		t.Error("permissionRequest 不应有 Title 字段（V2 没有这个字段）")
	}
}

// Test改动字段名 FileDiff.Info 必填 file/patch/additions/deletions/status。
func Test改动字段名(t *testing.T) {
	raw := `{"data":[{"file":"a.go","patch":"@@ -1 +1 @@","additions":10,"deletions":2,"status":"modified"}]}`
	var list []fileDiffInfo
	if err := unwrapData(raw, &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("条数 = %d", len(list))
	}
	f := list[0]
	if f.File != "a.go" || f.Additions != 10 || f.Deletions != 2 || f.Status != "modified" {
		t.Errorf("解析错误: %+v", f)
	}
}

// fieldNames 列出一个结构体的 json 字段名。
func fieldNames(v any) string {
	raw, _ := json.Marshal(v)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	var names []string
	for k := range m {
		names = append(names, k)
	}
	return strings.Join(names, ",")
}

// Test状态枚举 V2 spec 里 status 只有 added/deleted/modified 三个值。
// 图标函数对其它值走 default，属宽容处理；这里锁住已知三个值的映射。
func Test状态枚举(t *testing.T) {
	for status, want := range map[string]string{
		"added": "🆕", "deleted": "🗑️", "modified": "✍️",
	} {
		if got := diffStatusIcon(status); got != want {
			t.Errorf("diffStatusIcon(%q) = %q, 期望 %q", status, got, want)
		}
	}
	// 未知值走默认图标而不是空串
	if diffStatusIcon("future_status") == "" {
		t.Error("未知状态应回退默认图标，不应返回空")
	}
}

// Test会话ID路径转义 会话 ID 来自外部输入，直接拼进 URL 段会有注入风险。
func Test会话ID路径转义(t *testing.T) {
	got := sessPath("ses_abc/def")
	if strings.Contains(got, "ses_abc/def") {
		t.Errorf("未转义斜杠: %q", got)
	}
	if !strings.HasPrefix(got, "/api/session/") {
		t.Errorf("路径前缀错误: %q", got)
	}
}

func Test空会话ID路径仍合法(t *testing.T) {
	if got := sessPath(""); got != "/api/session/" {
		t.Errorf("空 ID 路径 = %q", got)
	}
}

// Test错误体压成一行 V2 错误体是 {message}（**无 error 键**）。
func Test错误体压成一行(t *testing.T) {
	got := summarizeErrBody(`{"_tag":"Error","message":"会话不存在"}`)
	if !strings.Contains(got, "会话不存在") {
		t.Errorf("应提取 message: %q", got)
	}
	if strings.Contains(got, "_tag") {
		t.Errorf("应只剩人读的部分: %q", got)
	}
}

func Test错误体非JSON原样(t *testing.T) {
	if got := summarizeErrBody("boom"); got != "boom" {
		t.Errorf("非 JSON 应原样返回: %q", got)
	}
}

func Test错误体空(t *testing.T) {
	if got := summarizeErrBody("  "); got != "(空响应)" {
		t.Errorf("空响应应有明确占位: %q", got)
	}
}

func Test错误体超长截断(t *testing.T) {
	long := strings.Repeat("x", 500)
	got := summarizeErrBody(long)
	r := []rune(got)
	if len(r) > 210 {
		t.Errorf("超长错误体应截断，实际 %d 字", len(r))
	}
	if !strings.HasSuffix(got, "…") {
		t.Error("截断后应有省略号")
	}
}
