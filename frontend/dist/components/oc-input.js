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
    font-family: var(--oc-input-font, "Cascadia Code", Consolas, "SF Mono", Menlo, monospace);
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
