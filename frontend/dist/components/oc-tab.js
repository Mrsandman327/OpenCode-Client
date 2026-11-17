// ============================================================
// oc-tab 自定义元素（Shadow DOM）
// ============================================================
// 定位：会话区的标签页——标题 + 关闭按钮，整块可点。
//
// 用法：
//   <oc-tab data-session-id="ses_xxx">了解项目概况 (fork #2)</oc-tab>
//   <oc-tab active data-session-id="ses_yyy">定时任务及其他功能</oc-tab>
//   <oc-tab no-close>不可关闭的标签</oc-tab>
//
// 属性：
//   active     选中态（强调色描边 + 淡底 + 加粗）
//   no-close   不显示关闭按钮
//   disabled   禁用（不派发事件）
//
// 事件：
//   select —— 点击标签主体（不含关闭按钮）
//   close  —— 点击关闭按钮
//   两者都是 bubbles + composed，外部挂在宿主上即可
//
// 样式变量（写在宿主上）：
//   --tab-max-w    最大宽度（默认 220px，超出标题省略）
//   --tab-fs       字号（默认 13px）
//   --tab-px / --tab-py   内边距（14px / 6px）
//   --tab-radius   圆角（默认 radius-sm）
//
// 布局约定：组件只管标签本体，间距与排列由外层容器决定。

const SHEET = new CSSStyleSheet();
SHEET.replaceSync(`
:host {
    display: inline-flex;
    max-width: var(--tab-max-w, 260px);
    font-family: inherit;
    line-height: 1.2;
    flex-shrink: 0;
}

:host([hidden]) { display: none; }

.frame {
    display: inline-flex;
    align-items: center;
    gap: var(--tab-gap, 4px);
    box-sizing: border-box;
    max-width: 100%;
    min-width: 0;
    padding: var(--tab-py, 6px) var(--tab-px, 12px);
    /* 由 JS 按标题自然宽度写入：悬浮让位时总宽不变，只压缩文字 */
    width: var(--tab-w, auto);
    border: 1px solid var(--border);
    border-radius: var(--tab-radius, 3px);
    background: var(--bg-input);
    color: var(--text-primary);
    font-family: var(--tab-font, inherit);
    font-size: var(--tab-fs, 13px);
    font-weight: 500;
    cursor: pointer;
    outline: none;
    position: relative;
    top: 0;
    transition: color .12s ease, background-color .12s ease, border-color .12s ease, top .12s ease;
}

/* 悬停：统一轻微上移（用 top 而不是 transform，避免边框被重绘到半像素上显粗） */
.frame:hover {
    top: -1px;
}

.frame:hover .close {
    opacity: 1;
    pointer-events: auto;
}

/* 悬浮时标题最大宽度减 21px（17 按钮 + 4 间距）：标签总宽已锁，文字被直接裁掉 */
.frame:hover .title {
    max-width: calc(100% - 16px);
    text-overflow: clip;
}

/* 键盘聚焦到关闭按钮时也要可见 */
.close:focus-visible {
    opacity: 1;
    pointer-events: auto;
}

/* 悬停高亮只体现在关闭图标上，标签本身不出现底色/边框变化 */
.frame:focus-visible {
    box-shadow: 0 0 0 2px var(--accent-ghost);
}

:host([active]) .frame {
    background: var(--accent-ghost);
    color: var(--accent);
    border-color: var(--accent);
    font-weight: 600;
}

:host([disabled]) .frame {
    opacity: 0.5;
    cursor: not-allowed;
}

.title {
    flex: 1 1 0;
    box-sizing: border-box;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* ---------- 关闭按钮 ---------- */
/* 绝对定位：不占布局。悬浮时浮到右侧，标题让出对应宽度后文字被裁掉 */
.close {
    all: unset;
    position: absolute;
    right: 6px;
    top: calc(50% - 8.5px);
    flex-shrink: 0;
    width: 17px;
    height: 17px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-xs, 4px);
    color: var(--text-muted);
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transition: opacity .12s ease, color .12s ease;
}

/* 常态图标小一号；悬停时放大并加粗（容器固定 17×17，不会挤压布局） */
.close svg {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    display: block;
    transition: width .12s ease, height .12s ease, stroke-width .12s ease;
}
.close:hover svg {
    width: 11px;
    height: 11px;
    stroke-width: 2.1;
}

/* 悬停统一「加深」：未选中 灰 → 次文字色；选中 蓝 → 更深的蓝 */
.close:hover {
    color: var(--text-secondary);
}

:host([active]) .close {
    color: var(--accent);
}

:host([active]) .frame:hover .close {
    color: color-mix(in srgb, var(--accent) 80%, #000);
    opacity: 0.85;
}

:host([active]) .close:hover {
    color: color-mix(in srgb, var(--accent) 80%, #000);
    opacity: 1;
}

:host([no-close]) .close { display: none; }
`);

class OcTab extends HTMLElement {
    static get observedAttributes() {
        return ['active', 'no-close', 'disabled'];
    }

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.adoptedStyleSheets = [SHEET];
        root.innerHTML =
            '<div class="frame" part="frame" role="tab" tabindex="0">' +
                '<span class="title" part="title"><slot></slot></span>' +
                '<button class="close" part="close" type="button" aria-label="关闭">' +
                    '<svg aria-hidden="true" viewBox="0 0 12 12">' +
                        '<path d="M2 2l8 8M10 2l-8 8"/>' +
                    '</svg>' +
                '</button>' +
            '</div>';
        this._frame = root.querySelector('.frame');
        this._close = root.querySelector('.close');
        this._title = root.querySelector('.title');
        const slot = root.querySelector('slot');
        if (slot) slot.addEventListener('slotchange', () => this._lockWidth());

        this._frame.addEventListener('click', () => this._onSelect());
        this._frame.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            this._onSelect();
        });
        this._close.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.hasAttribute('disabled')) return;
            this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
        });
    }

    connectedCallback() {
        this._sync();
        // 首帧之后按标题自然宽度锁定标签宽度
        requestAnimationFrame(() => this._lockWidth());
    }

    /**
     * 按标题的自然宽度锁定标签宽度（写入 --tab-w）。
     * 悬浮时关闭按钮浮到右侧、标题加 padding-right 让位；因为总宽已锁死，
     * 多出来的部分会被直接裁掉，标签整体不会变宽。
     * 测量前必须把 padding 清零、去掉 --tab-w，否则量到的是上一次的结果。
     */
    _lockWidth() {
        const title = this._title;
        if (!title) return;
        // 用 Range 直接量文本自身的宽度：不受 flex 压缩、overflow 裁剪、max-width 影响。
        // 文本在 light DOM（通过 slot 投影），所以量宿主的文本节点。
        const range = document.createRange();
        range.selectNodeContents(this);
        const rect = range.getBoundingClientRect();
        range.detach && range.detach();
        const textW = rect.width || title.scrollWidth;
        // 26 = 左右内边距 24 + 边框 2
        this.style.setProperty('--tab-w', Math.ceil(textW + 26) + 'px');
    }
    attributeChangedCallback() { this._sync(); }

    _sync() {
        if (!this._frame) return;
        const active = this.hasAttribute('active');
        this._frame.setAttribute('aria-selected', active ? 'true' : 'false');
        this._frame.setAttribute('aria-disabled', this.hasAttribute('disabled') ? 'true' : 'false');
    }

    _onSelect() {
        if (this.hasAttribute('disabled')) return;
        this.dispatchEvent(new CustomEvent('select', { bubbles: true, composed: true }));
    }

    get active() { return this.hasAttribute('active'); }
    set active(v) { v ? this.setAttribute('active', '') : this.removeAttribute('active'); }

    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) { v ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); }

    focus(opts) { if (this._frame) this._frame.focus(opts); }
}

if (!customElements.get('oc-tab')) {
    customElements.define('oc-tab', OcTab);
}
