package main

// 便携数据目录：把 opencode 的配置/数据/缓存/状态统一放到程序目录下，
// 通过设置 XDG 环境变量实现。
//
// 目录布局（与可执行文件同级）：
//
//	<exeDir>/agentdatas/
//	  config/opencode/   ← XDG_CONFIG_HOME（配置）
//	  data/opencode/     ← XDG_DATA_HOME（会话数据、凭据）
//	  cache/opencode/    ← XDG_CACHE_HOME（缓存，可再生）
//	  state/opencode/    ← XDG_STATE_HOME（服务注册 service.json）
//	  runtime/           ← XDG_RUNTIME_DIR（Linux 运行时目录）
//
// 生效范围：仅本进程的环境块，及其启动的子进程（opencode 服务、内置终端）；
// 不影响系统环境、已在运行的其他程序、用户自己开的终端。

import (
	"os"
	"path/filepath"

	"oc-manager/internal/logger"
)

// portableDataRootName 便携数据根目录名（与可执行文件同级）。
const portableDataRootName = "agentdatas"

// portableXdgDirs 环境变量 → agentdatas 下的子目录。
var portableXdgDirs = []struct {
	Env    string
	SubDir string
}{
	{"XDG_CONFIG_HOME", "config"},
	{"XDG_DATA_HOME", "data"},
	{"XDG_CACHE_HOME", "cache"},
	{"XDG_STATE_HOME", "state"},
	{"XDG_RUNTIME_DIR", "runtime"},
}

// setupPortableXDG 在程序启动最早期把 5 个 XDG 环境变量指向程序目录下的
// agentdatas/<子目录>（强制覆盖，即"便携模式"）。
//
// 设计取舍：
//   - 强制覆盖：便携模式必须稳定，不受系统已有 XDG 影响（用户已确认无逃生阀）；
//   - 失败不阻断启动：创建目录/设置变量失败只记录日志，后续按默认环境继续；
//   - 检测"已有服务/目录"的读取仍在各自的业务逻辑中显式进行，不依赖本函数。
func setupPortableXDG() {
	exePath, err := os.Executable()
	if err != nil {
		logger.Printf("[portable] 获取可执行文件路径失败，跳过便携数据目录设置: %v", err)
		return
	}
	base := filepath.Join(filepath.Dir(exePath), portableDataRootName)
	for _, item := range portableXdgDirs {
		dir := filepath.Join(base, item.SubDir)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			logger.Printf("[portable] 创建目录失败 %s: %v", dir, err)
			continue
		}
		if err := os.Setenv(item.Env, dir); err != nil {
			logger.Printf("[portable] 设置环境变量失败 %s=%s: %v", item.Env, dir, err)
			continue
		}
	}
	logger.Printf("[portable] 便携数据目录已启用: %s", base)
}
