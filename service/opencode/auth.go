// Package service 处理 OpenCode serve 进程管理、API 代理、SSE 事件流、会话 CRUD、项目树构建和终端启动。
package opencode

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// ============================================================================
// OpenCode v2 服务认证
//
// v1 的 `opencode serve` 无认证；v2 起默认开启 HTTP Basic 认证，启动时在 stdout
// 打印一行 `server password <token>`，且所有 /api/* 端点（含 SSE）都要求
// `Authorization: Basic base64("opencode:" + password)`。缺少该头会得到 401。
//
// 密码有两个来源：
//  1. 本进程启动的服务：从 stdout 解析（见 process.go 的 startPasswordRe）。
//  2. 外部启动 / 主动发现的服务：读取 V2 的服务注册文件 service.json。
// ============================================================================

// serverPasswordUser 是 v2 Basic 认证固定用户名。
const serverPasswordUser = "opencode"

// startPasswordRe 匹配 v2 serve 启动时打印的密码行：
//
//	server listening on http://127.0.0.1:41999
//	server password xWV63BgTpM11QtDql1YXVN33MU5XVM_l3iNEafmL-Q0
var startPasswordRe = regexp.MustCompile(`server password\s+(\S+)`)

// serviceInfo 对应 V2 服务注册文件（~/.local/state/opencode/service.json）的结构。
// 字段均为可选，仅取本项目需要的 url / pid / password。
type serviceInfo struct {
	ID       string `json:"id"`
	Version  string `json:"version"`
	URL      string `json:"url"`
	PID      int    `json:"pid"`
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
// 仅在「连接外部已启动的 opencode 服务」时需要——那种服务的口令只出现在
// 它自己的 stdout 里，OC Manager 既没 spawn 它、注册表里也可能没有。
// 本进程 spawn 的服务不需要它（口令从 stdout 直接解析）。
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

// discoverServerPassword 为外部启动 / 主动发现的服务寻找访问密码：
// 先看用户是否手工提供过口令，再回落到 V2 的服务注册文件。
func discoverServerPassword(hostname string, port int) string {
	if pwd := configuredPassword(); pwd != "" {
		return pwd
	}
	info := readServiceRegistration()
	if info == nil || info.Password == "" {
		return ""
	}
	if !serviceInfoMatches(info, hostname, port) {
		return ""
	}
	return info.Password
}

// serviceInfoMatches 判断注册文件描述的服务是否就是 hostname:port 这个地址。
func serviceInfoMatches(info *serviceInfo, hostname string, port int) bool {
	if info == nil || info.URL == "" {
		return false
	}
	url := info.URL
	for _, prefix := range []string{"http://", "https://"} {
		url = strings.TrimPrefix(url, prefix)
	}
	url = strings.TrimSuffix(url, "/")
	host, portStr, ok := strings.Cut(url, ":")
	if !ok {
		return false
	}
	// 主机名比较不区分大小写（Windows 下 127.0.0.1 / localhost 可能混用）
	return strings.EqualFold(host, hostname) && portStr == strconv.Itoa(port)
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
type serviceConfig struct {
	Hostname string            `json:"hostname"`
	Port     int               `json:"port"`
	Password string            `json:"password"`
	Cors     []string          `json:"cors"`
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
