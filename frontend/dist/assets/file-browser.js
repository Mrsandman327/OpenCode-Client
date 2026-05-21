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
        commitMessage: '',
        commitSubmitting: false,
        gitActionError: '',
        stageLoadingPath: '',
        unstageLoadingPath: '',
        stageAllLoading: false,
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

async function fileBrowserApiStageFile(rootDir, path) {
    if (fileBrowserUseWails()) {
        return await api.StageFile(rootDir, path);
    }
    var resp = await fetch('/api/git/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootDir: rootDir || '', path: path || '' })
    });
    if (!resp.ok) throw new Error('暂存文件失败');
    return await resp.json();
}

async function fileBrowserApiUnstageFile(rootDir, path) {
    if (fileBrowserUseWails()) {
        return await api.UnstageFile(rootDir, path);
    }
    var resp = await fetch('/api/git/unstage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootDir: rootDir || '', path: path || '' })
    });
    if (!resp.ok) throw new Error('取消暂存失败');
    return await resp.json();
}

async function fileBrowserApiStageAll(rootDir) {
    if (fileBrowserUseWails()) {
        return await api.StageAllFiles(rootDir);
    }
    var resp = await fetch('/api/git/stage-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootDir: rootDir || '' })
    });
    if (!resp.ok) throw new Error('全部暂存失败');
    return await resp.json();
}

async function fileBrowserApiGitCommit(rootDir, message) {
    if (fileBrowserUseWails()) {
        return await api.GitCommit(rootDir, message);
    }
    var resp = await fetch('/api/git/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootDir: rootDir || '', message: message || '' })
    });
    if (!resp.ok) throw new Error('提交失败');
    return await resp.json();
}

async function fileBrowserApiGitPush(rootDir) {
    if (fileBrowserUseWails()) {
        return await api.GitPush(rootDir);
    }
    var resp = await fetch('/api/git/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootDir: rootDir || '' })
    });
    if (!resp.ok) throw new Error('推送失败');
    return await resp.json();
}

async function fileBrowserApiGitPull(rootDir) {
    if (fileBrowserUseWails()) {
        return await api.GitPull(rootDir);
    }
    var resp = await fetch('/api/git/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootDir: rootDir || '' })
    });
    if (!resp.ok) throw new Error('拉取失败');
    return await resp.json();
}

async function fileBrowserApiDiscardFile(rootDir, path) {
    if (fileBrowserUseWails()) {
        return await api.DiscardFile(rootDir, path);
    }
    var resp = await fetch('/api/git/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootDir: rootDir || '', path: path || '' })
    });
    if (!resp.ok) throw new Error('撤销失败');
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

(function initFileBrowserGitResize() {
    var handle = document.getElementById('fileBrowserGitResizeHandle');
    var panel = document.getElementById('fileBrowserGitPanel');
    if (!handle || !panel || handle.dataset.bound) return;
    handle.dataset.bound = 'true';
    var STORAGE_KEY = 'fileBrowserGitPct';
    var DEFAULT_PCT = 60;
    var MIN_PCT = 20;
    var MAX_PCT = 80;

    var saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
    var initPct = (saved >= MIN_PCT && saved <= MAX_PCT) ? saved : DEFAULT_PCT;
    panel.style.setProperty('--git-current-pct', initPct + '%');
    panel.style.setProperty('--git-history-pct', (100 - initPct) + '%');

    handle.addEventListener('mousedown', function(e) {
        e.preventDefault();
        handle.classList.add('dragging');

        function onMove(ev) {
            var rect = panel.getBoundingClientRect();
            if (rect.height === 0) return;
            var pct = Math.max(MIN_PCT, Math.min(MAX_PCT, ((ev.clientY - rect.top) / rect.height) * 100));
            panel.style.setProperty('--git-current-pct', pct + '%');
            panel.style.setProperty('--git-history-pct', (100 - pct) + '%');
        }

        function onUp() {
            handle.classList.remove('dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            var finalPct = parseInt(panel.style.getPropertyValue('--git-current-pct')) || DEFAULT_PCT;
            localStorage.setItem(STORAGE_KEY, finalPct);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
})();

async function gitPush() {
    var state = window.fileBrowserState;
    if (!state.rootDir) return;
    var btn = document.getElementById('btnFileBrowserGitPush');
    if (btn) btn.disabled = true;
    try {
        var result = await fileBrowserApiGitPush(state.rootDir);
        if (result.success) {
            showToast('推送成功', 'success');
            await loadFileBrowserGitHistory(false);
        } else {
            showToast(result.message || '推送失败', 'error');
        }
    } catch (err) {
        showToast(err.message || '推送失败', 'error');
    }
    if (btn) btn.disabled = false;
}

async function gitPull() {
    var state = window.fileBrowserState;
    if (!state.rootDir) return;
    var btn = document.getElementById('btnFileBrowserGitPull');
    if (btn) btn.disabled = true;
    try {
        var result = await fileBrowserApiGitPull(state.rootDir);
        if (result.success) {
            showToast('拉取成功', 'success');
            await loadFileBrowserGitHistory(false);
        } else {
            showToast(result.message || '拉取失败', 'error');
        }
    } catch (err) {
        showToast(err.message || '拉取失败', 'error');
    }
    if (btn) btn.disabled = false;
}

async function discardFile(path) {
    var state = window.fileBrowserState;
    if (!state.rootDir || !path) return;
    state.git.gitActionError = '';
    try {
        var result = await fileBrowserApiDiscardFile(state.rootDir, path);
        if (result.success) {
            showToast('已撤销变更', 'success');
        } else {
            showToast(result.message || '撤销失败', 'error');
        }
    } catch (err) {
        showToast(err.message || '撤销失败', 'error');
    }
    await loadFileBrowserGitStatus();
}

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
        commitMessage: '',
        commitSubmitting: false,
        gitActionError: '',
        stageLoadingPath: '',
        unstageLoadingPath: '',
        stageAllLoading: false,
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
                synced: item.synced,
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
    var historyBodyEl = document.getElementById('fileBrowserGitHistoryBody');
    var state = window.fileBrowserState;
    if (!currentBodyEl || !historyBodyEl) return;
    if (!state.git.isGitRepo) {
        currentBodyEl.innerHTML = '<div class="file-browser-empty">' + escapeHtml(state.git.message || '当前目录未启用 Git 版本管理') + '</div>';
        historyBodyEl.innerHTML = '<div class="file-browser-empty">当前目录未启用 Git 版本管理</div>';
        return;
    }
    var errorHtml = state.git.gitActionError ? '<div class="file-browser-git-action-error" style="padding:4px 8px">' + escapeHtml(state.git.gitActionError) + '</div>' : '';
    var staged = state.git.files.filter(function(item) { return !!item.hasStaged; });
    var unstaged = state.git.files.filter(function(item) { return !item.tracked || !!item.hasUnstaged; });
    currentBodyEl.innerHTML = errorHtml +
        '<div class="file-browser-git-commit-bar">' +
            '<textarea class="file-browser-git-commit-input" placeholder="输入提交信息" rows="2">' + escapeHtml(state.git.commitMessage || '') + '</textarea>' +
            '<button type="button" class="btn btn-sm file-browser-git-commit-btn"' + (state.git.commitSubmitting ? ' disabled' : '') + '>提交</button>' +
        '</div>' +
        renderFileBrowserGitGroup('已暂存', staged, 'staged') +
        renderFileBrowserGitGroup('未暂存', unstaged, 'unstaged');
    bindCurrentGitFileEvents(currentBodyEl);
    renderFileBrowserGitHistory(historyBodyEl);
}



function renderFileBrowserGitGroup(title, files, groupName) {
    var html = '<div class="file-browser-git-group">' +
        '<div class="file-browser-git-group-header">' +
            '<div class="file-browser-git-subtitle">' + escapeHtml(title) + '</div>' +
            (groupName === 'unstaged' ? '<button type="button" class="btn file-browser-git-stage-all" id="btnStageAll" ' + (files.length ? '' : 'disabled') + '>全部暂存</button>' : '') +
        '</div>';
    if (!files.length) {
        return html + '<div class="file-browser-empty">当前没有' + escapeHtml(title) + '文件</div></div>';
    }
    html += files.map(function(item) {
        var fullPath = item.path.replace(/^\//, '');
        var displayName = item.name || fullPath;
        var actionBtn = '';
        var discardBtn = '<button type="button" class="file-browser-git-action-btn file-browser-git-discard-btn" data-git-path="' + escapeHtml(item.path) + '" data-action="discard" title="撤销变更">↩</button>';
        if (groupName === 'unstaged') {
            actionBtn = '<button type="button" class="file-browser-git-action-btn" data-git-path="' + escapeHtml(item.path) + '" data-action="stage" title="加入暂存区" ' + (window.fileBrowserState.git.stageLoadingPath === item.path || window.fileBrowserState.git.stageAllLoading ? 'disabled' : '') + '>+</button>';
        } else if (groupName === 'staged') {
            actionBtn = '<button type="button" class="file-browser-git-action-btn" data-git-path="' + escapeHtml(item.path) + '" data-action="unstage" title="移出暂存区" ' + (window.fileBrowserState.git.unstageLoadingPath === item.path ? 'disabled' : '') + '>-</button>';
        }
        return '<div class="file-browser-git-item-row">' +
            '<button type="button" class="file-browser-git-item" data-git-path="' + escapeHtml(item.path) + '" data-git-group="' + escapeHtml(groupName) + '">' +
                '<span class="file-browser-git-status status-' + escapeHtml(gitStatusClass(item.statusCode || 'xx')) + '">' + escapeHtml(item.statusCode || '') + '</span>' +
                '<span class="file-browser-git-text" title="' + escapeHtml(fullPath) + '">' +
                    '<span class="file-browser-git-name">' + escapeHtml(displayName) + '</span>' +
                    '<span class="file-browser-git-path">' + escapeHtml(fullPath) + '</span>' +
                '</span>' +
            '</button>' +
            discardBtn +
            actionBtn +
        '</div>';
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

    bodyEl.querySelectorAll('.file-browser-git-action-btn[data-action="stage"]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            stageSingleFile(this.dataset.gitPath || '/');
        });
    });

    bodyEl.querySelectorAll('.file-browser-git-action-btn[data-action="unstage"]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            unstageSingleFile(this.dataset.gitPath || '/');
        });
    });

    bodyEl.querySelectorAll('.file-browser-git-discard-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            discardFile(this.dataset.gitPath || '/');
        });
    });

    var stageAllBtn = document.getElementById('btnStageAll');
    if (stageAllBtn) {
        stageAllBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            stageAllGitFiles();
        });
    }

    // 提交按钮
    var commitBtn = bodyEl.querySelector('.file-browser-git-commit-btn');
    if (commitBtn) {
        commitBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            gitCommit();
        });
    }

    // 提交输入框
    var commitInput = bodyEl.querySelector('.file-browser-git-commit-input');
    if (commitInput) {
        commitInput.addEventListener('input', function() {
            window.fileBrowserState.git.commitMessage = this.value || '';
            window.fileBrowserState.git.gitActionError = '';
        });
    }
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
        var syncedIcon = item.synced === false ? '<span class="file-browser-git-sync-icon" title="未同步到服务器">⬆</span>' : '';
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
                syncedIcon +
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
    var pushBtn = document.getElementById('btnFileBrowserGitPush');
    if (pushBtn) {
        pushBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            gitPush();
        });
    }
    var pullBtn = document.getElementById('btnFileBrowserGitPull');
    if (pullBtn) {
        pullBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            gitPull();
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

async function stageSingleFile(path) {
    var state = window.fileBrowserState;
    if (!state.rootDir || !path) return;
    state.git.stageLoadingPath = path;
    state.git.gitActionError = '';
    renderFileBrowserGitSection();
    try {
        var result = await fileBrowserApiStageFile(state.rootDir, path);
        if (!result.success) {
            state.git.gitActionError = result.message || '暂存失败';
        }
    } catch (err) {
        state.git.gitActionError = err.message || '暂存失败';
    }
    state.git.stageLoadingPath = '';
    await loadFileBrowserGitStatus();
}

async function unstageSingleFile(path) {
    var state = window.fileBrowserState;
    if (!state.rootDir || !path) return;
    state.git.unstageLoadingPath = path;
    state.git.gitActionError = '';
    renderFileBrowserGitSection();
    try {
        var result = await fileBrowserApiUnstageFile(state.rootDir, path);
        if (!result.success) {
            state.git.gitActionError = result.message || '取消暂存失败';
        }
    } catch (err) {
        state.git.gitActionError = err.message || '取消暂存失败';
    }
    state.git.unstageLoadingPath = '';
    await loadFileBrowserGitStatus();
}

async function stageAllGitFiles() {
    var state = window.fileBrowserState;
    if (!state.rootDir) return;
    state.git.stageAllLoading = true;
    state.git.gitActionError = '';
    renderFileBrowserGitSection();
    try {
        var result = await fileBrowserApiStageAll(state.rootDir);
        if (!result.success) {
            state.git.gitActionError = result.message || '全部暂存失败';
        }
    } catch (err) {
        state.git.gitActionError = err.message || '全部暂存失败';
    }
    state.git.stageAllLoading = false;
    await loadFileBrowserGitStatus();
}

async function gitCommit() {
    var state = window.fileBrowserState;
    if (!state.rootDir) return;
    var msg = (state.git.commitMessage || '').trim();
    if (!msg) {
        state.git.gitActionError = '请输入提交信息';
        renderFileBrowserGitSection();
        return;
    }
    var staged = state.git.files.filter(function(item) { return !!item.hasStaged; });
    if (!staged.length) {
        state.git.gitActionError = '没有可提交的更改';
        renderFileBrowserGitSection();
        return;
    }
    state.git.commitSubmitting = true;
    state.git.gitActionError = '';
    renderFileBrowserGitSection();
    try {
        var result = await fileBrowserApiGitCommit(state.rootDir, msg);
        if (!result.success) {
            state.git.gitActionError = result.message || '提交失败';
        } else {
            state.git.commitMessage = '';
            state.git.gitActionError = '';
            await loadFileBrowserGitStatus();
            await loadFileBrowserGitHistory(false);
        }
    } catch (err) {
        state.git.gitActionError = err.message || '提交失败';
    }
    state.git.commitSubmitting = false;
    renderFileBrowserGitSection();
}

function switchFileBrowserMode(mode) {
    var state = window.fileBrowserState;
    state.mode = mode === 'git' ? 'git' : 'files';
    renderFileBrowserMode();
    if (state.mode === 'git' && !state.git.historyItems.length && !state.git.historyLoading) {
        loadFileBrowserGitHistory(false);
    }
    var uPBtn = document.getElementById('btnFileBrowserUp');
    if (state.mode === 'files')
        uPBtn.style.display = ''
    else
        uPBtn.style.display = 'none'
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
    if (state.mode === 'git') {
        loadFileBrowserGitHistory(false);
    }
}
