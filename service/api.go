// Package service 处理 OpenCode serve 进程管理、API 代理、SSE 事件流、会话 CRUD、项目树构建和终端启动。
package service

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"oc-manager/model"
)

// OpenCodeAPI 代理访问本机 opencode serve API，避免前端跨域限制。
func OpenCodeAPI(method, path, body string) model.APIResult {
	sess := getWebSession()
	if sess == nil {
		return model.APIResult{Error: "opencode 服务未启动"}
	}

	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	url := fmt.Sprintf("http://%s:%d%s", sess.hostname, sess.port, path)

	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return model.APIResult{Status: resp.StatusCode, Error: err.Error()}
	}
	return model.APIResult{Success: resp.StatusCode >= 200 && resp.StatusCode < 300, Status: resp.StatusCode, Body: string(data)}
}

// CreateSession 使用指定工作目录创建新会话（设置 x-opencode-directory 请求头）。
func CreateSession(workDir string) model.APIResult {
	sess := getWebSession()
	if sess == nil {
		return model.APIResult{Error: "opencode 服务未启动"}
	}
	workDir = strings.TrimSpace(workDir)
	if workDir == "" {
		return model.APIResult{Error: "工作目录不能为空"}
	}

	url := fmt.Sprintf("http://%s:%d/session", sess.hostname, sess.port)
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader("{}"))
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-opencode-directory", workDir)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return model.APIResult{Error: err.Error()}
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return model.APIResult{Status: resp.StatusCode, Error: err.Error()}
	}
	return model.APIResult{Success: resp.StatusCode >= 200 && resp.StatusCode < 300, Status: resp.StatusCode, Body: string(data)}
}

// AnswerQuestion 回答 question 工具调用。
// 通过 /question API 查找待回答的问题，然后调用 /question/{id}/reply 发送答案。
func AnswerQuestion(sessionID, answerLabel string) model.APIResult {
	sess := getWebSession()
	if sess == nil {
		return model.APIResult{Error: "opencode 服务未启动"}
	}

	// 1. 获取待回答的问题列表
	base := fmt.Sprintf("http://%s:%d", sess.hostname, sess.port)
	resp, err := http.Get(base + "/question")
	if err != nil {
		return model.APIResult{Error: fmt.Sprintf("获取问题列表失败: %v", err)}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	type QuestionRequest struct {
		ID        string `json:"id"`
		SessionID string `json:"sessionID"`
	}
	var questions []QuestionRequest
	if err := json.Unmarshal(body, &questions); err != nil {
		return model.APIResult{Error: fmt.Sprintf("解析问题列表失败: %v", err)}
	}

	// 2. 找到匹配 sessionID 的问题
	var requestID string
	for _, q := range questions {
		if q.SessionID == sessionID {
			requestID = q.ID
			break
		}
	}
	if requestID == "" {
		return model.APIResult{Error: "未找到该会话的待回答问题"}
	}

	// 3. 发送答案
	replyBody := fmt.Sprintf(`{"answers":[["%s"]]}`, answerLabel)
	replyResp, err := http.Post(
		fmt.Sprintf("%s/question/%s/reply", base, requestID),
		"application/json",
		strings.NewReader(replyBody),
	)
	if err != nil {
		return model.APIResult{Error: fmt.Sprintf("回答问题失败: %v", err)}
	}
	defer replyResp.Body.Close()

	replyData, _ := io.ReadAll(replyResp.Body)
	return model.APIResult{
		Success: replyResp.StatusCode >= 200 && replyResp.StatusCode < 300,
		Status:  replyResp.StatusCode,
		Body:    string(replyData),
	}
}

// RejectQuestion 忽略 question 工具调用。
func RejectQuestion(sessionID string) model.APIResult {
	sess := getWebSession()
	if sess == nil {
		return model.APIResult{Error: "opencode 服务未启动"}
	}

	base := fmt.Sprintf("http://%s:%d", sess.hostname, sess.port)
	resp, err := http.Get(base + "/question")
	if err != nil {
		return model.APIResult{Error: fmt.Sprintf("获取问题列表失败: %v", err)}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	type QuestionRequest struct {
		ID        string `json:"id"`
		SessionID string `json:"sessionID"`
	}
	var questions []QuestionRequest
	if err := json.Unmarshal(body, &questions); err != nil {
		return model.APIResult{Error: fmt.Sprintf("解析问题列表失败: %v", err)}
	}

	var requestID string
	for _, q := range questions {
		if q.SessionID == sessionID {
			requestID = q.ID
			break
		}
	}
	if requestID == "" {
		return model.APIResult{Error: "未找到该会话的待回答问题"}
	}

	req, _ := http.NewRequest(http.MethodPost,
		fmt.Sprintf("%s/question/%s/reject", base, requestID), nil)
	rejectResp, err := http.DefaultClient.Do(req)
	if err != nil {
		return model.APIResult{Error: fmt.Sprintf("忽略问题失败: %v", err)}
	}
	defer rejectResp.Body.Close()

	rejectData, _ := io.ReadAll(rejectResp.Body)
	return model.APIResult{
		Success: rejectResp.StatusCode >= 200 && rejectResp.StatusCode < 300,
		Status:  rejectResp.StatusCode,
		Body:    string(rejectData),
	}
}
