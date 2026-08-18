// ============================================================
// OpenCode 管理中心 - 工具函数
// ============================================================

import { store } from './state.js';

// DOM 快捷引用
export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => document.querySelectorAll(sel);

// Toast 通知
let toastTimer = null;

export function showToast(message, type = 'info') {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove('show');
    }, 2800);
}

// HTML 转义
export function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================================
// 运行环境判定
// ============================================================

/** 是否为纯浏览器环境（无 Wails runtime） */
export function isBrowserRuntimeForMain() {
    return !window.runtime;
}

// ============================================================
// 多会话 Tab 消息容器访问
// 每个 tab 对应一个 .oc-messages-tab 子容器，挂在 #ocMessagesPool 下
// ============================================================

/** 取指定会话的消息容器（tab 容器），不存在返回 null */
export function getTabMessagesEl(sessionID) {
    if (!sessionID) return null;
    var pool = document.getElementById('ocMessagesPool');
    if (!pool) return null;
    return pool.querySelector('.oc-messages-tab[data-tab="' + CSS.escape(sessionID) + '"]');
}

/** 取当前活动 tab 的消息容器；无活动 tab 时回退到池本身 */
export function getActiveMessagesEl() {
    var pool = document.getElementById('ocMessagesPool');
    if (!pool) return document.getElementById('ocMessages');
    var active = pool.querySelector('.oc-messages-tab.active');
    return active || pool;
}

/** 安全设置消息区空态提示。
 *  避免 getActiveMessagesEl() 在无活动 tab 时回退返回 pool 本身，
 *  导致 innerHTML= 清空整个池（连带销毁所有隐藏的 tab 容器）。
 *  规则：
 *   - 池中有活动 tab 容器 → 只写入该容器
 *   - 无活动但有隐藏 tab 容器（新建会话占位态）→ 更新/创建占位提示，保留 tab 容器
 *   - 无任何 tab 容器 → 直接写 pool */
export function setMessagesEmpty(text) {
    var pool = document.getElementById('ocMessagesPool');
    if (!pool) return;
    var active = pool.querySelector('.oc-messages-tab.active');
    if (active) {
        active.innerHTML = '<div class="oc-empty">' + text + '</div>';
        return;
    }
    var hasTabs = pool.querySelector('.oc-messages-tab');
    if (hasTabs) {
        var ph = pool.querySelector('.oc-new-session-placeholder');
        if (!ph) {
            ph = document.createElement('div');
            ph.className = 'oc-new-session-placeholder oc-empty';
            pool.appendChild(ph);
        }
        ph.style.display = 'block';
        ph.textContent = text;
        return;
    }
    pool.innerHTML = '<div class="oc-empty">' + text + '</div>';
}

/** 创建指定会话的消息容器（若不存在），返回容器元素 */
export function ensureTabMessagesEl(sessionID) {
    var pool = document.getElementById('ocMessagesPool');
    if (!pool) return null;
    var el = getTabMessagesEl(sessionID);
    if (el) return el;
    // 清掉 pool 里的非 tab 残留（初始空态提示、旧提示），避免与 tab 容器共存
    Array.prototype.slice.call(pool.children).forEach(function(child) {
        if (!child.classList || !child.classList.contains('oc-messages-tab')) {
            pool.removeChild(child);
        }
    });
    el = document.createElement('div');
    el.className = 'oc-messages oc-messages-tab';
    el.dataset.tab = sessionID;
    el.style.display = 'none';
    pool.appendChild(el);
    return el;
}

// ============================================================
// 消息缓存访问
// getCachedMessages 原属 chat/cache.js，为打破 cache.js ↔ render.js
// 循环依赖，统一移入 utils.js（它只依赖 store.messageCache）。
// ============================================================

/** 获取会话缓存消息（不存在则初始化为空数组） */
export function getCachedMessages(sessionID) {
    if (!store.messageCache[sessionID]) store.messageCache[sessionID] = [];
    return store.messageCache[sessionID];
}

// ============================================================
// 消息文本/结构纯函数
// 原属 chat/service.js，为打破 service.js ↔ render.js 循环依赖，
// 统一移入 utils.js（均为纯函数，只操作入参，无 DOM/状态依赖）。
// ============================================================

/** 安全转文本（处理 null/undefined/对象） */
export function safeText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
}

/** 从 part 对象中提取文本内容 */
export function extractPartText(part) {
    if (!part) return '';
    return part.text || part.content || part.message || part.value || safeText(part);
}

/** 从消息项中提取纯文本 */
export function messageText(item) {
    const parts = item?.parts || item?.info?.parts || [];
    const list = Array.isArray(parts) ? parts : [parts];
    return list.map(part => extractPartText(part)).join('\n').trim();
}

/** 判断消息是否为内部 user 消息（应过滤） */
export function isInternalUserMessage(item) {
    const info = item?.info || item || {};
    const role = info.role || info.author || '';
    if (role !== 'user') return false;
    const parts = item?.parts;
    if (!parts || (Array.isArray(parts) && parts.length === 0)) return true;
    const text = messageText(item);
    return text.includes('OMO_INTERNAL_INITIATOR')
        || text.includes('<system-reminder>')
        || text.includes('</system-reminder>')
        || /^\s*\[(?:BACKGROUND TASK COMPLETED|ALL BACKGROUND TASKS COMPLETE)\]/.test(text)
        || (text.includes('background_output(') && text.includes('task_id='));
}

/** 标准化消息项（确保 info 和 parts 结构一致） */
export function normalizeMessageItem(item) {
    const info = item.info || item;
    const parts = item.parts || info.parts || [];
    return {
        info,
        parts: Array.isArray(parts) ? parts : [parts],
    };
}

// ============================================================
// updateModelInfo 注册中心
// 打破 service.js / tree.js ↔ render.js 循环依赖：
// 实现留在 render.js（doUpdateModelInfo），由它在此注册；
// service/tree 只从 core 层 import updateModelInfo 调用。
// ============================================================
let updateModelInfoHandler = null;

/** 由 render.js 模块加载时注册实现 */
export function setUpdateModelInfoHandler(fn) {
    updateModelInfoHandler = typeof fn === 'function' ? fn : null;
}

/** 同步最新 assistant 使用的 Agent/Model 到下拉框（core 层入口，供 service/tree 调用） */
export function updateModelInfo(items) {
    if (updateModelInfoHandler) updateModelInfoHandler(items);
}

// ============================================================
// 项目树当前会话高亮同步
// 只依赖 store + DOM，不依赖 chat 层任何模块；
// tabs.js / session.js / tree.js 均从 core 层 import，避免模块环。
// ============================================================

/** 同步项目树中当前会话的高亮（active 类）。
 *  在 selectSession / switchTab / 树点击后调用，确保树节点与当前会话一致。 */
export function updateTreeActiveSession() {
    var container = document.getElementById('ocTree');
    if (!container) return;
    var activeId = store.activeTabId || store.currentSessionId || '';
    container.querySelectorAll('.oc-tree-session').forEach(function(node) {
        var isActive = !!activeId && node.dataset.sessionId === activeId;
        node.classList.toggle('active', isActive);
    });
}
