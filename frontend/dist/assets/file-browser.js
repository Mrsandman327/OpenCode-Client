// ============================================================
// 站内文件浏览器 - 目录浏览与状态管理
// ============================================================

window.fileBrowserState = {
    rootDir: '',
    mode: 'files',
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
        currentExpanded: false,
        historyExpanded: false,
        isGitRepo: false,
        files: [],
        message: '',
        historyItems: [],
        historyOffset: 0,
        historyHasMore: false,
        historyLoading: false,
        expandedCommitHash: '',
        loadingCommitHash: '',
        activeHistoryFileKey: '',
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

async function fileBrowserApiGitHistory(rootDir, offset, limit) {
    if (fileBrowserUseWails()) {
        return await api.GetGitHistory(rootDir, offset, limit);
    }
    var resp = await fetch('/api/git/history?rootDir=' + encodeURIComponent(rootDir) + '&offset=' + encodeURIComponent(String(offset || 0)) + '&limit=' + encodeURIComponent(String(limit || 30)));
    if (!resp.ok) throw new Error('读取 Git 提交历史失败');
    return await resp.json();
}

async function fileBrowserApiGitHistoryFiles(rootDir, commitHash) {
    if (fileBrowserUseWails()) {
        return await api.GetGitHistoryFiles(rootDir, commitHash);
    }
    var resp = await fetch('/api/git/history/files?rootDir=' + encodeURIComponent(rootDir) + '&commitHash=' + encodeURIComponent(commitHash || ''));
    if (!resp.ok) throw new Error('读取提交文件列表失败');
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
    window.fileBrowserState.mode = 'files';
    window.fileBrowserState.rootDir = rootDir || '';
    window.fileBrowserState.currentPath = '/';
    window.fileBrowserState.parentPath = '/';
    window.fileBrowserState.selectedItem = null;
    window.fileBrowserState.previewMode = 'file';
    window.fileBrowserState.git = {
        currentExpanded: false,
        historyExpanded: false,
        isGitRepo: false,
        files: [],
        message: '',
        historyItems: [],
        historyOffset: 0,
        historyHasMore: false,
        historyLoading: false,
        expandedCommitHash: '',
        loadingCommitHash: '',
        activeHistoryFileKey: '',
    };
    if (title) title.textContent = '文件浏览 - ' + (rootDir || '');
    modal.style.display = 'flex';
    renderFileBrowserMode();
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

async function loadFileBrowserGitHistory(loadMore) {
    var state = window.fileBrowserState;
    if (!state.rootDir || state.git.historyLoading) return;
    state.git.historyLoading = true;
    renderFileBrowserGitSection();
    try {
        var offset = loadMore ? (state.git.historyOffset || 0) : 0;
        var limit = loadMore ? 10 : 30;
        var data = await fileBrowserApiGitHistory(state.rootDir, offset, limit);
        var items = (data.items || []).map(function(item) {
            return {
                hash: item.hash,
                shortHash: item.shortHash,
                subject: item.subject,
                author: item.author,
                date: item.date,
                expanded: false,
                loadingFiles: false,
                filesLoaded: false,
                files: [],
            };
        });
        state.git.historyItems = loadMore ? state.git.historyItems.concat(items) : items;
        state.git.historyOffset = (data.offset || 0) + items.length;
        state.git.historyHasMore = !!data.hasMore;
    } catch (err) {
        state.git.message = err.message || String(err);
    } finally {
        state.git.historyLoading = false;
        renderFileBrowserGitSection();
    }
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
    var currentBodyEl = document.getElementById('fileBrowserGitCurrentBody');
    var currentHeaderEl = document.getElementById('fileBrowserGitCurrentToggle');
    var historyBodyEl = document.getElementById('fileBrowserGitHistoryBody');
    var historyHeaderEl = document.getElementById('fileBrowserGitHistoryToggle');
    var state = window.fileBrowserState;
    if (!currentBodyEl || !currentHeaderEl || !historyBodyEl || !historyHeaderEl) return;
    currentHeaderEl.textContent = (state.git.currentExpanded ? '▼ ' : '▶ ') + '当前变更';
    historyHeaderEl.textContent = (state.git.historyExpanded ? '▼ ' : '▶ ') + '提交历史';
    currentBodyEl.style.display = state.git.currentExpanded ? 'block' : 'none';
    historyBodyEl.style.display = state.git.historyExpanded ? 'block' : 'none';
    if (!state.git.isGitRepo) {
        currentBodyEl.innerHTML = '<div class="file-browser-empty">' + escapeHtml(state.git.message || '当前目录未启用 Git 版本管理') + '</div>';
        historyBodyEl.innerHTML = '<div class="file-browser-empty">当前目录未启用 Git 版本管理</div>';
        return;
    }
    if (state.git.currentExpanded) {
        var staged = state.git.files.filter(function(item) { return !!item.hasStaged; });
        var unstaged = state.git.files.filter(function(item) { return !item.tracked || !!item.hasUnstaged; });
        currentBodyEl.innerHTML = '' +
            renderFileBrowserGitGroup('已暂存', staged, 'staged') +
            renderFileBrowserGitGroup('未暂存', unstaged, 'unstaged');
        bindCurrentGitFileEvents(currentBodyEl);
    }
    if (state.git.historyExpanded) {
        renderFileBrowserGitHistory(historyBodyEl);
    }
}

function renderFileBrowserGitGroup(title, files, groupName) {
    var html = '<div class="file-browser-git-group">' +
        '<div class="file-browser-git-subtitle">' + escapeHtml(title) + '</div>';
    if (!files.length) {
        return html + '<div class="file-browser-empty">当前没有' + escapeHtml(title) + '文件</div></div>';
    }
    html += files.map(function(item) {
        var fullPath = item.path.replace(/^\//, '');
        var displayName = item.name || fullPath;
        return '<button type="button" class="file-browser-git-item" data-git-path="' + escapeHtml(item.path) + '" data-git-group="' + escapeHtml(groupName) + '">' +
            '<span class="file-browser-git-status status-' + escapeHtml(gitStatusClass(item.statusCode || 'xx')) + '">' + escapeHtml(item.statusCode || '') + '</span>' +
            '<span class="file-browser-git-text" title="' + escapeHtml(fullPath) + '">' +
                '<span class="file-browser-git-name">' + escapeHtml(displayName) + '</span>' +
                '<span class="file-browser-git-path">' + escapeHtml(fullPath) + '</span>' +
            '</span>' +
        '</button>';
    }).join('');
    html += '</div>';
    return html;
}

function bindCurrentGitFileEvents(bodyEl) {
    var state = window.fileBrowserState;
    bodyEl.querySelectorAll('.file-browser-git-item').forEach(function(btn) {
        btn.addEventListener('click', function() {
            state.previewMode = 'git';
            state.selectedItem = null;
            state.git.activeHistoryFileKey = '';
            renderFileBrowserSelection();
            bodyEl.querySelectorAll('.file-browser-git-item').forEach(function(node) {
                node.classList.toggle('active', node === btn);
            });
            renderGitFilePreview(this.dataset.gitPath || '/');
        });
    });
}

function renderFileBrowserGitHistory(bodyEl) {
    var state = window.fileBrowserState;
    if (state.git.historyLoading && !state.git.historyItems.length) {
        bodyEl.innerHTML = '<div class="file-browser-empty">正在读取提交历史...</div>';
        return;
    }
    if (!state.git.historyItems.length) {
        bodyEl.innerHTML = '<div class="file-browser-empty">暂无提交记录</div>';
        return;
    }
    var html = state.git.historyItems.map(function(item) {
        var expanded = state.git.expandedCommitHash === item.hash;
        var fileHtml = '';
        if (expanded) {
            if (item.loadingFiles) {
                fileHtml = '<div class="file-browser-empty">正在读取提交文件...</div>';
            } else if (!item.files.length) {
                fileHtml = '<div class="file-browser-empty">该提交没有文件变更</div>';
            } else {
                fileHtml = '<div class="file-browser-git-history-files">' + item.files.map(function(file) {
                    var fileKey = item.hash + '::' + file.path;
                    return '<button type="button" class="file-browser-git-item file-item' + (state.git.activeHistoryFileKey === fileKey ? ' active' : '') + '" data-history-file-key="' + escapeHtml(fileKey) + '" data-commit-hash="' + escapeHtml(item.hash) + '" data-history-path="' + escapeHtml(file.path) + '">' +
                        '<span class="file-browser-git-status status-' + escapeHtml(gitStatusClass(file.status || '')) + '">' + escapeHtml(file.status || '') + '</span>' +
                        '<span class="file-browser-git-text" title="' + escapeHtml(file.path) + '">' +
                            '<span class="file-browser-git-name">' + escapeHtml(file.displayName || file.path) + '</span>' +
                            '<span class="file-browser-git-path">' + escapeHtml(file.path) + '</span>' +
                        '</span>' +
                    '</button>';
                }).join('') + '</div>';
            }
        }
        return '<div class="file-browser-git-group">' +
            '<button type="button" class="file-browser-git-item commit-item' + (expanded ? ' active' : '') + '" data-commit-hash="' + escapeHtml(item.hash) + '">' +
                '<span class="file-browser-git-status status-modify">' + escapeHtml(item.shortHash || '') + '</span>' +
                '<span class="file-browser-git-text" title="' + escapeHtml(item.subject || '') + '">' +
                    '<span class="file-browser-git-name">' + escapeHtml(item.subject || '(无标题提交)') + '</span>' +
                    '<span class="file-browser-git-path">' + escapeHtml([item.author || '', item.date || ''].filter(Boolean).join(' · ')) + '</span>' +
                '</span>' +
            '</button>' + fileHtml +
        '</div>';
    }).join('');
    if (state.git.historyHasMore || state.git.historyLoading) {
        html += '<div class="file-browser-git-history-actions"><button type="button" class="file-browser-git-history-load-more" id="btnFileBrowserLoadGitHistory" ' + (state.git.historyLoading ? 'disabled' : '') + '>' + (state.git.historyLoading ? '加载中...' : '加载更多') + '</button></div>';
    } else {
        html += '<div class="file-browser-empty">已加载全部提交</div>';
    }
    bodyEl.innerHTML = html;
    bodyEl.querySelectorAll('.commit-item').forEach(function(btn) {
        btn.addEventListener('click', function() {
            toggleFileBrowserGitHistoryCommit(this.dataset.commitHash || '');
        });
    });
    bodyEl.querySelectorAll('.file-item').forEach(function(btn) {
        btn.addEventListener('click', function() {
            state.git.activeHistoryFileKey = this.dataset.historyFileKey || '';
            state.previewMode = 'git-history';
            state.selectedItem = null;
            renderFileBrowserSelection();
            renderGitHistoryFilePreview(this.dataset.commitHash || '', this.dataset.historyPath || '/');
            renderFileBrowserGitSection();
        });
    });
    var loadBtn = document.getElementById('btnFileBrowserLoadGitHistory');
    if (loadBtn) {
        loadBtn.addEventListener('click', function() {
            loadFileBrowserGitHistory(true);
        });
    }
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
    var gitPanel = document.getElementById('fileBrowserGitPanel');
    if (gitPanel) {
        gitPanel.querySelectorAll('.file-browser-git-item').forEach(function(node) {
            node.classList.remove('active');
        });
    }
}

function toggleFileBrowserGitCurrentSection() {
    window.fileBrowserState.git.currentExpanded = !window.fileBrowserState.git.currentExpanded;
    renderFileBrowserGitSection();
}

function toggleFileBrowserGitHistorySection() {
    var state = window.fileBrowserState;
    state.git.historyExpanded = !state.git.historyExpanded;
    renderFileBrowserGitSection();
    if (state.git.historyExpanded && !state.git.historyItems.length && !state.git.historyLoading) {
        loadFileBrowserGitHistory(false);
    }
}

async function toggleFileBrowserGitHistoryCommit(commitHash) {
    var state = window.fileBrowserState;
    if (!commitHash) return;
    if (state.git.expandedCommitHash === commitHash) {
        state.git.expandedCommitHash = '';
        renderFileBrowserGitSection();
        return;
    }
    state.git.expandedCommitHash = commitHash;
    var item = state.git.historyItems.find(function(entry) { return entry.hash === commitHash; });
    if (!item) {
        renderFileBrowserGitSection();
        return;
    }
    if (item.filesLoaded || item.loadingFiles) {
        renderFileBrowserGitSection();
        return;
    }
    item.loadingFiles = true;
    renderFileBrowserGitSection();
    try {
        var data = await fileBrowserApiGitHistoryFiles(state.rootDir, commitHash);
        item.files = data.files || [];
        item.filesLoaded = true;
    } catch (err) {
        item.files = [];
        item.filesLoaded = true;
        state.git.message = err.message || String(err);
    } finally {
        item.loadingFiles = false;
        renderFileBrowserGitSection();
    }
}

function switchFileBrowserMode(mode) {
    var state = window.fileBrowserState;
    state.mode = mode === 'git' ? 'git' : 'files';
    renderFileBrowserMode();
}

function renderFileBrowserMode() {
    var state = window.fileBrowserState;
    var filesBtn = document.getElementById('btnFileBrowserModeFiles');
    var gitBtn = document.getElementById('btnFileBrowserModeGit');
    var filesPanel = document.getElementById('fileBrowserFilesPanel');
    var gitPanel = document.getElementById('fileBrowserGitPanel');
    if (filesBtn) filesBtn.classList.toggle('active', state.mode === 'files');
    if (gitBtn) gitBtn.classList.toggle('active', state.mode === 'git');
    if (filesPanel) filesPanel.style.display = state.mode === 'files' ? 'flex' : 'none';
    if (gitPanel) gitPanel.style.display = state.mode === 'git' ? 'flex' : 'none';
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
    if (state.mode === 'git' && state.git.historyExpanded) {
        loadFileBrowserGitHistory(false);
    }
}
