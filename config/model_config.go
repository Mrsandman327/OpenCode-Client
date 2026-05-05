package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"oc-manager/model"
)

var configWriteMu sync.Mutex

// ========== 配置路径 & 加载 ==========

// ConfigPath 返回 oh-my-openagent.jsonc 的完整路径。
func ConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "opencode", "oh-my-openagent.jsonc")
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
	cleaned := stripComments(rawText)

	config, err := parseModelConfigSections(cleaned)
	if err != nil {
		return nil, rawText, nil, fmt.Errorf("解析配置失败: %w", err)
	}

	// 提取注释（key → comment text）
	comments := extractComments(rawText)

	return &config, rawText, comments, nil
}

func parseModelConfigSections(cleaned string) (model.OpenAgentConfig, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(cleaned), &raw); err != nil {
		return nil, err
	}

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

// GetFullConfig 返回完整 JSONC 字符串（前端解析后只显示 agents/categories）
func GetFullConfig() string {
	path := ConfigPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return "{}"
	}
	return string(data)
}

// SaveFullConfig 将前端修改后的完整 JSON 字符串直接写入文件
func SaveFullConfig(jsonStr string) model.SaveResult {
	configWriteMu.Lock()
	defer configWriteMu.Unlock()

	path := ConfigPath()
	if err := writeConfigFile(path, []byte(jsonStr), 0644); err != nil {
		return model.SaveResult{Success: false, Error: err.Error()}
	}
	return model.SaveResult{Success: true}
}

// SaveConfig 保存模型配置，只替换已存在条目的 model 值，避免重建整段配置导致注释或未知字段丢失。
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
	cfg, err := parseModelConfigSections(stripComments(string(data)))
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

			if modelRe.MatchString(line) {
				lines[i] = replaceModelValue(line, modelRe, entry.Model)
				updated = true
				break
			}

			for j := i + 1; j < len(lines) && j < i+8; j++ {
				if modelRe.MatchString(lines[j]) {
					lines[j] = replaceModelValue(lines[j], modelRe, entry.Model)
					updated = true
					break
				}
				if strings.Contains(lines[j], "}") {
					break
				}
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

	return writeConfigFile(path, []byte(strings.Join(lines, "\n")), 0644)
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
	if match == nil || len(match) < 4 {
		return line
	}
	return line[:match[3]] + fmt.Sprintf("%q", model) + line[match[1]:]
}

func insertModelEntry(lines []string, entry model.ModelEntry) ([]string, error) {
	entry.Type = normalizeModelEntryType(entry.Type)

	for i, line := range lines {
		if !isObjectKeyLine(strings.TrimSpace(line), entry.Type) {
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

func insertBeforeSectionClose(lines []string, closeIndex int, entry model.ModelEntry) []string {
	prevIndex := previousContentLine(lines, closeIndex)
	if prevIndex >= 0 {
		trimmed := strings.TrimSpace(lines[prevIndex])
		if !strings.Contains(trimmed, "{") && !strings.HasSuffix(trimmed, ",") {
			lines[prevIndex] += ","
		}
	}

	indent := leadingWhitespace(lines[closeIndex]) + "  "
	newEntry := []string{
		fmt.Sprintf(`%s%q: {`, indent, entry.Key),
		fmt.Sprintf(`%s  "model": %q%s`, indent, entry.Model, formatInlineComment(entry.Comment)),
		fmt.Sprintf(`%s}`, indent),
	}

	updated := make([]string, 0, len(lines)+len(newEntry))
	updated = append(updated, lines[:closeIndex]...)
	updated = append(updated, newEntry...)
	updated = append(updated, lines[closeIndex:]...)
	return updated
}

func formatInlineComment(comment string) string {
	comment = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(comment, "\r", " "), "\n", " "))
	if comment == "" {
		return ""
	}
	return " // " + comment
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
	rootEnd, err := findObjectBlockEnd(updated, 0)
	if err != nil {
		return nil, false, err
	}
	trimTrailingCommaBeforeSectionClose(updated, rootEnd)
	return updated, true, nil
}

func findSectionRange(lines []string, entryType string) (int, int) {
	for i, line := range lines {
		if !isObjectKeyLine(strings.TrimSpace(line), entryType) {
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

	rootEnd, err := findObjectBlockEnd(lines, 0)
	if err != nil {
		return nil, err
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

func writeConfigFile(path string, data []byte, perm os.FileMode) error {
	if strings.TrimSpace(string(data)) == "" {
		return fmt.Errorf("拒绝写入空配置文件: %s", path)
	}
	if err := validateJSONC(data); err != nil {
		return fmt.Errorf("拒绝写入无效配置文件 %s: %w", path, err)
	}

	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return fmt.Errorf("创建临时配置文件失败: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("写入临时配置文件失败: %w", err)
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return fmt.Errorf("设置临时配置文件权限失败: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("同步临时配置文件失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("关闭临时配置文件失败: %w", err)
	}

	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("替换配置文件失败: %w", err)
	}
	return nil
}

func validateJSONC(data []byte) error {
	cleaned := strings.TrimSpace(stripComments(string(data)))
	if cleaned == "" {
		return fmt.Errorf("配置内容为空")
	}
	if !json.Valid([]byte(cleaned)) {
		return fmt.Errorf("配置内容不是有效 JSON/JSONC")
	}
	return nil
}

// stripComments 移除 JSONC 中的单行注释（// ...）。
func stripComments(text string) string {
	lines := strings.Split(text, "\n")
	result := make([]string, 0, len(lines))
	for _, line := range lines {
		// 只在双引号外的 // 才算注释（简单处理，实际场景中 model 值不含 //）
		idx := strings.Index(line, "//")
		if idx >= 0 {
			// 确保 // 不在引号内（简化：检查 // 前引号数量）
			before := line[:idx]
			if strings.Count(before, "\"")%2 == 0 {
				line = before
			}
		}
		result = append(result, line)
	}
	return strings.Join(result, "\n")
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

	return writeConfigFile(path, []byte(strings.Join(lines, "\n")), 0644)
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

	return writeConfigFile(path, []byte(strings.Join(lines, "\n")), 0644)
}

// AddConfigEntry 添加 agent 或 category 条目。
func AddConfigEntry(key, m, entryType string) error {
	entryType = normalizeModelEntryType(entryType)
	configWriteMu.Lock()
	defer configWriteMu.Unlock()

	path := ConfigPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := strings.Split(string(data), "\n")
	lines, err = insertModelEntry(lines, model.ModelEntry{Key: key, Model: m, Type: entryType})
	if err != nil {
		return err
	}

	return writeConfigFile(path, []byte(strings.Join(lines, "\n")), 0644)
}

// DeleteConfigEntry 删除 agent 或 category 条目。
func DeleteConfigEntry(key, entryType string) error {
	entryType = normalizeModelEntryType(entryType)
	configWriteMu.Lock()
	defer configWriteMu.Unlock()

	path := ConfigPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := strings.Split(string(data), "\n")

	lines, removed, err := removeModelEntry(lines, key, entryType)
	if err != nil {
		return err
	}
	if !removed {
		return fmt.Errorf("未找到 %s 配置项 %q", entryType, key)
	}

	return writeConfigFile(path, []byte(strings.Join(lines, "\n")), 0644)
}

// loadConfigRaw 读取配置（不解析注释）
func loadConfigRaw() (*model.OpenAgentConfig, error) {
	path := ConfigPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	cleaned := stripComments(string(data))
	cfg, err := parseModelConfigSections(cleaned)
	if err != nil {
		return nil, err
	}
	return &cfg, nil
}

// saveConfigRaw 写回配置
func saveConfigRaw(cfg *model.OpenAgentConfig) error {
	configWriteMu.Lock()
	defer configWriteMu.Unlock()

	path := ConfigPath()
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return writeConfigFile(path, data, 0644)
}

// ========== 配置转前端结构 ==========

// ConfigToEntries 将 OpenAgentConfig 转为前端展示用的 ModelEntry 列表。
func ConfigToEntries(config *model.OpenAgentConfig, comments map[string]string) []model.ModelEntry {
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
			comment := comments[key]
			entries = append(entries, model.ModelEntry{
				Key:     key,
				Type:    section,
				Model:   mc.Model,
				Label:   deriveLabel(comment),
				Comment: comment,
			})
		}
	}

	return entries
}

// ========== 注释提取 ==========

// extractComments 从原始 JSONC 文本中提取每个 key 对应的行内注释。
func extractComments(rawText string) map[string]string {
	lines := strings.Split(rawText, "\n")
	comments := make(map[string]string)

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		// 匹配 "key": { 模式（block 开始）
		if idx := strings.Index(trimmed, `":`); idx > 0 && strings.Contains(trimmed[idx:], "{") {
			key := strings.Trim(trimmed[:idx], `" `)
			// 在当前行及后续 4 行中查找注释
			for j := i; j < len(lines) && j < i+5; j++ {
				c := extractInlineComment(lines[j])
				if c != "" {
					comments[key] = c
					break
				}
				// 遇到 } 且没有 {（即纯闭合行）则 block 结束
				if strings.Contains(lines[j], "}") && !strings.Contains(lines[j], "{") {
					break
				}
			}
		}
	}
	return comments
}

// extractInlineComment 提取一行中 // 后的注释文本。
func extractInlineComment(line string) string {
	idx := strings.Index(line, "//")
	if idx < 0 {
		return ""
	}
	before := line[:idx]
	// 确保 // 在引号外（偶数个引号）
	if strings.Count(before, `"`)%2 != 0 {
		return ""
	}
	return strings.TrimSpace(line[idx+2:])
}

// deriveLabel 从注释文本中提取 ≤5 字的中文简称。
// 策略：按中文标点截断取第一段 → 超出5字取前5字。
func deriveLabel(comment string) string {
	if comment == "" {
		return ""
	}

	// 尝试在分隔符处截断
	for _, sep := range []string{"：", ":", "，", "、", "；", "；", "——"} {
		if idx := strings.Index(comment, sep); idx > 0 {
			first := strings.TrimSpace(comment[:idx])
			runes := []rune(first)
			if len(runes) <= 5 && len(runes) > 0 {
				return first
			}
		}
	}

	// 无分隔符或第一段仍超长：取前5字符
	runes := []rune(comment)
	if len(runes) > 5 {
		return string(runes[:5])
	}
	return comment
}
