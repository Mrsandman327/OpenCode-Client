// card_action.go —— 卡片回调分发
//
// 卡片按钮与消息是**两个独立入口**，门禁必须同时覆盖。
// 只校验消息是不够的：拿到旧卡片的人点一下「允许」或切换会话即可绕过
// 消息侧的全部限制——而卡片会长期留在聊天记录里，比消息更容易被转发。

package feishu

import (
	"context"
	"fmt"
	"strings"
)

// CardAction 是一次卡片回调。
//
// 刻意与 SDK 的 CardActionEvent 分开：桥接只依赖自己需要的字段。
type CardAction struct {
	// ChatID 是卡片所在会话。
	ChatID string
	// UserID 是点击者。门禁按此判断。
	UserID string
	// MessageID 是被点击的卡片消息。
	MessageID string
	// Value 是按钮回调携带的值（我们自己的 action / request_id 等）。
	Value map[string]any
	// Option 是**下拉框选中项的值**。
	//
	// ⚠️ 必须单独取：`select_static` 的选中值只在这里，不在 Value 里。
	// 缺了它，菜单下拉会「收得到点击、拿不到用户选了什么」，表现为选了没反应
	// ——与表单的 form_value 完全同一类问题。
	Option string
	// FormValue 是表单提交时各控件的值。
	FormValue map[string]any
	// FormName 是表单容器的名字，用于把控件值映射回字段。
	FormName string
}

// valueStr 取字符串值。飞书回调里的值是 any，取不到返回空串。
func (a CardAction) valueStr(key string) string {
	if a.Value == nil {
		return ""
	}
	if s, ok := a.Value[key].(string); ok {
		return s
	}
	return ""
}

// HandleCardAction 处理一次卡片回调。
func (b *Bridge) HandleCardAction(ctx context.Context, a CardAction) {
	// 门禁第一条，与消息入口同一条规则
	if !IsUserAllowed(a.UserID, b.policy()) {
		b.replyText(ctx, a.ChatID, DeniedReply())
		return
	}

	act := a.valueStr("action")

	// ⚠️ 表单提交必须**先**按 FormValue 识别，落在 action 分派之前。
	//
	// 原因在 form_card.go：schema 2.0 下表单提交按钮走 behaviors 的
	// form_action，它**没有 value.action**——只有 `name: "submit_btn"`。
	// 于是 act 恒为空串，落进下面的 switch 一个分支都匹配不上，
	// 最终掉进 default 的「该卡片没有可执行的操作」。
	//
	// 症状极隐蔽：卡片渲染完全正常（甚至 `form_card_test.go` 全绿），
	// 用户点「提交」却收到一句「该卡片没有可执行的操作」。
	// 判据用 FormValue 是否非空，而不是 action.tag——tag 也是 "button"，
	// 与普通按钮无法区分。
	if len(a.FormValue) > 0 {
		b.handleFormSubmit(ctx, a)
		return
	}

	switch {
	case act == ActionSessionSelect:
		b.handleSessionSelect(ctx, a)
	case act == ActionPermissionAllowOnce || act == ActionPermissionAllowAlways || act == ActionPermissionReject:
		b.handlePermissionReply(ctx, a)
	case act == ActionFormSubmit:
		// 保留这条显式分支：万一将来某张表单卡真的带了 action，
		// 它应当被正常处理。实际生效的是上面的 FormValue 判定。
		b.handleFormSubmit(ctx, a)
	case act == ActionFormCancel:
		b.replyText(ctx, a.ChatID, "已取消该提问。")
	case act == ActionSwitchModel || act == ActionSwitchProjectInChat:
		b.handleMenuSelect(ctx, a, act)
	default:
		// 快捷按钮复用命令分发：同一个动作出现两份实现，
		// 必然出现「改了命令忘了改按钮」的不一致。
		//
		// 判定只看前缀——前缀本身就是「这是个命令」的契约，
		// 拿到命令名后还要过一次命令表校验，避免「进了分支但命令不存在」
		// 这种只回「未实现」的死路。
		if IsQuickCommandAction(act) {
			cmd := QuickCommandOf(act)
			b.handleQuickCommand(ctx, a, cmd)
			return
		}
		// 未知 action 通常来自旧版本卡片。明确回一句，
		// 否则用户点了没反应会以为卡片坏了
		if act != "" {
			b.replyText(ctx, a.ChatID,
				"这个按钮来自旧版本的卡片，已失效。\n\n请用 `/help` 查看当前可用的命令。")
			return
		}
		// 没有 action 值：可能是表单里的普通交互
		b.replyText(ctx, a.ChatID, "该卡片没有可执行的操作。")
	}
}

// handleSessionSelect 切换到卡片上选中的会话。
func (b *Bridge) handleSessionSelect(ctx context.Context, a CardAction) {
	sessionID := a.valueStr("session_id")
	if sessionID == "" {
		b.replyText(ctx, a.ChatID, "这个按钮缺少会话 ID，请重新用 `/sessions` 获取列表。")
		return
	}

	// 卡片上只有主会话按钮，但显式指定子会话仍允许——
	// 卡片不给子会话按钮是为了防误触，不是禁止使用
	project := b.sessions.Project(a.ChatID)
	if project == "" {
		project = b.cfg.DefaultProject
	}
	b.sessions.Bind(a.ChatID, sessionID, project, b.cfg.DefaultModel)

	// 把卡片换成「已切换」，而不是再发一条文本：
	// 用户点了按钮就该看到按钮所在的地方有反应
	card := NewCard().
		WithHeader("✅ 已切换会话", TemplateGreen).
		Markdown("`"+truncate(sessionID, 32)+"`\n\n可以直接发消息了。", "normal")
	if b.out != nil {
		if _, err := b.out.SendCard(ctx, a.ChatID, card); err != nil {
			logf("切换会话回执发送失败: %v", err)
		}
	}
}

// handlePermissionReply 回复权限请求。
func (b *Bridge) handlePermissionReply(ctx context.Context, a CardAction) {
	requestID := a.valueStr("request_id")
	if requestID == "" {
		b.replyText(ctx, a.ChatID, "这个按钮缺少请求 ID，请重新触发该操作。")
		return
	}

	st := b.sessions.Get(a.ChatID)
	if st.SessionID == "" {
		b.replyText(ctx, a.ChatID, "**当前没有绑定会话**\n\n无法定位这个权限请求所属的会话。")
		return
	}

	// 卡片 action → V2 的 decision 取值
	var decision string
	switch a.valueStr("action") {
	case ActionPermissionAllowOnce:
		decision = "once"
	case ActionPermissionAllowAlways:
		decision = "always"
	case ActionPermissionReject:
		decision = "reject"
	default:
		b.replyText(ctx, a.ChatID, "未知的权限操作。")
		return
	}

	if err := b.oc.ReplyPermission(st.SessionID, requestID, decision); err != nil {
		// 权限请求可能已过期（V2 对未知 requestID 会报错）。
		// 这类失败要可辨识，否则用户以为拒绝了而其实什么都没发生
		b.replyText(ctx, a.ChatID, "**回复权限请求失败**\n\n"+err.Error()+
			"\n\n该请求可能已过期或已被处理。")
		return
	}

	labels := map[string]string{
		"once":   "已允许本次",
		"always": "已允许（本会话内不再询问该资源）",
		"reject": "已拒绝",
	}
	card := NewCard().
		WithHeader("✅ "+labels[decision], TemplateGreen).
		Markdown("请求 `"+truncate(requestID, 20)+"`", "normal")
	if b.out != nil {
		if _, err := b.out.SendCard(ctx, a.ChatID, card); err != nil {
			logf("权限回执发送失败: %v", err)
		}
	}
}

// handleFormSubmit 提交 form 答案。
func (b *Bridge) handleFormSubmit(ctx context.Context, a CardAction) {
	st := b.sessions.Get(a.ChatID)
	if st.SessionID == "" {
		b.replyText(ctx, a.ChatID, "**当前没有绑定会话**\n\n无法提交这个表单。")
		return
	}
	if len(a.FormValue) == 0 {
		b.replyText(ctx, a.ChatID, "没有收到任何答案，请重新触发该提问。")
		return
	}

	// 表单答案按控件名回传（f0_key / f0_key__custom），
	// 这里汇总成一段文本交给 OpenCode——V2 的 form reply 需要
	// 与 fields 一一对应，直接转发控件名对不上
	answers := collectFormAnswers(a)
	summary := strings.Join(answers, "\n")
	if err := b.oc.SendPrompt(st.SessionID, summary, ""); err != nil {
		b.replyText(ctx, a.ChatID, "**提交答案失败**\n\n"+err.Error())
		return
	}

	card := FormAnsweredCard(FormInfo{Fields: nil}, answers)
	if b.out != nil {
		if _, err := b.out.SendCard(ctx, a.ChatID, card); err != nil {
			logf("表单回执发送失败: %v", err)
		}
	}
}

// collectFormAnswers 从表单回调里收集答案。
//
// 控件命名是 `f<索引>_<key>`（自定义输入为 `f<索引>_<key>__custom`），
// 这里按索引聚合：同一题的候选项与自填值放在一起，
// 自填优先（用户填了自定义答案就说明他不想用候选项）。
func collectFormAnswers(a CardAction) []string {
	// 索引 → 答案
	byIndex := map[int]string{}
	// 索引 → 是否有自填值
	custom := map[int]bool{}

	for name, raw := range a.FormValue {
		idx, key, isCustom := parseFieldControl(name)
		if key == "" {
			continue
		}
		s := stringifyFormValue(raw)
		if s == "" {
			continue
		}
		if isCustom {
			custom[idx] = true
			byIndex[idx] = s
			continue
		}
		if !custom[idx] {
			// 多选取值可能是数组，转成逗号分隔
			byIndex[idx] = s
		}
	}

	// 按索引升序输出，保证与表单字段顺序一致
	var out []string
	for i := 0; i < len(byIndex); i++ {
		if v, ok := byIndex[i]; ok {
			out = append(out, v)
		}
	}
	return out
}

// parseFieldControl 解析控件名，返回字段索引、字段 key、是否自填。
//
// 命名不匹配时返回 key=""，调用方据此跳过——而不是把控件名当答案
// 塞进去（那会让 OpenCode 收到一堆 `f0_x` 这样的垃圾）。
func parseFieldControl(name string) (index int, key string, isCustom bool) {
	if !strings.HasPrefix(name, "f") {
		return 0, "", false
	}
	rest := name[1:]
	sep := strings.Index(rest, "_")
	if sep <= 0 {
		return 0, "", false
	}
	idx := 0
	for _, r := range rest[:sep] {
		if r < '0' || r > '9' {
			return 0, "", false
		}
		idx = idx*10 + int(r-'0')
	}
	key = rest[sep+1:]
	if strings.HasSuffix(key, "__custom") {
		key = strings.TrimSuffix(key, "__custom")
		isCustom = true
	}
	if key == "" {
		return 0, "", false
	}
	return idx, key, isCustom
}

// stringifyFormValue 把回调值转成可读文本。
func stringifyFormValue(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(t)
	case []any:
		// 多选
		var parts []string
		for _, item := range t {
			if s := stringifyFormValue(item); s != "" {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, "、")
	case []string:
		return strings.Join(t, "、")
	case bool:
		if t {
			return "是"
		}
		return "否"
	default:
		return fmt.Sprintf("%v", t)
	}
}

// handleQuickCommand 执行卡片上的快捷命令按钮。
//
// 命令名在动作里（`opencode_quick_cmd:/status`），参数为空。
// 查一次命令表：卡片是**发送时**固化的，用户可能拿着几天前的卡片，
// 期间命令被改名/删除——直接执行会走到「未实现」的死路。
func (b *Bridge) handleQuickCommand(ctx context.Context, a CardAction, rawCmd string) {
	name := strings.TrimPrefix(strings.TrimSpace(rawCmd), "/")
	if name == "" {
		b.replyText(ctx, a.ChatID, "这个按钮缺少命令名，请重新获取卡片。")
		return
	}
	cmd, ok := lookupCommand(name)
	if !ok {
		b.replyText(ctx, a.ChatID, fmt.Sprintf(
			"命令 `/%s` 已不存在（这张卡片可能较旧）。\n\n用 `/help` 查看当前可用的命令。", name))
		return
	}
	b.handleCommand(ctx, IncomingMessage{ChatID: a.ChatID, UserID: a.UserID}, cmd, "")
}

// handleMenuSelect 处理项目/模型下拉。
//
// ⚠️ 选中值在 CardAction.Option，**不在** Value 里——
// select_static 的回调把选项值放在 option 字段。
// 取不到就会落进「什么都没发生」的分支，用户体验是「选了没反应」。
func (b *Bridge) handleMenuSelect(ctx context.Context, a CardAction, action string) {
	selected := strings.TrimSpace(a.Option)
	if selected == "" {
		b.replyText(ctx, a.ChatID,
			"没有收到选择的值，请改用命令：`/model <provider/model>` 或 `/switch_project <路径>`。")
		return
	}

	var cmd string
	switch action {
	case ActionSwitchModel:
		cmd = "model"
	case ActionSwitchProjectInChat:
		cmd = "switch_project"
	default:
		b.replyText(ctx, a.ChatID, "未知菜单动作。")
		return
	}

	c, ok := lookupCommand(cmd)
	if !ok {
		b.replyText(ctx, a.ChatID, fmt.Sprintf("命令 `/%s` 不存在。", cmd))
		return
	}
	// 参数整体透传：项目路径可能含空格，按命令解析后会被重新拼回，
	// handler 侧用 join(' ') 还原，与文本入口行为一致。
	b.handleCommand(ctx, IncomingMessage{ChatID: a.ChatID, UserID: a.UserID}, c, selected)
}
