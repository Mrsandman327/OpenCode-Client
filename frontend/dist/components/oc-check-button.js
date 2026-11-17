// ============================================================
// oc-check-button 自定义元素（Shadow DOM）
// ============================================================
// 定位：单个「复选按钮」——方框 + 文字，可多选，支持半选（全选表头用）。
// 形态与 oc-radio-button 对齐：无外框、无底色，只留「方框 + 文字」。
//
// 用法：
//   <oc-check-button value="vision" checked>视觉</oc-check-button>
//   <oc-check-button id="selectAll" indeterminate>全选</oc-check-button>
//   <oc-check-button value="tools" disabled>工具</oc-check-button>
//
// 属性：
//   value          该选项的值，change 里带出去
//   checked        选中
//   indeterminate  半选（只影响视觉与 change 的语义，不会自动变成 checked）
//   name           分组名（仅用于调用方按组查询，不做互斥）
//   disabled       禁用
//
// 事件：
//   change —— { detail: { value, name, checked, indeterminate } }，bubbles + composed
//
// 对外接口（与原生 checkbox 接近）：
//   el.checked / el.indeterminate / el.value / el.name / el.disabled
//
// 样式变量（写在宿主上）：
//   --check-box       方框边长（默认 13px）
//   --check-radius    方框圆角（默认 3px）
//   --check-gap       方框到文字的间距（默认 6px）
//   --check-fs        字号（默认 12.5px）
//   --check-accent    选中/半选的主色（默认 --accent）
//   --check-fg / --check-fg-on   文字色 / 选中文字色

const SHEET = new CSSStyleSheet();
SHEET.replaceSync(`
:host {
    display: inline-flex;
    vertical-align: middle;
    font-family: inherit;
    line-height: 1.2;
}

:host([hidden]) { display: none; }

.frame {
    all: unset;
    display: inline-flex;
    align-items: center;
    gap: var(--check-gap, 6px);
    box-sizing: border-box;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--check-fg, var(--text-secondary));
    font-family: inherit;
    font-size: var(--check-fs, 12.5px);
    cursor: pointer;
    outline: none;
    transition: color .15s ease;
}

.frame:hover:not(:disabled) { color: var(--check-fg-hover, var(--text-primary)); }
.frame:focus-visible { border-radius: 4px; box-shadow: 0 0 0 2px var(--accent-ghost); }
:host([checked]) .frame,
:host([indeterminate]) .frame { color: var(--check-fg-on, var(--text-primary)); }
:host([disabled]) .frame { opacity: 0.5; cursor: not-allowed; }

/* ---------- 方框 ---------- */
.box {
    position: relative;
    width: var(--check-box, 13px);
    height: var(--check-box, 13px);
    box-sizing: border-box;
    border: 1.5px solid var(--check-border, var(--border-light));
    border-radius: var(--check-radius, 3px);
    flex-shrink: 0;
    transition: border-color .15s ease, background-color .15s ease;
}

/* 未选中到选中/半选的统一底色 */
:host([checked]) .box,
:host([indeterminate]) .box {
    border-color: var(--check-accent, var(--accent));
    background: var(--check-accent, var(--accent));
}

/* 勾：一条旋转 45 度的折线 */
.box::after {
    content: '';
    position: absolute;
    left: 3.6px;
    top: 1.1px;
    width: 3.2px;
    height: 6.4px;
    border: solid #fff;
    border-width: 0 1.5px 1.5px 0;
    transform: rotate(45deg);
    opacity: 0;
}
:host([checked]) .box::after { opacity: 1; }

/* 半选：中间一条横线（与勾互斥） */
:host([indeterminate]) .box::after {
    left: 50%;
    top: 50%;
    width: 6px;
    height: 0;
    margin-left: -3px;
    border-width: 0 0 1.5px 0;
    transform: none;
    opacity: 1;
}
:host([indeterminate]) .box::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 6px;
    height: 1.5px;
    margin-left: -3px;
    margin-top: -0.75px;
    background: #fff;
    border-radius: 1px;
}

.label {
    display: inline-flex;
    align-items: center;
    gap: var(--check-gap, 6px);
    min-width: 0;
}
`);

class OcCheckButton extends HTMLElement {
    static get observedAttributes() {
        return ['checked', 'indeterminate', 'disabled', 'value', 'name', 'label'];
    }

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.adoptedStyleSheets = [SHEET];
        root.innerHTML =
            '<button class="frame" part="button" type="button" role="checkbox">' +
                '<span class="box" part="box" aria-hidden="true"></span>' +
                '<span class="label" part="label"><slot></slot></span>' +
            '</button>';
        this._btn = root.querySelector('.frame');
        this._btn.addEventListener('click', () => this._onClick());
    }

    connectedCallback() { this._sync(); }
    attributeChangedCallback() { this._sync(); }

    _sync() {
        if (!this._btn) return;
        const checked = this.hasAttribute('checked');
        const indeterminate = this.hasAttribute('indeterminate');
        this._btn.disabled = this.hasAttribute('disabled');
        this._btn.setAttribute('aria-checked', indeterminate ? 'mixed' : (checked ? 'true' : 'false'));
        const name = this.getAttribute('name') || '';
        const label = this.getAttribute('label') || '';
        if (label) this._btn.setAttribute('aria-label', label);
        if (name) this._btn.dataset.group = name;
    }

    _onClick() {
        if (this.hasAttribute('disabled')) return;
        // 半选态点一下 → 变成全选（与浏览器原生 checkbox 的默认行为一致）
        if (this.hasAttribute('indeterminate')) {
            this.removeAttribute('indeterminate');
            this.setAttribute('checked', '');
        } else if (this.hasAttribute('checked')) {
            this.removeAttribute('checked');
        } else {
            this.setAttribute('checked', '');
        }
        this.dispatchEvent(new CustomEvent('change', {
            bubbles: true,
            composed: true,
            detail: {
                value: this.value,
                name: this.name,
                checked: this.hasAttribute('checked'),
                indeterminate: this.hasAttribute('indeterminate')
            }
        }));
    }

    /* ---------- 与原生 checkbox 一致的读写接口 ---------- */
    get checked() { return this.hasAttribute('checked'); }
    set checked(v) { v ? this.setAttribute('checked', '') : this.removeAttribute('checked'); }

    get indeterminate() { return this.hasAttribute('indeterminate'); }
    set indeterminate(v) { v ? this.setAttribute('indeterminate', '') : this.removeAttribute('indeterminate'); }

    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) { v ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); }

    get value() { return this.getAttribute('value') || ''; }
    set value(v) { v == null ? this.removeAttribute('value') : this.setAttribute('value', String(v)); }

    get name() { return this.getAttribute('name') || ''; }
    set name(v) { v ? this.setAttribute('name', v) : this.removeAttribute('name'); }

    focus(opts) { if (this._btn) this._btn.focus(opts); }
    blur() { if (this._btn) this._btn.blur(); }
}

if (!customElements.get('oc-check-button')) {
    customElements.define('oc-check-button', OcCheckButton);
}
