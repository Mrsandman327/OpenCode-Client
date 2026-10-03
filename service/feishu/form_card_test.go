//go:build feishu

package feishu

import (
	"encoding/json"
	"strings"
	"testing"
)

// realForm 是实测样本（来自会话 ses_f17f172b0ffe）。
// 刻意用真实数据而非人造最小样本：form 契约的问题正是「人造样本与真实
// 契约不一致」导致的（见 form_card.go 头部说明）。
var realForm = FormInfo{
	ID:        "frm_0ea94190d001dVJDe15hahRQ4y",
	SessionID: "ses_f17f172b0ffeSNJccPJFeOtCSp",
	Title:     "Questions",
	Metadata:  map[string]any{"kind": "question"},
	Fields: []FormField{{
		Key:         "q0",
		Title:       "重启哪个进程",
		Description: "要重启的是哪个进程？当前 BMALL 六个服务均未运行。",
		Type:        "string",
		Options: []FormFieldOption{
			{Value: "重启预览用的 HTTP 服务", Label: "重启预览用的 HTTP 服务", Description: "重新拉起 python http.server"},
			{Value: "启动 BMALL 服务（go-exApi 等）", Label: "启动 BMALL 服务（go-exApi 等）", Description: "当前无服务在跑"},
			{Value: "是别的东西，我说明一下", Label: "是别的东西，我说明一下", Description: "上面都不是"},
		},
		Custom: true,
	}},
}

// formElements 摊平 body 里的 form 元素，取出其子元素。
// form 的子元素才是真正的表单控件；不摊平的话所有断言都会落空。
func formElements(t *testing.T, c *Card) []Element {
	t.Helper()
	if len(c.Body.Elements) != 1 {
		t.Fatalf("body 元素数 = %d, 期望 1（单个 form 容器）", len(c.Body.Elements))
	}
	if c.Body.Elements[0].Tag != "form" {
		t.Fatalf("顶层元素 tag = %q, 期望 form", c.Body.Elements[0].Tag)
	}
	return c.Body.Elements[0].Elements
}

func elementsWithTag(elems []Element, tag string) []Element {
	var out []Element
	for _, e := range elems {
		if e.Tag == tag {
			out = append(out, e)
		}
	}
	return out
}

func markdownText(elems []Element) string {
	var parts []string
	for _, e := range elems {
		if e.Tag == "markdown" && e.Content != "" {
			parts = append(parts, e.Content)
		}
	}
	return strings.Join(parts, "\n")
}

// ============ diff 卡 ============

func TestDiffCard无改动用灰色(t *testing.T) {
	c := DiffCard(DiffCardOptions{SessionFileCount: -1})
	if c.Header.Template != TemplateGrey {
		t.Errorf("无改动应为灰色（蓝色会让人以为是正常结果），实际 %q", c.Header.Template)
	}
	if !strings.Contains(cardText(t, c), "没有文件改动") {
		t.Error("应说明没有改动")
	}
}

func TestDiffCard统计与加删行(t *testing.T) {
	c := DiffCard(DiffCardOptions{
		Stats: []FileDiffStat{
			{File: "a.go", Status: "modified", Additions: 10, Deletions: 2},
			{File: "b.go", Status: "added", Additions: 5, Deletions: 0},
		},
		SessionFileCount: -1,
	})
	txt := cardText(t, c)
	for _, want := range []string{"**2** 个文件", "+15", "-2", "a.go", "b.go"} {
		if !strings.Contains(txt, want) {
			t.Errorf("缺 %q: %s", want, txt)
		}
	}
}

// TestDiffCard负数表示未知 sessionFileCount=-1 时不应显示
// 「本会话触及 -1 个」这种荒谬内容。
func TestDiffCard负数表示未知(t *testing.T) {
	c := DiffCard(DiffCardOptions{
		Stats:            []FileDiffStat{{File: "a.go", Additions: 1}},
		SessionFileCount: -1,
	})
	if strings.Contains(cardText(t, c), "触及") {
		t.Error("未知时应省略「本会话触及」")
	}

	c2 := DiffCard(DiffCardOptions{
		Stats:            []FileDiffStat{{File: "a.go", Additions: 1}},
		SessionFileCount: 4,
	})
	if !strings.Contains(cardText(t, c2), "本会话触及 **4** 个") {
		t.Error("已知时应显示本会话触及的文件数")
	}
}

func TestDiffCard文件超限明示余量(t *testing.T) {
	stats := make([]FileDiffStat, 25)
	for i := range stats {
		stats[i] = FileDiffStat{File: "f" + string(rune('a'+i%26)) + string(rune('a'+i/26))}
	}
	c := DiffCard(DiffCardOptions{Stats: stats, SessionFileCount: -1, Limit: 20})
	txt := cardText(t, c)
	if !strings.Contains(txt, "另有 5 个文件未列出") {
		t.Errorf("应明示未列出的文件数: %s", txt)
	}
}

func TestDiffStatusIcon(t *testing.T) {
	cases := map[string]string{
		"added": "🆕", "new": "🆕", "deleted": "🗑️", "removed": "🗑️",
		"renamed": "📝", "touched": "✍️", "modified": "✍️", "": "📄", "weird": "📄",
		"ADDED": "🆕", // 应大小写不敏感
	}
	for in, want := range cases {
		if got := diffStatusIcon(in); got != want {
			t.Errorf("diffStatusIcon(%q) = %q, 期望 %q", in, got, want)
		}
	}
}

// ============ form 卡 ============

// TestFormCard真实样本不炸 用真实契约的样本渲染。
func TestFormCard真实样本不炸(t *testing.T) {
	c := FormCard(realForm)
	if c.Schema != "2.0" {
		t.Errorf("schema = %q", c.Schema)
	}
	raw := cardText(t, c)
	if !strings.Contains(raw, "重启哪个进程") {
		t.Errorf("应含字段标题: %s", raw)
	}
}

func TestFormCard单选渲染select_static(t *testing.T) {
	elems := formElements(t, FormCard(realForm))
	selects := elementsWithTag(elems, "select_static")
	if len(selects) != 1 {
		t.Fatalf("select_static 数 = %d, 期望 1", len(selects))
	}
	if len(selects[0].Options) != 3 {
		t.Errorf("选项数 = %d, 期望 3", len(selects[0].Options))
	}
	// value 必须是机器值原样透传，不能用 index 或 label 代替：
	// 提交时 OpenCode 按 value 匹配，改了就会提交错值
	if selects[0].Options[0].Value != "重启预览用的 HTTP 服务" {
		t.Errorf("选项 value 被改写: %q", selects[0].Options[0].Value)
	}
	if selects[0].Name != "f0_q0" {
		t.Errorf("控件名 = %q, 期望 f0_q0", selects[0].Name)
	}
}

func TestFormCardcustom加输入框(t *testing.T) {
	elems := formElements(t, FormCard(realForm))
	inputs := elementsWithTag(elems, "input")
	if len(inputs) != 1 {
		t.Fatalf("input 数 = %d, 期望 1", len(inputs))
	}
	// 输入框名字必须与下拉框区分，否则自填答案会覆盖下拉选择
	if inputs[0].Name != "f0_q0__custom" {
		t.Errorf("输入框名 = %q, 期望 f0_q0__custom", inputs[0].Name)
	}
}

// TestFormCard选项说明单独列出 飞书 select 不支持选项级 description，
// 塞进 options 里会被静默丢弃。
func TestFormCard选项说明单独列出(t *testing.T) {
	elems := formElements(t, FormCard(realForm))
	txt := markdownText(elems)
	if !strings.Contains(txt, "重新拉起 python http.server") {
		t.Errorf("选项说明应单独列出: %s", txt)
	}
	if !strings.Contains(txt, "• **") {
		t.Errorf("应使用项目符号格式: %s", txt)
	}
}

// TestFormCard允许自填时非必填 强制必填会让用户无法只用自填作答。
func TestFormCard允许自填时非必填(t *testing.T) {
	elems := formElements(t, FormCard(realForm))
	sel := elementsWithTag(elems, "select_static")[0]
	if sel.Required {
		t.Error("custom=true 时下拉不应必填")
	}
}

// TestFormCard不允许自填时必填 没有自填兜底时，必填才能拦住空提交。
func TestFormCard不允许自填时必填(t *testing.T) {
	f := realForm
	f.Fields = []FormField{{Key: "q0", Title: "选一个", Type: "string", Options: realForm.Fields[0].Options}}
	elems := formElements(t, FormCard(f))
	if !elementsWithTag(elems, "select_static")[0].Required {
		t.Error("无 custom 时下拉应必填")
	}
	if len(elementsWithTag(elems, "input")) != 0 {
		t.Error("无 custom 时不应有输入框")
	}
}

func TestIsMultiSelect(t *testing.T) {
	cases := []struct {
		typ  string
		want bool
	}{
		{"string", false},
		{"array", true},
		{"multi", true},
		{"list", true},
		{"MULTI", true}, // 应大小写不敏感
		{"", false},
		{"number", false},
		// 刻意与 bot 侧保持一致：bot 只识别 array/multi/list 三种线索，
		// "string[]" 不含其中任一子串，因此判为单选。
		// 这处「不识别」是有意的保守取舍（实测样本里没出现多选确切取值），
		// 不在这里单方面加规则，否则两个客户端对同一 form 会渲染出不同控件。
		{"string[]", false},
	}
	for _, c := range cases {
		if got := IsMultiSelect(FormField{Type: c.typ}); got != c.want {
			t.Errorf("IsMultiSelect(type=%q) = %v, 期望 %v", c.typ, got, c.want)
		}
	}
}

// TestIsMultiSelect未知类型保守按单选 误判成多选会让用户以为能多选。
func TestIsMultiSelect未知类型保守按单选(t *testing.T) {
	if IsMultiSelect(FormField{Type: "number", Options: []FormFieldOption{{Value: "1"}, {Value: "2"}}}) {
		t.Error("未知 type 应按单选处理")
	}
}

func TestFormCard多选渲染multi_select_static(t *testing.T) {
	f := realForm
	f.Fields = []FormField{{Key: "q0", Title: "多选", Type: "array", Options: realForm.Fields[0].Options}}
	elems := formElements(t, FormCard(f))
	if len(elementsWithTag(elems, "multi_select_static")) != 1 {
		t.Error("array 类型应渲染 multi_select_static")
	}
	if len(elementsWithTag(elems, "select_static")) != 0 {
		t.Error("array 类型不应同时渲染 select_static")
	}
}

// TestFormCard多选占位文案 多选与单选的占位要让用户一眼分辨。
func TestFormCard多选占位文案(t *testing.T) {
	f := realForm
	f.Fields = []FormField{{Key: "q0", Title: "多选", Type: "array", Options: realForm.Fields[0].Options}}
	elems := formElements(t, FormCard(f))
	sel := elementsWithTag(elems, "multi_select_static")[0]
	if sel.Placeholder == nil || !strings.Contains(sel.Placeholder.Content, "可多选") {
		t.Errorf("多选占位应提示可多选: %+v", sel.Placeholder)
	}
}

// TestFormCard无选项降级为纯输入 没有候选项时不应渲染空下拉框——
// 飞书会显示一个点不动的下拉。
func TestFormCard无选项降级为纯输入(t *testing.T) {
	f := realForm
	f.Fields = []FormField{{Key: "q0", Title: "自由输入", Type: "string", Custom: true}}
	elems := formElements(t, FormCard(f))
	if len(elementsWithTag(elems, "select_static")) != 0 {
		t.Error("无选项时不应有下拉框")
	}
	if len(elementsWithTag(elems, "input")) != 1 {
		t.Error("应只有输入框")
	}
}

func TestFormCard长标题与标签截断(t *testing.T) {
	long := strings.Repeat("x", 200)
	f := realForm
	f.Fields = []FormField{{
		Key: "q0", Title: long, Type: "string",
		Options: []FormFieldOption{{Value: "v", Label: long}},
	}}
	elems := formElements(t, FormCard(f))
	sel := elementsWithTag(elems, "select_static")[0]
	label := []rune(sel.Options[0].Text.Content)
	if len(label) > optionLabelLimit {
		t.Errorf("选项标签长 %d, 应截断到 %d", len(label), optionLabelLimit)
	}
	if sel.Options[0].Value != "v" {
		t.Errorf("截断不应影响 value: %q", sel.Options[0].Value)
	}
}

func TestFormCard有自填字段才提示直接回复(t *testing.T) {
	withCustom := markdownText(formElements(t, FormCard(realForm)))
	if !strings.Contains(withCustom, "直接发消息回答") {
		t.Error("有 custom 字段时应提示可直接发消息")
	}

	f := realForm
	f.Fields = []FormField{{Key: "q0", Title: "选一个", Type: "string", Options: realForm.Fields[0].Options}}
	noCustom := markdownText(formElements(t, FormCard(f)))
	if strings.Contains(noCustom, "直接发消息回答") {
		t.Error("无 custom 字段时不应提示（用户会去找不存在的输入框）")
	}
}

func TestFormCard提交按钮是submit动作(t *testing.T) {
	elems := formElements(t, FormCard(realForm))
	var submit *Element
	for i := range elems {
		if elems[i].Tag == "column_set" {
			for _, col := range elems[i].Columns {
				for j := range col.Elements {
					// schema 2.0 走 behaviors 的 form_action，
					// 不是 1.0 的 form_action_type
					if len(col.Elements[j].Behaviors) > 0 &&
						col.Elements[j].Behaviors[0].Type == BehaviorFormAction {
						submit = &col.Elements[j]
					}
				}
			}
		}
	}
	if submit == nil {
		t.Fatal("未找到提交按钮")
	}
	if submit.Behaviors[0].Behavior != "submit" {
		t.Errorf("form_action 动作 = %q, 期望 submit", submit.Behaviors[0].Behavior)
	}
	if submit.ButtonText == nil || submit.ButtonText.Content != "提交" {
		t.Errorf("提交按钮文案 = %+v", submit.ButtonText)
	}
}

func TestFormCard多字段名不冲突(t *testing.T) {
	// 初版 bug：控件名只用了 field.key，两个 key 同名会互相覆盖，
	// 用户在第二题的选择覆盖掉第一题。
	f := realForm
	f.Fields = []FormField{
		{Key: "q", Title: "第一题", Type: "string", Options: []FormFieldOption{{Value: "1", Label: "1"}}},
		{Key: "q", Title: "第二题", Type: "string", Options: []FormFieldOption{{Value: "2", Label: "2"}}},
	}
	elems := formElements(t, FormCard(f))
	names := map[string]bool{}
	for _, sel := range elementsWithTag(elems, "select_static") {
		if names[sel.Name] {
			t.Errorf("控件名冲突: %q", sel.Name)
		}
		names[sel.Name] = true
	}
	if len(names) != 2 {
		t.Errorf("应有两个不同控件名，实际 %v", names)
	}
	if _, ok := names["f0_q"]; !ok {
		t.Errorf("第一题控件名 = f0_q，应存在。实际 %v", names)
	}
}

func TestFormCard多字段间有分隔线(t *testing.T) {
	f := realForm
	f.Fields = []FormField{
		{Key: "a", Title: "A", Type: "string", Options: []FormFieldOption{{Value: "1", Label: "1"}}},
		{Key: "b", Title: "B", Type: "string", Options: []FormFieldOption{{Value: "2", Label: "2"}}},
	}
	elems := formElements(t, FormCard(f))
	// 字段间 1 条 + 提交前 1 条
	if got := len(elementsWithTag(elems, "hr")); got != 2 {
		t.Errorf("分隔线数 = %d, 期望 2（字段间 + 提交前）", got)
	}
}

func TestFormCard空标题回退(t *testing.T) {
	f := realForm
	f.Title = ""
	c := FormCard(f)
	if c.Header.Title.Content != "❓ 需要你确认" {
		t.Errorf("空标题应回退: %q", c.Header.Title.Content)
	}
}

func TestFormCard空字段列表仍可提交(t *testing.T) {
	f := realForm
	f.Fields = nil
	c := FormCard(f)
	if len(c.Body.Elements) != 1 || c.Body.Elements[0].Tag != "form" {
		t.Fatal("空字段也应产出合法 form 容器")
	}
	if len(formElements(t, c)) == 0 {
		t.Error("空字段也应保留提交按钮")
	}
}

func TestFormCard名称含formID(t *testing.T) {
	c := FormCard(realForm)
	if c.Body.Elements[0].Name != "opencode_form_frm_0ea94190d001dVJDe15hahRQ4y" {
		t.Errorf("form 名 = %q", c.Body.Elements[0].Name)
	}
}

func TestFormAnsweredCard配对问答(t *testing.T) {
	c := FormAnsweredCard(realForm, []string{"启动 BMALL 服务（go-exApi 等）"})
	txt := cardText(t, c)
	if !strings.Contains(txt, "重启哪个进程") {
		t.Error("应含问题")
	}
	if !strings.Contains(txt, "启动 BMALL 服务") {
		t.Error("应含答案")
	}
	if c.Header.Template != TemplateTurquoise {
		t.Errorf("已回答应青绿，实际 %q", c.Header.Template)
	}
}

func TestFormAnsweredCard未回答标注(t *testing.T) {
	c := FormAnsweredCard(realForm, nil)
	if !strings.Contains(cardText(t, c), "(未回答)") {
		t.Error("缺答案时应标注未回答")
	}
}

// TestFormInfo契约字段名不漂 契约字段名错一个，OpenCode 的 form
// 事件就解析不出来——而错误是静默的。
func TestFormInfo契约字段名不漂(t *testing.T) {
	raw, err := json.Marshal(realForm)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"id", "sessionID", "title", "fields"} {
		if _, ok := out[key]; !ok {
			t.Errorf("FormInfo 缺字段 %q", key)
		}
	}
	field := out["fields"].([]any)[0].(map[string]any)
	for _, key := range []string{"key", "title", "type"} {
		if _, ok := field[key]; !ok {
			t.Errorf("FormField 缺字段 %q", key)
		}
	}
	if _, ok := field["options"]; !ok {
		t.Error("有候选项时 options 必须出现")
	}
	opt := field["options"].([]any)[0].(map[string]any)
	for _, key := range []string{"value", "label"} {
		if _, ok := opt[key]; !ok {
			t.Errorf("FormFieldOption 缺字段 %q", key)
		}
	}
	// 真实样本的选项都带 description，必须出现
	if d, ok := opt["description"]; !ok || d == "" {
		t.Error("有描述时必须序列化 description")
	}
	// 无描述的选项才应省略
	rawBare, _ := json.Marshal(FormFieldOption{Value: "v", Label: "L"})
	var bare map[string]any
	_ = json.Unmarshal(rawBare, &bare)
	if _, ok := bare["description"]; ok {
		t.Error("无描述的选项不应序列化 description（omitempty）")
	}
	// 布尔 false 也应省略：塞一堆 custom:false 会让契约看起来比实际复杂
	if _, ok := field["custom"]; !ok {
		t.Error("custom=true 时必须出现")
	}
	empty := FormField{Key: "k", Title: "t", Type: "string"}
	rawEmpty, _ := json.Marshal(empty)
	var outEmpty map[string]any
	_ = json.Unmarshal(rawEmpty, &outEmpty)
	for _, key := range []string{"options", "custom", "description"} {
		if _, ok := outEmpty[key]; ok {
			t.Errorf("零值字段 %q 不应序列化（omitempty）", key)
		}
	}
}
