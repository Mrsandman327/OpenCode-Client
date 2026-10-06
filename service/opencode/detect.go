package opencode

// 运行中的 opencode 服务检测（跨平台）。
//
// 背景：OC Manager 采用"便携数据目录"(agentdatas) 后，只能发现自己环境下的
// 服务注册；而外部启动的服务（v1 的 serve、v2 的 service、或上次崩溃残留）
// 不受环境限制。所以启动服务前必须做**进程级检测**：
//
//	进程名以 opencode 开头，且命令行中出现 service（v2）或 serve（v1）子命令
//	→ 视为"已有 opencode 服务在运行"。
//
// 交互式 TUI（opencode / opencode <目录>，无 service/serve）不会命中。

import (
	"strings"
)

// serviceProcess 一条进程记录（名称 + 命令行），由各平台实现提供。
type serviceProcess struct {
	Name    string
	Cmdline string
}

// hasServiceToken 判断命令行中是否存在独立的 service / serve 子命令 token。
// 使用"按空白切分后精确比较 token"，而不是子串匹配，避免把路径/参数中的
// 片段（如 C:\my services\）误判为子命令。
func hasServiceToken(cmdline string) bool {
	for _, f := range strings.Fields(strings.ToLower(cmdline)) {
		// 去掉可能的引号包裹（如 "serve"）
		f = strings.Trim(f, `"'`)
		if f == "service" || f == "serve" {
			return true
		}
	}
	return false
}

// isOpencodeServiceProcess 判定一条进程记录是否为"opencode 服务"进程。
func isOpencodeServiceProcess(p serviceProcess) bool {
	name := strings.ToLower(strings.TrimSpace(p.Name))
	if !strings.HasPrefix(name, "opencode") {
		return false
	}
	lower := strings.ToLower(p.Cmdline)
	if hasServiceToken(lower) {
		return true
	}
	// 私有服务模式：opencode --standalone（不写共享注册文件，但同样在提供服务）
	return strings.Contains(lower, "--standalone")
}

// findRunningOpencodeService 检测是否存在运行中的 opencode 服务。
// 返回 (是否存在, 描述信息)；描述用于提示文案（优先给出命令行摘要）。
// 检测本身失败（枚举进程不可用）时返回 (false, "")，即**放行**，
// 避免因检测机制不可用导致用户永远无法启动服务。
func findRunningOpencodeService() (bool, string) {
	procs, err := listProcesses()
	if err != nil {
		return false, ""
	}
	for _, p := range procs {
		if !isOpencodeServiceProcess(p) {
			continue
		}
		desc := strings.TrimSpace(p.Name)
		if cmd := strings.TrimSpace(p.Cmdline); cmd != "" {
			if len(cmd) > 160 {
				cmd = cmd[:160] + "…"
			}
			desc = cmd
		}
		return true, desc
	}
	return false, ""
}
