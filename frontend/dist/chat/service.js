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

/** 解析服务端口配置：'0' 表示随机端口（--port 0），应传 0 让后端主动发现实际端口 */
function resolveServicePort() {
    const cfg = getNetworkConfig();
    return cfg.servicePort === '0' ? 0 : (parseInt(cfg.servicePort, 10) || 4096);
}

/** 检测 OpenCode 服务运行状态 */
export async function checkWebStatus() {
    try {
        const config = getNetworkConfig();
        const status = await api.GetWebStatus(config.serviceHost, resolveServicePort());
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
            // 服务未运行（含被外部停止）：复位后端 SSE 标记，
            // 避免下次启动时被误判为已建立而不再调用 StartOpenCodeEvents
            startEventStream.backendStarted = false;
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

// ============================
// 服务状态
// ============================

/** 加载服务健康状态（Server / MCP / LSP / 插件） */
export async function loadServiceStatus() {
    const config = getNetworkConfig();
    try {
        const [web, mcp, lsp, cfg] = await Promise.all([
            api.GetWebStatus(config.serviceHost, resolveServicePort()).catch(() => null),
            store.webRunning ? api.OpenCodeCall('GET', '/mcp').catch(() => null) : Promise.resolve(null),
            store.webRunning ? api.OpenCodeCall('GET', '/lsp').catch(() => null) : Promise.resolve(null),
            store.webRunning ? api.OpenCodeCall('GET', '/config').catch(() => null) : Promise.resolve(null),
        ]);
        if (web) {
            store.webRunning = !!web.running;
            store.webURL = web.url || '';
        }
        store.serverStatus = normalizeServerStatus(web);
        store.mcpStatus = mcp;
        store.lspStatus = lsp;
        // 插件信息：只取 /config 的 plugin 数组（服务按此加载的插件），
        // 其余字段（含 provider API Key）不进入内存，避免敏感配置暴露
        store.pluginStatus = extractPluginList(cfg);
        updateWebUI();
        renderServiceStatus();
    } catch (e) {
        store.serverStatus = normalizeServerStatus(null);
        store.mcpStatus = null;
        store.lspStatus = null;
        store.pluginStatus = [];
        renderServiceStatus();
    }
}

/** 从 /config 响应提取 plugin 数组（cfg 为 OpenCodeCall 已解析的对象；解析失败返回空） */
function extractPluginList(cfg) {
    if (!cfg || typeof cfg !== 'object') return [];
    return Array.isArray(cfg.plugin) ? cfg.plugin.slice() : [];
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

    // ── 插件 — 服务实际加载的插件（来自 /config 的 plugin 数组）──
    if (store.pluginStatus.length) {
        const pluginSec = document.createElement('div');
        pluginSec.className = 'oc-service-group collapsed';
        const plugins = store.pluginStatus || [];
        const pluginDot = plugins.length ? 'on' : 'off';
        pluginSec.innerHTML = '<div class="oc-service-group-title clickable">' +
            '<span class="oc-service-dot ' + pluginDot + '"></span>插件' +
        '</div>';
        if (!plugins.length) {
            pluginSec.innerHTML += '<div class="oc-service-body"><div class="oc-service-item"><span class="oc-service-dot off"></span>未配置插件</div></div>';
        } else {
            let body = '<div class="oc-service-body">';
            plugins.forEach(name => {
                body += '<div class="oc-service-item"><span class="oc-service-dot on"></span>' + escapeHtml(name) + '</div>';
            });
            body += '</div>';
            pluginSec.innerHTML += body;
        }
        pluginSec.querySelector('.oc-service-group-title.clickable').addEventListener('click', function() {
            pluginSec.classList.toggle('collapsed');
        });
        box.appendChild(pluginSec);
    }
}

// ============================
// Web 控制 — OpenCode 服务启停
// ============================

/** 启动 OpenCode Web 服务 */
export async function startWeb() {
    const config = getNetworkConfig();
    const portText = (config.servicePort || '').trim();
    // '0' 表示随机端口（--port 0），由 OpenCode 分配
    const port = portText === '0' ? 0 : (parseInt(portText) || 4096);
    const hostname = config.serviceHost || '127.0.0.1';
    try {
        const result = await api.StartOpenCodeWeb(port, hostname, getNetworkConfig());
        if (result.running) {
            store.webRunning = true;
            store.webURL = result.url || `http://${hostname}:${port}`;
            store.serverStatus = normalizeServerStatus(result);
            updateWebUI();
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
        }
    } catch (e) {
        showToast('启动失败: ' + (e.message || e), 'error');
    } finally {
        updateWebUI();
    }
}

/** 停止 OpenCode Web 服务 */
export async function stopWeb() {
    try {
        await api.StopOpenCodeWeb();
        await api.StopOpenCodeEvents();
        // 后端 SSE 已停止：复位标记，使下次启动时 startEventStream() 能重新建立连接
        startEventStream.backendStarted = false;
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
        // 清理 Agent/Model 选择器：清空列表与选中值，并重置加载守卫，
        // 使下次启动时 loadAgentModelSelectors 重新获取列表。
        // 注意：不清空下拉框的 <option>——ocVariantSelect 的选项是 index.html
        // 静态定义的（Minimal/Low/...），清空后无法恢复；只重置选中值即可。
        store.agentList = [];
        store.modelList = [];
        store.selectedAgent = '';
        store.selectedModel = '';
        store.selectedVariant = '';
        store.agentModelSelectorsLoaded = false;
        store.agentModelSyncedSession = '';
        ['ocAgentSelect', 'ocModelSelect', 'ocVariantSelect'].forEach(function(id) {
            var sel = document.getElementById(id);
            if (sel) sel.value = '';
        });
        clearInterval(store.refreshTimer);
        clearTimeout(store.sessionRefreshTimer);
        updateWebUI();
        clearClientUI();
        document.getElementById('ocTree').innerHTML = '<div class="oc-empty">启动服务后加载项目树</div>';
        showToast('已停止', 'info');
    } catch (e) {
        showToast('停止失败: ' + (e.message || e), 'error');
    } finally {
        updateWebUI();
    }
}

/** 启动/停止二合一开关：按当前运行状态决定调 startWeb 或 stopWeb */
export function toggleWeb() {
    const btn = document.getElementById('btnToggleWeb');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.dataset.mode = store.webRunning ? 'stop' : 'start';
    btn.textContent = store.webRunning ? '⏳ 停止中...' : '⏳ 启动中...';
    const task = store.webRunning ? stopWeb() : startWeb();
    task.finally(() => {
        // 按钮状态由 updateWebUI 统一恢复（含文案/样式切换）
        updateWebUI();
    });
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
    document.getElementById('ocPrompt').value = '';
    updateModelInfo(null);
}

/** 更新 UI 按钮的禁用/启用状态（含启动/停止二合一按钮的文案与样式切换） */
export function updateWebUI() {
    const btnToggle = document.getElementById('btnToggleWeb');
    const btnWt = document.getElementById('btnWtOpen');
    const btnRefresh = document.getElementById('btnRefreshTree');
    const btnNewSession = document.getElementById('btnNewSession');
    const btnSend = document.getElementById('btnSendPrompt');
    const btnRefreshStatus = document.getElementById('btnRefreshStatus');
    const prompt = document.getElementById('ocPrompt');
    const btnAttach = document.getElementById('btnAttachFile');
    const btnFrontendWeb = document.getElementById('btnFrontendWebConfig');
    const btnFrontendWebDot = document.getElementById('frontendWebToolbarDot');

    if (btnToggle) {
        // 二合一按钮：运行态显示「停止」（danger 样式），停止态显示「启动」（主操作样式）
        if (store.webRunning) {
            btnToggle.disabled = false;
            btnToggle.dataset.mode = 'stop';
            btnToggle.textContent = '■ 停止 OpenCode';
            btnToggle.classList.add('btn-danger-outline');
            btnToggle.classList.remove('btn-primary');
        } else {
            btnToggle.disabled = false;
            btnToggle.dataset.mode = 'start';
            btnToggle.textContent = '▶ 启动 OpenCode';
            btnToggle.classList.add('btn-primary');
            btnToggle.classList.remove('btn-danger-outline');
        }
    }

    if (store.webRunning) {
        btnWt.disabled = false;
        btnRefresh.disabled = false;
        btnNewSession.disabled = false;
        btnSend.disabled = false;
        btnRefreshStatus.disabled = false;
        prompt.disabled = false;
        btnAttach.disabled = false;
    } else {
        btnWt.disabled = true;
        btnRefresh.disabled = true;
        btnNewSession.disabled = true;
        btnSend.disabled = true;
        btnRefreshStatus.disabled = true;
        prompt.disabled = true;
        btnAttach.disabled = true;
    }
    if (btnFrontendWeb && btnFrontendWebDot) {
        btnFrontendWebDot.classList.toggle('on', store.frontendWebRunning);
        btnFrontendWebDot.classList.toggle('off', !store.frontendWebRunning);
    }
}



// ===== OpenCode 版本检测与自动更新 =====
// 交互（与原型对齐）：检测更新 → 发现新版本 → 后台下载（不阻塞界面）→ 就绪通知 → 一键完成更新。
// 下载/解压在 Go 端后台任务执行；本模块只负责发起操作、轮询状态、渲染服务卡内横幅。

var updateStatusTimer = null; // 状态轮询句柄（仅 downloading/preparing 期间）
var updateLastPhase = '';     // 相位跃迁检测（下载完成 → toast 通知）
var updateSpeedText = '';     // 最近一次采样计算的下载速度（前端按轮询间隔差分）
var updateLastSample = { bytes: 0, ts: 0 }; // 上次采样的已下载字节与时刻

/** 渲染版本行：检测入口 + 更新横幅容器（服务面板每次渲染时调用）。 */
export function renderVersionCheck(version) {
    var el = document.getElementById('ocVersionCheck');
    if (!el) return;
    el.innerHTML = ' <a href="javascript:void(0)" class="oc-version-check-btn" id="ocVersionCheckBtn">检测更新</a>';
    var btn = document.getElementById('ocVersionCheckBtn');
    if (btn) {
        btn.addEventListener('click', function () {
            checkOpenCodeVersion(version);
        });
    }
    // 更新横幅挂在版本行的卡片末尾（独立成行，避免挤在行内右侧的窄区里）
    var card = el.closest('.oc-service-card');
    var banner = document.getElementById('ocUpdateBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.className = 'oc-update-banner';
        banner.id = 'ocUpdateBanner';
        banner.style.display = 'none';
        (card || el).appendChild(banner);
    }
    // 恢复后端残留状态（跨启动的「就绪待更新」/ 上次失败 / 在途下载）
    refreshUpdateStatus();
}

/** 检测更新：最新 → toast；有新版 → 「发现新版本」横幅。 */
export async function checkOpenCodeVersion(version) {
    setCheckBtnState('检测中…', true);
    try {
        var result = await api.CheckOpenCodeVersion(version || '', getNetworkConfig());
        setCheckBtnState('检测更新', false);
        if (result.isLatest) {
            showToast('已是最新版本', 'success');
        } else if (result.latestVersion) {
            renderUpdateBanner('found', { version: result.latestVersion });
        } else {
            showToast(result.error || '版本检测失败', 'error');
        }
    } catch (e) {
        setCheckBtnState('检测更新', false);
        showToast('版本检测失败', 'error');
    }
}

/** 检测按钮状态（链接式按钮无 disabled 语义，用样式+指针控制）。 */
function setCheckBtnState(text, busy) {
    var btn = document.getElementById('ocVersionCheckBtn');
    if (!btn) return;
    btn.textContent = text;
    btn.style.pointerEvents = busy ? 'none' : '';
    btn.style.opacity = busy ? '0.5' : '';
}

/** 渲染更新横幅（服务卡内的轻量状态区，不遮挡界面）。 */
function renderUpdateBanner(kind, data) {
    var el = document.getElementById('ocUpdateBanner');
    if (!el) return;
    if (kind === 'hidden') {
        el.style.display = 'none';
        el.innerHTML = '';
        delete el.dataset.kind;
        return;
    }
    el.style.display = 'block';
    // 下载中每秒轮询：同状态只做增量更新（整块重建会导致文字/按钮闪烁）
    if (el.dataset.kind === kind && (kind === 'downloading' || kind === 'preparing')) {
        updateDownloadingNumbers(el, kind, data);
        return;
    }
    el.dataset.kind = kind;
    var ver = '<b class="oc-update-ver">v' + escapeHtml(data.version || '') + '</b>';
    if (kind === 'found') {
        el.className = 'oc-update-banner found';
        el.innerHTML = '<div class="oc-update-line1"><span class="oc-update-ic">✦</span>'
            + '<span class="oc-update-grow">发现新版本 ' + ver + '</span>'
            + '<button class="btn btn-primary oc-update-btn" id="ocUpdateDownloadBtn">后台下载</button></div>'
            + '<div class="oc-update-line2">约 96 MB · 后台下载，期间可继续使用</div>';
        bindUpdateClick('ocUpdateDownloadBtn', function () { startUpdateDownload(data.version); });
        return;
    }
    if (kind === 'downloading' || kind === 'preparing') {
        var pct = data.total > 0 ? Math.floor(data.downloaded / data.total * 100) : 0;
        el.className = 'oc-update-banner downloading';
        el.innerHTML = '<div class="oc-update-line1">'
            + '<span class="oc-update-grow">正在后台下载 ' + ver + '<span id="ocUpdateDlPct">' + (kind === 'preparing' ? ' … 准备中' : ' … ' + pct + '%') + '</span></span>'
            + '<a href="javascript:void(0)" class="oc-version-check-btn" id="ocUpdateCancelBtn">取消下载</a></div>'
            + (kind === 'preparing' ? ''
                : '<div class="oc-update-mini-bar"><div class="oc-update-mini-fill" id="ocUpdateDlFill" style="width:' + pct + '%"></div></div>'
                + '<div class="oc-update-meta"><span id="ocUpdateDlSize">' + mbText(data.downloaded) + ' / ' + mbText(data.total) + '</span><span id="ocUpdateDlSpeed">' + (updateSpeedText || '—') + '</span></div>')
            + '<div class="oc-update-line2">可以继续使用其他功能，下载完成后会通知你。</div>';
        bindUpdateClick('ocUpdateCancelBtn', function () { cancelUpdateDownload(); });
        return;
    }
    if (kind === 'ready') {
        el.className = 'oc-update-banner ready';
        el.innerHTML = '<div class="oc-update-line1"><span class="oc-update-ic ok">✓</span>'
            + '<span class="oc-update-grow">' + ver + ' 已下载并准备就绪</span>'
            + '<button class="btn btn-primary oc-update-btn" id="ocUpdateApplyBtn">立即完成更新</button></div>'
            + '<div class="oc-update-line2">将重启 OpenCode 服务（约 10 秒），期间无法对话。</div>';
        bindUpdateClick('ocUpdateApplyBtn', function () { applyUpdate(data.version); });
        return;
    }
    if (kind === 'failed') {
        el.className = 'oc-update-banner failed';
        el.innerHTML = '<div class="oc-update-line1"><span class="oc-update-ic err">✕</span>'
            + '<span class="oc-update-grow">' + escapeHtml(data.error || '更新任务失败') + '</span>'
            + '<button class="btn btn-sm oc-update-btn" id="ocUpdateRetryBtn">重试</button></div>'
            + '<div class="oc-update-line2">已下载的部分会保留，重试将从中断处继续。</div>';
        bindUpdateClick('ocUpdateRetryBtn', function () { startUpdateDownload(data.version); });
        return;
    }
}

/** 下载中横幅的数值增量刷新（不重建 DOM，避免每秒轮询引起闪烁）。 */
function updateDownloadingNumbers(el, kind, data) {
    var pct = data.total > 0 ? Math.floor(data.downloaded / data.total * 100) : 0;
    var pctEl = el.querySelector('#ocUpdateDlPct');
    if (pctEl) pctEl.textContent = kind === 'preparing' ? ' … 准备中' : ' … ' + pct + '%';
    var fillEl = el.querySelector('#ocUpdateDlFill');
    if (fillEl) fillEl.style.width = pct + '%';
    var sizeEl = el.querySelector('#ocUpdateDlSize');
    if (sizeEl) sizeEl.textContent = mbText(data.downloaded) + ' / ' + mbText(data.total);
    var speedEl = el.querySelector('#ocUpdateDlSpeed');
    if (speedEl) speedEl.textContent = updateSpeedText || '—';
}

function bindUpdateClick(id, fn) {
    var b = document.getElementById(id);
    if (b) b.addEventListener('click', fn);
}

function mbText(bytes) {
    if (!bytes) return '0.0 MB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

/** 速度格式化：按速率大小自动切换 B/s / KB/s / MB/s（慢速时不再显示 0.0 MB/s）。 */
function speedText(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec <= 0) return '';
    if (bytesPerSec >= 1048576) return (bytesPerSec / 1048576).toFixed(1) + ' MB/s';
    if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
    return Math.round(bytesPerSec) + ' B/s';
}

/** 发起后台下载（立即返回；轮询接管进度显示）。 */
async function startUpdateDownload(version) {
    updateSpeedText = '';
    updateLastSample = { bytes: 0, ts: 0 };
    try {
        var st = await api.StartOpenCodeUpdate(version, getNetworkConfig());
        applyUpdateStatusToBanner(st);
        if (st.phase === 'downloading' || st.phase === 'preparing') startUpdatePolling();
    } catch (e) {
        showToast('启动下载失败: ' + (e && e.message ? e.message : e), 'error');
    }
}

/** 取消下载（保留已下载部分，重试可续传）。 */
async function cancelUpdateDownload() {
    stopUpdatePolling();
    try {
        await api.CancelOpenCodeUpdate();
    } catch (_) { /* 取消失败不阻断界面复位 */ }
    var el = document.getElementById('ocUpdateBanner');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
    setCheckBtnState('检测更新', false);
}

/** 轮询并渲染更新状态（服务面板渲染后、下载期间周期调用）。 */
export async function refreshUpdateStatus() {
    try {
        var st = await api.GetOpenCodeUpdateStatus();
        applyUpdateStatusToBanner(st);
        if (st.phase === 'downloading' || st.phase === 'preparing') startUpdatePolling();
        else stopUpdatePolling();
    } catch (_) { /* 状态查询失败静默（下次渲染重试） */ }
}

function applyUpdateStatusToBanner(st) {
    var phase = (st && st.phase) || 'idle';
    // 下载完成的通知：仅本会话内经历「下载/准备 → 就绪」时提示
    if (phase === 'ready' && updateLastPhase && updateLastPhase !== 'ready') {
        showToast('新版本 v' + (st.version || '') + ' 已就绪，可一键完成更新', 'success');
    }
    updateLastPhase = phase;
    // 网速：按轮询间隔对已下载字节差分（前端计算，后端状态无需提供）
    if (phase === 'downloading' && st.downloaded > 0) {
        var nowTs = Date.now();
        if (updateLastSample.ts && st.downloaded >= updateLastSample.bytes) {
            var dt = (nowTs - updateLastSample.ts) / 1000;
            if (dt >= 0.2) {
                var bps = (st.downloaded - updateLastSample.bytes) / dt;
                // 差值为 0（轮询间隔内暂无新字节）时保持上次速度显示，避免闪成 0
                if (bps > 0) updateSpeedText = speedText(bps);
            }
        }
        updateLastSample = { bytes: st.downloaded, ts: nowTs };
    } else if (phase !== 'downloading') {
        updateSpeedText = '';
    }
    switch (phase) {
        case 'downloading':
        case 'preparing':
            setCheckBtnState('检测更新', true);
            renderUpdateBanner(phase, st);
            break;
        case 'ready':
            setCheckBtnState('检测更新', true);
            renderUpdateBanner('ready', st);
            break;
        case 'failed':
            setCheckBtnState('检测更新', false);
            if (st.error) renderUpdateBanner('failed', st);
            else renderUpdateBanner('hidden');
            break;
        default:
            setCheckBtnState('检测更新', false);
            renderUpdateBanner('hidden');
            break;
    }
}

function startUpdatePolling() {
    if (updateStatusTimer) return;
    updateStatusTimer = setInterval(refreshUpdateStatus, 1000);
}

function stopUpdatePolling() {
    if (updateStatusTimer) {
        clearInterval(updateStatusTimer);
        updateStatusTimer = null;
    }
}

/** 完成更新（短流程 ~10 秒）：模态内推进步骤；请求返回后进入结果视图。 */
async function applyUpdate(version) {
    var cfg = getNetworkConfig();
    var port = parseInt((cfg.servicePort || '').trim(), 10) || 4096;
    var hostname = cfg.serviceHost || '127.0.0.1';

    stopUpdatePolling();
    var m = showUpdateApplyModal();
    var phases = [
        ['stop', '正在停止服务…'],
        ['replace', '正在替换二进制…'],
        ['start', '正在启动服务…'],
        ['check', '正在校验运行版本…'],
    ];
    var idx = 0;
    var tickTimer = null;
    // 步骤条仅作进度示意：请求返回后立即停止推进（否则会覆盖结果视图的标题）
    var tick = function () {
        if (idx > 0) m.markDone(phases[idx - 1][0]);
        if (idx < phases.length) {
            m.markDoing(phases[idx][0]);
            m.setTitle(phases[idx][1]);
            idx++;
            tickTimer = setTimeout(tick, 900);
        }
    };
    tick();

    try {
        var st = await api.ApplyOpenCodeUpdate(hostname, port, cfg);
        if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
        if (st.phase === 'done') {
            m.markAllDone();
            m.showDone(st.version || version);
        } else {
            m.showFailed(st.error || '更新失败', !!st.rolledBack);
        }
    } catch (e) {
        if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
        m.showFailed((e && e.message ? e.message : String(e)), false);
    }
    // 服务已被重启/版本已变化：刷新服务面板（版本号、健康状态）
    setTimeout(function () {
        try { loadServiceStatus(); } catch (_) {}
    }, 800);
}

/** 动态创建「完成更新」模态（复用 .modal-card 公共样式）。 */
function showUpdateApplyModal() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'ocUpdateModal';
    overlay.style.display = 'flex';
    overlay.innerHTML =
        '<div class="modal-card oc-update-modal">'
        + '<div class="modal-header"><h3 id="ocUpdateModalTitle">正在完成更新</h3></div>'
        + '<div class="modal-body">'
        +   '<div class="oc-update-steps" id="ocUpdateSteps">'
        +     '<div class="oc-update-step" data-step="stop"><span class="oc-update-step-ic">✓</span><span>停止 OpenCode 服务</span></div>'
        +     '<div class="oc-update-step" data-step="replace"><span class="oc-update-step-ic">✓</span><span>替换二进制（旧版本已备份）</span></div>'
        +     '<div class="oc-update-step" data-step="start"><span class="oc-update-step-ic">✓</span><span>启动服务</span></div>'
        +     '<div class="oc-update-step" data-step="check"><span class="oc-update-step-ic">✓</span><span>校验运行版本</span></div>'
        +   '</div>'
        +   '<div class="oc-update-result" id="ocUpdateResult" style="display:none"></div>'
        + '</div>'
        + '<div class="modal-footer" id="ocUpdateModalFooter"></div>'
        + '</div>';
    document.body.appendChild(overlay);

    var setStep = function (key, state) {
        var el = overlay.querySelector('.oc-update-step[data-step="' + key + '"]');
        if (el) { el.classList.remove('doing', 'done'); el.classList.add(state); }
    };
    return {
        setTitle: function (t) {
            var el = overlay.querySelector('#ocUpdateModalTitle');
            if (el) el.textContent = t;
        },
        markDoing: function (k) { setStep(k, 'doing'); },
        markDone: function (k) { setStep(k, 'done'); },
        markAllDone: function () {
            ['stop', 'replace', 'start', 'check'].forEach(function (k) { setStep(k, 'done'); });
        },
        showDone: function (ver) {
            overlay.querySelector('#ocUpdateModalTitle').textContent = '更新完成';
            overlay.querySelector('#ocUpdateSteps').style.display = 'none';
            var r = overlay.querySelector('#ocUpdateResult');
            r.style.display = 'block';
            r.innerHTML = '<div class="oc-update-r-icon ok">✓</div>'
                + '<div class="oc-update-r-t1">已更新到 v' + escapeHtml(ver) + '</div>'
                + '<div class="oc-update-r-t2">服务已重启，运行版本校验通过。</div>';
            var f = overlay.querySelector('#ocUpdateModalFooter');
            f.innerHTML = '<button class="btn btn-primary" id="ocUpdateModalOk">完成</button>';
            f.querySelector('#ocUpdateModalOk').addEventListener('click', function () { overlay.remove(); });
        },
        showFailed: function (msg, rolled) {
            overlay.querySelector('#ocUpdateModalTitle').textContent = '更新失败';
            overlay.querySelector('#ocUpdateSteps').style.display = 'none';
            var r = overlay.querySelector('#ocUpdateResult');
            r.style.display = 'block';
            r.innerHTML = '<div class="oc-update-r-icon err">' + (rolled ? '↩' : '✕') + '</div>'
                + '<div class="oc-update-r-t1">' + (rolled ? '已自动回滚' : '更新未完成') + '</div>'
                + '<div class="oc-update-r-t2">' + escapeHtml(msg) + '</div>'
                + (rolled ? '<div class="oc-update-rollback-note">已恢复到更新前的版本（备份 tools/opencode.exe.bak），服务已重新启动。</div>' : '');
            var f = overlay.querySelector('#ocUpdateModalFooter');
            f.innerHTML = '<button class="btn btn-sm" id="ocUpdateModalClose">关闭</button>';
            f.querySelector('#ocUpdateModalClose').addEventListener('click', function () { overlay.remove(); });
        },
    };
}
