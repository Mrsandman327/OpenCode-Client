// ============================================================
// OpenCode 管理中心 - 命令面板（输入 / 触发快捷命令选择）
// 依赖：core/state.js（webRunning, currentSessionId）、core/utils.js（escapeHtml, showToast, getCachedMessages）、
//       core/apicall.js（api）、chat/session.js（loadMessages）
// ============================================================

import { api } from '../core/apicall.js';
import { store } from '../core/state.js';
import { escapeHtml, showToast, getCachedMessages } from '../core/utils.js';
import { loadMessages } from './session.js';

let cmdPaletteItems = [];
let cmdPaletteLoaded = false;
let cmdPaletteIndex = -1;
let cmdPaletteVisible = false;

const FIXED_COMMANDS = [
    { name: 'summarize', description: '压缩会话上下文', source: 'fixed' },
    { name: 'revert',    description: '撤销最后消息（需 Git 仓库）', source: 'fixed' },
    { name: 'unrevert',  description: '重做撤销（需 Git 仓库）', source: 'fixed' },
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
