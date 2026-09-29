// access.go —— 访问门禁
//
// 移植自 opencode-feishu-bot 的 src/utils/access.ts。
// 那个模块修的是一个安全缺陷：`isWhitelisted()` 定义了但全仓零调用，
// `allow_all_users` 只被读取赋值、从不参与鉴权判断——结果是
// **任何能给机器人发消息的飞书用户都能驱动 OpenCode 在服务器文件系统上
// 执行工具**（shell / write / edit），且不区分群聊。
//
// 这里的语义与 bot 侧一致：
//   - AllowAllUsers 为 true（默认）：放行所有人，仅启动时告警。
//     保留默认放行是为了让升级不产生「配错就把自己锁在外面」的故障。
//   - AllowAllUsers 为 false：只放行管理员与白名单。
//
// 门禁同时作用于**消息**与**卡片按钮**两条入口——只校验消息是不够的，
// 拿到旧卡片的人点一下「允许」或切换会话即可绕过。
package feishu

import "fmt"

// AccessPolicy 是访问策略。
type AccessPolicy struct {
	// AllowAllUsers 为 true 时放行所有人，其余字段不参与判断。
	AllowAllUsers bool
	// AdminUserIDs 是管理员 open_id，任何时候都放行。
	AdminUserIDs []string
	// Whitelist 是白名单 open_id，仅在 AllowAllUsers 为 false 时参与。
	Whitelist []string
}

// IsUserAllowed 判断某用户是否被允许驱动机器人。
func IsUserAllowed(userID string, p AccessPolicy) bool {
	if p.AllowAllUsers {
		return true
	}
	if userID == "" {
		// 空 ID 一律拒绝：否则配置里出现空串就会被匿名绕过
		return false
	}
	for _, id := range p.AdminUserIDs {
		if id == userID {
			return true
		}
	}
	for _, id := range p.Whitelist {
		if id == userID {
			return true
		}
	}
	return false
}

// ShouldWarnOpenAccess 是否需要在启动时告警。
func ShouldWarnOpenAccess(p AccessPolicy) bool {
	return p.AllowAllUsers
}

// OpenAccessWarning 是启动告警文案。
//
// 只在真正处于放行态时提示：这是用户最容易漏看的安全配置，
// 而漏看的后果是任何人都能在服务器上执行工具。
func OpenAccessWarning(adminCount int) string {
	msg := "安全提示：allow_all_users 当前为 true，任何能给本机器人发消息的飞书用户" +
		"都能驱动 OpenCode 在服务器文件系统上执行操作，且不区分群聊。"
	if adminCount > 0 {
		return msg + fmt.Sprintf("如需收紧，请将配置改为 allow_all_users = false（当前已配置 %d 个管理员）。", adminCount)
	}
	return msg + "如需收紧，请将配置改为 allow_all_users = false 并用 /whitelist_add 添加用户。"
}

// DeniedReply 是拒绝时回复用户的话。
//
// 给出可操作的下一步，而不是只说「无权限」——后者会让用户以为机器人坏了。
func DeniedReply() string {
	return "**无访问权限**\n\n" +
		"该机器人会驱动 OpenCode 在服务器上执行操作，因此仅对授权用户开放。\n" +
		"如需开通，请让管理员执行 `/whitelist_add <你的用户ID>`。\n\n" +
		"你的用户ID 可在飞书「设置 → 账号与安全 → 账号信息」中查看。"
}
