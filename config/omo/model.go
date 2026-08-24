package omo

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"oc-manager/internal/fileutil"
	"oc-manager/model"
)

var configWriteMu sync.Mutex

// ========== 配置路径 & 加载 ==========

// configPathOverride 仅供测试注入配置文件路径；生产环境保持 nil。
var configPathOverride string

// ConfigPath 返回 OMO 配置文件的完整路径。
// 新位置优先：~/.omo/omo.jsonc（兼容同名 .json）；
// 回退兼容旧位置：$XDG_CONFIG_HOME/opencode/oh-my-openagent.jsonc 或
// ~/.config/opencode/oh-my-openagent.jsonc，便于已有配置平滑迁移。
func ConfigPath() string {
	if configPathOverride != "" {
		return configPathOverride
	}
	home, _ := os.UserHomeDir()

	candidates := []string{
		filepath.Join(home, ".omo", "omo.jsonc"),
		filepath.Join(home, ".omo", "omo.json"),
	}
	if dir := os.Getenv("XDG_CONFIG_HOME"); dir != "" {
		candidates = append(candidates,
			filepath.Join(dir, "opencode", "oh-my-openagent.jsonc"),
			filepath.Join(dir, "opencode", "oh-my-openagent.json"),
		)
	}
	candidates = append(candidates,
		filepath.Join(home, ".config", "opencode", "oh-my-openagent.jsonc"),
		filepath.Join(home, ".config", "opencode", "oh-my-openagent.json"),
	)

	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	// 默认新位置（保存时自动创建）
	return filepath.Join(home, ".omo", "omo.jsonc")
}

// LoadConfig 读取并解析 JSONC 配置，同时返回原始文本用于后续写回。
func LoadConfig() (*model.OpenAgentConfig, string, map[string]string, error) {
	path := ConfigPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", nil, fmt.Errorf("读取配置文件失败: %w", err)
	}

	rawText := string(data)

	// 去掉单行注释后解析 JSON
	cleaned := fileutil.StripComments(rawText)

	config, err := parseModelConfigSections(cleaned)
	if err != nil {
		return nil, rawText, nil, fmt.Errorf("解析配置失败: %w", err)
	}

	return &config, rawText, nil, nil
}

func parseModelConfigSections(cleaned string) (model.OpenAgentConfig, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(cleaned), &raw); err != nil {
		return nil, err
	}

	// 新格式（~/.omo/omo.jsonc）：模型映射位于 "[opencode]" 命名空间下；
	// 旧格式（oh-my-openagent.jsonc）：agents/categories 位于顶层。
	// 优先解析 "[opencode]"（新格式），失败或为空则回退顶层（旧格式）。
	if ns, ok := raw["[opencode]"]; ok {
		cfg, err := parseModelSectionsFrom(ns)
		if err == nil && len(cfg) > 0 {
			return cfg, nil
		}
	}
	return parseModelSectionsFromMap(raw)
}

// parseModelSectionsFrom 从指定的 JSON 对象（如 "[opencode]" 命名空间）解析模型映射 section。
func parseModelSectionsFrom(ns json.RawMessage) (model.OpenAgentConfig, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(ns, &raw); err != nil {
		return nil, err
	}
	return parseModelSectionsFromMap(raw)
}

// parseModelSectionsFromMap 遍历对象的所有键，收集"子项均为模型条目"的分组
// （agents / categories / 其他自定义分组）。$schema、_migrations 等非对象或
// 非模型分组会自动跳过。
func parseModelSectionsFromMap(raw map[string]json.RawMessage) (model.OpenAgentConfig, error) {
	config := make(model.OpenAgentConfig)
	for section, sectionData := range raw {
		var rawEntries map[string]json.RawMessage
		if err := json.Unmarshal(sectionData, &rawEntries); err != nil {
			continue
		}
		if len(rawEntries) == 0 {
			if isEmptyModelSectionName(section) {
				config[section] = map[string]model.ModelConfig{}
			}
			continue
		}

		entries := make(map[string]model.ModelConfig)
		isModelSection := true
		for key, entryData := range rawEntries {
			var entry model.ModelConfig
			if err := json.Unmarshal(entryData, &entry); err != nil || entry.Model == "" {
				isModelSection = false
				break
			}
			// 兼容旧配置：文件里是 variant 字段时映射到 reasoning（variant 已废弃）
			if entry.Reasoning == "" && entry.Variant != "" {
				entry.Reasoning = entry.Variant
			}
			entries[key] = entry
		}
		if isModelSection {
			config[section] = entries
		}
	}
	return config, nil
}

func isEmptyModelSectionName(section string) bool {
	section = normalizeModelEntryType(section)
	if section == "agents" || section == "categories" {
		return true
	}
	if section == "mcp" || section == "provider" || section == "providers" || section == "commands" || section == "settings" {
		return false
	}
	return len(section) > 3 && strings.HasSuffix(section, "s")
}

// SaveConfig 保存模型配置，只替换已存在条目的 model/variant/reasoning 值，
// 避免重建整段配置导致注释或未知字段丢失。agents/categories 位于
// "[opencode]" 命名空间内时自动在该容器内定位。
func SaveConfig(entries []model.ModelEntry) error {
	configWriteMu.Lock()
	defer configWriteMu.Unlock()
	entries = normalizeModelEntries(entries)

	path := ConfigPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("读取配置文件失败: %w", err)
	}

	lines := strings.Split(string(data), "\n")
	modelRe := regexp.MustCompile(`("model"\s*:\s*)"[^"]*"`)
	reasoningRe := regexp.MustCompile(`("reasoning"\s*:\s*)"[^"]*"`)
	cfg, err := parseModelConfigSections(fileutil.StripComments(string(data)))
	if err != nil {
		return fmt.Errorf("解析配置失败: %w", err)
	}

	for entryType, existing := range cfg {
		lines, err = removeMissingModelEntries(lines, existing, entries, entryType)
		if err != nil {
			return err
		}
	}

	for _, entry := range entries {
		var updated bool
		var keyExists bool
		sectionStart, sectionEnd := findSectionRange(lines, entry.Type)
		if sectionStart < 0 {
			lines, err = insertModelType(lines, entry.Type)
			if err != nil {
				return err
			}
			sectionStart, sectionEnd = findSectionRange(lines, entry.Type)
		}
		for i := sectionStart + 1; i < sectionEnd; i++ {
			line := lines[i]
			trimmed := strings.TrimSpace(line)
			if !isObjectKeyLine(trimmed, entry.Key) {
				continue
			}
			keyExists = true

			modelLineIndex := -1
			if modelRe.MatchString(line) {
				lines[i] = replaceModelValue(line, modelRe, entry.Model)
				modelLineIndex = i
				updated = true
			} else {
				for j := i + 1; j < len(lines) && j < i+8; j++ {
					if modelRe.MatchString(lines[j]) {
						lines[j] = replaceModelValue(lines[j], modelRe, entry.Model)
						modelLineIndex = j
						updated = true
						break
					}
					if strings.Contains(lines[j], "}") {
						break
					}
				}
			}

			if updated {
				// reasoning 写入（OMO 官方字段，variant 已废弃）：已有字段就地替换，否则在 model 行后补写
				lines = writeFieldValue(lines, i, modelLineIndex, "reasoning", entry.Reasoning, reasoningRe)
			}
			break
		}
		if !updated {
			if keyExists {
				return fmt.Errorf("未找到 %s 配置项 %q 的 model 字段", entry.Type, entry.Key)
			}
			lines, err = insertModelEntry(lines, entry)
			if err != nil {
				return err
			}
		}
	}

	return fileutil.AtomicWrite(path, []byte(strings.Join(lines, "\n")), 0644)
}

// writeFieldValue 在模型条目块内写入/替换单字段值，返回更新后的行列表。
// blockStart 为条目键所在行；modelLineIndex 为 model 字段行（可能等于 blockStart）。
// 已有字段就地替换；不存在则插入到 model 行之后（保持键序稳定）。
func writeFieldValue(lines []string, blockStart, modelLineIndex int, key, value string, re *regexp.Regexp) []string {
	if value == "" {
		// 值为空视为删除该字段：行内已有则移除，行内没有则不动
		return removeFieldLine(lines, blockStart, key)
	}
	// 已有字段：就地替换
	for k := modelLineIndex; k < len(lines) && k < modelLineIndex+8; k++ {
		if strings.Contains(lines[k], "}") {
			break
		}
		if re.MatchString(lines[k]) {
			lines[k] = replaceModelValue(lines[k], re, value)
			return lines
		}
	}
	// 未找到：在 model 行之后插入
	return insertFieldLine(lines, modelLineIndex, key, value)
}

// insertFieldLine 在 model 行后插入新字段行（如 variant / reasoning），返回新行列表。
// 逗号规则：若插入位置后还有非空字段行（不是 }），新行带尾逗号；否则不带。
// 前一行若需要分隔（无逗号且非 {）自动补逗号。
func insertFieldLine(lines []string, afterLine int, key, value string) []string {
	indent := leadingWhitespace(lines[afterLine])
	if indent == "" {
		indent = "  "
	}
	// 判断插入后是否还有后续字段（下一非空行不是闭合括号）
	hasNext := false
	for k := afterLine + 1; k < len(lines); k++ {
		trimmed := strings.TrimSpace(lines[k])
		if trimmed == "" {
			continue
		}
		if trimmed != "}" && trimmed != "}," {
			hasNext = true
		}
		break
	}
	// 前一行补逗号（model 行通常无尾逗号）
	if prev := lines[afterLine]; strings.TrimSpace(prev) != "" &&
		!strings.HasSuffix(strings.TrimSpace(prev), ",") &&
		!strings.HasSuffix(strings.TrimSpace(prev), "{") {
		lines[afterLine] = prev + ","
	}
	fieldLine := fmt.Sprintf(`%s"%s": %q`, indent, key, value)
	if hasNext {
		fieldLine += ","
	}
	updated := make([]string, 0, len(lines)+1)
	updated = append(updated, lines[:afterLine+1]...)
	updated = append(updated, fieldLine)
	updated = append(updated, lines[afterLine+1:]...)
	return updated
}

// removeFieldLine 移除条目块内的指定字段行（key: "..."），返回新行列表。
func removeFieldLine(lines []string, blockStart int, key string) []string {
	re := regexp.MustCompile(fmt.Sprintf(`^(\s*)"%s"\s*:`, regexp.QuoteMeta(key)))
	for k := blockStart + 1; k < len(lines) && k < blockStart+8; k++ {
		trimmed := strings.TrimSpace(lines[k])
		if trimmed == "}" || trimmed == "}," {
			break
		}
		if re.MatchString(lines[k]) {
			updated := make([]string, 0, len(lines)-1)
			updated = append(updated, lines[:k]...)
			updated = append(updated, lines[k+1:]...)
			return updated
		}
	}
	return lines
}

func normalizeModelEntries(entries []model.ModelEntry) []model.ModelEntry {
	normalized := make([]model.ModelEntry, len(entries))
	for i, entry := range entries {
		normalized[i] = entry
		normalized[i].Type = normalizeModelEntryType(entry.Type)
	}
	return normalized
}

func normalizeModelEntryType(entryType string) string {
	switch strings.TrimSpace(entryType) {
	case "agent":
		return "agents"
	case "category":
		return "categories"
	default:
		return strings.TrimSpace(entryType)
	}
}

func removeMissingModelEntries(lines []string, existing map[string]model.ModelConfig, entries []model.ModelEntry, entryType string) ([]string, error) {
	keep := make(map[string]bool)
	for _, entry := range entries {
		if entry.Type == entryType {
			keep[entry.Key] = true
		}
	}

	var err error
	for key := range existing {
		if keep[key] {
			continue
		}
		var removed bool
		lines, removed, err = removeModelEntry(lines, key, entryType)
		if err != nil {
			return nil, err
		}
		if !removed {
			return nil, fmt.Errorf("未找到待删除的 %s 配置项 %q", entryType, key)
		}
	}
	return lines, nil
}

func replaceModelValue(line string, modelRe *regexp.Regexp, model string) string {
	match := modelRe.FindStringSubmatchIndex(line)
	if len(match) < 4 {
		return line
	}
	return line[:match[3]] + fmt.Sprintf("%q", model) + line[match[1]:]
}

// insertModelEntry 在配置容器（[opencode] 或根对象）内的目标 section 中插入条目。
func insertModelEntry(lines []string, entry model.ModelEntry) ([]string, error) {
	entry.Type = normalizeModelEntryType(entry.Type)

	containerStart, containerEnd, _ := findModelContainer(lines)

	for i := containerStart; i <= containerEnd; i++ {
		if !isObjectKeyLine(strings.TrimSpace(lines[i]), entry.Type) {
			continue
		}

		depth := 0
		for j := i; j < len(lines); j++ {
			for _, ch := range lines[j] {
				switch ch {
				case '{':
					depth++
				case '}':
					depth--
				}
			}
			if depth == 0 && j > i {
				return insertBeforeSectionClose(lines, j, entry), nil
			}
		}
		break
	}

	return nil, fmt.Errorf("未找到 %s section", entry.Type)
}

// insertBeforeSectionClose 在 section 闭合括号前插入新条目，自动处理尾逗号。
func insertBeforeSectionClose(lines []string, closeIndex int, entry model.ModelEntry) []string {
	prevIndex := previousContentLine(lines, closeIndex)
	if prevIndex >= 0 {
		trimmed := strings.TrimSpace(lines[prevIndex])
		if !strings.Contains(trimmed, "{") && !strings.HasSuffix(trimmed, ",") {
			lines[prevIndex] += ","
		}
	}

	indent := leadingWhitespace(lines[closeIndex]) + "  "
	// 只写入 reasoning（OMO 官方字段，variant 已废弃）
	var fields []string
	fields = append(fields, fmt.Sprintf(`%s  "model": %q`, indent, entry.Model))
	if entry.Reasoning != "" {
		fields = append(fields, fmt.Sprintf(`%s  "reasoning": %q`, indent, entry.Reasoning))
	} else {
		fields = append(fields, fmt.Sprintf(`%s  "reasoning": "none"`, indent))
	}
	// 除最后一个字段外都带尾逗号
	for i := 0; i < len(fields); i++ {
		if i < len(fields)-1 {
			fields[i] += ","
		}
	}
	newEntry := append([]string{fmt.Sprintf(`%s%q: {`, indent, entry.Key)}, fields...)
	newEntry = append(newEntry, fmt.Sprintf(`%s}`, indent))

	updated := make([]string, 0, len(lines)+len(newEntry))
	updated = append(updated, lines[:closeIndex]...)
	updated = append(updated, newEntry...)
	updated = append(updated, lines[closeIndex:]...)
	return updated
}

func removeModelEntry(lines []string, key, entryType string) ([]string, bool, error) {
	entryType = normalizeModelEntryType(entryType)
	sectionStart, sectionEnd := findSectionRange(lines, entryType)
	if sectionStart < 0 {
		return nil, false, fmt.Errorf("未找到 %s section", entryType)
	}

	for i := sectionStart + 1; i < sectionEnd; i++ {
		trimmed := strings.TrimSpace(lines[i])
		if !isObjectKeyLine(trimmed, key) {
			continue
		}

		blockEnd, err := findObjectBlockEnd(lines, i)
		if err != nil {
			return nil, false, err
		}
		updated := append([]string{}, lines[:i]...)
		updated = append(updated, lines[blockEnd+1:]...)
		trimTrailingCommaBeforeSectionClose(updated, sectionEnd-(blockEnd-i+1))
		return updated, true, nil
	}

	return lines, false, nil
}

func removeModelType(lines []string, entryType string) ([]string, bool, error) {
	entryType = normalizeModelEntryType(entryType)
	if entryType == "" {
		return nil, false, fmt.Errorf("类型名称不能为空")
	}
	sectionStart, sectionEnd := findSectionRange(lines, entryType)
	if sectionStart < 0 {
		return lines, false, nil
	}

	updated := append([]string{}, lines[:sectionStart]...)
	updated = append(updated, lines[sectionEnd+1:]...)

	// 确定移除后所在的容器（[opencode] 或根对象）闭合行，清理尾逗号
	_, containerEnd, inOpenCodeNS := findModelContainer(updated)
	_ = inOpenCodeNS
	if containerEnd >= 0 && containerEnd < len(updated) {
		trimTrailingCommaBeforeSectionClose(updated, containerEnd)
	}
	return updated, true, nil
}

// findSectionRange 在配置容器（[opencode] 或根对象）内查找指定 section 的行范围。
func findSectionRange(lines []string, entryType string) (int, int) {
	containerStart, containerEnd, _ := findModelContainer(lines)
	for i := containerStart; i <= containerEnd; i++ {
		if !isObjectKeyLine(strings.TrimSpace(lines[i]), entryType) {
			continue
		}
		depth := 0
		for j := i; j < len(lines); j++ {
			for _, ch := range lines[j] {
				switch ch {
				case '{':
					depth++
				case '}':
					depth--
				}
			}
			if depth == 0 && j > i {
				return i, j
			}
		}
		break
	}
	return -1, -1
}

func isObjectKeyLine(line, key string) bool {
	pattern := fmt.Sprintf(`^"%s"\s*:\s*\{`, regexp.QuoteMeta(key))
	return regexp.MustCompile(pattern).MatchString(strings.TrimSpace(line))
}

func findObjectBlockEnd(lines []string, start int) (int, error) {
	depth := 0
	for i := start; i < len(lines); i++ {
		for _, ch := range lines[i] {
			switch ch {
			case '{':
				depth++
			case '}':
				depth--
			}
		}
		if depth == 0 && i >= start {
			return i, nil
		}
	}
	return -1, fmt.Errorf("未找到配置项闭合括号")
}

func trimTrailingCommaBeforeSectionClose(lines []string, sectionEnd int) {
	if sectionEnd < 0 || sectionEnd >= len(lines) {
		return
	}
	prev := previousContentLine(lines, sectionEnd)
	if prev >= 0 {
		lines[prev] = strings.TrimSuffix(lines[prev], ",")
	}
}

func previousContentLine(lines []string, before int) int {
	for i := before - 1; i >= 0; i-- {
		if strings.TrimSpace(lines[i]) != "" {
			return i
		}
	}
	return -1
}

func leadingWhitespace(line string) string {
	return line[:len(line)-len(strings.TrimLeft(line, " \t"))]
}

func insertModelType(lines []string, entryType string) ([]string, error) {
	entryType = normalizeModelEntryType(entryType)
	if strings.TrimSpace(entryType) == "" {
		return nil, fmt.Errorf("类型名称不能为空")
	}
	if start, _ := findSectionRange(lines, entryType); start >= 0 {
		return nil, fmt.Errorf("类型 %q 已存在", entryType)
	}

	// 定位容器：优先 [opencode] 块，否则根对象
	containerStart, containerEnd, _ := findModelContainer(lines)
	_ = containerStart
	rootEnd := containerEnd
	if rootEnd < 0 || rootEnd >= len(lines) {
		return nil, fmt.Errorf("未找到配置容器闭合括号")
	}

	prevIndex := previousContentLine(lines, rootEnd)
	if prevIndex >= 0 {
		trimmed := strings.TrimSpace(lines[prevIndex])
		if !strings.Contains(trimmed, "{") && !strings.HasSuffix(trimmed, ",") {
			lines[prevIndex] += ","
		}
	}

	indent := leadingWhitespace(lines[rootEnd]) + "  "
	newSection := []string{
		fmt.Sprintf(`%s%q: {`, indent, entryType),
		fmt.Sprintf(`%s}`, indent),
	}

	updated := make([]string, 0, len(lines)+len(newSection))
	updated = append(updated, lines[:rootEnd]...)
	updated = append(updated, newSection...)
	updated = append(updated, lines[rootEnd:]...)
	return updated, nil
}

// ========== 容器定位（[opencode] 命名空间支持） ==========

// findModelContainer 定位模型配置的容器块。
// 新格式（~/.omo/omo.jsonc）：agents/categories 位于 "[opencode]" 块内，
// 返回该块的行范围 [start, end]（end 为闭合 '}' 所在行）。
// 旧格式（oh-my-openagent.jsonc）：返回根对象范围 [0, rootEnd]。
// 返回的 bool 表示是否命中 "[opencode]" 命名空间。
func findModelContainer(lines []string) (start, end int, inOpenCodeNS bool) {
	for i, line := range lines {
		if !isObjectKeyLine(strings.TrimSpace(line), "[opencode]") {
			continue
		}
		depth := 0
		for j := i; j < len(lines); j++ {
			for _, ch := range lines[j] {
				switch ch {
				case '{':
					depth++
				case '}':
					depth--
				}
			}
			if depth == 0 && j > i {
				return i, j, true
			}
		}
		break
	}
	rootEnd, err := findObjectBlockEnd(lines, 0)
	if err != nil {
		return 0, len(lines) - 1, false
	}
	return 0, rootEnd, false
}

// ========== 增删模型类型与条目 ==========

// AddModelType 添加模型配置类型分组。
func AddModelType(entryType string) error {
	entryType = normalizeModelEntryType(entryType)
	configWriteMu.Lock()
	defer configWriteMu.Unlock()

	path := ConfigPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := strings.Split(string(data), "\n")
	lines, err = insertModelType(lines, entryType)
	if err != nil {
		return err
	}

	return fileutil.AtomicWrite(path, []byte(strings.Join(lines, "\n")), 0644)
}

// DeleteModelType 删除整个模型配置类型分组。
func DeleteModelType(entryType string) error {
	entryType = normalizeModelEntryType(entryType)
	configWriteMu.Lock()
	defer configWriteMu.Unlock()

	path := ConfigPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := strings.Split(string(data), "\n")
	lines, removed, err := removeModelType(lines, entryType)
	if err != nil {
		return err
	}
	if !removed {
		return fmt.Errorf("未找到 %s section", entryType)
	}

	return fileutil.AtomicWrite(path, []byte(strings.Join(lines, "\n")), 0644)
}

// ========== 配置转前端结构 ==========

// ParseConfigContent 解析任意 JSONC 文本（如导入的外部方案文件），返回结构化条目。
// 兼容新格式（[opencode] 命名空间）与旧格式（顶层 agents/categories）。
func ParseConfigContent(content string) ([]model.ModelEntry, error) {
	cleaned := fileutil.StripComments(content)
	cfg, err := parseModelConfigSections(cleaned)
	if err != nil {
		return nil, fmt.Errorf("解析配置失败: %w", err)
	}
	return ConfigToEntries(&cfg, nil), nil
}

// ConfigToEntries 将 OpenAgentConfig 转为前端展示用的 ModelEntry 列表。
func ConfigToEntries(config *model.OpenAgentConfig, descriptions map[string]string) []model.ModelEntry {
	entries := make([]model.ModelEntry, 0)
	sectionNames := make([]string, 0, len(*config))
	for section := range *config {
		sectionNames = append(sectionNames, section)
	}
	sort.Strings(sectionNames)

	for _, section := range sectionNames {
		keys := make([]string, 0, len((*config)[section]))
		for key := range (*config)[section] {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			mc := (*config)[section][key]
			desc := ""
			if descriptions != nil {
				desc = descriptions[key]
			}
			entries = append(entries, model.ModelEntry{
				Key:       key,
				Type:      section,
				Model:     mc.Model,
				Variant:   mc.Variant,
				Reasoning: mc.Reasoning,
				Comment:   desc,
			})
		}
	}

	return entries
}

