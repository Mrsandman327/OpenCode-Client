// ============================================================
// chat-events.js — SSE 事件流处理
// 负责 SSE 连接建立、事件分发解析、事件处理逻辑
// 依赖：core/state.js、core/utils.js（showToast, escapeHtml, getCachedMessages, safeText）、core/apicall.js（api）、
//       chat/session.js（loadMessages, refreshSessionTitle, selectSession）、
//       chat/render.js（updateSendButton）、chat/cache.js（scheduleRenderCachedMessages, upsertMessage 等）、
//       chat/sidepanel.js（scheduleSubtaskExtraction）、chat/tree.js（buildTree）
// ============================================================

import { store } from '../core/state.js';
import { api } from '../core/apicall.js';
import { showToast, escapeHtml, getCachedMessages, safeText } from '../core/utils.js';
import { loadMessages, refreshSessionTitle, selectSession } from './session.js';
import { updateSendButton } from './render.js';
import { scheduleRenderCachedMessages, upsertMessage, upsertPart, applyPartDelta, removePart, removeMessage } from './cache.js';
import { scheduleSubtaskExtraction } from './sidepanel.js';
import { buildTree } from './tree.js';
import { showPermissionRequest, closePermissionModal } from './permission.js';

// ============================
// SSE 事件处理
// ============================

/** EventSource 断线重连计数（浏览器模式；Wails 模式经 runtime 事件自动重连） */
let reconnectAttempts = 0;

/** 同类提示节流窗口（毫秒）：避免断开/重连提示在短时间内反复弹出刷屏 */
const TOAST_THROTTLE_MS = 10000;

/** 各提示键上次弹出的时间戳（键 -> 时间戳），用于节流判断 */
const toastLastShownAt = {};

/** 带节流的提示：同一 key 在 TOAST_THROTTLE_MS 内只弹一次，既保留断开可见性又不重复刷屏 */
function showThrottledToast(key, message, type) {
    const now = Date.now();
    if (now - (toastLastShownAt[key] || 0) < TOAST_THROTTLE_MS) return;
    toastLastShownAt[key] = now;
    showToast(message, type);
}

/** 解析 SSE 事件原始 JSON 载荷，解包 payload 字段 */
export function parseEventPayload(raw) {
    try {
        const event = JSON.parse(raw);
        if (event.payload?.type) {
            return {
                ...event.payload,
                directory: event.directory,
                project: event.project,
            };
        }
        return event;
    } catch { return { type: 'raw', data: raw }; }
}

/** 启动 SSE 事件流连接（Wails EventsOn / 浏览器 EventSource 双模式） */
export function startEventStream() {
    if (window.runtime && !startEventStream.bound) {
        window.runtime.EventsOn('oc-event', (raw) => handleOcEvent(parseEventPayload(raw)));
        window.runtime.EventsOn('oc-event-error', (msg) => {
            showToast('事件流异常: ' + msg, 'error');
        });
        startEventStream.bound = true;
    }
    if (!window.runtime && !startEventStream.eventSource) {
        const es = new EventSource('/events');
        startEventStream.eventSource = es;
        es.addEventListener('oc-event', (event) => handleOcEvent(parseEventPayload(event.data)));
        es.addEventListener('oc-event-error', (event) => {
            showToast('事件流异常: ' + (event.data || '连接已断开'), 'error');
        });
        // 服务端缓冲溢出、客户端即将被剔除前发来的显式通知：
        // 说明这段时间的事件已丢失，缓存可能残缺（缺正文/思考 part），
        // 必须主动全量补齐一次，否则界面会一直停在残缺状态。
        es.addEventListener('sse-lagged', () => {
            showThrottledToast('es-lagged', '事件流出现延迟，正在补齐消息...', 'warning');
            loadMessages();
        });
        es.onerror = () => {
            if (es.readyState === EventSource.CLOSED) {
                // 连接彻底关闭（非自动重连）：节流提示，避免重复刷屏
                showThrottledToast('es-closed', '事件流连接已断开，请刷新页面', 'error');
            } else {
                reconnectAttempts++;
                if (reconnectAttempts >= 3) {
                    showThrottledToast('es-reconnecting', '事件流异常，正在自动重连...', 'warning');
                    reconnectAttempts = 0; // 重置，防止持续弹框
                }
            }
        };
        // 连接成功（含浏览器自动重连成功）时重置计数，避免计数只增不减导致误报
        let sseEverConnected = false;
        es.onopen = () => {
            reconnectAttempts = 0;
            // 重连成功：断线期间的事件已永久丢失，主动全量补齐一次，
            // 否则残缺缓存（缺 text part）会一直停留在界面上，而刷新又可能被在途锁跳过。
            // 首次连接不补齐（初始加载由会话选择/状态轮询负责），避免无意义的重复请求。
            if (sseEverConnected) loadMessages();
            sseEverConnected = true;
        };
    }
    // 后端 SSE 只需建立一次：startEventStream() 会被 checkWebStatus() 反复调用
    // （例如每次点击侧栏 OpenCode 视图），若无条件重调会不断重建后端 SSE 连接并造成事件丢失。
    // 用一次性标记（同 startEventStream.bound 模式）避免重复；服务停止时在
    // stopWeb() 与 checkWebStatus() 中复位，保证重启后能重新建立连接。
    if (api.StartOpenCodeEvents && !startEventStream.backendStarted) {
        startEventStream.backendStarted = true;
        // 调用失败则复位标记，使下次有机会重试
        api.StartOpenCodeEvents().catch(() => { startEventStream.backendStarted = false; });
    }
}

/** 主事件处理中枢：按 type 分发到缓存、渲染、会话、树、面板等模块 */
export function handleOcEvent(event) {
    const type = event.type || event.name || '';
    const props = event.properties || event.data || event;
    const sid = props.sessionID || props.sessionId || props.info?.sessionID || props.part?.sessionID || store.currentSessionId;

    if (type === 'server.connected' || type === 'server.heartbeat') return;

    if (type.includes('permission')) {
        if (type.includes('asked')) {
            // 权限请求（permission.asked / permission.v2.asked）：弹窗提供 允许一次 / 始终允许 / 拒绝
            showPermissionRequest(props);
        } else if (type.includes('replied')) {
            // 权限已响应（本机或网页端等其他客户端）：关闭对应弹窗
            closePermissionModal(props.requestID || props.id);
        } else {
            showToast('权限请求: ' + (props.action || props.permission || 'tool'), 'warning');
        }
    }

    if (type === 'session.error' && sid && props.error) {
        store.sessionErrors[sid] = typeof props.error === 'string' ? props.error : (props.error.message || safeText(props.error));
        if (sid === store.currentSessionId) loadMessages();
        return;
    }
    if (type === 'session.status' && sid) {
        store.sessionStatuses[sid] = props.status || props;
        if (sid === store.currentSessionId) {
            updateSendButton();
            const status = props.status || props;
            if (status?.type === 'idle') {
                loadMessages();
                refreshSessionTitle();
            } else if (getCachedMessages(sid).length) {
                scheduleRenderCachedMessages(sid);
                scheduleSubtaskExtraction(sid);
            } else {
                loadMessages();
            }
        }
        return;
    }
    if (type === 'session.idle' && sid) {
        delete store.sessionErrors[sid];
        store.sessionStatuses[sid] = 'idle';
        if (sid === store.currentSessionId) {
            updateSendButton();
            loadMessages();
            refreshSessionTitle();
        }
        return;
    }

    if (type === 'message.updated' && props.info) {
        upsertMessage(props.info);
        bumpTabCacheVersion(sid);
        scheduleRenderCachedMessages(sid);
        scheduleSubtaskExtraction(sid);
        return;
    }
    if (type === 'message.part.updated' && props.part) {
        upsertPart(props.part);
        bumpTabCacheVersion(sid);
        scheduleRenderCachedMessages(sid);
        scheduleSubtaskExtraction(sid);
        return;
    }
    if (type === 'message.part.delta') {
        applyPartDelta(props);
        bumpTabCacheVersion(sid);
        scheduleRenderCachedMessages(sid);
        scheduleSubtaskExtraction(sid);
        return;
    }
    if (type === 'message.part.removed') {
        removePart(props);
        bumpTabCacheVersion(sid);
        scheduleRenderCachedMessages(sid);
        scheduleSubtaskExtraction(sid);
        return;
    }
    if (type === 'message.removed') {
        removeMessage(props);
        bumpTabCacheVersion(sid);
        scheduleRenderCachedMessages(sid);
        scheduleSubtaskExtraction(sid);
        return;
    }

    const isCurrentSession = sid && sid === store.currentSessionId;
    if (type === 'session.created' && isCurrentSession) {
        buildTree();
        return;
    }
    if (type === 'session.deleted') {
        if (window._skipSessionDeletedRebuild) {
            window._skipSessionDeletedRebuild = false;
        } else {
            buildTree();
        }
        return;
    }
    if (type === 'session.updated') {
        // 会话更新事件：无需处理
    }
}

/** 加载所有会话的运行状态（busy/idle/error） */
export async function loadSessionStatuses() {
    try {
        return await api.OpenCodeCall('GET', '/session/status') || {};
    } catch {
        return {};
    }
}

/** 会话缓存版本自增：SSE 更新消息缓存时调用，供 Tab 切回判断是否需要重建 DOM */
export function bumpTabCacheVersion(sessionID) {
    if (sessionID) store.tabCacheVersion[sessionID] = (store.tabCacheVersion[sessionID] || 0) + 1;
}

/** 切换会话（转发到 selectSession） */
export async function switchSession(id) { await selectSession(id); }
