// Package portable 定位并初始化「便携数据目录」。
//
// 便携模式把 opencode 的配置/数据/缓存/状态/运行时统一放在可执行文件同级的
// agentdatas/ 下。定位逻辑集中在本包：业务代码直接调用 helper，不再依赖进程级
// XDG 环境变量。这一点是刻意为之——把进程级 XDG_CONFIG_HOME 指向便携目录，
// 会让 libibus 找不到 $XDG_CONFIG_HOME/ibus/bus，从而导致 GTK / WebView 里
// 中文等输入法整体失效。
//
// 目录布局（与可执行文件同级）：
//
//	<exeDir>/agentdatas/
//	  config/    ← 配置（对齐 XDG_CONFIG_HOME）
//	  data/      ← 会话数据、凭据（XDG_DATA_HOME）
//	  cache/     ← 可再生缓存（XDG_CACHE_HOME）
//	  state/     ← 服务注册 service.json（XDG_STATE_HOME）
//	  runtime/   ← 运行时目录（XDG_RUNTIME_DIR）
//
// 生效方式：
//   - 本进程：用 ConfigHome() 等 helper 直接定位，不读、也不改环境变量；
//   - 子进程（opencode 服务、内置终端）：用 ChildEnvFrom() 显式注入 XDG 变量，
//     保证 opencode 依旧写入便携目录。
package portable

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// DataRootName 便携数据根目录名（与可执行文件同级）。
const DataRootName = "agentdatas"

// xdgSubdirs 环境变量 → agentdatas 下的子目录（供子进程注入使用）。
var xdgSubdirs = []struct {
	Env    string
	SubDir string
}{
	{"XDG_CONFIG_HOME", "config"},
	{"XDG_DATA_HOME", "data"},
	{"XDG_CACHE_HOME", "cache"},
	{"XDG_STATE_HOME", "state"},
	{"XDG_RUNTIME_DIR", "runtime"},
}

// Root 返回便携数据根目录 <exeDir>/agentdatas；无法获取可执行文件路径时返回空串。
func Root() string {
	exePath, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Join(filepath.Dir(exePath), DataRootName)
}

// subdir 返回根目录下的指定子目录；根目录不可用时返回空串。
func subdir(name string) string {
	r := Root()
	if r == "" {
		return ""
	}
	return filepath.Join(r, name)
}

// ConfigHome 返回便携配置目录 <root>/config（对齐 XDG_CONFIG_HOME）。
func ConfigHome() string { return subdir("config") }

// DataHome 返回便携数据目录 <root>/data（对齐 XDG_DATA_HOME）。
func DataHome() string { return subdir("data") }

// CacheHome 返回便携缓存目录 <root>/cache（对齐 XDG_CACHE_HOME）。
func CacheHome() string { return subdir("cache") }

// StateHome 返回便携状态目录 <root>/state（对齐 XDG_STATE_HOME）。
func StateHome() string { return subdir("state") }

// RuntimeDir 返回便携运行时目录 <root>/runtime（对齐 XDG_RUNTIME_DIR）。
func RuntimeDir() string { return subdir("runtime") }

// Init 创建便携数据目录。
//
// 注意：本函数刻意不修改任何进程级环境变量。真实用户目录（~/.config 等）
// 必须留给 GUI 工具链（GTK/ibus/dconf），否则 libibus 会因
// $XDG_CONFIG_HOME/ibus/bus 找不到而无法输入中文。
func Init() error {
	r := Root()
	if r == "" {
		return fmt.Errorf("获取可执行文件路径失败，无法确定便携数据目录")
	}
	for _, item := range xdgSubdirs {
		if err := os.MkdirAll(filepath.Join(r, item.SubDir), 0o700); err != nil {
			return fmt.Errorf("创建便携目录 %s 失败: %w", item.SubDir, err)
		}
	}
	return nil
}

// ChildEnv 返回注入子进程的 XDG 键值对，使 opencode 等服务继续使用便携目录。
// 根目录不可用时返回 nil。
func ChildEnv() []string {
	r := Root()
	if r == "" {
		return nil
	}
	env := make([]string, 0, len(xdgSubdirs))
	for _, item := range xdgSubdirs {
		env = append(env, item.Env+"="+filepath.Join(r, item.SubDir))
	}
	return env
}

// ChildEnvFrom 在 base 环境之上施加便携 XDG，返回可直接赋给 cmd.Env 的完整环境。
//
// 与「append(base, ChildEnv()...)」的关键区别：本函数会先**剔除 base 中同名的
// XDG 键**，保证每个键只出现一次。
//
// 为什么必须去重：环境变量是 KEY=VALUE 的数组，同名键重复时生效规则不可靠——
// Linux 的 getenv 顺序扫描取**第一个**（若系统值排在前面，便携注入就被忽略），
// Windows 的 CreateProcess 对重复键属未定义行为。一旦用户系统恰好设过
// XDG_CONFIG_HOME，直接 append 就会出现这种隐患。本函数等价于 os.Setenv 的
// 「覆盖」语义，只是作用范围被限制在这一个子进程——正是便携改造想要的效果。
//
// 注意：**所有需要便携语义的子进程**（opencode 服务、内置终端等）都应使用本
// 函数构造 cmd.Env，不要自行 append(os.Environ(), ChildEnv()...)。
func ChildEnvFrom(base []string) []string {
	env := ChildEnv()
	if len(env) == 0 {
		return base
	}
	drop := make(map[string]struct{}, len(xdgSubdirs))
	for _, item := range xdgSubdirs {
		drop[item.Env] = struct{}{}
	}
	out := make([]string, 0, len(base)+len(env))
	for _, kv := range base {
		key := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			key = kv[:i]
		}
		if _, skip := drop[key]; skip {
			continue
		}
		out = append(out, kv)
	}
	return append(out, env...)
}
