// diff_card.go —— 代码改动统计卡片
//
// 对应 bot 的 src/feishu/diff-card.ts。
//
// 只展示统计与文件清单，不放 diff 全文：飞书卡片放不下全文，
// 且全文需要 30KB 截断（见 client.go 的 MaxCardBytes），
// 截断后的 diff 反而更没用——用户看不出改了什么。
package feishu

import (
	"fmt"
	"strings"
)

// maxDiffFiles 是最多列出的文件数。
const maxDiffFiles = 20

// FileDiffStat 是一个文件的改动统计。
type FileDiffStat struct {
	File      string
	Status    string
	Additions int
	Deletions int
}

// DiffCardOptions 是改动卡的参数。
type DiffCardOptions struct {
	Stats []FileDiffStat
	// SessionFileCount 是本会话触及的文件数；-1 表示未知（不显示）。
	SessionFileCount int
	// Limit 是最多列出的文件数；<=0 时用 maxDiffFiles。
	Limit int
}

// DiffCard 生成改动统计卡片。
func DiffCard(o DiffCardOptions) *Card {
	limit := o.Limit
	if limit <= 0 {
		limit = maxDiffFiles
	}

	if len(o.Stats) == 0 {
		// 无改动是常见状态，用灰色模板——蓝色会让用户以为是正常结果
		return NewCard().
			WithHeader("📊 本次改动", TemplateGrey).
			Markdown("本次会话没有文件改动", "normal")
	}

	var additions, deletions int
	for _, f := range o.Stats {
		additions += f.Additions
		deletions += f.Deletions
	}

	head := fmt.Sprintf("**%d** 个文件　<font color='green'>+%d</font>　<font color='red'>-%d</font>",
		len(o.Stats), additions, deletions)
	if o.SessionFileCount >= 0 {
		head += fmt.Sprintf("　（本会话触及 **%d** 个）", o.SessionFileCount)
	}

	c := NewCard().WithHeader("📊 本次改动", TemplateBlue)
	c.Markdown(head, "normal")
	c.HR()

	shown := o.Stats
	if len(shown) > limit {
		shown = shown[:limit]
	}
	for _, f := range shown {
		c.Note(fmt.Sprintf("%s `%s`　<font color='green'>+%d</font>/<font color='red'>-%d</font>",
			diffStatusIcon(f.Status), truncate(f.File, 50), f.Additions, f.Deletions))
	}

	if rest := len(o.Stats) - len(shown); rest > 0 {
		c.Note(fmt.Sprintf("另有 %d 个文件未列出", rest))
	}
	return c
}

// diffStatusIcon 把 git 状态映射为图标。
func diffStatusIcon(status string) string {
	switch strings.ToLower(status) {
	case "added", "new":
		return "🆕"
	case "deleted", "removed":
		return "🗑️"
	case "renamed":
		return "📝"
	case "touched", "modified":
		return "✍️"
	default:
		return "📄"
	}
}
