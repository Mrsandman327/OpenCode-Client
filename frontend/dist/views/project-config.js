// ============================================================
// project-config.js — 项目配置管理弹窗（Apple 风格）
// ============================================================
// 说明：ES Modules 化改造。core 层依赖静态导入；filebrowser 依赖
// 暂以 typeof 守卫调用，待 filebrowser 改造完成后改为静态 import；
// marked 与 window.ProjectConfigCodeEditor 为全局 lib 符号，保持现状。
import { api } from '../core/apicall.js';
import { escapeHtml, showToast } from '../core/utils.js';
import { fileBrowserSanitizeMarkedHtml, fileBrowserHighlightCode } from '../filebrowser/preview.js';

window._projectConfig = {
    rootDir: '',
    summary: null,
    currentTab: 'coreConfig',
    editingFile: null,
    browseStack: [],   // 导航栈：{category, path}，用于返回上级目录
    editorInstance: null,
    editorMode: 'preview',
    editorInitialContent: '',
    searchButtonSyncTimer: null
};

export function stopProjectConfigSearchButtonSync() {
    var state = window._projectConfig;
    if (state.searchButtonSyncTimer) {
        clearInterval(state.searchButtonSyncTimer);
        state.searchButtonSyncTimer = null;
    }
}

export function isProjectConfigDarkTheme(theme) {
    var current = theme || document.documentElement.getAttribute('data-theme') || 'dark';
    return current === 'dark';
}

export function updateProjectConfigDirtyBadge() {
    var dirtyBadge = document.getElementById('pcEditorDirtyBadge');
    if (!dirtyBadge) {
        return;
    }
    dirtyBadge.style.display = isProjectConfigEditorDirty() ? 'inline' : 'none';
}

export function destroyProjectConfigEditor() {
    var state = window._projectConfig;
    stopProjectConfigSearchButtonSync();
    if (state.editorInstance && window.ProjectConfigCodeEditor) {
        window.ProjectConfigCodeEditor.destroy(state.editorInstance);
    }
    state.editorInstance = null;
    state.editorMode = 'preview';
    state.editorInitialContent = '';
}

export function getProjectConfigEditorContent() {
    var state = window._projectConfig;
    if (state.editorInstance && window.ProjectConfigCodeEditor) {
        return window.ProjectConfigCodeEditor.getValue(state.editorInstance);
    }
    var textarea = document.getElementById('pcEditorTextarea');
    return textarea ? textarea.value : '';
}

export function isProjectConfigEditorDirty() {
    var state = window._projectConfig;
    if (state.editorInstance && window.ProjectConfigCodeEditor) {
        return window.ProjectConfigCodeEditor.isDirty(state.editorInstance);
    }
    var textarea = document.getElementById('pcEditorTextarea');
    if (textarea) {
        return textarea.value !== state.editorInitialContent;
    }
    return false;
}

export function confirmProjectConfigDiscardChanges() {
    if (!isProjectConfigEditorDirty()) {
        return true;
    }
    return confirm('当前文件有未保存修改，确定要放弃吗？');
}

export function ensureProjectConfigCanLeaveEditMode() {
    if (!window._projectConfig.editorInstance) {
        return true;
    }
    if (!confirmProjectConfigDiscardChanges()) {
        return false;
    }
    destroyProjectConfigEditor();
    return true;
}

export function createProjectConfigEditor(fileName, content) {
    var mount = document.getElementById('pcCodeEditor');
    if (!mount || !window.ProjectConfigCodeEditor) {
        return false;
    }
    destroyProjectConfigEditor();
    window._projectConfig.editorInstance = window.ProjectConfigCodeEditor.create(mount, {
        fileName: fileName,
        content: content,
        isDark: isProjectConfigDarkTheme(),
        onChange: function(value) {
            if (window._projectConfig.editingFile) {
                window._projectConfig.editingFile.content = value;
            }
            updateProjectConfigDirtyBadge();
        }
    });
    window._projectConfig.editorInitialContent = content;
    window.ProjectConfigCodeEditor.markClean(window._projectConfig.editorInstance);
    window._projectConfig.editorMode = 'edit';
    window.ProjectConfigCodeEditor.focus(window._projectConfig.editorInstance);
    startProjectConfigSearchButtonSync();
    return true;
}

export function syncProjectConfigEditorTheme(theme) {
    var state = window._projectConfig;
    if (state.editorInstance && window.ProjectConfigCodeEditor) {
        window.ProjectConfigCodeEditor.setTheme(state.editorInstance, isProjectConfigDarkTheme(theme));
    }
}

export function refreshProjectConfigSearchButtonState() {
    var searchBtn = document.querySelector('.pc-btn-search');
    if (!searchBtn) {
        return;
    }
    var state = window._projectConfig;
    var isOpen = !!(state.editorInstance && window.ProjectConfigCodeEditor && window.ProjectConfigCodeEditor.isSearchOpen(state.editorInstance));
    searchBtn.classList.toggle('active', isOpen);
    searchBtn.textContent = isOpen ? '关闭搜索' : '搜索';
}

export function startProjectConfigSearchButtonSync() {
    var state = window._projectConfig;
    stopProjectConfigSearchButtonSync();
    if (!state.editorInstance) {
        return;
    }
    state.searchButtonSyncTimer = setInterval(refreshProjectConfigSearchButtonState, 200);
}

window.syncProjectConfigEditorTheme = syncProjectConfigEditorTheme;

// ============================
// 弹窗开关
// ============================

export function openProjectConfig(rootDir) {
    var state = window._projectConfig;
    destroyProjectConfigEditor();
    state.rootDir = rootDir;
    state.summary = null;
    state.currentTab = 'coreConfig';
    state.editingFile = null;
    state.browseStack = [];

    document.getElementById('projectConfigTitle').textContent = '项目配置 — ' + rootDir;

    var tabs = document.querySelectorAll('#projectConfigTabs .pc-tab');
    tabs.forEach(function(t) { t.classList.toggle('active', t.dataset.pcTab === 'coreConfig'); });

    document.getElementById('projectConfigModal').style.display = 'flex';
    loadProjectConfigSummary();
}

export function closeProjectConfig() {
    if (!ensureProjectConfigCanLeaveEditMode()) {
        return;
    }
    document.getElementById('projectConfigModal').style.display = 'none';
    window._projectConfig.rootDir = '';
    window._projectConfig.editingFile = null;
    window._projectConfig.browseStack = [];
}

// ============================
// 数据加载
// ============================

export async function loadProjectConfigSummary() {
    var state = window._projectConfig;
    var body = document.getElementById('projectConfigBody');
    if (!body) return;
    body.innerHTML = '<div class="pc-loading"><div class="spinner"></div><p>加载中...</p></div>';

    try {
        state.summary = await api.GetProjectConfigSummary(state.rootDir);
        renderCurrentTab();
    } catch (e) {
        body.innerHTML = '<div class="pc-empty error">加载失败: ' + escapeHtml(e.message || e) + '</div>';
    }
}

// ============================
// Tab 切换
// ============================

export function switchProjectConfigTab(tabName) {
    if (!ensureProjectConfigCanLeaveEditMode()) {
        return;
    }
    var state = window._projectConfig;
    state.currentTab = tabName;
    state.editingFile = null;
    var tabs = document.querySelectorAll('#projectConfigTabs .pc-tab');
    tabs.forEach(function(t) { t.classList.toggle('active', t.dataset.pcTab === tabName); });
    renderCurrentTab();
}

export function renderCurrentTab() {
    var state = window._projectConfig;
    var summary = state.summary;
    if (!summary) return;

    destroyProjectConfigEditor();

    switch (state.currentTab) {
        case 'coreConfig': renderCoreConfigTab(summary.coreConfig); break;
        case 'skills':    renderSkillsTab(summary.skills); break;
        case 'agentsMd':  renderAgentsMdTab(summary.agentsMd); break;
        case 'commands':  renderFileListTab('commands', summary.commands, '无项目命令', '.opencode/commands/ 目录下没有命令文件'); break;
        case 'rules':     renderFileListTab('rules', summary.rules, '无项目规则文件', '.opencode/rules/ 目录下没有规则文件'); break;
    }
}

// ============================
// Tab 1: 核心配置
// ============================

export function renderCoreConfigTab(tab) {
    var body = document.getElementById('projectConfigBody');
    if (!tab.exists) {
        body.innerHTML = '<div class="pc-empty"><div class="pc-empty-icon">⚙️</div><p>无项目配置</p><p class="pc-empty-desc">该项目下没有 .opencode/opencode.jsonc 或 opencode.json</p><button class="btn btn-sm btn-primary pc-empty-btn" id="btnViewGlobalConfig">查看全局配置</button></div>';
        document.getElementById('btnViewGlobalConfig').addEventListener('click', viewGlobalConfig);
        return;
    }
    openFileEditor('coreConfig', tab.files[0].path);
}

export async function viewGlobalConfig() {
    var body = document.getElementById('projectConfigBody');
    body.innerHTML = '<div class="pc-loading"><div class="spinner"></div><p>加载全局配置...</p></div>';
    try {
        var info = await api.GetGlobalOpenCodeConfig();
        if (!info.content) {
            body.innerHTML = '<div class="pc-empty"><div class="pc-empty-icon">📄</div><p>全局配置不存在</p><p class="pc-empty-desc">' + escapeHtml(info.path) + '</p></div>';
            return;
        }
        renderPreview(info.path, info.content, true);
    } catch (e) {
        body.innerHTML = '<div class="pc-empty error">加载失败: ' + escapeHtml(e.message || e) + '</div>';
    }
}

// ============================
// Tab 2: 技能管理
// ============================

export function renderSkillsTab(tab) {
    var body = document.getElementById('projectConfigBody');

    // 顶部操作栏
    var actionsHtml = '<div class="pc-skills-actions"><button class="btn btn-sm btn-primary pc-btn-import-skills">导入技能</button></div>';

    if (!tab.exists || !tab.files || !tab.files.length) {
        body.innerHTML = actionsHtml + '<div class="pc-empty"><div class="pc-empty-icon">🧩</div><p>无项目技能</p><p class="pc-empty-desc">.opencode/skills/ 目录下没有技能</p></div>';
    } else {
        var html = actionsHtml + '<div class="pc-skill-list">';
        tab.files.forEach(function(f) {
            html += '<div class="pc-skill-card">';
            html += '<div class="pc-skill-info">';
            html += '<div class="pc-skill-name">' + escapeHtml(f.name) + '</div>';
            if (f.description) {
                html += '<div class="pc-skill-desc">' + escapeHtml(f.description) + '</div>';
            }
            html += '</div>';
            html += '<div class="pc-skill-card-actions">';
            html += '<button class="btn btn-sm btn-primary pc-skill-view" data-path="' + escapeHtml(f.path) + '">查看</button>';
            html += '<button class="pc-file-del pc-skill-del" data-del-path="' + escapeHtml(f.path) + '" title="删除">✕</button>';
            html += '</div>';
            html += '</div>';
        });
        html += '</div>';
        body.innerHTML = html;
    }

    // 查看按钮
    body.querySelectorAll('.pc-skill-view').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            browseSkillDir(btn.dataset.path);
        });
    });
    // 删除按钮
    body.querySelectorAll('.pc-skill-del').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var path = btn.dataset.delPath;
            if (!confirm('确定要删除技能 "' + path + '" 吗？')) return;
            api.DeleteProjectEntry(window._projectConfig.rootDir, 'skills', path).then(function() {
                showToast('已删除: ' + path, 'success');
                loadProjectConfigSummary();
            }).catch(function(e) {
                showToast('删除失败: ' + (e.message || e), 'error');
            });
        });
    });
    // 导入按钮
    var importBtn = document.querySelector('.pc-btn-import-skills');
    if (importBtn) importBtn.addEventListener('click', showImportSkillsModal);
}

// ============================
// 导入技能弹窗
// ============================

export function showImportSkillsModal() {
    var body = document.getElementById('projectConfigBody');
    body.innerHTML = '<div class="pc-loading"><div class="spinner"></div><p>加载可导入技能...</p></div>';

    api.GetImportableSkills(window._projectConfig.rootDir).then(function(skills) {
        if (!skills || !skills.length) {
            body.innerHTML = renderSkillsHeader() + '<div class="pc-empty"><p>没有可导入的技能</p><p class="pc-empty-desc">请先在全局技能管理中配置来源目录</p></div>';
            return;
        }
        var html = renderSkillsHeader() + '<div class="pc-skill-list">';
        skills.forEach(function(s) {
            var statusHtml = '';
            var btnHtml = '';
            if (s.imported) {
                statusHtml = '<span class="pc-import-tag imported">已导入</span>';
                btnHtml = '<button class="btn btn-sm pc-btn-imported" disabled>已导入</button>';
            } else {
                if (s.globalExist) {
                    statusHtml = '<span class="pc-import-tag global">全局已有</span>';
                }
                btnHtml = '<button class="btn btn-sm btn-primary pc-btn-do-import" data-src="' + escapeHtml(s.sourcePath) + '" data-name="' + escapeHtml(s.name) + '">导入</button>';
            }
            html += '<div class="pc-skill-card">';
            html += '<div class="pc-skill-info">';
            html += '<div class="pc-skill-name">' + escapeHtml(s.name) + ' ' + statusHtml + '</div>';
            if (s.description) {
                html += '<div class="pc-skill-desc">' + escapeHtml(s.description) + '</div>';
            }
            html += '<div class="pc-skill-src">来源: ' + escapeHtml(s.sourceDir) + '</div>';
            html += '</div>';
            html += '<div class="pc-skill-card-actions">' + btnHtml + '</div>';
            html += '</div>';
        });
        html += '</div>';
        body.innerHTML = html;
        bindImportEvents();
    }).catch(function(e) {
        body.innerHTML = renderSkillsHeader() + '<div class="pc-empty error">加载失败: ' + escapeHtml(e.message || e) + '</div>';
    });
}

export function renderSkillsHeader() {
    return '<div class="pc-skills-actions"><button class="btn btn-sm btn-ghost pc-btn-back-to-skills">← 返回技能列表</button></div>';
}

export function bindImportEvents() {
    var backBtn = document.querySelector('.pc-btn-back-to-skills');
    if (backBtn) backBtn.addEventListener('click', function() { renderCurrentTab(); });

    document.querySelectorAll('.pc-btn-do-import').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var src = btn.dataset.src, name = btn.dataset.name;
            btn.disabled = true;
            btn.textContent = '导入中...';
            api.ImportSkill(window._projectConfig.rootDir, src, name).then(function() {
                showToast('已导入: ' + name, 'success');
                loadProjectConfigSummary();
            }).catch(function(err) {
                showToast('导入失败: ' + (err.message || err), 'error');
                btn.disabled = false;
                btn.textContent = '导入';
            });
        });
    });
}

export function browseSkillDir(skillPath) {
    var state = window._projectConfig;
    var body = document.getElementById('projectConfigBody');
    body.innerHTML = '<div class="pc-loading"><div class="spinner"></div><p>加载中...</p></div>';

    api.ListProjectConfigDir(state.rootDir, 'skills', skillPath).then(function(result) {
        // 从技能列表进入时清空导航栈，入栈当前路径
        state.browseStack = [{ category: 'skills', path: skillPath }];

        renderBrowseView('skills', skillPath, result, '← 返回技能列表', function() { renderCurrentTab(); });
    }).catch(function(e) {
        body.innerHTML = '<div class="pc-empty error">加载失败: ' + escapeHtml(e.message || e) + '</div>';
    });
}

/** 渲染目录浏览视图 */
export function renderBrowseView(category, dirPath, result, backLabel, backAction) {
    var body = document.getElementById('projectConfigBody');
    if (!result.exists || !result.files || !result.files.length) {
        body.innerHTML = '<div class="pc-editor">' +
            '<div class="pc-editor-toolbar"><span class="pc-editor-filename">📁 ' + escapeHtml(dirPath) + '</span>' +
            '<button class="btn btn-sm btn-ghost pc-btn-browse-back">' + backLabel + '</button></div>' +
            '<div class="pc-empty"><p>目录为空</p>' +
            '<button class="btn btn-sm btn-primary pc-btn-add-entry">+ 新增文件</button></div></div>';
    } else {
        var dirs = result.files.filter(function(f) { return f.type === 'dir'; });
        var files = result.files.filter(function(f) { return f.type === 'file'; });
        var sorted = dirs.concat(files);

        body.innerHTML = '<div class="pc-editor">' +
            '<div class="pc-editor-toolbar"><span class="pc-editor-filename">📁 ' + escapeHtml(dirPath) + '</span>' +
            '<button class="btn btn-sm btn-ghost pc-btn-browse-back">' + backLabel + '</button></div>' +
            renderFileListHtml(category, dirPath, sorted, true) +
            '<div class="pc-file-list-footer"><button class="btn btn-sm btn-primary pc-btn-add-entry">+ 新增文件</button></div></div>';
    }
    bindBrowseEvents(category, dirPath);
    bindDeleteButtons(category, dirPath, function() { browseSubDir(category, dirPath); });
    var backBtn = document.querySelector('.pc-btn-browse-back');
    if (backBtn) backBtn.addEventListener('click', backAction);
    bindAddEntryButton(category, dirPath, function() { browseSubDir(category, dirPath); });
}

export function renderFileListHtml(category, basePath, files, showDelete) {
    var html = '<div class="pc-file-list">';
    files.forEach(function(f) {
        var fullPath = (basePath ? basePath + '/' : '') + f.path;
        var icon = f.type === 'dir' ? '📁' : '📄';
        html += '<div class="pc-file-item" data-category="' + escapeHtml(category) + '" data-path="' + escapeHtml(fullPath) + '" data-type="' + escapeHtml(f.type) + '">';
        html += '<span class="pc-file-icon">' + icon + '</span>';
        html += '<span class="pc-file-name">' + escapeHtml(f.name) + '</span>';
        html += '<span class="pc-file-arrow">→</span>';
        if (showDelete) {
            html += '<button class="pc-file-del" data-del-path="' + escapeHtml(fullPath) + '" data-del-type="' + escapeHtml(f.type) + '" title="删除">✕</button>';
        }
        html += '</div>';
    });
    html += '</div>';
    return html;
}

export function bindBrowseEvents(category, currentPath) {
    var body = document.getElementById('projectConfigBody');
    body.querySelectorAll('.pc-file-item').forEach(function(item) {
        item.addEventListener('click', function(e) {
            if (e.target.closest('.pc-file-del')) return;
            var fullPath = item.dataset.path;
            var type = item.dataset.type;
            if (type === 'dir') {
                window._projectConfig.browseStack.push({ category: category, path: currentPath });
                browseSubDir(category, fullPath);
            } else {
                window._projectConfig.browseStack.push({ category: category, path: currentPath });
                openFileEditor(category, fullPath);
            }
        });
    });
}

export function browseSubDir(category, dirPath) {
    var state = window._projectConfig;
    var body = document.getElementById('projectConfigBody');
    body.innerHTML = '<div class="pc-loading"><div class="spinner"></div><p>加载中...</p></div>';

    api.ListProjectConfigDir(state.rootDir, category, dirPath).then(function(result) {
        renderBrowseView(category, dirPath, result, '← 返回上级', function() { goBrowseBack(); });
    }).catch(function(e) {
        body.innerHTML = '<div class="pc-empty error">加载失败: ' + escapeHtml(e.message || e) + '</div>';
    });
}

/** 返回上一级目录 */
export function goBrowseBack() {
    var state = window._projectConfig;
    state.browseStack.pop(); // 出栈当前
    if (state.browseStack.length === 0) {
        renderCurrentTab();
        return;
    }
    var prev = state.browseStack[state.browseStack.length - 1];
    browseSubDir(prev.category, prev.path);
}

// ============================
// Tab 3: 项目准则
// ============================

export function renderAgentsMdTab(tab) {
    var body = document.getElementById('projectConfigBody');
    if (!tab.exists) {
        body.innerHTML = '<div class="pc-empty"><div class="pc-empty-icon">📋</div><p>项目未初始化</p><p class="pc-empty-desc">请先执行 /init 初始化项目，将自动创建 AGENTS.md</p></div>';
        return;
    }
    openFileEditor('agentsMd', tab.files[0].path);
}

// ============================
// Tab 3/4: 文件列表
// ============================

export function renderFileListTab(category, tab, emptyTitle, emptyDesc) {
    var body = document.getElementById('projectConfigBody');
    if (!tab.exists || !tab.files || !tab.files.length) {
        body.innerHTML = '<div class="pc-empty"><div class="pc-empty-icon">📂</div><p>' + emptyTitle + '</p><p class="pc-empty-desc">' + emptyDesc + '</p>' +
            '<button class="btn btn-sm btn-primary pc-btn-add-entry">+ 新增</button></div>';
        bindAddEntryButton(category, '', function() { loadProjectConfigSummary(); });
        return;
    }

    body.innerHTML = renderFileListHtml(category, '', tab.files, true) +
        '<div class="pc-file-list-footer"><button class="btn btn-sm btn-primary pc-btn-add-entry">+ 新增</button></div>';

    body.querySelectorAll('.pc-file-item').forEach(function(item) {
        item.addEventListener('click', function(e) {
            if (e.target.closest('.pc-file-del')) return;
            openFileEditor(item.dataset.category, item.dataset.path);
        });
    });
    bindDeleteButtons(category, '', function() { loadProjectConfigSummary(); });
    bindAddEntryButton(category, '', function() { loadProjectConfigSummary(); });
}

// ============================
// 文件预览 / 编辑（默认预览模式）
// ============================

export function openFileEditor(category, relPath) {
    var body = document.getElementById('projectConfigBody');
    body.innerHTML = '<div class="pc-loading"><div class="spinner"></div><p>加载文件...</p></div>';

    api.ReadProjectConfigFile(window._projectConfig.rootDir, category, relPath).then(function(result) {
        window._projectConfig.editingFile = { category: category, path: relPath, content: result.content };
        var ext = '.' + (result.path || '').split('.').pop().toLowerCase();
        var isMarkdown = ext === '.md' || ext === '.markdown';
        if (isMarkdown) {
            renderPreview(result.path, result.content, false);
            return;
        }
        switchToEditMode(result.path, result.content);
    }).catch(function(e) {
        body.innerHTML = '<div class="pc-empty error">加载失败: ' + escapeHtml(e.message || e) + '</div>';
    });
}

// ============================
// 预览模式（与文件浏览器完全一致）
// ============================

export function renderPreview(fileName, content, readOnly) {
    destroyProjectConfigEditor();
    var body = document.getElementById('projectConfigBody');
    var ext = '.' + (fileName || '').split('.').pop().toLowerCase();

    // 判断预览方式
    var isMarkdown = ext === '.md' || ext === '.markdown';

    var label = readOnly ? '全局配置 · 只读' : escapeHtml(fileName);
    var actions = readOnly
        ? '<button class="btn btn-sm btn-ghost pc-btn-back">← 返回</button>'
        : (isMarkdown
            ? '<button class="btn btn-sm btn-primary pc-btn-edit">编辑</button>' +
              '<button class="btn btn-sm btn-ghost pc-btn-back">← 返回</button>'
            : '<button class="btn btn-sm btn-ghost pc-btn-back">← 返回</button>');

    var previewHtml = '';
    if (isMarkdown && typeof marked !== 'undefined') {
        // Markdown 渲染（与文件浏览器一致）
        var rawHtml = marked.parse(String(content || ''));
        var safeHtml = fileBrowserSanitizeMarkedHtml(rawHtml);
        previewHtml = '<div class="oc-text file-browser-markdown">' + safeHtml + '</div>';
    } else {
        // 代码高亮 + 行号（与文件浏览器一致）
        var highlighted = fileBrowserHighlightCode(String(content || ''), ext);
        previewHtml = '<pre class="file-browser-code"><code class="hljs">' + highlighted + '</code></pre>';
    }

    body.innerHTML = '<div class="pc-editor">' +
        '<div class="pc-editor-toolbar">' +
            '<span class="pc-editor-filename">' + label + '</span>' +
            '<div class="pc-editor-actions">' + actions + '</div>' +
        '</div>' +
        '<div class="pc-editor-viewer">' + previewHtml + '</div>' +
    '</div>';

    // 编辑按钮
    if (isMarkdown) {
        var editBtn = document.querySelector('.pc-btn-edit');
        if (editBtn) editBtn.addEventListener('click', function() {
            var latestContent = window._projectConfig.editingFile && typeof window._projectConfig.editingFile.content === 'string'
                ? window._projectConfig.editingFile.content
                : content;
            switchToEditMode(fileName, latestContent);
        });
    }

    // 返回按钮 → 导航栈回退
    var backBtn = document.querySelector('.pc-btn-back');
    if (backBtn) backBtn.addEventListener('click', function() {
        window._projectConfig.editingFile = null;
        editorGoBack();
    });
}

export function editorGoBack() {
    destroyProjectConfigEditor();
    var state = window._projectConfig;
    if (state.browseStack.length > 0) {
        var current = state.browseStack.pop();
        browseSubDir(current.category, current.path);
        return;
    }
    renderCurrentTab();
}

/** 降级高亮：当 fileBrowserHighlightCode 不可用时 */
export function pcHighlightFallback(code, ext) {
    var lines = String(code || '').split('\n');
    var numbered = '';
    for (var i = 0; i < lines.length; i++) {
        numbered += '<div class="hljs-line"><span class="hljs-line-no">' + (i + 1) + '</span><span class="hljs-line-content">' + (escapeHtml(lines[i]) || ' ') + '</span></div>';
    }
    return numbered;
}

// ============================
// 编辑模式（纯 textarea，无行号）
// ============================

export function switchToEditMode(fileName, content) {
    var body = document.getElementById('projectConfigBody');
    window._projectConfig.editingFile.content = content;
    window._projectConfig.editorInitialContent = content;
    var ext = '.' + (fileName || '').split('.').pop().toLowerCase();
    var allowPreviewToggle = ext === '.md' || ext === '.markdown';

    body.innerHTML = '<div class="pc-editor">' +
        '<div class="pc-editor-toolbar">' +
            '<span class="pc-editor-filename">' + escapeHtml(fileName) + ' <span style="color:var(--warning);font-size:11px">编辑中</span><span class="pc-editor-status-dirty" id="pcEditorDirtyBadge" style="display:none">未保存</span></span>' +
            '<div class="pc-editor-actions">' +
                '<button class="btn btn-sm btn-ghost pc-btn-back">← 返回</button>' +
                '<button class="btn btn-sm btn-ghost pc-editor-search-btn pc-btn-search">搜索</button>' +
                '<button class="btn btn-sm btn-primary pc-btn-save">保存</button>' +
                (allowPreviewToggle ? '<button class="btn btn-sm btn-ghost pc-btn-preview">预览</button>' : '') +
            '</div>' +
        '</div>' +
        '<div class="pc-editor-cm-wrap"><div class="pc-code-editor" id="pcCodeEditor"></div></div>' +
    '</div>';

    if (!createProjectConfigEditor(fileName, content)) {
        body.innerHTML = '<div class="pc-editor">' +
            '<div class="pc-editor-toolbar">' +
                '<span class="pc-editor-filename">' + escapeHtml(fileName) + ' <span style="color:var(--warning);font-size:11px">编辑中</span></span>' +
                '<div class="pc-editor-actions">' +
                    '<button class="btn btn-sm btn-ghost pc-btn-back">← 返回</button>' +
                    '<button class="btn btn-sm btn-primary pc-btn-save">保存</button>' +
                    (allowPreviewToggle ? '<button class="btn btn-sm btn-ghost pc-btn-preview">预览</button>' : '') +
                '</div>' +
            '</div>' +
            '<textarea class="pc-editor-textarea-simple" id="pcEditorTextarea" spellcheck="false">' + escapeHtml(content) + '</textarea>' +
        '</div>';
    }

    setupEditMode();
}

export function setupEditMode() {
    var textarea = document.getElementById('pcEditorTextarea');
    var state = window._projectConfig;

    if (textarea) {
        textarea.focus();
        textarea.addEventListener('input', updateProjectConfigDirtyBadge);
        textarea.addEventListener('keydown', function(e) {
            if (e.key === 'Tab') {
                e.preventDefault();
                var s = textarea.selectionStart, end = textarea.selectionEnd;
                textarea.value = textarea.value.substring(0, s) + '\t' + textarea.value.substring(end);
                textarea.selectionStart = textarea.selectionEnd = s + 1;
                updateProjectConfigDirtyBadge();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                saveCurrentFile();
            }
        });
    }

    var saveBtn = document.querySelector('.pc-btn-save');
    if (saveBtn) saveBtn.addEventListener('click', saveCurrentFile);

    var backBtn = document.querySelector('.pc-btn-back');
    if (backBtn) backBtn.addEventListener('click', function() {
        editorGoBack();
    });

    var searchBtn = document.querySelector('.pc-btn-search');
    if (searchBtn) {
        searchBtn.addEventListener('click', function() {
            if (state.editorInstance && window.ProjectConfigCodeEditor) {
                window.ProjectConfigCodeEditor.toggleSearch(state.editorInstance);
                refreshProjectConfigSearchButtonState();
            }
        });
    }

    var previewBtn = document.querySelector('.pc-btn-preview');
    if (previewBtn) previewBtn.addEventListener('click', function() {
        var newContent = getProjectConfigEditorContent();
        window._projectConfig.editingFile.content = newContent;
        renderPreview(window._projectConfig.editingFile.path, newContent, false);
    });

    updateProjectConfigDirtyBadge();
    refreshProjectConfigSearchButtonState();
}

// ============================
// 只读预览（全局配置查看）
// ============================

export function pcHighlightLines(code, lang) {
    return escapeHtml(code);
}

export async function saveCurrentFile() {
    var state = window._projectConfig;
    var editing = state.editingFile;
    if (!editing) return;
    var content = getProjectConfigEditorContent();
    var saveBtn = document.querySelector('.pc-btn-save');

    try {
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中...'; }
        await api.SaveProjectConfigFile(state.rootDir, editing.category, editing.path, content);
        showToast('保存成功', 'success');
        state.editingFile.content = content;
        state.editorInitialContent = content;
        if (state.editorInstance && window.ProjectConfigCodeEditor) {
            window.ProjectConfigCodeEditor.markClean(state.editorInstance);
        }
        var ext = '.' + (editing.path || '').split('.').pop().toLowerCase();
        var isMarkdown = ext === '.md' || ext === '.markdown';
        if (isMarkdown) {
            renderPreview(editing.path, content, false);
        } else {
            updateProjectConfigDirtyBadge();
        }
    } catch (e) {
        showToast('保存失败: ' + (e.message || e), 'error');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
    }
}

// ============================
// 新增 / 删除
// ============================

export function bindDeleteButtons(category, basePath, onDone) {
    document.querySelectorAll('.pc-file-del').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var path = btn.dataset.delPath;
            var type = btn.dataset.delType;
            var label = type === 'dir' ? '目录' : '文件';
            if (!confirm('确定要删除' + label + ' "' + path + '" 吗？此操作不可撤销。')) return;
            api.DeleteProjectEntry(window._projectConfig.rootDir, category, path).then(function() {
                showToast('已删除: ' + path, 'success');
                onDone();
            }).catch(function(e) {
                showToast('删除失败: ' + (e.message || e), 'error');
            });
        });
    });
}

export function bindAddEntryButton(category, basePath, onDone) {
    var btn = document.querySelector('.pc-btn-add-entry');
    if (!btn) return;
    // 避免重复绑定
    btn._bound = btn._bound || false;
    if (btn._bound) return;
    btn._bound = true;

    btn.addEventListener('click', function() {
        var name = prompt('请输入文件名（如 build.md）：');
        if (!name || !name.trim()) return;
        name = name.trim();
        // 自动补全 .md
        if (!name.includes('.')) name += '.md';
        api.CreateProjectEntry(window._projectConfig.rootDir, category, name).then(function(entry) {
            showToast('已创建: ' + entry.name, 'success');
            onDone();
        }).catch(function(e) {
            showToast('创建失败: ' + (e.message || e), 'error');
        });
    });
}

export function detectCodeLang(fileName) {
    var ext = (fileName || '').split('.').pop().toLowerCase();
    var map = { 'md': 'markdown', 'json': 'json', 'jsonc': 'json', 'yaml': 'yaml', 'yml': 'yaml', 'toml': 'ini', 'xml': 'xml', 'js': 'javascript', 'ts': 'typescript', 'css': 'css', 'html': 'xml', 'sh': 'bash', 'py': 'python', 'go': 'go', 'rs': 'rust', 'java': 'java' };
    return map[ext] || '';
}

// ============================
// 事件初始化
// ============================

document.addEventListener('DOMContentLoaded', function() {
    var modal = document.getElementById('projectConfigModal');
    if (!modal) return;

    modal.addEventListener('click', function(e) {
        if (e.target === modal) closeProjectConfig();
    });

    document.getElementById('btnCloseProjectConfig').addEventListener('click', closeProjectConfig);

    document.querySelectorAll('#projectConfigTabs .pc-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            switchProjectConfigTab(tab.dataset.pcTab);
        });
    });

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && modal.style.display === 'flex') {
            closeProjectConfig();
        }
    });
});
