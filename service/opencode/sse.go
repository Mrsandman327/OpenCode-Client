// Package service 处理 OpenCode serve 进程管理、API 代理、SSE 事件流、会话 CRUD、项目树构建和终端启动。
package opencode

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"oc-manager/model"
)

var (
	eventMu           sync.Mutex
	eventStop         context.CancelFunc
	browserSSEMu      sync.Mutex
	browserSSENextID  int
	browserSSEClients = map[int]chan BrowserSSEEvent{}
)

type BrowserSSEEvent struct {
	Name string
	Data string
}

// DesktopEmitter 抽象桌面端（Wails）的事件发射能力，避免本包直接依赖具体 GUI 框架。
// main 包在应用启动时通过 SetDesktopEmitter 注入实现（内部调用 application.App.Event.Emit）。
type DesktopEmitter interface {
	Emit(name string, data ...any)
}

// desktopEmitter 当前注入的桌面事件发射器；为 nil 时（纯 Web 模式）事件仅走浏览器通道。
var desktopEmitter DesktopEmitter

// SetDesktopEmitter 注入桌面事件发射器（由 main 包在 application.New 之后调用）。
func SetDesktopEmitter(e DesktopEmitter) {
	desktopEmitter = e
}

// emitToDesktop 向桌面端发射事件；未注入发射器时静默跳过，保证纯 Web 模式可用。
func emitToDesktop(name string, data any) {
	if desktopEmitter != nil {
		desktopEmitter.Emit(name, data)
	}
}

const (
	// browserSSEBufferSize 是每个浏览器 SSE 客户端的缓冲深度。
	// 原值 32 在消息密集时（思考/正文/工具会产生大量 part 事件）极易被填满：
	// 一旦消费端（浏览器网络）稍慢，缓冲即溢出，旧实现会静默剔除该客户端，
	// 造成前端丢事件却无从感知，残缺缓存（缺 text part）就此长期停留在界面上。
	// 提升到 256 显著降低触发概率；真正溢出时由 sse-lagged 通知 + 前端全量补齐兜底。
	browserSSEBufferSize = 256
	// sseLaggedEventName 是「客户端已滞后、事件即将丢失」的显式通知事件名。
	// 服务端在剔除慢客户端前尽力投递一条该事件，让前端明确知道自己丢过事件，
	// 从而主动触发一次 loadMessages() 全量补齐，而不是停在残缺缓存上。
	sseLaggedEventName = "sse-lagged"
)

// StartOpenCodeEvents 连接 opencode 全局 SSE，并通过桌面事件与浏览器 SSE 双通道转发给前端。
func StartOpenCodeEvents() model.APIResult {
	WebSessMu.Lock()
	sess := WebSess
	WebSessMu.Unlock()
	if sess == nil {
		return model.APIResult{Error: "opencode 服务未启动"}
	}

	eventMu.Lock()
	if eventStop != nil {
		eventStop()
	}
	sseCtx, cancel := context.WithCancel(context.Background())
	eventStop = cancel
	eventMu.Unlock()

	url := fmt.Sprintf("http://%s:%d/global/event", sess.hostname, sess.port)
	go func() {
		req, err := http.NewRequestWithContext(sseCtx, http.MethodGet, url, nil)
		if err != nil {
			emitToDesktop("oc-event-error", err.Error())
			return
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			emitToDesktop("oc-event-error", err.Error())
			broadcastBrowserSSE("oc-event-error", err.Error())
			return
		}
		defer resp.Body.Close()

		scanner := bufio.NewScanner(resp.Body)
		buf := make([]byte, 0, 64*1024)
		// 单行 SSE 数据可能携带大消息/大工具结果（如整文件内容、超长 JSON），
		// 默认 64KB 会频繁触发 token too long；上限放宽到 100MB。
		scanner.Buffer(buf, 100*1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "data:") {
				payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
				emitToDesktop("oc-event", payload)
				broadcastBrowserSSE("oc-event", payload)
			}
		}
		if err := scanner.Err(); err != nil && sseCtx.Err() == nil {
			emitToDesktop("oc-event-error", err.Error())
			broadcastBrowserSSE("oc-event-error", err.Error())
		}
	}()

	return model.APIResult{Success: true, Status: 200}
}

// StopOpenCodeEvents 停止 SSE 转发。
func StopOpenCodeEvents() model.APIResult {
	eventMu.Lock()
	if eventStop != nil {
		eventStop()
		eventStop = nil
	}
	eventMu.Unlock()
	return model.APIResult{Success: true, Status: 200}
}

func SubscribeBrowserSSE() (int, <-chan BrowserSSEEvent) {
	browserSSEMu.Lock()
	defer browserSSEMu.Unlock()
	browserSSENextID++
	id := browserSSENextID
	ch := make(chan BrowserSSEEvent, browserSSEBufferSize)
	browserSSEClients[id] = ch
	return id, ch
}

func UnsubscribeBrowserSSE(id int) {
	browserSSEMu.Lock()
	ch := browserSSEClients[id]
	delete(browserSSEClients, id)
	browserSSEMu.Unlock()
	if ch != nil {
		close(ch)
	}
}

func broadcastBrowserSSE(name, data string) {
	browserSSEMu.Lock()
	defer browserSSEMu.Unlock()
	for id, ch := range browserSSEClients {
		select {
		case ch <- BrowserSSEEvent{Name: name, Data: data}:
		default:
			// 缓冲已满：该客户端消费过慢，已滞后，即将被剔除。
			// 剔除前必须先显式通知前端（否则它会拿着残缺缓存却毫不知情）。
			// 但由于缓冲此刻是满的，通知本身也塞不进去，因此先丢弃一条最旧的积压事件
			// 腾出槽位（丢弃的增量由前端随后的全量补齐覆盖，不会造成最终数据缺失），再投递通知。
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- BrowserSSEEvent{Name: sseLaggedEventName, Data: `{"reason":"buffer overflow"}`}:
			default:
			}
			close(ch)                     // 前端读到流结束会触发 EventSource 自动重连并重新订阅
			delete(browserSSEClients, id) // 直接剔除客户端
		}
	}
}

func FormatBrowserSSE(event BrowserSSEEvent) string {
	var b strings.Builder
	b.WriteString("event: ")
	b.WriteString(event.Name)
	b.WriteString("\n")
	for _, line := range strings.Split(event.Data, "\n") {
		b.WriteString("data: ")
		b.WriteString(line)
		b.WriteString("\n")
	}
	b.WriteString("id: ")
	b.WriteString(strconv.FormatInt(int64(browserSSENextID), 10))
	b.WriteString("\n\n")
	return b.String()
}
