// ============================================================
// chat-events.js — SSE 事件流处理
// 负责 SSE 连接建立、事件分发解析、事件处理逻辑
// 依赖：core/state.js、core/utils.js（showToast, escapeHtml, getCachedMessages, safeText、
//       loadMessages, refreshSessionTitle, selectSession, loadAgentModelSelectors, notePromptActivity、
//       buildTree, wasSessionDeletedLocally 等注册中心入口）、core/apicall.js（api）、
//       chat/render.js（updateSendButton）、chat/cache.js（scheduleRenderCachedMessages, upsertMessage 等）、
//       chat/sidepanel.js（scheduleSubtaskExtraction）、chat/permission.js
// 解环说明：原先静态 import chat/session.js 与 chat/tree.js 造成循环依赖，
//           现改为经 core/utils.js 注册中心间接调用（实现由 session.js / tree.js 注册）。
// ============================================================

import { store, currentDir } from '../core/state.js';
import { api } from '../core/apicall.js';
import { showToast, escapeHtml, getCachedMessages, safeText, isDesktopRuntime, loadWailsRuntime, refreshServiceStatus, loadMessages, refreshSessionTitle, selectSession, loadAgentModelSelectors, notePromptActivity, buildTree, wasSessionDeletedLocally } from '../core/utils.js';
import { setSessionStatus, isBusyStatus } from './render.js';
import { scheduleRenderCachedMessages, upsertMessage, upsertPart, applyPartDelta, removePart, removeMessage } from './cache.js';
import { scheduleSubtaskExtraction } from './sidepanel.js';
import { showPermissionRequest, closePermissionModal } from './permission.js';
import { adaptEvent, normalizeStatuses } from '../core/v2compat.js';

// ============================
// SSE 事件处理
// ============================

/** EventSource 断线重连计数（浏览器模式；Wails 模式经 runtime 事件自动重连） */
let reconnectAttempts = 0;
/** 当前页面是否成功连接过事件流；连接对象重建时保留，确保恢复后补拉消息与状态。 */
let browserSseEverConnected = false;

// ============================
// 事件流自愈
// ============================
// 后端 forwardEvents 已带指数退避重连；前端保留一层兜底：
// 收到 oc-event-error 时复位 backendStarted 并延迟重建，避免后端协程
// 因异常退出后前端一直认为「已启动」而永久收不到事件。
let eventRecoveryAttempts = 0;
let eventRecoveryTimer = 0;

/** 收到任意事件即视为链路恢复：清空重试计数与待执行的重建定时器 */
function resetEventRecovery() {
    if (eventRecoveryAttempts === 0 && !eventRecoveryTimer) return;
    eventRecoveryAttempts = 0;
    if (eventRecoveryTimer) {
        clearTimeout(eventRecoveryTimer);
        eventRecoveryTimer = 0;
    }
}

/** 事件流异常后的兜底重建：2s / 4s / 8s，最多 3 次 */
function scheduleEventStreamRecovery() {
    if (eventRecoveryTimer || eventRecoveryAttempts >= 3) return;
    const delay = 2000 * Math.pow(2, eventRecoveryAttempts);
    eventRecoveryAttempts++;
    eventRecoveryTimer = setTimeout(function() {
        eventRecoveryTimer = 0;
        // 后端协程异常退出时 backendStarted 仍是 true，必须复位才会重新调用
        startEventStream.backendStarted = false;
        startEventStream();
    }, delay);
}

/**
 * v2 事件入口：把 OpenCode v2 的事件翻译成 v1 形态后逐条交给既有分发器。
 * 一条 v2 事件可能对应多条 v1 事件（如 user 入队同时产生消息与正文 part）。
 */
function dispatchV2Event(v2event) {
    const v2type = v2event && v2event.type;
    const v2sid = v2event && v2event.data && v2event.data.sessionID;
    // 活动事件推断 busy：服务端不一定在“开始执行”时发 session.status（旁观客户端
    // 打开会话后其它客户端才发起执行时尤其明显）。收到属于该会话的任意执行活动，
    // 即视为运行中——让 Web 端/多客户端不依赖轮询也能同步按钮。
    // 终止事件（execution.succeeded/failed/interrupted）不在 isBusyActivityEvent 内，
    // 由 adaptEvent 转成 idle/error 后再清除状态。
    if (v2sid && isBusyActivityEvent(v2type)) {
        setSessionStatus(v2sid, 'busy', 'activity');
    }
    const v1events = adaptEvent(v2event);
    for (const e of v1events) handleOcEvent(e);
    // 任何模型/agent 活动都说明本次发送没有石沉大海：刷新无响应看门狗的基线
    // （基线由 session.js 的发送流程维护，只认本次发送会话的事件，超时后才会提示）。
    if (isPromptActivityEvent(v2type)) {
        notePromptActivity(v2sid);
    }
}

/** 是否表示会话正在执行的活动事件（用于旁观客户端推断 busy）。
 *  不含 execution.succeeded/failed/interrupted（终止事件，由 adaptEvent 转 idle/error）；
 *  不含 session.status（显式状态，由 handleOcEvent 按 event 来源写入）。 */
function isBusyActivityEvent(type) {
    if (type === 'session.inbox.enqueued' || type === 'session.execution.started') return true;
    return /^session\.(text|reasoning|tool|step)\./.test(type || '');
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

// ============================
// MCP 状态变更 → 服务面板防抖刷新
// ============================

/** MCP 事件触发刷新的防抖窗口（毫秒）。
 *  MCP 连接状态变化常连续到来（status/tools/resources 多个事件），
 *  窗口内的多次事件合并为一次刷新，避免每个事件都重拉 /api/mcp 与 /api/plugin。 */
const MCP_STATUS_REFRESH_DEBOUNCE_MS = 500;

/** 待执行的 MCP 刷新定时器句柄（单例：新事件到来即重置等待窗口） */
let mcpStatusRefreshTimer = 0;

/** 防抖刷新服务面板（MCP/插件状态）。
 *  经 core/utils.js 的注册中心调用 service.js 的加载实现（refreshServiceStatus），
 *  避免 events.js ↔ service.js 循环导入。 */
function scheduleMcpStatusRefresh() {
    if (mcpStatusRefreshTimer) clearTimeout(mcpStatusRefreshTimer);
    mcpStatusRefreshTimer = setTimeout(function() {
        mcpStatusRefreshTimer = 0;
        refreshServiceStatus();
    }, MCP_STATUS_REFRESH_DEBOUNCE_MS);
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
            rt.Events.On('oc-event', (ev) => {
                resetEventRecovery();
                dispatchV2Event(parseEventPayload(ev.data));
            });
            rt.Events.On('oc-event-error', (ev) => {
                showThrottledToast('es-error', '事件流异常: ' + ev.data, 'error');
                scheduleEventStreamRecovery();
            });
            // 后端重连成功（或浏览器端缓冲溢出）时通知补齐：
            // 断线期间的增量事件已丢失，必须全量拉一次，否则卡片停在残缺状态。
            rt.Events.On('sse-lagged', () => {
                showThrottledToast('es-lagged', '事件流已重连，正在补齐消息...', 'warning');
                loadMessages();
                // 断线期间可能丢了 idle 事件：同时用 active 快照纠偏当前会话状态
                refreshSessionStatusFromActive(store.currentSessionId);
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
        es.addEventListener('oc-event', (event) => {
            resetEventRecovery();
            dispatchV2Event(parseEventPayload(event.data));
        });
        es.addEventListener('oc-event-error', (event) => {
            showThrottledToast('es-error', '事件流异常: ' + (event.data || '连接已断开'), 'error');
            scheduleEventStreamRecovery();
        });
        // 服务端缓冲溢出、客户端即将被剔除前发来的显式通知：
        // 说明这段时间的事件已丢失，缓存可能残缺（缺正文/思考 part），
        // 必须主动全量补齐一次，否则界面会一直停在残缺状态。
        es.addEventListener('sse-lagged', () => {
            showThrottledToast('es-lagged', '事件流出现延迟，正在补齐消息...', 'warning');
            loadMessages();
            // 事件丢失后同时用 active 快照纠偏运行状态，避免按钮卡在错误状态
            refreshSessionStatusFromActive(store.currentSessionId);
        });
        es.onerror = () => {
            if (es.readyState === EventSource.CLOSED) {
                // 彻底关闭（不再自动重连）：丢弃该客户端，交给兜底逻辑重建 EventSource
                showThrottledToast('es-closed', '事件流连接已断开，正在重连...', 'error');
                if (startEventStream.eventSource === es) {
                    startEventStream.eventSource = null;
                }
                scheduleEventStreamRecovery();
            } else {
                reconnectAttempts++;
                if (reconnectAttempts >= 3) {
                    showThrottledToast('es-reconnecting', '事件流异常，正在自动重连...', 'warning');
                    reconnectAttempts = 0; // 重置，防止持续弹框
                }
            }
        };
        // 连接成功（含浏览器自动重连成功）时重置计数，避免计数只增不减导致误报
        es.onopen = () => {
            reconnectAttempts = 0;
            resetEventRecovery();
            // 重连成功：断线期间的事件已永久丢失，主动全量补齐一次，
            // 否则残缺缓存（缺 text part）会一直停留在界面上，而刷新又可能被在途锁跳过。
            // 首次连接不补齐（初始加载由会话选择/状态纠偏负责），避免无意义的重复请求。
            if (browserSseEverConnected) {
                loadMessages();
                // 重连后用 active 快照纠偏当前会话状态（丢 idle 时按钮会卡在「停止」）
                refreshSessionStatusFromActive(store.currentSessionId);
            }
            browserSseEverConnected = true;
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
    // 显式会话 ID：状态类事件必须使用它，不允许用 currentSessionId 兜底，
    // 否则多 Tab / 多客户端场景下会把 A 的状态写到 B 头上。
    const eventSid = props.sessionID || props.sessionId || props.info?.sessionID || props.part?.sessionID || '';
    const sid = eventSid || store.currentSessionId;

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

    // MCP 运行时状态变化（mcp.status.changed / mcp.tools.changed / mcp.resources.changed，
    // 载荷形如 {server:"wiz"}）：官方客户端会据此刷新 MCP 状态；这里防抖刷新服务面板，
    // 让「连接中 → 已连接/异常」以及重连/断开的结果自动呈现，不再需要手动点刷新。
    if (type === 'mcp.status.changed' || type === 'mcp.tools.changed' || type === 'mcp.resources.changed') {
        scheduleMcpStatusRefresh();
        return;
    }

    // 插件列表/状态变化（plugin.updated）：安装、卸载、重载插件后服务端会发出此事件，
    // 载荷形如 {id:"opencode-dcp"}。复用 MCP 的防抖刷新链（重新拉 /api/plugin 并重渲染服务面板），
    // 让插件面板不再依赖「MCP 重连顺带触发」这种间接路径，单独改插件也能即时反映。
    if (type === 'plugin.updated') {
        scheduleMcpStatusRefresh();
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

    if (type === 'session.error' && eventSid && props.error) {
        const message = typeof props.error === 'string' ? props.error : (props.error.message || safeText(props.error));
        store.sessionErrors[eventSid] = message;
        // 让失败立刻可见：消息区的错误卡片可能因「服务端尚未落 assistant 卡片」而没有宿主
        // （例如 execution.failed 早于任何 step），且自动重试会连续触发失败事件。
        // 用节流 toast 保证第一时刻有提示、又不刷屏；持久错误行由 render.js 兜底渲染。
        showThrottledToast('session-error-' + eventSid, '执行失败: ' + String(message).replace(/\s+/g, ' ').slice(0, 200), 'error');
        if (eventSid === store.currentSessionId) loadMessages();
        return;
    }
    if (type === 'session.status' && eventSid) {
        // v1 的 status 是字符串（'busy'/'idle'）；v2 可能是 {type:'running'}，
        // 统一交给 normalizeStatuses 归一，避免 isSessionBusy 认不出 running。
        // idle 属于终止信号（terminal）：立即采纳并清本地保护；
        // busy/retry 属于非终止事件（event）：遵守本地发送/停止的保护窗口。
        const normalized = normalizeStatuses({ [eventSid]: props.status || props })[eventSid];
        if (normalized != null) {
            if (isBusyStatus(normalized)) {
                setSessionStatus(eventSid, normalized, 'event');
            } else {
                setSessionStatus(eventSid, normalized, 'terminal');
            }
        }
        if (eventSid === store.currentSessionId) {
            const status = props.status || props;
            if (status?.type === 'idle') {
                loadMessages();
                refreshSessionTitle();
            } else if (getCachedMessages(eventSid).length) {
                scheduleRenderCachedMessages(eventSid);
                scheduleSubtaskExtraction(eventSid);
            } else {
                loadMessages();
            }
        }
        return;
    }
    if (type === 'session.idle' && eventSid) {
        delete store.sessionErrors[eventSid];
        setSessionStatus(eventSid, 'idle', 'terminal');
        if (eventSid === store.currentSessionId) {
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
        // 会话元信息变更——最常见的是服务端异步生成标题后推送。
        // 之前这里是空实现，导致新建会话的标题停在占位值：
        // 轮询可能已自行停止，事件又不处理，就再也没有更新时机。
        const updatedId = props.sessionID || props.sessionId || props.info?.id || props.id || sid;
        if (!updatedId || updatedId === store.currentSessionId) {
            refreshSessionTitle();
        } else if (props.info?.title || props.title) {
            // 非当前会话：直接落库，切回时即可显示真标题（不额外发请求）
            const title = props.info?.title || props.title;
            if (!store.sessionMap) store.sessionMap = {};
            if (!store.sessionMap[updatedId]) store.sessionMap[updatedId] = {};
            store.sessionMap[updatedId].title = title;
        }
        return;
    }
}

/** 加载所有会话的运行状态（busy/idle/error）
 *  v1 为 GET /session/status，v2 改为 GET /api/session/active。
 *  v2 的值是 {type:'running'} 且只列出活跃会话，由 normalizeStatuses 转成 v1 契约。
 *
 *  返回值语义必须区分两种情况：
 *   - 合法空快照 `{}`：服务端确认当前没有任何活跃会话 —— 目标会话缺 key 即空闲；
 *   - 请求失败 `null`：网络/服务异常，不能据此判定空闲。
 *  active 有登记/清除延迟，因此它只用于“打开会话/重连”时的纠偏，不参与发送/停止瞬间的判定。 */
export async function loadSessionStatuses() {
    try {
        return normalizeStatuses(await api.OpenCodeCall('GET', '/api/session/active'));
    } catch {
        return null;
    }
}

/** 打开会话时 active 登记延迟的重试间隔（毫秒）。
 *  只在“从列表首次打开会话”时使用，不是周期轮询；空闲会话最多多 3 次轻量 GET。 */
const STATUS_RETRY_DELAYS = [1500, 4000, 8000];

/** 用 active 快照纠偏单个会话（打开会话、SSE 重连时调用）。
 *  快照缺 key 说明该会话当前不活跃 ⇒ idle；请求失败（null）时保持现状，不误判。
 *  是否覆盖本地状态由 setSessionStatus 的 hold 规则决定：
 *  发送/停止后的保护窗口内，反向快照会被忽略，避免 active 延迟把按钮打回。
 *
 *  retryIfMissing：从列表首次打开会话时，active 的登记可能有延迟，第一次快照
 *  缺该会话不代表真的空闲。为 true 时按 STATUS_RETRY_DELAYS 再确认几次
 *  （仍只发生在“打开会话”这一时机，不引入周期轮询）。 */
export async function refreshSessionStatusFromActive(sessionID, retryIfMissing) {
    if (!sessionID) return;
    const statuses = await loadSessionStatuses();
    if (!statuses) return;
    const missing = statuses[sessionID] === undefined;
    setSessionStatus(sessionID, statuses[sessionID] ?? 'idle', 'snapshot');
    if (!missing || !retryIfMissing) return;
    STATUS_RETRY_DELAYS.forEach(function(delay) {
        setTimeout(function() {
            if (sessionID !== store.currentSessionId) return;
            loadSessionStatuses().then(function(next) {
                if (!next || sessionID !== store.currentSessionId) return;
                setSessionStatus(sessionID, next[sessionID] ?? 'idle', 'snapshot');
            });
        }, delay);
    });
}

/** 会话缓存版本自增：SSE 更新消息缓存时调用，供 Tab 切回判断是否需要重建 DOM */
export function bumpTabCacheVersion(sessionID) {
    if (sessionID) store.tabCacheVersion[sessionID] = (store.tabCacheVersion[sessionID] || 0) + 1;
}

/** 切换会话（转发到 selectSession） */
export async function switchSession(id) { await selectSession(id); }
