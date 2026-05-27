// OpenCode 管理中心 - 技能管理视图
let skills = [];
let skillsLoaded = false;
let addingSourceDir = false;  // 防重入 guard

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
}

async function handleSkillManagerActionClick(event) {
    var target = event.target.closest('[data-action]');
    if (!target) return;
    var action = target.dataset.action;
    if (action === 'open-skill') {
        await openSkillDir(target.dataset.skillPath || '');
        return;
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

// 打开技能目录（复用文件浏览器）
async function openSkillDir(skillPath) {
    try {
        if (typeof openFileBrowserModal === 'function') {
            openFileBrowserModal(skillPath);
        } else {
            showToast('文件浏览器模块未加载', 'error');
        }
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
