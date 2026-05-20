// ============================================================
// 站内文件浏览器 - 目录浏览与状态管理
// ============================================================

window.fileBrowserState = {
    rootDir: '',
    currentPath: '/',
    parentPath: '/',
    items: [],
    selectedItem: null,
    previewMeta: null,
    previewContent: null,
    loadingList: false,
    loadingPreview: false,
    previewMode: 'file',
    git: {
        expanded: true,
        isGitRepo: false,
        files: [],
        message: '',
    },
};

function fileBrowserUseWails() {
    return !!window.runtime;
}

async function fileBrowserApiList(rootDir, path) {
    if (fileBrowserUseWails()) {
        return await api.ListBrowserFiles(rootDir, path);
    }
    var resp = await fetch('/api/files/list?rootDir=' + encodeURIComponent(rootDir) + '&path=' + encodeURIComponent(path));
    if (!resp.ok) throw new Error('列目录失败');
    return await resp.json();
}

async function fileBrowserApiGitStatus(rootDir) {
    if (fileBrowserUseWails()) {
        return await api.GetGitStatus(rootDir);
    }
    var resp = await fetch('/api/git/status?rootDir=' + encodeURIComponent(rootDir));
    if (!resp.ok) throw new Error('读取 Git 状态失败');
    return await resp.json();
}

(function initFileBrowserResize() {
    var handle = document.getElementById('fileBrowserResizeHandle');
    var body = document.querySelector('.file-browser-body');
    if (!handle || !body || handle.dataset.bound) return;
    handle.dataset.bound = 'true';
    var STORAGE_KEY = 'fileBrowserLeftWidth';
    var MIN_WIDTH = 220;
    var MAX_WIDTH = 520;

    var saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
    if (saved && saved >= MIN_WIDTH && saved <= MAX_WIDTH) {
        body.style.setProperty('--file-browser-left-width', saved + 'px');
    }

    handle.addEventListener('mousedown', function(e) {
        e.preventDefault();
        var startX = e.clientX;
        var startWidth = parseInt(getComputedStyle(body).getPropertyValue('--file-browser-left-width')) || 320;
        handle.classList.add('dragging');

        function onMove(ev) {
            var newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + (ev.clientX - startX)));
            body.style.setProperty('--file-browser-left-width', newWidth + 'px');
        }

        function onUp() {
            handle.classList.remove('dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            var finalWidth = parseInt(getComputedStyle(body).getPropertyValue('--file-browser-left-width')) || 320;
            localStorage.setItem(STORAGE_KEY, finalWidth);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
})();

function gitStatusClass(code) {
    var c = String(code || '').trim();
    if (c === '??') return 'untracked';
    if (c.indexOf('R') >= 0) return 'rename';
    if (c.indexOf('D') >= 0) return 'delete';
    if (c.indexOf('A') >= 0) return 'add';
    return 'modify';
}

function openFileBrowserModal(rootDir) {
    var modal = document.getElementById('fileBrowserModal');
    var title = document.getElementById('fileBrowserTitle');
    if (!modal) return;
    window.fileBrowserState.rootDir = rootDir || '';
    window.fileBrowserState.currentPath = '/';
    window.fileBrowserState.parentPath = '/';
    window.fileBrowserState.selectedItem = null;
    window.fileBrowserState.previewMode = 'file';
    window.fileBrowserState.git = { expanded: false, isGitRepo: false, files: [], message: '' };
    if (title) title.textContent = '文件浏览 - ' + (rootDir || '');
    modal.style.display = 'flex';
    loadFileBrowserList('/');
}

function closeFileBrowserModal() {
    var modal = document.getElementById('fileBrowserModal');
    if (modal) modal.style.display = 'none';
    if (typeof fileBrowserClearObjectURL === 'function') fileBrowserClearObjectURL();
    clearFileBrowserPreview();
}

function clearFileBrowserPreview() {
    var titleEl = document.getElementById('filePreviewTitle');
    var metaEl = document.getElementById('filePreviewMeta');
    var bodyEl = document.getElementById('filePreviewBody');
    if (titleEl) titleEl.textContent = '请选择文件';
    if (metaEl) metaEl.textContent = '';
    if (bodyEl) bodyEl.innerHTML = '<div class="file-browser-empty">请选择左侧文件进行预览</div>';
}

async function loadFileBrowserGitStatus() {
    var state = window.fileBrowserState;
    if (!state.rootDir) return;
    try {
        var data = await fileBrowserApiGitStatus(state.rootDir);
        state.git.isGitRepo = !!data.isGitRepo;
        state.git.files = data.files || [];
        state.git.message = data.message || '';
    } catch (err) {
        state.git.isGitRepo = false;
        state.git.files = [];
        state.git.message = err.message || String(err);
    }
    renderFileBrowserGitSection();
}

async function loadFileBrowserList(path) {
    var state = window.fileBrowserState;
    var listEl = document.getElementById('fileBrowserList');
    var emptyEl = document.getElementById('fileBrowserListEmpty');
    if (!listEl || !state.rootDir) return;
    state.loadingList = true;
    state.currentPath = path || '/';
    if (listEl) listEl.innerHTML = '<div class="file-browser-empty">正在读取目录...</div>';
    if (emptyEl) emptyEl.style.display = 'none';
    clearFileBrowserPreview();
    try {
        var data = await fileBrowserApiList(state.rootDir, state.currentPath);
        state.currentPath = data.currentPath || '/';
        state.parentPath = data.parentPath || '/';
        state.items = data.items || [];
        renderFileBrowserBreadcrumb();
        renderFileBrowserList();
        loadFileBrowserGitStatus();
    } catch (err) {
        if (listEl) listEl.innerHTML = '<div class="file-browser-empty error">' + escapeHtml(err.message || err) + '</div>';
    } finally {
        state.loadingList = false;
    }
}

function renderFileBrowserGitSection() {
    var bodyEl = document.getElementById('fileBrowserGitBody');
    var headerEl = document.getElementById('fileBrowserGitToggle');
    var state = window.fileBrowserState;
    if (!bodyEl || !headerEl) return;
    headerEl.textContent = (state.git.expanded ? '▼ ' : '▶ ') + 'Git 变更';
    bodyEl.style.display = state.git.expanded ? 'block' : 'none';
    if (!state.git.expanded) return;
    if (!state.git.isGitRepo) {
        bodyEl.innerHTML = '<div class="file-browser-empty">' + escapeHtml(state.git.message || '当前目录未启用 Git 版本管理') + '</div>';
        return;
    }
    if (!state.git.files.length) {
        bodyEl.innerHTML = '<div class="file-browser-empty">当前没有 Git 变更</div>';
        return;
    }
    bodyEl.innerHTML = state.git.files.map(function(item) {
        var fullPath = item.path.replace(/^\//, '');
        var displayName = item.name || fullPath;
        return '<button type="button" class="file-browser-git-item" data-git-path="' + escapeHtml(item.path) + '">' +
            '<span class="file-browser-git-status status-' + escapeHtml(gitStatusClass(item.statusCode || 'xx')) + '">' + escapeHtml(item.statusCode || '') + '</span>' +
            '<span class="file-browser-git-text" title="' + escapeHtml(fullPath) + '">' +
                '<span class="file-browser-git-name">' + escapeHtml(displayName) + '</span>' +
                '<span class="file-browser-git-path">' + escapeHtml(fullPath) + '</span>' +
            '</span>' +
        '</button>';
    }).join('');
    bodyEl.querySelectorAll('.file-browser-git-item').forEach(function(btn) {
        btn.addEventListener('click', function() {
            state.previewMode = 'git';
            state.selectedItem = null;
            renderFileBrowserSelection();
            bodyEl.querySelectorAll('.file-browser-git-item').forEach(function(node) {
                node.classList.toggle('active', node === btn);
            });
            renderGitFilePreview(this.dataset.gitPath || '/');
        });
    });
}

function renderFileBrowserBreadcrumb() {
    var pathEl = document.getElementById('fileBrowserPath');
    var upBtn = document.getElementById('btnFileBrowserUp');
    var state = window.fileBrowserState;
    if (pathEl) {
        var parts = state.currentPath.split('/').filter(Boolean);
        var html = '<span class="file-browser-crumb" data-path="/">根目录</span>';
        var acc = '/';
        parts.forEach(function(part) {
            acc += part + '/';
            html += '<span class="file-browser-crumb-sep">/</span><span class="file-browser-crumb" data-path="' + escapeHtml(acc) + '">' + escapeHtml(part) + '</span>';
        });
        pathEl.innerHTML = html;
        pathEl.querySelectorAll('[data-path]').forEach(function(node) {
            node.addEventListener('click', function() {
                loadFileBrowserList(this.dataset.path || '/');
            });
        });
    }
    if (upBtn) upBtn.disabled = (state.currentPath === '/' || state.currentPath === '');
}

function renderFileBrowserList() {
    var listEl = document.getElementById('fileBrowserList');
    var emptyEl = document.getElementById('fileBrowserListEmpty');
    var state = window.fileBrowserState;
    if (!listEl) return;
    if (!state.items.length) {
        listEl.innerHTML = '';
        if (emptyEl) {
            emptyEl.textContent = '当前目录为空';
            emptyEl.style.display = 'block';
        }
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.innerHTML = state.items.map(function(item) {
        var icon = item.type === 'dir' ? '📁' : '📄';
        return '<button type="button" class="file-browser-item ' + (item.type === 'dir' ? 'dir' : 'file') + '" data-path="' + escapeHtml(item.path) + '" data-type="' + escapeHtml(item.type) + '">' +
            '<span class="file-browser-item-icon">' + icon + '</span>' +
            '<span class="file-browser-item-name">' + escapeHtml(item.name) + '</span>' +
        '</button>';
    }).join('');
    listEl.querySelectorAll('.file-browser-item').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var path = this.dataset.path || '/';
            var type = this.dataset.type || 'file';
            if (type === 'dir') {
                loadFileBrowserList(path);
            } else {
                state.selectedItem = state.items.find(function(item) { return item.path === path; }) || null;
                renderFileBrowserSelection();
                renderFilePreview(state.selectedItem);
            }
        });
    });
}

function renderFileBrowserSelection() {
    var listEl = document.getElementById('fileBrowserList');
    var state = window.fileBrowserState;
    if (!listEl) return;
    listEl.querySelectorAll('.file-browser-item').forEach(function(node) {
        node.classList.toggle('active', !!state.selectedItem && node.dataset.path === state.selectedItem.path);
    });
    var gitBody = document.getElementById('fileBrowserGitBody');
    if (gitBody) {
        gitBody.querySelectorAll('.file-browser-git-item').forEach(function(node) {
            node.classList.remove('active');
        });
    }
}

function toggleFileBrowserGitSection() {
    window.fileBrowserState.git.expanded = !window.fileBrowserState.git.expanded;
    renderFileBrowserGitSection();
}

function goFileBrowserUp() {
    var state = window.fileBrowserState;
    if (!state.currentPath || state.currentPath === '/') return;
    loadFileBrowserList(state.parentPath || '/');
}

function refreshFileBrowser() {
    var state = window.fileBrowserState;
    loadFileBrowserList(state.currentPath || '/').then(function() {
        if (state.selectedItem) {
            renderFilePreview(state.selectedItem);
        }
    });
}
