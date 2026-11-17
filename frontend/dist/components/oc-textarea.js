// ============================================================
// oc-textarea 自定义元素（Shadow DOM）
// ============================================================
// 用法：
//   <oc-textarea id="summary" rows="3" placeholder="一两句话概括"></oc-textarea>
//   <oc-textarea id="content" class="kb-field-content" spellcheck="false"></oc-textarea>
//
// 属性：placeholder / value / rows / disabled / readonly / maxlength / spellcheck
// 内容：宿主标签内部的文本会作为初始值同步到内部 textarea
//
// 对外接口与原生 textarea 一致：
//   el.value / el.disabled / el.readOnly / el.focus()
//   el.selectionStart / el.selectionEnd / el.setSelectionRange()（光标位置代理）
//   el.addEventListener('input' | 'change' | 'keydown' | …)
//
// 可覆盖变量与 oc-input 相同：--oc-input-h 不适用，改的是 --oc-input-padding
//   oc-textarea { --oc-input-fs: 13px; --oc-input-padding: 10px 12px; }
//   oc-textarea::part(textarea) { line-height: 1.7; }

const SHEET = new CSSStyleSheet();
SHEET.replaceSync(`
:host {
    /* flex 而不是 block：宿主被 flex:1 拉伸时，内部 textarea 才能跟着长高 */
    display: flex;
    width: var(--oc-input-w, 100%);
    min-width: 0;
    min-height: 0;
    font-family: inherit;
}

:host([hidden]) { display: none; }

textarea {
    display: block;
    width: 100%;
    flex: 1 1 auto;
    /* 与 oc-input 保持同一套字体：等宽，便于写 Markdown / 日志 */
    font-family: var(--oc-input-font, "Cascadia Code", Consolas, "SF Mono", Menlo, monospace);
    min-height: var(--oc-textarea-min-h, 64px);
    padding: var(--oc-input-padding, 8px 9px);
    border: var(--oc-input-border-width, 1px) var(--oc-input-border-style, solid) var(--oc-input-border, var(--border));
    border-radius: var(--oc-input-radius, var(--radius-sm, 8px));
    background: var(--oc-input-bg, var(--bg-input));
    color: var(--oc-input-fg, var(--text-primary));
    font-size: var(--oc-input-fs, 12px);
    line-height: 1.6;
    box-sizing: border-box;
    outline: none;
    resize: vertical;
    transition: border-color .15s ease;
}

textarea::placeholder { color: var(--text-muted); font-family: inherit; }
textarea:focus { border-color: var(--accent); }
textarea:disabled { opacity: 0.5; cursor: not-allowed; }
`);

class OcTextarea extends HTMLElement {
    static get observedAttributes() {
        return ['placeholder', 'value', 'rows', 'disabled', 'readonly', 'maxlength', 'spellcheck'];
    }

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.adoptedStyleSheets = [SHEET];
        root.innerHTML = '<textarea part="textarea"></textarea>';
        this._ta = root.querySelector('textarea');
    }

    connectedCallback() {
        this._bindForward();
        // 宿主内部的文本作为初始值
        if (!this.hasAttribute('value') && !this._initialized) {
            this._ta.value = this.textContent.trim();
        }
        this._initialized = true;
        this._sync();
    }

    attributeChangedCallback() {
        this._sync();
    }

    _bindForward() {
        if (this._forwarded) return;
        this._forwarded = true;
        // 转发清单与 oc-input 对齐：聊天输入框要监听 paste（粘贴图片/文件）
        ['input', 'change', 'keydown', 'keyup', 'keypress', 'paste', 'select', 'focus', 'blur'].forEach((type) => {
            this._ta.addEventListener(type, (event) => {
                this.dispatchEvent(new CustomEvent(type, {
                    bubbles: type !== 'focus' && type !== 'blur',
                    composed: true,
                    cancelable: event.cancelable,
                    detail: { originalEvent: event }
                }));
            });
        });
    }

    _sync() {
        if (!this._ta) return;
        this._ta.placeholder = this.getAttribute('placeholder') || '';
        if (this.hasAttribute('value')) this._ta.value = this.getAttribute('value');
        if (this.hasAttribute('rows')) this._ta.rows = Number(this.getAttribute('rows')) || 3;
        this._ta.disabled = this.hasAttribute('disabled');
        this._ta.readOnly = this.hasAttribute('readonly');
        if (this.hasAttribute('maxlength')) this._ta.maxLength = Number(this.getAttribute('maxlength'));
        if (this.hasAttribute('spellcheck')) this._ta.spellcheck = this.getAttribute('spellcheck') !== 'false';
    }

    get value() { return this._ta ? this._ta.value : ''; }
    set value(v) { if (this._ta) this._ta.value = v == null ? '' : String(v); }

    /* ---------- 光标位置代理 ----------
       聊天输入框（#ocPrompt）要按光标插入 "@知识库" 引用，
       它读写的是 el.selectionStart / el.selectionEnd，
       不代理的话拿到的是宿主的 undefined，插入位置会算错。
       这四项都是「读写成对」的，缺 setter 会导致赋值静默失效。 */
    get selectionStart() { return this._ta ? this._ta.selectionStart : 0; }
    set selectionStart(v) { if (this._ta) this._ta.selectionStart = v; }

    get selectionEnd() { return this._ta ? this._ta.selectionEnd : 0; }
    set selectionEnd(v) { if (this._ta) this._ta.selectionEnd = v; }

    get selectionDirection() { return this._ta ? this._ta.selectionDirection : 'none'; }
    set selectionDirection(v) { if (this._ta) this._ta.selectionDirection = v; }

    /** 与原生 textarea 同名：一次设置选区的起点、终点与方向 */
    setSelectionRange(start, end, direction) {
        if (this._ta) this._ta.setSelectionRange(start, end, direction);
    }

    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) { v ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); }

    get readOnly() { return this.hasAttribute('readonly'); }
    set readOnly(v) { v ? this.setAttribute('readonly', '') : this.removeAttribute('readonly'); }

    get placeholder() { return this.getAttribute('placeholder') || ''; }
    set placeholder(v) { v ? this.setAttribute('placeholder', v) : this.removeAttribute('placeholder'); }

    focus(opts) { if (this._ta) this._ta.focus(opts); }
    blur() { if (this._ta) this._ta.blur(); }
    select() { if (this._ta) this._ta.select(); }
}

if (!customElements.get('oc-textarea')) {
    customElements.define('oc-textarea', OcTextarea);
}
