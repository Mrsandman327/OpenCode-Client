// ============================================================
// OpenCode 管理中心 - OMO 配置视图
// ============================================================
// 说明：ES Modules 化改造。core 层依赖静态导入；本文件不依赖
// filebrowser/chat 模块，无守卫调用。以下 modelEntries 等均为本
// 文件内的模块级变量（非 core/state.js 的 store），保持局部。
import { api } from '../core/apicall.js';
import { escapeHtml, showToast } from '../core/utils.js';
import { store } from '../core/state.js';

export let modelEntries = [];
export let modelTypes = [];
export let originalEntries = [];
export let modelSectionsLoaded = false;

export const REASONING_OPTIONS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// ========== 方案管理状态 ==========
export let schemeDir = '';
export let schemeList = [];
export let currentSourceType = '';   // 'system' | 'imported' | 'scheme' | ''
export let currentSourceName = '';   // display name
export let hasUnsavedChanges = false;
export let originalState = '';       // JSON serialized comparison baseline

// ========== 加载 ==========
// 前端只接触结构化 ModelEntry 数据，JSON 结构完全由后端负责。
export async function loadModelConfig() {
    const container = document.getElementById('modelConfig');

    container.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在加载OMO 配置...</p></div>';

    try {
        // 后端返回结构化 entries + 路径 + 描述表
        const [entries, confPath, descMap] = await Promise.all([
            api.GetModelConfig().catch(() => []),
            api.GetConfigPath(),
            (typeof api.GetAgentDescriptions === 'function'
                ? api.GetAgentDescriptions().catch(() => ({}))
                : Promise.resolve({})),
        ]);

        modelEntries = (entries || []).map(e => ({
            id: modelEntryId(e.type, e.key),
            key: e.key,
            type: e.type,
            model: e.model || '',
            variant: e.variant || '',
            reasoning: e.reasoning || '',
            comment: descMap[e.key] || e.comment || '',
        }));
        modelTypes = [...new Set(modelEntries.map(e => e.type))];
        originalEntries = modelEntries.map(e => ({ ...e }));
        modelSectionsLoaded = true;

        document.getElementById('configPath').textContent = confPath || '未知';
        const configPathInfo = document.getElementById('omoConfigPath');
        if (configPathInfo) configPathInfo.textContent = confPath || '未知';
    renderModelConfig();

    // 初始化方案状态
        originalState = JSON.stringify(buildModelConfig());
        currentSourceType = 'system';
        currentSourceName = '';
        hasUnsavedChanges = false;
        updateSchemeStatus();
        initSchemes().then(() => {
            document.getElementById('omoSchemeDir').textContent = schemeDir || '未知';
            updateSchemeDropdown();
        });

        // 后台尝试加载模型列表，不阻塞页面
        api.OpenCodeCall('GET', '/provider').then(function(models) {
            if (models && models.length) {
                store.availableModels = models;
                renderModelConfig();
            }
        }).catch(function() {});
    } catch (err) {
        container.innerHTML = `<div class="error"><p>⚠️ 加载失败</p><p class="error-detail">${escapeHtml(err.message||err)}</p><button class="btn btn-primary">重试</button></div>`;
        // ESM 下内联 onclick 失效，改为事件监听绑定
        var retryBtn = container.querySelector('.btn.btn-primary');
        if (retryBtn) retryBtn.addEventListener('click', loadModelConfig);
    }
}

export function modelEntryId(type, key) {
    return `${type}\u0000${key}`;
}

export function modelSelectOptions(models, currentModel) {
    const options = models && models.length ? [...models] : [];
    if (currentModel && !options.includes(currentModel)) {
        options.unshift(currentModel);
    }
    return options;
}

export function sameModelEntry(a, b) {
    return a && b && a.type === b.type && a.key === b.key;
}

export function isModelSection(section) {
    if (!section || Array.isArray(section) || typeof section !== 'object') return false;
    const values = Object.values(section);
    if (values.length === 0) return false;
    return values.every(value => value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'model'));
}

export function isEmptyModelSectionName(type) {
    if (type === 'agents' || type === 'categories') return true;
    if (['mcp', 'provider', 'providers', 'commands', 'settings'].includes(type)) return false;
    return type.length > 3 && type.endsWith('s');
}

export function stripJsonComments(jsonStr) {
    if (jsonStr == null) return '';
    return String(jsonStr).replace(/(?<!:)\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// ============================
// 渲染OMO 配置
// ============================

export function renderModelConfig() {
    const container = document.getElementById('modelConfig');
    const actions = document.getElementById('modelActions');

    container.innerHTML = '';
    actions.style.display = 'flex';

    if (modelTypes.length === 0) {
        container.innerHTML = '<div class="empty"><p>📭 未找到OMO 配置类型</p><p class="empty-hint">点击底部"添加类型"创建 agents、categories 等分组</p></div>';
        const bb = document.getElementById('omoBatchBar');
        if (bb) bb.innerHTML = '';
        updateSaveStatus();
        checkUnsavedChanges();
        return;
    }

    const bar = document.createElement('div');
    bar.className = 'batch-model-bar';
    bar.innerHTML = `
        <label class="batch-check"><input type="checkbox" id="selectAllModels" /> <span>全选</span></label>
        <select class="batch-model-select" id="batchModelSelect">
            <option value="">-- 批量设置模型 --</option>
            ${store.availableModels.map(m => `<option value="${m}">${m}</option>`).join('')}
        </select>
        <button class="btn btn-sm btn-open" id="btnApplyBatch">应用</button>
    `;
    const batchBar = document.getElementById('omoBatchBar');
    if (batchBar) {
        batchBar.innerHTML = '';
        batchBar.appendChild(bar);
    }

    document.getElementById('selectAllModels').addEventListener('change', e => {
        document.querySelectorAll('.model-check').forEach(cb => cb.checked = e.target.checked);
    });
    document.getElementById('btnApplyBatch').addEventListener('click', () => {
        const model = document.getElementById('batchModelSelect').value;
        if (!model) return;
        document.querySelectorAll('.model-check:checked').forEach(cb => {
            const entry = modelEntries.find(e => e.id === cb.dataset.id);
            if (entry) {
                entry.model = model;
            }
        });
        renderModelConfig();
        updateSaveStatus();
        checkUnsavedChanges();
    });

    modelTypes.forEach(type => {
        const entries = modelEntries.filter(e => e.type === type);
        container.appendChild(createModelGroup(modelTypeTitle(type), entries, type));
    });

    container.querySelectorAll('.model-select').forEach(select => {
        select.addEventListener('change', e => {
            const entry = modelEntries.find(en => en.id === e.target.dataset.id);
            if (entry) {
                entry.model = e.target.value;
                updateSaveStatus(); checkUnsavedChanges();
            }
        });
    });

    container.querySelectorAll('.model-reasoning-select').forEach(select => {
        select.addEventListener('change', e => {
            const entry = modelEntries.find(en => en.id === e.target.dataset.id);
            if (entry) {
                entry.reasoning = e.target.value;
                updateSaveStatus(); checkUnsavedChanges();
            }
        });
    });

    updateSaveStatus();
    checkUnsavedChanges();
}

export function modelTypeTitle(type) {
    const builtIn = { agents: '🤖 Agents', categories: '📦 Categories' };
    return builtIn[type] || `🧩 ${type}`;
}

export function createModelGroup(title, entries, entryType) {
    const group = document.createElement('div');
    group.className = 'model-group';

    const header = document.createElement('h3');
    header.className = 'model-group-title';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'model-group-label';
    titleSpan.textContent = title;
    const headerActions = document.createElement('span');
    headerActions.className = 'model-group-actions';

    // 卡片内全选
    const selectAll = document.createElement('label');
    selectAll.className = 'model-group-select-all';
    selectAll.innerHTML = '<input type="checkbox"> 全选';
    selectAll.addEventListener('click', (e) => {
        e.stopPropagation();
    });
    selectAll.querySelector('input').addEventListener('change', (e) => {
        const checked = e.target.checked;
        body.querySelectorAll('.model-check').forEach(cb => { cb.checked = checked; });
    });
    headerActions.appendChild(selectAll);

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-add-entry';
    addBtn.dataset.type = entryType;
    addBtn.title = '添加条目';
    addBtn.textContent = '+';
    const deleteTypeBtn = document.createElement('button');
    deleteTypeBtn.className = 'btn-delete-type';
    deleteTypeBtn.dataset.type = entryType;
    deleteTypeBtn.title = '删除类型';
    deleteTypeBtn.textContent = '✕';
    headerActions.appendChild(addBtn);
    headerActions.appendChild(deleteTypeBtn);
    header.appendChild(titleSpan);
    header.appendChild(headerActions);

    addBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        showAddEntryModal(entryType);
    });

    deleteTypeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteModelType(entryType, entries.length);
    });

    header.addEventListener('click', (e) => {
        if (e.target.closest('.model-group-actions')) return;
        header.classList.toggle('collapsed');
        body.classList.toggle('collapsed');
    });

    const body = document.createElement('div');
    body.className = 'model-group-body';

    entries.forEach(entry => {
        const isChanged = originalEntries.find(o => sameModelEntry(o, entry))?.model !== entry.model;
        const row = document.createElement('div');
        row.className = 'model-row' + (isChanged ? ' changed' : '');
        row.dataset.key = entry.key;
        row.dataset.id = entry.id;

        const topRow = document.createElement('div');
        topRow.className = 'model-row-top';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'model-check';
        cb.dataset.key = entry.key;
        cb.dataset.id = entry.id;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'model-key';
        nameSpan.textContent = entry.key;

        const select = document.createElement('select');
        select.className = 'model-select';
        select.dataset.key = entry.key;
        select.dataset.id = entry.id;
        modelSelectOptions(store.availableModels, entry.model).forEach(m => {
            const opt = document.createElement('option');
            opt.value = m; opt.textContent = m;
            if (m === entry.model) opt.selected = true;
            select.appendChild(opt);
        });

        const reasoningSelect = document.createElement('select');
        reasoningSelect.className = 'model-reasoning-select';
        reasoningSelect.dataset.key = entry.key;
        reasoningSelect.dataset.id = entry.id;
        REASONING_OPTIONS.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v; opt.textContent = v;
            if (v === entry.reasoning) opt.selected = true;
            reasoningSelect.appendChild(opt);
        });

        const badge = document.createElement('span');
        badge.className = 'model-type-badge';
        badge.textContent = entry.type;

        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-del';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', () => {
            if (!confirm(`确定删除 ${entry.key}?`)) return;
            modelEntries = modelEntries.filter(e => !sameModelEntry(e, entry));
            renderModelConfig();
            updateSaveStatus();
            checkUnsavedChanges();
            showToast(`已标记删除 ${entry.key}（点击保存生效）`, 'info');
        });

        topRow.appendChild(cb);
        topRow.appendChild(nameSpan);
        topRow.appendChild(select);
        topRow.appendChild(reasoningSelect);
        topRow.appendChild(badge);
        topRow.appendChild(delBtn);
        row.appendChild(topRow);

        if (entry.comment) {
            const commentDiv = document.createElement('div');
            commentDiv.className = 'model-comment';
            commentDiv.textContent = entry.comment;
            row.appendChild(commentDiv);
        }

        body.appendChild(row);
    });

    if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'model-group-empty';
        empty.textContent = '暂无条目，点击标题右侧 + 添加';
        body.appendChild(empty);
    }

    group.appendChild(header);
    group.appendChild(body);
    return group;
}

export async function deleteModelType(entryType, entryCount) {
    const warning = entryCount > 0 ? `，其中包含 ${entryCount} 个条目` : '';
    if (!confirm(`确定删除类型 ${entryType}${warning}？此操作会立即写入配置文件。`)) return;
    const result = await api.DeleteModelType(entryType);
    if (!result.success) {
        showToast('删除类型失败: ' + (result.error || '未知错误'), 'error');
        return;
    }
    modelTypes = modelTypes.filter(type => type !== entryType);
    modelEntries = modelEntries.filter(entry => entry.type !== entryType);
    originalEntries = originalEntries.filter(entry => entry.type !== entryType);
    renderModelConfig();
    checkUnsavedChanges();
    showToast(`已删除类型 ${entryType}`, 'success');
}

export function showAddTypeModal() {
    const old = document.querySelector('.modal-overlay');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal">
            <h3>添加OMO 配置类型</h3>
            <div class="modal-field"><label>类型名称（section）</label><input id="modalTypeKey" placeholder="如 agents / categories / reviewers" /></div>
            <div class="modal-actions"><button class="btn btn-cancel" id="btnCancelAddType">取消</button><button class="btn btn-primary" id="btnConfirmAddType">➕ 添加类型</button></div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', () => overlay.remove());
    overlay.querySelector('.modal').addEventListener('click', (e) => e.stopPropagation());
    overlay.querySelector('#btnCancelAddType').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#btnConfirmAddType').addEventListener('click', async () => {
        const type = overlay.querySelector('#modalTypeKey').value.trim();
        if (!type) { showToast('类型名称不能为空', 'error'); return; }
        if (modelTypes.includes(type)) { showToast('类型已存在', 'error'); return; }
        const result = await api.AddModelType(type);
        if (!result.success) { showToast('添加类型失败: ' + (result.error || '未知错误'), 'error'); return; }
        modelTypes.push(type);
        overlay.remove();
        renderModelConfig();
        checkUnsavedChanges();
        showToast(`已添加类型 ${type}`, 'success');
    });
}

export function showAddEntryModal(entryType) {
    const old = document.querySelector('.modal-overlay');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal">
            <h3>添加 ${modelTypeTitle(entryType).replace(/^[^\w\u4e00-\u9fa5]+\s*/, '')}</h3>
            <div class="modal-field"><label>Key（唯一标识）</label><input id="modalEntryKey" placeholder="如 my-agent" /></div>
            <div class="modal-field"><label>模型</label><select id="modalEntryModel" class="modal-select">${store.availableModels.map(m => `<option value="${m}">${m}</option>`).join('')}</select></div>
            <div class="modal-field"><label>Reasoning</label><select id="modalEntryReasoning" class="modal-select">${REASONING_OPTIONS.map(v => `<option value="${v}">${v}</option>`).join('')}</select></div>
            <div class="modal-field"><label>描述（作为注释）</label><input id="modalEntryComment" placeholder="简要描述用途" /></div>
            <div class="modal-actions"><button class="btn btn-cancel" id="btnCancelAdd">取消</button><button class="btn btn-primary" id="btnConfirmAdd">💾 添加</button></div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', () => overlay.remove());
    overlay.querySelector('.modal').addEventListener('click', (e) => e.stopPropagation());
    overlay.querySelector('#btnCancelAdd').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#btnConfirmAdd').addEventListener('click', () => {
        const key = overlay.querySelector('#modalEntryKey').value.trim();
        const model = overlay.querySelector('#modalEntryModel').value;
        const reasoning = overlay.querySelector('#modalEntryReasoning').value;
        const comment = overlay.querySelector('#modalEntryComment').value.trim();
        if (!key) { showToast('Key 不能为空', 'error'); return; }
        if (modelEntries.find(e => e.type === entryType && e.key === key)) { showToast('当前类型下 Key 已存在', 'error'); return; }
        modelEntries.push({ id: modelEntryId(entryType, key), key, type: entryType, model: model || 'deepseek-v4-flash', variant: '', reasoning, comment });
        overlay.remove();
        renderModelConfig();
        updateSaveStatus();
        checkUnsavedChanges();
        showToast(`已添加 ${key}（点击保存生效）`, 'info');
    });
}

export function updateSaveStatus() {
    const changed = modelEntries.filter(e => {
        const orig = originalEntries.find(o => sameModelEntry(o, e));
        return !orig || orig.model !== e.model || orig.variant !== e.variant || orig.reasoning !== e.reasoning;
    }).length;
    const deleted = originalEntries.filter(o => !modelEntries.find(e => sameModelEntry(e, o))).length;
    const total = changed + deleted;

    const status = document.getElementById('saveStatus');
    if (total > 0) {
        status.textContent = `${total} 项未保存 (改${changed} 删${deleted})`;
        status.className = 'save-status changed';
    } else {
        status.textContent = '已是最新';
        status.className = 'save-status';
    }
}

// ============================================================
// 方案管理
// ============================================================

// ========== 方案初始化 ==========
export async function initSchemes() {
    try {
        schemeDir = await api.GetSchemeDir();
        schemeList = await api.ListSchemes() || [];
    } catch (e) {
        schemeDir = '';
        schemeList = [];
    }
}

// ========== 方案数据加载 ==========
export async function loadSchemeIntoEditor(name) {
    try {
        // 方案文件由后端解析为结构化条目
        const entries = await api.ReadSchemeEntries(name);
        applyEntries(entries);
        await applyDescriptions();
        currentSourceType = 'scheme';
        currentSourceName = name;
        renderModelConfig();
        checkUnsavedChanges();
        updateSchemeStatus();
        return true;
    } catch (e) {
        showToast('方案加载失败: ' + (e.message || e), 'error');
        return false;
    }
}

export function checkUnsavedChanges() {
    // 每次模型条目变更后调用
    const current = JSON.stringify(buildModelConfig());
    hasUnsavedChanges = current !== originalState;
    updateSchemeStatus();
}

export function buildModelConfig() {
    const map = {};
    modelEntries.forEach(e => {
        if (!map[e.type]) map[e.type] = {};
        map[e.type][e.key] = { model: e.model, variant: e.variant, reasoning: e.reasoning };
    });
    return map;
}

// 保存时直接提交结构化 entries，由后端负责 JSON 结构写入。
export function buildSaveEntries() {
    return modelEntries.map(e => ({
        key: e.key,
        type: e.type,
        model: e.model || '',
        variant: e.variant || '',
        reasoning: e.reasoning || '',
        comment: e.comment || '',
    }));
}

// 从结构化数据重建编辑条目（方案加载/导入共用）
export function rebuildModelEntriesFromData(data) {
    modelEntries = [];
    modelTypes = [];
    for (const [type, section] of Object.entries(data || {})) {
        if (!isModelSection(section) && !(section && Object.keys(section).length === 0 && isEmptyModelSectionName(type))) continue;
        modelTypes.push(type);
        for (const [key, val] of Object.entries(section)) {
            modelEntries.push({
                id: modelEntryId(type, key),
                key,
                type,
                model: val.model || '',
                variant: val.variant || '',
                reasoning: val.reasoning || '',
                comment: '',
            });
        }
    }
}

// 从后端结构化 entries 重建（方案切换）
export function applyEntries(entries) {
    modelEntries = (entries || []).map(e => ({
        id: modelEntryId(e.type, e.key),
        key: e.key,
        type: e.type,
        model: e.model || '',
        variant: e.variant || '',
        reasoning: e.reasoning || '',
        comment: e.comment || '',
    }));
    modelTypes = [...new Set(modelEntries.map(e => e.type))];
}

// 从后端加载描述表并应用到当前 modelEntries
export async function applyDescriptions() {
    if (typeof api.GetAgentDescriptions !== 'function') return;
    try {
        const descs = await api.GetAgentDescriptions();
        if (!descs) return;
        modelEntries.forEach(e => {
            if (!e.comment && descs[e.key]) e.comment = descs[e.key];
        });
    } catch (_) { /* 非关键路径 */ }
}

// 从外部数据渲染（用于方案导入/加载，不改变原始配置引用）
export function renderModelConfigFromData(data) {
    rebuildModelEntriesFromData(data);
    originalEntries = modelEntries.map(e => ({ ...e }));
    renderModelConfig();
}

// ========== 方案交互处理 ==========
export async function handleSchemeImport() {
    if (hasUnsavedChanges) {
        if (!confirm('当前编辑区有未保存修改，继续导入将覆盖当前内容。是否继续？')) return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.jsonc,.json';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            // JSON 结构解析完全交由后端，前端只收结构化条目
            const entries = await api.ParseConfigContent(text);
            applyEntries(entries);
            await applyDescriptions();
            currentSourceType = 'imported';
            currentSourceName = '外部: ' + file.name.replace(/\.(jsonc|json)$/i, '');
            renderModelConfig();
            checkUnsavedChanges();
            updateSchemeStatus();
        } catch (err) {
            showToast('导入失败: ' + (err.message || '文件格式不正确或内容不可解析'), 'error');
        }
    };
    input.click();
}

export async function handleSchemeExport() {
    const name = prompt('请输入导出文件名：', 'oh-my-openagent.jsonc');
    if (!name) return;
    // 弹出目录选择对话框
    const dir = await api.OpenDirectoryDialog();
    if (!dir) return;
    try {
        // 结构化数据交给后端生成 JSONC
        const entries = buildSaveEntries();
        const savedPath = await api.ExportConfigEntries(dir, name, entries);
        showToast('已导出: ' + savedPath, 'success');
    } catch (e) {
        showToast('导出失败: ' + (e.message || e), 'error');
    }
}

export async function handleSchemeSave() {
    const name = prompt('请输入方案名称：');
    if (!name) return;
    if (/[\\/:*?"<>|]/.test(name)) {
        showToast('方案名包含非法字符', 'error');
        return;
    }
    try {
        const entries = buildSaveEntries();
        await api.SaveSchemeEntries(name, entries);
        await initSchemes();
        showToast('已保存到方案目录: ' + name, 'success');
        updateSchemeDropdown();
    } catch (e) {
        showToast('保存到方案目录失败: ' + (e.message || e), 'error');
    }
}

export async function handleSchemeSwitch(name) {
    if (!name) return;
    if (hasUnsavedChanges) {
        if (!confirm('当前编辑区有未保存修改，切换方案将覆盖当前内容。是否继续？')) return;
    }
    const ok = await loadSchemeIntoEditor(name);
    if (ok) {
        updateSchemeStatus();
        showToast('已加载方案: ' + name, 'success');
    }
}

export async function handleSchemeApply() {
    // 保存当前编辑内容到实际配置文件（提交结构化 entries，后端负责 JSON 写入）
    const totalChanges = modelEntries.filter(e => {
        const orig = originalEntries.find(o => sameModelEntry(o, e));
        return !orig || orig.model !== e.model || orig.variant !== e.variant || orig.reasoning !== e.reasoning;
    }).length + originalEntries.filter(o => !modelEntries.find(e => sameModelEntry(e, o))).length;

    if (totalChanges === 0) {
        showToast('没有需要保存的更改', 'info');
        return;
    }

    const btn = document.getElementById('btnSaveModels');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ 保存中...';
    }
    showToast('保存中...', 'info');

    try {
        const result = await api.UpdateModels(buildSaveEntries());
        if (result.success) {
            originalEntries = modelEntries.map(e => ({ ...e }));
            originalState = JSON.stringify(buildModelConfig());
            currentSourceType = 'system';
            currentSourceName = '';
            hasUnsavedChanges = false;
            updateSaveStatus();
            updateSchemeStatus();
            renderModelConfig();
            showToast(`已保存 ${totalChanges} 项更改`, 'success');
        } else {
            showToast('保存失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (err) {
        showToast('保存失败: ' + (err.message || err), 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '💾 保存';
        }
    }
}

// ========== 方案 UI 更新 ==========
export function updateSchemeStatus() {
    const bar = document.getElementById('omoSchemeStatus');
    if (!bar) return;
    if (currentSourceType === 'system' && !hasUnsavedChanges) {
        bar.textContent = '当前配置已应用 ✓';
        bar.style.background = 'transparent';
        return;
    }
    if (currentSourceType === 'imported' && !hasUnsavedChanges) {
        bar.textContent = '已导入外部方案：' + currentSourceName + '，当前仅加载到编辑区';
        bar.style.background = 'var(--accent-ghost)';
        return;
    }
    if (currentSourceType === 'scheme' && !hasUnsavedChanges) {
        bar.textContent = '当前已加载方案：' + currentSourceName + '，尚未应用';
        bar.style.background = 'var(--accent-ghost)';
        return;
    }
    if (hasUnsavedChanges) {
        bar.textContent = '当前编辑内容已修改，尚未保存并应用';
        bar.style.background = 'var(--accent-ghost)';
        return;
    }
    bar.textContent = '';
    bar.style.background = 'transparent';
}

export function updateSchemeDropdown() {
    const sel = document.getElementById('schemeSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">' + (schemeList.length ? '请选择方案' : '（无可用方案）') + '</option>';
    schemeList.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.name;
        opt.textContent = s.name;
        sel.appendChild(opt);
    });
    sel.disabled = !schemeList.length;
}
