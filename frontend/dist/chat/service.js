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
import { showToast, showApiError, escapeHtml, getActiveMessagesEl, updateModelInfo, setRefreshServiceStatusHandler, mcpState, mcpRetryShouldStop, todoPluginAvailable, refreshTodoPanel } from '../core/utils.js';
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
        // 插件状态获取失败：待办能力一并关闭，避免分区停留在上一次的状态
        store.todoSupported = false;
        refreshTodoPanel();
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
        // 无目录即查不到插件列表：按「待办插件未加载」处理，隐藏代办分区
        store.todoSupported = false;
        refreshTodoPanel();
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
    // 待办能力：由配套插件（oc-manager.todo）是否已加载决定，驱动右栏代办分区显隐
    store.todoSupported = todoPluginAvailable(store.pluginStatus);
    refreshTodoPanel();
}

// MCP/插件重试定时器句柄与「世代」令牌。
// 世代令牌的作用：旧的重试链可能在 await fetchMcpPlugin 期间被新的 schedule 取代，
// 恢复后凭过期世代直接退出，避免两条链并行造成重复请求（防泄漏）。
let mcpPluginRetryTimer = 0;
let mcpPluginRetryGen = 0;

/** MCP/插件延迟重试的最大尝试次数（3 秒/次，最长约 30 秒） */
const MCP_RETRY_MAX_ATTEMPTS = 10;

/**
 * 有限次延迟重试 MCP/插件状态。
 * OpenCode v2 的 MCP 服务器是**异步连接**的（stdio 需 spawn 子进程，通常耗时数秒），
 * 服务刚启动时 /api/mcp 往往返回空数组或 status=pending；插件（尤其 package 插件）也需加载时间。
 * 因此只要「MCP 列表为空 / 任一服务器仍 pending / 插件列表为空」就按固定间隔重试，
 * 直到全部就绪或达到上限（停止条件见 core/utils.js 的 mcpRetryShouldStop）。
 */
function scheduleMcpPluginRefresh(dir) {
    if (mcpPluginRetryTimer) { clearTimeout(mcpPluginRetryTimer); mcpPluginRetryTimer = 0; }
    if (!dir || !store.webRunning) return;
    const gen = ++mcpPluginRetryGen;
    let attempt = 0;
    const tick = async () => {
        // 已被更新的重试链取代（或服务已停止）时直接退出，避免旧链复活
        if (gen !== mcpPluginRetryGen || !store.webRunning) return;
        mcpPluginRetryTimer = 0;
        attempt += 1;
        if (mcpRetryShouldStop(store.mcpStatus, store.pluginStatus, attempt, MCP_RETRY_MAX_ATTEMPTS)) return;
        await fetchMcpPlugin(dir);
        // await 期间可能被新的 schedule 取代（例如 SSE 触发的刷新）：过期世代不再安排下一跳
        if (gen !== mcpPluginRetryGen || !store.webRunning) return;
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

// ===== MCP 运行时操作（重连 / 断开） =====

// 操作在途守卫：key = 「动作|服务器名」。
// 请求期间即使按钮被重绘替换（mcp.* 事件触发的防抖刷新会重建 DOM），
// 同一服务器的重复触发也会被这里拦下（双点击保护）。
const mcpActionInFlight = new Set();

/** 执行 MCP 运行时操作（重连 = connect，断开 = disconnect）。
 *
 *  opencode v2 的实验性运行时端点：
 *   - POST /api/experimental/mcp/:server/connect    内部为 stop+start，可安全重连；
 *   - POST /api/experimental/mcp/:server/disconnect 断开连接。
 *  两者成功均返回 204 NoContent（无响应体）；apicall.js 对空 body 直接返回 null，
 *  不会抛 JSON 解析错误，因此这里直接 await 即可。
 *  旧版本 opencode 没有这两个端点（404）：给出「重启服务」的替代方案。
 *
 *  @param {string} action 'connect'（重连）或 'disconnect'（断开）
 *  @param {string} name   服务器名（mcp.servers 的键）
 *  @param {HTMLButtonElement} btn 触发按钮（用于在途禁用与失败恢复） */
async function handleMcpAction(action, name, btn) {
    const key = action + '|' + name;
    if (mcpActionInFlight.has(key)) return;
    // 先占锁再 await：双击的第二次 click 会在这里被挡住，避免重复请求
    mcpActionInFlight.add(key);
    // 图标按钮没有可见文字：在途反馈 = 按钮禁用 + 图标自旋（CSS :disabled 规则），
    // 原生 title 提示文案临时改为「处理中…」；失败或提前返回时在 finally 中恢复。
    const originalTip = btn.title;
    btn.disabled = true;
    btn.title = '处理中…';
    try {
        const dir = await resolveServiceDefaultDir();
        if (!dir) {
            showToast('尚未获取到服务目录', 'error');
            return;
        }
        const path = '/api/experimental/mcp/' + encodeURIComponent(name) +
            (action === 'disconnect' ? '/disconnect' : '/connect');
        await api.OpenCodeCall('POST', path, null, dir);
        showToast(name + (action === 'disconnect' ? ' 已断开' : ' 已重连'), 'success');
        // 立即刷新一次；随后到达的 mcp.* SSE 事件还会防抖补刷（连接/断开可能有延迟）
        await fetchMcpPlugin(dir);
        renderServiceStatus();
    } catch (e) {
        if (e && e.status === 404) {
            // 旧版 opencode 未提供这两个实验端点：给出当前版本可执行的替代方案
            showToast('当前 opencode 版本不支持运行时重连,请重启服务', 'error');
        } else {
            showToast((action === 'disconnect' ? '断开失败: ' : '重连失败: ') + ((e && e.message) || e), 'error');
        }
    } finally {
        mcpActionInFlight.delete(key);
        // 成功路径已重绘（按钮脱离文档，无需恢复）；失败或提前返回时恢复按钮可点。
        // 用 isConnected 判断按钮是否仍在文档中，避免操作已被替换的旧引用。
        if (btn.isConnected) {
            btn.disabled = false;
            btn.title = originalTip;
        }
    }
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

    // ── 服务器 — 点击标题折叠（默认展开） ──
    const health = store.serverStatus.health || (store.webRunning ? '未知' : '离线');
    const url = store.serverStatus.url || '--';
    const version = store.serverStatus.version || '--';
    const serverSec = document.createElement('div');
    serverSec.className = 'oc-service-group';
    // 卡片包在 oc-service-body 里（与 MCP/LSP/插件分组同构）：
    // 折叠样式 .oc-service-group.collapsed .oc-service-body 只作用于 body 层。
    serverSec.innerHTML =
        '<div class="oc-service-group-title clickable">' +
            '<span class="oc-service-dot ' + serviceHealthClass(health) + '"></span>' +
            '服务器' +
        '</div>' +
        '<div class="oc-service-body">' +
            '<div class="oc-service-card">' +
                '<div class="oc-service-item"><span class="oc-service-dot ' + serviceHealthClass(health) + '"></span>健康状态 <span class="oc-service-state">' + escapeHtml(health) + '</span></div>' +
                '<div class="oc-service-field"><span>URL</span><code title="' + escapeHtml(url) + '">' + escapeHtml(url) + '</code></div>' +
                '<div class="oc-service-field"><span>版本</span><code>' + escapeHtml(version) + '</code><span class="oc-version-check" id="ocVersionCheck"></span></div>' +
            '</div>' +
        '</div>';
    serverSec.querySelector('.oc-service-group-title.clickable').addEventListener('click', function() {
        serverSec.classList.toggle('collapsed');
    });
    box.appendChild(serverSec);

    renderVersionCheck(version);

    // ── MCP 服务 — 点击展开/折叠 ──
    // v2 的 GET /api/mcp 返回 {location, data: Mcp.Server[]}，
    // 每项 { name, status:{status:'connected'|'pending'|'disabled'|'failed'|'needs_auth', error?}, integrationID? }
    // 状态提取用 core/utils.js 的 mcpState（与重试循环共用同一实现）。
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
            list.forEach((info, idx) => {
                const name = (info && (info.name || info.id)) || '?';
                const st = mcpState(info);
                const running = st === 'connected';
                const failed = st === 'failed' || st === 'needs_auth';
                const stateText = running ? '已连接'
                    : st === 'disabled' ? '已禁用'
                    : failed ? '异常'
                    : st === 'pending' ? '连接中'
                    : '未连接';
                // 错误全文不内联展示（过长会撑破行且影响观感），仅在悬浮「异常」状态文字时经原生 title 查看。
                const errText = (info && info.status && info.status.error) ? String(info.status.error) : '';
                // 操作按钮：「重连」对任何状态都可点（v2 的 connect 端点内部是 stop+start，
                // failed/needs_auth/disabled/pending/connected 都能安全重连）；
                // 「断开」只在已连接时出现（断开一个没连上的服务器没有意义）。
                // 用 list 下标（数字）标识目标服务器，避免把服务器名写进 HTML 属性带来的转义问题。
                // 两个按钮为图标按钮（内联 SVG，无外部资源）：
                //   - 文案不显示在按钮内，而是写入原生 title，悬停时由浏览器默认气泡呈现；
                //   - aria-label 保留同一文案，供读屏与无 tooltip 场景使用；
                //   - 图标尺寸/描边颜色由 .oc-service-icon 统一控制（stroke 取 currentColor 跟随按钮色）。
                const actions = '<span class="oc-service-actions">' +
                    '<button type="button" class="btn btn-sm" data-mcp-action="connect" data-mcp-idx="' + idx + '" title="重连" aria-label="重连">' +
                        '<svg class="oc-service-icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>' +
                    '</button>' +
                    (running ? '<button type="button" class="btn btn-sm btn-del" data-mcp-action="disconnect" data-mcp-idx="' + idx + '" title="断开" aria-label="断开">' +
                        '<svg class="oc-service-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>' +
                    '</button>' : '') +
                '</span>';
                // 异常状态只内联显示「异常」，错误全文放入原生 title。
                // escapeHtml 走 textContent→innerHTML，不转义双引号；而 title 属性由双引号包裹，
                // 因此就地把 " 替换为 &quot;（必须在 escapeHtml 之后替换，否则 & 会被二次转义）。
                const stateHtml = (failed && errText)
                    ? '<span class="oc-service-state" title="' + escapeHtml(errText).replace(/"/g, '&quot;') + '">' + stateText + '</span>'
                    : '<span class="oc-service-state">' + stateText + '</span>';
                body += '<div class="oc-service-item"><span class="oc-service-dot ' + (running ? 'on' : 'off') + '"></span>' + escapeHtml(name) + ' ' + stateHtml + actions + '</div>';
            });
            body += '</div>';
            sec.innerHTML += body;
            // MCP 操作按钮：本函数每次执行都会重建 DOM，因此必须在重建后重新绑定。
            // 服务器名从闭包中的 list 按下标取回（不经过 HTML 属性）。
            sec.querySelectorAll('[data-mcp-action]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    const info = list[Number(btn.dataset.mcpIdx)] || {};
                    const name = info.name || info.id || '?';
                    handleMcpAction(btn.dataset.mcpAction, name, btn);
                });
            });
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
    // 恢复重渲染前的展开状态：按记录双向恢复（新出现的分组保持构造默认）。
    // 原先只做「展开则 remove」——对默认折叠的分组够用，但服务器分组默认展开，
    // 用户折叠它后一旦重建就会被复位；toggle 双向设置可以保住折叠状态。
    box.querySelectorAll('.oc-service-group').forEach(function(g, i) {
        if (expandedBefore[i] === undefined) return;
        g.classList.toggle('collapsed', !expandedBefore[i]);
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
        showApiError('启动失败: ', e);
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
        // 代办分区同理：插件列表清空后待办能力关闭，分区随服务停止一起隐藏
        store.todoSupported = false;
        refreshTodoPanel();
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
        showApiError('停止失败: ', e);
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
        showApiError('启动终端失败: ', e);
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
        var result = await api.CheckOpenCodeVersion(version || '');
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
    var port = parseInt((cfg.servicePort || '').trim(), 10) || 49374;
    var hostname = cfg.serviceHost || '127.0.0.1';
    var password = (cfg.servicePassword || '').trim();

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
        var st = await api.ApplyOpenCodeUpdate(hostname, port, password, cfg);
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
