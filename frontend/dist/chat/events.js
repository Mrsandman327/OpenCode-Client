// ============================================================
// chat-events.js — SSE 事件流处理
// 负责 SSE 连接建立、事件分发解析、事件处理逻辑
// 依赖：core/state.js、core/utils.js（showToast, escapeHtml, getCachedMessages, safeText）、core/apicall.js（api）、
//       chat/session.js（loadMessages, refreshSessionTitle, selectSession）、
//       chat/render.js（updateSendButton）、chat/cache.js（scheduleRenderCachedMessages, upsertMessage 等）、
//       chat/sidepanel.js（scheduleSubtaskExtraction）、chat/tree.js（buildTree, wasSessionDeletedLocally）
// ============================================================

import { store, currentDir } from '../core/state.js';
import { api } from '../core/apicall.js';
import { showToast, escapeHtml, getCachedMessages, safeText, isDesktopRuntime, loadWailsRuntime } from '../core/utils.js';
import { loadMessages, refreshSessionTitle, selectSession, loadAgentModelSelectors, notePromptActivity } from './session.js';
import { updateSendButton } from './render.js';
import { scheduleRenderCachedMessages, upsertMessage, upsertPart, applyPartDelta, removePart, removeMessage } from './cache.js';
import { scheduleSubtaskExtraction } from './sidepanel.js';
import { buildTree, wasSessionDeletedLocally } from './tree.js';
import { showPermissionRequest, closePermissionModal } from './permission.js';
import { adaptEvent, normalizeStatuses } from '../core/v2compat.js';

// ============================
// SSE 事件处理
// ============================

/** EventSource 断线重连计数（浏览器模式；Wails 模式经 runtime 事件自动重连） */
let reconnectAttempts = 0;

/**
 * v2 事件入口：把 OpenCode v2 的事件翻译成 v1 形态后逐条交给既有分发器。
 * 一条 v2 事件可能对应多条 v1 事件（如 user 入队同时产生消息与正文 part）。
 */
function dispatchV2Event(v2event) {
    const v1events = adaptEvent(v2event);
    for (const e of v1events) handleOcEvent(e);
    // 任何模型/agent 活动都说明本次发送没有石沉大海：刷新无响应看门狗的基线
    // （基线由 session.js 的发送流程维护，只认本次发送会话的事件，超时后才会提示）。
    if (isPromptActivityEvent(v2event && v2event.type)) {
        notePromptActivity(v2event && v2event.data && v2event.data.sessionID);
    }
}

/** v2 事件是否代表「模型/agent 有活动」——用于取消发送后的无响应看门狗。
 *  含 text/reasoning/tool/step/execution 全系与重试计划；
 *  不含 inbox.enqueued（只证明服务端收下了消息，不证明模型可用）。 */
function isPromptActivityEvent(type) {
    if (type === 'session.inbox.delivered') return true;
    return /^session\.(text|reasoning|tool|step|execution|retry|usage)\./.test(type || '');
}

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

/** 解析 SSE 事件原始 JSON 载荷。
 *  v2 的事件是扁平的 {id, created, type, data, location?}，没有 v1 的 payload 包裹；
 *  目录字段也从 v1 的顶层 directory 变为 location.directory，这里统一补回 directory。 */
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
        if (event.location?.directory && !event.directory) {
            return { ...event, directory: event.location.directory };
        }
        return event;
    } catch { return { type: 'raw', data: raw }; }
}

/** 启动 SSE 事件流连接（Wails v3 事件 / 浏览器 EventSource 双模式） */
export function startEventStream() {
    if (isDesktopRuntime() && !startEventStream.bound) {
        // 桌面模式：订阅 wails3 运行时事件。
        // 回调参数为 WailsEvent 对象（{ name, data, sender }），业务载荷在 ev.data。
        startEventStream.bound = true;
        loadWailsRuntime().then((rt) => {
            rt.Events.On('oc-event', (ev) => dispatchV2Event(parseEventPayload(ev.data)));
            rt.Events.On('oc-event-error', (ev) => {
                showToast('事件流异常: ' + ev.data, 'error');
            });
        }).catch((err) => {
            // 加载失败时复位标记，使下次调用有机会重试
            startEventStream.bound = false;
            showToast('事件流初始化失败: ' + (err && err.message ? err.message : err), 'error');
        });
    }
    if (!isDesktopRuntime() && !startEventStream.eventSource) {
        const es = new EventSource('/events');
        startEventStream.eventSource = es;
        es.addEventListener('oc-event', (event) => dispatchV2Event(parseEventPayload(event.data)));
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

    // 模型/供应商目录变化：官方客户端在收到这些事件时会「invalidate + 重新 sync」
    // （见 opencode v2 源码 packages/client/src/solid/data.ts，model.updated / provider.updated /
    //  credential.* / integration.updated 分支）。这里做同样的重拉——这是获取模型列表的
    // 官方机制：初次拉取可能早于插件初始化完成（/api/model 官方描述即 "snapshot may precede
    //  initial plugin settlement"），靠事件驱动补齐；重拉只更新、不清空已有列表。
    if (type === 'model.updated' || type === 'provider.updated' ||
        type === 'credential.updated' || type === 'credential.switched' ||
        type === 'integration.updated') {
        loadAgentModelSelectors(currentDir(), true);
        return;
    }

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
        const message = typeof props.error === 'string' ? props.error : (props.error.message || safeText(props.error));
        store.sessionErrors[sid] = message;
        // 让失败立刻可见：消息区的错误卡片可能因「服务端尚未落 assistant 卡片」而没有宿主
        // （例如 execution.failed 早于任何 step），且自动重试会连续触发失败事件。
        // 用节流 toast 保证第一时刻有提示、又不刷屏；持久错误行由 render.js 兜底渲染。
        showThrottledToast('session-error-' + sid, '执行失败: ' + String(message).replace(/\s+/g, ' ').slice(0, 200), 'error');
        if (sid === store.currentSessionId) loadMessages();
        return;
    }
    if (type === 'session.status' && sid) {
        // v1 的 status 是字符串（'busy'/'idle'）；v2 可能是 {type:'running'}，
        // 统一交给 normalizeStatuses 归一，避免 isSessionBusy 认不出 running。
        store.sessionStatuses[sid] = normalizeStatuses({ [sid]: props.status || props })[sid];
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
    if (type === 'session.created') {
        // 新建会话必须刷新树：**不能**只在"它是当前会话"时才刷。
        // 事件可能在 store.currentSessionId 赋值之前到达（新建流程存在竞态），
        // 一旦被跳过，新建的会话就不会出现在项目树里。树重建很轻，无条件刷新即可。
        buildTree();
        return;
    }
    if (type === 'session.deleted') {
        // 严格取「被删的那个会话」的 ID，不能用上面那个 sid：
        // sid 的兜底是 store.currentSessionId，删的不是当前会话时会得到一个
        // 毫不相干的 ID。拿它去查「是否刚被本地删过」会误判，吞掉本该发生的重建。
        const deletedId = props.sessionID || props.sessionId || props.info?.sessionID || props.part?.sessionID || '';
        if (deletedId && wasSessionDeletedLocally(deletedId)) {
            // 树里该节点已被 deleteSession 直接摘掉，重建只会闪一下
            return;
        }
        buildTree();
        return;
    }
    if (type === 'session.updated') {
        // 会话更新事件：无需处理
    }
}

/** 加载所有会话的运行状态（busy/idle/error）
 *  v1 为 GET /session/status，v2 改为 GET /api/session/active。
 *  v2 的值是 {type:'running'} 且只列出活跃会话，由 normalizeStatuses 转成 v1 契约。 */
export async function loadSessionStatuses() {
    try {
        return normalizeStatuses(await api.OpenCodeCall('GET', '/api/session/active'));
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
