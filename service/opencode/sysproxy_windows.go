//go:build windows

package opencode

import (
	"net/url"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// detectSystemProxyURL 探测 Windows 系统代理（Internet 选项 → 注册表）。
//
// 背景：Go 的 http.ProxyFromEnvironment 只读取 HTTP_PROXY/HTTPS_PROXY 环境变量，
// 不读 Windows 的「系统代理」设置；而 Clash 等代理软件通常使用系统代理模式。
// 本函数让下载功能在「应用内未显式启用代理」时自动复用系统代理：
//  1. 读注册表 HKCU\...\Internet Settings 的 ProxyEnable / ProxyServer；
//  2. 解析出 host:port 后做一次 TCP 连通性探测（250ms 超时），
//     防止代理软件已退出但系统设置残留的情况；
//  3. 全部通过才返回代理 URL；否则返回 nil（下载保持原行为）。
func detectSystemProxyURL() *url.URL {
	k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Internet Settings`, registry.QUERY_VALUE)
	if err != nil {
		return nil
	}
	defer k.Close()

	enabled, _, err := k.GetIntegerValue("ProxyEnable")
	if err != nil || enabled == 0 {
		return nil
	}
	server, _, err := k.GetStringValue("ProxyServer")
	if err != nil {
		return nil
	}
	hostPort := pickProxyHostPort(server)
	if hostPort == "" || !tcpDialable(hostPort) {
		return nil
	}
	u, err := url.Parse("http://" + hostPort)
	if err != nil {
		return nil
	}
	return u
}

// pickProxyHostPort 从系统代理串中取出 host:port。
// 支持两种常见格式：
//   - "127.0.0.1:7897"（单地址）；
//   - "http=127.0.0.1:7897;https=127.0.0.1:7897"（按协议分段，优先取 https，其次 http）。
func pickProxyHostPort(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "=") {
		return s
	}
	fallback := ""
	for _, part := range strings.Split(s, ";") {
		part = strings.TrimSpace(part)
		lower := strings.ToLower(part)
		switch {
		case strings.HasPrefix(lower, "https="):
			return part[len("https="):] // 下载走 https，优先取 https 段
		case strings.HasPrefix(lower, "http="):
			fallback = part[len("http="):]
		}
	}
	return fallback
}
