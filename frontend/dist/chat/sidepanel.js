// ============================================================
// chat-sidepanel.js — 右侧面板（Diff + 子任务 + 代办）
// 依赖：core/state.js、chat/service.js（api.OpenCodeCall, normalizeMessageItem, isInternalUserMessage）、
//       core/utils.js（escapeHtml, showToast）、core/webcall.js（api）
// ============================================================

// ============================
// 代办事项 — 从消息中提取并渲染
// ============================

/** 从当前会话的缓存消息中提取代办事项列表 */
function extractTodos() {
    const items = getCachedMessages(currentSessionId);
    if (!items.length) return [];
    for (let i = items.length - 1; i >= 0; i--) {
        const info = items[i].info || items[i];
        if (info.role !== 'assistant') continue;
        const parts = items[i].parts || [];
        for (let j = parts.length - 1; j >= 0; j--) {
            const part = parts[j];
            if (part.type !== 'tool') continue;
            if (part.tool !== 'todowrite' && part.name !== 'todowrite') continue;
            const state = part.state || {};
            const todos = (state.input && state.input.todos) || state.todos;
            if (Array.isArray(todos)) return todos;
        }
    }
    return [];
}

/** 渲染代办事项面板 */
function renderTodos() {
    const box = document.getElementById('ocTodos');
    if (!box) return;
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

// ============================
// Diff 渲染 — 文件变更树
// ============================

/** 加载当前会话的文件变更列表 */
async function loadDiff() {
    const box = document.getElementById('ocDiff');
    if (!currentSessionId || !webRunning) {
        box.innerHTML = '<div class="oc-empty">选择会话后查看变更</div>';
        return;
    }
    try {
        const diff = await api.OpenCodeCall('GET', `/session/${encodeURIComponent(currentSessionId)}/diff`);
        renderDiff(diff || []);
    } catch (e) {
        box.innerHTML = `<div class="oc-empty error">${escapeHtml(e.message || e)}</div>`;
    }
}

/** 渲染文件变更列表 */
function renderDiff(diff) {
    const box = document.getElementById('ocDiff');
    const files = Array.isArray(diff) ? diff : Object.values(diff || {});
    if (!files.length) {
        box.innerHTML = '<div class="oc-empty">暂无文件变更</div>';
        return;
    }
    box.innerHTML = '';
    const root = buildFileTree(files);
    renderTreeNode(box, root, 0);
}

/** 将文件列表构建为目录树结构 */
function buildFileTree(files) {
    const root = { name: '', isDir: true, children: {} };
    files.forEach(file => {
        const path = (file.file || file.path || file.name || 'unknown').replace(/^\.\//);
        const parts = path.split('/');
        let node = root;
        for (let i = 0; i < parts.length; i++) {
            const name = parts[i];
            const isLast = i === parts.length - 1;
            if (!node.children[name]) {
                node.children[name] = isLast
                    ? { name, isDir: false, data: file }
                    : { name, isDir: true, children: {} };
            }
            node = node.children[name];
        }
    });
    return root;
}

/** 递归渲染文件树节点 */
function renderTreeNode(container, node, depth) {
    const dirs = [];
    const leafs = [];
    for (const child of Object.values(node.children || {})) {
        child.isDir ? dirs.push(child) : leafs.push(child);
    }
    [...dirs, ...leafs].forEach(child => {
        const el = document.createElement('div');
        el.className = 'oc-tree-node';
        el.style.paddingLeft = (depth * 14) + 'px';

        const head = document.createElement('div');
        head.className = 'oc-tree-head';

        if (child.isDir) {
            head.classList.add('dir');
            const icon = document.createElement('span');
            icon.className = 'oc-tree-arrow expanded';
            icon.textContent = '▼';
            head.appendChild(icon);
            head.appendChild(document.createTextNode(' 📁 ' + child.name));
            const sub = document.createElement('div');
            sub.className = 'oc-tree-children';
            renderTreeNode(sub, child, depth + 1);
            el.appendChild(head);
            el.appendChild(sub);
            head.addEventListener('click', () => {
                icon.classList.toggle('expanded');
                icon.classList.toggle('collapsed');
                icon.textContent = icon.classList.contains('expanded') ? '▼' : '⯈';
                sub.classList.toggle('hidden');
            });
        } else {
            head.classList.add('file');
            const fileName = child.name;
            const stats = child.data;
            const adds = stats.additions || 0;
            const dels = stats.deletions || 0;
            head.innerHTML = `<span class="oc-tree-file-icon">📄</span> ${escapeHtml(fileName)} <span class="oc-tree-stats">+${adds} −${dels}</span>`;
            const body = document.createElement('div');
            body.className = 'oc-tree-body';
            body.innerHTML = `<pre>${escapeHtml(safeText(stats))}</pre>`;
            body.classList.add('hidden');
            el.appendChild(head);
            el.appendChild(body);
            head.addEventListener('click', () => {
                body.classList.toggle('hidden');
                el.classList.toggle('expanded');
            });
        }
        container.appendChild(el);
    });
}

// ============================================================
// 子任务面板 — 摘要提取、渲染、详情弹窗
// ============================================================

/** 从缓存消息中提取子任务摘要列表 */
function extractSubtaskSummaries(sessionID) {
    const items = getCachedMessages(sessionID);
    if (!items || !items.length) {
        subtaskSummaries = [];
        return;
    }
    const summaries = [];
    const scanItems = items.length > 200 ? items.slice(-200) : items;
    for (const msg of scanItems) {
        const parts = msg.parts || [];
        for (const part of parts) {
            if (part.type !== 'tool' || part.tool !== 'task') continue;
            const st = part.state || {};
            const meta = st.metadata || part.metadata || {};
            const modelMeta = meta.model || {};
            const hasEnd = st.time && st.time.end != null;
            const hasStart = st.time && st.time.start != null;

            let status = st.status || 'pending';
            if (status === 'error' && meta.interrupted) status = 'interrupt';

            summaries.push({
                childSessionId: meta.sessionId || null,
                title: st.title || meta.description || st.input?.description || part.tool || '未知任务',
                description: meta.description || st.title || '',
                agent: meta.agent || 'unknown',
                model: modelMeta.providerID && modelMeta.modelID
                    ? modelMeta.providerID + '/' + modelMeta.modelID
                    : 'unknown',
                status: status,
                durationMs: (hasEnd && hasStart) ? (st.time.end - st.time.start) : null,
                interrupted: !!meta.interrupted,
                startedAt: hasStart ? st.time.start : null,
                endedAt: hasEnd ? st.time.end : null,
                outputPreview: (st.output || '').slice(0, 200),
                promptPreview: (meta.prompt || st.input?.prompt || '').slice(0, 200),
                parentMessageId: msg.info?.id || msg.id || '',
                taskPartId: part.id || '',
            });
        }
    }
    subtaskSummaries = summaries;
}

/** 调度子任务提取到下一帧 */
function scheduleSubtaskExtraction(sessionID) {
    if (!sessionID || sessionID !== currentSessionId) return;
    if (subtaskExtractionPending) return;
    subtaskExtractionPending = true;
    subtaskExtractionFrame = requestAnimationFrame(() => {
        const targetSid = currentSessionId;
        subtaskExtractionFrame = 0;
        subtaskExtractionPending = false;
        extractSubtaskSummaries(targetSid);
        renderSubtaskPanel();
    });
}

/** 格式化时长（毫秒 → 中国语文） */
function formatDuration(ms) {
    if (ms == null) return '—';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return seconds + '秒';
    const minutes = Math.floor(seconds / 60);
    const remainSec = seconds % 60;
    if (minutes < 60) return minutes + '分' + (remainSec > 0 ? remainSec + '秒' : '');
    const hours = Math.floor(minutes / 60);
    const remainMin = minutes % 60;
    return hours + '小时' + (remainMin > 0 ? remainMin + '分' : '');
}

/** 格式化时间戳 */
function formatTime(ts) {
    if (ts == null) return '—';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 渲染子任务面板 */
function renderSubtaskPanel() {
    const box = document.getElementById('ocSubtasks');
    if (!box) return;
    if (!webRunning || !currentSessionId) {
        box.innerHTML = '<div class="oc-empty">启动服务并选择会话后查看子任务</div>';
        return;
    }
    if (!subtaskSummaries.length) {
        box.innerHTML = '<div class="oc-empty">当前会话暂无子任务<br><small>子任务会在主会话触发 task 工具后显示在这里</small></div>';
        return;
    }
    let html = '';
    subtaskSummaries.forEach((s, idx) => {
        html += renderSubtaskCard(s, idx);
    });
    box.innerHTML = html;
    attachSubtaskCardEvents();
}

/** 渲染单张子任务卡片 */
function renderSubtaskCard(s, idx) {
    const statusClass = 'status-' + (s.status || 'pending');
    const statusLabels = { completed: '已完成', running: '运行中', error: '失败', interrupt: '已中断', pending: '等待中' };
    const statusLabel = statusLabels[s.status] || s.status || '未知';
    const durationText = s.durationMs != null ? formatDuration(s.durationMs) : (s.status === 'running' ? '运行中…' : '—');

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
function attachSubtaskCardEvents() {
    const box = document.getElementById('ocSubtasks');
    if (!box) return;
    box.removeEventListener('click', onSubtaskCardClick);
    box.addEventListener('click', onSubtaskCardClick);
}

/** 子任务卡片点击处理 */
function onSubtaskCardClick(e) {
    const detailBtn = e.target.closest('.oc-subtask-detail-btn');
    if (detailBtn) {
        e.stopPropagation();
        const idx = parseInt(detailBtn.dataset.index);
        if (isNaN(idx) || !subtaskSummaries[idx]) return;
        const summary = subtaskSummaries[idx];
        if (summary.childSessionId) {
            openSubtaskModal(summary.childSessionId, summary);
        }
        return;
    }
    // 卡片本身点击 → 定位主消息
    const card = e.target.closest('.oc-subtask-card');
    if (!card) return;
    const msgId = card.dataset.parentMessageId;
    if (!msgId) return;
    locateParentMessage(msgId);
}

/** 定位到父消息在消息列表中的位置 */
function locateParentMessage(msgId) {
    const box = document.getElementById('ocMessages');
    if (!box) return;
    const old = box.querySelectorAll('.oc-message.highlight');
    old.forEach(el => el.classList.remove('highlight'));
    let target = box.querySelector('.oc-message[data-message-id="' + msgId + '"]');
    if (!target) {
        const allMsgs = box.querySelectorAll('.oc-message');
        for (let i = allMsgs.length - 1; i >= 0; i--) {
            const partIds = allMsgs[i].querySelectorAll('[data-part-id]');
            for (const p of partIds) {
                if (subtaskSummaries.some(s => s.parentMessageId === msgId && s.taskPartId === p.dataset.partId)) {
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
    }
}

/** 打开子任务详情弹窗 */
function openSubtaskModal(childSessionId, subtaskSummary) {
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
function closeSubtaskModal() {
    const modal = document.getElementById('subtaskModal');
    if (modal) modal.style.display = 'none';
    if (document.activeElement && document.activeElement.closest('#subtaskModal')) {
        const promptEl = document.getElementById('ocPrompt');
        if (promptEl) promptEl.focus();
    }
}

/** 绑定子任务详情弹窗事件 */
function bindSubtaskModalEvents() {
    const modal = document.getElementById('subtaskModal');
    if (!modal || modal.dataset.eventsBound === '1') return;

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeSubtaskModal();
    });
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
    copyBtn?.addEventListener('click', () => {
        const sid = document.getElementById('subtaskSid')?.textContent || '';
        if (sid) {
            navigator.clipboard?.writeText(sid).then(() => showToast('已复制: ' + sid, 'success'))
                .catch(() => showToast('复制失败', 'error'));
        }
    });

    document.addEventListener('keydown', onSubtaskModalKey);
    modal.dataset.eventsBound = '1';
}

/** 子任务弹窗键盘事件（Esc 关闭） */
function onSubtaskModalKey(e) {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('subtaskModal');
    if (modal && modal.style.display === 'flex') closeSubtaskModal();
}

/** 填充子任务弹窗摘要信息 */
function fillModalSummary(s) {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };
    const setHtml = (id, val) => { const el = document.getElementById(id); if (el) el.innerHTML = val || '—'; };

    document.getElementById('subtaskModalTitle').textContent = s.title || '子任务详情';
    set('subtaskTitle', s.title);
    setHtml('subtaskAgent', escapeHtml(s.agent || '—'));
    setHtml('subtaskModel', escapeHtml(s.model || '—'));

    const duration = s.durationMs != null ? formatDuration(s.durationMs) : (s.status === 'running' ? '运行中…' : '—');
    set('subtaskDuration', duration);
    set('subtaskStarted', formatTime(s.startedAt));
    set('subtaskEnded', formatTime(s.endedAt));

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
async function loadSubtaskDetailMessages(childSessionId) {
    if (!childSessionId) return;
    if (detailLoading[childSessionId]) return;
    detailLoading[childSessionId] = true;
    const msgBox = document.getElementById('subtaskMessages');
    const thisSeq = ++detailMessageLoadSeq;

    try {
        const data = await api.OpenCodeCall('GET', '/session/' + encodeURIComponent(childSessionId) + '/message');
        if (thisSeq !== detailMessageLoadSeq) return;

        if (!data || !Array.isArray(data) || !data.length) {
            if (msgBox) msgBox.innerHTML = '<div class="oc-empty">子会话暂无消息</div>';
            return;
        }

        const items = data.map(normalizeMessageItem).filter(item => !isInternalUserMessage(item));
        if (thisSeq !== detailMessageLoadSeq) return;
        renderDetailMessages(items);
    } catch (err) {
        if (thisSeq !== detailMessageLoadSeq) return;
        if (msgBox) msgBox.innerHTML = '<div class="oc-empty error">加载失败：' + escapeHtml(err.message || '网络错误') + '</div>';
    } finally {
        detailLoading[childSessionId] = false;
    }
}

/** 渲染子任务详情消息列表 */
function renderDetailMessages(items) {
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
function renderDetailPart(part) {
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
