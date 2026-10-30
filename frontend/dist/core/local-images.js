// ============================================================
// core/local-images.js — Markdown 卡片中的本地图片加载
// ============================================================
// 背景：marked 渲染出的 <img src="C:\...\a.png"> 在浏览器/WebView 里
// 不是合法 URL，会直接破图。这里在渲染后扫描本地路径，通过
// api.ReadBrowserRawBase64 读取原始字节，替换为 data:image/... URL。
//
// 支持：
//   - Windows 盘符路径：C:\dir\a.png / C:/dir/a.png
//   - file:///C:/dir/a.png
//   - 相对路径：images/a.png（相对当前会话目录 baseDir）
// 跳过：
//   - http(s):、data:、blob:、// 协议相对、/ 站点绝对路径
//   - 非图片扩展名（避免把任意文件读进 DOM）

import { api } from './apicall.js';

/** 只处理常见图片扩展名 */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i;

/** data URL 缓存：同一路径重复渲染时避免反复读盘。最多保留 50 条。 */
const dataUrlCache = new Map();
const CACHE_LIMIT = 50;

/** 判断 src 是否是需要本地读取的图片路径 */
function isLocalImageRef(src) {
    if (!src) return false;
    // 已有可渲染协议，交给浏览器
    if (/^(https?:|data:|blob:|mailto:|#)/i.test(src)) return false;
    if (src.startsWith('//')) return false;
    // Windows 盘符绝对路径
    if (/^[a-zA-Z]:[\\/]/.test(src)) return true;
    // file:// 协议
    if (/^file:\/\//i.test(src)) return true;
    // 站点绝对路径（如 /assets/a.png）不当作本地文件
    if (src.startsWith('/')) return false;
    // 其余按相对路径处理
    return true;
}

/** 把本地路径拆成 filebrowser 需要的 rootDir + /relPath */
function toPathParts(src, baseDir) {
    let p = src;
    if (/^file:\/\//i.test(p)) {
        p = p.replace(/^file:\/\//i, '');
        try { p = decodeURIComponent(p); } catch (_) { /* 保持原样 */ }
        // file:///C:/... → /C:/... → C:/...
        if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    }
    // 统一成 Windows 分隔符，便于拆目录
    p = p.replace(/\//g, '\\');
    if (/^[a-zA-Z]:\\/.test(p)) {
        const idx = p.lastIndexOf('\\');
        if (idx <= 2) return null; // 只有盘符，没有文件名
        return { rootDir: p.slice(0, idx), relPath: '/' + p.slice(idx + 1) };
    }
    if (!baseDir) return null;
    return { rootDir: baseDir, relPath: '/' + p.replace(/^\\+/, '') };
}

function remember(src, dataUrl) {
    if (dataUrlCache.size >= CACHE_LIMIT) {
        // 简单的 FIFO 淘汰：删掉最早插入的一条
        const first = dataUrlCache.keys().next().value;
        if (first !== undefined) dataUrlCache.delete(first);
    }
    dataUrlCache.set(src, dataUrl);
}

/**
 * 把容器内所有本地图片替换为 data URL。
 * 异步执行，不阻塞渲染；读取失败时保留原 src（浏览器显示 alt/破图）。
 *
 * @param {HTMLElement} container 已写入 Markdown HTML 的容器
 * @param {string} baseDir 相对路径的基准目录（通常是当前会话目录）
 */
export async function hydrateLocalImages(container, baseDir) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    const imgs = Array.from(container.querySelectorAll('img[src]'));
    if (imgs.length === 0) return;

    await Promise.all(imgs.map(async (img) => {
        if (img.dataset.localImageResolved === '1') return;
        let src = (img.getAttribute('src') || '').trim();
        if (!src) return;
        // marked 可能对中文/空格做 URL 编码
        try { src = decodeURI(src); } catch (_) { /* 保持原样 */ }
        if (!isLocalImageRef(src)) return;

        const clean = src.split(/[?#]/)[0];
        if (!IMAGE_EXT.test(clean)) return;

        img.dataset.localImageResolved = '1';

        const cached = dataUrlCache.get(src);
        if (cached) {
            img.setAttribute('src', cached);
            return;
        }

        const parts = toPathParts(src, baseDir);
        if (!parts || !parts.rootDir) return;

        try {
            const raw = await api.ReadBrowserRawBase64(parts.rootDir, parts.relPath);
            const mime = String((raw && raw.mime) || '');
            // 只接受图片 MIME，防止把文本/二进制塞进 img
            if (!/^image\//i.test(mime) || !raw.base64) return;
            const dataUrl = 'data:' + mime + ';base64,' + raw.base64;
            remember(src, dataUrl);
            img.setAttribute('src', dataUrl);
        } catch (_) {
            // 读取失败：保留原 src
        }
    }));
}
