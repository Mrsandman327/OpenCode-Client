// ============================================================
// chat-cache.js — 消息缓存管理
// 负责消息的内存缓存、增量合并、SSE delta 应用和渲染调度
// 依赖：core/state.js（messageCache, currentSessionId）、core/utils.js（getTabMessagesEl, getCachedMessages,
//       normalizeMessageItem, isInternalUserMessage）、chat/render.js（renderMessages）
// 说明：getCachedMessages 已移入 core/utils.js 以打破 cache↔render 循环依赖；
//       normalizeMessageItem / isInternalUserMessage 已移入 core/utils.js 以打破 service↔render 循环依赖。
// ============================================================

import { store } from '../core/state.js';
import { getTabMessagesEl, getCachedMessages, normalizeMessageItem, isInternalUserMessage } from '../core/utils.js';
import { renderMessages, isSessionBusy } from './render.js';

// ============================
// 消息缓存与渲染
// ============================

/** 尚未被服务端确认的本地乐观用户消息 id。
 *  发送时通过 body.messageID 把本地 id 交给 opencode，确认后 id 不变，
 *  因此这里只用于「发送失败时回滚」以及判断消息是否仍处于待确认状态。
 *  （改用 messageID 方案后，不再依赖 `user_local_` id 前缀来识别乐观消息。） */
const pendingUserMessageIds = new Set();

/**
 * 缓存会话消息（增量合并模式）
 * 会话非忙碌或缓存为空时直接覆盖，否则按 id 逐个合并新消息
 */
export function cacheMessages(sessionID, items) {
    const incoming = (items || []).map(normalizeMessageItem).filter(item => !isInternalUserMessage(item));
    if (!isSessionBusy(sessionID) || !store.messageCache[sessionID]?.length) {
        // 全量覆盖：这些消息已由服务端确认，对应的乐观标记随之失效
        incoming.forEach(item => {
            const id = item.info?.id || item.id;
            if (id) pendingUserMessageIds.delete(id);
        });
        store.messageCache[sessionID] = incoming;
        return;
    }
    // 乐观用户消息与服务端消息共用同一个 id（发送时用 body.messageID 指定），
    // 因此这里不需要任何「按位置或按文本寻找乐观占位」的特殊处理，按 id 合并即可。
    const existing = getCachedMessages(sessionID);
    for (const item of incoming) {
        const key = item.info?.id || item.id;
        const existingIndex = existing.findIndex(old => (old.info?.id || old.id) === key);
        if (existingIndex >= 0) {
            existing[existingIndex] = mergeMessage(existing[existingIndex], item);
        } else {
            existing.push(item);
        }
        if ((item.info?.role || item.role) === 'user' && key) pendingUserMessageIds.delete(key);
    }
    store.messageCache[sessionID] = existing;
}

/**
 * 前置合并更早的消息（分页加载历史用）。
 * 新消息（更早）按 id 去重后插入缓存数组头部，保持 旧→新 顺序。
 */
export function prependMessages(sessionID, items) {
    if (!sessionID) return;
    const incoming = (items || []).map(normalizeMessageItem).filter(item => !isInternalUserMessage(item));
    if (!incoming.length) return;
    const existing = getCachedMessages(sessionID);
    const existingIds = new Set(existing.map(item => item.info?.id || item.id));
    const merged = [];
    for (const item of incoming) {
        const key = item.info?.id || item.id;
        if (!key || existingIds.has(key)) continue; // 去重（before 为排他游标，正常不重复，兜底）
        merged.push(item);
    }
    if (merged.length) {
        store.messageCache[sessionID] = merged.concat(existing);
    }
}

/** 合并两条消息（info 浅合并，parts 逐个按 id 合并）。
 *  服务端返回了真实 parts 时，先丢弃本地乐观 part（id 非 `prt_` 前缀，由 cacheLocalUserMessage
 *  在发送瞬间造出），否则同一条消息里会同时存在本地造的和服务端推的两份 part，显示为重复。 */
export function mergeMessage(existing, incoming) {
    if (!existing) return incoming;
    const existingParts = Array.isArray(existing.parts) ? existing.parts : [];
    const incomingParts = Array.isArray(incoming.parts) ? incoming.parts : [];
    const baseParts = incomingParts.length
        ? existingParts.filter(part => typeof part?.id === 'string' && part.id.startsWith('prt_'))
        : existingParts;
    const mergedParts = [...baseParts];
    for (const part of incomingParts) {
        const existingIndex = mergedParts.findIndex(old => old.id && old.id === part.id);
        if (existingIndex >= 0) {
            mergedParts[existingIndex] = mergePart(mergedParts[existingIndex], part);
        } else {
            mergedParts.push(part);
        }
    }
    return {
        info: { ...existing.info, ...incoming.info },
        parts: mergedParts,
    };
}

/**
 * 合并两个 part
 * 保护流式输出中的长文本不被后续较短增量覆盖
 * （当新文本长度 < 旧文本长度且未标记 time.end 时保留旧文本）
 */
export function mergePart(existing, incoming) {
    if (!existing) return incoming;
    const merged = { ...existing, ...incoming };
    for (const field of ['text', 'content']) {
        const oldText = typeof existing[field] === 'string' ? existing[field] : '';
        const newText = typeof incoming[field] === 'string' ? incoming[field] : '';
        if (oldText && newText && newText.length < oldText.length && !incoming.time?.end) {
            merged[field] = oldText;
        }
    }
    return merged;
}

/** 渲染会话缓存消息（渲染到该会话自己的 tab 容器；容器不存在则跳过） */
export function renderCachedMessages(sessionID) {
    if (!sessionID) return;
    var el = getTabMessagesEl(sessionID);
    if (!el) return;
    renderMessages(getCachedMessages(sessionID), el);
}

/** 调度下一帧渲染缓存消息（防抖；多会话各自记录待渲染，一帧内多次调用只触发一次） */
var _pendingRenderSessions = {};
var _pendingRenderFrame = 0;
export function scheduleRenderCachedMessages(sessionID) {
    if (!sessionID) return;
    _pendingRenderSessions[sessionID] = true;
    if (_pendingRenderFrame) return;
    _pendingRenderFrame = requestAnimationFrame(() => {
        _pendingRenderFrame = 0;
        var targets = Object.keys(_pendingRenderSessions);
        _pendingRenderSessions = {};
        targets.forEach(function(sid) {
            renderCachedMessages(sid);
        });
    });
}

/** 移除本地乐观用户消息（发送失败时回滚，避免残留"已发送"假象）。
 *  乐观消息与服务端消息共用同一个 id，因此按 id 精确删除即可。 */
export function removeLocalUserMessage(sessionID, messageId) {
    if (!sessionID) return;
    if (messageId) {
        store.messageCache[sessionID] = getCachedMessages(sessionID).filter(item => (item.info?.id || item.id) !== messageId);
        pendingUserMessageIds.delete(messageId);
        return;
    }
    // 未指定 id 时的兜底：移除所有仍处于待确认状态的乐观消息
    store.messageCache[sessionID] = getCachedMessages(sessionID).filter(item => !pendingUserMessageIds.has(item.info?.id || item.id));
}

/**
 * 乐观添加用户消息到缓存：发送后立即显示用户输入，不必等 API/SSE 推送。
 * 使用调用方生成的 messageId（会随请求通过 body.messageID 交给 opencode），
 * 因此服务端确认后的消息 id 与本地完全一致，回执时按 id 命中即可，无需任何猜测。
 * @param {string} sessionID 会话 id
 * @param {string} messageId 本地生成且会发给 opencode 的消息 id（必须以 msg 开头）
 * @param {Array} parts 发送用的 parts（正文 + 附件，通常来自 buildParts(text)）；
 *                      这里为每个 part 补上本地 id，供渲染与排序使用。
 *                      传入完整 parts 后，附件在乐观卡片里同样立即可见。
 */
export function cacheLocalUserMessage(sessionID, messageId, parts) {
    const source = Array.isArray(parts) ? parts : [];
    if (!sessionID || !messageId || !source.length) return;
    const list = getCachedMessages(sessionID);
    pendingUserMessageIds.add(messageId);
    const msg = {
        info: { id: messageId, sessionID, role: 'user', time: { created: Date.now() } },
        parts: source.map(function (part, i) {
            return { ...part, id: messageId + '_p' + i, sessionID, messageID: messageId };
        }),
    };
    // 插到 pending assistant 占位之前；无占位则追加末尾
    const pendingIdx = list.findIndex(item => (item.info?.id || item.id || '').startsWith('pending_'));
    if (pendingIdx >= 0) {
        list.splice(pendingIdx, 0, msg);
    } else {
        list.push(msg);
    }
    store.messageCache[sessionID] = list;
}

/** 按 info 插入或更新消息 */
export function upsertMessage(info) {
    if (!info?.sessionID || !info.id) return;
    const list = getCachedMessages(info.sessionID);
    if (info.role === 'assistant') {
        store.messageCache[info.sessionID] = list.filter(item => !(item.info?.id || item.id || '').startsWith('pending_'));
    } else if (info.role === 'user') {
        // 乐观消息用的就是同一个 id（发送时通过 body.messageID 指定），因此这里只需解除
        // 待确认标记，随后按 id 走下面的正常合并即可 —— 不再需要「找最近一条乐观占位再升级」。
        pendingUserMessageIds.delete(info.id);
    }
    const nextList = getCachedMessages(info.sessionID);
    const index = nextList.findIndex(item => (item.info?.id || item.id) === info.id);
    if (index >= 0) {
        nextList[index].info = { ...nextList[index].info, ...info };
    } else {
        nextList.push({ info, parts: [] });
    }
}

/** 按 id 插入或更新 part */
export function upsertPart(part) {
    if (!part?.sessionID || !part.messageID || !part.id) return;
    const list = getCachedMessages(part.sessionID);
    let message = list.find(item => (item.info?.id || item.id) === part.messageID);
    if (!message) {
        message = { info: { id: part.messageID, sessionID: part.sessionID, role: 'assistant' }, parts: [] };
        list.push(message);
    }
    const parts = Array.isArray(message.parts) ? message.parts : [];
    // 用户消息的真实 part 到达时，丢弃本地乐观 part（id 非 `prt_` 前缀，由 cacheLocalUserMessage 造出），
    // 由服务端 part 取代，避免同一条消息里出现本地和服务端两份内容。
    const isUserMsg = (message.info?.role || message.role) === 'user';
    const filtered = isUserMsg ? parts.filter(p => typeof p?.id === 'string' && p.id.startsWith('prt_')) : parts;
    const index = filtered.findIndex(item => item.id === part.id);
    if (index >= 0) {
        filtered[index] = mergePart(filtered[index], part);
    } else {
        filtered.push(part);
    }
    message.parts = filtered;
}

/** 应用流式文本增量到消息 part */
export function applyPartDelta(props) {
    const sessionID = props.sessionID || store.currentSessionId;
    const field = props.field || 'text';
    if (!sessionID || !props.messageID || !props.partID || typeof props.delta !== 'string') return;
    const list = getCachedMessages(sessionID);
    let message = list.find(item => (item.info?.id || item.id) === props.messageID);
    if (!message) {
        message = { info: { id: props.messageID, sessionID, role: 'assistant' }, parts: [] };
        list.push(message);
    }
    const parts = Array.isArray(message.parts) ? message.parts : [];
    let part = parts.find(item => item.id === props.partID);
    if (!part) {
        part = { id: props.partID, sessionID, messageID: props.messageID, type: field === 'text' ? 'text' : 'reasoning', [field]: '' };
        parts.push(part);
    }
    part[field] = (part[field] || '') + props.delta;
    message.parts = parts;
}

/** 按 id 移除 part */
export function removePart(props) {
    const sessionID = props.sessionID || store.currentSessionId;
    if (!sessionID || !props.messageID || !props.partID) return;
    const message = getCachedMessages(sessionID).find(item => (item.info?.id || item.id) === props.messageID);
    if (!message || !Array.isArray(message.parts)) return;
    message.parts = message.parts.filter(part => part.id !== props.partID);
}

/** 按 id 移除消息 */
export function removeMessage(props) {
    const sessionID = props.sessionID || store.currentSessionId;
    if (!sessionID || !props.messageID) return;
    store.messageCache[sessionID] = getCachedMessages(sessionID).filter(item => (item.info?.id || item.id) !== props.messageID);
}

/**
 * 确保会话缓存末尾有 pending assistant
 * 发送消息前调用，若最后一条不是 assistant 角色则插入占位项
 */
export function ensurePendingAssistant(sessionID) {
    if (!sessionID) return;
    const list = getCachedMessages(sessionID);
    const last = list[list.length - 1];
    const role = last?.info?.role || last?.role;
    if (role === 'assistant') {
        const info = last?.info || last || {};
        const hasTerminalError = !!(info.error?.message || info.error?.data?.message || info.error);
        const isCompleted = !!info.time?.completed;
        if (!hasTerminalError && !isCompleted) return;
    }
    list.push({
        info: {
            id: 'pending_' + Date.now(),
            sessionID,
            role: 'assistant',
            time: { created: Date.now() },
        },
        parts: [],
    });
}

/** 渲染等待助手回复的占位提示 */
export function renderPendingAssistantPlaceholder(sessionID) {
	if (!sessionID || sessionID !== store.currentSessionId) return;
	const box = getTabMessagesEl(sessionID);
	if (!box) return;
	box.innerHTML = '<div class="oc-empty">正在等待模型回复...</div>';
}
