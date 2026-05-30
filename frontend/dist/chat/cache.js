// ============================================================
// chat-cache.js — 消息缓存管理
// 负责消息的内存缓存、增量合并、SSE delta 应用和渲染调度
// ============================================================

// ============================
// 消息缓存与渲染
// ============================

/**
 * 缓存会话消息（增量合并模式）
 * 会话非忙碌或缓存为空时直接覆盖，否则按 id 逐个合并新消息
 */
function cacheMessages(sessionID, items) {
    const incoming = (items || []).map(normalizeMessageItem).filter(item => !isInternalUserMessage(item));
    if (!isSessionBusy(sessionID) || !messageCache[sessionID]?.length) {
        messageCache[sessionID] = incoming;
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
    messageCache[sessionID] = existing;
}

/** 合并两条消息（info 浅合并，parts 逐个按 id 合并） */
function mergeMessage(existing, incoming) {
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
function mergePart(existing, incoming) {
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

/** 获取会话缓存消息（不存在则初始化为空数组） */
function getCachedMessages(sessionID) {
    if (!messageCache[sessionID]) messageCache[sessionID] = [];
    return messageCache[sessionID];
}

/** 渲染会话缓存消息 */
function renderCachedMessages(sessionID) {
    if (!sessionID || sessionID !== currentSessionId) return;
    renderMessages(getCachedMessages(sessionID));
}

/** 调度下一帧渲染缓存消息（防抖：同一帧内多次调用只触发一次） */
function scheduleRenderCachedMessages(sessionID) {
    if (!sessionID || sessionID !== currentSessionId) return;
    pendingMessageRenderSession = sessionID;
    if (pendingMessageRenderFrame) return;
    pendingMessageRenderFrame = requestAnimationFrame(() => {
        const target = pendingMessageRenderSession;
        pendingMessageRenderFrame = 0;
        pendingMessageRenderSession = '';
        renderCachedMessages(target);
    });
}

/** 按 info 插入或更新消息 */
function upsertMessage(info) {
    if (!info?.sessionID || !info.id) return;
    const list = getCachedMessages(info.sessionID);
    if (info.role === 'assistant') {
        messageCache[info.sessionID] = list.filter(item => !(item.info?.id || item.id || '').startsWith('pending_'));
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
function upsertPart(part) {
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
function applyPartDelta(props) {
    const sessionID = props.sessionID || currentSessionId;
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
function removePart(props) {
    const sessionID = props.sessionID || currentSessionId;
    if (!sessionID || !props.messageID || !props.partID) return;
    const message = getCachedMessages(sessionID).find(item => (item.info?.id || item.id) === props.messageID);
    if (!message || !Array.isArray(message.parts)) return;
    message.parts = message.parts.filter(part => part.id !== props.partID);
}

/** 按 id 移除消息 */
function removeMessage(props) {
    const sessionID = props.sessionID || currentSessionId;
    if (!sessionID || !props.messageID) return;
    messageCache[sessionID] = getCachedMessages(sessionID).filter(item => (item.info?.id || item.id) !== props.messageID);
}

/**
 * 确保会话缓存末尾有 pending assistant
 * 发送消息前调用，若最后一条不是 assistant 角色则插入占位项
 */
function ensurePendingAssistant(sessionID) {
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
function renderPendingAssistantPlaceholder(sessionID) {
	if (!sessionID || sessionID !== currentSessionId) return;
	const box = document.getElementById('ocMessages');
	if (!box) return;
	box.innerHTML = '<div class="oc-empty">正在等待模型回复...</div>';
}
