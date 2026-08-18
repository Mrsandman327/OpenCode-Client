// ============================================================
// chat-service.js — 服务管理 & API 工具
// 依赖：core/state.js、core/utils.js（showToast, escapeHtml, getActiveMessagesEl, updateModelInfo）、core/apicall.js（api）、
//       chat/config.js（getNetworkConfig）、chat/events.js（startEventStream, loadSessionStatuses）、
//       chat/tree.js（buildTree）、chat/session.js（loadAgentModelSelectors）、
//       chat/search.js（initSearch, initUserNav）
// 解环说明：updateModelInfo 经 core/utils.js 注册中心调用（render.js 注册实现），
//           不再静态 import render.js。
// ============================================================

import { api } from '../core/apicall.js';
import { store } from '../core/state.js';
import { showToast, escapeHtml, getActiveMessagesEl, updateModelInfo } from '../core/utils.js';
import { getNetworkConfig } from './config.js';
import { startEventStream, loadSessionStatuses } from './events.js';
import { buildTree } from './tree.js';
import { loadAgentModelSelectors } from './session.js';
import { initSearch, initUserNav } from './search.js';

// ============================
// Web 状态检测
// ============================

/** 检测 OpenCode 服务运行状态 */
export async function checkWebStatus() {
    try {
        const config = getNetworkConfig();
        const status = await api.GetWebStatus(config.serviceHost, parseInt(config.servicePort) || 4096);
        store.webRunning = status.running;
        store.webURL = status.url || '';
        store.serverStatus = normalizeServerStatus(status);
        updateWebUI();
        if (store.webRunning) {
            startEventStream();
            buildTree();
            loadServiceStatus();
            loadAgentModelSelectors();
        } else {
            renderServiceStatus();
        }
    } catch (e) {
        console.warn('GetWebStatus failed:', e);
        store.serverStatus = normalizeServerStatus(null);
        renderServiceStatus();
    }
    setTimeout(function() { initSearch(); initUserNav(); }, 500);
}

// ============================
// API 工具
// ============================
// 注：safeText / extractPartText / messageText / isInternalUserMessage / normalizeMessageItem
// 已移入 core/utils.js（纯函数下沉，打破 service ↔ render 循环依赖）。

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
export async function loadServiceStatus() {
    const config = getNetworkConfig();
    try {
        const [web, mcp, lsp] = await Promise.all([
            api.GetWebStatus(config.serviceHost, parseInt(config.servicePort) || 4096).catch(() => null),
            store.webRunning ? api.OpenCodeCall('GET', '/mcp').catch(() => null) : Promise.resolve(null),
            store.webRunning ? api.OpenCodeCall('GET', '/lsp').catch(() => null) : Promise.resolve(null),
        ]);
        if (web) {
            store.webRunning = !!web.running;
            store.webURL = web.url || '';
        }
        store.serverStatus = normalizeServerStatus(web);
        store.mcpStatus = mcp;
        store.lspStatus = lsp;
        updateWebUI();
        renderServiceStatus();
    } catch (e) {
        store.serverStatus = normalizeServerStatus(null);
        store.mcpStatus = null;
        store.lspStatus = null;
        renderServiceStatus();
    }
}

/** 将服务器状态对象标准化为统一格式 */
export function normalizeServerStatus(status) {
    const config = getNetworkConfig();
    const fallbackURL = `http://${config.serviceHost || '127.0.0.1'}:${config.servicePort || '4096'}`;
    if (!status) {
        return { url: store.webURL || fallbackURL, health: store.webRunning ? '未知' : '离线', version: '' };
    }
    const running = !!status.running;
    return {
        url: status.url || store.webURL || fallbackURL,
        health: status.health || (running ? '未知' : '离线'),
        version: status.version || '',
    };
}

/** 返回服务健康状态对应的 CSS 类名 */
export function serviceHealthClass(health) {
    if (health === '在线') return 'on';
    if (health === '异常') return 'warn';
    return 'off';
}

/** 渲染服务状态面板（包含 Server / MCP / LSP 三栏） */
export function renderServiceStatus() {
    const box = document.getElementById('ocServices');
    box.innerHTML = '';

    // ── 服务器 — 始终展开 ──
    const health = store.serverStatus.health || (store.webRunning ? '未知' : '离线');
    const url = store.serverStatus.url || '--';
    const version = store.serverStatus.version || '--';
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
    if (store.mcpStatus) {
        const entries = typeof store.mcpStatus === 'object' ? Object.entries(store.mcpStatus) : [];
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
    if (store.lspStatus) {
        const entries = Array.isArray(store.lspStatus) ? store.lspStatus : Object.values(store.lspStatus || {});
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
export async function startWeb() {
    const config = getNetworkConfig();
    const port = parseInt(config.servicePort) || 4096;
    const hostname = config.serviceHost || '127.0.0.1';
    const btn = document.getElementById('btnStartWeb');
    btn.disabled = true;
    btn.textContent = '⏳ 启动中...';
    try {
        const result = await api.StartOpenCodeWeb(port, hostname, getNetworkConfig());
        if (result.running) {
            store.webRunning = true;
            store.webURL = result.url || `http://${hostname}:${port}`;
            store.serverStatus = normalizeServerStatus(result);
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
export async function stopWeb() {
    const btn = document.getElementById('btnStopWeb');
    btn.disabled = true;
    btn.textContent = '⏳ 停止中...';
    try {
        await api.StopOpenCodeWeb();
        await api.StopOpenCodeEvents();
        store.webRunning = false;
        store.webURL = '';
        store.currentSessionId = '';
        store.sessions = [];
        store.sessionStatuses = {};
        store.sessionErrors = {};
        store.messageCache = {};
        store.expandedParts = {};
        store.markdownCache = {};
        store.subtaskSummaries = [];
        store.detailMessageCache = {};
        store.detailLoading = {};
        store.detailExpandedParts = {};
        // 清理多会话 Tab
        if (store.openTabs) {
            store.openTabs = [];
            store.activeTabId = '';
            store.tabCacheVersion = {};
            store.tabRenderedVersion = {};
            store.tabScrollPositions = {};
            store.tabExpandedParts = {};
            var tabsBar = document.getElementById('ocTabsBar');
            if (tabsBar) tabsBar.innerHTML = '';
            // 显式移除池中所有 tab 容器与占位提示，避免 clearClientUI 写 pool 时误伤
            var poolEl = document.getElementById('ocMessagesPool');
            if (poolEl) poolEl.innerHTML = '';
        }
        store.serverStatus = normalizeServerStatus(null);
        store.mcpStatus = null;
        store.lspStatus = null;
        clearInterval(store.refreshTimer);
        clearTimeout(store.sessionRefreshTimer);
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
export async function launchTerminal() {
    try {
        const dir = await api.OpenDirectoryDialog();
        if (!dir) return;
        const result = await api.LaunchWindowsTerminal('attach', store.webURL, dir);
        if (!result.success && result.error) {
            showToast('启动失败: ' + result.error, 'error');
        }
    } catch (e) {
        showToast('启动终端失败: ' + (e.message || e), 'error');
    }
}

/** 清空客户端界面状态 */
export function clearClientUI() {
    document.getElementById('ocTree').innerHTML = '<div class="oc-empty">启动服务后加载项目树</div>';
    document.getElementById('ocChatTitle').textContent = '未选择会话';
    // 直接清空消息池（stopWeb 已显式移除 tab 容器；此处兜底整体重置）
    var poolEl = document.getElementById('ocMessagesPool');
    if (poolEl) {
        poolEl.innerHTML = '<div class="oc-empty">选择会话后查看消息，或输入内容创建新会话</div>';
    } else {
        getActiveMessagesEl().innerHTML = '<div class="oc-empty">选择会话后查看消息，或输入内容创建新会话</div>';
    }
    document.getElementById('ocSubtasks').innerHTML = '<div class="oc-empty">当前会话暂无子任务</div>';
    document.getElementById('ocTodos').innerHTML = '<div class="oc-empty">当前会话暂无代办</div>';
    renderServiceStatus();
    document.getElementById('ocDiff').innerHTML = '<div class="oc-empty">选择会话后查看变更</div>';
    document.getElementById('ocPrompt').value = '';
    updateModelInfo(null);
}

/** 更新 UI 按钮的禁用/启用状态 */
export function updateWebUI() {
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

    if (store.webRunning) {
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
        btnFrontendWebDot.classList.toggle('on', store.frontendWebRunning);
        btnFrontendWebDot.classList.toggle('off', !store.frontendWebRunning);
    }
}

// ===== OpenCode 版本检测 =====

/** 渲染版本检测按钮（始终显示，点击后 toast 提示结果） */
export function renderVersionCheck(version) {
    var el = document.getElementById('ocVersionCheck');
    if (!el) return;
    el.innerHTML = ' <a href="javascript:void(0)" class="oc-version-check-btn" id="ocVersionCheckBtn">检测更新</a>';
    var btn = document.getElementById('ocVersionCheckBtn');
    if (btn) {
        btn.addEventListener('click', function() {
            checkOpenCodeVersion(version);
        });
    }
}

/** 执行版本检测，结果通过 toast 展示 */
export async function checkOpenCodeVersion(version) {
    try {
        var result = await api.CheckOpenCodeVersion(version || '');
        if (result.isLatest) {
            showToast('已是最新版本', 'success');
        } else {
            showToast('发现新版本: ' + (result.latestVersion || ''), 'warning');
        }
    } catch (e) {
        showToast('版本检测失败', 'error');
    }
}
