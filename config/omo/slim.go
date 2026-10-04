package omo

// ============================================================
// oh-my-opencode-slim 配置文件（OMO Slim）
// ------------------------------------------------------------
// 负责 oh-my-opencode-slim.jsonc 的读取与保存，供「OMO 配置」视图
// 做「模型 + 思考力度（model / variant）」的可视化编辑。
//
// 配置文件位置与 omo-slim 插件自身读取位置一致：
//   $XDG_CONFIG_HOME/opencode/oh-my-opencode-slim.jsonc
//   （回退 ~/.config/opencode；优先 .jsonc，其次 .json）
//
// 结构示例：
//   {
//     "preset": "rongsi",                     // 当前启用的方案
//     "presets": {
//       "rongsi": {                           // 扁平形态：直接以 agent 名作键
//         "orchestrator": { "model": "...", "variant": "...", "skills": ["*"], "mcps": ["*"] }
//       },
//       "省流": { "extends": "rongsi", "explorer": { "model": "..." } }
//     },
//     "disabled_agents": [...], ...           // 其余顶层字段一律原样保留
//   }
//
// 设计要点（评审结论）：
//   - 只编辑 model / variant；agent 的其余字段（skills/mcps/description…）
//     与所有顶层未知字段必须无损保留；
//   - 结构未变（仅改值）时走行级替换，保留原文件注释；
//   - 结构变化（增删方案/条目、改 extends）时重建 "presets" 块（块内注释会丢，块外不动）；
//   - 继承（extends）：加载时合成显示（父方案 → 本方案覆盖）；保存时带 extends 的方案
//     只写「本方案自有或已改动（dirty）」的条目，其余保持继承；
//   - 保存前做内容哈希比对（revision），防止覆盖外部（插件 /preset、编辑器）的修改。
// ============================================================

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"oc-manager/internal/fileutil"
)

var (
	// slimWriteMu 保护配置文件写入的并发安全。
	slimWriteMu sync.Mutex
	// slimPathOverride 仅供测试注入配置文件路径；生产环境保持空。
	slimPathOverride string
)

// ========== 路径与描述表 ==========

// slimDescriptionsFileName 描述表相对 exe 目录的路径。
const slimDescriptionsFileName = "./configs/oh-my-opencode-slim/agents-comments.json"

// SlimConfigPath 返回 oh-my-opencode-slim 配置文件路径。
// 与插件自身一致：$XDG_CONFIG_HOME/opencode/oh-my-opencode-slim.jsonc；
// 优先 .jsonc，其次同名 .json。
func SlimConfigPath() string {
	if slimPathOverride != "" {
		return slimPathOverride
	}
	var dir string
	if xdg := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); xdg != "" {
		dir = filepath.Join(xdg, "opencode")
	} else {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config", "opencode")
	}
	jsonc := filepath.Join(dir, "oh-my-opencode-slim.jsonc")
	if _, err := os.Stat(jsonc); err == nil {
		return jsonc
	}
	jsonPath := strings.TrimSuffix(jsonc, ".jsonc") + ".json"
	if _, err := os.Stat(jsonPath); err == nil {
		return jsonPath
	}
	return jsonc
}

// ProjectSlimConfigPath 返回项目级配置文件路径（<dir>/.opencode/oh-my-opencode-slim.jsonc）。
// 项目级配置在插件中优先于用户级配置；界面据此提示"编辑可能不生效"。
func ProjectSlimConfigPath(projectDir string) string {
	dir := strings.TrimSpace(projectDir)
	if dir == "" {
		return ""
	}
	for _, name := range []string{"oh-my-opencode-slim.jsonc", "oh-my-opencode-slim.json"} {
		p := filepath.Join(dir, ".opencode", name)
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func slimDescriptionsPath() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("获取可执行文件路径失败: %w", err)
	}
	return filepath.Join(filepath.Dir(exePath), slimDescriptionsFileName), nil
}

// builtinSlimAgentComments 是内置 agent 描述兜底（描述文件缺失时使用）。
func builtinSlimAgentComments() map[string]string {
	return map[string]string{
		"orchestrator": "主编排器：拆解任务、调度后台专家、汇总结果",
		"oracle":       "高级顾问：架构决策、疑难调试、代码审查",
		"librarian":    "外部知识检索：文档查询、开源实现检索",
		"explorer":     "代码库侦察：大范围搜索与结构梳理",
		"designer":     "UI/UX 实现与视觉打磨",
		"fixer":        "快速实现：按计划执行范围化编码任务",
		"observer":     "只读视觉分析：图片、截图、PDF（需视觉模型）",
		"council":      "多模型共识：并行咨询多个模型并综合结论",
	}
}

// LoadSlimAgentDescriptions 从程序目录下的 agents-comments.json 加载描述表。
// 文件不存在或解析失败时回退内置描述，保证界面始终有可读文案。
func LoadSlimAgentDescriptions() (map[string]string, error) {
	path, err := slimDescriptionsPath()
	if err != nil {
		return builtinSlimAgentComments(), nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return builtinSlimAgentComments(), nil
	}
	var descriptions map[string]string
	if err := json.Unmarshal(data, &descriptions); err != nil {
		return builtinSlimAgentComments(), nil
	}
	// 以文件内容为准，未覆盖的 agent 用内置描述补齐
	merged := builtinSlimAgentComments()
	for k, v := range descriptions {
		merged[k] = v
	}
	return merged, nil
}

// ========== 前端数据结构 ==========

// SlimAgent 前端展示用的 agent 条目（仅 model/variant 可编辑）。
type SlimAgent struct {
	Key     string `json:"key"`
	Model   string `json:"model"`
	Variant string `json:"variant"`
	Comment string `json:"comment"`
	// Inherited 表示该行来自父方案（extends）；Overridden 表示父方案有但其被本方案覆盖。
	Inherited  bool `json:"inherited,omitempty"`
	Overridden bool `json:"overridden,omitempty"`
}

// SlimPreset 一个方案（预设）。
type SlimPreset struct {
	Name    string      `json:"name"`
	Extends string      `json:"extends,omitempty"`
	Agents  []SlimAgent `json:"agents"`
	// 继承异常标记（前端据此警示，并禁止保存）
	InheritMissing bool `json:"inheritMissing,omitempty"`
	InheritCycle   bool `json:"inheritCycle,omitempty"`
}

// SlimConfigResult 前端加载所需的完整数据。
type SlimConfigResult struct {
	Path       string `json:"path"`
	Exists     bool   `json:"exists"`
	ParseError string `json:"parseError,omitempty"`
	// ActivePreset 配置文件中声明的启用方案
	ActivePreset string       `json:"activePreset"`
	Presets      []SlimPreset `json:"presets"`
	// EnvPresetOverride 环境变量 OH_MY_OPENCODE_SLIM_PRESET 指定的方案（非空时覆盖文件值）
	EnvPresetOverride string `json:"envPresetOverride,omitempty"`
	// ProjectConfigPath 若当前项目存在项目级配置，返回其路径（项目级优先于用户级）
	ProjectConfigPath string `json:"projectConfigPath,omitempty"`
	// Revision 内容哈希，保存时用于冲突检测
	Revision string `json:"revision,omitempty"`
}

// SlimSaveAgent 保存提交的 agent 行。
// Dirty 表示该行在界面上被改动（带 extends 的方案只写 dirty 行）。
type SlimSaveAgent struct {
	Key     string `json:"key"`
	Model   string `json:"model"`
	Variant string `json:"variant"`
	Dirty   bool   `json:"dirty,omitempty"`
}

// SlimSavePreset 保存提交的方案。
// Deleted=true 表示显式删除该方案（仅显式删除才会移除，缺失默认保留）。
type SlimSavePreset struct {
	Name    string          `json:"name"`
	Extends string          `json:"extends"`
	Agents  []SlimSaveAgent `json:"agents"`
	Deleted bool            `json:"deleted,omitempty"`
}

// SlimSavePayload 前端提交的编辑结果。
type SlimSavePayload struct {
	ActivePreset string           `json:"activePreset"`
	Presets      []SlimSavePreset `json:"presets"`
	// BaseRevision 加载时返回的内容哈希；与磁盘不一致则拒绝保存。
	BaseRevision string `json:"baseRevision"`
}

// ========== 解析内部结构 ==========

// slimPresetDef 一个方案的原始定义（agent 名 → {model, variant}）。
type slimPresetDef struct {
	extends string
	agents  map[string]slimAgentValue
	// order 保留 agent 在文件中的原始顺序（JSON map 无序，故单独记录）
	order []string
	// extraAgents 记录非 agent 的未知键（保留用，当前仅用于生成时不丢 extends 之外的顶层键）
	extra map[string]json.RawMessage
}

type slimAgentValue struct {
	Model   string
	Variant string
}

// ========== 加载 ==========

// LoadSlimConfig 读取并解析配置文件，返回前端所需的结构化数据。
// projectDir 非空时，额外检测项目级配置（用于覆盖提示）。
func LoadSlimConfig(projectDir string) (*SlimConfigResult, error) {
	path := SlimConfigPath()
	res := &SlimConfigResult{Path: path}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			res.Exists = false
			res.ProjectConfigPath = ProjectSlimConfigPath(projectDir)
			res.EnvPresetOverride = strings.TrimSpace(os.Getenv("OH_MY_OPENCODE_SLIM_PRESET"))
			return res, nil
		}
		return nil, fmt.Errorf("读取 OMO Slim 配置失败: %w", err)
	}
	res.Exists = true
	res.Revision = contentRevision(data)
	res.ProjectConfigPath = ProjectSlimConfigPath(projectDir)
	res.EnvPresetOverride = strings.TrimSpace(os.Getenv("OH_MY_OPENCODE_SLIM_PRESET"))

	cleaned := fileutil.StripComments(string(data))
	var root map[string]json.RawMessage
	if err := json.Unmarshal([]byte(cleaned), &root); err != nil {
		res.ParseError = "配置文件不是有效 JSON/JSONC：" + err.Error()
		return res, nil
	}

	// 启用方案
	if raw, ok := root["preset"]; ok {
		_ = json.Unmarshal(raw, &res.ActivePreset)
	}

	// 解析 presets
	defs := map[string]*slimPresetDef{}
	var presetNames []string
	if raw, ok := root["presets"]; ok {
		var presetsMap map[string]json.RawMessage
		if err := json.Unmarshal(raw, &presetsMap); err == nil {
			for name, pv := range presetsMap {
				defs[name] = parseSlimPresetDef(pv)
			}
			for name, def := range defs {
				def.order = orderAgentKeys(cleaned, name, def.agents)
			}
			presetNames = orderKeysByText(cleaned, presetsMap, "presets")
		}
	}

	descs, _ := LoadSlimAgentDescriptions()

	for _, name := range presetNames {
		def := defs[name]
		preset := SlimPreset{Name: name, Extends: def.extends}
		agents, inherited, err := resolveSlimAgents(name, defs, nil, map[string]bool{})
		switch {
		case err != nil && err.Error() == slimErrCycle:
			preset.InheritCycle = true
		case err != nil && err.Error() == slimErrMissing:
			preset.InheritMissing = true
		}
		// 本方案自身声明的 agent 键集合（用于标记 Overridden）
		own := def.agents
		for _, a := range agents {
			_, inParent := inherited[a.Key]
			_, inOwn := own[a.Key]
			preset.Agents = append(preset.Agents, SlimAgent{
				Key:        a.Key,
				Model:      a.Model,
				Variant:    a.Variant,
				Comment:    descs[a.Key],
				Inherited:  inParent,
				Overridden: inParent && inOwn,
			})
		}
		res.Presets = append(res.Presets, preset)
	}

	return res, nil
}

// parseSlimPresetDef 解析单个方案定义，兼容扁平形态与 {extends, agents} 结构化形态。
func parseSlimPresetDef(raw json.RawMessage) *slimPresetDef {
	def := &slimPresetDef{agents: map[string]slimAgentValue{}, extra: map[string]json.RawMessage{}}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return def
	}
	if ex, ok := obj["extends"]; ok {
		_ = json.Unmarshal(ex, &def.extends)
	}
	// 结构化形态：agents 子对象内才是 agent
	if agentsRaw, ok := obj["agents"]; ok {
		var agentMap map[string]json.RawMessage
		if err := json.Unmarshal(agentsRaw, &agentMap); err == nil {
			for k, v := range agentMap {
				if av, ok := parseSlimAgentValue(v); ok {
					def.agents[k] = av
				} else {
					def.extra[k] = v
				}
			}
		}
		return def
	}
	// 扁平形态：除 extends/marketplace 外的对象键即 agent
	for k, v := range obj {
		if k == "extends" || k == "marketplace" {
			continue
		}
		if av, ok := parseSlimAgentValue(v); ok {
			def.agents[k] = av
		} else {
			def.extra[k] = v
		}
	}
	return def
}

// parseSlimAgentValue 解析单个 agent 覆盖对象；非对象或非 agent 形态返回 false。
func parseSlimAgentValue(raw json.RawMessage) (slimAgentValue, bool) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return slimAgentValue{}, false
	}
	av := slimAgentValue{}
	if m, ok := obj["model"]; ok {
		_ = json.Unmarshal(m, &av.Model)
	}
	if v, ok := obj["variant"]; ok {
		_ = json.Unmarshal(v, &av.Variant)
	}
	return av, true
}

const (
	slimErrCycle   = "extends-cycle"
	slimErrMissing = "extends-missing"
)

// resolveSlimAgents 递归合成方案生效的 agent 列表（父方案 → 本方案覆盖）。
// 返回：有序 agent 列表、来自父方案的 agent 集合、错误（环 / 继承源缺失）。
func resolveSlimAgents(name string, defs map[string]*slimPresetDef, stack []string, visiting map[string]bool) ([]slimAgentValueWithKey, map[string]bool, error) {
	def := defs[name]
	if def == nil {
		return nil, nil, fmt.Errorf(slimErrMissing)
	}
	if visiting[name] {
		return nil, nil, fmt.Errorf(slimErrCycle)
	}
	visiting[name] = true
	defer delete(visiting, name)

	var parentAgents []slimAgentValueWithKey
	inherited := map[string]bool{}
	if def.extends != "" {
		pAgents, _, err := resolveSlimAgents(def.extends, defs, append(stack, name), visiting)
		if err != nil {
			return nil, nil, err
		}
		parentAgents = pAgents
		// 父方案"生效"的全部 agent 都算继承而来（父自身也可能由继承+覆盖合成）
		for _, a := range pAgents {
			inherited[a.Key] = true
		}
	}

	// 父在前，本方案覆盖/新增在后
	merged := make([]slimAgentValueWithKey, 0, len(parentAgents)+len(def.agents))
	index := map[string]int{}
	for _, a := range parentAgents {
		index[a.Key] = len(merged)
		merged = append(merged, a)
	}
	// 本方案自身 agent：按文件原始顺序（order）遍历；order 缺失时回退名称排序
	ownKeys := def.order
	if len(ownKeys) == 0 {
		ownKeys = make([]string, 0, len(def.agents))
		for k := range def.agents {
			ownKeys = append(ownKeys, k)
		}
		sort.Strings(ownKeys)
	}
	for _, k := range ownKeys {
		v := def.agents[k]
		if i, ok := index[k]; ok {
			// 覆盖：仅当本方案显式提供了非空字段才覆盖
			if v.Model != "" {
				merged[i].Model = v.Model
			}
			if v.Variant != "" {
				merged[i].Variant = v.Variant
			}
		} else {
			index[k] = len(merged)
			merged = append(merged, slimAgentValueWithKey{Key: k, Model: v.Model, Variant: v.Variant})
		}
	}
	return merged, inherited, nil
}

type slimAgentValueWithKey struct {
	Key     string
	Model   string
	Variant string
}

// orderKeysByText 按 key 在文本中首次出现的位置排序（保持文件原始顺序）。
// scope 为容器键名（如 "presets"），从该键之后开始搜索，避免命中同名键。
func orderKeysByText(text string, m map[string]json.RawMessage, scope string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	base := 0
	if scope != "" {
		if idx := strings.Index(text, `"`+scope+`"`); idx >= 0 {
			base = idx
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		pi := strings.Index(text[base:], `"`+keys[i]+`"`)
		pj := strings.Index(text[base:], `"`+keys[j]+`"`)
		if pi < 0 {
			pi = 1 << 30
		}
		if pj < 0 {
			pj = 1 << 30
		}
		if pi == pj {
			return keys[i] < keys[j]
		}
		return pi < pj
	})
	return keys
}

// orderAgentKeys 按 agent 键在文本中首次出现的位置排序（保持文件原始顺序）。
// base 取该方案名首次出现的位置，避免命中其它方案中的同名键。
func orderAgentKeys(text, presetName string, agents map[string]slimAgentValue) []string {
	keys := make([]string, 0, len(agents))
	for k := range agents {
		keys = append(keys, k)
	}
	base := 0
	if idx := strings.Index(text, `"`+presetName+`"`); idx >= 0 {
		base = idx
	}
	sort.Slice(keys, func(i, j int) bool {
		pi := strings.Index(text[base:], `"`+keys[i]+`"`)
		pj := strings.Index(text[base:], `"`+keys[j]+`"`)
		if pi < 0 {
			pi = 1 << 30
		}
		if pj < 0 {
			pj = 1 << 30
		}
		if pi == pj {
			return keys[i] < keys[j]
		}
		return pi < pj
	})
	return keys
}

// contentRevision 返回内容的 SHA-256（用于保存冲突检测）。
func contentRevision(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// ========== 保存 ==========

// SaveSlimConfig 保存前端编辑结果。
// 结构未变时行级替换（保注释）；结构变化时重建 "presets" 块。
func SaveSlimConfig(p SlimSavePayload) error {
	slimWriteMu.Lock()
	defer slimWriteMu.Unlock()

	path := SlimConfigPath()

	var original []byte
	originalExists := false
	if data, err := os.ReadFile(path); err == nil {
		original = data
		originalExists = true
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("读取 OMO Slim 配置失败: %w", err)
	}

	// 冲突检测：磁盘内容与加载时不一致则拒绝
	if originalExists {
		if p.BaseRevision != "" && contentRevision(original) != p.BaseRevision {
			return fmt.Errorf("配置文件已被外部修改（插件切换或编辑器改动），请刷新后重试")
		}
	} else if p.BaseRevision != "" {
		return fmt.Errorf("配置文件已不存在或被移动，请刷新后重试")
	}

	text := string(original)
	cleaned := text
	if originalExists {
		cleaned = fileutil.StripComments(text)
	}

	// 解析原结构（用于结构对比与行级定位）
	originalDefs := map[string]*slimPresetDef{}
	if originalExists {
		var root map[string]json.RawMessage
		if err := json.Unmarshal([]byte(cleaned), &root); err == nil {
			if raw, ok := root["presets"]; ok {
				var pm map[string]json.RawMessage
				if err := json.Unmarshal(raw, &pm); err == nil {
					for name, pv := range pm {
						originalDefs[name] = parseSlimPresetDef(pv)
					}
				}
			}
		}
	}

	// 应用删除：仅显式 Deleted 的方案被移除；缺失的默认保留
	savePresets := make([]SlimSavePreset, 0, len(p.Presets))
	for _, sp := range p.Presets {
		if sp.Deleted {
			continue
		}
		savePresets = append(savePresets, sp)
	}

	structureChanged := slimStructureChanged(originalDefs, savePresets, originalExists)

	var lines []string
	if originalExists {
		lines = strings.Split(text, "\n")
	} else {
		lines = []string{"{", "}"}
	}

	if structureChanged {
		lines = rebuildSlimPresetsBlock(lines, savePresets, originalDefs)
	} else if edited, ok := applySlimLineEdits(lines, savePresets, originalDefs); ok {
		lines = edited
	} else {
		// 紧凑/单行布局导致行级定位失败 → 退化为重建
		lines = rebuildSlimPresetsBlock(lines, savePresets, originalDefs)
	}
	lines = setTopLevelField(lines, "preset", p.ActivePreset)

	out := strings.Join(lines, "\n")
	return fileutil.AtomicWrite(path, []byte(out), 0644)
}

// slimStructureChanged 判断结构（方案集合、extends、各方案自有 agent 集合）是否变化。
func slimStructureChanged(original map[string]*slimPresetDef, savePresets []SlimSavePreset, originalExists bool) bool {
	if !originalExists {
		return true
	}
	if len(original) != len(savePresets) {
		return true
	}
	for _, sp := range savePresets {
		def, ok := original[sp.Name]
		if !ok {
			return true
		}
		if def.extends != sp.Extends {
			return true
		}
		want := map[string]bool{}
		for _, a := range sp.Agents {
			if sp.Extends != "" && !a.Dirty {
				continue // 继承行不算本方案的结构
			}
			want[a.Key] = true
		}
		if len(want) != len(def.agents) {
			return true
		}
		for k := range def.agents {
			if !want[k] {
				return true
			}
		}
	}
	return false
}

// applySlimLineEdits 结构未变时的行级更新：在目标方案作用域内替换 model/variant。
// 第二个返回值表示行级定位是否成功；false 时调用方应退化为重建（如紧凑单行布局）。
func applySlimLineEdits(lines []string, savePresets []SlimSavePreset, original map[string]*slimPresetDef) ([]string, bool) {
	rootOpen, rootClose := rootContainer(lines)
	psKey, psEnd := findChildBlock(lines, rootOpen, rootClose, "presets")
	if psKey < 0 {
		return lines, false
	}
	for _, sp := range savePresets {
		pKey, pEnd := findChildBlock(lines, psKey, psEnd, sp.Name)
		if pKey < 0 {
			return lines, false
		}
		// 结构化形态时，agent 位于 agents 子对象内
		aOpen, aClose := pKey, pEnd
		if agKey, agEnd := findChildBlock(lines, pKey, pEnd, "agents"); agKey >= 0 {
			aOpen, aClose = agKey, agEnd
		}
		for _, a := range sp.Agents {
			if sp.Extends != "" && !a.Dirty {
				continue // 继承行不落盘，保持继承
			}
			ak, ae := findChildBlock(lines, aOpen, aClose, a.Key)
			if ak < 0 {
				return lines, false // 定位失败 → 退化重建
			}
			if a.Model != "" {
				lines = setFieldInRange(lines, ak, ae, "model", a.Model)
			}
			lines = setFieldInRange(lines, ak, ae, "variant", a.Variant)
		}
	}
	return lines, true
}

// rebuildSlimPresetsBlock 重建 "presets" 块的文本（块外内容原样保留）。
func rebuildSlimPresetsBlock(lines []string, savePresets []SlimSavePreset, original map[string]*slimPresetDef) []string {
	block := buildSlimPresetsBlock(savePresets)
	rootOpen, rootClose := rootContainer(lines)
	if psKey, psEnd := findChildBlock(lines, rootOpen, rootClose, "presets"); psKey >= 0 {
		// presets 之后若仍有成员，块末行需要补尾逗号
		if hasFollowingMember(lines, psEnd+1, len(lines)) {
			block[len(block)-1] += ","
		}
		out := make([]string, 0, len(lines)-(psEnd-psKey+1)+len(block))
		out = append(out, lines[:psKey]...)
		out = append(out, block...)
		out = append(out, lines[psEnd+1:]...)
		return out
	}
	// 顶层没有 presets 键：插入到根对象闭合行之前
	rootEnd := rootClose
	if prev := previousContentLine(lines, rootEnd); prev >= 0 {
		trimmed := strings.TrimSpace(lines[prev])
		if !strings.Contains(trimmed, "{") && !strings.HasSuffix(trimmed, ",") {
			lines[prev] += ","
		}
	}
	// 插入为根对象的最后一个成员：块末行不加逗号（前一个成员的逗号已在上方补好）
	out := make([]string, 0, len(lines)+len(block))
	out = append(out, lines[:rootEnd]...)
	out = append(out, block...)
	out = append(out, lines[rootEnd:]...)
	return out
}

// hasFollowingMember 判断 lines[start:end] 内是否还有"非空且非闭合括号"的成员行。
func hasFollowingMember(lines []string, start, end int) bool {
	if end > len(lines) {
		end = len(lines)
	}
	for i := start; i < end; i++ {
		t := strings.TrimSpace(lines[i])
		if t != "" && t != "}" && t != "}," {
			return true
		}
	}
	return false
}

// buildSlimPresetsBlock 生成 "presets" 块的文本行（含缩进，不含尾逗号）。
func buildSlimPresetsBlock(savePresets []SlimSavePreset) []string {
	var out []string
	out = append(out, `  "presets": {`)
	for _, sp := range savePresets {
		out = append(out, fmt.Sprintf(`    %s: {`, strconv.Quote(sp.Name)))
		if sp.Extends != "" {
			out = append(out, fmt.Sprintf(`      "extends": %s,`, strconv.Quote(sp.Extends)))
		}
		written := 0
		for _, a := range sp.Agents {
			// 空模型视为"不写该条目"（可用于撤掉覆盖）
			if a.Model == "" {
				continue
			}
			// 带 extends 的方案只写"已改动"的条目（保持继承）
			if sp.Extends != "" && !a.Dirty {
				continue
			}
			written++
			out = append(out, fmt.Sprintf(`      %s: {`, strconv.Quote(a.Key)))
			out = append(out, fmt.Sprintf(`        "model": %s,`, strconv.Quote(a.Model)))
			out = append(out, fmt.Sprintf(`        "variant": %s`, strconv.Quote(a.Variant)))
			out = append(out, `      },`)
		}
		// 去掉最后一个条目多余的尾逗号
		if written > 0 {
			last := len(out) - 1
			out[last] = strings.TrimSuffix(out[last], ",")
		} else if sp.Extends != "" {
			last := len(out) - 1
			out[last] = strings.TrimSuffix(out[last], ",")
		}
		out = append(out, `    },`)
	}
	// 最后一个方案去掉尾逗号
	if len(out) > 0 {
		last := len(out) - 1
		out[last] = strings.TrimSuffix(out[last], ",")
	}
	out = append(out, `  }`)
	return out
}

// ========== 文本定位与字段写入工具 ==========

// rootContainer 返回根对象的开括号行与闭括号行。
// 自动跳过文件开头的空行/注释行（配置文件常以注释开头，不能把注释行当成根括号行）。
func rootContainer(lines []string) (int, int) {
	open := -1
	for i, line := range lines {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "//") || strings.HasPrefix(t, "/*") ||
			strings.HasPrefix(t, "*") || strings.HasSuffix(t, "*/") {
			continue
		}
		if strings.Contains(t, "{") {
			open = i
			break
		}
	}
	if open < 0 {
		return 0, len(lines) - 1
	}
	if end, err := findObjectBlockEnd(lines, open); err == nil && end > open {
		return open, end
	}
	return open, len(lines) - 1
}

// findChildBlock 在父容器（parentOpen 为其 '{' 所在行、parentClose 为其 '}' 所在行）内
// 查找**直接子键** key 的对象块，返回 (键所在行, 块闭合行)。未找到返回 (-1, -1)。
// 从父容器开括号的下一行开始、以相对深度 0 为基准，避免根对象开括号造成的基准偏移。
func findChildBlock(lines []string, parentOpen, parentClose int, key string) (int, int) {
	if parentOpen < 0 {
		parentOpen = 0
	}
	if parentClose >= len(lines) {
		parentClose = len(lines) - 1
	}
	depth := 0
	for i := parentOpen + 1; i < parentClose && i < len(lines); i++ {
		if depth == 0 && isObjectKeyLine(strings.TrimSpace(lines[i]), key) {
			d := 0
			for j := i; j <= parentClose && j < len(lines); j++ {
				d += braceDelta(lines[j])
				if d <= 0 { // 单行对象（开闭同行）在此立即闭合
					return i, j
				}
			}
			return i, parentClose
		}
		depth += braceDelta(lines[i])
	}
	return -1, -1
}

// braceDelta 返回一行中 { 与 } 的数量差（忽略字符串字面量内的括号）。
func braceDelta(line string) int {
	delta := 0
	inString, escaped := false, false
	for i := 0; i < len(line); i++ {
		c := line[i]
		if inString {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inString = false
			}
			continue
		}
		switch c {
		case '"':
			inString = true
		case '{':
			delta++
		case '}':
			delta--
		}
	}
	return delta
}

// setFieldInRange 在 lines[from:to] 内替换字段 key 的字符串值；不存在则在 model 行后插入。
func setFieldInRange(lines []string, from, to int, key, value string) []string {
	if key == "" {
		return lines
	}
	re := regexp.MustCompile(`("` + regexp.QuoteMeta(key) + `"\s*:\s*)"[^"]*"`)
	for i := from; i <= to && i < len(lines); i++ {
		if re.MatchString(lines[i]) {
			lines[i] = replaceModelValue(lines[i], re, value)
			return lines
		}
	}
	// 未找到：插到 model 行之后；无 model 行则插到块起始行之后
	after := from
	modelRe := regexp.MustCompile(`"model"\s*:`)
	for i := from + 1; i <= to && i < len(lines); i++ {
		if modelRe.MatchString(lines[i]) {
			after = i
			break
		}
	}
	return insertFieldLine(lines, after, key, value)
}

// setTopLevelField 设置顶层字符串字段（如 "preset"）；为空时移除该字段行。
func setTopLevelField(lines []string, key, value string) []string {
	re := regexp.MustCompile(`^(\s*"` + regexp.QuoteMeta(key) + `"\s*:\s*)"[^"]*"`)
	for i, line := range lines {
		if re.MatchString(line) {
			if value == "" {
				out := make([]string, 0, len(lines)-1)
				out = append(out, lines[:i]...)
				out = append(out, lines[i+1:]...)
				return out
			}
			lines[i] = replaceModelValue(line, re, value)
			return lines
		}
	}
	if value == "" {
		return lines
	}
	// 插入到根对象第一个键之前
	rootEnd, err := findObjectBlockEnd(lines, 0)
	if err != nil {
		rootEnd = len(lines) - 1
	}
	insertAt := 1
	for i := 1; i < rootEnd; i++ {
		if strings.TrimSpace(lines[i]) != "" {
			insertAt = i
			break
		}
	}
	// 新字段插到根对象最前：后面的成员不受影响，无需给任何现有成员补逗号
	fieldLine := fmt.Sprintf(`  "%s": %s`, key, strconv.Quote(value))
	if hasFollowingMember(lines, insertAt, rootEnd) {
		fieldLine += ","
	}
	out := make([]string, 0, len(lines)+1)
	out = append(out, lines[:insertAt]...)
	out = append(out, fieldLine)
	out = append(out, lines[insertAt:]...)
	return out
}
