// ============================================================
// oc-context-menu 自定义元素（Shadow DOM）
// ============================================================
// 定位：右键菜单浮层。沿用原静态菜单的视觉规格
// （bg-card 底、radius-md、浅阴影、13px 文字、7/16 内边距、hover 浅灰）。
//
// 用法（命令式，菜单是一次性浮层，不需要常驻结构）：
//   import { showContextMenu, hideContextMenu } from './components/oc-context-menu.js';
//
//   showContextMenu({
//       x: e.clientX, y: e.clientY,
//       items: [
//           { action: 'close',      label: '关闭' },
//           { action: 'close-right', label: '关闭右侧' },
//           { action: 'close-all',  label: '关闭全部', danger: true },
//       ],
//       onSelect(action, item) { … }
//   });
//
// 也可以直接创建元素并监听 select：
//   const menu = document.createElement('oc-context-menu');
//   document.body.appendChild(menu);
//   menu.addEventListener('select', e => console.log(e.detail.action));
//   menu.show({ x, y, items });
//
// items 字段：
//   action    回调里带出去的动作名
//   label     显示文字
//   danger    hover 变红（删除类）
//   disabled  置灰、不可点
//   icon      图标（可选）：sprite id（如 'i-x'）或内联 SVG 片段（以 '<' 开头）
//   iconPart  额外的 part 名（可选），配合文档里的 oc-context-menu::part(icon-xxx)
//             给 mask-image 类资源图标（如 assets 下的中文名 SVG）用
//
// 内置行为：
//   - 位置自动 clamp 到视口内（右边/下边放不下时向左上翻转）
//   - 点击菜单外部、Esc、滚动、窗口尺寸变化都会关闭
//   - 同一时间只有一个菜单实例可见

const SHEET = new CSSStyleSheet();
SHEET.replaceSync(`
:host {
    position: fixed;
    z-index: 2000;
    display: none;
    font-family: inherit;
    line-height: 1.2;
}

:host([open]) { display: block; }

.menu {
    min-width: 140px;
    max-width: 260px;
    padding: 4px 0;
    background: var(--bg-card);
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: var(--radius-md, 10px);
    box-shadow: rgba(0, 0, 0, 0.08) 0 2px 12px;
    overflow: hidden;
}

.item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 16px;
    font-size: 13px;
    color: var(--text-primary);
    white-space: nowrap;
    cursor: pointer;
    transition: background-color .12s ease, color .12s ease;
}

.item:hover { background: rgba(0, 0, 0, 0.04); }

.item.danger:hover {
    color: var(--danger);
    background: rgba(220, 38, 38, 0.06);
}

.item[disabled] {
    opacity: 0.4;
    cursor: not-allowed;
    background: transparent;
}

.item .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    flex-shrink: 0;
}

/* mask 图标：图形由外部 oc-context-menu::part(icon-xxx) 的 mask-image 提供，
   这里只负责「实色填充 + 居中裁切」这套基础绘制方式。
   注意不能把 background 写在 [part="icon"] 的通用规则上，
   否则内联 SVG / sprite 图标的容器会被涂成实心色块。 */
.item .icon.mask {
    background: currentColor;
    -webkit-mask-repeat: no-repeat;
    -webkit-mask-position: center;
    -webkit-mask-size: contain;
    mask-repeat: no-repeat;
    mask-position: center;
    mask-size: contain;
}

.item .icon svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    display: block;
}

.item .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* 分隔线 */
.item.sep {
    height: 1px;
    padding: 0;
    margin: 4px 0;
    background: var(--border);
    cursor: default;
}
.item.sep:hover { background: var(--border); }
`);

class OcContextMenu extends HTMLElement {
    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.adoptedStyleSheets = [SHEET];
        root.innerHTML = '<div class="menu" part="menu"><slot></slot></div>';
        this._menu = root.querySelector('.menu');
        this._onDocDown = this._onDocDown.bind(this);
        this._onKey = this._onKey.bind(this);
        this._onViewportChange = this._onViewportChange.bind(this);
    }

    /**
     * 显示菜单
     * @param {{x:number, y:number, items:Array, onSelect?:Function}} opts
     */
    show(opts) {
        opts = opts || {};
        const items = Array.isArray(opts.items) ? opts.items : [];
        this._onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;
        this._items = items;

        // 生成条目：用 light DOM + slot，样式由 ::slotted 与文档类共同控制会受限，
        // 这里直接渲染成内部节点，外观完全由组件决定。
        const root = this.shadowRoot;
        this._menu.innerHTML = '';
        items.forEach((it) => {
            if (it === '-' || it.separator) {
                const sep = document.createElement('div');
                sep.className = 'item sep';
                this._menu.appendChild(sep);
                return;
            }
            const row = document.createElement('div');
            row.className = 'item' + (it.danger ? ' danger' : '');
            row.setAttribute('part', 'item');
            row.dataset.action = it.action || '';
            if (it.disabled) row.setAttribute('disabled', '');
            // icon：sprite id 或内联 SVG；iconPart：把 part 名交给外部，
            // 便于用 oc-context-menu::part(icon-xxx) 挂 mask-image 这类
            // 只能写在文档样式表里的资源图标（此时可以只给 iconPart，不给 icon）。
            if (it.icon || it.iconPart) {
                const ic = document.createElement('span');
                ic.className = 'icon';
                ic.setAttribute('part', it.iconPart ? 'icon ' + it.iconPart : 'icon');
                // 有 iconPart 说明图形来自外部的 mask-image 规则，用 .mask 走实色填充
                if (it.iconPart) ic.classList.add('mask');
                const raw = it.icon ? String(it.icon).trim() : '';
                if (raw.charAt(0) === '<') {
                    // 内联 SVG（调用方直接给图标片段），颜色随 currentColor
                    ic.innerHTML = raw;
                } else if (raw) {
                    // sprite 图标 id，如 'i-file'
                    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    svg.setAttribute('aria-hidden', 'true');
                    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
                    use.setAttribute('href', '#' + raw);
                    svg.appendChild(use);
                    ic.appendChild(svg);
                }
                row.appendChild(ic);
            }
            const label = document.createElement('span');
            label.className = 'label';
            label.textContent = it.label == null ? '' : String(it.label);
            row.appendChild(label);
            row.addEventListener('click', () => {
                if (row.hasAttribute('disabled')) return;
                this._fire(row.dataset.action, it);
            });
            this._menu.appendChild(row);
        });

        this.setAttribute('open', '');
        // 先显示再量尺寸，才能做边界翻转
        this.style.left = '0px';
        this.style.top = '0px';
        this._place(opts.x, opts.y);

        document.addEventListener('pointerdown', this._onDocDown, true);
        document.addEventListener('keydown', this._onKey, true);
        window.addEventListener('scroll', this._onViewportChange, true);
        window.addEventListener('resize', this._onViewportChange);
    }

    /** 定位：右下放不下就向左/上翻 */
    _place(x, y) {
        const rect = this.getBoundingClientRect();
        const w = rect.width || this._menu.offsetWidth || 160;
        const h = rect.height || this._menu.offsetHeight || 100;
        const pad = 6;
        let left = Number(x) || 0;
        let top = Number(y) || 0;
        if (left + w + pad > window.innerWidth) left = Math.max(pad, window.innerWidth - w - pad);
        if (top + h + pad > window.innerHeight) top = Math.max(pad, window.innerHeight - h - pad);
        this.style.left = Math.round(left) + 'px';
        this.style.top = Math.round(top) + 'px';
    }

    hide() {
        if (!this.hasAttribute('open')) return;
        this.removeAttribute('open');
        document.removeEventListener('pointerdown', this._onDocDown, true);
        document.removeEventListener('keydown', this._onKey, true);
        window.removeEventListener('scroll', this._onViewportChange, true);
        window.removeEventListener('resize', this._onViewportChange);
    }

    _fire(action, item) {
        this.hide();
        if (this._onSelect) this._onSelect(action, item);
        this.dispatchEvent(new CustomEvent('select', {
            bubbles: true,
            composed: true,
            detail: { action, item }
        }));
    }

    _onDocDown(e) {
        if (e.composedPath().includes(this)) return;
        this.hide();
    }

    _onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); this.hide(); }
    }

    _onViewportChange() { this.hide(); }
}

if (!customElements.get('oc-context-menu')) {
    customElements.define('oc-context-menu', OcContextMenu);
}

/** 单例便捷方法：首次调用时自动挂到 body */
export function showContextMenu(opts) {
    let menu = document.getElementById('ocGlobalContextMenu');
    if (!menu) {
        menu = document.createElement('oc-context-menu');
        menu.id = 'ocGlobalContextMenu';
        document.body.appendChild(menu);
    }
    hideContextMenu();          // 同一时间只显示一个
    menu.show(opts);
    return menu;
}

export function hideContextMenu() {
    const menu = document.getElementById('ocGlobalContextMenu');
    if (menu) menu.hide();
}
