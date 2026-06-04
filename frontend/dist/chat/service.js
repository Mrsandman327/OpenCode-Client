// ============================================================
// chat-service.js — 服务管理 & API 工具
// 依赖：core/state.js、chat/config.js（getNetworkConfig）、core/utils.js（showToast, escapeHtml）、core/webcall.js（api）
// ============================================================

// ============================
// Web 状态检测
// ============================

/** 检测 OpenCode 服务运行状态 */
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
    setTimeout(function() { initSearch(); initUserNav(); }, 500);
}

// ============================
// API 工具
// ============================

/** 安全转文本（处理 null/undefined/对象） */
function safeText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
}

/** 从 part 对象中提取文本内容 */
function extractPartText(part) {
    if (!part) return '';
    return part.text || part.content || part.message || part.value || safeText(part);
}

/** 从消息项中提取纯文本 */
function messageText(item) {
    const parts = item?.parts || item?.info?.parts || [];
    const list = Array.isArray(parts) ? parts : [parts];
    return list.map(part => extractPartText(part)).join('\n').trim();
}

/** 判断消息是否为内部 user 消息（应过滤） */
function isInternalUserMessage(item) {
    const info = item?.info || item || {};
    const role = info.role || info.author || '';
    if (role !== 'user') return false;
    const parts = item?.parts;
    if (!parts || (Array.isArray(parts) && parts.length === 0)) return true;
    const text = messageText(item);
    return text.includes('OMO_INTERNAL_INITIATOR')
        || text.includes('<system-reminder>')
        || text.includes('</system-reminder>')
        || /^\s*\[(?:BACKGROUND TASK COMPLETED|ALL BACKGROUND TASKS COMPLETE)\]/.test(text)
        || (text.includes('background_output(') && text.includes('task_id='));
}

/** 标准化消息项（确保 info 和 parts 结构一致） */
function normalizeMessageItem(item) {
    const info = item.info || item;
    const parts = item.parts || info.parts || [];
    return {
        info,
        parts: Array.isArray(parts) ? parts : [parts],
    };
}

/** 响应权限请求（批准/拒绝/始终允许） */
// async function respondPermission(permission, reply) {
//     const id = permission.id || permission.permissionID || permission.permissionId;
//     const sessionID = permission.sessionID || permission.sessionId || currentSessionId;
//     if (!id) return;
//     try {
//         try {
//             await api.OpenCodeCall('POST', `/permission/${encodeURIComponent(id)}/reply`, { reply });
//         } catch {
//             if (!sessionID) throw new Error('缺少会话编号，无法兼容旧权限接口');
//             await api.OpenCodeCall('POST', `/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(id)}`, { response: reply, remember: reply === 'always' });
//         }
//         showToast('权限已响应', 'success');
//     } catch (e) {
//         showToast('权限响应失败: ' + (e.message || e), 'error');
//     }
// }

// ============================
// 服务状态
// ============================

/** 加载服务健康状态（Server / MCP / LSP） */
async function loadServiceStatus() {
    const config = getNetworkConfig();
    try {
        const [web, mcp, lsp] = await Promise.all([
            api.GetWebStatus(config.serviceHost, parseInt(config.servicePort) || 4096).catch(() => null),
            webRunning ? api.OpenCodeCall('GET', '/mcp').catch(() => null) : Promise.resolve(null),
            webRunning ? api.OpenCodeCall('GET', '/lsp').catch(() => null) : Promise.resolve(null),
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

/** 将服务器状态对象标准化为统一格式 */
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

/** 返回服务健康状态对应的 CSS 类名 */
function serviceHealthClass(health) {
    if (health === '在线') return 'on';
    if (health === '异常') return 'warn';
    return 'off';
}

/** 渲染服务状态面板（包含 Server / MCP / LSP 三栏） */
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
            '<div class="oc-service-field"><span>版本</span><code>' + escapeHtml(version) + '</code><span class="oc-version-check" id="ocVersionCheck"></span></div>' +
        '</div>';
    box.appendChild(serverSec);

    renderVersionCheck(version);

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
// Web 控制 — OpenCode 服务启停
// ============================

/** 启动 OpenCode Web 服务 */
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

/** 停止 OpenCode Web 服务 */
async function stopWeb() {
    const btn = document.getElementById('btnStopWeb');
    btn.disabled = true;
    btn.textContent = '⏳ 停止中...';
    try {
        await api.StopOpenCodeWeb();
        await api.StopOpenCodeEvents();
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

/** 在外部 Windows Terminal 中打开 opencode 终端 */
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

/** 清空客户端界面状态 */
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

/** 更新 UI 按钮的禁用/启用状态 */
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

// ===== OpenCode 版本检测 =====

/** 版本检测状态：idle / checking / latest / outdated */
var ocVersionStatus = 'idle';
var ocVersionLatest = '';

/** 渲染版本检测按钮/状态 */
function renderVersionCheck(version) {
    var el = document.getElementById('ocVersionCheck');
    if (!el) return;
    if (ocVersionStatus === 'checking') {
        el.innerHTML = ' <span class="oc-version-check-label checking">⏳ 检测中...</span>';
        return;
    }
    if (ocVersionStatus === 'latest') {
        el.innerHTML = ' <span class="oc-version-check-label latest">✅ 已是最新</span>';
        return;
    }
    if (ocVersionStatus === 'outdated') {
        el.innerHTML = ' <span class="oc-version-check-label outdated">⚠️ 最新版本: ' + escapeHtml(ocVersionLatest || '') + '</span>';
        return;
    }
    // idle
    el.innerHTML = ' <a href="javascript:void(0)" class="oc-version-check-btn" id="ocVersionCheckBtn">检测更新</a>';
    var btn = document.getElementById('ocVersionCheckBtn');
    if (btn) {
        btn.addEventListener('click', function() {
            checkOpenCodeVersion(version);
        });
    }
}

/** 执行版本检测 */
async function checkOpenCodeVersion(version) {
    ocVersionStatus = 'checking';
    renderVersionCheck(version);
    try {
        var result = await api.CheckOpenCodeVersion(version || '');
        if (result.isLatest) {
            ocVersionStatus = 'latest';
        } else {
            ocVersionStatus = 'outdated';
            ocVersionLatest = result.latestVersion || '';
        }
    } catch (e) {
        ocVersionStatus = 'idle'; // 失败回退到 idle
    }
    renderVersionCheck(version);
}
