//go:build feishu

// opencode_remote.go —— 远程管理能力的真实实现
//
// 与 opencode_real.go 分开：这个文件只放「远程管理」类端点
// （导出/服务端信息/回滚），让核心的会话与权限调用保持易读。
//
// ⚠️ 契约取自本机 v2.0.15 /openapi.json 与真机实测。三处非显然的地方：
//  1. **导出走 /api/experimental/ 前缀**，不是 /api/session/。
//  2. **回滚的暂存与提交是两个端点**（revert/stage 与 revert/commit），
//     不是一次调用带布尔开关。
//  3. **消息用 type 字段表示角色**（"assistant"/"user"），**不是 role**。
//     且**只有 time.completed 存在的消息才是可回滚点**——未完成的回复
//     之后的内容还没定，回滚到它前面等于回滚到半个状态。
package feishu

import (
	"encoding/json"
	"fmt"
	"net/url"
	"time"
)

// ExportSession 导出会话为 JSON 原文。
//
// ⚠️ 端点在 /api/experimental/ 下（实测），不是 /api/session/。
func (r *RealOpenCode) ExportSession(sessionID string) (string, error) {
	if sessionID == "" {
		return "", fmt.Errorf("缺少会话 ID")
	}
	raw, err := call("GET", "/api/experimental/session/"+url.PathEscape(sessionID)+"/export", "")
	if err != nil {
		return "", err
	}
	// 剥掉 {data:{info,messages}} 包裹，只回内层会话数据
	var data struct {
		Info     json.RawMessage `json:"info"`
		Messages json.RawMessage `json:"messages"`
	}
	if err := unwrapData(raw, &data); err != nil {
		return "", fmt.Errorf("解析导出数据失败: %w", err)
	}
	// 重新组装为 {"info":...,"messages":...} 交给调用方，
	// 形状与 V2 的 SessionTransfer.Data 一致
	out := map[string]any{"info": data.Info, "messages": data.Messages}
	b, err := json.Marshal(out)
	if err != nil {
		return "", fmt.Errorf("重组导出数据失败: %w", err)
	}
	return string(b), nil
}

// ServerInfo 取服务端信息。
//
// GET /api/info 实测返回 {version, pid, urls:[...], paths:{...}}。
// 地址取 urls[0]——本机服务只监听回环，通常只有一个。
func (r *RealOpenCode) ServerInfo() (ServerInfo, error) {
	raw, err := call("GET", "/api/info", "")
	if err != nil {
		return ServerInfo{}, err
	}
	// /api/info **不**用 {data:...} 包裹，与本文件其它端点不同
	var out struct {
		Version string   `json:"version"`
		PID     int      `json:"pid"`
		URLs    []string `json:"urls"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return ServerInfo{}, fmt.Errorf("解析服务端信息失败: %w", err)
	}
	info := ServerInfo{Version: out.Version, PID: out.PID}
	if len(out.URLs) > 0 {
		info.Address = out.URLs[0]
	}
	return info, nil
}

// messageSummary 是一个消息的概要。
type messageSummary struct {
	ID string `json:"id"`
	// ⚠️ V2 用 **type** 表示角色（"assistant"/"user"），**不是 role**。
	Type string `json:"type"`
	Time struct {
		Created   int64 `json:"created"`
		Streamed  int64 `json:"streamed"`
		Completed int64 `json:"completed"`
	} `json:"time"`
	// content 可能是对象或数组，用 RawMessage 兜住两种形态
	Content json.RawMessage `json:"content"`
}

// ListRevertTargets 列出可回滚的位置，最新的在前。
//
// 只列**已完成**的 assistant 消息：未完成的回复之后的内容还没定，
// 回滚到它前面等于回滚到半个状态。
func (r *RealOpenCode) ListRevertTargets(sessionID string, limit int) ([]RevertTarget, error) {
	if sessionID == "" {
		return nil, fmt.Errorf("缺少会话 ID")
	}
	if limit <= 0 {
		limit = 10
	}
	raw, err := call("GET", sessPath(sessionID)+"/message", "")
	if err != nil {
		return nil, err
	}
	var list []messageSummary
	if err := unwrapData(raw, &list); err != nil {
		return nil, fmt.Errorf("解析消息列表失败: %w", err)
	}

	// 服务端按时间正序返回，倒着扫才是「最近的在前」
	var out []RevertTarget
	for i := len(list) - 1; i >= 0 && len(out) < limit; i-- {
		m := list[i]
		if m.Type != "assistant" {
			continue
		}
		if m.Time.Completed == 0 {
			continue
		}
		out = append(out, RevertTarget{
			MessageID: m.ID,
			Label:     time.UnixMilli(m.Time.Completed).Format("2006-01-02 15:04"),
		})
	}
	return out, nil
}

// StageRevert 暂存回滚。messageID 必填，files 控制是否一并回退文件改动。
func (r *RealOpenCode) StageRevert(sessionID, messageID string, revertFiles bool) error {
	if sessionID == "" {
		return fmt.Errorf("缺少会话 ID")
	}
	if messageID == "" {
		return fmt.Errorf("缺少消息 ID")
	}
	body := map[string]any{
		"messageID": messageID,
		"files":     revertFiles,
	}
	_, err := call("POST", sessPath(sessionID)+"/revert/stage", mustJSON(body))
	return err
}

// CommitRevert 提交暂存的回滚。
//
// 实测该端点**不接收 body**（spec 里 requestBody 为 null），
// 多传一个 {} 可能被严格校验拒绝，因此发空 body。
func (r *RealOpenCode) CommitRevert(sessionID string) error {
	if sessionID == "" {
		return fmt.Errorf("缺少会话 ID")
	}
	_, err := call("POST", sessPath(sessionID)+"/revert/commit", "")
	return err
}

// ClearRevert 清除暂存。用 DELETE 而非 POST。
func (r *RealOpenCode) ClearRevert(sessionID string) error {
	if sessionID == "" {
		return fmt.Errorf("缺少会话 ID")
	}
	_, err := call("DELETE", sessPath(sessionID)+"/revert", "")
	return err
}
