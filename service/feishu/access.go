//go:build feishu

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

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

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

// ── 可变白名单 ──

// Whitelist 是可增删的访问白名单，支持持久化。
//
// 与 AccessPolicy 的静态切片分开：/whitelist_add 等命令要在运行时改名单，
// 而 AccessPolicy 是启动配置。白名单单独持久化，否则重启后白名单归零——
// 收紧过权限的实例重启后又变成谁都能驱动。
type Whitelist struct {
	mu    sync.RWMutex
	ids   []string
	path  string
	dirty bool
}

// NewWhitelist 建白名单；path 非空时从磁盘加载。
func NewWhitelist(path string) *Whitelist {
	w := &Whitelist{path: path}
	w.load()
	return w
}

// List 返回当前名单的副本。
func (w *Whitelist) List() []string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return append([]string(nil), w.ids...)
}

// Add 加入白名单。已存在时返回 false（不重复添加）。
func (w *Whitelist) Add(id string) bool {
	id = strings.TrimSpace(id)
	// 空串会变成匿名绕过：IsUserAllowed 虽拒空 userID，
	// 但名单里留个空项会让「谁在名单里」这个问题无法回答
	if id == "" {
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, existing := range w.ids {
		if existing == id {
			return false
		}
	}
	w.ids = append(w.ids, id)
	w.persistLocked()
	return true
}

// Remove 移出白名单。不存在时返回 false。
func (w *Whitelist) Remove(id string) bool {
	id = strings.TrimSpace(id)
	w.mu.Lock()
	defer w.mu.Unlock()
	for i, existing := range w.ids {
		if existing == id {
			w.ids = append(w.ids[:i], w.ids[i+1:]...)
			w.persistLocked()
			return true
		}
	}
	return false
}

// Has 判断是否在名单内。
func (w *Whitelist) Has(id string) bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	for _, existing := range w.ids {
		if existing == id {
			return true
		}
	}
	return false
}

// Len 当前人数。
func (w *Whitelist) Len() int {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return len(w.ids)
}

func (w *Whitelist) load() {
	if w.path == "" {
		return
	}
	raw, err := os.ReadFile(w.path)
	if err != nil {
		return
	}
	// 损坏时降级为空：名单读不出来时保持「无人被授权」是安全的一侧，
	// 而回退到放行会让安全配置静默失效
	var ids []string
	if err := json.Unmarshal(raw, &ids); err != nil {
		return
	}
	w.ids = ids
}

func (w *Whitelist) persistLocked() {
	if w.path == "" {
		return
	}
	raw, err := json.MarshalIndent(w.ids, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(w.path), 0o755); err != nil {
		return
	}
	// 临时文件 + 改名：白名单写一半崩溃会留下损坏文件，
	// 而损坏文件下次加载降级为空——等于把所有人踢出去
	tmp := w.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, w.path)
}

// Policy 由当前配置与白名单合成访问策略。
func (w *Whitelist) Policy(allowAll bool, admins []string) AccessPolicy {
	return AccessPolicy{
		AllowAllUsers: allowAll,
		AdminUserIDs:  admins,
		Whitelist:     w.List(),
	}
}
