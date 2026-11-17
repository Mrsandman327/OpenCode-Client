// ============================================================
// oc-button 自定义元素（Shadow DOM）
// ============================================================
// 用法：
//   <oc-button>保存</oc-button>
//   <oc-button variant="primary">新建</oc-button>
//   <oc-button variant="primary" icon="i-plus">新建条目</oc-button>
//   <oc-button variant="secondary" size="sm" icon="i-refresh">刷新</oc-button>
//
// 属性：
//   variant = secondary（默认）| primary | danger | config | refresh
//   size    = md（默认）| sm | xs
//   icon    = sprite 图标 id（如 i-plus / i-refresh / i-x），不设则不显示图标
//   disabled / loading  布尔属性；也可以用 el.disabled = true 直接赋值
//   type    = button（默认）| submit | reset
//
// 图标有两种给法，优先级从高到低：
//   1) <oc-button icon="i-plus">          属性传 sprite id，组件内部生成 <svg><use>
//   2) <svg slot="icon">…</svg>           自己塞一个 SVG（用于 sprite 里没有的图标）
//   都不给则不留图标位，文字与边框之间不会多出空隙。
//
// 样式是隔离的（Shadow DOM）：宿主的 button / .btn 之类的选择器进不来。
// 要改外观只能通过下面两种方式：
//   1) CSS 变量（写在宿主标签上）
//        oc-button { --oc-btn-bg: #ff6a00; --oc-btn-radius: 10px; }
//      可用变量：--oc-btn-bg / --oc-btn-bg-hover / --oc-btn-fg / --oc-btn-fg-hover
//                --oc-btn-border / --oc-btn-border-hover / --oc-btn-radius
//                --oc-btn-px / --oc-btn-py / --oc-btn-fs / --oc-btn-weight
//                --oc-btn-gap / --oc-btn-icon
//   2) ::part 选择器
//        oc-button::part(button) { letter-spacing: 1px; }
//        oc-button::part(icon)   { width: 16px; }
//
// 事件：内部是原生 <button>，click / focus 等事件会正常冒泡到宿主元素。

/** 组件内部样式：只在 shadow root 内生效 */
const SHEET = new CSSStyleSheet();
SHEET.replaceSync(`
:host {
    display: inline-flex;
    /* 宿主被固定成方形（图标按钮）时，内部按钮要居中，否则会靠左导致图标偏移 */
    justify-content: center;
    align-items: stretch;
    vertical-align: middle;
    /* 字体默认继承页面，避免组件内变成浏览器默认字体 */
    font-family: inherit;
    line-height: 1.2;
}

:host([hidden]) { display: none; }

button {
    /* 清掉浏览器默认按钮外观，所有样式由下面统一给出 */
    all: unset;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--oc-btn-gap, 6px);
    box-sizing: border-box;
    /* 需要固定高度时由宿主给 --oc-btn-h（如聊天输入区 28px） */
    height: var(--oc-btn-h, auto);
    padding: var(--oc-btn-py, 8px) var(--oc-btn-px, 18px);
    border: 1px solid var(--oc-btn-border, transparent);
    border-radius: var(--oc-btn-radius, var(--radius-sm, 8px));
    background: var(--oc-btn-bg, transparent);
    color: var(--oc-btn-fg, var(--text-primary));
    font-size: var(--oc-btn-fs, 14px);
    font-weight: var(--oc-btn-weight, 500);
    font-family: inherit;
    letter-spacing: -0.01em;
    white-space: nowrap;
    cursor: pointer;
    outline: none;
    transition: background-color .2s ease, box-shadow .2s ease, color .2s ease, border-color .2s ease;
}

button:active:not(:disabled) { transform: scale(0.97); }
button:disabled { opacity: 0.4; cursor: not-allowed; }

/* ---------- 文本容器 ---------- */
/* light DOM 里常见写法是 <span class="btn-terminal-icon"></span>文字，
   这类图标靠 width/height + mask 显示；span 一旦处于普通 inline 上下文就塌成 0 宽，
   看起来就是"图标没了"。这里用 inline-flex 让内部节点都按 flex item 排布。 */
.label {
    display: inline-flex;
    align-items: center;
    gap: var(--oc-btn-gap, 6px);
    min-width: 0;
}

/* ---------- 图标位 ---------- */
.icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}
/* 没有图标时由 JS 把 .icon 隐藏，gap 不会留下多余空隙 */
.icon[hidden] { display: none; }
/* 属性生成的 sprite 图标：尺寸与线条粗细跟项目里的 .kb-i 保持一致 */
.icon svg {
    width: var(--oc-btn-icon, 14px);
    height: var(--oc-btn-icon, 14px);
    display: block;
    fill: none;
    stroke: currentColor;
    stroke-width: var(--oc-btn-icon-stroke, 3.2);
    stroke-linecap: round;
    stroke-linejoin: round;
}
/* 外部经 slot 塞进来的图标：尺寸交给外部类控制，这里只保证对齐 */
::slotted([slot="icon"]) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}
/* 外部塞进来的内联 SVG：尺寸与描边统一在这里，避免每个调用点各写一遍 */
::slotted(svg[slot="icon"]) {
    width: var(--oc-btn-icon, 15px);
    height: var(--oc-btn-icon, 15px);
    fill: none;
    stroke: currentColor;
    stroke-width: var(--oc-btn-icon-stroke, 1.9);
    stroke-linecap: round;
    stroke-linejoin: round;
}

/* ---------- 变体：只改颜色 ---------- */

/* 次级（默认）：灰描边，hover 转强调色 */
:host(:not([variant])) button,
:host([variant="secondary"]) button,
:host([variant="refresh"]) button,
:host([variant="open"]) button {
    background: var(--oc-btn-bg, var(--bg-input));
    color: var(--oc-btn-fg, var(--text-secondary));
    border-color: var(--oc-btn-border, var(--border));
}
:host(:not([variant])) button:hover:not(:disabled),
:host([variant="secondary"]) button:hover:not(:disabled),
:host([variant="refresh"]) button:hover:not(:disabled),
:host([variant="open"]) button:hover:not(:disabled) {
    background: var(--oc-btn-bg-hover, var(--bg-card-hover));
    color: var(--oc-btn-fg-hover, var(--accent));
    border-color: var(--oc-btn-border-hover, var(--accent));
}

/* 主操作：品牌蓝底白字 + 轻投影 */
:host([variant="primary"]) button {
    background: var(--oc-btn-bg, var(--accent));
    color: var(--oc-btn-fg, var(--text-on-accent));
    border-color: var(--oc-btn-border, transparent);
    font-weight: var(--oc-btn-weight, 600);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}
:host([variant="primary"]) button:hover:not(:disabled) {
    background: var(--oc-btn-bg-hover, var(--accent-hover));
}
:host([variant="primary"]) button:disabled { box-shadow: none; }

/* 危险操作：淡红底红字，hover 反色 */
:host([variant="danger"]) button {
    background: var(--oc-btn-bg, var(--danger-bg));
    color: var(--oc-btn-fg, var(--danger));
    border-color: var(--oc-btn-border, var(--danger));
}
:host([variant="danger"]) button:hover:not(:disabled) {
    background: var(--oc-btn-bg-hover, var(--danger));
    color: var(--oc-btn-fg-hover, #fff);
}

/* 配置入口：强调色描边 */
:host([variant="config"]) button {
    background: var(--oc-btn-bg, var(--bg-input));
    color: var(--oc-btn-fg, var(--accent));
    border-color: var(--oc-btn-border, var(--accent));
}
:host([variant="config"]) button:hover:not(:disabled) {
    background: var(--oc-btn-bg-hover, var(--accent));
    color: var(--oc-btn-fg-hover, #fff);
}

/* 裸图标按钮：任何状态都没有背景/边框，悬停与按下只改变图标颜色 */
:host([variant="bare"]) button {
    background: var(--oc-btn-bg, transparent);
    border: var(--oc-btn-border-width, 0) solid var(--oc-btn-border, transparent);
    color: var(--oc-btn-fg, var(--text-secondary));
}
:host([variant="bare"]) button:hover:not(:disabled) {
    background: var(--oc-btn-bg-hover, transparent);
    border-color: var(--oc-btn-border-hover, var(--oc-btn-border, transparent));
    /* 默认悬停变强调色（蓝）；删除类按钮各自覆盖成危险色 */
    color: var(--oc-btn-fg-hover, var(--accent));
}
:host([variant="bare"]) button:active:not(:disabled) {
    background: transparent;
    transform: none;
}

/* 幽灵按钮：透明底无边框，hover 才出现浅色块（图标按钮常用） */
:host([variant="ghost"]) button {
    background: transparent;
    color: var(--oc-btn-fg, var(--text-secondary));
    border-color: transparent;
}
:host([variant="ghost"]) button:hover:not(:disabled) {
    background: var(--oc-btn-bg-hover, rgba(0, 0, 0, 0.06));
    color: var(--oc-btn-fg-hover, var(--text-primary));
    border-color: transparent;
}

/* 激活态：分段控件 / 模式按钮用，叠在任意变体上 */
:host([active]) button {
    background: var(--oc-btn-active-bg, var(--accent-ghost, rgba(10, 132, 255, 0.12)));
    color: var(--oc-btn-active-fg, var(--accent));
    border-color: var(--oc-btn-active-border, transparent);
}

/* ---------- 尺寸：只改内边距与字号 ---------- */
:host([size="sm"]) button {
    padding: var(--oc-btn-py, 5px) var(--oc-btn-px, 14px);
    font-size: var(--oc-btn-fs, 13px);
}
:host([size="xs"]) button {
    padding: var(--oc-btn-py, 4px) var(--oc-btn-px, 12px);
    font-size: var(--oc-btn-fs, 12px);
}

/* 只有图标、没有文字时：正方形，内边距清零让图标真正居中。
   这里必须同时隐藏 .label 与 gap，否则空文字容器仍占位，图标会偏左 */
:host([icon-only]) button {
    padding: 0;
    gap: 0;
    aspect-ratio: 1;
}
:host([icon-only]) .label { display: none; }

/* 加载态：内容透明度降低，右侧出现一个旋转小圈 */
:host([loading]) .label { opacity: 0.6; }
.spinner {
    display: none;
    width: 12px;
    height: 12px;
    border: 1.5px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: oc-btn-spin .7s linear infinite;
}
:host([loading]) .spinner { display: inline-block; }
@keyframes oc-btn-spin { to { transform: rotate(360deg); } }
`);

class OcButton extends HTMLElement {
    // 这些属性变化时同步到内部结构
    static get observedAttributes() {
        return ['variant', 'size', 'disabled', 'loading', 'type', 'icon', 'icon-mask', 'icon-only', 'active', 'class'];
    }

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.adoptedStyleSheets = [SHEET];
        root.innerHTML =
            '<button part="button" type="button">' +
                '<span class="icon" part="icon" hidden></span>' +
                '<span class="label" part="label"><slot></slot></span>' +
                '<span class="spinner" aria-hidden="true"></span>' +
            '</button>';
        this._btn = root.querySelector('button');
        this._icon = root.querySelector('.icon');
    }

    connectedCallback() {
        this._sync();
        this._syncIcon();
    }

    attributeChangedCallback(name) {
        if (name === 'class') this._sanitizeClass();
        this._sync();
        this._syncIcon();
    }

    /**
     * 宿主元素上如果被塞了旧按钮类（.btn / .btn-primary …），
     * button.css 会把这些规则套在自定义元素本身上，出现「外层红框 + 内层蓝块」的双层外观。
     * 这里统一清掉，外观只由 variant / size 属性决定。
     */
    _sanitizeClass() {
        if (this._sanitizing) return;
        const legacy = ['btn', 'btn-sm', 'btn-xs', 'btn-primary', 'btn-secondary',
            'btn-danger-outline', 'btn-open', 'btn-refresh', 'btn-config', 'btn-ghost'];
        const hit = legacy.filter((name) => this.classList.contains(name));
        if (!hit.length) return;
        this._sanitizing = true;
        hit.forEach((name) => this.classList.remove(name));
        this._sanitizing = false;
    }

    /** 变体、图标、尺寸也提供 JDOM 属性写法，方便 JS 直接切换状态 */
    get variant() { return this.getAttribute('variant') || 'secondary'; }
    set variant(v) { v ? this.setAttribute('variant', v) : this.removeAttribute('variant'); }

    get icon() { return this.getAttribute('icon') || ''; }
    set icon(v) { v ? this.setAttribute('icon', v) : this.removeAttribute('icon'); }

    get size() { return this.getAttribute('size') || 'md'; }
    set size(v) { v ? this.setAttribute('size', v) : this.removeAttribute('size'); }

    /** 与原生 button 保持一致的属性读写习惯 */
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) { v ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); }

    get active() { return this.hasAttribute('active'); }
    set active(v) { v ? this.setAttribute('active', '') : this.removeAttribute('active'); }

    get loading() { return this.hasAttribute('loading'); }
    set loading(v) { v ? this.setAttribute('loading', '') : this.removeAttribute('loading'); }

    get type() { return this.getAttribute('type') || 'button'; }
    set type(v) { this.setAttribute('type', v || 'button'); }

    /** 把禁用态同步给内部真实按钮（禁用后点击不再触发、也无法 Tab 聚焦） */
    _sync() {
        if (!this._btn) return;
        const off = this.disabled || this.loading;
        this._btn.disabled = off;
        this._btn.type = this.getAttribute('type') || 'button';
        this.setAttribute('aria-disabled', off ? 'true' : 'false');
    }

    /**
     * 图标来源优先级：
     *   1) 外部塞进 slot="icon" 的自定义 SVG（最灵活）
     *   2) icon 属性 → 生成指向 sprite 的 <use>
     *   3) 都没有 → 隐藏图标位
     */
    _syncIcon() {
        if (!this._icon) return;

        const slotted = this.querySelector('[slot="icon"]');
        if (slotted) {
            // 用回 slot，让外部节点正常显示
            if (!this._icon.querySelector('slot')) this._icon.innerHTML = '<slot name="icon"></slot>';
            this._icon.hidden = false;
            return;
        }

        const mask = this.getAttribute('icon-mask');
        if (mask) {
            // 图标资源是 assets/*.svg + .oc-fb-icon-* 遮罩类，直接在 light DOM 造一个 span，
            // 交给页面样式渲染；Shadow DOM 只负责布局，不用维护 id → 文件名映射表
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
            this._icon.hidden = false;
            return;
        }

        const id = this.getAttribute('icon');
        if (id) {
            this._icon.innerHTML = '';
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('aria-hidden', 'true');
            // shadow root 里 <use href="#id"> 只能解析同一棵树的 symbol，
            // 所以先把主文档里的 symbol 克隆一份进来
            if (!this._ensureSymbol(id)) { this._icon.hidden = true; return; }
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttribute('href', '#' + id);
            svg.appendChild(use);
            this._icon.appendChild(svg);
            this._icon.hidden = false;
            return;
        }

        this._icon.innerHTML = '';
        this._icon.hidden = true;
    }

    /**
     * 把主文档 sprite 里的 <symbol> 克隆一份到 shadow root。
     * 原因：<use href="#id"> 的引用作用域是所在 tree，
     * 直接指向页面里的 symbol 在 Shadow DOM 内解析不到，图标就是空白。
     * 同一个图标只克隆一次。
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
        // sprite 里的 symbol / path 自带 stroke-width 表现属性，
        // 表现属性的优先级高于从 svg 继承下来的值，会把组件的描边设置吃掉；
        // 这里统一移除，让 CSS（--oc-btn-icon-stroke）说话
        clone.removeAttribute('stroke-width');
        clone.querySelectorAll('*').forEach(function(node) {
            node.removeAttribute('stroke-width');
            node.removeAttribute('stroke');
            node.removeAttribute('fill');
        });
        defs.appendChild(clone);
        return true;
    }

    focus(opts) { if (this._btn) this._btn.focus(opts); }
    blur() { if (this._btn) this._btn.blur(); }
}

if (!customElements.get('oc-button')) {
    customElements.define('oc-button', OcButton);
}
