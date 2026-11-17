import { escapeAttr } from '../core/utils.js';

// ============================================================
// oc-input 自定义元素（Shadow DOM）
// ============================================================
// 用法：
//   <oc-input id="kbEntryTitle" placeholder="一句话说清这条知识是什么"></oc-input>
//   <oc-input id="port" type="number" value="8080" size="sm"></oc-input>
//   <oc-input id="path" readonly value="/tmp"></oc-input>
//
// 属性：
//   type / placeholder / value / disabled / readonly / maxlength / autocomplete / spellcheck
//   size = md（默认，30px）| sm（26px）
//   oc-id  可选，内部 input 的 id（默认不加，避免与宿主 id 冲突）
//
// 对外接口（与原生 input 一致，迁移时业务代码基本不用改）：
//   el.value / el.disabled / el.readOnly / el.placeholder / el.focus() / el.select()
//   el.addEventListener('input' | 'change' | 'keydown' | 'focus' | 'blur', …)
//   事件是手动转发的 —— 原生 input 事件不跨 shadow 边界，不转发外部收不到。
//
// 样式隔离：宿主改外观只能走 CSS 变量或 ::part(input)
//   oc-input { --oc-input-h: 34px; --oc-input-fs: 13px; }
//   oc-input::part(input) { letter-spacing: 1px; }
//   可用变量：--oc-input-h / --oc-input-px / --oc-input-fs / --oc-input-radius
//            --oc-input-bg / --oc-input-fg / --oc-input-border / --oc-input-font

/** 组件内部样式 */
const SHEET = new CSSStyleSheet();
SHEET.replaceSync(`
:host {
    display: inline-flex;
    width: var(--oc-input-w, 100%);
    min-width: 0;
    font-family: inherit;
    vertical-align: middle;
}

:host([hidden]) { display: none; }

input {
    width: 100%;
    /* 表单控件统一用等宽字体，数字/路径/密钥对齐更整齐 */
    font-family: var(--oc-input-font, "Consolas", "Microsoft YaHei", monospace);
    height: var(--oc-input-h, 30px);
    padding: 0 var(--oc-input-px, 9px);
    border: var(--oc-input-border-width, 1px) var(--oc-input-border-style, solid) var(--oc-input-border, var(--border));
    border-radius: var(--oc-input-radius, var(--radius-sm, 8px));
    background: var(--oc-input-bg, var(--bg-input));
    color: var(--oc-input-fg, var(--text-primary));
    font-size: var(--oc-input-fs, 12px);
    line-height: 1.4;
    box-sizing: border-box;
    outline: none;
    transition: border-color .15s ease;
}

input::placeholder {
    color: var(--text-muted);
    font-family: inherit;
}

input:focus {
    border-color: var(--accent);
}

input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

/* 小号档位：26px，用于工具栏/表格内 */
:host([size="sm"]) input {
    height: var(--oc-input-h, 26px);
    font-size: var(--oc-input-fs, 12px);
}
`);

class OcInput extends HTMLElement {
    static get observedAttributes() {
        return ['type', 'placeholder', 'value', 'disabled', 'readonly', 'maxlength', 'autocomplete', 'spellcheck', 'size', 'min', 'max', 'step'];
    }

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.adoptedStyleSheets = [SHEET];
        root.innerHTML = '<input part="input" type="text" />';
        this._input = root.querySelector('input');
    }

    connectedCallback() {
        this._bindForward();
        this._sync();
    }

    attributeChangedCallback() {
        this._sync();
    }

    /** 把内部原生事件转发到宿主，外部监听方式与以前一致 */
    _bindForward() {
        if (this._forwarded) return;
        this._forwarded = true;
        const types = ['input', 'change', 'keydown', 'keyup', 'keypress', 'focus', 'blur', 'paste'];
        types.forEach((type) => {
            this._input.addEventListener(type, (event) => {
                // 原生事件不跨 shadow 边界，这里用 composed 的 CustomEvent 重新派发
                const clone = new CustomEvent(type, {
                    bubbles: type !== 'focus' && type !== 'blur',
                    composed: true,
                    cancelable: event.cancelable,
                    detail: { originalEvent: event }
                });
                this.dispatchEvent(clone);
                if (type === 'focus') this.dispatchEvent(new CustomEvent('focus', { bubbles: true, composed: true }));
            });
        });
    }

    _sync() {
        if (!this._input) return;
        const input = this._input;
        input.type = this.getAttribute('type') || 'text';
        input.placeholder = this.getAttribute('placeholder') || '';
        if (this.hasAttribute('value')) input.value = this.getAttribute('value');
        input.disabled = this.hasAttribute('disabled');
        input.readOnly = this.hasAttribute('readonly');
        if (this.hasAttribute('maxlength')) input.maxLength = Number(this.getAttribute('maxlength'));
        if (this.hasAttribute('autocomplete')) input.autocomplete = this.getAttribute('autocomplete');
        if (this.hasAttribute('min')) input.min = this.getAttribute('min');
        if (this.hasAttribute('max')) input.max = this.getAttribute('max');
        if (this.hasAttribute('step')) input.step = this.getAttribute('step');
        if (this.hasAttribute('spellcheck')) input.spellcheck = this.getAttribute('spellcheck') !== 'false';
    }

    /** type 需要读写一致：业务代码常用 el.type = 'text' 做明文切换 */
    get type() { return this.getAttribute('type') || 'text'; }
    set type(v) { this.setAttribute('type', v || 'text'); }

    /** 与原生 input 一致的读写接口 */
    get value() { return this._input ? this._input.value : ''; }
    set value(v) { if (this._input) this._input.value = v == null ? '' : String(v); }

    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) { v ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); }

    get readOnly() { return this.hasAttribute('readonly'); }
    set readOnly(v) { v ? this.setAttribute('readonly', '') : this.removeAttribute('readonly'); }

    get placeholder() { return this.getAttribute('placeholder') || ''; }
    set placeholder(v) { v ? this.setAttribute('placeholder', v) : this.removeAttribute('placeholder'); }

    focus(opts) { if (this._input) this._input.focus(opts); }
    blur() { if (this._input) this._input.blur(); }
    select() { if (this._input) this._input.select(); }
}

if (!customElements.get('oc-input')) {
    customElements.define('oc-input', OcInput);
}

// ============================================================
// 字段组工具（原 components/field.js，已合并进本文件）
// ============================================================
// controlHtml 产出 <oc-input> / <oc-select> / <oc-textarea>；
// fieldHtml 额外包一层 .field（标签 + 控件 + 说明）。
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
