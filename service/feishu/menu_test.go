//go:build feishu

package feishu

import (
	"encoding/json"
	"strings"
	"testing"
)

// ============ 快捷命令动作编码 ============

// Test快捷动作带前缀 动作名由 QuickCommandAction 统一生成，
// 卡片与分发器共用同一常量，两侧不可能分裂。
//
// 这条对应 bot 侧一次真机事故：菜单卡用裸 `quick_compact`、
// 分发器只认 `opencode_quick_cmd:`，导致整张卡的按钮静默失效。
func Test快捷动作带前缀(t *testing.T) {
	got := QuickCommandAction("status")
	if got != ActionQuickCmdPrefix+"/status" {
		t.Errorf("动作 = %q, 期望 %q", got, ActionQuickCmdPrefix+"/status")
	}
	if strings.HasPrefix(got, "quick_") {
		t.Error("不应出现裸 quick_ 形态")
	}
}

func Test识别快捷动作(t *testing.T) {
	if !IsQuickCommandAction(ActionQuickCmdPrefix + "/help") {
		t.Error("应识别为快捷动作")
	}
	// 裸前缀也算「是快捷动作」：它是命令名缺失的畸形卡片，
	// 放进分发里才能报出准确的「缺少命令名」；
	// 在此之前判否只会得到笼统的「旧版本卡片已失效」。
	if !IsQuickCommandAction(ActionQuickCmdPrefix) {
		t.Error("裸前缀应被识别为快捷动作（由 handler 报出缺命令名）")
	}
	for _, notQuick := range []string{
		"", "help", "quick_help", ActionSessionSelect, ActionSwitchModel,
	} {
		if IsQuickCommandAction(notQuick) {
			t.Errorf("%q 不应被识别为快捷动作", notQuick)
		}
	}
}

func Test取出快捷命令(t *testing.T) {
	if got := QuickCommandOf(ActionQuickCmdPrefix + "/status"); got != "/status" {
		t.Errorf("命令 = %q, 期望 /status", got)
	}
	if got := QuickCommandOf(ActionSessionSelect); got != "" {
		t.Errorf("非快捷动作应返回空串，实际 %q", got)
	}
}

// ============ 快捷卡按钮 ============

// cardButtons 取卡片里所有带 behaviors 的元素。
func cardButtons(t *testing.T, c *Card) []Element {
	t.Helper()
	var out []Element
	var walk func(elems []Element)
	walk = func(elems []Element) {
		for _, e := range elems {
			if len(e.Behaviors) > 0 {
				out = append(out, e)
			}
			if len(e.Elements) > 0 {
				walk(e.Elements)
			}
			for _, col := range e.Columns {
				walk(col.Elements)
			}
		}
	}
	walk(c.Body.Elements)
	return out
}

// Test快捷卡按钮全部带前缀
func Test快捷卡按钮全部带前缀(t *testing.T) {
	c := QuickActionsCard(MenuOptions{})
	btns := cardButtons(t, c)
	if len(btns) == 0 {
		t.Fatal("快捷卡应有按钮")
	}
	for _, b := range btns {
		act, _ := b.Behaviors[0].Value["action"].(string)
		if !IsQuickCommandAction(act) {
			t.Errorf("按钮 %q 的动作 %q 不是快捷命令形态", buttonLabel(b), act)
		}
	}
}

func buttonLabel(b Element) string {
	if b.ButtonText != nil {
		return b.ButtonText.Content
	}
	return "(无标签)"
}

// Test快捷卡按钮映射的命令都存在 只有「有前缀」不够：
// 映射到一个不存在的命令，进了分发也只会回「未实现」。
func Test快捷卡按钮映射的命令都存在(t *testing.T) {
	c := QuickActionsCard(MenuOptions{})
	for _, b := range cardButtons(t, c) {
		act, _ := b.Behaviors[0].Value["action"].(string)
		cmd := strings.TrimPrefix(QuickCommandOf(act), "/")
		if _, ok := lookupCommand(cmd); !ok {
			t.Errorf("按钮 %q 映射到不存在的命令 /%s", buttonLabel(b), cmd)
		}
	}
}

// Test快捷卡覆盖预期动作
func Test快捷卡覆盖预期动作(t *testing.T) {
	c := QuickActionsCard(MenuOptions{})
	actions := map[string]bool{}
	for _, b := range cardButtons(t, c) {
		act, _ := b.Behaviors[0].Value["action"].(string)
		actions[act] = true
	}
	for _, cmd := range []string{
		ActionQuickNewSession, ActionQuickSessions, ActionQuickHelp,
		ActionQuickStatus, ActionQuickUsage, ActionQuickCompact, ActionQuickAbort,
	} {
		if !actions[QuickCommandAction(cmd)] {
			t.Errorf("缺少 %q 按钮", cmd)
		}
	}
}

// Test破坏性操作不进快捷区 clear 会解除会话绑定，
// 混在一排按钮里容易被顺手点到。
func Test破坏性操作不进快捷区(t *testing.T) {
	c := QuickActionsCard(MenuOptions{})
	for _, b := range cardButtons(t, c) {
		act, _ := b.Behaviors[0].Value["action"].(string)
		if cmd := strings.TrimPrefix(QuickCommandOf(act), "/"); cmd == "clear" {
			t.Error("clear 不应作为快捷按钮出现")
		}
	}
	// clear 仍作为命令保留
	if _, ok := lookupCommand("clear"); !ok {
		t.Error("clear 命令应仍然存在")
	}
}

func Test中止按钮为danger样式(t *testing.T) {
	for _, b := range cardButtons(t, QuickActionsCard(MenuOptions{})) {
		if strings.Contains(buttonLabel(b), "中止") && b.ButtonType != "danger" {
			t.Errorf("中止按钮 type = %q, 期望 danger", b.ButtonType)
		}
	}
}

// Test快捷卡通过飞书Schema
func Test快捷卡通过飞书Schema(t *testing.T) {
	c := QuickActionsCard(MenuOptions{
		Projects: []string{`E:\work\bmall`},
		Models:   []string{"opencode-go/space-bunny-free"},
	})
	if p := c.Validate(); len(p) > 0 {
		t.Errorf("快捷卡未通过 schema 校验: %v", p)
	}
}

// ============ 菜单下拉 ============

// Test下拉渲染 项目/模型列表非空时应出现两个下拉。
func Test下拉渲染(t *testing.T) {
	c := QuickActionsCard(MenuOptions{
		Projects: []string{`E:\a`, `E:\b`},
		Models:   []string{"m1", "m2"},
	})
	var selects []Element
	for _, e := range c.Body.Elements {
		if e.Tag == "select_static" {
			selects = append(selects, e)
		}
	}
	if len(selects) != 2 {
		t.Fatalf("下拉数 = %d, 期望 2（项目 + 模型）", len(selects))
	}
	// 动作名与 bot 侧一致，便于交叉使用卡片
	actions := map[string]bool{}
	for _, s := range selects {
		act, _ := s.Behaviors[0].Value["action"].(string)
		actions[act] = true
	}
	for _, want := range []string{ActionSwitchModel, ActionSwitchProjectInChat} {
		if !actions[want] {
			t.Errorf("缺少 %q 下拉", want)
		}
	}
}

// Test下拉为空时给命令提示 挂一个空的点不动的下拉比不显示更糟。
func Test下拉为空时给命令提示(t *testing.T) {
	c := QuickActionsCard(MenuOptions{})
	for _, e := range c.Body.Elements {
		if e.Tag == "select_static" {
			t.Fatal("列表为空时不应渲染下拉")
		}
	}
	txt := cardText(t, c)
	if !strings.Contains(txt, "/model") || !strings.Contains(txt, "/switch_project") {
		t.Errorf("应说明改用命令: %s", txt)
	}
}

func Test下拉标出当前模型(t *testing.T) {
	c := QuickActionsCard(MenuOptions{
		Models:       []string{"m1", "m2"},
		CurrentModel: "m2",
	})
	for _, e := range c.Body.Elements {
		if e.Tag == "select_static" && e.InitialOption == "m2" {
			return
		}
	}
	t.Error("应把当前模型标为 initial_option")
}

func Test下拉选项超限截断(t *testing.T) {
	models := make([]string, 20)
	for i := range models {
		models[i] = "model-" + string(rune('a'+i))
	}
	c := QuickActionsCard(MenuOptions{Models: models})
	for _, e := range c.Body.Elements {
		if e.Tag != "select_static" {
			continue
		}
		if len(e.Options) > maxSelectOptions {
			t.Errorf("选项数 = %d, 应截断到 %d", len(e.Options), maxSelectOptions)
		}
		return
	}
	t.Fatal("应有下拉")
}

// Test下拉选项值原样保留 选项值是提交时要用的原文，
// 截断只应影响显示文本。
func Test下拉选项值原样保留(t *testing.T) {
	c := QuickActionsCard(MenuOptions{
		Models: []string{"opencode-go/space-bunny-free"},
	})
	for _, e := range c.Body.Elements {
		if e.Tag == "select_static" {
			if len(e.Options) == 0 {
				t.Fatal("下拉应有选项")
			}
			if e.Options[0].Value != "opencode-go/space-bunny-free" {
				t.Errorf("选项值被改写: %q", e.Options[0].Value)
			}
			return
		}
	}
	t.Fatal("应有下拉")
}

func Test下拉的action放在value里(t *testing.T) {
	// 与 bot 侧结构一致：action 在 behaviors[].value 内
	raw, err := QuickActionsCard(MenuOptions{Models: []string{"m1"}}).JSON()
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string([]byte(raw)), `"behaviors"`) {
		t.Error("下拉应通过 behaviors 携带回调")
	}
	_ = m
}

// Test需要参数的动作用命令
func Test需要参数的动作用命令(t *testing.T) {
	got := NeedsArgument()
	if len(got) != 2 {
		t.Errorf("需参数的动作 = %v, 期望 2 个", got)
	}
	if !strings.Contains(DescribeQuickActions(), ActionSwitchModel) {
		t.Error("说明应列出需参数的动作")
	}
}
