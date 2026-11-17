// ============================================================
// oc-icon-button 自定义元素（Shadow DOM）
// ============================================================
// 定位：纯图标按钮（没有文字）。原来全项目有 20 多处手写图标按钮，
// 尺寸（20/22/24/28/30px）、图标来源（sprite <use> / oc-fb-icon 遮罩 / 内联 SVG）、
// hover 反馈各写一套，这个组件把「点击区尺寸 + 图标尺寸 + 三种图标来源」收敛到一处。
//
// 用法：
//   <oc-icon-button icon="i-x" title="关闭"></oc-icon-button>
//   <oc-icon-button icon-mask="minus" size="sm" title="移除"></oc-icon-button>
//   <oc-icon-button size="lg" title="附件"><svg slot="icon">…</svg></oc-icon-button>
//
// 属性：
//   icon        sprite 里的 symbol id（会克隆进 shadow root，跨 tree 的 <use> 解析不到）
//   icon-mask   assets 里的遮罩图标名，生成 <span class="oc-fb-icon oc-fb-icon-<name>">
//   size        xs(20px) | sm(22px) | md(28px，默认) | lg(30px)
//   title       必填：同时写到内部 button 的 title 与 aria-label，保证有 tooltip 与无障碍名
//   active      持久选中态（如「已在显示明文」的眼睛按钮）
//   disabled    禁用态
//
// 变量（写在宿主上）：
//   --icon-box          点击区边长（默认随 size 档位）
//   --icon-size         图标边长（默认随 size 档位：xs/sm 12px、md 14px、lg 15px）
//   --icon-radius       悬停色块圆角（默认 6px）
//   --icon-color        图标颜色；--icon-color-hover 悬停颜色
//   --icon-bg-hover     悬停底色（默认透明，只变色）
//   --icon-stroke       描边粗细（默认 2）
//
// 事件：内部是原生 <button>，click 会冒泡到宿主，外部照常 addEventListener。
//
// 布局约定：组件只管「按钮本体」，position / margin 一律由外部类决定。

const SHEET = new CSSStyleSheet();
SHEET.replaceSync(`
:host {
    display: inline-flex;
    flex-shrink: 0;
    vertical-align: middle;
    /* 尺寸档位给出的默认边长，外部可用 --icon-box 覆盖 */
    width: var(--icon-box, 28px);
    height: var(--icon-box, 28px);
    font-family: inherit;
    line-height: 1;
}

:host([hidden]) { display: none; }

:host([size="xs"]) { width: var(--icon-box, 20px); height: var(--icon-box, 20px); }
:host([size="sm"]) { width: var(--icon-box, 22px); height: var(--icon-box, 22px); }
:host([size="md"]) { width: var(--icon-box, 28px); height: var(--icon-box, 28px); }
:host([size="lg"]) { width: var(--icon-box, 30px); height: var(--icon-box, 30px); }

button {
    /* 清掉浏览器默认外观，全部样式由下面给出 */
    all: unset;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    /* 默认无边框、透明底；带框的图标按钮（附件、目录返回）用变量开启 */
    border: var(--icon-border-width, 0) solid var(--icon-border, transparent);
    border-radius: var(--icon-radius, 6px);
    background: var(--icon-bg, transparent);
    color: var(--icon-color, var(--text-secondary));
    cursor: pointer;
    outline: none;
    transition: background-color .15s ease, color .15s ease, border-color .15s ease;
}

/* 默认只变色，不出现色块；需要色块的地方给 --icon-bg-hover */
button:hover:not(:disabled) {
    background: var(--icon-bg-hover, var(--icon-bg, transparent));
    color: var(--icon-color-hover, var(--text-primary));
    border-color: var(--icon-border-hover, var(--icon-border, transparent));
}
button:active:not(:disabled) { transform: scale(0.94); }
button:disabled { opacity: 0.4; cursor: not-allowed; }

/* 持久选中态：图标通常换成强调色（如眼睛按钮「明文显示中」） */
:host([active]) button {
    color: var(--icon-active-color, var(--accent));
}

.icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    /* 折叠/展开箭头用：.is-collapsed { --icon-rotate: 180deg } */
    transform: rotate(var(--icon-rotate, 0deg));
    transition: transform .14s ease;
}

/* sprite 图标：尺寸与描边由变量控制 */
.icon svg {
    width: var(--icon-size, 14px);
    height: var(--icon-size, 14px);
    display: block;
    fill: none;
    stroke: currentColor;
    stroke-width: var(--icon-stroke, 2);
    stroke-linecap: round;
    stroke-linejoin: round;
}

:host([size="xs"]) .icon svg,
:host([size="sm"]) .icon svg { width: var(--icon-size, 12px); height: var(--icon-size, 12px); }
:host([size="lg"]) .icon svg { width: var(--icon-size, 15px); height: var(--icon-size, 15px); }

/* 外部经 slot="icon" 塞进来的 SVG：尺寸同样统一，颜色走 currentColor */
::slotted([slot="icon"]) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}
/* 注意：遮罩图标（oc-fb-icon-*）是 span，尺寸受项目里 .oc-fb-icon 的
   width/height 控制。::slotted 的优先级低于文档里的类选择器，所以这里
   不强行覆盖——需要特定尺寸时，在外部写「.某按钮 .oc-fb-icon」即可。 */
::slotted(svg[slot="icon"]) {
    width: var(--icon-size, 14px);
    height: var(--icon-size, 14px);
    fill: none;
    stroke: currentColor;
    stroke-width: var(--icon-stroke, 2);
    stroke-linecap: round;
    stroke-linejoin: round;
}
`);

class OcIconButton extends HTMLElement {
    static get observedAttributes() {
        return ['icon', 'icon-mask', 'size', 'title', 'active', 'disabled'];
    }

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.adoptedStyleSheets = [SHEET];
        root.innerHTML = '<button part="button" type="button"><span class="icon" part="icon"></span></button>';
        this._btn = root.querySelector('button');
        this._icon = root.querySelector('.icon');
    }

    connectedCallback() {
        this._sync();
        this._syncIcon();
    }

    attributeChangedCallback() {
        this._sync();
        this._syncIcon();
    }

    /** 无障碍名与禁用态同步给内部真实按钮 */
    _sync() {
        if (!this._btn) return;
        const title = this.getAttribute('title') || '';
        if (title) {
            this._btn.title = title;
            this._btn.setAttribute('aria-label', title);
        }
        this._btn.disabled = this.hasAttribute('disabled');
        this.setAttribute('aria-disabled', this.hasAttribute('disabled') ? 'true' : 'false');
    }

    /**
     * 图标来源优先级：
     *   1) 外部塞进 slot="icon" 的自定义 SVG
     *   2) icon-mask 属性 → assets 里的 oc-fb-icon-* 遮罩图标
     *   3) icon 属性 → 克隆主文档 sprite 里的 symbol
     */
    _syncIcon() {
        if (!this._icon) return;

        const slotted = this.querySelector('[slot="icon"]');
        if (slotted) {
            if (!this._icon.querySelector('slot')) this._icon.innerHTML = '<slot name="icon"></slot>';
            return;
        }

        const mask = this.getAttribute('icon-mask');
        if (mask) {
            let el = this.querySelector('[data-oc-icon]');
            if (!el || el.getAttribute('data-oc-icon') !== mask) {
                if (el) el.remove();
                el = document.createElement('span');
                el.setAttribute('slot', 'icon');
                el.setAttribute('data-oc-icon', mask);
                el.setAttribute('aria-hidden', 'true');
                el.className = 'oc-fb-icon oc-fb-icon-' + mask;
                this.appendChild(el);
            }
            this._icon.innerHTML = '<slot name="icon"></slot>';
            return;
        }

        const id = this.getAttribute('icon');
        if (!id) { this._icon.innerHTML = ''; return; }
        if (!this._ensureSymbol(id)) { this._icon.innerHTML = ''; return; }

        this._icon.innerHTML = '';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', '#' + id);
        svg.appendChild(use);
        this._icon.appendChild(svg);
    }

    /**
     * 把主文档 sprite 里的 <symbol> 克隆一份进 shadow root。
     * <use href="#id"> 的引用作用域是所在 tree，直接指向页面里的 symbol 在
     * Shadow DOM 内解析不到，图标会是空白。同一个图标只克隆一次。
     */
    _ensureSymbol(id) {
        const root = this.shadowRoot;
        if (root.querySelector('symbol[data-oc-clone="' + id + '"]')) return true;
        const src = document.getElementById(id);
        if (!src || src.tagName.toLowerCase() !== 'symbol') return false;

        let defs = root.querySelector('svg.oc-defs');
        if (!defs) {
            defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            defs.setAttribute('class', 'oc-defs');
            defs.setAttribute('aria-hidden', 'true');
            defs.style.display = 'none';
            root.appendChild(defs);
        }
        const clone = src.cloneNode(true);
        clone.setAttribute('data-oc-clone', id);
        // symbol 自带的 stroke-width 表现属性优先级高于继承值，会吃掉 --icon-stroke
        clone.removeAttribute('stroke-width');
        clone.querySelectorAll('*').forEach(function (node) {
            node.removeAttribute('stroke-width');
        });
        defs.appendChild(clone);
        return true;
    }

    /* 与原生 button 一致的读写习惯 */
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) { v ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); }

    get active() { return this.hasAttribute('active'); }
    set active(v) { v ? this.setAttribute('active', '') : this.removeAttribute('active'); }

    get icon() { return this.getAttribute('icon') || ''; }
    set icon(v) { v ? this.setAttribute('icon', v) : this.removeAttribute('icon'); }

    get size() { return this.getAttribute('size') || 'md'; }
    set size(v) { v ? this.setAttribute('size', v) : this.removeAttribute('size'); }

    focus(opts) { if (this._btn) this._btn.focus(opts); }
    blur() { if (this._btn) this._btn.blur(); }
}

if (!customElements.get('oc-icon-button')) {
    customElements.define('oc-icon-button', OcIconButton);
}
