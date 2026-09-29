// app_ext.go —— App 上与 v2 扩展能力相关的方法
//
// 与 app.go 分开放：app.go 已经很宽，而这里是一组内聚的新增能力
// （会话移动/已读/上下文/导入导出/集成凭据/工作树/分支/终端），
// 单独成文件便于日后整体下线。
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

// GetSessionContext 取回活跃上下文（上次压缩之后的全部消息摘要）。
// 注意：这不是 token 占用，token/cost 已在会话对象的 tokens/cost 字段上。
func (a *App) GetSessionContext(sessionID string) string {
	return opencode.GetSessionContext(sessionID)
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

// ── 集成与凭据 ───────────────────────────────────────────────────────────

// ListIntegrations 列出已配置凭据的集成。
// includeEmpty 为 true 时返回全部集成（v2 约两百个条目，多数无凭据）。
func (a *App) ListIntegrations(directory string, includeEmpty bool) string {
	return opencode.ListIntegrations(directory, includeEmpty)
}

// ActivateCredential 切换当前生效的凭据。
func (a *App) ActivateCredential(credentialID string) model.APIResult {
	return opencode.ActivateCredential(credentialID)
}

// RenameCredential 修改凭据显示名（v2 只能改 label，改不了凭据内容）。
func (a *App) RenameCredential(credentialID, label string) model.APIResult {
	return opencode.RenameCredential(credentialID, label)
}

// AddCredential 给集成新增一把 API key（v2 的 connect/key）。
// 新增的那把会直接成为当前生效的凭据，调用方需重新拉列表。
func (a *App) AddCredential(integrationID, key, label string) model.APIResult {
	return opencode.AddCredential(integrationID, key, label)
}

// DeleteCredential 删除一把凭据（仅 credential 型，env 型不在凭据库里）。
func (a *App) DeleteCredential(credentialID string) model.APIResult {
	return opencode.DeleteCredential(credentialID)
}

// ── 工作树 / 分支 / 终端 ────────────────────────────────────────────────

// ListWorktrees 列出项目的工作树（端点以 projectID 定位，返回裸数组）。
func (a *App) ListWorktrees(projectID string) string {
	return opencode.ListWorktrees(projectID)
}

// ListBranches 列出本地与远端分支名（v2 返回扁平字符串数组）。
func (a *App) ListBranches(directory, search string, limit int) string {
	return opencode.ListBranches(directory, search, limit)
}

// ListPtys 列出持久终端。
func (a *App) ListPtys(directory string) string {
	return opencode.ListPtys(directory)
}
