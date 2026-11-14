package mcp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"oc-manager/internal/fileutil"
	"oc-manager/model"
)

// testConfig 是测试用的 opencode.jsonc：包含 mcp.servers、全局 timeout、
// 一个 v1 旧格式的 mcp.old 条目，以及若干未建模字段。
const testConfig = `{
  // JSONC 注释应被正确去除
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "local-tool": {
        "type": "local",
        "command": ["npx", "-y", "@modelcontextprotocol/server-everything"],
        "environment": {"TOKEN": "abc"},
        "disabled": true,
        "x-vendor": {"nested": 1}
      },
      "remote-tool": {
        "type": "remote",
        "url": "https://example.com/mcp",
        "headers": {"Authorization": "Bearer t"},
        "codemode": false,
        "oauth": false
      }
    },
    "timeout": {"startup": 30000},
    "old": {
      "type": "local",
      "command": ["legacy-server"]
    }
  },
  "other": true
}`

// withTempConfig 在临时目录创建配置文件，并把本包的读写路径指向它；
// 测试结束后恢复默认路径，确保不触碰真实用户配置。
func withTempConfig(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "opencode.jsonc")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("写入测试配置失败: %v", err)
	}
	prev := configPath
	configPath = func() string { return path }
	t.Cleanup(func() { configPath = prev })
	return path
}

// readConfig 读取并解析测试配置为通用 map，便于断言写回结果。
func readConfig(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取测试配置失败: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(fileutil.StripComments(string(data))), &out); err != nil {
		t.Fatalf("解析测试配置失败: %v", err)
	}
	return out
}

// mcpSection 取出配置中的 mcp 段并断言其存在。
func mcpSection(t *testing.T, raw map[string]any) map[string]any {
	t.Helper()
	section, ok := raw["mcp"].(map[string]any)
	if !ok {
		t.Fatalf("配置缺少 mcp 段: %v", raw)
	}
	return section
}

// serversSection 取出 mcp.servers 并断言其存在。
func serversSection(t *testing.T, raw map[string]any) map[string]any {
	t.Helper()
	servers, ok := mcpSection(t, raw)["servers"].(map[string]any)
	if !ok {
		t.Fatalf("配置缺少 mcp.servers: %v", raw)
	}
	return servers
}

// TestGetMcpConfigReadsServersAndSkipsLegacy 验证：
// servers 正确读出、v1 的 mcp.old 不出现在列表里、全局 timeout 与 Extra 正常。
func TestGetMcpConfigReadsServersAndSkipsLegacy(t *testing.T) {
	withTempConfig(t, testConfig)

	info := GetMcpConfig()
	if info.Path == "" {
		t.Fatal("GetMcpConfig 未返回配置文件路径")
	}
	if len(info.Servers) != 2 {
		t.Fatalf("连接器数量 = %d, 期望 2: %+v", len(info.Servers), info.Servers)
	}
	// 列表按名称排序，顺序稳定。
	if info.Servers[0].Name != "local-tool" || info.Servers[1].Name != "remote-tool" {
		t.Fatalf("连接器排序异常: %q, %q", info.Servers[0].Name, info.Servers[1].Name)
	}

	local := info.Servers[0]
	if local.Type != "local" || len(local.Command) != 3 || !local.Disabled {
		t.Fatalf("local-tool 读取结果异常: %+v", local)
	}
	if local.Environment["TOKEN"] != "abc" {
		t.Fatalf("local-tool environment 读取异常: %+v", local.Environment)
	}
	// 未建模字段应进入 Extra，供前端提示。
	if _, ok := local.Extra["x-vendor"]; !ok {
		t.Fatalf("local-tool 的未知字段未进入 Extra: %+v", local.Extra)
	}

	remote := info.Servers[1]
	// codemode=false 必须保留为「显式 false」，不能退化为未设置。
	if remote.Codemode == nil || *remote.Codemode {
		t.Fatalf("remote-tool codemode 应保留为显式 false: %+v", remote.Codemode)
	}
	// oauth=false 必须原样承载。
	if string(remote.OAuth) != "false" {
		t.Fatalf("remote-tool oauth 应为 false, 实际 %s", string(remote.OAuth))
	}

	if info.Timeout == nil || info.Timeout.Startup == nil || *info.Timeout.Startup != 30000 {
		t.Fatalf("全局 timeout 读取异常: %+v", info.Timeout)
	}

	// v1 旧条目不在列表中。
	for _, s := range info.Servers {
		if s.Name == "old" {
			t.Fatal("v1 的 mcp.old 条目不应出现在连接器列表中")
		}
	}
}

// TestSaveMcpServerPreservesUnknownFields 验证：
// 保存已知字段时，未知字段（x-vendor）与原文件其它顶层键都原样保留。
func TestSaveMcpServerPreservesUnknownFields(t *testing.T) {
	path := withTempConfig(t, testConfig)

	res := SaveMcpServer(model.McpServerSave{
		OldName:     "local-tool",
		Name:        "local-tool",
		Type:        "local",
		Command:     []string{"npx", "-y", "new-server"},
		Environment: map[string]string{"TOKEN": "xyz"},
	})
	if !res.Success {
		t.Fatalf("保存失败: %s", res.Error)
	}

	raw := readConfig(t, path)
	servers := serversSection(t, raw)
	entry, ok := servers["local-tool"].(map[string]any)
	if !ok {
		t.Fatalf("local-tool 条目丢失: %v", servers)
	}
	if _, ok := entry["x-vendor"]; !ok {
		t.Fatalf("未知字段 x-vendor 未被保留: %v", entry)
	}
	command, _ := entry["command"].([]any)
	if len(command) != 3 || command[2] != "new-server" {
		t.Fatalf("command 未更新: %v", entry["command"])
	}
	// mcp 下的 v1 旧条目仍然存在。
	if _, ok := mcpSection(t, raw)["old"]; !ok {
		t.Fatal("保存后 v1 的 mcp.old 条目被删除")
	}
	// 其它顶层键也保留。
	if raw["other"] != true {
		t.Fatalf("顶层未知键 other 丢失: %v", raw)
	}
}

// TestSaveMcpServerRenames 验证：重命名后旧键消失、新键存在，未建模字段随同迁移。
func TestSaveMcpServerRenames(t *testing.T) {
	path := withTempConfig(t, testConfig)

	res := SaveMcpServer(model.McpServerSave{
		OldName: "local-tool",
		Name:    "renamed-tool",
		Type:    "local",
		Command: []string{"npx", "renamed-server"},
	})
	if !res.Success {
		t.Fatalf("重命名保存失败: %s", res.Error)
	}

	servers := serversSection(t, readConfig(t, path))
	if _, ok := servers["local-tool"]; ok {
		t.Fatal("重命名后旧键 local-tool 仍然存在")
	}
	entry, ok := servers["renamed-tool"].(map[string]any)
	if !ok {
		t.Fatalf("重命名后新键 renamed-tool 不存在: %v", servers)
	}
	if _, ok := entry["x-vendor"]; !ok {
		t.Fatalf("重命名后未建模字段丢失: %v", entry)
	}
}

// TestSaveMcpServerValidation 验证：local 缺命令、remote 非 http(s)、超时非正数都被拒绝。
func TestSaveMcpServerValidation(t *testing.T) {
	withTempConfig(t, testConfig)

	zero := 0
	cases := []struct {
		name string
		save model.McpServerSave
	}{
		{"空名称", model.McpServerSave{Type: "local", Command: []string{"x"}}},
		{"local 缺命令", model.McpServerSave{Name: "a", Type: "local"}},
		{"remote URL 非法", model.McpServerSave{Name: "b", Type: "remote", URL: "ftp://example.com"}},
		{"remote URL 为空", model.McpServerSave{Name: "c", Type: "remote"}},
		{"超时非正数", model.McpServerSave{Name: "d", Type: "local", Command: []string{"x"}, Timeout: &model.McpTimeout{Startup: &zero}}},
	}
	for _, tc := range cases {
		if res := SaveMcpServer(tc.save); res.Success || res.Error == "" {
			t.Fatalf("%s: 期望校验失败, 实际 %+v", tc.name, res)
		}
	}
}

// TestSaveMcpTimeoutsEmptyDeletesKey 验证：
// 三项全空时删除整个 mcp.timeout 键，且 mcp 下的 v1 条目仍然存在。
func TestSaveMcpTimeoutsEmptyDeletesKey(t *testing.T) {
	path := withTempConfig(t, testConfig)

	if res := SaveMcpTimeouts(model.McpTimeout{}); !res.Success {
		t.Fatalf("保存超时失败: %s", res.Error)
	}

	section := mcpSection(t, readConfig(t, path))
	if _, ok := section["timeout"]; ok {
		t.Fatalf("三项全空时应删除 mcp.timeout 键: %v", section)
	}
	if _, ok := section["old"]; !ok {
		t.Fatal("保存超时后 v1 的 mcp.old 条目被删除")
	}
}

// TestSaveMcpTimeoutsWritesOnlySetFields 验证：只填一项时只写这一项。
func TestSaveMcpTimeoutsWritesOnlySetFields(t *testing.T) {
	path := withTempConfig(t, testConfig)

	execution := 120000
	if res := SaveMcpTimeouts(model.McpTimeout{Execution: &execution}); !res.Success {
		t.Fatalf("保存超时失败: %s", res.Error)
	}

	section := mcpSection(t, readConfig(t, path))
	timeout, ok := section["timeout"].(map[string]any)
	if !ok {
		t.Fatalf("mcp.timeout 未写出: %v", section)
	}
	if len(timeout) != 1 {
		t.Fatalf("只应写出 execution 一项, 实际: %v", timeout)
	}
	if value, ok := timeout["execution"].(float64); !ok || value != 120000 {
		t.Fatalf("execution 超时值异常: %v", timeout["execution"])
	}
}

// TestSaveMcpTimeoutsRejectsNonPositive 验证：全局超时非正数被拒绝。
func TestSaveMcpTimeoutsRejectsNonPositive(t *testing.T) {
	withTempConfig(t, testConfig)

	zero := 0
	negative := -1
	for _, t2 := range []model.McpTimeout{{Startup: &zero}, {Catalog: &negative}} {
		if res := SaveMcpTimeouts(t2); res.Success || res.Error == "" {
			t.Fatalf("非正数超时应被拒绝: %+v", t2)
		}
	}
}

// TestDeleteMcpServer 验证：删除单条连接器后其它条目与 v1 旧条目保持不变。
func TestDeleteMcpServer(t *testing.T) {
	path := withTempConfig(t, testConfig)

	if res := DeleteMcpServer("local-tool"); !res.Success {
		t.Fatalf("删除失败: %s", res.Error)
	}

	raw := readConfig(t, path)
	servers := serversSection(t, raw)
	if _, ok := servers["local-tool"]; ok {
		t.Fatal("删除后 local-tool 仍然存在")
	}
	if _, ok := servers["remote-tool"]; !ok {
		t.Fatal("删除 local-tool 时误删了 remote-tool")
	}
	if _, ok := mcpSection(t, raw)["old"]; !ok {
		t.Fatal("删除连接器后 v1 的 mcp.old 条目被删除")
	}
	// 幂等：重复删除不报错。
	if res := DeleteMcpServer("local-tool"); !res.Success {
		t.Fatalf("重复删除应幂等成功, 实际: %s", res.Error)
	}
}
