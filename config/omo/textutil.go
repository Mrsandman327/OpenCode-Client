package omo

// 本文件收纳 slim.go 复用的 JSONC 文本工具函数。
// 这些函数原位于 model.go（oh-my-openagent 旧实现），随旧实现清理迁移至此。

import (
	"fmt"
	"regexp"
	"strings"
)

// isObjectKeyLine 判断整行是否为 `"key": {` 形式的对象键行。
func isObjectKeyLine(line, key string) bool {
	pattern := fmt.Sprintf(`^"%s"\s*:\s*\{`, regexp.QuoteMeta(key))
	return regexp.MustCompile(pattern).MatchString(strings.TrimSpace(line))
}

// replaceModelValue 用正则子匹配定位，替换匹配中的字符串字面量值。
func replaceModelValue(line string, modelRe *regexp.Regexp, model string) string {
	match := modelRe.FindStringSubmatchIndex(line)
	if len(match) < 4 {
		return line
	}
	return line[:match[3]] + fmt.Sprintf("%q", model) + line[match[1]:]
}

// insertFieldLine 在 afterLine 行之后插入新字段行（如 "variant": "..."）。
// 逗号规则：插入位置后仍有字段则新行带尾逗号；前一行若无逗号且非 { 则自动补逗号。
func insertFieldLine(lines []string, afterLine int, key, value string) []string {
	indent := leadingWhitespace(lines[afterLine])
	if indent == "" {
		indent = "  "
	}
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

// leadingWhitespace 返回行首空白（空格/制表符）。
func leadingWhitespace(line string) string {
	return line[:len(line)-len(strings.TrimLeft(line, " \t"))]
}

// previousContentLine 返回 before 之前最近的非空行行号；无则 -1。
func previousContentLine(lines []string, before int) int {
	for i := before - 1; i >= 0; i-- {
		if strings.TrimSpace(lines[i]) != "" {
			return i
		}
	}
	return -1
}

// findObjectBlockEnd 从 start 行起寻找大括号深度归零的行（对象块结束行）。
// 深度用 braceDelta 累计（忽略字符串字面量内的括号），避免值里出现括号时误判。
func findObjectBlockEnd(lines []string, start int) (int, error) {
	depth := 0
	for i := start; i < len(lines); i++ {
		depth += braceDelta(lines[i])
		if depth == 0 && i >= start {
			return i, nil
		}
	}
	return -1, fmt.Errorf("未找到配置项闭合括号")
}
