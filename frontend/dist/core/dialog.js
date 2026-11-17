// ============================================================
// 通用确认弹窗
//
// window.confirm 的标题由 WebView / 浏览器决定（显示页面 origin，
// 例如「wails.localhost 显示」），无法通过 JS 修改。
// 需要自定义标题时改用本模块，复用项目已有的 modal-card 样式。
// ============================================================

import { escapeHtml, escapeAttr } from './utils.js';
import { buttonHtml } from '../components/oc-button.js';
import { createModal, openModal, closeModal } from '../components/modal.js';

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
        // 外壳交给组件生成：头部/正文/底栏与关闭按钮都在组件里
        var overlay = createModal({
            modalClass: 'confirm-modal',
            title: title,
            bodyClass: 'confirm-modal-body',
            bodyHtml: escapeHtml(message).replace(/\n/g, '<br>'),
            footerHtml:
                buttonHtml({ label: cancelText, variant: 'secondary', className: 'btn-cancel', attrs: { 'data-confirm-cancel': true } }) +
                buttonHtml({ label: okText, attrs: { 'data-confirm-ok': true } })
        });

        var settled = false;

        function close(result) {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            resolve(result);
        }

        // Esc / 点遮罩 / 关闭按钮都由组件统一关闭，组件关完会派发 modal:close
        overlay.addEventListener('modal:close', function() {
            close(false);
        });

        function onKey(e) {
            // Esc 已交给组件；这里只保留 Enter 直接确认
            if (e.key === 'Enter') {
                e.preventDefault();
                close(true);
            }
        }

        overlay.querySelectorAll('[data-confirm-cancel]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                closeModal(overlay);
            });
        });
        overlay.querySelector('[data-confirm-ok]').addEventListener('click', function() {
            close(true);
        });
        document.addEventListener('keydown', onKey, true);

        // 默认聚焦确认按钮，Enter 直接确认
        openModal(overlay, { focus: '[data-confirm-ok]' });
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
        // 外壳交给组件生成；正文 = 可选说明 + 输入框
        var overlay = createModal({
            modalClass: 'confirm-modal prompt-modal',
            title: title,
            bodyClass: 'confirm-modal-body',
            bodyHtml:
                (message ? '<p class="prompt-message">' + escapeHtml(message) + '</p>' : '') +
                '<oc-input class="prompt-input" value="' + escapeAttr(defaultValue) + '" placeholder="' + escapeAttr(placeholder) + '"></oc-input>',
            footerHtml:
                buttonHtml({ label: cancelText, variant: 'secondary', className: 'btn-cancel', attrs: { 'data-prompt-cancel': true } }) +
                buttonHtml({ label: okText, attrs: { 'data-prompt-ok': true } })
        });

        var input = overlay.querySelector('.prompt-input');
        var settled = false;

        function close(result) {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            resolve(result);
        }

        // Esc / 点遮罩 / 关闭按钮由组件统一关闭
        overlay.addEventListener('modal:close', function() {
            close(null);
        });

        function onKey(e) {
            // Esc 已交给组件，这里不再重复处理
            if (e.key === 'Escape') e.preventDefault();
        }

        overlay.querySelectorAll('[data-prompt-cancel]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                closeModal(overlay);
            });
        });
        overlay.querySelector('[data-prompt-ok]').addEventListener('click', function() {
            close(input.value);
        });
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                close(input.value);
            }
        });
        document.addEventListener('keydown', onKey, true);

        // createModal 已挂到 body；这里只负责显示与聚焦输入框
        openModal(overlay, { focus: '.prompt-input' });
        // 重命名场景预填旧名称，全选后直接输入即可覆盖
        input.select();
    });
}
