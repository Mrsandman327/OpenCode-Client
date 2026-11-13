// ============================================================
// chat-render.js — 消息渲染引擎
// 负责消息列表渲染、12 种 part 类型渲染器、滚动管理和模型信息同步
// 依赖：core/state.js、core/utils.js（escapeHtml, getActiveMessagesEl,
//       safeText, extractPartText, isInternalUserMessage, normalizeMessageItem）、core/apicall.js（api）、
//       chat/search.js（updateUserNav）
// 解环说明：renderTodos 由 sidepanel.js 通过 setRenderTodosHandler 回调注入；
//           updateModelInfo 由本文件实现、经 core/utils.js 注册中心暴露给 service/tree。
//           本文件不依赖 service/session/sidepanel，处于依赖链下游。
// ============================================================

import { store, currentDir } from '../core/state.js';
import { escapeHtml, getActiveMessagesEl, showToast, showApiError, safeText, extractPartText, isInternalUserMessage, normalizeMessageItem, setUpdateModelInfoHandler, modelDisplayLabel, resolveKnownValue, syncVariantSelect } from '../core/utils.js';
// Markdown 清洗统一走 core/sanitize.js 的白名单实现（含 href 协议校验）
import { sanitizeMarkedHtml } from '../core/sanitize.js';
// 本地图片：把 Markdown 里的 C:\... / file:// / 相对路径替换为 data URL
import { hydrateLocalImages } from '../core/local-images.js';
// 时间/数字格式化统一走 core/format.js
import { formatToolDuration, formatCompactNumber, formatDateTime } from '../core/format.js';
// isInternalInstructionMessage：识别服务端注入的内部指令/合成消息（如 "Instructions updated:" 的
// Code Mode 目录），只在渲染层跳过（数据仍保留在缓存），判定依据见 v2compat.js 的函数注释。
import { isInternalInstructionMessage } from '../core/v2compat.js';
import { api } from '../core/apicall.js';
import { updateUserNav, syncSearchAfterRender } from './search.js';

// ============================
// sidepanel 回调注册（打破 render↔sidepanel 循环依赖）
// ============================
let renderTodosHandler = null;

/** 由 sidepanel.js 在加载时注册消息渲染后的待办刷新回调 */
export function setRenderTodosHandler(fn) {
    renderTodosHandler = typeof fn === 'function' ? fn : null;
}

// ============================
// updateModelInfo 注册（service/tree 经 core 层调用，不依赖本文件）
// 注册中心在 core/utils.js（setUpdateModelInfoHandler / updateModelInfo），
// service.js / tree.js 从 core 层调用，不再静态 import render.js。
// ============================

/** 保存元素焦点状态（用于 DOM 重建后恢复焦点） */
export function saveFocusState(el) {
    const tag = el.tagName.toLowerCase();
    const cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).join('.')
        : tag;
    return {
        selector: el.id ? '#' + el.id : (tag + cls),
        start: el.selectionStart,
        end: el.selectionEnd,
    };
}

/** 恢复元素焦点状态 */
export function restoreFocusState(container, state) {
    const el = container.querySelector(state.selector);
    if (!el) return;
    try { el.focus(); } catch (_) {}
    try {
        if (typeof state.start === 'number') el.selectionStart = state.start;
        if (typeof state.end === 'number') el.selectionEnd = state.end;
    } catch (_) {}
}


/**
 * 生成工具调用用时 HTML 片段。
 * @param {object} part 工具 part（含 state.time）
 * @param {boolean} live 运行中是否显示动态秒表（提问工具等待回答期间传 false）
 * @returns {string} HTML 片段（无有效时间时返回空串）
 */
function buildDurationHtml(part, live) {
    const t = (part && part.state && part.state.time) || {};
    if (!t.start) return '';
    if (t.end) {
        // 已完成/失败：静态总用时
        return ' <span class="oc-tool-duration">用时 ' + formatToolDuration(t.end - t.start) + '</span>';
    }
    if (!live) return ''; // 不允许走秒（如提问等待回答）且未完成 → 不显示
    // 运行中：秒表，由全局定时器刷新
    return ' <span class="oc-tool-duration" data-live-start="' + t.start + '">已运行 ' + formatToolDuration(Date.now() - t.start) + '</span>';
}

/** 刷新所有运行中工具秒表文本（每秒执行） */
function refreshLiveToolDurations() {
    const els = document.querySelectorAll('.oc-tool-duration[data-live-start]');
    if (!els.length) return;
    const now = Date.now();
    els.forEach((el) => {
        const start = parseInt(el.getAttribute('data-live-start'), 10);
        if (!start) return;
        // 支持自定义文案（思考过程用「思考中」，工具默认「已运行」）
        const label = el.getAttribute('data-live-label') || '已运行';
        el.textContent = label + ' ' + formatToolDuration(now - start);
    });
}
// 秒表全局定时器：仅当页面存在运行中工具时才做实际更新，开销可忽略
setInterval(refreshLiveToolDurations, 200);

/** 构建 synthetic 系统通知的折叠块（主消息流内，所有 synthetic 消息统一使用）。
 *  数据来源：v2compat.js adaptMessage / adaptEvent 对 synthetic 消息写入的
 *  info.syntheticNotice（description 摘要 + state 终态），正文由该消息的 text part 提供。
 *  外观：卡片本体是外层 .oc-message.system（系统卡，含「系统」角色行），
 *  此函数只生成卡内折叠块 + 右下角时间（时间行复用 .oc-message-time 的样式与位置）。
 *  折叠块视觉/交互对齐「思考过程」折叠款（.oc-reasoning）：标题行点击展开/收起，
 *  展开态记忆在 store.expandedParts；摘要行右侧仅在 metadata.state 存在时显示状态
 *  （completed→完成 / failed→失败 / interrupted→已中断，其它值原样）。
 *  折叠块只做展开/收起，无任何点击定位交互。 */
function buildSyntheticNoticeCard(info, partList) {
    const notice = info.syntheticNotice || {};
    const wrapper = document.createElement('div');
    wrapper.className = 'oc-synthetic-notice';

    const key = 'synthetic:' + (info.id || '');
    const expanded = !!store.expandedParts[key];

    const fold = document.createElement('div');
    fold.className = 'oc-part oc-synthetic-fold';

    // 摘要行：固定前缀「系统通知」；有 description 时以全角冒号拼接
    const head = document.createElement('div');
    head.className = 'oc-synthetic-head';
    const label = document.createElement('span');
    label.className = 'oc-synthetic-label';
    label.textContent = '系统通知' + (notice.description ? '：' + notice.description : '');
    head.appendChild(label);
    // 状态徽章：仅有 metadata.state 时显示；中文映射，其它值原样
    if (notice.state) {
        const labelMap = { completed: '完成', failed: '失败', interrupted: '已中断' };
        const clsMap = { completed: 'completed', failed: 'error', interrupted: 'interrupt' };
        const stateEl = document.createElement('span');
        stateEl.className = 'oc-synthetic-status status-' + (clsMap[notice.state] || 'pending');
        stateEl.textContent = labelMap[notice.state] || notice.state;
        head.appendChild(stateEl);
    }
    const toggle = document.createElement('span');
    toggle.className = 'oc-synthetic-toggle';
    toggle.textContent = expanded ? '收起' : '展开';
    head.appendChild(toggle);

    // 展开区：默认折叠；正文沿用既有文本渲染（renderTextPart），text 为空时渲染空内容
    const bodyEl = document.createElement('div');
    bodyEl.className = 'oc-synthetic-body' + (expanded ? '' : ' hidden');
    const textPart = (Array.isArray(partList) ? partList : []).find(p => p && p.type === 'text');
    if (textPart) bodyEl.appendChild(renderTextPart(textPart));
    head.addEventListener('click', () => {
        store.expandedParts[key] = !store.expandedParts[key];
        bodyEl.classList.toggle('hidden', !store.expandedParts[key]);
        toggle.textContent = store.expandedParts[key] ? '收起' : '展开';
    });
    fold.appendChild(head);
    fold.appendChild(bodyEl);
    wrapper.appendChild(fold);

    // 底部右下角时间：与既有消息卡时间样式一致（.oc-message-time，text-align:right），
    // 数据取该 synthetic 消息的 time.created（沿用 buildMessageNode 的取值兜底链）
    const msgTime = formatDateTime(info.time?.created || info.time?.updated || info.createdAt);
    if (msgTime) {
        const timeEl = document.createElement('div');
        timeEl.className = 'oc-message-time';
        timeEl.textContent = '⏱ ' + msgTime;
        wrapper.appendChild(timeEl);
    }
    return wrapper;
}

/** 文本哈希：用于消息渲染签名，只需稳定区分内容变化，不做安全用途。 */
function hashRenderText(text) {
    const value = String(text || '');
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
        hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
}

/** 消息渲染签名：id、角色、parts 的 id/type/文本长度与哈希、工具状态。
 *  不包含运行时长/展开状态等会频繁变化的字段，避免正常追加被误判为内容变化。
 *  增量追加前用它校验旧 DOM 是否与缓存中的消息一致。 */
function messageRenderSignature(item) {
    const info = item?.info || item || {};
    const parts = Array.isArray(item?.parts) ? item.parts : [];
    let sig = String(info.id || '') + '|' + String(info.role || info.author || '') + '|' + parts.length;
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i] || {};
        const text = String(part.text ?? part.content ?? '');
        sig += '|' + String(part.id || '') + ':' + String(part.type || '') + ':' + text.length + ':' + hashRenderText(text);
        if (part.state) {
            sig += ':' + String(part.state.status || '') + ':' + (typeof part.state.output === 'string' ? part.state.output.length : 0);
        }
    }
    if (info.error) {
        sig += '|err:' + String(typeof info.error === 'string' ? info.error : (info.error.message || ''));
    }
    if (info.syntheticNotice) sig += '|synthetic';
    return sig;
}

/** 构建单条消息节点（user/assistant 卡片），供 renderMessages 与分帧渲染复用 */
export function buildMessageNode(item, sessionID) {
    const info = item.info || item;
    // 详情弹窗等场景可传入目标会话 id；不传时沿用当前会话（既有调用行为不变）
    const sid = sessionID || store.currentSessionId;
    const role = info.role || info.author || 'message';
    const displayRole = role === 'user' ? '用户'
        : (role === 'assistant' ? '助手'
            : (role === 'system' ? '系统' : role));
    const parts = item.parts || [];
    const node = document.createElement('div');
    node.className = `oc-message ${role}`;
    if (info.id) node.dataset.messageId = info.id;
    // 供增量追加校验：旧 DOM 与新缓存条目的签名不一致时回退全量重建。
    node.dataset.renderSignature = messageRenderSignature(item);
    node.innerHTML = `<div class="oc-message-role">${escapeHtml(displayRole)}</div>`;
    const body = document.createElement('div');
    body.className = 'oc-message-parts';
    // 渲染前按 part 自身顺序修正：不依赖 SSE 事件到达顺序（Web 端可能乱序）
    const partList = sortParts(Array.isArray(parts) ? parts : [parts]);
    // 兼容两种 error 形态：v2 适配层把消息 error 规范为字符串（errorText），
    // 而旧数据可能是 {message} 对象——字符串必须能读出，否则服务端已记录的错误不可见。
    const messageErrorText = typeof info.error === 'string'
        ? info.error
        : (info.error?.message || info.error?.data?.message || '');
    if (role === 'assistant' && messageErrorText) {
        const errEl = document.createElement('div');
        errEl.className = 'oc-part error-msg';
        errEl.textContent = messageErrorText;
        body.appendChild(errEl);
    }
    // synthetic 系统通知（v2compat.js adaptMessage / adaptEvent 写入的通用标记）：
    // 所有 synthetic 消息统一渲染为系统卡内的折叠通知块（摘要 + 状态 + 展开正文），
    // 不再走普通系统文本渲染；折叠块只做展开/收起，无任何点击定位交互。
    if (role === 'system' && info.syntheticNotice) {
        body.appendChild(buildSyntheticNoticeCard(info, partList));
        node.appendChild(body);
        return node;
    }
    if (partList.length) {
        partList.forEach(part => body.appendChild(renderPart(part)));
    } else if (role === 'assistant') {
        if (messageErrorText) {
            // 已在上方输出 message-level error
        } else if (isSessionBusy(sid)) {
            const pending = document.createElement('div');
            pending.className = 'oc-part pending';
            pending.textContent = getSessionPendingText(sid);
            body.appendChild(pending);
        } else if (hasSessionError(sid)) {
            const errEl = document.createElement('div');
            errEl.className = 'oc-part error-msg';
            errEl.textContent = '模型调用失败：' + (store.sessionErrors[sid] || '未知错误，请检查 opencode 提供商配置');
            body.appendChild(errEl);
        } else {
            const empty = document.createElement('div');
            empty.className = 'oc-part pending';
            empty.textContent = messageErrorText || (info.time?.completed ? '已停止或本次未产生回复内容' : '正在等待模型回复...');
            body.appendChild(empty);
        }
    } else {
        const pre = document.createElement('pre');
        pre.textContent = safeText(item);
        body.appendChild(pre);
    }
    node.appendChild(body);
    // 输出卡片：显示 agent / model 信息（图标使用 assets/agent.svg、model.svg）
    if (role === 'assistant' && (info.agent || info.modelID || (info.model && info.model.modelID))) {
        var metaItems = [];
        if (info.agent) metaItems.push({ icon: 'oc-select-icon-agent', text: info.agent });
        var metaModel = info.modelID || (info.model && info.model.modelID) || '';
        if (info.providerID && metaModel) metaModel = info.providerID + '/' + metaModel;
        if (metaModel) metaItems.push({ icon: 'oc-select-icon-model', text: modelDisplayLabel(metaModel) });
        if (metaItems.length) {
            const metaEl = document.createElement('div');
            metaEl.className = 'oc-message-meta';
            metaItems.forEach(function(item, index) {
                if (index > 0) {
                    const sep = document.createElement('span');
                    sep.className = 'oc-meta-sep';
                    sep.textContent = '·';
                    metaEl.appendChild(sep);
                }
                const row = document.createElement('span');
                row.className = 'oc-meta-item';
                const icon = document.createElement('span');
                icon.className = 'oc-select-icon ' + item.icon;
                icon.setAttribute('aria-hidden', 'true');
                row.appendChild(icon);
                row.appendChild(document.createTextNode(item.text));
                metaEl.appendChild(row);
            });
            node.appendChild(metaEl);
        }
    }
    // 消息时间：user / assistant 都显示在卡片底部（右下角）；
    // 助手消息的 token 统计放在**时间行左侧**（v2 历史消息没有步骤行，不做合成）。
    const msgTime = formatDateTime(info.time?.created || info.time?.updated || info.createdAt);
    var usageText = '';
    if (role === 'assistant' && info.tokens) {
        var tk2 = info.tokens || {};
        var cacheRead = Number(tk2.cache && tk2.cache.read) || 0;
        // v2 的 input 只计"未命中缓存"的部分，cache.read 才是命中部分；
        // 两者相加才是这次请求真实的输入规模。否则同一会话里数字会因缓存命中与否忽大忽小。
        var inTok2 = (Number(tk2.input) || 0) + cacheRead;
        var outTok2 = Number(tk2.output) || 0;
        var totalTok2 = inTok2 + outTok2 + (Number(tk2.reasoning) || 0);
        if (totalTok2 > 0) {
            usageText = '输入:' + formatCompactNumber(inTok2)
                + (cacheRead > 0 ? '(缓存 ' + formatCompactNumber(cacheRead) + ')' : '')
                + ' 输出:' + formatCompactNumber(outTok2)
                + ' 统计:' + formatCompactNumber(totalTok2) + ' tokens';
        }
    }
    if ((msgTime || usageText) && (role === 'user' || role === 'assistant')) {
        // 同一行：token 统计靠左、时间靠右（由 CSS 的 space-between 实现）
        const footerEl = document.createElement('div');
        footerEl.className = 'oc-message-footer';
        if (usageText) {
            const usageEl = document.createElement('span');
            usageEl.className = 'oc-message-usage';
            usageEl.textContent = usageText;
            footerEl.appendChild(usageEl);
        }
        if (msgTime) {
            const timeEl = document.createElement('span');
            timeEl.className = 'oc-message-time';
            timeEl.textContent = '⏱ ' + msgTime;
            footerEl.appendChild(timeEl);
        }
        node.appendChild(footerEl);
    }
    return node;
}

/**
 * 尝试只追加末尾新增消息。
 *
 * 保证不丢消息的规则：
 *   - 旧 DOM 必须全部是带 messageId 的消息节点（末尾最多允许一个错误行）；
 *   - 旧 DOM 的 id 序列必须等于新列表前 N 条；
 *   - 旧 DOM 的渲染签名必须与对应条目一致（防止同 id 内容被替换）；
 *   - 只有新列表比旧 DOM 多出末尾条目时才追加。
 * 任一条件不满足就返回 false，交给原全量重建。
 *
 * @returns {boolean} 是否已成功增量追加
 */
function tryAppendNewMessages(box, list, scrollAnchor, followBottom) {
    if (!box || !list || !list.length) return false;

    const rendered = [];
    const children = Array.from(box.children);
    for (let i = 0; i < children.length; i++) {
        const el = children[i];
        if (el.classList.contains('oc-message') && el.dataset.messageId) {
            rendered.push(el);
            continue;
        }
        // 只允许末尾存在无 id 的执行失败错误行；空态/其他节点一律回退全量。
        if (i === children.length - 1 && el.classList.contains('oc-message') &&
            !el.dataset.messageId && el.querySelector('.error-msg')) {
            continue;
        }
        return false;
    }

    const count = rendered.length;
    if (!count || list.length <= count) return false;

    for (let i = 0; i < count; i++) {
        const item = list[i];
        const id = String(item?.info?.id || item?.id || '');
        const el = rendered[i];
        if (!id || el.dataset.messageId !== id) return false;
        if (el.dataset.renderSignature !== messageRenderSignature(item)) return false;
    }

    // 先移除末尾错误行，避免新消息追加到错误行后面。
    let last = box.lastElementChild;
    while (last && last.classList.contains('oc-message') && !last.dataset.messageId &&
           last.querySelector('.error-msg')) {
        last.remove();
        last = box.lastElementChild;
    }

    // 只构建新增的末尾消息，旧消息 DOM 原样保留。
    const frag = document.createDocumentFragment();
    const appendedNodes = [];
    for (let i = count; i < list.length; i++) {
        const node = buildMessageNode(list[i]);
        appendedNodes.push(node);
        frag.appendChild(node);
    }
    box.appendChild(frag);

    // 与全量重建保持同一组收尾副作用。
    doUpdateModelInfo(list);
    const errorRow = appendSessionErrorRowIfNeeded(box, list);
    if (errorRow) appendedNodes.push(errorRow);
    // 旧 DOM 没有变化，新消息只追加在末尾，不需要重写 scrollTop：
    // 重写会打断搜索/用户平滑滚动，并可能让滚动监听把瞬时位置误判为“到顶”
    // 而触发 loadOlderMessages。只有原本贴底时才跟随到底。
    if (followBottom) restoreScrollAnchor(box, scrollAnchor, true);
    updateScrollBottomButton();
    // 增量追加保留旧消息 DOM 与旧高亮，只给新增节点补高亮
    syncSearchAfterRender({ kind: 'appendMessages', box, nodes: appendedNodes });
    if (renderTodosHandler) renderTodosHandler();
    updateUserNav();
    return true;
}

/** 渲染完整消息列表（支持增量更新、滚动保持、移动端截断）
 *  @param {Array} items 消息数组
 *  @param {HTMLElement} [targetBox] 目标容器；不传则用当前活动 tab 容器
 */
export function renderMessages(items, targetBox) {
    const box = targetBox || getActiveMessagesEl();
    const sourceList = (items || []).map(normalizeMessageItem)
        .filter(item => !isInternalUserMessage(item))
        // 内部指令/合成消息：只在渲染层跳过（原始数据保留在缓存/接口，便于排查），
        // 判定条件见 v2compat.js 的 isInternalInstructionMessage 注释。
        .filter(item => !isInternalInstructionMessage(item));
    const list = sourceList; // 分页加载：已加载消息全量渲染（不再本地截断）

    if (store.userScrolling) {
        store.lastMessageCount = list.length;
        return;
    }

    // 跟随底部必须按「该会话自己是否贴底」判断，不能看全局按钮：
    // 右下角按钮只反映当前激活会话，未激活会话在后台渲染时会被误判为已上翻。
    const renderSid = (box.dataset && box.dataset.tab) || store.currentSessionId || '';
    const followBottom = store.tabStickBottom[renderSid] !== false;
    const scrollAnchor = captureScrollAnchor(box);
    if (!list.length) {
        // 空列表也要给「执行失败」留宿主：若该会话有 sessionErrors（如 execution.failed
        // 早于任何 step、服务端未落 assistant 卡片），先渲染错误行，再回退空态提示。
        box.innerHTML = '';
        appendSessionErrorRowIfNeeded(box, list);
        if (!box.childElementCount) {
            box.innerHTML = '<div class="oc-empty">该会话暂无消息</div>';
        }
        store.lastMessageCount = 0;
        store.lastSourceMessageCount = 0;
        doUpdateModelInfo(null);
        updateScrollBottomButton();
        // 空列表同样同步搜索：清空容器后旧高亮已不存在，计数要归零/显示无匹配
        syncSearchAfterRender({ kind: 'full', box });
        return;
    }

    const sameCount = sourceList.length === store.lastSourceMessageCount;
    store.lastMessageCount = list.length;
    store.lastSourceMessageCount = sourceList.length;

    // 忙碌状态必须按被渲染的会话判断：后台 tab 渲染时用当前前台会话的 busy
    // 会把空闲会话误当成流式增量，导致增量分支被错误触发。
    const busySid = renderSid || store.currentSessionId || '';
    if (sameCount && list.length > 0 && store.webRunning && isSessionBusy(busySid)) {
        const last = list[list.length - 1];
        const lastId = last.info?.id || last.id || '';
        const lastRole = (last.info || last).role;
        if (lastRole === 'assistant' && lastId) {
            const lastMsg = box.lastElementChild;
            // 总数相等不代表尾卡就是这条消息：占位卡被真实消息「一换一」替换时，
            // 缓存里已没有 pending_，DOM 尾部却仍是带 pending_ 标识的占位节点。
            // 必须核对消息标识，否则真实流式内容会被写进占位卡（卡片身份与内容错位）。
            if (lastMsg && lastMsg.classList.contains('assistant') && lastMsg.dataset.messageId === lastId) {
                const body = lastMsg.querySelector('.oc-message-parts');
                if (body) {
                    // 流式增量分支同样按 part 自身顺序修正后再比对/追加
                    const partList = sortParts(Array.isArray(last.parts) ? last.parts : [last.parts]);
                    const newIds = partList.map(p => p.id || '');
                    const existingIds = Array.from(body.children).map(c => c.dataset.partId || '');
                    if (newIds.length > existingIds.length && existingIds.every((id, index) => id === newIds[index])) {
                        for (let i = existingIds.length; i < newIds.length; i++) {
                            const partEl = renderPart(partList[i]);
                            if (partList[i].id) partEl.dataset.partId = partList[i].id;
                            body.appendChild(partEl);
                        }
                    } else {
                        // 保存焦点状态，防止 replaceChildren 导致输入框失焦
                        const focused = document.activeElement;
                        const focusSelector = focused && body.contains(focused) ? saveFocusState(focused) : null;
                        body.replaceChildren(...partList.map(part => renderPart(part)));
                        if (focusSelector) restoreFocusState(body, focusSelector);
                    }
                    doUpdateModelInfo(list);
                    restoreScrollAnchor(box, scrollAnchor, followBottom);
                    updateScrollBottomButton();
                    // 末条消息被重建/追加片段：只重扫该消息，其他消息高亮不受影响
                    syncSearchAfterRender({ kind: 'message', box, messageEl: lastMsg, messageId: lastId });
                    return;
                }
            }
        }
    }

    // 末尾纯追加：旧消息完全未变时只构建新消息；任何不确定都回退全量重建。
    if (tryAppendNewMessages(box, list, scrollAnchor, followBottom)) return;

    // 全量重建：先构建到 DocumentFragment，再一次性替换。
    // 消息结构、顺序、Markdown 渲染结果均不变。
    const frag = document.createDocumentFragment();
    list.forEach(item => {
        frag.appendChild(buildMessageNode(item));
    });
    box.replaceChildren(frag);
    // 执行失败的兜底错误行（详见 appendSessionErrorRowIfNeeded 注释）
    appendSessionErrorRowIfNeeded(box, list);

    doUpdateModelInfo(items);
    restoreScrollAnchor(box, scrollAnchor, followBottom);
    updateScrollBottomButton();
    // 全量重建后旧高亮节点已全部销毁：按纯数据描述重扫整个容器，恢复高亮与 active
    syncSearchAfterRender({ kind: 'full', box });
    if (renderTodosHandler) renderTodosHandler();
    updateUserNav();

}

/**
 * 会话执行失败的兜底错误行。
 *
 * 背景：session.error（execution.failed / step.failed 等）会写入 store.sessionErrors；
 * 若服务端尚未落 assistant 卡片（失败早于任何 step），消息列表末尾就是用户消息，
 * 错误在消息区没有宿主——buildMessageNode 的 sessionErrors 分支只在「已有 assistant
 * 空卡片」时才生效。这里在列表末尾追加一条错误行，保证失败在消息区可见。
 * 列表末尾是 assistant 卡片时跳过（错误由卡片自身分支展示，避免重复）。
 */
function appendSessionErrorRowIfNeeded(box, list) {
    const sid = (box && box.dataset && box.dataset.tab) || store.currentSessionId;
    if (!sid || !hasSessionError(sid)) return null;
    const last = list && list.length ? list[list.length - 1] : null;
    const lastRole = last ? ((last.info || last).role || '') : '';
    if (lastRole === 'assistant') return null;
    const node = document.createElement('div');
    node.className = 'oc-message assistant';
    const body = document.createElement('div');
    body.className = 'oc-message-parts';
    const errEl = document.createElement('div');
    errEl.className = 'oc-part error-msg';
    errEl.textContent = '模型调用失败：' + (store.sessionErrors[sid] || '未知错误，请检查 opencode 提供商配置');
    body.appendChild(errEl);
    node.appendChild(body);
    box.appendChild(node);
    return node;
}


/** 从消息历史中同步最新 assistant 使用的 Agent/Model 到下拉框。
 *  原为 export，现改内部实现并由 core/utils.js 的 setUpdateModelInfoHandler 注册暴露，
 *  service.js / tree.js 从 core 层调用（打破 service/tree ↔ render 循环依赖）。
 *
 *  覆盖规则（真机 bug 修复）：
 *  - 用户在**本会话**内手动选择过的项（store.manualSelectionBySession[sessionID]）
 *    绝不被历史覆盖——包括「切走再切回 / 点击已打开会话」触发的重新同步；
 *  - 未手动选择过的项，按该会话历史同步一次（agentModelSyncedSession 守卫防重复）。 */
function doUpdateModelInfo(items) {
    const agentSel = document.getElementById('ocAgentSelect');
    const modelSel = document.getElementById('ocModelSelect');
    if (!agentSel || !modelSel) return;

    // 会话级守卫：同一会话只自动同步一次（用户手选会提前标记，见 session.js 的 change 监听）
    const sessionID = store.currentSessionId || '';
    if (sessionID && store.agentModelSyncedSession === sessionID) return;

    const list = items || [];
    let agent = '';
    let model = '';
    let variant = '';
    for (let i = list.length - 1; i >= 0; i--) {
        const info = list[i].info || list[i];
        if (info.role === 'assistant') {
            agent = info.agent || '';
            model = info.modelID || (info.model && info.model.modelID) || '';
            if (info.providerID) model = info.providerID + '/' + model;
            variant = info.variant || '';
            break;
        }
    }
    // 历史里没有可用信息：保持现状，等后续渲染再尝试同步
    if (!agent && !model) return;

    // 该会话的手动选择标记：被标记的项不允许被历史覆盖
    // （切换会话时由 restoreSessionSelection 决定是否带上标记；无标记项照常同步）
    const manual = sessionID ? ((store.manualSelectionBySession || {})[sessionID] || null) : null;
    const isManual = function (kind) {
        return !!(manual && Object.prototype.hasOwnProperty.call(manual, kind));
    };

    // API 列表未加载时无法校验，退化为沿用历史值（保留原「API 加载失败时降级」语义）
    const agentApiLoaded = (store.agentList || []).length > 0;
    const modelApiLoaded = (store.modelList || []).length > 0;
    const nextAgent = agent ? (agentApiLoaded ? resolveKnownValue(store.agentList, agent, agentValueOf) : agent) : '';
    const nextModel = model ? (modelApiLoaded ? resolveKnownValue(store.modelList, model, modelValueOf) : model) : '';

    // DOM 与 store 同时更新：校验不通过时回退「默认」（空串），绝不让失效名进入请求
    if (agent) {
        if (isManual('agent')) {
            // 手选优先：不覆盖，仅把下拉对齐回手动值（防重建后显示漂移）
            agentSel.value = store.selectedAgent || '';
        } else {
            if (nextAgent) ensureSelectOption(agentSel, nextAgent, nextAgent);
            agentSel.value = nextAgent;
            store.selectedAgent = nextAgent;
        }
    }
    if (model) {
        if (isManual('model')) {
            modelSel.value = store.selectedModel || '';
        } else {
            if (nextModel) ensureSelectOption(modelSel, nextModel, nextModel);
            modelSel.value = nextModel;
            store.selectedModel = nextModel;
        }
    }
    const variantSel = document.getElementById('ocVariantSelect');
    if (variantSel && !isManual('variant')) {
        // 先按当前模型重建档位，再回填历史值。
        // 这里必须用 keepUnknown：历史 variant 与 model 出自同一条 assistant 记录，
        // 且模型列表可能尚未加载完成（此时 variants 为空数组），严格回落会把历史值
        // 误判成「默认」；真正的非法档位由发送前的校验兜底。
        syncVariantSelect(variantSel, store.selectedModel || '', variant || '', { keepUnknown: true });
        store.selectedVariant = variantSel.value;
    }

    if (sessionID) store.agentModelSyncedSession = sessionID;
}

/** 取 agent 候选项的匹配键（以 /agent 返回对象的 **id** 为准，缺 id 才退回 name） */
function agentValueOf(item) {
    return item && (item.id || item.name);
}

/** 取 model 候选项的匹配键（/provider 展开后的 value，形如 providerID/modelID） */
function modelValueOf(item) {
    return item && item.value;
}

// 模块加载时注册 updateModelInfo 实现到 core 注册中心（service/tree 从 core 调用）
setUpdateModelInfoHandler(doUpdateModelInfo);

/** 确保指定 value 的选项存在于 <select> 中（API 加载失败降级） */
export function ensureSelectOption(sel, value, label) {
    for (let i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === value) return;
    }
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label || value;
    sel.appendChild(opt);
}

// ============================
// 滚动管理
// ============================

/** 智能滚动：根据用户是否在底部决定自动跟随还是保持位置 */
export function smartScroll(box, force) {
    const scrollState = captureScrollState(box);
    restoreScroll(box, scrollState, force);
    updateScrollBottomButton();
}

// 距底部小于该值视为「在底部」：约 1-2 行，避免轻微上翻仍被判定为跟随。
const SCROLL_BOTTOM_THRESHOLD = 32;

/** 捕获滚动状态（顶部位置、高度、距底部距离） */
export function captureScrollState(box) {
    const distanceToBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
    return {
        top: box.scrollTop,
        height: box.scrollHeight,
        nearBottom: distanceToBottom < SCROLL_BOTTOM_THRESHOLD,
    };
}

/** 恢复滚动位置：底部模式滚到底，否则按高度差修正 */
export function restoreScroll(box, state, force) {
    if (force || state.nearBottom) {
        // 直接滚到容器绝对底部，不依赖 lastElementChild（流式回复期间子元素持续增高）
        box.scrollTop = box.scrollHeight;
        updateScrollBottomButton();
        return;
    }
    const heightDelta = box.scrollHeight - state.height;
    box.scrollTop = Math.max(0, state.top + Math.min(0, heightDelta));
    updateScrollBottomButton();
}

/** 捕获视口顶部可见消息作为锚点：记录消息 id 与相对视口偏移。
 *  渲染后按同一条消息恢复位置，避免上方内容变高（新卡片/图片）导致视口下移。 */
export function captureScrollAnchor(box) {
    const top = box.scrollTop;
    let anchor = null;
    for (const el of box.children) {
        if (el.offsetTop + el.offsetHeight > top) {
            anchor = el;
            break;
        }
    }
    return {
        top: top,
        height: box.scrollHeight,
        messageId: anchor ? (anchor.dataset.messageId || '') : '',
        offset: anchor ? (anchor.offsetTop - top) : 0,
    };
}

/** 按锚点恢复滚动位置；followBottom 为真时直接滚到底。 */
export function restoreScrollAnchor(box, anchor, followBottom) {
    // 隐藏的 tab 容器（未激活）clientHeight 为 0，此时 scrollHeight 也不可靠：
    // 任何写入都会把它原有的 scrollTop 冲掉，切回时无法恢复位置。
    if (!box.clientHeight) return;
    if (followBottom) {
        box.scrollTop = box.scrollHeight;
        updateScrollBottomButton();
        return;
    }
    if (anchor && anchor.messageId) {
        const el = box.querySelector('[data-message-id="' + CSS.escape(anchor.messageId) + '"]');
        if (el) {
            box.scrollTop = Math.max(0, el.offsetTop - anchor.offset);
            updateScrollBottomButton();
            return;
        }
    }
    if (!anchor) return;
    // 锚点消息被删除/替换（例如分页覆盖）：退回高度差修正
    const heightDelta = box.scrollHeight - anchor.height;
    box.scrollTop = Math.max(0, anchor.top + Math.min(0, heightDelta));
    updateScrollBottomButton();
}

/** 更新「滚到底」按钮可见性，并记录当前会话自己的贴底状态 */
export function updateScrollBottomButton() {
    const box = getActiveMessagesEl();
    const btn = document.getElementById('btnScrollBottom');
    if (!box || !btn) return;
    const canScroll = box.scrollHeight > box.clientHeight + 8;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < SCROLL_BOTTOM_THRESHOLD;
    // 按钮只有一个，但「是否跟随底部」必须按会话独立记录：
    // 否则当前会话上翻会让其他会话也停止跟随。
    const sid = (box.dataset && box.dataset.tab) || store.currentSessionId || '';
    if (sid) store.tabStickBottom[sid] = nearBottom;
    btn.classList.toggle('visible', canScroll && !nearBottom);
}

/** 平滑动画滚动到消息列表底部（easeOutCubic） */
export function scrollMessagesToBottom() {
    const box = getActiveMessagesEl();
    if (!box) return;

    // 自定义动画：每帧用最新 scrollHeight 做插值，流式回复期间目标值自动跟上
    const startTop = box.scrollTop;
    const startTime = performance.now();
    const distance = box.scrollHeight - startTop;
    const duration = Math.max(180, Math.min(450, Math.abs(distance) * 0.3));

    function tick(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
        const target = box.scrollHeight;
        box.scrollTop = startTop + (target - startTop) * eased;

        if (progress < 1) {
            requestAnimationFrame(tick);
        } else {
            box.scrollTop = box.scrollHeight;
            updateScrollBottomButton();
        }
    }
    requestAnimationFrame(tick);
}

/** 判断一个状态值是否代表繁忙（busy/retry）。 */
export function isBusyStatus(status) {
    return status === 'busy' || status === 'running' || status === 'retry' ||
        status?.type === 'busy' || status?.type === 'retry' || status?.status === 'busy';
}

/** 判断会话是否繁忙（busy/retry 状态） */
export function isSessionBusy(id) {
    return isBusyStatus(store.sessionStatuses[id]);
}

/** 本地操作意图的保护窗口（毫秒）。
 *  /api/session/active 的登记/清除有延迟：发送后它可能仍返回空，停止后可能仍返回 running。
 *  在这段时间内，快照与本地状态相反时以本地为准；超过窗口后才允许快照纠偏。 */
const SESSION_STATUS_HOLD_MS = 10000;
/** 活动事件推断 busy 后的保护窗口。工具执行可能长时间无新事件，
 *  窗口需覆盖 active 的登记延迟，避免打开/重连时的快照把 busy 打回。 */
const ACTIVITY_HOLD_MS = 10000;

/**
 * 统一的状态写入入口。所有会话状态（本地发送/停止、SSE 事件、active 快照、
 * 活动事件推断）都必须经由此函数，避免多套写入路径互相覆盖。
 *
 * @param {string} id 会话 ID（必须显式传入，禁止用 currentSessionId 兜底）
 * @param {string|object} status 'busy' | 'idle' | retry 对象
 * @param {'local'|'event'|'activity'|'snapshot'} source 状态来源
 * @param {{holdMs?: number}} [options] local 来源的保护窗口覆盖
 */
export function setSessionStatus(id, status, source, options) {
    if (!id) return;
    let meta = store.sessionStatusMeta[id];
    if (!meta) {
        meta = { holdUntil: 0, source: '' };
        store.sessionStatusMeta[id] = meta;
    }
    const prev = store.sessionStatuses[id];

    if (source === 'activity') {
        // 活动事件推断 busy：只用于“从空闲变繁忙”，不能覆盖刚停止的本地意图。
        if (meta.holdUntil > Date.now() && !isBusyStatus(prev)) return;
        if (isBusyStatus(prev)) {
            // 执行仍在继续：续期保护窗口。工具执行可能长时间静默，
            // 期间若 active 的延迟空快照到达，没有保护就会把「停止」打回「发送」。
            meta.holdUntil = Date.now() + ACTIVITY_HOLD_MS;
            return; // 保留原状态对象（retry 信息不丢）
        }
        store.sessionStatuses[id] = 'busy';
        meta.source = 'activity';
        meta.holdUntil = Date.now() + ACTIVITY_HOLD_MS;
        if (id === store.currentSessionId) updateSendButton();
        return;
    }

    if (source === 'snapshot' || source === 'event') {
        // 本地意图保护：窗口内快照/非终止事件与本地状态方向相反时忽略；
        // 同向则采纳并清除保护（服务端已确认，本地意图可以退位）。
        // 典型场景：刚点停止，服务端延迟发来的 busy/retry 不能把按钮打回「停止」。
        if (meta.holdUntil > Date.now() && isBusyStatus(prev) !== isBusyStatus(status)) return;
        meta.holdUntil = 0;
    } else if (source === 'local') {
        meta.holdUntil = Date.now() + (options && options.holdMs != null ? options.holdMs : SESSION_STATUS_HOLD_MS);
    } else {
        // terminal（session.idle / execution.* 终止事件）：服务端已确认执行结束，
        // 必须立即采纳并清除本地保护——这是停止/失败后最重要的一次纠偏。
        meta.holdUntil = 0;
    }

    store.sessionStatuses[id] = status;
    meta.source = source;
    if (id === store.currentSessionId) updateSendButton();
}

/** 判断会话是否有错误 */
export function hasSessionError(id) {
    return !!store.sessionErrors[id];
}

/** 获取会话等待提示文本（区分普通等待和重试） */
export function getSessionPendingText(id) {
    const status = store.sessionStatuses[id];
    if (status?.type === 'retry') {
        // retry 的 message 是服务端现成的可读文案；补 error 字段兜底
        // （session.retry.scheduled 合成的事件只保证有 message，防御其它形态只给 error）。
        const detail = status.message || (status.error
            ? (typeof status.error === 'string' ? status.error : (status.error.message || ''))
            : '');
        return `模型连接失败，正在第 ${status.attempt || 1} 次重试：${detail || '等待下一次重试'}`;
    }
    return '正在等待模型回复...';
}

/**
 * 更新发送按钮状态
 * 会话繁忙时显示「⏹ 停止」按钮，空闲时显示「发送」按钮
 * 说明：原属 chat/session.js，为打破 session↔tabs 循环依赖移入本文件
 */
export function updateSendButton() {
    const btn = document.getElementById('btnSendPrompt');
    if (!store.webRunning || !store.currentSessionId) {
        btn.textContent = '发送';
        btn.className = 'btn btn-primary';
        btn.dataset.mode = 'send';
        return;
    }
    const busy = isSessionBusy(store.currentSessionId);
    if (busy) {
        btn.textContent = '⏹ 停止';
        btn.className = 'btn btn-danger-outline';
        btn.dataset.mode = 'stop';
    } else {
        btn.textContent = '发送';
        btn.className = 'btn btn-primary';
        btn.dataset.mode = 'send';
    }
}

// ============================
// Part 顺序修正
// ============================

/**
 * 判断 part 是否携带服务端有序 id。
 * opencode 的 part id 形如 `prt_<定长有序段>`（实测前缀统一为 prt_、长度统一为 30），
 * 同一消息内其字典序即逻辑生成顺序。本地乐观 part（形如 msg_*_p0）没有该前缀，
 * 不能参与重排，否则会被挤到错误位置。
 */
function hasServerOrderId(part) {
    return typeof part?.id === 'string' && part.id.startsWith('prt_');
}

/**
 * 按 part 自身的顺序字段稳定排序。
 * 背景：parts 的显示顺序原本等于事件到达顺序（cache.js 按到达顺序 push）。
 * 桌面端走 Wails 事件通道顺序通常正确；Web 端走 SSE 广播（含 channel 缓冲、
 * 慢客户端剔除、断线重连），到达顺序可能与逻辑顺序不一致，
 * 表现为「执行工具」跑到「文本输出」前面。显示顺序不应依赖到达顺序，故渲染前统一按 id 排序。
 * 稳定性保证：仅服务端 part 在它们占据的槽位之间重排，本地占位 part 保持原槽位不动；
 * id 相同（理论上不会出现）时按原下标先后，保证结果确定。
 * @param {Array} parts 消息的 part 数组
 * @returns {Array} 排序后的新数组（已有序时原样返回，避免流式期间每帧重建）
 */
export function sortParts(parts) {
    const list = Array.isArray(parts) ? parts : [];
    if (list.length < 2) return list;
    const sortable = [];
    list.forEach((part, index) => {
        if (hasServerOrderId(part)) sortable.push({ part, index });
    });
    if (sortable.length < 2) return list;
    // 已有序：直接返回原数组，避免无意义的数组分配
    let ordered = true;
    for (let i = 1; i < sortable.length; i++) {
        if (sortable[i - 1].part.id > sortable[i].part.id) { ordered = false; break; }
    }
    if (ordered) return list;
    // 槽位（升序下标）与「排序后的 part」一一对应填回，占位 part 的槽位不在其中，故保持原位
    const slots = sortable.map(entry => entry.index);
    const sorted = sortable.slice().sort((a, b) =>
        a.part.id < b.part.id ? -1 : a.part.id > b.part.id ? 1 : a.index - b.index);
    const result = list.slice();
    slots.forEach((slot, i) => { result[slot] = sorted[i].part; });
    return result;
}

// ============================
// Part 渲染器
// ============================

/** Part 渲染分发器：按 type 分发到对应的渲染函数 */
export function renderPart(part) {
    const type = part?.type || '';
    const id = part?.id || '';
    let el;
    switch (type) {
        case 'step-start': el = renderStepDivider(part, 'start'); break;
        case 'step-finish': el = renderStepDivider(part, 'finish'); break;
        case 'reasoning': el = renderReasoning(part); break;
        case 'tool': el = renderTool(part); break;
        case 'text': el = renderTextPart(part); break;
        case 'file': el = renderFilePart(part); break;
        case 'patch': el = renderPatchPart(part); break;
        case 'compaction': el = renderCompaction(part); break;
        case 'snapshot':   el = renderSnapshot(part); break;
        case 'retry':      el = renderRetry(part); break;
        default: el = renderFallback(part); break;
    }
    if (id) el.dataset.partId = id;
    return el;
}

/** 生成 part 展开状态的唯一 key */
export function partExpandKey(part, fallback) {
    return part?.id || `${part?.type || 'part'}:${part?.messageID || ''}:${fallback || ''}`;
}

/** 渲染步骤分割线（开始/结束 + token 统计 + 时间） */
export function renderStepDivider(part, phase) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-step-divider';
    const timeText = formatDateTime(part.time?.start || part.time?.created || part.time?.updated);
    const timeHtml = timeText ? `<span class="oc-step-time">⏱ ${timeText}</span>` : '';
    if (phase === 'finish' && part.tokens) {
        const t = part.tokens;
        const input = (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0)
        const ouput = (t.output||0) + (t.reasoning||0);
        const total = t.total || (t.input || 0) + (t.output || 0) + (t.reasoning || 0);
        el.innerHTML = `<span class="oc-step-label">步骤结束</span><span class="oc-step-cost">输入:${input} 输出:${ouput} 统计:${formatCompactNumber(total)} tokens</span>${timeHtml}`;
    } else {
        el.innerHTML = `<span class="oc-step-label">步骤开始</span>${timeHtml}`;
    }
    return el;
}

/** 渲染思考过程（可折叠，支持 Markdown） */
export function renderReasoning(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-reasoning';
    const key = partExpandKey(part, 'reasoning');
    const head = document.createElement('div');
    head.className = 'oc-reasoning-head';
    // 与工具卡片一致：标题 + 用时；进行中实时刷新，结束后显示总用时。
    // 不使用「展开/收起」文字，点击标题行即可折叠。
    const t = part.time || {};
    let durHtml = '';
    if (t.start && t.end) {
        durHtml = '<span class="oc-tool-duration">用时 ' + formatToolDuration(t.end - t.start) + '</span>';
    } else if (t.start) {
        durHtml = '<span class="oc-tool-duration" data-live-start="' + t.start + '" data-live-label="思考中">思考中 '
            + formatToolDuration(Date.now() - t.start) + '</span>';
    }
    head.innerHTML = '<span class="oc-reasoning-icon">🧠</span> 思考过程 ' + durHtml;
    const body = document.createElement('div');
    const expanded = !!store.expandedParts[key];
    body.className = 'oc-reasoning-body' + (expanded ? '' : ' hidden');
    body.dataset.expandKey = key;
    body.innerHTML = typeof marked !== 'undefined'
        ? sanitizeMarkedHtml(marked.parse(part.text || '', { breaks: true }))
        : `<pre>${escapeHtml(part.text || '')}</pre>`;
    // 本地图片（C:\... / file:// / 相对路径）异步替换为 data URL，避免破图
    hydrateLocalImages(body, currentDir());
    head.addEventListener('click', () => {
        store.expandedParts[key] = !store.expandedParts[key];
        body.classList.toggle('hidden', !store.expandedParts[key]);
    });
    el.appendChild(head);
    el.appendChild(body);
    return el;
}

/** 渲染 Question 工具（选项按钮、自定义输入、跳过、底部总提交） */
export function renderQuestionTool(part) {
    const state = part.state || {};
    const status = state.status || '';
    const isRunning = status === 'running' || (!status);
    const isCompleted = status === 'completed';
    const isDismissed = status === 'error' && (state.error || '').includes('dismissed');
    const isError = status === 'error' && !isDismissed;
    const questions = (state.input && state.input.questions) || [];
    const output = state.output;

    // 多问题逐题收集答案：挂到 part 上，避免跨渲染丢失
    if (!part.__pendingAnswers) part.__pendingAnswers = [];
    if (!part.__pendingCustom) part.__pendingCustom = [];
    if (!part.__pendingSkipped) part.__pendingSkipped = [];

    const el = document.createElement('div');
    el.className = `oc-part oc-tool oc-tool-question` + (isCompleted ? ' done' : '') + (isDismissed ? ' dismissed' : '') + (isError ? ' error' : '') + (isRunning ? ' running' : '');

    // head
    const head = document.createElement('div');
    head.className = 'oc-tool-head';
    let statusText, statusClass;
    if (isCompleted) { statusText = '✓ 已回答'; statusClass = 'ok'; }
    else if (isDismissed) { statusText = '↩ 已跳过'; statusClass = 'skipped'; }
    else if (isError) { statusText = '✗ 失败'; statusClass = 'err'; }
    else {
        const answeredCount = part.__pendingAnswers.filter(function(a) { return a && a.length; }).length;
        statusText = questions.length > 1 && answeredCount > 0
            ? '⏳ 已答 ' + answeredCount + '/' + questions.length
            : '⏳ 等待回答';
        statusClass = 'running';
    }
    head.innerHTML = `<span class="oc-tool-icon">❓</span> 提问 <span class="oc-tool-status ${statusClass}">${statusText}</span>` + (isCompleted ? buildDurationHtml(part, false) : '');

    // 组装所有答案并提交（含自定义输入；跳过的题传空数组）
    const submitAllAnswers = function() {
        const all = questions.map(function(q, i) {
            if (part.__pendingSkipped[i]) return [];
            const opts = part.__pendingAnswers[i] || [];
            const custom = part.__pendingCustom[i] || '';
            if (opts.length) return opts;
            if (custom.trim()) return [custom.trim()];
            return [];
        });
        answerQuestion(all);
    };

    const body = document.createElement('div');
    body.className = 'oc-tool-body';

    questions.forEach((q, qi) => {
        const qBlock = document.createElement('div');
        qBlock.className = 'oc-question-block';
        if (qi > 0) qBlock.style.marginTop = '16px';

        if (q.header) {
            const hdr = document.createElement('div');
            hdr.className = 'oc-question-header';
            hdr.textContent = q.header;
            qBlock.appendChild(hdr);
        }
        const qText = document.createElement('div');
        qText.className = 'oc-question-text';
        qText.textContent = q.question || '';
        qBlock.appendChild(qText);

        // 该题已跳过：直接显示跳过状态，不渲染选项/输入
        const qSkipped = part.__pendingSkipped && part.__pendingSkipped[qi];
        if (isRunning && qSkipped) {
            const skippedDiv = document.createElement('div');
            skippedDiv.className = 'oc-question-answer oc-question-dismissed';
            skippedDiv.textContent = '↩ 已跳过此问题';
            qBlock.appendChild(skippedDiv);
            body.appendChild(qBlock);
            return;
        }

        // 该问题已答标识（选项或自定义输入均可）
        const qAnswered = part.__pendingAnswers[qi] && part.__pendingAnswers[qi].length;
        const qCustom = part.__pendingCustom[qi] && part.__pendingCustom[qi].trim();
        const hasAnswer = !!(qAnswered || qCustom);
        if (isRunning && hasAnswer) {
            const answeredHint = document.createElement('div');
            answeredHint.className = 'oc-question-answered-hint';
            answeredHint.textContent = '✅ 已答：' + (qAnswered ? part.__pendingAnswers[qi].join(', ') : qCustom);
            qBlock.appendChild(answeredHint);
        }

        // 已回答：只显示该问题对应的答案
        if (isCompleted) {
            var metaAnswers = state.metadata && state.metadata.answers;
            var thisAnswer = (Array.isArray(metaAnswers) && metaAnswers[qi]) ? metaAnswers[qi] : null;
            if (thisAnswer && thisAnswer.length) {
                const answerDiv = document.createElement('div');
                answerDiv.className = 'oc-question-answer';
                answerDiv.innerHTML = `<span class="oc-question-answer-label">✅ 已选：</span>${escapeHtml(thisAnswer.join(', '))}`;
                qBlock.appendChild(answerDiv);
            } else if (output) {
                // 无 metadata 时降级：从汇总输出中尝试提取对应答案
                const answerDiv = document.createElement('div');
                answerDiv.className = 'oc-question-answer';
                answerDiv.innerHTML = `<span class="oc-question-answer-label">✅ 已选：</span>${escapeHtml(safeText(output))}`;
                qBlock.appendChild(answerDiv);
            }
        }
        // 已跳过
        if (isDismissed) {
            const dismissDiv = document.createElement('div');
            dismissDiv.className = 'oc-question-answer oc-question-dismissed';
            dismissDiv.textContent = '↩ 已跳过此问题';
            qBlock.appendChild(dismissDiv);
        }

        // 运行中显示选项按钮
        if (isRunning && q.options && q.options.length) {
            const optsDiv = document.createElement('div');
            optsDiv.className = 'oc-question-options';

            q.options.forEach(opt => {
                const btn = document.createElement('button');
                btn.className = 'oc-question-option-btn';
                const label = (opt.label || '');
                const desc = opt.description || '';
                // v2 的选项是 {value,label,description}：**提交必须用 value**（label 仅供展示）。
                // 老数据/工具形态可能只有 label，此时兜底用 label。
                const optValue = String(opt.value !== undefined && opt.value !== null ? opt.value : label);
                // 已选该选项时高亮
                const answered = part.__pendingAnswers[qi];
                if (answered && answered.indexOf(optValue) >= 0) btn.classList.add('selected');
                let btnHtml = `<span class="oc-option-label">${escapeHtml(label)}</span>`;
                if (desc) btnHtml += `<span class="oc-option-desc">${escapeHtml(desc)}</span>`;
                btn.innerHTML = btnHtml;
                // 点击只 toggle 选中状态，不提交、不关闭；直接更新当前 DOM
                btn.addEventListener('click', () => {
                    // 多选判据：v2 表单字段用 type === 'multiselect'（老数据可能是 multiple 布尔）
                    const isMulti = !!(q.multiple || q.type === 'multiselect');
                    let cur = part.__pendingAnswers[qi] || [];
                    if (isMulti) {
                        cur = cur.indexOf(optValue) >= 0 ? cur.filter(x => x !== optValue) : cur.concat([optValue]);
                    } else {
                        cur = [optValue];
                        // 单选：清除该问题其他选项的高亮
                        optsDiv.querySelectorAll('.oc-question-option-btn').forEach(function(b) {
                            b.classList.remove('selected');
                        });
                    }
                    part.__pendingAnswers[qi] = cur;
                    // 当前按钮高亮
                    btn.classList.toggle('selected', cur.indexOf(optValue) >= 0);
                    // 与自定义输入互斥：点了选项就**清空该题的输入框**（但不置灰，用户仍可继续输入；
                    // 一旦继续输入就会反过来取消选项高亮）——始终"最后动作生效"，所见即所交。
                    part.__pendingCustom[qi] = '';
                    const customEl = qBlock.querySelector('.oc-question-custom-input');
                    if (customEl) customEl.value = '';
                    // 选择即视为在作答：取消"跳过"标记，否则提交时会被跳过逻辑吞掉
                    part.__pendingSkipped[qi] = false;
                    // 更新该问题"已答"提示
                    const answeredHint = qBlock.querySelector('.oc-question-answered-hint');
                    if (cur.length) {
                        if (!answeredHint) {
                            const hint = document.createElement('div');
                            hint.className = 'oc-question-answered-hint';
                            hint.textContent = '✅ 已答：' + cur.join(', ');
                            qBlock.appendChild(hint);
                        } else {
                            answeredHint.textContent = '✅ 已答：' + cur.join(', ');
                        }
                    } else if (answeredHint) {
                        answeredHint.remove();
                    }
                    // 更新头部计数
                    const headStatus = el.querySelector('.oc-tool-status');
                    if (headStatus) {
                        const answeredCount = part.__pendingAnswers.filter(function(a) { return a && a.length; }).length;
                        headStatus.textContent = questions.length > 1 && answeredCount > 0
                            ? '⏳ 已答 ' + answeredCount + '/' + questions.length
                            : '⏳ 等待回答';
                    }
                });
                optsDiv.appendChild(btn);
            });
            qBlock.appendChild(optsDiv);

            // 自定义输入（仅记录，无独立发送按钮，随底部总提交一起提交）
            const customRow = document.createElement('div');
            customRow.className = 'oc-question-custom';
            const customInput = document.createElement('input');
            customInput.className = 'oc-question-custom-input';
            customInput.placeholder = '✏️ 输入自定义回答...';
            customInput.value = part.__pendingCustom[qi] || '';
            customInput.addEventListener('input', () => {
                part.__pendingCustom[qi] = customInput.value;
                // 与选项互斥：一旦输入，就取消该题所有选项的高亮（最后动作生效）
                if (customInput.value.trim()) {
                    part.__pendingAnswers[qi] = [];
                    qBlock.querySelectorAll('.oc-question-option-btn').forEach(function(b) {
                        b.classList.remove('selected');
                    });
                    part.__pendingSkipped[qi] = false;
                }
                // 同步"已答"提示
                const val = customInput.value.trim();
                const answeredHint = qBlock.querySelector('.oc-question-answered-hint');
                if (val) {
                    if (!answeredHint) {
                        const hint = document.createElement('div');
                        hint.className = 'oc-question-answered-hint';
                        hint.textContent = '✅ 已答：' + val;
                        qBlock.appendChild(hint);
                    } else {
                        answeredHint.textContent = '✅ 已答：' + val;
                    }
                } else if (answeredHint) {
                    answeredHint.remove();
                }
            });
            customRow.appendChild(customInput);
            qBlock.appendChild(customRow);

            // 跳过按钮
            const skipRow = document.createElement('div');
            skipRow.className = 'oc-question-skip-row';
            const skipBtn = document.createElement('button');
            skipBtn.className = 'oc-question-skip-btn';
            skipBtn.textContent = '↩ 跳过此问题';
            // 单题跳过：标记该题跳过，不调 reject（reject 会跳过整个问题集）
            skipBtn.addEventListener('click', () => {
                part.__pendingSkipped[qi] = true;
                // 清掉该题已选答案
                part.__pendingAnswers[qi] = [];
                part.__pendingCustom[qi] = '';
                // 原位更新：隐藏选项/输入/跳过，显示已跳过
                const optsDiv = qBlock.querySelector('.oc-question-options');
                if (optsDiv) optsDiv.style.display = 'none';
                const customRow = qBlock.querySelector('.oc-question-custom');
                if (customRow) customRow.style.display = 'none';
                const skipRow = qBlock.querySelector('.oc-question-skip-row');
                if (skipRow) skipRow.style.display = 'none';
                const answeredHint = qBlock.querySelector('.oc-question-answered-hint');
                if (answeredHint) answeredHint.remove();
                const skippedDiv = document.createElement('div');
                skippedDiv.className = 'oc-question-answer oc-question-dismissed';
                skippedDiv.textContent = '↩ 已跳过此问题';
                qBlock.appendChild(skippedDiv);
                // 更新头部计数
                const headStatus = el.querySelector('.oc-tool-status');
                if (headStatus) {
                    const answeredCount = part.__pendingAnswers.filter(function(a) { return a && a.length; }).length;
                    headStatus.textContent = questions.length > 1 && answeredCount > 0
                        ? '⏳ 已答 ' + answeredCount + '/' + questions.length
                        : '⏳ 等待回答';
                }
                showToast('已跳过该问题', 'info');
            });
            skipRow.appendChild(skipBtn);
            qBlock.appendChild(skipRow);
        }

        body.appendChild(qBlock);
    });

    if (!questions.length) {
        if (state.input) {
            body.innerHTML += `<div class="oc-tool-io oc-tool-input"><div class="oc-tool-io-label">输入</div><pre><code>${escapeHtml(safeText(state.input))}</code></pre></div>`;
        }
    }

    // 运行中：底部统一提交按钮
    if (isRunning && questions.length) {
        const submitRow = document.createElement('div');
        submitRow.className = 'oc-question-submit-row';
        const submitBtn = document.createElement('button');
        submitBtn.className = 'oc-question-finish-btn';
        submitBtn.textContent = '✓ 提交回答';
        submitBtn.addEventListener('click', function() {
            submitAllAnswers();
        });
        submitRow.appendChild(submitBtn);
        body.appendChild(submitRow);
    }

    if (!isRunning) {
        const key = partExpandKey(part, 'question');
        body.dataset.expandKey = key;
        if (!store.expandedParts[key]) body.classList.add('hidden');
        head.addEventListener('click', () => {
            store.expandedParts[key] = !store.expandedParts[key];
            body.classList.toggle('hidden', !store.expandedParts[key]);
        });
    }

    el.appendChild(head);
    el.appendChild(body);
    return el;
}

/** 解析工具输入：v2 的 state.input 可能是对象，也可能是 JSON 字符串。
 *  解析失败返回 null（调用方回退到原展示）。 */
function toolInputObject(input) {
    if (input == null) return null;
    if (typeof input === 'string') {
        const t = input.trim();
        if (!t.startsWith('{')) return null;
        try { return JSON.parse(t); } catch (_) { return null; }
    }
    return typeof input === 'object' ? input : null;
}

/** 渲染通用工具调用（Shell/文件操作，带输入/输出/错误展示） */
export function renderTool(part) {
    const tool = part.tool || part.name || '';

    // question 工具使用专用渲染
    if (tool === 'question') {
        return renderQuestionTool(part);
    }

    const state = part.state || {};
    const status = state.status || '';
    const isCompleted = status === 'completed';
    const isError = status === 'error';
    const isRunning = status === 'running';
    const key = partExpandKey(part, tool || 'tool');

    const isShell = tool === 'bash' || tool === 'shell';

    // 细粒度文件操作分类
    const fileCategoryMap = {
        read:              { cat: 'file-read',     icon: '📖', label: '读取文件' },
        look_at:           { cat: 'file-read',     icon: '📖', label: '读取文件' },
        glob:              { cat: 'file-search',   icon: '🔍', label: '搜索文件' },
        grep:              { cat: 'file-search',   icon: '🔍', label: '搜索文件' },
        ast_grep_search:   { cat: 'file-search',   icon: '🔍', label: '搜索文件' },
        ast_grep_replace:  { cat: 'file-edit',     icon: '✏️', label: '编辑文件' },
        edit:              { cat: 'file-edit',     icon: '✏️', label: '编辑文件' },
        write:             { cat: 'file-create',   icon: '📝', label: '创建文件' },
    };

    const fc = fileCategoryMap[tool];
    const category = isShell ? 'shell' : (fc ? fc.cat : 'tool');

    const el = document.createElement('div');
    el.className = `oc-part oc-tool oc-tool-${category}` + (isCompleted ? ' done' : '') + (isError ? ' error' : '') + (isRunning ? ' running' : '');

    const head = document.createElement('div');
    head.className = 'oc-tool-head';

    const iconMap = { shell: '💻', tool: '🔧' };
    const labelMap = { shell: '指令执行', tool: '工具调用' };
    const icon = fc ? fc.icon : (iconMap[category] || '🔧');
    const label = fc ? fc.label : (labelMap[category] || '工具调用');

    let statusText = '';
    let statusClass = '';
    if (isCompleted) { statusText = '✓ 完成'; statusClass = 'ok'; }
    else if (isError) { statusText = '✗ 失败'; statusClass = 'err'; }
    else if (isRunning) { statusText = '⏳ 运行中'; statusClass = 'running'; }
    else { statusText = status || '等待'; statusClass = 'pending'; }

    // 文件类工具的输入里带绝对路径（input 可能是对象或 JSON 字符串），
    // 标题优先用它，避免只显示工具名；其他工具仍用 state.title。
    const fileInput = fc ? toolInputObject(state.input) : null;
    const filePath = fileInput
        ? (fileInput.filePath || fileInput.file_path || fileInput.path || fileInput.filename || '')
        : '';
    const title = filePath || state.title || tool;
    head.innerHTML = `<span class="oc-tool-icon">${icon}</span> ${label}: <strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong> <span class="oc-tool-status ${statusClass}">${statusText}</span>` + buildDurationHtml(part, true);

    const body = document.createElement('div');
    body.className = 'oc-tool-body';
    body.dataset.expandKey = key;
    body.dataset.defaultExpanded = isRunning ? 'true' : 'false';

    // edit 类工具（edit/ast_grep_replace）：优先走左右对比渲染；input 无法解析时降级回 JSON 展示
    if (fc && fc.cat === 'file-edit' && state.input) {
        const editInput = parseEditInput(state.input);
        if (editInput) {
            return renderEditDiff(part, tool);
        }
    }

    if (state.input) {
        const inputDiv = document.createElement('div');
        inputDiv.className = 'oc-tool-io oc-tool-input';
        if (isShell && state.input.command) {
            inputDiv.innerHTML = `<div class="oc-tool-io-label">命令</div><pre><code>${escapeHtml(state.input.command)}</code></pre>`;
        } else {
            inputDiv.innerHTML = `<div class="oc-tool-io-label">输入</div><pre><code>${escapeHtml(safeText(state.input))}</code></pre>`;
        }
        body.appendChild(inputDiv);
    }

    if (state.output) {
        const outDiv = document.createElement('div');
        outDiv.className = 'oc-tool-io oc-tool-output';
        outDiv.innerHTML = `<div class="oc-tool-io-label">输出</div><pre><code>${escapeHtml(safeText(state.output))}</code></pre>`;
        body.appendChild(outDiv);
    }

    if (state.error) {
        const errDiv = document.createElement('div');
        errDiv.className = 'oc-tool-io oc-tool-error';
        errDiv.innerHTML = `<div class="oc-tool-io-label">错误</div><pre><code>${escapeHtml(safeText(state.error))}</code></pre>`;
        body.appendChild(errDiv);
    }

    if (!state.input && !state.output && !state.error) {
        body.innerHTML = `<div class="oc-tool-io"><pre><code>${escapeHtml(safeText(part))}</code></pre></div>`;
    }

    const expanded = store.expandedParts[key] ?? isRunning;
    if (!expanded) body.classList.add('hidden');

    head.addEventListener('click', () => {
        store.expandedParts[key] = !(store.expandedParts[key] ?? isRunning);
        body.classList.toggle('hidden', !store.expandedParts[key]);
    });

    el.appendChild(head);
    el.appendChild(body);
    return el;
}

// ── edit 工具左右对比渲染 ──

/** 解析 edit 工具的输入（兼容对象与 JSON 字符串两种形态）。
 *  返回 { filePath, oldString, newString }；解析失败返回 null（调用方降级回 JSON 展示）。 */
export function parseEditInput(input) {
    if (input == null) return null;
    let obj = input;
    if (typeof input === 'string') {
        const t = input.trim();
        if (!t.startsWith('{')) return null;
        try { obj = JSON.parse(t); } catch (_) { return null; }
    }
    if (typeof obj !== 'object' || obj === null) return null;
    const oldString = typeof obj.oldString === 'string' ? obj.oldString : '';
    const newString = typeof obj.newString === 'string' ? obj.newString : '';
    // 至少要有新文本；纯新增文件（old 为空）也支持对比展示
    if (oldString === '' && newString === '') return null;
    const filePath = (typeof obj.filePath === 'string' && obj.filePath) ? obj.filePath
        : (typeof obj.path === 'string' && obj.path) ? obj.path
        : (typeof obj.filename === 'string' && obj.filename) ? obj.filename
        : '';
    return { filePath, oldString, newString };
}

/** 行级 LCS diff：返回左右两侧各行的类型标记数组。
 *  old 侧每项 { text, type: 'unchanged'|'removed' }，new 侧每项 { text, type: 'unchanged'|'added' }。 */
export function lcsDiff(oldLines, newLines) {
    const n = oldLines.length;
    const m = newLines.length;
    // dp[i][j] = old[0..i) 与 new[0..j) 的 LCS 长度
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            dp[i][j] = (oldLines[i - 1] === newLines[j - 1])
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    // 回溯标记
    const oldMarked = oldLines.map(text => ({ text, type: 'removed' }));
    const newMarked = newLines.map(text => ({ text, type: 'added' }));
    let i = n, j = m;
    while (i > 0 && j > 0) {
        if (oldLines[i - 1] === newLines[j - 1]) {
            oldMarked[i - 1].type = 'unchanged';
            newMarked[j - 1].type = 'unchanged';
            i--; j--;
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
            i--;
        } else {
            j--;
        }
    }
    return { old: oldMarked, new: newMarked };
}

/** 渲染 edit 工具左右对比视图（行级 diff 高亮 + 统计条）。
 *  返回 DOM 元素（含头部/路径/统计/两栏正文），支持 store.expandedParts 折叠。 */
export function renderEditDiff(part, tool) {
    const input = parseEditInput(part.state && part.state.input);
    const el = document.createElement('div');
    el.className = 'oc-part oc-tool oc-tool-file-edit';

    const isRunning = (part.state && part.state.status) === 'running';
    const isCompleted = (part.state && part.state.status) === 'completed';
    const isError = (part.state && part.state.status) === 'error';
    if (isCompleted) el.classList.add('done');
    if (isError) el.classList.add('error');
    if (isRunning) el.classList.add('running');

    const key = partExpandKey(part, tool || 'edit');
    const expanded = !!(store.expandedParts[key] ?? isRunning);

    // 头部：图标 + 标签 + 文件路径 + 状态 + 统计
    const head = document.createElement('div');
    head.className = 'oc-tool-head';
    let statusText = '', statusClass = '';
    if (isCompleted) { statusText = '✓ 完成'; statusClass = 'ok'; }
    else if (isError) { statusText = '✗ 失败'; statusClass = 'err'; }
    else if (isRunning) { statusText = '⏳ 运行中'; statusClass = 'running'; }
    else { statusText = '等待'; statusClass = 'pending'; }

    const oldLines = input.oldString.split('\n');
    const newLines = input.newString.split('\n');
    const diff = lcsDiff(oldLines, newLines);
    const addedCount = diff.new.filter(l => l.type === 'added').length;
    const removedCount = diff.old.filter(l => l.type === 'removed').length;

    const pathText = input.filePath || '文件';
    const statsHtml = addedCount || removedCount
        ? ` <span class="oc-edit-stats"><span class="oc-edit-stats-add">+${addedCount}</span> <span class="oc-edit-stats-del">-${removedCount}</span></span>`
        : '';
    head.innerHTML = `<span class="oc-tool-icon">✏️</span> 编辑文件: <strong title="${escapeHtml(pathText)}">${escapeHtml(pathText)}</strong> <span class="oc-tool-status ${statusClass}">${statusText}</span>${statsHtml}` + buildDurationHtml(part, true);

    // 正文：左右两栏
    const body = document.createElement('div');
    body.className = 'oc-tool-body oc-edit-diff';
    body.dataset.expandKey = key;
    if (!expanded) body.classList.add('hidden');

    const oldPane = document.createElement('div');
    oldPane.className = 'oc-edit-pane oc-edit-pane-old';
    const newPane = document.createElement('div');
    newPane.className = 'oc-edit-pane oc-edit-pane-new';

    const renderPane = (lines, pane) => {
        const frag = document.createDocumentFragment();
        lines.forEach((line, idx) => {
            const row = document.createElement('div');
            row.className = 'oc-diff-line diff-' + line.type;
            const num = document.createElement('span');
            num.className = 'oc-diff-lineno';
            num.textContent = String(idx + 1);
            const code = document.createElement('code');
            code.textContent = line.text === '' ? ' ' : line.text;
            row.appendChild(num);
            row.appendChild(code);
            frag.appendChild(row);
        });
        pane.appendChild(frag);
    };
    renderPane(diff.old, oldPane);
    renderPane(diff.new, newPane);

    body.appendChild(oldPane);
    body.appendChild(newPane);

    head.addEventListener('click', () => {
        store.expandedParts[key] = !(store.expandedParts[key] ?? isRunning);
        body.classList.toggle('hidden', !store.expandedParts[key]);
    });

    el.appendChild(head);
    el.appendChild(body);
    return el;
}
// ── question 工具回复 ──

/**
 * 提交 Question 工具的回答。
 * 多问题场景：answers 为按问题顺序的二维数组（每个问题一个 string[]）。
 */
export async function answerQuestion(answers) {
    if (!store.currentSessionId) return;
    store.questionCustomInput = '';
    const input = document.getElementById('ocPrompt');
    try {
        // 兼容单值：传字符串时转成单问题单答案
        const answersArr = Array.isArray(answers)
            ? answers
            : [[answers]];
        const result = await api.AnswerQuestion(store.currentSessionId, answersArr);
        if (result && result.success) {
            showToast('已回答', 'success');
            if (input) input.value = '';
            // SSE 事件会自动推送模型响应，无需手动 loadMessages
        } else {
            showToast('回答失败: ' + ((result && result.error) || '未知错误'), 'error');
            if (input) { input.value = typeof answers === 'string' ? answers : ''; input.focus(); }
        }
    } catch (e) {
        showApiError('回答失败: ', e);
        if (input) { input.value = typeof answers === 'string' ? answers : ''; input.focus(); }
    }
}

/** 渲染文本 Part（Markdown 渲染） */
export function renderTextPart(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-text';
    const text = (part && (part.text || part.content || part.message || part.value)) || '';
    el.innerHTML = typeof marked !== 'undefined'
        ? sanitizeMarkedHtml(marked.parse(text || '', { breaks: true }))
        : `<pre>${escapeHtml(text || '')}</pre>`;
    // 本地图片（C:\... / file:// / 相对路径）异步替换为 data URL，避免破图
    hydrateLocalImages(el, currentDir());
    return el;
}

/** 渲染文件 Part：可折叠显示内容；image/* 展开后显示固定尺寸图像，其余展开显示文本 */
export function renderFilePart(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-file';
    const key = partExpandKey(part, part.filename || part.path || 'file');
    const filename = part.filename || part.path || part.file || '附件';
    const mime = (part.mime || part.type || 'file').toLowerCase();
    const url = part.url || part.content || '';
    const isImage = mime.startsWith('image/') && url;
    const raw = url || safeText(part);
    const size = raw.length > 1024 ? `${Math.round(raw.length / 1024)} KB` : `${raw.length} B`;
    // 图像不显示 size，其余显示 size
    const meta = `${escapeHtml(mime)} · ${size}`;
    const expanded = !!store.expandedParts[key];
    const head = document.createElement('div');
    head.className = 'oc-file-path';
    head.innerHTML = `<span>📎 ${escapeHtml(filename)}</span><span class="oc-file-meta">${meta} · ${expanded ? '收起' : '展开'}</span>`;
    // body：图像用 <img> 固定尺寸，其余用 <pre> 文本
    let body;
    if (isImage) {
        body = document.createElement('img');
        body.src = url;
        body.alt = filename;
        body.loading = 'lazy';
        body.className = 'oc-file-image' + (expanded ? '' : ' hidden');
    } else {
        body = document.createElement('pre');
        body.className = expanded ? '' : 'hidden';
        body.textContent = raw;
    }
    body.dataset.expandKey = key;
    head.addEventListener('click', () => {
        store.expandedParts[key] = !store.expandedParts[key];
        body.classList.toggle('hidden', !store.expandedParts[key]);
        head.querySelector('.oc-file-meta').textContent = `${meta} · ${store.expandedParts[key] ? '收起' : '展开'}`;
    });
    el.appendChild(head);
    el.appendChild(body);
    return el;
}

/** 渲染代码变更 Patch Part（文件路径 + diff 内容） */
export function renderPatchPart(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-patch';

    let fileInfo = '';
    if (Array.isArray(part.files) && part.files.length) {
        const first = part.files[0];
        const rest = part.files.length > 1 ? ` 等 ${part.files.length} 个文件` : '';
        fileInfo = escapeHtml(first) + rest;
    } else {
        fileInfo = escapeHtml(part.path || part.file || '');
    }
    const pathHtml = fileInfo ? `<div class="oc-patch-path">📝 ${fileInfo}</div>` : '';

    let codeHtml = '';
    if (part.patch) {
        codeHtml = `<pre><code>${escapeHtml(part.patch)}</code></pre>`;
    } else if (part.hash) {
        codeHtml = `<div class="oc-patch-hash">变更: <code>${escapeHtml(part.hash)}</code></div>`;
    }

    el.innerHTML = pathHtml + codeHtml;
    return el;
}

/** 渲染上下文压缩标记 Part */
export function renderCompaction(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-compaction';
    const auto = part.auto;
    el.innerHTML = auto
        ? '🗜️ 自动压缩上下文'
        : '🗜️ 上下文已压缩';
    return el;
}

/** 渲染文件快照 Part */
export function renderSnapshot(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-snapshot';
    const hash = (part.snapshot || '').slice(0, 7);
    el.innerHTML = hash
        ? `<span class="oc-snapshot-icon">📸</span> 文件快照 <span class="oc-snapshot-hash">${escapeHtml(hash)}</span>`
        : '<span class="oc-snapshot-icon">📸</span> 文件快照';
    return el;
}

/** 渲染重试标记 Part（显示重试次数和错误信息） */
export function renderRetry(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-retry';
    const attempt = part.attempt || 0;
    const msg = part.error?.data?.message || part.error?.message || '';
    el.innerHTML = msg
        ? `🔄 第 ${attempt} 次重试 — <span class="oc-retry-msg">${escapeHtml(msg)}</span>`
        : `🔄 第 ${attempt} 次重试`;
    return el;
}

/** 渲染未知类型 Part（降级方案，纯文本显示） */
export function renderFallback(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-fallback';
    const pre = document.createElement('pre');
    pre.textContent = extractPartText(part) || safeText(part);
    el.appendChild(pre);
    return el;
}
