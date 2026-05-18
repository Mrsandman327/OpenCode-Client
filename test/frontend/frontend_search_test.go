package frontendtest

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestSearchNavigationUsesTemporaryExpansionWithoutPersistingExpandedParts(t *testing.T) {
	sourceBytes, err := os.ReadFile("../../frontend/dist/chat.js")
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
	chatBytes, err := os.ReadFile("../../frontend/dist/chat.js")
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

	cssBytes, err := os.ReadFile("../../frontend/dist/style.css")
	if err != nil {
		t.Fatalf("读取样式表失败: %v", err)
	}
	cssSource := string(cssBytes)

	for _, required := range []string{
		`.oc-tree-tooltip {`,
		`.oc-tree-tooltip-title {`,
		`.oc-tree-tooltip-row {`,
		`.oc-tree-session:hover .oc-tree-tooltip`,
		`.oc-client`,
	} {
		if !strings.Contains(cssSource, required) {
			t.Fatalf("样式表缺少气泡样式: %s", required)
		}
	}
	if strings.Contains(cssSource, `.oc-client`) {
		if strings.Contains(cssSource, `.oc-client {\n`) {
		}
	}
}

func TestProjectTreeRefreshOnlyOnStructuralSessionEvents(t *testing.T) {
	chatBytes, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取聊天脚本失败: %v", err)
	}
	chatSource := string(chatBytes)

	for _, required := range []string{
		`if (type === 'session.deleted') {`,
		`buildTree();`,
		`const isCurrentSession = sid && sid === currentSessionId;`,
		`if (type === 'session.created' && isCurrentSession) {`,
	} {
		if !strings.Contains(chatSource, required) {
			t.Fatalf("项目树缺少结构性会话事件刷新逻辑: %s", required)
		}
	}

	forbiddenPatterns := map[string]*regexp.Regexp{
		"session.status idle 刷新项目树": regexp.MustCompile(`(?s)if \(type === 'session\.status' && sid\) \{.*?if \(status\?\.type === 'idle'\) \{\s*loadMessages\(\);\s*debounceRefreshTree\(\);`),
		"session.idle 刷新项目树":        regexp.MustCompile(`(?s)if \(type === 'session\.idle' && sid\) \{.*?loadMessages\(\);\s*debounceRefreshTree\(\);`),
		"session.updated 刷新项目树":     regexp.MustCompile(`(?s)if \(type === 'session\.updated'\) \{\s*loadDiff\(\);\s*debounceRefreshTree\(\);`),
	}

	for name, pattern := range forbiddenPatterns {
		if pattern.MatchString(chatSource) {
			t.Fatalf("会话过程事件不应触发项目树刷新: %s", name)
		}
	}

	createdRefreshRe := regexp.MustCompile(`(?s)if \(type === 'session\.created' \|\| type === 'session\.deleted'\) \{\s*buildTree\(\);`)
	if createdRefreshRe.MatchString(chatSource) {
		t.Fatal("session.created 不应再无条件触发项目树刷新")
	}
}

func TestProviderSaveIncludesNpmSelection(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/provider-view.js")
	if err != nil {
		t.Fatalf("读取供应商脚本失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"const npmSelect = card.querySelector('.prov-edit-npm');",
		"const selectedNpm = npmSelect?.value || '';",
		"const rawNpm = npmSelect?.dataset.rawNpm || '';",
		"npm: selectedNpm === PROVIDER_NPM_UNMATCHED ? rawNpm : selectedNpm,",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("供应商脚本缺少接口格式保存线索: %s", required)
		}
	}
}

func TestProviderViewIncludesNpmFormatOptions(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/provider-view.js")
	if err != nil {
		t.Fatalf("读取供应商脚本失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"const PROVIDER_NPM_OPTIONS = [",
		"@ai-sdk/openai",
		"@ai-sdk/openai-compatible",
		"@ai-sdk/anthropic",
		"@ai-sdk/amazon-bedrock",
		"@ai-sdk/google",
		"OpenAI Responses",
		"OpenAI Compatible",
		"Anthropic",
		"Amazon Bedrock",
		"Google (Gemini)",
		"const PROVIDER_NPM_UNMATCHED = '__unmatched__';",
		"未匹配保留",
		"npm: '@ai-sdk/openai-compatible'",
		"npmRaw: '@ai-sdk/openai-compatible'",
		"const matchedOption = PROVIDER_NPM_OPTIONS.find(item => item.value === (p.npm || ''));",
		"const selectedNpmValue = matchedOption ? matchedOption.value : PROVIDER_NPM_UNMATCHED;",
		"<option value=\"${PROVIDER_NPM_UNMATCHED}\" selected>未匹配保留</option>",
		"data-raw-npm=\"${escapeHtml(p.npm || '')}\"",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("供应商脚本缺少接口格式选项: %s", required)
		}
	}
}

func TestOmoSchemeSaveMergesHiddenFields(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/omo-config.js")
	if err != nil {
		t.Fatalf("读取 OMO 脚本失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"let saveBaseConfigJson = {};",
		"function buildMergedConfigForSave() {",
		"const merged = JSON.parse(JSON.stringify(saveBaseConfigJson || {}));",
		"for (const type of modelTypes) {",
		"delete merged[type];",
		"JSON.stringify(buildMergedConfigForSave(), null, 2)",
		"api.SaveFullConfig(",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("OMO 保存脚本缺少保存合并逻辑: %s", required)
		}
	}
}

func TestOmoSchemeSwitchUpdatesSaveBaseConfig(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/omo-config.js")
	if err != nil {
		t.Fatalf("读取 OMO 脚本失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"saveBaseConfigJson = JSON.parse(JSON.stringify(fullConfigJson || {}));",
		"saveBaseConfigJson = JSON.parse(JSON.stringify(data || {}));",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("OMO 方案切换后未更新保存基底: %s", required)
		}
	}
}

func TestOmoSaveButtonUsesHandleSchemeApply(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/main.js")
	if err != nil {
		t.Fatalf("读取 main.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"if (typeof handleSchemeApply === 'function') {",
		"await handleSchemeApply();",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("OMO 保存按钮未统一走 handleSchemeApply: %s", required)
		}
	}

	forbidden := regexp.MustCompile(`(?s)document\.getElementById\('modelActions'\)\.addEventListener\('click', async \(e\) => \{.*?const result = await api\.UpdateModels\(modelEntries\);`)
	if forbidden.MatchString(source) {
		t.Fatal("OMO 保存按钮不应再直接调用 api.UpdateModels(modelEntries)")
	}
}

func TestOmoSaveApplyKeepsButtonFeedback(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/omo-config.js")
	if err != nil {
		t.Fatalf("读取 OMO 脚本失败: %v", err)
	}
	source := string(js)
	lowerSource := strings.ToLower(source)

	for _, required := range []string{
		"showtoast('保存中...', 'info');",
		"btn.disabled = true;",
		"btn.textcontent = '⏳ 保存中...';",
		"btn.disabled = false;",
		"btn.textcontent = '💾 保存';",
		"已保存 ",
		"rendermodelconfig();",
	} {
		if !strings.Contains(lowerSource, strings.ToLower(required)) {
			t.Fatalf("OMO 保存交互缺少线索: %s", required)
		}
	}
}

func TestOmoSchemeSwitchDoesNotSwallowLoadErrors(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/omo-config.js")
	if err != nil {
		t.Fatalf("读取 OMO 脚本失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"showToast('方案加载失败: ' + (e.message || e), 'error');",
		"return true;",
		"return false;",
		"await loadSchemeIntoEditor(name);",
		"if (ok) {",
		"showToast('已加载方案: ' + name, 'success');",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("方案切换缺少失败传播或成功保护逻辑: %s", required)
		}
	}
}

func TestSkillBrowserUsesUnifiedInAppViewerInsteadOfSystemOpen(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/skill-manager.js")
	if err != nil {
		t.Fatalf("读取技能脚本失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"await openSkillFileBrowser(skillPath);",
		"await api.ListSkillFiles(skillPath);",
		"await api.ReadSkillFile(skillPath, relativePath);",
		"skill-file-browser",
		"skill-file-tree",
		"skill-file-preview",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("技能脚本缺少统一站内浏览器线索: %s", required)
		}
	}

	forbidden := regexp.MustCompile(`(?s)function openSkillDir\(skillPath\) \{.*?api\.OpenDir\(skillPath\)`)
	if forbidden.MatchString(source) {
		t.Fatal("技能管理打开行为不应再调用 api.OpenDir")
	}
}

func TestSkillManagerMainNoLongerHidesOpenButtonInBrowserRuntime(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/main.js")
	if err != nil {
		t.Fatalf("读取 main.js 失败: %v", err)
	}
	source := string(js)

	if !strings.Contains(source, "openGlobalDirBtn.style.display = 'none'") {
		t.Fatal("main.js 应在浏览器运行时隐藏技能管理全局目录打开按钮")
	}

	if strings.Contains(source, "if (isWebRuntime()) {") {
		t.Fatal("main.js 不应依赖 skill-manager.js 的 isWebRuntime 早期判断桌面/Web 环境")
	}
}

func TestSkillManagerGlobalOpenUsesDesktopOpenDirInsteadOfSkillBrowser(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/main.js")
	if err != nil {
		t.Fatalf("读取 main.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"await api.OpenDir(path);",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("main.js 缺少桌面端全局目录打开链路: %s", required)
		}
	}

	forbidden := regexp.MustCompile(`(?s)document\.getElementById\('btnOpenDir'\).*?openSkillDir\(path\)`)
	if forbidden.MatchString(source) {
		t.Fatal("btnOpenDir 不应再走 openSkillDir(path)")
	}
}

func TestMainHidesWorkspaceToolbarButtonsInBrowserRuntime(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/main.js")
	if err != nil {
		t.Fatalf("读取 main.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"var btnFrontendWebConfig = document.getElementById('btnFrontendWebConfig');",
		"var btnWtOpen = document.getElementById('btnWtOpen');",
		"btnFrontendWebConfig.style.display = 'none';",
		"btnWtOpen.style.display = 'none';",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("main.js 缺少 Web 端工作区工具栏隐藏逻辑: %s", required)
		}
	}
}

func TestWebDirectoryBrowserModalIsWiredForProjectTreeAddAction(t *testing.T) {
	htmlBytes, err := os.ReadFile("../../frontend/dist/index.html")
	if err != nil {
		t.Fatalf("读取 index.html 失败: %v", err)
	}
	html := string(htmlBytes)
	for _, required := range []string{
		`id="dirBrowserModal"`,
		`id="dirBrowserPath"`,
		`id="dirBrowserList"`,
		`id="btnDirBrowserSelect"`,
		`id="btnDirBrowserBack"`,
		`id="btnDirBrowserClose"`,
	} {
		if !strings.Contains(html, required) {
			t.Fatalf("index.html 缺少目录浏览弹窗元素: %s", required)
		}
	}

	js, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	source := string(js)
	for _, required := range []string{
		"async function openDirBrowserModal() {",
		"return new Promise((resolve, reject) => {",
		"dirBrowserResolver = resolve;",
		"dirBrowserRejecter = reject;",
		"async function loadDirBrowserList(path) {",
		"await api.ListBrowsableDirs(path || '');",
		"async function selectDirBrowserCurrent() {",
		"if (isBrowserRuntimeForMain()) {",
		"await openDirBrowserModal();",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat.js 缺少 Web 目录浏览器接线: %s", required)
		}
	}
}

func TestApiDocTabIncludesSearchBarAndEmptyState(t *testing.T) {
	htmlBytes, err := os.ReadFile("../../frontend/dist/index.html")
	if err != nil {
		t.Fatalf("读取 index.html 失败: %v", err)
	}
	html := string(htmlBytes)

	for _, required := range []string{
		`id="apiDocSearchBar"`,
		`id="apiDocSearch"`,
		`placeholder="输入关键字过滤 API 文档..."`,
		`未找到匹配的 API 接口`,
	} {
		if !strings.Contains(html, required) {
			t.Fatalf("API 文档 Tab 缺少搜索栏或空态线索: %s", required)
		}
	}
}

func TestApiDocSearchUsesKeywordStateAndFieldFiltering(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/assets/commands-view.js")
	if err != nil {
		t.Fatalf("读取 commands-view.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"let apiDocKeyword = '';",
		"function filterApiDocsEntries(entries) {",
		"const keyword = apiDocKeyword.trim().toLowerCase();",
		"const summary = (detail.summary || '').toLowerCase();",
		"const description = (detail.description || '').toLowerCase();",
		"const lowerPath = (path || '').toLowerCase();",
		"lowerPath.indexOf(keyword) >= 0",
		"summary.indexOf(keyword) >= 0",
		"description.indexOf(keyword) >= 0",
		"未找到匹配的 API 接口",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("API 文档搜索缺少关键实现线索: %s", required)
		}
	}

	for _, forbidden := range []string{
		"lowerTag.indexOf(keyword) >= 0",
		"parameterNames.some(",
	} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("API 文档搜索不应再匹配非目标字段: %s", forbidden)
		}
	}
}

func TestSidebarCollapseIncludesDefaultCollapsedStructure(t *testing.T) {
	htmlBytes, err := os.ReadFile("../../frontend/dist/index.html")
	if err != nil {
		t.Fatalf("读取 index.html 失败: %v", err)
	}
	html := string(htmlBytes)

	for _, required := range []string{
		`id="sidebar"`,
		`app-title`,
	} {
		if !strings.Contains(html, required) {
			t.Fatalf("index.html 缺少侧边栏折叠基础结构: %s", required)
		}
	}

	cssBytes, err := os.ReadFile("../../frontend/dist/assets/style.css")
	if err != nil {
		t.Fatalf("读取 style.css 失败: %v", err)
	}
	css := string(cssBytes)

	if !strings.Contains(css, "collapsed") {
		t.Fatal("style.css 缺少侧边栏默认折叠样式线索: collapsed")
	}
}

func TestSidebarCollapseUsesLocalStorageAndTitleHints(t *testing.T) {
	htmlBytes, err := os.ReadFile("../../frontend/dist/index.html")
	if err != nil {
		t.Fatalf("读取 index.html 失败: %v", err)
	}
	html := string(htmlBytes)

	for _, required := range []string{
		`title="工作区"`,
		`title="供应商配置"`,
	} {
		if !strings.Contains(html, required) {
			t.Fatalf("index.html 缺少侧边栏折叠提示线索: %s", required)
		}
	}

	js, err := os.ReadFile("../../frontend/dist/assets/navigation.js")
	if err != nil {
		js, err = os.ReadFile("../../frontend/dist/assets/main.js")
		if err != nil {
			t.Fatalf("读取 navigation.js/main.js 失败: %v", err)
		}
	}
	source := string(js)

	for _, required := range []string{
		"localStorage",
		"sidebarCollapsed",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("导航脚本缺少侧边栏折叠持久化线索: %s", required)
		}
	}
}

func TestTreePanelResizeIncludesHandleAndWidthStateHints(t *testing.T) {
	htmlBytes, err := os.ReadFile("../../frontend/dist/index.html")
	if err != nil {
		t.Fatalf("读取 index.html 失败: %v", err)
	}
	html := string(htmlBytes)

	for _, required := range []string{
		`id="ocSessions"`,
		`id="btnToggleSessions"`,
		`id="ocTreeResizeHandle"`,
	} {
		if !strings.Contains(html, required) {
			t.Fatalf("index.html 缺少项目树拖拽结构线索: %s", required)
		}
	}

	js, err := os.ReadFile("../../frontend/dist/assets/chat-session.js")
	if err != nil {
		t.Fatalf("读取 chat-session.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"treePanelWidth",
		"240",
		"180",
		"420",
		"loadTreePanelWidth",
		"applyTreePanelWidth",
		"persistTreePanelWidth",
		"initTreePanelResize",
		"pointerdown",
		"pointermove",
		"pointerup",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat-session.js 缺少项目树拖拽状态或事件线索: %s", required)
		}
	}
}

func TestTreePanelResizeKeepsCollapseButtonAndHoverHandleStyles(t *testing.T) {
	htmlBytes, err := os.ReadFile("../../frontend/dist/index.html")
	if err != nil {
		t.Fatalf("读取 index.html 失败: %v", err)
	}
	html := string(htmlBytes)
	if !regexp.MustCompile(`(?s)<aside class="oc-sessions" id="ocSessions">.*id="ocTreeResizeHandle"`).MatchString(html) {
		t.Fatal("拖拽手柄应挂在 ocSessions 内部右边缘，而不是独立放在 grid 流里")
	}

	cssBytes, err := os.ReadFile("../../frontend/dist/assets/style.css")
	if err != nil {
		t.Fatalf("读取 style.css 失败: %v", err)
	}
	css := string(cssBytes)

	for _, required := range []string{
		`.oc-tree-resize-handle {`,
		`position: absolute;`,
		`.oc-tree-resize-handle:hover {`,
		`.oc-tree-resize-handle.dragging {`,
		`.oc-client.tree-resizing {`,
		`transition: none;`,
		`.oc-client.hide-left .oc-tree-resize-handle {`,
		`.oc-toggle-left {`,
	} {
		if !strings.Contains(css, required) {
			t.Fatalf("style.css 缺少项目树拖拽样式线索: %s", required)
		}
	}

	mobileBytes, err := os.ReadFile("../../frontend/dist/assets/chat-mobile.js")
	if err != nil {
		t.Fatalf("读取 chat-mobile.js 失败: %v", err)
	}
	mobile := string(mobileBytes)
	for _, required := range []string{
		"toggleSessions()",
		"client.classList.toggle('hide-left')",
	} {
		if !strings.Contains(mobile, required) {
			t.Fatalf("现有完全收起逻辑线索缺失: %s", required)
		}
	}
}

func TestSidepanelResizeIncludesHandleAndWidthStateHints(t *testing.T) {
	htmlBytes, err := os.ReadFile("../../frontend/dist/index.html")
	if err != nil {
		t.Fatalf("读取 index.html 失败: %v", err)
	}
	html := string(htmlBytes)

	for _, required := range []string{
		`class="oc-sidepanel"`,
		`id="btnToggleSidepanel"`,
		`id="ocSidepanelResizeHandle"`,
	} {
		if !strings.Contains(html, required) {
			t.Fatalf("index.html 缺少右侧面板拖拽结构线索: %s", required)
		}
	}

	js, err := os.ReadFile("../../frontend/dist/assets/chat-session.js")
	if err != nil {
		t.Fatalf("读取 chat-session.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"sidepanelWidth",
		"320",
		"220",
		"420",
		"loadSidepanelWidth",
		"applySidepanelWidth",
		"persistSidepanelWidth",
		"initSidepanelResize",
		"pointerdown",
		"pointermove",
		"pointerup",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat-session.js 缺少右侧面板拖拽状态或事件线索: %s", required)
		}
	}
}

func TestSidepanelResizeKeepsCollapseButtonAndHoverHandleStyles(t *testing.T) {
	cssBytes, err := os.ReadFile("../../frontend/dist/assets/style.css")
	if err != nil {
		t.Fatalf("读取 style.css 失败: %v", err)
	}
	css := string(cssBytes)

	for _, required := range []string{
		`.oc-sidepanel-resize-handle {`,
		`.oc-sidepanel-resize-handle:hover {`,
		`.oc-sidepanel-resize-handle.dragging {`,
		`.oc-client.hide-right .oc-sidepanel-resize-handle {`,
		`.oc-toggle-right {`,
	} {
		if !strings.Contains(css, required) {
			t.Fatalf("style.css 缺少右侧面板拖拽样式线索: %s", required)
		}
	}

	mobileBytes, err := os.ReadFile("../../frontend/dist/assets/chat-mobile.js")
	if err != nil {
		t.Fatalf("读取 chat-mobile.js 失败: %v", err)
	}
	mobile := string(mobileBytes)
	for _, required := range []string{
		"toggleSidepanel()",
		"client.classList.toggle('hide-right')",
	} {
		if !strings.Contains(mobile, required) {
			t.Fatalf("现有右侧完全收起逻辑线索缺失: %s", required)
		}
	}
}

func TestCreateNewSessionUsesDirectoryBrowserInWebMode(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"if (isBrowserRuntimeForMain()) {",
		"const dir = await openDirBrowserModal();",
		"pendingWorkDir = dir;",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat.js 缺少新建会话复用目录浏览器线索: %s", required)
		}
	}

	closeAfterSelect := regexp.MustCompile(`(?s)async function createNewSession\(\) \{.*?pendingWorkDir = dir;.*?if \(isMobileTreeMode\(\)\) \{\s*closeMobileTree\(\);\s*\}`)
	if !closeAfterSelect.MatchString(source) {
		t.Fatal("手机端新建话题成功后应在 createNewSession 中自动收起项目树")
	}

}

func TestMobileProjectTreeDrawerFullyHidesAndDoesNotBlockModals(t *testing.T) {
	cssBytes, err := os.ReadFile("../../frontend/dist/style.css")
	if err != nil {
		t.Fatalf("读取 style.css 失败: %v", err)
	}
	css := string(cssBytes)
	for _, required := range []string{
		`left: 0;`,
		`width: min(70vw, 320px);`,
		`.oc-client.mobile-tree-open .oc-mobile-tree-mask {`,
		`z-index: 205;`,
		`.modal-overlay {`,
	} {
		if !strings.Contains(css, required) {
			t.Fatalf("style.css 缺少手机端抽屉完全隐藏或弹窗层级线索: %s", required)
		}
	}

	jsBytes, err := os.ReadFile("../../frontend/dist/main.js")
	if err != nil {
		t.Fatalf("读取 main.js 失败: %v", err)
	}
	js := string(jsBytes)
	for _, required := range []string{
		`if (e.target.closest('.modal-overlay')) return;`,
	} {
		if !strings.Contains(js, required) {
			t.Fatalf("main.js 缺少弹窗输入保护逻辑: %s", required)
		}
	}
}

func TestMobileSessionSwitchClosesDrawerBeforeAwaitingLoad(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"if (sid && sid !== currentSessionId) {",
		"if (isMobileTreeMode()) {",
		"closeMobileTree();",
		"await switchSession(sid);",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat.js 缺少手机端异步切换会话线索: %s", required)
		}
	}

	wrongOrder := regexp.MustCompile(`(?s)await switchSession\(sid\);\s*closeMobileTree\(\);`)
	if wrongOrder.MatchString(source) {
		t.Fatal("手机端会话切换不应在 await switchSession 之后才关闭抽屉")
	}
}

func TestMobileLongSessionLimitsInitialRenderedMessages(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"const MOBILE_MESSAGE_RENDER_LIMIT = 30;",
		"const MOBILE_MESSAGE_LOAD_MORE_STEP = 20;",
		"function trimMessagesForMobile(items) {",
		"return list.slice(-getVisibleMessageCount());",
		"function getVisibleMessageCount() {",
		"function renderCollapsedHistoryNotice(totalCount, hiddenCount) {",
		"已折叠较早消息，点击加载更多",
		"visibleMessageCount += MOBILE_MESSAGE_LOAD_MORE_STEP;",
		"const sourceList = (items || []).map(normalizeMessageItem).filter(item => !isInternalUserMessage(item));",
		"const list = trimMessagesForMobile(sourceList);",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat.js 缺少手机端长会话限量渲染线索: %s", required)
		}
	}
}

func TestSessionSelectionUsesImmediateLoadingInsteadOfAwaitingMessages(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"document.getElementById('ocMessages').innerHTML = '<div class=\"oc-empty\">正在加载会话消息...</div>';",
		"loadMessages().then(() => {",
		"if (id !== currentSessionId) return;",
		"smartScroll(document.getElementById('ocMessages'), true);",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat.js 缺少异步切换会话线索: %s", required)
		}
	}

}

func TestMobileSendPromptUsesLightweightPendingInsteadOfFullRerender(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"function renderPendingAssistantPlaceholder(sessionID) {",
		"if (isMobileTreeMode()) {",
		"renderPendingAssistantPlaceholder(currentSessionId);",
		"} else {",
		"renderCachedMessages(currentSessionId);",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat.js 缺少轻量 pending 渲染线索: %s", required)
		}
	}
}

func TestMobileWindowedRenderUsesFullMessageCountForIncrementalBranch(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"let lastSourceMessageCount = 0;",
		"const sameCount = sourceList.length === lastSourceMessageCount;",
		"lastSourceMessageCount = sourceList.length;",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat.js 缺少全量消息计数保护线索: %s", required)
		}
	}

	forbidden := regexp.MustCompile(`const sameCount = list\.length === lastMessageCount;`)
	if forbidden.MatchString(source) {
		t.Fatal("窗口化渲染下不应再用裁剪后条数判断 sameCount")
	}
}

func TestAssistantMessageLevelErrorTextIsRenderedInsteadOfEmptyCard(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"const messageErrorText = info.error?.message || info.error?.data?.message || '';",
		"errEl.textContent = messageErrorText;",
		"empty.textContent = messageErrorText || (info.time?.completed ? '已停止或本次未产生回复内容' : '正在等待模型回复...');",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat.js 缺少 message 级 error 文本渲染线索: %s", required)
		}
	}
}

func TestAssistantMessageLevelErrorTextRendersEvenWhenPartsExist(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"const messageErrorText = info.error?.message || info.error?.data?.message || '';",
		"if (messageErrorText) {",
		"body.appendChild(errEl);",
		"partList.forEach(part => body.appendChild(renderPart(part)));",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat.js 缺少 parts 非空时的 message 级 error 渲染线索: %s", required)
		}
	}
}

func TestStreamingDiagnosticsHooksExist(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	source := string(js)
	for _, required := range []string{
		"const STREAM_DEBUG_KEY = 'oc-stream-debug';",
		"function logStreamDebug(kind, payload) {",
		"window.__ocStreamDebug = streamDebugBuffer;",
		"logStreamDebug('event:part.updated'",
		"logStreamDebug('event:part.delta'",
		"logStreamDebug('cache:upsertPart'",
		"logStreamDebug('cache:applyPartDelta'",
		"logStreamDebug('render:branch'",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat.js 缺少流式诊断线索: %s", required)
		}
	}
}

func TestRenderTextPartFallsBackToExtractPartText(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"function renderTextPart(part) {",
		"const text = (part && (part.text || part.content || part.message || part.value)) || '';",
		"el.innerHTML = typeof marked !== 'undefined'",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat.js 缺少 text part 回退字段渲染线索: %s", required)
		}
	}

	if strings.Contains(source, "const text = extractPartText(part);") {
		t.Fatal("renderTextPart 不应再直接回退到 extractPartText(part)，否则会把仅含 metadata 的 part 渲染成原始 JSON")
	}
}

func TestCacheMessagesMergesInfoAndPartsDuringBusyState(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"function mergeMessage(existing, incoming) {",
		"existing[existingIndex] = mergeMessage(existing[existingIndex], item);",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat.js 缺少 busy 状态下完整合并消息线索: %s", required)
		}
	}

	forbidden := regexp.MustCompile(`existing\[existingIndex\]\.info = \{ \.\.\.existing\[existingIndex\]\.info, \.\.\.item\.info \};`)
	if forbidden.MatchString(source) {
		t.Fatal("busy 状态下不应只合并 info 而忽略 parts")
	}
}

func TestMergeMessagePreservesExistingPartsWhenIncomingListIsPartial(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"const mergedParts = [...existingParts];",
		"for (const part of incomingParts) {",
		"const existingIndex = mergedParts.findIndex(old => old.id && old.id === part.id);",
		"mergedParts.push(part);",
		"parts: mergedParts,",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat.js 缺少保留旧 parts 的合并线索: %s", required)
		}
	}
}

func TestStreamingIncrementalBranchOnlyReplacesWhenPartSetMatches(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"if (sameCount && list.length > 0 && webRunning && isSessionBusy(currentSessionId)) {",
		"body.replaceChildren(...partList.map(part => renderPart(part)));",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat.js 缺少更严格的流式 part 集判断线索: %s", required)
		}
	}
}

func TestMergePartPreservesOrAppendsStreamingTextInsteadOfOverwriting(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"if (oldText && newText && newText.length < oldText.length && !incoming.time?.end) {",
		"merged[field] = oldText;",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat.js 缺少流式文本累积合并线索: %s", required)
		}
	}
}

func TestSkillBrowserSupportsEditableTextFlow(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/skill-manager.js")
	if err != nil {
		t.Fatalf("读取技能脚本失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"isEditing: false",
		"await api.SaveSkillFile(skillPath, relativePath, text);",
		"currentSkillBrowserState.isEditing = true;",
		"currentSkillBrowserState.isEditing = false;",
		"renderSkillBrowserPreview(result.path || relativePath, result.content || '');",
		"renderSkillBrowserEditor(relativePath, result.content || '');",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("技能脚本缺少统一编辑保存线索: %s", required)
		}
	}

	forbidden := regexp.MustCompile(`Web 端技能浏览为只读模式`)
	if forbidden.MatchString(source) {
		t.Fatal("统一技能浏览器不应再保留 Web 只读提示分流")
	}

	for _, forbiddenSnippet := range []string{
		"SaveSkillContent(",
		"ReadSkillContent(",
		"showSkillModal(",
		"saveDesktopSkillEdit(",
	} {
		if strings.Contains(source, forbiddenSnippet) {
			t.Fatalf("统一技能浏览器不应再保留旧双流逻辑: %s", forbiddenSnippet)
		}
	}
}

func TestWebSkillBrowserAvoidsStalePreviewOverwrite(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/skill-manager.js")
	if err != nil {
		t.Fatalf("读取技能脚本失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"previewRequestId: 0",
		"var requestId = ++currentSkillBrowserState.previewRequestId;",
		"if (!currentSkillBrowserState || currentSkillBrowserState.skillPath !== skillPath || currentSkillBrowserState.selectedPath !== relativePath || currentSkillBrowserState.previewRequestId !== requestId) return;",
		"currentSkillBrowserState.previewRequestId++;",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("技能脚本缺少预览竞态保护线索: %s", required)
		}
	}
}

func TestSkillBrowserRemovesDetailsButtonAndUsesRenderedMarkdownPreview(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/skill-manager.js")
	if err != nil {
		t.Fatalf("读取技能脚本失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"renderSkillBrowserPreview(result.path || relativePath, result.content || '');",
		"sanitizeMarkedHtml(marked.parse(content))",
		"function sanitizeMarkedHtml(html) {",
		"allowedTags = new Set(",
		"template.innerHTML = html;",
		"function isMarkdownFile(path) {",
		"function renderSkillBrowserEditor(relativePath, content) {",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("技能脚本缺少 Markdown 预览线索: %s", required)
		}
	}

	if strings.Contains(source, "详情</button>") {
		t.Fatal("技能列表不应再渲染详情按钮")
	}

	forbidden := regexp.MustCompile(`preview\.innerHTML\s*=\s*.*marked\.parse\(content\)`)
	if forbidden.MatchString(source) {
		t.Fatal("Markdown 预览不应将 marked 输出直接注入 innerHTML")
	}
}

func TestSkillBrowserSupportsSelectionHighlightAndDirectoryCollapse(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/skill-manager.js")
	if err != nil {
		t.Fatalf("读取技能脚本失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"collapsedDirs: {}",
		"toggleSkillDirCollapse(path)",
		"currentSkillBrowserState.collapsedDirs[path] = !currentSkillBrowserState.collapsedDirs[path];",
		"var isSelected = currentSkillBrowserState && currentSkillBrowserState.selectedPath === node.path;",
		"skill-file-node-selected",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("技能脚本缺少高亮或折叠线索: %s", required)
		}
	}
}

func TestSkillBrowserPrioritizesSkillMDAtTopAndAsDefaultPreview(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/skill-manager.js")
	if err != nil {
		t.Fatalf("读取技能脚本失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"if (node.type === 'file' && node.name === 'SKILL.md') {",
		"return node;",
		"if (leftName === 'SKILL.md' || rightName === 'SKILL.md') {",
		"return leftName === 'SKILL.md' ? -1 : 1;",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("技能脚本缺少 SKILL.md 优先逻辑: %s", required)
		}
	}
}

func TestSkillBrowserStylesEmphasizeSelectionAndPrimaryFile(t *testing.T) {
	css, err := os.ReadFile("../../frontend/dist/style.css")
	if err != nil {
		t.Fatalf("读取 style.css 失败: %v", err)
	}
	source := string(css)

	for _, required := range []string{
		`.skill-file-node-selected {`,
		`.skill-file-node-selected:hover {`,
		`.skill-file-primary-badge {`,
		`.skill-file-dir-toggle {`,
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("style.css 缺少技能树高亮或主文件标识样式: %s", required)
		}
	}
}

func TestSkillBrowserRemovesInlineOnclickAndUsesDelegatedDataActions(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/skill-manager.js")
	if err != nil {
		t.Fatalf("读取技能脚本失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"data-skill-path=",
		"data-action=\"open-skill\"",
		"data-action=\"select-skill-file\"",
		"data-action=\"toggle-dir\"",
		"function bindSkillManagerEvents() {",
		"target.closest('[data-action]')",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("技能脚本缺少安全事件绑定线索: %s", required)
		}
	}

	if strings.Contains(source, "onclick=") {
		t.Fatal("技能脚本不应再生成 inline onclick 事件")
	}
}

func TestSkillBrowserProtectsDirtyEditsBeforeDiscarding(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/skill-manager.js")
	if err != nil {
		t.Fatalf("读取技能脚本失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"isDirty: false",
		"function markSkillBrowserDirtyState() {",
		"currentSkillBrowserState.isDirty = textarea.value !== currentSkillBrowserState.originalContent;",
		"function confirmDiscardSkillBrowserChanges(actionLabel) {",
		"return window.confirm('当前编辑内容尚未保存，确定要' + actionLabel + '吗？');",
		"if (!confirmDiscardSkillBrowserChanges('切换文件')) return;",
		"if (!confirmDiscardSkillBrowserChanges('取消编辑')) return;",
		"if (!confirmDiscardSkillBrowserChanges('关闭浏览器')) return;",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("技能脚本缺少未保存保护线索: %s", required)
		}
	}
}

func TestApiMockIncludesSaveSkillFileForUnifiedBrowserEditing(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/api-mock.js")
	if err != nil {
		t.Fatalf("读取 api-mock.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"SaveSkillFile: async (skillPath, relativePath, content) => ({",
		"ReadSkillFile: async (skillPath, relativePath) => ({",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("api-mock.js 缺少统一技能编辑接口线索: %s", required)
		}
	}
}

func TestApiMockIncludesBrowserHttpFallbackForCoreSessionFlows(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/api-mock.js")
	if err != nil {
		t.Fatalf("读取 api-mock.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"const webApiHandlers = {",
		"return webApi[prop];",
		"fetch('/api/project-tree?knownDirs=' + encodeURIComponent(knownDirs || '[]'))",
		"fetch('/api/open-code'",
		"fetch('/api/session/create'",
		"fetch('/api/models'",
		"fetch('/api/open-code-events/start'",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("api-mock.js 缺少浏览器 HTTP 回退线索: %s", required)
		}
	}
}

func TestChatEventStreamSupportsBrowserSSE(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"if (window.runtime && !startEventStream.bound)",
		"new EventSource('/events')",
		"startEventStream.eventSource = es;",
		"es.addEventListener('oc-event'",
		"es.addEventListener('oc-event-error'",
		"es.onerror = () => {",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat.js 缺少浏览器 SSE 事件流线索: %s", required)
		}
	}
}

func TestMainBrowserModeAlsoChecksWebStatus(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/main.js")
	if err != nil {
		t.Fatalf("读取 main.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"if (window.runtime) {",
		"checkWebStatus();",
		"if (!window.runtime) {",
		"loadSkillsData();",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("main.js 缺少浏览器模式初始化线索: %s", required)
		}
	}
}

func TestApiMockIncludesBrowserWebControlFallbacks(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/api-mock.js")
	if err != nil {
		t.Fatalf("读取 api-mock.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"fetch('/api/open-code-web/start'",
		"fetch('/api/open-code-web/status?hostname=' + encodeURIComponent(hostname || '') + '&port=' + encodeURIComponent(String(port || '')))" ,
		"fetch('/api/open-code-web/stop', { method: 'POST' })",
		"fetch('/api/open-code-events/stop', { method: 'POST' })",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("api-mock.js 缺少浏览器 Web 控制回退线索: %s", required)
		}
	}
}

func TestApiMockIncludesGenericBrowserRpcFallbackForManagementPages(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/api-mock.js")
	if err != nil {
		t.Fatalf("读取 api-mock.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"const webApi = new Proxy(",
		"fetch('/api/app-call'",
		"body: JSON.stringify({ method: String(prop), args })",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("api-mock.js 缺少管理页浏览器 RPC 回退线索: %s", required)
		}
	}
}

func TestIndexIncludesFrontendWebControls(t *testing.T) {
	htmlBytes, err := os.ReadFile("../../frontend/dist/index.html")
	if err != nil {
		t.Fatalf("读取 index.html 失败: %v", err)
	}
	html := string(htmlBytes)

	for _, required := range []string{
		`id="btnFrontendWebConfig"`,
		`id="frontendWebModal"`,
		`id="btnSaveFrontendWeb"`,
		`id="btnCloseFrontendWebModal"`,
		`id="frontendWebHost"`,
		`id="frontendWebPort"`,
		`id="frontendWebStatus"`,
		`id="frontendWebUrl"`,
	} {
		if !strings.Contains(html, required) {
			t.Fatalf("index.html 缺少页面 Web 控制元素: %s", required)
		}
	}

	for _, forbidden := range []string{
		`id="btnStartFrontendWeb"`,
		`id="ocFrontendWebStatus"`,
		`id="ocFrontendWebUrl"`,
	} {
		if strings.Contains(html, forbidden) {
			t.Fatalf("index.html 不应再保留工作区常驻页面 Web 控件: %s", forbidden)
		}
	}
}

func TestChatIncludesFrontendWebControlLogic(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"let frontendWebURL = '';",
		"async function checkFrontendWebStatus() {",
		"async function startFrontendWeb() {",
		"async function stopFrontendWeb() {",
		"function showFrontendWebModal() {",
		"function closeFrontendWebModal() {",
		"const host = document.getElementById('frontendWebHost')?.value.trim() || '127.0.0.1';",
		"const port = document.getElementById('frontendWebPort')?.value.trim() || '8081';",
		"const result = await api.StartFrontendWeb(",
		"const result = await api.GetFrontendWebStatus(host, port);",
		"await api.StopFrontendWeb();",
		"renderFrontendWebStatus();",
		"statusEl.textContent = frontendWebRunning ? '运行中' : '未启动';",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("chat.js 缺少页面 Web 控制逻辑: %s", required)
		}
	}
}

func TestApiMockGenericBrowserRpcThrowsOnHttpFailure(t *testing.T) {
	js, err := os.ReadFile("../../frontend/dist/api-mock.js")
	if err != nil {
		t.Fatalf("读取 api-mock.js 失败: %v", err)
	}
	source := string(js)

	for _, required := range []string{
		"if (!resp.ok) {",
		"const err = await resp.json().catch(() => null);",
		"throw new Error((err && (err.error || err.message)) || ('HTTP ' + resp.status));",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("api-mock.js 缺少通用 RPC 错误处理线索: %s", required)
		}
	}
}

func TestMobileProjectTreeDrawerUsesOverlayLayout(t *testing.T) {
	htmlBytes, err := os.ReadFile("../../frontend/dist/index.html")
	if err != nil {
		t.Fatalf("读取 index.html 失败: %v", err)
	}
	html := string(htmlBytes)

	for _, required := range []string{
		`id="btnMobileTree"`,
		`☰`,
		`id="ocMobileTreeMask"`,
	} {
		if !strings.Contains(html, required) {
			t.Fatalf("index.html 缺少手机端项目树抽屉元素: %s", required)
		}
	}

	cssBytes, err := os.ReadFile("../../frontend/dist/style.css")
	if err != nil {
		t.Fatalf("读取 style.css 失败: %v", err)
	}
	css := string(cssBytes)

	for _, required := range []string{
		`@media (max-width: 800px) {`,
		`.oc-toolbar {`,
		`display: none;`,
		`.oc-client {`,
		`grid-template-columns: 1fr;`,
		`.oc-sessions {`,
		`position: fixed;`,
		`transform: translateX(-100%);`,
		`width: min(70vw, 320px);`,
		`rgba(0,0,0,0.3)`,
		`.oc-sidepanel {`,
		`display: none;`,
		`.sidebar {`,
		`display: none;`,
		`.oc-messages {`,
		`contain: layout paint style;`,
		`.oc-chat-head-mobile-toggle {`,
	} {
		if !strings.Contains(css, required) {
			t.Fatalf("style.css 缺少手机端抽屉样式: %s", required)
		}
	}

	chatBytes, err := os.ReadFile("../../frontend/dist/chat.js")
	if err != nil {
		t.Fatalf("读取 chat.js 失败: %v", err)
	}
	chat := string(chatBytes)

	for _, required := range []string{
		`function closeMobileTree() {`,
		`function openMobileTree() {`,
		`function isMobileTreeMode() {`,
		`document.getElementById('webContainer').classList.add('mobile-tree-open');`,
		`document.getElementById('webContainer').classList.remove('mobile-tree-open');`,
		`closeMobileTree();`,
		`await switchSession(sid);`,
	} {
		if !strings.Contains(chat, required) {
			t.Fatalf("chat.js 缺少手机端抽屉逻辑: %s", required)
		}
	}

	mainBytes, err := os.ReadFile("../../frontend/dist/main.js")
	if err != nil {
		t.Fatalf("读取 main.js 失败: %v", err)
	}
	mainSource := string(mainBytes)

	for _, required := range []string{
		"document.getElementById('btnMobileTree').addEventListener('click', toggleMobileTree);",
		"document.getElementById('ocMobileTreeMask').addEventListener('click', closeMobileTree);",
		"document.querySelector('.oc-chat').addEventListener('click', (e) => {",
	} {
		if !strings.Contains(mainSource, required) {
			t.Fatalf("main.js 缺少手机端抽屉事件绑定: %s", required)
		}
	}
}
