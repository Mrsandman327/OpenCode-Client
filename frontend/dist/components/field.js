// ============================================================
// 表单控件与字段组
// ============================================================
// 分两层：
//
// 1) controlHtml(opts) —— 控件本体，只有外观，不含布局
//    <input class="ctl ctl--md" />
//    放在哪、跟谁并排，全部由外部容器决定。
//
// 2) fieldHtml(opts) —— 可选的便捷封装（纵向「标签 + 控件 + 说明」）
//    <div class="field field--md">
//        <label for="x">标签</label>
//        <input class="ctl ctl--md" id="x" />
//        <span class="field__hint">说明</span>
//    </div>
//    只做拼装，不规定外部布局；想自己摆就直接用 controlHtml。
//
// 样式见 css/field.css：.ctl* 是控件，.field* 是可选的组布局。

import { escapeAttr } from '../core/utils.js';

/** 把 options 渲染成 <option> */
function optionsHtml(options, value) {
    return (options || []).map(function(opt) {
        const v = opt && typeof opt === 'object' ? opt.value : opt;
        const label = opt && typeof opt === 'object' ? (opt.label != null ? opt.label : opt.value) : opt;
        const selected = String(v) === String(value == null ? '' : value) ? ' selected' : '';
        return '<option value="' + escapeAttr(v) + '"' + selected + '>' + escapeAttr(label) + '</option>';
    }).join('');
}

/**
 * 生成一个控件的 HTML（input / select / textarea）。
 * 只输出控件本身，不包含 label、间距、容器——布局由调用方决定。
 *
 * @param {object} [opts]
 * @param {string} [opts.type]        text（默认）| password | number | search | email | select | textarea
 * @param {string} [opts.id]
 * @param {string|number} [opts.value]
 * @param {string} [opts.placeholder]
 * @param {Array} [opts.options]      select 选项（[{ value, label }] 或字符串数组）
 * @param {number} [opts.rows]        textarea 行数
 * @param {string} [opts.className]   额外类名（如 prov-edit-name）
 * @param {object} [opts.attrs]       透传到控件的其他属性
 * @returns {string}
 */
export function controlHtml(opts) {
    opts = opts || {};
    const type = opts.type || 'text';
    // 控件已换成 Web Components（oc-input / oc-select / oc-textarea）：
    // class 里不再需要 ctl，外观由组件内部样式与 CSS 变量决定
    const classes = [];
    if (opts.className) classes.push(opts.className);

    const attrs = [];
    if (classes.length) attrs.push('class="' + escapeAttr(classes.join(' ')) + '"');
    if (opts.id) attrs.push('id="' + escapeAttr(opts.id) + '"');
    if (opts.placeholder) attrs.push('placeholder="' + escapeAttr(opts.placeholder) + '"');
    if (type !== 'select' && type !== 'textarea' && type !== 'text') {
        attrs.push('type="' + escapeAttr(type) + '"');
    }
    if (type === 'textarea') {
        if (opts.rows) attrs.push('rows="' + escapeAttr(opts.rows) + '"');
    } else if (type !== 'select' && opts.value != null) {
        attrs.push('value="' + escapeAttr(opts.value) + '"');
    }

    const extra = opts.attrs || {};
    Object.keys(extra).forEach(function(key) {
        const v = extra[key];
        if (v === false || v == null) return;
        if (v === true) attrs.push(key);
        else attrs.push(key + '="' + escapeAttr(v) + '"');
    });

    if (type === 'select') {
        return '<oc-select ' + attrs.join(' ') + '>' + optionsHtml(opts.options, opts.value) + '</oc-select>';
    }
    if (type === 'textarea') {
        return '<oc-textarea ' + attrs.join(' ') + '>' + escapeAttr(opts.value == null ? '' : opts.value) + '</oc-textarea>';
    }
    return '<oc-input ' + attrs.join(' ') + '></oc-input>';
}


/** 创建控件 DOM 节点 */
export function createControl(opts) {
    const holder = document.createElement('div');
    holder.innerHTML = controlHtml(opts);
    return holder.firstElementChild;
}

/**
 * 便捷封装：纵向「标签 + 控件 + 说明」的字段组。
 * 需要别的排列方式时，直接用 controlHtml 自己写容器，不必用这个。
 *
 * @param {object} [opts] 额外支持 label / hint / className（容器类）；其余同 controlHtml
 * @returns {string}
 */
export function fieldHtml(opts) {
    opts = opts || {};
    const classes = ['field' + (opts.size === 'md' ? ' field--md' : '')];
    if (opts.className) classes.push(opts.className);

    const label = opts.label
        ? '<label' + (opts.id ? ' for="' + escapeAttr(opts.id) + '"' : '') + '>' + escapeAttr(opts.label) + '</label>'
        : '';
    const hint = opts.hint ? '<span class="field__hint">' + escapeAttr(opts.hint) + '</span>' : '';

    return '<div class="' + escapeAttr(classes.join(' ')) + '">' +
        label + controlHtml(opts) + hint + '</div>';
}

/** 创建字段组 DOM 节点 */
export function createField(opts) {
    const holder = document.createElement('div');
    holder.innerHTML = fieldHtml(opts);
    return holder.firstElementChild;
}
