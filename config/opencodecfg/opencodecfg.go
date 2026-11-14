// Package opencodecfg 提供 opencode.json(c) 的统一读取、写入与并发保护。
//
// 供应商（config/provider）与 MCP 连接器（config/mcp）都编辑同一个配置文件，
// 必须共用同一把写锁，否则两个界面同时保存时会互相覆盖对方的修改。
package opencodecfg

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"oc-manager/internal/fileutil"
	"oc-manager/internal/portable"
	"oc-manager/model"
)

// writeMu 是 opencode.json(c) 的全进程写锁。
// 所有「读-改-写」都必须经由 Update/UpdateAt 在此锁内完成。
var writeMu sync.Mutex

// Path 返回 opencode.jsonc 的完整路径（不存在时回退同名 .json）。
func Path() string {
	return fileutil.ResolveJSONC(filepath.Join(portable.OpenCodeConfigDir(), "opencode.jsonc"))
}

// Load 读取并解析全局配置（先去除 JSONC 注释再反序列化）。
func Load() (*model.OpenCodeConfig, error) {
	return LoadAt(Path())
}

// LoadAt 从指定路径读取并解析配置。
// 单独暴露路径参数是为了让测试使用临时文件，不依赖真实用户配置目录；
// 业务代码应使用 Load/Update，以保证共用同一把写锁。
func LoadAt(path string) (*model.OpenCodeConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取配置失败: %w", err)
	}

	var cfg model.OpenCodeConfig
	// opencode.jsonc 包含注释，需要先去除注释再解析
	if err := json.Unmarshal([]byte(fileutil.StripComments(string(data))), &cfg); err != nil {
		return nil, fmt.Errorf("解析配置失败: %w", err)
	}
	return &cfg, nil
}

// Save 序列化并原子写回全局配置。
func Save(cfg *model.OpenCodeConfig) error {
	return SaveAt(Path(), cfg)
}

// SaveAt 序列化并原子写回指定路径。
func SaveAt(path string, cfg *model.OpenCodeConfig) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化失败: %w", err)
	}
	return fileutil.AtomicWrite(path, data, 0644)
}

// Update 在读-改-写全过程持锁，避免并发保存互相覆盖。
// fn 返回错误时不执行写入（放弃本次修改）。
func Update(fn func(*model.OpenCodeConfig) error) error {
	return UpdateAt(Path(), fn)
}

// UpdateAt 在指定路径上执行持锁的读-改-写。
// 与 Update 共用同一把包级锁，保证不同业务包之间的修改串行化。
func UpdateAt(path string, fn func(*model.OpenCodeConfig) error) error {
	writeMu.Lock()
	defer writeMu.Unlock()

	cfg, err := LoadAt(path)
	if err != nil {
		return err
	}
	if err := fn(cfg); err != nil {
		return err
	}
	return SaveAt(path, cfg)
}
