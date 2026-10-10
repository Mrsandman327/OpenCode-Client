// ============================================================
// chat-sidepanel.js — 右侧面板（Diff + 子任务 + 代办）
// 依赖：core/state.js、core/utils.js（escapeHtml, showToast, getActiveMessagesEl, getCachedMessages,
//       normalizeMessageItem, isInternalUserMessage, safeText）、core/apicall.js（api）、
//       chat/render.js（renderPart, setRenderTodosHandler）
// ============================================================

import { api } from '../core/apicall.js';
import { store, currentDir } from '../core/state.js';
import { escapeHtml, showToast, getActiveMessagesEl, getCachedMessages, safeText, modelDisplayLabel, setTodoPanelRefreshHandler, copyToClipboard, bindOverlayClose } from '../core/utils.js';
import { adaptMessages, formatApiError, unwrapList, nextCursor } from '../core/v2compat.js';
// 时间格式化统一走 core/format.js
import { formatSubtaskDuration, formatMinuteTime } from '../core/format.js';
import { renderPart, setRenderTodosHandler } from './render.js';

// 向 render.js 注入"消息渲染完成后刷新代办面板"的回调（sidepanel→render 单向依赖，无环）。
// 同时向 core 层注册"待办面板刷新"入口：service.js 检测到待办插件加载/卸载后会触发，
// 使代办分区的显隐立即生效（不必等待下一次消息渲染）。
// renderTodos 定义于本文件下方（函数声明提升）。
// 注意：session→tabs→events→session 仍存在跨模块环（顶层均无立即跨模块调用，运行时函数调用安全），
// 且 sidepanel 被 session 依赖、又依赖 render——渲染期注入仍需延迟到微任务，避免模块初始化 TDZ。
queueMicrotask(() => {
    setRenderTodosHandler(renderTodos);
    setTodoPanelRefreshHandler(renderTodos);
});

// ============================
// 代办事项 — 从消息中提取并渲染
// ============================

// 代办事项所用的工具名。
// v1 有内置的 todowrite 工具；v2 的官方工具清单里已无该工具
// （Files / Commands / Web / Interaction / Automation / Browser 都没有），
// 故 v2 下本面板无数据来源。此处仍兼容识别，以便混合版本或
// 用户自定义同名工具时仍能工作。
const TODO_TOOL_NAMES = ['todowrite', 'todo_write', 'todo'];

/** 从当前会话的缓存消息中提取代办事项列表 */
export function extractTodos() {
    const items = getCachedMessages(store.currentSessionId);
    if (!items.length) return [];
    for (let i = items.length - 1; i >= 0; i--) {
        const info = items[i].info || items[i];
        if (info.role !== 'assistant') continue;
        const parts = items[i].parts || [];
        for (let j = parts.length - 1; j >= 0; j--) {
            const part = parts[j];
            if (part.type !== 'tool') continue;
            const toolName = part.tool || part.name || '';
            if (!TODO_TOOL_NAMES.includes(toolName)) continue;
            const state = part.state || {};
            // v1 放在 state.input.todos；兼容 state.todos 与 v2 的 content 形态
            const todos = (state.input && state.input.todos)
                || state.todos
                || (Array.isArray(state.content) ? state.content : null);
            if (Array.isArray(todos)) return todos;
        }
    }
    return [];
}

/** 渲染代办事项面板
 *
 *  显隐由 store.todoSupported 驱动（整块分区隐藏，含标题，而不是渲染占位）：
 *  OpenCode v2 自身已无 todowrite 工具，该开关由 service.js 根据「配套待办插件
 *  （plugins/manager-todo.ts，提供 todo_write 工具）是否已加载」动态更新
 *  ——插件在 → true 显示；未装 / 无目录 / 服务停止 → false 隐藏。
 *  数据来源：模型调用 todo_write 后，从会话消息中提取 state.input.todos
 *  （见 extractTodos）；刷新时机：消息渲染后（render.js 回调）与插件状态变化后
 *  （service.js 经 core/utils.js 的刷新通道）。 */
export function renderTodos() {
    const box = document.getElementById('ocTodos');
    if (!box) return;

    const section = document.getElementById('todoPanelSection');
    if (section) {
        section.style.display = store.todoSupported === false ? 'none' : '';
    }
    if (store.todoSupported === false) {
        return;
    }

    const todos = extractTodos();
    if (!todos.length) {
        box.innerHTML = '<div class="oc-empty">会话中暂无代办</div>';
        return;
    }
    const active = todos.filter(t => t.status !== 'completed' && t.status !== 'cancelled');
    const completed = todos.filter(t => t.status === 'completed' || t.status === 'cancelled');
    if (!active.length && !completed.length) {
        box.innerHTML = '<div class="oc-empty">会话中暂无代办</div>';
        return;
    }

    let html = '';
    const priorityClass = { high: 'pri-high', medium: 'pri-medium', low: 'pri-low' };

    if (active.length) {
        html += '<div class="oc-todo-group"><div class="oc-todo-group-label">进行中</div>';
        active.forEach(t => {
            const pri = priorityClass[t.priority] || '';
            html += `<div class="oc-todo-item ${pri}" title="${escapeHtml(t.content)}">`;
            html += `<span class="oc-todo-check" data-content="${escapeHtml(t.content)}"></span>`;
            html += `<span class="oc-todo-text">${escapeHtml(t.content)}</span>`;
            html += `</div>`;
        });
        html += '</div>';
    }

    if (completed.length) {
        html += '<div class="oc-todo-group"><div class="oc-todo-group-label">已完成</div>';
        completed.forEach(t => {
            const pri = priorityClass[t.priority] || '';
            html += `<div class="oc-todo-item done ${pri}" title="${escapeHtml(t.content)}">`;
            html += `<span class="oc-todo-check">✓</span>`;
            html += `<span class="oc-todo-text">${escapeHtml(t.content)}</span>`;
            html += `</div>`;
        });
        html += '</div>';
    }

    box.innerHTML = html;
}


// ============================================================
// 子任务面板 — 数据源：服务端 child sessions 列表
// 原实现扫描「消息缓存」里的 subagent/task tool parts，先天不足：
//   1) 打开会话只拉最近 20 条消息（loadMessages），最近 20 条里没有 subagent 时
//      面板为空——即使会话历史里有大量子任务；
//   2) 滚动加载更早消息（loadOlderMessages）写入缓存后不会触发重新提取；
//   3) 只有发送消息后的 SSE 流事件才重新提取，导致「发消息后历史子任务突然出现」。
// 现改为直接查询服务端 child sessions 列表（GET /api/session?parentID=，权威全量、
// 一次一请求按游标翻页），与消息缓存彻底解耦。
// ============================================================

/** 子任务列表拉取节流窗口（毫秒）：消息 part 的 SSE 事件高频到来，
 *  面板数据源改为网络请求后必须节流合并，避免请求风暴。 */
const SUBTASK_REFRESH_THROTTLE_MS = 900;

/** 子任务列表翻页上限（防御服务端游标异常导致死循环；默认 50 条/页，5 页 = 250 条） */
const SUBTASK_MAX_PAGES = 5;

/** 面板刷新节流状态：上次发起请求时间 / 请求在途 / 有待执行的新一轮刷新 / 等待定时器句柄 */
let subtaskRefreshLastAt = 0;
let subtaskRefreshInFlight = false;
let subtaskRefreshQueued = false;
let subtaskRefreshTimer = 0;
/** 面板刷新轮次序号：用于丢弃过期请求的结果（快速切会话 / 连续刷新时） */
let subtaskPanelRefreshSeq = 0;

/** child session 的 outcome → 面板状态键（renderSubtaskCard/fillModalSummary 使用）：
 *  服务端仅提供 succeeded / failed / interrupted；进行中的子任务没有 outcome 字段。 */
const CHILD_SESSION_STATUS_MAP = {
    succeeded: 'completed',
    failed: 'error',
    interrupted: 'interrupt',
};

/** 把服务端 child session 数组归一化为面板卡片摘要（纯函数，便于单测）。
 *  字段逐一对应 renderSubtaskCard / fillModalSummary 的读取项：
 *  - childSessionId/title/agent/model/status/durationMs 来自列表字段；
 *  - 列表没有消息上下文（parentMessageId/taskPartId）与输入输出预览，置空串——
 *    卡片点击改走「消息缓存反查」（findCachedSubtaskPart）定位父消息，
 *    反查未命中时打开详情弹窗兜底，不再依赖这两个字段（见 onSubtaskCardClick）。
 *  输出顺序：按 time.updated 升序（旧→新，最新在最下面）。 */
export function mapChildSessionsToSummaries(list) {
    const children = Array.isArray(list) ? list : [];
    // 面板排序：按 time.updated 升序（旧在上、**最新在最下面**——用户明确要求）。
    // 缺 time.updated 的项以 0 参与比较（排最前）；slice() 复制副本，避免修改调用方数组。
    const sorted = children.slice().sort((a, b) => (Number(a?.time?.updated) || 0) - (Number(b?.time?.updated) || 0));
    return sorted.map(s => {
        const created = Number(s?.time?.created);
        const updated = Number(s?.time?.updated);
        const hasTime = Number.isFinite(created) && Number.isFinite(updated);
        const providerID = s?.model?.providerID || '';
        const modelID = s?.model?.id || '';
        const modelRef = (providerID && modelID) ? (providerID + '/' + modelID) : '';
        return {
            childSessionId: s?.id || '',
            title: s?.title || '未知任务',
            description: '',
            agent: s?.agent || 'unknown',
            model: modelRef ? modelDisplayLabel(modelRef) : 'unknown',
            status: CHILD_SESSION_STATUS_MAP[s?.outcome] || 'running',
            durationMs: hasTime ? (updated - created) : null,
            interrupted: s?.outcome === 'interrupted',
            startedAt: hasTime ? created : null,
            endedAt: hasTime ? updated : null,
            outputPreview: '',
            promptPreview: '',
            parentMessageId: '',
            taskPartId: '',
        };
    });
}

/** 取子任务查询所需的当前会话目录：优先现有目录来源（store.sessionMap 等，见 currentDir()），
 *  拿不到时兜底请求会话详情的 location.directory。
 *  返回空串时调用方必须跳过请求——child sessions 查询缺 location 会回落到服务端进程
 *  CWD（共享服务为 home）并把该目录误登记成项目。 */
async function resolveSubtaskDirectory(sessionId) {
    const dir = currentDir();
    if (dir) return dir;
    try {
        const res = await api.OpenCodeCall('GET', '/api/session/' + encodeURIComponent(sessionId));
        const data = (res && typeof res === 'object' && 'data' in res && res.data && typeof res.data === 'object')
            ? res.data
            : res;
        const directory = data && data.location && data.location.directory;
        return typeof directory === 'string' ? directory.trim() : '';
    } catch (_) {
        return '';
    }
}

/** 拉取某父会话的全部 child sessions（服务端权威列表；按游标翻页，上限 SUBTASK_MAX_PAGES 页防御）。
 *  响应形如 {data:[...], cursor:{next}}；实测数据已尽时仍可能签发 next，故「空页」同样终止翻页。 */
async function fetchChildSessions(directory, parentSessionId) {
    const all = [];
    let cursor = '';
    for (let page = 0; page < SUBTASK_MAX_PAGES; page++) {
        let path = '/api/session?parentID=' + encodeURIComponent(parentSessionId);
        if (cursor) path += '&cursor=' + encodeURIComponent(cursor);
        // 第 4 参由 api.OpenCodeCall 统一追加 location[directory]（与 service.js 的调用风格一致）
        const res = await api.OpenCodeCall('GET', path, null, directory);
        const list = unwrapList(res);
        if (!list.length) break; // 空页 = 已到末尾
        all.push(...list);
        cursor = nextCursor(res) || '';
        if (!cursor) break;
    }
    return all;
}

/** 刷新子任务面板：拉取并渲染当前会话的 child sessions 列表。
 *  调用方：会话打开/切换/刷新（session.js、tabs.js）与节流调度（scheduleSubtaskExtraction）。
 *  失败静默：请求异常时保留面板现状（仅 console 记录），不弹 toast。 */
export async function refreshSubtaskPanel() {
    const sessionId = store.currentSessionId;
    // 服务未运行 / 未选择会话：沿用既有空态（清空数据并渲染）
    if (!store.webRunning || !sessionId) {
        store.subtaskSummaries = [];
        renderSubtaskPanel();
        return;
    }
    const seq = ++subtaskPanelRefreshSeq;
    try {
        const dir = await resolveSubtaskDirectory(sessionId);
        if (!dir) return; // 无目录不请求（避免服务端回落到 CWD=home）
        const children = await fetchChildSessions(dir, sessionId);
        // 竞态保护：结果返回时刷新目标已变化（切了会话 / 又发起了新一轮刷新）→ 丢弃本次结果
        if (seq !== subtaskPanelRefreshSeq || sessionId !== store.currentSessionId) return;
        store.subtaskSummaries = mapChildSessionsToSummaries(children);
        renderSubtaskPanel();
    } catch (err) {
        console.warn('刷新子任务面板失败（保留面板现状）:', err);
    }
}

/** 标记「面板需要刷新」，按节流窗口择机发起（合并高频事件） */
function queueSubtaskPanelRefresh() {
    subtaskRefreshQueued = true;
    flushSubtaskPanelRefresh();
}

/** 尝试消耗「待刷新」标记：满足「无在途请求 + 距上次请求超过节流窗口」才真正发起；
 *  否则等窗口到期（定时器）或当前请求结束（finally 回调）后再试，保证最后一次事件被拉取。 */
function flushSubtaskPanelRefresh() {
    if (!subtaskRefreshQueued || subtaskRefreshInFlight) return;
    const wait = SUBTASK_REFRESH_THROTTLE_MS - (Date.now() - subtaskRefreshLastAt);
    if (wait > 0) {
        if (!subtaskRefreshTimer) {
            subtaskRefreshTimer = setTimeout(() => {
                subtaskRefreshTimer = 0;
                flushSubtaskPanelRefresh();
            }, wait);
        }
        return;
    }
    subtaskRefreshQueued = false;
    subtaskRefreshInFlight = true;
    subtaskRefreshLastAt = Date.now();
    refreshSubtaskPanel().finally(() => {
        subtaskRefreshInFlight = false;
        flushSubtaskPanelRefresh(); // 在途期间又收到事件 → 尾随补拉一次
    });
}

/** 调度子任务面板刷新到下一帧（对 events.js 的调用点保持原语义：传入会话 ID）。
 *  相对旧实现的唯一变化：数据源从「消息缓存扫描」改为「服务端 child sessions 拉取」，
 *  因此叠加了请求节流（见 queueSubtaskPanelRefresh），避免消息 part 高频事件轰炸 API。 */
export function scheduleSubtaskExtraction(sessionID) {
    if (!sessionID || sessionID !== store.currentSessionId) return;
    if (store.subtaskExtractionPending) return;
    store.subtaskExtractionPending = true;
    store.subtaskExtractionFrame = requestAnimationFrame(() => {
        store.subtaskExtractionFrame = 0;
        store.subtaskExtractionPending = false;
        queueSubtaskPanelRefresh();
    });
}

/** 渲染子任务面板 */
export function renderSubtaskPanel() {
    const box = document.getElementById('ocSubtasks');
    if (!box) return;
    if (!store.webRunning || !store.currentSessionId) {
        box.innerHTML = '<div class="oc-empty">启动服务并选择会话后查看子任务</div>';
        return;
    }
    if (!store.subtaskSummaries.length) {
        box.innerHTML = '<div class="oc-empty">当前会话暂无子任务<br><small>子任务会在主会话触发 task 工具后显示在这里</small></div>';
        return;
    }
    let html = '';
    store.subtaskSummaries.forEach((s, idx) => {
        html += renderSubtaskCard(s, idx);
    });
    box.innerHTML = html;
    attachSubtaskCardEvents();
}

/** 渲染单张子任务卡片 */
export function renderSubtaskCard(s, idx) {
    const statusClass = 'status-' + (s.status || 'pending');
    const statusLabels = { completed: '已完成', running: '运行中', error: '失败', interrupt: '已中断', pending: '等待中' };
    const statusLabel = statusLabels[s.status] || s.status || '未知';
    const durationText = s.durationMs != null ? formatSubtaskDuration(s.durationMs) : (s.status === 'running' ? '运行中…' : '—');

    return '<div class="oc-subtask-card ' + statusClass + '" data-index="' + idx + '" data-parent-message-id="' + escapeHtml(s.parentMessageId) + '" data-child-session-id="' + escapeHtml(s.childSessionId || '') + '">'
        + '<div style="display:flex;justify-content:space-between;align-items:center">'
        + '<span class="oc-subtask-card-title" title="' + escapeHtml(s.title) + '">' + escapeHtml(s.title) + '</span>'
        + '<span class="oc-subtask-status-badge status-' + escapeHtml(s.status || 'pending') + '">' + statusLabel + '</span>'
        + '</div>'
        + '<div class="oc-subtask-card-meta">' + escapeHtml(s.agent) + ' · ' + escapeHtml(s.model) + '</div>'
        + '<div class="oc-subtask-card-footer">'
        + '<span>' + durationText + '</span>'
        + '<button class="btn btn-sm oc-subtask-detail-btn" data-index="' + idx + '" ' + (s.childSessionId ? '' : 'disabled') + '>详情</button>'
        + '</div>'
        + '</div>';
}

/** 绑定子任务卡片事件 */
export function attachSubtaskCardEvents() {
    const box = document.getElementById('ocSubtasks');
    if (!box) return;
    box.removeEventListener('click', onSubtaskCardClick);
    box.addEventListener('click', onSubtaskCardClick);
}

/** 子任务工具名（消息缓存反查用）：v1 为 task，v2 为 subagent。 */
const SUBTASK_TOOL_NAMES = ['subagent', 'task'];

/** 判断单个 part 是否为指定子会话的 subagent/task 工具调用（纯函数，便于单测）。
 *  metadata 兼容两种形态：state.metadata（历史适配层）、part.metadata（部分实时事件）。 */
export function matchSubtaskPart(part, childId) {
    if (!part || part.type !== 'tool') return false;
    const toolName = part.tool || part.name || '';
    if (!SUBTASK_TOOL_NAMES.includes(toolName)) return false;
    if (!childId) return false;
    const meta = (part.state && part.state.metadata) || part.metadata || {};
    return !!meta && meta.sessionID === childId;
}

/** 在当前会话已加载的消息缓存中反查 childSessionId 对应的子任务工具 part。
 *  从后往前扫（最新的调用优先命中）。命中返回 { parentMessageId, taskPartId }；
 *  缓存中不存在（消息未加载）返回 null——调用方不得触发历史加载，改走弹窗兜底。 */
export function findCachedSubtaskPart(childSessionId) {
    if (!childSessionId) return null;
    const items = getCachedMessages(store.currentSessionId);
    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i] || {};
        const info = item.info || item;
        const parts = Array.isArray(item.parts) ? item.parts : [];
        for (let j = parts.length - 1; j >= 0; j--) {
            if (!matchSubtaskPart(parts[j], childSessionId)) continue;
            return {
                parentMessageId: info.id || '',
                taskPartId: parts[j].id || '',
            };
        }
    }
    return null;
}

/** 子任务卡片点击处理 */
export function onSubtaskCardClick(e) {
    const detailBtn = e.target.closest('.oc-subtask-detail-btn');
    if (detailBtn) {
        e.stopPropagation();
        const idx = parseInt(detailBtn.dataset.index);
        if (isNaN(idx) || !store.subtaskSummaries[idx]) return;
        const summary = store.subtaskSummaries[idx];
        if (summary.childSessionId) {
            openSubtaskModal(summary.childSessionId, summary);
        }
        return;
    }
    // 卡片本身点击 → 定位优先（仅缓存反查，不自动加载历史）：
    // 1) 在已加载的消息缓存里反查该子会话对应的 subagent/task tool part；
    // 2) 命中且 DOM 中存在对应父消息 → 滚动定位（locateParentMessage 返回 true）；
    // 3) 未命中（消息未加载进缓存 / 缓存有但 DOM 无）→ 打开子会话详情弹窗兜底。
    const card = e.target.closest('.oc-subtask-card');
    if (!card) return;
    const childId = card.dataset.childSessionId;
    if (!childId) return; // 无子会话 id（防御）：维持无操作
    const hit = findCachedSubtaskPart(childId);
    if (hit && locateParentMessage(hit.parentMessageId)) return;
    const summary = store.subtaskSummaries.find(s => s.childSessionId === childId) || null;
    openSubtaskModal(childId, summary);
}

/** 定位到父消息在消息列表中的位置。
 *  返回是否命中：主分支按 data-message-id 精确查询；fallback 分支按子任务摘要
 *  的 parentMessageId/taskPartId 匹配（兼容「消息卡片无父消息 id、但有 part id」的来源；
 *  列表数据源下 parentMessageId 为空串，该分支不命中，仅作历史兼容保留）。
 *  目标消息不在 DOM（未加载）时返回 false，由调用方决定兜底动作。 */
export function locateParentMessage(msgId) {
    const box = getActiveMessagesEl();
    if (!box) return false;
    const old = box.querySelectorAll('.oc-message.highlight');
    old.forEach(el => el.classList.remove('highlight'));
    let target = null;
    if (msgId) {
        target = box.querySelector('.oc-message[data-message-id="' + msgId + '"]');
    }
    if (!target && msgId) {
        const allMsgs = box.querySelectorAll('.oc-message');
        for (let i = allMsgs.length - 1; i >= 0; i--) {
            const partIds = allMsgs[i].querySelectorAll('[data-part-id]');
            for (const p of partIds) {
                if (store.subtaskSummaries.some(s => s.parentMessageId === msgId && s.taskPartId === p.dataset.partId)) {
                    target = allMsgs[i];
                    break;
                }
            }
            if (target) break;
        }
    }
    if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('highlight');
        setTimeout(() => target.classList.remove('highlight'), 2500);
        return true;
    }
    return false;
}

/** 打开子任务详情弹窗 */
export function openSubtaskModal(childSessionId, subtaskSummary) {
    const modal = document.getElementById('subtaskModal');
    if (!modal) return;
    if (subtaskSummary) fillModalSummary(subtaskSummary);

    const msgBox = document.getElementById('subtaskMessages');
    if (msgBox) msgBox.innerHTML = '<div class="oc-loading" style="padding:40px;text-align:center"><div class="spinner"></div><p>正在加载子任务详情...</p></div>';

    modal.style.display = 'flex';
    loadSubtaskDetailMessages(childSessionId);
    bindSubtaskModalEvents();
}

/** 关闭子任务详情弹窗 */
export function closeSubtaskModal() {
    const modal = document.getElementById('subtaskModal');
    if (modal) modal.style.display = 'none';
    if (document.activeElement && document.activeElement.closest('#subtaskModal')) {
        const promptEl = document.getElementById('ocPrompt');
        if (promptEl) promptEl.focus();
    }
}

/** 绑定子任务详情弹窗事件 */
export function bindSubtaskModalEvents() {
    const modal = document.getElementById('subtaskModal');
    if (!modal || modal.dataset.eventsBound === '1') return;

    // 仅当按下与松开都在遮罩上才关闭（避免弹窗内拖选误关）
    bindOverlayClose(modal, closeSubtaskModal);
    document.getElementById('subtaskModalCloseBtn')?.addEventListener('click', closeSubtaskModal);
    document.getElementById('subtaskModalCancelBtn')?.addEventListener('click', closeSubtaskModal);

    const promptToggle = document.getElementById('subtaskPromptToggle');
    const promptText = document.getElementById('subtaskPromptText');
    if (promptToggle && promptText) {
        promptToggle.addEventListener('click', () => {
            const hidden = promptText.style.display === 'none';
            promptText.style.display = hidden ? '' : 'none';
            promptToggle.textContent = hidden ? '收起原始任务' : '展开原始任务';
        });
    }

    const copyBtn = document.getElementById('subtaskCopySid');
    copyBtn?.addEventListener('click', async () => {
        const sid = document.getElementById('subtaskSid')?.textContent || '';
        if (!sid) return;
        try {
            await copyToClipboard(sid);
            showToast('已复制: ' + sid, 'success');
        } catch (_) {
            showToast('复制失败', 'error');
        }
    });

    document.addEventListener('keydown', onSubtaskModalKey);
    modal.dataset.eventsBound = '1';
}

/** 子任务弹窗键盘事件（Esc 关闭） */
export function onSubtaskModalKey(e) {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('subtaskModal');
    if (modal && modal.style.display === 'flex') closeSubtaskModal();
}

/** 填充子任务弹窗摘要信息 */
export function fillModalSummary(s) {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };
    const setHtml = (id, val) => { const el = document.getElementById(id); if (el) el.innerHTML = val || '—'; };

    document.getElementById('subtaskModalTitle').textContent = s.title || '子任务详情';
    set('subtaskTitle', s.title);
    setHtml('subtaskAgent', escapeHtml(s.agent || '—'));
    setHtml('subtaskModel', escapeHtml(s.model || '—'));

    const duration = s.durationMs != null ? formatSubtaskDuration(s.durationMs) : (s.status === 'running' ? '运行中…' : '—');
    set('subtaskDuration', duration);
    set('subtaskStarted', formatMinuteTime(s.startedAt));
    set('subtaskEnded', formatMinuteTime(s.endedAt));

    const desc = s.description || '';
    const descRow = document.getElementById('subtaskDescRow');
    if (descRow) descRow.style.display = desc ? '' : 'none';
    set('subtaskDesc', desc);

    const prompt = s.promptPreview || '';
    const promptCollapse = document.querySelector('.subtask-prompt-collapse');
    if (promptCollapse) promptCollapse.style.display = prompt ? '' : 'none';
    set('subtaskPromptText', prompt);

    set('subtaskSid', s.childSessionId || '');

    const statusLabels = { completed: '已完成', running: '运行中', error: '失败', interrupt: '已中断', pending: '等待中' };
    const statusLabel = statusLabels[s.status] || s.status || '未知';
    const updateBadge = (el, text, st) => {
        if (!el) return;
        el.textContent = text;
        el.dataset.status = st;
    };
    updateBadge(document.getElementById('subtaskStatusBadge'), statusLabel, s.status);
    updateBadge(document.getElementById('subtaskStatusBadge2'), statusLabel, s.status);
}

/** 加载子任务详情消息 */
export async function loadSubtaskDetailMessages(childSessionId) {
    if (!childSessionId) return;
    if (store.detailLoading[childSessionId]) return;
    store.detailLoading[childSessionId] = true;
    const msgBox = document.getElementById('subtaskMessages');
    const thisSeq = ++store.detailMessageLoadSeq;

    try {
        const res = await api.OpenCodeCall('GET', '/api/session/' + encodeURIComponent(childSessionId) + '/message');
        if (thisSeq !== store.detailMessageLoadSeq) return;

        // v2 返回 {data:[扁平消息], cursor}，需还原为 v1 的 [{info,parts}] 且按旧→新排列
        const items = adaptMessages(childSessionId, res);
        if (!items.length) {
            if (msgBox) msgBox.innerHTML = '<div class="oc-empty">子会话暂无消息</div>';
            return;
        }
        if (thisSeq !== store.detailMessageLoadSeq) return;
        renderDetailMessages(items);
    } catch (err) {
        if (thisSeq !== store.detailMessageLoadSeq) return;
        if (msgBox) msgBox.innerHTML = '<div class="oc-empty error">加载失败：' + escapeHtml(formatApiError(err) || '网络错误') + '</div>';
    } finally {
        store.detailLoading[childSessionId] = false;
    }
}

/** 渲染子任务详情消息列表 */
export function renderDetailMessages(items) {
    const box = document.getElementById('subtaskMessages');
    if (!box) return;
    box.innerHTML = '';
    (items || []).forEach(item => {
        const info = item.info || item;
        const role = info.role || 'message';
        const displayRole = role === 'user' ? '子任务输入' : (role === 'assistant' ? '助手' : role);
        const parts = item.parts || [];
        const node = document.createElement('div');
        node.className = 'oc-message ' + role;
        node.innerHTML = '<div class="oc-message-role">' + escapeHtml(displayRole) + '</div>';
        const body = document.createElement('div');
        body.className = 'oc-message-parts';
        const partList = Array.isArray(parts) ? parts : [parts];
        if (partList.length) {
            partList.forEach(part => {
                const partEl = renderDetailPart(part);
                if (partEl) body.appendChild(partEl);
            });
        } else {
            const empty = document.createElement('div');
            empty.className = 'oc-part pending';
            empty.textContent = info.time?.completed ? '已停止或本次未产生回复内容' : '（空内容）';
            body.appendChild(empty);
        }
        node.appendChild(body);
        box.appendChild(node);
    });
}

/** 渲染子任务详情中的单个 part */
export function renderDetailPart(part) {
    const type = part?.type || '';
    if (type === 'tool' && (part.tool === 'question' || part.name === 'question')) {
        const saved = part.state ? { ...part.state } : null;
        if (part.state) part.state._readOnly = true;
        const el = renderPart(part);
        if (saved) part.state = saved;
        return el;
    }
    return renderPart(part);
}
