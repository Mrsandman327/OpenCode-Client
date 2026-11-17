import { escapeAttr } from '../core/utils.js';

// ============================================================
// oc-switch 自定义元素（Shadow DOM）
// ============================================================
// 用法：
//   <oc-switch id="mcpEnabled" checked></oc-switch>
//   <oc-switch id="proxyEnabled" disabled title="代理开关"></oc-switch>
//
// 属性：checked / disabled / name / title / aria-label
// 接口（与原生 checkbox 一致）：
//   el.checked / el.disabled / el.input（内部 checkbox）/ el.focus()
//   el.addEventListener('change', …)   —— 内部事件不跨 shadow，已手动转发
//
// 尺寸由 CSS 变量控制：
//   oc-switch { --sw-track-w: 34px; --sw-track-h: 20px; }
//   oc-switch::part(track) { … }  oc-switch::part(thumb) { … }

const SHEET = new CSSStyleSheet();
SHEET.replaceSync(`
:host {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    vertical-align: middle;
    cursor: pointer;
    user-select: none;
}
:host([hidden]) { display: none; }
:host([disabled]) { cursor: not-allowed; }

/* 真正的 checkbox 只做可访问性承载，视觉完全由 track/thumb 表达 */
input {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    opacity: 0;
    overflow: hidden;
}

label {
    position: relative;
    display: inline-flex;
    align-items: center;
    cursor: inherit;
}

.track {
    position: relative;
    width: var(--sw-track-w, 34px);
    height: var(--sw-track-h, 20px);
    background: var(--border);
    border-radius: 9999px;
    flex-shrink: 0;
    transition: background-color .2s ease;
}

.thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: calc(var(--sw-track-h, 20px) - 4px);
    height: calc(var(--sw-track-h, 20px) - 4px);
    background: #fff;
    border-radius: 50%;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    transition: transform .2s ease;
}

input:checked + .track { background: var(--sw-on, var(--accent)); }
input:checked + .track .thumb {
    /* 位移 = 轨道宽 - 滑块宽 - 左右各 2px 内缩 */
    transform: translateX(calc(var(--sw-track-w, 34px) - var(--sw-track-h, 20px)));
}

input:disabled + .track { opacity: 0.35; }
input:disabled:checked + .track { background: var(--text-muted); }

input:focus-visible + .track {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
}

label:hover .track { opacity: 0.85; }
`);

class OcSwitch extends HTMLElement {
    static get observedAttributes() {
        return ['checked', 'disabled', 'name', 'aria-label'];
    }

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.adoptedStyleSheets = [SHEET];
        root.innerHTML =
            '<label part="switch">' +
                '<input type="checkbox" part="input" />' +
                '<span class="track" part="track" aria-hidden="true"><span class="thumb" part="thumb"></span></span>' +
            '</label>';
        this._input = root.querySelector('input');
    }

    connectedCallback() {
        if (!this._bound) {
            this._bound = true;
            // 原生 change 不跨 shadow 边界，这里重新派发
            this._input.addEventListener('change', () => {
                this.toggleAttribute('checked', this._input.checked);
                this.dispatchEvent(new CustomEvent('change', {
                    bubbles: true,
                    composed: true,
                    detail: { checked: this._input.checked }
                }));
            });
        }
        this._sync();
    }

    attributeChangedCallback() {
        this._sync();
    }

    _sync() {
        if (!this._input) return;
        this._input.checked = this.hasAttribute('checked');
        this._input.disabled = this.hasAttribute('disabled');
        if (this.hasAttribute('name')) this._input.name = this.getAttribute('name');
        const label = this.getAttribute('aria-label') || this.getAttribute('title');
        if (label) this._input.setAttribute('aria-label', label);
    }

    /** 与原生 checkbox 一致的读写接口 */
    get checked() { return this.hasAttribute('checked'); }
    set checked(v) { v ? this.setAttribute('checked', '') : this.removeAttribute('checked'); }

    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) { v ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); }

    /** 兼容旧代码里 switch.input 的用法 */
    get input() { return this._input; }

    focus(opts) { if (this._input) this._input.focus(opts); }
    blur() { if (this._input) this._input.blur(); }
}

if (!customElements.get('oc-switch')) {
    customElements.define('oc-switch', OcSwitch);
}

// ============================================================
// 开关模板工具（原 components/switch.js，已合并进本文件）
// ============================================================
// ============================================================
// 统一开关控件
// ============================================================
// 全项目只有这一套开关结构（对应 css/style.css 里的 .sw），
// 各处不再自己拼 label + span + ::after。
//
// 结构固定为：
//   <label class="sw">
//       <input type="checkbox" />
//       <span class="sw-track"><span class="sw-thumb"></span></span>
//   </label>
// input 用 1px + 透明的方式视觉隐藏：既看不见，又保留在焦点序列里
// （键盘 Tab 能选中、空格能切换；display:none 会把它移出无障碍树）。
//
// 三种用法：
//   1) switchHtml(opts)     模板拼接 / innerHTML 场景，返回 HTML 字符串
//   2) createSwitch(opts)   动态创建场景，返回 DOM 节点（带 .input 引用与可选 onChange）
//   3) enhanceSwitches(root) 静态 HTML 场景：把裸 <input data-switch> 补出轨道与滑块
//
// 业务事件不写进组件：所有 id / class / data-* 都原样透传到 input，
// 现有的 getElementById、事件委托、change 监听可以继续用。


/** 开关根节点的类名（样式定义在 css/style.css） */
const SW_CLASS = 'sw';

/**
 * 生成开关的 HTML 字符串。
 *
 * @param {object} [opts]
 * @param {string} [opts.id]          input 的 id（保持既有 getElementById 可用）
 * @param {string} [opts.name]        input 的 name
 * @param {string} [opts.className]   input 额外类名（如 prov-edit-enabled）
 * @param {boolean} [opts.checked]    是否选中
 * @param {boolean} [opts.disabled]   是否禁用
 * @param {string} [opts.title]       整行的悬浮提示
 * @param {string} [opts.ariaLabel]   input 的无障碍名称
 * @param {object} [opts.attrs]       透传到 input 的其他属性（data-*、value 等）
 * @param {string} [opts.root]        根节点标签：'label'（默认）或 'span'
 * @param {string} [opts.extraClass]  根节点额外类名
 * @returns {string}
 */
export function switchHtml(opts) {
    opts = opts || {};
    // 外层已经是 <label> 时（例如整行可点的设置项）必须用 span：
    // HTML 不允许 label 嵌套 label，浏览器会把它拆开导致点击行为错乱。
    const tag = opts.root === 'span' ? 'span' : 'label';

    const inputAttrs = [];
    if (opts.id) inputAttrs.push('id="' + escapeAttr(opts.id) + '"');
    if (opts.name) inputAttrs.push('name="' + escapeAttr(opts.name) + '"');
    if (opts.className) inputAttrs.push('class="' + escapeAttr(opts.className) + '"');
    if (opts.checked) inputAttrs.push('checked');
    if (opts.disabled) inputAttrs.push('disabled');
    if (opts.ariaLabel) inputAttrs.push('aria-label="' + escapeAttr(opts.ariaLabel) + '"');

    // 额外属性：false / null 跳过，true 输出无值属性
    const extra = opts.attrs || {};
    Object.keys(extra).forEach(function(key) {
        const value = extra[key];
        if (value === false || value == null) return;
        if (value === true) inputAttrs.push(key);
        else inputAttrs.push(key + '="' + escapeAttr(value) + '"');
    });

    // 已经组件化：直接产出 <oc-switch>，外观与交互在组件内部
    const hostAttrs = [];
    if (opts.id) hostAttrs.push('id="' + escapeAttr(opts.id) + '"');
    if (opts.name) hostAttrs.push('name="' + escapeAttr(opts.name) + '"');
    if (opts.className) hostAttrs.push('class="' + escapeAttr(opts.className) + '"');
    if (opts.extraClass) hostAttrs.push('class="' + escapeAttr(opts.extraClass) + '"');
    if (opts.checked) hostAttrs.push('checked');
    if (opts.disabled) hostAttrs.push('disabled');
    if (opts.title) hostAttrs.push('title="' + escapeAttr(opts.title) + '"');
    if (opts.ariaLabel) hostAttrs.push('aria-label="' + escapeAttr(opts.ariaLabel) + '"');
    Object.keys(extra).forEach(function(key) {
        const value = extra[key];
        if (value === false || value == null) return;
        if (value === true) hostAttrs.push(key);
        else hostAttrs.push(key + '="' + escapeAttr(value) + '"');
    });
    return '<oc-switch ' + hostAttrs.join(' ') + '></oc-switch>';
}

/**
 * 创建开关 DOM 节点（动态渲染场景）。
 * 返回的根节点上挂了 .input 引用，业务侧可以直接绑事件或读取状态，
 * 不必再 querySelector，也不依赖 id。
 *
 * @param {object} [opts] 同 switchHtml，另支持 opts.onChange(event, input)
 * @returns {HTMLElement}
 */
export function createSwitch(opts) {
    opts = opts || {};
    const holder = document.createElement('div');
    holder.innerHTML = switchHtml(opts);
    const root = holder.firstElementChild;
    // 组件化后真正的 checkbox 在 shadow 里，通过 .input 暴露
    const input = root.input || root.querySelector('input[type="checkbox"]');
    if (typeof opts.onChange === 'function') {
        input.addEventListener('change', function(event) {
            opts.onChange(event, input);
        });
    }
    return root;
}

/**
 * 把静态 HTML 里的裸开关补全成统一结构：
 *   <label class="sw"><input type="checkbox" id="x" data-switch></label>
 *   → 自动补出 <span class="sw-track"><span class="sw-thumb"></span></span>
 *
 * 用 data-switch 属性标记需要增强的 input，避免和 .sw 容器类名互相干扰
 * （input 自身带 .sw 会命中容器的布局规则）。只改 DOM 结构，不碰事件，可重复调用。
 *
 * @param {ParentNode} [root] 搜索范围，默认 document
 */
export function enhanceSwitches(root) {
    const scope = root || document;
    if (!scope || !scope.querySelectorAll) return;
    const inputs = scope.querySelectorAll('input[data-switch][type="checkbox"]');
    for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        if (input.dataset && input.dataset.swReady === 'true') continue;
        const parent = input.parentElement;
        // 已经是组件产出的完整结构（父级是 .sw 且已有轨道）就不重复补
        if (parent && parent.classList.contains(SW_CLASS) && parent.querySelector('.sw-track')) {
            input.dataset.swReady = 'true';
            continue;
        }
        const track = document.createElement('span');
        track.className = 'sw-track';
        track.setAttribute('aria-hidden', 'true');
        const thumb = document.createElement('span');
        thumb.className = 'sw-thumb';
        track.appendChild(thumb);
        input.insertAdjacentElement('afterend', track);
        input.dataset.swReady = 'true';
    }
}

export { SW_CLASS };
