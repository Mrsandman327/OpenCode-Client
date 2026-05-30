// ============================================================
// OpenCode 管理中心 - 供应商配置视图
// ============================================================
let providerCache = [];

function getProviderConfigDir(cfgPath) {
    var fullPath = String(cfgPath || '').trim();
    if (!fullPath) return '';
    return fullPath.replace(/[\\/][^\\/]+$/, '');
}

async function openProviderConfigDirInBrowser() {
    var pathEl = document.getElementById('providerConfigPath');
    var cfgPath = pathEl ? String(pathEl.textContent || '').trim() : '';
    var dir = getProviderConfigDir(cfgPath);
    if (!dir || dir === '未知' || dir === '加载中...') {
        showToast('配置文件目录不可用', 'error');
        return;
    }
    try {
        if (typeof openFileBrowserModal === 'function') {
            openFileBrowserModal(dir);
        } else {
            showToast('文件浏览器模块未加载', 'error');
        }
    } catch (err) {
        showToast('打开目录失败: ' + (err.message || err), 'error');
    }
}

const PROVIDER_NPM_OPTIONS = [
    { label: 'OpenAI Responses', value: '@ai-sdk/openai' },
    { label: 'OpenAI Compatible', value: '@ai-sdk/openai-compatible' },
    { label: 'Anthropic', value: '@ai-sdk/anthropic' },
    { label: 'Amazon Bedrock', value: '@ai-sdk/amazon-bedrock' },
    { label: 'Google (Gemini)', value: '@ai-sdk/google' },
];

const PROVIDER_NPM_UNMATCHED = '__unmatched__';

async function loadProviders() {
    const list = document.getElementById('providersList');
    const openBtn = document.getElementById('btnOpenProviderConfigDir');
    list.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在加载供应商...</p></div>';
    if (openBtn) openBtn.disabled = true;
    try {
        const [providers, cfgPath] = await Promise.all([
            api.GetProviders(),
            api.GetProviderConfigPath(),
        ]);
        document.getElementById('providerConfigPath').textContent = cfgPath || '未知';
        if (openBtn) openBtn.disabled = !getProviderConfigDir(cfgPath);
        renderProviders(providers || []);
    } catch (err) {
        list.innerHTML = `<div class="error"><p>⚠️ 加载失败</p><p class="error-detail">${escapeHtml(err.message||err)}</p></div>`;
        if (openBtn) openBtn.disabled = true;
    }
}

(function bindProviderConfigActions() {
    var openBtn = document.getElementById('btnOpenProviderConfigDir');
    if (!openBtn || openBtn.dataset.bound) return;
    openBtn.dataset.bound = 'true';
    openBtn.addEventListener('click', function() {
        openProviderConfigDirInBrowser();
    });
})();

function emptyProvider() {
    return { key: '', name: '', baseURL: '', apiKey: '', npm: '@ai-sdk/openai-compatible', npmRaw: '@ai-sdk/openai-compatible', enabled: true, models: [], _new: true };
}

function renderProviders(providers) {
    const list = document.getElementById('providersList');
    const html = providers.map(p => providerCardHtml(p)).join('');
    list.innerHTML = html + `
        <div class="provider-card provider-card-add" id="btnAddCard">
            <span>➕ 添加供应商</span>
        </div>`;
    bindProviderEvents(providers);
    document.getElementById('btnAddCard').addEventListener('click', () => addNewCard());
}

function providerCardHtml(p) {
    const isNew = p._new;
    const npmValue = p.npm || p.npmRaw || '@ai-sdk/openai-compatible';
    const matchedOption = PROVIDER_NPM_OPTIONS.find(item => item.value === (p.npm || ''));
    const selectedNpmValue = matchedOption ? matchedOption.value : PROVIDER_NPM_UNMATCHED;
    const npmOptionsHtml = [
        ...PROVIDER_NPM_OPTIONS.map(item => `<option value="${escapeHtml(item.value)}" ${selectedNpmValue === item.value ? 'selected' : ''}>${escapeHtml(item.label)}</option>`),
        !matchedOption && npmValue ? `<option value="${PROVIDER_NPM_UNMATCHED}" selected>未匹配保留</option>` : ''
    ].join('');
    return `
        <div class="provider-card" data-key="${escapeHtml(p.key)}">
            <div class="provider-card-header">
                <div style="flex:1;display:flex;gap:8px;align-items:center">
                    <sapn style="font-size:12px;">供应商标识&nbsp;&nbsp;</span><input class="prov-edit-key" value="${escapeHtml(p.key)}" placeholder="key (如 deepseek)" ${isNew?'':'readonly'} />
                    <sapn style="font-size:12px;">供应商名称&nbsp;&nbsp;</span><input class="prov-edit-name" value="${escapeHtml(p.name||'')}" placeholder="名称"/>
                </div>
                <div class="provider-card-actions" style="display:flex;gap:6px;align-items:center">
                    <label style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:4px;cursor:pointer">
                        <input type="checkbox" class="prov-edit-enabled" ${p.enabled!==false?'checked':''} /> 启用
                    </label>
                    <button class="btn btn-sm btn-save-card" data-key="${escapeHtml(p.key)}">💾 保存</button>
                    <button class="btn btn-del btn-del-card" data-key="${escapeHtml(p.key)}" title="删除">✕</button>
                </div>
            </div>
            <div class="provider-card-body">
                <div style="display:flex;gap:10px">
                    <label style="flex:2">
                        <span style="font-size:11px;font-weight:600;color:var(--text-muted)">请求地址 (baseURL)</span>
                        <input class="prov-edit-url" value="${escapeHtml(p.baseURL||'')}" placeholder="https://api.xxx.com/v1" style="width:100%;margin-top:2px" />
                    </label>
                    <label style="flex:2">
                        <span style="font-size:10px;font-weight:600;color:var(--text-muted)">API Key</span>
                        <div style="display:flex;gap:0;margin-top:2px">
                            <input class="prov-edit-apikey" value="${escapeHtml(p.apiKey||'')}" type="password" placeholder="sk-..." style="width:100%;border-right:none;border-radius:4px 0 0 4px" />
                            <button class="btn-eye" type="button" title="切换明文">👁</button>
                        </div>
                    </label>
                    <label style="flex:1">
                        <span style="font-size:11px;font-weight:600;color:var(--text-muted)">接口格式</span>
                        <select class="prov-edit-npm" data-raw-npm="${escapeHtml(p.npm || '')}" aria-label="interface format" style="width:100%;margin-top:2px">
                            ${npmOptionsHtml}
                        </select>
                    </label>
                </div>
                <div class="provider-models">
                    <div class="provider-models-title">📦 模型 <button class="btn btn-sm btn-add btn-add-model-card" data-key="${escapeHtml(p.key)}">手动添加</button><button class="btn btn-sm btn-add btn-fetch-models" data-key="${escapeHtml(p.key)}" style="margin-left:4px">📡 获取模型列表</button></div>
                    <div class="card-models-list" data-key="${escapeHtml(p.key)}">
                        ${(p.models||[]).map((m,i) => `
                            <div class="model-subcard">
                                <div style="display:flex;align-items:center;gap:8px;flex:1">
                                    <span style="font-size:11px;font-weight:600;color:var(--text-muted);width:45px;flex-shrink:0">模型ID</span>
                                    <input class="model-edit-id" value="${escapeHtml(m.id)}" placeholder="deepseek-v4-pro" style="font-size:12px;flex:1;width:50%" />
                                    <span style="font-size:11px;font-weight:600;color:var(--text-muted);width:45px;flex-shrink:0">名称</span>
                                    <input class="model-edit-name" value="${escapeHtml(m.name||'')}" placeholder="DeepSeek-V4-Pro" style="font-size:12px;flex:1;width:50%" />
                                </div>
                                <button class="btn btn-del btn-del-model" title="删除">✕</button>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        </div>`;
}

function bindProviderEvents(providers) {
    providerCache = providers;

    document.querySelectorAll('.btn-save-card').forEach(btn => {
        btn.addEventListener('click', () => saveProviderFromDom(btn.dataset.key));
    });

    document.querySelectorAll('.btn-del-card').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.key;
            if (!confirm(`确定删除供应商 "${key}" 吗？`)) return;
            api.DeleteProvider(key).then(r => {
                if (r.success) { showToast(`已删除 ${key}`, 'success'); loadProviders(); }
                else showToast('删除失败: '+r.error, 'error');
            });
        });
    });

    document.querySelectorAll('.btn-add-model-card').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.key;
            const list = document.querySelector(`.card-models-list[data-key="${CSS.escape(key)}"]`);
            const row = document.createElement('div');
            row.className = 'model-subcard';
            row.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;flex:1">
                    <span style="font-size:10px;color:var(--text-muted);width:45px;flex-shrink:0">模型ID</span>
                    <input class="model-edit-id" placeholder="deepseek-v4-pro" style="flex:1;width:50%" />
                    <span style="font-size:10px;color:var(--text-muted);width:45px;flex-shrink:0">名称</span>
                    <input class="model-edit-name" placeholder="DeepSeek-V4-Pro" style="flex:1;width:50%" />
                </div>
                <button class="btn btn-del btn-del-model" title="删除">✕</button>
            `;
            row.querySelector('.btn-del-model').addEventListener('click', () => row.remove());
            list.appendChild(row);
        });
    });

    document.querySelectorAll('.btn-del-model').forEach(btn => {
        btn.addEventListener('click', () => btn.parentElement.remove());
    });

    // 获取模型列表按钮
    document.querySelectorAll('.btn-fetch-models').forEach(btn => {
        btn.addEventListener('click', () => {
            var key = btn.dataset.key;
            var card = document.querySelector('.provider-card[data-key="' + CSS.escape(key) + '"]');
            if (!card) return;
            var name = card.querySelector('.prov-edit-name')?.value?.trim() || key;
            var baseURL = card.querySelector('.prov-edit-url')?.value?.trim() || '';
            var apiKey = card.querySelector('.prov-edit-apikey')?.value?.trim() || '';
            if (!baseURL) { showToast('请先填写请求地址', 'error'); return; }
            if (!apiKey) { showToast('请先填写 API Key', 'error'); return; }
            showModelListModal(key, name, baseURL, apiKey);
        });
    });

    document.querySelectorAll('.btn-eye').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = btn.parentElement.querySelector('.prov-edit-apikey');
            if (input.type === 'password') {
                input.type = 'text';
                btn.textContent = '🙈';
            } else {
                input.type = 'password';
                btn.textContent = '👁';
            }
        });
    });
}

function addNewCard() {
    const isNew = providerCache.some(p => p._new);
    if (isNew) { showToast('请先保存当前新增的供应商', 'info'); return; }
    providerCache.push(emptyProvider());
    renderProviders(providerCache);
}

function saveProviderFromDom(key) {
    const card = document.querySelector(`.provider-card[data-key="${CSS.escape(key)}"]`);
    if (!card) return;

    const npmSelect = card.querySelector('.prov-edit-npm');
    const selectedNpm = npmSelect?.value || '';
    const rawNpm = npmSelect?.dataset.rawNpm || '';

    const data = {
        key: card.querySelector('.prov-edit-key').value.trim(),
        name: card.querySelector('.prov-edit-name').value.trim(),
        baseURL: card.querySelector('.prov-edit-url').value.trim(),
        apiKey: card.querySelector('.prov-edit-apikey').value.trim(),
        npm: selectedNpm === PROVIDER_NPM_UNMATCHED ? rawNpm : selectedNpm,
        enabled: card.querySelector('.prov-edit-enabled').checked,
        models: []
    };

    if (!data.key) { showToast('Key 不能为空', 'error'); return; }

    card.querySelectorAll('.model-subcard').forEach(row => {
        const id = row.querySelector('.model-edit-id')?.value?.trim();
        const name = row.querySelector('.model-edit-name')?.value?.trim();
        if (id) data.models.push({ id, name: name || id });
    });

    const btn = card.querySelector('.btn-save-card');
    btn.disabled = true; btn.textContent = '...';

    api.SaveProvider(data).then(r => {
        if (r.success) {
            showToast(`供应商 ${data.key} 已保存`, 'success');
            loadProviders();
        } else {
            showToast('保存失败: ' + r.error, 'error');
            btn.disabled = false; btn.textContent = '💾 保存';
        }
    });
}

// ========== 获取模型列表弹窗 ==========

async function showModelListModal(key, name, baseURL, apiKey) {
    var btn = document.querySelector('.btn-fetch-models[data-key="' + CSS.escape(key) + '"]');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 获取中...'; }

    var models = [];
    try {
        models = await api.GetModelList(baseURL, apiKey) || [];
    } catch (e) {
        showToast('获取模型列表失败: ' + (e.message || e), 'error');
        if (btn) { btn.disabled = false; btn.textContent = '📡 获取模型列表'; }
        return;
    }
    if (btn) { btn.disabled = false; btn.textContent = '📡 获取模型列表'; }

    if (!models.length) { showToast('未获取到模型列表', 'info'); return; }

    // 获取当前卡片中已有模型 ID
    var card = document.querySelector('.provider-card[data-key="' + CSS.escape(key) + '"]');
    var existingIds = [];
    if (card) {
        card.querySelectorAll('.model-edit-id').forEach(function(input) {
            var v = input.value.trim();
            if (v) existingIds.push(v);
        });
    }
    var existingSet = {};
    existingIds.forEach(function(id) { existingSet[id] = true; });

    // 渲染弹窗
    var html = '<div class="model-list-body">';
    models.forEach(function(m) {
        var escaped = escapeHtml(m);
        html += '<div class="model-list-row">' +
            '<span class="model-list-name">' + escaped + '</span>';
        if (existingSet[m]) {
            html += '<button class="btn btn-sm btn-del" data-action="del" data-model="' + escaped + '">删除</button>';
        } else {
            html += '<button class="btn btn-sm btn-add" data-action="add" data-model="' + escaped + '">增加</button>';
        }
        html += '</div>';
    });
    html += '</div>';

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'modelListModal';
    overlay.innerHTML = '<div class="modal proxy-modal" onclick="event.stopPropagation()" style="max-width:420px">' +
        '<h3>' + escapeHtml(name) + '-模型</h3>' +
        html +
        '<div class="modal-actions"><button class="btn btn-sm" id="btnCloseModelList">关闭</button></div>' +
    '</div>';
    document.body.appendChild(overlay);
    overlay.style.display = 'flex';

    // 事件绑定
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) closeModelListModal();
    });
    overlay.querySelector('#btnCloseModelList').addEventListener('click', closeModelListModal);

    overlay.querySelectorAll('[data-action]').forEach(function(actBtn) {
        actBtn.addEventListener('click', function() {
            var action = this.dataset.action;
            var modelId = this.dataset.model;
            var list = document.querySelector('.card-models-list[data-key="' + CSS.escape(key) + '"]');
            if (!list) return;

            if (action === 'add') {
                var row = document.createElement('div');
                row.className = 'model-subcard';
                row.innerHTML = '<div style="display:flex;align-items:center;gap:8px;flex:1">' +
                    '<span style="font-size:10px;color:var(--text-muted);width:45px;flex-shrink:0">模型ID</span>' +
                    '<input class="model-edit-id" value="' + escapeHtml(modelId) + '" style="font-size:12px;font-family:monospace;flex:1;width:50%" readonly />' +
                    '<span style="font-size:10px;color:var(--text-muted);width:45px;flex-shrink:0">名称</span>' +
                    '<input class="model-edit-name" value="' + escapeHtml(modelId) + '" style="font-size:12px;flex:1;width:50%" />' +
                '</div>' +
                '<button class="btn btn-del btn-del-model" title="删除">✕</button>';
                row.querySelector('.btn-del-model').addEventListener('click', function() { row.remove(); });
                list.appendChild(row);
                this.textContent = '删除';
                this.className = 'btn btn-sm btn-del';
                this.dataset.action = 'del';
            } else if (action === 'del') {
                list.querySelectorAll('.model-edit-id').forEach(function(input) {
                    if (input.value.trim() === modelId) {
                        input.closest('.model-subcard').remove();
                    }
                });
                this.textContent = '增加';
                this.className = 'btn btn-sm btn-add';
                this.dataset.action = 'add';
            }
        });
    });
}

function closeModelListModal() {
    var m = document.getElementById('modelListModal');
    if (m) m.remove();
}
