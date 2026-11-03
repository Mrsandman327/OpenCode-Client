// ============================================================
// 通知历史面板：左下角入口 + 本地历史列表
// 依赖：core/toast-history.js（数据）、core/utils.js（escapeHtml）
// ============================================================

import { escapeHtml, copyToClipboard } from '../core/utils.js';
import {
    TOAST_HISTORY_EVENT,
    readToastHistory,
    unreadToastCount,
    markToastHistoryRead,
    clearToastHistory,
} from '../core/toast-history.js';

function formatNotifyTime(ts) {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    const sameDay = date.toDateString() === now.toDateString();
    return sameDay ? (hh + ':' + mm + ':' + ss) : ((date.getMonth() + 1) + '-' + date.getDate() + ' ' + hh + ':' + mm + ':' + ss);
}

const LEVEL_LABELS = { info: 'INFO', success: 'SUCCESS', error: 'ERROR' };

export function initNotifications() {
    const btn = document.getElementById('sidebarNotify');
    const panel = document.getElementById('notifyPanel');
    const listEl = document.getElementById('notifyList');
    const badge = document.getElementById('sidebarNotifyBadge');
    const clearBtn = document.getElementById('notifyClear');
    const closeBtn = document.getElementById('notifyClose');
    if (!btn || !panel || !listEl) return;

    let open = false;

    function renderBadge() {
        if (!badge) return;
        const count = unreadToastCount();
        if (count > 0) {
            badge.hidden = false;
            badge.textContent = count > 99 ? '99+' : String(count);
        } else {
            badge.hidden = true;
            badge.textContent = '';
        }
    }

    let renderedMessages = [];

    function renderList() {
        const items = readToastHistory().slice().reverse();
        renderedMessages = items.map(item => item.message);
        if (!items.length) {
            listEl.innerHTML = '<div class="notify-empty">暂无消息</div>';
            return;
        }
        listEl.innerHTML = items.map((item, idx) => {
            const type = item.type || 'info';
            const level = LEVEL_LABELS[type] || LEVEL_LABELS.info;
            return '<div class="notify-item is-' + escapeHtml(type) + '">' +
                '<span class="notify-time">' + escapeHtml(formatNotifyTime(item.time)) + '</span>' +
                '<span class="notify-level">' + level + '</span>' +
                '<span class="notify-msg">' + escapeHtml(item.message) + '</span>' +
                '<button type="button" class="notify-copy" data-copy-index="' + idx + '" title="复制消息">复制</button>' +
            '</div>';
        }).join('');
    }

    function setOpen(next) {
        open = !!next;
        panel.classList.toggle('open', open);
        btn.classList.toggle('active', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
            renderList();
            markToastHistoryRead();
            renderBadge();
            listEl.scrollTop = 0;
        }
    }

    btn.addEventListener('click', function(e) {
        e.stopPropagation();
        setOpen(!open);
    });

    // div 不是原生按钮，补 Enter / Space 键盘操作
    btn.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(!open);
        }
    });

    if (closeBtn) {
        closeBtn.addEventListener('click', function() {
            setOpen(false);
            btn.focus();
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', function() {
            clearToastHistory();
            renderList();
            renderBadge();
        });
    }

    // 每条消息右侧「复制」：复制原始消息文本（不含时间/级别）
    listEl.addEventListener('click', async function(e) {
        const btn = e.target.closest('.notify-copy');
        if (!btn) return;
        e.stopPropagation();
        const idx = Number(btn.dataset.copyIndex);
        const text = renderedMessages[idx];
        if (typeof text !== 'string') return;
        // 复制统一走 core/utils.js 的 copyToClipboard（成功 resolve / 失败 reject）
        let ok = false;
        try {
            await copyToClipboard(text);
            ok = true;
        } catch (_) {
            // 复制失败：按钮显示「复制失败」，稍后自动恢复
        }
        btn.textContent = ok ? '已复制' : '复制失败';
        btn.classList.toggle('copied', ok);
        btn.classList.toggle('copy-failed', !ok);
        clearTimeout(btn._copyTimer);
        btn._copyTimer = setTimeout(function() {
            btn.textContent = '复制';
            btn.classList.remove('copied', 'copy-failed');
        }, 1200);
    });

    // 点击面板外部关闭（入口按钮自身已 stopPropagation）
    document.addEventListener('click', function(e) {
        if (!open) return;
        if (panel.contains(e.target) || btn.contains(e.target)) return;
        setOpen(false);
    });

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && open) {
            setOpen(false);
            btn.focus();
        }
    });

    window.addEventListener(TOAST_HISTORY_EVENT, function() {
        if (open) {
            // 面板打开时新通知视为已读（markToastHistoryRead 会再次派发事件，
            // 第二次进来时未读已为 0，不会循环）
            if (unreadToastCount() > 0) {
                markToastHistoryRead();
                return;
            }
            renderList();
        }
        renderBadge();
    });

    // 每次应用启动（页面加载）清空历史：消息只保留本次运行产生的，
    // 避免打开应用就看到上一次运行遗留的通知。
    clearToastHistory();

    renderList();
    renderBadge();
}

initNotifications();
