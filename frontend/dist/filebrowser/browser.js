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
    previewReadResult: null,
    previewRenderMode: 'preview',
    previewEditorValue: '',
    previewOriginalContent: '',
    previewEditorInstance: null,
    previewSearchSyncTimer: null,
    savingPreview: false,
    loadingList: false,
    loadingPreview: false,
    previewMode: 'file',
    forcedTextPreview: {},
    uploading: false,
    uploadError: '',
    uploadConflict: false,
    uploadConflictName: '',
    pendingUploadFile: null,
    pendingUploadBase64: '',
    pendingUploadFileName: '',
    previewDownloadPath: '',
    previewDownloadName: '',
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

async function fileBrowserApiList(rootDir, path) {
    return await api.ListBrowserFiles(rootDir, path);
}

async function fileBrowserApiGitStatus(rootDir) {
    return await api.GetGitStatus(rootDir);
}

async function fileBrowserApiGitHistory(rootDir, offset, limit) {
    return await api.GetGitHistory(rootDir, offset, limit);
}

async function fileBrowserApiGitHistoryFiles(rootDir, commitHash) {
    return await api.GetGitHistoryFiles(rootDir, commitHash);
}

async function fileBrowserApiStageFile(rootDir, path) {
    return await api.StageFile(rootDir, path);
}

async function fileBrowserApiUnstageFile(rootDir, path) {
    return await api.UnstageFile(rootDir, path);
}

async function fileBrowserApiStageAll(rootDir) {
    return await api.StageAllFiles(rootDir);
}

async function fileBrowserApiGitCommit(rootDir, message) {
    return await api.GitCommit(rootDir, message);
}

function fileBrowserGetProxy() {
    var enabled = document.getElementById('proxyEnabled');
    var host = document.getElementById('proxyHost');
    var port = document.getElementById('proxyPort');
    return {
        proxyEnabled: !!(enabled && enabled.checked),
        proxyHost: host ? host.value : '',
        proxyPort: port ? port.value : ''
    };
}

async function fileBrowserApiGitPush(rootDir) {
    return await api.GitPush(rootDir, fileBrowserGetProxy());
}

async function fileBrowserApiGitPull(rootDir) {
    return await api.GitPull(rootDir, fileBrowserGetProxy());
}

async function fileBrowserApiDiscardFile(rootDir, path) {
    return await api.DiscardFile(rootDir, path);
}

async function fileBrowserApiUpload(rootDir, path, fileName, base64Data, overwrite) {
    return await api.UploadBrowserFile(rootDir, path, fileName, base64Data, overwrite);
}

async function fileBrowserApiCreateDir(rootDir, path, dirName) {
    return await api.CreateBrowserDir(rootDir, path, dirName);
}

async function fileBrowserApiDelete(rootDir, path) {
    return await api.DeleteBrowserEntry(rootDir, path);
}

async function fileBrowserApiSave(rootDir, path, content) {
    return await api.SaveBrowserFile(rootDir, path, content);
}

function setFileBrowserDownloadTarget(path, name) {
    var btn = document.getElementById('btnFileBrowserDownload');
    window.fileBrowserState.previewDownloadPath = path || '';
    window.fileBrowserState.previewDownloadName = name || '';
    if (!btn) return;
    btn.style.display = path ? 'inline-flex' : 'none';
    btn.disabled = !path;
}

function fileToBase64(file) {
    return new Promise(function(resolve, reject) {
        var reader = new FileReader();
        reader.onload = function() {
            var result = String(reader.result || '');
            var comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = function() {
            reject(new Error('读取文件失败'));
        };
        reader.readAsDataURL(file);
    });
}

function openFileBrowserUploadPicker() {
    var input = document.getElementById('fileBrowserUploadInput');
    if (input) input.click();
}

function setFileBrowserCreateDirLoading(loading) {
    var btn = document.getElementById('btnFileBrowserCreateDir');
    var confirmBtn = document.getElementById('btnFileBrowserCreateDirConfirm');
    var cancelBtn = document.getElementById('btnFileBrowserCreateDirCancel');
    var input = document.getElementById('fileBrowserCreateDirInput');
    if (btn) btn.disabled = !!loading;
    if (confirmBtn) confirmBtn.disabled = !!loading;
    if (cancelBtn) cancelBtn.disabled = !!loading;
    if (input) input.disabled = !!loading;
}

function closeFileBrowserCreateDirInline() {
    var wrap = document.getElementById('fileBrowserCreateDirInline');
    var input = document.getElementById('fileBrowserCreateDirInput');
    setFileBrowserCreateDirLoading(false);
    if (input) input.value = '';
    if (wrap) wrap.style.display = 'none';
}

function openFileBrowserCreateDirInline() {
    var wrap = document.getElementById('fileBrowserCreateDirInline');
    var input = document.getElementById('fileBrowserCreateDirInput');
    if (wrap) wrap.style.display = 'flex';
    if (input) {
        input.value = '';
        input.focus();
        input.select();
    }
}

async function submitFileBrowserCreateDir() {
    var state = window.fileBrowserState;
    var input = document.getElementById('fileBrowserCreateDirInput');
    var dirName = input ? String(input.value || '').trim() : '';
    if (!dirName) {
        showToast('请输入文件夹名称', 'error');
        if (input) input.focus();
        return;
    }
    setFileBrowserCreateDirLoading(true);
    try {
        var result = await fileBrowserApiCreateDir(state.rootDir, state.currentPath || '/', dirName);
        if (!result.success) {
            showToast(result.error || '创建文件夹失败', 'error');
            if (input) input.focus();
            return;
        }
        closeFileBrowserCreateDirInline();
        showToast('已创建文件夹：' + dirName, 'success');
        await loadFileBrowserList(state.currentPath || '/');
    } catch (err) {
        showToast(err.message || '创建文件夹失败', 'error');
    } finally {
        setFileBrowserCreateDirLoading(false);
    }
}

function closeFileBrowserUploadConflictModal() {
    var modal = document.getElementById('fileBrowserUploadConflictModal');
    var field = document.getElementById('fileBrowserUploadRenameField');
    var input = document.getElementById('fileBrowserUploadRenameInput');
    var error = document.getElementById('fileBrowserUploadConflictError');
    var confirmBtn = document.getElementById('btnFileBrowserUploadRenameConfirm');
    if (modal) modal.style.display = 'none';
    if (field) field.style.display = 'none';
    if (input) input.value = '';
    if (error) error.textContent = '';
    if (confirmBtn) confirmBtn.style.display = 'none';
}

function openFileBrowserUploadConflictModal(name) {
    var modal = document.getElementById('fileBrowserUploadConflictModal');
    var nameEl = document.getElementById('fileBrowserUploadConflictName');
    var input = document.getElementById('fileBrowserUploadRenameInput');
    var field = document.getElementById('fileBrowserUploadRenameField');
    var error = document.getElementById('fileBrowserUploadConflictError');
    var confirmBtn = document.getElementById('btnFileBrowserUploadRenameConfirm');
    if (nameEl) nameEl.textContent = name;
    if (input) input.value = name;
    if (field) field.style.display = 'none';
    if (error) error.textContent = '';
    if (confirmBtn) confirmBtn.style.display = 'none';
    if (modal) modal.style.display = 'flex';
}

function showFileBrowserRenameMode() {
    var field = document.getElementById('fileBrowserUploadRenameField');
    var confirmBtn = document.getElementById('btnFileBrowserUploadRenameConfirm');
    if (field) field.style.display = 'block';
    if (confirmBtn) confirmBtn.style.display = 'inline-flex';
}

async function submitBrowserUpload(fileName, overwrite) {
    var state = window.fileBrowserState;
    var result = await fileBrowserApiUpload(state.rootDir, state.currentPath || '/', fileName, state.pendingUploadBase64 || '', overwrite);
    if (result.success) {
        closeFileBrowserUploadConflictModal();
        state.pendingUploadFileName = '';
        state.pendingUploadBase64 = '';
        showToast('上传成功', 'success');
        await loadFileBrowserList(state.currentPath || '/');
        return;
    }
    if (result.conflict) {
        var error = document.getElementById('fileBrowserUploadConflictError');
        if (error) error.textContent = '文件名已存在，请重新输入';
        return;
    }
    throw new Error(result.error || '上传失败');
}

async function handleBrowserUploadSelected(file) {
    if (!file) return;
    var state = window.fileBrowserState;
    state.pendingUploadFileName = file.name || '';
    state.pendingUploadBase64 = await fileToBase64(file);
    try {
        var result = await fileBrowserApiUpload(state.rootDir, state.currentPath || '/', state.pendingUploadFileName, state.pendingUploadBase64, false);
        if (result.success) {
            state.pendingUploadFileName = '';
            state.pendingUploadBase64 = '';
            showToast('上传成功', 'success');
            await loadFileBrowserList(state.currentPath || '/');
            return;
        }
        if (result.conflict) {
            openFileBrowserUploadConflictModal(state.pendingUploadFileName);
            return;
        }
        showToast(result.error || '上传失败', 'error');
    } catch (err) {
        showToast(err.message || '上传失败', 'error');
    }
}

async function fileBrowserConfirmDelete(item) {
    var name = item && item.name ? item.name : '该条目';
    var typeLabel = item && item.type === 'dir' ? '文件夹' : '文件';
    var message = '确定删除' + typeLabel + '「' + name + '」吗？';
    if (window.runtime && api.ShowConfirmDialog) {
        return await api.ShowConfirmDialog('删除确认', message);
    }
    return confirm(message);
}

async function deleteBrowserItem(item) {
    var state = window.fileBrowserState;
    if (!item || !state.rootDir) return;
    var confirmed = await fileBrowserConfirmDelete(item);
    if (!confirmed) return;
    try {
        var result = await fileBrowserApiDelete(state.rootDir, item.path);
        if (!result.success) {
            showToast(result.error || '删除失败', 'error');
            return;
        }
        if (state.selectedItem && state.selectedItem.path === item.path) {
            state.selectedItem = null;
            clearFileBrowserPreview();
        }
        showToast('已删除' + (item.type === 'dir' ? '文件夹' : '文件') + '：' + item.name, 'success');
        await loadFileBrowserList(state.currentPath || '/');
    } catch (err) {
        showToast(err.message || '删除失败', 'error');
    }
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

    // 统一封装鼠标/触摸拖拽，保证移动端也能拖动目录宽度。
    function startDrag(clientX) {
        var startX = clientX;
        var startWidth = parseInt(getComputedStyle(body).getPropertyValue('--file-browser-left-width')) || 320;
        handle.classList.add('dragging');

        function onMove(ev) {
            if (ev.touches) ev.preventDefault();
            var x = ev.touches ? ev.touches[0].clientX : ev.clientX;
            var newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + (x - startX)));
            body.style.setProperty('--file-browser-left-width', newWidth + 'px');
        }

        function onUp() {
            handle.classList.remove('dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
            var finalWidth = parseInt(getComputedStyle(body).getPropertyValue('--file-browser-left-width')) || 320;
            localStorage.setItem(STORAGE_KEY, finalWidth);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    }

    handle.addEventListener('mousedown', function(e) {
        e.preventDefault();
        startDrag(e.clientX);
    });

    handle.addEventListener('touchstart', function(e) {
        e.preventDefault();
        startDrag(e.touches[0].clientX);
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

    // 统一封装鼠标/触摸拖拽，保证移动端也能调整 Git 历史区域高度。
    function startDrag() {
        handle.classList.add('dragging');

        function onMove(ev) {
            if (ev.touches) ev.preventDefault();
            var rect = panel.getBoundingClientRect();
            if (rect.height === 0) return;
            var y = ev.touches ? ev.touches[0].clientY : ev.clientY;
            var pct = Math.max(MIN_PCT, Math.min(MAX_PCT, ((y - rect.top) / rect.height) * 100));
            panel.style.setProperty('--git-current-pct', pct + '%');
            panel.style.setProperty('--git-history-pct', (100 - pct) + '%');
        }

        function onUp() {
            handle.classList.remove('dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
            var finalPct = parseInt(panel.style.getPropertyValue('--git-current-pct')) || DEFAULT_PCT;
            localStorage.setItem(STORAGE_KEY, finalPct);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    }

    handle.addEventListener('mousedown', function(e) {
        e.preventDefault();
        startDrag();
    });

    handle.addEventListener('touchstart', function(e) {
        e.preventDefault();
        startDrag();
    });
})();

async function gitPush() {
    var state = window.fileBrowserState;
    if (!state.rootDir) return;
    var btn = document.getElementById('btnFileBrowserGitPush');
    setGitRemoteActionLoading('push', true);
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
    setGitRemoteActionLoading('push', false);
}

async function gitPull() {
    var state = window.fileBrowserState;
    if (!state.rootDir) return;
    setGitRemoteActionLoading('pull', true);
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
    setGitRemoteActionLoading('pull', false);
}

function setGitRemoteActionLoading(action, loading) {
    var pullBtn = document.getElementById('btnFileBrowserGitPull');
    var pushBtn = document.getElementById('btnFileBrowserGitPush');
    if (pullBtn) {
        pullBtn.disabled = !!loading;
        pullBtn.innerHTML = action === 'pull' && loading
            ? '<span class="file-browser-git-btn-spinner"></span><span>拉取中...</span>'
            : '⬇ 拉取';
    }
    if (pushBtn) {
        pushBtn.disabled = !!loading;
        pushBtn.innerHTML = action === 'push' && loading
            ? '<span class="file-browser-git-btn-spinner"></span><span>推送中...</span>'
            : '⬆ 推送';
    }
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

(function initFileBrowserGitActions() {
    var pushBtn = document.getElementById('btnFileBrowserGitPush');
    if (pushBtn && !pushBtn.dataset.bound) {
        pushBtn.dataset.bound = 'true';
        pushBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            gitPush();
        });
    }
    var pullBtn = document.getElementById('btnFileBrowserGitPull');
    if (pullBtn && !pullBtn.dataset.bound) {
        pullBtn.dataset.bound = 'true';
        pullBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            gitPull();
        });
    }
})();

function gitStatusClass(code) {
    var c = String(code || '').trim();
    if (c === '??') return 'untracked';
    if (c.indexOf('R') >= 0) return 'rename';
    if (c.indexOf('D') >= 0) return 'delete';
    if (c.indexOf('A') >= 0) return 'add';
    return 'modify';
}

function openFileBrowserModal(rootDir, options) {
    var modal = document.getElementById('fileBrowserModal');
    var title = document.getElementById('fileBrowserTitle');
    if (!modal) return;
    var features = (options && Array.isArray(options.features)) ? options.features : [];
    var hasExtraFeatures = features.length > 0;
    window.fileBrowserState.mode = 'files';
    window.fileBrowserState.rootDir = rootDir || '';
    window.fileBrowserState.features = features;
    window.fileBrowserState.currentPath = '/';
    window.fileBrowserState.parentPath = '/';
    window.fileBrowserState.selectedItem = null;
    window.fileBrowserState.previewMode = 'file';
    window.fileBrowserState.previewRenderMode = 'preview';
    window.fileBrowserState.previewEditorValue = '';
    window.fileBrowserState.previewOriginalContent = '';
    window.fileBrowserState.previewEditorInstance = null;
    window.fileBrowserState.previewSearchSyncTimer = null;
    window.fileBrowserState.previewReadResult = null;
    window.fileBrowserState.savingPreview = false;
    window.fileBrowserState.forcedTextPreview = {};
    window.fileBrowserState.previewDownloadPath = '';
    window.fileBrowserState.previewDownloadName = '';
    window.fileBrowserState.pendingUploadFileName = '';
    window.fileBrowserState.pendingUploadBase64 = '';
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
    if (hasExtraFeatures) {
        modal.classList.remove('file-browser-compact');
    } else {
        modal.classList.add('file-browser-compact');
    }
    modal.style.display = 'flex';
    renderFileBrowserMode();
    loadFileBrowserList('/');
}

function closeFileBrowserModal() {
    var modal = document.getElementById('fileBrowserModal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('file-browser-compact');
    }
    if (typeof fileBrowserClearObjectURL === 'function') fileBrowserClearObjectURL();
    if (typeof destroyFileBrowserEditor === 'function') destroyFileBrowserEditor();
    closeFileBrowserCreateDirInline();
    clearFileBrowserPreview();
}

function clearFileBrowserPreview() {
    var titleEl = document.getElementById('filePreviewTitle');
    var metaEl = document.getElementById('filePreviewMeta');
    var bodyEl = document.getElementById('filePreviewBody');
    var downloadBtn = document.getElementById('btnFileBrowserDownload');
    if (titleEl) titleEl.textContent = '请选择文件';
    if (metaEl) metaEl.textContent = '';
    if (bodyEl) bodyEl.innerHTML = '<div class="file-browser-empty">请选择左侧文件进行预览</div>';
    if (typeof destroyFileBrowserEditor === 'function') destroyFileBrowserEditor();
    window.fileBrowserState.previewMeta = null;
    window.fileBrowserState.previewContent = null;
    window.fileBrowserState.previewReadResult = null;
    window.fileBrowserState.previewRenderMode = 'preview';
    window.fileBrowserState.previewEditorValue = '';
    window.fileBrowserState.previewOriginalContent = '';
    window.fileBrowserState.previewEditorInstance = null;
    window.fileBrowserState.previewSearchSyncTimer = null;
    window.fileBrowserState.savingPreview = false;
    window.fileBrowserState.previewDownloadPath = '';
    window.fileBrowserState.previewDownloadName = '';
    if (downloadBtn) {
        downloadBtn.style.display = 'none';
        downloadBtn.disabled = true;
    }
    if (typeof renderFilePreviewToolbar === 'function') renderFilePreviewToolbar();
}

async function downloadCurrentFilePreview() {
    var state = window.fileBrowserState;
    if (!state.rootDir || !state.previewDownloadPath) return;
    try {
        var rawRes = await fileBrowserResolveRawResource(state.rootDir, state.previewDownloadPath);
        var link = document.createElement('a');
        link.href = rawRes.url;
        link.download = state.previewDownloadName || rawRes.name || 'download';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch (err) {
        showToast(err.message || '下载失败', 'error');
    }
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
    closeFileBrowserCreateDirInline();
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
        return '<div class="file-browser-item-row">' +
            '<button type="button" class="file-browser-item ' + (item.type === 'dir' ? 'dir' : 'file') + '" data-path="' + escapeHtml(item.path) + '" data-type="' + escapeHtml(item.type) + '">' +
                '<span class="file-browser-item-icon">' + icon + '</span>' +
                '<span class="file-browser-item-name">' + escapeHtml(item.name) + '</span>' +
            '</button>' +
            '<button type="button" class="file-browser-item-delete" data-delete-path="' + escapeHtml(item.path) + '" title="删除">✕</button>' +
        '</div>';
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
    listEl.querySelectorAll('.file-browser-item-delete').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var path = this.dataset.deletePath || '/';
            var item = state.items.find(function(entry) { return entry.path === path; }) || null;
            deleteBrowserItem(item);
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
    if (mode === 'git' && (!state.features || state.features.indexOf('git') < 0)) return;
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
    var hasGit = state.features && state.features.indexOf('git') >= 0;
    if (filesBtn) filesBtn.classList.toggle('active', state.mode === 'files');
    if (gitBtn) {
        gitBtn.style.display = hasGit ? '' : 'none';
        gitBtn.classList.toggle('active', state.mode === 'git');
    }
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

(function initFileBrowserActions() {
    var closeBtn = document.getElementById('btnCloseFileBrowser');
    if (closeBtn && !closeBtn.dataset.bound) {
        closeBtn.dataset.bound = 'true';
        closeBtn.addEventListener('click', closeFileBrowserModal);
    }

    var refreshBtn = document.getElementById('btnRefreshFiles');
    if (refreshBtn && !refreshBtn.dataset.bound) {
        refreshBtn.dataset.bound = 'true';
        refreshBtn.addEventListener('click', refreshFileBrowser);
    }

    var upBtn = document.getElementById('btnFileBrowserUp');
    if (upBtn && !upBtn.dataset.bound) {
        upBtn.dataset.bound = 'true';
        upBtn.addEventListener('click', goFileBrowserUp);
    }

    var downloadBtn = document.getElementById('btnFileBrowserDownload');
    if (downloadBtn && !downloadBtn.dataset.bound) {
        downloadBtn.dataset.bound = 'true';
        downloadBtn.addEventListener('click', downloadCurrentFilePreview);
    }

    var filesModeBtn = document.getElementById('btnFileBrowserModeFiles');
    if (filesModeBtn && !filesModeBtn.dataset.bound) {
        filesModeBtn.dataset.bound = 'true';
        filesModeBtn.addEventListener('click', function() {
            switchFileBrowserMode('files');
        });
    }

    var gitModeBtn = document.getElementById('btnFileBrowserModeGit');
    if (gitModeBtn && !gitModeBtn.dataset.bound) {
        gitModeBtn.dataset.bound = 'true';
        gitModeBtn.addEventListener('click', function() {
            switchFileBrowserMode('git');
        });
    }

    var uploadBtn = document.getElementById('btnFileBrowserUpload');
    if (uploadBtn && !uploadBtn.dataset.bound) {
        uploadBtn.dataset.bound = 'true';
        uploadBtn.addEventListener('click', openFileBrowserUploadPicker);
    }

    var createDirBtn = document.getElementById('btnFileBrowserCreateDir');
    if (createDirBtn && !createDirBtn.dataset.bound) {
        createDirBtn.dataset.bound = 'true';
        createDirBtn.addEventListener('click', function() {
            openFileBrowserCreateDirInline();
        });
    }

    var createDirConfirmBtn = document.getElementById('btnFileBrowserCreateDirConfirm');
    if (createDirConfirmBtn && !createDirConfirmBtn.dataset.bound) {
        createDirConfirmBtn.dataset.bound = 'true';
        createDirConfirmBtn.addEventListener('click', function() {
            submitFileBrowserCreateDir();
        });
    }

    var createDirCancelBtn = document.getElementById('btnFileBrowserCreateDirCancel');
    if (createDirCancelBtn && !createDirCancelBtn.dataset.bound) {
        createDirCancelBtn.dataset.bound = 'true';
        createDirCancelBtn.addEventListener('click', function() {
            closeFileBrowserCreateDirInline();
        });
    }

    var createDirInput = document.getElementById('fileBrowserCreateDirInput');
    if (createDirInput && !createDirInput.dataset.bound) {
        createDirInput.dataset.bound = 'true';
        createDirInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitFileBrowserCreateDir();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                closeFileBrowserCreateDirInline();
            }
        });
    }

    var uploadInput = document.getElementById('fileBrowserUploadInput');
    if (uploadInput && !uploadInput.dataset.bound) {
        uploadInput.dataset.bound = 'true';
        uploadInput.addEventListener('change', function() {
            var file = this.files && this.files[0] ? this.files[0] : null;
            handleBrowserUploadSelected(file).finally(function() {
                uploadInput.value = '';
            });
        });
    }

    var overwriteBtn = document.getElementById('btnFileBrowserUploadOverwrite');
    if (overwriteBtn && !overwriteBtn.dataset.bound) {
        overwriteBtn.dataset.bound = 'true';
        overwriteBtn.addEventListener('click', function() {
            submitBrowserUpload(window.fileBrowserState.pendingUploadFileName || '', true).catch(function(err) {
                showToast(err.message || '上传失败', 'error');
            });
        });
    }

    var renameModeBtn = document.getElementById('btnFileBrowserUploadRenameMode');
    if (renameModeBtn && !renameModeBtn.dataset.bound) {
        renameModeBtn.dataset.bound = 'true';
        renameModeBtn.addEventListener('click', showFileBrowserRenameMode);
    }

    var renameConfirmBtn = document.getElementById('btnFileBrowserUploadRenameConfirm');
    if (renameConfirmBtn && !renameConfirmBtn.dataset.bound) {
        renameConfirmBtn.dataset.bound = 'true';
        renameConfirmBtn.addEventListener('click', function() {
            var input = document.getElementById('fileBrowserUploadRenameInput');
            var name = input ? String(input.value || '').trim() : '';
            if (!name) {
                var error = document.getElementById('fileBrowserUploadConflictError');
                if (error) error.textContent = '请输入新的文件名';
                return;
            }
            submitBrowserUpload(name, false).catch(function(err) {
                showToast(err.message || '上传失败', 'error');
            });
        });
    }

    var uploadCancelBtn = document.getElementById('btnFileBrowserUploadConflictCancel');
    if (uploadCancelBtn && !uploadCancelBtn.dataset.bound) {
        uploadCancelBtn.dataset.bound = 'true';
        uploadCancelBtn.addEventListener('click', closeFileBrowserUploadConflictModal);
    }
})();
