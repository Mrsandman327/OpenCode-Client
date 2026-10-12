// ============================================================
// OpenCode 管理中心 - 键位表（纯逻辑层）
// ============================================================
// 本文件只做「键位书写 → 匹配判定」的纯函数，不 import 任何仓内模块、
// 不触碰 DOM，因此 Node 单测可以直接加载它。
// 「id → 键位 + handler」的声明式表与监听初始化在同级的 chat/keybinds.js。
//
// 语法与上游 use-session-commands.tsx 的 keybind 字段一致：
//   - 逗号分隔「序列」（如 "mod+k,mod+shift+p"，必须依次按下）
//   - 加号分隔「修饰键 + 主键」（如 "mod+shift+s"）
//   - "mod" 是平台相关修饰键：macOS = meta（⌘），Windows/Linux = ctrl
//     （上游 keybinds.tsx:100 `const mod = IS_MAC ? event.metaKey : event.ctrlKey`）
//   - 显式写 "ctrl"/"meta"/"alt"/"shift" 时按字面匹配，不受平台切换影响
// ============================================================

/** 平台判定：只有 mac 系列才把 mod 认成 metaKey。 */
export function isMacPlatform(platform) {
    if (typeof platform !== 'string') return false;
    return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * 解析单步键位（不含序列），如 "mod+shift+s" → {key:'s', mod:true, shift:true}。
 *
 * 主键是**最后一个** token（修饰键都在它前面），因此 "mod+alt+[" 的主键是 "["。
 * 主键统一转小写做比较，但匹配时用 event.key 的小写形式，所以大小写不敏感；
 * 需要区分大小写的场景由 shift 修饰键表达，不靠主键本身的大小写。
 *
 * @param {string} step 单步书写，如 "ctrl+b"
 * @returns {{key:string, mod:boolean, ctrl:boolean, alt:boolean, shift:boolean, meta:boolean}}
 */
export function parseKeybindStep(step) {
    const raw = step == null ? '' : String(step).trim().toLowerCase();
    const parts = raw.split('+').map(function (p) { return p.trim(); }).filter(Boolean);
    const key = parts.length ? parts[parts.length - 1] : '';
    const mods = parts.slice(0, Math.max(0, parts.length - 1));
    return {
        key: key,
        mod: mods.indexOf('mod') >= 0 || mods.indexOf('cmd') >= 0 || mods.indexOf('super') >= 0,
        ctrl: mods.indexOf('ctrl') >= 0,
        meta: mods.indexOf('meta') >= 0,
        alt: mods.indexOf('alt') >= 0,
        shift: mods.indexOf('shift') >= 0,
    };
}

/**
 * 解析完整键位书写为「步骤序列」。
 *
 * @param {string} spec 如 "mod+k,mod+shift+p"；空书写返回空数组
 * @returns {Array<ReturnType<parseKeybindStep>>}
 */
export function parseKeybind(spec) {
    const raw = spec == null ? '' : String(spec).trim();
    if (!raw) return [];
    return raw.split(',').map(function (s) { return parseKeybindStep(s); });
}

/**
 * Shift 孪生字符：同一颗物理键在按住 Shift 时浏览器给的 event.key 不一样
 * （`'`→`"`、`.`→`>`、`[`→`{`、`\`→`|`……），所以书写 `shift+mod+'`
 * 实际等到的 event.key 是 `"`，直接比 key 会永远不中。
 * 上游 keybinds.tsx 用「从真实事件反录」绕开了这个问题（录进来就是 `"`）；
 * 本表是**静态书写**的，必须显式承认这层映射。
 */
const SHIFTED_TWIN = {
    '`': '~', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
    '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
    '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|',
    ';': ':', "'": '"', ',': '<', '.': '>', '/': '?',
};

/**
 * 判断一次 keydown 是否匹配某一步。
 *
 * 三个方向的校验都必须做，否则键位表会「误触发」或「吃掉别人的快捷键」：
 *   1. 声明的修饰键必须真按着；
 *   2. **没声明的修饰键必须都没按**（否则 "ctrl+b" 会被 "ctrl+alt+b" 命中）；
 *   3. 主键必须相等——形如 `shift+mod+'` 的还要认它的 Shift 孪生键 `"`。
 *
 * @param {KeyboardEvent} event
 * @param {ReturnType<parseKeybindStep>} parsed 已解析的单步
 * @param {boolean} mac 是否 macOS（决定 mod 落在 meta 还是 ctrl）
 * @returns {boolean}
 */
export function stepMatches(event, parsed, mac) {
    if (!event || !parsed || !parsed.key) return false;
    const wantCtrl = parsed.ctrl || (parsed.mod && !mac);
    const wantMeta = parsed.meta || (parsed.mod && mac);
    if (!!event.ctrlKey !== !!wantCtrl) return false;
    if (!!event.metaKey !== !!wantMeta) return false;
    if (!!event.altKey !== !!parsed.alt) return false;
    if (!!event.shiftKey !== !!parsed.shift) return false;
    const key = event.key == null ? '' : String(event.key).toLowerCase();
    if (key === parsed.key) return true;
    // Shift 孪生：书写用的是「不按 Shift 时那颗键的字符」
    if (parsed.shift && SHIFTED_TWIN[parsed.key] === key) return true;
    return false;
}

/**
 * 判断一次 keydown 是否匹配整个键位书写（序列需按下一步才推进，由调用方持有进度）。
 * 上层做序列匹配用：先比第一步，命中后把剩余步骤存为「待续步骤」。
 *
 * @param {KeyboardEvent} event
 * @param {ReturnType<parseKeybindStep>} parsed 待匹配的单步
 * @param {boolean} mac
 * @returns {boolean}
 */
export function eventMatchesStep(event, parsed, mac) {
    return stepMatches(event, parsed, mac);
}

/**
 * 目标是否落在「可输入元素」里。
 *
 * 键位表**必须**避开输入框/文本域/可编辑元素内的既有按键（Enter 发送、
 * Ctrl+F 搜索、Esc 清理、命令面板的上下选择等），否则会把用户打字当成快捷键。
 * contenteditable 也要算：消息区的富文本与部分内联编辑用它。
 *
 * @param {EventTarget|null} target event.target
 * @returns {boolean}
 */
export function isEditableTarget(target) {
    if (!target || typeof target !== 'object') return false;
    const el = /** @type {Element} */ (target);
    const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (typeof el.isContentEditable === 'boolean' && el.isContentEditable) return true;
    // 少数场景 target 是没有 tagName 的节点（document/window），用 nodeType 兜底判 Element
    return false;
}

/**
 * 当前是否有模态弹窗打开。
 *
 * 约定沿用仓内既有实现：`.modal-overlay` 元素 display 为 flex 即视为打开。
 * 弹窗打开时键位表整体让位（弹窗自己有 Esc/关闭逻辑），
 * 避免「弹窗开着却触发了背后的切换会话」。
 *
 * @param {Document} doc
 * @returns {boolean}
 */
export function hasOpenModal(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return false;
    const list = doc.querySelectorAll('.modal-overlay');
    for (let i = 0; i < list.length; i++) {
        if (list[i].style && list[i].style.display === 'flex') return true;
    }
    return false;
}
