//go:build linux

package sysproxy

import (
	"context"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// DetectSystemProxyURL 探测 Linux 桌面环境的系统代理配置：
//  1. GNOME（GSettings）：`org.gnome.system.proxy` 的 mode 为 'manual' 时，
//     取 http 段代理（回退 socks 段，socks5://）；
//  2. KDE：~/.config/kioslaverc 中 [Proxy Settings] 段 ProxyType=1（手动）时，
//     取 httpsProxy（回退 httpProxy）。
//
// 命中后做一次 TCP 连通性探测（250ms，确认代理端口真有服务监听），
// 通过才返回代理 URL；否则返回 nil（保持调用方原行为）。
// 环境变量（HTTP_PROXY/HTTPS_PROXY）由 http.ProxyFromEnvironment 单独处理，不在此重复。
func DetectSystemProxyURL() *url.URL {
	if u := detectGSettingsProxy(); u != nil {
		return u
	}
	return detectKDEProxy()
}

// ===== GNOME（GSettings）=====

// detectGSettingsProxy 读取 GNOME 桌面代理设置（调用 gsettings CLI）。
// 未安装 gsettings / 模式非 manual / 代理端口不通时返回 nil。
func detectGSettingsProxy() *url.URL {
	mode, err := gsettingsGet("org.gnome.system.proxy", "mode")
	if err != nil || mode != "manual" {
		return nil
	}
	// 优先 http 段；host 为空时回退 socks 段（socks5://）
	host, err := gsettingsGet("org.gnome.system.proxy.http", "host")
	if err == nil && host != "" {
		if port, err := gsettingsGet("org.gnome.system.proxy.http", "port"); err == nil {
			if u := proxyURLFrom("http", host, port); u != nil {
				return u
			}
		}
	}
	sHost, err := gsettingsGet("org.gnome.system.proxy.socks", "host")
	if err == nil && sHost != "" {
		if sPort, err := gsettingsGet("org.gnome.system.proxy.socks", "port"); err == nil {
			return proxyURLFrom("socks5", sHost, sPort)
		}
	}
	return nil
}

// gsettingsGet 调用 `gsettings get <schema> <key>` 并规范化输出：
// 去除首尾空白与 GVariant 的单引号包裹（如 'manual' → manual）。
func gsettingsGet(schema, key string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "gsettings", "get", schema, key).Output()
	if err != nil {
		return "", err
	}
	return strings.Trim(strings.TrimSpace(string(out)), "'"), nil
}

// proxyURLFrom 由 scheme/host/port 组装代理 URL；端口为空/0 或 TCP 不通时返回 nil。
func proxyURLFrom(scheme, host, port string) *url.URL {
	host = strings.TrimSpace(host)
	port = strings.TrimSpace(port)
	if host == "" || port == "" || port == "0" {
		return nil
	}
	hostPort := host + ":" + port
	if !tcpDialable(hostPort) {
		return nil
	}
	// socks5 代理 URL 是 Go http.Transport 原生支持的格式
	u, err := url.Parse(scheme + "://" + hostPort)
	if err != nil {
		return nil
	}
	return u
}

// ===== KDE（kioslaverc）=====

// detectKDEProxy 解析 KDE 代理配置 ~/.config/kioslaverc。
// 仅在 [Proxy Settings] 段 ProxyType=1（手动代理）时生效；
// 值为形如 http://127.0.0.1:7897 的完整 URL，优先 httpsProxy，其次 httpProxy。
func detectKDEProxy() *url.URL {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(home, ".config", "kioslaverc"))
	if err != nil {
		return nil // 非 KDE 环境（文件不存在）：静默跳过
	}
	proxyType, httpsProxy, httpProxy := "", "", ""
	inSection := false
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			inSection = line == "[Proxy Settings]"
			continue
		}
		if !inSection {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "ProxyType":
			proxyType = strings.TrimSpace(val)
		case "httpsProxy":
			httpsProxy = strings.TrimSpace(val)
		case "httpProxy":
			httpProxy = strings.TrimSpace(val)
		}
	}
	if proxyType != "1" {
		// KDE ProxyType 枚举：0 无代理 / 1 手动 / 2 PAC / 3 WPAD / 4 环境变量
		return nil
	}
	raw := httpsProxy
	if raw == "" {
		raw = httpProxy
	}
	return parseDialableProxyURL(raw)
}

// parseDialableProxyURL 解析形如 http://host:port 的代理串并做连通性验证。
func parseDialableProxyURL(raw string) *url.URL {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return nil
	}
	if !tcpDialable(u.Host) {
		return nil
	}
	return u
}
