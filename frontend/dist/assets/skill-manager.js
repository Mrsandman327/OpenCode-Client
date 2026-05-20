// OpenCode 管理中心 - 技能管理视图
let skills = [];
let skillsLoaded = false;
let addingSourceDir = false;  // 防重入 guard
let currentSkillBrowserState = null;

async function loadSkillsData() {
    if (skillsLoaded) return;
    skillsLoaded = true;
    try {
        var result = await api.GetSkillConfig();
        skills = result.skills || [];
        renderStats(result.stats);
        renderSourceDirs(result.sourceDirs || []);
        renderSkillList();
        await loadSkillSchemes();
    } catch (err) {
        skillsLoaded = false;
        showToast('加载技能数据失败: ' + (err.message || err), 'error');
    }
}

function renderStats(stats) {
    document.getElementById('statGlobal').textContent = stats ? (stats.globalSkills || 0) : 0;
}

function renderSkillList(filter) {
    filter = filter || '';
    var list = document.getElementById('skillList');
    if (!skills.length) {
        list.innerHTML = '<div class="oc-empty">暂无技能</div>';
        return;
    }
    var noSourcesMode = skills.length > 0 && skills.every(function(s) { return s.noSources; });

    var filtered = filter ? skills.filter(function(s) { return s.name.toLowerCase().indexOf(filter.toLowerCase()) >= 0; }) : skills;

    list.innerHTML = filtered.map(function(s) {
        var safeName = escapeHtml(s.name);
        var safePath = escapeHtml(s.path);
        var safeDesc = escapeHtml(s.description || '无描述');
        var sourceLabel = s.source && s.source !== 'global' ? '全局' : 'opencode';
        var sourceClass = s.source === 'global' || !s.source ? 'skill-source-global' : 'skill-source-project';

        // 开关状态
        var checkedAttr = s.linked ? 'checked' : '';
        var disabledAttr = (!s.enableable) ? 'disabled' : '';
        var toggleTitle = s.conflict ? '冲突，不可操作' : (s.noSources ? '无来源目录，不可操作' : (s.linked ? '点击禁用' : '点击启用'));

        var html = '<div class="skill-card" data-skill="' + safeName + '" data-path="' + safePath + '">' +
            '<div class="skill-info">' +
                '<div class="skill-name-row">' +
                    '<button type="button" class="skill-name" data-action="open-skill" data-skill-path="' + safePath + '" style="cursor:pointer;text-decoration:underline;color:var(--accent);background:none;border:none;padding:0;font:inherit;">' + safeName + '</button>' +
                    (s.conflict ? '<span class="skill-tag conflict-tag">冲突</span>' : '<span class="skill-tag ' + sourceClass + '">' + sourceLabel + '</span>') +
                '</div>' +
                '<div class="skill-desc">' + safeDesc + '</div>' +
                '<div class="skill-path">' + safePath + '</div>';

        // 冲突状态：展开显示冲突来源
        if (s.conflict && s.sources && s.sources.length > 0) {
            html += '<div class="skill-conflict-sources" style="margin-top:4px;font-size:11px;color:var(--danger);">该技能在 ' + s.sources.length + ' 个来源目录中存在同名冲突：';
            s.sources.forEach(function(src) {
                html += '<div style="padding-left:12px;">→ ' + escapeHtml(src.path) + '</div>';
            });
            html += '</div>';
        }
        html += '</div>' +
            '<div class="skill-actions">' +
                '<label class="toggle" title="' + toggleTitle + '">' +
                    '<input type="checkbox" ' + checkedAttr + ' ' + disabledAttr +
                        ' data-action="toggle-skill" data-skill-path="' + safePath + '" data-skill-name="' + safeName + '" />' +
                    '<span class="toggle-slider"></span>' +
                '</label>' +
                '<button class="btn btn-sm btn-open" data-action="open-skill" data-skill-path="' + safePath + '">📂 打开</button>' +
            '</div>' +
        '</div>';
        return html;
    }).join('');

    // 无来源目录提示横幅
    if (noSourcesMode && filtered.length > 0) {
        list.innerHTML += '<div class="no-sources-banner">⚠ 尚未添加来源目录，当前展示的是 opencode 全局技能目录。添加来源目录后可管理启用状态。</div>';
    }

    if (!filtered.length && skills.length > 0) {
        list.innerHTML = '<div class="oc-empty">没有匹配的技能</div>';
    }
}

// 搜索事件在 main.js 中绑定
// 技能 Modal 事件在 DOMContentLoaded 中绑定（main.js）

function bindSkillManagerEvents() {
    var skillList = document.getElementById('skillList');
    if (skillList && !skillList.dataset.bound) {
        skillList.dataset.bound = 'true';
        skillList.addEventListener('click', handleSkillManagerActionClick);
    }
    var skillModalBody = document.getElementById('skillModalBody');
    if (skillModalBody && !skillModalBody.dataset.bound) {
        skillModalBody.dataset.bound = 'true';
        skillModalBody.addEventListener('click', handleSkillManagerActionClick);
    }
}

async function handleSkillManagerActionClick(event) {
    var target = event.target.closest('[data-action]');
    if (!target) return;
    var action = target.dataset.action;
    if (action === 'open-skill') {
        await openSkillDir(target.dataset.skillPath || '');
        return;
    }
    if (action === 'select-skill-file') {
        await selectSkillBrowserFile(target.dataset.relativePath || '');
        return;
    }
    if (action === 'toggle-dir') {
        toggleSkillDirCollapse(target.dataset.relativePath || '');
    }
    if (action === 'toggle-skill') {
        var skillPath = target.dataset.skillPath;
        var skillName = target.dataset.skillName;
        var enable = target.checked;  // 点击后的目标状态
        try {
            await toggleSkill(skillPath, skillName, enable);
        } catch (e) {
            // 失败时回滚 checkbox 并提示
            target.checked = !enable;
            showToast('操作失败: ' + (e.message || e), 'error');
        }
        return;
    }
}

async function editSkill(skillPath) {
    if (!currentSkillBrowserState || currentSkillBrowserState.skillPath !== skillPath || !currentSkillBrowserState.selectedPath) {
        await openSkillFileBrowser(skillPath);
        return;
    }
    try {
        var result = await api.ReadSkillFile(skillPath, currentSkillBrowserState.selectedPath);
        currentSkillBrowserState.isEditing = true;
        renderSkillBrowserTree();
        var relativePath = result.path || currentSkillBrowserState.selectedPath;
        renderSkillBrowserEditor(relativePath, result.content || '');
    } catch (err) {
        showToast('读取技能文件失败: ' + (err.message || err), 'error');
    }
}

function showSkillBrowserModal(skillPath, tree) {
    currentSkillBrowserState = {
        skillPath: skillPath,
        tree: tree,
		selectedPath: '',
		previewRequestId: 0,
        collapsedDirs: {},
        isEditing: false,
        isDirty: false,
        originalContent: ''
    };
    var modal = document.getElementById('skillModal');
    var body = document.getElementById('skillModalBody');
    var title = document.getElementById('skillModalTitle');
    var editBtn = document.getElementById('skillModalEdit');
    var saveBtn = document.getElementById('skillModalSave');
    var cancelBtn = document.getElementById('skillModalCancel');

    title.textContent = (tree && tree.name) || '技能文件浏览';
    modal.dataset.skillPath = skillPath;
    modal.dataset.mode = 'browser';
    body.innerHTML = '' +
        '<div class="skill-file-browser" style="display:flex;gap:16px;min-height:420px;max-height:65vh;">' +
            '<div class="skill-file-tree" style="width:260px;overflow:auto;border-right:1px solid var(--border);padding-right:12px;"></div>' +
            '<div class="skill-file-preview" style="flex:1;overflow:auto;padding-left:4px;"><div class="oc-empty">请选择文件</div></div>' +
        '</div>';
    editBtn.style.display = '';
    saveBtn.style.display = 'none';
    cancelBtn.style.display = 'none';
    modal.style.display = 'flex';
    renderSkillBrowserTree();
}

function renderSkillBrowserTree() {
    var modal = document.getElementById('skillModal');
    var treeContainer = modal.querySelector('.skill-file-tree');
    if (!treeContainer || !currentSkillBrowserState) return;
    treeContainer.innerHTML = renderSkillTreeNode(currentSkillBrowserState.tree, true);
}

function renderSkillTreeNode(node, isRoot) {
    if (!node) return '';
    var children = Array.isArray(node.children) ? sortSkillTreeChildren(node.children) : [];
    if (node.type === 'file') {
        var isSelected = currentSkillBrowserState && currentSkillBrowserState.selectedPath === node.path;
        var selectedClass = isSelected ? ' skill-file-node-selected' : '';
        var primaryBadge = node.name === 'SKILL.md' ? '<span class="skill-file-primary-badge">主文件</span>' : '';
        return '<div class="skill-file-node skill-file-node-file" style="margin:4px 0;">' +
            '<button type="button" class="btn btn-sm' + selectedClass + '" data-action="select-skill-file" data-relative-path="' + escapeTreePath(node.path) + '" style="width:100%;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:8px;"><span>📄 ' + escapeHtml(node.name) + '</span>' + primaryBadge + '</button>' +
        '</div>';
    }
    var collapsed = !isRoot && currentSkillBrowserState && currentSkillBrowserState.collapsedDirs[node.path];
    var icon = collapsed ? '📁' : '📂';
    var toggleLabel = icon + ' ' + escapeHtml(node.name);
    return '<div class="skill-file-node skill-file-node-dir" style="margin:4px 0;">' +
        '<button type="button" class="btn btn-sm skill-file-dir-toggle" data-action="toggle-dir" data-relative-path="' + escapeTreePath(node.path) + '">' + toggleLabel + '</button>' +
        '<div style="display:' + (collapsed ? 'none' : 'block') + ';margin-left:' + (isRoot ? '0' : '14') + 'px;">' + children.map(function(child) {
            return renderSkillTreeNode(child, false);
        }).join('') + '</div>' +
    '</div>';
}

function escapeTreePath(path) {
    return escapeHtml(path).replace(/'/g, '&#39;');
}

async function openSkillFileBrowser(skillPath) {
    try {
        var tree = await api.ListSkillFiles(skillPath);
        showSkillBrowserModal(skillPath, tree);
        bindSkillManagerEvents();
        var firstTextFile = findFirstTextFile(tree);
        if (firstTextFile) {
            await selectSkillBrowserFile(firstTextFile.path);
        }
    } catch (err) {
        showToast('读取技能目录失败: ' + (err.message || err), 'error');
    }
}

function findFirstTextFile(node) {
    if (!node) return null;
    if (node.type === 'file' && node.name === 'SKILL.md') {
        return node;
    }
    if (node.type === 'file') {
        return node;
    }
    var children = Array.isArray(node.children) ? node.children : [];
    for (var i = 0; i < children.length; i++) {
        var found = findFirstTextFile(children[i]);
        if (found) return found;
    }
    return null;
}

function sortSkillTreeChildren(children) {
    return (children || []).slice().sort(function(left, right) {
        var leftName = left && left.name ? left.name : '';
        var rightName = right && right.name ? right.name : '';
        if (leftName === 'SKILL.md' || rightName === 'SKILL.md') {
            return leftName === 'SKILL.md' ? -1 : 1;
        }
        var leftDir = left && left.type === 'dir';
        var rightDir = right && right.type === 'dir';
        if (leftDir !== rightDir) {
            return leftDir ? -1 : 1;
        }
        return leftName.localeCompare(rightName);
    });
}

async function selectSkillBrowserFile(relativePath) {
    if (!currentSkillBrowserState) return;
    if (currentSkillBrowserState.isEditing && currentSkillBrowserState.isDirty) {
        if (!confirmDiscardSkillBrowserChanges('切换文件')) return;
    }
    currentSkillBrowserState.selectedPath = relativePath;
    currentSkillBrowserState.isEditing = false;
    currentSkillBrowserState.isDirty = false;
    currentSkillBrowserState.originalContent = '';
    updateSkillBrowserModalActions();
    renderSkillBrowserTree();
    var requestId = ++currentSkillBrowserState.previewRequestId;
    var skillPath = currentSkillBrowserState.skillPath;
    var preview = document.querySelector('#skillModal .skill-file-preview');
    if (!preview) return;
    preview.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在读取文件...</p></div>';
    try {
        var result = await api.ReadSkillFile(skillPath, relativePath);
        if (!currentSkillBrowserState || currentSkillBrowserState.skillPath !== skillPath || currentSkillBrowserState.selectedPath !== relativePath || currentSkillBrowserState.previewRequestId !== requestId) return;
        renderSkillBrowserPreview(result.path || relativePath, result.content || '');
    } catch (err) {
        if (!currentSkillBrowserState || currentSkillBrowserState.skillPath !== skillPath || currentSkillBrowserState.selectedPath !== relativePath || currentSkillBrowserState.previewRequestId !== requestId) return;
        preview.innerHTML = '<div class="oc-empty">读取文件失败</div>';
        showToast('读取技能文件失败: ' + (err.message || err), 'error');
    }
}

function renderSkillBrowserPreview(relativePath, content) {
    var preview = document.querySelector('#skillModal .skill-file-preview');
    if (!preview) return;
    var previewHtml = '';
    if (isMarkdownFile(relativePath)) {
        previewHtml = '<div class="oc-text">' + sanitizeMarkedHtml(marked.parse(content)) + '</div>';
    } else {
        previewHtml = '<pre style="margin:0;white-space:pre-wrap;word-break:break-word;background:var(--bg-tertiary);padding:12px;border-radius:8px;">' + escapeHtml(content) + '</pre>';
    }
    preview.innerHTML = '' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;">' +
            '<strong>' + escapeHtml(relativePath) + '</strong>' +
            '<span style="color:var(--text-secondary);font-size:12px;">预览模式</span>' +
        '</div>' + previewHtml;
    currentSkillBrowserState.originalContent = content;
    currentSkillBrowserState.isDirty = false;
    updateSkillBrowserModalActions();
}

function renderSkillBrowserEditor(relativePath, content) {
    var preview = document.querySelector('#skillModal .skill-file-preview');
    if (!preview) return;
    preview.innerHTML = '' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;">' +
            '<strong>' + escapeHtml(relativePath) + '</strong>' +
            '<span style="color:var(--text-secondary);font-size:12px;">编辑模式</span>' +
        '</div>' +
        '<textarea id="skillFileEditArea" class="skill-edit-area">' + escapeHtml(content) + '</textarea>';
    var modal = document.getElementById('skillModal');
    modal.dataset.mode = 'browser-edit';
    currentSkillBrowserState.originalContent = content;
    currentSkillBrowserState.isDirty = false;
    updateSkillBrowserModalActions();
    var textarea = document.getElementById('skillFileEditArea');
    if (textarea) {
        textarea.addEventListener('input', markSkillBrowserDirtyState);
    }
}

function isMarkdownFile(path) {
    return /\.(md|markdown)$/i.test(path || '');
}

function toggleSkillDirCollapse(path) {
    if (!currentSkillBrowserState || !path || path === '.') return;
    currentSkillBrowserState.collapsedDirs[path] = !currentSkillBrowserState.collapsedDirs[path];
    renderSkillBrowserTree();
}

function sanitizeMarkedHtml(html) {
    var template = document.createElement('template');
    template.innerHTML = html;
    var allowedTags = new Set(['A', 'P', 'BR', 'STRONG', 'EM', 'CODE', 'PRE', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR']);
    sanitizeMarkedNodeTree(template.content, allowedTags);
    return template.innerHTML;
}

function sanitizeMarkedNodeTree(root, allowedTags) {
    var children = Array.prototype.slice.call(root.childNodes || []);
    children.forEach(function(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            root.removeChild(node);
            return;
        }
        if (!allowedTags.has(node.tagName)) {
            var text = document.createTextNode(node.textContent || '');
            root.replaceChild(text, node);
            return;
        }
        var attrs = Array.prototype.slice.call(node.attributes || []);
        attrs.forEach(function(attr) {
            var attrName = attr.name.toLowerCase();
            if (node.tagName === 'A' && attrName === 'href') {
                var href = (attr.value || '').trim();
                if (/^(https?:|mailto:|#|\/)/i.test(href)) {
                    node.setAttribute('target', '_blank');
                    node.setAttribute('rel', 'noopener noreferrer');
                } else {
                    node.removeAttribute(attr.name);
                }
                return;
            }
            node.removeAttribute(attr.name);
        });
        sanitizeMarkedNodeTree(node, allowedTags);
    });
}

function markSkillBrowserDirtyState() {
    if (!currentSkillBrowserState) return;
    var textarea = document.getElementById('skillFileEditArea');
    if (!textarea) return;
    currentSkillBrowserState.isDirty = textarea.value !== currentSkillBrowserState.originalContent;
}

function confirmDiscardSkillBrowserChanges(actionLabel) {
    if (!currentSkillBrowserState || !currentSkillBrowserState.isEditing || !currentSkillBrowserState.isDirty) return true;
    return window.confirm('当前编辑内容尚未保存，确定要' + actionLabel + '吗？');
}

function updateSkillBrowserModalActions() {
    var modal = document.getElementById('skillModal');
    var editBtn = document.getElementById('skillModalEdit');
    var saveBtn = document.getElementById('skillModalSave');
    var cancelBtn = document.getElementById('skillModalCancel');
    if (!currentSkillBrowserState) {
        editBtn.style.display = 'none';
        saveBtn.style.display = 'none';
        cancelBtn.style.display = 'none';
        return;
    }
    if (currentSkillBrowserState.isEditing) {
        modal.dataset.mode = 'browser-edit';
        editBtn.style.display = 'none';
        saveBtn.style.display = '';
        cancelBtn.style.display = '';
        return;
    }
    modal.dataset.mode = 'browser';
    editBtn.style.display = currentSkillBrowserState.selectedPath ? '' : 'none';
    saveBtn.style.display = 'none';
    cancelBtn.style.display = 'none';
}

function closeSkillModal() {
	if (!confirmDiscardSkillBrowserChanges('关闭浏览器')) return;
	if (currentSkillBrowserState) {
		currentSkillBrowserState.previewRequestId++;
	}
    currentSkillBrowserState = null;
    document.getElementById('skillModal').style.display = 'none';
}

function cancelSkillBrowserEdit() {
	if (!currentSkillBrowserState || !currentSkillBrowserState.selectedPath) return;
	if (!confirmDiscardSkillBrowserChanges('取消编辑')) return;
	currentSkillBrowserState.isEditing = false;
	currentSkillBrowserState.isDirty = false;
	updateSkillBrowserModalActions();
	selectSkillBrowserFile(currentSkillBrowserState.selectedPath);
}

async function saveSkillEdit() {
    var modal = document.getElementById('skillModal');
	if (modal.dataset.mode === 'browser-edit') {
		await saveSkillBrowserEdit();
		return;
	}
}

async function saveSkillBrowserEdit() {
	if (!currentSkillBrowserState || !currentSkillBrowserState.selectedPath) return;
	var modal = document.getElementById('skillModal');
	var skillPath = modal.dataset.skillPath;
	var relativePath = currentSkillBrowserState.selectedPath;
	var text = document.getElementById('skillFileEditArea').value;
	try {
		await api.SaveSkillFile(skillPath, relativePath, text);
		currentSkillBrowserState.isEditing = false;
		currentSkillBrowserState.originalContent = text;
		currentSkillBrowserState.isDirty = false;
		updateSkillBrowserModalActions();
		renderSkillBrowserPreview(relativePath, text);
		showToast('保存成功', 'success');
	} catch (err) {
		showToast('保存失败: ' + (err.message || err), 'error');
	}
}

// ========== Toggle 开关 ==========

async function toggleSkill(skillPath, skillName, enable) {
    var result = await api.ToggleSkill(skillPath, skillName, enable);
    if (result.success) {
        showToast((enable ? '已启用 ' : '已禁用 ') + skillName, 'success');
        skillsLoaded = false;
        await loadSkillsData();
        return;
    }
    // 失败时抛出错误，由事件处理器回滚 checkbox 状态
    throw new Error(result.error || '未知错误');
}

// 打开技能目录
async function openSkillDir(skillPath) {
    try {
        await openSkillFileBrowser(skillPath);
    } catch (err) {
        showToast('打开目录失败: ' + (err.message || err), 'error');
    }
}

// ========== 源目录管理 ==========

function renderSourceDirs(dirs) {
    var select = document.getElementById('sourceDirSelect');
    if (!select) return;
    if (!dirs || dirs.length === 0) {
        select.innerHTML = '<option value="">（未添加来源目录）</option>';
        return;
    }
    select.innerHTML = dirs.map(function(d) {
        return '<option value="' + escapeHtml(d) + '">' + escapeHtml(d) + '</option>';
    }).join('');
}

async function addSourceDir() {
    var dir = '';
    if (isBrowserRuntimeForMain()) {
        dir = await openDirBrowserModal();
    } else {
        dir = await api.OpenDirectoryDialog();
    }
    if (!dir) return;
    await performAddSourceDir(dir);
    return;
}

async function performAddSourceDir(dir) {
    try {
        var result = await api.AddSkillSourceDir(dir);
        if (result && result.success === false) {
            showToast('添加目录失败: ' + (result.error || '未知错误'), 'error');
            return;
        }
        showToast('已添加目录: ' + dir, 'success');
        // 立即更新下拉框（不等全量刷新，保证 UI 即时反馈）
        var select = document.getElementById('sourceDirSelect');
        if (select) {
            var opt = document.createElement('option');
            opt.value = dir;
            opt.textContent = dir;
            select.appendChild(opt);
            select.value = dir;
        }
        skillsLoaded = false;
        await loadSkillsData();
    } catch (err) {
        showToast('添加目录失败: ' + (err.message || err), 'error');
    }
}

async function removeSourceDir() {
    var select = document.getElementById('sourceDirSelect');
    var dir = select ? select.value : '';
    if (!dir) {
        showToast('请先选择要删除的来源目录', 'error');
        return;
    }
    // 查询受影响的已启用技能
    try {
        var enabledSkills = await api.GetDirEnabledSkills(dir);
        var msg = '确定删除来源目录「' + dir + '」？';
        if (enabledSkills && enabledSkills.length > 0) {
            msg = '该来源目录下有 ' + enabledSkills.length + ' 个技能当前已启用，删除后这些链接将被移除：\n' +
                enabledSkills.map(function(s) { return ' · ' + s; }).join('\n') +
                '\n\n确定删除吗？';
        }
        if (!confirm(msg)) return;
        var result = await api.RemoveSkillSourceDir(dir);
        if (result && result.success === false) {
            showToast('删除目录失败: ' + (result.error || '未知错误'), 'error');
            return;
        }
        showToast('已删除目录: ' + dir, 'success');
        skillsLoaded = false;
        await loadSkillsData();
    } catch (err) {
        showToast('删除目录失败: ' + (err.message || err), 'error');
    }
}

async function openSelectedSourceDir() {
    var select = document.getElementById('sourceDirSelect');
    var dir = select ? select.value : '';
    if (!dir) {
        showToast('请先选择要打开的目录', 'error');
        return;
    }
    try {
        await api.OpenDir(dir);
    } catch (err) {
        showToast('打开目录失败: ' + (err.message || err), 'error');
    }
}

// ========== 技能方案管理 ==========

async function loadSkillSchemes() {
    try {
        var schemes = await api.ListSkillSchemes();
        var select = document.getElementById('skillSchemeSelect');
        if (!select) return;
        var defaultText = (schemes && schemes.length > 0) ? '请选择方案' : '（无可用方案）';
        // 记住当前选中值，避免刷新后丢失选择
        var prevValue = select.value;
        select.innerHTML = '<option value="">' + defaultText + '</option>' +
            (schemes || []).map(function(s) { return '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>'; }).join('');
        // 如果之前有选中值且仍存在，恢复选择
        if (prevValue && schemes && schemes.indexOf(prevValue) >= 0) {
            select.value = prevValue;
        }
    } catch (err) {
        console.error('加载技能方案失败:', err);
    }
}

async function saveSkillScheme() {
    var name = prompt('请输入方案名称：');
    if (!name || name.trim() === '') return;
    name = name.trim();
    // 检查非法字符
    if (/[\\\/:*?"<>|]/.test(name)) {
        showToast('方案名包含非法字符（\\ / : * ? " < > |）', 'error');
        return;
    }
    try {
        var result = await api.SaveSkillScheme(name);
        if (result && result.success === false) {
            showToast('保存方案失败: ' + (result.error || '未知错误'), 'error');
            return;
        }
        showToast('已保存方案：' + name, 'success');
        await loadSkillSchemes();
        // 选中刚保存的方案
        var select = document.getElementById('skillSchemeSelect');
        if (select) select.value = name;
    } catch (err) {
        showToast('保存方案失败: ' + (err.message || err), 'error');
    }
}

async function deleteSkillScheme() {
    var select = document.getElementById('skillSchemeSelect');
    var name = select ? select.value : '';
    if (!name) {
        showToast('请先选择要删除的方案', 'error');
        return;
    }
    if (!confirm('确定删除方案「' + name + '」？')) return;
    try {
        var result = await api.DeleteSkillScheme(name);
        if (result && result.success === false) {
            showToast('删除方案失败: ' + (result.error || '未知错误'), 'error');
            return;
        }
        showToast('已删除方案：' + name, 'success');
        await loadSkillSchemes();
    } catch (err) {
        showToast('删除方案失败: ' + (err.message || err), 'error');
    }
}

async function applySkillScheme() {
    var select = document.getElementById('skillSchemeSelect');
    var name = select ? select.value : '';
    if (!name) {
        showToast('请先选择要应用的方案', 'error');
        return;
    }
    try {
        var result = await api.ApplySkillScheme(name);
        var msgParts = [];
        if (result.applied && result.applied.length > 0) msgParts.push('✓ 成功应用 ' + result.applied.length + ' 个技能');
        if (result.missing && result.missing.length > 0) msgParts.push('✗ ' + result.missing.length + ' 个技能缺失: ' + result.missing.join(', '));
        if (result.conflicts && result.conflicts.length > 0) msgParts.push('✗ ' + result.conflicts.length + ' 个技能冲突: ' + result.conflicts.join(', '));
        if (result.errors && result.errors.length > 0) msgParts.push('✗ 错误: ' + result.errors.join(', '));
        showToast(msgParts.join(' | '), result.success ? 'success' : 'error');
        skillsLoaded = false;
        await loadSkillsData();
    } catch (err) {
        showToast('应用方案失败: ' + (err.message || err), 'error');
    }
}
