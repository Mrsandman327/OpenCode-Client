package knowledge

import (
	"strings"

	"oc-manager/model"
)

// frontmatterDelimiter 是 frontmatter 的分隔行。
const frontmatterDelimiter = "---"

// RenderMarkdown 将条目渲染为带 frontmatter 的 Markdown 文本。
// ID 不写入 frontmatter（文件名即 ID）。
// 字段值经 sanitizeFieldValue 折叠换行后逐行写入，解析时按首个冒号切分，
// 因此值中本身含冒号、逗号、引号都能原样往返。
func RenderMarkdown(entry model.KnowledgeEntry) string {
	var sb strings.Builder
	sb.WriteString(frontmatterDelimiter + "\n")
	writeFrontmatterField(&sb, "title", entry.Title)
	writeFrontmatterField(&sb, "summary", entry.Summary)
	writeFrontmatterField(&sb, "category", entry.Category)
	writeFrontmatterField(&sb, "tags", formatList(entry.Tags))
	writeFrontmatterField(&sb, "created", entry.Created)
	writeFrontmatterField(&sb, "updated", entry.Updated)
	writeFrontmatterField(&sb, "converted", formatList(entry.Converted))
	sb.WriteString(frontmatterDelimiter + "\n")
	if strings.TrimSpace(entry.Content) != "" {
		sb.WriteString("\n")
		sb.WriteString(entry.Content)
	}
	return sb.String()
}

// ParseMarkdown 解析带 frontmatter 的 Markdown 文本。
// 文件不以 --- 开头或 frontmatter 未闭合时，整体按正文处理。
func ParseMarkdown(text string) model.KnowledgeEntry {
	entry := model.KnowledgeEntry{Tags: []string{}, Converted: []string{}}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != frontmatterDelimiter {
		entry.Content = strings.TrimSpace(text)
		return entry
	}

	end := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == frontmatterDelimiter {
			end = i
			break
		}
	}
	if end < 0 {
		entry.Content = strings.TrimSpace(text)
		return entry
	}

	for _, line := range lines[1:end] {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "title":
			entry.Title = strings.TrimSpace(value)
		case "summary":
			entry.Summary = strings.TrimSpace(value)
		case "category":
			entry.Category = strings.TrimSpace(value)
		case "tags":
			entry.Tags = parseList(value)
		case "created":
			entry.Created = strings.TrimSpace(value)
		case "updated":
			entry.Updated = strings.TrimSpace(value)
		case "converted":
			entry.Converted = parseList(value)
		}
	}
	entry.Content = strings.TrimLeft(strings.Join(lines[end+1:], "\n"), "\n")
	return entry
}

// writeFrontmatterField 写入一行 frontmatter 字段，值中的换行会被折叠为空格。
func writeFrontmatterField(sb *strings.Builder, key, value string) {
	sb.WriteString(key)
	sb.WriteString(": ")
	sb.WriteString(sanitizeFieldValue(value))
	sb.WriteString("\n")
}

// sanitizeFieldValue 折叠换行并去除首尾空白，避免破坏逐行解析。
func sanitizeFieldValue(value string) string {
	replaced := strings.NewReplacer("\r", " ", "\n", " ").Replace(value)
	return strings.TrimSpace(replaced)
}

// formatList 将字符串切片格式化为 [a, b] 形式，空切片输出 []。
func formatList(items []string) string {
	cleaned := make([]string, 0, len(items))
	for _, item := range items {
		item = sanitizeFieldValue(item)
		if item == "" {
			continue
		}
		cleaned = append(cleaned, item)
	}
	return "[" + strings.Join(cleaned, ", ") + "]"
}

// parseList 解析 [a, b, c] 形式的数组；空值返回空切片。
func parseList(value string) []string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "[") {
		value = strings.TrimPrefix(value, "[")
	}
	if strings.HasSuffix(value, "]") {
		value = strings.TrimSuffix(value, "]")
	}
	items := []string{}
	if strings.TrimSpace(value) == "" {
		return items
	}
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		items = append(items, part)
	}
	return items
}
