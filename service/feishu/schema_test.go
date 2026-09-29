// schema_test.go —— 飞书卡片 schema 约束
//
// 这些断言的依据是**飞书真实返回的错误**，不是文档推测。
//
// 真实事故：behaviors 被写成单个对象而非数组，飞书返回
//   ErrCode 200621: expected slice for behaviors, but: map[type:Callback value:map[…]]
// 整张卡片被拒——**所有文本消息正常、所有卡片静默失败**。
// 而当时 251 个单测全绿，因为它们只验「JSON 合法」，
// 不验「飞书接受」。json.Marshal 永远不会发现这类问题。
//
// 所以这里把已知约束固化成断言，并要求**每一张卡**都过校验。

package feishu

import (
	"encoding/json"
	"strings"
	"testing"
)

// mustValid 断言卡片通过 schema 校验。
func mustValid(t *testing.T, c *Card, name string) {
	t.Helper()
	if p := c.Validate(); len(p) > 0 {
		t.Errorf("%s 未通过飞书卡片校验: %s", name, strings.Join(p, "; "))
	}
}

// Test所有卡片通过飞书Schema 逐张过一遍。
//
// 这里刻意不走 registry（没有 registry），而是显式列出——
// 漏掉一张就是漏检，而漏检的后果是那张卡在飞书里静默失败。
func Test所有卡片通过飞书Schema(t *testing.T) {
	cards := map[string]*Card{
		"会话选择": SessionSelectCard(SessionSelectOptions{
			Nodes: []SessionNode{
				{ID: "ses_a", Title: "会话A"},
				{ID: "ses_b", Title: "会话B"},
			},
			CurrentID: "ses_a",
		}),
		"权限审批": PermissionCard(PermissionRequest{
			ID: "per_1", Action: "bash", Resources: []string{"ls"},
		}),
		"用量统计": UsageCard(Usage{Cost: 1.5, Tokens: TokenUsage{Input: 100, Output: 200}}),
		"任务通知": TaskNotificationCard(TaskNotification{
			ElapsedSeconds: 90, Success: true, Output: "完成", SessionID: "ses_x",
		}),
		"代码改动": DiffCard(DiffCardOptions{
			Stats:            []FileDiffStat{{File: "a.go", Additions: 1, Deletions: 0, Status: "modified"}},
			SessionFileCount: -1,
		}),
		"form": FormCard(FormInfo{
			ID: "frm_1", Title: "确认",
			Fields: []FormField{{
				Key: "q0", Title: "选一个", Type: "string",
				Options: []FormFieldOption{{Value: "a", Label: "A", Description: "第一个"}},
				Custom:  true,
			}},
		}),
		"快捷操作": QuickActionsCard(),
	}

	for name, c := range cards {
		t.Run(name, func(t *testing.T) {
			mustValid(t, c, name)
		})
	}
}

// Test表单各变体通过Schema 表单的控件类型多，逐个变体都要过。
func Test表单各变体通过Schema(t *testing.T) {
	opts := []FormFieldOption{{Value: "a", Label: "A"}, {Value: "b", Label: "B"}}
	cases := map[string]FormField{
		"单选":  {Key: "q0", Title: "单选", Type: "string", Options: opts},
		"多选":  {Key: "q0", Title: "多选", Type: "array", Options: opts},
		"纯输入": {Key: "q0", Title: "输入", Type: "string", Custom: true},
		"无选项": {Key: "q0", Title: "空", Type: "string"},
		"带描述": {Key: "q0", Title: "带描述", Type: "string", Description: "说明文字", Options: opts},
		"多字段": {Key: "q0", Title: "A", Type: "string", Options: opts},
	}
	for name, f := range cases {
		t.Run(name, func(t *testing.T) {
			mustValid(t, FormCard(FormInfo{
				ID: "frm_1", Title: "T", Fields: []FormField{f},
			}), "form/"+name)
		})
	}
	// 多字段组合
	mustValid(t, FormCard(FormInfo{
		ID: "frm_1", Title: "T",
		Fields: []FormField{
			{Key: "a", Title: "A", Type: "string", Options: opts},
			{Key: "b", Title: "B", Type: "array", Options: opts, Custom: true},
		},
	}), "form/多字段")
}

// TestBehaviors是数组 是本次事故的核心回归断言。
//
// 直接查 JSON 形态，不经 Validate——防的是「有人把 Validate 改松」。
func TestBehaviors是数组(t *testing.T) {
	c := PermissionCard(PermissionRequest{ID: "per_1", Action: "bash"})
	raw, err := c.JSON()
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	body := m["body"].(map[string]any)
	for _, raw := range body["elements"].([]any) {
		el := raw.(map[string]any)
		if el["tag"] != "button" {
			continue
		}
		b, ok := el["behaviors"]
		if !ok {
			t.Fatal("按钮缺 behaviors")
		}
		if _, isArray := b.([]any); !isArray {
			t.Fatalf("behaviors 必须是数组，实际 %T —— 飞书会报 ErrCode 200621", b)
		}
	}
}

// Test校验能抓出违规元素 验证 Validate 本身有效，
// 而不是永远返回空——一个永远返回空的校验等于没有校验。
func Test校验能抓出违规元素(t *testing.T) {
	// 手工构造一个缺 text 的按钮，绕过 Button() 的正确封装
	bad := &Card{
		Schema: "2.0",
		Header: &Header{Title: PlainText{Tag: "plain_text", Content: "x"}},
		Body: Body{
			Direction: "vertical",
			Elements: []Element{
				{Tag: "button", ButtonType: "default"}, // 缺 text
			},
		},
	}
	problems := bad.Validate()
	if len(problems) == 0 {
		t.Fatal("Validate 对缺 text 的按钮无任何反应，说明校验是坏的")
	}
	if !strings.Contains(strings.Join(problems, ";"), "缺 text") {
		t.Errorf("应报出缺 text，实际: %v", problems)
	}

	// 正常卡片不应被误报
	good := TextCard("标题", "正文")
	if p := good.Validate(); len(p) != 0 {
		t.Errorf("正常卡片被误报: %v", p)
	}
}

// Test按钮必须带行为 点了没反应是最常见的「卡片坏了」。
func Test按钮必须带行为(t *testing.T) {
	c := QuickActionsCard()
	for _, btn := range buttonsOf(t, c) {
		if len(btn.Behaviors) == 0 {
			t.Errorf("按钮 %q 未挂 behaviors，点击不会有任何反应", btn.ButtonText.Content)
		}
	}
}

// Test禁用按钮不带行为 当前项的按钮是禁用的，不该挂回调。
func Test禁用按钮不带行为(t *testing.T) {
	c := SessionSelectCard(SessionSelectOptions{
		Nodes:     []SessionNode{{ID: "ses_a", Title: "A"}},
		CurrentID: "ses_a",
	})
	for _, btn := range buttonsOf(t, c) {
		if btn.Disabled && len(btn.Behaviors) != 0 {
			t.Error("禁用按钮不应挂 behaviors")
		}
	}
}

// Test行为类型必须小写 第二条真机踩坑：写成 "Callback" / "OpenURL"
// 会报 `unknown behavior type`（ErrCode 200621）。
//
// 飞书对取值大小写敏感，而本地序列化完全不感知这一点——
// 所以必须在这里把正确取值钉死。
func Test行为类型必须小写(t *testing.T) {
	cases := []struct {
		name string
		card *Card
	}{
		{"权限审批", PermissionCard(PermissionRequest{ID: "per_1", Action: "bash"})},
		{"会话选择", SessionSelectCard(SessionSelectOptions{
			Nodes: []SessionNode{{ID: "ses_a", Title: "A"}},
		})},
		{"快捷操作", QuickActionsCard()},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			raw, err := c.card.JSON()
			if err != nil {
				t.Fatal(err)
			}
			var m map[string]any
			_ = json.Unmarshal([]byte(raw), &m)

			var walk func(elems []any)
			walk = func(elems []any) {
				for _, raw := range elems {
					el, ok := raw.(map[string]any)
					if !ok {
						continue
					}
					if list, ok := el["behaviors"].([]any); ok {
						for _, item := range list {
							b, ok := item.(map[string]any)
							if !ok {
								continue
							}
							typ, _ := b["type"].(string)
							if typ != strings.ToLower(typ) {
								t.Errorf("behavior type = %q 必须全小写", typ)
							}
							if typ != BehaviorCallback && typ != BehaviorOpenURL && typ != BehaviorFormAction {
								t.Errorf("behavior type = %q 不在合法取值内", typ)
							}
						}
					}
					if ce, ok := el["elements"].([]any); ok {
						walk(ce)
					}
					if cols, ok := el["columns"].([]any); ok {
						for _, c := range cols {
							if col, ok := c.(map[string]any); ok {
								if ce, ok := col["elements"].([]any); ok {
									walk(ce)
								}
							}
						}
					}
				}
			}
			body := m["body"].(map[string]any)
			walk(body["elements"].([]any))
		})
	}
}

// TestValidate拒绝大小写错误的behavior 保证 Validate 真能抓出这一类，
// 而不是永远返回空。
func TestValidate拒绝大小写错误的behavior(t *testing.T) {
	bad := &Card{
		Schema: "2.0",
		Header: &Header{Title: PlainText{Tag: "plain_text", Content: "x"}},
		Body: Body{
			Direction: "vertical",
			Elements: []Element{{
				Tag:        "button",
				ButtonText: &PlainText{Tag: "plain_text", Content: "点"},
				Behaviors:  []ButtonBehavior{{Type: "Callback", Value: map[string]any{"a": "b"}}},
			}},
		},
	}
	problems := bad.Validate()
	if len(problems) == 0 {
		t.Fatal("Validate 没有抓出大小写错误的 behavior type")
	}
	if !strings.Contains(strings.Join(problems, ";"), "不合法") {
		t.Errorf("应指出类型不合法，实际: %v", problems)
	}
}

// TestValidate拒绝缺字段的behavior open_url 的 default_url 是必填。
func TestValidate拒绝缺字段的behavior(t *testing.T) {
	bad := &Card{
		Schema: "2.0",
		Header: &Header{Title: PlainText{Tag: "plain_text", Content: "x"}},
		Body: Body{
			Direction: "vertical",
			Elements: []Element{{
				Tag:        "button",
				ButtonText: &PlainText{Tag: "plain_text", Content: "点"},
				Behaviors:  []ButtonBehavior{{Type: BehaviorOpenURL}},
			}},
		},
	}
	problems := bad.Validate()
	found := false
	for _, p := range problems {
		if strings.Contains(p, "default_url") {
			found = true
		}
	}
	if !found {
		t.Errorf("应报出缺 default_url，实际: %v", problems)
	}
}
