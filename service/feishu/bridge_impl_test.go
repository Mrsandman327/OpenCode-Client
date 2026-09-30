//go:build feishu

package feishu

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// ============ 测试替身 ============

// fakeOC 是 OpenCode 接口的测试替身。
//
// 每个方法都记录调用，因此除了断言返回值还能断言「有没有被调用」——
// 「没调用」是这类桥接层最常见的静默失败。
type fakeOC struct {
	mu sync.Mutex

	created      []string // CreateSession 的 directory
	prompts      []string // SendPrompt 的文本
	interrupts   []string
	renames      []string
	deletes      []string
	compacts     []string
	modelSet     []string
	forkedFrom   []string
	stagedRevert []string
	committed    []string
	cleared      []string
	repliedPerm  []string

	sessions   []SessionSummary
	perms      []PermissionRequest
	forms      map[string]FormInfo
	usage      Usage
	diffs      []FileDiffStat
	revertTgt  []RevertTarget
	exportData string
	serverInfo ServerInfo

	// failOn 让指定操作返回错误，验证错误路径
	failOn string

	// getFormCalls 记录 GetForm 的调用（formID 或 "sessionID|formID"）。
	getFormCalls []string
	// getFormErr 让 GetForm 返回错误。
	getFormErr error

	// subscribed 记录 SubscribeEvents 被调用的会话 ID。
	subscribed []string
	// unsubCount 记录退订函数被调用的次数。
	unsubCount int
	// handlers 持有当前的订阅回调，便于测试手动喂事件。
	handlers []EventCallback
	// subscribeErr 让订阅返回错误。
	subscribeErr error
	// activeSub 标记当前是否有活跃订阅（用于断言关停确实收了它）。
	activeSub bool
}

// SubscribeEvents 记录订阅并保存回调。
//
// 真实实现在独立 goroutine 里读 SSE；这里保持同步注册，
// 便于测试用 emit 精确投递事件。
func (f *fakeOC) SubscribeEvents(sessionID string, cb EventCallback) (func(), error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.subscribeErr != nil {
		return nil, f.subscribeErr
	}
	f.subscribed = append(f.subscribed, sessionID)
	f.handlers = append(f.handlers, cb)
	f.activeSub = true
	var once sync.Once
	return func() {
		once.Do(func() {
			f.mu.Lock()
			f.unsubCount++
			f.activeSub = false
			f.mu.Unlock()
		})
	}, nil
}

// emit 向当前所有订阅投递一条事件。
func (f *fakeOC) emit(ev AgentEvent) {
	f.mu.Lock()
	handlers := make([]EventCallback, len(f.handlers))
	copy(handlers, f.handlers)
	f.mu.Unlock()
	for _, h := range handlers {
		h(ev)
	}
}

// hasSub 是否有活跃订阅。
func (f *fakeOC) hasSub() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.activeSub
}

// unsubCalls 返回退订次数。
func (f *fakeOC) unsubCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.unsubCount
}

func (f *fakeOC) shouldFail(op string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.failOn == op
}

func (f *fakeOC) CreateSession(directory, model string) (string, error) {
	f.mu.Lock()
	f.created = append(f.created, directory)
	f.mu.Unlock()
	if f.shouldFail("create") {
		return "", fmt.Errorf("模拟创建失败")
	}
	return "ses_new", nil
}

func (f *fakeOC) SendPrompt(sessionID, text, delivery string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failOn == "prompt" {
		return fmt.Errorf("模拟发送失败")
	}
	f.prompts = append(f.prompts, text)
	return nil
}

func (f *fakeOC) ListSessions(directory, parentID string, limit int) ([]SessionSummary, error) {
	if f.shouldFail("list") {
		return nil, fmt.Errorf("模拟列表失败")
	}
	return f.sessions, nil
}

func (f *fakeOC) Interrupt(sessionID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failOn == "interrupt" {
		return fmt.Errorf("模拟中止失败")
	}
	f.interrupts = append(f.interrupts, sessionID)
	return nil
}

func (f *fakeOC) RenameSession(sessionID, title string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failOn == "rename" {
		return fmt.Errorf("模拟重命名失败")
	}
	f.renames = append(f.renames, title)
	return nil
}

func (f *fakeOC) CompactSession(sessionID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.compacts = append(f.compacts, sessionID)
	return nil
}

func (f *fakeOC) SessionUsage(sessionID string) (Usage, error) { return f.usage, nil }

func (f *fakeOC) SessionDiff(sessionID string) ([]FileDiffStat, error) {
	return f.diffs, nil
}

func (f *fakeOC) ListPermissions(sessionID string) ([]PermissionRequest, error) {
	return f.perms, nil
}

// GetForm 返回登记的表单。
//
// 找不到时返回错误而不是零值 FormInfo：真实实现在这种情况下也会
// 报错（见 RealOpenCode.GetForm 的空响应判别），返回一个「有 ID 没
// fields」的零值会让测试测不到真正的失败路径。
func (f *fakeOC) GetForm(sessionID, formID string) (FormInfo, error) {
	f.mu.Lock()
	f.getFormCalls = append(f.getFormCalls, sessionID+"|"+formID)
	f.mu.Unlock()
	if f.getFormErr != nil {
		return FormInfo{}, f.getFormErr
	}
	form, ok := f.forms[formID]
	if !ok {
		return FormInfo{}, fmt.Errorf("模拟：表单 %s 不存在", formID)
	}
	return form, nil
}

func (f *fakeOC) ReplyPermission(sessionID, requestID, decision string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failOn == "replyPerm" {
		return fmt.Errorf("模拟回复失败")
	}
	f.repliedPerm = append(f.repliedPerm, requestID+":"+decision)
	return nil
}

func (f *fakeOC) DeleteSession(sessionID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failOn == "delete" {
		return fmt.Errorf("模拟删除失败")
	}
	f.deletes = append(f.deletes, sessionID)
	return nil
}

func (f *fakeOC) ForkSession(sessionID, before string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.forkedFrom = append(f.forkedFrom, before)
	return "ses_forked", nil
}

func (f *fakeOC) SetModel(sessionID, model string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failOn == "setModel" {
		return fmt.Errorf("模拟切换失败")
	}
	f.modelSet = append(f.modelSet, model)
	return nil
}

func (f *fakeOC) ExportSession(sessionID string) (string, error) {
	if f.exportData == "" {
		f.exportData = `{"info":{},"messages":[]}`
	}
	return f.exportData, nil
}

func (f *fakeOC) ServerInfo() (ServerInfo, error) {
	if f.shouldFail("serverInfo") {
		return ServerInfo{}, fmt.Errorf("模拟服务端信息失败")
	}
	return f.serverInfo, nil
}

func (f *fakeOC) ListRevertTargets(sessionID string, limit int) ([]RevertTarget, error) {
	return f.revertTgt, nil
}

func (f *fakeOC) StageRevert(sessionID, messageID string, revertFiles bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failOn == "stageRevert" {
		return fmt.Errorf("模拟暂存失败")
	}
	f.stagedRevert = append(f.stagedRevert, messageID)
	return nil
}

func (f *fakeOC) CommitRevert(sessionID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.committed = append(f.committed, sessionID)
	return nil
}

func (f *fakeOC) ClearRevert(sessionID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cleared = append(f.cleared, sessionID)
	return nil
}

// fakeOut 记录发送内容。
type fakeOut struct {
	mu       sync.Mutex
	texts    []string
	cards    []*Card
	failSend bool

	// updates 记录每次 UpdateCard 的卡片内容（按顺序）。
	updates []string
	// updateFails 为 true 时 UpdateCard 失败，返回 updateResult。
	// 默认成功：真实的 UpdateCard 绝大多数时候是成功的，
	// 失败路径必须显式打开，否则节流测的是「一直失败」而不是节流。
	updateFails bool
	// updateResult 是 updateFails 为 true 时的返回内容。
	updateResult SendResult
	updateErr    error
	// failCard 让 SendCard 失败（占位卡发不出去）。
	failCard bool
	// updateIDs 记录被更新的 messageID。
	updateIDs []string
}

func (o *fakeOut) SendText(ctx context.Context, chatID, text string) (string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.failSend {
		return "", fmt.Errorf("模拟发送失败")
	}
	o.texts = append(o.texts, text)
	return "om_1", nil
}

func (o *fakeOut) SendCard(ctx context.Context, chatID string, card *Card) (string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.failCard {
		return "", fmt.Errorf("模拟发卡失败")
	}
	o.cards = append(o.cards, card)
	return fmt.Sprintf("om_card_%d", len(o.cards)), nil
}

// UpdateCard 实现 CardUpdater，使 fakeOut 能参与流式渲染测试。
func (o *fakeOut) UpdateCard(ctx context.Context, messageID string, card *Card) (SendResult, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.updateIDs = append(o.updateIDs, messageID)
	o.updates = append(o.updates, card.MustJSON())
	if !o.updateFails {
		return SendResult{Success: true}, nil
	}
	if o.updateErr != nil {
		return o.updateResult, o.updateErr
	}
	return o.updateResult, fmt.Errorf("模拟更新失败 code=%d", 230025)
}

// updateTexts 返回每次更新的卡片正文（按顺序）。
func (o *fakeOut) updateTexts() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := make([]string, 0, len(o.updates))
	for _, raw := range o.updates {
		var probe struct {
			Body struct {
				Elements []struct {
					Content string `json:"content"`
				} `json:"elements"`
			} `json:"body"`
		}
		if err := json.Unmarshal([]byte(raw), &probe); err != nil {
			continue
		}
		for _, el := range probe.Body.Elements {
			if el.Content != "" {
				out = append(out, el.Content)
			}
		}
	}
	return out
}

// updateCount 返回更新次数。
func (o *fakeOut) updateCount() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.updates)
}

// noUpdateOut 只支持发消息、不支持更新卡片。
//
// 刻意**不内嵌** fakeOut：内嵌会把 UpdateCard 一起带进来，
// 于是这个替身仍然满足 CardUpdater，测不出「不支持流式」这条路径。
type noUpdateOut struct {
	mu    sync.Mutex
	cards []*Card
}

func (o *noUpdateOut) SendText(ctx context.Context, chatID, text string) (string, error) {
	return "om_1", nil
}

func (o *noUpdateOut) SendCard(ctx context.Context, chatID string, card *Card) (string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.cards = append(o.cards, card)
	return "om_card_1", nil
}

// lastText 返回最后一条文本。
func (o *fakeOut) lastText() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.texts) == 0 {
		return ""
	}
	return o.texts[len(o.texts)-1]
}

func (o *fakeOut) allText() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return strings.Join(o.texts, "\n---\n")
}

func (o *fakeOut) cardJSON(t *testing.T, idx int) string {
	t.Helper()
	o.mu.Lock()
	defer o.mu.Unlock()
	raw, err := o.cards[idx].JSON()
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal([]byte(raw), &m)
	b, _ := json.Marshal(m)
	return string(b)
}

// newTestBridge 建一套「默认放行」的测试环境。
//
// 默认放行是刻意的：AccessPolicy.AllowAllUsers 的零值是 false，
// 若沿用调用方传入的零值，所有非门禁测试都会被门禁挡住——
// 它们实际在测门禁，而不是各自要测的东西，且失败原因会指向
// 完全不相干的地方。门禁测试请用 newGatedBridge。
func newTestBridge(t *testing.T, oc *fakeOC, cfg BridgeConfig) (*Bridge, *fakeOut, *SessionMap, *Whitelist) {
	t.Helper()
	cfg.AllowAllUsers = true
	return newBridgeWith(t, oc, cfg)
}

// newGatedBridge 建一套「默认收紧」的测试环境，仅供门禁测试使用。
func newGatedBridge(t *testing.T, oc *fakeOC, cfg BridgeConfig) (*Bridge, *fakeOut, *SessionMap, *Whitelist) {
	t.Helper()
	cfg.AllowAllUsers = false
	return newBridgeWith(t, oc, cfg)
}

func newBridgeWith(t *testing.T, oc *fakeOC, cfg BridgeConfig) (*Bridge, *fakeOut, *SessionMap, *Whitelist) {
	t.Helper()
	out := &fakeOut{}
	dir := t.TempDir()
	sm := NewSessionMap(dir + "/sessions.json")
	wl := NewWhitelist(dir + "/whitelist.json")
	return NewBridge(oc, out, sm, wl, cfg), out, sm, wl
}

func msg(text string) IncomingMessage {
	return IncomingMessage{ChatID: "oc_chat", UserID: "ou_user", Text: text}
}

// ============ 门禁 ============

// Test未授权用户不能驱动任何操作 是最关键的安全行为。
func Test未授权用户不能驱动任何操作(t *testing.T) {
	oc := &fakeOC{}
	b, _, _, _ := newGatedBridge(t, oc, BridgeConfig{
		AdminUserIDs: []string{"ou_admin"},
	})
	// 管理员能建会话
	admin := IncomingMessage{ChatID: "oc_chat", UserID: "ou_admin", Text: "/new /proj"}
	b.HandleMessage(context.Background(), admin)
	if len(oc.created) != 1 {
		t.Fatalf("管理员应能建会话，实际调用 %d 次", len(oc.created))
	}

	// 收紧后，未授权用户的任何消息都应被拒
	oc2 := &fakeOC{}
	b2, out2, _, _ := newGatedBridge(t, oc2, BridgeConfig{
		AdminUserIDs: []string{"ou_admin"},
	})
	b2.HandleMessage(context.Background(), msg("/new /proj"))
	if len(oc2.created) != 0 {
		t.Errorf("未授权用户不应能建会话，实际调用 %d 次", len(oc2.created))
	}
	if !strings.Contains(out2.allText(), "无访问权限") {
		t.Error("应回复无权限")
	}

	// 未授权用户的普通消息也不该被送进 OpenCode
	oc3 := &fakeOC{}
	b3, _, _, _ := newGatedBridge(t, oc3, BridgeConfig{})
	b3.HandleMessage(context.Background(), msg("帮我删掉所有文件"))
	if len(oc3.prompts) != 0 {
		t.Errorf("未授权用户的普通消息不应被发送，实际 %d 条", len(oc3.prompts))
	}
}

func Test默认放行任何人(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{})
	b.HandleMessage(context.Background(), msg("/new /proj"))
	if len(oc.created) != 1 {
		t.Error("默认放行时任何人都应能用")
	}
	if strings.Contains(out.allText(), "无访问权限") {
		t.Error("不应出现无权限提示")
	}
}

func Test白名单内用户可用(t *testing.T) {
	oc := &fakeOC{}
	b, _, _, wl := newGatedBridge(t, oc, BridgeConfig{})
	wl.Add("ou_member")
	b.HandleMessage(context.Background(), IncomingMessage{
		ChatID: "oc_chat", UserID: "ou_member", Text: "/new /proj",
	})
	if len(oc.created) != 1 {
		t.Error("白名单内用户应可用")
	}
}

// ============ 命令路由 ============

func Test命令被分发不被当普通消息(t *testing.T) {
	oc := &fakeOC{}
	b, _, sm, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	if len(oc.prompts) != 0 {
		t.Error("命令不应被送进 prompt")
	}
	if sm.Get("oc_chat").SessionID != "ses_new" {
		t.Error("命令未生效")
	}
}

func Test普通消息推进会话(t *testing.T) {
	oc := &fakeOC{}
	b, _, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("帮我看看代码"))
	if len(oc.prompts) != 1 || oc.prompts[0] != "帮我看看代码" {
		t.Errorf("普通消息应被发送，实际 %v", oc.prompts)
	}
}

func Test未绑定会话时提示先新建(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{})
	b.HandleMessage(context.Background(), msg("随便说点什么"))
	if len(oc.prompts) != 0 {
		t.Error("未绑定时不应发送")
	}
	if !strings.Contains(out.lastText(), "/new") {
		t.Errorf("应提示先 /new: %s", out.lastText())
	}
}

// Test句中出现的斜杠不误判 「路径是 C:/Users/x」里的 /Users 不是命令。
func Test句中出现的斜杠不误判(t *testing.T) {
	oc := &fakeOC{}
	b, _, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("看下 C:/Users/x 这个路径"))
	if len(oc.prompts) != 1 || !strings.Contains(oc.prompts[0], "C:/Users/x") {
		t.Errorf("应整条作为普通消息发送，实际 %v", oc.prompts)
	}
}

func Test管理员命令对非管理员拒绝(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, wl := newTestBridge(t, oc, BridgeConfig{AdminUserIDs: []string{"ou_admin"}})
	b.HandleMessage(context.Background(), msg("/whitelist_list"))
	if !strings.Contains(out.lastText(), "仅限管理员") {
		t.Errorf("非管理员应被拒: %s", out.lastText())
	}
	if wl.Len() != 0 {
		t.Error("不应有任何副作用")
	}
}

func Test管理员可用白名单命令(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, wl := newTestBridge(t, oc, BridgeConfig{AdminUserIDs: []string{"ou_admin"}})
	admin := IncomingMessage{ChatID: "oc_chat", UserID: "ou_admin", Text: "/whitelist_add ou_new"}
	b.HandleMessage(context.Background(), admin)
	if !wl.Has("ou_new") {
		t.Error("管理员应能加入白名单")
	}
	_ = out
}

// Test白名单命令在放行态下说明无效原因 只说「已添加」会让管理员
// 以为收紧已经生效了。
func Test白名单命令在放行态下说明无效原因(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{AdminUserIDs: []string{"ou_admin"}})
	admin := IncomingMessage{ChatID: "oc_chat", UserID: "ou_admin", Text: "/whitelist_add ou_x"}
	b.HandleMessage(context.Background(), admin)
	txt := out.lastText()
	if !strings.Contains(txt, "allow_all_users") {
		t.Errorf("放行态下应说明白名单不生效: %s", txt)
	}
}

func Test白名单列表在放行态告警(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, wl := newTestBridge(t, oc, BridgeConfig{AdminUserIDs: []string{"ou_admin"}})
	wl.Add("ou_x")
	admin := IncomingMessage{ChatID: "oc_chat", UserID: "ou_admin", Text: "/whitelist_list"}
	b.HandleMessage(context.Background(), admin)
	if !strings.Contains(out.lastText(), "不参与鉴权") {
		t.Errorf("应提示白名单当前不生效: %s", out.lastText())
	}
}

// Test收紧态添加说明已生效 放行态与收紧态的回执必须不同：
// 收紧态下添加是真的生效了，不该再带「不参与鉴权」的告警。
func Test收紧态添加说明已生效(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, wl := newGatedBridge(t, oc, BridgeConfig{AdminUserIDs: []string{"ou_admin"}})
	admin := IncomingMessage{ChatID: "oc_chat", UserID: "ou_admin", Text: "/whitelist_add ou_x"}
	b.HandleMessage(context.Background(), admin)
	if !wl.Has("ou_x") {
		t.Fatal("应已加入")
	}
	txt := out.lastText()
	if strings.Contains(txt, "不参与鉴权") {
		t.Errorf("收紧态下不应再告警白名单无效: %s", txt)
	}
	if !strings.Contains(txt, "现在可以使用") {
		t.Errorf("应说明已生效: %s", txt)
	}
}

// Test放行态重复添加也告警 重复添加走的是「已存在」分支，
// 该分支同样必须带告警。
func Test放行态重复添加也告警(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, wl := newTestBridge(t, oc, BridgeConfig{AdminUserIDs: []string{"ou_admin"}})
	wl.Add("ou_x")
	admin := IncomingMessage{ChatID: "oc_chat", UserID: "ou_admin", Text: "/whitelist_add ou_x"}
	b.HandleMessage(context.Background(), admin)
	if !strings.Contains(out.lastText(), "allow_all_users") {
		t.Errorf("重复添加也应告警: %s", out.lastText())
	}
}

// ============ 破坏性命令的两步确认 ============

// Test删除需两步确认 一步到位意味着用户没有反悔机会。
func Test删除需两步确认(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/delete"))

	if len(oc.deletes) != 0 {
		t.Fatal("第一次 /delete 不应真删")
	}
	if !strings.Contains(out.lastText(), "confirm") {
		t.Errorf("应提示 confirm: %s", out.lastText())
	}
	if !strings.Contains(out.lastText(), "不可恢复") {
		t.Error("应警示不可恢复")
	}

	b.HandleMessage(context.Background(), msg("/delete confirm"))
	if len(oc.deletes) != 1 || oc.deletes[0] != "ses_new" {
		t.Errorf("confirm 后应删除: %v", oc.deletes)
	}
}

func Test删除可取消(t *testing.T) {
	oc := &fakeOC{}
	b, _, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/delete"))
	b.HandleMessage(context.Background(), msg("/delete cancel"))
	if len(oc.deletes) != 0 {
		t.Error("取消后不应删除")
	}
	// 取消后再 confirm 不应生效
	b.HandleMessage(context.Background(), msg("/delete confirm"))
	if len(oc.deletes) != 0 {
		t.Error("取消后 confirm 不应删���")
	}
}

func Test无待确认时confirm提示(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/delete confirm"))
	if len(oc.deletes) != 0 {
		t.Error("无待确认时不应删除")
	}
	if !strings.Contains(out.lastText(), "没有待确认") {
		t.Errorf("应说明没有待确认: %s", out.lastText())
	}
}

// Test待确认时普通消息不推进对话 否则用户随手一句话就被当成
// 对删除操作的回应。
func Test待确认时普通消息不推进对话(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/delete"))
	oc.prompts = nil

	b.HandleMessage(context.Background(), msg("等一下"))
	if len(oc.prompts) != 0 {
		t.Error("待确认期间的普通消息不应被送进 OpenCode")
	}
	if !strings.Contains(out.lastText(), "cancel") {
		t.Errorf("应引导用户确认或取消: %s", out.lastText())
	}
}

func Test待确认过期(t *testing.T) {
	oc := &fakeOC{}
	b, _, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/delete"))

	// 把待确认状态改成 11 分钟前
	b.mu.Lock()
	b.pending["oc_chat"].CreatedAt = time.Now().Add(-11 * time.Minute)
	b.mu.Unlock()

	b.HandleMessage(context.Background(), msg("/delete confirm"))
	if len(oc.deletes) != 0 {
		t.Error("过期的确认不应生效")
	}
}

// Test待确认按会话隔离 A 的确认不能作用到 B 的会话。
func Test待确认按会话隔离(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/delete"))

	// 另一个会话发起 confirm，不应命中 A 的待确认
	b.HandleMessage(context.Background(), IncomingMessage{
		ChatID: "oc_other", UserID: "ou_user", Text: "/delete confirm",
	})
	if len(oc.deletes) != 0 {
		t.Error("跨会话的 confirm 不应生效")
	}
	_ = out
}

func Test删除失败给出错误(t *testing.T) {
	oc := &fakeOC{failOn: "delete"}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/delete"))
	b.HandleMessage(context.Background(), msg("/delete confirm"))
	if !strings.Contains(out.lastText(), "删除失败") {
		t.Errorf("应给出失败信息: %s", out.lastText())
	}
}

// ============ revert ============

func TestRevert三步(t *testing.T) {
	oc := &fakeOC{revertTgt: []RevertTarget{
		{MessageID: "msg_1", Label: "2026-09-01 10:00"},
		{MessageID: "msg_2", Label: "2026-09-01 11:00"},
	}}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))

	// 列出
	b.HandleMessage(context.Background(), msg("/revert"))
	if !strings.Contains(out.lastText(), "msg_1") {
		t.Errorf("应列出可回滚位置: %s", out.lastText())
	}
	if len(oc.stagedRevert) != 0 {
		t.Error("仅列出不应暂存")
	}

	// 暂存
	b.HandleMessage(context.Background(), msg("/revert 2"))
	if len(oc.stagedRevert) != 1 || oc.stagedRevert[0] != "msg_2" {
		t.Errorf("应暂存第 2 个: %v", oc.stagedRevert)
	}
	if len(oc.committed) != 0 {
		t.Error("暂存不应提交")
	}

	// 提交
	b.HandleMessage(context.Background(), msg("/revert confirm"))
	if len(oc.committed) != 1 {
		t.Errorf("confirm 应提交: %v", oc.committed)
	}
}

func TestRevert取消清服务端暂存(t *testing.T) {
	oc := &fakeOC{revertTgt: []RevertTarget{{MessageID: "msg_1", Label: "x"}}}
	b, _, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/revert 1"))
	b.HandleMessage(context.Background(), msg("/revert cancel"))
	// 不清服务端暂存的话，下次 revert 会带着旧的暂存
	if len(oc.cleared) != 1 {
		t.Errorf("取消应清服务端暂存: %v", oc.cleared)
	}
	if len(oc.committed) != 0 {
		t.Error("取消不应提交")
	}
}

func TestRevert序号越界(t *testing.T) {
	oc := &fakeOC{revertTgt: []RevertTarget{{MessageID: "msg_1", Label: "x"}}}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/revert 99"))
	if len(oc.stagedRevert) != 0 {
		t.Error("越界不应暂存")
	}
	if !strings.Contains(out.lastText(), "超出范围") {
		t.Errorf("应提示越界: %s", out.lastText())
	}
}

func TestRevert无目标(t *testing.T) {
	oc := &fakeOC{revertTgt: nil}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/revert"))
	if !strings.Contains(out.lastText(), "没有可回滚") {
		t.Errorf("应说明无可回滚位置: %s", out.lastText())
	}
}

// ============ 会话选择 ============

// Test会话卡只给主会话生成按钮 子会话切过去会让主对话线分叉且无返回入口。
func Test会话卡只给主会话生成按钮(t *testing.T) {
	oc := &fakeOC{sessions: []SessionSummary{
		{ID: "ses_root", Title: "主会话", Updated: 1790645535868},
		{ID: "ses_c1", Title: "子1", ParentID: "ses_root", Updated: 1790645535869},
		{ID: "ses_c2", Title: "子2", ParentID: "ses_root", Updated: 1790645535870},
	}}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/sessions"))

	if len(out.cards) != 1 {
		t.Fatalf("应发一张会话卡，实际 %d 张", len(out.cards))
	}
	btns := buttonsOf(t, out.cards[0])
	if len(btns) != 1 {
		t.Fatalf("按钮数 = %d, 期望 1（只有主会话可点）", len(btns))
	}
	if btns[0].Behaviors[0].Value["session_id"] != "ses_root" {
		t.Errorf("按钮应属主会话: %v", btns[0].Behaviors[0].Value)
	}
	txt := out.cardJSON(t, 0)
	if !strings.Contains(txt, "2 个子会话") {
		t.Errorf("子会话应给条数: %s", txt)
	}
	if strings.Contains(txt, "子1") || strings.Contains(txt, "子2") {
		t.Error("子会话明细不应出现在卡上（只给条数）")
	}
}

func Test会话卡按关键词过滤(t *testing.T) {
	oc := &fakeOC{sessions: []SessionSummary{
		{ID: "ses_a", Title: "重构认证模块"},
		{ID: "ses_b", Title: "写文档"},
	}}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/sessions 认证"))
	if len(out.cards) != 1 {
		t.Fatalf("应发卡: %d", len(out.cards))
	}
	txt := out.cardJSON(t, 0)
	if !strings.Contains(txt, "重构认证模块") {
		t.Error("应保留命中项")
	}
	if strings.Contains(txt, "写文档") {
		t.Error("不应保留未命中项")
	}
}

func Test会话卡无结果给提示(t *testing.T) {
	oc := &fakeOC{sessions: []SessionSummary{{ID: "ses_a", Title: "x"}}}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/sessions 不存在的东西"))
	if len(out.cards) != 0 {
		t.Error("无结果不应发卡")
	}
	if !strings.Contains(out.lastText(), "没有标题含") {
		t.Errorf("应说明无匹配: %s", out.lastText())
	}
}

// Test序号只在一级会话中取 与卡片按钮顺序一致，
// 否则「/use 2」切到的会话和点第二个按钮不是一个。
func Test序号只在一级会话中取(t *testing.T) {
	oc := &fakeOC{sessions: []SessionSummary{
		{ID: "ses_root1", Title: "主1"},
		{ID: "ses_child", Title: "子", ParentID: "ses_root1"},
		{ID: "ses_root2", Title: "主2"},
	}}
	b, _, sm, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/use 2"))
	// 两个主会话，序号 2 应是 ses_root2 而不是 ses_child
	if got := sm.Get("oc_chat").SessionID; got != "ses_root2" {
		t.Errorf("/use 2 切到 %q, 期望 ses_root2（序号只数一级会话）", got)
	}
}

func Test序号越界提示(t *testing.T) {
	oc := &fakeOC{sessions: []SessionSummary{{ID: "ses_a", Title: "A"}}}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/use 9"))
	if !strings.Contains(out.lastText(), "超出范围") {
		t.Errorf("应提示越界: %s", out.lastText())
	}
}

func Test会话ID直接切换(t *testing.T) {
	oc := &fakeOC{}
	b, _, sm, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/use ses_explicit"))
	if got := sm.Get("oc_chat").SessionID; got != "ses_explicit" {
		t.Errorf("应切到指定会话，实际 %q", got)
	}
}

// Test显式指定子会话可用 /sessions 卡片不提供子会话按钮防误触，
// 但显式 /use <子会话ID> 是用户有意的意图，应当允许。
func Test显式指定子会话可用(t *testing.T) {
	oc := &fakeOC{}
	b, _, sm, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/use ses_child_explicit"))
	if got := sm.Get("oc_chat").SessionID; got != "ses_child_explicit" {
		t.Error("显式指定子会话应允许")
	}
}

// ============ 其它命令 ============

func TestUsage发卡片(t *testing.T) {
	oc := &fakeOC{usage: Usage{Cost: 1.5, Tokens: TokenUsage{Input: 100, Output: 200}}}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/usage"))
	if len(out.cards) != 1 {
		t.Fatalf("应发用量卡，实际 %d 张", len(out.cards))
	}
	if !strings.Contains(out.cardJSON(t, 0), "1.5000") {
		t.Error("卡里应含费用")
	}
}

func TestDiff发卡片(t *testing.T) {
	oc := &fakeOC{diffs: []FileDiffStat{{File: "a.go", Additions: 3, Deletions: 1, Status: "modified"}}}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/diff"))
	if len(out.cards) != 1 {
		t.Fatalf("应发改动卡，实际 %d 张", len(out.cards))
	}
	if !strings.Contains(out.cardJSON(t, 0), "a.go") {
		t.Error("卡里应含文件名")
	}
}

func TestPermissions逐条发卡(t *testing.T) {
	oc := &fakeOC{perms: []PermissionRequest{
		{ID: "per_1", Action: "bash", Resources: []string{"ls"}},
		{ID: "per_2", Action: "write", Resources: []string{"a.go"}},
	}}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/permissions"))
	if len(out.cards) != 2 {
		t.Errorf("每条请求应一张卡，实际 %d 张", len(out.cards))
	}
}

func TestPermissions为空给提示(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/permissions"))
	if !strings.Contains(out.lastText(), "没有待审批") {
		t.Errorf("应说明无待审批: %s", out.lastText())
	}
}

func TestModel切换并记录(t *testing.T) {
	oc := &fakeOC{}
	b, _, sm, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/model openai/gpt-5.4"))
	if len(oc.modelSet) != 1 || oc.modelSet[0] != "openai/gpt-5.4" {
		t.Errorf("应设置模型: %v", oc.modelSet)
	}
	// /status 要能显示当前模型，因此必须记进映射
	if got := sm.Get("oc_chat").Model; got != "openai/gpt-5.4" {
		t.Errorf("模型未记入映射: %q", got)
	}
}

func TestModel缺参数提示(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/model"))
	if len(oc.modelSet) != 0 {
		t.Error("缺参数不应设置")
	}
	if !strings.Contains(out.lastText(), "用法") {
		t.Errorf("应给用法: %s", out.lastText())
	}
}

func TestFork切到新会话(t *testing.T) {
	oc := &fakeOC{}
	b, _, sm, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/fork msg_before"))
	if got := sm.Get("oc_chat").SessionID; got != "ses_forked" {
		t.Errorf("分叉后应切到新会话，实际 %q", got)
	}
	if len(oc.forkedFrom) != 1 || oc.forkedFrom[0] != "msg_before" {
		t.Errorf("应带分叉点: %v", oc.forkedFrom)
	}
}

func TestExport说明体积而非发截断片段(t *testing.T) {
	oc := &fakeOC{exportData: strings.Repeat("x", 5000)}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/export"))
	txt := out.lastText()
	// 把截断片段当「导出结果」发出去会误导
	if strings.Contains(txt, strings.Repeat("x", 100)) {
		t.Error("不应把大段内容塞进飞书消息")
	}
	if !strings.Contains(txt, "5000") {
		t.Errorf("应说明实际大小: %s", txt)
	}
}

func TestServerStatus(t *testing.T) {
	oc := &fakeOC{serverInfo: ServerInfo{Version: "2.0.15", Address: "http://127.0.0.1:49374", PID: 10620}}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{})
	b.HandleMessage(context.Background(), msg("/server_status"))
	txt := out.lastText()
	for _, want := range []string{"2.0.15", "49374", "10620"} {
		if !strings.Contains(txt, want) {
			t.Errorf("缺 %s: %s", want, txt)
		}
	}
}

func TestServerStatus失败(t *testing.T) {
	oc := &fakeOC{failOn: "serverInfo"}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{})
	b.HandleMessage(context.Background(), msg("/server_status"))
	if !strings.Contains(out.lastText(), "失败") {
		t.Errorf("应给出失败: %s", out.lastText())
	}
}

func TestSwitchProject解除绑定(t *testing.T) {
	oc := &fakeOC{}
	b, out, sm, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/projA"})
	b.HandleMessage(context.Background(), msg("/new"))
	if !sm.Bound("oc_chat") {
		t.Fatal("应已绑定")
	}
	b.HandleMessage(context.Background(), msg("/switch_project /projB"))
	// 继续用旧会话会让 agent 在旧目录读写，而用户以为已切过去
	if sm.Bound("oc_chat") {
		t.Error("换项目应解除原绑定")
	}
	if !strings.Contains(out.lastText(), "/projB") {
		t.Errorf("应回显新项目: %s", out.lastText())
	}
	if !strings.Contains(out.lastText(), "没有删除") {
		t.Error("应说明会话没被删除")
	}
}

// TestNewSession沿用切换后的项目 /switch_project 之后执行 /new_session，
// 应当开在新项目下。用默认项目会让切换看起来没生效。
func TestNewSession沿用切换后的项目(t *testing.T) {
	oc := &fakeOC{}
	b, _, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/projA"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/switch_project /projB"))
	oc.created = nil
	b.HandleMessage(context.Background(), msg("/new_session"))
	if len(oc.created) != 1 || oc.created[0] != "/projB" {
		t.Errorf("/new_session 应使用切换后的项目 /projB，实际 %v", oc.created)
	}
}

// TestNewSession未切换时用默认项目
func TestNewSession未切换时用默认项目(t *testing.T) {
	oc := &fakeOC{}
	b, _, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/projA"})
	b.HandleMessage(context.Background(), msg("/new_session"))
	if len(oc.created) != 1 || oc.created[0] != "/projA" {
		t.Errorf("无切换记录时应回落默认项目，实际 %v", oc.created)
	}
}

func TestNew无路径且无默认给提示(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{})
	b.HandleMessage(context.Background(), msg("/new"))
	if len(oc.created) != 0 {
		t.Error("不应瞎猜项目")
	}
	if !strings.Contains(out.lastText(), "需要指定项目路径") {
		t.Errorf("应要求指定路径: %s", out.lastText())
	}
}

func TestClear只解绑不删(t *testing.T) {
	oc := &fakeOC{}
	b, out, sm, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	b.HandleMessage(context.Background(), msg("/clear"))
	if sm.Bound("oc_chat") {
		t.Error("应已解绑")
	}
	if len(oc.deletes) != 0 {
		t.Error("clear 不应删服务端会话")
	}
	if !strings.Contains(out.lastText(), "没有被删除") {
		t.Errorf("应说明会话没被删除: %s", out.lastText())
	}
}

func TestHelp标注破坏性命令(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{})
	b.HandleMessage(context.Background(), msg("/help"))
	txt := out.lastText()
	if !strings.Contains(txt, "⚠️") {
		t.Error("破坏性命令应带警示标注")
	}
	if !strings.Contains(txt, "/delete") {
		t.Error("应列出 /delete")
	}
}

// ============ 未实现命令不静默 ============

// Test所有命令都有实现 分发表漏一条的表现是静默无响应，
// 而静默无响应会被用户当成「机器人坏了」。
//
// 卡片型命令（/usage、/diff、/sessions、/permissions）只发卡不发文本，
// 因此必须同时统计卡与文本，否则会把它们误判成「未实现」。
func Test所有命令都有实现(t *testing.T) {
	oc := &fakeOC{
		sessions:  []SessionSummary{{ID: "ses_a", Title: "A"}},
		revertTgt: []RevertTarget{{MessageID: "msg_1", Label: "x"}},
	}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{
		DefaultProject: "/proj",
		AdminUserIDs:   []string{"ou_user"},
	})
	// 先建一个会话，让依赖会话的命令有前提
	b.HandleMessage(context.Background(), msg("/new"))

	for _, c := range commands {
		out.texts = nil
		out.cards = nil
		b.HandleMessage(context.Background(), msg("/"+c.Name))
		if len(out.texts) == 0 && len(out.cards) == 0 {
			t.Errorf("/%s 无任何响应（可能是分发表漏了）", c.Name)
			continue
		}
		if n := len(out.texts); n > 0 && strings.Contains(out.texts[n-1], "尚未实现") {
			t.Errorf("/%s 未实现", c.Name)
		}
	}
}

// ============ 错误路径不 panic ============

// Test发送失败不崩 发送失败本身就是失败路径，
// 再 panic 会拖垮整个事件循环。
func Test发送失败不崩(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{})
	out.failSend = true
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("发送失败时 panic: %v", r)
		}
	}()
	b.HandleMessage(context.Background(), msg("/help"))
	b.HandleMessage(context.Background(), msg("/new /proj"))
}

// TestOpenCode报错不崩 服务端各种异常都不应让事件循环挂掉。
func TestOpenCode报错不崩(t *testing.T) {
	ops := []string{"create", "prompt", "interrupt", "rename", "setModel", "delete"}
	for _, op := range ops {
		oc := &fakeOC{failOn: op}
		b, _, _, _ := newTestBridge(t, oc, BridgeConfig{AllowAllUsers: true, DefaultProject: "/proj"})
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("op=%s 时 panic: %v", op, r)
				}
			}()
			b.HandleMessage(context.Background(), msg("/new"))
			b.HandleMessage(context.Background(), msg("/title 新名"))
			b.HandleMessage(context.Background(), msg("/abort"))
			b.HandleMessage(context.Background(), msg("/model a/b"))
			b.HandleMessage(context.Background(), msg("/delete"))
			b.HandleMessage(context.Background(), msg("/delete confirm"))
			b.HandleMessage(context.Background(), msg("普通消息"))
		}()
	}
}

func Test空消息不处理(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{AllowAllUsers: true, DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("   "))
	if len(oc.prompts) != 0 || len(out.texts) != 0 {
		t.Error("空消息不应产生任何动作")
	}
}
