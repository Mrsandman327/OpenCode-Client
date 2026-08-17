// ============================================================
// chat-tabs.js — 多会话 Tab 页管理
// 依赖：core/state.js（openTabs, activeTabId, tabCacheVersion 等）、
//       chat/render.js（buildMessageNode, renderMessages）、
//       chat/cache.js（getCachedMessages）、chat/session.js（selectSession）
// ============================================================

/** 渲染 Tab 栏 DOM（移动端单会话模式不显示） */
function renderTabsBar() {
    var bar = document.getElementById('ocTabsBar');
    if (!bar) return;
    // 移动端不显示 Tab 栏
    if (typeof isMobileTreeMode === 'function' && isMobileTreeMode()) {
        bar.innerHTML = '';
        bar.style.display = 'none';
        return;
    }
    bar.style.display = 'flex';
    if (!openTabs.length) {
        bar.innerHTML = '';
        return;
    }
    bar.innerHTML = openTabs.map(function(tab) {
        var active = tab.sessionID === activeTabId ? ' active' : '';
        return '<div class="oc-tab' + active + '" data-session-id="' + escapeHtml(tab.sessionID) + '">' +
            '<span class="oc-tab-title">' + escapeHtml(tab.title || tab.sessionID) + '</span>' +
            '<span class="oc-tab-close" data-close-id="' + escapeHtml(tab.sessionID) + '">✕</span>' +
        '</div>';
    }).join('');

    bar.querySelectorAll('.oc-tab').forEach(function(tab) {
        tab.addEventListener('click', function(e) {
            if (e.target.closest('.oc-tab-close')) return;
            var sid = tab.dataset.sessionId;
            if (sid && sid !== activeTabId) {
                switchTab(sid);
            }
        });
    });
    bar.querySelectorAll('.oc-tab-close').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            closeSessionTab(btn.dataset.closeId || '');
        });
    });
}

/** 打开会话 Tab（已存在则切换并更新标题；首次打开只注册，加载交给 selectSession 原流程）
 *  移动端（isMobileTreeMode）单会话模式：打开新会话前关闭其他所有 Tab */
function openSessionTab(sessionID, title) {
    if (!sessionID) return;
    // 移动端单会话：先关闭其他 Tab，只保留当前这一个
    if (typeof isMobileTreeMode === 'function' && isMobileTreeMode()) {
        openTabs.slice().forEach(function(t) {
            if (t.sessionID !== sessionID && typeof closeSessionTab === 'function') {
                closeSessionTab(t.sessionID);
            }
        });
    }
    var existing = openTabs.find(function(t) { return t.sessionID === sessionID; });
    if (existing) {
        if (title) existing.title = title;
        switchTab(sessionID);
        return;
    }
    openTabs.push({ sessionID: sessionID, title: title || sessionID });
    tabCacheVersion[sessionID] = 0;
    tabRenderedVersion[sessionID] = 0;
    renderTabsBar();
}

/** 激活指定会话的消息容器：显示它、隐藏其他；容器不存在时创建并触发加载 */
function activateTabContainer(sessionID) {
    var pool = document.getElementById('ocMessagesPool');
    if (!pool) return;
    // 清除新建会话占位提示（切回已打开 tab 时不应再残留）
    var ph = pool.querySelector('.oc-new-session-placeholder');
    if (ph && ph.parentNode) ph.parentNode.removeChild(ph);
    var all = pool.querySelectorAll('.oc-messages-tab');
    for (var i = 0; i < all.length; i++) {
        var isActive = all[i].dataset.tab === sessionID;
        all[i].classList.toggle('active', isActive);
        all[i].style.display = isActive ? 'flex' : 'none';
    }
    // 目标容器不存在时创建并触发加载
    if (!getTabMessagesEl(sessionID)) {
        var el = ensureTabMessagesEl(sessionID);
        if (el) {
            el.classList.add('active');
            el.style.display = 'flex';
            el.innerHTML = '<div class="oc-empty">正在加载会话消息...</div>';
            if (typeof loadMessages === 'function') loadMessages();
        }
    }
}

/** 切换活动 Tab（多容器方案）：纯 display 显隐，各容器内容已实时渲染，切换零成本 */
function switchTab(sessionID) {
    if (!sessionID) return;
    activeTabId = sessionID;
    currentSessionId = sessionID;
    activateTabContainer(sessionID);

    // 标题、目录路径更新
    var title = '';
    var tabInfo = openTabs.find(function(t) { return t.sessionID === sessionID; });
    if (tabInfo) title = tabInfo.title;
    var info = window._sessionMap && window._sessionMap[sessionID];
    if (!title && info) title = info.title;
    if (title) document.getElementById('ocChatTitle').textContent = title;

    var dirEl = document.getElementById('ocSideDirPath');
    if (dirEl) {
        var dirPath = (info && info.directory) || '';
        dirEl.textContent = dirPath || sessionID;
        dirEl.title = dirPath || '';
        dirEl.onclick = function() {
            if (dirPath) openFileBrowserModal(dirPath, { features: ['git'] });
        };
    }

    renderTabsBar();

    // 恢复该 tab 的展开状态，刷新侧栏与状态
    expandedParts = tabExpandedParts[sessionID] || {};
    // 重置用户导航状态：userNavIndex 是全局单例，切 tab 后必须重新定位到新会话
    if (typeof resetUserNav === 'function') resetUserNav();
    updateUserNav();
    if (!isMobileTreeMode()) {
        extractSubtaskSummaries(sessionID);
        renderSubtaskPanel();
        loadDiff();
    }
    loadSessionStatuses().then(function(statuses) {
        if (sessionID === currentSessionId) {
            sessionStatuses = statuses || sessionStatuses;
            updateSendButton();
        }
    });
    updateScrollBottomButton();
}

/** 关闭会话 Tab：销毁容器（释放 DOM + 缓存） */
function closeSessionTab(sessionID) {
    if (!sessionID) return;
    openTabs = openTabs.filter(function(t) { return t.sessionID !== sessionID; });

    // 销毁容器，释放 DOM
    var el = getTabMessagesEl(sessionID);
    if (el && el.parentNode) el.parentNode.removeChild(el);

    // 释放缓存与快照
    delete messageCache[sessionID];
    delete tabCacheVersion[sessionID];
    delete tabRenderedVersion[sessionID];
    delete tabScrollPositions[sessionID];
    delete tabExpandedParts[sessionID];

    if (activeTabId === sessionID) {
        var next = openTabs[openTabs.length - 1];
        activeTabId = '';
        currentSessionId = '';
        if (next) {
            switchTab(next.sessionID);
        } else {
            document.getElementById('ocChatTitle').textContent = '未选择会话';
            var pool = document.getElementById('ocMessagesPool');
            if (pool) {
                pool.querySelectorAll('.oc-messages-tab').forEach(function(c) { c.remove(); });
                pool.innerHTML = '<div class="oc-empty">选择会话后查看消息，或输入内容创建新会话</div>';
            }
        }
    }
    renderTabsBar();
}
