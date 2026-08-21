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

// ============================
// SSE 事件处理
// ============================

/** EventSource 断线重连计数（浏览器模式；Wails 模式经 runtime 事件自动重连） */
let reconnectAttempts = 0;

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
            // SSE 断开 → 交叉验证：调 GetWebStatus() 确认服务是否真停了
            // 若在线 → 自动重连 SSE；若离线 → 更新 UI 状态
            //setTimeout(() => checkWebStatus(), 200);
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
        es.onerror = () => {
            if (es.readyState === EventSource.CLOSED) {
                showToast('事件流连接已断开，请刷新页面', 'error');
            } else {
                reconnectAttempts++;
                if (reconnectAttempts >= 3) {
                    showToast('事件流异常，正在自动重连...', 'warning');
                    reconnectAttempts = 0; // 重置，防止持续弹框
                }
            }
        };
    }
    if (api.StartOpenCodeEvents) api.StartOpenCodeEvents();
}

/** 主事件处理中枢：按 type 分发到缓存、渲染、会话、树、面板等模块 */
export function handleOcEvent(event) {
    const type = event.type || event.name || '';
    const props = event.properties || event.data || event;
    const sid = props.sessionID || props.sessionId || props.info?.sessionID || props.part?.sessionID || store.currentSessionId;

    if (type === 'server.connected' || type === 'server.heartbeat') return;

    if (type.includes('permission')) {
        const permission = props.permission ? { ...props.permission, ...props } : props;
        const kind = permission.permission || permission.type || 'tool';
        showToast('权限请求: ' + escapeHtml(kind), 'warning');
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
