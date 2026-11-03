// ============================================================
// 配置弹窗：界面外观 / Web 服务 / 快捷方式 / 常用命令 / 关于
// 依赖：core/theme.js（主题）、core/apicall.js（命令数据/版本）、
//       chat/config.js（复用现有 Web 服务输入框与状态逻辑）
// ============================================================

import { getTheme, setTheme } from '../core/theme.js';
import { api } from '../core/apicall.js';
import { escapeHtml, copyToClipboard } from '../core/utils.js';
import { store } from '../core/state.js';
import { loadFrontendWebConfigToInputs, checkFrontendWebStatus, toggleFrontendWeb, loadProxyConfigToInputs } from '../chat/config.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let configCommands = null;
let configCommandsLoading = false;
let configCommandsError = '';
let configCmdTab = 'cli';
let configApiDoc = null;
let configApiDocLoading = false;
let configApiDocError = '';
let aboutVersionLoaded = false;
let aboutVersionLoading = false;

function renderThemeSelection() {
    const theme = getTheme();
    $$('.cfg-theme-card').forEach(card => {
        card.classList.toggle('selected', card.dataset.cfgTheme === theme);
    });
}

function switchSection(name) {
    $$('.cfg-nav-item').forEach(item => item.classList.toggle('active', item.dataset.cfgSection === name));
    $$('.cfg-section').forEach(sec => sec.classList.toggle('active', sec.dataset.cfgSection === name));
    const scroll = $('.cfg-scroll');
    if (scroll) scroll.scrollTop = 0;

    if (name === 'network') {
        loadProxyConfigToInputs();
    } else if (name === 'web') {
        loadFrontendWebConfigToInputs().then(() => checkFrontendWebStatus()).then(() => {
            refreshWebOpen();
            syncWebSwitch();
        });
    } else if (name === 'commands') {
        loadConfigCommands();
    } else if (name === 'about') {
        loadAboutVersion();
    }
}

function refreshWebOpen() {
    const btn = $('#cfgWebOpen');
    const link = $('#frontendWebUrl');
    if (!btn || !link) return;
    const href = link.getAttribute('href') || '';
    btn.disabled = !/^https?:/i.test(href);
}

function syncWebSwitch() {
    const sw = $('#cfgWebSwitch');
    if (sw) sw.checked = !!store.frontendWebRunning;
}

function openConfigPanel(section) {
    const overlay = $('#configOverlay');
    const nav = $('#navConfig');
    if (!overlay) return;
    overlay.style.display = 'flex';
    nav?.classList.add('active');
    nav?.setAttribute('aria-expanded', 'true');
    renderThemeSelection();
    loadAboutVersion();
    // 每次打开都重新进入当前分区：网络分区需要重新读取 webRunning，
    // 否则上次留下的只读状态会一直保留。
    const activeItem = document.querySelector('.cfg-nav-item.active');
    const target = section || (activeItem && activeItem.dataset.cfgSection) || 'appearance';
    switchSection(target);
    $('#cfgClose')?.focus();
}

function closeConfigPanel() {
    const overlay = $('#configOverlay');
    const nav = $('#navConfig');
    if (!overlay) return;
    overlay.style.display = 'none';
    nav?.classList.remove('active');
    nav?.setAttribute('aria-expanded', 'false');
    nav?.focus();
}

async function loadAboutVersion() {
    if (aboutVersionLoaded || aboutVersionLoading) return;
    aboutVersionLoading = true;
    try {
        const version = await api.GetAppVersion();
        if (typeof version !== 'string' && typeof version !== 'number') return;
        const text = String(version).trim();
        if (!text) return;
        aboutVersionLoaded = true;
        const label = 'v' + text;
        const about = $('#cfgAboutVersion');
        const row = $('#cfgAboutVersionRow');
        const footer = $('#cfgFooterVersion');
        if (about) about.textContent = label;
        if (row) row.textContent = label;
        if (footer) footer.textContent = label;
    } catch (_) {
        // 保留 HTML 中的兜底版本号
    } finally {
        aboutVersionLoading = false;
    }
}

function commandName(cmd, isTui) {
    const name = String(cmd.name || '').trim();
    if (!name) return '';
    if (isTui) return name;
    return name.startsWith('opencode ') ? name : 'opencode ' + name;
}

function renderConfigCommands() {
    const box = $('#cfgCmdList');
    if (!box) return;

    if (configCmdTab === 'api') {
        if (configApiDocLoading) {
            box.innerHTML = '<div class="cfg-empty">正在加载 API 文档…</div>';
            return;
        }
        if (configApiDocError) {
            box.innerHTML = '<div class="cfg-empty">' + escapeHtml(configApiDocError) + '</div>';
            return;
        }
        if (!configApiDoc) {
            loadConfigApiDocs();
            box.innerHTML = '<div class="cfg-empty">正在加载 API 文档…</div>';
            return;
        }

        const entries = [];
        const paths = (configApiDoc && configApiDoc.paths) || {};
        Object.entries(paths).forEach(([path, methods]) => {
            Object.entries(methods || {}).forEach(([method, detail]) => {
                if (method === 'parameters' || !detail || typeof detail !== 'object') return;
                const upper = method.toUpperCase();
                if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(upper)) return;
                entries.push({
                    method: upper,
                    path,
                    desc: String(detail.summary || detail.description || detail.operationId || '').trim(),
                });
            });
        });

        box.innerHTML = entries.map(row =>
            '<div class="cfg-cmd-row">' +
                '<div class="cfg-cmd-main">' +
                    '<div class="cfg-cmd-name"><span class="cfg-method ' + row.method.toLowerCase() + '">' + row.method + '</span><code>' + escapeHtml(row.path) + '</code></div>' +
                    (row.desc ? '<div class="cfg-cmd-desc">' + escapeHtml(row.desc) + '</div>' : '') +
                '</div>' +
                '<button type="button" class="cfg-copy-btn" data-copy="' + escapeHtml(row.method + ' ' + row.path) + '">复制</button>' +
            '</div>'
        ).join('') || '<div class="cfg-empty">接口文档为空</div>';
        return;
    }

    if (configCommandsLoading) {
        box.innerHTML = '<div class="cfg-empty">正在加载命令…</div>';
        return;
    }
    if (configCommandsError) {
        box.innerHTML = '<div class="cfg-empty">' + escapeHtml(configCommandsError) + '</div>';
        return;
    }
    if (!Array.isArray(configCommands)) {
        box.innerHTML = '<div class="cfg-empty">打开后加载命令…</div>';
        return;
    }

    const isTui = configCmdTab === 'tui';
    const groups = configCommands.filter(group => !!group.isTui === isTui);
    let html = '';
    groups.forEach(group => {
        const cmds = Array.isArray(group.cmds) ? group.cmds : [];
        if (!cmds.length) return;
        html += '<div class="cfg-cmd-group-title">' + escapeHtml(group.title || '') + '</div>';
        cmds.forEach(cmd => {
            const name = commandName(cmd, isTui);
            if (!name) return;
            const desc = String(cmd.desc || '').trim();
            const options = String(cmd.options || '').trim();
            html += '<div class="cfg-cmd-row">' +
                '<div class="cfg-cmd-main">' +
                    '<div class="cfg-cmd-name"><code>' + escapeHtml(name) + '</code></div>' +
                    (desc ? '<div class="cfg-cmd-desc">' + escapeHtml(desc) + '</div>' : '') +
                    (options ? '<div class="cfg-cmd-opt">' + (isTui ? '快捷键：' : '参数：') + escapeHtml(options) + '</div>' : '') +
                '</div>' +
                '<button type="button" class="cfg-copy-btn" data-copy="' + escapeHtml(name) + '">复制</button>' +
            '</div>';
        });
    });
    box.innerHTML = html || '<div class="cfg-empty">暂无命令</div>';
}

async function loadConfigApiDocs() {
    if (configApiDocLoading || configApiDoc) {
        renderConfigCommands();
        return;
    }
    configApiDocLoading = true;
    configApiDocError = '';
    renderConfigCommands();
    try {
        const data = await api.OpenCodeCall('GET', '/openapi.json');
        configApiDoc = data || null;
        if (!configApiDoc) configApiDocError = '未获取到 API 文档';
    } catch (e) {
        configApiDocError = '加载 API 文档失败：' + (e && e.message ? e.message : '未知错误');
    } finally {
        configApiDocLoading = false;
        renderConfigCommands();
    }
}

async function loadConfigCommands() {
    if (configCommands || configCommandsLoading) {
        renderConfigCommands();
        return;
    }
    configCommandsLoading = true;
    configCommandsError = '';
    renderConfigCommands();
    try {
        const data = await api.GetCommands();
        configCommands = Array.isArray(data) ? data : [];
    } catch (e) {
        configCommandsError = '加载命令失败：' + (e && e.message ? e.message : '未知错误');
    } finally {
        configCommandsLoading = false;
        renderConfigCommands();
    }
}

export function initConfigPanel() {
    const overlay = $('#configOverlay');
    const nav = $('#navConfig');
    if (!overlay || !nav) return;

    nav.addEventListener('click', () => openConfigPanel());
    nav.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openConfigPanel();
        }
    });

    $('#cfgClose')?.addEventListener('click', closeConfigPanel);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeConfigPanel();
    });

    $$('.cfg-nav-item').forEach(item => {
        item.addEventListener('click', () => switchSection(item.dataset.cfgSection));
    });

    $$('.cfg-theme-card').forEach(card => {
        card.addEventListener('click', () => {
            setTheme(card.dataset.cfgTheme);
            renderThemeSelection();
        });
    });

    $('#cfgWebOpen')?.addEventListener('click', async () => {
        const link = $('#frontendWebUrl');
        const href = link?.getAttribute('href') || '';
        if (!/^https?:/i.test(href)) return;
        // 桌面端交给 Go 用系统默认浏览器打开；浏览器预览模式回退到新标签页
        try {
            await api.OpenURL(href);
        } catch (_) {
            window.open(href, '_blank');
        }
    });

    $('#cfgWebSwitch')?.addEventListener('change', async (e) => {
        const desired = e.target.checked;
        if (desired === !!store.frontendWebRunning) {
            syncWebSwitch();
            return;
        }
        const sw = e.target;
        sw.disabled = true;
        try {
            await toggleFrontendWeb();
        } finally {
            sw.disabled = false;
            refreshWebOpen();
            syncWebSwitch();
        }
    });

    // 启停逻辑完成后由 renderFrontendWebStatus 派发状态事件，统一同步开关与按钮
    window.addEventListener('oc-frontend-web-status', () => {
        refreshWebOpen();
        syncWebSwitch();
    });

    $$('.cfg-cmd-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            configCmdTab = tab.dataset.cfgTab;
            $$('.cfg-cmd-tab').forEach(t => t.classList.toggle('active', t === tab));
            if (configCmdTab === 'api' && !configApiDoc) {
                loadConfigApiDocs();
            } else {
                renderConfigCommands();
            }
        });
    });

    $('#cfgCmdList')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('.cfg-copy-btn');
        if (!btn) return;
        const text = btn.dataset.copy || '';
        if (!text) return;
        // 复制统一走 core/utils.js 的 copyToClipboard（成功 resolve / 失败 reject）
        let ok = false;
        try {
            await copyToClipboard(text);
            ok = true;
        } catch (_) {
            // 复制失败：按钮显示「复制失败」
        }
        const old = btn.textContent;
        btn.textContent = ok ? '已复制' : '复制失败';
        btn.classList.toggle('copied', ok);
        setTimeout(() => {
            btn.textContent = old;
            btn.classList.remove('copied');
        }, 1200);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.style.display !== 'none') {
            closeConfigPanel();
        }
    });

    // 主题可能由其他地方（如旧的全局按钮）变更，打开配置时重新同步
    renderThemeSelection();
}

// 模块加载时初始化（DOM 已就绪）
initConfigPanel();

// 供工具栏 WEB 服务按钮直接打开到对应分区
export { openConfigPanel };
