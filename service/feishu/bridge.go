// bridge.go —— 飞书 ↔ OpenCode 桥接层
//
// 把三件事连起来：飞书事件进来、命令解析、OpenCode 调用、结果发回飞书。
//
// 依赖两个窄接口（Output 收消息、OpenCode 调服务），因此整条链路
// 可以在没有飞书连接、也没有 opencode 服务的情况下被测试——
// 这不是为测试而做的抽象：真实部署里长连接随时可能断，
// 逻辑若只能靠端到端验证，断连时就完全失去可测性。
package feishu

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Output 是桥接层需要的发送能力（*Client 满足它）。
type Output interface {
	SendText(ctx context.Context, chatID, text string) (string, error)
	SendCard(ctx context.Context, chatID string, card *Card) (string, error)
}

// BridgeConfig 是桥接层的配置。
type BridgeConfig struct {
	// AllowAllUsers 为 true 时放行所有用户（仅启动时告警）。
	AllowAllUsers bool
	// AdminUserIDs 是管理员 open_id。
	AdminUserIDs []string
	// DefaultProject 是未指定项目时使用的工作目录。
	DefaultProject string
	// DefaultModel 是新建会话时使用的模型。
	DefaultModel string
	// Projects 是可在菜单下拉里切换的项目目录；为空则不渲染该下拉。
	Projects []string
	// Models 是可在菜单下拉里切换的模型（provider/model 形态）。
	Models []string
}

// Bridge 是飞书与 OpenCode 之间的桥。
type Bridge struct {
	oc       OpenCode
	out      Output
	sessions *SessionMap
	wl       *Whitelist
	cfg      BridgeConfig

	// pending 存「等下一步确认」的状态。
	// key 是 chatID——确认必须绑定会话，否则 A 的确认会作用到 B 的会话上。
	mu      sync.Mutex
	pending map[string]*pendingState

	// onReply 供上层把执行结果发出去（流式渲染等）。可为空。
	onReply func(ctx context.Context, chatID, sessionID, text string)
}

// pendingState 是等待用户确认的中间状态。
type pendingState struct {
	// Kind 区分待确认类型：delete / revert。
	Kind string
	// SessionID 是该状态作用的会话。
	SessionID string
	// MessageID 是 revert 暂存的目标消息。
	MessageID string
	// CreatedAt 用于过期清理。
	CreatedAt time.Time
}

// pendingTimeout 是待确认状态的有效期。
//
// 无限制的话，一次 `/delete` 没确认就永远卡着，下次误发 `/delete confirm`
// 会作用在很久以前的会话上。10 分钟足够用户看一眼。
const pendingTimeout = 10 * time.Minute

// NewBridge 建桥接层。
func NewBridge(oc OpenCode, out Output, sessions *SessionMap, wl *Whitelist, cfg BridgeConfig) *Bridge {
	return &Bridge{
		oc:       oc,
		out:      out,
		sessions: sessions,
		wl:       wl,
		cfg:      cfg,
		pending:  make(map[string]*pendingState),
	}
}

// SetReplyHandler 注册执行结果回调。
func (b *Bridge) SetReplyHandler(fn func(ctx context.Context, chatID, sessionID, text string)) {
	b.onReply = fn
}

// policy 取当前访问策略。
func (b *Bridge) policy() AccessPolicy {
	return b.wl.Policy(b.cfg.AllowAllUsers, b.cfg.AdminUserIDs)
}

// ── 消息入口 ──

// IncomingMessage 是一条收到的飞书消息。
//
// 刻意与 SDK 的 NormalizedMessage 分开：桥接只依赖自己需要的字段，
// 换传输层（换 SDK、或直接喂测试数据）时不必跟着改。
type IncomingMessage struct {
	ChatID  string
	UserID  string
	Text    string
	IsGroup bool
}

// HandleMessage 处理一条消息。
func (b *Bridge) HandleMessage(ctx context.Context, msg IncomingMessage) {
	// 门禁第一条：任何驱动 OpenCode 的入口都必须先过门禁
	if !IsUserAllowed(msg.UserID, b.policy()) {
		b.replyText(ctx, msg.ChatID, DeniedReply())
		return
	}

	cmd, args, isCmd := ParseCommand(msg.Text)
	if isCmd {
		b.handleCommand(ctx, msg, cmd, args)
		return
	}

	// 未识别为命令：按普通消息处理（推进对话）
	b.handlePrompt(ctx, msg)
}

// handlePrompt 把普通消息推进到 OpenCode。
func (b *Bridge) handlePrompt(ctx context.Context, msg IncomingMessage) {
	if strings.TrimSpace(msg.Text) == "" {
		return
	}

	// 有待确认状态时，普通消息应被引导去确认，而不是被当成新指令
	if p := b.takePending(msg.ChatID); p != nil {
		b.replyText(ctx, msg.ChatID,
			fmt.Sprintf("上一步操作（`/%s`）还在等确认。\n\n"+
				"请执行 `/delete confirm` 或 `/delete cancel`；发普通消息不会继续该操作。", p.Kind))
		return
	}

	st := b.sessions.Get(msg.ChatID)
	if st.SessionID == "" {
		b.replyText(ctx, msg.ChatID,
			"**还没有绑定会话**\n\n"+
				"先执行 `/new <项目路径>` 建立一个会话，之后的普通消息都会发给它。\n"+
				"用 `/help` 看全部命令。")
		return
	}

	if err := b.oc.SendPrompt(st.SessionID, msg.Text, ""); err != nil {
		b.replyText(ctx, msg.ChatID, "**发送失败**\n\n"+err.Error())
		return
	}
	// 回复内容由上层流式渲染接走；这里只做确认性提示
	if b.onReply != nil {
		b.onReply(ctx, msg.ChatID, st.SessionID, msg.Text)
	}
}

// ── 命令入口 ──

// handleCommand 分发一条命令。
func (b *Bridge) handleCommand(ctx context.Context, msg IncomingMessage, cmd Command, args string) {
	isAdmin := IsAdmin(msg.UserID, b.cfg.AdminUserIDs)
	if cmd.AdminOnly && !isAdmin {
		b.replyText(ctx, msg.ChatID, "该命令仅限管理员使用。")
		return
	}

	switch cmd.Name {
	case "help":
		b.replyText(ctx, msg.ChatID, HelpText(isAdmin))
	case "menu":
		b.sendCard(ctx, msg.ChatID, QuickActionsCard(MenuOptions{
			Projects:     b.cfg.Projects,
			Models:       b.cfg.Models,
			CurrentModel: b.cfg.DefaultModel,
		}))
	case "status":
		b.cmdStatus(ctx, msg.ChatID)
	case "new":
		b.cmdNew(ctx, msg.ChatID, args, false)
	case "new_session":
		b.cmdNew(ctx, msg.ChatID, "", true)
	case "switch_project":
		b.cmdSwitchProject(ctx, msg.ChatID, args)
	case "sessions":
		b.cmdSessions(ctx, msg.ChatID, args)
	case "use":
		b.cmdUse(ctx, msg.ChatID, args)
	case "title":
		b.cmdTitle(ctx, msg.ChatID, args)
	case "abort":
		b.cmdAbort(ctx, msg.ChatID)
	case "compact":
		b.cmdCompact(ctx, msg.ChatID)
	case "usage":
		b.cmdUsage(ctx, msg.ChatID)
	case "diff":
		b.cmdDiff(ctx, msg.ChatID)
	case "clear":
		b.cmdClear(ctx, msg.ChatID)
	case "permissions":
		b.cmdPermissions(ctx, msg.ChatID)
	case "model":
		b.cmdModel(ctx, msg.ChatID, args)
	case "fork":
		b.cmdFork(ctx, msg.ChatID, args)
	case "export":
		b.cmdExport(ctx, msg.ChatID)
	case "delete":
		b.cmdDelete(ctx, msg.ChatID, args)
	case "revert":
		b.cmdRevert(ctx, msg.ChatID, args)
	case "server_status":
		b.cmdServerStatus(ctx, msg.ChatID)
	case "whitelist_add":
		b.cmdWhitelistAdd(ctx, msg, args)
	case "whitelist_remove":
		b.cmdWhitelistRemove(ctx, msg, args)
	case "whitelist_list":
		b.cmdWhitelistList(ctx, msg.ChatID)
	default:
		// 走到这里说明命令表加了条目但忘了写 handler。
		// 明确报错而不是静默无响应——静默无响应会被当成「机器人坏了」。
		b.replyText(ctx, msg.ChatID, "命令 `/"+cmd.Name+"` 尚未实现。")
	}
}

// requireSession 取当前会话，未绑定时给出提示并返回 false。
func (b *Bridge) requireSession(ctx context.Context, chatID string) (ChatSession, bool) {
	st := b.sessions.Get(chatID)
	if st.SessionID == "" {
		b.replyText(ctx, chatID,
			"**当前没有绑定会话**\n\n先执行 `/new <项目路径>`，或用 `/sessions` + `/use` 切回之前的会话。")
		return st, false
	}
	return st, true
}

// ── 各命令实现 ──

func (b *Bridge) cmdStatus(ctx context.Context, chatID string) {
	st := b.sessions.Get(chatID)
	if st.SessionID == "" {
		b.replyText(ctx, chatID, "**当前没有绑定会话**\n\n用 `/new <项目路径>` 新建，或 `/sessions` 查看历史。")
		return
	}
	var sb strings.Builder
	sb.WriteString("**当前会话**\n\n")
	sb.WriteString("• ID：`" + st.SessionID + "`\n")
	if st.ProjectPath != "" {
		sb.WriteString("• 项目：`" + st.ProjectPath + "`\n")
	}
	if st.Model != "" {
		sb.WriteString("• 模型：`" + st.Model + "`\n")
	}
	if b.wl.Has(chatID) {
		sb.WriteString("• 白名单：已在\n")
	}
	b.replyText(ctx, chatID, sb.String())
}

// cmdNew 新建会话。
//
// reuseProject 为 true（/new_session）时忽略参数，沿用该 chat 记住的当前
// 项目——而不是默认项目。用户在 /switch_project 切过项目后执行
// /new_session，理应开在新项目下；用默认项目会让切换看起来没生效。
func (b *Bridge) cmdNew(ctx context.Context, chatID, arg string, reuseProject bool) {
	project := b.cfg.DefaultProject
	if reuseProject {
		if cur := b.sessions.Project(chatID); cur != "" {
			project = cur
		}
	} else if strings.TrimSpace(arg) != "" {
		project = strings.TrimSpace(arg)
	}
	if project == "" {
		b.replyText(ctx, chatID,
			"**需要指定项目路径**\n\n用法：`/new <项目路径>`\n"+
				"例如 `/new D:\\\\work\\\\bmall`。\n"+
				"没有默认项目时必须显式指定——猜一个目录不如问清楚。")
		return
	}

	model := b.cfg.DefaultModel
	sid, err := b.oc.CreateSession(project, model)
	if err != nil {
		b.replyText(ctx, chatID, "**新建会话失败**\n\n"+err.Error())
		return
	}
	b.sessions.Bind(chatID, sid, project, model)
	b.replyText(ctx, chatID, fmt.Sprintf(
		"**已新建会话**\n\n• ID：`%s`\n• 项目：`%s`\n\n现在可以直接发消息了。", sid, project))
}

func (b *Bridge) cmdSwitchProject(ctx context.Context, chatID, arg string) {
	project := strings.TrimSpace(arg)
	if project == "" {
		b.replyText(ctx, chatID, "用法：`/switch_project <项目路径>`")
		return
	}
	// 换项目等于换工作目录：继续用旧会话会让 agent 在旧目录里读写，
	// 而用户以为已经切过去了。因此解除会话绑定——但**记住新项目**，
	// 之后 /new_session 才会在新项目下开会话。
	b.sessions.Unbind(chatID)
	b.sessions.SetProject(chatID, project)
	b.replyText(ctx, chatID, fmt.Sprintf(
		"**已切换项目到** `%s`\n\n"+
			"原会话绑定已解除（会话本身没有删除，仍在历史里）。\n"+
			"执行 `/new_session` 在新项目下开会话，或用 `/sessions` + `/use` 切回。", project))
}

// cmdSessions 列出会话，按主/子分层。
func (b *Bridge) cmdSessions(ctx context.Context, chatID, arg string) {
	keyword := strings.TrimSpace(arg)
	project := b.cfg.DefaultProject
	if st := b.sessions.Get(chatID); st.ProjectPath != "" {
		project = st.ProjectPath
	}

	// 一次拉取后本地建树：两次有界查询（父+子混合池）比逐个查子会话
	// 少一个量级的请求，且不会漏掉父会话较久、子会话较新的情况
	pool, err := b.oc.ListSessions(project, "", 50)
	if err != nil {
		b.replyText(ctx, chatID, "**获取会话列表失败**\n\n"+err.Error())
		return
	}
	if keyword != "" {
		pool = filterSessions(pool, keyword)
	}
	if len(pool) == 0 {
		if keyword != "" {
			b.replyText(ctx, chatID, fmt.Sprintf("没有标题含「%s」的会话。", keyword))
		} else {
			b.replyText(ctx, chatID, "暂无历史会话。")
		}
		return
	}

	nodes, unattached := BuildSessionTree(pool)
	current := b.sessions.Get(chatID).SessionID
	b.out.SendCard(ctx, chatID, SessionSelectCard(SessionSelectOptions{
		Nodes:                nodes,
		CurrentID:            current,
		TotalRoots:           countRoots(pool),
		UnattachedChildCount: unattached,
	}))
}

// filterSessions 按关键词过滤（标题或 ID 命中即保留）。
func filterSessions(list []SessionSummary, keyword string) []SessionSummary {
	kw := strings.ToLower(keyword)
	var out []SessionSummary
	for _, s := range list {
		if strings.Contains(strings.ToLower(s.Title), kw) ||
			strings.Contains(strings.ToLower(s.ID), kw) {
			out = append(out, s)
		}
	}
	return out
}

func countRoots(list []SessionSummary) int {
	n := 0
	for _, s := range list {
		if s.ParentID == "" {
			n++
		}
	}
	return n
}

// cmdUse 切换会话。支持会话 ID 或列表序号。
func (b *Bridge) cmdUse(ctx context.Context, chatID, arg string) {
	target := strings.TrimSpace(arg)
	if target == "" {
		b.replyText(ctx, chatID, "用法：`/use <会话ID或序号>`\n先用 `/sessions` 查看可选项。")
		return
	}

	sessionID := target
	// 纯数字按序号解析：会话 ID 一律以 ses 开头，不会与纯数字混淆
	if _, err := strconv.Atoi(target); err == nil {
		project := b.cfg.DefaultProject
		if st := b.sessions.Get(chatID); st.ProjectPath != "" {
			project = st.ProjectPath
		}
		pool, err := b.oc.ListSessions(project, "", 50)
		if err != nil {
			b.replyText(ctx, chatID, "**获取会话列表失败**\n\n"+err.Error())
			return
		}
		idx, _ := strconv.Atoi(target)
		// 序号只在一级会话中取，与 /sessions 卡片展示的按钮顺序一致
		roots := make([]SessionSummary, 0, len(pool))
		for _, s := range pool {
			if s.ParentID == "" {
				roots = append(roots, s)
			}
		}
		if idx < 1 || idx > len(roots) {
			b.replyText(ctx, chatID, fmt.Sprintf("序号超出范围：当前共 %d 个主会话。", len(roots)))
			return
		}
		sessionID = roots[idx-1].ID
	}

	// **不校验目标是否为子会话**：子会话 ID 确实可用，
	// 只是不进 /sessions 的可点列表（那里避免误触）。显式指定是用户有意的。
	b.sessions.Bind(chatID, sessionID, b.cfg.DefaultProject, b.cfg.DefaultModel)
	b.replyText(ctx, chatID, "**已切换会话**\n\n`"+sessionID+"`")
}

func (b *Bridge) cmdTitle(ctx context.Context, chatID, arg string) {
	title := strings.TrimSpace(arg)
	if title == "" {
		b.replyText(ctx, chatID, "用法：`/title <名称>`")
		return
	}
	st, ok := b.requireSession(ctx, chatID)
	if !ok {
		return
	}
	if err := b.oc.RenameSession(st.SessionID, title); err != nil {
		b.replyText(ctx, chatID, "**重命名失败**\n\n"+err.Error())
		return
	}
	b.replyText(ctx, chatID, "**已重命名为** "+title)
}

func (b *Bridge) cmdAbort(ctx context.Context, chatID string) {
	st, ok := b.requireSession(ctx, chatID)
	if !ok {
		return
	}
	if err := b.oc.Interrupt(st.SessionID); err != nil {
		b.replyText(ctx, chatID, "**中止失败**\n\n"+err.Error())
		return
	}
	b.replyText(ctx, chatID, "已中止当前运行的任务。")
}

func (b *Bridge) cmdCompact(ctx context.Context, chatID string) {
	st, ok := b.requireSession(ctx, chatID)
	if !ok {
		return
	}
	if err := b.oc.CompactSession(st.SessionID); err != nil {
		b.replyText(ctx, chatID, "**压缩失败**\n\n"+err.Error())
		return
	}
	b.replyText(ctx, chatID, "已提交上下文压缩请求。")
}

func (b *Bridge) cmdUsage(ctx context.Context, chatID string) {
	st, ok := b.requireSession(ctx, chatID)
	if !ok {
		return
	}
	u, err := b.oc.SessionUsage(st.SessionID)
	if err != nil {
		b.replyText(ctx, chatID, "**获取用量失败**\n\n"+err.Error())
		return
	}
	b.sendCard(ctx, chatID, UsageCard(u))
}

func (b *Bridge) cmdDiff(ctx context.Context, chatID string) {
	st, ok := b.requireSession(ctx, chatID)
	if !ok {
		return
	}
	stats, err := b.oc.SessionDiff(st.SessionID)
	if err != nil {
		b.replyText(ctx, chatID, "**获取改动失败**\n\n"+err.Error())
		return
	}
	// 本会话触及的文件数拿不到（V2 无此口径），显式传 -1 表示未知，
	// 让卡片省略而不是显示 0
	b.sendCard(ctx, chatID, DiffCard(DiffCardOptions{Stats: stats, SessionFileCount: -1}))
}

func (b *Bridge) cmdClear(ctx context.Context, chatID string) {
	if !b.sessions.Bound(chatID) {
		b.replyText(ctx, chatID, "当前本来就没有绑定会话。")
		return
	}
	b.sessions.Unbind(chatID)
	b.replyText(ctx, chatID,
		"**已解除绑定**\n\n服务端会话没有被删除，历史里仍可用 `/sessions` + `/use` 切回。")
}

func (b *Bridge) cmdPermissions(ctx context.Context, chatID string) {
	st, ok := b.requireSession(ctx, chatID)
	if !ok {
		return
	}
	reqs, err := b.oc.ListPermissions(st.SessionID)
	if err != nil {
		b.replyText(ctx, chatID, "**获取权限请求失败**\n\n"+err.Error())
		return
	}
	if len(reqs) == 0 {
		b.replyText(ctx, chatID, "当前没有待审批的权限请求。")
		return
	}
	for _, r := range reqs {
		b.sendCard(ctx, chatID, PermissionCard(r))
	}
}

func (b *Bridge) cmdModel(ctx context.Context, chatID, arg string) {
	model := strings.TrimSpace(arg)
	if model == "" {
		b.replyText(ctx, chatID,
			"用法：`/model <provider/model>`\n例如 `/model opencode-go/space-bunny-free`")
		return
	}
	st, ok := b.requireSession(ctx, chatID)
	if !ok {
		return
	}
	if err := b.oc.SetModel(st.SessionID, model); err != nil {
		b.replyText(ctx, chatID, "**切换模型失败**\n\n"+err.Error())
		return
	}
	// 记进映射：/status 要能显示当前模型
	st.Model = model
	b.sessions.Set(chatID, st)
	b.replyText(ctx, chatID, "**已切换模型为** `"+model+"`")
}

func (b *Bridge) cmdFork(ctx context.Context, chatID, arg string) {
	st, ok := b.requireSession(ctx, chatID)
	if !ok {
		return
	}
	before := strings.TrimSpace(arg)
	newID, err := b.oc.ForkSession(st.SessionID, before)
	if err != nil {
		b.replyText(ctx, chatID, "**分叉失败**\n\n"+err.Error())
		return
	}
	b.sessions.Bind(chatID, newID, st.ProjectPath, st.Model)
	msg := "**已分叉**\n\n新会话：`" + newID + "`\n已自动切换到新会话。"
	if before != "" {
		msg += "\n\n分叉点：在消息 `" + truncate(before, 14) + "` 之前。"
	}
	b.replyText(ctx, chatID, msg)
}

func (b *Bridge) cmdExport(ctx context.Context, chatID string) {
	st, ok := b.requireSession(ctx, chatID)
	if !ok {
		return
	}
	raw, err := b.oc.ExportSession(st.SessionID)
	if err != nil {
		b.replyText(ctx, chatID, "**导出失败**\n\n"+err.Error())
		return
	}
	// 全量 JSON 远超飞书消息长度上限。给出大小与保存方式，
	// 而不是把截断后的片段当「导出结果」发出去。
	size := len([]rune(raw))
	msg := fmt.Sprintf("**已导出**\n\n• 会话：`%s`\n• 大小：约 %d 字符\n\n"+
		"完整 JSON 有 %d 字符，飞书单条消息放不下，因此不在这里发送。\n"+
		"如需查看，用 `/status` 确认会话 ID 后在本机 OpenCode 里导出。", st.SessionID, size, size)
	b.replyText(ctx, chatID, msg)
}

func (b *Bridge) cmdServerStatus(ctx context.Context, chatID string) {
	info, err := b.oc.ServerInfo()
	if err != nil {
		b.replyText(ctx, chatID, "**获取服务端状态失败**\n\n"+err.Error())
		return
	}
	var sb strings.Builder
	sb.WriteString("**OpenCode 服务端**\n\n")
	if info.Version != "" {
		sb.WriteString("• 版本：" + info.Version + "\n")
	}
	if info.Address != "" {
		sb.WriteString("• 地址：" + info.Address + "\n")
	}
	if info.PID != 0 {
		sb.WriteString("• 进程 PID：" + strconv.Itoa(info.PID) + "\n")
	}
	b.replyText(ctx, chatID, sb.String())
}

// cmdDelete 删除会话，两步确认。
func (b *Bridge) cmdDelete(ctx context.Context, chatID, arg string) {
	switch strings.TrimSpace(arg) {
	case "confirm":
		p := b.takePending(chatID)
		if p == nil || p.Kind != "delete" {
			b.replyText(ctx, chatID,
				"没有待确认的删除操作。\n\n如需删除当前会话，先执行 `/delete`。")
			return
		}
		if err := b.oc.DeleteSession(p.SessionID); err != nil {
			b.replyText(ctx, chatID, "**删除失败**\n\n"+err.Error())
			return
		}
		b.sessions.Unbind(chatID)
		b.replyText(ctx, chatID, "**已删除会话** `"+truncate(p.SessionID, 20)+"`\n\n此操作不可恢复。")

	case "cancel":
		if b.takePending(chatID) == nil {
			b.replyText(ctx, chatID, "没有待确认的操作。")
			return
		}
		b.replyText(ctx, chatID, "已取消。")

	default:
		st, ok := b.requireSession(ctx, chatID)
		if !ok {
			return
		}
		b.setPending(chatID, &pendingState{
			Kind:      "delete",
			SessionID: st.SessionID,
			CreatedAt: time.Now(),
		})
		b.replyText(ctx, chatID, fmt.Sprintf(
			"**确认删除会话？**\n\n`%s`\n\n"+
				"⚠️ **删除不可恢复**，会话内的对话记录会一并消失。\n\n"+
				"执行 `/delete confirm` 确认，或 `/delete cancel` 放弃。\n"+
				"（10 分钟内有效；期间发普通消息不会继续该操作。）", truncate(st.SessionID, 24)))
	}
}

// cmdRevert 回滚会话。列可选点 → 暂存 → 提交。
func (b *Bridge) cmdRevert(ctx context.Context, chatID, arg string) {
	st, ok := b.requireSession(ctx, chatID)
	if !ok {
		return
	}
	targets, err := b.oc.ListRevertTargets(st.SessionID, 10)
	if err != nil {
		b.replyText(ctx, chatID, "**获取可回滚位置失败**\n\n"+err.Error())
		return
	}
	if len(targets) == 0 {
		b.replyText(ctx, chatID, "当前会话没有可回滚的位置（至少需要一条已完成的回复）。")
		return
	}

	switch strings.TrimSpace(arg) {
	case "confirm":
		p := b.takePending(chatID)
		if p == nil || p.Kind != "revert" {
			b.replyText(ctx, chatID, "没有待确认的回滚。\n\n用法：`/revert <序号>` 暂存，`/revert confirm` 提交。")
			return
		}
		if err := b.oc.CommitRevert(p.SessionID); err != nil {
			b.replyText(ctx, chatID, "**回滚失败**\n\n"+err.Error())
			return
		}
		b.replyText(ctx, chatID, "**已回滚**到消息 `"+truncate(p.MessageID, 20)+"` 之前。")

	case "cancel":
		if p := b.takePending(chatID); p == nil {
			b.replyText(ctx, chatID, "没有待确认的操作。")
			return
		} else if p.Kind == "revert" {
			// 放弃时要把服务端的暂存也清掉，否则下次 revert 会带着旧暂存
			if err := b.oc.ClearRevert(p.SessionID); err != nil {
				b.replyText(ctx, chatID, "已放弃本地确认，但清除服务端暂存失败：\n\n"+err.Error())
				return
			}
		}
		b.replyText(ctx, chatID, "已取消。")

	default:
		b.listRevertTargets(ctx, chatID, st.SessionID, targets)
		if idx, err := strconv.Atoi(strings.TrimSpace(arg)); err == nil {
			if idx < 1 || idx > len(targets) {
				b.replyText(ctx, chatID, fmt.Sprintf("序号超出范围：当前共 %d 个可回滚位置。", len(targets)))
				return
			}
			t := targets[idx-1]
			if err := b.oc.StageRevert(st.SessionID, t.MessageID, true); err != nil {
				b.replyText(ctx, chatID, "**暂存回滚失败**\n\n"+err.Error())
				return
			}
			b.setPending(chatID, &pendingState{
				Kind:      "revert",
				SessionID: st.SessionID,
				MessageID: t.MessageID,
				CreatedAt: time.Now(),
			})
			b.replyText(ctx, chatID, fmt.Sprintf(
				"**已暂存回滚到**\n\n%s\n\n"+
					"⚠️ 提交后该位置之后的对话与改动都会被丢弃。\n\n"+
					"执行 `/revert confirm` 提交，或 `/revert cancel` 放弃。\n"+
					"（10 分钟内有效。）", t.Label))
		}
	}
}

func (b *Bridge) listRevertTargets(ctx context.Context, chatID, sessionID string, targets []RevertTarget) {
	var sb strings.Builder
	sb.WriteString("**可回滚位置**\n\n")
	for i, t := range targets {
		sb.WriteString(fmt.Sprintf("%d. %s\n   `%s`\n", i+1, t.Label, truncate(t.MessageID, 20)))
	}
	sb.WriteString("\n执行 `/revert <序号>` 暂存该位置。")
	b.replyText(ctx, chatID, sb.String())
}

func (b *Bridge) cmdWhitelistAdd(ctx context.Context, msg IncomingMessage, arg string) {
	id := strings.TrimSpace(arg)
	if id == "" {
		b.replyText(ctx, msg.ChatID, "用法：`/whitelist_add <用户ID>`\n用户ID 是飞书 open_id（`ou_` 开头）。")
		return
	}
	added := b.wl.Add(id)

	// ⚠️ 放行态的告警必须**无条件**给出，不能只放在「已存在」分支。
	// 首次添加时若只回「已加入白名单」，管理员会以为访问已经收紧，
	// 而实际上 allow_all_users=true 时白名单根本不参与鉴权。
	// 漏掉这一句的后果是安全配置被静默绕过，且没有任何迹象。
	if b.cfg.AllowAllUsers {
		head := "**已加入白名单**"
		if !added {
			head = "**该用户已在白名单中**"
		}
		b.replyText(ctx, msg.ChatID, head+"\n\n`"+id+"`\n\n"+
			"⚠️ 但当前 `allow_all_users = true`，**白名单不参与鉴权**——\n"+
			"这个用户本来就能用，添加后访问范围没有变化。\n"+
			"要让它生效，请把配置改为 `allow_all_users = false` 并重启。")
		return
	}

	if added {
		b.replyText(ctx, msg.ChatID, "**已加入白名单**\n\n`"+id+"`\n\n"+
			"该用户现在可以使用机器人（`allow_all_users = false` 已生效）。")
		return
	}
	b.replyText(ctx, msg.ChatID, "该用户已在白名单中（无变化）。")
}

func (b *Bridge) cmdWhitelistRemove(ctx context.Context, msg IncomingMessage, arg string) {
	id := strings.TrimSpace(arg)
	if id == "" {
		b.replyText(ctx, msg.ChatID, "用法：`/whitelist_remove <用户ID>`")
		return
	}
	if b.wl.Remove(id) {
		b.replyText(ctx, msg.ChatID, "**已移出白名单**\n\n`"+id+"`")
		return
	}
	b.replyText(ctx, msg.ChatID, "该用户不在白名单中。")
}

func (b *Bridge) cmdWhitelistList(ctx context.Context, chatID string) {
	ids := b.wl.List()
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("**白名单**（%d 人）\n\n", len(ids)))
	if b.cfg.AllowAllUsers {
		sb.WriteString("⚠️ 当前 `allow_all_users = true`，白名单**不参与鉴权**。\n")
		sb.WriteString("把配置改为 `allow_all_users = false` 后名单才生效。\n\n")
	}
	if len(ids) == 0 {
		sb.WriteString("（空）")
	} else {
		for _, id := range ids {
			sb.WriteString("• `" + id + "`\n")
		}
	}
	if len(b.cfg.AdminUserIDs) > 0 {
		sb.WriteString("\n管理员（始终放行）：")
		for _, a := range b.cfg.AdminUserIDs {
			sb.WriteString("`" + a + "` ")
		}
	}
	b.replyText(ctx, chatID, sb.String())
}

// ── 待确认状态 ──

func (b *Bridge) setPending(chatID string, p *pendingState) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pending[chatID] = p
}

// takePending 取出并清除待确认状态；已过期则当作没有。
func (b *Bridge) takePending(chatID string) *pendingState {
	b.mu.Lock()
	defer b.mu.Unlock()
	p, ok := b.pending[chatID]
	if !ok {
		return nil
	}
	delete(b.pending, chatID)
	// 过期即失效：10 分钟前的确认不该作用到现在的会话上
	if time.Since(p.CreatedAt) > pendingTimeout {
		return nil
	}
	return p
}

// ── 发送辅助 ──

func (b *Bridge) replyText(ctx context.Context, chatID, text string) {
	if b.out == nil {
		return
	}
	if _, err := b.out.SendText(ctx, chatID, text); err != nil {
		// 发送失败无处可报（这本身就是失败路径），记日志即可。
		// 不 panic：一条消息发不出去不该拖垮整个事件循环。
		logf("飞书回复失败 chat=%s: %v", chatID, err)
	}
}

func (b *Bridge) sendCard(ctx context.Context, chatID string, card *Card) {
	if b.out == nil {
		return
	}
	if _, err := b.out.SendCard(ctx, chatID, card); err != nil {
		logf("飞书卡片发送失败 chat=%s: %v", chatID, err)
	}
}
