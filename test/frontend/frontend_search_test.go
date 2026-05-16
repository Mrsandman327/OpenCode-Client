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
