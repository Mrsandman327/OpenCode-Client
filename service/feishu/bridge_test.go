//go:build feishu

package feishu

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// ============ 访问门禁 ============

// Test门禁默认放行是刻意设计：保留默认放行是为了让升级不产生
// 「配错就把自己锁在外面」的故障。测试锁住这个语义不被无意改掉。
func Test门禁默认放行(t *testing.T) {
	if !IsUserAllowed("ou_anyone", AccessPolicy{AllowAllUsers: true}) {
		t.Error("AllowAllUsers=true 时应放行任何人（含未知用户）")
	}
	if !IsUserAllowed("", AccessPolicy{AllowAllUsers: true}) {
		t.Error("AllowAllUsers=true 时连空 ID 也放行")
	}
}

func Test门禁关闭后放行授权者(t *testing.T) {
	p := AccessPolicy{
		AllowAllUsers: false,
		AdminUserIDs:  []string{"ou_admin"},
		Whitelist:     []string{"ou_a", "ou_b"},
	}
	for _, id := range []string{"ou_admin", "ou_a", "ou_b"} {
		if !IsUserAllowed(id, p) {
			t.Errorf("%s 应放行", id)
		}
	}
	if IsUserAllowed("ou_stranger", p) {
		t.Error("未授权用户应被拒")
	}
}

func Test门禁拒绝空ID(t *testing.T) {
	// 空 ID 必须拒绝：否则配置里出现空串就会被匿名绕过
	p := AccessPolicy{
		AllowAllUsers: false,
		AdminUserIDs:  []string{""},
		Whitelist:     []string{""},
	}
	if IsUserAllowed("", p) {
		t.Error("空 userID 必须拒绝，即使集合里也有空串")
	}
}

func Test门禁告警仅在放行态(t *testing.T) {
	if !ShouldWarnOpenAccess(AccessPolicy{AllowAllUsers: true}) {
		t.Error("放行态应告警")
	}
	if ShouldWarnOpenAccess(AccessPolicy{AllowAllUsers: false}) {
		t.Error("收紧后不应再告警")
	}
}

func Test告警文案含收紧方式(t *testing.T) {
	withAdmin := OpenAccessWarning(2)
	if !strings.Contains(withAdmin, "allow_all_users = false") {
		t.Error("应给出收紧配置的具体方式")
	}
	if !strings.Contains(withAdmin, "2") {
		t.Error("应说明当前管理员数量")
	}

	noAdmin := OpenAccessWarning(0)
	if !strings.Contains(noAdmin, "/whitelist_add") {
		t.Error("无管理员时应提示用命令添加")
	}
}

func Test拒绝文案可操作(t *testing.T) {
	txt := DeniedReply()
	if !strings.Contains(txt, "/whitelist_add") {
		t.Error("应给出开通方式")
	}
	if !strings.Contains(txt, "用户ID") {
		t.Error("应说明去哪看用户ID")
	}
}

// ============ 会话映射 ============

func Test会话映射基本读写(t *testing.T) {
	m := NewSessionMap("")
	if m.Bound("oc_chat") {
		t.Error("初始不应已绑定")
	}
	if got := m.Get("oc_chat"); got.SessionID != "" || got.ProjectPath != "" {
		t.Errorf("未绑定应返回零值: %+v", got)
	}

	m.Bind("oc_chat", "ses_1", "E:\\work", "openai/gpt-5.4")
	got := m.Get("oc_chat")
	if got.SessionID != "ses_1" {
		t.Errorf("SessionID = %q", got.SessionID)
	}
	if got.ProjectPath != "E:\\work" {
		t.Errorf("ProjectPath = %q", got.ProjectPath)
	}
	if !m.Bound("oc_chat") {
		t.Error("绑定后 Bound 应为 true")
	}

	m.Unbind("oc_chat")
	if m.Bound("oc_chat") {
		t.Error("解绑后不应再绑定")
	}
}

// Test会话映射并发安全 飞书事件与卡片回调在不同 goroutine 触发。
func Test会话映射并发安全(t *testing.T) {
	m := NewSessionMap("")
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(3)
		go func(i int) { defer wg.Done(); m.Bind("oc_chat", "ses_"+strconv.Itoa(i), "/p", "") }(i)
		go func() { defer wg.Done(); _ = m.Get("oc_chat") }()
		go func() { defer wg.Done(); m.Unbind("oc_other") }()
	}
	wg.Wait()
}

// Test映射持久化往返 绑定需持久化：重启后应继续上次对话。
func Test映射持久化往返(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sessions.json")

	m := NewSessionMap(path)
	m.Bind("oc_a", "ses_1", "E:\\work", "m1")
	m.Bind("oc_b", "ses_2", "E:\\other", "")

	m2 := NewSessionMap(path)
	if got := m2.Get("oc_a"); got.SessionID != "ses_1" || got.ProjectPath != "E:\\work" {
		t.Errorf("重启后应恢复绑定: %+v", got)
	}
	if got := m2.Get("oc_b"); got.SessionID != "ses_2" {
		t.Errorf("第二个绑定未恢复: %+v", got)
	}
}

// Test映射文件损坏降级为空 映射丢失只是丢历史会话，
// 不该让整个程序起不来。
func Test映射文件损坏降级为空(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sessions.json")
	if err := os.WriteFile(path, []byte("{ 损坏的 json"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := NewSessionMap(path)
	if m.Len() != 0 {
		t.Errorf("损坏文件应降级为空，实际 %d 条", m.Len())
	}
}

func Test映射缺文件不报错(t *testing.T) {
	m := NewSessionMap(filepath.Join(t.TempDir(), "nope.json"))
	if m.Len() != 0 {
		t.Error("缺文件应为空映射")
	}
}

func Test映射自动建目录(t *testing.T) {
	path := filepath.Join(t.TempDir(), "deep", "nested", "sessions.json")
	m := NewSessionMap(path)
	m.Bind("oc_a", "ses_1", "/p", "")
	if _, err := os.Stat(path); err != nil {
		t.Errorf("应自动创建目录并落盘: %v", err)
	}
}

func Test映射无路径时纯内存(t *testing.T) {
	m := NewSessionMap("")
	m.Bind("oc_a", "ses_1", "/p", "")
	if m.Get("oc_a").SessionID != "ses_1" {
		t.Error("无路径时仍应在内存中可用")
	}
}

func Test映射裁剪到上限(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sessions.json")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	// 直接构造超量数据，绕过逐条绑定的时间戳递增
	items := map[string]*ChatSession{}
	for i := 0; i < maxPersistedSessions+50; i++ {
		items["oc_"+strconv.Itoa(i)] = &ChatSession{
			SessionID: "ses_" + strconv.Itoa(i),
			// 让 oc_0 最新、其余递减，便于断言保留的是最近的
			UpdatedAt: int64(maxPersistedSessions+50-i) * 1000,
		}
	}
	raw, _ := json.Marshal(items)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	m := NewSessionMap(path)
	m.Set("oc_trigger", ChatSession{SessionID: "ses_trigger"})
	// Set 触发裁剪
	if m.Len() > maxPersistedSessions {
		t.Errorf("裁剪后仍超上限: %d > %d", m.Len(), maxPersistedSessions)
	}
	// 最新的必须还在
	if m.Get("oc_0").SessionID == "" {
		t.Error("最久未活跃前的最近一条被误删")
	}
}

// ============ 命令解析 ============

func Test解析命令(t *testing.T) {
	cases := []struct {
		in   string
		name string
		args string
	}{
		{"/help", "help", ""},
		{"  /help  ", "help", ""},
		{"/use 3", "use", "3"},
		{"/title 新的名字", "title", "新的名字"},
		{"/whitelist_add ou_abc", "whitelist_add", "ou_abc"},
	}
	for _, c := range cases {
		cmd, args, ok := ParseCommand(c.in)
		if !ok {
			t.Errorf("%q 应识别为命令", c.in)
			continue
		}
		if cmd.Name != c.name {
			t.Errorf("%q 命令名 = %q, 期望 %q", c.in, cmd.Name, c.name)
		}
		if args != c.args {
			t.Errorf("%q 参数 = %q, 期望 %q", c.in, args, c.args)
		}
	}
}

// Test普通文本不误判为命令 句中出现的 /xxx 是普通文本，
// 不该被吞成命令。
func Test普通文本不误判为命令(t *testing.T) {
	cases := []string{
		"你好",
		"帮我看下 /api/session 这个路径",
		"路径是 C:/Users/x",
		"",
		"   ",
		"/",
	}
	for _, in := range cases {
		if _, _, ok := ParseCommand(in); ok {
			t.Errorf("%q 不应识别为命令", in)
		}
	}
}

// Test未知命令不吞掉 未识别的 /xxx 更可能是用户在说一句话，
// 交回普通消息处理比静默丢弃好。
func Test未知命令不吞掉(t *testing.T) {
	if _, _, ok := ParseCommand("/nonexistent foo"); ok {
		t.Error("未知命令不应被识别（否则用户说的话会被吞掉）")
	}
}

func Test按管理员过滤命令(t *testing.T) {
	user := CommandsFor(false)
	admin := CommandsFor(false)
	adminList := CommandsFor(true)

	if len(adminList) <= len(user) {
		t.Errorf("管理员可见命令应更多: user=%d admin=%d", len(user), len(adminList))
	}
	_ = admin
	for _, c := range user {
		if c.AdminOnly {
			t.Errorf("非管理员不应看到管理员命令 %q", c.Name)
		}
	}
	// 每个可见命令都应有描述与用法
	for _, c := range adminList {
		if c.Description == "" || c.Usage == "" {
			t.Errorf("命令 %q 缺描述或用法", c.Name)
		}
	}
}

func TestIsAdmin(t *testing.T) {
	admins := []string{"ou_1", "ou_2"}
	if !IsAdmin("ou_1", admins) {
		t.Error("ou_1 应是管理员")
	}
	if IsAdmin("ou_3", admins) {
		t.Error("ou_3 不应是管理员")
	}
	if IsAdmin("", admins) {
		t.Error("空 ID 不应是管理员")
	}
	if IsAdmin("ou_1", nil) {
		t.Error("空管理员列表不应有人是管理员")
	}
}

func Test所有命令无重名(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range commands {
		if seen[c.Name] {
			t.Errorf("命令名重复: %q", c.Name)
		}
		seen[c.Name] = true
		for _, a := range c.Aliases {
			if seen[a] {
				t.Errorf("别名与其他命令名冲突: %q", a)
			}
			seen[a] = true
		}
	}
}
