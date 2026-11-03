// ============================================================
// core/path.js — 路径工具（同时支持 Windows 与 POSIX 写法）
// ============================================================
// 背景：项目里多处需要「取父目录 / 取末段名 / 取末几段做展示」，此前后端返回的
// 路径既有 Windows 盘符形式（E:\code\git\xxx），也有 POSIX 形式（/home/user/x），
// 各视图各自实现了一套字符串切分逻辑，边界处理不一致（如盘符根 E:\ 被削成 E:）。
// 这里统一为一套纯字符串实现，不做任何文件系统访问：
//   - 分隔符 `\` 与 `/` 等价；
//   - Windows 盘符根（E:\、E:/）与 POSIX 根（/）原样保留；
//   - 允许输入带结尾分隔符（目录路径的常见形态）。

/** 判断字符是否为路径分隔符（反斜杠或正斜杠） */
function isSep(ch) {
    return ch === '\\' || ch === '/';
}

/** 是否为 Windows 盘符根，如 E:\ 或 E:/（恰好两个字符 + 一个分隔符） */
function isDriveRoot(s) {
    return /^[A-Za-z]:[\\/]$/.test(s);
}

/**
 * 取所在目录：去掉末尾的文件名，保留盘符 / 根。
 * - E:\code\a.jsonc → E:\code
 * - E:\a.jsonc      → E:\
 * - /a.jsonc        → /
 * - 无分隔符（无法推断目录）时返回空串。
 * @param {string} p 原始路径
 * @returns {string} 目录路径
 */
export function dirname(p) {
    const raw = String(p == null ? '' : p);
    if (!raw) return '';
    // 根路径直接返回自身，避免下面「去尾分隔符」把 C:\ 削成 C:；
    // 盘符根统一输出 Windows 习惯的反斜杠形式（C:/ → C:\）。
    if (isDriveRoot(raw)) return raw.slice(0, 2) + '\\';
    if (raw === '/' || raw === '\\') return raw;
    // 去掉结尾分隔符（目录路径常带尾斜杠），至少保留一个字符
    let s = raw;
    while (s.length > 1 && isSep(s[s.length - 1])) s = s.slice(0, -1);
    const idx = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    if (idx < 0) return '';                 // 没有分隔符：无法推断目录
    if (idx === 0) return s[0];             // POSIX 根下的文件：/a → /
    if (idx === 2 && s[1] === ':') {
        return s.slice(0, 2) + '\\';        // 盘符根下的文件：C:\a → C:\（统一反斜杠）
    }
    return s.slice(0, idx);
}

/**
 * 取最后一段（文件名或目录名）。
 * - E:\code\git\xxx → xxx
 * - /home/user/     → user
 * - 纯根路径返回自身（/ → /，C:\ → C:），与原有各视图的展示口径一致。
 * @param {string} p 原始路径
 * @returns {string} 末段名称
 */
export function basename(p) {
    const raw = String(p == null ? '' : p);
    if (!raw) return '';
    if (isDriveRoot(raw)) return raw.slice(0, 2); // C:\ → C:
    if (raw === '/' || raw === '\\') return raw;
    let s = raw;
    while (s.length > 1 && isSep(s[s.length - 1])) s = s.slice(0, -1);
    const idx = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return idx < 0 ? s : s.slice(idx + 1);
}

/**
 * 取末尾 maxSegments 段用于界面展示（默认 2 段），段之间用反斜杠连接。
 * 例：E:\code\git\xxx → git\xxx；/home/user/project → user\project。
 * 说明：保留历史上「反斜杠连接」的展示口径，保证各视图文案不变。
 * @param {string} p 原始路径
 * @param {number} [maxSegments=2] 最多保留几段（非正数回退为 2）
 * @returns {string} 缩短后的路径
 */
export function shortPath(p, maxSegments = 2) {
    const limit = (typeof maxSegments === 'number' && maxSegments > 0)
        ? Math.floor(maxSegments)
        : 2;
    const parts = String(p == null ? '' : p).split(/[\\/]/).filter(Boolean);
    if (!parts.length) return '';
    return parts.slice(-limit).join('\\');
}
