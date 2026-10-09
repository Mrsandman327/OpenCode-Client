// Package service 处理 OpenCode serve 进程管理、API 代理、SSE 事件流、会话 CRUD、项目树构建和终端启动。
package opencode

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ============================================================================
// OpenCode v2 服务认证
//
// v1 的 `opencode serve` 无认证；v2 起默认开启 HTTP Basic 认证，且所有 /api/*
// 端点（含 SSE）都要求 `Authorization: Basic base64("opencode:" + password)`。
// 缺少该头会得到 401。
//
// 口令有两个来源：
//  1. 服务注册文件 state/service.json：由 `opencode service start` 启动的服务
//     自行写入，是自启动服务的权威来源（见 readServiceRegistration）。
//  2. 用户手工填写：适用于外部启动 / 无注册文件的场景（见 SetServerPassword），
//     在注册文件口令不可用时作为兜底（见 process.go 的 discoverOpenCodeServer）。
// ============================================================================

// serverPasswordUser 是 v2 Basic 认证固定用户名。
const serverPasswordUser = "opencode"

// serviceInfo 对应 V2 服务注册文件（~/.local/state/opencode/service.json）的结构。
// 字段均为可选，仅取本项目需要的 url / password；其余字段（id/version/pid 等）
// 由 encoding/json 默认忽略，不影响解析。
type serviceInfo struct {
	URL      string `json:"url"`
	Password string `json:"password"`
}

// serviceRegistrationPath 返回 V2 服务注册文件路径。
// 参考 @opencode/client 的 Service.discover()：默认取 XDG state 目录下的
// opencode/service.json；XDG_STATE_HOME 未设置时按平台惯例推导。
func serviceRegistrationPath() string {
	if dir := strings.TrimSpace(os.Getenv("XDG_STATE_HOME")); dir != "" {
		return filepath.Join(dir, "opencode", "service.json")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	// Windows 与 unix 下 XDG state 目录都落在 ~/.local/state
	return filepath.Join(home, ".local", "state", "opencode", "service.json")
}

// readServiceRegistration 读取服务注册文件，文件不存在或损坏时返回 nil。
func readServiceRegistration() *serviceInfo {
	path := serviceRegistrationPath()
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var info serviceInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return nil
	}
	return &info
}

// configuredServerPassword 是用户在网络配置里手工填写的服务口令。
// 用于「外部启动 / 注册文件口令不可用」的场景：这类服务的口令只出现在
// 它自己的启动输出里，OC Manager 无法从注册文件获得，只能由用户手填。
// 由 discoverOpenCodeServer 在注册文件口令探测失败时作为兜底使用。
var (
	configuredServerPasswordMu sync.RWMutex
	configuredServerPassword   string
)

// SetServerPassword 设置用户手工提供的服务口令（传空串清除）。
func SetServerPassword(password string) {
	configuredServerPasswordMu.Lock()
	configuredServerPassword = strings.TrimSpace(password)
	configuredServerPasswordMu.Unlock()
}

// configuredPassword 读取用户手工提供的口令。
func configuredPassword() string {
	configuredServerPasswordMu.RLock()
	defer configuredServerPasswordMu.RUnlock()
	return configuredServerPassword
}

// basicAuthValue 生成 Basic 认证头值。password 为空时返回空串（表示不加认证头）。
func basicAuthValue(password string) string {
	if password == "" {
		return ""
	}
	raw := serverPasswordUser + ":" + password
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(raw))
}

// applyAuth 给请求附加 v2 Basic 认证头。
func applyAuth(req *http.Request, password string) {
	if v := basicAuthValue(password); v != "" {
		req.Header.Set("Authorization", v)
	}
}

// ============================================================================
// V2 服务配置（$XDG_CONFIG_HOME/opencode/service.json）
//
// 由 `opencode service set <key> <value>` 维护，记录共享服务的 hostname/port/
// password/cors/env。OC Manager 在启动服务前读取它，判断是否需要 set。
// ============================================================================

// serviceConfig 对应 V2 服务配置文件结构。
// 仅声明本项目读写的字段；cors 等其余配置项由 encoding/json 默认忽略。
type serviceConfig struct {
	Hostname string            `json:"hostname"`
	Port     int               `json:"port"`
	Password string            `json:"password"`
	Env      map[string]string `json:"env"`
}

// serviceConfigPath 返回 V2 服务配置文件路径（config 侧）。
// 与 @opencode/client 的 ServiceConfig 一致：XDG_CONFIG_HOME 下的 opencode/service.json。
func serviceConfigPath() string {
	if dir := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); dir != "" {
		return filepath.Join(dir, "opencode", "service.json")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "opencode", "service.json")
}

// readServiceConfig 读取服务配置文件，文件不存在或损坏时返回 nil。
func readServiceConfig() *serviceConfig {
	path := serviceConfigPath()
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var cfg serviceConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil
	}
	return &cfg
}
