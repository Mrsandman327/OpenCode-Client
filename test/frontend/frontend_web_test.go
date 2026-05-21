package frontendtest

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"oc-manager/model"
	"oc-manager/service"
)

type frontendBridgeStub struct {
	models []string
	skillRoot string
}

func (b *frontendBridgeStub) GetProjectTree(string) string { return "[]" }
func (b *frontendBridgeStub) OpenCodeAPI(string, string, string) model.APIResult {
	return model.APIResult{Error: "opencode 服务未启动"}
}
func (b *frontendBridgeStub) CreateSession(string) model.APIResult { return model.APIResult{Error: "opencode 服务未启动"} }
func (b *frontendBridgeStub) GetAvailableModels() ([]string, error) { return b.models, nil }
func (b *frontendBridgeStub) StartOpenCodeEvents() model.APIResult { return model.APIResult{Success: true, Status: 200} }
func (b *frontendBridgeStub) StopOpenCodeEvents() model.APIResult  { return model.APIResult{Success: true, Status: 200} }
func (b *frontendBridgeStub) StartOpenCodeWeb(int, string, model.ProxyConfig) model.WebResult {
	return model.WebResult{Error: "未实现"}
}
func (b *frontendBridgeStub) GetWebStatus(string, int) model.WebResult { return model.WebResult{Health: "离线"} }
func (b *frontendBridgeStub) StopOpenCodeWeb() model.WebResult        { return model.WebResult{Success: true} }
func (b *frontendBridgeStub) AppCall(method string, args []json.RawMessage) (interface{}, error) {
	switch method {
	case "GetCommands":
		return []model.CmdGroup{{Title: "测试命令", Cmds: []model.CmdInfo{{Name: "run"}}}}, nil
	case "ListSkillFiles":
		return map[string]any{
			"name": filepath.Base(b.skillRoot),
			"path": ".",
			"type": "dir",
			"children": []map[string]any{{"name": "SKILL.md", "path": "SKILL.md", "type": "file"}, {"name": "docs", "path": "docs", "type": "dir", "children": []map[string]any{{"name": "note.txt", "path": "docs/note.txt", "type": "file"}}}},
		}, nil
	case "ReadSkillFile":
		var rel string
		if err := json.Unmarshal(args[1], &rel); err != nil { return nil, err }
		if rel == "../secret.txt" || rel == "escape.txt" { return nil, errors.New("仅允许访问技能根目录内的文件") }
		if rel == "docs/note.txt" { return model.SkillContent{Path: rel, Content: "hello web viewer"}, nil }
		return model.SkillContent{Path: rel, Content: "# demo\n"}, nil
	case "SaveSkillFile":
		var rel string
		if err := json.Unmarshal(args[1], &rel); err != nil { return nil, err }
		if rel == "../secret.txt" { return nil, errors.New("仅允许访问技能根目录内的文件") }
		return map[string]bool{"success": true}, nil
	default:
		return nil, errors.New("unsupported method")
	}
}

func frontendFS() fs.FS {
	return os.DirFS(filepath.Join("..", "..", "frontend", "dist"))
}

func startFrontendServer(t *testing.T) (string, *frontendBridgeStub) {
	t.Helper()
	bridge := &frontendBridgeStub{models: []string{"demo/model"}, skillRoot: filepath.Join("/tmp", "demo-skill")}
	result := service.StartFrontendWebServer(frontendFS(), bridge, 0, "127.0.0.1")
	if result.Error != "" { t.Fatalf("启动页面 Web 服务失败: %v", result.Error) }
	t.Cleanup(func() { _ = service.StopFrontendWebServer() })
	return result.URL, bridge
}

func TestFrontendWebServesEmbeddedIndex(t *testing.T) {
	url, _ := startFrontendServer(t)
	var resp *http.Response
	var err error
	for i := 0; i < 10; i++ {
		resp, err = http.Get(url + "/")
		if err == nil { break }
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil { t.Fatalf("请求页面首页失败: %v", err) }
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK { t.Fatalf("首页状态码异常: %d", resp.StatusCode) }
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(strings.ToLower(string(body)), "<html") { t.Fatalf("首页内容不像 HTML: %s", string(body)) }
}

func TestFrontendWebStatusReflectsRunningAndStopped(t *testing.T) {
	url, _ := startFrontendServer(t)
	_ = url
	running := service.FrontendWebStatus("127.0.0.1", 0)
	if !running.Running || !running.Success || running.URL == "" { t.Fatalf("运行中状态异常: %+v", running) }
	stopped := service.StopFrontendWebServer()
	if stopped.Error != "" { t.Fatalf("停止页面 Web 服务失败: %v", stopped.Error) }
	status := service.FrontendWebStatus("127.0.0.1", 0)
	if status.Running { t.Fatalf("停止后仍显示运行中: %+v", status) }
}

func TestFrontendWebProjectTreeAPIRespondsJSON(t *testing.T) {
	url, _ := startFrontendServer(t)
	resp, err := http.Get(url + "/api/project-tree?knownDirs=%5B%5D")
	if err != nil { t.Fatalf("请求项目树接口失败: %v", err) }
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK { t.Fatalf("项目树接口状态码异常: %d", resp.StatusCode) }
	body, _ := io.ReadAll(resp.Body)
	var tree []any
	if err := json.Unmarshal(body, &tree); err != nil { t.Fatalf("项目树接口未返回 JSON 数组: %v, body=%s", err, string(body)) }
}

func TestFrontendWebOpenCodeAPIProxyReturnsStructuredError(t *testing.T) {
	url, _ := startFrontendServer(t)
	req, _ := http.NewRequest(http.MethodPost, url+"/api/open-code", strings.NewReader(`{"method":"GET","path":"/session","body":""}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil { t.Fatalf("请求 open-code 接口失败: %v", err) }
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var resultBody struct { Success bool `json:"success"`; Error string `json:"error"` }
	if err := json.Unmarshal(body, &resultBody); err != nil { t.Fatalf("open-code 接口未返回结构化 JSON: %v, body=%s", err, string(body)) }
	if resultBody.Success || resultBody.Error == "" { t.Fatalf("open-code 接口错误语义异常: %s", string(body)) }
}

func TestFrontendWebAppCallReturnsCommandsData(t *testing.T) {
	url, _ := startFrontendServer(t)
	body := frontendAppCall(t, url, `{"method":"GetCommands","args":[]}`)
	var groups []map[string]any
	if err := json.Unmarshal(body, &groups); err != nil { t.Fatalf("app-call 响应不是合法 JSON: %v, body=%s", err, string(body)) }
	if len(groups) == 0 { t.Fatalf("app-call 未返回命令分组: %s", string(body)) }
}

func TestFrontendWebAppCallReturnsSkillDirectoryTreeAndTextFile(t *testing.T) {
	url, bridge := startFrontendServer(t)
	bridge.skillRoot = filepath.Join("C:", "demo-skill")
	treeBody := frontendAppCall(t, url, `{"method":"ListSkillFiles","args":["`+jsonEscape(bridge.skillRoot)+`"]}`)
	var tree map[string]any
	if err := json.Unmarshal(treeBody, &tree); err != nil { t.Fatalf("目录树响应不是合法 JSON: %v, body=%s", err, string(treeBody)) }
	if tree["name"] != "demo-skill" { t.Fatalf("目录树根名称异常: %s", string(treeBody)) }
	fileBody := frontendAppCall(t, url, `{"method":"ReadSkillFile","args":["`+jsonEscape(bridge.skillRoot)+`","docs/note.txt"]}`)
	var file map[string]any
	if err := json.Unmarshal(fileBody, &file); err != nil { t.Fatalf("文本文件响应不是合法 JSON: %v, body=%s", err, string(fileBody)) }
	if file["content"] != "hello web viewer" { t.Fatalf("文本文件内容异常: %s", string(fileBody)) }
}

func TestFrontendWebAppCallReadsFileWithinSymlinkSkillRoot(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	skillRoot := filepath.Join(configHome, "opencode", "skills")
	realSkillDir := filepath.Join(configHome, "real-skill")
	linkedSkillDir := filepath.Join(skillRoot, "linked-skill")
	if err := os.MkdirAll(realSkillDir, 0755); err != nil { t.Fatalf("创建真实技能目录失败: %v", err) }
	if err := os.MkdirAll(skillRoot, 0755); err != nil { t.Fatalf("创建技能根目录失败: %v", err) }
	if err := os.WriteFile(filepath.Join(realSkillDir, "SKILL.md"), []byte("# linked\n"), 0644); err != nil { t.Fatalf("写入 SKILL.md 失败: %v", err) }
	if err := os.Symlink(realSkillDir, linkedSkillDir); err != nil { t.Skipf("当前环境不支持技能软链接测试: %v", err) }

	url, bridge := startFrontendServer(t)
	bridge.skillRoot = linkedSkillDir
	body := frontendAppCall(t, url, `{"method":"ReadSkillFile","args":["`+jsonEscape(linkedSkillDir)+`","SKILL.md"]}`)
	var file map[string]any
	if err := json.Unmarshal(body, &file); err != nil { t.Fatalf("软链接技能文件响应不是合法 JSON: %v, body=%s", err, string(body)) }
	if file["content"] != "# demo\n" { t.Fatalf("软链接技能文件内容异常: %s", string(body)) }
}

func TestFrontendWebGitHistoryEndpoints(t *testing.T) {
	url, _ := startFrontendServer(t)
	repo, commits := initFrontendGitRepo(t)

	historyResp, err := http.Get(url + "/api/git/history?rootDir=" + jsonEscape(repo) + "&offset=0&limit=30")
	if err != nil { t.Fatalf("请求 Git 历史失败: %v", err) }
	defer historyResp.Body.Close()
	if historyResp.StatusCode != http.StatusOK { t.Fatalf("Git 历史接口状态码异常: %d", historyResp.StatusCode) }
	var history model.GitHistoryResult
	if err := json.NewDecoder(historyResp.Body).Decode(&history); err != nil { t.Fatalf("解析 Git 历史失败: %v", err) }
	if len(history.Items) != 2 { t.Fatalf("Git 历史条数异常: %#v", history) }
	if history.Items[0].Hash != commits[1] { t.Fatalf("Git 历史首条应为最新提交: %#v", history.Items[0]) }

	filesResp, err := http.Get(url + "/api/git/history/files?rootDir=" + jsonEscape(repo) + "&commitHash=" + commits[1])
	if err != nil { t.Fatalf("请求提交文件列表失败: %v", err) }
	defer filesResp.Body.Close()
	if filesResp.StatusCode != http.StatusOK { t.Fatalf("提交文件列表状态码异常: %d", filesResp.StatusCode) }
	var files model.GitCommitFilesResult
	if err := json.NewDecoder(filesResp.Body).Decode(&files); err != nil { t.Fatalf("解析提交文件列表失败: %v", err) }
	if len(files.Files) != 2 { t.Fatalf("提交文件列表数量异常: %#v", files.Files) }

	previewResp, err := http.Get(url + "/api/git/history/preview?rootDir=" + jsonEscape(repo) + "&commitHash=" + commits[1] + "&path=alpha.txt")
	if err != nil { t.Fatalf("请求历史 diff 失败: %v", err) }
	defer previewResp.Body.Close()
	if previewResp.StatusCode != http.StatusOK { t.Fatalf("历史 diff 状态码异常: %d", previewResp.StatusCode) }
	var preview model.GitCommitFilePreviewResult
	if err := json.NewDecoder(previewResp.Body).Decode(&preview); err != nil { t.Fatalf("解析历史 diff 失败: %v", err) }
	if len(preview.Blocks) == 0 { t.Fatalf("历史 diff 不应为空: %#v", preview) }
	if preview.FilePath != "alpha.txt" { t.Fatalf("历史 diff 文件路径异常: %#v", preview) }
}

func frontendAppCall(t *testing.T, baseURL, requestBody string) []byte {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, baseURL+"/api/app-call", strings.NewReader(requestBody))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil { t.Fatalf("请求 app-call 接口失败: %v", err) }
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		t.Fatalf("app-call 状态码异常: %d body=%s", resp.StatusCode, string(respBody))
	}
	respBody, _ := io.ReadAll(resp.Body)
	return respBody
}

func jsonEscape(value string) string {
	encoded, _ := json.Marshal(value)
	return strings.Trim(string(encoded), `"`)
}

func initFrontendGitRepo(t *testing.T) (string, []string) {
	t.Helper()
	repo := t.TempDir()
	runFrontendGit(t, repo, "init")
	runFrontendGit(t, repo, "config", "user.name", "Test User")
	runFrontendGit(t, repo, "config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(repo, "alpha.txt"), []byte("hello\n"), 0644); err != nil { t.Fatalf("写入 alpha.txt 失败: %v", err) }
	runFrontendGit(t, repo, "add", "alpha.txt")
	runFrontendGit(t, repo, "commit", "-m", "first commit")
	first := strings.TrimSpace(runFrontendGit(t, repo, "rev-parse", "HEAD"))
	if err := os.WriteFile(filepath.Join(repo, "alpha.txt"), []byte("hello\nworld\n"), 0644); err != nil { t.Fatalf("更新 alpha.txt 失败: %v", err) }
	if err := os.WriteFile(filepath.Join(repo, "beta.txt"), []byte("beta\n"), 0644); err != nil { t.Fatalf("写入 beta.txt 失败: %v", err) }
	runFrontendGit(t, repo, "add", "alpha.txt", "beta.txt")
	runFrontendGit(t, repo, "commit", "-m", "second commit")
	second := strings.TrimSpace(runFrontendGit(t, repo, "rev-parse", "HEAD"))
	return repo, []string{first, second}
}

func runFrontendGit(t *testing.T, repo string, args ...string) string {
	t.Helper()
	out, err := service.TestRunGitCommand(repo, args...)
	if err != nil { t.Fatalf("git %v 失败: %v", args, err) }
	return out
}
