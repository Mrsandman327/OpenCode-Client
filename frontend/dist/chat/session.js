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
            api.OpenCodeCall('GET', '/agent').catch(() => []),
            api.OpenCodeCall('GET', '/provider').catch(() => []),
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
let currentSessionRefreshPending = false;

/** 从 OpenCode API 获取当前会话的最新标题，更新标题栏、_sessionMap 和项目树节点 */
async function refreshSessionTitle() {
    if (!currentSessionId) return;
    try {
        const data = await api.OpenCodeCall('GET', `/session/${encodeURIComponent(currentSessionId)}`);
        const title = data?.title || data?.Title;
        if (!title) return;
        // 从 _sessionMap 读取旧标题（可能因时序问题尚未存在）
        const oldTitle = window._sessionMap?.[currentSessionId]?.title;
        if (oldTitle === title) return;
        // 确保 _sessionMap 存在并更新
        if (!window._sessionMap) window._sessionMap = {};
        if (!window._sessionMap[currentSessionId]) window._sessionMap[currentSessionId] = {};
        window._sessionMap[currentSessionId].title = title;
        // 更新会话区标题栏
        document.getElementById('ocChatTitle').textContent = title;
        // 更新项目树中的会话节点
        const escapedId = currentSessionId.replace(/[&<>"']/g, function(m) {
            return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m];
        });
        const treeNode = document.querySelector('.oc-tree-session[data-session-id="' + escapedId + '"]');
        if (treeNode) {
            const label = treeNode.querySelector('.oc-tree-label');
            if (label) {
                label.textContent = '💬 ' + title;
            }
            const tooltipTitle = treeNode.querySelector('.oc-tree-tooltip-title');
            if (tooltipTitle) tooltipTitle.textContent = title;
        }
    } catch (_) {}
}

/**
 * 刷新当前会话视图。
 * 与切换会话后的加载流程类似，但保留当前会话的局部阅读状态，
 * 不清空展开状态、不清空 question 自定义输入，也不切换会话本身。
 */
async function refreshCurrentSession() {
    if (!webRunning) return;
    if (!currentSessionId) {
        showToast('当前没有可刷新的会话', 'info');
        return;
    }
    if (currentSessionRefreshPending) return;

    const refreshBtn = document.getElementById('btnRefreshCurrentSession');
    const box = document.getElementById('ocMessages');
    const refreshSessionId = currentSessionId;

    currentSessionRefreshPending = true;
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '⏳';
        refreshBtn.title = '正在刷新当前会话';
    }

    markdownCache = {};
    lastMessageCount = 0;
    messageLoadSeq++;
    if (box) {
        box.innerHTML = '<div class="oc-empty">正在刷新会话消息...</div>';
    }

    try {
        await loadMessages();
        if (refreshSessionId !== currentSessionId) return;

        if (!isMobileTreeMode()) {
            extractSubtaskSummaries(currentSessionId);
            renderSubtaskPanel();
            await loadDiff();
        }

        try {
            const statuses = await loadSessionStatuses();
            if (refreshSessionId === currentSessionId && statuses) {
                sessionStatuses = statuses || sessionStatuses;
            }
        } catch (_) {}

        if (refreshSessionId !== currentSessionId) return;

        updateSendButton();
        if (isSessionBusy(currentSessionId)) {
            scheduleRefresh();
        }
        smartScroll(document.getElementById('ocMessages'), true);
        showToast('已刷新当前会话', 'success');
    } catch (e) {
        if (refreshSessionId === currentSessionId) {
            showToast('刷新当前会话失败: ' + (e.message || e), 'error');
        }
    } finally {
        currentSessionRefreshPending = false;
        if (refreshBtn) {
            refreshBtn.disabled = !webRunning || !currentSessionId;
            refreshBtn.textContent = '↻';
            refreshBtn.title = '刷新当前会话';
        }
    }
}

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
        var dirPath = info?.directory || '';
        dirEl.textContent = dirPath || id;
        dirEl.title = dirPath || '';
        dirEl.style.cursor = 'pointer';
        dirEl.onclick = function() {
            var p = info?.directory || '';
            if (!p) return;
            // 桌面端和 Web 端统一：都打开站内文件浏览器
            openFileBrowserModal(p, { features: ['git'] });
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
    const session = await api.OpenCodeCall('POST', '/session?directory=' + encodeURIComponent(dir));
    rememberKnownDir(dir);
    return session;
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
        const messages = await api.OpenCodeCall('GET', `/session/${encodeURIComponent(currentSessionId)}/message`);
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
    // 同时兼容鼠标与触摸拖拽，保证移动端也能调整项目树宽度。
    const startResize = (startClientX) => {
        if (isMobileTreeMode()) return;
        const client = document.getElementById('webContainer');
        if (!client || client.classList.contains('hide-left')) return;
        const startWidth = treePanelWidth;
        let currentWidth = startWidth;
        client.classList.add('tree-resizing');
        treeResizeHandle.classList.add('dragging');

        const onMove = (moveEvent) => {
            if (moveEvent.touches) moveEvent.preventDefault();
            const clientX = moveEvent.touches ? moveEvent.touches[0].clientX : moveEvent.clientX;
            const delta = clientX - startClientX;
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
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', stopResize);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', stopResize);
            window.removeEventListener('blur', stopResize);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', stopResize);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', stopResize);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', stopResize);
        window.addEventListener('blur', stopResize);
    };

    treeResizeHandle.addEventListener('pointerdown', (event) => {
        startResize(event.clientX);
        treeResizeHandle.setPointerCapture?.(event.pointerId);
    });

    treeResizeHandle.addEventListener('touchstart', (event) => {
        event.preventDefault();
        startResize(event.touches[0].clientX);
    });
}

// ============================
// 右侧面板宽度状态
// ============================

/** 右侧面板宽度的 localStorage 键名（全局共享） */
const SIDEPANEL_WIDTH_KEY = 'sidepanelWidth';
/** 右侧面板默认宽度（无记录时使用） */
const SIDEPANEL_DEFAULT_WIDTH = 320;
/** 右侧面板允许的最小宽度 */
const SIDEPANEL_MIN_WIDTH = 220;
/** 右侧面板允许的理论最大宽度 */
const SIDEPANEL_MAX_WIDTH = 420;
/** 最近一次有效的右侧面板展开宽度 */
let sidepanelWidth = SIDEPANEL_DEFAULT_WIDTH;

/**
 * 归一化右侧面板用户偏好宽度
 * 仅做静态范围约束（220~420），不考虑当前窗口可用宽度
 */
function normalizeSidepanelWidth(width) {
    const numeric = Number(width);
    if (!Number.isFinite(numeric)) return SIDEPANEL_DEFAULT_WIDTH;
    return Math.max(SIDEPANEL_MIN_WIDTH, Math.min(SIDEPANEL_MAX_WIDTH, numeric));
}

/**
 * 计算当前窗口下允许的右侧面板动态最大宽度
 * 需要为中间聊天区保留至少 360px，并考虑左侧项目树当前渲染宽度
 */
function getSidepanelDynamicMaxWidth() {
    const client = document.getElementById('webContainer');
    if (!client) return SIDEPANEL_MAX_WIDTH;
    const availableWidth = client.clientWidth;
    const leftWidth = client.classList.contains('hide-left')
        ? 0
        : (parseFloat(getComputedStyle(client).getPropertyValue('--tree-panel-width')) || TREE_PANEL_DEFAULT_WIDTH);
    return Math.max(SIDEPANEL_MIN_WIDTH, Math.min(SIDEPANEL_MAX_WIDTH, availableWidth - leftWidth - 360));
}

/**
 * 根据当前窗口大小夹取右侧面板实际渲染宽度
 * 该宽度可能小于用户偏好值，但不会覆盖用户偏好本身
 */
function clampSidepanelWidth(width) {
    return Math.max(SIDEPANEL_MIN_WIDTH, Math.min(getSidepanelDynamicMaxWidth(), normalizeSidepanelWidth(width)));
}

/**
 * 将右侧面板宽度应用到桌面端布局
 * 通过 `--sidepanel-width` 同时驱动第三列宽度与收起按钮定位
 */
function applySidepanelWidth(width) {
    const client = document.getElementById('webContainer');
    if (!client || isMobileTreeMode()) return;
    const nextWidth = clampSidepanelWidth(width);
    client.style.setProperty('--sidepanel-width', nextWidth + 'px');
}

/**
 * 持久化用户偏好的右侧面板宽度
 * 保存的是用户偏好值，不是当前窗口下的临时夹取值
 */
function persistSidepanelWidth(width) {
    const nextWidth = normalizeSidepanelWidth(width);
    sidepanelWidth = nextWidth;
    try {
        localStorage.setItem(SIDEPANEL_WIDTH_KEY, String(nextWidth));
    } catch (_) {}
    return nextWidth;
}

/**
 * 初始化右侧面板宽度
 * 优先恢复 localStorage 中的值；无记录或非法值时回退到默认值 320px
 */
function loadSidepanelWidth() {
    let width = SIDEPANEL_DEFAULT_WIDTH;
    try {
        const saved = localStorage.getItem(SIDEPANEL_WIDTH_KEY);
        if (saved != null) {
            width = saved;
        }
    } catch (_) {}
    sidepanelWidth = normalizeSidepanelWidth(width);
    applySidepanelWidth(sidepanelWidth);
    persistSidepanelWidth(sidepanelWidth);
}

/**
 * 绑定右侧面板拖拽调宽逻辑（仅桌面端）
 * 收起状态下不响应拖拽；拖拽结束后写入 localStorage
 */
function initSidepanelResize() {
    const sidepanelResizeHandle = document.getElementById('ocSidepanelResizeHandle');
    if (!sidepanelResizeHandle) return;
    // 同时兼容鼠标与触摸拖拽，保证移动端也能调整右侧面板宽度。
    const startResize = (startClientX) => {
        if (isMobileTreeMode()) return;
        const client = document.getElementById('webContainer');
        if (!client || client.classList.contains('hide-right')) return;
        const startWidth = sidepanelWidth;
        let currentWidth = startWidth;
        client.classList.add('sidepanel-resizing');
        sidepanelResizeHandle.classList.add('dragging');

        const onMove = (moveEvent) => {
            if (moveEvent.touches) moveEvent.preventDefault();
            const clientX = moveEvent.touches ? moveEvent.touches[0].clientX : moveEvent.clientX;
            const delta = startClientX - clientX;
            currentWidth = startWidth + delta;
            applySidepanelWidth(currentWidth);
        };

        const stopResize = () => {
            persistSidepanelWidth(currentWidth);
            applySidepanelWidth(sidepanelWidth);
            client.classList.remove('sidepanel-resizing');
            sidepanelResizeHandle.classList.remove('dragging');
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', stopResize);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', stopResize);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', stopResize);
            window.removeEventListener('blur', stopResize);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', stopResize);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', stopResize);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', stopResize);
        window.addEventListener('blur', stopResize);
    };

    sidepanelResizeHandle.addEventListener('pointerdown', (event) => {
        startResize(event.clientX);
        sidepanelResizeHandle.setPointerCapture?.(event.pointerId);
    });

    sidepanelResizeHandle.addEventListener('touchstart', (event) => {
        event.preventDefault();
        startResize(event.touches[0].clientX);
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
                loadMessages();
                refreshSessionTitle();
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
        await api.OpenCodeCall('POST', `/session/${encodeURIComponent(sessionID)}/abort`);
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

/** 发送消息主函数：新会话创建 → 构建 body → 同步发送 → 刷新消息 */
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
                //设置当前目录
                document.getElementById('ocSideDirPath').textContent = sessionDir;
                currentSessionId = session.id || session.ID;
            } else {
                 showToast('请先新建会话，设置会话目录', 'error');
                 return;
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
        const dirEl = document.getElementById('ocSideDirPath');
        const requestDir = (dirEl?.textContent || window._sessionMap?.[currentSessionId]?.directory || sessionDir || '').trim();
        const directoryQuery = requestDir ? `?directory=${encodeURIComponent(requestDir)}` : '';
        await api.OpenCodeCall('POST', `/session/${encodeURIComponent(currentSessionId)}/prompt_async${directoryQuery}`, body);
        if (isNew) {
            dirEl.onclick = function() {
                openFileBrowserModal(requestDir, { features: ['git'] });
            };
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
