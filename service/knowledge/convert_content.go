package knowledge

import (
	"strings"

	"oc-manager/model"
)

// assetContent 生成转化目标的完整内容。
// 技能/命令带 frontmatter，规则为纯正文，准则为可直接追加的注释块。
func assetContent(req model.ConvertRequest, entry model.KnowledgeEntry) string {
	switch req.Kind {
	case kindSkill:
		meta := "name: " + sanitizeFieldValue(req.Name) + "\ndescription: " + sanitizeFieldValue(entry.Summary)
		return withFrontmatter(meta, entry.Content)
	case kindCommand:
		return withFrontmatter("description: "+sanitizeFieldValue(entry.Summary), entry.Content)
	case kindRule:
		return ensureTrailingNewline(entry.Content)
	default: // kindAgents
		return "<!-- 知识库：" + sanitizeFieldValue(entry.Title) + " -->\n" + ensureTrailingNewline(entry.Content)
	}
}

// withFrontmatter 拼接 frontmatter 与正文，两者之间保留一个空行。
func withFrontmatter(meta, content string) string {
	return frontmatterDelimiter + "\n" + meta + "\n" + frontmatterDelimiter + "\n\n" + ensureTrailingNewline(content)
}

// appendBlock 在原有内容末尾追加一个块：
// 保证原文以换行结尾、块之间留空行、结果以换行结尾，不破坏原文件内容。
func appendBlock(oldContent, block string) string {
	var sb strings.Builder
	sb.WriteString(oldContent)
	if oldContent != "" {
		if !strings.HasSuffix(oldContent, "\n") {
			sb.WriteString("\n")
		}
		sb.WriteString("\n")
	}
	sb.WriteString(strings.TrimRight(block, "\n"))
	sb.WriteString("\n")
	return sb.String()
}

// ensureTrailingNewline 保证文本以换行结尾，避免追加时与后续块粘连。
func ensureTrailingNewline(text string) string {
	if strings.HasSuffix(text, "\n") {
		return text
	}
	return text + "\n"
}

// countLines 统计文本行数：末尾换行不计为额外空行，空文本为 0 行。
func countLines(text string) int {
	if text == "" {
		return 0
	}
	n := strings.Count(text, "\n")
	if !strings.HasSuffix(text, "\n") {
		n++
	}
	return n
}
