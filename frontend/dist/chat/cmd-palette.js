// ============================================================
// OpenCode 管理中心 - 命令面板（输入 / 触发快捷命令选择）
// 依赖：core/state.js（webRunning, currentSessionId）、core/utils.js（escapeHtml, showToast, getCachedMessages）、
//       core/apicall.js（api）、chat/session.js（loadMessages）
// ============================================================

import { api } from '../core/apicall.js';
import { store } from '../core/state.js';
import { escapeHtml, showToast, getCachedMessages, messageText } from '../core/utils.js';
import { loadMessages, loadOlderMessages, isSessionLoadedAll } from './session.js';
import { openSessionTab } from './tabs.js';
import { buildTree } from './tree.js';

let cmdPaletteItems = [];
let cmdPaletteLoaded = false;
let cmdPaletteIndex = -1;
let cmdPaletteVisible = false;

const FIXED_COMMANDS = [
    { name: 'summarize', description: '压缩会话上下文', source: 'fixed' },
    { name: 'revert',    description: '撤销最后消息（需 Git 仓库）', source: 'fixed' },
    { name: 'unrevert',  description: '重做撤销（需 Git 仓库）', source: 'fixed' },
    { name: 'fork',      description: '从消息创建新会话（分叉）', source: 'fixed' },
];

const cmdPaletteEl = document.getElementById('ocCmdPalette');
const cmdPaletteScroll = cmdPaletteEl.querySelector('.oc-cmd-palette-scroll');
const cmdInputEl = document.getElementById('ocPrompt');

// ============================
// 数据加载
// ============================

export async function loadCmdPalette() {
    if (cmdPaletteLoaded) return;
    try {
        cmdPaletteItems = await api.OpenCodeCall('GET', '/command') || [];
    } catch (_) {
        cmdPaletteItems = [];
    }
    // 合并固定命令（排前面）
    cmdPaletteItems = [...FIXED_COMMANDS, ...cmdPaletteItems];
    cmdPaletteLoaded = true;
}

export function filterCmdItems(query) {
    if (!query) return cmdPaletteItems;
    const q = query.toLowerCase();
    return cmdPaletteItems.filter(item =>
        item.name.toLowerCase().includes(q)
    );
}

// ============================
// 显示/隐藏
// ============================

export async function showCmdPalette() {
    await loadCmdPalette();
    cmdPaletteVisible = true;
    cmdPaletteIndex = 0;
    const query = cmdInputEl.value.slice(1);
    renderCmdPalette(query);
    cmdPaletteEl.style.display = 'block';
}

export function hideCmdPalette() {
    cmdPaletteVisible = false;
    cmdPaletteIndex = -1;
    cmdPaletteEl.style.display = 'none';
}

// ============================
// 渲染
// ============================

export function renderCmdPalette(query) {
    const filtered = filterCmdItems(query);
    if (cmdPaletteIndex >= filtered.length) cmdPaletteIndex = Math.max(0, filtered.length - 1);

    if (!filtered.length) {
        cmdPaletteScroll.innerHTML = '<div class="oc-cmd-empty">无匹配命令</div>';
        return;
    }

    let html = '';
    filtered.forEach((item, i) => {
        const active = i === cmdPaletteIndex ? ' active' : '';
        const sourceTag = item.source === 'fixed' ? '<span class="oc-cmd-source fixed">内置</span>' : `<span class="oc-cmd-source">${escapeHtml(item.source || '')}</span>`;
        html += `<div class="oc-cmd-item${active}" data-cmd="${escapeHtml(item.name)}" data-source="${escapeHtml(item.source || '')}" data-idx="${i}">
            <span class="oc-cmd-name">/${escapeHtml(item.name)}</span>
            <span class="oc-cmd-desc">${escapeHtml(item.description || '')}</span>
            ${sourceTag}
        </div>`;
    });

    cmdPaletteScroll.innerHTML = html;

    // 点击选中（mousedown 避免 blur 导致焦点丢失）
    cmdPaletteScroll.querySelectorAll('.oc-cmd-item').forEach(el => {
        el.addEventListener('mousedown', (e) => {
            e.preventDefault();
            selectCmdItem(el.dataset.cmd, el.dataset.source);
        });
    });

    // 滚动到高亮项
    const active = cmdPaletteScroll.querySelector('.oc-cmd-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
}

// ============================
// 键盘交互（捕获阶段，优先于 main.js 的 Enter 发送逻辑）
// ============================

cmdInputEl.addEventListener('keydown', (e) => {
    if (!cmdPaletteVisible) return;

    switch (e.key) {
        case 'Escape':
            e.preventDefault();
            hideCmdPalette();
            break;
        case 'ArrowDown':
            e.preventDefault();
            navigateCmdPalette('down');
            break;
        case 'ArrowUp':
            e.preventDefault();
            navigateCmdPalette('up');
            break;
        case 'Enter':
            e.preventDefault();
            e.stopImmediatePropagation();
            selectCmdPalette();
            break;
        case 'Tab':
            e.preventDefault();
            e.stopImmediatePropagation();
            selectCmdPalette();
            break;
    }
}, true); // capture = true，先于 main.js 的绑定

// ============================
// 输入过滤
// ============================

cmdInputEl.addEventListener('input', () => {
    const value = cmdInputEl.value;
    if (value.startsWith('/') && !value.slice(1).includes(' ')) {
        if (!cmdPaletteVisible) {
            showCmdPalette();
        } else {
            renderCmdPalette(value.slice(1));
        }
    } else {
        hideCmdPalette();
    }
});

// 点击面板外关闭（click 优于 blur，不会在点击面板时先失去焦点）
document.addEventListener('click', (e) => {
    if (!cmdPaletteVisible) return;
    if (!cmdPaletteEl.contains(e.target) && e.target !== cmdInputEl) {
        hideCmdPalette();
    }
});

// ============================
// 导航与选中
// ============================

export function navigateCmdPalette(direction) {
    const filtered = filterCmdItems(cmdInputEl.value.slice(1));
    if (!filtered.length) return;

    if (direction === 'up') {
        cmdPaletteIndex = (cmdPaletteIndex - 1 + filtered.length) % filtered.length;
    } else {
        cmdPaletteIndex = (cmdPaletteIndex + 1) % filtered.length;
    }
    renderCmdPalette(cmdInputEl.value.slice(1));
}

export function selectCmdPalette() {
    const active = cmdPaletteScroll.querySelector('.oc-cmd-item.active');
    if (active) {
        selectCmdItem(active.dataset.cmd, active.dataset.source);
    }
}

export function selectCmdItem(cmdName, source) {
    if (source === 'fixed') {
        executeFixedCmd(cmdName);
    } else {
        insertCmdToPrompt(cmdName);
    }
}

export async function executeFixedCmd(cmdName) {
    if (!store.webRunning || !store.currentSessionId) {
        showToast('请先启动服务并选择会话', 'error');
        return;
    }
    const sid = store.currentSessionId;
    hideCmdPalette();
    showToast(`执行 /${cmdName}...`, 'info');

    try {
        switch (cmdName) {
            case 'summarize': {
                // 从最后一条 assistant 消息中提取 provider/model
                let providerID = '', modelID = '';
                const list = getCachedMessages(sid);
                for (let i = list.length - 1; i >= 0; i--) {
                    const info = list[i].info || list[i];
                    if (info.role === 'assistant' && info.modelID) {
                        modelID = info.modelID;
                        providerID = info.providerID || '';
                        break;
                    }
                }
                const body = {};
                if (providerID) body.providerID = providerID;
                if (modelID) body.modelID = modelID;
                await api.OpenCodeCall('POST', `/session/${encodeURIComponent(sid)}/summarize`, body);
                showToast('会话上下文已压缩', 'success');
                break;
            }
            case 'revert': {
                // 撤销最后一条 assistant 消息
                const list = getCachedMessages(sid);
                let messageID = '';
                for (let i = list.length - 1; i >= 0; i--) {
                    const info = list[i].info || list[i];
                    if (info.role === 'assistant') {
                        messageID = info.id || '';
                        break;
                    }
                }
                if (!messageID) { showToast('未找到可撤销的消息', 'error'); return; }
                await api.OpenCodeCall('POST', `/session/${encodeURIComponent(sid)}/revert`, { messageID });
                showToast('已撤销最后消息', 'success');
                loadMessages();
                break;
            }
            case 'unrevert':
                await api.OpenCodeCall('POST', `/session/${encodeURIComponent(sid)}/unrevert`);
                showToast('已重做撤销', 'success');
                loadMessages();
                break;
            case 'fork':
                // 弹出消息选择（选一条用户消息作为分叉点），成功后新建 tab + 刷新树
                await showForkMessagePicker(sid);
                break;
        }
    } catch (e) {
        showToast(`/${cmdName} 失败: ` + (e.message || e), 'error');
    }
    cmdInputEl.value = '';
}

export function insertCmdToPrompt(cmdName) {
    cmdInputEl.value = '/' + cmdName + ' ';
    cmdInputEl.focus();
    hideCmdPalette();
}

// ============================
// fork 会话：选择用户消息作为分叉点，创建新会话
// ============================

/** 弹窗当前 fork 的会话 id */
let forkSessionId = '';
/** 弹窗已加载的用户消息 */
let forkMessages = [];

/** 消息时间 → HH:MM */
function forkTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

/** 渲染消息列表（含搜索过滤），最新的在前 */
function renderForkList(query) {
    const listEl = document.getElementById('forkMsgList');
    if (!listEl) return;
    const q = (query || '').toLowerCase();
    const items = forkMessages.filter(m => {
        if (!q) return true;
        return messageText(m).toLowerCase().includes(q);
    }).reverse();
    if (!items.length) {
        listEl.innerHTML = '<div class="fork-empty">无匹配用户消息</div>';
        return;
    }
    listEl.innerHTML = items.map(m => {
        const info = m.info || m;
        const msgId = escapeHtml(info.id || '');
        const time = forkTime(info.time?.created || 0);
        const text = escapeHtml(messageText(m).replace(/\s+/g, ' ').trim() || '（空）');
        return `<div class="fork-msg-row" data-id="${msgId}">
            <span class="fork-msg-text">${text}</span>
            <span class="fork-msg-time">${time}</span>
        </div>`;
    }).join('');
    listEl.querySelectorAll('.fork-msg-row').forEach(row => {
        row.addEventListener('click', () => forkFromMessage(row.dataset.id));
    });
}

/** 从指定消息分叉：POST fork → 打开新 tab + 刷新树 */
async function forkFromMessage(messageID) {
    if (!forkSessionId || !messageID) return;
    // 先保存 id：hideForkPicker() 会清空 forkSessionId，避免路径变成 /session//fork
    const sid = forkSessionId;
    hideForkPicker();
    let raw = null;
    try {
        showToast('正在分叉...', 'info');
        // 直接走 OpenCodeAPI，便于诊断非 JSON 响应（HTML/错误页）
        raw = await api.OpenCodeAPI('POST', `/session/${encodeURIComponent(sid)}/fork`, JSON.stringify({ messageID }));
        if (!raw || !raw.success) {
            throw new Error((raw && (raw.error || `HTTP ${raw.status}`)) || '未知错误');
        }
        if (!raw.body) throw new Error('空响应');
        const result = JSON.parse(raw.body);
        if (result && result.id) {
            openSessionTab(result.id, result.title || result.id);
            await buildTree();
            showToast('已分叉新会话', 'success');
        } else {
            showToast('分叉失败：未返回新会话', 'error');
        }
    } catch (e) {
        // 诊断：追加请求路径、响应状态码与 body 片段，便于定位 HTML/错误页响应
        const reqPath = `/session/${sid}/fork`;
        const status = raw ? ` [status=${raw.status}]` : '';
        const snippet = raw && raw.body && typeof raw.body === 'string'
            ? ` body=${raw.body.slice(0, 120)}`
            : '';
        console.error('[fork] 请求路径:', reqPath, 'messageID:', messageID, 'raw:', raw, '错误:', e);
        showToast('分叉失败: ' + (e.message || e) + status + snippet + ` | path=${reqPath}`, 'error');
    }
}

/** 打开 fork 消息选择弹窗（只列用户消息，基于已加载 + 可加载更早） */
export async function showForkMessagePicker(sessionID) {
    const modal = document.getElementById('forkModal');
    if (!modal) return;
    forkSessionId = sessionID;
    forkMessages = getCachedMessages(sessionID).filter(m => (m.info?.role || m.role) === 'user');
    if (!forkMessages.length) {
        showToast('当前会话暂无用户消息可分叉', 'warning');
        return;
    }
    const moreBtn = document.getElementById('forkMoreBtn');
    if (moreBtn) moreBtn.style.display = isSessionLoadedAll(sessionID) ? 'none' : '';
    const search = document.getElementById('forkSearchInput');
    if (search) search.value = '';
    renderForkList('');
    modal.style.display = 'flex';
}

/** 关闭 fork 弹窗 */
export function hideForkPicker() {
    const modal = document.getElementById('forkModal');
    if (modal) modal.style.display = 'none';
    forkSessionId = '';
    forkMessages = [];
}

/** 初始化 fork 弹窗事件（模块加载时绑定） */
(function bindForkModalEvents() {
    const close = document.getElementById('btnForkClose');
    if (close) close.addEventListener('click', hideForkPicker);
    const search = document.getElementById('forkSearchInput');
    if (search) search.addEventListener('input', () => renderForkList(search.value));
    const more = document.getElementById('forkMoreBtn');
    if (more) more.addEventListener('click', async () => {
        if (!forkSessionId) return;
        await loadOlderMessages(forkSessionId);
        // 刷新消息列表
        forkMessages = getCachedMessages(forkSessionId).filter(m => (m.info?.role || m.role) === 'user');
        more.style.display = isSessionLoadedAll(forkSessionId) ? 'none' : '';
        const s = document.getElementById('forkSearchInput');
        renderForkList(s ? s.value : '');
    });
    const modal = document.getElementById('forkModal');
    if (modal) modal.addEventListener('click', e => {
        if (e.target === modal) hideForkPicker();
    });
})();
