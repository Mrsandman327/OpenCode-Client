// ============================================================
// OpenCode 管理中心 - 消息搜索
// Ctrl+F 在当前会话中搜索消息内容
// 依赖：core/state.js（expandedParts）、core/utils.js（getActiveMessagesEl）
// ============================================================

import { store } from '../core/state.js';
import { getActiveMessagesEl } from '../core/utils.js';

/** 搜索状态：保存可长期复用的纯数据描述，不长期持有旧 DOM 节点。
 *  query/sessionID 标识当前搜索；activeKey 是命中位置的纯数据键
 *  （搜索作用域 + 该作用域内第几个匹配），DOM 重建后据此找回同一处；
 *  activeGlobalIndex 是 key 失效（原位置被删除/流式改写）时的钳位兜底。 */
var searchState = {
    query: '',
    sessionID: '',
    activeKey: '',
    activeGlobalIndex: -1,
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
        var base = counters[scopeKey] || 0;
        var made = new Array(matches.length);
        for (var m = matches.length - 1; m >= 0; m--) {
            try {
                var range = document.createRange();
                range.setStart(node, matches[m]);
                range.setEnd(node, matches[m] + lowerQuery.length);
                var mark = document.createElement('mark');
                mark.className = 'oc-search-highlight';
                mark.dataset.searchKey = scopeKey + '#' + (base + m);
                range.surroundContents(mark);
                made[m] = mark;
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
    for (var i = 0; i < total; i++) {
        searchResults[i].classList.remove('oc-search-active');
    }
    var node = searchResults[index];
    node.classList.add('oc-search-active');
    searchIndex = index;
    searchState.activeKey = node.dataset.searchKey || '';
    searchState.activeGlobalIndex = index;
    temporarilyRevealSearchResult(node);
    if (scroll && container) scrollSearchResultIntoView(node, container);
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
            if (searchResults[i].dataset.searchKey === searchState.activeKey) {
                index = i;
                break;
            }
        }
    }
    if (index < 0 && searchState.activeGlobalIndex >= 0) {
        index = Math.min(searchState.activeGlobalIndex, total - 1);
    }
    if (index < 0) index = 0;
    for (var j = 0; j < total; j++) {
        searchResults[j].classList.remove('oc-search-active');
    }
    searchResults[index].classList.add('oc-search-active');
    searchIndex = index;
    searchState.activeKey = searchResults[index].dataset.searchKey || '';
    searchState.activeGlobalIndex = index;
    updateSearchUI(index + 1, total);
}

/** 全量重扫：容器内容整体变化后，旧 mark 全部失效，重建高亮与 active */
function rebuildSearchResults(box) {
    clearHighlightsIn(box);
    searchResults = scanScope(box, searchState.query);
    restoreActive(box);
}

/**
 * 执行搜索
 * 遍历消息容器中的所有文本节点，用 <mark> 标签包裹匹配文本
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
    updateSearchUI(0, 0, '');
    if (!query || query.length < 2) return;
    if (!msgContainer) return;

    searchState.query = query;
    searchState.sessionID = (msgContainer.dataset && msgContainer.dataset.tab) || store.currentSessionId || '';
    searchResults = scanScope(msgContainer, query);

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
 * @param {{kind?: string, box?: HTMLElement, nodes?: HTMLElement[], messageEl?: HTMLElement, messageId?: string}} scope
 *   kind: 'full' 全量重建 | 'appendMessages' 末尾追加消息 | 'message' 单条消息重建/追加片段
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
        // 旧消息 DOM 和高亮都保留，只给末尾新增消息补高亮
        var nodes = (scope && scope.nodes) || [];
        for (var i = 0; i < nodes.length; i++) scanScope(nodes[i], searchState.query);
        searchResults = Array.prototype.slice.call(box.querySelectorAll('.oc-search-highlight'));
        restoreActive(box);
        return;
    }
    if (kind === 'message' && scope && (scope.messageEl || scope.messageId)) {
        // 单条消息被替换或追加片段：只重扫该消息，其他消息的高亮原样保留
        var msgEl = scope.messageEl;
        if (!msgEl && scope.messageId) {
            msgEl = box.querySelector('[data-message-id="' + CSS.escape(scope.messageId) + '"]');
        }
        if (msgEl) {
            clearHighlightsIn(msgEl);
            scanScope(msgEl, searchState.query);
            searchResults = Array.prototype.slice.call(box.querySelectorAll('.oc-search-highlight'));
            restoreActive(box);
            return;
        }
    }
    // 全量：容器内容整体替换，旧高亮全部失效，重扫整个容器
    rebuildSearchResults(box);
}

/** 判断是否处于搜索导航的平滑滚动保护期（供分页监听避免误判「到顶」） */
export function isSearchNavActive(sessionID) {
    if (Date.now() > searchNavUntil) return false;
    if (!sessionID) return true;
    if (!searchState.sessionID) return true;
    return sessionID === searchState.sessionID;
}

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
    searchNavUntil = Date.now() + 800;
    var targetTop = getSearchAnchorTop(node, container);
    var targetScroll = targetTop - container.clientHeight / 3;
    var maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTo({
        top: Math.max(0, Math.min(maxScroll, targetScroll)),
        behavior: 'smooth'
    });
}

/** 计算搜索结果相对于消息容器的偏移高度，用于精确滚动定位 */
export function getSearchAnchorTop(node, container) {
    var anchor = node.closest('.oc-part') || node.closest('.oc-message') || node;
    var top = 0;
    var el = anchor;
    while (el && el !== container) {
        top += el.offsetTop || 0;
        el = el.offsetParent;
    }
    if (el === container) return top;
    return anchor.offsetTop || 0;
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
    // 关闭搜索后立即解除分页保护，不残留 800ms 的禁用窗口
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
