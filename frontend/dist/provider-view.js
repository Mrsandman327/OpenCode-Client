// ============================================================
// OpenCode 管理中心 - 供应商配置视图
// ============================================================
let providerCache = [];

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
    list.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在加载供应商...</p></div>';
    try {
        const [providers, cfgPath] = await Promise.all([
            api.GetProviders(),
            api.GetProviderConfigPath(),
        ]);
        document.getElementById('providerConfigPath').textContent = cfgPath || '未知';
        renderProviders(providers || []);
    } catch (err) {
        list.innerHTML = `<div class="error"><p>⚠️ 加载失败</p><p class="error-detail">${escapeHtml(err.message||err)}</p></div>`;
    }
}

function emptyProvider() {
    return { key: '', name: '', baseURL: '', apiKey: '', npm: '@ai-sdk/openai-compatible', npmRaw: '@ai-sdk/openai-compatible', enabled: true, models: [], _new: true };
}

function renderProviders(providers) {
    const list = document.getElementById('providersList');
    const html = providers.map(p => providerCardHtml(p)).join('');
    list.innerHTML = html + `
        <div class="provider-card provider-card-add" id="btnAddCard" style="border:dashed 1px var(--border);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:24px;color:var(--text-muted)">
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
                    <input class="prov-edit-key" value="${escapeHtml(p.key)}" placeholder="key (如 deepseek)" style="width:140px;font-size:13px;font-weight:600" ${isNew?'':'readonly'} />
                    <input class="prov-edit-name" value="${escapeHtml(p.name||'')}" placeholder="名称" style="width:160px;font-size:12px" />
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
                    <div class="provider-models-title">📦 模型 <button class="btn btn-sm btn-add btn-add-model-card" data-key="${escapeHtml(p.key)}" style="font-size:10px;padding:2px 8px">+</button></div>
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
                    <input class="model-edit-id" placeholder="deepseek-v4-pro" style="font-size:12px;font-family:monospace;flex:1;width:50%" />
                    <span style="font-size:10px;color:var(--text-muted);width:45px;flex-shrink:0">名称</span>
                    <input class="model-edit-name" placeholder="DeepSeek-V4-Pro" style="font-size:12px;flex:1;width:50%" />
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
