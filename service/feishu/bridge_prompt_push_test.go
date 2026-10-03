//go:build feishu

// bridge_prompt_push_test.go —— 「向用户提问」卡片的推送
//
// 这一层曾整条缺失：V2 的 form.created 事件翻译出来了、渲染层也停了心跳，
// 但**没有任何代码把问题卡推给用户**。症状是流式卡上写着
// 「正在等待你回答问题卡片…」，而用户手上什么都没有。
package feishu

import (
	"context"
	"strings"
	"testing"
)

// pushForm 往测试替身里登记一张表单。
func pushForm(oc *fakeOC, form FormInfo) *fakeOC {
	if oc.forms == nil {
		oc.forms = map[string]FormInfo{}
	}
	oc.forms[form.ID] = form
	return oc
}

// lastCardJSON 返回最后一张卡的 JSON。
func lastCardJSON(t *testing.T, out *fakeOut) string {
	t.Helper()
	out.mu.Lock()
	defer out.mu.Unlock()
	if len(out.cards) == 0 {
		t.Fatal("一张卡都没发出")
	}
	return out.cards[len(out.cards)-1].MustJSON()
}

// TestFormCreated真的推出问题卡 这是本文件最核心的一条：
// 事件翻译对了、渲染层也处理了，但没有推送就等于没做。
func TestFormCreated真的推出问题卡(t *testing.T) {
	oc := pushForm(&fakeOC{}, realForm)
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	// 占位卡之外应多出一张 form 卡
	before := len(out.cards)
	oc.emit(AgentEvent{Type: EvFormCreated, Properties: EventProps{
		SessionID: "ses_1", FormID: realForm.ID,
	}})

	if len(out.cards) != before+1 {
		t.Fatalf("收到 form.created 后应多推一张卡，实际 %d → %d", before, len(out.cards))
	}
	got := lastCardJSON(t, out)
	// 问题卡必须带上真实字段，否则用户看到的是一张空表单
	if !strings.Contains(got, "重启哪个进程") {
		t.Errorf("问题卡应含字段标题: %s", got)
	}
	if !strings.Contains(got, "重启预览用的 HTTP 服务") {
		t.Errorf("问题卡应含候选项: %s", got)
	}
	// ⚠️ 不能断言 ActionFormSubmit 出现在卡上：schema 2.0 的
	// form_action 按钮**没有 value.action**（见 form_card.go 注释），
	// 提交靠 behaviors 识别。断言错的东西会让人以为该改成 value.action。
	if !strings.Contains(got, BehaviorFormAction) || !strings.Contains(got, "submit_btn") {
		t.Errorf("问题卡应含提交按钮（form_action）: %s", got)
	}
}

// TestFormCreated先查详情再渲染 事件只带 formID、不带 fields。
// 不查就渲染等于发一张空表单——用户以为「机器人没问真问题」。
func TestFormCreated先查详情再渲染(t *testing.T) {
	oc := pushForm(&fakeOC{}, realForm)
	b, _ := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	oc.emit(AgentEvent{Type: EvFormCreated, Properties: EventProps{
		SessionID: "ses_1", FormID: realForm.ID,
	}})

	oc.mu.Lock()
	calls := append([]string(nil), oc.getFormCalls...)
	oc.mu.Unlock()
	want := "ses_1|" + realForm.ID
	if len(calls) != 1 || calls[0] != want {
		t.Errorf("GetForm 调用 = %v, 期望 [%s]", calls, want)
	}
}

// TestFormCreated带会话与表单ID 卡片里 form 容器的 name 由 form.ID 生成，
// 服务端偶尔不回填，缺了它提交就找不到对应的 form。
func TestFormCreated带会话与表单ID(t *testing.T) {
	// 服务端只回 fields，不回 id / sessionID（实测里出现过）
	oc := &fakeOC{forms: map[string]FormInfo{
		"frm_from_event": {Fields: realForm.Fields},
	}}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	oc.emit(AgentEvent{Type: EvFormCreated, Properties: EventProps{
		SessionID: "ses_1", FormID: "frm_from_event",
	}})

	got := lastCardJSON(t, out)
	if !strings.Contains(got, "opencode_form_frm_from_event") {
		t.Errorf("form 容器名应回退用事件里的 formID: %s", got)
	}
}

// TestFormCreated同一form只推一次 卡片会长期留在聊天记录里，
// 重复推送等于让用户对着两张一样的卡不知道该点哪张。
func TestFormCreated同一form只推一次(t *testing.T) {
	oc := pushForm(&fakeOC{}, realForm)
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	before := len(out.cards)
	ev := AgentEvent{Type: EvFormCreated, Properties: EventProps{
		SessionID: "ses_1", FormID: realForm.ID,
	}}
	oc.emit(ev)
	oc.emit(ev)
	oc.emit(ev)

	if got := len(out.cards) - before; got != 1 {
		t.Errorf("同一 form 重复事件应只推 1 张卡，实际推了 %d 张", got)
	}
}

// TestFormCreated取不到详情要告知 静默失败最难查：流式卡已经写着
// 「在等你回答」，用户会一直等一张永远不来的卡。
func TestFormCreated取不到详情要告知(t *testing.T) {
	oc := &fakeOC{getFormErr: errNoEventSubscriber}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	nCards := len(out.cards)
	oc.emit(AgentEvent{Type: EvFormCreated, Properties: EventProps{
		SessionID: "ses_1", FormID: "frm_missing",
	}})

	// 不能推一张空表单
	if len(out.cards) != nCards {
		t.Errorf("取不到详情时不应推卡（会渲染成空表单），实际多发 %d 张", len(out.cards)-nCards)
	}
	if !strings.Contains(out.lastText(), "问题卡片加载失败") {
		t.Errorf("必须明确告知用户: %s", out.lastText())
	}
	if !strings.Contains(out.lastText(), "/abort") {
		t.Errorf("应给出可操作的下一步: %s", out.lastText())
	}
}

// TestFormCreated先渲染等待提示再推卡 顺序反了的话，用户可能在流式卡
// 上还看到「正在思考」就去点问题卡，两张卡自相矛盾。
func TestFormCreated先渲染等待提示再推卡(t *testing.T) {
	oc := pushForm(&fakeOC{}, realForm)
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	nUpdates := out.updateCount()
	oc.emit(AgentEvent{Type: EvFormCreated, Properties: EventProps{
		SessionID: "ses_1", FormID: realForm.ID,
	}})

	// 等待提示是**更新**流式卡（不是新卡），问题卡是**新卡**
	if out.updateCount() <= nUpdates {
		t.Error("流式卡应先被更新为「在等你回答」")
	}
	if !strings.Contains(strings.Join(out.updateTexts(), "|"), "回答问题卡片") {
		t.Error("流式卡应写明在等用户回答问题卡片")
	}
}

// TestFormCreated仍停心跳 与权限卡同理：被 form 卡住时
// message.complete / session.idle 永远不会来，心跳若继续转，
// 卡片会永远显示「正在思考」。
func TestFormCreated仍停心跳(t *testing.T) {
	oc := pushForm(&fakeOC{}, realForm)
	b, _ := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	turn := b.currentTurn("oc_chat")
	oc.emit(AgentEvent{Type: EvFormCreated, Properties: EventProps{
		SessionID: "ses_1", FormID: realForm.ID,
	}})

	if !turn.heartbeatStopped() {
		t.Error("form 卡住时必须停心跳")
	}
}

// ============ 权限卡 ============

// TestPermissionAsked真的推出审批卡 你的清单里说「对照权限卡有真实推送」，
// 实际并没有：唯一推它的地方是 `/permissions` 命令，而 V2 是 inbox 式
// 执行——本轮被权限卡住时 message.complete / session.idle 永远不会来，
// 用户不主动敲命令就永远看不到这张卡。
func TestPermissionAsked真的推出审批卡(t *testing.T) {
	oc := &fakeOC{perms: []PermissionRequest{{
		ID: "per_1", Action: "bash", Resources: []string{"ls"},
		Message: "执行 ls", Save: []string{"shell:ls"},
	}}}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	nCards := len(out.cards)
	oc.emit(AgentEvent{Type: EvPermissionAsked, Properties: EventProps{
		SessionID: "ses_1", PermissionID: "per_1",
	}})

	if len(out.cards) != nCards+1 {
		t.Fatalf("收到 permission.asked 后应多推一张卡，实际 %d → %d", nCards, len(out.cards))
	}
	got := lastCardJSON(t, out)
	// 事件只带 requestID，动作与资源必须靠 ListPermissions 补齐
	if !strings.Contains(got, "执行 ls") {
		t.Errorf("审批卡应含请求说明: %s", got)
	}
	if !strings.Contains(got, ActionPermissionAllowOnce) {
		t.Errorf("审批卡应含允许动作: %s", got)
	}
	if !strings.Contains(got, "per_1") {
		t.Errorf("审批卡应带 request_id: %s", got)
	}
}

// TestPermissionAsked只推匹配的那张 同一会话可能有多个待审请求，
// 推错一张等于让用户批了不相干的操作。
func TestPermissionAsked只推匹配的那张(t *testing.T) {
	oc := &fakeOC{perms: []PermissionRequest{
		{ID: "per_a", Action: "bash", Resources: []string{"rm -rf /"}, Message: "危险 A"},
		{ID: "per_b", Action: "read", Resources: []string{"a.go"}, Message: "普通 B"},
	}}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	nCards := len(out.cards)
	oc.emit(AgentEvent{Type: EvPermissionAsked, Properties: EventProps{
		SessionID: "ses_1", PermissionID: "per_b",
	}})

	if len(out.cards) != nCards+1 {
		t.Fatalf("应只推 1 张，实际 %d", len(out.cards)-nCards)
	}
	got := lastCardJSON(t, out)
	if !strings.Contains(got, "普通 B") {
		t.Errorf("应推 per_b: %s", got)
	}
	if strings.Contains(got, "危险 A") {
		t.Errorf("不应把 per_a 一起推出来: %s", got)
	}
}

// TestPermissionAsked同一请求只推一次 同 form。
func TestPermissionAsked同一请求只推一次(t *testing.T) {
	oc := &fakeOC{perms: []PermissionRequest{{ID: "per_1", Action: "bash", Resources: []string{"ls"}}}}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	nCards := len(out.cards)
	ev := AgentEvent{Type: EvPermissionAsked, Properties: EventProps{
		SessionID: "ses_1", PermissionID: "per_1",
	}}
	oc.emit(ev)
	oc.emit(ev)

	if got := len(out.cards) - nCards; got != 1 {
		t.Errorf("同一请求应只推 1 张，实际 %d", got)
	}
}

// TestPermissionAsked请求已消失则不推 推一张点下去只会报错的卡
// 比不推更糟。
func TestPermissionAsked请求已消失则不推(t *testing.T) {
	oc := &fakeOC{perms: []PermissionRequest{{ID: "per_other", Action: "bash"}}}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	nCards := len(out.cards)
	oc.emit(AgentEvent{Type: EvPermissionAsked, Properties: EventProps{
		SessionID: "ses_1", PermissionID: "per_gone",
	}})

	if len(out.cards) != nCards {
		t.Errorf("请求已不在待审列表时不应推卡，实际多发 %d 张", len(out.cards)-nCards)
	}
}

// TestForm与Permission去重互不干扰 键前缀不同，form 的 ID 与
// 权限的 requestID 即使字面相同也不该互相抑制。
func TestForm与Permission去重互不干扰(t *testing.T) {
	oc := pushForm(&fakeOC{}, realForm)
	oc.perms = []PermissionRequest{{ID: "X", Action: "bash", Resources: []string{"ls"}}}
	oc.forms["X"] = FormInfo{ID: "X", Fields: realForm.Fields}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	nCards := len(out.cards)
	oc.emit(AgentEvent{Type: EvFormCreated, Properties: EventProps{SessionID: "ses_1", FormID: "X"}})
	oc.emit(AgentEvent{Type: EvPermissionAsked, Properties: EventProps{SessionID: "ses_1", PermissionID: "X"}})

	if got := len(out.cards) - nCards; got != 2 {
		t.Errorf("同名字符的 form 与权限应各推一张，实际推了 %d 张", got)
	}
}

// TestClose后不再推卡 关停期间不该再往一个已停的连接发卡片。
func TestClose后不再推卡(t *testing.T) {
	oc := pushForm(&fakeOC{}, realForm)
	b, out := bindSession(t, oc, "ses_1")

	b.HandleMessage(context.Background(), msg("hi"))
	b.Close()

	nCards := len(out.cards)
	// 直接调回调：关停后已无事件可投，这条锁的是回调自身的门禁
	b.onFormCreated("oc_chat", "ses_1")(realForm.ID)
	if len(out.cards) != nCards {
		t.Error("Close 后不应再推卡")
	}
}

// ============ 提交侧 ============

// Test表单提交按FormValue识别 这是 form 问答的另一半，同样曾经整条缺失。
//
// schema 2.0 的 form_action 按钮**没有 value.action**，只有控件值。
// 而 `HandleCardAction` 原先只按 value.action 分派——act 恒为空串，
// `case act == ActionFormSubmit` 永远不命中，用户点「提交」只会收到
// 「该卡片没有可执行的操作」。
//
// 症状隐蔽到极点：卡片渲染完全正常，`form_card_test.go` 全绿，
// 断的只是「点提交」这一步。
func Test表单提交按FormValue识别(t *testing.T) {
	oc := &fakeOC{}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleCardAction(context.Background(), CardAction{
		ChatID:    "oc_chat",
		UserID:    "ou_user",
		MessageID: "om_form",
		// 关键：Value 为空（卡片上没有 action），只有控件值
		Value:     nil,
		FormValue: map[string]any{"f0_q0": "启动 BMALL 服务"},
		FormName:  "opencode_form_frm_1",
	})

	oc.mu.Lock()
	prompts := append([]string(nil), oc.prompts...)
	oc.mu.Unlock()
	if len(prompts) != 1 {
		t.Fatalf("点提交应产生一条回答，实际 %d 条", len(prompts))
	}
	if prompts[0] != "启动 BMALL 服务" {
		t.Errorf("回答内容 = %q", prompts[0])
	}
	// 回执必须是「已回答」卡，而不是「没有可执行的操作」
	got := lastCardJSON(t, out)
	if !strings.Contains(got, "已回答") {
		t.Errorf("应发已回答回执: %s", got)
	}
}

// Test表单提交不会被当成未知动作 这是上条的门禁：不能退回到
// 「这个按钮来自旧版本的卡片」这类误导性提示。
func Test表单提交不会被当成未知动作(t *testing.T) {
	oc := &fakeOC{}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleCardAction(context.Background(), CardAction{
		ChatID:    "oc_chat",
		UserID:    "ou_user",
		FormValue: map[string]any{"f0_q0": "x"},
	})

	if strings.Contains(out.lastText(), "没有可执行的操作") {
		t.Errorf("表单提交不应回「该卡片没有可执行的操作」: %s", out.lastText())
	}
	if strings.Contains(out.lastText(), "旧版本") {
		t.Errorf("表单提交不应回「旧版本卡片」: %s", out.lastText())
	}
}

// Test普通按钮不受FormValue判定影响 加了 FormValue 前置判定之后，
// 必须确认它没有把会话切换 / 权限审批之类的正常按钮误吞。
func Test普通按钮不受FormValue判定影响(t *testing.T) {
	oc := &fakeOC{}
	b, out := bindSession(t, oc, "ses_1")

	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat",
		UserID: "ou_user",
		Value:  map[string]any{"action": ActionSessionSelect, "session_id": "ses_other"},
	})

	sm := b.sessions
	if got := sm.Get("oc_chat").SessionID; got != "ses_other" {
		t.Errorf("会话切换按钮应照常生效，实际 %q", got)
	}
	if strings.Contains(out.lastText(), "没有收到任何答案") {
		t.Errorf("普通按钮不应走表单分支: %s", out.lastText())
	}
}

// Test空FormValue仍报「没有收到任何答案」 FormValue 前置判定之后，
// 原本 handleFormSubmit 里的这道校验变成了不可达。删掉它会让
// 「提交了空表单」变成一次静默成功。
func Test空FormValue仍报没有收到任何答案(t *testing.T) {
	oc := &fakeOC{}
	b, out := bindSession(t, oc, "ses_1")

	// 显式带上 action（走那条保留的分支），FormValue 为空
	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat",
		UserID: "ou_user",
		Value:  map[string]any{"action": ActionFormSubmit},
	})

	if !strings.Contains(out.lastText(), "没有收到任何答案") {
		t.Errorf("空提交应明确报错: %s", out.lastText())
	}
}
