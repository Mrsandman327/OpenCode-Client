//go:build feishu

// events_test.go —— V2 事件翻译的契约测试
//
// fixture 全部取自 tests/fixtures/events-basic.json 与 events-tool.json
// （本机 v2.0.15 真机抓下来的原始 SSE 载荷），不是手写的理想结构。
// 手写 fixture 有一个致命问题：人会照着自己以为的结构写，于是测试全绿、
// 线上静默失败。本文件里最关键的两条（回合边界、权威全文）正是靠真机
// 载荷才暴露出来的。
package feishu

import (
	"strings"
	"testing"
)

// realReasoningStarted 是真机抓的 session.reasoning.started 事件。
const realReasoningStarted = `{"id":"evt_0e66e18cb0013vqARnu0v0LnEO","created":1790572370123,"type":"session.reasoning.started","location":{"directory":"C:\\Users\\swordkee\\AppData\\Local\\Temp\\opencode\\oc-capture"},"data":{"sessionID":"ses_f1991fb25ffeHR2OxfoQ01Yy78","assistantMessageID":"msg_0e66e0935001QhlNL2GyHiqO14","ordinal":0,"state":{"reasoningField":"reasoning_content"}},"durable":{"aggregateID":"ses_f1991fb25ffeHR2OxfoQ01Yy78","seq":6,"version":1}}`

// realReasoningDelta 是真机抓的 session.reasoning.delta 事件。
const realReasoningDelta = `{"id":"evt_0e66e1934001yNgoV1iltFZaGR","created":1790572370228,"type":"session.reasoning.delta","data":{"sessionID":"ses_f1991fb25ffeHR2OxfoQ01Yy78","assistantMessageID":"msg_0e66e0935001QhlNL2GyHiqO14","ordinal":0,"delta":"The user wants me to"}}`

// realTextDelta 是真机抓的 session.text.delta 事件。
const realTextDelta = `{"id":"evt_0e66e1b16001X22AzgdHIpaXf2","created":1790572370710,"type":"session.text.delta","data":{"sessionID":"ses_f1991fb25ffeHR2OxfoQ01Yy78","assistantMessageID":"msg_0e66e0935001QhlNL2GyHiqO14","ordinal":0,"delta":"OK-42"}}`

// realTextEnded 是真机抓的 session.text.ended 事件。
//
// ⚠️ 它**带 durable.aggregateID** 但 data.sessionID 也在——两个来源都有，
// 因此实现里任一来源单独可用都不够，但也不能只读一个。
const realTextEnded = `{"id":"evt_0e66e1b17001a9chFhztyo05CN","created":1790572370711,"type":"session.text.ended","data":{"sessionID":"ses_f1991fb25ffeHR2OxfoQ01Yy78","assistantMessageID":"msg_0e66e0935001QhlNL2GyHiqO14","ordinal":0,"text":"OK-42"},"durable":{"aggregateID":"ses_f1991fb25ffeHR2OxfoQ01Yy78","seq":9,"version":1}}`

// realStepEnded 是真机抓的 session.step.ended 事件。
const realStepEnded = `{"id":"evt_0e66e1b21001Kdg7UegqOa0oXU","created":1790572370721,"type":"session.step.ended","data":{"sessionID":"ses_f1991fb25ffeHR2OxfoQ01Yy78","assistantMessageID":"msg_0e66e0935001QhlNL2GyHiqO14","finish":"stop","rawFinish":"stop","cost":0,"tokens":{"input":5203,"output":7,"reasoning":18,"cache":{"read":1280,"write":0}}},"durable":{"aggregateID":"ses_f1991fb25ffeHR2OxfoQ01Yy78","seq":11,"version":1}}`

// realExecutionSucceeded 是真机抓的 session.execution.succeeded 事件。
const realExecutionSucceeded = `{"id":"evt_0e66e1b28001Jg7PeRGG7XwDF1","created":1790572370728,"type":"session.execution.succeeded","data":{"sessionID":"ses_f1991fb25ffeHR2OxfoQ01Yy78"},"durable":{"aggregateID":"ses_f1991fb25ffeHR2OxfoQ01Yy78","seq":12,"version":1}}`

// realToolInputStarted 是真机抓的 session.tool.input.started 事件。
const realToolInputStarted = `{"id":"evt_0e6762ec50012tVpB2u6Sf773l","created":1790572900037,"type":"session.tool.input.started","data":{"sessionID":"ses_f1989e5d3ffetbnXuT2gIOnH04","assistantMessageID":"msg_0e6761df8001iKRQt97b3sSryZ","id":"call_41847ad4590c4197b77cc708","name":"shell"},"durable":{"aggregateID":"ses_f1989e5d3ffetbnXuT2gIOnH04","seq":7,"version":1}}`

const testSID = "ses_f1991fb25ffeHR2OxfoQ01Yy78"

// toolSID 是工具事件所属的会话（另一次抓取，与 testSID 不同）。
const toolSID = "ses_f1989e5d3ffetbnXuT2gIOnH04"

func mustTranslate(t *testing.T, sid, payload string) AgentEvent {
	t.Helper()
	ev, ok := TranslateEvent(sid, []byte(payload))
	if !ok {
		t.Fatalf("事件未被翻译: %s", payload)
	}
	return ev
}

// Test真机事件翻译成内部契约 覆盖一轮短回答的完整事件序列。
func Test真机事件翻译成内部契约(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		// sid 是该事件所属的会话；真机 fixture 跨了两次抓取，
		// 会话 ID 并不相同。
		sid   string
		want  string
		check func(t *testing.T, ev AgentEvent)
	}{
		{
			name:    "reasoning.started → thinking.start",
			payload: realReasoningStarted,
			sid:     testSID,
			want:    EvThinkingStart,
			check: func(t *testing.T, ev AgentEvent) {
				// V2 不叫 messageID，叫 assistantMessageID
				if ev.Properties.MessageID != "msg_0e66e0935001QhlNL2GyHiqO14" {
					t.Errorf("MessageID = %q（V2 字段名是 assistantMessageID）", ev.Properties.MessageID)
				}
			},
		},
		{
			name:    "reasoning.delta → thinking.delta",
			payload: realReasoningDelta,
			sid:     testSID,
			want:    EvThinkingDelta,
			check: func(t *testing.T, ev AgentEvent) {
				if ev.Properties.Delta != "The user wants me to" {
					t.Errorf("Delta = %q", ev.Properties.Delta)
				}
			},
		},
		{
			name:    "text.delta → message.delta",
			payload: realTextDelta,
			sid:     testSID,
			want:    EvMessageDelta,
			check: func(t *testing.T, ev AgentEvent) {
				if ev.Properties.Delta != "OK-42" {
					t.Errorf("Delta = %q", ev.Properties.Delta)
				}
			},
		},
		{
			name:    "text.ended → message.segment.complete（带完整正文）",
			payload: realTextEnded,
			sid:     testSID,
			want:    EvMessageSegmentComplete,
			check: func(t *testing.T, ev AgentEvent) {
				if ev.Properties.Text != "OK-42" {
					t.Errorf("Text = %q（text.ended 必须带该段完整正文）", ev.Properties.Text)
				}
			},
		},
		{
			name:    "execution.succeeded → message.complete",
			payload: realExecutionSucceeded,
			sid:     testSID,
			want:    EvMessageComplete,
		},
		{
			name:    "tool.input.started → tool.start",
			payload: realToolInputStarted,
			sid:     toolSID,
			want:    EvToolStart,
			check: func(t *testing.T, ev AgentEvent) {
				if ev.Properties.Tool != "shell" {
					t.Errorf("Tool = %q", ev.Properties.Tool)
				}
				if ev.Properties.ToolCallID != "call_41847ad4590c4197b77cc708" {
					t.Errorf("ToolCallID = %q", ev.Properties.ToolCallID)
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ev := mustTranslate(t, tc.sid, tc.payload)
			if ev.Type != tc.want {
				t.Errorf("type = %q, 期望 %q", ev.Type, tc.want)
			}
			if ev.Properties.SessionID != tc.sid {
				t.Errorf("SessionID = %q, 期望 %q", ev.Properties.SessionID, tc.sid)
			}
			if tc.check != nil {
				tc.check(t, ev)
			}
		})
	}
}

// Test段结束不是回合结束 是「回复半截」缺陷的根因。
//
// session.step.ended 是「一个工作单元结束」的**中间**边界，一轮里
// 可能有多个（text → tool → text）。把它当回合结束会让上层在第一个
// step 就收尾退订，工具调用之后的文本整段丢失。
func Test段结束不是回合结束(t *testing.T) {
	if _, ok := TranslateEvent(testSID, []byte(realStepEnded)); ok {
		t.Error("session.step.ended 不得被翻译成任何事件（它是中间边界，不是回合结束）")
	}
}

// Test段文本结束也不当回合结束 但它**必须**以 message.segment.complete
// 的形式上报：那是「用权威全文覆盖累加结果」的唯一时机。
func Test段文本结束也不当回合结束(t *testing.T) {
	ev := mustTranslate(t, testSID, realTextEnded)
	if ev.Type == EvMessageComplete {
		t.Fatal("text.ended 不得翻译成 message.complete（那会让人提前收尾）")
	}
	if ev.Type != EvMessageSegmentComplete {
		t.Errorf("text.ended = %q, 期望 %q", ev.Type, EvMessageSegmentComplete)
	}
}

// TestsessionIdle也是回合结束 短回答常只有 session.idle 而没有
// execution.succeeded——两个来源都可能只到其一。
func TestSessionIdle也是回合结束(t *testing.T) {
	payload := `{"type":"session.idle","data":{"sessionID":"` + testSID + `"}}`
	ev := mustTranslate(t, testSID, payload)
	if ev.Type != EvMessageComplete {
		t.Errorf("session.idle = %q, 期望 %q", ev.Type, EvMessageComplete)
	}
}

// TestsessionResumed不是回合结束 实测它比 message.complete **晚 1.3 秒**
// 才到。拿它当判据会让收尾晚 1.3 秒，某些轮次还会永远等不到。
func TestSessionResumed不是回合结束(t *testing.T) {
	payload := `{"type":"session.resumed","data":{"sessionID":"` + testSID + `"}}`
	if _, ok := TranslateEvent(testSID, []byte(payload)); ok {
		t.Error("session.resumed 不得被当作任何事件（它比 message.complete 晚 1.3 秒）")
	}
}

// Test别的会话的事件被丢弃 SSE 是全局流，一个进程上跑着所有会话的事件。
// 不过滤等于把别的会话的正文渲染到当前卡片上。
func Test别的会话的事件被丢弃(t *testing.T) {
	other := `{"type":"session.text.delta","data":{"sessionID":"ses_OTHER","delta":"别人的内容"}}`
	if _, ok := TranslateEvent(testSID, []byte(other)); ok {
		t.Error("别的会话的事件必须丢弃")
	}
}

// Test无法判定归属的事件丢弃 宁可漏一条，也不能猜错——
// 猜错等于把别的会话的正文渲染到当前卡片上。
func Test无法判定归属的事件丢弃(t *testing.T) {
	payload := `{"type":"session.usage.updated","data":{"cost":1}}`
	if _, ok := TranslateEvent(testSID, []byte(payload)); ok {
		t.Error("既无 sessionID 也无 durable 的事件必须丢弃，不能猜")
	}
}

// Test只靠durable也能判定归属 部分事件（如 session.idle）只带
// durable.aggregateID。只读 data.sessionID 会把这类事件全丢掉，
// 表现是「短回答能收到，长回答收不到结尾」。
func Test只靠durable也能判定归属(t *testing.T) {
	payload := `{"type":"session.idle","data":{},"durable":{"aggregateID":"` + testSID + `","seq":9}}`
	ev := mustTranslate(t, testSID, payload)
	if ev.Type != EvMessageComplete {
		t.Errorf("仅 durable 归属的事件应被接受，实际 type = %q", ev.Type)
	}
}

// Test权限与form事件透传 V2 是 inbox 式执行：被权限卡住时
// message.complete 永远不会来，只能靠这两类事件驱动。
func Test权限与form事件透传(t *testing.T) {
	perm := `{"type":"permission.asked","data":{"sessionID":"` + testSID + `","permissionID":"per_1"}}`
	ev := mustTranslate(t, testSID, perm)
	if ev.Type != EvPermissionAsked {
		t.Errorf("permission.asked = %q", ev.Type)
	}
	if ev.Properties.PermissionID != "per_1" {
		t.Errorf("PermissionID = %q", ev.Properties.PermissionID)
	}

	form := `{"type":"form.created","data":{"sessionID":"` + testSID + `","formID":"frm_1"}}`
	ev = mustTranslate(t, testSID, form)
	if ev.Type != EvFormCreated {
		t.Errorf("form.created = %q", ev.Type)
	}
	if ev.Properties.FormID != "frm_1" {
		t.Errorf("FormID = %q", ev.Properties.FormID)
	}
}

// Test中断与失败事件
func Test中断与失败事件(t *testing.T) {
	abort := `{"type":"session.execution.interrupted","data":{"sessionID":"` + testSID + `","reason":"user"}}`
	if ev := mustTranslate(t, testSID, abort); ev.Type != EvAbort {
		t.Errorf("interrupted = %q, 期望 %q", ev.Type, EvAbort)
	}

	failed := `{"type":"session.execution.failed","data":{"sessionID":"` + testSID + `","error":{"_tag":"ProviderError","message":"上游超时"}}}`
	ev := mustTranslate(t, testSID, failed)
	if ev.Type != EvError {
		t.Errorf("failed = %q, 期望 %q", ev.Type, EvError)
	}
	if ev.Properties.Error != "上游超时" {
		t.Errorf("Error = %q（应提取 error.message）", ev.Properties.Error)
	}
}

// Test畸形载荷不崩 事件流是外部输入，解析失败必须丢弃而不是 panic
// ——panic 会连带打断整条 SSE 读取循环。
func Test畸形载荷不崩(t *testing.T) {
	for _, payload := range []string{"", "not json", `{"type":123}`, `{"type":"session.text.delta","data":"not an object"}`} {
		if _, ok := TranslateEvent(testSID, []byte(payload)); ok {
			t.Errorf("畸形载荷 %q 不应被接受", payload)
		}
	}
}

// Test未识别类型安全丢弃 V2 会持续加新事件类型，不能因此崩。
func Test未识别类型安全丢弃(t *testing.T) {
	payload := `{"type":"session.future.thing","data":{"sessionID":"` + testSID + `"}}`
	if _, ok := TranslateEvent(testSID, []byte(payload)); ok {
		t.Error("未识别类型应丢弃而不是硬编一个映射")
	}
}

// ============ 表单端点契约 ============

// realFormResponse 是按 V2 契约（@opencode/client@2.0.18 生成的客户端里
// `GET /api/session/{sessionID}/form/{formID}` → 200）还原的响应。
//
// 字段值取自 form_card_test.go 里那份**真机实测样本**
// （会话 ses_f17f172b0ffe），不是人造最小样本——
// form 契约的历次问题都源于「人造样本与真实契约不一致」。
const realFormResponse = `{"data":{"id":"frm_0ea94190d001dVJDe15hahRQ4y","sessionID":"ses_f17f172b0ffeSNJccPJFeOtCSp","title":"Questions","metadata":{"kind":"question"},"fields":[{"key":"q0","title":"重启哪个进程","description":"要重启的是哪个进程？","type":"string","options":[{"value":"重启预览用的 HTTP 服务","label":"重启预览用的 HTTP 服务","description":"重新拉起 python http.server"}],"custom":true}]}}`

// Test表单端点路径不漂 端点错一个字符的后果是 404，
// 而 404 会被 GetForm 的错误路径吞掉、表现成「问题卡加载失败」。
//
// 断言的是 **GetForm 真正调用的那个函数**，不是把同一串字符
// 在测试里重打一遍——后者测的是测试自己，改实现它照样绿。
func Test表单端点路径不漂(t *testing.T) {
	if got := formPath("ses_X", "frm_Y"); got != "/api/session/ses_X/form/frm_Y" {
		t.Errorf("表单取详情路径 = %q, 期望 /api/session/ses_X/form/frm_Y", got)
	}
}

// Test表单路径转义ID formID 来自事件载荷，直接拼进 URL 段会有注入风险。
func Test表单路径转义ID(t *testing.T) {
	got := formPath("ses_X", "frm_a/b")
	if strings.Contains(got, "frm_a/b") {
		t.Errorf("formID 未转义斜杠: %q", got)
	}
	if !strings.HasSuffix(got, "/form/frm_a%2Fb") {
		t.Errorf("转义结果 = %q", got)
	}
}

// Test表单响应能解出完整字段 契约错一个字段名不会报错，只是恒为零值——
// 卡片会渲染成空表单。这种「不报错的错」必须靠解包测试挡住。
func Test表单响应能解出完整字段(t *testing.T) {
	var form FormInfo
	if err := unwrapData(realFormResponse, &form); err != nil {
		t.Fatalf("解包失败: %v", err)
	}
	if form.ID != "frm_0ea94190d001dVJDe15hahRQ4y" {
		t.Errorf("ID = %q", form.ID)
	}
	if form.SessionID != "ses_f17f172b0ffeSNJccPJFeOtCSp" {
		t.Errorf("SessionID = %q", form.SessionID)
	}
	if form.Title != "Questions" {
		t.Errorf("Title = %q", form.Title)
	}
	if len(form.Fields) != 1 {
		t.Fatalf("字段数 = %d, 期望 1", len(form.Fields))
	}
	f := form.Fields[0]
	if f.Key != "q0" {
		t.Errorf("fields[].key = %q（V2 必填）", f.Key)
	}
	if f.Type != "string" {
		t.Errorf("fields[].type = %q", f.Type)
	}
	if !f.Custom {
		t.Error("fields[].custom 应为 true")
	}
	if len(f.Options) != 1 {
		t.Fatalf("候选项数 = %d, 期望 1", len(f.Options))
	}
	if f.Options[0].Value == "" || f.Options[0].Label == "" {
		t.Errorf("候选项必须有 value 与 label: %+v", f.Options[0])
	}
	if f.Options[0].Description == "" {
		t.Error("候选项的 description 也应解出（渲染时要单列）")
	}
}

// Test表单响应兼容裸对象 V2 不同端点之间并不统一（/api/project 返裸数组），
// 假设其一就会在另一类端点上静默失败。
func Test表单响应兼容裸对象(t *testing.T) {
	bare := `{"id":"frm_1","fields":[{"key":"q0","title":"t","type":"string"}]}`
	var form FormInfo
	if err := unwrapData(bare, &form); err != nil {
		t.Fatal(err)
	}
	if form.ID != "frm_1" || len(form.Fields) != 1 {
		t.Errorf("裸对象应能解包: %+v", form)
	}
}

// Test表单响应为空必须报错 「字段名全对但内容空」是最危险的形态：
// 会渲染出一张只有提交按钮的空表单，且没有任何报错。
//
// 这条曾经是个**假测试**：它只调 unwrapData（而 unwrapData 不判空），
// 于是分支永远走不到、断言永远不执行。改为直接打 parseForm。
func Test表单响应为空必须报错(t *testing.T) {
	for _, raw := range []string{
		`{"data":{}}`,
		`{}`,
		`{"data":{"id":"","sessionID":"ses_1","title":"t","fields":[]}}`,
		`   `,
	} {
		if _, err := parseForm(raw); err == nil {
			t.Errorf("空表单响应 %q 必须报错，否则会渲染出空表单", raw)
		}
	}
}

// Test只有ID没有fields也算半截 有 ID 但一个字段都没有，渲染出来
// 仍然是一张用户没法作答的卡。
func Test只有ID没有fields也算半截(t *testing.T) {
	raw := `{"data":{"id":"frm_1","sessionID":"ses_1","title":"t","fields":[]}}`
	form, err := parseForm(raw)
	if err != nil {
		t.Fatalf("带 ID 的响应应被接受: %v", err)
	}
	if form.ID != "frm_1" {
		t.Errorf("ID = %q", form.ID)
	}
	if len(form.Fields) != 0 {
		t.Errorf("字段数 = %d", len(form.Fields))
	}
}

// Test翻译结果不泄漏原始字段 载荷里大量字段（ordinal/state/finish/tokens）
// 渲染层一个都用不到。
func Test翻译结果不泄漏原始字段(t *testing.T) {
	e := mustTranslate(t, testSID, realTextDelta)
	if strings.Contains(e.Type, "session.") {
		t.Errorf("内部契约不应出现原始 V2 事件名: %q", e.Type)
	}
}
