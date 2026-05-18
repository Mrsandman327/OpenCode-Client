// ============================================================
// chat-session.js — 会话管理与消息收发
// 负责会话选择/创建/加载、Agent/Model 选择器、附件管理、消息发送、轮询与中止
// ============================================================

// ============================
// 全局 Agent/Model 选择器
// ============================

/** 加载 Agent/Model 下拉选择器（从 API 获取可用列表） */
async function loadAgentModelSelectors() {
    if (agentModelSelectorsLoaded) return;
    try {
        const [agents, models] = await Promise.all([
            ocApi('GET', '/agent').catch(() => []),
            api.GetAvailableModels().catch(() => []),
        ]);
        agentList = agents || [];
        modelList = models || [];
    } catch (_) {
        agentList = [];
        modelList = [];
    }

    const agentSel = document.getElementById('ocAgentSelect');
    const modelSel = document.getElementById('ocModelSelect');
    if (!agentSel || !modelSel) return;

    // 填充 agent 下拉框
    agentSel.innerHTML = '<option value="">默认</option>';
    agentList.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.name;
        opt.textContent = a.name;
        if (a.description) opt.title = a.description;
        agentSel.appendChild(opt);
    });
    agentSel.value = selectedAgent;

    // 填充 model 下拉框
    modelSel.innerHTML = '<option value="">默认</option>';
    modelList.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        modelSel.appendChild(opt);
    });
    modelSel.value = selectedModel;

    // change 事件
    agentSel.addEventListener('change', () => {
        selectedAgent = agentSel.value;
    });
    modelSel.addEventListener('change', () => {
        selectedModel = modelSel.value;
    });

    // Variant 选择器
    const variantSel = document.getElementById('ocVariantSelect');
    if (variantSel) {
        variantSel.value = selectedVariant;
        variantSel.addEventListener('change', () => {
            selectedVariant = variantSel.value;
        });
    }

    agentModelSelectorsLoaded = true;
}

let pendingWorkDir = '';

/** 选择/切换会话：更新标题、目录路径，加载消息和子任务 */
async function selectSession(id) {
    if (!id) return;
    currentSessionId = id;
    if (isMobileTreeMode()) { 
        visibleMessageCount = MOBILE_MESSAGE_RENDER_LIMIT; 
    }
    else{
        visibleMessageCount = PC_MESSAGE_RENDER_LIMIT;
    }
    expandedParts = {};
    markdownCache = {};
    lastMessageCount = 0;
    messageLoadSeq++;
    questionCustomInput = ''; // 清除 question 自定义输入
    const info = window._sessionMap?.[id];
    document.getElementById('ocChatTitle').textContent = info?.title || id;
    const dirEl = document.getElementById('ocSideDirPath');
    if (dirEl) {
        dirEl.textContent = info?.directory || id;
        dirEl.title = info?.directory || '';
        dirEl.style.cursor = 'pointer';
        dirEl.onclick = () => {
            const p = info?.directory || '';
            if (p) api.OpenDir(p).catch(e => showToast('打开失败: ' + (e.message || e), 'error'));
        };
    }
    document.getElementById('ocMessages').innerHTML = '<div class="oc-empty">正在加载会话消息...</div>';
    loadMessages().then(() => {
        if (id !== currentSessionId) return;
        if (!isMobileTreeMode()) {
            extractSubtaskSummaries(currentSessionId);
            renderSubtaskPanel();
            loadDiff();
        }
        smartScroll(document.getElementById('ocMessages'), true);
    }).catch(() => {});
}

/** 用指定目录创建会话 */
async function createSessionWithDir(dir) {
    if (isMobileTreeMode()) { 
        visibleMessageCount = MOBILE_MESSAGE_RENDER_LIMIT; 
    }
    else{
        visibleMessageCount = PC_MESSAGE_RENDER_LIMIT;
    }
    const result = await api.CreateSession(dir);
    if (!result.success) throw new Error(result.error || result.body || '创建失败');
    rememberKnownDir(dir);
    return JSON.parse(result.body);
}

/** 加载当前会话消息列表（含竞态保护） */
async function loadMessages() {
    const box = document.getElementById('ocMessages');
    const seq = ++messageLoadSeq;
    if (!currentSessionId) {
        box.innerHTML = '<div class="oc-empty">选择会话后查看消息，或输入内容创建新会话</div>';
        return;
    }
    try {
        const messages = await ocApi('GET', `/session/${encodeURIComponent(currentSessionId)}/message`);
        if (seq !== messageLoadSeq) return;
        cacheMessages(currentSessionId, messages || []);
        renderMessages(getCachedMessages(currentSessionId));
        if (!isMobileTreeMode()) {
            extractSubtaskSummaries(currentSessionId);
            renderSubtaskPanel();
        }
    } catch (e) {
        if (seq !== messageLoadSeq) return;
        box.innerHTML = `<div class="oc-empty error">${escapeHtml(e.message || e)}</div>`;
    }
}

// ============================
// 项目树面板宽度状态
// ============================

/** 项目树面板宽度的 localStorage 键名（全局共享） */
const TREE_PANEL_WIDTH_KEY = 'treePanelWidth';
/** 项目树面板默认宽度（无记录时使用） */
const TREE_PANEL_DEFAULT_WIDTH = 240;
/** 项目树面板允许的最小宽度 */
const TREE_PANEL_MIN_WIDTH = 180;
/** 项目树面板允许的理论最大宽度 */
const TREE_PANEL_MAX_WIDTH = 420;
/** 最近一次有效的展开宽度（收起后保留，展开时恢复） */
let treePanelWidth = TREE_PANEL_DEFAULT_WIDTH;

/**
 * 归一化用户偏好宽度
 * 仅做静态范围约束（180~420），不考虑当前窗口可用宽度
 */
function normalizeTreePanelWidth(width) {
    const numeric = Number(width);
    if (!Number.isFinite(numeric)) return TREE_PANEL_DEFAULT_WIDTH;
    return Math.max(TREE_PANEL_MIN_WIDTH, Math.min(TREE_PANEL_MAX_WIDTH, numeric));
}

/**
 * 计算当前窗口下允许的动态最大宽度
 * 需要为中间聊天区保留至少 360px，为右侧栏保留 320px
 */
function getTreePanelDynamicMaxWidth() {
    const client = document.getElementById('webContainer');
    if (!client) return TREE_PANEL_MAX_WIDTH;
    const availableWidth = client.clientWidth;
    return Math.max(TREE_PANEL_MIN_WIDTH, Math.min(TREE_PANEL_MAX_WIDTH, availableWidth - 360 - 320));
}

/**
 * 根据当前窗口大小夹取实际渲染宽度
 * 该宽度可能小于用户偏好值，但不会覆盖用户偏好本身
 */
function clampTreePanelWidth(width) {
    return Math.max(TREE_PANEL_MIN_WIDTH, Math.min(getTreePanelDynamicMaxWidth(), normalizeTreePanelWidth(width)));
}

/**
 * 将项目树面板宽度应用到桌面端布局
 * 通过 `--tree-panel-width` 同时驱动左栏列宽与收起按钮定位
 */
function applyTreePanelWidth(width) {
    const client = document.getElementById('webContainer');
    if (!client || isMobileTreeMode()) return;
    const nextWidth = clampTreePanelWidth(width);
    client.style.setProperty('--tree-panel-width', nextWidth + 'px');
}

/**
 * 持久化用户偏好宽度
 * 保存的是用户偏好值，不是当前窗口下的临时夹取值
 */
function persistTreePanelWidth(width) {
    const nextWidth = normalizeTreePanelWidth(width);
    treePanelWidth = nextWidth;
    try {
        localStorage.setItem(TREE_PANEL_WIDTH_KEY, String(nextWidth));
    } catch (_) {}
    return nextWidth;
}

/**
 * 初始化项目树面板宽度
 * 优先恢复 localStorage 中的值；无记录或非法值时回退到默认值 240px
 */
function loadTreePanelWidth() {
    let width = TREE_PANEL_DEFAULT_WIDTH;
    try {
        const saved = localStorage.getItem(TREE_PANEL_WIDTH_KEY);
        if (saved != null) {
            width = saved;
        }
    } catch (_) {}
    treePanelWidth = normalizeTreePanelWidth(width);
    applyTreePanelWidth(treePanelWidth);
    persistTreePanelWidth(treePanelWidth);
}

/**
 * 绑定项目树拖拽调宽逻辑（仅桌面端）
 * 收起状态下不响应拖拽；拖拽结束后写入 localStorage
 */
function initTreePanelResize() {
    const treeResizeHandle = document.getElementById('ocTreeResizeHandle');
    if (!treeResizeHandle) return;
    treeResizeHandle.addEventListener('pointerdown', (event) => {
        if (isMobileTreeMode()) return;
        const client = document.getElementById('webContainer');
        if (!client || client.classList.contains('hide-left')) return;
        const startX = event.clientX;
        const startWidth = treePanelWidth;
        let currentWidth = startWidth;
        client.classList.add('tree-resizing');
        treeResizeHandle.classList.add('dragging');
        treeResizeHandle.setPointerCapture?.(event.pointerId);

        const onMove = (moveEvent) => {
            const delta = moveEvent.clientX - startX;
            currentWidth = startWidth + delta;
            applyTreePanelWidth(currentWidth);
        };

        const stopResize = () => {
            persistTreePanelWidth(currentWidth);
            applyTreePanelWidth(treePanelWidth);
            client.classList.remove('tree-resizing');
            treeResizeHandle.classList.remove('dragging');
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', stopResize);
            window.removeEventListener('blur', stopResize);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', stopResize);
        window.addEventListener('blur', stopResize);
    });
}


// ============================
// 附件管理
// ============================

/** 读取文件为 DataURL（用 FileReader） */
function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
    });
}

/** 添加附件（20MB 限制，防重复） */
function addAttachment(file) {
    const size = file.size;
    if (size > 20 * 1024 * 1024) {
        showToast('附件过大，请选择 20MB 以内的文件', 'error');
        return;
    }
    const filename = file.name;
    if (attachedFiles.some(f => f.filename === filename && f.size === size)) {
        showToast('文件已添加: ' + filename, 'info');
        return;
    }
    readFileAsDataURL(file).then(data => {
        attachedFiles.push({ data, filename, mime: file.type || 'application/octet-stream', size });
        renderAttachedFiles();
    }).catch(e => {
        showToast('读取附件失败: ' + e.message, 'error');
    });
}

/** 移除指定索引的附件 */
function removeAttachment(index) {
    attachedFiles.splice(index, 1);
    renderAttachedFiles();
}

/** 渲染附件列表 DOM（含删除按钮） */
function renderAttachedFiles() {
    const list = document.getElementById('ocAttachList');
    if (!list) return;
    if (!attachedFiles.length) {
        list.innerHTML = '';
        return;
    }
    list.innerHTML = attachedFiles.map((f, i) =>
        `<span class="oc-attach-chip"><span class="oc-attach-chip-name">📎 ${escapeHtml(f.filename)}</span><span class="oc-attach-chip-remove" data-index="${i}">✕</span></span>`
    ).join('');
    list.querySelectorAll('.oc-attach-chip-remove').forEach(el => {
        el.addEventListener('click', () => removeAttachment(parseInt(el.dataset.index)));
    });
}

/** 清空全部附件 */
function clearAttachments() {
    attachedFiles = [];
    renderAttachedFiles();
}

/** 构建发送消息的 parts 数组（文本 + 附件） */
function buildParts(text) {
    const parts = [];
    if (text.trim()) {
        parts.push({ type: 'text', text });
    }
    attachedFiles.forEach(f => {
        parts.push({ type: 'file', mime: f.mime, filename: f.filename, url: f.data });
    });
    return parts;
}

// ============================
// 会话轮询与发送按钮
// ============================

/** 调度会话状态轮询（每 4 秒检查，非忙碌时自动停止） */
/**
 * 调度会话状态轮询
 * 每 4 秒检查一次会话状态，会话繁忙时持续轮询，完成后自动停止并刷新消息
 */
function scheduleRefresh() {
    clearInterval(refreshTimer);
    const refreshSessionId = currentSessionId;
    refreshTimer = setInterval(() => {
        if (!webRunning || !refreshSessionId) return;//opencode服务未启动或者当前没有会话
        // 如果用户已经切换会话，旧定时器直接停止，避免处理新会话
        if (refreshSessionId !== currentSessionId) {
            clearInterval(refreshTimer);
            refreshTimer = null;
            return;
        }
        const wasBusy = isSessionBusy(refreshSessionId);
        loadSessionStatuses().then(statuses => {
            const nextStatuses = statuses || {};
            if (isSessionBusy(refreshSessionId) && !nextStatuses[refreshSessionId]) {
                nextStatuses[refreshSessionId] = sessionStatuses[refreshSessionId];
            }
            sessionStatuses = nextStatuses;
            updateSendButton();
            const busy = isSessionBusy(refreshSessionId);
            // if (busy || wasBusy) {
            //     loadMessages();
            // }
            if (!busy) {
                clearInterval(refreshTimer);
                refreshTimer = null;
                loadMessages()
            }
        }).catch(() => {
            // 状态刷新失败时不要影响 SSE 流式输出
        });
        if (wasBusy) loadDiff();
        
    }, 4000);
}

/** 更新发送按钮状态（发送 / 停止） */
/**
 * 更新发送按钮状态
 * 会话繁忙时显示「⏹ 停止」按钮，空闲时显示「发送」按钮
 */
function updateSendButton() {
    const btn = document.getElementById('btnSendPrompt');
    if (!webRunning || !currentSessionId) {
        btn.textContent = '发送';
        btn.className = 'btn btn-primary';
        return;
    }
    const busy = isSessionBusy(currentSessionId);
    if (busy) {
        btn.textContent = '⏹ 停止';
        btn.className = 'btn btn-danger-outline';
    } else {
        btn.textContent = '发送';
        btn.className = 'btn btn-primary';
    }
}

/** 中止当前会话（调用 API，刷新状态和消息） */
/**
 * 中止当前会话
 * 调用 API 停止会话处理，更新状态并刷新消息列表
 */
async function abortSession() {
    if (!webRunning || !currentSessionId) return;
    const btn = document.getElementById('btnSendPrompt');
    btn.disabled = true;
    const sessionID = currentSessionId;
    try {
        await ocApi('POST', `/session/${encodeURIComponent(sessionID)}/abort`);
        showToast('已停止', 'info');
        sessionStatuses[sessionID] = 'idle';
        updateSendButton();
        await loadMessages();
        loadSessionStatuses().then(statuses => {
            sessionStatuses = statuses || sessionStatuses;
            updateSendButton();
        });
    } catch (e) {
        showToast('停止失败: ' + (e.message || e), 'error');
    }
    btn.disabled = false;
}

// ============================
// 发送消息
// ============================

/** 发送消息主函数：新会话创建 → 构建 body → prompt_async → 轮询刷新 */
async function sendPrompt() {
    if (!webRunning) return;
    const input = document.getElementById('ocPrompt');
    const text = input.value.trim();
    if (!text.trim() && !attachedFiles.length) return;
    const btn = document.getElementById('btnSendPrompt');
    btn.disabled = true;
    const isNew = !currentSessionId;
    let sessionDir = '';
    try {
        if (isNew) {
            if (pendingWorkDir) {
                sessionDir = pendingWorkDir;
                pendingWorkDir = '';
                const session = await createSessionWithDir(sessionDir);
                currentSessionId = session.id || session.ID;
            } else {
                const session = await ocApi('POST', '/session');
                currentSessionId = session.id || session.ID;
            }
            await buildTree();
        }
        if (currentSessionId) {
            sessionStatuses[currentSessionId] = 'busy';
            ensurePendingAssistant(currentSessionId);
            if (isMobileTreeMode()) {
                renderPendingAssistantPlaceholder(currentSessionId);
            } else {
                renderCachedMessages(currentSessionId);
            }
            smartScroll(document.getElementById('ocMessages'), true);
            updateSendButton();
        }
        const body = { parts: buildParts(text) };
        if (selectedAgent) body.agent = selectedAgent;
        if (selectedModel) {
            const slashIdx = selectedModel.indexOf('/');
            if (slashIdx > 0) {
                body.model = {
                    providerID: selectedModel.slice(0, slashIdx),
                    modelID: selectedModel.slice(slashIdx + 1),
                };
            }
        }
        if (selectedVariant) body.variant = selectedVariant;
        await ocApi('POST', `/session/${encodeURIComponent(currentSessionId)}/prompt_async`, body);
        if (isNew) {
            const title = text.slice(0, 15) + (text.length > 15 ? '...' : '');
            await ocApi('PATCH', `/session/${encodeURIComponent(currentSessionId)}`, { title })
                .catch(() => {});
            await buildTree();
        }
        input.value = '';
        clearAttachments();
        if (!isMobileTreeMode()) {
            await loadMessages();
        }
        smartScroll(document.getElementById('ocMessages'), true);
        scheduleRefresh();
        updateSendButton();
    } catch (e) {
        showToast('发送失败: ' + (e.message || e), 'error');
    }
    btn.disabled = false;
}
