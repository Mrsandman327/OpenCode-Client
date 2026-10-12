// ============================================================
// chat-config.js — 网络配置 & Web 服务配置
// 依赖：core/state.js（FRONTEND_WEB_CONFIG_KEY, frontendWebRunning, frontendWebURL, webRunning）、
//       core/theme.js（NETWORK_CONFIG_KEY）、core/utils.js（showToast）、core/apicall.js（api）
// ============================================================

import { NETWORK_CONFIG_KEY } from '../core/theme.js';
import { FRONTEND_WEB_CONFIG_KEY, store } from '../core/state.js';
import { showToast, showApiError, copyToClipboard } from '../core/utils.js';
import { api } from '../core/apicall.js';

// ============================
// 网络配置 — localStorage 读写
// ============================

/** 端口归一化：非法值（空 / 0 / 非数字 / 超范围）一律回退默认，避免界面显示 0 或 NaN。
 *  背景：用户反馈"端口没保存、每次打开显示 0"——存进去的可能是 0/空串这类无效值，
 *  这里统一在读取时纠正，写入时也用它把关。 */
function normalizePort(value, fallback) {
    const n = parseInt(String(value === undefined || value === null ? '' : value).trim(), 10);
    if (!Number.isFinite(n) || n <= 0 || n > 65535) return fallback;
    return String(n);
}

/** 从 localStorage 读取网络配置 */
export function getNetworkConfig() {
    try {
        const saved = JSON.parse(localStorage.getItem(NETWORK_CONFIG_KEY) || '{}');
        // 迁移：老版本（v1）用 servicePort === '0' 表示「随机端口」。本版本已移除随机端口，
        // 若不处理，界面会直接显示 0（'0' 是真值字符串，不会被 || 兜底）。这里统一按默认端口处理。
        const rawPort = String(saved.servicePort === undefined || saved.servicePort === null ? '' : saved.servicePort).trim();
        const migratedPort = rawPort === '0' ? '' : rawPort;
        return {
            serviceHost: (saved.serviceHost || '127.0.0.1').trim(),
            servicePort: normalizePort(migratedPort, '49374'),
            // servicePassword：OpenCode v2 服务强制 Basic 认证。启动服务时会用此口令
            // 执行 `opencode service set password`。默认 12345678。
            servicePassword: (saved.servicePassword || '12345678').trim(),
            proxyEnabled: !!saved.proxyEnabled,
            proxyHost: (saved.proxyHost || '127.0.0.1').trim(),
            proxyPort: (saved.proxyPort || '7897').toString().trim(),
        };
    } catch (_) {
        return { serviceHost: '127.0.0.1', servicePort: '49374', servicePassword: '12345678', proxyEnabled: false, proxyHost: '127.0.0.1', proxyPort: '7897' };
    }
}

/** 保存网络配置到 localStorage */
export function saveNetworkConfig(config) {
    const next = {
        serviceHost: (config.serviceHost || '127.0.0.1').trim(),
        servicePort: normalizePort(config.servicePort, '49374'),
        servicePassword: (config.servicePassword || '12345678').trim(),
        proxyEnabled: !!config.proxyEnabled,
        proxyHost: (config.proxyHost || '127.0.0.1').trim(),
        proxyPort: (config.proxyPort || '7897').toString().trim(),
    };
    localStorage.setItem(NETWORK_CONFIG_KEY, JSON.stringify(next));
    updateProxyButton();
    return next;
}

/** 从 localStorage 读取页面 Web 服务配置 */
export function getFrontendWebConfig() {
    try {
        const saved = JSON.parse(localStorage.getItem(FRONTEND_WEB_CONFIG_KEY) || '{}');
        return {
            host: (saved.host || '127.0.0.1').trim(),
            port: normalizePort(saved.port, '8081'),
        };
    } catch (_) {
        return { host: '127.0.0.1', port: '8081' };
    }
}

/** 保存页面 Web 服务配置到 localStorage */
export function saveFrontendWebConfig(config) {
    const next = {
        host: (config.host || '127.0.0.1').trim(),
        port: normalizePort(config.port, '8081'),
    };
    localStorage.setItem(FRONTEND_WEB_CONFIG_KEY, JSON.stringify(next));
    return next;
}

/** 将 Web 服务配置加载到弹窗输入框
 *  监听地址优先使用后端探测的本机局域网 IPv4（启动时已探测并缓存）；
 *  后端未探测到时回退到 localStorage 中保存的监听地址。 */
export async function loadFrontendWebConfigToInputs() {
    const hostEl = document.getElementById('frontendWebHost');
    const portEl = document.getElementById('frontendWebPort');
    const config = getFrontendWebConfig();
    const lan = await ensureLanIPv4();
    if (hostEl) hostEl.value = lan || config.host;
    if (portEl) portEl.value = config.port;
    return config;
}

/** 从弹窗输入框读取并持久化 Web 服务配置 */
export function persistFrontendWebConfigFromInputs() {
    const host = document.getElementById('frontendWebHost')?.value.trim() || '127.0.0.1';
    const port = document.getElementById('frontendWebPort')?.value.trim() || '8081';
    return saveFrontendWebConfig({ host, port });
}

/** 复制页面 Web 服务访问地址到剪贴板 */
export async function copyFrontendWebUrl() {
    if (!store.frontendWebURL) {
        showToast('当前没有可复制的访问地址', 'warning');
        return;
    }
    try {
        await copyToClipboard(store.frontendWebURL);
        showToast('访问地址已复制', 'success');
    } catch (e) {
        showApiError('复制失败: ', e);
    }
}

/** 构造代理 URL */
export function proxyUrl(config = getNetworkConfig()) {
    if (!config.proxyHost || !config.proxyPort) return '';
    return `http://${config.proxyHost}:${config.proxyPort}`;
}

/** 更新网络配置弹窗中的预览文本 */
export function updateProxyPreview() {
    const proxyEnabled = document.getElementById('proxyEnabled')?.checked;
    const proxyHost = document.getElementById('proxyHost')?.value.trim() || '127.0.0.1';
    const proxyPort = document.getElementById('proxyPort')?.value.trim() || '7897';
    const serviceHost = document.getElementById('serviceHost')?.value.trim() || '127.0.0.1';
    const servicePort = document.getElementById('servicePort')?.value.trim() || '49374';
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

/** 更新代理按钮的样式和提示 */
export function updateProxyButton() {
    const btn = document.getElementById('btnProxySettings');
    if (!btn) return;
    const config = getNetworkConfig();
    btn.classList.toggle('active', config.proxyEnabled);
    btn.title = store.webRunning ? '配置（服务运行期间仅可查看）' : (config.proxyEnabled ? `代理已启用: ${proxyUrl(config)}` : '配置');
}

/** 显示网络配置弹窗 */
export function showProxyModal() {
    const config = getNetworkConfig();
    const serviceHostEl = document.getElementById('serviceHost');
    const servicePortEl = document.getElementById('servicePort');
    const proxyEnabledEl = document.getElementById('proxyEnabled');
    const proxyHostEl = document.getElementById('proxyHost');
    const proxyPortEl = document.getElementById('proxyPort');
    const servicePwdEl = document.getElementById('servicePassword');
    const actionsEl = document.getElementById('proxyModalActions');
    serviceHostEl.value = config.serviceHost;
    servicePortEl.value = config.servicePort;
    if (servicePwdEl) servicePwdEl.value = config.servicePassword || '';
    proxyEnabledEl.checked = config.proxyEnabled;
    proxyHostEl.value = config.proxyHost;
    proxyPortEl.value = config.proxyPort;
    const readonly = store.webRunning;
    serviceHostEl.readOnly = readonly;
    servicePortEl.readOnly = readonly;
    // 口令是"启动服务时设置的密码"（启动时写入 service.json、由 opencode 进程读取），
    // 运行中修改不生效（需重启服务），因此服务运行期间与 host/port 一并置灰。
    if (servicePwdEl) servicePwdEl.readOnly = readonly;
    // 显示明文按钮（复用 provider 的 .btn-eye 交互）
    const pwdToggleEl = document.getElementById('btnToggleServicePwd');
    // 只读期间同步禁用"显示明文"按钮（与口令输入框状态保持一致）
    if (pwdToggleEl) pwdToggleEl.disabled = readonly;
    if (pwdToggleEl && !pwdToggleEl.dataset.bound) {
        pwdToggleEl.dataset.bound = '1';
        pwdToggleEl.addEventListener('click', function() {
            const input = document.getElementById('servicePassword');
            if (!input) return;
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            pwdToggleEl.textContent = show ? '🙈' : '👁';
            pwdToggleEl.title = show ? '隐藏明文' : '显示明文';
        });
    }
    proxyEnabledEl.disabled = readonly;
    proxyHostEl.readOnly = readonly;
    proxyPortEl.readOnly = readonly;
    // 只读（服务运行中）：整个操作区隐藏——保存不可用、也不再显示「关闭」按钮（点弹窗遮罩即可关闭）；
    // 编辑态显示「取消 + 保存」。
    if (actionsEl) actionsEl.style.display = readonly ? 'none' : '';
    if (readonly) {
        serviceHostEl.style.opacity = '0.6';
        servicePortEl.style.opacity = '0.6';
        if (servicePwdEl) servicePwdEl.style.opacity = '0.6';
        proxyHostEl.style.opacity = '0.6';
        proxyPortEl.style.opacity = '0.6';
    } else {
        serviceHostEl.style.opacity = '';
        servicePortEl.style.opacity = '';
        if (servicePwdEl) servicePwdEl.style.opacity = '';
        proxyHostEl.style.opacity = '';
        proxyPortEl.style.opacity = '';
    }
    updateProxyPreview();
    document.getElementById('proxyModal').style.display = 'flex';
}

/** 隐藏网络配置弹窗 */
export function hideProxyModal() {
    document.getElementById('proxyModal').style.display = 'none';
}

/** 应用网络配置 */
export function applyProxyConfig() {
    const serviceHost = document.getElementById('serviceHost').value.trim() || '127.0.0.1';
    const servicePort = document.getElementById('servicePort').value.trim() || '49374';
    const proxyEnabled = document.getElementById('proxyEnabled').checked;
    const proxyHost = document.getElementById('proxyHost').value.trim() || '127.0.0.1';
    const proxyPort = document.getElementById('proxyPort').value.trim() || '7897';
    // 服务访问口令（OpenCode v2 服务强制 Basic 认证）
    const pwdEl = document.getElementById('servicePassword');
    const servicePassword = pwdEl ? pwdEl.value.trim() : '';
    if (!/^\d{1,5}$/.test(servicePort)) {
        showToast('服务端口必须是数字', 'error');
        return;
    }
    if (proxyEnabled && !/^\d{1,5}$/.test(proxyPort)) {
        showToast('代理端口必须是数字', 'error');
        return;
    }
    saveNetworkConfig({ serviceHost, servicePort, servicePassword, proxyEnabled, proxyHost, proxyPort });
    hideProxyModal();
}

// ============================
// 页面 Web 服务 — frontend-web 启停 & 状态
// ============================

// 本机局域网 IPv4 缓存（软件启动时探测；用于监听地址默认值与二维码）
let lanIPv4Cache = null;

/** 探测并缓存本机局域网 IPv4（force=true 强制重新探测）。失败时缓存为空串。 */
export async function ensureLanIPv4(force) {
    if (!force && lanIPv4Cache !== null) return lanIPv4Cache;
    try {
        const ip = await api.GetLanIPv4();
        lanIPv4Cache = ip || '';
    } catch (e) {
        lanIPv4Cache = '';
    }
    return lanIPv4Cache;
}

/** 检测页面 Web 服务是否正在运行 */
export async function checkFrontendWebStatus() {
    try {
        const config = persistFrontendWebConfigFromInputs();
        const host = config.host || '127.0.0.1';
        const port = parseInt(config.port, 10) || 8081;
        const result = await api.GetFrontendWebStatus(host, port);
        store.frontendWebRunning = !!result.running;
        store.frontendWebURL = result.url || '';
    } catch (e) {
        store.frontendWebRunning = false;
        store.frontendWebURL = '';
    }
    renderFrontendWebStatus();
}

/** 渲染页面 Web 服务状态 UI */
export function renderFrontendWebStatus() {
    const statusEl = document.getElementById('frontendWebStatus');
    const urlEl = document.getElementById('frontendWebUrl');
    const btnToggle = document.getElementById('btnToggleFrontendWeb');
    const btnCopy = document.getElementById('btnCopyFrontendWebUrl');
    const btnToolbar = document.getElementById('btnFrontendWebConfig');
    const toolbarDot = document.getElementById('frontendWebToolbarDot');
    if (!statusEl || !urlEl || !btnToggle || !btnCopy || !btnToolbar || !toolbarDot) return;
    statusEl.textContent = store.frontendWebRunning ? '运行中' : '未启动';
    statusEl.classList.toggle('frontend-web-status-running', store.frontendWebRunning);
    urlEl.textContent = store.frontendWebURL || '--';
    urlEl.title = store.frontendWebURL || '';
    urlEl.href = store.frontendWebURL || '#';
    urlEl.classList.toggle('disabled', !store.frontendWebURL);
    // 二合一按钮（参照 OpenCode 启停按钮）：运行态显示「停止」（danger 样式），停止态显示「启动」（主操作样式）
    if (store.frontendWebRunning) {
        btnToggle.disabled = false;
        btnToggle.dataset.mode = 'stop';
        btnToggle.textContent = '■ 停止 Web服务';
        btnToggle.classList.add('btn-danger-outline');
        btnToggle.classList.remove('btn-primary');
    } else {
        btnToggle.disabled = false;
        btnToggle.dataset.mode = 'start';
        btnToggle.textContent = '▶ 启动 Web服务';
        btnToggle.classList.add('btn-primary');
        btnToggle.classList.remove('btn-danger-outline');
    }
    btnCopy.disabled = !store.frontendWebURL;
    toolbarDot.classList.toggle('on', store.frontendWebRunning);
    toolbarDot.classList.toggle('off', !store.frontendWebRunning);
    btnToolbar.title = store.frontendWebRunning && store.frontendWebURL ? `Web服务运行中: ${store.frontendWebURL}` : 'Web服务';
    // 与状态同步刷新二维码（fire-and-forget，内部自行探测局域网地址）
    renderFrontendWebQr();
}

/** 计算二维码应指向的访问地址：
 *  host 已是私有局域网 IP 时直接使用；否则用启动时探测的本机局域网 IP 替换（手机需要局域网可访问地址）。
 *  端口为空时按 8081 处理；探测失败且 host 非局域网时返回空串（由调用方提示）。 */
async function resolveFrontendWebQrUrl(host, port) {
    const p = port || '8081';
    const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host || '');
    if (isPrivate) return 'http://' + host + ':' + p;
    const lan = await ensureLanIPv4();
    return lan ? 'http://' + lan + ':' + p : '';
}

/** 渲染 Web 服务二维码（常驻）：
 *  - 未运行：直接用弹窗输入框的监听地址/端口生成预览二维码，提示「启动服务后生效」；
 *  - 运行中：用实际生效的访问地址；监听本机/通配地址时给黄色提示（建议改 0.0.0.0）。
 *  启动/停止服务后由 renderFrontendWebStatus 触发重新生成。 */
async function renderFrontendWebQr() {
    const box = document.getElementById('frontendWebQrBox');
    const hint = document.getElementById('frontendWebQrHint');
    if (!box || !hint) return;
    hint.classList.remove('warn');
    const running = !!(store.frontendWebRunning && store.frontendWebURL);
    let host = '', port = '';
    if (running) {
        // 运行中：以实际生效的访问地址为准
        try {
            const u = new URL(store.frontendWebURL);
            host = u.hostname; port = u.port;
        } catch (e) { /* 解析失败按不可用处理 */ }
    } else {
        // 未运行：用弹窗输入框当前值（弹窗未打开过时为空，将走"探测 IP + 默认端口"分支）
        host = (document.getElementById('frontendWebHost')?.value || '').trim();
        port = (document.getElementById('frontendWebPort')?.value || '').trim();
    }
    if (typeof QRCode === 'undefined') {
        box.innerHTML = '<div class="frontend-web-qr-empty">二维码库未加载</div>';
        return;
    }
    const qrUrl = await resolveFrontendWebQrUrl(host, port);
    if (!qrUrl) {
        box.innerHTML = '<div class="frontend-web-qr-empty">未能探测到局域网地址<br>请检查网络连接</div>';
        hint.textContent = running ? '手机扫码打开此页面' : '启动服务后生效';
        return;
    }
    const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host || '');
    if (!running) {
        hint.textContent = '启动服务后生效';
    } else if (!isPrivate) {
        // 运行中但监听本机/通配地址：二维码已用探测的局域网 IP，提示需改为对外监听
        hint.textContent = '提示：服务监听 ' + (host || '本机') + '，手机可能无法访问；建议将监听地址改为 0.0.0.0 后重启';
        hint.classList.add('warn');
    } else {
        hint.textContent = '手机扫码打开此页面';
    }
    // 幂等刷新：清空容器后重建实例（简单可靠，避免多实例叠加）
    box.innerHTML = '';
    new QRCode(box, { text: qrUrl, width: 176, height: 176, correctLevel: QRCode.CorrectLevel.M });
}

/** 显示页面 Web 服务配置弹窗 */
export function showFrontendWebModal() {
    const modal = document.getElementById('frontendWebModal');
    if (!modal) return;
    loadFrontendWebConfigToInputs();
    modal.style.display = 'flex';
    checkFrontendWebStatus();
}

/** 关闭页面 Web 服务配置弹窗 */
export function closeFrontendWebModal() {
    const modal = document.getElementById('frontendWebModal');
    if (modal) modal.style.display = 'none';
}

/** 启动页面 Web 服务 */
export async function startFrontendWeb() {
    const config = persistFrontendWebConfigFromInputs();
    const host = config.host;
    const portText = config.port;
    if (!/^\d{1,5}$/.test(portText)) {
        showToast('Web服务端口必须是数字', 'error');
        return;
    }
    const port = parseInt(portText, 10) || 8081;
    try {
        const result = await api.StartFrontendWeb(port, host);
        store.frontendWebRunning = !!result.running;
        store.frontendWebURL = result.url || '';
        // 状态刷新会同步重新生成二维码（使用实际生效的地址）
        renderFrontendWebStatus();
        if (store.frontendWebRunning) {
            showToast('Web服务已启动', 'success');
        } else if (result.error) {
            showToast('Web服务启动失败: ' + result.error, 'error');
        }
    } catch (e) {
        showApiError('Web服务启动失败: ', e);
    }
    checkFrontendWebStatus();
}

/** 停止页面 Web 服务 */
export async function stopFrontendWeb() {
    try {
        await api.StopFrontendWeb();
        store.frontendWebRunning = false;
        store.frontendWebURL = '';
        renderFrontendWebStatus();
        showToast('Web服务已停止', 'info');
    } catch (e) {
        showApiError('Web服务停止失败: ', e);
    }
    checkFrontendWebStatus();
}

/** 启动/停止二合一开关（参照 OpenCode 启停按钮模式）：
 *  按当前运行状态分派到 startFrontendWeb / stopFrontendWeb；
 *  在途禁用按钮并显示进度文案，结束后由 renderFrontendWebStatus 统一恢复文案与样式。 */
export async function toggleFrontendWeb() {
    const btn = document.getElementById('btnToggleFrontendWeb');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const wasRunning = !!store.frontendWebRunning;
    btn.textContent = wasRunning ? '⏳ 停止中...' : '⏳ 启动中...';
    if (wasRunning) {
        await stopFrontendWeb();
    } else {
        await startFrontendWeb();
    }
    renderFrontendWebStatus();
}
