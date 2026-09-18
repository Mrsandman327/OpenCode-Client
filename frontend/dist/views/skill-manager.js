// OpenCode 管理中心 - 技能管理视图
// 说明：ES Modules 化改造。core 层依赖静态导入；filebrowser 依赖
// 暂以 typeof 守卫调用，待 filebrowser 改造完成后改为静态 import。
import { api } from '../core/apicall.js';
import { escapeHtml, showToast, isBrowserRuntimeForMain } from '../core/utils.js';
import { store } from '../core/state.js';
import { openFileBrowserModal } from '../filebrowser/browser.js';
import { openDirBrowserModal } from '../filebrowser/dir.js';

export let skills = [];
export let addingSourceDir = false;  // 防重入 guard

// ========== 技能页顶部配置区的 UI 状态 ==========
// 来源目录：并列的多个目录，没有「当前 / 选中」概念（点击 chip 主体只执行打开）
var skillDirs = [];
// 技能方案：技能启用状态的一份份「快照 / 配方」，同样没有「当前 / 选中」概念。
// 事实依据：技能启用哪些由 opencode 全局技能目录下存在哪些软链接决定（唯一真相源）。
// 「应用方案」= 把配方写回真相源（按方案记录增删软链接）；应用后系统里只有一堆软链接，
// 没有任何地方记录「当前用的是哪个方案」，故不存在「当前方案」。
// 因此这里只维护可应用的配方清单，点击 chip 只是「执行应用动作」而非「选中」。
var skillSchemes = [];
// 应用进行中的方案名（'' 表示空闲）。这是临时的「正在执行」忙碌态，
// 用于防止异步应用未完成时连点 chip 重复触发，与「当前 / 选中」无关
var applyingScheme = '';

// 配置区使用的内联 SVG 图标（禁用 emoji，统一线性 stroke 风格）
var CFG_ICON_FOLDER = '<svg class="cfg-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
var CFG_ICON_X = '<svg class="cfg-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
// 方案书签图标：与来源目录的文件夹图标对应，用于方案 chip 主体
var CFG_ICON_BOOKMARK = '<svg class="cfg-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
var CFG_ICON_PLUS = '<svg class="cfg-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

// 取路径末两段作为 chip 上的短标签（完整路径仍保留在 title 提示里）
function shortPath(p) {
    var parts = String(p).split(/[\\/]/).filter(Boolean);
    return parts.length <= 2 ? parts.join('\\') : parts.slice(-2).join('\\');
}

export async function loadSkillsData() {
    if (store.skillsLoaded) return;
    store.skillsLoaded = true;
    try {
        var result = await api.GetSkillConfig();
        skills = result.skills || [];
        renderStats(result.stats);
        renderSourceDirs(result.sourceDirs || []);
        renderSkillList();
        await loadSkillSchemes();
    } catch (err) {
        store.skillsLoaded = false;
        showToast('加载技能数据失败: ' + (err.message || err), 'error');
    }
}

export function renderStats(stats) {
    document.getElementById('statGlobal').textContent = stats ? (stats.globalSkills || 0) : 0;
}

export function renderSkillList(filter) {
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
                    '<button type="button" class="skill-name" data-action="open-skill" data-skill-path="' + safePath + '" style="cursor:pointer;text-decoration:underline;color:var(--accent);background:none;border:none;padding:0;font:inherit;font-size:14px;font-weight:600;">' + safeName + '</button>' +
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

export function bindSkillManagerEvents() {
    var skillList = document.getElementById('skillList');
    if (skillList && !skillList.dataset.bound) {
        skillList.dataset.bound = 'true';
        skillList.addEventListener('click', handleSkillManagerActionClick);
    }
    bindSkillConfigEvents();
}

// 顶部配置区事件：状态行的「更改」展开/收起开关 + 两组 chip 的事件委托
// 容器是静态结构，绑定一次即可（内容由 innerHTML 重绘，委托仍然有效）
function bindSkillConfigEvents() {
    var toggleBtn = document.getElementById('btnSkillCfgToggle');
    var inline = document.getElementById('skillCfgInline');
    if (toggleBtn && inline && !toggleBtn.dataset.bound) {
        toggleBtn.dataset.bound = 'true';
        toggleBtn.addEventListener('click', function() {
            var open = !inline.classList.contains('open');
            inline.classList.toggle('open', open);
            toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
    }
    var dirChips = document.getElementById('skillDirChips');
    if (dirChips && !dirChips.dataset.bound) {
        dirChips.dataset.bound = 'true';
        dirChips.addEventListener('click', handleSkillConfigClick);
    }
    var planChips = document.getElementById('skillPlanChips');
    if (planChips && !planChips.dataset.bound) {
        planChips.dataset.bound = 'true';
        planChips.addEventListener('click', handleSkillConfigClick);
    }
}

// 配置区里 chip 与操作按钮的统一事件处理（6 个功能全部在此分流）
async function handleSkillConfigClick(event) {
    var target = event.target.closest('[data-action]');
    if (!target) return;
    var action = target.dataset.action;

    // ----- 来源目录 -----
    // 功能 1：添加目录
    if (action === 'add-dir') {
        await addSourceDir();
        return;
    }
    // 功能 2：打开目录（一次性动作，只读 skillDirs 中的路径，不写回任何状态）
    if (action === 'open-dir') {
        var dirToOpen = skillDirs[Number(target.dataset.dirIndex)];
        if (dirToOpen) await openSelectedSourceDir(dirToOpen);
        return;
    }
    // 功能 3：删除目录
    if (action === 'remove-dir') {
        var dirToRemove = skillDirs[Number(target.dataset.dirIndex)];
        if (dirToRemove) await removeSourceDir(dirToRemove);
        return;
    }

    // ----- 技能方案 -----
    // 功能 4：方案入库
    if (action === 'save-scheme') {
        await saveSkillScheme();
        return;
    }
    // 功能 5：点击 chip 主体 = 直接应用该方案（与来源目录「点 chip 主体执行该区块主操作」对称）。
    // 这是「执行应用动作」而非「选中」——应用后不回写任何「当前方案」状态
    if (action === 'apply-scheme') {
        await applySkillScheme(target.dataset.schemeName || '');
        return;
    }
    // 功能 6：删除方案
    if (action === 'delete-scheme') {
        await deleteSkillScheme(target.dataset.schemeName || '');
    }
}

export async function handleSkillManagerActionClick(event) {
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

export async function toggleSkill(skillPath, skillName, enable) {
    var result = await api.ToggleSkill(skillPath, skillName, enable);
    if (result.success) {
        showToast((enable ? '已启用 ' : '已禁用 ') + skillName, 'success');
        store.skillsLoaded = false;
        await loadSkillsData();
        return;
    }
    // 失败时抛出错误，由事件处理器回滚 checkbox 状态
    throw new Error(result.error || '未知错误');
}

// 打开技能目录（复用文件浏览器）
export async function openSkillDir(skillPath) {
    try {
        openFileBrowserModal(skillPath);
    } catch (e) {
        showToast('打开技能目录失败: ' + (e.message || e), 'error');
    }
}

// ========== 源目录管理 ==========

export function renderSourceDirs(dirs) {
    skillDirs = (dirs || []).slice();
    renderDirChips();
    renderSkillConfigStatus();
}

// ========== 顶部配置区渲染 ==========

// 状态行摘要：来源目录与技能方案两项完全对称——都只报数量、都不显示名称。
// 依据：技能启用状态由软链接决定，方案只是状态快照，应用后系统不记录「当前用的是哪个方案」，
// 故不存在「当前方案」，状态行不显示方案名，只报可应用方案的数量。
function renderSkillConfigStatus() {
    var srcCountEl = document.getElementById('skillSrcCount');
    if (srcCountEl) {
        srcCountEl.textContent = skillDirs.length ? skillDirs.length + ' 个目录' : '未添加';
    }

    var planCountEl = document.getElementById('skillPlanCount');
    if (planCountEl) {
        planCountEl.textContent = skillSchemes.length ? skillSchemes.length + ' 个' : '未添加';
    }

    // 展开区里的数量徽标
    var dirBadge = document.getElementById('skillDirCountBadge');
    if (dirBadge) dirBadge.textContent = skillDirs.length;
    var planBadge = document.getElementById('skillPlanCountBadge');
    if (planBadge) planBadge.textContent = skillSchemes.length;
}

// 来源目录 chip 行：
//   chip 主体点击 = 打开该目录（一次性动作，不改状态、不产生高亮）
//   chip 上的 ✕   = 删除该目录
//   末尾虚线按钮  = 添加目录
function renderDirChips() {
    var box = document.getElementById('skillDirChips');
    if (!box) return;
    // Web 端（浏览器）无法调用系统文件管理器打开本地目录。
    // 此前该动作由独立按钮承担、并在 Web 模式被隐藏；chip 方案改为点击 chip 主体触发后，
    // 需在这里区分环境：Web 端只提示不支持（点击拦截见 openSelectedSourceDir），不隐藏 chip。
    var webMode = isBrowserRuntimeForMain();
    var html = skillDirs.map(function(dir, i) {
        var safeDir = escapeHtml(dir);
        // Web 端的 chip 主体用 --noop 弱化可点击暗示（默认光标），桌面端保持原有「打开」语义
        var mainCls = 'chip-main' + (webMode ? ' chip-main--noop' : '');
        var mainTitle = webMode ? 'Web 端不支持打开本地目录：' + safeDir : '打开该目录：' + safeDir;
        return '<span class="chip">' +
            '<button type="button" class="' + mainCls + '" data-action="open-dir" data-dir-index="' + i + '" title="' + mainTitle + '">' +
                CFG_ICON_FOLDER +
                '<span class="chip-text">' + escapeHtml(shortPath(dir)) + '</span>' +
            '</button>' +
            '<button type="button" class="chip-x" data-action="remove-dir" data-dir-index="' + i + '" title="移除该来源目录">' + CFG_ICON_X + '</button>' +
        '</span>';
    }).join('');
    html += '<button type="button" class="chip-action" data-action="add-dir" title="添加一个技能来源目录">' + CFG_ICON_PLUS + '添加目录</button>';
    box.innerHTML = html;
}

// 技能方案 chip 行（结构与来源目录 chip 行完全对称）：
//   chip 主体点击 = 应用该方案（一次性动作，把配方写回软链接；不产生任何高亮 / 选中态）
//   chip 上的 ✕   = 删除该方案
//   末尾虚线按钮  = 保存为方案（把当前技能启用状态保存为一份配方）
// 概念说明：方案只是技能启用状态的一份快照（配方），应用后系统里只有软链接，
// 没有任何地方记录「当前用的是哪个方案」，所以「当前方案 / 选中方案」是误解——
// 点击 chip 只是「执行应用动作」，而非「选中」。应用进行中该 chip 呈忙碌态并禁用
function renderPlanChips() {
    var box = document.getElementById('skillPlanChips');
    if (!box) return;
    var html = skillSchemes.map(function(name) {
        var isBusy = (name === applyingScheme);
        var safeName = escapeHtml(name);
        var mainTitle = isBusy ? '正在应用方案：' + safeName : '点击应用该方案：' + safeName;
        // 应用进行中禁用所有 chip 主体与 ✕，避免连点重复触发
        var disabledAttr = applyingScheme ? ' disabled' : '';
        return '<span class="chip' + (isBusy ? ' chip--busy' : '') + '">' +
            '<button type="button" class="chip-main" data-action="apply-scheme" data-scheme-name="' + safeName + '" title="' + mainTitle + '"' + disabledAttr + '>' +
                CFG_ICON_BOOKMARK +
                '<span class="chip-text">' + safeName + '</span>' +
            '</button>' +
            '<button type="button" class="chip-x" data-action="delete-scheme" data-scheme-name="' + safeName + '" title="删除该方案"' + disabledAttr + '>' + CFG_ICON_X + '</button>' +
        '</span>';
    }).join('');
    html += '<button type="button" class="chip-action" data-action="save-scheme" title="把当前技能启用状态保存为方案">' + CFG_ICON_PLUS + '保存为方案</button>';
    box.innerHTML = html;
}

export async function addSourceDir() {
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

export async function performAddSourceDir(dir) {
    try {
        var result = await api.AddSkillSourceDir(dir);
        if (result && result.success === false) {
            showToast('添加目录失败: ' + (result.error || '未知错误'), 'error');
            return;
        }
        showToast('已添加目录: ' + dir, 'success');
        // 重新拉取并整体重绘配置区（chip 行 + 状态行）
        store.skillsLoaded = false;
        await loadSkillsData();
    } catch (err) {
        showToast('添加目录失败: ' + (err.message || err), 'error');
    }
}

// 删除来源目录。dir 由 chip 上的 ✕ 传入（不再从下拉框读取）
export async function removeSourceDir(dir) {
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
        store.skillsLoaded = false;
        await loadSkillsData();
    } catch (err) {
        showToast('删除目录失败: ' + (err.message || err), 'error');
    }
}

// 打开来源目录。dir 由 chip 主体点击传入。
// 这是一次性动作：不修改 skillDirs，也不产生任何选中 / 高亮状态。
export async function openSelectedSourceDir(dir) {
    if (!dir) {
        showToast('请先选择要打开的目录', 'error');
        return;
    }
    // Web 端（浏览器）无法调用系统文件管理器打开本地目录：
    // 原实现是在 Web 模式隐藏专属按钮，chip 方案改由点击 chip 触发后必须在此拦截，
    // 否则点击会静默无效或报错。这里给出明确提示，让用户知道是环境限制而非故障。
    if (isBrowserRuntimeForMain()) {
        showToast('Web 端不支持打开本地目录，请在桌面端使用该功能', 'info');
        return;
    }
    try {
        await api.OpenDir(dir);
    } catch (err) {
        showToast('打开目录失败: ' + (err.message || err), 'error');
    }
}

// ========== 技能方案管理 ==========

export async function loadSkillSchemes() {
    try {
        var schemes = await api.ListSkillSchemes();
        // 后端只返回方案名列表（配方清单）。方案没有「当前 / 选中」概念，
        // 无需回填任何「生效方案」状态，直接渲染清单即可
        skillSchemes = schemes || [];
        renderPlanChips();
        renderSkillConfigStatus();
    } catch (err) {
        console.error('加载技能方案失败:', err);
    }
}

export async function saveSkillScheme() {
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
        // 保存只是新增一份配方，不等于已应用，也不存在「当前方案」需要维护
        await loadSkillSchemes();
    } catch (err) {
        showToast('保存方案失败: ' + (err.message || err), 'error');
    }
}

// 删除技能方案。name 由 chip 上的 ✕ 传入（不再从下拉框读取）
export async function deleteSkillScheme(name) {
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
        // 删除只是移除一份配方；不涉及「当前方案」状态（本就不存在该状态）
        await loadSkillSchemes();
    } catch (err) {
        showToast('删除方案失败: ' + (err.message || err), 'error');
    }
}

// 应用技能方案。name 由方案 chip 主体点击传入。
// 语义：把该方案（配方）写回唯一真相源——opencode 全局技能目录下的软链接。
// 应用成功后系统里只有软链接，不会记录「当前用的是哪个方案」，
// 故此处不写入任何持久状态，仅用 toast 反馈结果；下次点击只是再次执行应用动作。
export async function applySkillScheme(name) {
    // 防重复点击：上一次应用尚未结束时拒绝新的触发
    if (applyingScheme) {
        showToast('方案「' + applyingScheme + '」正在应用中，请稍候…', 'info');
        return;
    }
    if (!name) {
        showToast('请先选择要应用的方案', 'error');
        return;
    }
    applyingScheme = name;
    renderPlanChips();  // 立即进入忙碌态：chip 禁用，给出「处理中」反馈，避免连点
    try {
        var result = await api.ApplySkillScheme(name);
        var msgParts = [];
        if (result.applied && result.applied.length > 0) msgParts.push('✓ 成功应用 ' + result.applied.length + ' 个技能');
        if (result.missing && result.missing.length > 0) msgParts.push('✗ ' + result.missing.length + ' 个技能缺失: ' + result.missing.join(', '));
        if (result.conflicts && result.conflicts.length > 0) msgParts.push('✗ ' + result.conflicts.length + ' 个技能冲突: ' + result.conflicts.join(', '));
        if (result.errors && result.errors.length > 0) msgParts.push('✗ 错误: ' + result.errors.join(', '));
        showToast(msgParts.join(' | '), result.success ? 'success' : 'error');
        store.skillsLoaded = false;
        await loadSkillsData();
    } catch (err) {
        showToast('应用方案失败: ' + (err.message || err), 'error');
    } finally {
        // 无论成败都退出忙碌态，恢复 chip 可点击
        applyingScheme = '';
        renderPlanChips();
        renderSkillConfigStatus();
    }
}
