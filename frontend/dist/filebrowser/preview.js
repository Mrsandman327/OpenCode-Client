// ============================================================
// 站内文件浏览器 - 预览器分发
// 依赖：core/apicall.js(api)、core/utils.js(showToast)、
//       browser.js(setFileBrowserDownloadTarget，循环引用)，
//       全局 lib：marked、window.ProjectConfigCodeEditor
// ============================================================

import { api } from '../core/apicall.js';
import { showToast } from '../core/utils.js';
import { setFileBrowserDownloadTarget } from './browser.js';

export async function fileBrowserApiStat(rootDir, relPath) {
    return await api.StatBrowserFile(rootDir, relPath);
}

export async function fileBrowserApiRead(rootDir, relPath) {
    return await api.ReadBrowserFile(rootDir, relPath);
}

export async function fileBrowserApiSave(rootDir, relPath, content) {
    return await api.SaveBrowserFile(rootDir, relPath, content);
}

export async function fileBrowserApiGitPreview(rootDir, relPath) {
    return await api.GetGitPreview(rootDir, relPath);
}

export async function fileBrowserApiGitHistoryPreview(rootDir, commitHash, relPath) {
    return await api.GetGitHistoryPreview(rootDir, commitHash, relPath);
}

export function fileBrowserClearObjectURL() {
    var state = window.fileBrowserState;
    if (state && state.previewObjectURL) {
        URL.revokeObjectURL(state.previewObjectURL);
        state.previewObjectURL = '';
    }
    // 清理 HTML 预览专用的 blob URL
    if (state && state.htmlPreviewBlobURL) {
        try { URL.revokeObjectURL(state.htmlPreviewBlobURL); } catch (_) {}
        state.htmlPreviewBlobURL = null;
    }
    if (state && Array.isArray(state.previewObjectURLs) && state.previewObjectURLs.length) {
        state.previewObjectURLs.forEach(function(url) {
            try {
                URL.revokeObjectURL(url);
            } catch (_) {}
        });
        state.previewObjectURLs = [];
    }
}

export function base64ToBlob(base64, mime) {
    var binary = atob(base64 || '');
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

export async function fileBrowserResolveRawResource(rootDir, relPath) {
    var raw = await api.ReadBrowserRawBase64(rootDir, relPath);
    var blob = base64ToBlob(raw.base64 || '', raw.mime || 'application/octet-stream');
    var url = URL.createObjectURL(blob);
    window.fileBrowserState.previewObjectURL = url;
    return { url: url, name: raw.name || '', mime: raw.mime || 'application/octet-stream' };
}

export function fileBrowserTrackObjectURL(url) {
    var state = window.fileBrowserState;
    if (!state || !url) return url;
    if (!Array.isArray(state.previewObjectURLs)) {
        state.previewObjectURLs = [];
    }
    state.previewObjectURLs.push(url);
    return url;
}

export async function fileBrowserResolveRawResourceMulti(rootDir, relPath) {
    var raw = await api.ReadBrowserRawBase64(rootDir, relPath);
    var blob = base64ToBlob(raw.base64 || '', raw.mime || 'application/octet-stream');
    var url = fileBrowserTrackObjectURL(URL.createObjectURL(blob));
    return { url: url, name: raw.name || '', mime: raw.mime || 'application/octet-stream' };
}

export function fileBrowserEscapeHTML(text) {
    if (text == null) return '';
    var div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

export function fileBrowserHighlightCode(code, ext) {
    var lines = String(code || '').split('\n');
    var numbered = '';
    for (var i = 0; i < lines.length; i++) {
        numbered += '<div class="hljs-line"><span class="hljs-line-no">' + (i + 1) + '</span><span class="hljs-line-content">' + (fileBrowserEscapeHTML(lines[i]) || ' ') + '</span></div>';
    }
    return numbered;
}

export function fileBrowserSanitizeMarkedHtml(html) {
    var template = document.createElement('template');
    template.innerHTML = html;
    var allowedTags = new Set(['A', 'P', 'BR', 'STRONG', 'EM', 'CODE', 'PRE', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'IMG', 'DETAILS', 'SUMMARY']);
    sanitizeNodeTree(template.content, allowedTags);
    return template.innerHTML;
}

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

export function fileBrowserFormatBytes(bytes) {
    if (!bytes) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    var val = bytes;
    while (val >= 1024 && i < units.length - 1) {
        val /= 1024;
        i++;
    }
    return (i === 0 ? val : val.toFixed(1)) + ' ' + units[i];
}

export function updateFileBrowserDownloadButton(item) {
    var path = item && item.path ? item.path : '';
    var name = item && item.name ? item.name : '';
    setFileBrowserDownloadTarget(path, name);
}

export function fileBrowserCanEdit(meta) {
    return !!(meta && meta.editable);
}

export function isFileBrowserDarkTheme(theme) {
    var current = theme || document.documentElement.getAttribute('data-theme') || 'dark';
    return current === 'dark';
}

export function destroyFileBrowserEditor() {
    var state = window.fileBrowserState;
    stopFileBrowserSearchButtonSync();
    if (state && state.previewEditorInstance && window.ProjectConfigCodeEditor) {
        window.ProjectConfigCodeEditor.destroy(state.previewEditorInstance);
    }
    if (state) {
        state.previewEditorInstance = null;
    }
}

export function syncFileBrowserEditorTheme(theme) {
    var state = window.fileBrowserState;
    if (state && state.previewEditorInstance && window.ProjectConfigCodeEditor) {
        window.ProjectConfigCodeEditor.setTheme(state.previewEditorInstance, isFileBrowserDarkTheme(theme));
    }
}

window.syncFileBrowserEditorTheme = syncFileBrowserEditorTheme;

export function fileBrowserIsSearchOpen() {
    var state = window.fileBrowserState;
    return !!(state && state.previewEditorInstance && window.ProjectConfigCodeEditor && window.ProjectConfigCodeEditor.isSearchOpen(state.previewEditorInstance));
}

export function refreshFileBrowserSearchButtonState() {
    var searchBtn = document.getElementById('btnFilePreviewSearch');
    if (!searchBtn) return;
    var isOpen = fileBrowserIsSearchOpen();
    searchBtn.classList.toggle('active', isOpen);
    searchBtn.textContent = isOpen ? '关闭搜索' : '搜索';
}

export function stopFileBrowserSearchButtonSync() {
    var state = window.fileBrowserState;
    if (state && state.previewSearchSyncTimer) {
        clearInterval(state.previewSearchSyncTimer);
        state.previewSearchSyncTimer = null;
    }
}

export function startFileBrowserSearchButtonSync() {
    var state = window.fileBrowserState;
    stopFileBrowserSearchButtonSync();
    if (!state || !state.previewEditorInstance) return;
    state.previewSearchSyncTimer = setInterval(refreshFileBrowserSearchButtonState, 200);
}

export function fileBrowserCanPreview(meta) {
    if (!meta) return false;
    if (meta.previewKind === 'binary') return false;
    if (meta.previewKind === 'markdown') return true;
    if (meta.previewKind === 'code' && isHtmlExtension(meta.ext || '')) return true;
    if (fileBrowserCanEdit(meta)) return false;
    return !!meta.previewable || !meta.ext;
}

export function isHtmlExtension(ext) {
    var normalized = (ext || '').toLowerCase();
    return normalized === '.html' || normalized === '.htm';
}

export function fileBrowserGetPreferredRenderMode(meta) {
    if (!meta) return 'preview';
    if (fileBrowserCanEdit(meta)) return 'edit';
    return 'preview';
}

export function fileBrowserIsDirty() {
    var state = window.fileBrowserState;
    return (state.previewEditorValue || '') !== (state.previewOriginalContent || '');
}

export function renderFilePreviewToolbar() {
    var state = window.fileBrowserState;
    var actionsEl = document.getElementById('filePreviewActions');
    if (!actionsEl) return;

    var meta = state.previewMeta;
    if (!meta || state.previewMode !== 'file' || !state.selectedItem || state.selectedItem.type !== 'file') {
        actionsEl.innerHTML = '';
        return;
    }

    var canEdit = fileBrowserCanEdit(meta);
    var canPreview = fileBrowserCanPreview(meta);
    var allowModeToggle = !!(meta && (meta.previewKind === 'markdown' || (meta.previewKind === 'code' && isHtmlExtension(meta.ext || ''))));
    var buttons = '';

    if (allowModeToggle && canPreview) {
        buttons += '<button type="button" class="btn btn-sm' + (state.previewRenderMode === 'preview' ? ' active-file-preview-action' : '') + '" id="btnFilePreviewModePreview">预览</button>';
    }
    if (canEdit) {
        if (allowModeToggle) {
            buttons += '<button type="button" class="btn btn-sm' + (state.previewRenderMode === 'edit' ? ' active-file-preview-action' : '') + '" id="btnFilePreviewModeEdit">编辑</button>';
        }
        if (state.previewRenderMode === 'edit') {
            buttons += '<button type="button" class="btn btn-sm pc-editor-search-btn' + (fileBrowserIsSearchOpen() ? ' active' : '') + '" id="btnFilePreviewSearch">' + (fileBrowserIsSearchOpen() ? '关闭搜索' : '搜索') + '</button>';
        }
        buttons += '<button type="button" class="btn btn-sm btn-primary" id="btnFilePreviewSave"' + ((!fileBrowserIsDirty() || state.savingPreview || (state.previewReadResult && state.previewReadResult.truncated)) ? ' disabled' : '') + '>' + (state.savingPreview ? '保存中...' : '保存') + '</button>';
    }

    actionsEl.innerHTML = buttons;

    var previewBtn = document.getElementById('btnFilePreviewModePreview');
    if (previewBtn) {
        previewBtn.addEventListener('click', function() {
            switchFilePreviewRenderMode('preview');
        });
    }
    var editBtn = document.getElementById('btnFilePreviewModeEdit');
    if (editBtn) {
        editBtn.addEventListener('click', function() {
            switchFilePreviewRenderMode('edit');
        });
    }
    var searchBtn = document.getElementById('btnFilePreviewSearch');
    if (searchBtn) {
        refreshFileBrowserSearchButtonState();
        searchBtn.addEventListener('click', function() {
            if (state.previewEditorInstance && window.ProjectConfigCodeEditor) {
                window.ProjectConfigCodeEditor.toggleSearch(state.previewEditorInstance);
                refreshFileBrowserSearchButtonState();
            }
        });
    }
    var saveBtn = document.getElementById('btnFilePreviewSave');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveCurrentFilePreview);
    }
}

export function renderFilePreviewEditor(item, meta, readData) {
    var state = window.fileBrowserState;
    var bodyEl = document.getElementById('filePreviewBody');
    if (!bodyEl) return;
    destroyFileBrowserEditor();
    var truncatedHint = readData && readData.truncated
        ? '<div class="file-browser-editor-hint error">当前仅加载前 2MB 内容，已禁止保存，请使用外部编辑器处理大文件。</div>':'';
    bodyEl.innerHTML = '<div class="file-browser-editor-wrap">' +
        truncatedHint +
        '<div class="file-browser-code-editor" id="fileBrowserEditor"></div>' +
    '</div>';
    var editorMount = document.getElementById('fileBrowserEditor');
    if (!editorMount || !window.ProjectConfigCodeEditor) return;
    state.previewEditorInstance = window.ProjectConfigCodeEditor.create(editorMount, {
        fileName: item.name || meta.name || '',
        content: state.previewEditorValue || '',
        isDark: isFileBrowserDarkTheme(),
        onChange: function(value) {
            state.previewEditorValue = value || '';
            renderFilePreviewToolbar();
        }
    });
    if ((state.previewEditorValue || '') === (state.previewOriginalContent || '')) {
        window.ProjectConfigCodeEditor.markClean(state.previewEditorInstance);
    }
    window.ProjectConfigCodeEditor.focus(state.previewEditorInstance);
    startFileBrowserSearchButtonSync();
    renderFilePreviewToolbar();
}

// 规范化相对路径（处理 ../ 和 ./ ）
export function normalizeRelativePath(p) {
    var parts = p.replace(/\\/g, '/').split('/');
    var result = [];
    for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        if (part === '' || part === '.') continue;
        if (part === '..') {
            result.pop();
        } else {
            result.push(part);
        }
    }
    return result.join('/');
}

// 解析 markdown HTML 中图片的相对路径，替换为 blob URL
export async function resolveMarkdownImages(rawHtml, rootDir, mdFilePath) {
    var template = document.createElement('template');
    template.innerHTML = rawHtml;
    var imgs = template.content.querySelectorAll('img');
    if (imgs.length === 0) return rawHtml;
    var mdDir = mdFilePath.substring(0, mdFilePath.lastIndexOf('/') + 1);
    var tasks = [];
    imgs.forEach(function(img) {
        var src = (img.getAttribute('src') || '').trim();
        if (!src || /^(https?:|data:|blob:|\/\/)/i.test(src)) return;
        // marked 可能对中文路径做 URL 编码，需要先解码
        try { src = decodeURI(src); } catch(e) {}
        var resolvedPath = normalizeRelativePath(mdDir + src);
        var task = fileBrowserResolveRawResource(rootDir, resolvedPath).then(function(res) {
            img.setAttribute('src', res.url);
        }).catch(function() {
            // 图片读取失败，保留原始 src
        });
        tasks.push(task);
    });
    if (tasks.length > 0) {
        await Promise.all(tasks);
    }
    return template.innerHTML;
}

export async function resolveHtmlResources(rawHtml, rootDir, htmlFilePath) {
    var template = document.createElement('template');
    template.innerHTML = rawHtml;
    var htmlDir = htmlFilePath.substring(0, htmlFilePath.lastIndexOf('/') + 1);
    var tasks = [];

    template.content.querySelectorAll('img[src]').forEach(function(img) {
        var src = (img.getAttribute('src') || '').trim();
        if (!src || /^(https?:|data:|blob:|\/\/|#)/i.test(src)) return;
        try { src = decodeURI(src); } catch (_) {}
        var resolvedPath = normalizeRelativePath(htmlDir + src);
        tasks.push(fileBrowserResolveRawResourceMulti(rootDir, resolvedPath).then(function(res) {
            img.setAttribute('src', res.url);
        }).catch(function() {
            // 资源读取失败时保留原始路径，方便用户发现问题。
        }));
    });

    template.content.querySelectorAll('link[href]').forEach(function(link) {
        var rel = (link.getAttribute('rel') || '').toLowerCase();
        if (rel.indexOf('stylesheet') < 0) return;
        var href = (link.getAttribute('href') || '').trim();
        if (!href || /^(https?:|data:|blob:|\/\/|#)/i.test(href)) return;
        try { href = decodeURI(href); } catch (_) {}
        var resolvedPath = normalizeRelativePath(htmlDir + href);
        tasks.push(fileBrowserResolveRawResourceMulti(rootDir, resolvedPath).then(function(res) {
            link.setAttribute('href', res.url);
        }).catch(function() {
            // 样式读取失败时保留原始路径。
        }));
    });

    template.content.querySelectorAll('script[src]').forEach(function(script) {
        var src = (script.getAttribute('src') || '').trim();
        if (!src || /^(https?:|data:|blob:|\/\/|#)/i.test(src)) return;
        try { src = decodeURI(src); } catch (_) {}
        var resolvedPath = normalizeRelativePath(htmlDir + src);
        tasks.push(fileBrowserResolveRawResourceMulti(rootDir, resolvedPath).then(function(res) {
            script.setAttribute('src', res.url);
        }).catch(function() {
            // 脚本读取失败时保留原始路径。
        }));
    });

    // 预处理 <meta http-equiv="refresh"> 相对跳转 URL
    template.content.querySelectorAll('meta[http-equiv="refresh"i]').forEach(function(meta) {
        var content = (meta.getAttribute('content') || '').trim();
        if (!content) return;
        // content 格式: "秒数;url=相对路径" 或 "秒数; url=相对路径"
        var match = content.match(/url\s*=\s*(.+)$/i);
        if (!match) return;
        var targetUrl = match[1].trim();
        if (!targetUrl || /^(https?:|data:|blob:|\/\/|#)/i.test(targetUrl)) return;
        try { targetUrl = decodeURI(targetUrl); } catch (_) {}
        var resolvedPath = normalizeRelativePath(htmlDir + targetUrl);
        tasks.push(fileBrowserResolveRawResourceMulti(rootDir, resolvedPath).then(function(res) {
            var newContent = content.replace(/url\s*=\s*.+$/i, 'url=' + res.url);
            meta.setAttribute('content', newContent);
        }).catch(function() {
            // 目标文件读取失败，保留原始路径
        }));
    });

    if (tasks.length > 0) {
        await Promise.all(tasks);
    }
    return template.innerHTML;
}

export async function renderHtmlPreview(item, readData) {
    var state = window.fileBrowserState;
    var bodyEl = document.getElementById('filePreviewBody');
    if (!bodyEl || !state) return;
    var resolvedHtml = await resolveHtmlResources(readData.content || '', state.rootDir, item.path);

    // 注入导航拦截脚本：在页面内最前面运行，拦截所有相对路径跳转
    // （window.location.href / replace / assign 以及 <a href> 点击）
    // 通过 postMessage 与父页面通信，将相对路径解析为 blob URL 后再导航
    var htmlDir = item.path.substring(0, item.path.lastIndexOf('/') + 1);
    var navInterceptScript = '<script>' +
        '(function(){' +
            // 通过 postMessage 请求父页面解析相对路径
            'function resolvePath(path, next){' +
                'var handler=function(e){' +
                    'if(e.data&&e.data.type==="oc-html-nav-resolved"){' +
                        'window.removeEventListener("message",handler);' +
                        'next(e.data.url||null);' +
                    '}' +
                '};' +
                'window.addEventListener("message",handler);' +
                'window.parent.postMessage({type:"oc-html-nav",path:path}, "*");' +
            '}' +
            // 拦截 window.location.href 赋值
            'var _loc=window.location;' +
            'var _origDesc=Object.getOwnPropertyDescriptor(Location.prototype,"href")||' +
                'Object.getOwnPropertyDescriptor(window.__proto__.__proto__.__proto__,"href");' +
            'try{' +
                'if(_origDesc&&_origDesc.set){' +
                    'var _origSet=_origDesc.set;' +
                    'Object.defineProperty(Location.prototype,"href",{' +
                        'get:function(){return _origDesc.get? _origDesc.get.call(this):""},' +
                        'set:function(val){' +
                            'if(typeof val==="string"&&/^\\.\\.?\\//.test(val)&&!/^(https?:|data:|blob:|#)/i.test(val)){' +
                                'resolvePath(val,function(resolved){' +
                                    'if(resolved) _origSet.call(_loc,resolved);' +
                                '});' +
                                'return;' +
                            '}' +
                            '_origSet.call(this,val);' +
                        '}' +
                    '});' +
                '}' +
            '}catch(_){}' +
            // 拦截 <a href> 点击（非锚点相对路径）
            'document.addEventListener("click",function(e){' +
                'var a=e.target.closest("a[href]");' +
                'if(!a)return;' +
                'var href=a.getAttribute("href")||"";' +
                'if(!/^\\.\\.?\\//.test(href)||/^(https?:|data:|blob:|#)/i.test(href))return;' +
                'e.preventDefault();e.stopPropagation();' +
                'resolvePath(href,function(resolved){' +
                    'if(resolved) window.location.href=resolved;' +
                '});' +
            '},true);' +
        '})();' +
    '</script>';
    // 注入到 <head> 之后（保证在所有其他脚本之前运行）
    if (/<head[^>]*>/i.test(resolvedHtml)) {
        resolvedHtml = resolvedHtml.replace(/<head[^>]*>/i, '$&' + navInterceptScript);
    } else {
        resolvedHtml = navInterceptScript + resolvedHtml;
    }

    // 清理上一次 HTML 预览的 blob URL
    if (state.htmlPreviewBlobURL) {
        try { URL.revokeObjectURL(state.htmlPreviewBlobURL); } catch (_) {}
        state.htmlPreviewBlobURL = null;
    }

    // 生成 blob URL：iframe 拥有独立地址，
    // 原生锚点导航和页面内脚本均可正常工作
    var blob = new Blob([resolvedHtml], { type: 'text/html;charset=utf-8' });
    var blobURL = URL.createObjectURL(blob);
    state.htmlPreviewBlobURL = blobURL;

    // sandbox: allow-same-origin 使锚点原生生效
    //          allow-scripts     使页面脚本可执行
    bodyEl.innerHTML = '<iframe class="file-browser-html-preview" sandbox="allow-same-origin allow-scripts" title="HTML预览"></iframe>';
    var iframe = bodyEl.querySelector('.file-browser-html-preview');
    if (!iframe) return;

    // 设置父页面消息监听：响应 iframe 内脚本的相对路径解析请求
    iframe.addEventListener('load', function setupNavListener() {
        var rootDir = state.rootDir;
        var baseDir = htmlDir;
        var msgHandler = function(e) {
            if (!e.data || e.data.type !== 'oc-html-nav') return;
            var path = e.data.path || '';
            var resolvedPath = normalizeRelativePath(baseDir + path);
            fileBrowserResolveRawResourceMulti(rootDir, resolvedPath).then(function(res) {
                try { iframe.contentWindow.postMessage({ type: 'oc-html-nav-resolved', url: res.url }, '*'); } catch (_) {}
            }).catch(function() {
                try { iframe.contentWindow.postMessage({ type: 'oc-html-nav-resolved', url: null }, '*'); } catch (_) {}
            });
        };
        window.addEventListener('message', msgHandler);
        // 当 HTML 预览被替换时清理监听器
        var prevCleanup = state._htmlNavMsgCleanup;
        if (prevCleanup) { try { prevCleanup(); } catch (_) {} }
        state._htmlNavMsgCleanup = function() {
            window.removeEventListener('message', msgHandler);
        };
    }, { once: true });
    iframe.src = blobURL;
}

export async function renderTextualFilePreview(item, meta, readData, ext) {
    var state = window.fileBrowserState;
    var bodyEl = document.getElementById('filePreviewBody');
    if (!bodyEl) return;
    if (state.previewRenderMode === 'edit' && fileBrowserCanEdit(meta)) {
        renderFilePreviewEditor(item, meta, readData);
        return;
    }
    if (meta.previewKind === 'markdown') {
        var rawHtml = marked.parse(readData.content || '');
        var resolvedHtml = await resolveMarkdownImages(rawHtml, state.rootDir, item.path);
        bodyEl.innerHTML = '<div class="oc-text file-browser-markdown">' + fileBrowserSanitizeMarkedHtml(resolvedHtml) + '</div>';
        return;
    }
    if (isHtmlExtension(ext)) {
        await renderHtmlPreview(item, readData);
        return;
    }
    if (meta.previewKind === 'csv') {
        bodyEl.innerHTML = renderCSVPreview(readData.content || '');
        return;
    }
    bodyEl.innerHTML = '<pre class="file-browser-code"><code class="hljs">' + fileBrowserHighlightCode(readData.content || '', ext) + '</code></pre>';
}

export function switchFilePreviewRenderMode(mode) {
    var state = window.fileBrowserState;
    var meta = state.previewMeta;
    if (!meta) return;
    if (mode === 'edit' && !fileBrowserCanEdit(meta)) return;
    if (mode === 'preview' && !fileBrowserCanPreview(meta)) return;
    if (mode === 'preview') {
        destroyFileBrowserEditor();
    }
    state.previewRenderMode = mode === 'edit' ? 'edit' : 'preview';
    renderFilePreviewToolbar();
    if (state.selectedItem) {
        renderFilePreview(state.selectedItem, { keepMode: true, skipMetaReload: true });
    }
}

export async function saveCurrentFilePreview() {
    var state = window.fileBrowserState;
    var meta = state.previewMeta;
    var item = state.selectedItem;
    if (!item || !meta || !fileBrowserCanEdit(meta) || state.savingPreview) return;
    if (state.previewReadResult && state.previewReadResult.truncated) {
        showToast('当前文件已截断，禁止保存', 'error');
        return;
    }
    state.savingPreview = true;
    renderFilePreviewToolbar();
    try {
        var result = await fileBrowserApiSave(state.rootDir, item.path, state.previewEditorValue || '');
        if (!result.success) {
            showToast(result.error || '保存失败', 'error');
            return;
        }
        state.previewOriginalContent = state.previewEditorValue || '';
        state.previewContent = state.previewEditorValue || '';
        if (state.previewEditorInstance && window.ProjectConfigCodeEditor) {
            window.ProjectConfigCodeEditor.markClean(state.previewEditorInstance);
        }
        showToast('保存成功', 'success');
        renderFilePreviewToolbar();
    } catch (err) {
        showToast(err.message || '保存失败', 'error');
    } finally {
        state.savingPreview = false;
        renderFilePreviewToolbar();
    }
}

export async function renderFilePreview(item, options) {
    var state = window.fileBrowserState;
    options = options || {};
    if (!state || !item || item.type !== 'file') return;
    if (!(options.keepMode && state.previewRenderMode === 'edit')) {
        destroyFileBrowserEditor();
    }
    fileBrowserClearObjectURL();
    state.selectedItem = item;
    state.previewMode = 'file';
    updateFileBrowserDownloadButton(item);
    var titleEl = document.getElementById('filePreviewTitle');
    var metaEl = document.getElementById('filePreviewMeta');
    var bodyEl = document.getElementById('filePreviewBody');
    if (titleEl) titleEl.textContent = item.name;
    if (metaEl) metaEl.textContent = '加载中...';
    if (bodyEl) bodyEl.innerHTML = '<div class="file-browser-empty">正在读取文件...</div>';
    renderFilePreviewToolbar();

    try {
        var meta = options.skipMetaReload && state.previewMeta ? state.previewMeta : await fileBrowserApiStat(state.rootDir, item.path);
        state.previewMeta = meta;
        if (!options.keepMode) {
            state.previewRenderMode = fileBrowserGetPreferredRenderMode(meta);
        }
        if (metaEl) {
            metaEl.textContent = [meta.ext || '', fileBrowserFormatBytes(meta.size || 0), meta.modifiedAt || ''].filter(Boolean).join(' · ');
        }
        renderFilePreviewToolbar();
        var ext = (meta.ext || '').toLowerCase();
        var previewKind = meta.previewKind || '';

        if (previewKind === 'image') {
            var previewImageRes = await fileBrowserResolveRawResource(state.rootDir, item.path);
            bodyEl.innerHTML = '<div class="file-browser-image-wrap"><img class="file-browser-image" src="' + previewImageRes.url + '" alt="' + fileBrowserEscapeHTML(item.name) + '"></div>';
            return;
        }
        if (previewKind === 'pdf') {
            var previewPdfRes = await fileBrowserResolveRawResource(state.rootDir, item.path);
            bodyEl.innerHTML = '<iframe class="file-browser-pdf" title="PDF预览" src="' + previewPdfRes.url + '"></iframe>';
            return;
        }
        if (previewKind === 'spreadsheet') {
            bodyEl.innerHTML = '<div class="file-browser-unsupported">' +
                '<p>当前版本未启用 Excel 在线预览。</p>' +
                '<p>文件：' + fileBrowserEscapeHTML(item.name) + '</p>' +
                '</div>';
            return;
        }
        if (previewKind === 'markdown' || previewKind === 'csv' || previewKind === 'text' || previewKind === 'code') {
            var previewReadData = await fileBrowserApiRead(state.rootDir, item.path);
            state.previewReadResult = previewReadData;
            state.previewContent = previewReadData.content || '';
            if (!options.keepMode || state.previewEditorValue === '' || !fileBrowserIsDirty()) {
                state.previewEditorValue = previewReadData.content || '';
                state.previewOriginalContent = previewReadData.content || '';
            }
            await renderTextualFilePreview(item, meta, previewReadData, ext);
            renderFilePreviewToolbar();
            return;
        }

        if (!ext) {
            if (state.previewRenderMode === 'edit' || state.forcedTextPreview[item.path]) {
                var noExtReadData = await fileBrowserApiRead(state.rootDir, item.path);
                var noExtContent = noExtReadData.content || '';
                state.previewReadResult = noExtReadData;
                state.previewContent = noExtContent;
                if (!options.keepMode || state.previewEditorValue === '' || !fileBrowserIsDirty()) {
                    state.previewEditorValue = noExtContent;
                    state.previewOriginalContent = noExtContent;
                }
                if (metaEl) {
                    metaEl.textContent = ['无扩展名 · 按普通文本方式打开', fileBrowserFormatBytes(meta.size || 0), meta.modifiedAt || ''].filter(Boolean).join(' · ');
                }
                await renderTextualFilePreview(item, meta, noExtReadData, '');
                renderFilePreviewToolbar();
                return;
            }
            bodyEl.innerHTML = renderNoExtPreview(item, meta);
            bindNoExtPreviewActions(item);
            renderFilePreviewToolbar();
            return;
        }

        bodyEl.innerHTML = '<div class="file-browser-unsupported">' +
            '<p>该文件类型暂不支持在线预览。</p>' +
            '<p>文件：' + fileBrowserEscapeHTML(item.name) + '</p>' +
            '</div>';
        renderFilePreviewToolbar();
    } catch (err) {
        if (metaEl) metaEl.textContent = '';
        if (bodyEl) bodyEl.innerHTML = '<div class="file-browser-empty error">' + fileBrowserEscapeHTML(err.message || err) + '</div>';
        renderFilePreviewToolbar();
    }
}

export function renderNoExtPreview(item, meta) {
    return '<div class="file-browser-noext">' +
        '<div class="file-browser-noext-title">无扩展名文件</div>' +
        '<div class="file-browser-noext-hint">系统暂时无法自动判断该文件类型。你可以按普通文本方式尝试预览。</div>' +
        '<div class="file-browser-noext-name">文件：' + fileBrowserEscapeHTML(item.name || meta.name || item.path || '') + '</div>' +
        '<div class="file-browser-noext-actions">' +
            '<button type="button" class="btn btn-sm btn-refresh" id="btnOpenNoExtAsText">按普通文本打开</button>' +
        '</div>' +
    '</div>';
}

export function bindNoExtPreviewActions(item) {
    var openBtn = document.getElementById('btnOpenNoExtAsText');
    if (openBtn) {
        openBtn.onclick = function() {
            window.fileBrowserState.forcedTextPreview[item.path] = true;
            window.fileBrowserState.previewRenderMode = 'edit';
            renderFilePreview(item);
        };
    }
}

export function renderCSVPreview(content) {
    var lines = String(content || '').split(/\r?\n/).filter(function(line) { return line !== ''; });
    if (!lines.length) return '<div class="file-browser-empty">CSV 文件为空</div>';
    var rows = lines.map(function(line) { return line.split(','); });
    var html = '<div class="file-browser-table-wrap"><table class="file-browser-table"><tbody>';
    rows.forEach(function(cols, rowIndex) {
        html += '<tr>';
        cols.forEach(function(col) {
            if (rowIndex === 0) {
                html += '<th>' + fileBrowserEscapeHTML(col) + '</th>';
            } else {
                html += '<td>' + fileBrowserEscapeHTML(col) + '</td>';
            }
        });
        html += '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
}

export async function renderGitFilePreview(path) {
    var state = window.fileBrowserState;
    if (!state || !path) return;
    fileBrowserClearObjectURL();
    state.previewMode = 'git';
    state.selectedItem = null;
    updateFileBrowserDownloadButton(null);
    var titleEl = document.getElementById('filePreviewTitle');
    var metaEl = document.getElementById('filePreviewMeta');
    var bodyEl = document.getElementById('filePreviewBody');
    if (titleEl) titleEl.textContent = path.replace(/^\//, '');
    if (metaEl) metaEl.textContent = 'Git 变更预览';
    if (bodyEl) bodyEl.innerHTML = '<div class="file-browser-empty">正在读取 Git 变更...</div>';
    renderFilePreviewToolbar();
    try {
        var data = await fileBrowserApiGitPreview(state.rootDir, path);
        if (!data.tracked) {
            bodyEl.innerHTML = '<div class="git-preview-section">' +
                '<div class="git-preview-section-title">未跟踪文件</div>' +
                '<div class="file-browser-empty" style="padding:0 0 12px">当前文件尚未纳入 Git 管理，因此没有历史 diff。</div>' +
                '<pre class="file-browser-code"><code class="hljs">' + fileBrowserHighlightCode(data.untrackedContent || '', '.' + ((data.path || '').split('.').pop() || '').toLowerCase()) + '</code></pre>' +
                '</div>';
            return;
        }
        bodyEl.innerHTML = '' +
            renderGitSection('已暂存修改', data.stagedBlocks || [], data.hasStaged) +
            renderGitSection('未暂存修改', data.unstagedBlocks || [], data.hasUnstaged);
    } catch (err) {
        bodyEl.innerHTML = '<div class="file-browser-empty error">' + fileBrowserEscapeHTML(err.message || err) + '</div>';
    }
}

export async function renderGitHistoryFilePreview(commitHash, path) {
    var state = window.fileBrowserState;
    if (!state || !commitHash || !path) return;
    fileBrowserClearObjectURL();
    state.previewMode = 'git-history';
    state.selectedItem = null;
    updateFileBrowserDownloadButton(null);
    var titleEl = document.getElementById('filePreviewTitle');
    var metaEl = document.getElementById('filePreviewMeta');
    var bodyEl = document.getElementById('filePreviewBody');
    if (titleEl) titleEl.textContent = path;
    if (metaEl) metaEl.textContent = '提交历史 · ' + commitHash.slice(0, 7);
    if (bodyEl) bodyEl.innerHTML = '<div class="file-browser-empty">正在读取提交历史文件变更...</div>';
    renderFilePreviewToolbar();
    try {
        var data = await fileBrowserApiGitHistoryPreview(state.rootDir, commitHash, path);
        var blocks = data.blocks || [];
        bodyEl.innerHTML = renderGitSection('提交修改', blocks, true);
    } catch (err) {
        bodyEl.innerHTML = '<div class="file-browser-empty error">' + fileBrowserEscapeHTML(err.message || err) + '</div>';
    }
}

export function renderGitSection(title, blocks, enabled) {
    if (!enabled || !blocks || !blocks.length) {
        return '<div class="git-preview-section">' +
            '<div class="git-preview-section-title">' + fileBrowserEscapeHTML(title) + '</div>' +
            '<div class="file-browser-empty">当前没有' + fileBrowserEscapeHTML(title) + '</div>' +
        '</div>';
    }
    var html = '<div class="git-preview-section">' +
        '<div class="git-preview-section-title">' + fileBrowserEscapeHTML(title) + '</div>';
    blocks.forEach(function(block) {
        html += renderGitDiffBlock(block);
    });
    html += '</div>';
    return html;
}

export function renderGitDiffBlock(block) {
    var leftLines = block.left || [];
    var rightLines = block.right || [];
    var maxLen = Math.max(leftLines.length, rightLines.length);
    var html = '<div class="git-diff-grid">';
    for (var i = 0; i < maxLen; i++) {
        var left = leftLines[i] || { kind: 'empty', oldNo: 0, newNo: 0, text: '' };
        var right = rightLines[i] || { kind: 'empty', oldNo: 0, newNo: 0, text: '' };
        html += renderGitDiffLine(left, 'left');
        html += renderGitDiffLine(right, 'right');
    }
    html += '</div>';
    return html;
}

export function renderGitDiffLine(line, side) {
    var no = side === 'left' ? line.oldNo : line.newNo;
    var noText = no ? String(no) : '';
    return '<div class="git-diff-line ' + fileBrowserEscapeHTML(line.kind || 'context') + '">' +
        '<span class="git-diff-line-no">' + fileBrowserEscapeHTML(noText) + '</span>' +
        '<span class="git-diff-line-text">' + fileBrowserEscapeHTML(line.text || '') + '</span>' +
    '</div>';
}
