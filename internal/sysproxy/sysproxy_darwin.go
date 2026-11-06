//go:build darwin

package sysproxy

import (
	"net/url"
	"os/exec"
	"strings"
)

// DetectSystemProxyURL 探测 macOS 的系统代理设置。
//
// 背景：Go 的 http.ProxyFromEnvironment 只读取 HTTP_PROXY / HTTPS_PROXY 环境变量，
// 不读 macOS「系统设置 → 网络 → 代理」里的配置，因此这里补一个平台实现。
//
// 实现方式：调用 `scutil --proxy` 读取系统代理字典，格式类似：
//
//	<dictionary> {
//	  HTTPEnable : 1
//	  HTTPPort : 7890
//	  HTTPProxy : 127.0.0.1
//	  HTTPSEnable : 1
//	  HTTPSPort : 7890
//	  HTTPSProxy : 127.0.0.1
//	}
//
// 优先使用 HTTPS 段（访问 https 更常见），其次 HTTP 段。
// 命中后做一次 250ms 的 TCP 连通性探测，避免代理软件已退出但系统设置残留。
// 全部通过才返回代理 URL；否则返回 nil，保持调用方原有行为。
func DetectSystemProxyURL() *url.URL {
	out, err := exec.Command("scutil", "--proxy").Output()
	if err != nil {
		// scutil 不可用或执行失败：静默跳过，不影响直连
		return nil
	}
	values := parseScutilProxy(string(out))
	if u := proxyFromScutil(values, "HTTPS"); u != nil {
		return u
	}
	return proxyFromScutil(values, "HTTP")
}

// parseScutilProxy 把 `scutil --proxy` 的 "Key : Value" 行解析成 map。
//
// 只保留标量行；数组/字典块的嵌套内容（以 "<" 开头）不参与代理选择。
// 例如 ExceptionsList 的值是 "<array> {"，这种行会被跳过。
func parseScutilProxy(s string) map[string]string {
	result := make(map[string]string)
	for _, line := range strings.Split(s, "\n") {
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.TrimSpace(val)
		if key == "" || val == "" || strings.HasPrefix(val, "<") {
			continue
		}
		result[key] = val
	}
	return result
}

// proxyFromScutil 按协议前缀（"HTTPS" 或 "HTTP"）读取 enable/host/port，
// 校验端口连通性后组装成 http://host:port 形式的代理 URL。
//
// macOS 的 HTTP/HTTPS 代理都使用 HTTP CONNECT 隧道，因此统一按 http:// 处理。
func proxyFromScutil(values map[string]string, prefix string) *url.URL {
	if values[prefix+"Enable"] != "1" {
		return nil
	}
	host := strings.TrimSpace(values[prefix+"Proxy"])
	port := strings.TrimSpace(values[prefix+"Port"])
	if host == "" || port == "" || port == "0" {
		return nil
	}
	hostPort := host + ":" + port
	if !tcpDialable(hostPort) {
		return nil
	}
	u, err := url.Parse("http://" + hostPort)
	if err != nil {
		return nil
	}
	return u
}
