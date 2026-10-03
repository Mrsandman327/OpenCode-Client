//go:build feishu

// reply_split_test.go —— 长回复分段的契约测试
//
// 本文件的核心断言只有一条，但它是全部：
// **每一段实测的卡片字节数都不超过预算。**
//
// 只断言「段数」的测试是假保险：一个按 10000 字符硬切的实现能通过
// 段数断言，但中文正文按字符切 = 3 倍字节，10000 字符 = 30KB，
// 每一段都撞 230025 —— 线上照样「卡片冻结在半途」。
package feishu

import (
	"strings"
	"testing"
)

// Test预算常量与文档一致 阈值必须可追溯到飞书官方文档，
// 不能被「优化」成一个拍脑袋的数。
func Test预算常量与文档一致(t *testing.T) {
	// 飞书 im/v1/messages PATCH：卡片消息最大 30 KB，超限 230025
	if FeishuCardMaxBytes != 30*1024 {
		t.Errorf("FeishuCardMaxBytes = %d, 期望 30*1024（官方硬上限）", FeishuCardMaxBytes)
	}
	// 留 10% 余量：官方警告「样式标签会让实际消息体大于请求体」
	if CardSegmentBudgetBytes != 27648 {
		t.Errorf("CardSegmentBudgetBytes = %d, 期望 27648（硬上限的 90%%）", CardSegmentBudgetBytes)
	}
	if MaxReplySegments != 10 {
		t.Errorf("MaxReplySegments = %d, 期望 10", MaxReplySegments)
	}
	if CardSegmentBudgetBytes >= FeishuCardMaxBytes {
		t.Error("预算必须小于硬上限（余量用于样式标签膨胀）")
	}
}

// Test每段实测字节不超预算 中文正文是核心场景：
// 一字 3 字节，按字符切必然超限。
func Test每段实测字节不超预算(t *testing.T) {
	// 20000 个中文字 = 60000 字节正文，远超 27648 预算
	content := strings.Repeat("中文分段的字节口径测试。", 2500)
	plan := PlanReplySegments(PlanOptions{
		Content:    content,
		Measure:    cardBytes,
		HeadNotice: SplitHeadNotice,
		DropNotice: TailDroppedNotice,
	})
	if len(plan.Segments) < 2 {
		t.Fatalf("60000 字节正文应被拆成多段，实际 %d 段", len(plan.Segments))
	}
	for i, seg := range plan.Segments {
		// 这是**真实卡片序列化后的字节数**，与发出去的完全同源
		if got := cardBytes(seg); got > CardSegmentBudgetBytes {
			t.Errorf("第 %d 段实测 %d 字节，超过预算 %d", i+1, got, CardSegmentBudgetBytes)
		}
	}
	if !plan.Split {
		t.Error("Split 应为 true")
	}
}

// Test按字节切不是按字符切 回归测试：一个按 rune 切的实现
// 在这个用例上必然超预算。
func Test按字节切不是按字符切(t *testing.T) {
	content := strings.Repeat("中", 20000) // 60000 字节
	plan := PlanReplySegments(PlanOptions{Content: content, Measure: cardBytes})

	total := 0
	for _, seg := range plan.Segments {
		total += len([]rune(seg))
		if cardBytes(seg) > CardSegmentBudgetBytes {
			t.Fatalf("某段 %d 字节超预算", cardBytes(seg))
		}
	}
	// 若按字符切（10000 字符/段），20000 字会切 2 段；
	// 按字节切必然更多。
	if len(plan.Segments) < 3 {
		t.Errorf("段数 = %d，20000 个中文字（60000 字节）按字节切应 ≥3 段", len(plan.Segments))
	}
	_ = total
}

// Test切点不落在多字节字符中间 切在字节中间会产出非法 UTF-8，
// JSON 序列化后变成 � 乱码。
func Test切点不落在多字节字符中间(t *testing.T) {
	// 混排：中文 + emoji（4 字节） + ASCII
	content := strings.Repeat("中🙂ab", 6000)
	plan := PlanReplySegments(PlanOptions{Content: content, Measure: cardBytes})
	for i, seg := range plan.Segments {
		if !isValidUTF8(seg) {
			t.Errorf("第 %d 段不是合法 UTF-8（切点落在字符中间）", i+1)
		}
		if strings.ContainsRune(seg, '�') {
			t.Errorf("第 %d 段含替换字符（多字节字符被切坏）", i+1)
		}
	}
}

// Test首段预算含提示文案 提示也占字节，必须从预算里扣。
func Test首段预算含提示文案(t *testing.T) {
	content := strings.Repeat("A", 30000) // 30000 字节
	plan := PlanReplySegments(PlanOptions{
		Content:    content,
		Measure:    cardBytes,
		HeadNotice: SplitHeadNotice,
	})
	if cardBytes(plan.Segments[0]) > CardSegmentBudgetBytes {
		t.Errorf("首段 %d 字节超预算", cardBytes(plan.Segments[0]))
	}
	// 提示本身必须在段内（否则等于没提示）
	if !strings.Contains(plan.Segments[0], "已分段显示") {
		t.Error("首段应带分段提示")
	}
}

// Test短内容不分段 便宜优先：装得下就一段。
func Test短内容不分段(t *testing.T) {
	content := "这是一条很短的回复。"
	plan := PlanReplySegments(PlanOptions{Content: content, Measure: cardBytes, HeadNotice: SplitHeadNotice})
	if len(plan.Segments) != 1 {
		t.Fatalf("短内容应只 1 段，实际 %d 段", len(plan.Segments))
	}
	if plan.Segments[0] != content {
		t.Errorf("短内容应原样返回，实际 %q", plan.Segments[0])
	}
	if plan.DroppedTail != "" {
		t.Error("短内容不应有被省略的尾巴")
	}
}

// Test内容不丢失 分段的唯一目的是超限时改用多张卡，不是丢内容。
func Test内容不丢失(t *testing.T) {
	content := strings.Repeat("句子。", 9000)
	plan := PlanReplySegments(PlanOptions{Content: content, Measure: cardBytes})
	var joined string
	for _, seg := range plan.Segments {
		joined += seg
	}
	// 去掉续卡片前缀后应能还原全部内容
	for i := 1; i < len(plan.Segments); i++ {
		joined = strings.Replace(joined, DefaultContPrefix(i), "", 1)
	}
	// 段间的换行会被吃掉，所以只断言「没有内容被截断」：
	// 所有段的字符数总和应不小于原文（提示文案只会加长）
	if len([]rune(joined)) < len([]rune(content)) {
		t.Errorf("分段后总字符数 %d < 原文 %d，说明有内容丢失",
			len([]rune(joined)), len([]rune(content)))
	}
	if plan.DroppedTail != "" {
		t.Errorf("未超段数上限时不应有被省略的尾巴: %d 字符", len([]rune(plan.DroppedTail)))
	}
}

// Test超段数上限显式告知省略量 绝不静默丢内容。
func Test超段数上限显式告知省略量(t *testing.T) {
	// 500KB 正文，10 段 × 27648 ≈ 276KB 装不下
	content := strings.Repeat("超长", 250000) // 750000 字节
	plan := PlanReplySegments(PlanOptions{
		Content:    content,
		Measure:    cardBytes,
		DropNotice: TailDroppedNotice,
	})
	if len(plan.Segments) != MaxReplySegments {
		t.Fatalf("段数 = %d, 期望上限 %d", len(plan.Segments), MaxReplySegments)
	}
	if plan.DroppedTail == "" {
		t.Fatal("超上限时必须有被省略的尾巴")
	}
	last := plan.Segments[len(plan.Segments)-1]
	if !strings.Contains(last, "已省略") {
		t.Error("最后一段必须显式说明内容被省略")
	}
	if !strings.Contains(last, "请缩小提问范围") {
		t.Error("应给出可操作的下一步")
	}
}

// Test未给DropNotice时不写省略提示 流式期不能提前说「已省略」——
// 那段内容随后会以续卡片完整发出。
func Test未给DropNotice时不写省略提示(t *testing.T) {
	content := strings.Repeat("超长", 250000)
	plan := PlanReplySegments(PlanOptions{Content: content, Measure: cardBytes})
	if strings.Contains(plan.Segments[len(plan.Segments)-1], "已省略") {
		t.Error("未传 DropNotice 时不应写「已省略」（流式期那部分还会续发）")
	}
}

// Test断点回退到换行 段落/代码块不该被拦腰截断。
func Test断点回退到换行(t *testing.T) {
	// 每 100 字符一个换行，累积到 40000 字节
	var sb strings.Builder
	for i := 0; i < 400; i++ {
		sb.WriteString(strings.Repeat("x", 99))
		sb.WriteString("\n")
	}
	content := sb.String()
	plan := PlanReplySegments(PlanOptions{Content: content, Measure: cardBytes})
	if len(plan.Segments) < 2 {
		t.Skip("内容不足以触发分段")
	}
	// 至少有一段的末尾落在换行上（而不是硬切在词中间）
	found := false
	for _, seg := range plan.Segments[:len(plan.Segments)-1] {
		if strings.HasSuffix(seg, "\n") {
			found = true
		}
	}
	if !found {
		t.Error("断点未回退到换行：段落被拦腰截断")
	}
	for i, seg := range plan.Segments {
		if cardBytes(seg) > CardSegmentBudgetBytes {
			t.Errorf("第 %d 段 %d 字节超预算（回退后必须仍不超）", i+1, cardBytes(seg))
		}
	}
}

// TestFirstSegment装得下时原样返回 流式期每个 delta 都会调到这里，
// 每次都二分等于给每个 delta 加 O(n) 开销。
func TestFirstSegment装得下时原样返回(t *testing.T) {
	content := "短回复"
	got := FirstSegment(content, cardBytes, FirstSegmentOptions{HeadNotice: StreamOverflowNotice})
	if got != content {
		t.Errorf("装得下应原样返回，实际 %q", got)
	}
}

// TestFirstSegment超限时只取第一段且不超预算
func TestFirstSegment超限时只取第一段且不超预算(t *testing.T) {
	content := strings.Repeat("中文内容测试", 5000)
	got := FirstSegment(content, cardBytes, FirstSegmentOptions{HeadNotice: StreamOverflowNotice})
	if cardBytes(got) > CardSegmentBudgetBytes {
		t.Errorf("首段 %d 字节超预算", cardBytes(got))
	}
	if got == content {
		t.Error("超限时不应原样返回")
	}
	// 流式期必须用「完成后会续发」而不是「见下方续卡片」——
	// 流式期续卡片还不存在，说「见下方」是骗用户
	if !strings.Contains(got, "完成后以「续」卡片发出") {
		t.Error("流式期溢出提示文案不对")
	}
	if strings.Contains(got, "见下方「续」卡片") {
		t.Error("流式期不能引用尚不存在的续卡片")
	}
}

// Test空内容安全 空内容时不能 panic，也不能返回空段。
func Test空内容安全(t *testing.T) {
	plan := PlanReplySegments(PlanOptions{Content: "", Measure: cardBytes})
	if len(plan.Segments) != 0 {
		t.Errorf("空内容应产出 0 段，实际 %d", len(plan.Segments))
	}
	if got := FirstSegment("", cardBytes, FirstSegmentOptions{}); got != "" {
		t.Errorf("空内容首段应为空，实际 %q", got)
	}
}

// Testmeasure为nil时退化为字节数 不能 panic。
func TestMeasure为nil时退化为字节数(t *testing.T) {
	plan := PlanReplySegments(PlanOptions{Content: strings.Repeat("x", 100)})
	if len(plan.Segments) != 1 {
		t.Errorf("100 字节应 1 段，实际 %d", len(plan.Segments))
	}
}

// Test卡片刻度与真实发送同源 这是分段正确性的前提：
// 如果 measure 量的东西和 UpdateCard 发的不是同一个，分段就形同虚设。
func Test卡片刻度与真实发送同源(t *testing.T) {
	content := "一二三四五"
	card := ReplyCard(statusCompleted, content)
	if got, want := cardBytes(content), len([]byte(card.MustJSON())); got != want {
		t.Errorf("cardBytes = %d，实际卡片 JSON = %d（两者必须是同一个东西）", got, want)
	}
}

// Test占位文案占预算 空正文时 ReplyCard 会填占位符，
// 占位符的字节必须计入 measure。
func Test占位文案占预算(t *testing.T) {
	withPlaceholder := cardBytes("")
	explicit := cardBytes(placeholderText)
	if withPlaceholder != explicit {
		t.Errorf("空正文与显式占位符应量出同样的字节数: %d vs %d", withPlaceholder, explicit)
	}
}

func isValidUTF8(s string) bool {
	for _, r := range s {
		if r == '�' {
			return false
		}
	}
	return true
}
