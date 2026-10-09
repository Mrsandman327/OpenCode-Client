// ext.go —— OpenCode v2 扩展能力端点
//
// 这里集中承载 v1 没有、v2 新增的一批端点。与 api.go 分开是因为两者性质不同：
// api.go 处理的是 v1→v2 的契约翻译，本文件处理的是「v2 才有」的能力。
//
// 全部端点契约均已对本机 opencode v2.0.15 实际探测确认，非照文档推断。
// 探测中确认的若干反直觉之处已在各处注明，勿凭直觉简化：
//
//  1. /api/session/{id}/view 的 body 里 idle **必填**，缺了返回
//     400 {"kind":"Payload","message":"Missing key [\"idle\"]"}。
//     它不是装饰字段，而是服务端判定「viewer 已观察到这次 idle 转换」的凭据。
//  2. 会话移动的 directory 目标是**项目目录**，不是目录树里的子路径。
package opencode

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"oc-manager/internal/jsonutil"
	"oc-manager/model"
)

// sessionScoped 取出 base + 口令，会话未启动时返回零值与错误。
func sessionScoped() (string, string, model.APIResult) {
	sess := getWebSession()
	if sess == nil {
		return "", "", model.APIResult{Error: "opencode 服务未启动"}
	}
	base, err := getWebSessionBase()
	if err != nil {
		return "", "", model.APIResult{Error: err.Error()}
	}
	return base, sess.password, model.APIResult{}
}

// ── 会话移动 ─────────────────────────────────────────────────────────────

// MoveSession 把会话移到另一个项目目录。
// delivery 决定目标目录已有待处理输入时新指令的投递方式：
// "steer" 插队、"queue" 排队；空字符串表示不指定（由服务端沿用默认）。
func MoveSession(sessionID, directory, delivery string) model.APIResult {
	if strings.TrimSpace(sessionID) == "" {
		return model.APIResult{Error: "缺少会话 ID"}
	}
	if strings.TrimSpace(directory) == "" {
		return model.APIResult{Error: "缺少目标目录"}
	}
	base, password, fail := sessionScoped()
	if fail.Error != "" {
		return fail
	}

	payload := map[string]any{"directory": directory}
	if delivery == "steer" || delivery == "queue" {
		payload["delivery"] = delivery
	}
	body, _ := json.Marshal(payload)
	return apiPost(base+"/api/session/"+url.QueryEscape(sessionID)+"/move", password, body)
}

// ── 标记已读 ─────────────────────────────────────────────────────────────

// MarkSessionViewed 标记「idle 转换已被客户端观察到」。
// idle 必须取会话当前的 Session.Info.time.idle 原值——它是服务端的对账凭据，
// 填 0 或当前时间戳都不对。返回值变化会触发 service 端的 session.viewed 事件。
func MarkSessionViewed(sessionID string, idle int64) model.APIResult {
	if strings.TrimSpace(sessionID) == "" {
		return model.APIResult{Error: "缺少会话 ID"}
	}
	if idle <= 0 {
		return model.APIResult{Error: "idle 必须为会话 time.idle 的原值，不能为 0"}
	}
	base, password, fail := sessionScoped()
	if fail.Error != "" {
		return fail
	}
	body, _ := json.Marshal(map[string]any{"idle": idle})
	return apiPost(base+"/api/session/"+url.QueryEscape(sessionID)+"/view", password, body)
}

// ── 导出 / 导入 ──────────────────────────────────────────────────────────

// ExportSession 导出会话（信息 + 全部消息），返回原始 JSON 字符串。
// sanitize 为 true 时服务端会抹掉可识别信息后再导出。
//
// 端点位于 /api/experimental 下，服务端自己标注为实验性，路径将来可能变。
func ExportSession(sessionID string, sanitize bool) string {
	if strings.TrimSpace(sessionID) == "" {
		return failureJSON("缺少会话 ID")
	}
	base, password, fail := sessionScoped()
	if fail.Error != "" {
		return failureJSON(fail.Error)
	}
	target := base + "/api/experimental/session/" + url.QueryEscape(sessionID) + "/export"
	if sanitize {
		target += "?sanitize=true"
	}
	raw, err := apiGet(target, password)
	if err != nil {
		return failureJSON(err.Error())
	}
	// 原样透出：导出内容要能被 import 原样吃回去，任何再包装都会破坏往返
	return string(raw)
}

// ImportSession 从导出的 JSON 导入会话，返回新会话对象。
//
// 两条必须遵守的约束（服务端会以 409 Conflict 拒绝）：
//  1. 若导出数据里的 info 带 parentID，父会话必须已存在于目标服务——
//     所以批量导入必须先导父再导子。
//  2. location 走请求体，不接受查询参数。
func ImportSession(exportJSON string) model.APIResult {
	trimmed := strings.TrimSpace(exportJSON)
	if trimmed == "" {
		return model.APIResult{Error: "导入内容为空"}
	}
	// 解信封：导出接口返回的是 {location, data:{info,messages}}（Location 信封，与
	// 其它带 location 的端点一致；前端导出时也是按 parsed.data.info 取标题的），
	// 而导入端点要的负载是 SessionTransfer.Data = {info, messages}（见 v2 源码
	// packages/schema/src/session-transfer.ts，CLI 也是先解码 Data 再补 location 提交）。
	// 因此先解一层：有 data 用 data，否则用顶层（兼容手工整理或旧版导出的文件）。
	payloadRaw := json.RawMessage(trimmed)
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal([]byte(trimmed), &envelope); err == nil && len(envelope.Data) > 0 {
		payloadRaw = envelope.Data
	}
	// 再本地校验结构，避免把明显不是导出数据的东西发给服务端
	var probe struct {
		Info     *map[string]any   `json:"info"`
		Messages *[]map[string]any `json:"messages"`
	}
	if err := json.Unmarshal(payloadRaw, &probe); err != nil {
		return model.APIResult{Error: "导入内容不是合法 JSON: " + err.Error()}
	}
	if probe.Info == nil || probe.Messages == nil {
		return model.APIResult{Error: "导入内容缺少 info 或 messages 字段，不是会话导出格式"}
	}
	if parent := jsonutil.String((*probe.Info)["parentID"]); parent != "" {
		return model.APIResult{Error: fmt.Sprintf(
			"该会话是子会话（parentID=%s），需先导入父会话，否则服务端返回 409", parent)}
	}

	base, password, fail := sessionScoped()
	if fail.Error != "" {
		return fail
	}
	var payload map[string]any
	if err := json.Unmarshal(payloadRaw, &payload); err != nil {
		return model.APIResult{Error: "解析导入内容失败: " + err.Error()}
	}
	body, _ := json.Marshal(payload)
	res := apiPost(base+"/api/experimental/session/import", password, body)
	// 409 = 该会话 ID 已存在。这是 v2 的既定语义：导入会用 info.id 原样建会话
	// （server/src/handlers/session.ts 的 session.import → ImportConflictError），
	// 所以同一服务里重复导入同一条会话必然冲突（官方 CLI 亦如此）。
	// 这里换成可操作的说明，而不是把英文原始错误丢给用户。
	if res.Status == http.StatusConflict || strings.Contains(res.Error, "already exists") {
		return model.APIResult{Status: res.Status, Error: "该会话已存在（ID 冲突）：导入会沿用导出文件里的会话 ID。" +
			"若要恢复这条会话，请先删除原会话；若只是想要一份副本，请改在另一个项目目录/另一台机器导入。"}
	}
	return res
}

// ── 小工具 ───────────────────────────────────────────────────────────────

// failureJSON 统一的失败响应，保证前端拿到的永远是可解析的 JSON。
func failureJSON(msg string) string {
	out, _ := json.Marshal(map[string]any{"error": msg})
	return string(out)
}
