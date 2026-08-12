// ============================================================
// chat-render.js — 消息渲染引擎
// 负责消息列表渲染、12 种 part 类型渲染器、滚动管理和模型信息同步
// ============================================================

/** 清洗 marked 渲染结果：移除会引发副作用的标签（脚本、meta 跳转、iframe 等）与事件属性 */
function sanitizeMarkedHtml(html) {
    var template = document.createElement('template');
    template.innerHTML = html;
    var dangerousTags = ['SCRIPT', 'META', 'IFRAME', 'OBJECT', 'EMBED', 'STYLE', 'LINK', 'BASE', 'FORM', 'INPUT', 'BUTTON'];
    template.content.querySelectorAll('*').forEach(function(node) {
        if (dangerousTags.indexOf(node.tagName) >= 0) {
            node.parentNode.removeChild(node);
            return;
        }
        Array.prototype.slice.call(node.attributes || []).forEach(function(attr) {
            if (/^on/i.test(attr.name)) {
                node.removeAttribute(attr.name);
            }
        });
    });
    return template.innerHTML;
}

/** 移动端消息截断：限制可见消息数量，返回末尾 N 条 */
function trimMessagesForRender(items) {
	const list = Array.isArray(items) ? items : [];
	if (list.length <= visibleMessageCount) {
		return list;
	}
	return list.slice(-visibleMessageCount);
}

/** 渲染移动端折叠提示按钮（点击加载更多历史消息） */
function renderCollapsedHistoryNotice(totalCount, hiddenCount, box) {
	const boxEl = box || getActiveMessagesEl();
	if (!boxEl || hiddenCount <= 0) return;
	const notice = document.createElement('button');
	notice.type = 'button';
	notice.className = 'btn btn-sm oc-history-more';
	notice.textContent = `已折叠较早消息，点击加载更多（前面还有 ${hiddenCount} 条）`;
	notice.addEventListener('click', () => {
		const prevHeight = boxEl.scrollHeight;
        if (isMobileTreeMode()) { 
            visibleMessageCount += MOBILE_MESSAGE_LOAD_MORE_STEP; 
        }else{
            visibleMessageCount += PC_MESSAGE_LOAD_MORE_STEP;
        }
		renderMessages(getCachedMessages(currentSessionId), boxEl);
		const nextHeight = boxEl.scrollHeight;
		boxEl.scrollTop += nextHeight - prevHeight;
	});
	boxEl.prepend(notice);
}

/** 保存元素焦点状态（用于 DOM 重建后恢复焦点） */
function saveFocusState(el) {
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
function restoreFocusState(container, state) {
    const el = container.querySelector(state.selector);
    if (!el) return;
    try { el.focus(); } catch (_) {}
    try {
        if (typeof state.start === 'number') el.selectionStart = state.start;
        if (typeof state.end === 'number') el.selectionEnd = state.end;
    } catch (_) {}
}

/** 构建单条消息节点（user/assistant 卡片），供 renderMessages 与分帧渲染复用 */
function buildMessageNode(item) {
    const info = item.info || item;
    const role = info.role || info.author || 'message';
    const displayRole = role === 'user' ? '你' : (role === 'assistant' ? '助手' : role);
    const parts = item.parts || [];
    const node = document.createElement('div');
    node.className = `oc-message ${role}`;
    if (info.id) node.dataset.messageId = info.id;
    node.innerHTML = `<div class="oc-message-role">${escapeHtml(displayRole)}</div>`;
    const body = document.createElement('div');
    body.className = 'oc-message-parts';
    const partList = Array.isArray(parts) ? parts : [parts];
    const messageErrorText = info.error?.message || info.error?.data?.message || '';
    if (role === 'assistant' && messageErrorText) {
        const errEl = document.createElement('div');
        errEl.className = 'oc-part error-msg';
        errEl.textContent = messageErrorText;
        body.appendChild(errEl);
    }
    if (partList.length) {
        partList.forEach(part => body.appendChild(renderPart(part)));
    } else if (role === 'assistant') {
        if (messageErrorText) {
            // 已在上方输出 message-level error
        } else if (isSessionBusy(currentSessionId)) {
            const pending = document.createElement('div');
            pending.className = 'oc-part pending';
            pending.textContent = getSessionPendingText(currentSessionId);
            body.appendChild(pending);
        } else if (hasSessionError(currentSessionId)) {
            const errEl = document.createElement('div');
            errEl.className = 'oc-part error-msg';
            errEl.textContent = '模型调用失败：' + (sessionErrors[currentSessionId] || '未知错误，请检查 opencode 提供商配置');
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
    // 输出卡片：显示 agent / model 信息
    if (role === 'assistant' && (info.agent || info.modelID || (info.model && info.model.modelID))) {
        var metaParts = [];
        if (info.agent) metaParts.push('🤖 ' + info.agent);
        var metaModel = info.modelID || (info.model && info.model.modelID) || '';
        if (info.providerID && metaModel) metaModel = info.providerID + '/' + metaModel;
        if (metaModel) metaParts.push('🧠 ' + metaModel);
        if (metaParts.length) {
            const metaEl = document.createElement('div');
            metaEl.className = 'oc-message-meta';
            metaEl.textContent = metaParts.join(' · ');
            node.appendChild(metaEl);
        }
    }
    // 消息时间：user / assistant 都显示在卡片底部（右下角）
    const msgTime = formatStepTime(info.time?.created || info.time?.updated || info.createdAt);
    if (msgTime && (role === 'user' || role === 'assistant')) {
        const timeEl = document.createElement('div');
        timeEl.className = 'oc-message-time';
        timeEl.textContent = '⏱ ' + msgTime;
        node.appendChild(timeEl);
    }
    return node;
}

/** 渲染完整消息列表（支持增量更新、滚动保持、移动端截断）
 *  @param {Array} items 消息数组
 *  @param {HTMLElement} [targetBox] 目标容器；不传则用当前活动 tab 容器
 */
function renderMessages(items, targetBox) {
    const box = targetBox || getActiveMessagesEl();
    const sourceList = (items || []).map(normalizeMessageItem).filter(item => !isInternalUserMessage(item));
    const list = trimMessagesForRender(sourceList);

    if (userScrolling) {
        lastMessageCount = list.length;
        return;
    }

    const scrollState = captureScrollState(box);
    if (!list.length) {
        box.innerHTML = '<div class="oc-empty">该会话暂无消息</div>';
        lastMessageCount = 0;
        lastSourceMessageCount = 0;
        updateModelInfo(null);
        updateScrollBottomButton();
        return;
    }

    const sameCount = sourceList.length === lastSourceMessageCount;
    lastMessageCount = list.length;
    lastSourceMessageCount = sourceList.length;

    if (sameCount && list.length > 0 && webRunning && isSessionBusy(currentSessionId)) {
        const last = list[list.length - 1];
        const lastRole = (last.info || last).role;
        if (lastRole === 'assistant') {
            const lastMsg = box.lastElementChild;
            if (lastMsg && lastMsg.classList.contains('assistant')) {
                const body = lastMsg.querySelector('.oc-message-parts');
                if (body) {
                    const partList = Array.isArray(last.parts) ? last.parts : [last.parts];
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
                    updateModelInfo(list);
                    restoreScroll(box, scrollState, false);
                    updateScrollBottomButton();
                    return;
                }
            }
        }
    }

    box.innerHTML = '';
    list.forEach(item => {
        box.appendChild(buildMessageNode(item));
    });

    updateModelInfo(items);
    restoreScroll(box, scrollState, false);
    updateScrollBottomButton();
    renderTodos();
	renderCollapsedHistoryNotice(sourceList.length, sourceList.length - list.length, box);
    updateUserNav();

}


/** 从消息历史中同步最新 assistant 使用的 Agent/Model 到下拉框 */
function updateModelInfo(items) {
    const agentSel = document.getElementById('ocAgentSelect');
    const modelSel = document.getElementById('ocModelSelect');
    if (!agentSel || !modelSel) return;
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

    // 确保下拉框中有当前值（API 加载失败时的降级）
    if (agent) ensureSelectOption(agentSel, agent, agent);
    if (model)  ensureSelectOption(modelSel, model, model);

    // 同步选中值
    if (agent && agentSel) agentSel.value = agent;
    if (model && modelSel)  modelSel.value = model;
    const variantSel = document.getElementById('ocVariantSelect');
    if (variant && variantSel) variantSel.value = variant;

    // 首次加载时同步全局选中值
    if (agent && !selectedAgent) selectedAgent = agent;
    if (model && !selectedModel) selectedModel = model;
    if (variant && !selectedVariant) selectedVariant = variant;
}

/** 确保指定 value 的选项存在于 <select> 中（API 加载失败降级） */
function ensureSelectOption(sel, value, label) {
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
function smartScroll(box, force) {
    const scrollState = captureScrollState(box);
    restoreScroll(box, scrollState, force);
    updateScrollBottomButton();
}

/** 捕获滚动状态（顶部位置、高度、距底部距离） */
function captureScrollState(box) {
    const distanceToBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
    return {
        top: box.scrollTop,
        height: box.scrollHeight,
        nearBottom: distanceToBottom < 120,
    };
}

/** 恢复滚动位置：底部模式滚到底，否则按高度差修正 */
function restoreScroll(box, state, force) {
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

/** 更新「滚到底」按钮可见性 */
function updateScrollBottomButton() {
    const box = getActiveMessagesEl();
    const btn = document.getElementById('btnScrollBottom');
    if (!box || !btn) return;
    const canScroll = box.scrollHeight > box.clientHeight + 8;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    btn.classList.toggle('visible', canScroll && !nearBottom);
}

/** 平滑动画滚动到消息列表底部（easeOutCubic） */
function scrollMessagesToBottom() {
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

/** 判断会话是否繁忙（busy/retry 状态） */
function isSessionBusy(id) {
    const status = sessionStatuses[id];
    return status === 'busy' || status?.type === 'busy' || status?.type === 'retry' || status?.status === 'busy';
}

/** 判断会话是否有错误 */
function hasSessionError(id) {
    return !!sessionErrors[id];
}

/** 获取会话等待提示文本（区分普通等待和重试） */
function getSessionPendingText(id) {
    const status = sessionStatuses[id];
    if (status?.type === 'retry') {
        return `模型连接失败，正在第 ${status.attempt || 1} 次重试：${status.message || '等待下一次重试'}`;
    }
    return '正在等待模型回复...';
}

// ============================
// Part 渲染器
// ============================

/** Part 渲染分发器：按 type 分发到对应的渲染函数 */
function renderPart(part) {
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
        case 'agent':
        case 'subtask': el = renderAgentPart(part, type); break;
        case 'compaction': el = renderCompaction(part); break;
        case 'snapshot':   el = renderSnapshot(part); break;
        case 'retry':      el = renderRetry(part); break;
        default: el = renderFallback(part); break;
    }
    if (id) el.dataset.partId = id;
    return el;
}

/** 生成 part 展开状态的唯一 key */
function partExpandKey(part, fallback) {
    return part?.id || `${part?.type || 'part'}:${part?.messageID || ''}:${fallback || ''}`;
}

// 格式化数字：<1000 原样显示；≥1000 显示 xx.xxk；≥1000000 显示 xx.xxM
function formatNumber(num) {
  // 安全处理：不是数字就返回 0
  if (isNaN(num) || num === null || num === undefined) return '0';

  if (num < 1000) {
    // 小于 1000，直接返回数字（可选择保留0位小数）
    return num.toFixed(0);
  } else if (num < 1000000) {
    // 1000 ~ 999,999 → 显示 xx.xx k
    return (num / 1000).toFixed(2) + 'k';
  } else {
    // ≥1,000,000 → 显示 xx.xx M
    return (num / 1000000).toFixed(2) + 'M';
  }
}

/** 格式化时间戳为「年月日时分秒」，非法值返回空串 */
function formatStepTime(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}


/** 渲染步骤分割线（开始/结束 + token 统计 + 时间） */
function renderStepDivider(part, phase) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-step-divider';
    const timeText = formatStepTime(part.time?.start || part.time?.created || part.time?.updated);
    const timeHtml = timeText ? `<span class="oc-step-time">⏱ ${timeText}</span>` : '';
    if (phase === 'finish' && part.tokens) {
        const t = part.tokens;
        const input = (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0)
        const ouput = (t.output||0) + (t.reasoning||0);
        const total = t.total || (t.input || 0) + (t.output || 0) + (t.reasoning || 0);
        el.innerHTML = `<span class="oc-step-label">步骤结束</span><span class="oc-step-cost">输入:${input} 输出:${ouput} 统计:${formatNumber(total)} tokens</span>${timeHtml}`;
    } else {
        el.innerHTML = `<span class="oc-step-label">步骤开始</span>${timeHtml}`;
    }
    return el;
}

/** 渲染思考过程（可折叠，支持 Markdown） */
function renderReasoning(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-reasoning';
    const key = partExpandKey(part, 'reasoning');
    const head = document.createElement('div');
    head.className = 'oc-reasoning-head';
    head.innerHTML = '<span class="oc-reasoning-icon">🧠</span> 思考过程 <span class="oc-reasoning-toggle">展开</span>';
    const body = document.createElement('div');
    const expanded = !!expandedParts[key];
    body.className = 'oc-reasoning-body' + (expanded ? '' : ' hidden');
    body.dataset.expandKey = key;
    body.innerHTML = typeof marked !== 'undefined'
        ? sanitizeMarkedHtml(marked.parse(part.text || '', { breaks: true }))
        : `<pre>${escapeHtml(part.text || '')}</pre>`;
    head.querySelector('.oc-reasoning-toggle').textContent = expanded ? '收起' : '展开';
    head.addEventListener('click', () => {
        expandedParts[key] = !expandedParts[key];
        body.classList.toggle('hidden', !expandedParts[key]);
        head.querySelector('.oc-reasoning-toggle').textContent = expandedParts[key] ? '收起' : '展开';
    });
    el.appendChild(head);
    el.appendChild(body);
    return el;
}

/** 渲染 Question 工具（选项按钮、自定义输入、跳过、底部总提交） */
function renderQuestionTool(part) {
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
    head.innerHTML = `<span class="oc-tool-icon">❓</span> 提问 <span class="oc-tool-status ${statusClass}">${statusText}</span>`;

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
                // 已选该选项时高亮
                const answered = part.__pendingAnswers[qi];
                if (answered && answered.indexOf(label) >= 0) btn.classList.add('selected');
                let btnHtml = `<span class="oc-option-label">${escapeHtml(label)}</span>`;
                if (desc) btnHtml += `<span class="oc-option-desc">${escapeHtml(desc)}</span>`;
                btn.innerHTML = btnHtml;
                // 点击只 toggle 选中状态，不提交、不关闭；直接更新当前 DOM
                btn.addEventListener('click', () => {
                    const isMulti = !!q.multiple;
                    let cur = part.__pendingAnswers[qi] || [];
                    if (isMulti) {
                        cur = cur.indexOf(label) >= 0 ? cur.filter(x => x !== label) : cur.concat([label]);
                    } else {
                        cur = [label];
                        // 单选：清除该问题其他选项的高亮
                        optsDiv.querySelectorAll('.oc-question-option-btn').forEach(function(b) {
                            b.classList.remove('selected');
                        });
                    }
                    part.__pendingAnswers[qi] = cur;
                    // 当前按钮高亮
                    btn.classList.toggle('selected', cur.indexOf(label) >= 0);
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
        if (!expandedParts[key]) body.classList.add('hidden');
        head.addEventListener('click', () => {
            expandedParts[key] = !expandedParts[key];
            body.classList.toggle('hidden', !expandedParts[key]);
        });
    }

    el.appendChild(head);
    el.appendChild(body);
    return el;
}

/** 渲染通用工具调用（Shell/文件操作，带输入/输出/错误展示） */
function renderTool(part) {
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

    const title = state.title || tool;
    head.innerHTML = `<span class="oc-tool-icon">${icon}</span> ${label}: <strong>${escapeHtml(title)}</strong> <span class="oc-tool-status ${statusClass}">${statusText}</span>`;

    const body = document.createElement('div');
    body.className = 'oc-tool-body';
    body.dataset.expandKey = key;
    body.dataset.defaultExpanded = isRunning ? 'true' : 'false';

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

    const expanded = expandedParts[key] ?? isRunning;
    if (!expanded) body.classList.add('hidden');

    head.addEventListener('click', () => {
        expandedParts[key] = !(expandedParts[key] ?? isRunning);
        body.classList.toggle('hidden', !expandedParts[key]);
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
async function answerQuestion(answers) {
    if (!currentSessionId) return;
    questionCustomInput = '';
    const input = document.getElementById('ocPrompt');
    try {
        // 兼容单值：传字符串时转成单问题单答案
        const answersArr = Array.isArray(answers)
            ? answers
            : [[answers]];
        const result = await api.AnswerQuestion(currentSessionId, answersArr);
        if (result && result.success) {
            showToast('已回答', 'success');
            if (input) input.value = '';
            // SSE 事件会自动推送模型响应，无需手动 loadMessages
        } else {
            showToast('回答失败: ' + ((result && result.error) || '未知错误'), 'error');
            if (input) { input.value = typeof answers === 'string' ? answers : ''; input.focus(); }
        }
    } catch (e) {
        showToast('回答失败: ' + (e.message || e), 'error');
        if (input) { input.value = typeof answers === 'string' ? answers : ''; input.focus(); }
    }
}

/** 渲染文本 Part（Markdown 渲染） */
function renderTextPart(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-text';
    const text = (part && (part.text || part.content || part.message || part.value)) || '';
    el.innerHTML = typeof marked !== 'undefined'
        ? sanitizeMarkedHtml(marked.parse(text || '', { breaks: true }))
        : `<pre>${escapeHtml(text || '')}</pre>`;
    return el;
}

/** 渲染文件 Part（可折叠显示文件内容） */
function renderFilePart(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-file';
    const key = partExpandKey(part, part.filename || part.path || 'file');
    const filename = part.filename || part.path || part.file || '附件';
    const mime = part.mime || part.type || 'file';
    const raw = part.content || part.url || safeText(part);
    const size = raw.length > 1024 ? `${Math.round(raw.length / 1024)} KB` : `${raw.length} B`;
    const expanded = !!expandedParts[key];
    const head = document.createElement('div');
    head.className = 'oc-file-path';
    head.innerHTML = `<span>📎 ${escapeHtml(filename)}</span><span class="oc-file-meta">${escapeHtml(mime)} · ${size} · ${expanded ? '收起' : '展开'}</span>`;
    const body = document.createElement('pre');
    body.className = expanded ? '' : 'hidden';
    body.dataset.expandKey = key;
    body.textContent = raw;
    head.addEventListener('click', () => {
        expandedParts[key] = !expandedParts[key];
        body.classList.toggle('hidden', !expandedParts[key]);
        head.querySelector('.oc-file-meta').textContent = `${mime} · ${size} · ${expandedParts[key] ? '收起' : '展开'}`;
    });
    el.appendChild(head);
    el.appendChild(body);
    return el;
}

/** 渲染代码变更 Patch Part（文件路径 + diff 内容） */
function renderPatchPart(part) {
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

/** 渲染代理/子任务 Part */
function renderAgentPart(part, type) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-agent';
    const label = type === 'agent' ? '🤖 代理' : '📋 子任务';
    el.innerHTML = `<div class="oc-agent-head">${label}: ${escapeHtml(part.name || part.agent || type)}</div><pre>${escapeHtml(safeText(part))}</pre>`;
    return el;
}

/** 渲染上下文压缩标记 Part */
function renderCompaction(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-compaction';
    const auto = part.auto;
    el.innerHTML = auto
        ? '🗜️ 自动压缩上下文'
        : '🗜️ 上下文已压缩';
    return el;
}

/** 渲染文件快照 Part */
function renderSnapshot(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-snapshot';
    const hash = (part.snapshot || '').slice(0, 7);
    el.innerHTML = hash
        ? `<span class="oc-snapshot-icon">📸</span> 文件快照 <span class="oc-snapshot-hash">${escapeHtml(hash)}</span>`
        : '<span class="oc-snapshot-icon">📸</span> 文件快照';
    return el;
}

/** 渲染重试标记 Part（显示重试次数和错误信息） */
function renderRetry(part) {
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
function renderFallback(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-fallback';
    const pre = document.createElement('pre');
    pre.textContent = extractPartText(part) || safeText(part);
    el.appendChild(pre);
    return el;
}
