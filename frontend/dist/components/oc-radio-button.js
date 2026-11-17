// ============================================================
// oc-radio-button 自定义元素（Shadow DOM）
// ============================================================
// 定位：单个「单选按钮」——胶囊外框 + 圆点 + 文字。
// 同 name 的实例自动互斥，点击选中并派发 change，外部按原生 radio 的习惯接。
//
// 用法：
//   <oc-radio-button name="kbConvKind" value="skill">技能</oc-radio-button>
//   <oc-radio-button name="kbConvKind" value="command" checked>命令</oc-radio-button>
//   <oc-radio-button name="scope" value="project" disabled>项目</oc-radio-button>
//
// 属性：
//   name      分组名（同名互斥；不写则各自独立）
//   value     该选项的值，change 事件里带出去
//   checked   选中态
//   disabled  禁用
//
// 事件：
//   change —— { detail: { value, name } }，bubbles + composed，能跨 Shadow 边界
//
// 对外接口（与原生 radio 接近）：
//   el.checked / el.value / el.name / el.disabled
//
// 样式变量（写在宿主上）：
//   --radio-dot        圆点直径（默认 13px）
//   --radio-fs / --radio-gap                 字号（12.5px）与圆点到文字的间距（6px）
//   --radio-accent     选中色（默认 --accent）
//   --radio-fg / --radio-fg-on              文字色 / 选中文字色（形态为「圆点 + 文字」，无边框无底色）
//
// 布局约定：组件只管按钮本体，外层间距 / 排列由调用方决定。

const SHEET = new CSSStyleSheet();
SHEET.replaceSync(`
:host {
    display: inline-flex;
    vertical-align: middle;
    font-family: inherit;
    line-height: 1.2;
}

:host([hidden]) { display: none; }

/* 裸形态：只有「圆点 + 文字」，不加边框、不加底色、不留内边距。
   宿主上的 padding/border 会被页面里的 * { padding: 0 } 覆盖，所以外观都放在 .frame 上。 */
.frame {
    all: unset;
    display: inline-flex;
    align-items: center;
    gap: var(--radio-gap, 6px);
    box-sizing: border-box;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--radio-fg, var(--text-secondary));
    font-family: inherit;
    font-size: var(--radio-fs, 12.5px);
    font-weight: var(--radio-weight, 400);
    cursor: pointer;
    outline: none;
    transition: color .15s ease;
}

.frame:hover:not(:disabled) {
    color: var(--radio-fg-hover, var(--text-primary));
}

/* 键盘可达性：只在键盘聚焦时显示焦点环 */
.frame:focus-visible {
    border-radius: 4px;
    box-shadow: 0 0 0 2px var(--radio-focus, var(--accent-ghost));
}

/* 选中态只改文字颜色（圆点由下面单独处理） */
:host([checked]) .frame {
    color: var(--radio-fg-on, var(--text-primary));
}

:host([disabled]) .frame {
    opacity: 0.5;
    cursor: not-allowed;
}

/* ---------- 圆点 ---------- */
.dot {
    position: relative;
    width: var(--radio-dot, 13px);
    height: var(--radio-dot, 13px);
    border-radius: 50%;
    border: 1.5px solid var(--radio-dot-border, var(--border-light));
    flex-shrink: 0;
    box-sizing: border-box;
    transition: border-color .15s ease;
}

:host([checked]) .dot {
    border-color: var(--radio-accent, var(--accent));
}

/* 选中时内部实心点：inset 按圆点尺寸比例，改 --radio-dot 也能对齐 */
:host([checked]) .dot::after {
    content: '';
    position: absolute;
    /* 内部实心点：约占圆点直径的一半，比原来的细点点更明显 */
    inset: calc(var(--radio-dot, 13px) * 0.13);
    border-radius: 50%;
    background: var(--radio-accent, var(--accent));
}

.label {
    display: inline-flex;
    align-items: center;
    gap: var(--radio-gap, 6px);
    min-width: 0;
}
`);

class OcRadioButton extends HTMLElement {
    static get observedAttributes() {
        return ['checked', 'disabled', 'value', 'name', 'label'];
    }

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.adoptedStyleSheets = [SHEET];
        root.innerHTML =
            '<button class="frame" part="button" type="button" role="radio">' +
                '<span class="dot" part="dot" aria-hidden="true"></span>' +
                '<span class="label" part="label"><slot></slot></span>' +
            '</button>';
        this._btn = root.querySelector('.frame');
        this._btn.addEventListener('click', () => this._onClick());
    }

    connectedCallback() {
        // 同一 name 里出现多个 checked 时，以文档顺序第一个为准
        this._sync();
    }

    attributeChangedCallback(name) {
        this._sync();
    }

    _sync() {
        if (!this._btn) return;
        this._btn.disabled = this.hasAttribute('disabled');
        this._btn.setAttribute('aria-checked', this.hasAttribute('checked') ? 'true' : 'false');
        const name = this.getAttribute('name') || '';
        this._btn.setAttribute('aria-label', this.getAttribute('label') || '');
        if (name) this._btn.dataset.group = name;
    }

    _onClick() {
        if (this.hasAttribute('disabled')) return;
        // 已选中时再点不派发 change（与原生 radio 一致）
        if (this.hasAttribute('checked')) return;
        this._select();
        this.dispatchEvent(new CustomEvent('change', {
            bubbles: true,
            composed: true,
            detail: { value: this.value, name: this.name }
        }));
    }

    /** 选中自己，并把同 name 的其它实例取消选中 */
    _select() {
        const name = this.getAttribute('name') || '';
        if (name) {
            document.querySelectorAll('oc-radio-button').forEach((el) => {
                if (el !== this && (el.getAttribute('name') || '') === name) {
                    el.removeAttribute('checked');
                }
            });
        }
        this.setAttribute('checked', '');
    }

    /* ---------- 与原生 radio 一致的读写接口 ---------- */
    get checked() { return this.hasAttribute('checked'); }
    set checked(v) { v ? this.setAttribute('checked', '') : this.removeAttribute('checked'); }

    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) { v ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); }

    get value() { return this.getAttribute('value') || ''; }
    set value(v) { v == null ? this.removeAttribute('value') : this.setAttribute('value', String(v)); }

    get name() { return this.getAttribute('name') || ''; }
    set name(v) { v ? this.setAttribute('name', v) : this.removeAttribute('name'); }

    focus(opts) { if (this._btn) this._btn.focus(opts); }
    blur() { if (this._btn) this._btn.blur(); }
}

if (!customElements.get('oc-radio-button')) {
    customElements.define('oc-radio-button', OcRadioButton);
}

/** 静态方法：读取同名组当前选中项的 value（迁移时替代 querySelector('input:checked')） */
OcRadioButton.valueOfGroup = function (name) {
    const hit = Array.from(document.querySelectorAll('oc-radio-button'))
        .find((el) => (el.getAttribute('name') || '') === name && el.hasAttribute('checked'));
    return hit ? hit.value : '';
};
