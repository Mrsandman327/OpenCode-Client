// ============================================================
// chat-session.js — 会话管理与消息收发
// 负责会话选择/创建/加载、Agent/Model 选择器、附件管理、消息发送、轮询与中止
// 依赖：core/state.js、core/utils.js（showToast, escapeHtml, getActiveMessagesEl, ensureTabMessagesEl, getCachedMessages）、
//       core/apicall.js（api）、chat/mobile.js（isMobileTreeMode）、chat/tabs.js（openSessionTab, renderTabsBar, setTabActivationHandler）、
//       chat/sidepanel.js（extractSubtaskSummaries, renderSubtaskPanel）、chat/events.js（loadSessionStatuses）、
//       chat/render.js（isSessionBusy, smartScroll, updateSendButton, renderMessages）、chat/tree.js（rememberKnownDir）、
//       chat/search.js（resetUserNav）、chat/cache.js（cacheMessages, ensurePendingAssistant, renderPendingAssistantPlaceholder, renderCachedMessages）
//       filebrowser/browser.js（openFileBrowserModal）——尚未改造，保留全局守卫调用
// 解环说明：updateSendButton 已移入 chat/render.js；pendingWorkDir 已移入 core/state.js 的 store；
//           通过 setTabActivationHandler 向 tabs.js 注入会话激活加载回调，避免 tabs↔session 循环依赖。
// ============================================================

import { api } from '../core/apicall.js';
import { store } from '../core/state.js';
import { showToast, escapeHtml, getActiveMessagesEl, ensureTabMessagesEl, getCachedMessages, updateTreeActiveSession } from '../core/utils.js';
import { isMobileTreeMode } from './mobile.js';
import { openSessionTab, renderTabsBar, setTabActivationHandler } from './tabs.js';
import { extractSubtaskSummaries, renderSubtaskPanel } from './sidepanel.js';
import { loadSessionStatuses } from './events.js';
import { isSessionBusy, smartScroll, updateSendButton, renderMessages } from './render.js';
import { rememberKnownDir } from './tree.js';
import { resetUserNav, updateUserNav, shiftUserNavIndex } from './search.js';
import { cacheMessages, ensurePendingAssistant, renderPendingAssistantPlaceholder, renderCachedMessages, cacheLocalUserMessage, removeLocalUserMessage, prependMessages } from './cache.js';
import { openFileBrowserModal } from '../filebrowser/browser.js';

// ============================
// 全局 Agent/Model 选择器
// ============================

/** 加载 Agent/Model 下拉选择器（从 API 获取可用列表） */
export async function loadAgentModelSelectors() {
    if (store.agentModelSelectorsLoaded) return;
    try {
        const [agents, models] = await Promise.all([
            api.OpenCodeCall('GET', '/agent').catch(() => []),
            api.OpenCodeCall('GET', '/provider').catch(() => []),
        ]);
        store.agentList = agents || [];
        store.modelList = models || [];
    } catch (_) {
        store.agentList = [];
        store.modelList = [];
    }

    const agentSel = document.getElementById('ocAgentSelect');
    const modelSel = document.getElementById('ocModelSelect');
    if (!agentSel || !modelSel) return;

    // 填充 agent 下拉框
    agentSel.innerHTML = '<option value="">默认</option>';
    store.agentList.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.name;
        opt.textContent = a.name;
        if (a.description) opt.title = a.description;
        agentSel.appendChild(opt);
    });
    agentSel.value = store.selectedAgent;

    // 填充 model 下拉框
    modelSel.innerHTML = '<option value="">默认</option>';
    store.modelList.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        modelSel.appendChild(opt);
    });
    modelSel.value = store.selectedModel;

    // change 事件（带绑定守卫：启停多次只绑一次，避免重复监听）
    if (!agentSel.dataset.modelBound) {
        agentSel.dataset.modelBound = '1';
        agentSel.addEventListener('change', () => {
            store.selectedAgent = agentSel.value;
        });
    }
    if (!modelSel.dataset.modelBound) {
        modelSel.dataset.modelBound = '1';
        modelSel.addEventListener('change', () => {
            store.selectedModel = modelSel.value;
        });
    }

    // Variant 选择器
    const variantSel = document.getElementById('ocVariantSelect');
    if (variantSel) {
        variantSel.value = store.selectedVariant;
        if (!variantSel.dataset.modelBound) {
            variantSel.dataset.modelBound = '1';
            variantSel.addEventListener('change', () => {
                store.selectedVariant = variantSel.value;
            });
        }
    }

    store.agentModelSelectorsLoaded = true;
}

let currentSessionRefreshPending = false;

/** 从 OpenCode API 获取当前会话的最新标题，更新标题栏、_sessionMap 和项目树节点 */
export async function refreshSessionTitle() {
    if (!store.currentSessionId) return;
    try {
        const data = await api.OpenCodeCall('GET', `/session/${encodeURIComponent(store.currentSessionId)}`);
        const title = data?.title || data?.Title;
        // 标题尚未生成（OpenCode 异步生成，晚于 idle 事件）：直接返回，
        // 由 scheduleSessionTitleRefresh 的轮询持续驱动，避免 tab 页 / 项目树停留在占位名
        if (!title) return;
        // 从 _sessionMap 读取旧标题（可能因时序问题尚未存在）
        const oldTitle = window._sessionMap?.[store.currentSessionId]?.title;
        if (oldTitle === title) return;
        // 确保 _sessionMap 存在并更新
        if (!window._sessionMap) window._sessionMap = {};
        if (!window._sessionMap[store.currentSessionId]) window._sessionMap[store.currentSessionId] = {};
        window._sessionMap[store.currentSessionId].title = title;
        // 更新会话区标题栏
        document.getElementById('ocChatTitle').textContent = title;
        // 同步 Tab 标题
        if (store.openTabs && Array.isArray(store.openTabs)) {
            var tab = store.openTabs.find(function(t) { return t.sessionID === store.currentSessionId; });
            if (tab) {
                tab.title = title;
                renderTabsBar();
            }
        }
        // 更新项目树中的会话节点
        const escapedId = store.currentSessionId.replace(/[&<>"']/g, function(m) {
            return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m];
        });
        const treeNode = document.querySelector('.oc-tree-session[data-session-id="' + escapedId + '"]');
        if (treeNode) {
            // 注意：标题图标已由 renderTree 渲染为独立的 .oc-tree-session-icon 元素，
            // 这里只更新 label 文本（不再加 💬 前缀，否则与图标重复）
            const label = treeNode.querySelector('.oc-tree-label');
            if (label) {
                label.textContent = title;
            }
            const tooltipTitle = treeNode.querySelector('.oc-tree-tooltip-title');
            if (tooltipTitle) tooltipTitle.textContent = title;
        }
    } catch (_) {}
}

/**
 * 新会话标题由 OpenCode 异步生成：主动轮询更新（兜底 idle 事件/现有轮询未触发的情况）。
 * 标题刷新轮询的唯一驱动——refreshSessionTitle 内部不再自带重试。
 */
let titlePollTimer = null;
let titlePollCount = 0;
const TITLE_POLL_MAX = 20;
const TITLE_POLL_INTERVAL = 1000;
function scheduleSessionTitleRefresh(sessionID) {
    if (!sessionID) return;
    titlePollCount = 0;
    if (titlePollTimer) clearInterval(titlePollTimer);
    titlePollTimer = setInterval(function() {
        // 已切换会话：旧轮询立即停止
        if (sessionID !== store.currentSessionId) {
            clearInterval(titlePollTimer);
            titlePollTimer = null;
            return;
        }
        // 标题已从占位值更新为真实标题：停止轮询，避免空转浪费请求
        const mappedTitle = window._sessionMap?.[sessionID]?.title;
        if (mappedTitle && mappedTitle !== sessionID) {
            clearInterval(titlePollTimer);
            titlePollTimer = null;
            return;
        }
        titlePollCount++;
        if (titlePollCount > TITLE_POLL_MAX) {
            clearInterval(titlePollTimer);
            titlePollTimer = null;
            return;
        }
        refreshSessionTitle();
    }, TITLE_POLL_INTERVAL);
}

/**
 * 刷新当前会话视图。
 * 与切换会话后的加载流程类似，但保留当前会话的局部阅读状态，
 * 不清空展开状态、不清空 question 自定义输入，也不切换会话本身。
 */
export async function refreshCurrentSession() {
    if (!store.webRunning) return;
    if (!store.currentSessionId) {
        showToast('当前没有可刷新的会话', 'info');
        return;
    }
    if (currentSessionRefreshPending) return;

    const refreshBtn = document.getElementById('btnRefreshCurrentSession');
    const box = getActiveMessagesEl();
    const refreshSessionId = store.currentSessionId;

    currentSessionRefreshPending = true;
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '⏳';
        refreshBtn.title = '正在刷新当前会话';
    }

    store.markdownCache = {};
    store.lastMessageCount = 0;
    store.messageLoadSeq++;
    if (box) {
        box.innerHTML = '<div class="oc-empty">正在刷新会话消息...</div>';
    }

    try {
        await loadMessages();
        if (refreshSessionId !== store.currentSessionId) return;

        if (!isMobileTreeMode()) {
            extractSubtaskSummaries(store.currentSessionId);
            renderSubtaskPanel();
        }

        try {
            const statuses = await loadSessionStatuses();
            if (refreshSessionId === store.currentSessionId && statuses) {
                // 只更新目标会话的状态（快照权威），其它会话 key 保留本地值
                if (statuses[refreshSessionId] !== undefined) {
                    store.sessionStatuses[refreshSessionId] = statuses[refreshSessionId];
                }
            }
        } catch (_) {}

        if (refreshSessionId !== store.currentSessionId) return;

        updateSendButton();
        if (isSessionBusy(store.currentSessionId)) {
            scheduleRefresh();
        }
        smartScroll(getActiveMessagesEl(), true);
        showToast('已刷新当前会话', 'success');
    } catch (e) {
        if (refreshSessionId === store.currentSessionId) {
            showToast('刷新当前会话失败: ' + (e.message || e), 'error');
        }
    } finally {
        currentSessionRefreshPending = false;
        if (refreshBtn) {
            refreshBtn.disabled = !store.webRunning || !store.currentSessionId;
            refreshBtn.textContent = '↻';
            refreshBtn.title = '刷新当前会话';
        }
    }
}

/** 选择/切换会话：更新标题、目录路径，加载消息和子任务 */
export async function selectSession(id) {
    if (!id) return;
    var info = window._sessionMap?.[id];
    // 已打开的 Tab：走 Tab 快速切换（保存快照 + 秒切/分帧渲染）
    if (store.openTabs.some(function(t) { return t.sessionID === id; })) {
        openSessionTab(id, info?.title);
        return;
    }
    // 首次打开：注册 Tab 并走原有完整加载流程
    openSessionTab(id, info?.title);
    store.currentSessionId = id;
    store.activeTabId = id;
    // 同步项目树高亮
    updateTreeActiveSession();
    // 重新渲染 Tab 栏，确保新 tab 呈激活态（openSessionTab 内部已渲染一次，但此时 activeTabId 还未更新）
    renderTabsBar();
    store.expandedParts = {};
    store.markdownCache = {};
    store.lastMessageCount = 0;
    store.messageLoadSeq++;
    store.questionCustomInput = ''; // 清除 question 自定义输入
    document.getElementById('ocChatTitle').textContent = info?.title || id;
    const dirEl = document.getElementById('ocSideDirPath');
    if (dirEl) {
        var dirPath = info?.directory || '';
        dirEl.textContent = dirPath || id;
        dirEl.title = dirPath || '';
        dirEl.style.cursor = 'pointer';
        dirEl.onclick = function() {
            var p = info?.directory || '';
            if (!p) return;
            // 桌面端和 Web 端统一：都打开站内文件浏览器
            openFileBrowserModal(p, { features: ['git'] });
        };
    }
    // 创建并激活该会话容器，显示加载态
    var sessBox = ensureTabMessagesEl(id);
    if (sessBox) {
        sessBox.classList.add('active');
        sessBox.style.display = 'flex';
        sessBox.innerHTML = '<div class="oc-empty">正在加载会话消息...</div>';
        // 隐藏其他 tab 容器
        var poolEl = document.getElementById('ocMessagesPool');
        if (poolEl) {
            poolEl.querySelectorAll('.oc-messages-tab').forEach(function(c) {
                if (c !== sessBox) { c.classList.remove('active'); c.style.display = 'none'; }
            });
        }
    }
    // 重置用户消息导航状态（必须在容器激活后、loadMessages 前调用，
    // 避免 getActiveMessagesEl 仍指向旧容器导致 userNavIndex 被污染）
    resetUserNav();
    // 传 id 加载到该会话自己的容器：快速连点时各会话独立加载，互不丢弃
    loadMessages(id).then(() => {
        if (id !== store.currentSessionId) return;
        if (!isMobileTreeMode()) {
            extractSubtaskSummaries(store.currentSessionId);
            renderSubtaskPanel();
        }
        smartScroll(sessBox || getActiveMessagesEl(), true);
    }).catch(() => {});
}

/** 用指定目录创建会话 */
export async function createSessionWithDir(dir) {
    const session = await api.OpenCodeCall('POST', '/session?directory=' + encodeURIComponent(dir));
    rememberKnownDir(dir);
    return session;
}

/** 加载会话消息列表（含竞态保护；渲染到该会话自己的 tab 容器）。
 *  @param {string} [sessionID] 指定要加载的会话；缺省用当前会话。
 *  竞态保护按「每个会话独立 seq」：快速连点多个 tab 时，各会话的加载请求
 *  互不丢弃（原全局 seq 会因连点导致前序会话的加载被整体放弃 → 容器停在占位态）。 */
/** 每会话分页状态：{ loadedAll: 是否已全部加载, loading: 是否加载中 } */
const sessionPaging = {};

/** 是否已全部加载该会话的消息（分页） */
export function isSessionLoadedAll(sessionID) {
    return !!(sessionPaging[sessionID] && sessionPaging[sessionID].loadedAll);
}

/** 构造 before 游标：base64url(JSON{id, time})（time 为毫秒，取自消息 info.time.created） */
function buildBeforeCursor(msg) {
    const info = msg.info || msg;
    const id = info.id;
    const time = info.time?.created || info.time || 0;
    if (!id || !time) return '';
    return btoa(JSON.stringify({ id, time }))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 加载更早的消息（分页历史，向上滚动 / 用户定位到边界时调用）。
 * 每次拉取 200 条（before=缓存最旧消息游标），前置合并后保持滚动位置。
 */
export async function loadOlderMessages(sessionID) {
    const targetId = sessionID || store.currentSessionId;
    if (!targetId) return;
    if (!sessionPaging[targetId]) sessionPaging[targetId] = {};
    const paging = sessionPaging[targetId];
    if (paging.loadedAll || paging.loading) return;
    const list = getCachedMessages(targetId);
    const oldest = list[0];
    if (!oldest) return;
    const before = buildBeforeCursor(oldest);
    if (!before) return;
    paging.loading = true;
    try {
        const messages = await api.OpenCodeCall('GET', `/session/${encodeURIComponent(targetId)}/message?limit=200&before=${encodeURIComponent(before)}`);
        // 渲染到目标会话自己的容器；仅当前激活会话保持滚动位置与同步用户定位
        const isCurrent = targetId === store.currentSessionId;
        const box = isCurrent ? ensureTabMessagesEl(targetId) : null;
        const prevHeight = box ? box.scrollHeight : 0;
        if (!messages || !messages.length) {
            paging.loadedAll = true; // 没有更早消息，全部加载完成
        } else {
            prependMessages(targetId, messages);
            if (messages.length < 200) paging.loadedAll = true;
            // 新加载的用户消息插入缓存头部，用户定位索引整体偏移（保持"看到的那条"位置）
            const addedUserCount = messages.filter(m => (m.info?.role || m.role) === 'user').length;
            shiftUserNavIndex(addedUserCount);
            if (box && isCurrent) {
                renderMessages(getCachedMessages(targetId), box);
                const nextHeight = box.scrollHeight;
                box.scrollTop += nextHeight - prevHeight; // 保持加载前滚动位置
                updateUserNav(); // 同步用户定位（新加载的用户消息可定位、计数更新）
            } else if (box) {
                renderCachedMessages(targetId); // 非当前会话：仅合并缓存，激活时渲染
            }
        }
    } catch (_) {
    } finally {
        paging.loading = false;
    }
}

export async function loadMessages(sessionID) {
    const targetId = sessionID || store.currentSessionId;
    const seq = (store.sessionLoadSeq[targetId] = (store.sessionLoadSeq[targetId] || 0) + 1);
    if (!targetId) {
        // 无当前会话：仅当池中没有 tab 容器时才写空态提示；
        // 否则保留隐藏的 tab 容器与新建会话占位提示，避免误清空
        var poolEl = document.getElementById('ocMessagesPool');
        if (poolEl && !poolEl.querySelector('.oc-messages-tab')) {
            poolEl.innerHTML = '<div class="oc-empty">选择会话后查看消息，或输入内容创建新会话</div>';
        }
        return;
    }
    const box = ensureTabMessagesEl(targetId);
    if (!box) return;
    // 已加载过（分页进行中）：不重新拉取覆盖，直接渲染缓存，避免破坏分页状态
    const existing = getCachedMessages(targetId);
    if (existing.length) {
        renderMessages(existing, box);
        if (!isMobileTreeMode()) {
            extractSubtaskSummaries(targetId);
            renderSubtaskPanel();
        }
        return;
    }
    // 无缓存 = 全新加载（会话可能被关闭后重开、或刚 fork 出的新会话）：
    // 重置分页状态，防止 closeSessionTab 未清理的 loadedAll 残留（来自关闭前的滚动加载）
    // 把向上滚动加载永久拦截，导致只能看到最近 20 条。
    sessionPaging[targetId] = { loadedAll: false, loading: false };
    try {
        // 首次加载：分页拉最新 20 条
        const messages = await api.OpenCodeCall('GET', `/session/${encodeURIComponent(targetId)}/message?limit=20`);
        if (seq !== store.sessionLoadSeq[targetId]) return;
        cacheMessages(targetId, messages || []);
        // 返回条数 < 20 说明没有更多历史（已全部加载）
        if (!messages || messages.length < 20) {
            if (!sessionPaging[targetId]) sessionPaging[targetId] = {};
            sessionPaging[targetId].loadedAll = true;
        }
        renderMessages(getCachedMessages(targetId), box);
        if (!isMobileTreeMode()) {
            extractSubtaskSummaries(targetId);
            renderSubtaskPanel();
        }
    } catch (e) {
        if (seq !== store.sessionLoadSeq[targetId]) return;
        box.innerHTML = `<div class="oc-empty error">${escapeHtml(e.message || e)}</div>`;
    }
}

// ============================
// 项目树面板宽度状态
// ============================

/** 项目树面板宽度的 localStorage 键名（全局共享） */
const TREE_PANEL_WIDTH_KEY = 'treePanelWidth';
/** 项目树面板默认宽度（无记录时使用） */
const TREE_PANEL_DEFAULT_WIDTH = 240;
/** 项目树面板允许的最小宽度 */
const TREE_PANEL_MIN_WIDTH = 180;
/** 项目树面板允许的理论最大宽度 */
const TREE_PANEL_MAX_WIDTH = 420;
/** 最近一次有效的展开宽度（收起后保留，展开时恢复） */
export let treePanelWidth = TREE_PANEL_DEFAULT_WIDTH;

/**
 * 归一化用户偏好宽度
 * 仅做静态范围约束（180~420），不考虑当前窗口可用宽度
 */
export function normalizeTreePanelWidth(width) {
    const numeric = Number(width);
    if (!Number.isFinite(numeric)) return TREE_PANEL_DEFAULT_WIDTH;
    return Math.max(TREE_PANEL_MIN_WIDTH, Math.min(TREE_PANEL_MAX_WIDTH, numeric));
}

/**
 * 计算当前窗口下允许的动态最大宽度
 * 需要为中间聊天区保留至少 360px，为右侧栏保留 320px
 */
export function getTreePanelDynamicMaxWidth() {
    const client = document.getElementById('webContainer');
    if (!client) return TREE_PANEL_MAX_WIDTH;
    const availableWidth = client.clientWidth;
    return Math.max(TREE_PANEL_MIN_WIDTH, Math.min(TREE_PANEL_MAX_WIDTH, availableWidth - 360 - 320));
}

/**
 * 根据当前窗口大小夹取实际渲染宽度
 * 该宽度可能小于用户偏好值，但不会覆盖用户偏好本身
 */
export function clampTreePanelWidth(width) {
    return Math.max(TREE_PANEL_MIN_WIDTH, Math.min(getTreePanelDynamicMaxWidth(), normalizeTreePanelWidth(width)));
}

/**
 * 将项目树面板宽度应用到桌面端布局
 * 通过 `--tree-panel-width` 同时驱动左栏列宽与收起按钮定位
 */
export function applyTreePanelWidth(width) {
    const client = document.getElementById('webContainer');
    if (!client || isMobileTreeMode()) return;
    const nextWidth = clampTreePanelWidth(width);
    client.style.setProperty('--tree-panel-width', nextWidth + 'px');
}

/**
 * 持久化用户偏好宽度
 * 保存的是用户偏好值，不是当前窗口下的临时夹取值
 */
export function persistTreePanelWidth(width) {
    const nextWidth = normalizeTreePanelWidth(width);
    treePanelWidth = nextWidth;
    try {
        localStorage.setItem(TREE_PANEL_WIDTH_KEY, String(nextWidth));
    } catch (_) {}
    return nextWidth;
}

/**
 * 初始化项目树面板宽度
 * 优先恢复 localStorage 中的值；无记录或非法值时回退到默认值 240px
 */
export function loadTreePanelWidth() {
    let width = TREE_PANEL_DEFAULT_WIDTH;
    try {
        const saved = localStorage.getItem(TREE_PANEL_WIDTH_KEY);
        if (saved != null) {
            width = saved;
        }
    } catch (_) {}
    treePanelWidth = normalizeTreePanelWidth(width);
    applyTreePanelWidth(treePanelWidth);
    persistTreePanelWidth(treePanelWidth);
}

/**
 * 绑定项目树拖拽调宽逻辑（仅桌面端）
 * 收起状态下不响应拖拽；拖拽结束后写入 localStorage
 */
export function initTreePanelResize() {
    const treeResizeHandle = document.getElementById('ocTreeResizeHandle');
    if (!treeResizeHandle) return;
    // 同时兼容鼠标与触摸拖拽，保证移动端也能调整项目树宽度。
    const startResize = (startClientX) => {
        if (isMobileTreeMode()) return;
        const client = document.getElementById('webContainer');
        if (!client || client.classList.contains('hide-left')) return;
        const startWidth = treePanelWidth;
        let currentWidth = startWidth;
        client.classList.add('tree-resizing');
        treeResizeHandle.classList.add('dragging');

        const onMove = (moveEvent) => {
            if (moveEvent.touches) moveEvent.preventDefault();
            const clientX = moveEvent.touches ? moveEvent.touches[0].clientX : moveEvent.clientX;
            const delta = clientX - startClientX;
            currentWidth = startWidth + delta;
            applyTreePanelWidth(currentWidth);
        };

        const stopResize = () => {
            persistTreePanelWidth(currentWidth);
            applyTreePanelWidth(treePanelWidth);
            client.classList.remove('tree-resizing');
            treeResizeHandle.classList.remove('dragging');
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', stopResize);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', stopResize);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', stopResize);
            window.removeEventListener('blur', stopResize);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', stopResize);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', stopResize);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', stopResize);
        window.addEventListener('blur', stopResize);
    };

    treeResizeHandle.addEventListener('pointerdown', (event) => {
        startResize(event.clientX);
        treeResizeHandle.setPointerCapture?.(event.pointerId);
    });

    treeResizeHandle.addEventListener('touchstart', (event) => {
        event.preventDefault();
        startResize(event.touches[0].clientX);
    });
}

// ============================
// 右侧面板宽度状态
// ============================

/** 右侧面板宽度的 localStorage 键名（全局共享） */
const SIDEPANEL_WIDTH_KEY = 'sidepanelWidth';
/** 右侧面板默认宽度（无记录时使用） */
const SIDEPANEL_DEFAULT_WIDTH = 320;
/** 右侧面板允许的最小宽度 */
const SIDEPANEL_MIN_WIDTH = 220;
/** 右侧面板允许的理论最大宽度 */
const SIDEPANEL_MAX_WIDTH = 420;
/** 最近一次有效的右侧面板展开宽度 */
export let sidepanelWidth = SIDEPANEL_DEFAULT_WIDTH;

/**
 * 归一化右侧面板用户偏好宽度
 * 仅做静态范围约束（220~420），不考虑当前窗口可用宽度
 */
export function normalizeSidepanelWidth(width) {
    const numeric = Number(width);
    if (!Number.isFinite(numeric)) return SIDEPANEL_DEFAULT_WIDTH;
    return Math.max(SIDEPANEL_MIN_WIDTH, Math.min(SIDEPANEL_MAX_WIDTH, numeric));
}

/**
 * 计算当前窗口下允许的右侧面板动态最大宽度
 * 需要为中间聊天区保留至少 360px，并考虑左侧项目树当前渲染宽度
 */
export function getSidepanelDynamicMaxWidth() {
    const client = document.getElementById('webContainer');
    if (!client) return SIDEPANEL_MAX_WIDTH;
    const availableWidth = client.clientWidth;
    const leftWidth = client.classList.contains('hide-left')
        ? 0
        : (parseFloat(getComputedStyle(client).getPropertyValue('--tree-panel-width')) || TREE_PANEL_DEFAULT_WIDTH);
    return Math.max(SIDEPANEL_MIN_WIDTH, Math.min(SIDEPANEL_MAX_WIDTH, availableWidth - leftWidth - 360));
}

/**
 * 根据当前窗口大小夹取右侧面板实际渲染宽度
 * 该宽度可能小于用户偏好值，但不会覆盖用户偏好本身
 */
export function clampSidepanelWidth(width) {
    return Math.max(SIDEPANEL_MIN_WIDTH, Math.min(getSidepanelDynamicMaxWidth(), normalizeSidepanelWidth(width)));
}

/**
 * 将右侧面板宽度应用到桌面端布局
 * 通过 `--sidepanel-width` 同时驱动第三列宽度与收起按钮定位
 */
export function applySidepanelWidth(width) {
    const client = document.getElementById('webContainer');
    if (!client || isMobileTreeMode()) return;
    const nextWidth = clampSidepanelWidth(width);
    client.style.setProperty('--sidepanel-width', nextWidth + 'px');
}

/**
 * 持久化用户偏好的右侧面板宽度
 * 保存的是用户偏好值，不是当前窗口下的临时夹取值
 */
export function persistSidepanelWidth(width) {
    const nextWidth = normalizeSidepanelWidth(width);
    sidepanelWidth = nextWidth;
    try {
        localStorage.setItem(SIDEPANEL_WIDTH_KEY, String(nextWidth));
    } catch (_) {}
    return nextWidth;
}

/**
 * 初始化右侧面板宽度
 * 优先恢复 localStorage 中的值；无记录或非法值时回退到默认值 320px
 */
export function loadSidepanelWidth() {
    let width = SIDEPANEL_DEFAULT_WIDTH;
    try {
        const saved = localStorage.getItem(SIDEPANEL_WIDTH_KEY);
        if (saved != null) {
            width = saved;
        }
    } catch (_) {}
    sidepanelWidth = normalizeSidepanelWidth(width);
    applySidepanelWidth(sidepanelWidth);
    persistSidepanelWidth(sidepanelWidth);
}

/**
 * 绑定右侧面板拖拽调宽逻辑（仅桌面端）
 * 收起状态下不响应拖拽；拖拽结束后写入 localStorage
 */
export function initSidepanelResize() {
    const sidepanelResizeHandle = document.getElementById('ocSidepanelResizeHandle');
    if (!sidepanelResizeHandle) return;
    // 同时兼容鼠标与触摸拖拽，保证移动端也能调整右侧面板宽度。
    const startResize = (startClientX) => {
        if (isMobileTreeMode()) return;
        const client = document.getElementById('webContainer');
        if (!client || client.classList.contains('hide-right')) return;
        const startWidth = sidepanelWidth;
        let currentWidth = startWidth;
        client.classList.add('sidepanel-resizing');
        sidepanelResizeHandle.classList.add('dragging');

        const onMove = (moveEvent) => {
            if (moveEvent.touches) moveEvent.preventDefault();
            const clientX = moveEvent.touches ? moveEvent.touches[0].clientX : moveEvent.clientX;
            const delta = startClientX - clientX;
            currentWidth = startWidth + delta;
            applySidepanelWidth(currentWidth);
        };

        const stopResize = () => {
            persistSidepanelWidth(currentWidth);
            applySidepanelWidth(sidepanelWidth);
            client.classList.remove('sidepanel-resizing');
            sidepanelResizeHandle.classList.remove('dragging');
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', stopResize);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', stopResize);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', stopResize);
            window.removeEventListener('blur', stopResize);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', stopResize);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', stopResize);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', stopResize);
        window.addEventListener('blur', stopResize);
    };

    sidepanelResizeHandle.addEventListener('pointerdown', (event) => {
        startResize(event.clientX);
        sidepanelResizeHandle.setPointerCapture?.(event.pointerId);
    });

    sidepanelResizeHandle.addEventListener('touchstart', (event) => {
        event.preventDefault();
        startResize(event.touches[0].clientX);
    });
}


// ============================
// 附件管理
// ============================

/** 读取文件为 DataURL（用 FileReader） */
export function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
    });
}

/** 添加附件（20MB 限制，防重复） */
export function addAttachment(file) {
    const size = file.size;
    if (size > 20 * 1024 * 1024) {
        showToast('附件过大，请选择 20MB 以内的文件', 'error');
        return;
    }
    const filename = file.name;
    if (store.attachedFiles.some(f => f.filename === filename && f.size === size)) {
        showToast('文件已添加: ' + filename, 'info');
        return;
    }
    readFileAsDataURL(file).then(data => {
        store.attachedFiles.push({ data, filename, mime: file.type || 'application/octet-stream', size });
        renderAttachedFiles();
    }).catch(e => {
        showToast('读取附件失败: ' + e.message, 'error');
    });
}

/** 移除指定索引的附件 */
export function removeAttachment(index) {
    store.attachedFiles.splice(index, 1);
    renderAttachedFiles();
}

/** 渲染附件列表 DOM（含删除按钮） */
export function renderAttachedFiles() {
    const list = document.getElementById('ocAttachList');
    if (!list) return;
    if (!store.attachedFiles.length) {
        list.innerHTML = '';
        return;
    }
    list.innerHTML = store.attachedFiles.map((f, i) =>
        `<span class="oc-attach-chip"><span class="oc-attach-chip-name">📎 ${escapeHtml(f.filename)}</span><span class="oc-attach-chip-remove" data-index="${i}">✕</span></span>`
    ).join('');
    list.querySelectorAll('.oc-attach-chip-remove').forEach(el => {
        el.addEventListener('click', () => removeAttachment(parseInt(el.dataset.index)));
    });
}

/** 清空全部附件 */
export function clearAttachments() {
    store.attachedFiles = [];
    renderAttachedFiles();
}

/** 构建发送消息的 parts 数组（文本 + 附件） */
export function buildParts(text) {
    const parts = [];
    if (text.trim()) {
        parts.push({ type: 'text', text });
    }
    store.attachedFiles.forEach(f => {
        parts.push({ type: 'file', mime: f.mime, filename: f.filename, url: f.data });
    });
    return parts;
}

// ============================
// 会话轮询与发送按钮
// ============================

/** 调度会话状态轮询（每 4 秒检查，非忙碌时自动停止） */
/**
 * 调度会话状态轮询
 * 每 4 秒检查一次会话状态，会话繁忙时持续轮询，完成后自动停止并刷新消息
 */
export function scheduleRefresh() {
    clearInterval(store.refreshTimer);
    const refreshSessionId = store.currentSessionId;
    store.refreshTimer = setInterval(() => {
        if (!store.webRunning || !refreshSessionId) return;//opencode服务未启动或者当前没有会话
        // 如果用户已经切换会话，旧定时器直接停止，避免处理新会话
        if (refreshSessionId !== store.currentSessionId) {
            clearInterval(store.refreshTimer);
            store.refreshTimer = null;
            return;
        }
        const wasBusy = isSessionBusy(refreshSessionId);
        loadSessionStatuses().then(statuses => {
            const nextStatuses = statuses || {};
            // 只更新目标会话的状态（快照权威，纠正 SSE 可能丢失的事件）；
            // 其它会话的 key 保留本地值（SSE 增量权威），避免整体替换抹掉其它 tab 的 busy
            if (nextStatuses[refreshSessionId] !== undefined) {
                store.sessionStatuses[refreshSessionId] = nextStatuses[refreshSessionId];
            }
            updateSendButton();
            const busy = isSessionBusy(refreshSessionId);
            // if (busy || wasBusy) {
            //     loadMessages();
            // }
            if (!busy) {
                clearInterval(store.refreshTimer);
                store.refreshTimer = null;
                loadMessages();
                refreshSessionTitle();
            }
        }).catch(() => {
            // 状态刷新失败时不要影响 SSE 流式输出
        });
        
    }, 4000);
}

/** 中止当前会话（调用 API，刷新状态和消息） */
/**
 * 中止当前会话
 * 调用 API 停止会话处理，更新状态并刷新消息列表
 */
export async function abortSession() {
    if (!store.webRunning || !store.currentSessionId) return;
    const btn = document.getElementById('btnSendPrompt');
    btn.disabled = true;
    const sessionID = store.currentSessionId;
    // 停止 4 秒状态轮询：否则 abort 后轮询会把服务端延迟返回的 busy 快照
    // 写回 sessionStatuses，导致按钮变回「停止」，用户点击实际执行 abort 而非发送。
    clearInterval(store.refreshTimer);
    store.refreshTimer = null;
    try {
        const dirEl = document.getElementById('ocSideDirPath');
        const requestDir = (dirEl?.textContent || window._sessionMap?.[sessionID]?.directory || '').trim();
        const directoryQuery = requestDir ? `?directory=${encodeURIComponent(requestDir)}` : '';
        try {
            await api.OpenCodeCall('POST', `/session/${encodeURIComponent(sessionID)}/abort${directoryQuery}`);
        } catch (err) {
            if (directoryQuery) {
                await api.OpenCodeCall('POST', `/session/${encodeURIComponent(sessionID)}/abort`);
            } else {
                throw err;
            }
        }
        showToast('已停止', 'info');
        delete store.sessionErrors[sessionID];
        store.sessionStatuses[sessionID] = 'idle';
        updateSendButton();
        await loadMessages();
        loadSessionStatuses().then(statuses => {
            // abort 后快照只认可 idle：服务端 abort 可能有延迟，若返回 busy
            // 说明是未同步的旧状态，忽略（否则按钮变回「停止」，用户点发送实际执行 abort）。
            // 服务端确认 idle 则保留权威状态。
            if (statuses && typeof statuses === 'object' && statuses[sessionID] === 'idle') {
                store.sessionStatuses[sessionID] = 'idle';
            }
            updateSendButton();
        });
    } catch (e) {
        showToast('停止失败: ' + (e.message || e), 'error');
    }
    btn.disabled = false;
}

// ============================
// 发送消息
// ============================

/** 发送消息主函数：新会话创建 → 构建 body → 同步发送 → 刷新消息 */
/** 发送中标志：防止同一次操作重复触发 sendPrompt（按钮双击 / Enter 连按 / 事件重复绑定）。
 *  提交 prompt_async 请求返回后即释放，模型回复期间仍可继续发送下一条。 */
let promptSending = false;

export async function sendPrompt() {
    if (!store.webRunning) return;
    if (promptSending) return;
    promptSending = true;
    try {
        const input = document.getElementById('ocPrompt');
        const text = input.value.trim();
        if (!text.trim() && !store.attachedFiles.length) return;
        // 立即清空输入框（不等请求返回）：即使发送中锁已复位，
        // 重复触发（键盘抖动/双击）也因无文本而被拦截，不会发两条一样的。
        input.value = '';
    const btn = document.getElementById('btnSendPrompt');
    btn.disabled = true;
    const isNew = !store.currentSessionId;
    let sessionDir = '';
    try {
        if (isNew) {
            if (store.pendingWorkDir) {
                sessionDir = store.pendingWorkDir;
                store.pendingWorkDir = '';
                const session = await createSessionWithDir(sessionDir);
                //设置当前目录
                document.getElementById('ocSideDirPath').textContent = sessionDir;
                store.currentSessionId = session.id || session.ID;
                store.activeTabId = store.currentSessionId;
                // 新建会话自动打开 Tab
                var newTitle = (window._sessionMap && window._sessionMap[store.currentSessionId] && window._sessionMap[store.currentSessionId].title) || store.currentSessionId;
                openSessionTab(store.currentSessionId, newTitle);
                // 标题由 OpenCode 异步生成：主动轮询更新 tab/树/标题栏
                scheduleSessionTitleRefresh(store.currentSessionId);
                // 首开的 Tab 只注册未建容器，这里手动创建并激活，否则消息会渲染进隐藏容器导致界面空白
                var sessBox = ensureTabMessagesEl(store.currentSessionId);
                if (sessBox) {
                    sessBox.classList.add('active');
                    sessBox.style.display = 'flex';
                    var poolEl = document.getElementById('ocMessagesPool');
                    if (poolEl) {
                        poolEl.querySelectorAll('.oc-messages-tab').forEach(function(c) {
                            if (c !== sessBox) { c.classList.remove('active'); c.style.display = 'none'; }
                        });
                    }
                }
                // 新建会话后重置用户消息导航索引（否则残留上一个会话的定位）
                resetUserNav();
            } else {
                 showToast('请先新建会话，设置会话目录', 'error');
                 return;
            }
        }
        if (store.currentSessionId) {
            delete store.sessionErrors[store.currentSessionId];
            store.sessionStatuses[store.currentSessionId] = 'busy';
            ensurePendingAssistant(store.currentSessionId);
            // 乐观添加用户消息到缓存，立即显示用户输入（不等 API/事件推送）
            cacheLocalUserMessage(store.currentSessionId, text);
            if (isMobileTreeMode()) {
                renderPendingAssistantPlaceholder(store.currentSessionId);
            } else {
                renderCachedMessages(store.currentSessionId);
            }
            smartScroll(getActiveMessagesEl(), true);
            updateSendButton();
        }
        const body = { parts: buildParts(text) };
        if (store.selectedAgent) body.agent = store.selectedAgent;
        if (store.selectedModel) {
            const slashIdx = store.selectedModel.indexOf('/');
            if (slashIdx > 0) {
                body.model = {
                    providerID: store.selectedModel.slice(0, slashIdx),
                    modelID: store.selectedModel.slice(slashIdx + 1),
                };
            }
        }
        if (store.selectedVariant) body.variant = store.selectedVariant;
        const dirEl = document.getElementById('ocSideDirPath');
        const requestDir = (dirEl?.textContent || window._sessionMap?.[store.currentSessionId]?.directory || sessionDir || '').trim();
        const directoryQuery = requestDir ? `?directory=${encodeURIComponent(requestDir)}` : '';
        await api.OpenCodeCall('POST', `/session/${encodeURIComponent(store.currentSessionId)}/prompt_async${directoryQuery}`, body);
        if (isNew) {
            dirEl.onclick = function() {
                openFileBrowserModal(requestDir, { features: ['git'] });
            };
        }
        clearAttachments();
        if (!isMobileTreeMode()) {
            await loadMessages();
        }
        smartScroll(getActiveMessagesEl(), true);
        scheduleRefresh();
        updateSendButton();
    } catch (e) {
        // 发送失败：移除乐观用户消息，避免残留"已发送"假象
        if (store.currentSessionId) removeLocalUserMessage(store.currentSessionId);
        showToast('发送失败: ' + (e.message || e), 'error');
    }
        btn.disabled = false;
    } finally {
        promptSending = false;
    }
}

// ============================================================
// Tab 激活加载回调注入
// tabs.js 的 activateTabContainer 在目标容器不存在时会触发加载，
// ESM 下为避免 tabs↔session 循环依赖，由本模块在加载完成后注入回调。
// ============================================================
setTabActivationHandler(function() {
    if (store.currentSessionId) loadMessages();
});

// ============================================================
// 分页事件绑定：消息容器滚动到顶加载更早；用户定位到边界触发
// ============================================================
(function bindMessagePagingEvents() {
    const pool = document.getElementById('ocMessagesPool');
    if (pool) {
        let scrollTimer = null;
        pool.addEventListener('scroll', function() {
            if (scrollTimer) clearTimeout(scrollTimer);
            scrollTimer = setTimeout(function() {
                const box = getActiveMessagesEl();
                if (box && box.scrollTop <= 5) {
                    loadOlderMessages(store.currentSessionId);
                }
            }, 250);
        }, true);
    }
    // 用户定位（▲ 到最早一条）触发加载更早消息
    document.addEventListener('oc-load-older', function() {
        loadOlderMessages(store.currentSessionId);
    });
})();
