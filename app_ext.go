// app_ext.go —— App 上与 v2 扩展能力相关的方法
//
// 与 app.go 分开放：app.go 已经很宽，而这里是一组内聚的新增能力
// （会话移动/已读/导入导出），单独成文件便于日后整体下线。
package main

import (
	"oc-manager/model"
	"oc-manager/service/opencode"
)

// ── 会话 ─────────────────────────────────────────────────────────────────

// MoveSession 把会话移动到另一个项目目录。
// delivery 取值 "steer"（插队）或 "queue"（排队），空串表示服务端默认。
func (a *App) MoveSession(sessionID, directory, delivery string) model.APIResult {
	return opencode.MoveSession(sessionID, directory, delivery)
}

// MarkSessionViewed 标记该会话的 idle 转换已被客户端观察到。
// idle 必须是会话 time.idle 的原值。
func (a *App) MarkSessionViewed(sessionID string, idle int64) model.APIResult {
	return opencode.MarkSessionViewed(sessionID, idle)
}

// ── 导入导出 ─────────────────────────────────────────────────────────────

// ExportSession 导出会话为 JSON 字符串。
func (a *App) ExportSession(sessionID string, sanitize bool) string {
	return opencode.ExportSession(sessionID, sanitize)
}

// ImportSession 从导出的 JSON 导入会话。
func (a *App) ImportSession(exportJSON string) model.APIResult {
	return opencode.ImportSession(exportJSON)
}
