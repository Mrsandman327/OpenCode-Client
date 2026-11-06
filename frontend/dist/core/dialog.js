// ============================================================
// 通用确认弹窗
//
// window.confirm 的标题由 WebView / 浏览器决定（显示页面 origin，
// 例如「wails.localhost 显示」），无法通过 JS 修改。
// 需要自定义标题时改用本模块，复用项目已有的 modal-card 样式。
// ============================================================

import { escapeHtml, escapeAttr } from './utils.js';

/**
 * 显示确认弹窗。
 *
 * @param {Object} options
 * @param {string} options.title 标题
 * @param {string} options.message 正文（\n 转为换行）
 * @param {string} [options.okText='确定'] 确认按钮文字
 * @param {string} [options.cancelText='取消'] 取消按钮文字
 * @returns {Promise<boolean>} 确认返回 true，取消 / Esc / 点遮罩返回 false
 */
export function showConfirm(options) {
    var opts = options || {};
    var title = opts.title || '确认';
    var message = opts.message == null ? '' : String(opts.message);
    var okText = opts.okText || '确定';
    var cancelText = opts.cancelText || '取消';

    return new Promise(function(resolve) {
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML =
            '<div class="modal modal-card confirm-modal" role="dialog" aria-modal="true">' +
                '<div class="modal-header">' +
                    '<h3>' + escapeHtml(title) + '</h3>' +
                    '<button type="button" class="modal-close-btn" data-confirm-cancel title="关闭（Esc）" aria-label="关闭">' +
                        '<span class="oc-fb-icon oc-fb-icon-close" aria-hidden="true"></span>' +
                    '</button>' +
                '</div>' +
                '<div class="modal-body confirm-modal-body">' +
                    escapeHtml(message).replace(/\n/g, '<br>') +
                '</div>' +
                '<div class="modal-footer">' +
                    '<button type="button" class="btn btn-cancel" data-confirm-cancel>' + escapeHtml(cancelText) + '</button>' +
                    '<button type="button" class="btn btn-primary" data-confirm-ok>' + escapeHtml(okText) + '</button>' +
                '</div>' +
            '</div>';

        var settled = false;

        function close(result) {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            resolve(result);
        }

        function onKey(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                close(false);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                close(true);
            }
        }

        // 点击遮罩空白处关闭
        overlay.addEventListener('mousedown', function(e) {
            if (e.target === overlay) close(false);
        });
        overlay.querySelectorAll('[data-confirm-cancel]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                close(false);
            });
        });
        overlay.querySelector('[data-confirm-ok]').addEventListener('click', function() {
            close(true);
        });
        document.addEventListener('keydown', onKey, true);

        document.body.appendChild(overlay);
        // 默认聚焦确认按钮，Enter 直接确认
        var okBtn = overlay.querySelector('[data-confirm-ok]');
        if (okBtn) okBtn.focus();
    });
}

/**
 * 显示输入弹窗，替代 window.prompt。
 *
 * @param {Object} options
 * @param {string} options.title 标题
 * @param {string} [options.message] 输入框上方说明
 * @param {string} [options.defaultValue=''] 默认值（打开时全选，便于直接覆盖）
 * @param {string} [options.placeholder] 占位提示
 * @param {string} [options.okText='确定'] 确认按钮文字
 * @param {string} [options.cancelText='取消'] 取消按钮文字
 * @returns {Promise<string|null>} 确认返回输入值（允许空串），取消 / Esc 返回 null
 */
export function showPrompt(options) {
    var opts = options || {};
    var title = opts.title || '请输入';
    var message = opts.message == null ? '' : String(opts.message);
    var defaultValue = opts.defaultValue == null ? '' : String(opts.defaultValue);
    var placeholder = opts.placeholder || '';
    var okText = opts.okText || '确定';
    var cancelText = opts.cancelText || '取消';

    return new Promise(function(resolve) {
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML =
            '<div class="modal modal-card confirm-modal prompt-modal" role="dialog" aria-modal="true">' +
                '<div class="modal-header">' +
                    '<h3>' + escapeHtml(title) + '</h3>' +
                    '<button type="button" class="modal-close-btn" data-prompt-cancel title="关闭（Esc）" aria-label="关闭">' +
                        '<span class="oc-fb-icon oc-fb-icon-close" aria-hidden="true"></span>' +
                    '</button>' +
                '</div>' +
                '<div class="modal-body confirm-modal-body">' +
                    (message ? '<p class="prompt-message">' + escapeHtml(message) + '</p>' : '') +
                    '<input type="text" class="prompt-input" value="' + escapeAttr(defaultValue) + '" placeholder="' + escapeAttr(placeholder) + '">' +
                '</div>' +
                '<div class="modal-footer">' +
                    '<button type="button" class="btn btn-cancel" data-prompt-cancel>' + escapeHtml(cancelText) + '</button>' +
                    '<button type="button" class="btn btn-primary" data-prompt-ok>' + escapeHtml(okText) + '</button>' +
                '</div>' +
            '</div>';

        var input = overlay.querySelector('.prompt-input');
        var settled = false;

        function close(result) {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            resolve(result);
        }

        function onKey(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                close(null);
            }
        }

        overlay.querySelectorAll('[data-prompt-cancel]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                close(null);
            });
        });
        overlay.querySelector('[data-prompt-ok]').addEventListener('click', function() {
            close(input.value);
        });
        overlay.addEventListener('mousedown', function(e) {
            if (e.target === overlay) close(null);
        });
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                close(input.value);
            }
        });
        document.addEventListener('keydown', onKey, true);

        document.body.appendChild(overlay);
        input.focus();
        // 重命名场景预填旧名称，全选后直接输入即可覆盖
        input.select();
    });
}
