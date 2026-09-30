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
import { store, currentDir } from '../core/state.js';
import { showToast, escapeHtml, getActiveMessagesEl, updateModelInfo, setRefreshServiceStatusHandler } from '../core/utils.js';
import { getNetworkConfig } from './config.js';
import { startEventStream, loadSessionStatuses } from './events.js';
import { buildTree } from './tree.js';
import { loadAgentModelSelectors } from './session.js';
import { initSearch, initUserNav } from './search.js';
import { unwrap } from '../core/v2compat.js';

// 注册服务状态刷新实现：session.js 打开会话（拿到目录）后会调用它重新拉取 MCP/插件状态
setRefreshServiceStatusHandler(() => loadServiceStatus());

// ============================
// Web 状态检测
// ============================

/** 解析服务端口配置：OpenCode v2 共享服务端口（默认 49374），不再支持随机端口 */
function resolveServicePort() {
    const cfg = getNetworkConfig();
    return parseInt(cfg.servicePort, 10) || 49374;
}

/** 检测 OpenCode 服务运行状态 */
export async function checkWebStatus() {
    try {
        const config = getNetworkConfig();
        // OpenCode v2 的服务需要 Basic 认证：把用户填写的口令交给后端，
        // 使「连接外部已启动的服务」也能通过鉴权。
        // 由 OC Manager 自己拉起的服务不依赖此口令（后端从启动输出自动解析）。
        if (config.servicePassword && api.SetServerPassword) {
            try { await api.SetServerPassword(config.servicePassword); } catch (_) { /* 旧后端无此方法，忽略 */ }
        }
        const status = await api.GetWebStatus(config.serviceHost, resolveServicePort());
        store.webRunning = status.running;
        store.webURL = status.url || '';
        store.serverStatus = normalizeServerStatus(status);
        updateWebUI();
        if (store.webRunning && status.health === '需口令') {
            // 服务在线但鉴权失败：明确提示，否则表现为「在线却什么都加载不出来」
            showToast('OpenCode 服务需要访问口令：请在网络配置中填写（口令见 opencode 启动日志的 server password）', 'error');
        }
        if (store.webRunning) {
            startEventStream();
            buildTree();
            loadServiceStatus();
            loadAgentModelSelectors(currentDir());
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
        // v2：/api/mcp（MCP 运行时状态）与 /api/plugin（插件运行时状态）；
        // v1 的 /lsp 已移除——OpenCode v2 不再运行语言服务器、不暴露 LSP 工具，故不查询 lsp 状态。
        // 目录来源：不再依赖「当前会话」，改为**服务端默认 location**
        // （GET /api/location 不带 location 参数，即官方文档的 "the server default location"）。
        // 这样启动/连接服务后即可取模型与 MCP/插件状态，与是否打开会话解耦。
        const dir = await resolveServiceDefaultDir();
        const web = await api.GetWebStatus(config.serviceHost, resolveServicePort()).catch(() => null);
        if (web) {
            store.webRunning = !!web.running;
            store.webURL = web.url || '';
        }
        store.serverStatus = normalizeServerStatus(web);
        // v2 无 /api/lsp 端点（不运行语言服务器），故 lspStatus 恒为 null、
        // lspSupported 为 false，服务面板据此**整段不渲染** LSP 分组。
        store.lspStatus = null;
        store.lspSupported = false;
        // MCP/插件：需要 location[directory]，且服务端为**异步就绪**（MCP 要 spawn 子进程连接），
        // 首次查询常常为空 —— 故先查一次，再安排有限次延迟重试。
        const effectiveDir = store.webRunning ? dir : '';
        await fetchMcpPlugin(effectiveDir);
        // agent/model 与 MCP 同一时机：启动/连接服务时取一次（force 跳过同目录守卫）
        loadAgentModelSelectors(effectiveDir, true);
        updateWebUI();
        renderServiceStatus();
        scheduleMcpPluginRefresh(effectiveDir);
    } catch (e) {
        store.serverStatus = normalizeServerStatus(null);
        store.mcpStatus = null;
        store.lspStatus = null;
        store.pluginStatus = null;
        renderServiceStatus();
    }
}

// 服务端默认 location（GET /api/location，不带 location 参数），启动/连接服务时解析并缓存。
// 为什么用它：v2 的 agent / model / mcp / plugin 都要求 location[directory]；用「默认 location」
// 而不是「当前会话目录」，可以让这些状态在**服务启动/连接后立即取到**，且与是否打开会话解耦。
// 停止服务时清空，下次启动重新解析。
let serviceDefaultDir = '';

async function resolveServiceDefaultDir() {
    if (serviceDefaultDir) return serviceDefaultDir;
    try {
        const res = await api.OpenCodeCall('GET', '/api/location', null, '');
        const obj = unwrap(res) || res || {};
        const nested = (obj.data && obj.data.directory) || '';
        const dir = obj.directory || (obj.location && obj.location.directory) || nested || '';
        serviceDefaultDir = typeof dir === 'string' ? dir.trim() : '';
    } catch (_) {
        serviceDefaultDir = '';
    }
    return serviceDefaultDir;
}

/** 查询 MCP 与插件状态（需要 location[directory]；目录为空则跳过，避免回落到服务端 CWD=home）。 */
async function fetchMcpPlugin(dir) {
    if (!dir) {
        store.mcpStatus = null;
        store.pluginStatus = null;
        store.pluginBuiltin = null;
        return;
    }
    const [mcp, plugin] = await Promise.all([
        api.OpenCodeCall('GET', '/api/mcp', null, dir).catch(() => null),
        api.OpenCodeCall('GET', '/api/plugin', null, dir).catch(() => null),
    ]);
    // v2 的 /api/mcp 返回 {location, data: Mcp.Server[]} 信封
    store.mcpStatus = unwrap(mcp) ?? null;
    // 插件：extractPluginList 已剔除内置插件，内置部分单独汇总到 pluginBuiltin
    const pluginInfo = extractPluginList(plugin);
    store.pluginStatus = pluginInfo.list;
    store.pluginBuiltin = pluginInfo.builtin;
}

// MCP/插件重试定时器句柄
let mcpPluginRetryTimer = 0;

/**
 * 有限次延迟重试 MCP/插件状态。
 * OpenCode v2 的 MCP 服务器是**异步连接**的（stdio 需 spawn 子进程，通常耗时数秒），
 * 服务刚启动时 /api/mcp 往往返回空数组；插件（尤其 package 插件）也需加载时间。
 * 因此在拿到数据前按固定间隔重试若干次，最多约 18 秒。
 */
function scheduleMcpPluginRefresh(dir) {
    if (mcpPluginRetryTimer) { clearTimeout(mcpPluginRetryTimer); mcpPluginRetryTimer = 0; }
    if (!dir || !store.webRunning) return;
    let attempt = 0;
    const tick = async () => {
        attempt += 1;
        const mcpEmpty = !Array.isArray(store.mcpStatus) || store.mcpStatus.length === 0;
        const pluginEmpty = !(store.pluginStatus || []).length;
        if ((!mcpEmpty && !pluginEmpty) || attempt > 6) return; // 拿到数据或超时即止
        await fetchMcpPlugin(dir);
        renderServiceStatus();
        mcpPluginRetryTimer = setTimeout(tick, 3000);
    };
    mcpPluginRetryTimer = setTimeout(tick, 3000);
}

/** 从 /api/plugin 响应提取插件信息。
 *
 *  OpenCode v2 的 GET /api/plugin 返回 { location, data: Plugin.Info[] }，其中
 *  Plugin.Info = { id?, source:{type,target,version?,outdated?,updating?}, features, state:{status:'active'|'failed', error?} }。
 *  兼容裸数组与 v1 的 {plugins:[...]} / 字符串数组形态。
 *
 *  说明：v2 会把约 85 个内置插件（source.type === 'builtin'，id 形如 opencode.tool.read /
 *  opencode.provider.openai）一并返回。它们是内建子系统、对用户没有操作价值，
 *  因此这里**只返回用户插件**（local/package 等）；内置插件单独汇总成计数与状态。
 *
 *  @returns {{ list: Array, builtin: {count:number, active:number, failed:number}|null }}
 */
function extractPluginList(res) {
    if (!res) return { list: [], builtin: null };
    // 解开 {location, data} 信封
    let list = (res && !Array.isArray(res) && res.data !== undefined) ? res.data : res;
    // v1 兼容：{ plugins:[...] } 或 { plugin:[...] }
    if (list && !Array.isArray(list) && typeof list === 'object') {
        list = list.plugins ?? list.plugin ?? null;
    }
    if (!Array.isArray(list)) return { list: [], builtin: null };

    const user = [];
    let builtinCount = 0;
    let builtinActive = 0;
    let builtinFailed = 0;
    list.forEach(p => {
        if (typeof p === 'string') {
            user.push({ name: p, state: '', version: '', outdated: false, error: '' });
            return;
        }
        const src = p.source || {};
        // 内置插件：只统计，不逐条展示
        if (src.type === 'builtin') {
            builtinCount++;
            const st = (p.state && p.state.status) || '';
            if (st === 'active') builtinActive++;
            else if (st === 'failed') builtinFailed++;
            return;
        }
        // 用户插件（local/package 等）：归一化为 { name, state, version, outdated, error } 便于渲染
        const item = {
            name: p.id || src.target || src.path || '?',
            state: (p.state && p.state.status) || '',
            version: src.version || '',
            outdated: !!src.outdated,
            error: (p.state && p.state.error) || '',
        };
        if (item.name) user.push(item);
    });

    const builtin = builtinCount > 0
        ? { count: builtinCount, active: builtinActive, failed: builtinFailed }
        : null;
    return { list: user, builtin: builtin };
}

/** 将服务器状态对象标准化为统一格式 */
export function normalizeServerStatus(status) {
    const config = getNetworkConfig();
    const fallbackURL = `http://${config.serviceHost || '127.0.0.1'}:${config.servicePort || '49374'}`;
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
    // 重渲染前记录各分组的展开状态（按下标）。
    // 本函数会被"MCP/插件重试"等流程反复调用（每 3 秒一次，最多 6 次），
    // 若每次都按默认 collapsed 重建，用户手动展开的分组就会被复位——
    // 表现就是"刚展开，过一会儿自己折叠了"。这里保存并在渲染后恢复。
    const expandedBefore = Array.from(box.querySelectorAll('.oc-service-group'))
        .map(g => !g.classList.contains('collapsed'));
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
    // v2 的 GET /api/mcp 返回 {location, data: Mcp.Server[]}，
    // 每项 { name, status:{status:'connected'|'pending'|'disabled'|'failed'|'needs_auth', error?}, integrationID? }
    const mcpState = (info) => {
        if (!info) return '';
        const s = info.status;
        return (s && typeof s === 'object') ? (s.status || '') : (s || '');
    };
    if (store.mcpStatus) {
        const list = Array.isArray(store.mcpStatus) ? store.mcpStatus : Object.values(store.mcpStatus || {});
        const anyRunning = list.some(i => mcpState(i) === 'connected');
        const anyFailed = list.some(i => { const s = mcpState(i); return s === 'failed' || s === 'needs_auth'; });
        const dotClass = list.length === 0 ? 'off' : (anyFailed ? 'off' : (anyRunning ? 'on' : 'off'));
        const collapsed = list.length > 0 ? ' collapsed' : '';

        const sec = document.createElement('div');
        sec.className = 'oc-service-group' + collapsed;
        sec.innerHTML = '<div class="oc-service-group-title clickable">' +
            '<span class="oc-service-dot ' + dotClass + '"></span>MCP 服务' +
        '</div>';
        if (list.length === 0) {
            sec.innerHTML += '<div class="oc-service-body"><div class="oc-service-item"><span class="oc-service-dot off"></span>无已配置的 MCP 服务</div></div>';
        } else {
            let body = '<div class="oc-service-body">';
            list.forEach(info => {
                const name = (info && (info.name || info.id)) || '?';
                const st = mcpState(info);
                const running = st === 'connected';
                const failed = st === 'failed' || st === 'needs_auth';
                const stateText = running ? '已连接'
                    : st === 'disabled' ? '已禁用'
                    : failed ? '异常'
                    : st === 'pending' ? '连接中'
                    : '未连接';
                const detail = (info && info.status && info.status.error) ? '（' + escapeHtml(info.status.error) + '）' : '';
                body += '<div class="oc-service-item"><span class="oc-service-dot ' + (running ? 'on' : 'off') + '"></span>' + escapeHtml(name) + ' <span class="oc-service-state">' + stateText + detail + '</span></div>';
            });
            body += '</div>';
            sec.innerHTML += body;
        }
        sec.querySelector('.oc-service-group-title.clickable').addEventListener('click', function() {
            sec.classList.toggle('collapsed');
        });
        box.appendChild(sec);
    }

    // ── LSP 服务 ──
    // OpenCode v2 不再运行语言服务器、不暴露 LSP 工具，也没有 /api/lsp 端点，
    // 因此 v2 下拿不到任何 LSP 状态。
    //
    // 服务端不支持时**整段不渲染**，而不是渲染一个「不支持」的占位分组：
    // 占位分组会长期占着侧栏位置、看起来像个坏了的功能，而它永远不会有内容。
    // 若将来接上支持 LSP 的服务端，lspSupported 转 true，下面的分支自然恢复。
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

    // ── 插件 — 来自 GET /api/plugin（Plugin.Info[]，含运行时状态）──
    // 与 MCP 一致：仅在已按当前会话目录查询过（pluginStatus !== null）时渲染；
    // 无会话/无目录时 pluginStatus 为 null，整块不渲染。
    if (store.pluginStatus) {
        const plugins = store.pluginStatus || [];
        const builtin = store.pluginBuiltin || null;
        const anyActive = plugins.some(p => p.state === 'active');
        const anyFailed = plugins.some(p => p.state === 'failed') || (builtin ? builtin.failed > 0 : false);
        const pluginDot = (!plugins.length && !builtin) ? 'off' : (anyFailed ? 'off' : ((anyActive || builtin) ? 'on' : 'off'));
        const pluginSec = document.createElement('div');
        pluginSec.className = 'oc-service-group collapsed';
        // 标题只计用户插件数（内置插件另行汇总，避免出现「88 个插件」之类的噪音）
        pluginSec.innerHTML = '<div class="oc-service-group-title clickable">' +
            '<span class="oc-service-dot ' + pluginDot + '"></span>插件' +
            (plugins.length ? ' <span class="oc-service-state">' + plugins.length + '</span>' : '') +
        '</div>';
        let body = '<div class="oc-service-body">';
        // 内置插件：仅展示一行汇总（数量 + 状态），不逐条列出
        if (builtin) {
            const parts = [];
            if (builtin.active) parts.push(builtin.active + ' 正常');
            if (builtin.failed) parts.push(builtin.failed + ' 失败');
            const detail = parts.length ? '（' + parts.join('、') + '）' : '';
            body += '<div class="oc-service-item"><span class="oc-service-dot ' + (builtin.failed ? 'off' : 'on') + '"></span>内置插件 ' +
                builtin.count + ' 个' + detail + '</div>';
        }
        if (!plugins.length) {
            // 无用户插件且无内置插件时，才提示「未加载插件」
            if (!builtin) {
                body += '<div class="oc-service-item"><span class="oc-service-dot off"></span>未加载插件</div>';
            }
        } else {
            plugins.forEach(p => {
                const ok = p.state === 'active';
                const failed = p.state === 'failed';
                const stateText = ok ? '已加载' : failed ? '失败' : '';
                const suffix = p.outdated ? '（可更新）' : '';
                const detail = (failed && p.error) ? '（' + escapeHtml(p.error) + '）' : suffix;
                const label = p.version ? escapeHtml(p.name) + ' <span class="oc-service-state">v' + escapeHtml(p.version) + '</span>' : escapeHtml(p.name);
                body += '<div class="oc-service-item"><span class="oc-service-dot ' + (ok ? 'on' : 'off') + '"></span>' + label +
                    (stateText ? ' <span class="oc-service-state">' + stateText + '</span>' : '') + detail + '</div>';
            });
        }
        body += '</div>';
        pluginSec.innerHTML += body;
        pluginSec.querySelector('.oc-service-group-title.clickable').addEventListener('click', function() {
            pluginSec.classList.toggle('collapsed');
        });
        box.appendChild(pluginSec);
    }
    // 恢复重渲染前的展开状态（新出现的分组保持默认折叠）
    box.querySelectorAll('.oc-service-group').forEach(function(g, i) {
        if (expandedBefore[i]) g.classList.remove('collapsed');
    });
}

// ============================
// Web 控制 — OpenCode 服务启停
// ============================

/** 启动 OpenCode Web 服务 */
export async function startWeb() {
    const config = getNetworkConfig();
    const port = parseInt((config.servicePort || '').trim(), 10) || 49374;
    const hostname = config.serviceHost || '127.0.0.1';
    const password = (config.servicePassword || '').trim();
    try {
        const result = await api.StartOpenCodeWeb(port, hostname, password, getNetworkConfig());
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
            loadAgentModelSelectors(currentDir());
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
        // 插件区块也要随之隐藏：此前漏清 pluginStatus，导致停止服务后 MCP 隐藏而插件仍显示
        store.pluginStatus = null;
        store.pluginBuiltin = null;
        // 清理 Agent/Model 选择器：清空列表与选中值，并重置加载守卫，
        // 使下次启动时 loadAgentModelSelectors 重新获取列表。
        // 注意：不清空下拉框的 <option>——ocVariantSelect 的选项是 index.html
        // 静态定义的（Minimal/Low/...），清空后无法恢复；只重置选中值即可。
        store.agentList = [];
        store.modelList = [];
        serviceDefaultDir = '';
        store.selectedAgent = '';
        store.selectedModel = '';
        store.selectedVariant = '';
        store.agentModelSelectorsLoaded = false;
        store.agentModelSyncedSession = '';
        // 各会话的手动选择标记随服务停止一并清空：会话列表/选择器都已被重置，
        // 标记若残留会在下次连接后把旧值恢复到选择器里（旧服务的数据不应跨实例继承）。
        store.manualSelectionBySession = {};
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
