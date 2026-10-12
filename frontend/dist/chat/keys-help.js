// ============================================================
// OpenCode 管理中心 - 快捷键与命令速查面板
// ============================================================
// 为什么要有它：键位表（16 条）与面板固定命令此前只存在于 JS 数据结构里，
// 界面上没有任何入口能看到——用户不读源码就不知道有哪些快捷键。
// 本面板把两者渲染出来：
//   - 键位经 formatKeybind 平台化（Windows: Ctrl+Shift+S / macOS: ⌘⇧S）；
//   - 命令列表由命令面板在打开时传入（避免 keys-help 反向 import
//     cmd-palette 造成循环依赖）。
//
// 反漂移设计：数据直接来自实现本身（chat/keybinds.js 的 KEYBINDS +
// cmd-palette.js 的 FIXED_COMMANDS），不是另抄一份说明——改实现这里
// 自动跟着变，文档与实现不会分叉。
// ============================================================

import { escapeHtml, showToast, bindOverlayClose } from '../core/utils.js';
import { keybindDisplayList, keybindLabelForCommand } from './keybinds.js';

/** 取面板元素（不存在返回 null：老页面/裁剪过的 DOM 下不应抛错） */
function keysHelpModal() {
    return document.getElementById('ocKeysHelp');
}

/** 渲染速查内容。每次打开都重渲：键位/命令改动立即生效，也天然适配平台差异。 */
function renderKeysHelp(commands) {
    const modal = keysHelpModal();
    if (!modal) return;

    const keyList = modal.querySelector('#ocKeysHelpList');
    if (keyList) {
        keyList.innerHTML = keybindDisplayList().map(function (k) {
            return '<div class="oc-keys-help-row">'
                + '<span class="oc-keys-help-label">' + escapeHtml(k.label) + '</span>'
                + '<span class="oc-keys-help-desc">' + escapeHtml(k.title) + '</span>'
                + '</div>';
        }).join('');
    }

    const cmdList = modal.querySelector('#ocKeysHelpCmds');
    if (cmdList) {
        cmdList.innerHTML = (commands || []).map(function (c) {
            const label = keybindLabelForCommand(c.name);
            // 未绑定的命令如实标「未绑定」，不塞一个假的快捷键占位
            const chip = label
                ? '<span class="oc-keys-help-label">' + escapeHtml(label) + '</span>'
                : '<span class="oc-keys-help-label none">未绑定</span>';
            return '<div class="oc-keys-help-row">'
                + '<span class="oc-keys-help-name">/' + escapeHtml(c.name) + '</span>'
                + '<span class="oc-keys-help-desc">' + escapeHtml(c.description || '') + '</span>'
                + chip
                + '</div>';
        }).join('');
    }
}

/**
 * 打开速查面板。
 * @param {Array<{name: string, description?: string}>} commands 面板固定命令（由 cmd-palette 传入）
 * @returns {boolean} 是否成功打开
 */
export function openKeysHelp(commands) {
    const modal = keysHelpModal();
    if (!modal) {
        showToast('速查面板不可用（缺少 #ocKeysHelp）', 'error');
        return false;
    }
    renderKeysHelp(commands);
    modal.style.display = 'flex';
    return true;
}

/** 关闭速查面板（内容是静态数据，无需清理状态） */
export function hideKeysHelp() {
    const modal = keysHelpModal();
    if (modal) modal.style.display = 'none';
}

/** 绑定面板事件（幂等：重复调用不重复绑）。由 main.js 在启动时调用。 */
export function bindKeysHelpEvents() {
    const modal = keysHelpModal();
    if (!modal || modal.dataset.eventsBound) return;
    modal.dataset.eventsBound = '1';

    const close = modal.querySelector('.oc-keys-help-close');
    if (close) close.addEventListener('click', hideKeysHelp);

    // Esc 关闭（与仓内其它弹窗一致；只在本面板开着时响应）
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (modal.style.display === 'flex') hideKeysHelp();
    });

    // 点遮罩关闭：复用 core/utils.js 的 bindOverlayClose
    bindOverlayClose(modal, hideKeysHelp);
}
