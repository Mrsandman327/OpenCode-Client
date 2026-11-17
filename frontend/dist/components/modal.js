// ============================================================
// 弹窗外壳组件
// ============================================================
// 全项目只有一套弹窗结构（对应 css/style.css 里的 .modal / .modal-header /
// .modal-body / .modal-footer）：
//
//   <div class="modal-overlay" id="x" style="display:none">
//       <div class="modal modal-card {额外类}" role="dialog" aria-modal="true">
//           <div class="modal-header">
//               <h3>标题</h3>
//               <button class="modal-close-btn" data-modal-close>×</button>
//           </div>
//           <div class="modal-body">正文</div>
//           <div class="modal-footer">按钮</div>
//       </div>
//   </div>
//
// 组件只负责「外壳 + 行为」：
//   - 生成外壳 HTML / DOM
//   - 打开、关闭（记录触发元素、锁定页面滚动、还原焦点）
//   - Esc 只关最顶层弹窗、点击遮罩空白处关闭、统一关闭按钮
//
// 正文内容、按钮、业务状态一律留在宿主：宿主仍然自己 getElementById、
// 自己绑事件、自己在关闭后清理（可监听 'modal:close'）。
//
// 三种用法：
//   1) modalHtml(opts)      模板拼接 / innerHTML 时生成 HTML 字符串
//   2) createModal(opts)    动态创建并返回 overlay 节点（已挂到 body）
//   3) enhanceModals(root)  静态 HTML 里的弹窗，一次性接管通用行为

import { escapeAttr, escapeHtml } from '../core/utils.js';

/** 已打开的弹窗（overlay 元素），后进先出；Esc 只处理栈顶 */
const STACK = [];

/** 滚动锁计数：多个弹窗嵌套时只在最后一个关闭时恢复滚动 */
let scrollLocks = 0;
/** 打开前的 body overflow 原值，关闭后还原 */
let prevBodyOverflow = '';

/** 全局监听是否已绑定 */
let bound = false;

/**
 * 生成弹窗外壳的 HTML 字符串。
 *
 * @param {object} [opts]
 * @param {string} [opts.id]          overlay 的 id
 * @param {string} [opts.title]       标题（纯文本，内部会转义）
 * @param {string} [opts.titleHtml]   标题（已转义的 HTML，优先于 title）
 * @param {string} [opts.bodyHtml]    正文 HTML；为空则不生成 .modal-body
 * @param {string} [opts.bodyClass]   正文的额外类（宿主排版，如 confirm-modal-body）
 * @param {string} [opts.footerHtml]  底部 HTML；为空则不生成 .modal-footer
 * @param {string} [opts.headerHtml]  完全自定义的头部内容（不含关闭按钮）
 * @param {string} [opts.modalClass]  卡片额外类，如 'confirm-modal'
 * @param {string} [opts.overlayClass] 遮罩额外类
 * @param {string} [opts.sizeAttr]    size 属性标记（仅记录用途，样式由 CSS 决定）
 * @param {boolean} [opts.showClose=true] 是否生成右上角关闭按钮
 * @param {boolean} [opts.static=false]   点击遮罩空白处不关闭
 * @param {object} [opts.attrs]       透传到 overlay 的其他属性
 * @param {object} [opts.modalAttrs]  透传到卡片的其他属性
 * @returns {string}
 */
export function modalHtml(opts) {
    opts = opts || {};

    const overlayAttrs = ['class="modal-overlay' + (opts.overlayClass ? ' ' + escapeAttr(opts.overlayClass) : '') + '"'];
    if (opts.id) overlayAttrs.push('id="' + escapeAttr(opts.id) + '"');
    if (opts.static) overlayAttrs.push('data-modal-static="1"');
    overlayAttrs.push('style="display:none"');
    pushAttrs(overlayAttrs, opts.attrs);

    const modalAttrs = ['class="modal modal-card' + (opts.modalClass ? ' ' + escapeAttr(opts.modalClass) : '') + '"'];
    modalAttrs.push('role="dialog"');
    modalAttrs.push('aria-modal="true"');
    if (opts.title) modalAttrs.push('aria-label="' + escapeAttr(opts.title) + '"');
    pushAttrs(modalAttrs, opts.modalAttrs);

    const titleHtml = opts.titleHtml != null ? opts.titleHtml : (opts.title != null ? escapeHtml(opts.title) : '');
    const closeHtml = opts.showClose === false ? '' :
        '<oc-button variant="ghost" icon-only icon-mask="close" class="modal-close-btn" data-modal-close title="关闭（Esc）" aria-label="关闭"></oc-button>';

    let html = '<div ' + overlayAttrs.join(' ') + '>' +
        '<div ' + modalAttrs.join(' ') + '>';

    if (opts.headerHtml != null) {
        html += '<div class="modal-header">' + opts.headerHtml + closeHtml + '</div>';
    } else if (titleHtml || closeHtml) {
        html += '<div class="modal-header">' +
            '<h3>' + titleHtml + '</h3>' +
            closeHtml +
        '</div>';
    }

    if (opts.bodyHtml) {
        const bodyCls = 'modal-body' + (opts.bodyClass ? ' ' + escapeAttr(opts.bodyClass) : '');
        html += '<div class="' + bodyCls + '">' + opts.bodyHtml + '</div>';
    }
    if (opts.footerHtml) html += '<div class="modal-footer">' + opts.footerHtml + '</div>';

    html += '</div></div>';
    return html;
}

/**
 * 动态创建弹窗并挂到 body（默认隐藏）。
 *
 * @param {object} opts 同 modalHtml
 * @returns {HTMLElement} overlay 节点
 */
export function createModal(opts) {
    const holder = document.createElement('div');
    holder.innerHTML = modalHtml(opts);
    const overlay = holder.firstElementChild;
    document.body.appendChild(overlay);
    // 动态弹窗同样接入统一行为（关闭按钮、点遮罩空白）
    enhanceModals(overlay);
    return overlay;
}

/**
 * 打开弹窗：记录触发元素、锁滚动、聚焦第一个可聚焦控件。
 *
 * @param {HTMLElement|string} target overlay 节点或其 id
 * @param {object} [opts]
 * @param {string} [opts.focus]   打开后要聚焦的元素选择器（限定在弹窗内）
 * @param {boolean} [opts.restoreFocus=true] 关闭时是否把焦点还给触发元素
 */
export function openModal(target, opts) {
    const overlay = resolveOverlay(target);
    if (!overlay) return null;
    opts = opts || {};

    bindGlobalOnce();

    // 已经打开就不重复入栈（避免 Esc 关两次关不掉）
    if (STACK.indexOf(overlay) < 0) {
        overlay.__modalTrigger = document.activeElement;
        overlay.__modalRestoreFocus = opts.restoreFocus !== false;
        STACK.push(overlay);
        lockScroll();
    }

    overlay.style.display = 'flex';

    const modal = overlay.querySelector('.modal, .modal-card');
    // 默认聚焦正文里的第一个可聚焦控件；没有就聚焦弹窗本身，保证键盘可用。
    // 控件已组件化：oc-input / oc-textarea / oc-select 自带 focus()，宿主本身不可聚焦，
    // 所以自定义元素必须排在内置元素前面，否则 focus() 落在宿主上是空操作。
    const focusSel = opts.focus || 'oc-input, oc-textarea, oc-select, input:not([type="hidden"]), textarea, select, oc-button:not(.modal-close-btn), button:not(.modal-close-btn)';
    const focusEl = (modal && modal.querySelector(focusSel)) || modal;
    if (focusEl) {
        try { focusEl.focus({ preventScroll: true }); } catch (e) { focusEl.focus(); }
    }

    overlay.dispatchEvent(new CustomEvent('modal:open', { bubbles: true }));
    return overlay;
}

/**
 * 关闭弹窗：解除滚动锁、还原焦点。
 * 只改显隐，不销毁节点——宿主的业务清理请监听 'modal:close'。
 *
 * @param {HTMLElement|string} target overlay 节点或其 id
 */
export function closeModal(target) {
    const overlay = resolveOverlay(target);
    if (!overlay) return;

    const idx = STACK.indexOf(overlay);
    if (idx >= 0) {
        STACK.splice(idx, 1);
        unlockScroll();
    }

    overlay.style.display = 'none';

    if (overlay.__modalRestoreFocus && overlay.__modalTrigger && document.contains(overlay.__modalTrigger)) {
        try { overlay.__modalTrigger.focus({ preventScroll: true }); } catch (e) { /* 元素已不可聚焦时忽略 */ }
    }
    overlay.__modalTrigger = null;

    overlay.dispatchEvent(new CustomEvent('modal:close', { bubbles: true }));
}

/** 当前最顶层的弹窗（没有则返回 null） */
export function getTopModal() {
    if (STACK.length) return STACK[STACK.length - 1];
    // 兼容：宿主自己把 display 改成 flex 打开、没有经过 openModal 的弹窗，
    // 按 DOM 顺序取最后一个可见的（后出现的通常层级更高）
    const all = document.querySelectorAll('.modal-overlay');
    for (let i = all.length - 1; i >= 0; i -= 1) {
        if (getComputedStyle(all[i]).display !== 'none') return all[i];
    }
    return null;
}

/**
 * 接管静态 HTML 里的弹窗：
 *   - 点击 [data-modal-close] 或 .modal-close-btn → 关闭
 *   - 点击遮罩空白处 → 关闭（弹窗上写了 data-modal-static 的除外）
 *   - Esc → 只关闭最顶层
 *
 * 同一节点重复调用不会重复绑定。
 *
 * @param {ParentNode} [root=document]
 */
export function enhanceModals(root) {
    root = root || document;
    bindGlobalOnce();

    const overlays = [];
    if (root.matches && root.matches('.modal-overlay')) overlays.push(root);
    if (root.querySelectorAll) overlays.push.apply(overlays, root.querySelectorAll('.modal-overlay'));

    overlays.forEach(function(overlay) {
        if (overlay.__modalEnhanced) return;
        overlay.__modalEnhanced = true;

        overlay.addEventListener('click', function(e) {
            // 关闭按钮
            const closer = e.target.closest && e.target.closest('[data-modal-close], .modal-close-btn');
            if (closer && overlay.contains(closer)) {
                closeModal(overlay);
                return;
            }
            // 遮罩空白：只有点在 overlay 自身时才算
            if (e.target === overlay && overlay.getAttribute('data-modal-static') !== '1') {
                closeModal(overlay);
            }
        });
    });
}

// ============================================================
// 内部实现
// ============================================================

/** 把额外的 attrs 对象拼成 HTML 属性（true 表示无值属性） */
function pushAttrs(list, attrs) {
    if (!attrs) return;
    Object.keys(attrs).forEach(function(key) {
        const v = attrs[key];
        if (v === false || v == null) return;
        if (v === true) list.push(key);
        else list.push(key + '="' + escapeAttr(v) + '"');
    });
}

/** id 或节点统一解析成 overlay 节点 */
function resolveOverlay(target) {
    if (!target) return null;
    if (typeof target === 'string') {
        const el = document.getElementById(target);
        return el && el.classList.contains('modal-overlay') ? el : null;
    }
    return target;
}

/** 全局只绑一次：Esc 关闭栈顶 */
function bindGlobalOnce() {
    if (bound) return;
    bound = true;
    document.addEventListener('keydown', function(e) {
        if (e.key !== 'Escape') return;
        const top = getTopModal();
        if (!top) return;
        // 该弹窗声明了自行处理 Esc 时不抢
        if (top.getAttribute('data-modal-esc') === 'off') return;
        e.preventDefault();
        // 优先「点一下它自己的关闭按钮」：这样宿主绑在按钮上的清理逻辑
        // （重置表单、停止轮询等）照常执行，Esc 和鼠标关闭走同一条路径
        const closer = top.querySelector('.modal-close-btn, [data-modal-close]');
        if (closer) closer.click();
        else closeModal(top);
    }, true);
}

/** 打开弹窗时锁住页面滚动，避免背景跟着滚 */
function lockScroll() {
    if (scrollLocks === 0) {
        prevBodyOverflow = document.body.style.overflow || '';
        document.body.style.overflow = 'hidden';
    }
    scrollLocks += 1;
}

/** 关闭弹窗时恢复滚动；嵌套时只在最后一个关闭后还原 */
function unlockScroll() {
    if (scrollLocks > 0) scrollLocks -= 1;
    if (scrollLocks === 0) {
        document.body.style.overflow = prevBodyOverflow;
        prevBodyOverflow = '';
    }
}
