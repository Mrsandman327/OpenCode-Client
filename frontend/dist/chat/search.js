// ============================================================
// OpenCode 管理中心 - 消息搜索
// Ctrl+F 在当前会话中搜索消息内容
// 依赖：core/state.js（expandedParts）、core/utils.js（getActiveMessagesEl）
// ============================================================

import { store } from '../core/state.js';
import { getActiveMessagesEl, safeText } from '../core/utils.js';

/** 搜索状态：保存可长期复用的纯数据描述，不长期持有旧 DOM 节点。
 *  query/sessionID 标识当前搜索；activeKey 是命中位置的纯数据键
 *  （搜索作用域 + 该作用域内第几个匹配），DOM 重建后据此找回同一处；
 *  activeGlobalIndex 是 key 失效（原位置被删除/流式改写）时的钳位兜底。 */
var searchState = {
    query: '',
    sessionID: '',
    activeKey: '',
    activeGlobalIndex: -1,
    // 搜索导航临时展开的工具卡：partId -> true。
    // 和思考过程一致，导航离开或关闭搜索时自动折叠，不改变用户原本的展开状态。
    tempExpandedTools: Object.create(null),
};
/** 当前 DOM 代的高亮 mark（每次同步后从 DOM 重新收集，不作为长期引用） */
var searchResults = [];
/** 当前聚焦的搜索结果在数组中的索引 */
var searchIndex = -1;
/** 搜索时临时展开的隐藏 part，用于在折叠区域中定位搜索结果 */
let searchTemporaryExpansion = null;
/** 搜索导航保护截止时间（毫秒时间戳）：平滑滚动期间禁止滚动分页误判「到顶」 */
var searchNavUntil = 0;

/**
 * 判断当前是否处于可响应 Ctrl+F 的会话上下文：
 * 会话视图（ocSearchBar 所在 view-panel）处于激活状态，且没有模态/覆盖层打开
 * （如文件浏览器弹窗、子任务弹窗等），避免在其他界面按 Ctrl+F 误打开会话搜索栏。
 */
function isSessionSearchContext() {
    var searchBar = document.getElementById('ocSearchBar');
    if (!searchBar) return false;
    var viewPanel = searchBar.closest('.view-panel');
    if (viewPanel && !viewPanel.classList.contains('active')) return false;
    var overlays = document.querySelectorAll('.modal-overlay');
    for (var i = 0; i < overlays.length; i++) {
        if (getComputedStyle(overlays[i]).display !== 'none') return false;
    }
    return true;
}

/**
 * 初始化搜索功能
 * - 绑定 Ctrl+F 打开搜索栏（仅会话视图激活且无模态时响应）
 * - 绑定 Escape 关闭搜索
 * - 绑定输入框的输入事件（200ms 防抖执行搜索）
 * - 绑定关闭、上一条、下一条按钮
 */
export function initSearch() {
    document.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.key === 'f') {
            // 非会话上下文（其他视图激活或模态打开）不响应，保持默认行为
            if (!isSessionSearchContext()) return;
            e.preventDefault();
            var bar = document.getElementById('ocSearchBar');
            if (bar) {
                bar.style.display = 'flex';
                var input = document.getElementById('ocSearchInput');
                if (input) { input.focus(); input.select(); }
            }
        }
        if (e.key === 'Escape') { closeSearch(); }
    });

    var searchInput = document.getElementById('ocSearchInput');
    if (searchInput) {
        var searchTimer;
        searchInput.addEventListener('input', function() {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(function() { doSearch(searchInput.value); }, 200);
        });
    }

    var closeBtn = document.getElementById('ocSearchClose');
    if (closeBtn) closeBtn.addEventListener('click', closeSearch);

    var prevBtn = document.getElementById('ocSearchPrev');
    if (prevBtn) prevBtn.addEventListener('click', function() { navigateSearch(-1); });

    var nextBtn = document.getElementById('ocSearchNext');
    if (nextBtn) nextBtn.addEventListener('click', function() { navigateSearch(1); });
}

/**
 * 计算文本节点所属的搜索作用域键。
 * 优先用 part id（part 是重构后的最小稳定单元）；没有 part id 时退回消息 id；
 * 都没有则归入根作用域。作用域键 + 作用域内序号组成 activeKey，
 * 保证 DOM 重建后还能定位到同一处匹配。
 */
function resolveScopeKey(element) {
    var part = element && element.closest ? element.closest('.oc-part') : null;
    if (part && part.dataset && part.dataset.partId) return 'p:' + part.dataset.partId;
    var msg = element && element.closest ? element.closest('.oc-message') : null;
    if (msg && msg.dataset && msg.dataset.messageId) return 'm:' + msg.dataset.messageId;
    return 'r';
}

/**
 * 在 root 内扫描 query，并把每个匹配文本包成 <mark class="oc-search-highlight">。
 * 返回按 DOM 顺序排列的 mark 数组；每个 mark 带 data-search-key 纯数据键。
 *
 * 同一个文本节点内的所有出现都会高亮（旧实现只包第一个，导致计数偏少）。
 * 包裹从后往前执行，避免前一次分割改变后续匹配的偏移。
 *
 * @param {HTMLElement} root 扫描根（整个消息容器 / 单条消息 / 新增消息节点）
 * @param {string} query 搜索词
 * @returns {HTMLElement[]}
 */
function scanScope(root, query) {
    var out = [];
    if (!root || !query) return out;
    var lowerQuery = query.toLowerCase();
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    // 按作用域累计序号：同一 part 内第几个匹配决定 activeKey 的稳定后缀
    var counters = Object.create(null);
    for (var n = 0; n < textNodes.length; n++) {
        var node = textNodes[n];
        var parent = node.parentElement;
        if (!parent) continue;
        // 已高亮文本跳过，避免重复包裹（增量同步时可能扫到旧 mark 所在区域）
        if (parent.closest('.oc-search-highlight')) continue;
        // 空态提示不是消息内容，不参与搜索
        if (parent.closest('.oc-empty')) continue;
        // 折叠工具卡摘要不参与 DOM 扫描：完整内容由 scanCollapsedToolData 负责，避免重复计数
        if (parent.closest('.oc-tool-summary')) continue;

        var text = node.textContent || '';
        var lower = text.toLowerCase();
        var idx = lower.indexOf(lowerQuery);
        if (idx < 0) continue;

        // 收集该文本节点内所有匹配位置（不重叠）
        var matches = [];
        while (idx >= 0) {
            matches.push(idx);
            idx = lower.indexOf(lowerQuery, idx + lowerQuery.length);
        }

        var scopeKey = resolveScopeKey(parent);
        var msgEl = parent.closest('.oc-message');
        var messageId = msgEl && msgEl.dataset ? (msgEl.dataset.messageId || '') : '';
        var base = counters[scopeKey] || 0;
        var made = new Array(matches.length);
        for (var m = matches.length - 1; m >= 0; m--) {
            try {
                var range = document.createRange();
                range.setStart(node, matches[m]);
                range.setEnd(node, matches[m] + lowerQuery.length);
                var mark = document.createElement('mark');
                mark.className = 'oc-search-highlight';
                var keyStr = scopeKey + '#' + (base + m);
                mark.dataset.searchKey = keyStr;
                range.surroundContents(mark);
                made[m] = { key: keyStr, mark: mark, anchor: null, source: 'dom', messageId: messageId };
            } catch (_) {
                made[m] = null;
            }
        }
        for (var k = 0; k < made.length; k++) {
            if (made[k]) out.push(made[k]);
        }
        counters[scopeKey] = base + matches.length;
    }
    return out;
}

/** 在 root 内按 part id 查找可折叠卡片节点（工具卡或思考过程） */
function findCollapsiblePartElement(root, partId) {
    if (!root || !root.querySelector || !partId) return null;
    return root.querySelector('.oc-part[data-part-id="' + CSS.escape(partId) + '"]');
}

/**
 * 折叠卡片的数据索引：工具卡读 state.input/output/error，思考过程读 part.text。
 *
 * 折叠状态为了控制 DOM 总量不构建正文，因此搜索结果不能只依赖 DOM。
 * 每个命中字段产生一个结果，定位到该卡片节点；卡片展开后正文进入 DOM，
 * 由 scanScope 负责精确高亮。
 *
 * @param {HTMLElement} root 搜索作用域（整个消息容器或单条消息）
 * @param {Array} items 与作用域对应的消息数据
 * @param {string} query 搜索词
 */
function scanCollapsedToolData(root, items, query) {
    var out = [];
    if (!root || !items || !items.length || !query) return out;
    var lower = query.toLowerCase();
    // 先一次性收集可折叠卡片节点，避免每个 part 都全量 querySelector
    var partMap = Object.create(null);
    var partEls = root.querySelectorAll('.oc-tool[data-part-id], .oc-reasoning[data-part-id]');
    for (var t = 0; t < partEls.length; t++) {
        partMap[partEls[t].dataset.partId] = partEls[t];
    }
    for (var i = 0; i < items.length; i++) {
        var item = items[i] || {};
        var info = item.info || item;
        var messageId = String(info.id || '');
        var parts = Array.isArray(item.parts) ? item.parts : [];
        for (var p = 0; p < parts.length; p++) {
            var part = parts[p];
            if (!part) continue;
            var partType = part.type;
            if (partType !== 'tool' && partType !== 'reasoning') continue;
            var partId = String(part.id || '');
            if (!partId) continue;
            var partEl = partMap[partId] || null;
            if (!partEl) continue;
            // 已展开且构建了正文的卡片由 DOM 扫描负责，避免重复计数
            var body = partEl.querySelector('.oc-tool-body, .oc-reasoning-body');
            if (body && body.dataset.toolBodyBuilt === 'true' && !body.classList.contains('hidden')) continue;
            if (partType === 'reasoning') {
                var rtext = safeText(part.text);
                if (rtext && rtext.toLowerCase().indexOf(lower) >= 0) {
                    out.push({
                        key: 'p:' + partId + ':data:text',
                        mark: null,
                        anchor: partEl,
                        source: 'data',
                        messageId: messageId,
                        field: 'text',
                    });
                }
                continue;
            }
            var state = part.state || {};
            var fields = [['input', state.input], ['output', state.output], ['error', state.error]];
            for (var f = 0; f < fields.length; f++) {
                var text = safeText(fields[f][1]);
                if (!text) continue;
                if (text.toLowerCase().indexOf(lower) < 0) continue;
                out.push({
                    key: 'p:' + partId + ':data:' + fields[f][0],
                    mark: null,
                    anchor: partEl,
                    source: 'data',
                    messageId: messageId,
                    // 记录命中的字段：展开后据此定位到输入/输出/错误对应的正文区域
                    field: fields[f][0],
                });
            }
        }
    }
    return out;
}

/** 按文档顺序排序搜索结果（DOM 高亮与折叠工具卡数据结果混合） */
function sortSearchResults(list) {
    return list.sort(function (a, b) {
        var ea = a.mark || a.anchor;
        var eb = b.mark || b.anchor;
        if (!ea || !eb || ea === eb) return 0;
        var pos = ea.compareDocumentPosition(eb);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
    });
}

/** 收集一次完整搜索结果：DOM 文本高亮 + 折叠工具卡数据索引 */
function collectSearchResults(root, items, query) {
    var domResults = scanScope(root, query);
    var dataResults = scanCollapsedToolData(root, items, query);
    return sortSearchResults(domResults.concat(dataResults));
}

/** 更新搜索栏计数与上一条/下一条按钮状态 */
function updateSearchUI(current, total, text) {
    var countEl = document.getElementById('ocSearchCount');
    var prevBtn = document.getElementById('ocSearchPrev');
    var nextBtn = document.getElementById('ocSearchNext');
    var label = text;
    if (label === undefined) label = total > 0 ? (current + '/' + total) : '';
    if (countEl) countEl.textContent = label;
    if (prevBtn) prevBtn.disabled = total <= 0;
    if (nextBtn) nextBtn.disabled = total <= 0;
}

/**
 * 折叠搜索导航临时展开的工具卡。
 * 与思考过程的临时展开一致：离开该结果后恢复折叠，不改变用户原本的展开状态。
 * @param {string} keepPartId 保留不折叠的 partId（当前导航目标所在的工具卡）
 */
function collapseTempExpandedTools(keepPartId) {
    var box = getActiveMessagesEl();
    var ids = Object.keys(searchState.tempExpandedTools);
    for (var i = 0; i < ids.length; i++) {
        var partId = ids[i];
        if (keepPartId && partId === keepPartId) continue;
        delete searchState.tempExpandedTools[partId];
        var el = box ? findCollapsiblePartElement(box, partId) : null;
        if (el && typeof el.__ocSetExpanded === 'function') {
            el.__ocSetExpanded(false);
        }
    }
}

/** 给单个搜索结果加上/移除 active 样式（DOM 高亮加 mark 类，折叠工具卡加整卡类） */
function setResultActive(item, active) {
    if (!item) return;
    if (item.mark) item.mark.classList.toggle('oc-search-active', active);
    if (item.anchor) item.anchor.classList.toggle('oc-search-data-active', active);
}

/** 移除当前结果列表里的全部 active 样式 */
function clearAllResultActive() {
    for (var i = 0; i < searchResults.length; i++) setResultActive(searchResults[i], false);
}

/**
 * 激活第 index 个搜索结果。
 * @param {number} index 结果索引
 * @param {HTMLElement} container 消息容器（用于滚动）
 * @param {boolean} scroll 是否滚动到该结果
 */
function activateResult(index, container, scroll) {
    var total = searchResults.length;
    if (!total) {
        searchIndex = -1;
        updateSearchUI(0, 0, '');
        return;
    }
    if (index < 0) index = 0;
    if (index >= total) index = total - 1;

    var item = searchResults[index];
    // 数据结果（折叠卡片）没有 mark：搜索命中在尚未构建的正文里，
    // 只高亮整卡用户看不到具体位置。先展开该卡让正文进入 DOM，
    // notifyToolBodyToggled 会重算结果；再把 active 定位到正文里的第一个匹配。
    if (!item.mark && item.anchor) {
        // 工具卡与思考过程的正文/标题类名不同，这里统一匹配两种
        var body = item.anchor.querySelector('.oc-tool-body, .oc-reasoning-body');
        var head = item.anchor.querySelector('.oc-tool-head, .oc-reasoning-head');
        if (body && head && body.dataset.toolBodyBuilt !== 'true') {
            var partId = item.anchor.dataset.partId || '';
            // 记录为搜索临时展开：导航离开或关闭搜索时折叠回原状
            if (partId) searchState.tempExpandedTools[partId] = true;
            // 强制展开：head.click() 是 toggle，store 里残留的展开状态会让它反而收起
            if (typeof item.anchor.__ocSetExpanded === 'function') {
                item.anchor.__ocSetExpanded(true);
            } else {
                head.click();
            }
            // 按命中字段定位到对应正文区域，避免总是跳到卡片里的第一个匹配
            var fieldSelector = item.field === 'input' ? '.oc-tool-input'
                : (item.field === 'output' ? '.oc-tool-output'
                    : (item.field === 'error' ? '.oc-tool-error'
                        : (item.field === 'text' ? '.oc-reasoning-body' : '')));
            var fieldEl = fieldSelector ? item.anchor.querySelector(fieldSelector) : null;
            var firstMark = (fieldEl && fieldEl.querySelector('.oc-search-highlight'))
                || item.anchor.querySelector('.oc-search-highlight');
            if (firstMark) {
                for (var f = 0; f < searchResults.length; f++) {
                    if (searchResults[f].mark === firstMark) {
                        activateResult(f, container, scroll);
                        return;
                    }
                }
            }
            // 展开后正文里没有对应 mark（字段内容与渲染文本不一致）：
            // 退回整卡高亮 + 滚动到卡片，保证结果仍可定位
        }
    }

    clearAllResultActive();
    setResultActive(item, true);
    searchIndex = index;
    searchState.activeKey = item.key || '';
    searchState.activeGlobalIndex = index;
    // 数据结果没有 mark，导航锚点用工具卡本身
    var target = item.mark || item.anchor;
    if (target) temporarilyRevealSearchResult(target);
    if (scroll && container && target) {
        // 展开工具卡/临时展开折叠区后布局可能刚变化：
        // 等一帧再按命中节点自身位置滚动，避免用旧布局算出的偏移。
        requestAnimationFrame(function () {
            scrollSearchResultIntoView(target, container);
        });
    }
    updateSearchUI(index + 1, total);
}

/**
 * 清除指定容器内的高亮 mark 并合并被切碎的文本节点。
 * 只处理传入容器，避免误清其他会话/其他视图的高亮。
 */
function clearHighlightsIn(root) {
    if (!root || !root.querySelectorAll) return;
    var marks = root.querySelectorAll('.oc-search-highlight');
    var parents = [];
    for (var i = marks.length - 1; i >= 0; i--) {
        var mark = marks[i];
        var parent = mark.parentNode;
        if (!parent) continue;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        if (parents.indexOf(parent) < 0) parents.push(parent);
    }
    // 合并相邻文本节点，恢复原始文本结构（否则下次搜索会看到大量碎片）
    for (var p = 0; p < parents.length; p++) {
        try { parents[p].normalize(); } catch (_) {}
    }
    // 数据索引命中的折叠工具卡没有 mark，单独清除整卡高亮
    var dataActive = root.querySelectorAll('.oc-search-data-active');
    for (var d = 0; d < dataActive.length; d++) {
        dataActive[d].classList.remove('oc-search-data-active');
    }
}

/**
 * 渲染后恢复 active 位置与计数。
 * 优先按 activeKey 找回同一处；key 找不到（原位置被删除/流式改写）时
 * 按旧全局索引钳位到邻近结果。
 *
 * 注意：这里只恢复高亮和计数，不滚动、不展开折叠区，
 * 避免覆盖渲染刚恢复的阅读位置或打断搜索平滑滚动。
 */
function restoreActive(box) {
    var total = searchResults.length;
    if (!total) {
        searchIndex = -1;
        updateSearchUI(0, 0, searchState.query ? '无匹配' : '');
        return;
    }
    var index = -1;
    if (searchState.activeKey) {
        for (var i = 0; i < total; i++) {
            if (searchResults[i].key === searchState.activeKey) {
                index = i;
                break;
            }
        }
    }
    if (index < 0 && searchState.activeGlobalIndex >= 0) {
        index = Math.min(searchState.activeGlobalIndex, total - 1);
    }
    if (index < 0) index = 0;
    clearAllResultActive();
    setResultActive(searchResults[index], true);
    searchIndex = index;
    searchState.activeKey = searchResults[index].key || '';
    searchState.activeGlobalIndex = index;
    updateSearchUI(index + 1, total);
}

/** 全量重算：容器内容整体变化后，旧 mark 全部失效，重建高亮、数据索引与 active */
function rebuildSearchResults(box, items) {
    clearHighlightsIn(box);
    searchResults = collectSearchResults(box, items, searchState.query);
    restoreActive(box);
}

/**
 * 执行搜索
 * 搜索来源分两类：
 *   1) DOM 中可见文本（标题、普通消息、已展开工具卡正文）
 *   2) 折叠工具卡的 part 数据（正文未建 DOM，按 state.input/output/error 索引）
 * @param {string} query - 搜索关键词，长度小于 2 时跳过
 */
export function doSearch(query) {
    restoreSearchTemporaryExpansion();
    var msgContainer = getActiveMessagesEl();
    if (msgContainer) clearHighlightsIn(msgContainer);
    searchResults = [];
    searchIndex = -1;
    searchState.query = '';
    searchState.sessionID = '';
    searchState.activeKey = '';
    searchState.activeGlobalIndex = -1;
    // 清空搜索状态后再折叠临时展开的工具卡，避免折叠触发旧搜索结果的同步
    collapseTempExpandedTools('');
    updateSearchUI(0, 0, '');
    if (!query || query.length < 2) return;
    if (!msgContainer) return;

    searchState.query = query;
    searchState.sessionID = (msgContainer.dataset && msgContainer.dataset.tab) || store.currentSessionId || '';
    var list = store.messageCache[searchState.sessionID] || [];
    searchResults = collectSearchResults(msgContainer, list, query);

    if (!searchResults.length) {
        updateSearchUI(0, 0, '无匹配');
        return;
    }
    // 与旧行为一致：执行搜索后直接定位到第一个结果
    activateResult(0, msgContainer, true);
}

/**
 * 渲染后同步搜索高亮。
 * 搜索状态是纯数据描述，不依赖旧 DOM 节点；任何渲染路径完成后调用这里，
 * 高亮、计数、active 位置都会恢复。
 *
 * @param {{kind?: string, box?: HTMLElement, nodes?: HTMLElement[], items?: Array,
 *          messageEl?: HTMLElement, messageId?: string}} scope
 *   kind: 'full' 全量重建 | 'appendMessages' 末尾追加消息 | 'message' 单条消息重建/追加片段
 *   items: 与本次渲染范围对应的消息数据，用于折叠工具卡的数据索引
 */
export function syncSearchAfterRender(scope) {
    if (!searchState.query) return;
    var box = (scope && scope.box) || getActiveMessagesEl();
    if (!box) return;
    var sid = (box.dataset && box.dataset.tab) || store.currentSessionId || '';
    // 只同步搜索所属会话：其他会话的后台渲染不动高亮
    if (searchState.sessionID && sid !== searchState.sessionID) return;

    // 旧 DOM 节点可能已随重建销毁，临时展开引用不能再复用
    searchTemporaryExpansion = null;

    var kind = (scope && scope.kind) || 'full';
    if (kind === 'appendMessages') {
        // 旧消息 DOM、高亮和数据结果都保留，只给末尾新增消息补结果
        var nodes = (scope && scope.nodes) || [];
        var added = [];
        for (var i = 0; i < nodes.length; i++) {
            added = added.concat(scanScope(nodes[i], searchState.query));
        }
        // 新增消息里的折叠工具卡按数据索引补充（完整正文不在 DOM）
        added = added.concat(scanCollapsedToolData(box, (scope && scope.items) || [], searchState.query));
        searchResults = sortSearchResults(searchResults.concat(added));
        restoreActive(box);
        return;
    }
    if (kind === 'message' && scope && (scope.messageEl || scope.messageId)) {
        // 单条消息被替换或追加片段：只重算该消息，其他消息的结果原样保留
        var msgEl = scope.messageEl;
        if (!msgEl && scope.messageId) {
            msgEl = box.querySelector('[data-message-id="' + CSS.escape(scope.messageId) + '"]');
        }
        if (msgEl) {
            var messageId = scope.messageId || (msgEl.dataset && msgEl.dataset.messageId) || '';
            // 先移除该消息的旧结果（旧 mark 已随 DOM 重建销毁）
            searchResults = searchResults.filter(function (r) {
                return r.messageId !== messageId;
            });
            clearHighlightsIn(msgEl);
            var msgResults = collectSearchResults(msgEl, (scope && scope.items) || [], searchState.query);
            searchResults = sortSearchResults(searchResults.concat(msgResults));
            restoreActive(box);
            return;
        }
    }
    // 全量：容器内容整体替换，旧高亮全部失效，重算整个容器
    rebuildSearchResults(box, (scope && scope.items) || store.messageCache[sid] || []);
}

/**
 * 工具卡展开/收起后重新索引该消息的搜索结果。
 * 展开时正文进入 DOM（scanScope 命中），收起时正文销毁（改用数据索引命中），
 * 两种状态都必须立刻重算，否则高亮和计数会与实际可见内容不一致。
 */
export function notifyToolBodyToggled(partId) {
    if (!searchState.query || !partId) return;
    var box = getActiveMessagesEl();
    if (!box) return;
    var toolEl = findCollapsiblePartElement(box, partId);
    if (!toolEl) return;
    var msgEl = toolEl.closest('.oc-message');
    if (!msgEl) return;
    var messageId = (msgEl.dataset && msgEl.dataset.messageId) || '';
    var list = store.messageCache[searchState.sessionID] || [];
    var items = [];
    for (var i = 0; i < list.length; i++) {
        var info = list[i] && (list[i].info || list[i]) || {};
        if (String(info.id || '') === messageId) {
            items = [list[i]];
            break;
        }
    }
    syncSearchAfterRender({
        kind: 'message',
        box: box,
        messageEl: msgEl,
        messageId: messageId,
        items: items,
    });
}

/** 判断当前是否有活动搜索（搜索栏有关键词）。
 *  搜索期间渲染层不应把会话重新判定为「贴底」：
 *  搜索结果可能在会话底部附近，一旦被判定贴底，流式追加会把视口拉到底，命中文字移出视口。 */
export function isSearchActive() {
    return !!searchState.query;
}

/** 判断是否应禁止滚动分页（供分页监听避免误判「用户上滑到顶」） */
export function isSearchNavActive(sessionID) {
    // 搜索期间一律禁用滚动分页：
    // 搜索结果导航的平滑滚动、工具卡展开/收起、高亮恢复都会改变滚动位置，
    // 这些都不是用户主动上滑。关闭搜索（query 清空）后恢复正常分页。
    var searching = !!searchState.query;
    if (!searching && Date.now() > searchNavUntil) return false;
    if (!sessionID) return true;
    if (!searchState.sessionID) return true;
    return sessionID === searchState.sessionID;
}

/** 判断搜索结果导航的滚动是否仍需保护。
 *  导航后的短保护期内，流式/全量渲染不能调用 restoreScrollAnchor 重写 scrollTop，
 *  否则会立即打断搜索的平滑滚动，把命中文字留在视口外。 */
export function isSearchScrollLocked(sessionID) {
    if (!searchState.query) return false;
    if (Date.now() > searchNavUntil) return false;
    if (!sessionID) return true;
    if (!searchState.sessionID) return true;
    return sessionID === searchState.sessionID;
}

/** 关闭标签：清理属于该会话的搜索结果，避免 searchResults 继续持有已移除容器的 DOM。 */
document.addEventListener('oc-tab-closed', function (e) {
    var sid = e && e.detail && e.detail.sessionID;
    if (!sid || !searchState.sessionID || searchState.sessionID !== sid) return;
    // 容器已被 tabs.js 移除，closeSearch 会清空 mark 引用与临时展开状态
    closeSearch();
});

/**
 * 切换会话后把搜索重新绑定到活动会话。
 * 搜索状态里的 activeKey / searchResults 属于旧会话容器，切走后不能继续导航：
 * 否则「下一条」会按旧节点坐标滚动新容器。搜索栏打开且有关键词时直接重搜新会话，
 * 容器尚未加载完成也没关系——加载后的全量渲染会通过 syncSearchAfterRender 再恢复一次。
 */
export function restartSearchForActiveSession() {
    var bar = document.getElementById('ocSearchBar');
    if (!bar || getComputedStyle(bar).display === 'none') return;
    var input = document.getElementById('ocSearchInput');
    var query = input ? input.value : '';
    if (!query || query.length < 2) return;
    doSearch(query);
}

/**
 * 导航到上一条/下一条搜索结果
 * @param {number} dir - 方向：1 为下一条，-1 为上一条
 */
export function navigateSearch(dir) {
    if (!searchResults.length) return;
    restoreSearchTemporaryExpansion();
    var count = searchResults.length;
    var next = (searchIndex + dir + count) % count;
    activateResult(next, getActiveMessagesEl(), true);
    // 与思考过程一致：导航离开后折叠上一个搜索临时展开的卡片。
    // 只保留当前结果所在的那一张，同一卡片的不同字段之间切换不会闪烁。
    // 用通用的 .oc-part：工具卡和思考过程的类名不同，不能只查 .oc-tool。
    var current = searchResults[searchIndex];
    var keepEl = current && (current.mark ? current.mark.closest('.oc-part') : current.anchor);
    collapseTempExpandedTools(keepEl ? (keepEl.dataset.partId || '') : '');
}

/** 将搜索结果滚动到可视区域的上三分之一处 */
export function scrollSearchResultIntoView(node, container) {
    // 搜索导航是显式阅读操作：先取消贴底。
    // 否则搜索平滑滚动期间若有新消息增量追加，renderMessages 会按旧的贴底状态
    // 把视口拉到底，导致用户看不到搜索结果。
    var sid = (container.dataset && container.dataset.tab) || store.currentSessionId || '';
    if (sid) store.tabStickBottom[sid] = false;
    // 平滑滚动期间设置保护期：滚动位置会经过接近顶部的位置，
    // 分页监听可能把动画中的瞬时位置误判为「用户上滑到顶」而加载 200 条历史。
    // 1.5 秒覆盖平滑滚动动画 + 流式渲染的若干帧，期间 renderMessages 不重写 scrollTop。
    searchNavUntil = Date.now() + 1500;
    var targetTop = getSearchAnchorTop(node, container);
    var targetScroll = targetTop - container.clientHeight / 3;
    var maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTo({
        top: Math.max(0, Math.min(maxScroll, targetScroll)),
        behavior: 'smooth'
    });
}

/** 计算搜索结果命中节点相对消息容器的内容偏移，用于精确滚动定位。
 *  必须用命中节点自身的位置：工具卡/思考卡展开后可能很长，
 *  用整个 part 的顶部会把具体命中滚出视口；同一卡片的多个结果也无法区分。 */
export function getSearchAnchorTop(node, container) {
    if (!node || !container || !node.getBoundingClientRect) return 0;
    var rect = node.getBoundingClientRect();
    var boxRect = container.getBoundingClientRect();
    // rect.top - boxRect.top 是节点相对容器视口顶部的偏移，
    // 加上当前 scrollTop 换算成容器内容坐标，供 scrollTo 使用。
    return rect.top - boxRect.top + container.scrollTop;
}

/** 临时展开搜索结果所在的折叠区域，让隐藏的搜索结果可见 */
export function temporarilyRevealSearchResult(node) {
    var hiddenAncestor = node.closest('.hidden');
    if (!hiddenAncestor) return;
    var targetPart = node.closest('.oc-part');
    hiddenAncestor.classList.remove('hidden');
    hiddenAncestor.classList.add('oc-search-temp-expanded');
    if (targetPart) targetPart.classList.add('oc-search-target-part');
    searchTemporaryExpansion = {
        body: hiddenAncestor,
        targetPart: targetPart,
    };
}

/** 恢复搜索时临时展开的区域，如果该区域没有保持展开的必要则重新折叠 */
export function restoreSearchTemporaryExpansion() {
    if (!searchTemporaryExpansion) return;
    var body = searchTemporaryExpansion.body;
    if (body && body.classList && body.classList.contains('oc-search-temp-expanded')) {
        if (!shouldKeepTemporaryExpansionVisible(body)) {
            body.classList.add('hidden');
        }
        body.classList.remove('oc-search-temp-expanded');
    }
    var targetPart = searchTemporaryExpansion.targetPart;
    if (targetPart && targetPart.classList) {
        targetPart.classList.remove('oc-search-target-part');
    }
    searchTemporaryExpansion = null;
}

/**
 * 判断一个 part 是否应该保持展开状态
 * 检查 expandedParts 中是否有对应的展开记录
 */
export function shouldKeepTemporaryExpansionVisible(body) {
    var key = body.dataset ? body.dataset.expandKey : '';
    if (!key) return false;
    if (Object.prototype.hasOwnProperty.call(store.expandedParts, key)) {
        return !!store.expandedParts[key];
    }
    return body.dataset.defaultExpanded === 'true';
}

/** 清除当前会话的高亮标记，恢复原始 DOM 结构 */
export function clearHighlights() {
    var box = getActiveMessagesEl();
    if (box) clearHighlightsIn(box);
    searchResults = [];
    searchIndex = -1;
}

/** 关闭搜索栏：恢复临时展开、清除高亮与搜索状态、隐藏搜索栏 */
export function closeSearch() {
    restoreSearchTemporaryExpansion();
    // 关闭搜索必须清掉所有会话容器里的高亮：
    // 后台 tab 也可能残留上一次搜索结果，切回时搜索栏已关闭不会再重搜。
    var pool = document.getElementById('ocMessagesPool');
    if (pool) {
        clearHighlightsIn(pool);
    } else {
        var box = getActiveMessagesEl();
        if (box) clearHighlightsIn(box);
    }
    searchResults = [];
    searchIndex = -1;
    // 清空查询状态：之后任何渲染都不再尝试恢复高亮
    searchState.query = '';
    searchState.sessionID = '';
    searchState.activeKey = '';
    searchState.activeGlobalIndex = -1;
    // 关闭搜索：折叠所有搜索期间临时展开的工具卡，恢复用户原本的折叠状态
    collapseTempExpandedTools('');
    searchNavUntil = 0;
    var bar = document.getElementById('ocSearchBar');
    if (bar) bar.style.display = 'none';
    var input = document.getElementById('ocSearchInput');
    if (input) input.value = '';
    updateSearchUI(0, 0, '');
}

// ============================================================
// 用户消息快速导航
// 在消息列表中快速跳转到各条用户输入卡片
// ============================================================

/** 用户消息导航：当前高亮的消息索引（-1 表示无高亮） */
var userNavIndex = -1;
/** 用户消息导航：高亮移除定时器句柄 */
var userNavHighlightTimer = null;
/** 用户消息导航：滚动检测防抖定时器 */
var userNavScrollTimer = null;
/** 用户消息导航：是否已经完成事件绑定，避免重复初始化 */
var userNavInited = false;

/**
 * 初始化用户消息导航按钮
 * 绑定 ▲ ▼ 按钮的点击事件，在页面加载后调用一次
 */
export function initUserNav() {
    if (userNavInited) return;
    var prevBtn = document.getElementById('btnUserNavPrev');
    var nextBtn = document.getElementById('btnUserNavNext');
    if (prevBtn) prevBtn.addEventListener('click', function() { navigateUserMessage(-1); });
    if (nextBtn) nextBtn.addEventListener('click', function() { navigateUserMessage(1); });

    // 监听消息区滚动（scroll 事件不冒泡，需用 capture 捕获子容器滚动），自动同步当前用户消息位置
    var msgPool = document.getElementById('ocMessagesPool');
    if (msgPool) msgPool.addEventListener('scroll', onUserNavScroll, true);
    userNavInited = true;
}

/**
 * 立即按当前视口位置同步用户导航索引。
 * 切换会话后调用：不能 reset 成 -1（updateUserNav 会把 -1 自动当成最后一条，
 * 显示 5/5），必须按实际滚动位置计算当前是第几条用户消息。
 */
export function syncUserNavToScroll() {
    var container = getActiveMessagesEl();
    if (!container) {
        updateUserNav();
        return;
    }

    var msgs = collectUserMessages();
    if (!msgs.length) {
        updateUserNav();
        return;
    }

    // 可视区域顶部与底部（相对于容器的 scrollTop）
    var viewTop = container.scrollTop;
    var viewBottom = viewTop + container.clientHeight;

    var closestIndex = -1;
    var closestDistance = Infinity;

    for (var i = 0; i < msgs.length; i++) {
        var msgTop = msgs[i].offsetTop;
        var msgBottom = msgTop + msgs[i].offsetHeight;

        // 优先选择在可视区域内且最接近顶部的消息
        if (msgBottom > viewTop && msgTop < viewBottom) {
            var dist = Math.abs(msgTop - viewTop);
            if (dist < closestDistance) {
                closestDistance = dist;
                closestIndex = i;
            }
        }
    }

    // 如果可视区域内没有用户消息，找距离可视区域最近的那条
    if (closestIndex < 0) {
        for (var j = 0; j < msgs.length; j++) {
            var msgTop2 = msgs[j].offsetTop;
            var dist2 = Math.abs(msgTop2 - viewTop);
            if (dist2 < closestDistance) {
                closestDistance = dist2;
                closestIndex = j;
            }
        }
    }

    if (closestIndex >= 0) userNavIndex = closestIndex;
    updateUserNav();
}

/**
 * 用户滚动时自动更新导航位置
 * 100ms 防抖后按当前视口同步索引
 */
export function onUserNavScroll() {
    if (userNavScrollTimer) clearTimeout(userNavScrollTimer);
    userNavScrollTimer = setTimeout(syncUserNavToScroll, 100);
}

/**
 * 收集当前 DOM 中所有用户消息卡片节点
 * @returns {HTMLElement[]}
 */
export function collectUserMessages() {
    var container = getActiveMessagesEl();
    if (!container) return [];
    return Array.from(container.querySelectorAll('.oc-message.user'));
}

/**
 * 导航到上一条/下一条用户消息
 * @param {number} dir - 方向：1=下一条，-1=上一条
 */
export function navigateUserMessage(dir) {
    var msgs = collectUserMessages();
    if (!msgs.length) return;

    // 计算新索引
    if (userNavIndex < 0) {
        // 当前无高亮，从第一条开始
        userNavIndex = dir > 0 ? 0 : msgs.length - 1;
    } else if (dir < 0 && userNavIndex === 0) {
        // 已到最早一条：触发加载更早消息（加载后由 updateUserNav 重新定位到原位置）
        document.dispatchEvent(new CustomEvent('oc-load-older'));
        return;
    } else {
        userNavIndex = Math.max(0, Math.min(msgs.length - 1, userNavIndex + dir));
    }

    // 清除旧高亮
    clearUserNavHighlight();

    // 高亮并滚动到目标消息
    var target = msgs[userNavIndex];
    target.classList.add('oc-user-highlight');

    // 滚动到可视区域中间偏上位置
    var container = getActiveMessagesEl();
    if (container) {
        var targetTop = target.offsetTop - container.offsetTop;
        var targetScroll = targetTop - container.clientHeight * 0.3;
        var maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
        container.scrollTo({
            top: Math.max(0, Math.min(maxScroll, targetScroll)),
            behavior: 'smooth'
        });
    }

    // 1.5 秒后自动清除高亮
    if (userNavHighlightTimer) clearTimeout(userNavHighlightTimer);
    userNavHighlightTimer = setTimeout(function() {
        if (target) target.classList.remove('oc-user-highlight');
        userNavHighlightTimer = null;
    }, 1500);

    updateUserNav();
}

/** 立即清除用户消息高亮和定时器 */
export function clearUserNavHighlight() {
    if (userNavHighlightTimer) {
        clearTimeout(userNavHighlightTimer);
        userNavHighlightTimer = null;
    }
    var prev = document.querySelector('.oc-message.user.oc-user-highlight');
    if (prev) prev.classList.remove('oc-user-highlight');
}

/**
 * 刷新用户导航按钮状态
 * 在消息渲染后调用，更新计数和按钮可用性，控制导航条显隐
 */
export function updateUserNav() {
    var navEl = document.getElementById('ocUserNav');
    var prevBtn = document.getElementById('btnUserNavPrev');
    var nextBtn = document.getElementById('btnUserNavNext');
    var countEl = document.getElementById('ocUserNavCount');
    if (!navEl || !prevBtn || !nextBtn || !countEl) return;

    var msgs = collectUserMessages();
    var total = msgs.length;

    if (total <= 1) {
        // 0 或 1 条用户消息，隐藏导航条
        navEl.classList.remove('visible');
        userNavIndex = -1;
        return;
    }

    navEl.classList.add('visible');

    // 首次加载（未高亮任何消息）：自动定位到最后一条用户消息
    // 打开会话后默认显示最新消息，导航从最后一条开始，按 ▲ 向上滚动
    if (userNavIndex < 0) {
        userNavIndex = total - 1;
    }

    // 边界钳位
    userNavIndex = Math.max(0, Math.min(total - 1, userNavIndex));

    // 更新计数显示（当前索引从 0 开始，显示时 +1）
    countEl.textContent = (userNavIndex + 1) + '/' + total;

    // 边界禁用按钮
    prevBtn.disabled = (userNavIndex <= 0);
    nextBtn.disabled = (userNavIndex >= total - 1);
}

/** 分页加载更早消息后，用户定位索引整体偏移（新加载的用户消息插入缓存头部） */
export function shiftUserNavIndex(offset) {
    if (!offset || userNavIndex < 0) return;
    userNavIndex += offset;
}

/**
 * 重置用户导航状态（切换会话、清空消息时调用）
 */
export function resetUserNav() {
    clearUserNavHighlight();
    userNavIndex = -1;
    updateUserNav();
}
