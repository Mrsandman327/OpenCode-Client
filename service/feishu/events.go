//go:build feishu

// events.go —— OpenCode 事件的内部契约与 V2 事件翻译
//
// 对应 opencode-feishu-bot 的 src/opencode/client.ts 的 translateEvent
// 与 src/agent/opencode.ts 的事件映射。
//
// 移植而非重设计：V2 的事件名与 V1 完全不同（assistant.text →
// session.text.delta），bot 侧已经用「原始 V2 事件 → 内部契约」两层映射
// 踩平了这层差异，并且踩出了两个必须照抄的坑：
//
//  1. **回合边界不能一刀切**。一轮里可能有 text → tool → text 多段，
//     `session.text.ended`（一段文本结束）与 `session.step.ended`
//     （一个工作单元结束）都**不是**回合结束。此前一律翻译成
//     `message.complete`，上层据此收尾退订，于是工具调用之后的文本
//     整段丢失（用户看到的「半截」），首个 step 只有工具调用时
//     还会渲染出一张空白卡片。真正的回合结束只有
//     `session.execution.succeeded` / `session.idle`。
//
//  2. **delta 会丢，text.ended 不会**。`session.text.delta` 可能因
//     事件流断线而缺段，而 `session.text.ended` 每次都带该段的**完整**
//     正文（实测确认）。因此段结束必须用权威全文**覆盖**累加结果。
//
// 本文件只做纯函数翻译，不含 IO，可直接单测。
package feishu

import "encoding/json"

// 内部事件类型（V2 原始名 → 本契约名）。
//
// ⚠️ 这组名字是渲染层、心跳层、通知层的**唯一**输入契约。
// 新增事件类型时三处都要想清楚：它是否推进阶段、是否停心跳、
// 是否算回合结束。
const (
	// EvThinkingStart 模型开始思考。
	EvThinkingStart = "thinking.start"
	// EvThinkingDelta 思考内容增量。
	EvThinkingDelta = "thinking.delta"
	// EvThinkingComplete 思考结束，携带该段完整思考内容。
	EvThinkingComplete = "thinking.complete"
	// EvMessageStart 一段正文开始。
	EvMessageStart = "message.start"
	// EvMessageDelta 正文增量。
	EvMessageDelta = "message.delta"
	// EvMessageSegmentComplete 一段正文结束，Text 是该段**完整**正文。
	EvMessageSegmentComplete = "message.segment.complete"
	// EvMessageComplete 整轮执行结束。
	EvMessageComplete = "message.complete"
	// EvToolStart / EvToolDelta / EvToolComplete 工具执行。
	EvToolStart    = "tool.start"
	EvToolDelta    = "tool.delta"
	EvToolComplete = "tool.complete"
	// EvError 执行失败。
	EvError = "error"
	// EvAbort 执行被中断。
	EvAbort = "abort"
	// EvPermissionAsked 出现待审批的权限请求。
	EvPermissionAsked = "permission.asked"
	// EvFormCreated 出现待回答的 form。
	EvFormCreated = "form.created"
	// EvSessionRenamed 会话被重命名。
	EvSessionRenamed = "session.renamed"
)

// AgentEvent 是一个内部事件契约事件。
type AgentEvent struct {
	Type       string
	Properties EventProps
}

// EventProps 是事件的载荷。
//
// 只取渲染层真正用得到的字段：V2 的原始 payload 有大量状态字段
// （ordinal / state / finish / tokens），飞书侧一个都用不到，
// 全量透传只会让每个消费方都要先分辨哪些是噪声。
type EventProps struct {
	SessionID string
	MessageID string
	// Delta 是增量内容（thinking.delta / message.delta / tool.delta）。
	Delta string
	// Text 是权威完整内容（message.segment.complete / thinking.complete）。
	Text string
	// Tool 是工具名（tool.start / tool.complete）。
	Tool string
	// ToolCallID 是工具调用 ID。
	ToolCallID string
	// Error 是错误描述（error）。
	Error string
	// Reason 是中断原因（abort）。
	Reason string
	// FormID 是 form 的 ID（form.created）。
	FormID string
	// PermissionID 是权限请求 ID（permission.asked）。
	PermissionID string
}

// EventCallback 是一条已翻译事件的回调。
//
// 回调在订阅 goroutine 里**同步**执行，因此实现必须自己快速返回
// （真正的渲染要另起 goroutine 或在回调内做非阻塞的事）。
type EventCallback func(ev AgentEvent)

// rawEvent 是 SSE `data:` 行的原始形态（V2 Event）。
type rawEvent struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// TranslateEvent 把一条 V2 原始事件翻译成内部契约。
//
// 返回 ok=false 表示该事件与渲染无关（应丢弃）：
//   - 属于其它会话的事件
//   - 属于「不是回合结束」的边界（step.ended / text.ended 的回合语义已
//     由 message.segment.complete 承担）
//   - 未识别的类型
//
// 纯函数：不做 IO、不依赖全局状态，可直接单测。
func TranslateEvent(sessionID string, payload []byte) (AgentEvent, bool) {
	var raw rawEvent
	if err := json.Unmarshal(payload, &raw); err != nil {
		return AgentEvent{}, false
	}

	// 先取会话归属再判类型：不属于本会话的事件一律丢掉。
	// V2 事件的 data.sessionID 是权威字段；部分事件（如 session.idle）
	// 只在 durable.aggregateID 上带会话 ID，因此两个来源都要读。
	sid := sessionIDOf(payload, raw.Data)
	if sid != "" && sid != sessionID {
		return AgentEvent{}, false
	}
	// sid 为空（少数事件既无 sessionID 也无 durable）时不猜：
	// 猜错等于把别的会话的内容渲染到当前卡片上。
	if sid == "" {
		return AgentEvent{}, false
	}

	var d eventData
	if len(raw.Data) > 0 {
		if err := json.Unmarshal(raw.Data, &d); err != nil {
			return AgentEvent{}, false
		}
	}

	switch raw.Type {
	case "session.reasoning.started":
		return AgentEvent{Type: EvThinkingStart, Properties: EventProps{
			SessionID: sid, MessageID: d.MessageID,
		}}, true

	case "session.reasoning.delta":
		return AgentEvent{Type: EvThinkingDelta, Properties: EventProps{
			SessionID: sid, MessageID: d.MessageID, Delta: d.Delta,
		}}, true

	case "session.reasoning.ended":
		return AgentEvent{Type: EvThinkingComplete, Properties: EventProps{
			SessionID: sid, MessageID: d.MessageID, Text: d.Text,
		}}, true

	case "session.text.started":
		return AgentEvent{Type: EvMessageStart, Properties: EventProps{
			SessionID: sid, MessageID: d.MessageID,
		}}, true

	case "session.text.delta":
		return AgentEvent{Type: EvMessageDelta, Properties: EventProps{
			SessionID: sid, MessageID: d.MessageID, Delta: d.Delta,
		}}, true

	case "session.text.ended":
		// 一段文本结束，**不是整轮结束**。一轮里可能有 text → tool → text
		// 多段，把这里当成完成信号会让上层提前收尾（用户看到的「半截」）。
		//
		// 报成独立事件 message.segment.complete 而不是 message.complete：
		// 前者可以安全地用于「以权威内容覆盖累加结果 + 强制渲染」，
		// 后者会让上层退订事件流。
		//
		// d.Text 是该段的权威完整正文（实测确认），比累加 delta 可靠。
		return AgentEvent{Type: EvMessageSegmentComplete, Properties: EventProps{
			SessionID: sid, MessageID: d.MessageID, Text: d.Text,
		}}, true

	case "session.tool.input.started", "session.tool.input.ended":
		// 工具名只在 input.started 里出现；这里原样带上 id，
		// 由渲染层用 ToolCallID 兜底显示。
		return AgentEvent{Type: EvToolStart, Properties: EventProps{
			SessionID: sid, MessageID: d.MessageID, ToolCallID: d.ID, Tool: d.Name,
		}}, true

	case "session.tool.progress":
		return AgentEvent{Type: EvToolStart, Properties: EventProps{
			SessionID: sid, MessageID: d.MessageID, ToolCallID: d.ID,
		}}, true

	case "session.tool.input.delta":
		return AgentEvent{Type: EvToolDelta, Properties: EventProps{
			SessionID: sid, ToolCallID: d.ID, Delta: d.Text,
		}}, true

	case "session.tool.success", "session.tool.failed":
		return AgentEvent{Type: EvToolComplete, Properties: EventProps{
			SessionID: sid, ToolCallID: d.ID, Tool: d.Name,
		}}, true

	case "session.execution.started":
		return AgentEvent{Type: EvMessageStart, Properties: EventProps{
			SessionID: sid, MessageID: d.MessageID,
		}}, true

	// ⚠️ 回合结束的**唯一**两个来源。实测二者可能只到其一：
	// 短回答常只有 session.execution.succeeded；被权限卡住的轮次
	// 两者都不会来（见事件流注释）。
	case "session.execution.succeeded", "session.idle":
		return AgentEvent{Type: EvMessageComplete, Properties: EventProps{SessionID: sid}}, true

	case "session.execution.failed":
		return AgentEvent{Type: EvError, Properties: EventProps{
			SessionID: sid, Error: errorText(d.Error),
		}}, true

	case "session.execution.interrupted":
		return AgentEvent{Type: EvAbort, Properties: EventProps{
			SessionID: sid, Reason: d.Reason,
		}}, true

	case "session.renamed":
		return AgentEvent{Type: EvSessionRenamed, Properties: EventProps{
			SessionID: sid, Text: d.Title,
		}}, true

	case "permission.asked":
		return AgentEvent{Type: EvPermissionAsked, Properties: EventProps{
			SessionID: sid, PermissionID: d.PermissionID,
		}}, true

	case "form.created":
		return AgentEvent{Type: EvFormCreated, Properties: EventProps{
			SessionID: sid, FormID: firstNonEmpty(d.FormID, d.ID),
		}}, true

	// step.ended 是「一个工作单元结束」的**中间**边界，整轮可能有多个。
	// 返回丢弃：把它当完成信号会让上层在第一个 step 就收尾。
	//
	// session.resumed 同样丢弃：实测它比 message.complete **晚 1.3 秒**
	// 才到，拿它当回合结束判据会凭空多等一会；更糟的是某些轮次它先到，
	// 拿它当开始信号则会漏掉真正的开始。
	case "session.step.ended", "session.step.streamed", "session.resumed",
		"session.usage.updated", "session.created":
		return AgentEvent{}, false

	default:
		return AgentEvent{}, false
	}
}

// eventData 是 V2 事件 data 的形状（只取本契约用得到的字段）。
//
// ⚠️ V2 的这些字段名是实测的，写错不报错、只是恒为零值——
// 那是最难查的一类失败，因此这里逐个标注来源。
type eventData struct {
	SessionID string `json:"sessionID"`
	// MessageID 对应 assistantMessageID：V2 不叫 messageID。
	MessageID string `json:"assistantMessageID"`
	Delta     string `json:"delta"`
	// Text 在 reasoning.ended / text.ended 上是该段的完整内容。
	Text string `json:"text"`
	// ID 在工具事件上是调用 ID，在 form 事件上是 form ID。
	ID   string `json:"id"`
	Name string `json:"name"`
	// Title 在 session.renamed 上是新标题。
	Title string `json:"title"`
	// PermissionID 在 permission.asked 上是请求 ID。
	PermissionID string `json:"permissionID"`
	// FormID 与 ID 都可能承载 form 标识，两个都读。
	FormID  string          `json:"formID"`
	Reason  string          `json:"reason"`
	Error   json.RawMessage `json:"error"`
	Ordinal int             `json:"ordinal"`
}

// sessionIDOf 取事件所属会话 ID。
//
// 两个来源（实测都存在）：data.sessionID，以及 durable.aggregateID。
// 后者只在部分事件上出现（session.idle、text.ended 等）。
func sessionIDOf(payload []byte, data json.RawMessage) string {
	var d eventData
	if len(data) > 0 {
		_ = json.Unmarshal(data, &d)
		if d.SessionID != "" {
			return d.SessionID
		}
	}
	// durable.aggregateID 只在顶层，不在 data 里
	var top struct {
		Durable struct {
			AggregateID string `json:"aggregateID"`
		} `json:"durable"`
	}
	if err := json.Unmarshal(payload, &top); err == nil && top.Durable.AggregateID != "" {
		return top.Durable.AggregateID
	}
	return ""
}

// errorText 把 V2 的 error 字段（对象或字符串）压成一行。
func errorText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "未知错误"
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var obj struct {
		Message string `json:"message"`
		Name    string `json:"name"`
		Tag     string `json:"_tag"`
	}
	if err := json.Unmarshal(raw, &obj); err == nil {
		if obj.Message != "" {
			return obj.Message
		}
		if obj.Name != "" {
			return obj.Name
		}
	}
	return summarizeErrBody(string(raw))
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
