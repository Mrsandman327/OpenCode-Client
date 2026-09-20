// ============================================================
// 站内文件浏览器 - 预览器分发
// 依赖：core/apicall.js(api)、core/utils.js(showToast)、
//       browser.js(setFileBrowserDownloadTarget，循环引用)，
//       全局 lib：marked、window.ProjectConfigCodeEditor
// ============================================================

import { api } from '../core/apicall.js';
import { showToast, escapeHtml } from '../core/utils.js';

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
    var url = fileBrowserTrackObjectURL(URL.createObjectURL(blob));
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
    return fileBrowserResolveRawResource(rootDir, relPath);
}

export function fileBrowserHighlightCode(code, ext) {
    var lines = String(code || '').split('\n');
    var numbered = '';
    for (var i = 0; i < lines.length; i++) {
        numbered += '<div class="hljs-line"><span class="hljs-line-no">' + (i + 1) + '</span><span class="hljs-line-content">' + (escapeHtml(lines[i]) || ' ') + '</span></div>';
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
    if (state && state.previewDiffInstance && state.previewDiffInstance.destroy) {
        // git diff 视图：销毁左右双编辑器实例
        state.previewDiffInstance.destroy();
    }
    if (state && state.previewEditorInstance && window.ProjectConfigCodeEditor) {
        window.ProjectConfigCodeEditor.destroy(state.previewEditorInstance);
    }
    if (state) {
        state.previewDiffInstance = null;
        state.previewEditorInstance = null;
    }
}

export function setFileBrowserDownloadTarget(path, name) {
    var btn = document.getElementById('btnFileBrowserDownload');
    var state = window.fileBrowserState;
    if (!state) return;
    state.previewDownloadPath = path || '';
    state.previewDownloadName = name || '';
    if (!btn) return;
    btn.style.display = path ? 'inline-flex' : 'none';
    btn.disabled = !path;
}

export function clearFileBrowserPreview() {
    var titleEl = document.getElementById('filePreviewTitle');
    var metaEl = document.getElementById('filePreviewMeta');
    var bodyEl = document.getElementById('filePreviewBody');
    var downloadBtn = document.getElementById('btnFileBrowserDownload');
    if (titleEl) titleEl.textContent = '请选择文件';
    if (metaEl) metaEl.textContent = '';
    if (bodyEl) bodyEl.innerHTML = '<div class="file-browser-empty">请选择左侧文件进行预览</div>';
    destroyFileBrowserEditor();
    var state = window.fileBrowserState;
    if (!state) return;
    state.previewMeta = null;
    state.previewReadResult = null;
    state.previewRenderMode = 'preview';
    state.previewEditorValue = '';
    state.previewOriginalContent = '';
    state.previewEditorInstance = null;
    state.previewDiffInstance = null;
    state.gitPreviewPath = '';
    state.previewSearchSyncTimer = null;
    state.savingPreview = false;
    state.previewDownloadPath = '';
    state.previewDownloadName = '';
    if (downloadBtn) {
        downloadBtn.style.display = 'none';
        downloadBtn.disabled = true;
    }
    renderFilePreviewToolbar();
}

export function syncFileBrowserEditorTheme(theme) {
    var state = window.fileBrowserState;
    var isDark = isFileBrowserDarkTheme(theme);
    if (state && state.previewDiffInstance && state.previewDiffInstance.setTheme) {
        // git diff 视图：左右两个编辑器同步换肤
        state.previewDiffInstance.setTheme(isDark);
    }
    if (state && state.previewEditorInstance && window.ProjectConfigCodeEditor) {
        window.ProjectConfigCodeEditor.setTheme(state.previewEditorInstance, isDark);
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

    // Git 视图：渲染「保存」按钮。
    // git 模式：diff 由 createDiff 实例提供（getValueRightClean + isDirty）：
    //  - git-file（工作区 vs HEAD）：右上栏可编辑并可保存
    //  - git-history（提交快照）：两侧均只读
    if (state.previewMode === 'git' || state.previewMode === 'git-history') {
        var diff = state.previewDiffInstance;
        var canSave = state.previewMode === 'git' && diff && diff.isDirty() && !state.savingPreview;
        var buttons = '';
        if (state.previewMode === 'git') {
            buttons = '<button type="button" class="btn btn-sm btn-primary" id="btnGitDiffSave"' +
                (canSave ? '' : ' disabled') + '>' +
                (state.savingPreview ? '保存中...' : '保存') + '</button>';
        }
        actionsEl.innerHTML = buttons;
        var gSave = document.getElementById('btnGitDiffSave');
        if (gSave) gSave.addEventListener('click', saveCurrentGitDiffPreview);
        return;
    }

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

export async function renderHtmlPreview(item, readData, isCurrentRequest) {
    var state = window.fileBrowserState;
    var bodyEl = document.getElementById('filePreviewBody');
    if (!bodyEl || !state) return;
    var resolvedHtml = await resolveHtmlResources(readData.content || '', state.rootDir, item.path);
    if (isCurrentRequest && !isCurrentRequest()) return;

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

export async function renderTextualFilePreview(item, meta, readData, ext, isCurrentRequest) {
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
        if (isCurrentRequest && !isCurrentRequest()) return;
        bodyEl.innerHTML = '<div class="oc-text file-browser-markdown">' + fileBrowserSanitizeMarkedHtml(resolvedHtml) + '</div>';
        return;
    }
    if (isHtmlExtension(ext)) {
        await renderHtmlPreview(item, readData, isCurrentRequest);
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

// ============================================================
// 多文件 tab：点文件以 tab 打开，可同时开多个、切换、关闭。
// 每个打开过的文件在 state.fileTabCache[path] 保留编辑状态
// （editorValue/originalContent/renderMode），切换与关闭都不丢失，
// 重新打开同一文件时恢复。
// ============================================================

/** 把当前预览文件的编辑状态存入缓存（切 tab / 关闭 tab 前调用） */
export function saveFileTabState() {
    var state = window.fileBrowserState;
    if (!state) return;
    var path = state.activeFileTabPath || (state.selectedItem && state.selectedItem.path);
    if (!path) return;
    if (state.previewMode === 'file') {
        state.fileTabCache[path] = {
            editorValue: state.previewEditorValue || '',
            originalContent: state.previewOriginalContent || '',
            renderMode: state.previewRenderMode || 'preview',
        };
        return;
    }
    // git 模式：缓存右栏（工作区）编辑值，切 tab 不丢失未保存的修改
    if (state.previewMode === 'git' && state.previewDiffInstance) {
        state.fileTabCache[path] = {
            gitRightContent: state.previewDiffInstance.getValueRight() || '',
        };
    }
}

/** 渲染文件 tab 栏（含切换 / 关闭事件） */
export function renderFileBrowserTabs() {
    var tabsEl = document.getElementById('fileBrowserPreviewTabs');
    if (!tabsEl) return;
    var state = window.fileBrowserState;
    if (!state.fileTabs || !state.fileTabs.length) {
        tabsEl.innerHTML = '';
        tabsEl.style.display = 'none';
        return;
    }
    tabsEl.innerHTML = state.fileTabs.map(function(t) {
        var active = t.path === state.activeFileTabPath ? ' active' : '';
        return '<div class="file-browser-tab' + active + '" data-path="' + escapeHtml(t.path) + '" title="' + escapeHtml(t.path) + '">' +
            '<span class="file-browser-tab-name">' + escapeHtml(t.name) + '</span>' +
            '<span class="file-browser-tab-close" data-close="' + escapeHtml(t.path) + '">✕</span>' +
        '</div>';
    }).join('');
    tabsEl.style.display = 'flex';

    tabsEl.querySelectorAll('.file-browser-tab').forEach(function(el) {
        el.addEventListener('click', function(e) {
            if (e.target.closest('.file-browser-tab-close')) return;
            fileBrowserSwitchTab(el.dataset.path);
        });
    });
    tabsEl.querySelectorAll('.file-browser-tab-close').forEach(function(el) {
        el.addEventListener('click', function(e) {
            e.stopPropagation();
            fileBrowserCloseTab(el.dataset.close);
        });
    });
}

/**
 * 以 tab 打开文件（点击文件 / 切换 tab / 刷新时调用）：
 * 保存当前 tab 状态 → 销毁旧编辑器 → 更新 tab 列表并激活目标 →
 * 从缓存恢复目标文件的编辑状态 → 渲染预览。
 */
export function fileBrowserOpenFileTab(item) {
    var state = window.fileBrowserState;
    if (!state || !item || (item.type !== 'file' && item.type !== 'git-file' && item.type !== 'git-history-file')) return;
    var path = item.path;
    // 1. 保存当前活动 tab 的编辑状态
    saveFileTabState();
    // 2. 切换文件必须销毁旧编辑器（单编辑器实例）
    destroyFileBrowserEditor();
    // 3. 更新 tab 列表（同路径去重：已打开则激活，否则新增）
    if (!state.fileTabs.some(function(t) { return t.path === path; })) {
        state.fileTabs.push(item);
    }
    state.activeFileTabPath = path;
    state.selectedItem = item;
    renderFileBrowserTabs();
    // git 变更文件：无编辑态缓存，重新拉取并渲染全文件对比视图。
    // （普通文件与 git diff 在同一套 tab 栏里可互相切换）
    if (item.type === 'git-file') {
        // 切回 git 变更 tab 时恢复右栏未保存的编辑值（若存在缓存）
        var gitCache = state.fileTabCache[path];
        renderGitFilePreview(item.gitPath, gitCache ? gitCache.gitRightContent : undefined);
        return;
    }
    if (item.type === 'git-history-file') {
        renderGitHistoryFilePreview(item.commitHash, item.gitPath);
        return;
    }
    // 4. 从缓存恢复目标文件编辑状态（打开过则保留编辑内容/渲染模式）
    var cache = state.fileTabCache[path];
    if (cache) {
        state.previewEditorValue = cache.editorValue || '';
        state.previewOriginalContent = cache.originalContent || '';
        state.previewRenderMode = cache.renderMode || 'preview';
        // 渲染：keepMode 保留恢复的编辑值，避免被文件内容覆盖
        renderFilePreview(item, { keepMode: true, skipMetaReload: false });
    } else {
        // 新文件：重置单例状态，renderFilePreview 不带 keepMode，
        // 让它按文件类型重新计算渲染模式（代码文件默认可编辑）并读取文件内容
        state.previewEditorValue = '';
        state.previewOriginalContent = '';
        state.previewRenderMode = 'preview';
        renderFilePreview(item, { skipMetaReload: false });
    }
}

/**
 * 以 tab 打开一个 git 变更文件（diff 视图）。
 * tab key 带 "git:" 前缀，与普通文件 tab 隔离（同名文件可同时开普通预览与 diff）；
 * 标题加 ◆ 标记便于识别是 git 对比。
 */
export function fileBrowserOpenGitTab(gitPath, group) {
    var state = window.fileBrowserState;
    if (!state || !gitPath) return;
    var clean = String(gitPath).replace(/^\//, '');
    var parts = clean.split('/');
    var name = parts[parts.length - 1] || clean;
    var groupTag = group === 'staged' ? ' [已暂存]' : '';
    fileBrowserOpenFileTab({
        path: 'git:' + clean,
        name: '◆ ' + name + groupTag,
        type: 'git-file',
        gitPath: gitPath
    });
}

/**
 * 以 tab 打开一个提交历史中的文件（diff 视图）。
 * key 带 "git-history:" 前缀，与普通文件 / git 变更列表 tab 均隔离；
 * 标题显示 ◆ 文件名 @前7位哈希。
 */
export function fileBrowserOpenGitHistoryTab(commitHash, gitPath) {
    var state = window.fileBrowserState;
    if (!state || !commitHash || !gitPath) return;
    var clean = String(gitPath).replace(/^\//, '');
    var parts = clean.split('/');
    var name = parts[parts.length - 1] || clean;
    var short = String(commitHash).slice(0, 7);
    fileBrowserOpenFileTab({
        path: 'git-history:' + short + ':' + clean,
        name: '◆ ' + name + ' @' + short,
        type: 'git-history-file',
        gitPath: gitPath,
        commitHash: commitHash
    });
}

/** 切换到指定路径的 tab（复用打开逻辑：已存在则仅激活） */
export function fileBrowserSwitchTab(path) {
    var state = window.fileBrowserState;
    if (!state || path === state.activeFileTabPath) return;
    var tab = state.fileTabs.find(function(t) { return t.path === path; });
    if (!tab) return;
    fileBrowserOpenFileTab(tab);
}

/** 关闭指定路径的 tab：从列表移除（编辑缓存保留，重新打开恢复），激活相邻 tab */
export function fileBrowserCloseTab(path) {
    var state = window.fileBrowserState;
    if (!state || !state.fileTabs) return;
    // 先保存当前活动 tab 状态（可能是被关闭的 tab）
    saveFileTabState();
    var idx = state.fileTabs.findIndex(function(t) { return t.path === path; });
    if (idx < 0) return;
    state.fileTabs.splice(idx, 1);
    if (state.activeFileTabPath === path) {
        // 关闭的是活动 tab：激活相邻 tab
        var next = state.fileTabs[idx] || state.fileTabs[idx - 1];
        if (next) {
            fileBrowserOpenFileTab(next);
        } else {
            // 无剩余 tab：清空预览区
            state.activeFileTabPath = '';
            state.selectedItem = null;
            destroyFileBrowserEditor();
            clearFileBrowserPreview();
            renderFileBrowserTabs();
        }
    } else {
        renderFileBrowserTabs();
    }
}

export async function renderFilePreview(item, options) {
    var state = window.fileBrowserState;
    options = options || {};
    if (!state || !item || item.type !== 'file') return;
    var requestSeq = ++state.previewRequestSeq;
    var isCurrentRequest = function() {
        return requestSeq === state.previewRequestSeq && state.activeFileTabPath === item.path;
    };
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
        if (!isCurrentRequest()) return;
        state.previewMeta = meta;
        if (!options.keepMode) {
            state.previewRenderMode = fileBrowserGetPreferredRenderMode(meta);
        }
        // 普通代码/文本文件没有“预览/编辑”切换按钮；可编辑时必须保持编辑模式，
        // 避免从其他 tab 恢复的 preview 状态导致同类文件变成只读。
        var canSwitchRenderMode = meta.previewKind === 'markdown' ||
            (meta.previewKind === 'code' && isHtmlExtension(meta.ext || ''));
        if (meta.editable && !canSwitchRenderMode) {
            state.previewRenderMode = 'edit';
        }
        if (metaEl) {
            metaEl.textContent = [meta.ext || '', fileBrowserFormatBytes(meta.size || 0), meta.modifiedAt || ''].filter(Boolean).join(' · ');
        }
        renderFilePreviewToolbar();
        var ext = (meta.ext || '').toLowerCase();
        var previewKind = meta.previewKind || '';

        if (previewKind === 'image') {
            var previewImageRes = await fileBrowserResolveRawResource(state.rootDir, item.path);
            if (!isCurrentRequest()) return;
            bodyEl.innerHTML = '<div class="file-browser-image-wrap"><img class="file-browser-image" src="' + previewImageRes.url + '" alt="' + escapeHtml(item.name) + '"></div>';
            return;
        }
        if (previewKind === 'pdf') {
            var previewPdfRes = await fileBrowserResolveRawResource(state.rootDir, item.path);
            if (!isCurrentRequest()) return;
            bodyEl.innerHTML = '<iframe class="file-browser-pdf" title="PDF预览" src="' + previewPdfRes.url + '"></iframe>';
            return;
        }
        if (previewKind === 'spreadsheet') {
            bodyEl.innerHTML = '<div class="file-browser-unsupported">' +
                '<p>当前版本未启用 Excel 在线预览。</p>' +
                '<p>文件：' + escapeHtml(item.name) + '</p>' +
                '</div>';
            return;
        }
        if (previewKind === 'markdown' || previewKind === 'csv' || previewKind === 'text' || previewKind === 'code') {
            var previewReadData = await fileBrowserApiRead(state.rootDir, item.path);
            if (!isCurrentRequest()) return;
            state.previewReadResult = previewReadData;
            if (!options.keepMode || state.previewEditorValue === '' || !fileBrowserIsDirty()) {
                state.previewEditorValue = previewReadData.content || '';
                state.previewOriginalContent = previewReadData.content || '';
            }
            await renderTextualFilePreview(item, meta, previewReadData, ext, isCurrentRequest);
            if (!isCurrentRequest()) return;
            renderFilePreviewToolbar();
            return;
        }

        if (!ext) {
            if (state.previewRenderMode === 'edit' || state.forcedTextPreview[item.path]) {
                var noExtReadData = await fileBrowserApiRead(state.rootDir, item.path);
                if (!isCurrentRequest()) return;
                var noExtContent = noExtReadData.content || '';
                state.previewReadResult = noExtReadData;
                if (!options.keepMode || state.previewEditorValue === '' || !fileBrowserIsDirty()) {
                    state.previewEditorValue = noExtContent;
                    state.previewOriginalContent = noExtContent;
                }
                if (metaEl) {
                    metaEl.textContent = ['无扩展名 · 按普通文本方式打开', fileBrowserFormatBytes(meta.size || 0), meta.modifiedAt || ''].filter(Boolean).join(' · ');
                }
                await renderTextualFilePreview(item, meta, noExtReadData, '', isCurrentRequest);
                if (!isCurrentRequest()) return;
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
                '<p>文件：' + escapeHtml(item.name) + '</p>' +
            '</div>';
        renderFilePreviewToolbar();
    } catch (err) {
        if (!isCurrentRequest()) return;
        if (metaEl) metaEl.textContent = '';
        if (bodyEl) bodyEl.innerHTML = '<div class="file-browser-empty error">' + escapeHtml(err.message || err) + '</div>';
        renderFilePreviewToolbar();
    }
}

export function renderNoExtPreview(item, meta) {
    return '<div class="file-browser-noext">' +
        '<div class="file-browser-noext-title">无扩展名文件</div>' +
        '<div class="file-browser-noext-hint">系统暂时无法自动判断该文件类型。你可以按普通文本方式尝试预览。</div>' +
        '<div class="file-browser-noext-name">文件：' + escapeHtml(item.name || meta.name || item.path || '') + '</div>' +
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
            html += '<th>' + escapeHtml(col) + '</th>';
            } else {
            html += '<td>' + escapeHtml(col) + '</td>';
            }
        });
        html += '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
}

/**
 * 将全量 diff 的 blocks 展平为行对列表。
 * parseUnifiedDiffToBlocks 保证每个 block 的 left/right 长度恒等（appendPair 同步推进），
 * 全量模式（-U1000000 覆盖整文件）下 blocks 即完整行对；左侧 del/右侧 add 的变更行
 * 在对侧以 empty 行占位，前端据此重建等行数文档实现逐行对齐。
 */
export function buildGitPairRows(blocks) {
    var rows = [];
    (blocks || []).forEach(function(block) {
        var L = block.left || [];
        var R = block.right || [];
        var n = L.length > R.length ? L.length : R.length;
        for (var i = 0; i < n; i++) {
            var l = L[i] || { kind: 'empty', oldNo: 0, newNo: 0, text: '' };
            var r = R[i] || { kind: 'empty', oldNo: 0, newNo: 0, text: '' };
            rows.push({
                left: { text: l.text || '', no: l.oldNo || 0, kind: l.kind || 'empty' },
                right: { text: r.text || '', no: r.newNo || 0, kind: r.kind || 'empty' }
            });
        }
    });
    return rows;
}

/**
 * 渲染工作区 Git 变更的编辑器 diff 视图（左侧 HEAD 版本 / 右侧工作区版本）。
 * presetRightContent 为 tab 缓存里恢复的右侧编辑值（未保存的编辑不因切 tab 丢失）；
 * 传 undefined 表示无缓存，用后端返回的 rightContent。
 */
export async function renderGitFilePreview(path, presetRightContent) {
    var state = window.fileBrowserState;
    if (!state || !path) return;
    fileBrowserClearObjectURL();
    state.previewMode = 'git';
    state.selectedItem = null;
    state.gitPreviewPath = path;
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
        var isUntracked = !data.tracked;
        var blocks = (data.stagedBlocks && data.stagedBlocks.length) ? data.stagedBlocks : (data.unstagedBlocks || []);
        var fullBlocks = !isUntracked && !!data.fullBlocks && blocks.length > 0;
        // 行对模式下：由全量 blocks 展平行对；右文档由行对重建（含占位符）。
        // tab 缓存（presetRightContent）是用户编辑过的行对右文档，仅当行数与当前行对
        // 一致才采纳（用户增删行导致长度变化时丢弃缓存，用后端内容重建）。
        var pairRows = fullBlocks ? buildGitPairRows(blocks) : null;
        var presetDoc = null;
        if (pairRows && typeof presetRightContent === 'string') {
            if (presetRightContent.split('\n').length === pairRows.length) presetDoc = presetRightContent;
        }
        // 非行对模式下的右栏内容：优先用 tab 缓存里未保存的编辑值
        var rightContent = (typeof presetRightContent === 'string')
            ? presetRightContent
            : (isUntracked ? (data.untrackedContent || '') : (data.rightContent || ''));
        renderGitDiffEditor({
            fileName: ((data.path || path).split('/').pop() || ''),
            leftTitle: isUntracked ? '（新文件，无旧版本）' : 'HEAD 版本',
            rightTitle: isUntracked ? '工作区内容（可编辑）' : '工作区（可编辑）',
            leftContent: isUntracked ? '' : (data.leftContent || ''),
            rightContent: rightContent,
            blocks: isUntracked ? [] : blocks,
            fullBlocks: fullBlocks,
            pairRows: pairRows,
            presetRightDoc: presetDoc,
            rightReadOnly: false
        });
    } catch (err) {
        bodyEl.innerHTML = '<div class="file-browser-empty error">' + escapeHtml(err.message || err) + '</div>';
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
        renderGitDiffEditor({
            fileName: (path.split('/').pop() || ''),
            leftTitle: '父提交版本',
            rightTitle: '当前提交版本（只读）',
            leftContent: data.leftContent || '',
            rightContent: data.rightContent || '',
            blocks: data.blocks || [],
            fullBlocks: !!data.fullBlocks,
            rightReadOnly: true
        });
    } catch (err) {
        bodyEl.innerHTML = '<div class="file-browser-empty error">' + escapeHtml(err.message || err) + '</div>';
    }
}

/**
 * 用左右两个 CodeMirror 编辑器渲染 diff 视图。
 * opts: { fileName, leftTitle, rightTitle, leftContent, rightContent, blocks, fullBlocks, rightReadOnly }
 * fullBlocks=true 且 blocks 非空时走「行对模式」（等行数 + 1:1 滚动）；
 * 否则回退「独立双文档 + 比例滚动」模式（片段 diff 或未跟踪文件）。
 */
export function renderGitDiffEditor(opts) {
    var state = window.fileBrowserState;
    var bodyEl = document.getElementById('filePreviewBody');
    if (!bodyEl || !window.ProjectConfigCodeEditor || !window.ProjectConfigCodeEditor.createDiff) return;
    // 先销毁旧 diff 实例（切换文件 / tab / 刷新时复用）
    if (state.previewDiffInstance) {
        state.previewDiffInstance.destroy();
        state.previewDiffInstance = null;
    }
    // 行对模式前置条件：全量 diff + 有 blocks 且编辑器 createDiff 返回 paired 实例
    var usePaired = opts.fullBlocks && opts.blocks && opts.blocks.length;
    var pairRows = usePaired ? (opts.pairRows || buildGitPairRows(opts.blocks)) : null;
    bodyEl.innerHTML =
        '<div class="file-browser-diff-wrap">' +
            '<div class="file-browser-diff-pane">' +
                '<div class="file-browser-diff-pane-title">' + escapeHtml(opts.leftTitle || '旧版本') + '</div>' +
                '<div class="file-browser-code-editor" id="fileBrowserDiffLeft"></div>' +
            '</div>' +
            '<div class="file-browser-diff-divider"></div>' +
            '<div class="file-browser-diff-pane">' +
                '<div class="file-browser-diff-pane-title">' + escapeHtml(opts.rightTitle || '新版本') + '</div>' +
                '<div class="file-browser-code-editor" id="fileBrowserDiffRight">' +
                    // minimap 容器：位于编辑器可视区内右上角，行对模式下显示变更概览
                    '<div class="file-browser-diff-minimap" id="fileBrowserDiffMinimap" style="display:none"></div>' +
                '</div>' +
            '</div>' +
        '</div>';
    var leftMount = document.getElementById('fileBrowserDiffLeft');
    var rightMount = document.getElementById('fileBrowserDiffRight');
    if (!leftMount || !rightMount) return;
    state.previewDiffInstance = window.ProjectConfigCodeEditor.createDiff(leftMount, rightMount, {
        fileName: opts.fileName || '',
        isDark: isFileBrowserDarkTheme(),
        pairRows: pairRows,
        presetRightDoc: opts.presetRightDoc,
        leftContent: opts.leftContent || '',
        rightContent: opts.rightContent || '',
        blocks: opts.blocks || [],
        rightReadOnly: !!opts.rightReadOnly,
        onChangeRight: function(value) {
            state.previewEditorValue = value || '';
            renderFilePreviewToolbar();
        }
    });
    // 行对模式：构建并显示滚动条 minimap
    if (pairRows && state.previewDiffInstance && state.previewDiffInstance.paired) {
        buildGitDiffMinimap(pairRows, state.previewDiffInstance);
    }
    // 中间分隔条拖拽调节左右宽度（双击恢复等宽）
    initGitDiffDivider();
    state.previewOriginalContent = opts.rightContent || '';
    renderFilePreviewToolbar();
}

/**
 * 构建滚动条 minimap（GitHub 风格）：
 * - 按 pairRows 计算变更段：连续 del/add 行归并为一段，标记 删(add-only)/增(del-only)/改(混合)
 * - 段位置与高度按行号比例线性映射（行对模式无折行、行高恒等，映射精确）
 * - 视口指示条跟随左右编辑器滚动（行对模式两侧 1:1，监听一侧即可）
 * - 点击段/任意位置 → scrollToRow(rowIndex) 两侧同步跳转
 */
export function buildGitDiffMinimap(rows, diff) {
    var mmEl = document.getElementById('fileBrowserDiffMinimap');
    if (!mmEl || !rows || !rows.length || !diff || !diff.right || !diff.scrollToRow) return;
    // 1. 收集变更段
    var segs = [];
    var cur = null;
    rows.forEach(function(r, i) {
        var hasDel = (r.left && r.left.kind === 'del');
        var hasAdd = (r.right && r.right.kind === 'add');
        if (!hasDel && !hasAdd) {
            if (cur) { segs.push(cur); cur = null; }
            return;
        }
        if (!cur) {
            cur = { start: i, end: i, hasDel: hasDel, hasAdd: hasAdd };
        } else {
            cur.end = i;
            if (hasDel) cur.hasDel = true;
            if (hasAdd) cur.hasAdd = true;
        }
    });
    if (cur) segs.push(cur);
    var total = rows.length;
    // 2. 渲染色块
    var html = '';
    segs.forEach(function(s) {
        var topPct = (s.start / total) * 100;
        var hPct = ((s.end - s.start + 1) / total) * 100;
        if (hPct < 0.4) hPct = 0.4; // 保证 1 行也可见
        var cls = (s.hasDel && s.hasAdd) ? 'modified' : (s.hasDel ? 'del' : 'add');
        html += '<div class="file-browser-diff-minimap-seg ' + cls + '" data-start="' + s.start + '"' +
            ' style="top:' + topPct.toFixed(2) + '%;height:' + hPct.toFixed(2) + '%"></div>';
    });
    html += '<div class="file-browser-diff-minimap-viewport"></div>';
    mmEl.innerHTML = html;
    mmEl.style.display = 'block';
    // 3. 视口指示条随滚动移动
    var scrollDom = diff.left && diff.left.view ? diff.left.view.scrollDOM : null;
    if (!scrollDom && diff.right && diff.right.view) scrollDom = diff.right.view.scrollDOM;
    var vp = mmEl.querySelector('.file-browser-diff-minimap-viewport');
    function updateMinimapViewport() {
        if (!scrollDom || !vp) return;
        var maxTop = scrollDom.scrollHeight - scrollDom.clientHeight;
        var ratio = maxTop > 0 ? (scrollDom.scrollTop / maxTop) : 0;
        // 指示条高度表示当前可视窗口占比
        var vpH = (scrollDom.clientHeight / scrollDom.scrollHeight) * 100;
        if (vpH > 100) vpH = 100;
        vp.style.top = ratio * (100 - vpH) + '%';
        vp.style.height = vpH + '%';
    }
    if (scrollDom) scrollDom.addEventListener('scroll', updateMinimapViewport);
    updateMinimapViewport();
    // 4. 点击跳转：点中色块跳到段首行；空白处按比例换算行号
    mmEl.addEventListener('click', function(e) {
        var target = e.target;
        if (target && target.classList && target.classList.contains('file-browser-diff-minimap-seg')) {
            var start = parseInt(target.dataset.start || '0', 10);
            if (!isNaN(start)) diff.scrollToRow(start);
            return;
        }
        var rect = mmEl.getBoundingClientRect();
        var ratio = (e.clientY - rect.top) / rect.height;
        if (ratio < 0 || ratio > 1) return;
        var row = Math.min(total - 1, Math.floor(ratio * total));
        diff.scrollToRow(Math.max(0, row));
    });
}

/**
 * 中间分隔条拖拽调节左右 diff 面板宽度：
 * - mousedown 记录起始 X 与左侧 pane 当前宽，mousemove 实时改左侧 flex-basis
 * - 最小宽度守卫（120px），右侧 pane 保持弹性撑满剩余空间
 * - 双击分隔条恢复等宽（flex: 1 1 0）
 * CodeMirror 自带 ResizeObserver，容器宽度变化后自动重排，无需额外通知。
 */
export function initGitDiffDivider() {
    var bodyEl = document.getElementById('filePreviewBody');
    if (!bodyEl) return;
    var wrap = bodyEl.querySelector('.file-browser-diff-wrap');
    if (!wrap) return;
    var divider = wrap.querySelector('.file-browser-diff-divider');
    if (!divider) return;
    var panes = wrap.querySelectorAll('.file-browser-diff-pane');
    if (panes.length < 2) return;
    var leftPane = panes[0];
    var rightPane = panes[1];
    var MIN_W = 120;
    var startX = 0;
    var startLeftW = 0;
    var dragging = false;

    function clampPanes(leftW) {
        var wrapW = wrap.clientWidth;
        var maxW = wrapW - MIN_W - 8;
        if (leftW < MIN_W) leftW = MIN_W;
        if (leftW > maxW) leftW = maxW;
        leftPane.style.flex = '0 0 ' + leftW + 'px';
        rightPane.style.flex = '1 1 0';
        rightPane.style.flexGrow = '1';
    }
    function onMove(e) {
        if (!dragging) return;
        var delta = e.clientX - startX;
        clampPanes(startLeftW + delta);
    }
    function onUp() {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('file-browser-diff-dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    }
    divider.addEventListener('mousedown', function(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startLeftW = leftPane.getBoundingClientRect().width;
        document.body.classList.add('file-browser-diff-dragging');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
    // 双击恢复等宽
    divider.addEventListener('dblclick', function() {
        leftPane.style.flex = '';
        leftPane.style.flex = '1 1 0';
        rightPane.style.flex = '1 1 0';
    });
}

/** 保存 git-file 视图右侧（工作区）的编辑内容到磁盘 */
export async function saveCurrentGitDiffPreview() {
    var state = window.fileBrowserState;
    var diff = state.previewDiffInstance;
    if (!state || !diff || state.previewMode !== 'git' || state.savingPreview) return;
    var path = state.gitPreviewPath;
    if (!path) return;
    state.savingPreview = true;
    renderFilePreviewToolbar();
    try {
        // 行对模式右文档含 \u200b 占位行，保存前必须过滤（getValueRightClean）；
        // 非行对模式该函数等价于 getValueRight。
        var result = await fileBrowserApiSave(state.rootDir, path, diff.getValueRightClean());
        if (!result.success) {
            showToast(result.error || '保存失败', 'error');
            return;
        }
        diff.markClean();
        showToast('保存成功', 'success');
        // 保存后重新拉取 diff（工作区已变化，右栏与左栏应趋于一致）
        await renderGitFilePreview(path);
    } catch (err) {
        showToast(err.message || '保存失败', 'error');
    } finally {
        state.savingPreview = false;
        renderFilePreviewToolbar();
    }
}

// ===== Git 改动跳转 =====
// 上一处/下一处按钮已移除（滚动条 minimap 承担跳转职责，点击即达）；
// 编辑器 diff 的跳转能力保留在 createDiff 实例的 scrollToRow（minimap 使用）。
