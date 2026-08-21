// ============================================================
// OpenCode 管理中心 - 供应商配置视图
// ============================================================
// 说明：ES Modules 化改造。core 层依赖静态导入；filebrowser 依赖
// 暂以 typeof 守卫调用，待 filebrowser 改造完成后改为静态 import。
import { api } from '../core/apicall.js';
import { escapeHtml, showToast } from '../core/utils.js';
import { openFileBrowserModal } from '../filebrowser/browser.js';

export let providerCache = [];

export function getProviderConfigDir(cfgPath) {
    var fullPath = String(cfgPath || '').trim();
    if (!fullPath) return '';
    return fullPath.replace(/[\\/][^\\/]+$/, '');
}

export async function openProviderConfigDirInBrowser() {
    var pathEl = document.getElementById('providerConfigPath');
    var cfgPath = pathEl ? String(pathEl.textContent || '').trim() : '';
    var dir = getProviderConfigDir(cfgPath);
    if (!dir || dir === '未知' || dir === '加载中...') {
        showToast('配置文件目录不可用', 'error');
        return;
    }
    try {
        openFileBrowserModal(dir);
    } catch (err) {
        showToast('打开目录失败: ' + (err.message || err), 'error');
    }
}

export const PROVIDER_NPM_OPTIONS = [
    { label: 'OpenAI Responses', value: '@ai-sdk/openai' },
    { label: 'OpenAI Compatible', value: '@ai-sdk/openai-compatible' },
    { label: 'Anthropic', value: '@ai-sdk/anthropic' },
    { label: 'Amazon Bedrock', value: '@ai-sdk/amazon-bedrock' },
    { label: 'Google (Gemini)', value: '@ai-sdk/google' },
];

export const PROVIDER_NPM_UNMATCHED = '__unmatched__';

// 模态能力选项
export const MODALITY_INPUT  = ['text', 'image', 'pdf', 'audio', 'video'];
export const MODALITY_OUTPUT = ['text', 'image', 'audio', 'video'];

// 渲染模型能力芯片（按 modalities 回填勾选状态）
function modelAbilitiesHtml(modalities) {
    const input  = modalities?.input  || [];
    const output = modalities?.output || [];
    const boxes = (list, cls, selected) => list.map(m =>
        `<label class="mod-chip"><input type="checkbox" class="${cls}" value="${m}" ${selected.includes(m) ? 'checked' : ''}><span class="mod-chip-text">${m}</span></label>`
    ).join('');
    return `<div class="model-abilities">
        <div class="mod-row"><span class="mod-label">输入</span><div class="mod-chip-list">${boxes(MODALITY_INPUT, 'mod-input', input)}</div></div>
        <div class="mod-row"><span class="mod-label">输出</span><div class="mod-chip-list">${boxes(MODALITY_OUTPUT, 'mod-output', output)}</div></div>
    </div>`;
}

// 计算能力摘要：取输入/输出中非 text 的能力，去重，最多显示 2 个 + 超出计数
function abilitiesSummary(modalities) {
    const set = new Set([
        ...(modalities?.input || []),
        ...(modalities?.output || []),
    ].filter(m => m && m !== 'text'));
    const list = [...set];
    if (!list.length) return '';
    const shown = list.slice(0, 2).join('+');
    return list.length > 2 ? `${shown}+${list.length - 2}` : shown;
}

// 渲染单个模型子卡片（三处复用）：
// providerCardHtml 静态渲染、「手动添加」动态新增行、「获取模型列表」弹窗新增行，
// 统一走此函数，保证结构与行为一致（能力区默认折叠，由 CSS 控制显隐）。
// 注意：
// 1. .btn-del-model 必须保持为 .model-subcard 的直接子元素——
//    bindProviderEvents 里通过 btn.parentElement.remove() 删除整行；
// 2. 能力区隐藏采用 display:none（CSS 折叠），不影响 saveProviderFromDom
//    用 .mod-input:checked / .mod-output:checked 收集勾选值。
function modelSubcardHtml(model, modalities) {
    const m = model || {};
    const readonlyAttr = m.readonlyId ? 'readonly' : '';
    const summary = abilitiesSummary(modalities);
    return `
        <div class="model-subcard">
            <div class="model-subcard-fields">
                <div style="display:flex;align-items:center;gap:8px">
                    <span style="font-size:11px;font-weight:600;color:var(--text-muted);width:45px;flex-shrink:0;">模型ID</span>
                    <input class="model-edit-id" value="${escapeHtml(m.id || '')}" placeholder="deepseek-v4-pro" ${readonlyAttr} style="font-size:12px;flex:1;width:50%" />
                    <span style="font-size:11px;font-weight:600;color:var(--text-muted);width:45px;flex-shrink:0;padding-left:20px;">名称</span>
                    <input class="model-edit-name" value="${escapeHtml(m.name || '')}" placeholder="DeepSeek-V4-Pro" style="font-size:12px;flex:1;width:50%" />
                </div>
                ${modelAbilitiesHtml(modalities)}
            </div>
            <button class="btn-toggle-abilities" type="button" aria-expanded="false" title="展开/收起模型模态设置">
                <span class="btn-toggle-abilities-text">多模态</span>
                ${summary ? `<span class="abilities-summary">${escapeHtml(summary)}</span>` : ''}
                <span class="toggle-arrow">▾</span>
            </button>
            <button class="btn btn-del btn-del-model" title="删除">✕</button>
        </div>`;
}

export async function loadProviders() {
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

export function emptyProvider() {
    return { key: '', name: '', baseURL: '', apiKey: '', npm: '@ai-sdk/openai-compatible', npmRaw: '@ai-sdk/openai-compatible', enabled: true, models: [], _new: true };
}

export function renderProviders(providers) {
    const list = document.getElementById('providersList');
    const empty = (!providers || !providers.length)
        ? '<div class="prov-empty">暂无供应商，点击下方「➕ 添加供应商」</div>'
        : '';
    const html = (providers || []).map(p => providerCardHtml(p)).join('');
    list.innerHTML = empty + html + `
        <div class="provider-card provider-card-add" id="btnAddCard">
            <span>➕ 添加供应商</span>
        </div>`;
    bindProviderEvents(providers);
    document.getElementById('btnAddCard').addEventListener('click', () => addNewCard());
}

export function providerCardHtml(p) {
    const isNew = p._new;
    const npmValue = p.npm || p.npmRaw || '@ai-sdk/openai-compatible';
    const matchedOption = PROVIDER_NPM_OPTIONS.find(item => item.value === (p.npm || ''));
    const selectedNpmValue = matchedOption ? matchedOption.value : PROVIDER_NPM_UNMATCHED;
    const npmOptionsHtml = [
        ...PROVIDER_NPM_OPTIONS.map(item => `<option value="${escapeHtml(item.value)}" ${selectedNpmValue === item.value ? 'selected' : ''}>${escapeHtml(item.label)}</option>`),
        !matchedOption && npmValue ? `<option value="${PROVIDER_NPM_UNMATCHED}" selected>未匹配保留</option>` : ''
    ].join('');
    const modelsHtml = (p.models || []).length
        ? (p.models || []).map(m => modelSubcardHtml({ id: m.id, name: m.name || '' }, m.modalities)).join('')
        : '<div class="prov-empty">暂无模型，点击「手动添加」或「 获取模型列表」</div>';
    return `
        <div class="provider-card" data-key="${escapeHtml(p.key)}">
            <div class="provider-card-header">
                <div class="provider-identity">
                    <span class="prov-inline-label">供应商标识</span><input class="prov-edit-key" value="${escapeHtml(p.key)}" placeholder="key (如 deepseek)" ${isNew?'':'readonly'} />
                    <span class="prov-inline-label">供应商名称</span><input class="prov-edit-name" value="${escapeHtml(p.name||'')}" placeholder="名称"/>
                </div>
                <div class="provider-card-actions">
                    <label class="prov-toggle" title="启用该供应商">
                        <input type="checkbox" class="prov-edit-enabled" ${p.enabled!==false?'checked':''} />
                        <span class="prov-toggle-track"><span class="prov-toggle-thumb"></span></span>
                        <span class="prov-toggle-label">启用</span>
                    </label>
                    <button class="btn btn-sm btn-save-card" data-key="${escapeHtml(p.key)}">保存</button>
                    <button class="btn btn-del btn-del-card" data-key="${escapeHtml(p.key)}" title="删除">✕</button>
                </div>
            </div>
            <div class="provider-card-body">
                <div class="provider-conn-row">
                    <label class="provider-conn-col">
                        <span class="prov-field-label">请求地址 (baseURL)</span>
                        <input class="prov-edit-url" value="${escapeHtml(p.baseURL||'')}" placeholder="https://api.xxx.com/v1" />
                    </label>
                    <label class="provider-conn-col">
                        <span class="prov-field-label">API Key</span>
                        <div class="prov-apikey-row">
                            <input class="prov-edit-apikey" value="${escapeHtml(p.apiKey||'')}" type="password" placeholder="sk-..." />
                            <button class="btn-eye" type="button" title="切换明文">👁</button>
                        </div>
                    </label>
                    <label class="provider-conn-col">
                        <span class="prov-field-label">接口格式</span>
                        <select class="prov-edit-npm" data-raw-npm="${escapeHtml(p.npm || '')}" aria-label="interface format">
                            ${npmOptionsHtml}
                        </select>
                    </label>
                </div>
                <div class="provider-models">
                    <div class="provider-models-title">模型 <button class="btn btn-sm btn-add btn-add-model-card" data-key="${escapeHtml(p.key)}">手动添加</button><button class="btn btn-sm btn-add btn-fetch-models" data-key="${escapeHtml(p.key)}" style="margin-left:4px">📡 获取模型列表</button></div>
                    <div class="card-models-list" data-key="${escapeHtml(p.key)}">
                        ${modelsHtml}
                    </div>
                </div>
            </div>
        </div>`;
}

export function bindProviderEvents(providers) {
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
            // 移除空态占位（若有）
            const emptyEl = list.querySelector('.prov-empty');
            if (emptyEl) emptyEl.remove();
            // 用共享的 modelSubcardHtml 生成子卡片（结构/折叠行为与静态渲染一致），
            // 默认勾选 text 输入/输出能力
            const temp = document.createElement('div');
            temp.innerHTML = modelSubcardHtml(
                { id: '', name: '' },
                { input: ['text'], output: ['text'] }
            ).trim();
            const row = temp.firstElementChild;
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

    // 「能力」展开/折叠按钮：事件委托挂在每个 .card-models-list 容器上，
    // 静态渲染、手动新增行、弹窗新增行的子卡片点击都会冒泡到这里，无需逐行绑定。
    // dataset.abilitiesBound 防止 renderProviders 重渲染时对同一容器重复绑定。
    // 折叠仅切换 .abilities-open（CSS 用 display:none 显隐能力区），
    // checkbox 仍在 DOM 中，:checked 收集不受影响。
    document.querySelectorAll('.card-models-list').forEach(list => {
        if (list.dataset.abilitiesBound) return;
        list.dataset.abilitiesBound = 'true';
        list.addEventListener('click', e => {
            const toggle = e.target.closest('.btn-toggle-abilities');
            if (!toggle) return;
            const subcard = toggle.closest('.model-subcard');
            if (!subcard) return;
            const open = subcard.classList.toggle('abilities-open');
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
    });
}

export function addNewCard() {
    const isNew = providerCache.some(p => p._new);
    if (isNew) { showToast('请先保存当前新增的供应商', 'info'); return; }
    providerCache.push(emptyProvider());
    renderProviders(providerCache);
}

export function saveProviderFromDom(key) {
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
        if (!id) return;
        const input  = [...row.querySelectorAll('.mod-input:checked')].map(c => c.value);
        const output = [...row.querySelectorAll('.mod-output:checked')].map(c => c.value);
        const model = { id, name: name || id };
        // 仅当设置了任意能力时才写 modalities；全空则省略字段，交给 OpenCode 走 models.dev 兜底
        if (input.length || output.length) {
            model.modalities = { input, output };
        }
        data.models.push(model);
    });

    const btn = card.querySelector('.btn-save-card');
    btn.disabled = true; btn.textContent = '...';

    api.SaveProvider(data).then(r => {
        if (r.success) {
            showToast(`供应商 ${data.key} 已保存`, 'success');
            // 保存成功不重新加载列表，保持当前界面状态
            btn.disabled = false; btn.textContent = '💾 保存';
            if (key !== data.key) {
                // 新增供应商：key 已变更，同步卡片及内部按钮的 data-key，并清除新增标记
                card.dataset.key = data.key;
                card.querySelectorAll('[data-key]').forEach(el => {
                    if (el.dataset.key === key) el.dataset.key = data.key;
                });
                const idx = providerCache.findIndex(p => p._new);
                if (idx >= 0) {
                    providerCache[idx].key = data.key;
                    providerCache[idx].name = data.name;
                    providerCache[idx]._new = false;
                }
            }
        } else {
            showToast('保存失败: ' + r.error, 'error');
            btn.disabled = false; btn.textContent = '💾 保存';
        }
    });
}

// ========== 获取模型列表弹窗 ==========

export async function showModelListModal(key, name, baseURL, apiKey) {
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
    overlay.innerHTML = '<div class="modal proxy-modal" style="max-width:420px">' +
        '<h3>' + escapeHtml(name) + '-模型</h3>' +
        html +
        '<div class="modal-actions"><button class="btn btn-sm" id="btnCloseModelList">关闭</button></div>' +
    '</div>';
    document.body.appendChild(overlay);
    overlay.style.display = 'flex';
    overlay.querySelector('.modal').addEventListener('click', function(e) { e.stopPropagation(); });

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
                // 移除空态占位（若有）
                var emptyEl = list.querySelector('.prov-empty');
                if (emptyEl) emptyEl.remove();
                // 与「手动添加」走同一套 modelSubcardHtml 结构（能力区默认折叠）；
                // 弹窗拉取的模型 ID 固定 readonly，默认勾选 text 输入/输出能力
                var temp = document.createElement('div');
                temp.innerHTML = modelSubcardHtml(
                    { id: modelId, name: modelId, readonlyId: true },
                    { input: ['text'], output: ['text'] }
                ).trim();
                var row = temp.firstElementChild;
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

export function closeModelListModal() {
    var m = document.getElementById('modelListModal');
    if (m) m.remove();
}
