// ============================================================
// 主按钮组件
// ============================================================
// 主按钮 = 普通按钮的骨架 + primary 变体。
// 结构与档位完全复用 components/button.js，本文件只固定 variant，
// 让「哪些是主操作」在代码里更明确（也避免手写类名时漏加 btn-primary）。
//
// 用法：
//   primaryButtonHtml({ label: '保存', size: 'sm' })   → HTML 字符串
//   createPrimaryButton({ label: '保存', onClick })     → DOM 节点
//
// 样式在 css/button-primary.css（普通按钮骨架在 css/button.css）。

import { buttonHtml, createButton } from './button.js';

/**
 * 生成主按钮的 HTML 字符串。
 * 参数与 buttonHtml 相同，variant 固定为 primary。
 *
 * @param {object} [opts] 同 buttonHtml
 * @returns {string}
 */
export function primaryButtonHtml(opts) {
    return buttonHtml(Object.assign({}, opts, { variant: 'primary' }));
}

/**
 * 创建主按钮 DOM 节点。
 * 参数与 createButton 相同，variant 固定为 primary。
 *
 * @param {object} [opts] 同 buttonHtml，另支持 opts.onClick(event, button)
 * @returns {HTMLButtonElement}
 */
export function createPrimaryButton(opts) {
    return createButton(Object.assign({}, opts, { variant: 'primary' }));
}
