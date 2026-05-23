// ============================================================
// 站内文件浏览器 - 预览器分发
// ============================================================

function fileBrowserBuildApiURL(kind, rootDir, relPath) {
    return '/api/files/' + kind + '?rootDir=' + encodeURIComponent(rootDir || '') + '&path=' + encodeURIComponent(relPath || '/');
}

async function fileBrowserApiStat(rootDir, relPath) {
    if (window.runtime) {
        return await api.StatBrowserFile(rootDir, relPath);
    }
    var resp = await fetch(fileBrowserBuildApiURL('stat', rootDir, relPath));
    if (!resp.ok) throw new Error('读取文件信息失败');
    return await resp.json();
}

async function fileBrowserApiRead(rootDir, relPath) {
    if (window.runtime) {
        return await api.ReadBrowserFile(rootDir, relPath);
    }
    var resp = await fetch(fileBrowserBuildApiURL('read', rootDir, relPath));
    if (!resp.ok) throw new Error('读取文件内容失败');
    return await resp.json();
}

async function fileBrowserApiGitPreview(rootDir, relPath) {
    if (window.runtime) {
        return await api.GetGitPreview(rootDir, relPath);
    }
    var resp = await fetch('/api/git/preview?rootDir=' + encodeURIComponent(rootDir || '') + '&path=' + encodeURIComponent(relPath || '/'));
    if (!resp.ok) throw new Error('读取 Git 变更失败');
    return await resp.json();
}

async function fileBrowserApiGitHistoryPreview(rootDir, commitHash, relPath) {
    if (window.runtime) {
        return await api.GetGitHistoryPreview(rootDir, commitHash, relPath);
    }
    var resp = await fetch('/api/git/history/preview?rootDir=' + encodeURIComponent(rootDir || '') + '&commitHash=' + encodeURIComponent(commitHash || '') + '&path=' + encodeURIComponent(relPath || '/'));
    if (!resp.ok) throw new Error('读取 Git 历史文件变更失败');
    return await resp.json();
}

function fileBrowserBuildRawURL(rootDir, relPath) {
    return fileBrowserBuildApiURL('raw', rootDir, relPath);
}

function fileBrowserClearObjectURL() {
    var state = window.fileBrowserState;
    if (state && state.previewObjectURL) {
        URL.revokeObjectURL(state.previewObjectURL);
        state.previewObjectURL = '';
    }
}

function base64ToBlob(base64, mime) {
    var binary = atob(base64 || '');
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

async function fileBrowserResolveRawResource(rootDir, relPath) {
    if (window.runtime) {
        var raw = await api.ReadBrowserRawBase64(rootDir, relPath);
        var blob = base64ToBlob(raw.base64 || '', raw.mime || 'application/octet-stream');
        var url = URL.createObjectURL(blob);
        window.fileBrowserState.previewObjectURL = url;
        return { url: url, name: raw.name || '', mime: raw.mime || 'application/octet-stream' };
    }
    return { url: fileBrowserBuildRawURL(rootDir, relPath), name: '', mime: '' };
}

function fileBrowserEscapeHTML(text) {
    if (text == null) return '';
    var div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function fileBrowserHighlightCode(code, ext) {
    if (typeof hljs === 'undefined') return fileBrowserEscapeHTML(code);
    try {
        var lang = fileBrowserExtToLang(ext);
        var result = lang ? hljs.highlight(String(code || ''), { language: lang }) : hljs.highlightAuto(String(code || ''));
        var html = result.value;
        // 拆行加行号
        var lines = html.split('\n');
        var numbered = '';
        for (var i = 0; i < lines.length; i++) {
            numbered += '<div class="hljs-line"><span class="hljs-line-no">' + (i + 1) + '</span><span class="hljs-line-content">' + (lines[i] || ' ') + '</span></div>';
        }
        return numbered;
    } catch (e) {
        return fileBrowserEscapeHTML(code);
    }
}

function fileBrowserExtToLang(ext) {
    var map = {
        '.js': 'javascript', '.jsx': 'javascript','mjs':'javascript','cjs':'javascript',
        '.ts': 'typescript', '.tsx': 'typescript',
        '.go': 'go', '.mod': 'go', '.sum': 'go',
        '.py': 'python',
        '.java': 'java','.jsp': 'java',
        '.c': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.h': 'c',
        'cs':'csharp',
        '.rs': 'rust',
        '.sh': 'bash', '.bash': 'bash','.cmd': 'bash',
        '.css': 'css', '.scss': 'scss', '.less': 'less',
        '.html': 'xml', '.htm': 'xml', '.xml': 'xml',
        '.json': 'json','.jsonc': 'json',
        '.yaml': 'yaml', '.yml': 'yaml','.toml': 'toml',
        '.sql': 'sql',
        '.ini': 'ini', '.env': 'ini',
        '.bat': 'dos',
        '.md': 'markdown', '.markdown': 'markdown',
    };
    return map[(ext || '').toLowerCase()] || null;
}

function fileBrowserSanitizeMarkedHtml(html) {
    var template = document.createElement('template');
    template.innerHTML = html;
    var allowedTags = new Set(['A', 'P', 'BR', 'STRONG', 'EM', 'CODE', 'PRE', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']);
    sanitizeNodeTree(template.content, allowedTags);
    return template.innerHTML;
}

function sanitizeNodeTree(root, allowedTags) {
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
            node.removeAttribute(attr.name);
        });
        sanitizeNodeTree(node, allowedTags);
    });
}

function fileBrowserFormatBytes(bytes) {
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

function updateFileBrowserDownloadButton(item) {
	var path = item && item.path ? item.path : '';
	var name = item && item.name ? item.name : '';
	if (typeof setFileBrowserDownloadTarget === 'function') {
		setFileBrowserDownloadTarget(path, name);
	}
}

async function renderFilePreview(item) {
    var state = window.fileBrowserState;
    if (!state || !item || item.type !== 'file') return;
    fileBrowserClearObjectURL();
    state.selectedItem = item;
    updateFileBrowserDownloadButton(item);
    var titleEl = document.getElementById('filePreviewTitle');
    var metaEl = document.getElementById('filePreviewMeta');
    var bodyEl = document.getElementById('filePreviewBody');
    if (titleEl) titleEl.textContent = item.name;
    if (metaEl) metaEl.textContent = '加载中...';
    if (bodyEl) bodyEl.innerHTML = '<div class="file-browser-empty">正在读取文件...</div>';

    try {
        var meta = await fileBrowserApiStat(state.rootDir, item.path);
        state.previewMeta = meta;
        if (metaEl) {
            metaEl.textContent = [meta.ext || '', fileBrowserFormatBytes(meta.size || 0), meta.modifiedAt || ''].filter(Boolean).join(' · ');
        }
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
            state.previewContent = previewReadData.content || '';
            if (previewKind === 'markdown') {
                bodyEl.innerHTML = '<div class="oc-text file-browser-markdown">' + fileBrowserSanitizeMarkedHtml(marked.parse(previewReadData.content || '')) + '</div>';
                return;
            }
            if (previewKind === 'csv') {
                bodyEl.innerHTML = renderCSVPreview(previewReadData.content || '');
                return;
            }
            bodyEl.innerHTML = '<pre class="file-browser-code"><code class="hljs">' + fileBrowserHighlightCode(previewReadData.content || '', ext) + '</code></pre>';
            return;
        }

        if (!ext) {
            if (state.forcedTextPreview[item.path]) {
                var noExtReadData = await fileBrowserApiRead(state.rootDir, item.path);
                var noExtContent = noExtReadData.content || '';
                state.previewContent = noExtContent;
                if (metaEl) {
                    metaEl.textContent = ['无扩展名 · 按普通文本方式预览', fileBrowserFormatBytes(meta.size || 0), meta.modifiedAt || ''].filter(Boolean).join(' · ');
                }
                bodyEl.innerHTML = '<div class="file-browser-noext-hint">已按普通文本方式打开该无扩展名文件，内容可能不是可读文本。</div>' +
                    '<pre class="file-browser-code"><code class="hljs">' + fileBrowserHighlightCode(noExtContent, '') + '</code></pre>';
                return;
            }
            bodyEl.innerHTML = renderNoExtPreview(item, meta);
            bindNoExtPreviewActions(item);
            return;
        }

        bodyEl.innerHTML = '<div class="file-browser-unsupported">' +
            '<p>该文件类型暂不支持在线预览。</p>' +
            '<p>文件：' + fileBrowserEscapeHTML(item.name) + '</p>' +
            '</div>';
    } catch (err) {
        if (metaEl) metaEl.textContent = '';
        if (bodyEl) bodyEl.innerHTML = '<div class="file-browser-empty error">' + fileBrowserEscapeHTML(err.message || err) + '</div>';
    }
}

function renderNoExtPreview(item, meta) {
    return '<div class="file-browser-noext">' +
        '<div class="file-browser-noext-title">无扩展名文件</div>' +
        '<div class="file-browser-noext-hint">系统暂时无法自动判断该文件类型。你可以按普通文本方式尝试预览。</div>' +
        '<div class="file-browser-noext-name">文件：' + fileBrowserEscapeHTML(item.name || meta.name || item.path || '') + '</div>' +
        '<div class="file-browser-noext-actions">' +
            '<button type="button" class="btn btn-sm btn-refresh" id="btnOpenNoExtAsText">按普通文本打开</button>' +
        '</div>' +
    '</div>';
}

function bindNoExtPreviewActions(item) {
    var openBtn = document.getElementById('btnOpenNoExtAsText');
    if (openBtn) {
        openBtn.onclick = function() {
            window.fileBrowserState.forcedTextPreview[item.path] = true;
            renderFilePreview(item);
        };
    }
}

function renderCSVPreview(content) {
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

async function renderGitFilePreview(path) {
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

async function renderGitHistoryFilePreview(commitHash, path) {
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
    try {
        var data = await fileBrowserApiGitHistoryPreview(state.rootDir, commitHash, path);
        var blocks = data.blocks || [];
        bodyEl.innerHTML = renderGitSection('提交修改', blocks, true);
    } catch (err) {
        bodyEl.innerHTML = '<div class="file-browser-empty error">' + fileBrowserEscapeHTML(err.message || err) + '</div>';
    }
}

function renderGitSection(title, blocks, enabled) {
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

function renderGitDiffBlock(block) {
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

function renderGitDiffLine(line, side) {
    var no = side === 'left' ? line.oldNo : line.newNo;
    var noText = no ? String(no) : '';
    return '<div class="git-diff-line ' + fileBrowserEscapeHTML(line.kind || 'context') + '">' +
        '<span class="git-diff-line-no">' + fileBrowserEscapeHTML(noText) + '</span>' +
        '<span class="git-diff-line-text">' + fileBrowserEscapeHTML(line.text || '') + '</span>' +
    '</div>';
}
