package opencode

import (
	"net"
	"time"
)

// tcpDialable 对 host:port 做一次快速 TCP 连通性探测（250ms 超时）。
// 用于系统代理自动探测：确认代理端口真的有服务监听，
// 避免「代理软件已退出但系统设置残留」导致下载失败。
// 本函数为跨平台公共实现，被各平台的 detectSystemProxyURL 调用。
func tcpDialable(hostPort string) bool {
	conn, err := net.DialTimeout("tcp", hostPort, 250*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
