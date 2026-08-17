// ============================================================
// chat-config.js — 网络配置 & Web 服务配置
// 依赖：core/state.js（FRONTEND_WEB_CONFIG_KEY, frontendWebRunning, frontendWebURL, webRunning）、
//       core/theme.js（NETWORK_CONFIG_KEY）、core/utils.js（showToast）、core/apicall.js（api）
// ============================================================

import { NETWORK_CONFIG_KEY } from '../core/theme.js';
import { FRONTEND_WEB_CONFIG_KEY, store } from '../core/state.js';
import { showToast } from '../core/utils.js';
import { api } from '../core/apicall.js';

// ============================
// 网络配置 — localStorage 读写
// ============================

/** 从 localStorage 读取网络配置 */
export function getNetworkConfig() {
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

/** 保存网络配置到 localStorage */
export function saveNetworkConfig(config) {
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

/** 从 localStorage 读取页面 Web 服务配置 */
export function getFrontendWebConfig() {
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

/** 保存页面 Web 服务配置到 localStorage */
export function saveFrontendWebConfig(config) {
    const next = {
        host: (config.host || '127.0.0.1').trim(),
        port: (config.port || '8081').toString().trim(),
    };
    localStorage.setItem(FRONTEND_WEB_CONFIG_KEY, JSON.stringify(next));
    return next;
}

/** 将 Web 服务配置加载到弹窗输入框 */
export function loadFrontendWebConfigToInputs() {
    const hostEl = document.getElementById('frontendWebHost');
    const portEl = document.getElementById('frontendWebPort');
    const config = getFrontendWebConfig();
    if (hostEl) hostEl.value = config.host;
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
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(store.frontendWebURL);
        } else {
            const input = document.createElement('input');
            input.value = store.frontendWebURL;
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
    const saveBtn = document.getElementById('btnSaveProxy');
    const cancelBtn = document.getElementById('btnCancelProxy');
    serviceHostEl.value = config.serviceHost;
    servicePortEl.value = config.servicePort;
    proxyEnabledEl.checked = config.proxyEnabled;
    proxyHostEl.value = config.proxyHost;
    proxyPortEl.value = config.proxyPort;
    const readonly = store.webRunning;
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

/** 隐藏网络配置弹窗 */
export function hideProxyModal() {
    document.getElementById('proxyModal').style.display = 'none';
}

/** 应用网络配置 */
export function applyProxyConfig() {
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
// 页面 Web 服务 — frontend-web 启停 & 状态
// ============================

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
    const btnStart = document.getElementById('btnSaveFrontendWeb');
    const btnStop = document.getElementById('btnStopFrontendWeb');
    const btnCopy = document.getElementById('btnCopyFrontendWebUrl');
    const btnToolbar = document.getElementById('btnFrontendWebConfig');
    const toolbarDot = document.getElementById('frontendWebToolbarDot');
    if (!statusEl || !urlEl || !btnStart || !btnStop || !btnCopy || !btnToolbar || !toolbarDot) return;
    statusEl.textContent = store.frontendWebRunning ? '运行中' : '未启动';
    statusEl.classList.toggle('frontend-web-status-running', store.frontendWebRunning);
    urlEl.textContent = store.frontendWebURL || '--';
    urlEl.title = store.frontendWebURL || '';
    urlEl.href = store.frontendWebURL || '#';
    urlEl.classList.toggle('disabled', !store.frontendWebURL);
    btnStart.disabled = store.frontendWebRunning;
    btnStop.disabled = !store.frontendWebRunning;
    btnCopy.disabled = !store.frontendWebURL;
    toolbarDot.classList.toggle('on', store.frontendWebRunning);
    toolbarDot.classList.toggle('off', !store.frontendWebRunning);
    btnToolbar.title = store.frontendWebRunning && store.frontendWebURL ? `Web服务运行中: ${store.frontendWebURL}` : 'Web服务';
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
        store.frontendWebRunning = !!result.running;
        store.frontendWebURL = result.url || '';
        renderFrontendWebStatus();
        if (store.frontendWebRunning) {
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

/** 停止页面 Web 服务 */
export async function stopFrontendWeb() {
    const btn = document.getElementById('btnStopFrontendWeb');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '⏳ 停止中...';
    try {
        await api.StopFrontendWeb();
        store.frontendWebRunning = false;
        store.frontendWebURL = '';
        renderFrontendWebStatus();
        showToast('Web服务已停止', 'info');
    } catch (e) {
        showToast('Web服务停止失败: ' + (e.message || e), 'error');
    }
    btn.textContent = '停止服务';
    checkFrontendWebStatus();
}
