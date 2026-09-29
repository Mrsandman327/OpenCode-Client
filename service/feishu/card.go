// card.go —— 飞书卡片（schema 2.0）构建
//
// 用 Go 结构体而非 map[string]any 拼卡片：卡片字段嵌套深、名称长，
// 用 map 拼装极易写错键名且编译期无感知。结构体在编译期就能暴露拼装错误。
//
// 对应 opencode-feishu-bot 的 src/channels/feishu/card-builder.ts。
package feishu

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Card 是飞书 schema 2.0 卡片的顶层结构。
type Card struct {
	Schema string     `json:"schema"`
	Config CardConfig `json:"config"`
	Header *Header    `json:"header,omitempty"`
	Body   Body       `json:"body"`
}

// CardConfig 控制卡片行为。
type CardConfig struct {
	// UpdateMulti 允许一张卡片被多次更新。
	// 流式回复必须开启，否则第二次 UpdateCard 会被拒。
	UpdateMulti bool `json:"update_multi"`
	// StreamingMode 开启卡片流式渲染（若服务端支持）。
	StreamingMode bool `json:"streaming_mode,omitempty"`
	// Summary 卡片折叠时显示的摘要。
	Summary *CardSummary `json:"summary,omitempty"`
}

// CardSummary 是卡片折叠态的摘要内容。
type CardSummary struct {
	Title *PlainText `json:"title,omitempty"`
	Text  string     `json:"text,omitempty"`
}

// Header 是卡片头部（标题条）。
type Header struct {
	Title    PlainText `json:"title"`
	Template string    `json:"template,omitempty"`
}

// PlainText 是纯文本元素。
type PlainText struct {
	Tag     string `json:"tag"`
	Content string `json:"content"`
}

// Body 是卡片主体。
type Body struct {
	Direction string    `json:"direction"`
	Elements  []Element `json:"elements"`
}

// Element 是卡片元素的统一表示。
//
// 飞书卡片的元素是「多态」的：markdown / button / column_set / hr / div 各有
// 自己的字段。用单一结构体承载全部可读字段，未设置的字段靠 omitempty 消失，
// 这样调用方可以按需填字段而不必关心类型断言。
//
// ⚠️ 同一结构体内**不得出现重复的 json tag**：encoding/json 遇到同层同名
// 字段会静默把两者都丢弃（不报错），表现为卡片上按钮没有标签、div 没有文本。
// button 与 div 都需要 "text" 字段，这里只保留 button 的（ButtonText），
// div 需要时另建独立类型。
type Element struct {
	Tag string `json:"tag"`

	// markdown
	Content   string `json:"content,omitempty"`
	TextSize  string `json:"text_size,omitempty"` // notation | normal | heading
	Href      string `json:"href,omitempty"`
	ElementID string `json:"element_id,omitempty"`

	// button
	ButtonType string `json:"type,omitempty"`  // primary_filled | default | danger
	Width      string `json:"width,omitempty"` // fill | default
	Disabled   bool   `json:"disabled,omitempty"`
	// ⚠️ behaviors 必须是**数组**。写成单个对象时飞书报
	// `expected slice for behaviors, but: map[...]`（ErrCode 200621），
	// 整张卡片被拒——而本地所有测试都会通过，因为它们只验 JSON 合法，
	// 不验飞书的 schema。
	Behaviors  []ButtonBehavior `json:"behaviors,omitempty"`
	ButtonText *PlainText       `json:"text,omitempty"`

	// column_set
	FlexMode        string   `json:"flex_mode,omitempty"` // flow | stretch | flow_both
	HorizontalSpace string   `json:"horizontal_spacing,omitempty"`
	HorizontalAlign string   `json:"horizontal_align,omitempty"`
	Columns         []Column `json:"columns,omitempty"`

	// div 的键值对字段
	Fields []Field `json:"fields,omitempty"`

	// note / form 的子元素
	Elements []Element `json:"elements,omitempty"`

	// form
	Name            string `json:"name,omitempty"`
	VerticalSpacing string `json:"vertical_spacing,omitempty"`

	// select_static / multi_select_static / input
	// 这些字段与 button 共用部分键：type 复用 ButtonType、width 复用 Width，
	// 因为两者的 JSON 键名本来就相同（"type" / "width"），不存在语义冲突。
	Placeholder *PlainText     `json:"placeholder,omitempty"`
	Options     []SelectOption `json:"options,omitempty"`
	Required    bool           `json:"required,omitempty"`
}

// SelectOption 是下拉/多选候选项。
type SelectOption struct {
	Text  PlainText `json:"text"`
	Value string    `json:"value"`
}

// ButtonBehavior 描述按钮点击后的行为。
//
// 两类（**取值必须小写**，飞书 schema 2.0 是大小写敏感的）：
// - callback：把 Value 回传给我们（用于会话选择、权限审批等）
// - open_url：直接打开链接，default_url 为**必填**的兜底地址
//
// 不设行为则点击无响应——这是最常见的「按钮点了没反应」原因。
//
// ⚠️ 两次踩坑都只在真机发卡时暴露（ErrCode 200621）：
//  1. Behaviors 写成单个对象 → `expected slice for behaviors`
//  2. type 写成 "Callback"   → `unknown behavior type`
//
// 两次本地测试全绿：json.Marshal 只验「合法 JSON」，不验飞书 schema。
// 因此 Validate() 把这些约束固化成了断言。
type ButtonBehavior struct {
	Type string `json:"type"` // callback | open_url | form_action
	// DefaultURL 是 open_url 的兜底跳转地址（该类型下必填）。
	DefaultURL string `json:"default_url,omitempty"`
	// Behavior 是 form_action 类型下的动作（submit / cancel）。
	Behavior string `json:"behavior,omitempty"`
	// Value 是回传给我们的数据，callback 类型使用。
	Value map[string]any `json:"value,omitempty"`
}

// Column 是 column_set 中的一列。
type Column struct {
	Tag           string    `json:"tag"`
	Width         string    `json:"width,omitempty"`
	VerticalAlign string    `json:"vertical_align,omitempty"`
	Elements      []Element `json:"elements"`
}

// Field 是 div 里的键值对。
type Field struct {
	IsShort bool      `json:"is_short"`
	Text    PlainText `json:"text"`
}

// 模板颜色：飞书预定义的一组色板，不要自造。
const (
	TemplateBlue      = "blue"
	TemplateWathet    = "wathet"
	TemplateTurquoise = "turquoise"
	TemplateGreen     = "green"
	TemplateYellow    = "yellow"
	TemplateOrange    = "orange"
	TemplateRed       = "red"
	TemplateCarmine   = "carmine"
	TemplateViolet    = "violet"
	TemplatePurple    = "purple"
	TemplateIndigo    = "indigo"
	TemplateGrey      = "grey"
)

// 按钮行为类型的固定值。
//
// ⚠️ **必须小写**：飞书 schema 2.0 对这些取值大小写敏感。
// 写成 "Callback" / "OpenURL" 会在真机发卡时报
// ErrCode 200621「unknown behavior type」——而本地 json.Marshal
// 照样产出合法 JSON，测试全绿。
const (
	// BehaviorCallback 把 Value 回传到服务端。
	BehaviorCallback = "callback"
	// BehaviorOpenURL 打开链接，default_url 必填。
	BehaviorOpenURL = "open_url"
	// BehaviorFormAction 表单事件（submit/cancel）。
	BehaviorFormAction = "form_action"
)

// NewCard 建一张空白纵向卡片。
func NewCard() *Card {
	return &Card{
		Schema: "2.0",
		Config: CardConfig{UpdateMulti: true},
		Body:   Body{Direction: "vertical"},
	}
}

// WithHeader 设置标题条。template 为空则用蓝色。
func (c *Card) WithHeader(title, template string) *Card {
	if template == "" {
		template = TemplateBlue
	}
	c.Header = &Header{
		Title:    PlainText{Tag: "plain_text", Content: title},
		Template: template,
	}
	return c
}

// WithSummary 设置折叠摘要，让长内容折叠时仍可辨识。
func (c *Card) WithSummary(text string) *Card {
	c.Config.Summary = &CardSummary{Text: text}
	return c
}

// Add 追加元素。
func (c *Card) Add(elems ...Element) *Card {
	c.Body.Elements = append(c.Body.Elements, elems...)
	return c
}

// Markdown 加一段 markdown 文本。size 为空则默认 normal。
func (c *Card) Markdown(content, size string) *Card {
	if size == "" {
		size = "normal"
	}
	return c.Add(Element{Tag: "markdown", Content: content, TextSize: size})
}

// Note 加一段小字注解。
func (c *Card) Note(content string) *Card {
	return c.Add(Element{Tag: "markdown", Content: content, TextSize: "notation"})
}

// HR 加一条分隔线。
func (c *Card) HR() *Card {
	return c.Add(Element{Tag: "hr"})
}

// Button 加一个按钮。
//
// value 非空时自动挂 Callback 行为（点击后把 value 回传）；
// url 非空时自动挂 OpenURL 行为。
func (c *Card) Button(label, buttonType string, value map[string]any, url string) *Card {
	if buttonType == "" {
		buttonType = "primary_filled"
	}
	el := Element{
		Tag:        "button",
		ButtonType: buttonType,
		Width:      "fill",
		ButtonText: &PlainText{Tag: "plain_text", Content: label},
	}
	switch {
	case url != "":
		el.Behaviors = []ButtonBehavior{{Type: BehaviorOpenURL, DefaultURL: url}}
	case value != nil:
		el.Behaviors = []ButtonBehavior{{Type: BehaviorCallback, Value: value}}
	}
	return c.Add(el)
}

// ButtonDisabled 加一个禁用按钮（用于标注「当前项」）。
func (c *Card) ButtonDisabled(label string) *Card {
	return c.Add(Element{
		Tag:        "button",
		ButtonType: "default",
		Width:      "fill",
		Disabled:   true,
		ButtonText: &PlainText{Tag: "plain_text", Content: label},
	})
}

// Columns 加一行多列布局。cols 必须是 []Element 的切片列表。
func (c *Card) Columns(cols ...[]Element) *Card {
	set := &Element{
		Tag:             "column_set",
		FlexMode:        "flow",
		HorizontalSpace: "8px",
		HorizontalAlign: "left",
	}
	for _, col := range cols {
		set.Columns = append(set.Columns, Column{
			Tag:      "column",
			Width:    "auto",
			Elements: col,
		})
	}
	return c.Add(*set)
}

// JSON 序列化为卡片 JSON 字符串。
//
// SDK 的 SendInput.Card 与流式 UpdateCard 都要求字符串形态的 JSON。
func (c *Card) JSON() (string, error) {
	b, err := json.Marshal(c)
	if err != nil {
		return "", fmt.Errorf("序列化卡片失败: %w", err)
	}
	return string(b), nil
}

// Validate 按飞书卡片 schema 检查已知易错点。
//
// 存在的理由：json.Marshal 只保证「是合法 JSON」，不保证「飞书接受」。
// 真实踩过的坑——behaviors 写成单个对象而不是数组，飞书返回
// ErrCode 200621「expected slice for behaviors」，整张卡片被拒，
// 而本地所有测试都通过。这类「本地产出合法、远端拒收」的契约
// 只能靠把已知约束固化成断言来防。
func (c *Card) Validate() []string {
	var problems []string
	raw, err := c.JSON()
	if err != nil {
		return []string{"序列化失败: " + err.Error()}
	}
	var probe map[string]any
	if err := json.Unmarshal([]byte(raw), &probe); err != nil {
		return []string{"不是合法 JSON: " + err.Error()}
	}

	var walk func(elements []any, path string)
	walk = func(elements []any, path string) {
		for i, raw := range elements {
			el, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			here := fmt.Sprintf("%s[%d]", path, i)
			// behaviors 必须是数组，且类型取值必须合法
			if b, exists := el["behaviors"]; exists {
				list, isSlice := b.([]any)
				if !isSlice {
					problems = append(problems, fmt.Sprintf(
						"%s 的 behaviors 必须是数组，实际是 %T（飞书 ErrCode 200621）", here, b))
				}
				for _, item := range list {
					behavior, ok := item.(map[string]any)
					if !ok {
						problems = append(problems, here+" 的 behaviors 项必须是对象")
						continue
					}
					typ, _ := behavior["type"].(string)
					switch typ {
					case BehaviorCallback:
						// value 是必填的
						if _, ok := behavior["value"]; !ok {
							problems = append(problems, here+" 的 callback behavior 缺 value")
						}
					case BehaviorOpenURL:
						// default_url 是必填的
						if _, ok := behavior["default_url"]; !ok {
							problems = append(problems, here+" 的 open_url behavior 缺 default_url")
						}
					case BehaviorFormAction:
						if _, ok := behavior["behavior"]; !ok {
							problems = append(problems, here+" 的 form_action behavior 缺 behavior 字段")
						}
					case "":
						problems = append(problems, here+" 的 behavior 缺 type")
					default:
						// 飞书对取值大小写敏感：写 "Callback" 会报 unknown behavior type
						problems = append(problems, fmt.Sprintf(
							"%s 的 behavior type = %q 不合法，应为 %s / %s / %s（飞书 ErrCode 200621）",
							here, typ, BehaviorCallback, BehaviorOpenURL, BehaviorFormAction))
					}
				}
			}
			// button 必须有文字，否则渲染成空白块
			if tag, _ := el["tag"].(string); tag == "button" {
				if _, hasText := el["text"]; !hasText {
					problems = append(problems, here+" 的 button 缺 text")
				}
			}
			// 递归子元素
			if child, ok := el["elements"].([]any); ok {
				walk(child, here+".elements")
			}
			if cols, ok := el["columns"].([]any); ok {
				for ci, c := range cols {
					col, ok := c.(map[string]any)
					if !ok {
						continue
					}
					if ce, ok := col["elements"].([]any); ok {
						walk(ce, fmt.Sprintf("%s.columns[%d].elements", here, ci))
					}
				}
			}
		}
	}

	body, ok := probe["body"].(map[string]any)
	if !ok {
		return []string{"缺 body"}
	}
	elems, ok := body["elements"].([]any)
	if !ok {
		return []string{"body.elements 必须是数组"}
	}
	walk(elems, "body.elements")
	return problems
}

// MustValidate 返回校验问题的合并文本；无问题时返回空串。
func (c *Card) MustValidate() string {
	p := c.Validate()
	if len(p) == 0 {
		return ""
	}
	return strings.Join(p, "; ")
}

// MustJSON 序列化，失败时返回空串。仅用于确定不会失败的场景（如测试）。
func (c *Card) MustJSON() string {
	s, err := c.JSON()
	if err != nil {
		return ""
	}
	return s
}

// TextCard 是最简卡片：一段文本。
func TextCard(title, text string) *Card {
	return NewCard().WithHeader(title, TemplateBlue).Markdown(text, "normal")
}
