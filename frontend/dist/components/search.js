// ============================================================
// 搜索框组件
// ============================================================
// 统一「图标 + 无边框输入框 + 容器描边」的搜索结构（样式见 css/search.css）：
//
//   <div class="search">
//       <span class="search__icon"><svg class="i"><use href="#i-search"></use></svg></span>
//       <input class="search__input" type="search" id="x" placeholder="搜索…" />
//   </div>
//
// 尺寸（高度/内边距/宽度）不在这里写死，由宿主容器决定。
//
// 用法：
//   searchHtml({ id: 'pvSearch', placeholder: '搜索供应商、模型…' })
//   searchHtml({ id: 'forkSearch', placeholder: '搜索', icon: '' })        // 不要图标
//   searchHtml({ id: 'fbSearch', placeholder: '搜索内容…', trailingHtml: clearBtnHtml })

import { escapeAttr } from '../core/utils.js';

/**
 * 生成搜索框的 HTML。
 *
 * @param {object} [opts]
 * @param {string} [opts.id]           input 的 id
 * @param {string} [opts.placeholder]
 * @param {string} [opts.value]        初始值
 * @param {string} [opts.icon]         图标 sprite id，默认 i-search；传空字符串则不显示图标
 * @param {string} [opts.type]         search（默认）| text
 * @param {string} [opts.className]    .search 容器的额外类
 * @param {string} [opts.inputClass]   input 的额外类
 * @param {string} [opts.trailingHtml] 尾部附加元素（计数、清除按钮等）
 * @param {object} [opts.attrs]        透传到 input 的其他属性
 * @returns {string}
 */
export function searchHtml(opts) {
    opts = opts || {};
    const icon = opts.icon === undefined ? 'i-search' : opts.icon;

    const inputAttrs = ['class="search__input' + (opts.inputClass ? ' ' + escapeAttr(opts.inputClass) : '') + '"'];
    inputAttrs.push('type="' + escapeAttr(opts.type || 'search') + '"');
    if (opts.id) inputAttrs.push('id="' + escapeAttr(opts.id) + '"');
    if (opts.placeholder) inputAttrs.push('placeholder="' + escapeAttr(opts.placeholder) + '"');
    if (opts.value != null) inputAttrs.push('value="' + escapeAttr(opts.value) + '"');

    const extra = opts.attrs || {};
    Object.keys(extra).forEach(function(key) {
        const v = extra[key];
        if (v === false || v == null) return;
        if (v === true) inputAttrs.push(key);
        else inputAttrs.push(key + '="' + escapeAttr(v) + '"');
    });

    const iconHtml = icon
        ? '<span class="search__icon" aria-hidden="true"><svg class="i"><use href="#' + escapeAttr(icon) + '"></use></svg></span>'
        : '';

    const classes = 'search' + (opts.className ? ' ' + opts.className : '');
    return '<div class="' + escapeAttr(classes) + '">' +
        iconHtml +
        '<input ' + inputAttrs.join(' ') + ' />' +
        (opts.trailingHtml || '') +
        '</div>';
}

/** 创建搜索框 DOM 节点 */
export function createSearch(opts) {
    const holder = document.createElement('div');
    holder.innerHTML = searchHtml(opts);
    return holder.firstElementChild;
}
