// ============================================================
// OpenCode 管理中心 - 工作区（OpenCode Web）
// ============================================================

let webURL = '';
let frontendWebURL = '';
let webRunning = false;
let frontendWebRunning = false;
const FRONTEND_WEB_CONFIG_KEY = 'oc-frontend-web-config';
let currentSessionId = '';
let sessions = [];
let sessionStatuses = {};
let sessionErrors = {};
let refreshTimer = null;
let serverStatus = { url: '', health: '未知', version: '' };
let mcpStatus = null;
let lspStatus = null;
let expandedParts = {};
let markdownCache = {};
let lastMessageCount = 0;
let lastSourceMessageCount = 0;
let messageLoadSeq = 0;
let messageCache = {};
let pendingMessageRenderSession = '';
let pendingMessageRenderFrame = 0;
let userScrolling = false;

let sessionRefreshTimer = null;
let attachedFiles = [];
let questionCustomInput = ''; // question 工具自定义输入框的值（防止 DOM 重建时丢失）
let dirBrowserCurrentPath = '';
const MOBILE_MESSAGE_RENDER_LIMIT = 30;
const MOBILE_MESSAGE_LOAD_MORE_STEP = 20;
let visibleMessageCount = MOBILE_MESSAGE_RENDER_LIMIT;

// 全局 agent/model 选择
let agentList = [];
let modelList = [];
let selectedAgent = '';
let selectedModel = '';
let selectedVariant = '';
let agentModelSelectorsLoaded = false;

// ============================
// 子任务面板全局状态
// ============================
let subtaskSummaries = [];
let subtaskExtractionPending = false;
let subtaskExtractionFrame = 0;

// 子会话详情缓存（独立于 messageCache）
let detailMessageCache = {};
let detailLoading = {};
let detailMessageLoadSeq = 0;

// 详情弹窗展开状态（独立于 expandedParts）
let detailExpandedParts = {};

// ============================
// 网络配置
// ============================

function getNetworkConfig() {
    try {
        const saved = JSON.parse(localStorage.getItem(NETWORK_CONFIG_KEY) || '{}');
        return {
            serviceHost: (saved.serviceHost || '127.0.0.1').trim(),
            servicePort: (saved.servicePort || '4096').toString().trim(),
            proxyEnabled: !!saved.proxyEnabled,
            proxyHost: (saved.proxyHost || '127.0.0.1').trim(),
            proxyPort: (saved.proxyPort || '7897').toString().trim(),
        };
    } catch (_) {
        return { serviceHost: '127.0.0.1', servicePort: '4096', proxyEnabled: false, proxyHost: '127.0.0.1', proxyPort: '7897' };
    }
}

function saveNetworkConfig(config) {
    const next = {
        serviceHost: (config.serviceHost || '127.0.0.1').trim(),
        servicePort: (config.servicePort || '4096').toString().trim(),
        proxyEnabled: !!config.proxyEnabled,
        proxyHost: (config.proxyHost || '127.0.0.1').trim(),
        proxyPort: (config.proxyPort || '7897').toString().trim(),
    };
    localStorage.setItem(NETWORK_CONFIG_KEY, JSON.stringify(next));
    updateProxyButton();
    return next;
}

function getFrontendWebConfig() {
    try {
        const saved = JSON.parse(localStorage.getItem(FRONTEND_WEB_CONFIG_KEY) || '{}');
        return {
            host: (saved.host || '127.0.0.1').trim(),
            port: (saved.port || '8081').toString().trim(),
        };
    } catch (_) {
        return { host: '127.0.0.1', port: '8081' };
    }
}

function saveFrontendWebConfig(config) {
    const next = {
        host: (config.host || '127.0.0.1').trim(),
        port: (config.port || '8081').toString().trim(),
    };
    localStorage.setItem(FRONTEND_WEB_CONFIG_KEY, JSON.stringify(next));
    return next;
}

function loadFrontendWebConfigToInputs() {
    const hostEl = document.getElementById('frontendWebHost');
    const portEl = document.getElementById('frontendWebPort');
    const config = getFrontendWebConfig();
    if (hostEl) hostEl.value = config.host;
    if (portEl) portEl.value = config.port;
    return config;
}

function persistFrontendWebConfigFromInputs() {
    const host = document.getElementById('frontendWebHost')?.value.trim() || '127.0.0.1';
    const port = document.getElementById('frontendWebPort')?.value.trim() || '8081';
    return saveFrontendWebConfig({ host, port });
}

async function copyFrontendWebUrl() {
    if (!frontendWebURL) {
        showToast('当前没有可复制的访问地址', 'warning');
        return;
    }
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(frontendWebURL);
        } else {
            const input = document.createElement('input');
            input.value = frontendWebURL;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
        }
        showToast('访问地址已复制', 'success');
    } catch (e) {
        showToast('复制失败: ' + (e.message || e), 'error');
    }
}

function proxyUrl(config = getNetworkConfig()) {
    if (!config.proxyHost || !config.proxyPort) return '';
    return `http://${config.proxyHost}:${config.proxyPort}`;
}

function updateProxyPreview() {
    const proxyEnabled = document.getElementById('proxyEnabled')?.checked;
    const proxyHost = document.getElementById('proxyHost')?.value.trim() || '127.0.0.1';
    const proxyPort = document.getElementById('proxyPort')?.value.trim() || '7897';
    const serviceHost = document.getElementById('serviceHost')?.value.trim() || '127.0.0.1';
    const servicePort = document.getElementById('servicePort')?.value.trim() || '4096';
    const preview = document.getElementById('proxyPreview');
    if (!preview) return;
    const parts = [];
    parts.push(`服务地址: ${serviceHost}:${servicePort}`);
    if (proxyEnabled) {
        const url = `http://${proxyHost}:${proxyPort}`;
        parts.push(`代理: HTTP_PROXY、HTTPS_PROXY、ALL_PROXY = ${url}；NO_PROXY = localhost,127.0.0.1`);
    } else {
        parts.push('代理未启用');
    }
    preview.textContent = parts.join('\n');
}

function updateProxyButton() {
    const btn = document.getElementById('btnProxySettings');
    if (!btn) return;
    const config = getNetworkConfig();
    btn.classList.toggle('active', config.proxyEnabled);
    btn.title = webRunning ? '配置（服务运行期间仅可查看）' : (config.proxyEnabled ? `代理已启用: ${proxyUrl(config)}` : '配置');
}

function showProxyModal() {
    const config = getNetworkConfig();
    const serviceHostEl = document.getElementById('serviceHost');
    const servicePortEl = document.getElementById('servicePort');
    const proxyEnabledEl = document.getElementById('proxyEnabled');
    const proxyHostEl = document.getElementById('proxyHost');
    const proxyPortEl = document.getElementById('proxyPort');
    const saveBtn = document.getElementById('btnSaveProxy');
    const cancelBtn = document.getElementById('btnCancelProxy');
    serviceHostEl.value = config.serviceHost;
    servicePortEl.value = config.servicePort;
    proxyEnabledEl.checked = config.proxyEnabled;
    proxyHostEl.value = config.proxyHost;
    proxyPortEl.value = config.proxyPort;
    const readonly = webRunning;
    serviceHostEl.readOnly = readonly;
    servicePortEl.readOnly = readonly;
    proxyEnabledEl.disabled = readonly;
    proxyHostEl.readOnly = readonly;
    proxyPortEl.readOnly = readonly;
    saveBtn.style.display = readonly ? 'none' : '';
    cancelBtn.textContent = readonly ? '关闭' : '取消';
    if (readonly) {
        serviceHostEl.style.opacity = '0.6';
        servicePortEl.style.opacity = '0.6';
        proxyHostEl.style.opacity = '0.6';
        proxyPortEl.style.opacity = '0.6';
    } else {
        serviceHostEl.style.opacity = '';
        servicePortEl.style.opacity = '';
        proxyHostEl.style.opacity = '';
        proxyPortEl.style.opacity = '';
    }
    updateProxyPreview();
    document.getElementById('proxyModal').style.display = 'flex';
}

function hideProxyModal() {
    document.getElementById('proxyModal').style.display = 'none';
}

function applyProxyConfig() {
    const serviceHost = document.getElementById('serviceHost').value.trim() || '127.0.0.1';
    const servicePort = document.getElementById('servicePort').value.trim() || '4096';
    const proxyEnabled = document.getElementById('proxyEnabled').checked;
    const proxyHost = document.getElementById('proxyHost').value.trim() || '127.0.0.1';
    const proxyPort = document.getElementById('proxyPort').value.trim() || '7897';
    if (!/^\d{1,5}$/.test(servicePort)) {
        showToast('服务端口必须是数字', 'error');
        return;
    }
    if (proxyEnabled && !/^\d{1,5}$/.test(proxyPort)) {
        showToast('代理端口必须是数字', 'error');
        return;
    }
    saveNetworkConfig({ serviceHost, servicePort, proxyEnabled, proxyHost, proxyPort });
    hideProxyModal();
}

// ============================
// 项目树
// ============================

async function buildTree() {
    if (!webRunning) return;
    try {
        const knownDirs = JSON.parse(localStorage.getItem('oc-known-dirs') || '[]');
        const json = await api.GetProjectTree(JSON.stringify(knownDirs));
        if (json && json !== '[]') {
            const tree = JSON.parse(json);
            window._lastProjectTree = tree;
            renderTree(tree);
            return true;
        } else {
            window._lastProjectTree = [];
            document.getElementById('ocTree').innerHTML = '<div class="oc-empty">暂无项目，新建会话后将自动出现</div>';
            return false;
        }
    } catch (_) {
        window._lastProjectTree = [];
        document.getElementById('ocTree').innerHTML = '<div class="oc-empty">加载树失败</div>';
        return false;
    }
}

async function refreshTree() {
    const ok = await buildTree();
    showToast(ok ? '刷新成功' : '刷新失败', ok ? 'success' : 'error');
}

function renderTree(tree) {
    const container = document.getElementById('ocTree');
    if (!tree || tree.length === 0) {
        container.innerHTML = '<div class="oc-empty">暂无项目</div>';
        return;
    }
    window._sessionMap = {};
    let html = '';
    for (const proj of tree) {
        html += `<div class="oc-tree-node oc-tree-project" data-id="${escapeHtml(proj.id)}">`;
        html += `<div class="oc-tree-row oc-tree-project-row"><div class="oc-tree-toggle">▼</div><span class="oc-tree-label" title="${escapeHtml(proj.title)}">📁 ${escapeHtml(proj.title)}</span><button class="oc-tree-add-dir" data-project-id="${escapeHtml(proj.id)}" title="添加工作目录">＋</button></div>`;
        html += `<div class="oc-tree-children">`;
        for (const dir of (proj.children || [])) {
            html += `<div class="oc-tree-node oc-tree-directory" data-id="${escapeHtml(dir.id)}">`;
            html += `<div class="oc-tree-toggle">▼</div><span class="oc-tree-label" title="${escapeHtml(dir.title)}">📂 ${escapeHtml(dir.title)}</span>`;
            html += `<div class="oc-tree-children">`;
            for (const ses of (dir.children || [])) {
                const fullTitle = ses.title;
                const updatedAt = ses.updatedAt || '';
                const sesDir = ses.directory || dir.title;
                window._sessionMap[ses.id] = { title: ses.title, directory: sesDir, updatedAt: updatedAt };
                html += `<div class="oc-tree-node oc-tree-session" data-session-id="${escapeHtml(ses.id)}">`;
                html += `<div class="oc-tree-indent"></div><span class="oc-tree-label" title="${escapeHtml(ses.title+'\n📂 '+sesDir+'\n⏰ '+updatedAt)}">💬 ${escapeHtml(ses.title)}</span>`;
                html += `<div class="oc-tree-tooltip"><div class="oc-tree-tooltip-title">${escapeHtml(ses.title)}</div><div class="oc-tree-tooltip-row">📂 ${escapeHtml(sesDir)}</div><div class="oc-tree-tooltip-row">⏰ ${escapeHtml(updatedAt)}</div></div>`;
                html += `<button class="oc-tree-del" data-del-id="${escapeHtml(ses.id)}" title="删除会话">✕</button>`;
                html += `</div>`;
            }
            html += `</div></div>`;
        }
        html += `</div></div>`;
    }
    container.innerHTML = html;

    container.querySelectorAll('.oc-tree-toggle').forEach(el => {
        el.addEventListener('click', () => {
            const node = el.closest('.oc-tree-node');
            const children = node.querySelector('.oc-tree-children');
            if (children) {
                const isOpen = children.style.display !== 'none';
                children.style.display = isOpen ? 'none' : '';
                el.textContent = isOpen ? '▶' : '▼';
            }
        });
    });

    container.querySelectorAll('.oc-tree-session').forEach(el => {
        el.addEventListener('click', async (e) => {
            if (e.target.closest('.oc-tree-del')) return;
            const sid = el.dataset.sessionId;
            if (sid && sid !== currentSessionId) {
                if (isMobileTreeMode()) {
                    closeMobileTree();
                }
                await switchSession(sid);
            }
            if (isMobileTreeMode()) {
                closeMobileTree();
            }
        });
    });
    container.querySelectorAll('.oc-tree-add-dir').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await addDirectoryToProject(btn.dataset.projectId || '');
        });
    });
    container.querySelectorAll('.oc-tree-del').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const sid = btn.dataset.delId;
            if (!sid) return;
            await deleteSession(sid);
            await buildTree();
        });
    });
}

function rememberKnownDir(dir) {
    if (!dir) return;
    try {
        const dirs = JSON.parse(localStorage.getItem('oc-known-dirs') || '[]');
        if (!dirs.includes(dir)) {
            dirs.push(dir);
            localStorage.setItem('oc-known-dirs', JSON.stringify(dirs));
        }
    } catch (_) {}
}

function treeHasSessionsForDir(tree, dir) {
    const target = String(dir || '').replace(/\\+$/, '').toLowerCase();
    for (const proj of (tree || [])) {
        for (const child of (proj.children || [])) {
            const title = String(child.title || '').replace(/\\+$/, '').toLowerCase();
            if (title === target && (child.children || []).length > 0) {
                return true;
            }
        }
    }
    return false;
}

async function addDirectoryToProject() {
    if (!webRunning) return;
    try {
        if (isBrowserRuntimeForMain()) {
            await openDirBrowserModal();
            return;
        }
        const dir = await api.OpenDirectoryDialog();
        if (!dir) return;
        rememberKnownDir(dir);
        const ok = await buildTree();
        if (!ok || !treeHasSessionsForDir(window._lastProjectTree, dir)) {
            document.getElementById('ocChatTitle').textContent = '工作目录 @ ' + dir;
            document.getElementById('ocMessages').innerHTML = '<div class="oc-empty">该目录下没有会话记录，请先在该目录下新建会话</div>';
            showToast('该目录下没有会话记录，请先在该目录下新建会话', 'warning');
            return;
        }
        showToast('已加载目录会话: ' + dir, 'success');
    } catch (e) {
        showToast('选择目录失败: ' + (e.message || e), 'error');
    }
}

// ============================
// 全局 Agent/Model 选择器
// ============================

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

// ============================
// Web 状态检测
// ============================

async function checkWebStatus() {
    try {
        const config = getNetworkConfig();
        const status = await api.GetWebStatus(config.serviceHost, parseInt(config.servicePort) || 4096);
        webRunning = status.running;
        webURL = status.url || '';
        serverStatus = normalizeServerStatus(status);
        updateWebUI();
    if (webRunning) {
        startEventStream();
        buildTree();
        loadServiceStatus();
        loadAgentModelSelectors();
    } else {
            renderServiceStatus();
        }
    } catch (e) {
        console.warn('GetWebStatus failed:', e);
        serverStatus = normalizeServerStatus(null);
        renderServiceStatus();
    }
    setTimeout(function() { initSearch(); }, 500);
}

async function checkFrontendWebStatus() {
    try {
        const config = persistFrontendWebConfigFromInputs();
        const host = config.host || '127.0.0.1';
        const port = parseInt(config.port, 10) || 8081;
        const result = await api.GetFrontendWebStatus(host, port);
        frontendWebRunning = !!result.running;
        frontendWebURL = result.url || '';
    } catch (e) {
        frontendWebRunning = false;
        frontendWebURL = '';
    }
    renderFrontendWebStatus();
}

function renderFrontendWebStatus() {
    const statusEl = document.getElementById('frontendWebStatus');
    const urlEl = document.getElementById('frontendWebUrl');
    const btnStart = document.getElementById('btnSaveFrontendWeb');
    const btnStop = document.getElementById('btnStopFrontendWeb');
    const btnCopy = document.getElementById('btnCopyFrontendWebUrl');
    const btnToolbar = document.getElementById('btnFrontendWebConfig');
    const toolbarDot = document.getElementById('frontendWebToolbarDot');
    if (!statusEl || !urlEl || !btnStart || !btnStop || !btnCopy || !btnToolbar || !toolbarDot) return;
    statusEl.textContent = frontendWebRunning ? '运行中' : '未启动';
    statusEl.classList.toggle('frontend-web-status-running', frontendWebRunning);
    urlEl.textContent = frontendWebURL || '--';
    urlEl.title = frontendWebURL || '';
    urlEl.href = frontendWebURL || '#';
    urlEl.classList.toggle('disabled', !frontendWebURL);
    btnStart.disabled = frontendWebRunning;
    btnStop.disabled = !frontendWebRunning;
    btnCopy.disabled = !frontendWebURL;
    toolbarDot.classList.toggle('on', frontendWebRunning);
    toolbarDot.classList.toggle('off', !frontendWebRunning);
    btnToolbar.title = frontendWebRunning && frontendWebURL ? `Web服务运行中: ${frontendWebURL}` : 'Web服务';
}

function showFrontendWebModal() {
    const modal = document.getElementById('frontendWebModal');
    if (!modal) return;
    loadFrontendWebConfigToInputs();
    modal.style.display = 'flex';
    checkFrontendWebStatus();
}

function closeFrontendWebModal() {
    const modal = document.getElementById('frontendWebModal');
    if (modal) modal.style.display = 'none';
}

async function startFrontendWeb() {
    const btn = document.getElementById('btnSaveFrontendWeb');
    if (!btn) return;
    const config = persistFrontendWebConfigFromInputs();
    const host = config.host;
    const portText = config.port;
    if (!/^\d{1,5}$/.test(portText)) {
        showToast('Web服务端口必须是数字', 'error');
        return;
    }
    const port = parseInt(portText, 10) || 8081;
    btn.disabled = true;
    btn.textContent = '⏳ 启动中...';
    try {
        const result = await api.StartFrontendWeb(port, host);
        frontendWebRunning = !!result.running;
        frontendWebURL = result.url || '';
        renderFrontendWebStatus();
        if (frontendWebRunning) {
            showToast('Web服务已启动', 'success');
        } else if (result.error) {
            showToast('Web服务启动失败: ' + result.error, 'error');
        }
    } catch (e) {
        showToast('Web服务启动失败: ' + (e.message || e), 'error');
    }
    btn.textContent = '启动服务';
    checkFrontendWebStatus();
}

async function stopFrontendWeb() {
    const btn = document.getElementById('btnStopFrontendWeb');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '⏳ 停止中...';
    try {
        await api.StopFrontendWeb();
        frontendWebRunning = false;
        frontendWebURL = '';
        renderFrontendWebStatus();
        showToast('Web服务已停止', 'info');
    } catch (e) {
        showToast('Web服务停止失败: ' + (e.message || e), 'error');
    }
    btn.textContent = '停止服务';
    checkFrontendWebStatus();
}

// ============================
// API 工具
// ============================

async function ocApi(method, path, data) {
    const result = await api.OpenCodeAPI(method, path, data ? JSON.stringify(data) : '');
    if (!result.success) {
        throw new Error(result.error || result.body || `HTTP ${result.status}`);
    }
    if (!result.body) return null;
    return JSON.parse(result.body);
}

function safeText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
}

function extractPartText(part) {
    if (!part) return '';
    return part.text || part.content || part.message || part.value || safeText(part);
}

function messageText(item) {
    const parts = item?.parts || item?.info?.parts || [];
    const list = Array.isArray(parts) ? parts : [parts];
    return list.map(part => extractPartText(part)).join('\n').trim();
}

function isInternalUserMessage(item) {
    const info = item?.info || item || {};
    const role = info.role || info.author || '';
    if (role !== 'user') return false;
    // 空 parts 的 user 消息（如系统自动标记）视为内部消息
    const parts = item?.parts;
    if (!parts || (Array.isArray(parts) && parts.length === 0)) return true;
    const text = messageText(item);
    return text.includes('OMO_INTERNAL_INITIATOR')
        || text.includes('<system-reminder>')
        || text.includes('</system-reminder>')
        || /^\s*\[(?:BACKGROUND TASK COMPLETED|ALL BACKGROUND TASKS COMPLETE)\]/.test(text)
        || (text.includes('background_output(') && text.includes('task_id='));
}

// ============================
// SSE 事件处理
// ============================

function parseEventPayload(raw) {
    try {
        const event = JSON.parse(raw);
        if (event.payload?.type) {
            return {
                ...event.payload,
                directory: event.directory,
                project: event.project,
            };
        }
        return event;
    } catch { return { type: 'raw', data: raw }; }
}

function startEventStream() {
    if (window.runtime && !startEventStream.bound) {
        window.runtime.EventsOn('oc-event', (raw) => handleOcEvent(parseEventPayload(raw)));
        window.runtime.EventsOn('oc-event-error', (msg) => {
            showToast('事件流异常: ' + msg, 'error');
            // SSE 断开 → 交叉验证：调 GetWebStatus() 确认服务是否真停了
            // 若在线 → 自动重连 SSE；若离线 → 更新 UI 状态
            //setTimeout(() => checkWebStatus(), 200);
        });
        startEventStream.bound = true;
    }
    if (!window.runtime && !startEventStream.eventSource) {
        const es = new EventSource('/events');
        startEventStream.eventSource = es;
        es.addEventListener('oc-event', (event) => handleOcEvent(parseEventPayload(event.data)));
        es.addEventListener('oc-event-error', (event) => {
            showToast('事件流异常: ' + (event.data || '连接已断开'), 'error');
        });
        es.onerror = () => {
            showToast('事件流异常: 连接已断开', 'error');
        };
    }
    if (api.StartOpenCodeEvents) api.StartOpenCodeEvents();
}

function handleOcEvent(event) {
    const type = event.type || event.name || '';
    const props = event.properties || event.data || event;
    const sid = props.sessionID || props.sessionId || props.info?.sessionID || props.part?.sessionID || currentSessionId;

    if (type === 'server.connected' || type === 'server.heartbeat') return;

    if (type.includes('permission')) {
        const permission = props.permission ? { ...props.permission, ...props } : props;
        const kind = permission.permission || permission.type || 'tool';
        showToast('权限请求: ' + escapeHtml(kind), 'warning');
    }

    if (type === 'session.error' && sid && props.error) {
        sessionErrors[sid] = typeof props.error === 'string' ? props.error : (props.error.message || safeText(props.error));
        if (sid === currentSessionId) loadMessages();
        return;
    }
    if (type === 'session.status' && sid) {
        sessionStatuses[sid] = props.status || props;
        if (sid === currentSessionId) {
            updateSendButton();
            const status = props.status || props;
            if (status?.type === 'idle') {
                loadMessages();
            } else if (getCachedMessages(sid).length) {
                scheduleRenderCachedMessages(sid);
                scheduleSubtaskExtraction(sid);
            } else {
                loadMessages();
            }
        }
        return;
    }
    if (type === 'session.idle' && sid) {
        delete sessionErrors[sid];
        sessionStatuses[sid] = 'idle';
        if (sid === currentSessionId) {
            updateSendButton();
            loadMessages();
        }
        return;
    }

    if (type === 'message.updated' && props.info) {
        upsertMessage(props.info);
        scheduleRenderCachedMessages(sid);
        scheduleSubtaskExtraction(sid);
        return;
    }
    if (type === 'message.part.updated' && props.part) {
        upsertPart(props.part);
        scheduleRenderCachedMessages(sid);
        scheduleSubtaskExtraction(sid);
        return;
    }
    if (type === 'message.part.delta') {
        applyPartDelta(props);
        scheduleRenderCachedMessages(sid);
        scheduleSubtaskExtraction(sid);
        return;
    }
    if (type === 'message.part.removed') {
        removePart(props);
        scheduleRenderCachedMessages(sid);
        scheduleSubtaskExtraction(sid);
        return;
    }
    if (type === 'message.removed') {
        removeMessage(props);
        scheduleRenderCachedMessages(sid);
        scheduleSubtaskExtraction(sid);
        return;
    }

    const isCurrentSession = sid && sid === currentSessionId;
    if (type === 'session.created' && isCurrentSession) {
        buildTree();
        loadDiff();
        return;
    }
    if (type === 'session.deleted') {
        buildTree();
        loadDiff();
        return;
    }
    if (type === 'session.updated') {
        loadDiff();
    }
}

// ============================
// 消息缓存与渲染
// ============================

function normalizeMessageItem(item) {
    const info = item.info || item;
    const parts = item.parts || info.parts || [];
    return {
        info,
        parts: Array.isArray(parts) ? parts : [parts],
    };
}

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

function mergeMessage(existing, incoming) {
    if (!existing) return incoming;
    const existingParts = Array.isArray(existing.parts) ? existing.parts : [];
    const incomingParts = Array.isArray(incoming.parts) ? incoming.parts : [];
    return {
        info: { ...existing.info, ...incoming.info },
        parts: incomingParts.map(part => mergePart(existingParts.find(old => old.id && old.id === part.id), part)),
    };
}

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

function getCachedMessages(sessionID) {
    if (!messageCache[sessionID]) messageCache[sessionID] = [];
    return messageCache[sessionID];
}

function renderCachedMessages(sessionID) {
    if (!sessionID || sessionID !== currentSessionId) return;
    renderMessages(getCachedMessages(sessionID));
}

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

function removePart(props) {
    const sessionID = props.sessionID || currentSessionId;
    if (!sessionID || !props.messageID || !props.partID) return;
    const message = getCachedMessages(sessionID).find(item => (item.info?.id || item.id) === props.messageID);
    if (!message || !Array.isArray(message.parts)) return;
    message.parts = message.parts.filter(part => part.id !== props.partID);
}

function removeMessage(props) {
    const sessionID = props.sessionID || currentSessionId;
    if (!sessionID || !props.messageID) return;
    messageCache[sessionID] = getCachedMessages(sessionID).filter(item => (item.info?.id || item.id) !== props.messageID);
}

function ensurePendingAssistant(sessionID) {
    if (!sessionID) return;
    const list = getCachedMessages(sessionID);
    const last = list[list.length - 1];
    const role = last?.info?.role || last?.role;
    if (role === 'assistant') return;
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

function renderPendingAssistantPlaceholder(sessionID) {
	if (!sessionID || sessionID !== currentSessionId) return;
	const box = document.getElementById('ocMessages');
	if (!box) return;
	box.innerHTML = '<div class="oc-empty">正在等待模型回复...</div>';
}

async function loadSessions() {
    if (!webRunning) return;
    await buildTree();
}

function debounceRefreshTree() {
    clearTimeout(sessionRefreshTimer);
    sessionRefreshTimer = setTimeout(() => {
        if (webRunning) buildTree();
    }, 2000);
}

async function deleteSession(id) {
    if (!id) return;
    if (!confirm('确定要删除该会话吗？此操作不可撤销。')) return;
    try {
        await ocApi('DELETE', `/session/${encodeURIComponent(id)}`);
        showToast('已删除', 'success');
        if (id === currentSessionId) {
            currentSessionId = '';
            messageCache[currentSessionId] = null;
            expandedParts = {};
            document.getElementById('ocMessages').innerHTML = '<div class="oc-empty">选择会话后查看消息，或输入内容创建新会话</div>';
            document.getElementById('ocChatTitle').textContent = '未选择会话';
            updateModelInfo(null);
        }
        await loadSessions();
    } catch (e) {
        showToast('删除失败: ' + (e.message || e), 'error');
    }
}

async function loadSessionStatuses() {
    try {
        return await ocApi('GET', '/session/status') || {};
    } catch {
        return {};
    }
}

async function switchSession(id) { await selectSession(id); }

let pendingWorkDir = '';

async function selectSession(id) {
    if (!id) return;
    currentSessionId = id;
    visibleMessageCount = MOBILE_MESSAGE_RENDER_LIMIT;
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

async function createNewSession() {
    if (!webRunning) return;
    try {
        const dir = await api.OpenDirectoryDialog();
        if (!dir) return;
        pendingWorkDir = dir;
        currentSessionId = '';
        sessionStatuses = {};
        sessionErrors = {};
        subtaskSummaries = [];
        detailMessageCache = {};
        document.getElementById('ocChatTitle').textContent = '新建会话 @ ' + dir;
        document.getElementById('ocMessages').innerHTML = '<div class="oc-empty">输入内容后 Enter 发送，会话将在首次发送时创建</div>';
        document.getElementById('ocDiff').innerHTML = '<div class="oc-empty">选择会话后查看变更</div>';
        document.getElementById('ocPrompt').value = '';
        document.getElementById('ocPrompt').focus();
    } catch (e) {
        showToast('选择目录失败: ' + (e.message || e), 'error');
    }
}

async function createSessionWithDir(dir) {
    const result = await api.CreateSession(dir);
    if (!result.success) throw new Error(result.error || result.body || '创建失败');
    rememberKnownDir(dir);
    return JSON.parse(result.body);
}

async function newSessionWithDir() {
    if (!webRunning) return;
    try {
        const dir = await api.OpenDirectoryDialog();
        if (!dir) return;
        const session = await createSessionWithDir(dir);
        currentSessionId = session.id || session.ID;
        await buildTree();
        await loadMessages();
        showToast('会话已创建: ' + dir, 'success');
    } catch (e) {
        showToast('创建失败: ' + (e.message || e), 'error');
    }
}

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

function trimMessagesForMobile(items) {
	const list = Array.isArray(items) ? items : [];
	if (!isMobileTreeMode()) {
		return list;
	}
	if (list.length <= getVisibleMessageCount()) {
		return list;
	}
	return list.slice(-getVisibleMessageCount());
}

function getVisibleMessageCount() {
	if (!isMobileTreeMode()) {
		return Number.MAX_SAFE_INTEGER;
	}
	return visibleMessageCount;
}

function renderCollapsedHistoryNotice(totalCount, hiddenCount) {
	const box = document.getElementById('ocMessages');
	if (!box || hiddenCount <= 0) return;
	const notice = document.createElement('button');
	notice.type = 'button';
	notice.className = 'btn btn-sm oc-history-more';
	notice.textContent = `已折叠较早消息，点击加载更多（前面还有 ${hiddenCount} 条）`;
	notice.addEventListener('click', () => {
		const prevHeight = box.scrollHeight;
		visibleMessageCount += MOBILE_MESSAGE_LOAD_MORE_STEP;
		renderMessages(getCachedMessages(currentSessionId));
		const nextHeight = box.scrollHeight;
		box.scrollTop += nextHeight - prevHeight;
	});
	box.prepend(notice);
}

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

function restoreFocusState(container, state) {
    const el = container.querySelector(state.selector);
    if (!el) return;
    try { el.focus(); } catch (_) {}
    try {
        if (typeof state.start === 'number') el.selectionStart = state.start;
        if (typeof state.end === 'number') el.selectionEnd = state.end;
    } catch (_) {}
}

function renderMessages(items) {
    const box = document.getElementById('ocMessages');
    const sourceList = (items || []).map(normalizeMessageItem).filter(item => !isInternalUserMessage(item));
    const list = trimMessagesForMobile(sourceList);

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
        box.appendChild(node);
    });

    updateModelInfo(items);
    restoreScroll(box, scrollState, false);
    updateScrollBottomButton();
    renderTodos();
    if (isMobileTreeMode()) {
		renderCollapsedHistoryNotice(sourceList.length, sourceList.length - list.length);
	}
}

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

// 确保 <select> 中存在指定 value 的选项（API 加载失败时的降级）
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

function smartScroll(box, force) {
    const scrollState = captureScrollState(box);
    restoreScroll(box, scrollState, force);
    updateScrollBottomButton();
}

function captureScrollState(box) {
    const distanceToBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
    return {
        top: box.scrollTop,
        height: box.scrollHeight,
        nearBottom: distanceToBottom < 120,
    };
}

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

function updateScrollBottomButton() {
    const box = document.getElementById('ocMessages');
    const btn = document.getElementById('btnScrollBottom');
    if (!box || !btn) return;
    const canScroll = box.scrollHeight > box.clientHeight + 8;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    btn.classList.toggle('visible', canScroll && !nearBottom);
}

function scrollMessagesToBottom() {
    const box = document.getElementById('ocMessages');
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

function isSessionBusy(id) {
    const status = sessionStatuses[id];
    return status === 'busy' || status?.type === 'busy' || status?.type === 'retry' || status?.status === 'busy';
}

function hasSessionError(id) {
    return !!sessionErrors[id];
}

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

function partExpandKey(part, fallback) {
    return part?.id || `${part?.type || 'part'}:${part?.messageID || ''}:${fallback || ''}`;
}

function renderStepDivider(part, phase) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-step-divider';
    if (phase === 'finish' && part.tokens) {
        const t = part.tokens;
        const total = t.total || (t.input || 0) + (t.output || 0) + (t.reasoning || 0);
        el.innerHTML = `<span class="oc-step-label">步骤结束</span><span class="oc-step-cost">↥${t.input||0} ↧${t.output||0} 🧠${t.reasoning||0} ≈${total} tokens</span>`;
    } else {
        el.innerHTML = '<span class="oc-step-label">步骤开始</span>';
    }
    return el;
}

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
        ? marked.parse(part.text || '', { breaks: true })
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

function renderQuestionTool(part) {
    const state = part.state || {};
    const status = state.status || '';
    const isRunning = status === 'running' || (!status);
    const isCompleted = status === 'completed';
    const isDismissed = status === 'error' && (state.error || '').includes('dismissed');
    const isError = status === 'error' && !isDismissed;
    const questions = (state.input && state.input.questions) || [];
    const output = state.output;

    const el = document.createElement('div');
    el.className = `oc-part oc-tool oc-tool-question` + (isCompleted ? ' done' : '') + (isDismissed ? ' dismissed' : '') + (isError ? ' error' : '') + (isRunning ? ' running' : '');

    // head
    const head = document.createElement('div');
    head.className = 'oc-tool-head';
    let statusText, statusClass;
    if (isCompleted) { statusText = '✓ 已回答'; statusClass = 'ok'; }
    else if (isDismissed) { statusText = '↩ 已跳过'; statusClass = 'skipped'; }
    else if (isError) { statusText = '✗ 失败'; statusClass = 'err'; }
    else { statusText = '⏳ 等待回答'; statusClass = 'running'; }
    head.innerHTML = `<span class="oc-tool-icon">❓</span> 提问 <span class="oc-tool-status ${statusClass}">${statusText}</span>`;

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

        // 已回答
        if (isCompleted && output) {
            const answerDiv = document.createElement('div');
            answerDiv.className = 'oc-question-answer';
            answerDiv.innerHTML = `<span class="oc-question-answer-label">✅ 已选：</span>${escapeHtml(safeText(output))}`;
            qBlock.appendChild(answerDiv);
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
                let btnHtml = `<span class="oc-option-label">${escapeHtml(label)}</span>`;
                if (desc) btnHtml += `<span class="oc-option-desc">${escapeHtml(desc)}</span>`;
                btn.innerHTML = btnHtml;
                btn.addEventListener('click', () => {
                    answerQuestion(label);
                });
                optsDiv.appendChild(btn);
            });
            qBlock.appendChild(optsDiv);

            // 自定义输入
            const customRow = document.createElement('div');
            customRow.className = 'oc-question-custom';
            const customInput = document.createElement('input');
            customInput.className = 'oc-question-custom-input';
            customInput.placeholder = '✏️ 输入自定义回答...';
            customInput.value = questionCustomInput || '';
            customInput.addEventListener('input', () => {
                questionCustomInput = customInput.value;
            });
            const customBtn = document.createElement('button');
            customBtn.className = 'oc-question-custom-btn';
            customBtn.textContent = '发送';
            const doCustomAnswer = () => {
                const val = customInput.value.trim();
                if (!val) return;
                questionCustomInput = '';
                answerQuestion(val);
            };
            customBtn.addEventListener('click', doCustomAnswer);
            customInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); doCustomAnswer(); }
            });
            customRow.appendChild(customInput);
            customRow.appendChild(customBtn);
            qBlock.appendChild(customRow);

            // 跳过按钮
            const skipRow = document.createElement('div');
            skipRow.className = 'oc-question-skip-row';
            const skipBtn = document.createElement('button');
            skipBtn.className = 'oc-question-skip-btn';
            skipBtn.textContent = '↩ 跳过此问题';
            skipBtn.addEventListener('click', async () => {
                questionCustomInput = '';
                skipBtn.disabled = true;
                skipBtn.textContent = '跳过中...';
                try {
                    const result = await api.RejectQuestion(currentSessionId);
                    if (result && result.success) {
                        showToast('已跳过问题', 'info');
                    } else {
                        showToast('操作失败: ' + ((result && result.error) || '未知错误'), 'error');
                        skipBtn.disabled = false;
                        skipBtn.textContent = '↩ 跳过此问题';
                    }
                } catch (e) {
                    showToast('操作失败: ' + (e.message || e), 'error');
                    skipBtn.disabled = false;
                    skipBtn.textContent = '↩ 跳过此问题';
                }
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

async function answerQuestion(answerText) {
    if (!currentSessionId) return;
    questionCustomInput = '';
    const input = document.getElementById('ocPrompt');
    try {
        const result = await api.AnswerQuestion(currentSessionId, answerText);
        if (result && result.success) {
            showToast('已回答: ' + answerText, 'success');
            if (input) input.value = '';
            // SSE 事件会自动推送模型响应，无需手动 loadMessages
        } else {
            showToast('回答失败: ' + ((result && result.error) || '未知错误'), 'error');
            if (input) { input.value = answerText; input.focus(); }
        }
    } catch (e) {
        showToast('回答失败: ' + (e.message || e), 'error');
        if (input) { input.value = answerText; input.focus(); }
    }
}

function renderTextPart(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-text';
    const text = (part && (part.text || part.content || part.message || part.value)) || '';
    el.innerHTML = typeof marked !== 'undefined'
        ? marked.parse(text || '', { breaks: true })
        : `<pre>${escapeHtml(text || '')}</pre>`;
    return el;
}

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

function renderAgentPart(part, type) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-agent';
    const label = type === 'agent' ? '🤖 代理' : '📋 子任务';
    el.innerHTML = `<div class="oc-agent-head">${label}: ${escapeHtml(part.name || part.agent || type)}</div><pre>${escapeHtml(safeText(part))}</pre>`;
    return el;
}

function renderCompaction(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-compaction';
    const auto = part.auto;
    el.innerHTML = auto
        ? '🗜️ 自动压缩上下文'
        : '🗜️ 上下文已压缩';
    return el;
}

function renderSnapshot(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-snapshot';
    const hash = (part.snapshot || '').slice(0, 7);
    el.innerHTML = hash
        ? `<span class="oc-snapshot-icon">📸</span> 文件快照 <span class="oc-snapshot-hash">${escapeHtml(hash)}</span>`
        : '<span class="oc-snapshot-icon">📸</span> 文件快照';
    return el;
}

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

function renderFallback(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-fallback';
    const pre = document.createElement('pre');
    pre.textContent = extractPartText(part) || safeText(part);
    el.appendChild(pre);
    return el;
}

// ============================
// Diff 渲染
// ============================

async function loadDiff() {
    const box = document.getElementById('ocDiff');
    if (!currentSessionId || !webRunning) {
        box.innerHTML = '<div class="oc-empty">选择会话后查看变更</div>';
        return;
    }
    try {
        const diff = await ocApi('GET', `/session/${encodeURIComponent(currentSessionId)}/diff`);
        renderDiff(diff || []);
    } catch (e) {
        box.innerHTML = `<div class="oc-empty error">${escapeHtml(e.message || e)}</div>`;
    }
}

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

function buildFileTree(files) {
    const root = { name: '', isDir: true, children: {} };
    files.forEach(file => {
        const path = (file.file || file.path || file.name || 'unknown').replace(/^\.\//, '');
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
                icon.textContent = icon.classList.contains('expanded') ? '▼' : '▶';
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

function renderPermissions() {
    // 面板已改为服务状态，保留空实现避免引用报错
}

async function respondPermission(permission, reply) {
    const id = permission.id || permission.permissionID || permission.permissionId;
    const sessionID = permission.sessionID || permission.sessionId || currentSessionId;
    if (!id) return;
    try {
        try {
            await ocApi('POST', `/permission/${encodeURIComponent(id)}/reply`, { reply });
        } catch {
            if (!sessionID) throw new Error('缺少会话编号，无法兼容旧权限接口');
            await ocApi('POST', `/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(id)}`, { response: reply, remember: reply === 'always' });
        }
        showToast('权限已响应', 'success');
    } catch (e) {
        showToast('权限响应失败: ' + (e.message || e), 'error');
    }
}

// ============================
// 服务状态
// ============================

async function loadServiceStatus() {
    const config = getNetworkConfig();
    try {
        const [web, mcp, lsp] = await Promise.all([
            api.GetWebStatus(config.serviceHost, parseInt(config.servicePort) || 4096).catch(() => null),
            webRunning ? ocApi('GET', '/mcp').catch(() => null) : Promise.resolve(null),
            webRunning ? ocApi('GET', '/lsp').catch(() => null) : Promise.resolve(null),
        ]);
        if (web) {
            webRunning = !!web.running;
            webURL = web.url || '';
        }
        serverStatus = normalizeServerStatus(web);
        mcpStatus = mcp;
        lspStatus = lsp;
        updateWebUI();
        renderServiceStatus();
    } catch (e) {
        serverStatus = normalizeServerStatus(null);
        mcpStatus = null;
        lspStatus = null;
        renderServiceStatus();
    }
}

function normalizeServerStatus(status) {
    const config = getNetworkConfig();
    const fallbackURL = `http://${config.serviceHost || '127.0.0.1'}:${config.servicePort || '4096'}`;
    if (!status) {
        return { url: webURL || fallbackURL, health: webRunning ? '未知' : '离线', version: '' };
    }
    const running = !!status.running;
    return {
        url: status.url || webURL || fallbackURL,
        health: status.health || (running ? '未知' : '离线'),
        version: status.version || '',
    };
}

function serviceHealthClass(health) {
    if (health === '在线') return 'on';
    if (health === '异常') return 'warn';
    return 'off';
}

function renderServiceStatus() {
    const box = document.getElementById('ocServices');
    box.innerHTML = '';

    // ── 服务器 — 始终展开 ──
    const health = serverStatus.health || (webRunning ? '未知' : '离线');
    const url = serverStatus.url || '--';
    const version = serverStatus.version || '--';
    const serverSec = document.createElement('div');
    serverSec.className = 'oc-service-group';
    serverSec.innerHTML =
        '<div class="oc-service-group-title">' +
            '<span class="oc-service-dot ' + serviceHealthClass(health) + '"></span>' +
            '服务器' +
        '</div>' +
        '<div class="oc-service-card">' +
            '<div class="oc-service-item"><span class="oc-service-dot ' + serviceHealthClass(health) + '"></span>健康状态 <span class="oc-service-state">' + escapeHtml(health) + '</span></div>' +
            '<div class="oc-service-field"><span>URL</span><code title="' + escapeHtml(url) + '">' + escapeHtml(url) + '</code></div>' +
            '<div class="oc-service-field"><span>版本</span><code>' + escapeHtml(version) + '</code></div>' +
        '</div>';
    box.appendChild(serverSec);

    // ── MCP 服务 — 点击展开/折叠 ──
    if (mcpStatus) {
        const entries = typeof mcpStatus === 'object' ? Object.entries(mcpStatus) : [];
        const anyRunning = entries.some(([, info]) => info?.status === 'connected' || info?.connected || info?.running);
        const anyFailed = entries.some(([, info]) => info?.status === 'error');
        const dotClass = entries.length === 0 ? 'off' : (anyFailed ? 'off' : (anyRunning ? 'on' : 'off'));
        const collapsed = entries.length > 0 ? ' collapsed' : '';

        const sec = document.createElement('div');
        sec.className = 'oc-service-group' + collapsed;
        sec.innerHTML = '<div class="oc-service-group-title clickable">' +
            '<span class="oc-service-dot ' + dotClass + '"></span>MCP 服务' +
        '</div>';
        if (entries.length === 0) {
            sec.innerHTML += '<div class="oc-service-body"><div class="oc-service-item"><span class="oc-service-dot off"></span>无已配置的 MCP 服务</div></div>';
        } else {
            let body = '<div class="oc-service-body">';
            entries.forEach(([name, info]) => {
                const running = info?.status === 'connected' || info?.connected || info?.running;
                body += '<div class="oc-service-item"><span class="oc-service-dot ' + (running ? 'on' : 'off') + '"></span>' + escapeHtml(name) + ' <span class="oc-service-state">' + (running ? '已连接' : '未连接') + '</span></div>';
            });
            body += '</div>';
            sec.innerHTML += body;
        }
        sec.querySelector('.oc-service-group-title.clickable').addEventListener('click', function() {
            sec.classList.toggle('collapsed');
        });
        box.appendChild(sec);
    }

    // ── LSP 服务 — 点击展开/折叠 ──
    if (lspStatus) {
        const entries = Array.isArray(lspStatus) ? lspStatus : Object.values(lspStatus || {});
        const anyRunning = entries.some(info => info?.status === 'connected' || info?.status === 'running' || info?.running || info?.connected);
        const anyFailed = entries.some(info => info?.status === 'error');
        const dotClass = entries.length === 0 ? 'off' : (anyFailed ? 'off' : (anyRunning ? 'on' : 'off'));
        //const collapsed = entries.length > 0 ? ' collapsed' : '';
        const collapsed = ' collapsed';

        const sec = document.createElement('div');
        sec.className = 'oc-service-group' + collapsed;
        sec.innerHTML = '<div class="oc-service-group-title clickable">' +
            '<span class="oc-service-dot ' + dotClass + '"></span>LSP 服务' +
        '</div>';
        if (entries.length === 0) {
            sec.innerHTML += '<div class="oc-service-body"><div class="oc-service-item"><span class="oc-service-dot off"></span>已从文件类型自动检测 LSP，打开代码文件后会启动匹配的服务</div></div>';
        } else {
            let body = '<div class="oc-service-body">';
            entries.forEach(info => {
                const name = info?.name || info?.server || info?.language || '?';
                const status = info?.status || '';
                const running = status === 'connected' || status === 'running' || info?.running || info?.connected;
                const failed = status === 'error';
                const stateText = failed ? '异常' : (running ? '已连接' : '未启动');
                body += '<div class="oc-service-item"><span class="oc-service-dot ' + (running ? 'on' : 'off') + '"></span>' + escapeHtml(name) + ' <span class="oc-service-state">' + stateText + '</span></div>';
            });
            body += '</div>';
            sec.innerHTML += body;
        }
        sec.querySelector('.oc-service-group-title.clickable').addEventListener('click', function() {
            sec.classList.toggle('collapsed');
        });
        box.appendChild(sec);
    }
}

// ============================
// 附件管理
// ============================

function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
    });
}

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

function removeAttachment(index) {
    attachedFiles.splice(index, 1);
    renderAttachedFiles();
}

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

function clearAttachments() {
    attachedFiles = [];
    renderAttachedFiles();
}

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
// 发送消息
// ============================

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

function scheduleRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
        if (webRunning && currentSessionId) {
            const wasBusy = isSessionBusy(currentSessionId);
            loadSessionStatuses().then(statuses => {
                const nextStatuses = statuses || {};
                if (currentSessionId && isSessionBusy(currentSessionId) && !nextStatuses[currentSessionId]) {
                    nextStatuses[currentSessionId] = sessionStatuses[currentSessionId];
                }
                sessionStatuses = nextStatuses;
                updateSendButton();
                const busy = isSessionBusy(currentSessionId);
                if (busy || wasBusy) {
                    loadMessages();
                }
                if (!busy) {
                    clearInterval(refreshTimer);
                    refreshTimer = null;
                }
            });
            if (wasBusy) loadDiff();
        }
    }, 4000);
}

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
// Web 控制
// ============================

async function startWeb() {
    const config = getNetworkConfig();
    const port = parseInt(config.servicePort) || 4096;
    const hostname = config.serviceHost || '127.0.0.1';
    const btn = document.getElementById('btnStartWeb');
    btn.disabled = true;
    btn.textContent = '⏳ 启动中...';
    try {
        const result = await api.StartOpenCodeWeb(port, hostname, getNetworkConfig());
        if (result.running) {
            webRunning = true;
            webURL = result.url || `http://${hostname}:${port}`;
            serverStatus = normalizeServerStatus(result);
            updateWebUI();
            btn.textContent = '▶ 启动 opencode';
            startEventStream();
            var treeLoaded = await buildTree();
            if (!treeLoaded) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                await buildTree();
            }
            loadServiceStatus();
            loadAgentModelSelectors();
            showToast('OpenCode Web 已启动', 'success');
        } else if (result.error) {
            showToast('启动失败: ' + result.error, 'error');
            btn.disabled = false;
            btn.textContent = '▶ 启动 opencode';
        }
    } catch (e) {
        showToast('启动失败: ' + (e.message || e), 'error');
        btn.disabled = false;
        btn.textContent = '▶ 启动 opencode';
    }
}

async function stopWeb() {
    const btn = document.getElementById('btnStopWeb');
    btn.disabled = true;
    btn.textContent = '⏳ 停止中...';
    try {
        await api.StopOpenCodeWeb();
        if (api.StopOpenCodeEvents) await api.StopOpenCodeEvents();
        webRunning = false;
        webURL = '';
        currentSessionId = '';
        sessions = [];
        sessionStatuses = {};
        sessionErrors = {};
        messageCache = {};
        expandedParts = {};
        markdownCache = {};
        subtaskSummaries = [];
        detailMessageCache = {};
        detailLoading = {};
        detailExpandedParts = {};
        serverStatus = normalizeServerStatus(null);
        mcpStatus = null;
        lspStatus = null;
        clearInterval(refreshTimer);
        clearTimeout(sessionRefreshTimer);
        updateWebUI();
        btn.textContent = '■ 停止';
        clearClientUI();
        document.getElementById('ocTree').innerHTML = '<div class="oc-empty">启动服务后加载项目树</div>';
        showToast('已停止', 'info');
    } catch (e) {
        showToast('停止失败: ' + (e.message || e), 'error');
        btn.disabled = false;
        btn.textContent = '■ 停止';
    }
}

async function launchTerminal() {
    try {
        const dir = await api.OpenDirectoryDialog();
        if (!dir) return;
        const result = await api.LaunchWindowsTerminal('attach', webURL, dir);
        if (!result.success && result.error) {
            showToast('启动失败: ' + result.error, 'error');
        }
    } catch (e) {
        showToast('启动终端失败: ' + (e.message || e), 'error');
    }
}

function clearClientUI() {
    document.getElementById('ocTree').innerHTML = '<div class="oc-empty">启动服务后加载项目树</div>';
    document.getElementById('ocChatTitle').textContent = '未选择会话';
    document.getElementById('ocMessages').innerHTML = '<div class="oc-empty">选择会话后查看消息，或输入内容创建新会话</div>';
    document.getElementById('ocSubtasks').innerHTML = '<div class="oc-empty">当前会话暂无子任务</div>';
    document.getElementById('ocTodos').innerHTML = '<div class="oc-empty">当前会话暂无代办</div>';
    renderServiceStatus();
    document.getElementById('ocDiff').innerHTML = '<div class="oc-empty">选择会话后查看变更</div>';
    document.getElementById('ocPrompt').value = '';
    updateModelInfo(null);
}

function updateWebUI() {
    const btnStart = document.getElementById('btnStartWeb');
    const btnStop = document.getElementById('btnStopWeb');
    const btnProxy = document.getElementById('btnProxySettings');
    const btnWt = document.getElementById('btnWtOpen');
    const btnRefresh = document.getElementById('btnRefreshTree');
    const btnNewSession = document.getElementById('btnNewSession');
    const btnSend = document.getElementById('btnSendPrompt');
    const btnDiff = document.getElementById('btnLoadDiff');
    const btnRefreshStatus = document.getElementById('btnRefreshStatus');
    const prompt = document.getElementById('ocPrompt');
    const btnAttach = document.getElementById('btnAttachFile');
    const btnFrontendWeb = document.getElementById('btnFrontendWebConfig');
    const btnFrontendWebDot = document.getElementById('frontendWebToolbarDot');

    if (webRunning) {
        btnStart.disabled = true;
        btnStop.disabled = false;
        btnWt.disabled = false;
        btnRefresh.disabled = false;
        btnNewSession.disabled = false;
        btnSend.disabled = false;
        btnDiff.disabled = false;
        btnRefreshStatus.disabled = false;
        prompt.disabled = false;
        btnAttach.disabled = false;
    } else {
        btnStart.disabled = false;
        btnStop.disabled = true;
        btnWt.disabled = true;
        btnRefresh.disabled = true;
        btnNewSession.disabled = true;
        btnSend.disabled = true;
        btnDiff.disabled = true;
        btnRefreshStatus.disabled = true;
        prompt.disabled = true;
        btnAttach.disabled = true;
    }
    if (btnFrontendWeb && btnFrontendWebDot) {
        btnFrontendWebDot.classList.toggle('on', frontendWebRunning);
        btnFrontendWebDot.classList.toggle('off', !frontendWebRunning);
    }
}

async function openDirBrowserModal() {
	dirBrowserCurrentPath = '';
	document.getElementById('dirBrowserModal').style.display = 'flex';
	await loadDirBrowserList('');
}

function closeDirBrowserModal() {
	document.getElementById('dirBrowserModal').style.display = 'none';
}

async function loadDirBrowserList(path) {
	dirBrowserCurrentPath = path || '';
	document.getElementById('dirBrowserPath').textContent = dirBrowserCurrentPath || '根目录';
	const list = document.getElementById('dirBrowserList');
	list.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在读取目录...</p></div>';
	try {
		const dirs = await api.ListBrowsableDirs(path || '');
		if (!dirs || !dirs.length) {
			list.innerHTML = '<div class="oc-empty">当前层没有可进入的目录</div>';
			return;
		}
		list.innerHTML = dirs.map(dir => '<button type="button" class="btn btn-sm skill-file-dir-toggle" data-path="' + escapeHtml(dir.path) + '" style="margin:4px 0;width:100%;">📁 ' + escapeHtml(dir.name) + '</button>').join('');
		list.querySelectorAll('[data-path]').forEach(btn => {
			btn.addEventListener('click', async () => {
				await loadDirBrowserList(btn.dataset.path || '');
			});
		});
	} catch (e) {
		list.innerHTML = '<div class="oc-empty">读取目录失败</div>';
		showToast('读取目录失败: ' + (e.message || e), 'error');
	}
}

async function selectDirBrowserCurrent() {
	if (!dirBrowserCurrentPath) {
		showToast('请先进入目标目录', 'warning');
		return;
	}
	rememberKnownDir(dirBrowserCurrentPath);
	closeDirBrowserModal();
	const ok = await buildTree();
	if (!ok || !treeHasSessionsForDir(window._lastProjectTree, dirBrowserCurrentPath)) {
		document.getElementById('ocChatTitle').textContent = '工作目录 @ ' + dirBrowserCurrentPath;
		document.getElementById('ocMessages').innerHTML = '<div class="oc-empty">该目录下没有会话记录，请先在该目录下新建会话</div>';
		showToast('该目录下没有会话记录，请先在该目录下新建会话', 'warning');
		return;
	}
	showToast('已加载目录会话: ' + dirBrowserCurrentPath, 'success');
}

async function goDirBrowserUp() {
	if (!dirBrowserCurrentPath) return;
	const current = String(dirBrowserCurrentPath).replace(/[\\/]+$/, '');
	const parent = current.replace(/[\\/][^\\/]+$/, '');
	if (!parent || parent === current) {
		await loadDirBrowserList('');
		return;
	}
    await loadDirBrowserList(parent);
}

function isMobileTreeMode() {
    return window.matchMedia('(max-width: 800px)').matches;
}

function openMobileTree() {
    if (!isMobileTreeMode()) return;
    document.getElementById('webContainer').classList.add('mobile-tree-open');
}

function closeMobileTree() {
    document.getElementById('webContainer').classList.remove('mobile-tree-open');
}

function toggleMobileTree() {
    if (!isMobileTreeMode()) return;
    const client = document.getElementById('webContainer');
    if (client.classList.contains('mobile-tree-open')) {
        closeMobileTree();
        return;
    }
    openMobileTree();
}

function toggleSessions() {
    if (isMobileTreeMode()) {
        toggleMobileTree();
        return;
    }
    const client = document.getElementById('webContainer');
    const btn = document.getElementById('btnToggleSessions');
    const hidden = client.classList.toggle('hide-left');
    btn.textContent = hidden ? '▶' : '◀';
    btn.title = hidden ? '显示会话栏' : '隐藏会话栏';
}

function toggleSidepanel() {
    if (isMobileTreeMode()) return;
    const client = document.getElementById('webContainer');
    const btn = document.getElementById('btnToggleSidepanel');
    const hidden = client.classList.toggle('hide-right');
    btn.textContent = hidden ? '◀' : '▶';
    btn.title = hidden ? '显示信息栏' : '隐藏信息栏';
}

// ========== 消息搜索 ==========
var searchResults = [];
var searchIndex = -1;
let searchTemporaryExpansion = null;

function initSearch() {
    document.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.key === 'f') {
            e.preventDefault();
            var bar = document.getElementById('ocSearchBar');
            if (bar) {
                bar.style.display = 'flex';
                var input = document.getElementById('ocSearchInput');
                if (input) { input.focus(); input.select(); }
            }
        }
        if (e.key === 'Escape') { closeSearch(); }
    });

    var searchInput = document.getElementById('ocSearchInput');
    if (searchInput) {
        var searchTimer;
        searchInput.addEventListener('input', function() {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(function() { doSearch(searchInput.value); }, 200);
        });
    }

    var closeBtn = document.getElementById('ocSearchClose');
    if (closeBtn) closeBtn.addEventListener('click', closeSearch);

    var prevBtn = document.getElementById('ocSearchPrev');
    if (prevBtn) prevBtn.addEventListener('click', function() { navigateSearch(-1); });

    var nextBtn = document.getElementById('ocSearchNext');
    if (nextBtn) nextBtn.addEventListener('click', function() { navigateSearch(1); });
}

function doSearch(query) {
    restoreSearchTemporaryExpansion();
    clearHighlights();
    searchResults = [];
    searchIndex = -1;
    var countEl = document.getElementById('ocSearchCount');
    var prevBtn = document.getElementById('ocSearchPrev');
    var nextBtn = document.getElementById('ocSearchNext');
    if (countEl) countEl.textContent = '';
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    if (!query || query.length < 2) return;

    var msgContainer = document.getElementById('ocMessages');
    if (!msgContainer) return;

    var walker = document.createTreeWalker(msgContainer, NodeFilter.SHOW_TEXT, null, false);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    var lowerQuery = query.toLowerCase();
    for (var n = 0; n < nodes.length; n++) {
        var text = nodes[n].textContent.toLowerCase();
        var idx = text.indexOf(lowerQuery);
        if (idx >= 0) {
            var parent = nodes[n].parentElement;
            if (parent) {
                try {
                    var range = document.createRange();
                    range.setStart(nodes[n], idx);
                    range.setEnd(nodes[n], idx + query.length);
                    var mark = document.createElement('mark');
                    mark.className = 'oc-search-highlight';
                    range.surroundContents(mark);
                    searchResults.push(mark);
                } catch (_) {}
            }
        }
    }

    if (searchResults.length > 0) {
        if (countEl) countEl.textContent = '1/' + searchResults.length;
        if (prevBtn) prevBtn.disabled = false;
        if (nextBtn) nextBtn.disabled = false;
        navigateSearch(1);
    } else {
        if (countEl) countEl.textContent = '无匹配';
    }
}

function navigateSearch(dir) {
    for (var i = 0; i < searchResults.length; i++) {
        searchResults[i].classList.remove('oc-search-active');
    }
    restoreSearchTemporaryExpansion();
    searchIndex = (searchIndex + dir + searchResults.length) % searchResults.length;
    var current = searchResults[searchIndex];
    current.classList.add('oc-search-active');
    temporarilyRevealSearchResult(current);
    var container = document.getElementById('ocMessages');
    if (container) {
        scrollSearchResultIntoView(current, container);
    }
    var countEl = document.getElementById('ocSearchCount');
    if (countEl) countEl.textContent = (searchIndex + 1) + '/' + searchResults.length;
}

function scrollSearchResultIntoView(node, container) {
    var targetTop = getSearchAnchorTop(node, container);
    var targetScroll = targetTop - container.clientHeight / 3;
    var maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTo({
        top: Math.max(0, Math.min(maxScroll, targetScroll)),
        behavior: 'smooth'
    });
}

function getSearchAnchorTop(node, container) {
    var anchor = node.closest('.oc-part') || node.closest('.oc-message') || node;
    var top = 0;
    var el = anchor;
    while (el && el !== container) {
        top += el.offsetTop || 0;
        el = el.offsetParent;
    }
    if (el === container) return top;
    return anchor.offsetTop || 0;
}

function temporarilyRevealSearchResult(node) {
    var hiddenAncestor = node.closest('.hidden');
    if (!hiddenAncestor) return;
    var targetPart = node.closest('.oc-part');
    hiddenAncestor.classList.remove('hidden');
    hiddenAncestor.classList.add('oc-search-temp-expanded');
    if (targetPart) targetPart.classList.add('oc-search-target-part');
    searchTemporaryExpansion = {
        body: hiddenAncestor,
        targetPart: targetPart,
    };
}

function restoreSearchTemporaryExpansion() {
    if (!searchTemporaryExpansion) return;
    var body = searchTemporaryExpansion.body;
    if (body && body.classList && body.classList.contains('oc-search-temp-expanded')) {
        if (!shouldKeepTemporaryExpansionVisible(body)) {
            body.classList.add('hidden');
        }
        body.classList.remove('oc-search-temp-expanded');
    }
    var targetPart = searchTemporaryExpansion.targetPart;
    if (targetPart && targetPart.classList) {
        targetPart.classList.remove('oc-search-target-part');
    }
    searchTemporaryExpansion = null;
}

function shouldKeepTemporaryExpansionVisible(body) {
    var key = body.dataset ? body.dataset.expandKey : '';
    if (!key) return false;
    if (Object.prototype.hasOwnProperty.call(expandedParts, key)) {
        return !!expandedParts[key];
    }
    return body.dataset.defaultExpanded === 'true';
}

function clearHighlights() {
    var marks = document.querySelectorAll('.oc-search-highlight');
    for (var m = marks.length - 1; m >= 0; m--) {
        var parent = marks[m].parentNode;
        while (marks[m].firstChild) parent.insertBefore(marks[m].firstChild, marks[m]);
        parent.removeChild(marks[m]);
    }
}

function closeSearch() {
    restoreSearchTemporaryExpansion();
    clearHighlights();
    var bar = document.getElementById('ocSearchBar');
    if (bar) bar.style.display = 'none';
    var input = document.getElementById('ocSearchInput');
    if (input) input.value = '';
    searchResults = [];
}

// ============================================================
// 子任务面板 — 摘要提取、渲染、详情弹窗
// ============================================================

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

// ── 格式化函数 ──
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

function formatTime(ts) {
    if (ts == null) return '—';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// ── 右侧面板渲染 ──
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

function attachSubtaskCardEvents() {
    const box = document.getElementById('ocSubtasks');
    if (!box) return;
    box.removeEventListener('click', onSubtaskCardClick);
    box.addEventListener('click', onSubtaskCardClick);
}

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

function locateParentMessage(msgId) {
    const box = document.getElementById('ocMessages');
    if (!box) return;
    // 清除旧高亮
    const old = box.querySelectorAll('.oc-message.highlight');
    old.forEach(el => el.classList.remove('highlight'));
    // 通过 data-message-id 属性查找
    let target = box.querySelector('.oc-message[data-message-id="' + msgId + '"]');
    // 回退：遍历查找包含该消息 ID 的容器
    if (!target) {
        const allMsgs = box.querySelectorAll('.oc-message');
        for (let i = allMsgs.length - 1; i >= 0; i--) {
            // 通过 part data-part-id 反向匹配
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

// ── 详情弹窗 ──
function openSubtaskModal(childSessionId, subtaskSummary) {
    const modal = document.getElementById('subtaskModal');
    if (!modal) return;
    // 填充摘要
    if (subtaskSummary) fillModalSummary(subtaskSummary);
   
    // 显示加载态
    const msgBox = document.getElementById('subtaskMessages');
    if (msgBox) msgBox.innerHTML = '<div class="oc-loading" style="padding:40px;text-align:center"><div class="spinner"></div><p>正在加载子任务详情...</p></div>';
   
    modal.style.display = 'flex';
    loadSubtaskDetailMessages(childSessionId);
    bindSubtaskModalEvents();
}

function closeSubtaskModal() {
    const modal = document.getElementById('subtaskModal');
    if (modal) modal.style.display = 'none';
    if (document.activeElement && document.activeElement.closest('#subtaskModal')) {
        const promptEl = document.getElementById('ocPrompt');
        if (promptEl) promptEl.focus();
    }
}

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

function onSubtaskModalKey(e) {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('subtaskModal');
    if (modal && modal.style.display === 'flex') closeSubtaskModal();
}

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

    // 状态徽章
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

async function loadSubtaskDetailMessages(childSessionId) {
    if (!childSessionId) return;
    if (detailLoading[childSessionId]) return;
    detailLoading[childSessionId] = true;
    const msgBox = document.getElementById('subtaskMessages');
    const thisSeq = ++detailMessageLoadSeq;

    try {
        const data = await ocApi('GET', '/session/' + encodeURIComponent(childSessionId) + '/message');
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

function renderDetailPart(part) {
    const type = part?.type || '';
    // 复用 renderPart，但在只读上下文中渲染（question 工具不显示交互按钮）
    if (type === 'tool' && (part.tool === 'question' || part.name === 'question')) {
        // 对 question 工具，使用标记跳过交互渲染
        const saved = part.state ? { ...part.state } : null;
        if (part.state) part.state._readOnly = true;
        const el = renderPart(part);
        if (saved) part.state = saved;
        return el;
    }
    return renderPart(part);
}
