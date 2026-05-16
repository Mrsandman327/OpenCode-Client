// Package service 处理 OpenCode serve 进程管理、API 代理、SSE 事件流、会话 CRUD、项目树构建和终端启动。
package service

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"oc-manager/model"
)

var (
	eventMu   sync.Mutex
	eventStop context.CancelFunc
	browserSSEMu      sync.Mutex
	browserSSENextID  int
	browserSSEClients = map[int]chan BrowserSSEEvent{}
)

type BrowserSSEEvent struct {
	Name string
	Data string
}

// StartOpenCodeEvents 连接 opencode 全局 SSE，并通过 Wails 事件转发给前端。
func StartOpenCodeEvents(ctx context.Context) model.APIResult {
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
			wruntime.EventsEmit(ctx, "oc-event-error", err.Error())
			return
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			wruntime.EventsEmit(ctx, "oc-event-error", err.Error())
			broadcastBrowserSSE("oc-event-error", err.Error())
			return
		}
		defer resp.Body.Close()

		scanner := bufio.NewScanner(resp.Body)
		buf := make([]byte, 0, 64*1024)
		scanner.Buffer(buf, 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "data:") {
				payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
				wruntime.EventsEmit(ctx, "oc-event", payload)
				broadcastBrowserSSE("oc-event", payload)
			}
		}
		if err := scanner.Err(); err != nil && sseCtx.Err() == nil {
			wruntime.EventsEmit(ctx, "oc-event-error", err.Error())
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
	ch := make(chan BrowserSSEEvent, 32)
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
			close(ch)
			delete(browserSSEClients, id)
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
