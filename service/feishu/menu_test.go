package feishu

import (
	"context"
	"os"
	"strings"
	"testing"
)

// ============ 快捷操作卡 ============

func Test快捷卡有按钮(t *testing.T) {
	c := QuickActionsCard()
	btns := buttonsOf(t, c)
	if len(btns) < 5 {
		t.Fatalf("按钮数 = %d, 期望至少 5", len(btns))
	}
	for _, btn := range btns {
		if btn.Behavior == nil || btn.Behavior.Value == nil {
			t.Fatal("每个按钮都必须带 callback，否则点了没反应")
		}
		if _, ok := btn.Behavior.Value["action"]; !ok {
			t.Errorf("按钮缺 action: %+v", btn.Behavior.Value)
		}
	}
}

// Test快捷卡不挂无实现的按钮 挂了却没实现的按钮比没有更糟——
// 用户会以为功能坏了。
func Test快捷卡不挂无实现的按钮(t *testing.T) {
	c := QuickActionsCard()
	for _, btn := range buttonsOf(t, c) {
		act, _ := btn.Behavior.Value["action"].(string)
		if _, _, ok := ResolveQuickAction(act); !ok {
			t.Errorf("按钮 %q 没有对应命令实现", act)
		}
	}
}

// Test需要参数的快捷动作不挂按钮 /model 与 /switch_project 都需要参数，
// 一键执行不了。
func Test需要参数的快捷动作不挂按钮(t *testing.T) {
	c := QuickActionsCard()
	raw := cardText(t, c)
	for _, act := range NeedsArgument() {
		if strings.Contains(raw, act) {
			t.Errorf("需要参数的 %q 不应作为按钮出现", act)
		}
	}
	if len(NeedsArgument()) == 0 {
		t.Error("应列出需要参数的动作")
	}
}

// Test破坏性操作不进快捷区 /clear 会解绑，混在一排按钮里容易被顺手点到。
func Test破坏性操作不进快捷区(t *testing.T) {
	c := QuickActionsCard()
	raw := cardText(t, c)
	if _, _, ok := ResolveQuickAction(ActionQuickClear); ok {
		t.Error("clear 不应作为快捷动作")
	}
	if strings.Contains(raw, ActionQuickClear) {
		t.Error("clear 按钮不应出现在快捷卡上")
	}
	// 中止是唯一允许在快捷区的破坏性操作
	if _, _, ok := ResolveQuickAction(ActionQuickAbort); !ok {
		t.Error("abort 应保留在快捷区")
	}
}

func Test中止按钮为danger样式(t *testing.T) {
	c := QuickActionsCard()
	for _, btn := range buttonsOf(t, c) {
		act, _ := btn.Behavior.Value["action"].(string)
		if act == ActionQuickAbort && btn.ButtonType != "danger" {
			t.Errorf("中止按钮 type = %q, 期望 danger", btn.ButtonType)
		}
	}
}

func Test快捷卡提示可用命令(t *testing.T) {
	if !strings.Contains(cardText(t, QuickActionsCard()), "直接发") {
		t.Error("应提示也可以直接发消息")
	}
}

// Test快捷动作映射到真实命令 这是「不重复实现」的关键保证：
// 映射到的命令名必须在命令表里，否则点了会回「尚未实现」。
func Test快捷动作映射到真实命令(t *testing.T) {
	for act, cmd := range quickActionToCommand {
		if _, ok := lookupCommand(cmd); !ok {
			t.Errorf("快捷动作 %q 映射到不存在的命令 %q", act, cmd)
		}
	}
}

func Test解析快捷动作(t *testing.T) {
	cmd, args, ok := ResolveQuickAction(ActionQuickStatus)
	if !ok || cmd != "status" {
		t.Errorf("解析 %q = %q, 期望 status", ActionQuickStatus, cmd)
	}
	if args != "" {
		t.Errorf("快捷动作不应带参数，实际 %q", args)
	}
	if _, _, ok := ResolveQuickAction("quick_not_exist"); ok {
		t.Error("不存在的快捷动作不应解析成功")
	}
}

func Test快捷操作说明(t *testing.T) {
	txt := DescribeQuickActions()
	if !strings.Contains(txt, "quick_model") {
		t.Errorf("应列出需要参数的动作: %s", txt)
	}
}

// ============ 快捷按钮端到端走命令分发 ============

// Test快捷按钮走命令分发 快捷动作复用命令分发，
// 同一动作不该有两份实现。
func Test快捷按钮走命令分发(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{DefaultProject: "/proj"})
	b.HandleMessage(context.Background(), msg("/new"))
	oc.interrupts = nil

	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user",
		Value: map[string]any{"action": ActionQuickAbort},
	})
	if len(oc.interrupts) != 1 {
		t.Errorf("快捷中止应调用 Interrupt，实际 %d 次", len(oc.interrupts))
	}
	if !strings.Contains(out.allText(), "中止") {
		t.Errorf("应有中止回执: %s", out.allText())
	}
}

func Test快捷帮助按钮走help(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{})
	b.HandleCardAction(context.Background(), CardAction{
		ChatID: "oc_chat", UserID: "ou_user",
		Value: map[string]any{"action": ActionQuickHelp},
	})
	if !strings.Contains(out.lastText(), "可用命令") {
		t.Errorf("应返回命令表: %s", out.lastText())
	}
}

// Test菜单命令发快捷卡 /menu 是卡片型命令，只发卡不发文本。
func Test菜单命令发快捷卡(t *testing.T) {
	oc := &fakeOC{}
	b, out, _, _ := newTestBridge(t, oc, BridgeConfig{})
	b.HandleMessage(context.Background(), msg("/menu"))
	if len(out.cards) != 1 {
		t.Fatalf("应发一张快捷操作卡，实际 %d 张", len(out.cards))
	}
	if len(buttonsOf(t, out.cards[0])) == 0 {
		t.Error("卡上应有按钮")
	}
}

// ============ 白名单可变 ============

func Test白名单增删查(t *testing.T) {
	w := NewWhitelist("")
	if !w.Add("ou_a") {
		t.Error("首次添加应成功")
	}
	if w.Add("ou_a") {
		t.Error("重复添加应返回 false")
	}
	if !w.Has("ou_a") {
		t.Error("应在名单内")
	}
	if w.Len() != 1 {
		t.Errorf("人数 = %d", w.Len())
	}
	if !w.Remove("ou_a") {
		t.Error("移除应成功")
	}
	if w.Remove("ou_a") {
		t.Error("重复移除应返回 false")
	}
	if w.Len() != 0 {
		t.Error("移除后应为空")
	}
}

// Test白名单拒绝空串 否则配置里混进空串就成了匿名绕过。
func Test白名单拒绝空串(t *testing.T) {
	w := NewWhitelist("")
	if w.Add("") {
		t.Error("不应接受空串")
	}
	if w.Add("   ") {
		t.Error("不应接受纯空白")
	}
	if w.Len() != 0 {
		t.Error("空串不应进入名单")
	}
}

func Test白名单持久化往返(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/wl.json"
	w1 := NewWhitelist(path)
	w1.Add("ou_a")
	w1.Add("ou_b")

	w2 := NewWhitelist(path)
	if w2.Len() != 2 || !w2.Has("ou_a") || !w2.Has("ou_b") {
		t.Errorf("重启后名单应恢复: %v", w2.List())
	}
	// 移除后重启也应反映
	w2.Remove("ou_a")
	w3 := NewWhitelist(path)
	if w3.Has("ou_a") {
		t.Error("移除应持久化")
	}
	if !w3.Has("ou_b") {
		t.Error("未移除的应保留")
	}
}

// Test白名单文件损坏降级为空 名单读不出来时保持「无人被授权」是安全的一侧。
func Test白名单文件损坏降级为空(t *testing.T) {
	path := t.TempDir() + "/wl.json"
	if err := os.WriteFile(path, []byte("BROKEN NOT JSON"), 0o644); err != nil {
		t.Fatal(err)
	}
	w := NewWhitelist(path)
	if w.Len() != 0 {
		t.Errorf("损坏文件应降级为空，实际 %d 人", w.Len())
	}
	// 损坏后仍可正常增删
	if !w.Add("ou_x") {
		t.Error("损坏后应可继续添加")
	}
}

func Test白名单返回副本(t *testing.T) {
	w := NewWhitelist("")
	w.Add("ou_a")
	got := w.List()
	got[0] = "被改了"
	if !w.Has("ou_a") {
		t.Error("List 应返回副本，外部改动不应影响内部")
	}
}

func Test白名单合成策略(t *testing.T) {
	w := NewWhitelist("")
	w.Add("ou_member")
	p := w.Policy(false, []string{"ou_admin"})
	if p.AllowAllUsers {
		t.Error("应保持收紧")
	}
	if !IsUserAllowed("ou_member", p) {
		t.Error("白名单成员应放行")
	}
	if !IsUserAllowed("ou_admin", p) {
		t.Error("管理员应放行")
	}
	if IsUserAllowed("ou_stranger", p) {
		t.Error("其他人应被拒")
	}
}

// Test策略随白名单变化 即时生效，不需要重启。
func Test策略随白名单变化(t *testing.T) {
	w := NewWhitelist("")
	if IsUserAllowed("ou_x", w.Policy(false, nil)) {
		t.Error("初始应无放行")
	}
	w.Add("ou_x")
	if !IsUserAllowed("ou_x", w.Policy(false, nil)) {
		t.Error("添加后应立即放行")
	}
	w.Remove("ou_x")
	if IsUserAllowed("ou_x", w.Policy(false, nil)) {
		t.Error("移除后应立即收回")
	}
}
