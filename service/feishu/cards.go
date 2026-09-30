// cards.go —— 业务卡片集
//
// 对应 opencode-feishu-bot 的 src/feishu/ 下各 *-card.ts 与 task-notification.ts。
// 移植而非重设计：这些卡片的文案与交互在 bot 侧已被实际使用验证过，
// 改动文案会带来与 bot 不一致的表现。
package feishu

import (
	"fmt"
	"strings"
	"time"
)

// 卡片按钮的 action 标识。必须与 bot 侧保持一致，否则两套系统的
// 卡片回调无法共用同一套处理逻辑。
const (
	ActionPermissionAllowOnce   = "opencode_permission_once"
	ActionPermissionAllowAlways = "opencode_permission_always"
	ActionPermissionReject      = "opencode_permission_reject"
	ActionSessionSelect         = "opencode_session_select"
)

// ── 通用 ──

// truncate 按字符（而非字节）截断，避免把中文字切一半。
func truncate(text string, max int) string {
	r := []rune(text)
	if len(r) <= max {
		return text
	}
	return string(r[:max-1]) + "…"
}

// ── 权限审批 ──

// PermissionRequest 是一个待审批的请求。
//
// 字段对应 V2 的 Permission.Request（spec 实测）：
// 必填 id/sessionID/action/resources；可选 save/metadata/source/message。
//
// ⚠️ **没有 title 字段**。V2 里承载说明文字的是 message——
// 按 title 读会恒为空，卡片上「请求标题」整段静默消失。
type PermissionRequest struct {
	ID        string
	Action    string
	Resources []string
	// Message 是请求自带的说明文字，可能为空。
	Message string
	// Save 是「始终允许」在本会话内会永久放行的资源清单。
	// 为空时按 Resources 处理——服务端在 reply 时会自行采用请求里的 save。
	Save []string
}

// PermissionCard 生成权限审批卡片。
func PermissionCard(req PermissionRequest) *Card {
	c := NewCard().WithHeader("🔐 需要确认", TemplateOrange)

	if req.Message != "" {
		c.Markdown("**"+req.Message+"**", "normal")
	}

	// 资源列表最多 5 条，超出明示余量
	res := renderResources(req.Resources)
	c.Markdown(fmt.Sprintf("**操作**: `%s`\n**资源**:\n%s", truncate(req.Action, 60), res), "normal")

	if note := permissionScopeNote(req); note != "" {
		c.Note(note)
	}

	c.Button("允许一次", "primary_filled", map[string]any{
		"action":     ActionPermissionAllowOnce,
		"request_id": req.ID,
	}, "")
	c.Button("始终允许", "default", map[string]any{
		"action":     ActionPermissionAllowAlways,
		"request_id": req.ID,
	}, "")
	c.Button("拒绝", "danger", map[string]any{
		"action":     ActionPermissionReject,
		"request_id": req.ID,
	}, "")

	return c
}

func renderResources(resources []string) string {
	if len(resources) == 0 {
		return "(无)"
	}
	limit := 5
	if len(resources) < limit {
		limit = len(resources)
	}
	parts := make([]string, 0, limit)
	for _, r := range resources[:limit] {
		parts = append(parts, "`"+truncate(r, 60)+"`")
	}
	out := strings.Join(parts, "\n")
	if rest := len(resources) - limit; rest > 0 {
		out += fmt.Sprintf("\n… 另有 %d 项", rest)
	}
	return out
}

// permissionScopeNote 说明「始终允许」的真实授权范围。
//
// V2 的 always 是**本会话内**对该 resource 永久放行：不写入全局
// permission.saved，换一条命令仍会再问。不写清楚容易被理解成永久放行，
// 导致用户在不熟悉的操作上点了「始终允许」。
func permissionScopeNote(req PermissionRequest) string {
	scope := req.Save
	if len(scope) == 0 {
		scope = req.Resources
	}
	if len(scope) == 0 {
		return ""
	}
	limit := 3
	if len(scope) < limit {
		limit = len(scope)
	}
	parts := make([]string, 0, limit)
	for _, s := range scope[:limit] {
		parts = append(parts, "`"+truncate(s, 40)+"`")
	}
	list := strings.Join(parts, "、")
	if rest := len(scope) - limit; rest > 0 {
		list += fmt.Sprintf(" 等 %d 项", rest)
	}
	return "ℹ️ **始终允许** = 本会话内不再询问 " + list + "；换其它命令仍会再问。不会写入全局配置。"
}

// ── 用量统计 ──

// TokenUsage 是 token 消耗。字段与 V2 的 TokenUsageInfo 对应。
type TokenUsage struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	Reasoning  int64 `json:"reasoning"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
}

// Usage 是会话用量。
type Usage struct {
	Cost   float64    `json:"cost"`
	Tokens TokenUsage `json:"tokens"`
}

// UsageCard 生成用量统计卡片。
func UsageCard(u Usage) *Card {
	lines := []string{
		fmt.Sprintf("**费用**: $%.4f", u.Cost),
		fmt.Sprintf("**输入**: %s", commaInt(u.Tokens.Input)),
		fmt.Sprintf("**输出**: %s", commaInt(u.Tokens.Output)),
	}
	// 零值不显示：推理/缓存常常是 0，全列出来只是噪音
	if u.Tokens.Reasoning > 0 {
		lines = append(lines, fmt.Sprintf("**推理**: %s", commaInt(u.Tokens.Reasoning)))
	}
	if u.Tokens.CacheRead > 0 {
		lines = append(lines, fmt.Sprintf("**缓存读**: %s", commaInt(u.Tokens.CacheRead)))
	}
	if u.Tokens.CacheWrite > 0 {
		lines = append(lines, fmt.Sprintf("**缓存写**: %s", commaInt(u.Tokens.CacheWrite)))
	}

	return NewCard().
		WithHeader("📈 用量统计", TemplateBlue).
		Markdown(strings.Join(lines, "\n"), "normal")
}

// commaInt 给数字加千分位，便于快速读量级。
func commaInt(n int64) string {
	s := fmt.Sprintf("%d", n)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")

	var parts []string
	for len(s) > 3 {
		parts = append([]string{s[len(s)-3:]}, parts...)
		s = s[:len(s)-3]
	}
	parts = append([]string{s}, parts...)

	out := strings.Join(parts, ",")
	if neg {
		out = "-" + out
	}
	return out
}

// ── 后台任务通知 ──

// LongTaskSeconds 是判定长任务的阈值：超过它才在结束时额外推通知。
const LongTaskSeconds = 30

// maxSummaryChars 是通知摘要的最大字符数。
const maxSummaryChars = 1500

// maxTitleChars 是卡片里会话标题的长度上限。
const maxTitleChars = 32

// TaskNotification 是一次后台任务完成的通知内容。
//
// ⚠️ 职责边界（这是本结构被改写的原因）：
// **正文只由流式卡承载，通知卡只承载元信息。**
//
// 此前这里有个 Output 字段，而它就是 fullContent —— 与流式卡上已经
// 逐字显示过的正文同源。超过 30 秒的任务因此把同一份正文**发了两遍**。
// 这不是「摘要更好」，是重复投递。
//
// 唯一例外：上方那张流式卡**没能成功送达**时（UpdateCard 真失败），
// 用户手上什么都没有，此时通知卡是唯一载体，必须带正文。
// 用 FallbackOutput 单独表达这个意图——它不是「要不要摘要」，
// 而是「有没有兜底的必要」，两者混在一个字段里必然复发。
type TaskNotification struct {
	ElapsedSeconds int
	Success        bool
	// FallbackOutput 是兜底正文。**只在没有可指向上方的流式卡时才填**
	// （如卡片更新真失败）。常规路径（流式卡已送达）必须留空——
	// 填了就等于把正文重发一遍。
	FallbackOutput string
	ProjectPath    string
	HasChanges     bool
	// SessionTitle 用于多标签页并行时辨认是哪一个会话；可能为空。
	SessionTitle string
	// SessionID 在标题缺失时兜底辨认。
	SessionID string
}

// bodyElsewhere 是正文在流式卡上时的指引文案。
const bodyElsewhere = "📄 完整回复见上方卡片"

// bodyElsewhereError 是错误分支的指引文案。
const bodyElsewhereError = "📄 错误详情见上方卡片"

// bodyFallbackHint 是正文因为兜底而必须出现在本卡时的说明。
const bodyFallbackHint = "⚠️ 上方回复卡片未能更新，正文附在此处"

// bodyFallbackHintError 是错误分支的兜底说明。
const bodyFallbackHintError = "⚠️ 上方回复卡片未能更新，错误详情附在此处"

// HasFallbackBody 判断本卡是否需要兜底展示正文。
//
// 单独抽成函数而不是内联在建卡逻辑里：「该不该重复正文」是一条
// 产品规则，值得被独立断言。
func HasFallbackBody(n TaskNotification) bool {
	return strings.TrimSpace(n.FallbackOutput) != ""
}

// ShouldNotifyTask 判断任务是否值得额外通知。
//
// 短任务本来就有流式卡片在更新，结束时再推一条是噪音；
// 长任务用户往往已切走，漏掉通知会以为任务死了。
func ShouldNotifyTask(elapsed time.Duration) bool {
	return elapsed.Seconds() >= LongTaskSeconds
}

// TaskNotificationCard 生成任务完成通知卡片。
func TaskNotificationCard(n TaskNotification) *Card {
	head := "✅ 任务完成"
	template := TemplateGreen
	if !n.Success {
		head = "❌ 任务失败"
		template = TemplateRed
	}
	c := NewCard().WithHeader(head, template)

	// 标题可能为空（OpenCode 尚未生成），回退短 ID
	title := strings.TrimSpace(n.SessionTitle)
	if title == "" {
		title = truncate(n.SessionID, 12)
	}
	if title == "" {
		title = "(无标题)"
	}
	c.Markdown(fmt.Sprintf("**会话**: %s\n**耗时**: %s",
		truncate(title, maxTitleChars), humanDuration(n.ElapsedSeconds)), "normal")

	if n.ProjectPath != "" {
		c.Markdown("**项目**: `"+truncate(n.ProjectPath, 70)+"`", "normal")
	}
	if n.HasChanges {
		c.Markdown("**有文件改动**", "normal")
	}

	c.HR()
	if HasFallbackBody(n) {
		// 唯一允许在通知卡里出现正文的分支：上方卡片没送达
		hint := bodyFallbackHint
		if !n.Success {
			hint = bodyFallbackHintError
		}
		c.Markdown(hint, "normal")
		c.Markdown(summarizeOutput(n.FallbackOutput), "normal")
		return c
	}
	if n.Success {
		c.Markdown(bodyElsewhere, "normal")
	} else {
		c.Markdown(bodyElsewhereError, "normal")
	}
	return c
}

// summarizeOutput 截断输出为通知摘要。
//
// 截断必须标注总长度，否则用户会把残缺内容当成全部结论。
func summarizeOutput(output string) string {
	text := strings.TrimSpace(output)
	if text == "" {
		return ""
	}
	r := []rune(text)
	if len(r) <= maxSummaryChars {
		return text
	}
	return string(r[:maxSummaryChars]) + fmt.Sprintf("\n… 已截断（共 %d 字）", len(r))
}

// humanDuration 把秒数格式化成易读时长。
func humanDuration(seconds int) string {
	switch {
	case seconds < 60:
		return fmt.Sprintf("%d 秒", seconds)
	case seconds < 3600:
		return fmt.Sprintf("%d 分 %d 秒", seconds/60, seconds%60)
	default:
		return fmt.Sprintf("%d 小时 %d 分", seconds/3600, (seconds%3600)/60)
	}
}
