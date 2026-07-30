// ============================================================
// OpenCode 管理中心 - 消息搜索
// Ctrl+F 在当前会话中搜索消息内容
// ============================================================

/** 搜索结果中高亮标记的 DOM 元素数组 */
var searchResults = [];
/** 当前聚焦的搜索结果在数组中的索引 */
var searchIndex = -1;
/** 搜索时临时展开的隐藏 part，用于在折叠区域中定位搜索结果 */
let searchTemporaryExpansion = null;

/**
 * 初始化搜索功能
 * - 绑定 Ctrl+F 打开搜索栏
 * - 绑定 Escape 关闭搜索
 * - 绑定输入框的输入事件（200ms 防抖执行搜索）
 * - 绑定关闭、上一条、下一条按钮
 */
function initSearch() {
    document.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.key === 'f') {
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
 * 执行搜索
 * 遍历消息容器中的所有文本节点，用 <mark> 标签包裹匹配文本
 * @param {string} query - 搜索关键词，长度小于 2 时跳过
 */
function doSearch(query) {
    restoreSearchTemporaryExpansion();
    clearHighlights();
    searchResults = [];
    searchIndex = -1;
    var countEl = document.getElementById('ocSearchCount');
    var prevBtn = document.getElementById('ocSearchPrev');
    var nextBtn = document.getElementById('ocSearchNext');
    if (countEl) countEl.textContent = '';
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    if (!query || query.length < 2) return;

    var msgContainer = document.getElementById('ocMessages');
    if (!msgContainer) return;

    var walker = document.createTreeWalker(msgContainer, NodeFilter.SHOW_TEXT, null, false);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    var lowerQuery = query.toLowerCase();
    for (var n = 0; n < nodes.length; n++) {
        var text = nodes[n].textContent.toLowerCase();
        var idx = text.indexOf(lowerQuery);
        if (idx >= 0) {
            var parent = nodes[n].parentElement;
            if (parent) {
                try {
                    var range = document.createRange();
                    range.setStart(nodes[n], idx);
                    range.setEnd(nodes[n], idx + query.length);
                    var mark = document.createElement('mark');
                    mark.className = 'oc-search-highlight';
                    range.surroundContents(mark);
                    searchResults.push(mark);
                } catch (_) {}
            }
        }
    }

    if (searchResults.length > 0) {
        if (countEl) countEl.textContent = '1/' + searchResults.length;
        if (prevBtn) prevBtn.disabled = false;
        if (nextBtn) nextBtn.disabled = false;
        navigateSearch(1);
    } else {
        if (countEl) countEl.textContent = '无匹配';
    }
}

/**
 * 导航到上一条/下一条搜索结果
 * @param {number} dir - 方向：1 为下一条，-1 为上一条
 */
function navigateSearch(dir) {
    for (var i = 0; i < searchResults.length; i++) {
        searchResults[i].classList.remove('oc-search-active');
    }
    restoreSearchTemporaryExpansion();
    searchIndex = (searchIndex + dir + searchResults.length) % searchResults.length;
    var current = searchResults[searchIndex];
    current.classList.add('oc-search-active');
    temporarilyRevealSearchResult(current);
    var container = document.getElementById('ocMessages');
    if (container) {
        scrollSearchResultIntoView(current, container);
    }
    var countEl = document.getElementById('ocSearchCount');
    if (countEl) countEl.textContent = (searchIndex + 1) + '/' + searchResults.length;
}

/** 将搜索结果滚动到可视区域的上三分之一处 */
function scrollSearchResultIntoView(node, container) {
    var targetTop = getSearchAnchorTop(node, container);
    var targetScroll = targetTop - container.clientHeight / 3;
    var maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTo({
        top: Math.max(0, Math.min(maxScroll, targetScroll)),
        behavior: 'smooth'
    });
}

/** 计算搜索结果相对于消息容器的偏移高度，用于精确滚动定位 */
function getSearchAnchorTop(node, container) {
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
function temporarilyRevealSearchResult(node) {
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
function restoreSearchTemporaryExpansion() {
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
function shouldKeepTemporaryExpansionVisible(body) {
    var key = body.dataset ? body.dataset.expandKey : '';
    if (!key) return false;
    if (Object.prototype.hasOwnProperty.call(expandedParts, key)) {
        return !!expandedParts[key];
    }
    return body.dataset.defaultExpanded === 'true';
}

/** 清除所有搜索结果的高亮标记，恢复原始 DOM 结构 */
function clearHighlights() {
    var marks = document.querySelectorAll('.oc-search-highlight');
    for (var m = marks.length - 1; m >= 0; m--) {
        var parent = marks[m].parentNode;
        while (marks[m].firstChild) parent.insertBefore(marks[m].firstChild, marks[m]);
        parent.removeChild(marks[m]);
    }
}

/** 关闭搜索栏：恢复临时展开、清除高亮、隐藏搜索栏 */
function closeSearch() {
    restoreSearchTemporaryExpansion();
    clearHighlights();
    var bar = document.getElementById('ocSearchBar');
    if (bar) bar.style.display = 'none';
    var input = document.getElementById('ocSearchInput');
    if (input) input.value = '';
    searchResults = [];
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
function initUserNav() {
    if (userNavInited) return;
    var prevBtn = document.getElementById('btnUserNavPrev');
    var nextBtn = document.getElementById('btnUserNavNext');
    if (prevBtn) prevBtn.addEventListener('click', function() { navigateUserMessage(-1); });
    if (nextBtn) nextBtn.addEventListener('click', function() { navigateUserMessage(1); });

    // 监听消息区滚动，自动同步当前用户消息位置
    var msgBox = document.getElementById('ocMessages');
    if (msgBox) msgBox.addEventListener('scroll', onUserNavScroll);
    userNavInited = true;
}

/**
 * 用户滚动时自动更新导航位置
 * 100ms 防抖，检测当前可视区域内最接近顶部的用户消息
 */
function onUserNavScroll() {
    if (userNavScrollTimer) clearTimeout(userNavScrollTimer);
    userNavScrollTimer = setTimeout(function() {
        var container = document.getElementById('ocMessages');
        if (!container) return;

        var msgs = collectUserMessages();
        if (msgs.length <= 1) return;

        // 可视区域顶部（相对于容器的 scrollTop）
        var viewTop = container.scrollTop;
        // 可视区域底部
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

        if (closestIndex >= 0 && closestIndex !== userNavIndex) {
            userNavIndex = closestIndex;
            updateUserNav();
        }
    }, 100);
}

/**
 * 收集当前 DOM 中所有用户消息卡片节点
 * @returns {HTMLElement[]}
 */
function collectUserMessages() {
    var container = document.getElementById('ocMessages');
    if (!container) return [];
    return Array.from(container.querySelectorAll('.oc-message.user'));
}

/**
 * 导航到上一条/下一条用户消息
 * @param {number} dir - 方向：1=下一条，-1=上一条
 */
function navigateUserMessage(dir) {
    var msgs = collectUserMessages();
    if (!msgs.length) return;

    // 计算新索引
    if (userNavIndex < 0) {
        // 当前无高亮，从第一条开始
        userNavIndex = dir > 0 ? 0 : msgs.length - 1;
    } else {
        userNavIndex = Math.max(0, Math.min(msgs.length - 1, userNavIndex + dir));
    }

    // 清除旧高亮
    clearUserNavHighlight();

    // 高亮并滚动到目标消息
    var target = msgs[userNavIndex];
    target.classList.add('oc-user-highlight');

    // 滚动到可视区域中间偏上位置
    var container = document.getElementById('ocMessages');
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
function clearUserNavHighlight() {
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
function updateUserNav() {
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

/**
 * 重置用户导航状态（切换会话、清空消息时调用）
 */
function resetUserNav() {
    clearUserNavHighlight();
    userNavIndex = -1;
    updateUserNav();
}
