// Package mcp 提供 OpenCode v2 MCP 连接器（mcp.servers / mcp.timeout）的读写。
//
// 只处理 v2 的 mcp.servers 结构；v1 的 mcp.<name> 旧格式条目由
// model.McpConfig.Extra 原样保留，本包不读取、不迁移、不删除。
package mcp

import (
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"oc-manager/config/opencodecfg"
	"oc-manager/model"
)

// configPath 返回要读写的配置文件路径。
// 默认指向全局 opencode.jsonc；测试可替换为临时文件路径，
// 从而不依赖真实用户配置目录。业务代码无需修改此变量。
var configPath = opencodecfg.Path

// 连接器类型（对应 v2 schema 的 type 枚举）。
const (
	serverTypeLocal  = "local"
	serverTypeRemote = "remote"
)

// GetMcpConfig 返回 mcp.servers 列表、全局超时和配置文件路径。
// 配置文件读取失败时返回空列表与空 Path，不 panic。
func GetMcpConfig() model.McpConfigInfo {
	info := model.McpConfigInfo{Servers: []model.McpServerInfo{}}

	path := configPath()
	cfg, err := opencodecfg.LoadAt(path)
	if err != nil {
		return info
	}
	info.Path = path

	if cfg.Mcp == nil {
		return info
	}
	if cfg.Mcp.Timeout.Enabled() {
		info.Timeout = cfg.Mcp.Timeout
	}
	if len(cfg.Mcp.Servers) == 0 {
		return info
	}

	// map 遍历顺序随机，按名称排序保证前端列表顺序稳定。
	names := make([]string, 0, len(cfg.Mcp.Servers))
	for name := range cfg.Mcp.Servers {
		names = append(names, name)
	}
	sort.Strings(names)

	info.Servers = make([]model.McpServerInfo, 0, len(names))
	for _, name := range names {
		s := cfg.Mcp.Servers[name]
		if s == nil {
			// null 条目无法展示，但仍保留在配置中，不在此处清理。
			continue
		}
		info.Servers = append(info.Servers, model.McpServerInfo{
			Name:        name,
			Type:        s.Type,
			Command:     s.Command,
			Cwd:         s.Cwd,
			Environment: s.Environment,
			URL:         s.URL,
			Headers:     s.Headers,
			Disabled:    s.Disabled,
			Codemode:    s.Codemode,
			Pool:        s.Pool,
			Protocol:    s.Protocol,
			Timeout:     s.Timeout,
			OAuth:       s.OAuth,
			Extra:       copyExtra(s.Extra),
		})
	}
	return info
}

// SaveMcpServer 新增或更新单条连接器。
//   - OldName 非空且与 Name 不同时，删除旧键（重命名）；
//   - 未建模字段从原条目继承，不能丢；
//   - 校验：Name 非空；local 要求 Command 非空；remote 要求 http(s) URL；
//     timeout 每项必须是正整数。
func SaveMcpServer(p model.McpServerSave) model.SaveResult {
	if err := validateServerSave(p); err != nil {
		return model.SaveResult{Error: err.Error()}
	}
	name := strings.TrimSpace(p.Name)
	oldName := strings.TrimSpace(p.OldName)

	err := opencodecfg.UpdateAt(configPath(), func(cfg *model.OpenCodeConfig) error {
		if cfg.Mcp == nil {
			cfg.Mcp = &model.McpConfig{}
		}
		if cfg.Mcp.Servers == nil {
			cfg.Mcp.Servers = make(map[string]*model.McpServer)
		}

		// 未建模字段的继承来源：重命名时取旧键；否则取同名条目（原地更新）。
		sourceKey := name
		if oldName != "" {
			sourceKey = oldName
		}
		old := cfg.Mcp.Servers[sourceKey]

		// 重命名到已存在的另一个键会覆盖对方配置，直接拒绝。
		if sourceKey != name {
			if _, exists := cfg.Mcp.Servers[name]; exists {
				return fmt.Errorf("连接器 %q 已存在", name)
			}
		}

		cfg.Mcp.Servers[name] = buildServer(p, old)
		if sourceKey != name {
			delete(cfg.Mcp.Servers, sourceKey)
		}
		return nil
	})
	if err != nil {
		return model.SaveResult{Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// DeleteMcpServer 删除单条连接器。条目不存在时按幂等成功处理。
func DeleteMcpServer(name string) model.SaveResult {
	name = strings.TrimSpace(name)
	if name == "" {
		return model.SaveResult{Error: "连接器名称不能为空"}
	}
	err := opencodecfg.UpdateAt(configPath(), func(cfg *model.OpenCodeConfig) error {
		if cfg.Mcp == nil || cfg.Mcp.Servers == nil {
			return nil
		}
		delete(cfg.Mcp.Servers, name)
		return nil
	})
	if err != nil {
		return model.SaveResult{Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// SaveMcpTimeouts 保存全局默认超时。
//   - 三项都为空时删除整个 mcp.timeout 键（不留空对象 {}）；
//   - 只写有值的子项（指针为 nil 的项由 omitempty 省略）；
//   - 每项必须是正整数（schema 是 exclusiveMinimum: 0）。
func SaveMcpTimeouts(t model.McpTimeout) model.SaveResult {
	if err := validateTimeout(&t); err != nil {
		return model.SaveResult{Error: err.Error()}
	}
	err := opencodecfg.UpdateAt(configPath(), func(cfg *model.OpenCodeConfig) error {
		// 全部留空视为「使用 OpenCode 默认值」：删除整个 timeout 键。
		if !t.Enabled() {
			if cfg.Mcp != nil {
				cfg.Mcp.Timeout = nil
			}
			return nil
		}
		if cfg.Mcp == nil {
			cfg.Mcp = &model.McpConfig{}
		}
		timeout := t
		cfg.Mcp.Timeout = &timeout
		return nil
	})
	if err != nil {
		return model.SaveResult{Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// buildServer 把提交结构组装为配置条目；old 非空时继承其未建模字段。
func buildServer(p model.McpServerSave, old *model.McpServer) *model.McpServer {
	entry := &model.McpServer{
		Type:        strings.TrimSpace(p.Type),
		Command:     p.Command,
		Cwd:         strings.TrimSpace(p.Cwd),
		Environment: p.Environment,
		URL:         strings.TrimSpace(p.URL),
		Headers:     p.Headers,
		Disabled:    p.Disabled,
		Codemode:    p.Codemode,
		Pool:        p.Pool,
		Protocol:    strings.TrimSpace(p.Protocol),
		Timeout:     p.Timeout,
		OAuth:       p.OAuth,
	}
	// 三项都为空的 timeout 对象没有语义，归一化为「未设置」，避免写回 {}。
	if !entry.Timeout.Enabled() {
		entry.Timeout = nil
	}
	// oauth 显式传 null 等同于未设置。
	if string(entry.OAuth) == "null" {
		entry.OAuth = nil
	}
	if old != nil {
		entry.Extra = copyExtra(old.Extra)
	}
	return entry
}

// validateServerSave 校验前端提交的单条连接器。
func validateServerSave(p model.McpServerSave) error {
	if strings.TrimSpace(p.Name) == "" {
		return fmt.Errorf("连接器名称不能为空")
	}
	typ := strings.TrimSpace(p.Type)
	if typ == "" {
		return fmt.Errorf("连接器类型不能为空")
	}
	switch typ {
	case serverTypeLocal:
		if len(p.Command) == 0 {
			return fmt.Errorf("本地连接器（local）必须填写启动命令")
		}
	case serverTypeRemote:
		if err := validateHTTPURL(p.URL); err != nil {
			return err
		}
	}
	return validateTimeout(p.Timeout)
}

// validateTimeout 校验超时项：只允许正整数。
func validateTimeout(t *model.McpTimeout) error {
	if t == nil {
		return nil
	}
	items := []struct {
		label string
		value *int
	}{
		{"startup", t.Startup},
		{"catalog", t.Catalog},
		{"execution", t.Execution},
	}
	for _, item := range items {
		if item.value != nil && *item.value <= 0 {
			return fmt.Errorf("超时 %s 必须是正整数", item.label)
		}
	}
	return nil
}

// validateHTTPURL 校验远程连接器地址：必须是带主机名的 http(s) URL。
func validateHTTPURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fmt.Errorf("远程连接器（remote）必须填写 URL")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("远程连接器 URL 必须是 http(s) 地址: %s", raw)
	}
	return nil
}

// copyExtra 复制未建模字段映射，避免调用方与配置对象共享底层 map。
func copyExtra(extra map[string]json.RawMessage) map[string]json.RawMessage {
	if len(extra) == 0 {
		return nil
	}
	out := make(map[string]json.RawMessage, len(extra))
	for k, v := range extra {
		out[k] = v
	}
	return out
}
