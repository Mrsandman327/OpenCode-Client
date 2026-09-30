// opencode_iface.go —— 飞书层需要的 OpenCode 能力子集
//
// 这里只定义接口，不含任何 HTTP 代码，因此桥接逻辑可以完全脱离真实服务
// 被测试。真实实现见 opencode_real.go。
//
// 方法集合按「飞书通道实际需要什么」裁剪，不求覆盖 V2 全部能力——
// 多余的方法只会让测试替身变长，而用不到的接口不该有实现。
package feishu

// OpenCode 是飞书通道依赖的 OpenCode 能力。
//
// 所有路径契约（方法、body 字段名、query 参数）取自本机 v2.0.15 的
// /openapi.json 实测，不靠推测——错一个字段名就是静默失败。
type OpenCode interface {
	// CreateSession 新建会话，返回会话 ID。directory 为空表示用服务端默认。
	CreateSession(directory, model string) (string, error)

	// SendPrompt 发送一条用户消息。delivery 非空时指定投递方式
	//（"steer" 插队 / "queue" 排队）。
	SendPrompt(sessionID, text, delivery string) error

	// ListSessions 列出会话。parentID 非空时只列其子会话。
	// 返回的顺序须是服务端给出的顺序（按 updated 倒序）。
	ListSessions(directory, parentID string, limit int) ([]SessionSummary, error)

	// Interrupt 中止当前运行。
	Interrupt(sessionID string) error

	// RenameSession 重命名会话。
	RenameSession(sessionID, title string) error

	// CompactSession 压缩上下文。
	CompactSession(sessionID string) error

	// SessionUsage 取 token 用量与费用。
	SessionUsage(sessionID string) (Usage, error)

	// SessionDiff 取本次会话的代码改动。
	SessionDiff(sessionID string) ([]FileDiffStat, error)

	// ListPermissions 列出会话待审批的权限请求。
	ListPermissions(sessionID string) ([]PermissionRequest, error)

	// GetForm 取单个待回答的表单（含 fields）。
	//
	// 为什么需要它：`form.created` 事件只带 formID，**没有 fields**，
	// 而卡片必须逐字段渲染下拉与输入框——不查一次就只能发一张空表单，
	// 用户看到的正是「有个卡片但里面什么都没有」。
	GetForm(sessionID, formID string) (FormInfo, error)

	// ReplyPermission 回复权限请求。decision 取
	// "once" / "always" / "reject"。
	ReplyPermission(sessionID, requestID, decision string) error

	// DeleteSession 真正删除服务端会话（不可恢复）。
	DeleteSession(sessionID string) error

	// ForkSession 分叉会话，before 非空表示在该消息前分叉。
	ForkSession(sessionID, before string) (string, error)

	// SetModel 切换会话模型。model 形如 "provider/model"。
	SetModel(sessionID, model string) error

	// SubscribeEvents 订阅某个会话的事件流，用于流式渲染。
	//
	// 返回的退订函数**必须可重复调用**且不能阻塞：调用方（StopFeishu）
	// 依赖它收掉后台 goroutine，漏调就是泄漏。
	//
	// 契约：只投递属于该会话的事件（内部已按 sessionID 过滤），
	// 且已把 V2 原始事件翻译成内部契约（见 events.go）。
	// 断线由实现自己重连，调用方不必处理。
	SubscribeEvents(sessionID string, cb EventCallback) (func(), error)

	// ── 以下为远程管理能力 ──

	// ExportSession 导出会话为 JSON 原文。
	ExportSession(sessionID string) (string, error)

	// ServerInfo 取服务端信息。
	ServerInfo() (ServerInfo, error)

	// ListRevertTargets 列出可回滚的位置（最近的若干条已完成回复）。
	ListRevertTargets(sessionID string, limit int) ([]RevertTarget, error)

	// StageRevert 暂存一次回滚（尚不生效）。
	//
	// 暂存与提交分两步：回滚会丢弃该位置之后的对话与改动，
	// 一步到位意味着用户没有反悔的机会。
	StageRevert(sessionID, messageID string, revertFiles bool) error

	// CommitRevert 提交已暂存的回滚。
	CommitRevert(sessionID string) error

	// ClearRevert 清除已暂存但未提交的回滚。
	ClearRevert(sessionID string) error
}

// ServerInfo 是 OpenCode 服务端信息。
type ServerInfo struct {
	Version string
	Address string
	PID     int
}

// RevertTarget 是一个可回滚的位置。
type RevertTarget struct {
	MessageID string
	Label     string
}

// SessionSummary 是一个会话的概要信息。
type SessionSummary struct {
	ID       string
	Title    string
	ParentID string
	Updated  int64 // 毫秒时间戳；0 表示未知
	IsIdle   bool
	HasIdle  bool
}
