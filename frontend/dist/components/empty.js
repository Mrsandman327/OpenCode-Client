// ============================================================
// 空态组件
// ============================================================
// 空态 = 列表/面板没有数据时的占位内容。
// 全项目只有这一套结构（样式见 css/empty.css）：
//
//   <div class="empty-state">
//       <span class="empty-state__icon"><svg class="i"><use href="#i-inbox"></use></svg></span>
//       <p class="empty-state__title">无项目配置</p>
//       <p class="empty-state__desc">该项目下没有 .opencode/opencode.jsonc</p>
//       <button …>查看全局配置</button>
//   </div>
//
// 各段可选：只要一段文字就只传 title；带图标的传 icon；带操作的传 action。
//
// 用法：
//   emptyHtml({ title: '暂无技能' })
//   emptyHtml({ icon: 'i-inbox', title: '暂无供应商', desc: '点击工具栏「添加供应商」' })
//   emptyHtml({ icon: 'i-file', title: '无项目配置', action: { label: '查看全局配置', id: 'btnViewGlobalConfig' } })
//   emptyHtml({ title: '加载失败: ' + msg, variant: 'error' })
//   emptyHtml({ title: '请选择目录', size: 'sm' })

import { escapeAttr } from '../core/utils.js';
import { buttonHtml } from './button.js';

/**
 * 生成空态的 HTML 字符串。
 *
 * @param {object} [opts]
 * @param {string} [opts.icon]        Sprite 图标 id（如 i-inbox），不传则不显示图标
 * @param {string} [opts.title]       主文字
 * @param {string} [opts.desc]        补充说明
 * @param {object|string} [opts.action] 操作按钮：buttonHtml 的参数对象，或直接给 HTML 字符串
 * @param {string} [opts.variant]     'error' 表示错误态（文字与图标用危险色）
 * @param {string} [opts.size]        'sm' 紧凑（列表/树内），默认普通（整块面板）
 * @param {boolean} [opts.bordered]   是否带虚线外框（供应商卡片内那种）
 * @param {string} [opts.className]   额外类名
 * @param {string} [opts.titleHtml]   需要内嵌 <code> 等结构时用这个替代 title
 * @param {string} [opts.descHtml]    同上，替代 desc
 * @returns {string}
 */
export function emptyHtml(opts) {
    opts = opts || {};
    const classes = ['empty-state'];
    if (opts.size === 'sm') classes.push('empty-state--sm');
    if (opts.bordered) classes.push('empty-state--bordered');
    if (opts.variant === 'error') classes.push('empty-state--error');
    if (opts.className) classes.push(opts.className);

    let html = '<div class="' + escapeAttr(classes.join(' ')) + '">';

    if (opts.icon) {
        html += '<span class="empty-state__icon" aria-hidden="true">' +
            '<svg class="i"><use href="#' + escapeAttr(opts.icon) + '"></use></svg></span>';
    }

    // titleHtml / descHtml 由调用方保证内容安全（用于内嵌 <code> 等）
    const title = opts.titleHtml != null ? opts.titleHtml : opts.title;
    if (title) {
        html += '<p class="empty-state__title">' +
            (opts.titleHtml != null ? title : escapeAttr(title)) + '</p>';
    }

    const desc = opts.descHtml != null ? opts.descHtml : opts.desc;
    if (desc) {
        html += '<p class="empty-state__desc">' +
            (opts.descHtml != null ? desc : escapeAttr(desc)) + '</p>';
    }

    if (opts.action) {
        const actionHtml = typeof opts.action === 'string'
            ? opts.action
            : buttonHtml(Object.assign({ variant: 'secondary', size: 'sm' }, opts.action));
        html += '<div class="empty-state__action">' + actionHtml + '</div>';
    }

    return html + '</div>';
}

/**
 * 创建空态 DOM 节点（动态插入场景）。
 *
 * @param {object} [opts] 同 emptyHtml
 * @returns {HTMLElement}
 */
export function createEmpty(opts) {
    const holder = document.createElement('div');
    holder.innerHTML = emptyHtml(opts);
    return holder.firstElementChild;
}
