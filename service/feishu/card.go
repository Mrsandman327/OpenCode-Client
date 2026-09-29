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
	ButtonType string          `json:"type,omitempty"`  // primary_filled | default | danger
	Width      string          `json:"width,omitempty"` // fill | default
	Disabled   bool            `json:"disabled,omitempty"`
	Behavior   *ButtonBehavior `json:"behaviors,omitempty"`
	ButtonText *PlainText      `json:"text,omitempty"`

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
	// FormActionType 在提交按钮上取 "submit"。
	FormActionType string `json:"form_action_type,omitempty"`
}

// SelectOption 是下拉/多选候选项。
type SelectOption struct {
	Text  PlainText `json:"text"`
	Value string    `json:"value"`
}

// ButtonBehavior 描述按钮点击后的行为。
//
// 两类：
// - Callback：把 Value 回传给我们（用于会话选择、权限审批等）
// - OpenURL：直接打开链接
// 不设行为则点击无响应——这是最常见的「按钮点了没反应」原因。
type ButtonBehavior struct {
	Type         string         `json:"type"` // Callback | OpenURL
	BehaviorsURL string         `json:"url,omitempty"`
	DefaultURL   string         `json:"default_url,omitempty"`
	Value        map[string]any `json:"value,omitempty"`
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
		el.Behavior = &ButtonBehavior{Type: "OpenURL", DefaultURL: url}
	case value != nil:
		el.Behavior = &ButtonBehavior{Type: "Callback", Value: value}
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
