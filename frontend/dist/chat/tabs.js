// ============================================================
// chat-tabs.js — 多会话 Tab 页管理
// 依赖：core/state.js（openTabs, activeTabId, tabCacheVersion 等）、core/utils.js（escapeHtml, getTabMessagesEl, ensureTabMessagesEl）、
//       chat/mobile.js（isMobileTreeMode）、chat/render.js（updateScrollBottomButton, updateSendButton）、
//       chat/events.js（loadSessionStatuses）、chat/sidepanel.js（extractSubtaskSummaries, renderSubtaskPanel, loadDiff）、
//       chat/search.js（resetUserNav, updateUserNav）
//       filebrowser/browser.js（openFileBrowserModal）——尚未改造，保留全局守卫调用
// 解环说明：本文件不得 import chat/session.js。原 activateTabContainer 中 loadMessages() 调用
//           改为回调注入 tabActivationHandler，由 session.js 在模块加载时通过 setTabActivationHandler 注入。
// ============================================================

import { store } from '../core/state.js';
import { escapeHtml, getTabMessagesEl, ensureTabMessagesEl } from '../core/utils.js';
import { isMobileTreeMode } from './mobile.js';
import { updateScrollBottomButton, updateSendButton } from './render.js';
import { loadSessionStatuses } from './events.js';
import { extractSubtaskSummaries, renderSubtaskPanel, loadDiff } from './sidepanel.js';
import { resetUserNav, updateUserNav } from './search.js';
import { openFileBrowserModal } from '../filebrowser/browser.js';
import { updateTreeActiveSession } from '../core/utils.js';

/**
 * 会话激活时的加载回调（由 session.js 通过 setTabActivationHandler 注入）。
 * ESM 下为避免 tabs↔session 循环依赖，用回调注入替代直接函数调用。
 */
export let tabActivationHandler = null;

/** 注入会话激活加载回调 */
export function setTabActivationHandler(fn) {
    tabActivationHandler = fn;
}

/** 渲染 Tab 栏 DOM（移动端单会话模式不显示） */
export function renderTabsBar() {
    var bar = document.getElementById('ocTabsBar');
    if (!bar) return;
    // 移动端不显示 Tab 栏
    if (isMobileTreeMode()) {
        bar.innerHTML = '';
        bar.style.display = 'none';
        return;
    }
    bar.style.display = 'flex';
    if (!store.openTabs.length) {
        bar.innerHTML = '';
        return;
    }
    bar.innerHTML = store.openTabs.map(function(tab) {
        var active = tab.sessionID === store.activeTabId ? ' active' : '';
        return '<div class="oc-tab' + active + '" data-session-id="' + escapeHtml(tab.sessionID) + '">' +
            '<span class="oc-tab-title">' + escapeHtml(tab.title || tab.sessionID) + '</span>' +
            '<span class="oc-tab-close" data-close-id="' + escapeHtml(tab.sessionID) + '">✕</span>' +
        '</div>';
    }).join('');

    bar.querySelectorAll('.oc-tab').forEach(function(tab) {
        tab.addEventListener('click', function(e) {
            if (e.target.closest('.oc-tab-close')) return;
            var sid = tab.dataset.sessionId;
            if (sid && sid !== store.activeTabId) {
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
export function openSessionTab(sessionID, title) {
    if (!sessionID) return;
    // 移动端单会话：先关闭其他 Tab，只保留当前这一个
    if (isMobileTreeMode()) {
        store.openTabs.slice().forEach(function(t) {
            if (t.sessionID !== sessionID) {
                closeSessionTab(t.sessionID);
            }
        });
    }
    var existing = store.openTabs.find(function(t) { return t.sessionID === sessionID; });
    if (existing) {
        if (title) existing.title = title;
        switchTab(sessionID);
        return;
    }
    store.openTabs.push({ sessionID: sessionID, title: title || sessionID });
    store.tabCacheVersion[sessionID] = 0;
    store.tabRenderedVersion[sessionID] = 0;
    renderTabsBar();
}

/** 激活指定会话的消息容器：显示它、隐藏其他；容器不存在时创建并触发加载 */
export function activateTabContainer(sessionID) {
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
            if (tabActivationHandler) tabActivationHandler();
        }
    }
}

/** 切换活动 Tab（多容器方案）：纯 display 显隐，各容器内容已实时渲染，切换零成本 */
export function switchTab(sessionID) {
    if (!sessionID) return;
    store.activeTabId = sessionID;
    store.currentSessionId = sessionID;
    activateTabContainer(sessionID);
    // 同步项目树高亮（树节点与当前 tab 一致）
    updateTreeActiveSession();

    // 标题、目录路径更新
    var title = '';
    var tabInfo = store.openTabs.find(function(t) { return t.sessionID === sessionID; });
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
    store.expandedParts = store.tabExpandedParts[sessionID] || {};
    // 重置用户导航状态：userNavIndex 是全局单例，切 tab 后必须重新定位到新会话
    resetUserNav();
    updateUserNav();
    if (!isMobileTreeMode()) {
        extractSubtaskSummaries(sessionID);
        renderSubtaskPanel();
        loadDiff();
    }
    loadSessionStatuses().then(function(statuses) {
        if (sessionID === store.currentSessionId) {
            // 只更新目标会话的状态（快照权威），其它会话的 key 保留本地值
            // （SSE 增量更新），避免整体替换抹掉其它 tab 刚写入的 busy 状态
            if (statuses && typeof statuses === 'object' && statuses[sessionID] !== undefined) {
                store.sessionStatuses[sessionID] = statuses[sessionID];
            }
            updateSendButton();
        }
    });
    updateScrollBottomButton();
}

/** 关闭会话 Tab：销毁容器（释放 DOM + 缓存） */
export function closeSessionTab(sessionID) {
    if (!sessionID) return;
    store.openTabs = store.openTabs.filter(function(t) { return t.sessionID !== sessionID; });

    // 销毁容器，释放 DOM
    var el = getTabMessagesEl(sessionID);
    if (el && el.parentNode) el.parentNode.removeChild(el);

    // 释放缓存与快照
    delete store.messageCache[sessionID];
    delete store.tabCacheVersion[sessionID];
    delete store.tabRenderedVersion[sessionID];
    delete store.tabScrollPositions[sessionID];
    delete store.tabExpandedParts[sessionID];

    if (store.activeTabId === sessionID) {
        var next = store.openTabs[store.openTabs.length - 1];
        store.activeTabId = '';
        store.currentSessionId = '';
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
