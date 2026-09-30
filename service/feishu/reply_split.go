// reply_split.go —— 长回复按字节分段
//
// 对应 opencode-feishu-bot 的 src/feishu/reply-split.ts。
//
// 缺陷根因（实测确证）：主回复路径把**全文**塞进一张卡片反复 patch。
// 飞书对卡片消息体有硬上限（见 FeishuCardMaxBytes），一旦超限，
// PATCH 每次都返回 230025，而 UpdateCard 对非限流错误只返回失败不抛 ——
// 于是每一次更新都失败，卡片**冻结在最后一次成功的状态**，用户看到「半截」。
// 这不是「截断」，是「静默丢弃更新」。
//
// 阈值依据（官方文档，非拍脑袋）：
//   - 飞书开放平台 `im/v1/messages/:message_id`（更新应用发送的消息卡片）：
//     「更新的卡片消息最大不能超过 30 KB」；超限错误码 `230025`
//     「The length of the message content reaches its limit」。
//     卡片实体接口（cardkit）同口径给 `200860`。
//   - 同一文档明确警告：「若消息中包含大量样式标签，会使实际消息体长度
//     大于你输入的请求体长度」——所以不能贴着 30KB 发。
//   - 限流是**字节**不是字符：中文 1 字 = 3 字节 UTF-8。
//
// ⚠️ **按字节，不按字符**。本仓 cards.go 的 truncate 是按字符的
// （注释明说「避免把中文字切一半」），那个口径对切短标签/ID 是对的，
// **不能拿来做正文分段**：按 28000 字符切中文 = 84KB，必超 30KB 上限。
//
// 本模块**不做字节估算**：调用方给一个 measure(段文本) => 卡片字节数，
// 分段时二分逼近预算。预算是否装得下由 measure 说了算，
// 测试也能用假 measure 把「信封开销」精确复现。
package feishu

import (
	"fmt"
	"strings"
)

// FeishuCardMaxBytes 是飞书卡片消息体硬上限：30 KB。
//
// 依据：`im/v1/messages` PATCH 文档「卡片及富文本消息最大不能超过 30 KB」，
// 错误码 230025。此值是**不可调**的服务端限制，调大只会被拒。
const FeishuCardMaxBytes = 30 * 1024

// CardSegmentBudgetBytes 是单张卡片 JSON 序列化后的字节预算。
//
// 取硬上限的 90%（27648 字节）而不是 30KB：官方明确「样式标签会让
// 实际消息体大于你输入的请求体长度」，留 10% 余量避免踩线。
const CardSegmentBudgetBytes = FeishuCardMaxBytes * 9 / 10

// MaxReplySegments 是单轮最多发出的卡片数（含主卡）。
//
// 上限存在的理由不是省流量，而是**必须有明确上限**：一旦超长回复无限分段，
// 用户会被刷屏；而超限时必须**显式告知**被省略了多少（见 TailDroppedNotice），
// 绝不能静默丢内容——静默丢弃正是本模块要修的那个缺陷本身。
// 27648 字节/卡 × 9 张 ≈ 24 万字符，远超任何正常回复。
const MaxReplySegments = 10

// SplitHeadNotice 是终态首段追加的固定提示。固定文案 ⇒ 预算可精确预留。
const SplitHeadNotice = "\n\n---\n✂️ 内容较长，已分段显示，完整内容见下方「续」卡片"

// StreamOverflowNotice 是流式期的溢出提示。
//
// 必须与 SplitHeadNotice 区分开：流式期「续」卡片**还不存在**，
// 说「见下方续卡片」是骗用户；此处只承诺「完成后会续发」。
const StreamOverflowNotice = "\n\n---\n✂️ 内容较长，本卡仅显示开头部分，剩余内容将在完成后以「续」卡片发出"

// TailDroppedNotice 是尾部被省略时的提示。
func TailDroppedNotice(droppedChars int) string {
	return fmt.Sprintf("\n\n---\n✂️ 回复过长，以上为前 %d 段，其余内容已省略（请缩小提问范围后重试）", droppedChars)
}

// DefaultContPrefix 是续卡片的正文前缀。index 为 1 起的续序号。
func DefaultContPrefix(index int) string {
	return fmt.Sprintf("（续 %d）\n\n", index)
}

// snapWindowChars 是断点回退窗口（字符数）。
// 在预算内往回找一个换行/空格，尽量不切断段落与代码块。
const snapWindowChars = 400

// minSnapFillRatio 是断点至少要填满预算的这个比例才采纳，
// 否则宁可保持满卡。防止「每行都换行」的文本被切成几十张几百字的小卡片。
const minSnapFillRatio = 0.4

// Measure 量出「某段文本装成一张卡片后」的字节数。
//
// 契约：返回值必须与**真正发出去的**那张卡片序列化后的字节数同源。
// 传字符数或 rune 数会让分段形同虚设——分段测试会过，线上照样 230025。
type Measure func(text string) int

// SegmentPlan 是一次分段的结果。
type SegmentPlan struct {
	// Segments 每段**已含前缀/提示**的完整正文，可直接逐段发出。
	Segments []string
	// DroppedTail 是因超过段数上限而被省略的尾部；空表示全部装下了。
	DroppedTail string
	// Split 是否被拆成多张卡片。
	Split bool
}

// PlanOptions 是分段的参数。
type PlanOptions struct {
	Content string
	Measure Measure
	// BudgetBytes 为 0 时用 CardSegmentBudgetBytes。
	BudgetBytes int
	// MaxSegments 为 0 时用 MaxReplySegments。
	MaxSegments int
	// HeadNotice 是首段正文之后的固定提示（计入预算）。
	HeadNotice string
	// ContPrefix 是续卡片正文前缀（计入预算）。为 nil 用 DefaultContPrefix。
	ContPrefix func(index int) string
	// DropNotice 是尾部被省略时的提示。
	//
	// 默认**不写**。FirstSegment 正是靠这一点区分两种「没显示完」：
	//   - 流式期：尾巴只是**还没轮到**，随后会以续卡片发出 → 不该说「已省略」
	//   - 终态段数上限：尾巴是真的**丢了** → 必须显式告知
	DropNotice func(droppedChars int) string
}

// PlanReplySegments 把一段可能远超卡片容量的正文拆成若干段。
//
// 纯函数：不做任何 IO，输入输出都是字符串，测试可以喂一个恒定开销的
// 假 measure 来精确复现「卡片信封 + 固定开销」的场景。
func PlanReplySegments(o PlanOptions) SegmentPlan {
	budget := o.BudgetBytes
	if budget <= 0 {
		budget = CardSegmentBudgetBytes
	}
	maxSegments := o.MaxSegments
	if maxSegments <= 0 {
		maxSegments = MaxReplySegments
	}
	contPrefix := o.ContPrefix
	if contPrefix == nil {
		contPrefix = DefaultContPrefix
	}
	measure := o.Measure
	if measure == nil {
		measure = func(s string) int { return len([]byte(s)) }
	}

	var segments []string
	rest := []rune(o.Content)

	for len(segments) < maxSegments && len(rest) > 0 {
		index := len(segments)
		head := ""
		if index > 0 {
			head = contPrefix(index)
		}
		tail := ""
		if index == 0 {
			tail = o.HeadNotice
		}

		body := takeBody(rest, budget, measure, head, tail)
		cut := snapToSoftBreak(rest, body, budget, measure, head, tail)

		segments = append(segments, head+string(rest[:cut])+tail)
		rest = rest[cut:]
		rest = trimLeadingNewlines(rest)
	}

	if len(rest) == 0 {
		// 全部装下且只有一段：把分段提示**摘掉**。
		//
		// 提示在测量时必须计入预算（否则超限时首段会超限），
		// 但内容其实没被分段时说「已分段显示，完整内容见下方「续」卡片」
		// 是骗用户——下方根本没有续卡片。
		// 摘掉只会让字节变少，因此不会引入新的超限。
		if len(segments) == 1 && o.HeadNotice != "" {
			segments[0] = strings.TrimSuffix(segments[0], o.HeadNotice)
		}
		return SegmentPlan{Segments: segments, Split: len(segments) > 1}
	}

	// 达到段数上限：显式告知省略了多少，绝不静默丢
	if o.DropNotice != nil {
		segments[len(segments)-1] += o.DropNotice(len(rest))
	}
	return SegmentPlan{
		Segments:    segments,
		DroppedTail: string(rest),
		Split:       len(segments) > 1,
	}
}

// FirstSegmentOptions 是流式期「主卡只放得下多少」的参数。
type FirstSegmentOptions struct {
	// BudgetBytes 为 0 时用 CardSegmentBudgetBytes。
	BudgetBytes int
	// HeadNotice 是溢出时追加的固定提示（计入预算）。
	HeadNotice string
}

// FirstSegment 返回流式过程中主卡能显示的正文（只取第一段）。
//
// 便宜优先：整个正文装得下时只做一次 measure（每个 delta 都会调到这里，
// 不能每次都二分）。装不下才走完整分段，此时的代价可接受——
// 内容一旦超限就稳定超限。
func FirstSegment(content string, measure Measure, o FirstSegmentOptions) string {
	if measure == nil {
		measure = func(s string) int { return len([]byte(s)) }
	}
	budget := o.BudgetBytes
	if budget <= 0 {
		budget = CardSegmentBudgetBytes
	}

	// 装得下就**原样返回**：没超限时必须零额外开销，
	// 否则等于给每个 delta 加上 O(n) 的二分。
	if measure(content) <= budget {
		return content
	}

	plan := PlanReplySegments(PlanOptions{
		Content:     content,
		Measure:     measure,
		BudgetBytes: budget,
		MaxSegments: 1,
		HeadNotice:  o.HeadNotice,
	})
	if len(plan.Segments) == 0 {
		return content
	}
	return plan.Segments[0]
}

// takeBody 二分找出最长的正文前缀，使 measure(head+body+tail) <= budget。
//
// measure 关于前缀长度单调不减（往卡片里加字符，序列化结果只会变长），
// 二分成立。至少返回 1 个字符，保证循环一定推进、不会死循环。
//
// 按 **rune** 边界切而不是字节边界：按字节切会把一个中文字切成
// 两个非法 UTF-8 序列，JSON 序列化后变成 � 乱码。
func takeBody(rest []rune, budget int, measure Measure, head, tail string) int {
	lo, hi, best := 1, len(rest), 1

	for lo <= hi {
		mid := (lo + hi) / 2
		if measure(head+string(rest[:mid])+tail) <= budget {
			best = mid
			lo = mid + 1
		} else {
			hi = mid - 1
		}
	}

	return best
}

// snapToSoftBreak 把断点回退到附近的换行/空格，让段落和代码块不被拦腰截断。
//
// 只有在回退后仍装得下、且仍能填满预算的 40% 时才采纳，否则保持满卡断点。
// 单行超长（如 minified JSON、超长 URL）找不到断点时就硬切——这是已知取舍。
func snapToSoftBreak(text []rune, cut, budget int, measure Measure, head, tail string) int {
	from := cut - snapWindowChars
	if from < 1 {
		from = 1
	}
	full := measure(head + string(text[:cut]) + tail)

	for i := cut; i > from; i-- {
		ch := text[i-1]
		if ch != '\n' && ch != ' ' {
			continue
		}
		size := measure(head + string(text[:i]) + tail)
		if size <= budget && float64(size) >= float64(full)*minSnapFillRatio {
			return i
		}
		return cut
	}

	return cut
}

// trimLeadingNewlines 去掉切点之后紧跟的换行。
//
// 不去掉的话，每一段开头都会挂着一两个空行，续卡片越读越松散。
func trimLeadingNewlines(rest []rune) []rune {
	for len(rest) > 0 && (rest[0] == '\n' || rest[0] == '\r') {
		rest = rest[1:]
	}
	return rest
}

// cardBytes 量出「某段正文装成一张回复卡」后的真实字节数。
//
// 用**真实 Card 序列化**的 len([]byte(...))，保证量出来的和发出去的是
// 同一个东西：卡片信封本身也要算进预算，而信封大小随 header/备注变化。
// 按字符估（bot 侧 formatter.ts 里 28000 那个值）会大幅高估中文正文。
func cardBytes(content string) int {
	return len([]byte(ReplyCard("completed", content).MustJSON()))
}
