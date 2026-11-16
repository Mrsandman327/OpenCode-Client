// ============================================================
// Toast 通知组件
// ============================================================
// 全项目统一的轻提示（样式见 css/toast.css）。
//
// 用法（210+ 处调用点都走 core/utils.js 转出的 showToast，签名不变）：
//   showToast('已保存', 'success')
//   showToast('加载失败: ' + msg, 'error')
//   showToast('服务需要访问口令', 'info')
//   showToast('帧数量可能不足', 'warning')
//
// 行为：
//   - 底部居中，2.8 秒后自动收起；新提示会覆盖旧提示并重新计时
//   - 同时写入通知历史（core/toast-history.js），左下角「通知」里可回看
//   - 元素不存在时自动创建，不依赖 index.html 里预置节点

import { recordToast } from '../core/toast-history.js';

/** 支持的提示类型（未知类型按 info 处理） */
const VALID_TYPES = ['info', 'success', 'error', 'warning'];

/** 自动收起时间（毫秒） */
const DURATION = 2800;

/** 当前收起定时器 */
let hideTimer = 0;

/** 取得（必要时创建）toast 节点 */
function toastEl() {
    let el = document.getElementById('toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        el.className = 'toast';
        document.body.appendChild(el);
    }
    return el;
}

/**
 * 显示一条提示。
 *
 * @param {string} message 提示文字
 * @param {string} [type]  info（默认）| success | error | warning
 */
export function showToast(message, type) {
    const el = toastEl();
    const kind = VALID_TYPES.indexOf(type) >= 0 ? type : 'info';
    const text = message == null ? '' : String(message);

    el.textContent = text;
    el.className = 'toast ' + kind + ' show';

    clearTimeout(hideTimer);
    hideTimer = setTimeout(function() {
        el.classList.remove('show');
    }, DURATION);

    // 同步写入通知历史（左下角「通知」入口内可回看）
    recordToast(text, kind);
}

/** 立即收起当前提示（关闭面板等场景需要时可用） */
export function hideToast() {
    const el = document.getElementById('toast');
    if (el) el.classList.remove('show');
    clearTimeout(hideTimer);
}
