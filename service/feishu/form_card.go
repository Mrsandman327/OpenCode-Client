// form_card.go —— OpenCode form（向用户提问）卡片
//
// 对应 bot 的 src/feishu/form-card.ts。
//
// 数据契约来自真实会话实测（2026-09），**不是**旧版 question-card 的假设：
//   - 旧版（错）：questions[].options[].label + questions[].multiple 决定单/多选
//   - 实际（对）：fields[].options[].value/label/description，fields[].type 决定样式，
//     fields[].custom 表示允许自填
//
// bot 仓里 question-card.ts 至今仍在（且自带测试），但已无任何运行时路径引用，
// 属死代码——其契约已被实测证伪。这里刻意不复刻它，避免把已证伪的假设
// 重新带进 Go 侧。
package feishu

import (
	"fmt"
	"strings"
)

// 表单 action 标识。
const (
	ActionFormSubmit = "opencode_form_submit"
	ActionFormCancel = "opencode_form_cancel"
)

// 表单各项的长度上限（飞书单行显示有限）。
const (
	optionLabelLimit = 40
	optionDescLimit  = 90
	fieldTitleLimit  = 60
)

// FormFieldOption 是候选项。
type FormFieldOption struct {
	Value       string `json:"value"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// FormField 是表单的一个字段。
type FormField struct {
	Key         string `json:"key"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	// Type 实测样本里单选取值 "string"；其余取值原样保留。
	Type string `json:"type"`
	// Options 是候选项。为空时无下拉框（仅靠 custom 输入框）。
	Options []FormFieldOption `json:"options,omitempty"`
	// Custom 允许用户自填答案。
	Custom bool `json:"custom,omitempty"`
}

// FormInfo 是 OpenCode form 的完整信息。
type FormInfo struct {
	ID        string         `json:"id"`
	SessionID string         `json:"sessionID"`
	Title     string         `json:"title"`
	Metadata  map[string]any `json:"metadata,omitempty"`
	Fields    []FormField    `json:"fields"`
}

// IsMultiSelect 判断字段是否应渲染为多选。
//
// 实测样本里单选的 type 是 "string"。多选的确切取值未在样本中出现，
// 这里按「显式声明为多选」一条线索判定；不满足时**保守按单选处理**——
// 误判成多选会让用户以为可以选多个，改成单选只是少选，不产生错误提交。
func IsMultiSelect(field FormField) bool {
	t := strings.ToLower(field.Type)
	return strings.Contains(t, "array") ||
		strings.Contains(t, "multi") ||
		t == "list"
}

// formFieldName 生成字段的表单控件名。索引参与命名，否则多字段会互相覆盖。
func formFieldName(index int, key string) string {
	return fmt.Sprintf("f%d_%s", index, key)
}

// renderField 渲染一个字段的全部卡片元素。
func renderField(field FormField, index int) []Element {
	var rows []Element

	rows = append(rows, Element{
		Tag:      "markdown",
		Content:  fmt.Sprintf("**%d.** %s", index+1, truncate(field.Title, fieldTitleLimit)),
		TextSize: "normal",
	})

	if field.Description != "" {
		rows = append(rows, Element{
			Tag:      "markdown",
			Content:  "<font color='grey'>" + truncate(field.Description, optionDescLimit) + "</font>",
			TextSize: "notation",
		})
	}

	if len(field.Options) > 0 {
		multi := IsMultiSelect(field)
		tag := "select_static"
		placeholder := "请选择"
		if multi {
			tag = "multi_select_static"
			placeholder = "可多选"
		}

		opts := make([]SelectOption, 0, len(field.Options))
		for _, o := range field.Options {
			opts = append(opts, SelectOption{
				Text:  PlainText{Tag: "plain_text", Content: truncate(o.Label, optionLabelLimit)},
				Value: o.Value,
			})
		}

		rows = append(rows, Element{
			Tag:         tag,
			Placeholder: &PlainText{Tag: "plain_text", Content: placeholder},
			Options:     opts,
			ButtonType:  "default",
			Width:       "default",
			// custom 允许自填，因此有候选项时也不强制必填
			Required: !field.Custom,
			Name:     formFieldName(index, field.Key),
		})

		// 选项说明单独列出：飞书的 select 不支持选项级 description
		var described []string
		for _, o := range field.Options {
			if o.Description != "" {
				described = append(described, fmt.Sprintf("• **%s**：%s",
					truncate(o.Label, optionLabelLimit), truncate(o.Description, optionDescLimit)))
			}
		}
		if len(described) > 0 {
			rows = append(rows, Element{
				Tag:      "markdown",
				Content:  strings.Join(described, "\n"),
				TextSize: "notation",
			})
		}
	}

	// custom 允许自填；即使有候选项也保留输入框
	if field.Custom {
		rows = append(rows, Element{
			Tag:         "input",
			Placeholder: &PlainText{Tag: "plain_text", Content: "或直接输入你的答案"},
			Width:       "default",
			Name:        formFieldName(index, field.Key) + "__custom",
		})
	}

	return rows
}

// FormCard 构建待回答的 form 卡片。
func FormCard(form FormInfo) *Card {
	title := form.Title
	if title == "" {
		title = "需要你确认"
	}

	var elems []Element
	for i, field := range form.Fields {
		if i > 0 {
			elems = append(elems, Element{Tag: "hr"})
		}
		elems = append(elems, renderField(field, i)...)
	}

	// 提交按钮单独装进 column_set。
	//
	// ⚠️ schema 2.0 下表单提交走 behaviors 的 form_action，
	// 不是 1.0 的 form_action_type —— 后者在 2.0 下不生效，
	// 表现为按钮点了没反应。
	elems = append(elems, Element{Tag: "hr"})
	elems = append(elems, Element{
		Tag:             "column_set",
		FlexMode:        "flow",
		HorizontalSpace: "8px",
		HorizontalAlign: "left",
		Columns: []Column{{
			Tag:   "column",
			Width: "auto",
			Elements: []Element{{
				Tag:        "button",
				ButtonType: "primary_filled",
				ButtonText: &PlainText{Tag: "plain_text", Content: "提交"},
				Behaviors: []ButtonBehavior{{
					Type:     BehaviorFormAction,
					Behavior: "submit",
				}},
				Name: "submit_btn",
			}},
		}},
	})

	// 有自填字段才提示：否则用户会去找一个不存在的输入框
	anyCustom := false
	for _, f := range form.Fields {
		if f.Custom {
			anyCustom = true
			break
		}
	}
	if anyCustom {
		elems = append(elems, Element{
			Tag:      "markdown",
			Content:  "💬 也可以直接发消息回答",
			TextSize: "notation",
		})
	}

	c := &Card{
		Schema: "2.0",
		Config: CardConfig{UpdateMulti: true},
		Header: &Header{
			Title:    PlainText{Tag: "plain_text", Content: "❓ " + title},
			Template: TemplateOrange,
		},
		Body: Body{
			Direction: "vertical",
			Elements: []Element{{
				Tag:             "form",
				Name:            "opencode_form_" + form.ID,
				Elements:        elems,
				VerticalSpacing: "10px",
			}},
		},
	}
	return c
}

// FormAnsweredCard 生成提交后的回执卡片。
func FormAnsweredCard(form FormInfo, answers []string) *Card {
	c := NewCard().WithHeader("✅ 已回答", TemplateTurquoise)
	for i, field := range form.Fields {
		if i > 0 {
			c.HR()
		}
		c.Markdown("**"+field.Title+"**", "normal")
		answer := ""
		if i < len(answers) {
			answer = answers[i]
		}
		if answer == "" {
			answer = "(未回答)"
		}
		c.Markdown(answer, "normal")
	}
	return c
}
