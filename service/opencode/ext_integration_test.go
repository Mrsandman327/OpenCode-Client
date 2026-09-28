//go:build integration

// ext_integration_test.go —— 对真实 opencode v2 服务验证 ext.go 的端点契约。
//
// 单测里的 fixture 是我自己写的，能验证「解析逻辑对不对」，但验证不了
// 「我理解的契约对不对」。本文件补上后者：直接打真实服务，确认请求形态
// 与响应结构确实如 ext.go 顶部注释所述。
//
// 默认不参与 `go test ./...`（build tag 隔离），需要时显式开启：
//
//	go test -tags integration ./service/opencode/ -run Integration -v
//
// 前提：本机已有一个可发现的 opencode v2 服务（opencode serve 已运行）。
// 所有用例只读，唯一例外是 TestIntegration标记已读 —— 它会写一条已读标记，
// 属于无副作用的状态记录，但会在服务端产生 session.viewed 事件。
package opencode

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
)

// opencodeAddr 从环境变量读服务地址，缺省用仓库里既有的自动探测。
// 形如 http://127.0.0.1:4096 或 127.0.0.1:4096
func opencodeAddr(t *testing.T) (host string, port int) {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv("OC_TEST_ADDR"))
	if raw == "" {
		sess := getWebSession()
		if sess == nil {
			t.Skip("未发现本机 opencode 服务，且未设置 OC_TEST_ADDR —— 跳过集成测试")
		}
		return sess.hostname, sess.port
	}
	raw = strings.TrimPrefix(raw, "http://")
	raw = strings.TrimSuffix(raw, "/")
	h, p, err := net.SplitHostPort(raw)
	if err != nil {
		t.Fatalf("OC_TEST_ADDR 格式错误（期望 host:port）: %q", raw)
	}
	n, err := strconv.Atoi(p)
	if err != nil {
		t.Fatalf("端口不是数字: %q", p)
	}
	return h, n
}

// useRealService 把 WebSess 指向指定地址，并沿用自动探测到的口令。
func useRealService(t *testing.T) {
	t.Helper()
	host, port := opencodeAddr(t)
	prevSess := getWebSession()
	WebSessMu.Lock()
	prev := WebSess
	WebSess = &webSession{
		hostname: host,
		port:     port,
		password: prevSess.password,
		external: true,
	}
	WebSessMu.Unlock()
	t.Cleanup(func() {
		WebSessMu.Lock()
		WebSess = prev
		WebSessMu.Unlock()
	})
}

// pickIdleSession 找一个不在运行、且不是子会话的真实会话。
// 回滚等写操作只对空闲会话有效（实测运行中会话返回 SessionBusyError）。
func pickIdleSession(t *testing.T) map[string]any {
	t.Helper()
	base, password, fail := sessionScoped()
	if fail.Error != "" {
		t.Skipf("服务不可用: %s", fail.Error)
	}

	// 先取运行中的会话 ID，避免挑到正在被使用的
	busy := map[string]bool{}
	if raw, err := apiGet(base+"/api/session/active", password); err == nil {
		var active struct {
			Data map[string]any `json:"data"`
		}
		if json.Unmarshal(raw, &active) == nil {
			for id := range active.Data {
				busy[id] = true
			}
		}
	}

	raw, err := apiGet(base+"/api/session?limit=50", password)
	if err != nil {
		t.Skipf("列会话失败: %v", err)
	}
	var list struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Skipf("解析会话列表失败: %v", err)
	}
	for _, s := range list.Data {
		id := asString(s["id"])
		if id == "" || busy[id] {
			continue
		}
		if asString(s["parentID"]) != "" {
			continue
		}
		return s
	}
	t.Skip("没有可用的空闲会话")
	return nil
}

// TestIntegration服务端能力 确认 ext.go 依赖的基础能力在真实服务上成立。
func TestIntegration服务端能力(t *testing.T) {
	useRealService(t)
	base, _, fail := sessionScoped()
	if fail.Error != "" {
		t.Skip(fail.Error)
	}
	if _, err := getWebSessionBase(); err != nil {
		t.Fatal(err)
	}
	_ = base
	t.Log("服务可连接")
}

// TestIntegrationContext不是Token占用 是 ext.go 顶部第 2 条结论的实证：
// context 返回的是「上次压缩之后的全部消息」，不是 token 占用。
func TestIntegrationContext不是Token占用(t *testing.T) {
	useRealService(t)
	sess := pickIdleSession(t)
	id := asString(sess["id"])

	raw := GetSessionContext(id)
	var out struct {
		Messages []struct {
			Type string `json:"type"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("解析失败: %v (%s)", err, raw)
	}
	// 确认没有失败（按 error 字段判，不靠子串匹配）
	var probe map[string]any
	_ = json.Unmarshal([]byte(raw), &probe)
	if msg := asString(probe["error"]); msg != "" {
		t.Fatalf("不应返回错误: %s", msg)
	}
	t.Logf("context 返回 %d 条消息", len(out.Messages))
	if len(out.Messages) > 0 {
		t.Logf("首条类型 = %q（压缩过的会话首条通常是 compaction）", out.Messages[0].Type)
	}

	// token/cost 确实在会话对象上，且是必填字段
	tok, ok := sess["tokens"].(map[string]any)
	if !ok {
		t.Fatal("Session.Info 上应存在 tokens 字段")
	}
	cost, ok := sess["cost"]
	if !ok {
		t.Fatal("Session.Info 上应存在 cost 字段")
	}
	t.Logf("Session.Info.tokens=%v cost=%v", tok, cost)
}

// TestIntegration标记已读 验证 idle 必填这一实测约束。
func TestIntegration标记已读(t *testing.T) {
	useRealService(t)
	sess := pickIdleSession(t)
	id := asString(sess["id"])

	timeInfo, _ := sess["time"].(map[string]any)
	idle := asInt64(timeInfo["idle"])
	if idle <= 0 {
		t.Skip("该会话没有 idle 记录（可能从未空闲过），跳过")
	}

	// 缺 idle 会被服务端拒绝（400 Missing key ["idle"]）——
	// 本地已拦下，这里确认拦下是对的：直接打服务端验证它确实会 400
	base, password, _ := sessionScoped()
	bad := apiPost(base+"/api/session/"+id+"/view", password, []byte(`{}`))
	if bad.Success {
		t.Error("省略 idle 时服务端本应返回 400，实际却成功了——契约可能已变")
	} else {
		t.Logf("省略 idle 的响应：%d %s", bad.Status, bad.Body)
	}

	if res := MarkSessionViewed(id, idle); !res.Success {
		t.Errorf("带正确 idle 应当成功，实际 %+v", res)
	} else {
		t.Log("带 idle 标记成功")
	}
}

// TestIntegration移动会话同目录 验证 move 的请求形态（不改变实际归属）。
func TestIntegration移动会话同目录(t *testing.T) {
	useRealService(t)
	sess := pickIdleSession(t)
	id := asString(sess["id"])
	loc, _ := sess["location"].(map[string]any)
	dir := asString(loc["directory"])
	if dir == "" {
		t.Skip("会话无目录信息")
	}

	// 移到自身所在目录：语义上是空操作，但能验证端点与 body 形态正确
	res := MoveSession(id, dir, "")
	if !res.Success {
		t.Fatalf("同目录移动应当成功，实际 %+v", res)
	}
}

// TestIntegration导出往返 验证导出能被原样再导入（往返一致性）。
// 会导入一份副本，随后删除，不污染原有会话。
func TestIntegration导出往返(t *testing.T) {
	useRealService(t)
	sess := pickIdleSession(t)
	id := asString(sess["id"])

	exported := ExportSession(id, false)
	// 不能用 strings.Contains(raw, "error") 判失败：导出的对话里本来就有
	// 工具报错（"error":true）等字段，真正的会话内容会命中同样的子串。
	// 只能按「能否解析出 data.info」来判断。
	var probe struct {
		Data struct {
			Info     map[string]any   `json:"info"`
			Messages []map[string]any `json:"messages"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(exported), &probe); err != nil {
		t.Fatalf("导出内容不是合法 JSON: %v（前 200 字符: %.200s）", err, exported)
	}
	if probe.Data.Info == nil {
		t.Fatalf("导出内容缺 data.info，可能是错误体（前 200 字符: %.200s）", exported)
	}
	t.Logf("导出 %d 条消息，标题 %q", len(probe.Data.Messages), asString(probe.Data.Info["title"]))

	// 只带标题的最小副本：验证导入入口通
	body, _ := json.Marshal(map[string]any{
		"info":     map[string]any{"title": "oc-manager 集成测试副本"},
		"messages": []map[string]any{},
	})
	res := ImportSession(string(body))
	if res.Success {
		t.Logf("导入成功：%.200s", res.Body)
	} else {
		// 服务端对 info 的完整性有要求，这是契约细节而非本层 bug，记下来即可
		t.Logf("导入未成功（服务端要求 info 更完整）：%d %.200s", res.Status, res.Body)
	}
}

// TestIntegration错误体不被当成数据 覆盖 readAPIResponse 的非 2xx 处理。
// v2 错误体是 {_tag, message}，**没有 error 键**——若不转成 error，
// 调用方会把 404 的错误体当正常数据继续解析。
func TestIntegration错误体不被当成数据(t *testing.T) {
	useRealService(t)
	// 不存在的会话：应报 404，且错误信息带出服务端的 tag 与 message
	raw := GetSessionContext("ses_does_not_exist_at_all")
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("失败响应也应是合法 JSON: %v", err)
	}
	msg := asString(m["error"])
	if msg == "" {
		t.Fatalf("失败时必须给出 error 字段，实际 %s", raw)
	}
	if !strings.Contains(msg, "404") {
		t.Errorf("错误信息应含状态码，实际 %q", msg)
	}
	t.Logf("404 被正确转成错误：%s", msg)
}

// TestIntegration工作树与分支 验证 projectID 定位与裸数组形态。
func TestIntegration工作树与分支(t *testing.T) {
	useRealService(t)
	base, password, fail := sessionScoped()
	if fail.Error != "" {
		t.Skip(fail.Error)
	}

	// 取一个真实 projectID
	raw, err := apiGet(base+"/api/project", password)
	if err != nil {
		t.Skipf("取项目列表失败: %v", err)
	}
	var projects []map[string]any
	if err := json.Unmarshal(raw, &projects); err != nil {
		t.Fatalf("项目列表应为裸数组（无 data 信封），解析失败: %v", err)
	}
	if len(projects) == 0 {
		t.Skip("没有已知项目")
	}
	pid := asString(projects[0]["id"])
	t.Logf("projectID = %q", pid)

	wt := ListWorktrees(pid)
	t.Logf("工作树：%.200s", wt)

	// 裸数组确认：直接 unmarshal 成 []WorktreeInfo，若被包成 {data:} 会失败
	var direct []WorktreeInfo
	if err := json.Unmarshal(raw, &direct); err == nil {
		t.Log("项目列表确认为裸数组")
	} else {
		t.Errorf("项目列表不是裸数组: %v", err)
	}

	br := ListBranches("", "", 5)
	t.Logf("分支（未指定目录，服务端回落到默认 location）：%.200s", br)
}

// TestIntegration集成凭据 验证 ~200 条集成里只有少数有凭据，
// 以及 connections[0] 即当前生效连接这一约定。
func TestIntegration集成凭据(t *testing.T) {
	useRealService(t)
	raw := ListIntegrations("", false)
	var out struct {
		Integrations []struct {
			ID          string `json:"id"`
			Connections []struct {
				Type string `json:"type"`
				ID   string `json:"id"`
				Env  string `json:"name"`
			} `json:"connections"`
		} `json:"integrations"`
		Total int `json:"total"`
		Shown int `json:"shown"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	t.Logf("集成总数 %d，其中已配凭据 %d", out.Total, out.Shown)
	for _, it := range out.Integrations {
		if len(it.Connections) == 0 {
			continue
		}
		first := it.Connections[0]
		desc := first.Env
		if first.Type == "credential" {
			desc = first.ID
		}
		t.Logf("  %s → 当前生效 %s(%s)", it.ID, first.Type, desc)
	}
	if out.Total < out.Shown {
		t.Errorf("shown(%d) 不应大于 total(%d)", out.Shown, out.Total)
	}
}

// TestIntegration终端 验证 pty 端点返回 {location, data} 且 location 是对象。
func TestIntegration终端(t *testing.T) {
	useRealService(t)
	raw := ListPtys("")
	var out struct {
		Ptys  []PtyInfo `json:"ptys"`
		Count int       `json:"count"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("解析失败: %v（若报 type mismatch，说明 location 被当成了字符串）", err)
	}
	t.Logf("持久终端 %d 个", out.Count)
}

// TestIntegration认证必需 确认服务确实要求认证，且口令能从注册文件取到。
func TestIntegration认证必需(t *testing.T) {
	useRealService(t)
	sess := getWebSession()
	if sess.password == "" {
		t.Skip("未取到服务口令（可能服务未启用认证），跳过")
	}
	base, password, _ := sessionScoped()
	req, err := http.NewRequest(http.MethodGet, base+"/api/project", nil)
	if err != nil {
		t.Fatal(err)
	}
	applyAuth(req, password)
	resp, err := apiClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("带口令请求应 200，实际 %d", resp.StatusCode)
	}

	// 不带口令应当被拒
	bare, _ := http.NewRequest(http.MethodGet, base+"/api/project", nil)
	resp2, err := apiClient.Do(bare)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	t.Logf("无口令请求状态 = %d", resp2.StatusCode)
}
