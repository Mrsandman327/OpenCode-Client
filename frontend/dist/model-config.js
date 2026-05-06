// ============================================================
// OpenCode 管理中心 - 模型配置视图
// ============================================================

let modelEntries = [];
let modelTypes = [];
let availableModels = [];
let originalEntries = [];
let modelSectionsLoaded = false;

let fullConfigJson = {};
let fullConfigRaw = '';

async function loadModelConfig() {
    const container = document.getElementById('modelConfig');

    container.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在加载模型配置...</p></div>';

    try {
        const [fullConfig, models, confPath] = await Promise.all([
            api.GetFullConfig(),
            api.GetAvailableModels(),
            api.GetConfigPath(),
        ]);

        fullConfigRaw = fullConfig || '';
        fullConfigJson = JSON.parse(stripJsonComments(fullConfig) || '{}');
        availableModels = models || [];

        modelEntries = [];
        modelTypes = [];
        const commentMap = extractComments(fullConfigRaw);
        for (const [type, section] of Object.entries(fullConfigJson)) {
            if (!isModelSection(section) && !(section && Object.keys(section).length === 0 && isEmptyModelSectionName(type))) continue;
            modelTypes.push(type);
            for (const [key, val] of Object.entries(section)) {
                modelEntries.push({ id: modelEntryId(type, key), key, type, model: val.model || '', comment: commentMap[key] || '' });
            }
        }
        originalEntries = modelEntries.map(e => ({ ...e }));

        document.getElementById('configPath').textContent = confPath || '未知';
        renderModelConfig();
    } catch (err) {
        container.innerHTML = `<div class="error"><p>⚠️ 加载失败</p><p class="error-detail">${escapeHtml(err.message||err)}</p><button class="btn btn-primary" onclick="loadModelConfig()">重试</button></div>`;
    }
}

function modelEntryId(type, key) {
    return `${type}\u0000${key}`;
}

function sameModelEntry(a, b) {
    return a && b && a.type === b.type && a.key === b.key;
}

function isModelSection(section) {
    if (!section || Array.isArray(section) || typeof section !== 'object') return false;
    const values = Object.values(section);
    if (values.length === 0) return false;
    return values.every(value => value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'model'));
}

function isEmptyModelSectionName(type) {
    if (type === 'agents' || type === 'categories') return true;
    if (['mcp', 'provider', 'providers', 'commands', 'settings'].includes(type)) return false;
    return type.length > 3 && type.endsWith('s');
}

function stripJsonComments(jsonStr) {
    if (jsonStr == null) return '';
    return String(jsonStr).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function extractComments(text) {
    const map = {};
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const keyMatch = line.match(/"([^"]+)"\s*:\s*\{/);
        if (!keyMatch) continue;

        const key = keyMatch[1];
        for (let j = i; j < lines.length && j < i + 5; j++) {
            const cmtIdx = lines[j].indexOf('//');
            if (cmtIdx >= 0) {
                const before = lines[j].substring(0, cmtIdx);
                if ((before.match(/"/g) || []).length % 2 === 0) {
                    map[key] = lines[j].substring(cmtIdx + 2).trim();
                    break;
                }
            }
            if (lines[j].includes('}') && !lines[j].includes('{')) break;
        }
    }
    return map;
}

// ============================
// 渲染模型配置
// ============================

function renderModelConfig() {
    const container = document.getElementById('modelConfig');
    const actions = document.getElementById('modelActions');

    container.innerHTML = '';
    actions.style.display = 'flex';

    if (modelTypes.length === 0) {
        container.innerHTML = '<div class="empty"><p>📭 未找到模型配置类型</p><p class="empty-hint">点击底部"添加类型"创建 agents、categories 等分组</p></div>';
        updateSaveStatus();
        return;
    }

    const bar = document.createElement('div');
    bar.className = 'batch-model-bar';
    bar.innerHTML = `
        <label class="batch-check"><input type="checkbox" id="selectAllModels" /> <span>全选</span></label>
        <select class="batch-model-select" id="batchModelSelect">
            <option value="">-- 批量设置模型 --</option>
            ${availableModels.map(m => `<option value="${m}">${m}</option>`).join('')}
        </select>
        <button class="btn btn-sm" id="btnApplyBatch">应用</button>
    `;
    container.appendChild(bar);

    document.getElementById('selectAllModels').addEventListener('change', e => {
        document.querySelectorAll('.model-check').forEach(cb => cb.checked = e.target.checked);
    });
    document.getElementById('btnApplyBatch').addEventListener('click', () => {
        const model = document.getElementById('batchModelSelect').value;
        if (!model) return;
        document.querySelectorAll('.model-check:checked').forEach(cb => {
            const entry = modelEntries.find(e => e.id === cb.dataset.id);
            if (entry) entry.model = model;
        });
        renderModelConfig();
        updateSaveStatus();
    });

    modelTypes.forEach(type => {
        const entries = modelEntries.filter(e => e.type === type);
        container.appendChild(createModelGroup(modelTypeTitle(type), entries, type));
    });

    container.querySelectorAll('.model-select').forEach(select => {
        select.addEventListener('change', e => {
            const entry = modelEntries.find(en => en.id === e.target.dataset.id);
            if (entry) { entry.model = e.target.value; updateSaveStatus(); }
        });
    });

    updateSaveStatus();
}

function modelTypeTitle(type) {
    const builtIn = { agents: '🤖 Agents', categories: '📦 Categories' };
    return builtIn[type] || `🧩 ${type}`;
}

function createModelGroup(title, entries, entryType) {
    const group = document.createElement('div');
    group.className = 'model-group';

    const header = document.createElement('h3');
    header.className = 'model-group-title';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'model-group-label';
    titleSpan.textContent = title;
    const headerActions = document.createElement('span');
    headerActions.className = 'model-group-actions';
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
        availableModels.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m; opt.textContent = m;
            if (m === entry.model) opt.selected = true;
            select.appendChild(opt);
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
            showToast(`已标记删除 ${entry.key}（点击保存生效）`, 'info');
        });

        topRow.appendChild(cb);
        topRow.appendChild(nameSpan);
        topRow.appendChild(select);
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

async function deleteModelType(entryType, entryCount) {
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
    delete fullConfigJson[entryType];
    renderModelConfig();
    showToast(`已删除类型 ${entryType}`, 'success');
}

function showAddTypeModal() {
    const old = document.querySelector('.modal-overlay');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal" onclick="event.stopPropagation()">
            <h3>添加模型配置类型</h3>
            <div class="modal-field"><label>类型名称（顶层 section）</label><input id="modalTypeKey" placeholder="如 agents / categories / reviewers" /></div>
            <div class="modal-actions"><button class="btn btn-cancel" id="btnCancelAddType">取消</button><button class="btn btn-primary" id="btnConfirmAddType">➕ 添加类型</button></div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', () => overlay.remove());
    overlay.querySelector('#btnCancelAddType').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#btnConfirmAddType').addEventListener('click', async () => {
        const type = overlay.querySelector('#modalTypeKey').value.trim();
        if (!type) { showToast('类型名称不能为空', 'error'); return; }
        if (modelTypes.includes(type)) { showToast('类型已存在', 'error'); return; }
        const result = await api.AddModelType(type);
        if (!result.success) { showToast('添加类型失败: ' + (result.error || '未知错误'), 'error'); return; }
        modelTypes.push(type);
        fullConfigJson[type] = {};
        overlay.remove();
        renderModelConfig();
        showToast(`已添加类型 ${type}`, 'success');
    });
}

function showAddEntryModal(entryType) {
    const old = document.querySelector('.modal-overlay');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal" onclick="event.stopPropagation()">
            <h3>添加 ${modelTypeTitle(entryType).replace(/^[^\w\u4e00-\u9fa5]+\s*/, '')}</h3>
            <div class="modal-field"><label>Key（唯一标识）</label><input id="modalEntryKey" placeholder="如 my-agent" /></div>
            <div class="modal-field"><label>模型</label><select id="modalEntryModel" style="width:100%;padding:6px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text-primary)">${availableModels.map(m => `<option value="${m}">${m}</option>`).join('')}</select></div>
            <div class="modal-field"><label>描述（作为注释）</label><input id="modalEntryComment" placeholder="简要描述用途" /></div>
            <div class="modal-actions"><button class="btn btn-cancel" id="btnCancelAdd">取消</button><button class="btn btn-primary" id="btnConfirmAdd">💾 添加</button></div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', () => overlay.remove());
    overlay.querySelector('#btnCancelAdd').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#btnConfirmAdd').addEventListener('click', () => {
        const key = overlay.querySelector('#modalEntryKey').value.trim();
        const model = overlay.querySelector('#modalEntryModel').value;
        const comment = overlay.querySelector('#modalEntryComment').value.trim();
        if (!key) { showToast('Key 不能为空', 'error'); return; }
        if (modelEntries.find(e => e.type === entryType && e.key === key)) { showToast('当前类型下 Key 已存在', 'error'); return; }
        modelEntries.push({ id: modelEntryId(entryType, key), key, type: entryType, model: model || 'deepseek-v4-flash', comment });
        overlay.remove();
        renderModelConfig();
        updateSaveStatus();
        showToast(`已添加 ${key}（点击保存生效）`, 'info');
    });
}

function updateSaveStatus() {
    const changed = modelEntries.filter(e => {
        const orig = originalEntries.find(o => sameModelEntry(o, e));
        return !orig || orig.model !== e.model;
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
