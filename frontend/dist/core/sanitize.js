// ============================================================
// core/sanitize.js — Markdown / HTML 白名单清洗（公共实现）
// ============================================================
// 背景：聊天消息（chat/render.js）、文件预览（filebrowser/preview.js）、
// 知识库与项目配置视图都需要把 marked 渲染出的 HTML 再过滤一遍。
// 原实现有两套：聊天侧为黑名单（不清洗 href 协议，存在 javascript: 链接
// 穿透风险），预览侧为白名单（严格）。这里统一为白名单版：
//   - 只保留允许的标签，白名单外的标签降级为纯文本；
//   - 属性一律移除，仅放行 A[href]（限 http/https/mailto/#/ 开头）、
//     IMG[src|alt]、DETAILS[open]；
//   - 外链补 target="_blank" + rel="noopener noreferrer"。

/** 允许保留的标签集合（marked 常见输出 + 表格/图片/折叠块） */
const ALLOWED_TAGS = new Set(['A', 'P', 'BR', 'STRONG', 'EM', 'CODE', 'PRE', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'IMG', 'DETAILS', 'SUMMARY']);

/** 清洗 marked 渲染结果：白名单标签 + 属性白名单 + href 协议校验 */
export function sanitizeMarkedHtml(html) {
    var template = document.createElement('template');
    template.innerHTML = html;
    sanitizeNodeTree(template.content, ALLOWED_TAGS);
    return template.innerHTML;
}

/** 递归清洗节点树：白名单外元素降级为其文本，属性按标签白名单放行 */
export function sanitizeNodeTree(root, allowedTags) {
    var children = Array.prototype.slice.call(root.childNodes || []);
    children.forEach(function(node) {
        if (node.nodeType === Node.TEXT_NODE) return;
        if (node.nodeType !== Node.ELEMENT_NODE) {
            root.removeChild(node);
            return;
        }
        if (!allowedTags.has(node.tagName)) {
            var text = document.createTextNode(node.textContent || '');
            root.replaceChild(text, node);
            return;
        }
        var attrs = Array.prototype.slice.call(node.attributes || []);
        attrs.forEach(function(attr) {
            var attrName = attr.name.toLowerCase();
            if (node.tagName === 'A' && attrName === 'href') {
                var href = (attr.value || '').trim();
                if (/^(https?:|mailto:|#|\/)/i.test(href)) {
                    node.setAttribute('target', '_blank');
                    node.setAttribute('rel', 'noopener noreferrer');
                } else {
                    node.removeAttribute(attr.name);
                }
                return;
            }
            if (node.tagName === 'IMG' && (attrName === 'src' || attrName === 'alt')) {
                return;
            }
            if (node.tagName === 'DETAILS' && attrName === 'open') {
                return;
            }
            node.removeAttribute(attr.name);
        });
        sanitizeNodeTree(node, allowedTags);
    });
}
