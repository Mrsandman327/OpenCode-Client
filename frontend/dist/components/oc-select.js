// ============================================================
// oc-select 自定义元素（Shadow DOM）
// ============================================================
// 用法：
//   <oc-select id="scheduleTz">
//       <option value="Asia/Shanghai">Asia/Shanghai</option>
//       <option value="UTC">UTC</option>
//   </oc-select>
//
// 说明：<option> 必须写在宿主标签里（浏览器不允许 slot 到 select 内部），
// 组件会把它们克隆进 shadow 里的原生 select，并用 MutationObserver
// 跟随宿主 option 的变化（业务代码动态 append/替换 option 时自动同步）。
//
// 对外接口与原生 select 一致：
//   el.value / el.disabled / el.options / el.selectedIndex
//   el.addEventListener('change' | 'focus' | 'blur', …)
//
// 样式变量：
//   oc-select { --oc-input-h: 30px; --oc-input-fs: 12px; }
//   oc-select::part(select) { padding-right: 24px; }

const SHEET = new CSSStyleSheet();
SHEET.replaceSync(`
:host {
    display: inline-flex;
    width: var(--oc-input-w, 100%);
    min-width: 0;
    font-family: inherit;
    vertical-align: middle;
}

/* fit：宽度 = 最长选项的固有宽度（浏览器原生 auto 的行为），
   比 auto 更明确，也不会被父容器的 100% 拉宽 */
:host([fit]) {
    width: max-content;
    max-width: var(--oc-input-max-w, min(100%, 520px));
}
:host([fit]) select {
    width: auto;
}

:host([hidden]) { display: none; }

select {
    width: 100%;
    font-family: var(--oc-input-font, "Cascadia Code", Consolas, "SF Mono", Menlo, monospace);
    height: var(--oc-input-h, 30px);
    padding: 0 var(--oc-input-px, 9px);
    border: var(--oc-input-border-width, 1px) var(--oc-input-border-style, solid) var(--oc-input-border, var(--border));
    border-radius: var(--oc-input-radius, var(--radius-sm, 8px));
    background: var(--oc-input-bg, var(--bg-input));
    color: var(--oc-input-fg, var(--text-primary));
    font-size: var(--oc-input-fs, 12px);
    box-sizing: border-box;
    outline: none;
    cursor: pointer;
    transition: border-color .15s ease;
}

select:focus { border-color: var(--accent); }
select:disabled { opacity: 0.5; cursor: not-allowed; }
`);

class OcSelect extends HTMLElement {
    static get observedAttributes() {
        return ['value', 'disabled', 'fit'];
    }

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.adoptedStyleSheets = [SHEET];
        root.innerHTML = '<select part="select"></select>';
        this._select = root.querySelector('select');
    }

    connectedCallback() {
        this._bindForward();
        this._syncOptions();
        // 宿主 option 变化时同步（业务侧常直接 innerHTML / appendChild）
        if (!this._observer) {
            this._observer = new MutationObserver(() => this._syncOptions());
            this._observer.observe(this, { childList: true, subtree: true, characterData: true });
        }
        this._sync();
    }

    disconnectedCallback() {
        if (this._observer) { this._observer.disconnect(); this._observer = null; }
    }

    attributeChangedCallback() {
        this._sync();
    }

    _bindForward() {
        if (this._forwarded) return;
        this._forwarded = true;
        ['change', 'focus', 'blur'].forEach((type) => {
            this._select.addEventListener(type, (event) => {
                // 用户改选时把值同步回宿主 value 属性：MutationObserver 重建 option 后
                // 会按属性恢复选中，属性不同步就会退回第一个选项（显示成「默认」）
                if (type === 'change' && this.getAttribute('value') !== this._select.value) {
                    this.setAttribute('value', this._select.value);
                }
                this.dispatchEvent(new CustomEvent(type, {
                    bubbles: type !== 'focus' && type !== 'blur',
                    composed: true,
                    detail: { originalEvent: event }
                }));
            });
        });
    }

    /** 内部 select 是否已有某个 value 的选项 */
    _hasValue(value) {
        if (!this._select) return false;
        return Array.from(this._select.options).some((o) => o.value === value);
    }

    /** 把宿主里的 option 克隆进内部 select，保留当前选中值 */
    _syncOptions() {
        if (!this._select) return;
        // 业务侧常见写法是「先替换宿主 option，再立刻设置 el.value」：
        // MutationObserver 回调晚于这句赋值，此时内部 select 还只有旧选项，
        // 赋值会被原生 select 丢弃。所以这里以宿主 value 属性为准兜底。
        const keep = this._select.value || this.getAttribute('value') || '';
        this._select.innerHTML = '';
        const opts = Array.from(this.querySelectorAll('option'));
        opts.forEach((opt) => {
            const clone = opt.cloneNode(true);
            // 克隆节点保留 value/text，disabled/selected 也一并保留
            this._select.appendChild(clone);
        });
        // 只恢复确实存在的档位：模型不支持的值不能硬塞回下拉。
        // keep 为空表示「默认」——此时不要写 ''，否则第一个 option 值非空的下拉会变成空白
        if (keep) this._select.value = this._hasValue(keep) ? keep : '';
    }

    _sync() {
        if (!this._select) return;
        this._select.disabled = this.hasAttribute('disabled');
        if (this.hasAttribute('value')) this._select.value = this.getAttribute('value');
    }

    get value() {
        if (!this._select) return '';
        // 选项还没重建完时（MutationObserver 尚未回调），内部 select 是空值；
        // 此时以宿主 value 属性为准，避免调用方读到假的「默认」
        if (this._select.value !== '') return this._select.value;
        return this.getAttribute('value') || '';
    }
    set value(v) {
        if (!this._select) return;
        const s = v == null ? '' : String(v);
        this._select.value = s;
        // 关键：同步到属性。options 整体替换后由 _syncOptions 按属性恢复选中，
        // 否则「先换 option 再设 value」的写法会静默丢值、显示回第一个选项
        if (this.getAttribute('value') !== s) this.setAttribute('value', s);
    }

    get options() { return this._select ? this._select.options : []; }
    get selectedIndex() { return this._select ? this._select.selectedIndex : -1; }
    set selectedIndex(i) { if (this._select) this._select.selectedIndex = i; }

    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) { v ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); }

    focus(opts) { if (this._select) this._select.focus(opts); }
    blur() { if (this._select) this._select.blur(); }
}

if (!customElements.get('oc-select')) {
    customElements.define('oc-select', OcSelect);
}
