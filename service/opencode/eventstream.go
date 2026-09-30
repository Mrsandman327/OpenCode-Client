// eventstream.go —— OpenCode 全局事件流（/api/event）的可复用连接
//
// 从 sse.go 抽出「建连 + 逐行读」这一段，让 sse.go（转给前端）与
// 飞书通道（自己消费）走**同一条**连接代码路径。
//
// 为什么不各自实现：这段逻辑里有三处非显然的判据，任何一处写错都
// 表现为「连上了但收不到事件」且不报错——
//  1. v2 需要 Basic 认证（v1 ��� /global/event 且不需要）；
//  2. 认证失败或路径不存在时 v2 回落到 SPA 首页，返回 200 + HTML，
//     此时**没有任何 data: 行**，不显式判别就会一直空等；
//  3. 必须用没有 Timeout 的 client（普通 API 用的 apiClient 有 60s
//     超时，用它会把长连接周期性切断）。
package opencode

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// sseScanBufferInit / sseScanBufferMax 决定单行 SSE 数据的容量上限。
//
// 单条 data: 行可能携带整文件内容或超长工具结果，默认 64KB 会
// 频繁触发 token too long，表现为「事件流莫名其妙断掉」。
const (
	sseScanBufferInit = 64 * 1024
	sseScanBufferMax  = 100 * 1024 * 1024
)

// errEventStreamHTML 表示服务端返回的是网页而不是事件流。
type errEventStreamHTML struct{}

func (errEventStreamHTML) Error() string {
	return "事件流连接失败：OpenCode v2 未提供 /api/event 端点（返回了网页内容）"
}

// dialEventStream 打开 /api/event 并返回响应体。
//
// 调用方负责 Close。ctx 结束会中断正在进行的读。
func dialEventStream(ctx context.Context) (io.ReadCloser, error) {
	sess := getWebSession()
	if sess == nil {
		return nil, fmt.Errorf("opencode 服务未启动")
	}
	url := fmt.Sprintf("http://%s:%d/api/event", sess.hostname, sess.port)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	applyAuth(req, sess.password)

	// 刻意用 http.DefaultClient（无 Timeout）：长连接必须能一直挂着。
	// 绝不能换成 apiClient——它有 60s 超时，会把事件流周期性切断。
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("事件流连接失败: HTTP %d", resp.StatusCode)
	}
	if isHTMLResponse(resp.Header.Get("Content-Type")) {
		resp.Body.Close()
		return nil, errEventStreamHTML{}
	}
	return resp.Body, nil
}

// pumpEventStream 逐行读出 data: 载荷并回调。
//
// body 已由 dialEventStream 建立；本函数只负责读到流结束。
// onLine 收到的是**已去前缀、去空白**的 data 内容。
func pumpEventStream(body io.Reader, onLine func(payload string)) error {
	scanner := bufio.NewScanner(body)
	buf := make([]byte, 0, sseScanBufferInit)
	scanner.Buffer(buf, sseScanBufferMax)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data:") {
			onLine(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	return scanner.Err()
}

// SubscribeOpenCodeEvents 连上全局事件流并把每条 data 载荷交给 onPayload。
//
// 这是**长连接**：函数会一直阻塞到 ctx 结束或服务端断开。
func SubscribeOpenCodeEvents(ctx context.Context, onPayload func(payload string)) error {
	body, err := dialEventStream(ctx)
	if err != nil {
		return err
	}
	defer body.Close()
	return pumpEventStream(body, onPayload)
}
