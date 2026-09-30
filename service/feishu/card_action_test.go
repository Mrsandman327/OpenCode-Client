//go:build feishu

package feishu

import (
	"context"
	"strings"
	"testing"
)

// ============ 会话选择 ============

func Test会话选择切换绑定(t *testing.T) {
	oc := &fakeOC{}
	b, out, sm, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user",
		Value: map[string]any{
			"action":     ActionSessionSelect,
			"session_id": "ses_picked",
		},
	})
	if got := sm.Get("oc_chat").SessionID; got != "ses_picked" {
		t.Errorf("应切到选中会话，实际 %q", got)
	}
	// 回执应是卡片而不是文本：用户点了按钮就该在按钮所在处看到反应
	if len(out.cards) == 0 {
		t.Error("应发回执卡片")
	} else if !strings.Contains(out.cardJSON(t, 0), "已切换会话") {
		t.Error("回执应说明已切换")
	}
}

func Test会话选择缺ID提示(t *testing.T) {
	oc := &fakeOC{}
	b, out, sm, _ := newTestBridge(t, oc, BridgeConfig{})
	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user",
		Value: map[string]any{"action": ActionSessionSelect},
	})
	if strings.Contains(out.allText(), "已切换") {
		t.Error("缺 ID 时不应声称切换成功")
	}
	if !strings.Contains(out.lastText(), "缺少会话 ID") {
		t.Errorf("应说明缺 ID: %s", out.lastText())
	}
	if sm.Bound("oc_chat") {
		t.Error("不应产生绑定")
	}
}

// Test卡片回调也过门禁 拿到旧卡片的人点一下就能绕过消息侧限制，
// 而卡片会长期留在聊天记录里，比消息更容易被转发。
func Test卡片回调也过门禁(t *testing.T) {
	oc := &fakeOC{}
	b, out, sm, _ := newGatedBridge(t, oc, BridgeConfig{})
	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_stranger",
		Value: map[string]any{
			"action":     ActionSessionSelect,
			"session_id": "ses_victim",
		},
	})
	if sm.Bound("oc_chat") {
		t.Error("未授权用户不应能通过卡片切换会话")
	}
	if !strings.Contains(out.allText(), "无访问权限") {
		t.Error("应回复无权限")
	}

	// 权限批准同样要拦——否则未授权用户能放行任意工具调用
	oc2 := &fakeOC{}
	b2, _, sm2, _ := newGatedBridge(t, oc2, BridgeConfig{})
	b2.sessions.Bind("oc_chat", "ses_1", "/p", "")
	b2.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_stranger",
		Value: map[string]any{
			"action":     ActionPermissionAllowOnce,
			"request_id": "per_1",
		},
	})
	if len(oc2.repliedPerm) != 0 {
		t.Error("未授权用户不应能批准权限请求")
	}
	_ = sm2
}

// ============ 权限回复 ============

// Test三种权限决策映射 卡片 action 名与 V2 的 decision 取值不同，
// 映射错一位就会批准错的东西。
func Test三种权限决策映射(t *testing.T) {
	cases := []struct {
		action string
		want   string
	}{
		{ActionPermissionAllowOnce, "once"},
		{ActionPermissionAllowAlways, "always"},
		{ActionPermissionReject, "reject"},
	}
	for _, c := range cases {
		oc := &fakeOC{}
		b, _, sm, _ := newTestBridge(t, oc, BridgeConfig{})
		sm.Bind("oc_chat", "ses_1", "/p", "")
		b.HandleCardAction(context.Background(), CardAction{
			ChatID: "oc_chat", UserID: "ou_user",
			Value: map[string]any{
				"action":     c.action,
				"request_id": "per_1",
			},
		})
		if len(oc.repliedPerm) != 1 {
			t.Fatalf("%s 应回复一次，实际 %d", c.action, len(oc.repliedPerm))
		}
		if oc.repliedPerm[0] != "per_1:"+c.want {
			t.Errorf("%s 映射为 %q, 期望 per_1:%s", c.action, oc.repliedPerm[0], c.want)
		}
	}
}

// Test权限回复过期可辨识 用户以为拒绝了而其实什么都没发生，
// 是这类失败最糟的形态。
func Test权限回复过期可辨识(t *testing.T) {
	oc := &fakeOC{failOn: "replyPerm"}
	b, out, sm, _ := newTestBridge(t, oc, BridgeConfig{})
	sm.Bind("oc_chat", "ses_1", "/p", "")
	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user",
		Value: map[string]any{
			"action":     ActionPermissionAllowOnce,
			"request_id": "per_gone",
		},
	})
	txt := out.lastText()
	if !strings.Contains(txt, "失败") {
		t.Errorf("应明确失败: %s", txt)
	}
	if !strings.Contains(txt, "已过期") {
		t.Errorf("应提示可能已过期: %s", txt)
	}
}

func Test权限回复未绑定会话(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{})
	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user",
		Value: map[string]any{
			"action":     ActionPermissionAllowOnce,
			"request_id": "per_1",
		},
	})
	if len(oc.repliedPerm) != 0 {
		t.Error("未绑定会话时不应回复")
	}
	if !strings.Contains(out.lastText(), "没有绑定会话") {
		t.Errorf("应说明未绑定: %s", out.lastText())
	}
}

func Test权限回复缺请求ID(t *testing.T) {
	oc := &fakeOC{}
	b, out, sm, _ := newTestBridge(t, oc, BridgeConfig{})
	sm.Bind("oc_chat", "ses_1", "/p", "")
	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user",
		Value: map[string]any{"action": ActionPermissionAllowOnce},
	})
	if len(oc.repliedPerm) != 0 {
		t.Error("缺 request_id 时不应回复")
	}
	if !strings.Contains(out.lastText(), "缺少请求 ID") {
		t.Errorf("应说明缺 ID: %s", out.lastText())
	}
}

// ============ 未知 action ============

// Test旧卡片明确失效 点了没反应会被当成卡片坏了。
func Test旧卡片明确失效(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{})
	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user",
		Value: map[string]any{"action": "some_removed_action"},
	})
	if !strings.Contains(out.lastText(), "旧版本") {
		t.Errorf("应说明卡片已失效: %s", out.lastText())
	}
}

func Test无action值给提示(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{})
	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user", Value: nil,
	})
	if !strings.Contains(out.lastText(), "没有可执行的操作") {
		t.Errorf("应说明无可执行操作: %s", out.lastText())
	}
}

// ============ 表单答案解析 ============

func Test解析控件名(t *testing.T) {
	cases := []struct {
		in       string
		idx      int
		key      string
		isCustom bool
	}{
		{"f0_q0", 0, "q0", false},
		{"f12_q0", 12, "q0", false},
		{"f0_q0__custom", 0, "q0", true},
		{"f3_answer", 3, "answer", false},
		// 不符合命名的一律拒绝，不能把控件名当答案塞给 OpenCode
		{"submit_btn", 0, "", false},
		{"f_abc", 0, "", false},
		{"f0_", 0, "", false},
		{"q0", 0, "", false},
		{"", 0, "", false},
		{"fx_key", 0, "", false},
	}
	for _, c := range cases {
		idx, key, custom := parseFieldControl(c.in)
		if key != c.key {
			t.Errorf("parseFieldControl(%q) key = %q, 期望 %q", c.in, key, c.key)
		}
		if c.key != "" {
			if idx != c.idx {
				t.Errorf("parseFieldControl(%q) idx = %d, 期望 %d", c.in, idx, c.idx)
			}
			if custom != c.isCustom {
				t.Errorf("parseFieldControl(%q) custom = %v, 期望 %v", c.in, custom, c.isCustom)
			}
		}
	}
}

func Test收集表单答案按索引排序(t *testing.T) {
	a := CardAction{FormValue: map[string]any{
		"f1_second": "答案二",
		"f0_first":  "答案一",
	}}
	got := collectFormAnswers(a)
	if len(got) != 2 {
		t.Fatalf("答案数 = %d: %v", len(got), got)
	}
	// 顺序必须与表单字段一致，否则 OpenCode 收到的是错位的答案
	if got[0] != "答案一" || got[1] != "答案二" {
		t.Errorf("顺序错误: %v", got)
	}
}

// Test自填优先于候选项 用户填了自定义答案就说明他不想用候选项。
func Test自填优先于候选项(t *testing.T) {
	a := CardAction{FormValue: map[string]any{
		"f0_q0":         "候选项A",
		"f0_q0__custom": "我自己写的",
	}}
	got := collectFormAnswers(a)
	if len(got) != 1 || got[0] != "我自己写的" {
		t.Errorf("自填应覆盖候选项，实际 %v", got)
	}
}

func Test多选取值拼接(t *testing.T) {
	a := CardAction{FormValue: map[string]any{
		"f0_q0": []any{"A", "B", "C"},
	}}
	got := collectFormAnswers(a)
	if len(got) != 1 || got[0] != "A、B、C" {
		t.Errorf("多选应拼接为顿号分隔，实际 %v", got)
	}
}

func Test空答案被忽略(t *testing.T) {
	a := CardAction{FormValue: map[string]any{
		"f0_q0": "   ",
		"f1_q1": nil,
		"f2_q2": "",
	}}
	if got := collectFormAnswers(a); len(got) != 0 {
		t.Errorf("空答案应被忽略，实际 %v", got)
	}
}

func Test非控件名被忽略(t *testing.T) {
	a := CardAction{FormValue: map[string]any{
		"submit_btn": "提交",
		"f0_q0":      "真答案",
	}}
	got := collectFormAnswers(a)
	if len(got) != 1 || got[0] != "真答案" {
		t.Errorf("应只取控件字段，实际 %v", got)
	}
}

func TestStringifyFormValue(t *testing.T) {
	if got := stringifyFormValue(nil); got != "" {
		t.Errorf("nil 应为空: %q", got)
	}
	if got := stringifyFormValue("  x  "); got != "x" {
		t.Errorf("应去空白: %q", got)
	}
	if got := stringifyFormValue(true); got != "是" {
		t.Errorf("布尔应转中文: %q", got)
	}
	if got := stringifyFormValue([]string{"a", "b"}); got != "a、b" {
		t.Errorf("字符串切片应拼接: %q", got)
	}
	if got := stringifyFormValue(42); got != "42" {
		t.Errorf("数字应可读: %q", got)
	}
}

func Test表单提交走prompt(t *testing.T) {
	oc := &fakeOC{}
	b, out, sm, _ := newTestBridge(t, oc, BridgeConfig{})
	sm.Bind("oc_chat", "ses_1", "/p", "")
	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user",
		Value:     map[string]any{"action": ActionFormSubmit},
		FormValue: map[string]any{"f0_q0": "重启 go-exApi"},
	})
	if len(oc.prompts) != 1 || !strings.Contains(oc.prompts[0], "重启 go-exApi") {
		t.Errorf("答案应被送进会话: %v", oc.prompts)
	}
	if len(out.cards) == 0 {
		t.Error("应发已回答回执")
	}
}

func Test表单空提交提示(t *testing.T) {
	oc := &fakeOC{}
	b, out, sm, _ := newTestBridge(t, oc, BridgeConfig{})
	sm.Bind("oc_chat", "ses_1", "/p", "")
	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user",
		Value: map[string]any{"action": ActionFormSubmit},
	})
	if len(oc.prompts) != 0 {
		t.Error("空提交不应发送")
	}
	if !strings.Contains(out.lastText(), "没有收到任何答案") {
		t.Errorf("应说明无答案: %s", out.lastText())
	}
}

// Test表单取消
func Test表单取消(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{})
	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user",
		Value: map[string]any{"action": ActionFormCancel},
	})
	if !strings.Contains(out.lastText(), "已取消") {
		t.Errorf("应确认取消: %s", out.lastText())
	}
}

// ============ 健壮性 ============

func Test卡片回调不panic(t *testing.T) {
	oc := &fakeOC{}
	b, _, _, _ := newTestBridge(t, oc, BridgeConfig{})
	weird := []CardAction{
		{ChatID: "", UserID: "", Value: nil},
		{ChatID: "c", UserID: "u", Value: map[string]any{}},
		{ChatID: "c", UserID: "u", Value: map[string]any{"action": 123}},
		{ChatID: "c", UserID: "u", Value: map[string]any{"action": ActionSessionSelect, "session_id": 456}},
		{ChatID: "c", UserID: "u", FormValue: map[string]any{"f0_x": []any{1, 2, 3}}},
		{ChatID: "c", UserID: "u", FormValue: map[string]any{"fx_y": "z"}},
	}
	for i, a := range weird {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("用例 %d panic: %v (action=%+v)", i, r, a)
				}
			}()
			b.HandleCardAction(context.Background(), a)
		}()
	}
}

// ============ 快捷命令按钮 ============

func Test快捷按钮执行对应命令(t *testing.T) {
	oc := &fakeOC{}
	b, _, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	oc.compacts = nil

	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user",
		Value: map[string]any{"action": QuickCommandAction("compact")},
	})
	if len(oc.compacts) != 1 {
		t.Errorf("应执行 compact，实际 %d 次", len(oc.compacts))
	}
}

// Test快捷按钮指向已删除的命令时给提示 卡片是发送时固化的，
// 用户可能拿着几天前的卡片。
func Test快捷按钮指向已删除的命令时给提示(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{})
	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user",
		Value: map[string]any{"action": QuickCommandAction("nonexistent")},
	})
	if !strings.Contains(out.lastText(), "不存在") {
		t.Errorf("应说明命令已不存在: %s", out.lastText())
	}
}

func Test快捷按钮缺命令名(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{})
	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user",
		Value: map[string]any{"action": ActionQuickCmdPrefix},
	})
	if !strings.Contains(out.lastText(), "缺少命令名") {
		t.Errorf("应提示缺命令名: %s", out.lastText())
	}
}

// ============ 菜单下拉 ============

func Test模型下拉切换模型(t *testing.T) {
	oc := &fakeOC{}
	b, _, sm, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	oc.modelSet = nil

	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user",
		Value:  map[string]any{"action": ActionSwitchModel},
		Option: "opencode-go/space-bunny-free",
	})
	if len(oc.modelSet) != 1 || oc.modelSet[0] != "opencode-go/space-bunny-free" {
		t.Errorf("应切换模型，实际 %v", oc.modelSet)
	}
	_ = sm
}

func Test项目下拉切换项目(t *testing.T) {
	oc := &fakeOC{}
	b, _, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/projA"})
	b.HandleMessage(context.Background(), msg("/new"))
	oc.created = nil

	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user",
		Value:  map[string]any{"action": ActionSwitchProjectInChat},
		Option: "/projB",
	})
	// 换项目会解除绑定并要求重新开会话
	if len(oc.created) != 0 {
		t.Error("切换项目本身不应新建会话")
	}
}

// Test下拉缺选中值给命令替代 选中值在 Option 而非 Value，
// 取不到会落进「什么都没发生」。
func Test下拉缺选中值给命令替代(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{})
	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user",
		Value: map[string]any{"action": ActionSwitchModel},
	})
	if !strings.Contains(out.lastText(), "/model") {
		t.Errorf("应给出命令替代: %s", out.lastText())
	}
	if len(oc.modelSet) != 0 {
		t.Error("缺选中值时不应设置模型")
	}
}

// Test下拉也过门禁 未授权用户不应能通过卡片切换模型/项目。
func Test下拉也过门禁(t *testing.T) {
	oc := &fakeOC{}
	b, _, sm, _ := newGatedBridge(t, oc, BridgeConfig{})
	sm.Bind("oc_chat", "ses_1", "/p", "")
	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_stranger",
		Value:  map[string]any{"action": ActionSwitchModel},
		Option: "a/b",
	})
	if len(oc.modelSet) != 0 {
		t.Error("未授权用户不应能切换模型")
	}
}
