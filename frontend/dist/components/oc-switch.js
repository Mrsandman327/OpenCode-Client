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
