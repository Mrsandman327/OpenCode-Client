// Package sysproxy 解析系统级代理设置，供网络请求（下载更新、版本检查等）复用。
//
// 背景：Go 的 http.ProxyFromEnvironment 只读 HTTP_PROXY/HTTPS_PROXY 环境变量，
// 不读操作系统的「系统代理」设置；而 Clash 等代理软件通常使用系统代理模式。
// 本包提供统一入口：
//   - DetectSystemProxyURL 探测系统代理（带 TCP 连通性预检）；
//   - ProxyFunc 组装「环境变量 > 系统代理 > 直连」的最终代理函数。
package sysproxy

import (
	"net"
	"net/http"
	"net/url"
	"time"
)

// tcpDialable 对 host:port 做一次快速 TCP 连通性探测（250ms 超时）。
// 用于系统代理自动探测：确认代理端口真的有服务监听，
// 避免「代理软件已退出但系统设置残留」导致请求失败。
// 本函数为跨平台公共实现，被各平台的 DetectSystemProxyURL 调用。
func tcpDialable(hostPort string) bool {
	conn, err := net.DialTimeout("tcp", hostPort, 250*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// ProxyFunc 返回按「环境变量 > 系统代理 > 直连」顺序解析的代理函数。
// 未探测到系统代理时等价于 http.ProxyFromEnvironment（仅环境变量）。
func ProxyFunc() func(*http.Request) (*url.URL, error) {
	envProxy := http.ProxyFromEnvironment
	sysProxy := DetectSystemProxyURL()
	if sysProxy == nil {
		return envProxy
	}
	return func(req *http.Request) (*url.URL, error) {
		if u, err := envProxy(req); u != nil || err != nil {
			return u, err
		}
		return sysProxy, nil
	}
}
