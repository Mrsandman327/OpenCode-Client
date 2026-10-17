// ============================================================
// OpenCode 管理中心 - 供应商配置视图
// ============================================================
// 说明：ES Modules 化改造。core 层依赖静态导入；filebrowser 依赖
// 暂以 typeof 守卫调用，待 filebrowser 改造完成后改为静态 import。
import { api } from '../core/apicall.js';
import { escapeHtml, showToast, showApiError, bindOverlayClose } from '../core/utils.js';
import { openFileBrowserModal } from '../filebrowser/browser.js';

export let providerCache = [];

// 当前配置文件完整路径（原 path-bar 已移除：改为内存保存，供「打开配置文件」定位所在目录）
var providerConfigPath = '';

export function getProviderConfigDir(cfgPath) {
    var fullPath = String(cfgPath || '').trim();
    if (!fullPath) return '';
    return fullPath.replace(/[\\/][^\\/]+$/, '');
}

export async function openProviderConfigDirInBrowser() {
    var dir = getProviderConfigDir(providerConfigPath);
    if (!dir || dir === '未知' || dir === '加载中...') {
        showToast('配置文件目录不可用', 'error');
        return;
    }
    try {
        openFileBrowserModal(dir);
    } catch (err) {
        showApiError('打开目录失败: ', err);
    }
}

// v2 供应商「接口格式」选项（对应 opencode v2 的 package 字段）：
// 值统一为 "aisdk:" 前缀 + AI SDK 包名；v1 的无前缀 @ai-sdk/* 写法已废弃。
// 常量名保留 NPM 字样以免波及外部引用；但对外读写/提交的字段名一律为 package。
export const PROVIDER_NPM_OPTIONS = [
    { label: 'OpenAI Responses', value: 'aisdk:@ai-sdk/openai' },
    { label: 'OpenAI Compatible', value: 'aisdk:@ai-sdk/openai-compatible' },
    { label: 'Anthropic', value: 'aisdk:@ai-sdk/anthropic' },
    { label: 'Amazon Bedrock', value: 'aisdk:@ai-sdk/amazon-bedrock' },
    { label: 'Google (Gemini)', value: 'aisdk:@ai-sdk/google' },
];

// 未匹配保留的哨兵值：后端返回的 package 不在上方列表时，
// 下拉展示「未匹配保留」并维持原样提交（原值挂在 select 的 data-raw-npm 上）
export const PROVIDER_NPM_UNMATCHED = '__unmatched__';

// 能力（capabilities）芯片选项：
// input / output 沿用原模态列表；tools（工具调用）为单个布尔勾选框，不在此列表中
export const MODALITY_INPUT  = ['text', 'image', 'pdf', 'audio', 'video'];
export const MODALITY_OUTPUT = ['text', 'image', 'audio', 'video'];

// 渲染模型能力芯片（按 capabilities 回填勾选状态）
// capabilities 形如 { tools?: boolean, input?: string[], output?: string[] }
function modelAbilitiesHtml(capabilities) {
    const caps   = capabilities || {};
    const input  = caps.input  || [];
    const output = caps.output || [];
    const boxes = (list, cls, selected) => list.map(m =>
        `<label class="mod-chip"><input type="checkbox" class="${cls}" value="${m}" ${selected.includes(m) ? 'checked' : ''}><span class="mod-chip-text">${m}</span></label>`
    ).join('');
    // 工具调用（v2 capabilities.tools）：单个布尔勾选框，可选项，默认不勾选；
    // .mod-tools 类名与输入/输出区隔开，便于 saveProviderFromDom 单独收集勾选态
    const toolsChecked = caps.tools === true ? 'checked' : '';
    return `<div class="model-abilities">
        <div class="mod-row"><span class="mod-label">输入</span><div class="mod-chip-list">${boxes(MODALITY_INPUT, 'mod-input', input)}</div></div>
        <div class="mod-row"><span class="mod-label">输出</span><div class="mod-chip-list">${boxes(MODALITY_OUTPUT, 'mod-output', output)}</div></div>
        <div class="mod-row"><span class="mod-label">工具</span><div class="mod-chip-list"><label class="mod-chip"><input type="checkbox" class="mod-tools" ${toolsChecked}><span class="mod-chip-text">工具调用</span></label></div></div>
    </div>`;
}

// 计算能力摘要：取输入/输出中非 text 的能力，去重，最多显示 2 个 + 超出计数
// （tools 是布尔开关，不参与摘要，保持与迁移前摘要行为一致）
function abilitiesSummary(capabilities) {
    const caps = capabilities || {};
    const set = new Set([
        ...(caps.input || []),
        ...(caps.output || []),
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
//    用 .mod-input:checked / .mod-output:checked / .mod-tools:checked 收集勾选值。
function modelSubcardHtml(model, capabilities) {
    const m = model || {};
    const readonlyAttr = m.readonlyId ? 'readonly' : '';
    const summary = abilitiesSummary(capabilities);
    return `
        <div class="model-subcard">
            <div class="model-subcard-fields">
                <div style="display:flex;align-items:center;gap:8px">
                    <span style="font-size:11px;font-weight:600;color:var(--text-muted);width:45px;flex-shrink:0;">模型ID</span>
                    <input class="model-edit-id" value="${escapeHtml(m.id || '')}" placeholder="deepseek-v4-pro" ${readonlyAttr} style="flex:1;width:50%" />
                    <span style="font-size:11px;font-weight:600;color:var(--text-muted);width:45px;flex-shrink:0;padding-left:20px;">名称</span>
                    <input class="model-edit-name" value="${escapeHtml(m.name || '')}" placeholder="DeepSeek-V4-Pro" style="flex:1;width:50%" />
                </div>
                ${modelAbilitiesHtml(capabilities)}
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
        providerConfigPath = cfgPath || '';
        if (openBtn) openBtn.disabled = !getProviderConfigDir(providerConfigPath);
        renderProviders(providers || []);
    } catch (err) {
        list.innerHTML = `<div class="error"><p>⚠️ 加载失败</p><p class="error-detail">${escapeHtml(err.message||err)}</p></div>`;
        if (openBtn) openBtn.disabled = true;
    }
}

(function bindProviderConfigActions() {
    var openBtn = document.getElementById('btnOpenProviderConfigDir');
    if (openBtn && !openBtn.dataset.bound) {
        openBtn.dataset.bound = 'true';
        openBtn.addEventListener('click', function() {
            openProviderConfigDirInBrowser();
        });
    }
    // 工具栏：添加供应商
    var addBtn = document.getElementById('btnAddProvider');
    if (addBtn && !addBtn.dataset.bound) {
        addBtn.dataset.bound = 'true';
        addBtn.addEventListener('click', function() { addNewCard(); });
    }
    // 工具栏：搜索过滤
    var searchEl = document.getElementById('providerSearch');
    if (searchEl && !searchEl.dataset.bound) {
        searchEl.dataset.bound = 'true';
        searchEl.addEventListener('input', function() {
            providerSearchQuery = searchEl.value;
            applyProviderFilter();
        });
    }
    // 工具栏：展开 / 折叠全部
    var expandBtn = document.getElementById('btnExpandAllProviders');
    if (expandBtn && !expandBtn.dataset.bound) {
        expandBtn.dataset.bound = 'true';
        expandBtn.addEventListener('click', function() {
            var list = document.getElementById('providersList');
            if (!list) return;
            var cards = list.querySelectorAll('.provider-card');
            var anyCollapsed = Array.prototype.some.call(cards, function(c) {
                return !c.classList.contains('expanded');
            });
            Array.prototype.forEach.call(cards, function(c) {
                c.classList.toggle('expanded', anyCollapsed);
            });
        });
    }
    // 工具栏：列表（单列）/ 卡片（多列）切换
    var seg = document.getElementById('providerViewSeg');
    if (seg && !seg.dataset.bound) {
        seg.dataset.bound = 'true';
        seg.addEventListener('click', function(e) {
            var btn = e.target.closest('.pv-seg-btn');
            if (!btn) return;
            providerViewMode = btn.dataset.view === 'list' ? 'list' : 'card';
            try { localStorage.setItem(PROVIDER_VIEW_KEY, providerViewMode); } catch (_) {}
            applyProviderFilter();
        });
    }
})();

export function emptyProvider() {
    // v2 字段迁移：package/packageRaw 取代 v1 的 npm/npmRaw，默认 package 带 aisdk: 前缀
    return { key: '', name: '', baseURL: '', apiKey: '', package: 'aisdk:@ai-sdk/openai-compatible', packageRaw: 'aisdk:@ai-sdk/openai-compatible', enabled: true, models: [], _new: true };
}

// 供应商列表视图状态：搜索词 + 视图模式（card=多列瀑布流 / list=单列）
// 视图模式持久化到 localStorage：上次选卡片下次打开仍是卡片，选列表仍是列表
const PROVIDER_VIEW_KEY = 'oc-manager-provider-view';
var providerSearchQuery = '';
var providerViewMode = null; // null = 尚未从 localStorage 读取（首次应用时惰性加载）

function getProviderViewMode() {
    if (!providerViewMode) {
        try {
            providerViewMode = localStorage.getItem(PROVIDER_VIEW_KEY) === 'list' ? 'list' : 'card';
        } catch (_) {
            providerViewMode = 'card';
        }
    }
    return providerViewMode;
}

/** 应用搜索过滤与视图模式（交互时调用；卡片重建后也需重新应用） */
function applyProviderFilter() {
    const list = document.getElementById('providersList');
    if (!list) return;
    const mode = getProviderViewMode();
    list.classList.toggle('list-mode', mode === 'list');
    const q = providerSearchQuery.trim().toLowerCase();
    list.querySelectorAll('.provider-card').forEach(c => {
        c.style.display = (!q || c.textContent.toLowerCase().indexOf(q) >= 0) ? '' : 'none';
    });
    const seg = document.getElementById('providerViewSeg');
    if (seg) {
        seg.querySelectorAll('.pv-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.view === mode));
    }
}

export function renderProviders(providers) {
    const list = document.getElementById('providersList');
    const isEmpty = !providers || !providers.length;
    const empty = isEmpty
        ? '<div class="prov-empty">暂无供应商，点击工具栏「添加供应商」</div>'
        : '';
    const html = (providers || []).map(p => providerCardHtml(p)).join('');
    // 空态强制单列（columns 下提示会挤在左列，居中到整个列表区）
    list.classList.toggle('is-empty', isEmpty);
    list.innerHTML = empty + html;
    bindProviderEvents(providers);
    // 恢复当前视图模式与搜索过滤（renderProviders 会重建卡片 DOM）
    applyProviderFilter();
}

export function providerCardHtml(p) {
    const isNew = p._new;
    // v2：接口格式字段为 package（不再读 v1 的 npm）；packageRaw 作为新增卡片/兜底时的原始值
    const packageValue = p.package || p.packageRaw || 'aisdk:@ai-sdk/openai-compatible';
    const matchedOption = PROVIDER_NPM_OPTIONS.find(item => item.value === (p.package || ''));
    const selectedPackageValue = matchedOption ? matchedOption.value : PROVIDER_NPM_UNMATCHED;
    const packageOptionsHtml = [
        ...PROVIDER_NPM_OPTIONS.map(item => `<option value="${escapeHtml(item.value)}" ${selectedPackageValue === item.value ? 'selected' : ''}>${escapeHtml(item.label)}</option>`),
        !matchedOption && packageValue ? `<option value="${PROVIDER_NPM_UNMATCHED}" selected>未匹配保留</option>` : ''
    ].join('');
    const enabled = p.enabled !== false;
    const allModels = p.models || [];
    // 收起态：列出模型名单（超过 4 个截断，title 保留完整名单）
    const modelsLineNames = allModels.slice(0, 3).map(m => String(m.id || '').split('/').pop()).join(' · ');
    const modelsLineMore = allModels.length > 3 ? ` <span class="more">等 ${allModels.length} 个</span>` : '';
    const modelsLine = allModels.length
        ? `<span class="prov-models-label">模型</span><span class="prov-models-names" title="${escapeHtml(allModels.map(m => m.id).join('、'))}">${escapeHtml(modelsLineNames)}</span>${modelsLineMore}`
        : '<span class="prov-models-label">模型</span><span class="prov-models-empty">暂无模型</span>';
    const modelsHtml = allModels.length
        ? allModels.map(m => modelSubcardHtml({ id: m.id, name: m.name || '' }, m.capabilities)).join('')
        : '<div class="prov-empty">暂无模型，点击「手动添加」或「 获取模型列表」</div>';
    const baseHost = (p.baseURL || '').trim().replace(/^https?:\/\//, '');
    // 说明：接口格式下拉的类名 .prov-edit-npm 与 data-raw-npm 保留 v1 命名（CSS/事件绑定依赖），
    // 其承载的对外字段已是 v2 的 package
    return `
        <div class="provider-card${enabled ? '' : ' disabled'}${isNew ? ' expanded new-provider' : ''}" data-key="${escapeHtml(p.key)}">
            <div class="provider-card-header">
                <div class="provider-title">
                    <span class="prov-expand-ic" aria-hidden="true"></span>
                    <label class="prov-toggle" title="启用该供应商">
                        <input type="checkbox" class="prov-edit-enabled" ${enabled ? 'checked' : ''} />
                        <span class="prov-toggle-track"><span class="prov-toggle-thumb"></span></span>
                    </label>
                    <span class="prov-name">${escapeHtml(p.name || p.key || '新供应商')}</span>
                    <span class="prov-key">${escapeHtml(p.key || '未命名')}</span>
                    <span class="prov-badge">${allModels.length} 个模型</span>
                </div>
                <div class="provider-card-actions">
                    <button class="btn btn-del btn-del-card" data-key="${escapeHtml(p.key)}" title="删除供应商" aria-label="删除供应商"><span class="prov-del-ic" aria-hidden="true"></span></button>
                </div>
            </div>
            <div class="provider-summary">
                <span class="mono">${escapeHtml(baseHost) || '未设置请求地址'}</span>
                <span class="sep">·</span>
                <span>${escapeHtml(p.package || packageValue)}</span>
            </div>
            <div class="prov-models-line">${modelsLine}</div>
            <div class="provider-card-body">
                <div class="provider-conn-row">
                    ${isNew ? `<label class="provider-conn-col"><span class="prov-field-label">供应商标识 (key)</span><input class="prov-edit-key" value="${escapeHtml(p.key || '')}" placeholder="key (如 deepseek)" /></label>` : ''}
                    <label class="provider-conn-col">
                        <span class="prov-field-label">供应商名称</span>
                        <input class="prov-edit-name" value="${escapeHtml(p.name||'')}" placeholder="名称" />
                    </label>
                </div>
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
                        <select class="prov-edit-npm" data-raw-npm="${escapeHtml(p.package || '')}" aria-label="interface format">
                            ${packageOptionsHtml}
                        </select>
                    </label>
                </div>
                <div class="provider-models">
                    <div class="provider-models-title">模型 <button class="btn btn-sm btn-add btn-add-model-card" data-key="${escapeHtml(p.key)}">手动添加</button><button class="btn btn-sm btn-add btn-fetch-models" data-key="${escapeHtml(p.key)}" style="margin-left:4px">📡 获取模型列表</button></div>
                    <div class="card-models-list" data-key="${escapeHtml(p.key)}">
                        ${modelsHtml}
                    </div>
                </div>
                <div class="provider-save-row">
                    <button class="btn btn-sm btn-save-card" data-key="${escapeHtml(p.key)}">保存</button>
                </div>
            </div>
        </div>`;
}

export function bindProviderEvents(providers) {
    providerCache = providers;

    document.querySelectorAll('.btn-save-card').forEach(btn => {
        btn.addEventListener('click', () => saveProviderFromDom(btn.dataset.key));
    });

    // 启用开关：点击立即保存生效（卡片默认收起，收起态看不到保存按钮）
    document.querySelectorAll('.prov-edit-enabled').forEach(input => {
        input.addEventListener('change', () => {
            const card = input.closest('.provider-card');
            if (!card) return;
            toggleProviderEnabled(card, input, input.checked);
        });
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
            // 默认不勾选任何能力（保存时全空则不写 capabilities 字段）
            const temp = document.createElement('div');
            temp.innerHTML = modelSubcardHtml({ id: '', name: '' }).trim();
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

    // 点击标题栏/摘要行展开折叠（排除开关、删除与表单控件）
    document.querySelectorAll('.provider-card').forEach(card => {
        const head = card.querySelector('.provider-card-header');
        const summary = card.querySelector('.provider-summary');
        [head, summary].forEach(el => {
            if (!el || el.dataset.expandBound) return;
            el.dataset.expandBound = '1';
            el.addEventListener('click', (e) => {
                if (e.target.closest('.prov-toggle, .btn-del-card, .btn-save-card, .btn-add-model-card, .btn-fetch-models, .btn-toggle-abilities, .btn-del-model, input, select')) return;
                card.classList.toggle('expanded');
            });
        });
    });
}

export function addNewCard() {
    const isNew = providerCache.some(p => p._new);
    if (isNew) { showToast('请先保存当前新增的供应商', 'info'); return; }
    // 清空搜索：避免新建的空卡片被当前过滤条件隐藏
    providerSearchQuery = '';
    const searchEl = document.getElementById('providerSearch');
    if (searchEl) searchEl.value = '';
    providerCache.push(emptyProvider());
    renderProviders(providerCache);
    // 新卡渲染在列表末尾并默认展开：滚动到可见位置，聚焦「供应商标识」
    const newCard = document.querySelector('.provider-card.new-provider');
    if (newCard) {
        newCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const keyInput = newCard.querySelector('.prov-edit-key');
        if (keyInput) keyInput.focus();
    }
}

/**
 * 从卡片 DOM 收集提交数据（保存按钮与启用开关共用）。
 * 收起态下编辑区只是 display:none，表单值仍可正常读取。
 */
export function collectProviderData(card) {
    // 下拉的类名/数据属性保留 v1 命名（.prov-edit-npm / data-raw-npm），提交字段已迁移为 v2 的 package
    const packageSelect = card.querySelector('.prov-edit-npm');
    const selectedPackage = packageSelect?.value || '';
    const rawPackage = packageSelect?.dataset.rawNpm || '';

    // 已添加供应商的标识不可编辑（标题栏只读徽章）：优先取新增卡的 key 输入，否则用卡片的 data-key
    const keyInput = card.querySelector('.prov-edit-key');
    const data = {
        key: keyInput ? keyInput.value.trim() : (card.dataset.key || '').trim(),
        name: card.querySelector('.prov-edit-name').value.trim(),
        baseURL: card.querySelector('.prov-edit-url').value.trim(),
        apiKey: card.querySelector('.prov-edit-apikey').value.trim(),
        // 选中「未匹配保留」哨兵值时，回退提交渲染时挂在 data-raw-npm 上的原始 package
        package: selectedPackage === PROVIDER_NPM_UNMATCHED ? rawPackage : selectedPackage,
        enabled: card.querySelector('.prov-edit-enabled').checked,
        models: []
    };

    card.querySelectorAll('.model-subcard').forEach(row => {
        const id = row.querySelector('.model-edit-id')?.value?.trim();
        const name = row.querySelector('.model-edit-name')?.value?.trim();
        if (!id) return;
        const tools  = !!row.querySelector('.mod-tools')?.checked;
        const input  = [...row.querySelectorAll('.mod-input:checked')].map(c => c.value);
        const output = [...row.querySelectorAll('.mod-output:checked')].map(c => c.value);
        // v2 保存契约要求 id 与 modelID 两个字段：当前 UI 只有单一「模型ID」输入，
        // 两者同源写入该输入值（后端以二者标识同一个模型）
        const model = { id, name: name || id, modelID: id };
        // 仅当设置了任意能力（工具/输入/输出任一非空）时才写 capabilities；
        // 全空则省略字段，交给 OpenCode 走 models.dev 兜底
        if (tools || input.length || output.length) {
            model.capabilities = { tools, input, output };
        }
        data.models.push(model);
    });

    return data;
}

/** 同步启用态 UI：卡片禁用样式（标题栏开关本身由 checkbox 状态驱动） */
function applyProviderEnabledUi(card, enabled) {
    card.classList.toggle('disabled', !enabled);
}

/**
 * 启用开关：点击即保存生效。
 * 卡片默认收起，收起态看不到保存按钮，因此不能依赖展开后手动保存。
 * 先乐观更新 UI，保存失败时回滚开关与卡片样式。
 */
function toggleProviderEnabled(card, input, enabled) {
    const key = card.dataset.key;
    if (!key) {
        input.checked = !enabled;
        showToast('请先保存供应商后再切换启用状态', 'info');
        return;
    }
    applyProviderEnabledUi(card, enabled);
    const data = collectProviderData(card);
    data.enabled = enabled;
    input.disabled = true;
    api.SaveProvider(data).then(r => {
        input.disabled = false;
        if (r.success) {
            const cached = providerCache.find(p => p.key === key);
            if (cached) cached.enabled = enabled;
            showToast(`${data.name || key} 已${enabled ? '启用' : '禁用'}`, 'success');
        } else {
            input.checked = !enabled;
            applyProviderEnabledUi(card, !enabled);
            showToast('切换失败: ' + (r.error || '未知错误'), 'error');
        }
    }).catch(err => {
        input.disabled = false;
        input.checked = !enabled;
        applyProviderEnabledUi(card, !enabled);
        showApiError('切换启用状态失败: ', err);
    });
}

export function saveProviderFromDom(key) {
    const card = document.querySelector(`.provider-card[data-key="${CSS.escape(key)}"]`);
    if (!card) return;

    const data = collectProviderData(card);
    if (!data.key) { showToast('Key 不能为空', 'error'); return; }

    const btn = card.querySelector('.btn-save-card');
    btn.disabled = true; btn.textContent = '...';

    api.SaveProvider(data).then(r => {
        if (r.success) {
            showToast(`供应商 ${data.key} 已保存`, 'success');
            // 保存成功不重新加载列表，保持当前界面状态
            btn.disabled = false; btn.textContent = '保存';
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
            btn.disabled = false; btn.textContent = '保存';
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
        showApiError('获取模型列表失败: ', e);
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
        // 状态圆点：蓝=可新增（未添加）/ 红=可删除（已添加），与按钮悬停语义色对应
        html += '<div class="model-list-row">' +
            '<span class="model-list-dot ' + (existingSet[m] ? 'del' : 'add') + '"></span>' +
            '<span class="model-list-name">' + escaped + '</span>';
        if (existingSet[m]) {
            // 行内操作按钮图标化：删除用「关闭.svg」（保留红色语义），title 提供可读提示
            html += '<button class="btn btn-sm btn-del" data-action="del" data-model="' + escaped + '" title="删除"><span class="oc-fb-icon oc-fb-icon-minus" aria-hidden="true"></span></button>';
        } else {
            html += '<button class="btn btn-sm btn-add" data-action="add" data-model="' + escaped + '" title="增加"><span class="oc-fb-icon oc-fb-icon-add" aria-hidden="true"></span></button>';
        }
        html += '</div>';
    });
    html += '</div>';

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'modelListModal';
    overlay.innerHTML = '<div class="modal modal-card proxy-modal" style="max-width:420px">' +
        '<div class="modal-header"><h3>' + escapeHtml(name) + '-模型</h3>' +
        '<button type="button" class="modal-close-btn" id="btnCloseModelList" title="关闭"><span class="oc-fb-icon oc-fb-icon-close" aria-hidden="true"></span></button></div>' +
        '<div class="modal-body">' + html + '</div>' +
        '</div>';
    document.body.appendChild(overlay);
    overlay.style.display = 'flex';
    // 事件绑定：由 bindOverlayClose 统一处理「点击遮罩关闭」，
    // 仅当按下与松开都在遮罩上才关闭（新机制不再需要子元素 stopPropagation）
    bindOverlayClose(overlay, closeModelListModal);
    overlay.querySelector('#btnCloseModelList').addEventListener('click', closeModelListModal);

    overlay.querySelectorAll('[data-action]').forEach(function(actBtn) {
        actBtn.addEventListener('click', function() {
            var action = this.dataset.action;
            var modelId = this.dataset.model;
            var list = document.querySelector('.card-models-list[data-key="' + CSS.escape(key) + '"]');
            if (!list) return;

            if (action === 'add') {
                // 移除空态占位（若有）
                const emptyEl = list.querySelector('.prov-empty');
                if (emptyEl) emptyEl.remove();
                // 与「手动添加」走同一套 modelSubcardHtml 结构（能力区默认折叠）；
                // 弹窗拉取的模型 ID 固定 readonly，默认不勾选任何能力（全空则不写 capabilities）
                const temp = document.createElement('div');
                temp.innerHTML = modelSubcardHtml(
                    { id: modelId, name: modelId, readonlyId: true }
                ).trim();
                const row = temp.firstElementChild;
                row.querySelector('.btn-del-model').addEventListener('click', function() { row.remove(); });
                list.appendChild(row);
                // 切换删除态图标（不能用 textContent，会清掉图标 span 变纯文字）
                this.innerHTML = '<span class="oc-fb-icon oc-fb-icon-minus" aria-hidden="true"></span>';
                this.className = 'btn btn-sm btn-del';
                this.dataset.action = 'del';
                this.title = '删除';
            } else if (action === 'del') {
                list.querySelectorAll('.model-edit-id').forEach(function(input) {
                    if (input.value.trim() === modelId) {
                        input.closest('.model-subcard').remove();
                    }
                });
                // 切换增加态图标（不能用 textContent，会清掉图标 span 变纯文字）
                this.innerHTML = '<span class="oc-fb-icon oc-fb-icon-add" aria-hidden="true"></span>';
                this.className = 'btn btn-sm btn-add';
                this.dataset.action = 'add';
                this.title = '增加';
            }
            // 圆点跟随按钮状态（add=未添加蓝 / del=已添加红）
            var rowEl = this.closest('.model-list-row');
            var dotEl = rowEl ? rowEl.querySelector('.model-list-dot') : null;
            if (dotEl) dotEl.className = 'model-list-dot ' + this.dataset.action;
        });
    });
}

export function closeModelListModal() {
    var m = document.getElementById('modelListModal');
    if (m) m.remove();
}
