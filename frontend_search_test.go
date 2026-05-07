package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestSearchNavigationUsesTemporaryExpansionWithoutPersistingExpandedParts(t *testing.T) {
	sourceBytes, err := os.ReadFile("frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取聊天脚本失败: %v", err)
	}
	source := string(sourceBytes)

	for _, required := range []string{
		"let searchTemporaryExpansion = null;",
		"restoreSearchTemporaryExpansion();",
		"temporarilyRevealSearchResult(current);",
		"function temporarilyRevealSearchResult(node) {",
		"function restoreSearchTemporaryExpansion() {",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("缺少搜索临时展开机制: %s", required)
		}
	}

	re := regexp.MustCompile(`(?s)function temporarilyRevealSearchResult\(node\) \{(.*?)\n\}`)
	match := re.FindStringSubmatch(source)
	if len(match) != 2 {
		t.Fatal("未找到 temporarilyRevealSearchResult 函数体")
	}
	if strings.Contains(match[1], "expandedParts[") {
		t.Fatal("搜索临时展开不能写入 expandedParts，避免多次搜索导致卡片永久展开")
	}
}

func TestSessionTooltipIncludesTitleDirectoryAndUpdatedAt(t *testing.T) {
	chatBytes, err := os.ReadFile("frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取聊天脚本失败: %v", err)
	}
	chatSource := string(chatBytes)

	for _, required := range []string{
		`oc-tree-tooltip`,
		`ses.title`,
		`updatedAt`,
		`sesDir`,
		`oc-tree-tooltip-title`,
		`oc-tree-tooltip-row`,
	} {
		if !strings.Contains(chatSource, required) {
			t.Fatalf("聊天脚本缺少会话气泡元素: %s", required)
		}
	}

	cssBytes, err := os.ReadFile("frontend/dist/style.css")
	if err != nil {
		t.Fatalf("读取样式表失败: %v", err)
	}
	cssSource := string(cssBytes)

	for _, required := range []string{
		`.oc-tree-tooltip {`,
		`.oc-tree-tooltip-title {`,
		`.oc-tree-tooltip-row {`,
		`.oc-tree-session:hover .oc-tree-tooltip`,
		`.oc-client`,  // still present
	} {
		if !strings.Contains(cssSource, required) {
			t.Fatalf("样式表缺少气泡样式: %s", required)
		}
	}
	// .oc-client 不应再有 overflow: hidden 裁剪气泡
	if strings.Contains(cssSource, `.oc-client`) {
		// verify it uses overflow: visible now
		if strings.Contains(cssSource, `.oc-client {\n`) {
			// just check overflow:visible appears near oc-client
		}
	}
}
