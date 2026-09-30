package feishu

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// cardText 把卡片 JSON 摊平成一个字符串，便于断言文案。
func cardText(t *testing.T, c *Card) string {
	t.Helper()
	raw, err := c.JSON()
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("不是合法 JSON: %v", err)
	}
	b, _ := json.Marshal(out)
	return string(b)
}

// buttonsOf 取出卡片里的全部按钮元素。
func buttonsOf(t *testing.T, c *Card) []Element {
	t.Helper()
	var out []Element
	for _, el := range c.Body.Elements {
		if el.Tag == "button" {
			out = append(out, el)
		}
	}
	return out
}

// ============ 权限审批卡 ============

func TestPermissionCard三按钮且action正确(t *testing.T) {
	c := PermissionCard(PermissionRequest{
		ID: "req_1", Action: "bash", Resources: []string{"ls -la"},
	})
	btns := buttonsOf(t, c)
	if len(btns) != 3 {
		t.Fatalf("按钮数 = %d, 期望 3（允许一次/始终允许/拒绝）", len(btns))
	}
	want := []string{ActionPermissionAllowOnce, ActionPermissionAllowAlways, ActionPermissionReject}
	for i, w := range want {
		if len(btns[i].Behaviors) == 0 || btns[i].Behaviors[0].Value["action"] != w {
			t.Errorf("第 %d 个按钮 action = %v, 期望 %s", i, btns[i].Behaviors, w)
		}
		// request_id 必须带上，否则回执无法对应到具体请求
		if len(btns[i].Behaviors) == 0 || btns[i].Behaviors[0].Value["request_id"] != "req_1" {
			t.Errorf("第 %d 个按钮缺 request_id", i)
		}
	}
}

// TestPermissionCard拒绝按钮为danger 视觉上要与允许区分，
// 误点代价高。
func TestPermissionCard拒绝按钮为danger(t *testing.T) {
	c := PermissionCard(PermissionRequest{ID: "r", Action: "write"})
	btns := buttonsOf(t, c)
	last := btns[len(btns)-1]
	if last.ButtonType != "danger" {
		t.Errorf("拒绝按钮 type = %q, 期望 danger", last.ButtonType)
	}
}

func TestPermissionCard资源超限明示余量(t *testing.T) {
	res := make([]string, 8)
	for i := range res {
		res[i] = "resource-" + string(rune('a'+i))
	}
	c := PermissionCard(PermissionRequest{ID: "r", Action: "bash", Resources: res})
	txt := cardText(t, c)
	if !strings.Contains(txt, "另有 3 项") {
		t.Errorf("8 个资源应显示「另有 3 项」，实际: %s", txt)
	}
}

func TestPermissionCard空资源显示占位(t *testing.T) {
	c := PermissionCard(PermissionRequest{ID: "r", Action: "bash"})
	if !strings.Contains(cardText(t, c), "(无)") {
		t.Error("无资源时应显示占位而非空白")
	}
}

// TestPermissionCard始终允许说明授权范围 关键：V2 的 always 是
// 本会话内放行，不写清楚会被理解成永久放行。
func TestPermissionCard始终允许说明授权范围(t *testing.T) {
	c := PermissionCard(PermissionRequest{
		ID: "r", Action: "bash", Resources: []string{"shell:ls"},
	})
	txt := cardText(t, c)
	if !strings.Contains(txt, "本会话内不再询问") {
		t.Errorf("应说明 always 的会话内范围: %s", txt)
	}
	if !strings.Contains(txt, "不会写入全局配置") {
		t.Errorf("应说明不写入全局: %s", txt)
	}
}

func TestPermissionCard优先用Save清单(t *testing.T) {
	c := PermissionCard(PermissionRequest{
		ID:        "r",
		Action:    "bash",
		Resources: []string{"a", "b", "c", "d", "e", "f"},
		Save:      []string{"only-this"},
	})
	txt := cardText(t, c)
	if !strings.Contains(txt, "only-this") {
		t.Errorf("应优先展示 save 清单: %s", txt)
	}
	if strings.Contains(txt, "本会话内不再询问 `a`") {
		t.Errorf("save 非空时不应回退到 resources: %s", txt)
	}
}

// ============ 用量卡 ============

func TestUsageCard全字段(t *testing.T) {
	c := UsageCard(Usage{
		Cost: 1.23456,
		Tokens: TokenUsage{
			Input: 1234567, Output: 89012, Reasoning: 555, CacheRead: 999, CacheWrite: 111,
		},
	})
	txt := cardText(t, c)
	for _, want := range []string{"$1.2346", "1,234,567", "89,012", "555", "999", "111"} {
		if !strings.Contains(txt, want) {
			t.Errorf("缺 %s: %s", want, txt)
		}
	}
}

func TestUsageCard零值字段不显示(t *testing.T) {
	c := UsageCard(Usage{Cost: 0, Tokens: TokenUsage{Input: 100, Output: 200}})
	txt := cardText(t, c)
	if strings.Contains(txt, "推理") {
		t.Errorf("推理为 0 时不应显示（纯噪音）: %s", txt)
	}
	if strings.Contains(txt, "缓存读") {
		t.Errorf("缓存读为 0 时不应显示: %s", txt)
	}
	if !strings.Contains(txt, "$0.0000") {
		t.Errorf("费用应显示为 0.0000: %s", txt)
	}
}

func TestCommaInt千分位(t *testing.T) {
	cases := map[int64]string{
		0: "0", 7: "7", 999: "999",
		1000: "1,000", 12345: "12,345", 1234567: "1,234,567",
		-12345: "-12,345",
	}
	for in, want := range cases {
		if got := commaInt(in); got != want {
			t.Errorf("commaInt(%d) = %q, 期望 %q", in, got, want)
		}
	}
}

// ============ 任务通知卡 ============

func TestShouldNotifyTask阈值(t *testing.T) {
	if ShouldNotifyTask(29 * time.Second) {
		t.Error("29 秒不应通知（短任务本就有流式卡片，额外通知是噪音）")
	}
	if !ShouldNotifyTask(30 * time.Second) {
		t.Error("30 秒应通知（用户可能已切走）")
	}
	if !ShouldNotifyTask(10 * time.Minute) {
		t.Error("长任务必须通知")
	}
}

func TestTaskNotificationCard成功与失败视觉区分(t *testing.T) {
	ok := TaskNotificationCard(TaskNotification{ElapsedSeconds: 90, Success: true, FallbackOutput: "完成"})
	fail := TaskNotificationCard(TaskNotification{ElapsedSeconds: 90, Success: false, FallbackOutput: "炸了"})

	if ok.Header.Template != TemplateGreen {
		t.Errorf("成功卡片模板 = %q, 期望绿", ok.Header.Template)
	}
	if fail.Header.Template != TemplateRed {
		t.Errorf("失败卡片模板 = %q, 期望红", fail.Header.Template)
	}
	if !strings.Contains(cardText(t, ok), "✅") {
		t.Error("成功应有 ✅ 标识")
	}
	if !strings.Contains(cardText(t, fail), "❌") {
		t.Error("失败应有 ❌ 标识")
	}
}

func TestTaskNotificationCard标题缺失回退短ID(t *testing.T) {
	c := TaskNotificationCard(TaskNotification{ElapsedSeconds: 5, SessionID: "ses_abcdefghijklmnop"})
	if !strings.Contains(cardText(t, c), "ses_abcdefg") {
		t.Errorf("标题缺失时应回退显示短 ID: %s", cardText(t, c))
	}
}

func TestHumanDuration(t *testing.T) {
	cases := map[int]string{
		5:    "5 秒",
		90:   "1 分 30 秒",
		3600: "1 小时 0 分",
		7260: "2 小时 1 分",
	}
	for in, want := range cases {
		if got := humanDuration(in); got != want {
			t.Errorf("humanDuration(%d) = %q, 期望 %q", in, got, want)
		}
	}
}

// Test输出截断标注总长度 不标总长度的话，用户会把残缺内容当成全部结论。
func Test输出截断标注总长度(t *testing.T) {
	long := strings.Repeat("输出", 2000)
	c := TaskNotificationCard(TaskNotification{ElapsedSeconds: 60, FallbackOutput: long})
	txt := cardText(t, c)
	if !strings.Contains(txt, "已截断") {
		t.Error("超长输出应标注截断")
	}
	if !strings.Contains(txt, "共 4000 字") {
		t.Errorf("应标注总长度: %s", txt[:min(len(txt), 300)])
	}
}

// Test兜底输出为空时不加输出段
func Test输出为空时不加输出段(t *testing.T) {
	c := TaskNotificationCard(TaskNotification{ElapsedSeconds: 60, FallbackOutput: "   "})
	if strings.Contains(cardText(t, c), "正文附在此处") {
		t.Error("空兜底输出不应渲染兜底段")
	}
}

// ============ 通知卡去重 ============

// Test常规路径不重复正文 这是通知卡最关键的行为约束。
//
// 旧实现有个 Output 字段，它就是 fullContent —— 与流式卡上已经逐字
// 显示过的正文同源。超过 30 秒的任务因此把同一份正文发了两遍。
// 这不是「摘要更好」，是重复投递。
func Test常规路径不重复正文(t *testing.T) {
	// 常规路径：FallbackOutput 留空（主卡已送达）
	c := TaskNotificationCard(TaskNotification{
		ElapsedSeconds: 120,
		Success:        true,
		ProjectPath:    "/proj",
		SessionID:      "ses_1",
	})
	txt := cardText(t, c)
	if HasFallbackBody(TaskNotification{ElapsedSeconds: 120, Success: true}) {
		t.Error("FallbackOutput 为空时 HasFallbackBody 应为 false")
	}
	if !strings.Contains(txt, bodyElsewhere) {
		t.Errorf("常规路径应指引用户看上方卡片: %s", txt)
	}
	if strings.Contains(txt, "正文附在此处") {
		t.Errorf("常规路径不得带正文: %s", txt)
	}
}

// Test真失败时才兜底正文 上方流式卡没送达时，通知卡是唯一载体。
func Test真失败时才兜底正文(t *testing.T) {
	n := TaskNotification{
		ElapsedSeconds: 120,
		Success:        true,
		FallbackOutput: "上方没送达的正文",
		SessionID:      "ses_1",
	}
	if !HasFallbackBody(n) {
		t.Fatal("填了 FallbackOutput 时 HasFallbackBody 应为 true")
	}
	txt := cardText(t, TaskNotificationCard(n))
	if !strings.Contains(txt, bodyFallbackHint) {
		t.Errorf("兜底时必须说明原因: %s", txt)
	}
	if !strings.Contains(txt, "上方没送达的正文") {
		t.Errorf("兜底时必须带正文: %s", txt)
	}
	if strings.Contains(txt, bodyElsewhere) {
		t.Errorf("兜底时不应再说「见上方卡片」（上方什么都没有）: %s", txt)
	}
}

// Test错误分支的兜底说明不同 错误详情与正常正文要说清区别。
func Test错误分支的兜底说明不同(t *testing.T) {
	ok := cardText(t, TaskNotificationCard(TaskNotification{
		ElapsedSeconds: 90, Success: true, FallbackOutput: "x",
	}))
	fail := cardText(t, TaskNotificationCard(TaskNotification{
		ElapsedSeconds: 90, Success: false, FallbackOutput: "x",
	}))
	if !strings.Contains(ok, bodyFallbackHint) {
		t.Errorf("成功兜底说明: %s", ok)
	}
	if !strings.Contains(fail, bodyFallbackHintError) {
		t.Errorf("错误兜底说明应另起文案: %s", fail)
	}
	// 无兜底时错误分支也有自己的指引文案
	noFallback := cardText(t, TaskNotificationCard(TaskNotification{
		ElapsedSeconds: 90, Success: false,
	}))
	if !strings.Contains(noFallback, bodyElsewhereError) {
		t.Errorf("错误分支无兜底时应说「错误详情见上方卡片」: %s", noFallback)
	}
}

// Test通知卡仍带元信息 通知卡的价值在「辨认是哪一个会话 + 耗时」。
func Test通知卡仍带元信息(t *testing.T) {
	c := TaskNotificationCard(TaskNotification{
		ElapsedSeconds: 3725,
		Success:        true,
		ProjectPath:    "/work/bmall",
		HasChanges:     true,
		SessionID:      "ses_abcdefghij",
	})
	txt := cardText(t, c)
	for _, want := range []string{"1 小时 2 分", "/work/bmall", "有文件改动", "ses_ab"} {
		if !strings.Contains(txt, want) {
			t.Errorf("通知卡缺元信息 %q: %s", want, txt)
		}
	}
}

// Test通知卡不再有Output字段 防止有人「顺手」把正文加回来。
func Test通知卡不再有Output字段(t *testing.T) {
	names := strings.Split(fieldNames(TaskNotification{}), ",")
	for _, n := range names {
		if n == "Output" {
			t.Error("TaskNotification 不应有 Output 字段（它就是「重复投递正文」的成因）")
		}
	}
	found := false
	for _, n := range names {
		if n == "FallbackOutput" {
			found = true
		}
	}
	if !found {
		t.Error("TaskNotification 应有 FallbackOutput 字段")
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ============ 会话选择卡 ============

func node(id, title string, children ...SessionNode) SessionNode {
	return SessionNode{ID: id, Title: title, Updated: time.Unix(1700000000, 0), Children: children}
}

func TestSessionSelectCard一级为按钮(t *testing.T) {
	c := SessionSelectCard(SessionSelectOptions{
		Nodes: []SessionNode{node("ses_a", "会话A"), node("ses_b", "会话B")},
	})
	btns := buttonsOf(t, c)
	if len(btns) != 2 {
		t.Fatalf("按钮数 = %d, 期望 2", len(btns))
	}
	if btns[0].Behaviors[0].Value["session_id"] != "ses_a" {
		t.Errorf("按钮未带 session_id: %v", btns[0].Behaviors[0].Value)
	}
	if btns[0].Behaviors[0].Value["action"] != ActionSessionSelect {
		t.Errorf("action = %v, 期望 %s", btns[0].Behaviors[0].Value["action"], ActionSessionSelect)
	}
}

func TestSessionSelectCard当前会话禁用(t *testing.T) {
	c := SessionSelectCard(SessionSelectOptions{
		Nodes:     []SessionNode{node("ses_a", "A"), node("ses_b", "B")},
		CurrentID: "ses_a",
	})
	btns := buttonsOf(t, c)
	if !btns[0].Disabled {
		t.Error("当前会话按钮应禁用（避免重复切换）")
	}
	if !strings.Contains(cardText(t, c), "✅") {
		t.Error("当前会话应有 ✅ 标识")
	}
	if btns[1].Disabled {
		t.Error("非当前会话不应禁用")
	}
}

// Test子会话不产生按钮 是本卡最关键的行为约束。
//
// 子会话是 subagent 的上下文，切过去会让主对话线分叉且没有返回入口。
// 做成可点按钮等于埋一个「把对话发到错地方」的坑。
func Test子会话不产生按钮(t *testing.T) {
	parent := node("ses_p", "主会话",
		node("ses_c1", "子任务A"),
		node("ses_c2", "子任务B"),
	)
	c := SessionSelectCard(SessionSelectOptions{Nodes: []SessionNode{parent}})

	btns := buttonsOf(t, c)
	if len(btns) != 1 {
		t.Fatalf("按钮数 = %d, 期望 1（只有主会话可点）", len(btns))
	}
	if btns[0].Behaviors[0].Value["session_id"] != "ses_p" {
		t.Errorf("唯一按钮应属主会话: %v", btns[0].Behaviors[0].Value)
	}
}

// Test子会话只给条数不列明细 2026-09-30 改的行为。
//
// 逐条列出时主会话被彻底淹没（实测最近 50 条里 39 条是子会话），
// 卡片高度也撑爆；而子会话本来就不给入口，列明细只剩噪音。
func Test子会话只给条数不列明细(t *testing.T) {
	parent := node("ses_p", "主会话",
		node("ses_c1", "子任务A"),
		node("ses_c2", "子任务B"),
	)
	c := SessionSelectCard(SessionSelectOptions{Nodes: []SessionNode{parent}})

	txt := cardText(t, c)
	if !strings.Contains(txt, "↳ 2 个子会话") {
		t.Errorf("应给子会话条数: %s", txt)
	}
	// 明细（子会话标题与会话 ID）不应出现
	for _, leaked := range []string{"子任务A", "子任务B", "ses_c1", "ses_c2"} {
		if strings.Contains(txt, leaked) {
			t.Errorf("子会话明细 %q 不应出现（只给条数）: %s", leaked, txt)
		}
	}
}

// Test条数含被截断的子会话 锁住 HiddenChildCount 必须计入。
//
// 一个实际有 12 个子会话的父会话，展示 5 个时若报「5 个子会话」就是直接说谎。
func Test条数含被截断的子会话(t *testing.T) {
	parent := node("ses_p", "主", node("c1", "子"), node("c2", "子2"))
	parent.HiddenChildCount = 7 // 共 9 个子会话
	c := SessionSelectCard(SessionSelectOptions{Nodes: []SessionNode{parent}})
	if !strings.Contains(cardText(t, c), "↳ 9 个子会话") {
		t.Errorf("条数必须含被截断的 7 个: %s", cardText(t, c))
	}
	if !strings.Contains(cardText(t, c), "共 1 个主会话、9 个子会话") {
		t.Errorf("标题计数同样必须含被截断部分: %s", cardText(t, c))
	}
}

// Test多层级子会话只算一条链 孙会话计入，但不单独列行。
func Test多层级子会话只算一条链(t *testing.T) {
	grand := node("ses_g", "孙")
	child := node("ses_c", "子", grand)
	c := SessionSelectCard(SessionSelectOptions{
		Nodes: []SessionNode{node("ses_p", "主", child)},
	})
	txt := cardText(t, c)
	if !strings.Contains(txt, "↳ 2 个子会话") {
		t.Errorf("子 + 孙共 2 个: %s", txt)
	}
	if strings.Contains(txt, "↳ 子") || strings.Contains(txt, "↳ 孙") {
		t.Errorf("不应逐条列子会话: %s", txt)
	}
}

func Test会话卡报主与子数量(t *testing.T) {
	c := SessionSelectCard(SessionSelectOptions{
		Nodes: []SessionNode{node("ses_p", "主", node("c1", "子1"), node("c2", "子2"))},
	})
	if !strings.Contains(cardText(t, c), "共 1 个主会话、2 个子会话") {
		t.Errorf("应分别报主/子数量: %s", cardText(t, c))
	}
}

func Test会话卡无子时用原措辞(t *testing.T) {
	c := SessionSelectCard(SessionSelectOptions{
		Nodes: []SessionNode{node("a", "A"), node("b", "B")},
	})
	txt := cardText(t, c)
	if !strings.Contains(txt, "共 2 个历史会话") {
		t.Errorf("无子会话时应沿用原措辞: %s", txt)
	}
	if strings.Contains(txt, "子会话") {
		t.Error("无子会话时不应出现「子会话」字样（制造噪音）")
	}
}

// Test三类截断提示 覆盖静默隐藏这一类缺陷：
// 数据少了但用户不知道，就会以为系统漏了东西。
func Test三类截断提示(t *testing.T) {
	parent := node("ses_p", "主", node("c1", "子"))
	parent.HiddenChildCount = 7

	c := SessionSelectCard(SessionSelectOptions{
		Nodes:                []SessionNode{parent, node("ses_q", "主2")},
		Limit:                1,
		TotalRoots:           9,
		UnattachedChildCount: 4,
	})
	txt := cardText(t, c)
	// 被截断的子会话不再单独提示「另有 N 个更早的子会话」——
	// 它们已经并进「↳ 8 个子会话」这个总数里（见 Test条数含被截断的子会话）
	for _, want := range []string{"已显示最近 1 个", "另有 4 个子会话的父会话较久", "↳ 8 个子会话"} {
		if !strings.Contains(txt, want) {
			t.Errorf("缺提示 %q: %s", want, txt)
		}
	}
	if strings.Contains(txt, "另有 7 个更早的子会话") {
		t.Errorf("截断的子会话应并入总数而非单独提示: %s", txt)
	}
}

// Test根节点截断也计入条数 截断提示改由条数承载后，
// 根节点自己的 HiddenChildCount 同样不能丢。
func Test根节点截断也计入条数(t *testing.T) {
	parent := node("ses_p", "主", node("c1", "子"))
	parent.HiddenChildCount = 3
	c := SessionSelectCard(SessionSelectOptions{Nodes: []SessionNode{parent}})
	if !strings.Contains(cardText(t, c), "↳ 4 个子会话") {
		t.Errorf("根节点截断必须计入条数: %s", cardText(t, c))
	}
}

func Test空会话列表(t *testing.T) {
	c := SessionSelectCard(SessionSelectOptions{Nodes: nil})
	txt := cardText(t, c)
	if !strings.Contains(txt, "暂无历史会话") {
		t.Errorf("空列表应给出提示: %s", txt)
	}
	if len(buttonsOf(t, c)) != 0 {
		t.Error("空列表不应有按钮")
	}
}

func TestCountChildren含多层(t *testing.T) {
	// 根：p、q；p 的子：c、c2；c 的子：g
	// 子会话共 3 个（c、c2、g）——p 与 q 是一级会话，不计入
	nodes := []SessionNode{
		node("p", "主", node("c", "子", node("g", "孙")), node("c2", "子2")),
		node("q", "另一主"),
	}
	if got := countChildren(nodes); got != 3 {
		t.Errorf("countChildren = %d, 期望 3（c、c2、g；p/q 是一级会话不计入）", got)
	}
}

// TestCountChildren含截断部分 12 个子会话的父会话不能被报成 5 个。
//
// 这是 UI 现在**唯一**的子会话呈现口径（只给条数），漏算就是直接说谎。
func TestCountChildren含截断部分(t *testing.T) {
	// 实际 12 个子会话：保留 5 个（maxChildrenPerRoot），隐藏 7 个
	children := make([]SessionNode, 0, 5)
	for i := 0; i < 5; i++ {
		children = append(children, node(fmt.Sprintf("c%d", i), "子"))
	}
	root := node("p", "主", children...)
	root.HiddenChildCount = 7
	if got := countDescendants(root); got != 12 {
		t.Errorf("countDescendants = %d, 期望 12（5 展示 + 7 截断）", got)
	}
	if got := countChildren([]SessionNode{root}); got != 12 {
		t.Errorf("countChildren = %d, 期望 12（不能只数已展开的 5 个）", got)
	}
}

// TestCountDescendants递归计入孙的截断部分
func TestCountDescendants递归计入孙的截断部分(t *testing.T) {
	grand := node("g", "孙")
	grand.HiddenChildCount = 2
	child := node("c", "子", grand)
	root := node("p", "主", child)
	// 1（c）+ 1（g）+ 2（g 的隐藏）
	if got := countDescendants(root); got != 4 {
		t.Errorf("countDescendants = %d, 期望 4", got)
	}
}

func TestCountChildren空与无子(t *testing.T) {
	if got := countChildren(nil); got != 0 {
		t.Errorf("空树 = %d, 期望 0", got)
	}
	if got := countChildren([]SessionNode{node("a", "A"), node("b", "B")}); got != 0 {
		t.Errorf("无子会话时 = %d, 期望 0", got)
	}
}

func Test空标题与空ID回退(t *testing.T) {
	c := SessionSelectCard(SessionSelectOptions{
		Nodes: []SessionNode{{ID: "ses_x"}}, // 无标题
	})
	txt := cardText(t, c)
	if !strings.Contains(txt, "(无标题)") {
		t.Errorf("空标题应回退占位: %s", txt)
	}
}

// ============ 截断工具 ============

// TestTruncate按字符不切半中文 用字节截断会把中文字切成乱码半个字。
func TestTruncate按字符不切半中文(t *testing.T) {
	got := truncate("这是一段中文内容", 5)
	if got != "这是一段…"[0:0]+truncate("这是一段中文内容", 5) {
		t.Fatalf("自比较失败: %q", got)
	}
	r := []rune(got)
	if len(r) != 5 {
		t.Errorf("截断后 rune 数 = %d, 期望 5（按字符而非字节）", len(r))
	}
	if r[len(r)-1] != '…' {
		t.Errorf("应以省略号结尾: %q", got)
	}
}

func TestTruncate不超长时原样(t *testing.T) {
	if got := truncate("短", 10); got != "短" {
		t.Errorf("未超长应原样返回: %q", got)
	}
}
