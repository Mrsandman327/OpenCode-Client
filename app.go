package main

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
)

// App 是 Wails 应用的核心结构体，所有绑定到前端的方法都定义在此。
type App struct {
	ctx context.Context
	sm  *SkillManager
}

// NewApp 创建新的 App 实例。
func NewApp() *App {
	return &App{
		sm: NewSkillManager(),
	}
}

// startup 在应用启动时调用
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// 后台预加载模型列表
	go loadModels()
}

// GetSkills 返回所有技能及其在各平台的链接状态。
func (a *App) GetSkills() []SkillInfo {
	return a.sm.GetAllSkills()
}

// GetTargets 返回所有目标平台名称列表。
func (a *App) GetTargets() []TargetInfo {
	return a.sm.GetTargets()
}

// GetSourceDir 返回技能源目录路径。
func (a *App) GetSourceDir() string {
	return a.sm.sourceDir
}

// OpenDir 在文件资源管理器中打开指定目录。
func (a *App) OpenDir(path string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("explorer", path).Start()
	case "darwin":
		return exec.Command("open", path).Start()
	default:
		return exec.Command("xdg-open", path).Start()
	}
}

// GetStats 返回统计信息。
func (a *App) GetStats() Stats {
	skills := a.sm.GetAllSkills()
	s := Stats{
		TotalSkills: len(skills),
		TargetStats: make(map[string]int),
	}

	targets := a.sm.GetTargets()
	for _, t := range targets {
		count := 0
		for _, sk := range skills {
			if sk.Targets[t.Key] {
				count++
			}
		}
		s.TargetStats[t.Key] = count
	}

	return s
}

// ToggleSkill 切换某个技能在指定目标平台的链接状态。
// 参数: skillName - 技能名称, target - 目标平台, enable - true 创建链接 / false 移除链接
// 返回: 操作后的新状态、可能的错误信息
func (a *App) ToggleSkill(skillName, target string, enable bool) ToggleResult {
	newState, err := a.sm.ToggleSkill(skillName, target, enable)
	result := ToggleResult{
		SkillName: skillName,
		Target:    target,
		Linked:    newState,
		Success:   err == nil,
	}
	if err != nil {
		errMsg := err.Error()
		result.Error = &errMsg
	}
	return result
}

// ToggleAllSkills 批量切换某个目标平台下所有技能的链接状态。
func (a *App) ToggleAllSkills(target string, enable bool) BatchResult {
	errs := a.sm.ToggleAll(target, enable)
	result := BatchResult{
		Target:  target,
		Enabled: enable,
		Errors:  make([]string, 0),
	}
	for _, e := range errs {
		result.Errors = append(result.Errors, e.Error())
	}
	result.Success = len(result.Errors) == 0
	return result
}

// Refresh 重新扫描技能目录并刷新状态。
func (a *App) Refresh() error {
	a.sm = NewSkillManager()
	return nil
}

// ========== 模型配置方法 ==========

// GetModelConfig 读取所有 agent/category 的模型配置。
func (a *App) GetModelConfig() ([]ModelEntry, error) {
	config, _, comments, err := loadConfig()
	if err != nil {
		return nil, err
	}
	return configToEntries(config, comments), nil
}

// GetAvailableModels 通过 opencode models 获取所有可用模型。
func (a *App) GetAvailableModels() ([]string, error) {
	return getAvailableModels()
}

// RefreshAvailableModels 强制刷新模型列表缓存。
func (a *App) RefreshAvailableModels() ([]string, error) {
	refreshModels()
	return getAvailableModels()
}

// UpdateModels 批量更新模型配置并保存到 JSONC 文件。
func (a *App) UpdateModels(entries []ModelEntry) ModelSaveResult {
	if err := saveConfig(entries); err != nil {
		return ModelSaveResult{Success: false, Error: err.Error()}
	}
	return ModelSaveResult{Success: true}
}

// AddModelEntry 添加 agent 或 category 条目。
func (a *App) AddModelEntry(key, model, entryType string) ModelSaveResult {
	if err := addConfigEntry(key, model, entryType); err != nil {
		return ModelSaveResult{Success: false, Error: err.Error()}
	}
	return ModelSaveResult{Success: true}
}

// AddModelType 添加模型配置类型分组。
func (a *App) AddModelType(entryType string) ModelSaveResult {
	if err := addModelType(entryType); err != nil {
		return ModelSaveResult{Success: false, Error: err.Error()}
	}
	return ModelSaveResult{Success: true}
}

// DeleteModelType 删除整个模型配置类型分组。
func (a *App) DeleteModelType(entryType string) ModelSaveResult {
	if err := deleteModelType(entryType); err != nil {
		return ModelSaveResult{Success: false, Error: err.Error()}
	}
	return ModelSaveResult{Success: true}
}

// DeleteModelEntry 删除 agent 或 category 条目。
func (a *App) DeleteModelEntry(key, entryType string) ModelSaveResult {
	if err := deleteConfigEntry(key, entryType); err != nil {
		return ModelSaveResult{Success: false, Error: err.Error()}
	}
	return ModelSaveResult{Success: true}
}

// GetConfigPath 返回模型配置文件路径。
func (a *App) GetConfigPath() string {
	return configPath()
}

// GetProviderConfigPath 返回供应商配置文件路径。
func (a *App) GetProviderConfigPath() string {
	return opencodeConfigPath()
}

// ========== 供应商配置方法 ==========

// GetProviders 获取所有供应商配置。
func (a *App) GetProviders() ([]ProviderInfo, error) {
	return getProviders(), nil
}

// SaveProvider 保存供应商配置。
func (a *App) SaveProvider(ps ProviderSave) SaveResult {
	if err := saveProvider(ps); err != nil {
		return SaveResult{Success: false, Error: err.Error()}
	}
	return SaveResult{Success: true}
}

// DeleteProvider 删除供应商。
func (a *App) DeleteProvider(key string) SaveResult {
	if err := deleteProvider(key); err != nil {
		return SaveResult{Success: false, Error: err.Error()}
	}
	return SaveResult{Success: true}
}

// ========== 数据传输类型 ==========

// SaveResult 保存操作结果。
type SaveResult struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

// ========== 数据传输类型 ==========

// ModelSaveResult 模型保存结果。
type ModelSaveResult struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

// SkillInfo 前端展示用的技能信息。
type SkillInfo struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	SourcePath  string          `json:"sourcePath"`
	Targets     map[string]bool `json:"targets"` // target key -> is linked
}

// TargetInfo 目标平台信息。
type TargetInfo struct {
	Key   string `json:"key"`   // 内部标识，如 "opencode"
	Label string `json:"label"` // 显示名称，如 "OpenCode"
	Path  string `json:"path"`  // 目标路径
}

// Stats 统计信息。
type Stats struct {
	TotalSkills int            `json:"totalSkills"`
	TargetStats map[string]int `json:"targetStats"` // target key -> linked count
}

// ToggleResult 单个技能切换结果。
type ToggleResult struct {
	SkillName string  `json:"skillName"`
	Target    string  `json:"target"`
	Linked    bool    `json:"linked"`
	Success   bool    `json:"success"`
	Error     *string `json:"error,omitempty"`
}

// BatchResult 批量操作结果。
type BatchResult struct {
	Target  string   `json:"target"`
	Enabled bool     `json:"enabled"`
	Success bool     `json:"success"`
	Errors  []string `json:"errors"`
}

// String 实现 Stringer 接口，便于调试。
func (s Stats) String() string {
	return fmt.Sprintf("Skills: %d, Targets: %v", s.TotalSkills, s.TargetStats)
}
