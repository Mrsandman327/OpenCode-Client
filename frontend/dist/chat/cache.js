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

/**
 * 缓存会话消息（增量合并模式）
 * 会话非忙碌或缓存为空时直接覆盖，否则按 id 逐个合并新消息
 */
export function cacheMessages(sessionID, items) {
    const incoming = (items || []).map(normalizeMessageItem).filter(item => !isInternalUserMessage(item));
    if (!isSessionBusy(sessionID) || !store.messageCache[sessionID]?.length) {
        store.messageCache[sessionID] = incoming;
        return;
    }
    const existing = getCachedMessages(sessionID);
    for (const item of incoming) {
        const key = item.info?.id || item.id;
        const existingIndex = existing.findIndex(old => (old.info?.id || old.id) === key);
        if (existingIndex >= 0) {
            existing[existingIndex] = mergeMessage(existing[existingIndex], item);
        } else {
            existing.push(item);
        }
    }
    store.messageCache[sessionID] = existing;
}

/** 合并两条消息（info 浅合并，parts 逐个按 id 合并） */
export function mergeMessage(existing, incoming) {
    if (!existing) return incoming;
    const existingParts = Array.isArray(existing.parts) ? existing.parts : [];
    const incomingParts = Array.isArray(incoming.parts) ? incoming.parts : [];
    const mergedParts = [...existingParts];
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

/** 按 info 插入或更新消息 */
export function upsertMessage(info) {
    if (!info?.sessionID || !info.id) return;
    const list = getCachedMessages(info.sessionID);
    if (info.role === 'assistant') {
        store.messageCache[info.sessionID] = list.filter(item => !(item.info?.id || item.id || '').startsWith('pending_'));
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
    const index = parts.findIndex(item => item.id === part.id);
    if (index >= 0) {
        parts[index] = mergePart(parts[index], part);
    } else {
        parts.push(part);
    }
    message.parts = parts;
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
