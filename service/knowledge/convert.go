package knowledge

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"oc-manager/internal/fileutil"
	"oc-manager/internal/symlink"
	"oc-manager/model"
)

// 转化目标类型。
const (
	kindSkill   = "skill"
	kindCommand = "command"
	kindRule    = "rule"
	kindAgents  = "agents"
)

// 转化作用域。
const (
	scopeGlobal  = "global"
	scopeProject = "project"
)

// 同步方式。
const (
	syncCopy    = "copy"
	syncSymlink = "symlink"
)

// 预览模式。
const (
	modeCreate    = "create"
	modeOverwrite = "overwrite"
	modeAppend    = "append"
)

// agentsName 是项目准则目标的固定文件名（不含扩展名）。
const agentsName = "AGENTS"

// skillFileName 是技能的固定入口文件名。
const skillFileName = "SKILL.md"

// Converter 将知识库条目转化为 OpenCode 可用的资产文件。
type Converter struct {
	store      *Store
	globalRoot string // 全局 opencode 配置目录，测试可注入以避免触碰真实目录
}

// NewConverter 用真实全局配置目录创建转化器。
func NewConverter(store *Store) (*Converter, error) {
	root, err := globalOpenCodeDir()
	if err != nil {
		return nil, err
	}
	return NewConverterWithRoot(store, root), nil
}

// NewConverterWithRoot 用指定的全局配置目录创建转化器（测试或自定义场景）。
func NewConverterWithRoot(store *Store, globalRoot string) *Converter {
	return &Converter{store: store, globalRoot: globalRoot}
}

// globalOpenCodeDir 解析全局 opencode 配置目录：
// 优先 XDG_CONFIG_HOME，其次 ~/.config；与 config/skill 的全局技能目录约定保持一致。
func globalOpenCodeDir() (string, error) {
	if dir := os.Getenv("XDG_CONFIG_HOME"); dir != "" {
		return filepath.Join(dir, "opencode"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("获取用户主目录失败: %w", err)
	}
	return filepath.Join(home, ".config", "opencode"), nil
}

// Preview 计算转化目标与内容，纯读取计算，不产生任何写入。
func (c *Converter) Preview(req model.ConvertRequest) (model.ConvertPreview, error) {
	norm, err := normalizeConvertRequest(req)
	if err != nil {
		return model.ConvertPreview{}, err
	}
	entry, err := c.store.Get(norm.ID)
	if err != nil {
		return model.ConvertPreview{}, err
	}
	return c.buildPreview(norm, *entry)
}

// Convert 执行转化并按需回填转化记录，返回写入目标的完整路径。
func (c *Converter) Convert(req model.ConvertRequest) (string, error) {
	norm, err := normalizeConvertRequest(req)
	if err != nil {
		return "", err
	}
	entry, err := c.store.Get(norm.ID)
	if err != nil {
		return "", err
	}
	plan, err := c.buildPreview(norm, *entry)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(plan.TargetPath), dirPerm); err != nil {
		return "", fmt.Errorf("创建目标目录失败: %w", err)
	}
	if err := c.writeAsset(norm, plan); err != nil {
		return "", err
	}
	if err := c.store.MarkConverted(norm.ID, convertRecord(norm)); err != nil {
		return "", err
	}
	return plan.TargetPath, nil
}

// MarkConverted 把转化记录追加到条目的 Converted 字段并持久化（同一条记录幂等去重）。
// 追加成功会刷新条目的更新时间。
func (s *Store) MarkConverted(id, record string) error {
	entry, err := s.Get(id)
	if err != nil {
		return err
	}
	for _, existing := range entry.Converted {
		if existing == record {
			return nil
		}
	}
	entry.Converted = append(entry.Converted, record)
	if _, err := s.Save(*entry); err != nil {
		return fmt.Errorf("回填转化记录失败: %w", err)
	}
	return nil
}

// buildPreview 计算目标路径、写入模式与最终内容。
func (c *Converter) buildPreview(req model.ConvertRequest, entry model.KnowledgeEntry) (model.ConvertPreview, error) {
	targetPath, err := c.resolveTargetPath(req)
	if err != nil {
		return model.ConvertPreview{}, err
	}
	oldContent, exists := readFileContent(targetPath)

	mode := modeCreate
	if exists {
		if req.Kind == kindAgents {
			mode = modeAppend
		} else {
			mode = modeOverwrite
		}
	}

	newContent := assetContent(req, entry)
	appendAtLine := 0
	if mode == modeAppend {
		appendAtLine = countLines(oldContent) + 1
		newContent = appendBlock(oldContent, newContent)
	}

	return model.ConvertPreview{
		TargetPath:   targetPath,
		Mode:         mode,
		NewContent:   newContent,
		OldContent:   oldContent,
		Exists:       exists,
		AppendAtLine: appendAtLine,
	}, nil
}

// writeAsset 写入转化产物：symlink 模式优先创建链接，失败时回退为复制。
func (c *Converter) writeAsset(req model.ConvertRequest, plan model.ConvertPreview) error {
	// 准则需要追加语义，不能使用软链接
	if req.SyncMode == syncSymlink && req.Kind != kindAgents {
		if err := c.linkEntry(req.ID, plan.TargetPath); err == nil {
			return nil
		} else {
			// 软链接失败（如 Windows 无权限创建符号链接）不应导致整体失败，回退为复制
			log.Printf("[知识库] 创建软链接失败，回退为复制: %v", err)
		}
	}
	if err := fileutil.AtomicWriteRaw(plan.TargetPath, []byte(plan.NewContent), filePerm); err != nil {
		return fmt.Errorf("写入转化目标失败: %w", err)
	}
	return nil
}

// linkEntry 在目标位置创建指向知识库条目文件的软链接。
func (c *Converter) linkEntry(id, targetPath string) error {
	if symlink.Exists(targetPath) {
		if err := symlink.Remove(targetPath); err != nil {
			return fmt.Errorf("移除既有目标失败: %w", err)
		}
	}
	return symlink.Create(c.store.entryFile(id), targetPath)
}

// resolveTargetPath 解析转化目标的完整路径。
func (c *Converter) resolveTargetPath(req model.ConvertRequest) (string, error) {
	if req.Scope == scopeGlobal {
		return resolveGlobalPath(c.globalRoot, req), nil
	}
	return resolveProjectPath(req), nil
}

// resolveGlobalPath 解析全局作用域下的目标路径。
func resolveGlobalPath(root string, req model.ConvertRequest) string {
	switch req.Kind {
	case kindSkill:
		return filepath.Join(root, "skills", req.Name, skillFileName)
	case kindCommand:
		return filepath.Join(globalCommandDir(root), req.Name+markdownExt)
	case kindRule:
		return filepath.Join(root, "rules", req.Name+markdownExt)
	default: // kindAgents
		return filepath.Join(root, "AGENTS.md")
	}
}

// resolveProjectPath 解析项目作用域下的目标路径。
// 技能/命令/规则位于 .opencode/ 下，项目准则位于项目根。
func resolveProjectPath(req model.ConvertRequest) string {
	ocDir := filepath.Join(req.ProjectDir, ".opencode")
	switch req.Kind {
	case kindSkill:
		return filepath.Join(ocDir, "skills", req.Name, skillFileName)
	case kindCommand:
		return filepath.Join(ocDir, "commands", req.Name+markdownExt)
	case kindRule:
		return filepath.Join(ocDir, "rules", req.Name+markdownExt)
	default: // kindAgents
		return filepath.Join(req.ProjectDir, "AGENTS.md")
	}
}

// globalCommandDir 返回全局命令目录，兼容 command/ 与 commands/ 两种命名：
// 优先使用已存在的单数目录 command/，否则使用复数 commands/（不存在时作为默认创建目标）。
func globalCommandDir(root string) string {
	legacy := filepath.Join(root, "command")
	if info, err := os.Stat(legacy); err == nil && info.IsDir() {
		return legacy
	}
	return filepath.Join(root, "commands")
}

// readFileContent 读取目标内容，并返回其是否存在（含目录等非普通文件）。
// 存在但不可读时返回空内容与 true，交由写入阶段按覆盖语义处理。
func readFileContent(path string) (string, bool) {
	if _, err := os.Stat(path); err != nil {
		return "", false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", true
	}
	return string(data), true
}

// normalizeConvertRequest 校验并归一化转化请求。
func normalizeConvertRequest(req model.ConvertRequest) (model.ConvertRequest, error) {
	switch req.Kind {
	case kindSkill, kindCommand, kindRule:
		if !validID(req.Name) {
			return req, fmt.Errorf("非法的目标名称: %q", req.Name)
		}
	case kindAgents:
		// 准则文件名固定，忽略调用方传入的名称
		req.Name = agentsName
	default:
		return req, fmt.Errorf("未知的转化类型: %q", req.Kind)
	}

	switch req.Scope {
	case scopeGlobal:
	case scopeProject:
		if strings.TrimSpace(req.ProjectDir) == "" {
			return req, fmt.Errorf("项目作用域必须提供项目目录")
		}
	default:
		return req, fmt.Errorf("未知的转化作用域: %q", req.Scope)
	}

	if req.SyncMode == "" {
		req.SyncMode = syncCopy
	}
	if req.SyncMode != syncCopy && req.SyncMode != syncSymlink {
		return req, fmt.Errorf("未知的同步方式: %q", req.SyncMode)
	}
	return req, nil
}

// convertRecord 生成形如 "<scope>:<kind>:<name>" 的转化记录标识。
func convertRecord(req model.ConvertRequest) string {
	return req.Scope + ":" + req.Kind + ":" + req.Name
}
