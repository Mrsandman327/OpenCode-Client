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

	// ReplyPermission 回复权限请求。decision 取
	// "once" / "always" / "reject"。
	ReplyPermission(sessionID, requestID, decision string) error

	// DeleteSession 真正删除服务端会话（不可恢复）。
	DeleteSession(sessionID string) error

	// ForkSession 分叉会话，before 非空表示在该消息前分叉。
	ForkSession(sessionID, before string) (string, error)

	// SetModel 切换会话模型。model 形如 "provider/model"。
	SetModel(sessionID, model string) error
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
