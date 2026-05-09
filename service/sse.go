// Package service 处理 OpenCode serve 进程管理、API 代理、SSE 事件流、会话 CRUD、项目树构建和终端启动。
package service

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"oc-manager/model"
)

type EventEmitter func(event string, data ...interface{})

var (
	eventMu   sync.Mutex
	eventStop context.CancelFunc
)

// StartOpenCodeEvents 连接 opencode 全局 SSE，并通过 Wails 事件转发给前端。
func StartOpenCodeEvents(emit EventEmitter) model.APIResult {
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
			emit("oc-event-error", err.Error())
			return
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			emit("oc-event-error", err.Error())
			return
		}
		defer resp.Body.Close()

		scanner := bufio.NewScanner(resp.Body)
		buf := make([]byte, 0, 64*1024)
		scanner.Buffer(buf, 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "data:") {
				emit("oc-event", strings.TrimSpace(strings.TrimPrefix(line, "data:")))
			}
		}
		if err := scanner.Err(); err != nil && sseCtx.Err() == nil {
			emit("oc-event-error", err.Error())
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
