// ============================================================
// OpenCode 管理中心 - 知识库 @ 引用（工作区聊天输入框）
// 在 #ocPrompt 中输入 "@" 时弹出知识库搜索面板；选中条目后把 textarea 里的
// "@查询词" 删除，并在输入框上方的引用区（#ocRefs）添加一个引用胶囊。
// 发送时由 chat/session.js 调用 collectKnowledgeRefs() 取全文，作为独立 part 注入。
// 依赖：core/apicall.js（api）、core/utils.js（escapeHtml, showToast）
// ============================================================

import { api } from '../core/apicall.js';
import { escapeHtml, showToast } from '../core/utils.js';

// ---------- 内联线性图标（与 views/knowledge.js 同一套语言，不使用 emoji） ----------
var ICONS = {
    doc: '<svg class="kb-i" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    close: '<svg class="kb-i kb-i-14" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>'
};

// ---------- DOM 获取（延迟取，避免模块加载时序问题；元素均为静态 HTML） ----------
function inputEl() { return document.getElementById('ocPrompt'); }
function refsEl() { return document.getElementById('ocRefs'); }
function panelEl() { return document.getElementById('ocKbPalette'); }
function scrollEl() { return document.getElementById('ocKbScroll'); }
function searchEl() { return document.getElementById('ocKbSearchInput'); }

// ---------- 模块状态 ----------
var kbItems = [];        // 知识库条目元数据缓存（KnowledgeList 结果）
var kbFiltered = [];     // 当前查询词的过滤结果
var kbActiveIdx = 0;     // 面板高亮项索引
var kbVisible = false;   // 面板是否可见
var kbLoading = false;   // 列表是否正在拉取
var kbBound = false;     // 事件是否已绑定（防止重复初始化）

// ============================================================
// 初始化与事件绑定
// ============================================================

/**
 * 初始化知识库引用交互（由 main.js 在 DOMContentLoaded 调用）。
 * 幂等：重复调用只生效一次。
 */
export function initKnowledgeRef() {
    if (kbBound) return;
    if (!inputEl() || !refsEl() || !panelEl()) return;
    kbBound = true;

    // textarea 输入：检查光标前是否以 @查询词 结尾
    inputEl().addEventListener('input', onPromptInput);

    // 面板内搜索框：允许在面板里继续收窄过滤（不改变 textarea 内容）
    var se = searchEl();
    if (se) {
        se.addEventListener('input', function () {
            kbActiveIdx = 0;
            renderKbPanel(se.value);
        });
    }

    // 键盘导航：capture 阶段，先于 main.js 的 Enter 发送逻辑
    inputEl().addEventListener('keydown', onPaletteKeydown, true);
    if (se) se.addEventListener('keydown', onPaletteKeydown, true);

    // 点击面板外关闭（click 优于 blur，点击面板项不会先触发失焦）
    document.addEventListener('click', function (e) {
        if (!kbVisible) return;
        var panel = panelEl();
        if ((panel && panel.contains(e.target)) || e.target === inputEl()) return;
        hideKbPalette();
    });

    updateRefsVisibility();
}

// ============================================================
// 面板打开 / 关闭
// ============================================================

/** textarea 输入处理：命中 /@([^\s@]*)$/ 则打开面板，否则关闭 */
function onPromptInput() {
    var el = inputEl();
    if (!el) return;
    var value = el.value;
    var pos = el.selectionStart == null ? value.length : el.selectionStart;
    // 只看光标之前的文本，避免光标后面的内容误触
    var m = value.slice(0, pos).match(/@([^\s@]*)$/);
    if (!m) {
        hideKbPalette();
        return;
    }
    openKbPalette(m[1]);
}

/**
 * 打开面板：先用缓存渲染避免等待闪烁，再拉取最新列表后重渲染。
 * @param {string} query 当前查询词（@ 之后的字符）
 */
async function openKbPalette(query) {
    var panel = panelEl();
    if (!panel) return;
    kbVisible = true;
    panel.style.display = 'block';

    var se = searchEl();
    if (se && se.value !== query) se.value = query;

    kbActiveIdx = 0;
    renderKbPanel(query);

    await loadKbItems();

    // 请求期间用户可能已关闭面板或改了查询词
    if (!kbVisible) return;
    renderKbPanel(searchEl() ? searchEl().value : query);
}

/** 关闭面板（不改变 textarea 内容） */
export function hideKbPalette() {
    var panel = panelEl();
    kbVisible = false;
    kbActiveIdx = 0;
    if (panel) panel.style.display = 'none';
}

// ============================================================
// 数据加载与过滤
// ============================================================

/** 拉取知识库列表（每次打开都刷新，保证新增条目立即可见） */
async function loadKbItems() {
    if (kbLoading) return;
    kbLoading = true;
    try {
        var list = await api.KnowledgeList();
        kbItems = Array.isArray(list) ? list : [];
    } catch (e) {
        if (!kbItems.length) showToast('加载知识库失败: ' + (e.message || e), 'error');
    } finally {
        kbLoading = false;
    }
}

/**
 * 过滤条目：标题 / 说明 / 标签 命中，标题命中优先。
 * 无查询词时返回全部（列表已按更新时间倒序）。
 */
function filterKbItems(query) {
    var q = (query || '').trim().toLowerCase();
    if (!q) return kbItems.slice();
    var hits = [];
    kbItems.forEach(function (e) {
        var title = (e.title || '').toLowerCase();
        var summary = (e.summary || '').toLowerCase();
        var tags = (e.tags || []).join(' ').toLowerCase();
        if (title.indexOf(q) !== -1) {
            hits.push({ rank: 0, entry: e });
        } else if (summary.indexOf(q) !== -1 || tags.indexOf(q) !== -1) {
            hits.push({ rank: 1, entry: e });
        }
    });
    // 稳定排序：rank 相同的保持后端返回顺序
    hits.sort(function (a, b) { return a.rank - b.rank; });
    return hits.map(function (h) { return h.entry; });
}

// ============================================================
// 面板渲染
// ============================================================

/** 渲染结果列表（含空态与加载态） */
function renderKbPanel(query) {
    var host = scrollEl();
    if (!host) return;

    kbFiltered = filterKbItems(query);
    if (kbActiveIdx >= kbFiltered.length) kbActiveIdx = Math.max(0, kbFiltered.length - 1);
    if (kbActiveIdx < 0) kbActiveIdx = 0;

    if (kbLoading && !kbItems.length) {
        host.innerHTML = '<div class="oc-kb-empty">正在加载知识库...</div>';
        return;
    }
    if (!kbFiltered.length) {
        host.innerHTML = '<div class="oc-kb-empty">' +
            (kbItems.length ? '没有匹配的知识库条目' : '知识库还没有条目') + '</div>';
        return;
    }

    var html = '';
    kbFiltered.forEach(function (e, i) {
        var active = i === kbActiveIdx ? ' active' : '';
        var tags = (e.tags || []).slice(0, 3).map(function (t) {
            return '<span class="oc-kb-tag">#' + escapeHtml(t) + '</span>';
        }).join('');
        html += '<div class="oc-kb-item' + active + '" data-kb-idx="' + i + '">' +
                    '<span class="oc-kb-item-icon">' + ICONS.doc + '</span>' +
                    '<span class="oc-kb-item-main">' +
                        '<span class="oc-kb-item-title">' + escapeHtml(e.title || e.id || '') + '</span>' +
                        '<span class="oc-kb-item-summary">' + escapeHtml(e.summary || '（暂无说明）') + '</span>' +
                    '</span>' +
                    (tags ? '<span class="oc-kb-item-tags">' + tags + '</span>' : '') +
                '</div>';
    });
    host.innerHTML = html;

    // 点击选中：mousedown 并阻止默认行为，避免 textarea 失焦丢失光标
    host.querySelectorAll('.oc-kb-item').forEach(function (el) {
        el.addEventListener('mousedown', function (e) {
            e.preventDefault();
            chooseKbItem(parseInt(el.dataset.kbIdx, 10));
        });
    });

    // 高亮项保持在可视区内
    var activeEl = host.querySelector('.oc-kb-item.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

// ============================================================
// 键盘导航与选中
// ============================================================

/** 面板键盘处理：↑/↓ 移动、Enter/Tab 选中、Esc 关闭 */
function onPaletteKeydown(e) {
    if (!kbVisible) return;
    switch (e.key) {
        case 'Escape':
            e.preventDefault();
            hideKbPalette();
            break;
        case 'ArrowDown':
            e.preventDefault();
            e.stopImmediatePropagation();
            moveKbActive(1);
            break;
        case 'ArrowUp':
            e.preventDefault();
            e.stopImmediatePropagation();
            moveKbActive(-1);
            break;
        case 'Enter':
        case 'Tab':
            if (!kbFiltered.length) {
                // 无匹配项：不拦截，交回默认行为（Enter 正常发送），仅关闭面板避免遮挡
                hideKbPalette();
                return;
            }
            e.preventDefault();
            e.stopImmediatePropagation();
            chooseKbItem(kbActiveIdx);
            break;
    }
}

/** 循环移动高亮项 */
function moveKbActive(delta) {
    if (!kbFiltered.length) return;
    kbActiveIdx = (kbActiveIdx + delta + kbFiltered.length) % kbFiltered.length;
    renderKbPanel(searchEl() ? searchEl().value : '');
}

/**
 * 选中某条目：去重 → 添加胶囊 → 删除 textarea 里的 @查询词 → 关闭面板并回焦。
 * @param {number} idx kbFiltered 中的索引
 */
function chooseKbItem(idx) {
    var entry = kbFiltered[idx];
    if (!entry) return;
    var id = entry.id;

    if (hasRef(id)) {
        // 去重：同一条目重复引用时不再添加，仅清理触发词
        showToast('该知识库条目已引用', 'info');
    } else {
        addRefChip(entry);
    }
    removeTriggerFromInput();
    hideKbPalette();
    focusPrompt();
}

/** 删除 textarea 中光标前的 "@查询词"（光标位置不变） */
function removeTriggerFromInput() {
    var el = inputEl();
    if (!el) return;
    var value = el.value;
    var pos = el.selectionStart == null ? value.length : el.selectionStart;
    var m = value.slice(0, pos).match(/@([^\s@]*)$/);
    if (!m) return;
    var start = pos - m[0].length;
    el.value = value.slice(0, start) + value.slice(pos);
    el.selectionStart = el.selectionEnd = start;
}

/** 焦点回到 textarea */
function focusPrompt() {
    var el = inputEl();
    if (el) el.focus();
}

// ============================================================
// 引用胶囊
// ============================================================

/** 是否已引用某条目 */
function hasRef(id) {
    var host = refsEl();
    if (!host) return false;
    var chips = host.querySelectorAll('[data-kb-ref]');
    for (var i = 0; i < chips.length; i++) {
        if (chips[i].dataset.kbRef === id) return true;
    }
    return false;
}

/** 追加一个引用胶囊（id 存在 data-kb-ref 上，供收集与去重使用） */
function addRefChip(entry) {
    var host = refsEl();
    if (!host || !entry) return;
    var title = entry.title || entry.id;

    var chip = document.createElement('span');
    chip.className = 'oc-ref-chip';
    chip.dataset.kbRef = entry.id;
    chip.title = title;
    chip.innerHTML = '<span class="oc-ref-chip-icon">' + ICONS.doc + '</span>' +
                     '<span class="oc-ref-chip-name">' + escapeHtml(title) + '</span>' +
                     '<button type="button" class="oc-ref-chip-remove" title="移除引用" aria-label="移除引用">' +
                         ICONS.close +
                     '</button>';

    chip.querySelector('.oc-ref-chip-remove').addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        chip.remove();
        updateRefsVisibility();
    });

    host.appendChild(chip);
    updateRefsVisibility();
}

/** 引用区无内容时隐藏，避免占位 */
function updateRefsVisibility() {
    var host = refsEl();
    if (!host) return;
    host.classList.toggle('hidden', host.children.length === 0);
}

// ============================================================
// 对外接口（供 session.js 调用）
// ============================================================

/** 当前是否有知识库引用 */
export function hasKnowledgeRefs() {
    var host = refsEl();
    return !!(host && host.children.length > 0);
}

/**
 * 收集当前所有引用（按添加顺序），逐个拉取全文。
 * 单条拉取失败时仅返回元数据、content 为空，不阻断发送。
 * @returns {Promise<Array<{id:string,title:string,summary:string,content:string}>>}
 */
export async function collectKnowledgeRefs() {
    var host = refsEl();
    if (!host) return [];
    var chips = Array.prototype.slice.call(host.querySelectorAll('[data-kb-ref]'));
    var out = [];

    for (var i = 0; i < chips.length; i++) {
        var id = chips[i].dataset.kbRef;
        var meta = null;
        for (var j = 0; j < kbItems.length; j++) {
            if (kbItems[j].id === id) { meta = kbItems[j]; break; }
        }

        var content = '';
        try {
            var full = await api.KnowledgeGet(id);
            if (full) {
                content = full.content || '';
                if (!meta) meta = full;
            }
        } catch (e) {
            // 取全文失败：保留引用元数据，内容留空
            content = '';
        }

        out.push({
            id: id,
            title: (meta && meta.title) || id,
            summary: (meta && meta.summary) || '',
            content: content
        });
    }
    return out;
}

/** 清空引用区（发送成功后调用，与附件清空同步） */
export function clearKnowledgeRefs() {
    var host = refsEl();
    if (!host) return;
    host.innerHTML = '';
    updateRefsVisibility();
}
