import { escapeAttr } from '../core/utils.js';

// ============================================================
// oc-search 自定义元素（Shadow DOM）
// ============================================================
// 用法：
//   <oc-search id="providerSearch" placeholder="搜索供应商、模型…"></oc-search>
//   <oc-search id="forkSearch" placeholder="搜索" no-icon></oc-search>
//   <oc-search id="fbSearch">{尾部 × 自动出现，点它清空}</oc-search>
//       <span slot="trailing" class="count">3</span>
//   </oc-search>
//
// 属性：
//   placeholder / value / no-icon / size（md 默认 | sm）
//   尾部 × 是「清空输入内容」，有内容时自动出现；需要关掉时加 noclear
// 接口：
//   el.value / el.focus() / el.select() / el.blur()
// 事件：
//   input（输入）、clear（点清空按钮）
//
// 样式变量：
//   oc-search { --search-h: 30px; --search-radius: 8px; --search-bg: var(--bg-input); }
//   oc-search::part(input) { letter-spacing: 1px; }

const SHEET = new CSSStyleSheet();
SHEET.replaceSync(`
/* 只放布局：padding/border/background 放在 .frame 上，
   否则会被页面里的全局 reset（* { padding: 0 }）覆盖 */
:host {
    display: inline-flex;
    align-items: stretch;
    min-width: 0;
    vertical-align: middle;
}
:host([hidden]) { display: none; }

.frame {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: var(--search-h, 30px);
    padding: 0;
    padding-left: var(--search-px, 10px);
    padding-right: var(--search-px, 10px);
    background: var(--search-bg, var(--bg-input));
    border: 1px solid var(--search-border, var(--border));
    border-radius: var(--search-radius, var(--radius-sm, 8px));
    color: var(--text-muted);
    box-sizing: border-box;
    min-width: 0;
}
.frame:focus-within { border-color: var(--accent); }

.icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: currentColor;
}
.icon svg {
    width: 14px;
    height: 14px;
    display: block;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
}

input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--search-fs, 12px);
    font-family: var(--search-font, inherit);
    outline: none;
}
input::placeholder { color: var(--text-muted); }
/* 去掉 WebKit 自带的搜索清除按钮，统一用组件自己的 */
input::-webkit-search-cancel-button { display: none; }

.clear {
    display: none;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 12px;
    line-height: 1;
}
.clear:hover { color: var(--text-primary); }
/* 尾部 × 的作用是「清空输入内容」，不是关闭：
   默认有内容才出现；确实不需要清除按钮的搜索框加 noclear */
:host([has-value]:not([noclear])) .clear { display: inline-flex; }

:host([size="sm"]) .frame { height: var(--search-h, 26px); }
::slotted([slot="trailing"]) { flex-shrink: 0; }
`);

class OcSearch extends HTMLElement {
    static get observedAttributes() {
        return ['placeholder', 'value', 'no-icon', 'size'];
    }

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.adoptedStyleSheets = [SHEET];
        root.innerHTML =
            '<div class="frame" part="frame">' +
                    '<span class="icon" part="icon" hidden>' +
                    '<svg aria-hidden="true"><use part="use" href="#i-search"></use></svg>' +
                '</span>' +
                '<input part="input" type="search" />' +
                '<span class="clear" part="clear" title="清空">×</span>' +
                '<slot name="trailing"></slot>' +
            '</div>';
        this._input = root.querySelector('input');
        this._icon = root.querySelector('.icon');
        this._clear = root.querySelector('.clear');
    }

    connectedCallback() {
        if (!this._bound) {
            this._bound = true;
            this._input.addEventListener('input', () => {
                this._syncClear();
                this.dispatchEvent(new CustomEvent('input', { bubbles: true, composed: true }));
            });
            this._input.addEventListener('keydown', (event) => {
                this.dispatchEvent(new CustomEvent('keydown', { bubbles: true, composed: true, cancelable: event.cancelable, detail: { originalEvent: event } }));
            });
            this._clear.addEventListener('click', () => {
                this.value = '';
                this.dispatchEvent(new CustomEvent('input', { bubbles: true, composed: true }));
                this.dispatchEvent(new CustomEvent('clear', { bubbles: true, composed: true }));
                this._input.focus();
            });
        }
        this._syncIcon();
        this._sync();
    }

    attributeChangedCallback() {
        this._syncIcon();
        this._sync();
    }

    _syncIcon() {
        if (!this._icon) return;
        this._icon.hidden = this.hasAttribute('no-icon');
        if (this.hasAttribute('no-icon')) return;
        // sprite 图标在页面文档里，shadow 内需要克隆一份 symbol 才能解析
        const root = this.shadowRoot;
        if (!root.querySelector('symbol[data-oc-clone="i-search"]')) {
            const src = document.getElementById('i-search');
            if (src) {
                const clone = src.cloneNode(true);
                clone.setAttribute('data-oc-clone', 'i-search');
                const defs = root.querySelector('svg.oc-defs') || (function () {
                    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    s.setAttribute('class', 'oc-defs');
                    s.style.display = 'none';
                    root.appendChild(s);
                    return s;
                })();
                defs.appendChild(clone);
            }
        }
        const use = root.querySelector('use');
        if (use) use.setAttribute('href', '#i-search');
    }

    _sync() {
        if (!this._input) return;
        this._input.placeholder = this.getAttribute('placeholder') || '';
        if (this.hasAttribute('value')) this._input.value = this.getAttribute('value');
        this._syncClear();
    }

    /** 同步「有内容」标记，控制尾部 × 的显隐（不写进 observedAttributes，避免循环） */
    _syncClear() {
        if (!this._input) return;
        this.toggleAttribute('has-value', !!this._input.value);
    }

    get value() { return this._input ? this._input.value : ''; }
    set value(v) {
        if (!this._input) return;
        this._input.value = v == null ? '' : String(v);
        this._syncClear();
    }

    get placeholder() { return this.getAttribute('placeholder') || ''; }
    set placeholder(v) { v ? this.setAttribute('placeholder', v) : this.removeAttribute('placeholder'); }

    focus(opts) { if (this._input) this._input.focus(opts); }
    blur() { if (this._input) this._input.blur(); }
    select() { if (this._input) this._input.select(); }
}

if (!customElements.get('oc-search')) {
    customElements.define('oc-search', OcSearch);
}

// ============================================================
// 搜索框模板工具（原 components/search.js，已合并进本文件）
// ============================================================
// 统一「图标 + 无边框输入框 + 容器描边」的搜索结构（样式在本文件的 SHEET 里）：
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
