// ============================================================
// 统一按钮控件
// ============================================================
// 全项目共用一套按钮结构（样式见 css/button.css）。
//
// 结构：<button class="btn btn-sm btn-primary">保存</button>
//   .btn            不变量：圆角 radius-sm、字体 500、间距 6px、行高 1.2、轻投影
//   .btn-sm/.btn-xs 尺寸档位：只改内边距与字号（默认是 md）
//   .btn-primary …  配色变体：只改颜色
//
// 尺寸与配色互不覆盖，组合顺序随意：
//   class="btn btn-sm btn-primary"  → 小号主按钮
//   class="btn btn-xs"              → 更小的次级按钮
//
// 用法：
//   1) buttonHtml(opts)   模板拼接 / innerHTML
//   2) createButton(opts) 动态创建，返回 <button>（带 onClick 可选）
//
// 业务事件不写进组件：id / class / data-* 都原样透传，
// 现有的 getElementById、事件委托、addEventListener 可以继续用。

import { escapeAttr } from '../core/utils.js';

/** 尺寸档位 → 附加类（默认 md 不需要类） */
const SIZE_CLASS = { md: '', sm: 'btn-sm', xs: 'btn-xs' };

/** 配色变体 → 附加类；secondary 是 .btn 的默认灰底观感，不需要额外类 */
const VARIANT_CLASS = {
    primary: 'btn-primary',
    secondary: '',
    danger: 'btn-danger-outline',
    open: 'btn-open',
    refresh: 'btn-refresh',
    config: 'btn-config',
    ghost: 'btn-ghost',
};

/**
 * 生成按钮的 HTML 字符串。
 *
 * @param {object} [opts]
 * @param {string} [opts.label]      按钮文字（不走 HTML 解析，会被转义）
 * @param {string} [opts.html]       需要嵌入 SVG 等结构时用这个（调用方自行保证安全）
 * @param {string} [opts.variant]    primary（默认）| secondary | danger | open | refresh | config
 * @param {string} [opts.size]       md（默认）| sm | xs
 * @param {string} [opts.id]
 * @param {string} [opts.className]  额外类名（如 btn-save-card、oc-question-finish-btn）
 * @param {string} [opts.title]
 * @param {string} [opts.type]       button（默认）| submit
 * @param {boolean} [opts.disabled]
 * @param {object} [opts.attrs]      透传到 button 的其他属性（data-* 等）
 * @returns {string}
 */
export function buttonHtml(opts) {
    opts = opts || {};
    const classes = ['btn'];
    const sizeClass = SIZE_CLASS[opts.size || 'md'];
    if (sizeClass) classes.push(sizeClass);
    const variantClass = VARIANT_CLASS[opts.variant || 'primary'] || '';
    if (variantClass) classes.push(variantClass);
    if (opts.className) classes.push(opts.className);

    const attrs = ['class="' + escapeAttr(classes.join(' ')) + '"'];
    attrs.push('type="' + escapeAttr(opts.type || 'button') + '"');
    if (opts.id) attrs.push('id="' + escapeAttr(opts.id) + '"');
    if (opts.title) attrs.push('title="' + escapeAttr(opts.title) + '"');
    if (opts.disabled) attrs.push('disabled');

    const extra = opts.attrs || {};
    Object.keys(extra).forEach(function(key) {
        const value = extra[key];
        if (value === false || value == null) return;
        if (value === true) attrs.push(key);
        else attrs.push(key + '="' + escapeAttr(value) + '"');
    });

    // label 走转义；html 用于需要嵌入图标 SVG 的场景，由调用方保证内容安全
    const content = opts.html != null ? opts.html : escapeAttr(opts.label == null ? '' : opts.label);
    return '<button ' + attrs.join(' ') + '>' + content + '</button>';
}

/**
 * 创建按钮 DOM 节点。
 * 返回的节点是 <button> 本身，业务侧可直接绑事件或改文案。
 *
 * @param {object} [opts] 同 buttonHtml，另支持 opts.onClick(event, button)
 * @returns {HTMLButtonElement}
 */
export function createButton(opts) {
    opts = opts || {};
    const holder = document.createElement('div');
    holder.innerHTML = buttonHtml(opts);
    const btn = holder.firstElementChild;
    if (typeof opts.onClick === 'function') {
        btn.addEventListener('click', function(event) {
            opts.onClick(event, btn);
        });
    }
    return btn;
}

/**
 * 把静态 HTML 里的声明式按钮补上统一类名：
 *   <button type="button" data-btn="primary" data-btn-size="sm" id="x">保存</button>
 *   → class="btn btn-primary btn-sm"
 *
 * 只改 class，不动其它属性与事件，可重复调用。
 * 静态 HTML 用这套声明，避免手写类名时漏掉 btn / 档位 / 变体。
 *
 * @param {ParentNode} [root] 搜索范围，默认 document
 */
export function enhanceButtons(root) {
    const scope = root || document;
    if (!scope || !scope.querySelectorAll) return;
    const els = scope.querySelectorAll('[data-btn]');
    for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const variant = VARIANT_CLASS[el.dataset.btn] || '';
        const sizeClass = SIZE_CLASS[el.dataset.btnSize || 'md'];
        const classes = String(el.className || '').split(/\s+/).filter(Boolean);
        if (!classes.includes('btn')) classes.unshift('btn');
        if (variant && !classes.includes(variant)) classes.push(variant);
        if (sizeClass && !classes.includes(sizeClass)) classes.push(sizeClass);
        el.className = classes.join(' ');
        delete el.dataset.btn;
        delete el.dataset.btnSize;
    }
}
