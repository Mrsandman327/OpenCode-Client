// session_card.go —— 会话选择卡片
//
// 对应 opencode-feishu-bot 的 src/feishu/session-card.ts，
// 连同其「按层级识别子会话」的修复一并移植（见 fbc48e5）。
//
// 层级问题的由来：V2 的子代理（subagent）会话与主会话同目录共存，
// 平铺混排时实测最近 50 条里 39 条（78%）是子会话，主会话被淹没。
//
// 切换语义：子会话**可见但不可点**。切进子代理会话意味着后续消息进入
// 子代理的上下文，主对话线就此分叉，而当前没有「回到父会话」的入口——
// 误点的代价是把对话发到错误的地方。做成 disabled 按钮看起来像坏了，
// 所以用标注行：看得见、认得出层级、明确不可点。
package feishu

import (
	"fmt"
	"strings"
	"time"
)

// sessionCardDefaults 对齐 bot 侧默认值。
const (
	defaultSessionLimit    = 10
	buttonTextLimit        = 30
	childTextLimit         = 24
	defaultChildrenPerRoot = 5
)

// SessionNode 是会话树的一个节点。
type SessionNode struct {
	ID      string
	Title   string
	Updated time.Time
	// ParentID 非空表示这是子会话。
	ParentID string
	Children []SessionNode
	// HiddenChildCount 是因 MaxChildrenPerRoot 截断而未展示的子会话数。
	HiddenChildCount int
}

// SessionSelectOptions 是会话选择卡的参数。
type SessionSelectOptions struct {
	Nodes []SessionNode
	// CurrentID 是当前会话，会禁用其按钮。
	CurrentID string
	// Limit 是一级会话按钮的渲染上限。
	Limit int
	// UnattachedChildCount 是父会话未在展示集合内的子会话数。
	UnattachedChildCount int
	// TotalRoots 是服务端共有多少个一级会话；0 表示未知。
	TotalRoots int
	// Now 用于测试注入时间。
	Now time.Time
}

// SessionSelectCard 生成会话选择卡片。
func SessionSelectCard(o SessionSelectOptions) *Card {
	limit := o.Limit
	if limit <= 0 {
		limit = defaultSessionLimit
	}
	now := o.Now
	if now.IsZero() {
		now = time.Now()
	}

	shown := o.Nodes
	if len(shown) > limit {
		shown = shown[:limit]
	}
	childTotal := countChildren(o.Nodes)

	c := NewCard().WithHeader("📂 选择会话", TemplateBlue)

	if len(o.Nodes) == 0 {
		return c.Note("暂无历史会话")
	}

	// 标题里把层级讲清楚，避免用户以为这是一份平铺列表
	if childTotal > 0 {
		c.Markdown(fmt.Sprintf("共 %d 个主会话、%d 个子会话，点击主会话按钮切换：", len(o.Nodes), childTotal), "normal")
	} else {
		c.Markdown(fmt.Sprintf("共 %d 个历史会话，点击下方按钮切换：", len(o.Nodes)), "normal")
	}

	for _, node := range shown {
		title := truncate(strings.TrimSpace(node.Title), buttonTextLimit)
		if title == "" {
			title = "(无标题)"
		}
		label := title
		if node.ID == o.CurrentID {
			label = "✅ " + title
		}

		ts := formatSessionTime(node.Updated, now)
		text := label
		if ts != "" {
			text = label + "  " + ts
		}

		if node.ID == o.CurrentID {
			// 当前会话禁用，避免重复切换
			c.ButtonDisabled(text)
		} else {
			c.Button(text, "primary_filled", map[string]any{
				"action":     ActionSessionSelect,
				"session_id": node.ID,
			}, "")
		}

		appendChildRows(c, node.Children, 1)
		// 根节点自己被截断的子会话也要提示，否则这部分数据静默消失
		if node.HiddenChildCount > 0 {
			c.Note(fmt.Sprintf("%s⋯ 另有 %d 个更早的子会话", indent(depthOfRoot), node.HiddenChildCount))
		}
	}

	// 三类截断都要如实说明，不能静默隐藏
	var notes []string
	if o.TotalRoots > len(o.Nodes) {
		notes = append(notes, fmt.Sprintf("另有 %d 个更早的主会话", o.TotalRoots-len(o.Nodes)))
	}
	if len(o.Nodes) > len(shown) {
		notes = append(notes, fmt.Sprintf("已显示最近 %d 个，另有 %d 个更早的主会话", len(shown), len(o.Nodes)-len(shown)))
	}
	if o.UnattachedChildCount > 0 {
		notes = append(notes, fmt.Sprintf("另有 %d 个子会话的父会话较久，未取到", o.UnattachedChildCount))
	}
	if len(notes) > 0 {
		c.HR()
		c.Note(strings.Join(notes, "；") + "。可用 `/use <会话ID>` 指定。")
	}

	return c
}

// depthOfRoot 是一级会话下子会话行的缩进深度。
const depthOfRoot = 1

// appendChildRows 渲染子会话标注行（缩进随层级加深）。
func appendChildRows(c *Card, children []SessionNode, depth int) {
	for _, child := range children {
		title := truncate(strings.TrimSpace(child.Title), childTextLimit)
		if title == "" {
			title = "(无标题)"
		}
		ts := formatSessionTime(child.Updated, time.Time{})
		line := fmt.Sprintf("%s↳ %s  `%s`", indent(depth), title, truncate(child.ID, 14))
		if ts != "" {
			line += "  " + ts
		}
		c.Note(line)

		if child.HiddenChildCount > 0 {
			c.Note(fmt.Sprintf("%s⋯ 另有 %d 个更早的子会话", indent(depth), child.HiddenChildCount))
		}
		appendChildRows(c, child.Children, depth+1)
	}
}

// indent 生成缩进。用全角空格：在飞书 markdown 下比半角稳定。
func indent(depth int) string {
	if depth <= 0 {
		return ""
	}
	return strings.Repeat("　", depth)
}

// formatSessionTime 格式化会话时间；零值返回空串（不显示 0001-01-01）。
func formatSessionTime(t, now time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format("2006-01-02 15:04")
}

// countChildren 统计子会话总数（**不含**传入的这些一级会话本身）。
//
// 注意与 countDescendants 的分工：这里只数 roots 的下一层及更深，
// 不把 roots 自身计入——否则「1 主 2 子」会被报成「1 主 3 子」。
func countChildren(roots []SessionNode) int {
	total := 0
	for _, r := range roots {
		total += len(r.Children)
		for _, child := range r.Children {
			total += countDescendants(child)
		}
	}
	return total
}

// countDescendants 统计某个节点之下（不含自身）的全部后代。
func countDescendants(n SessionNode) int {
	total := len(n.Children)
	for _, child := range n.Children {
		total += countDescendants(child)
	}
	return total
}
