// ============================================================
// 站内文件浏览器 - 目录浏览与状态管理
// 依赖：core/apicall.js(api)、core/utils.js(showToast/escapeHtml)、
//       preview.js(fileBrowserClearObjectURL/destroyFileBrowserEditor/renderFilePreviewToolbar，
//                  循环引用)
// ============================================================

import { api } from '../core/apicall.js';
import { store } from '../core/state.js';
import { showToast, escapeHtml, showApiError, isDesktopRuntime, copyToClipboard } from '../core/utils.js';
import { formatApiError } from '../core/v2compat.js';
import {
    fileBrowserClearObjectURL,
    destroyFileBrowserEditor,
    fileBrowserResolveRawResource,
    fileBrowserOpenFileTab,
    fileBrowserOpenGitTab,
    fileBrowserOpenGitHistoryTab,
    renderFileBrowserTabs,
    clearFileBrowserPreview,
    fileBrowserOpenFileAtLine
} from './preview.js';

store.fileBrowserState = {
    rootDir: '',
    mode: 'files',
    selectedItem: null,
    // 多文件 tab：已打开的文件列表（去重 by path）、各文件编辑缓存、活动 tab
    fileTabs: [],
    fileTabCache: {},
    activeFileTabPath: '',
    // 文件树相关状态
    rootNode: null,
    selectedPath: '',
    previewMeta: null,
    previewReadResult: null,
    previewRenderMode: 'preview',
    // 异步预览请求序号：只允许最后一次文件预览更新界面，避免快速切换时串写。
    previewRequestSeq: 0,
    previewEditorValue: '',
    previewOriginalContent: '',
    previewEditorInstance: null,
    previewDiffInstance: null,
    gitPreviewPath: '',
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
        // 变更树折叠状态：key = 组名 + '|' + 目录路径，值为 true 表示已折叠
        collapsedDirs: {},
    },
};

export async function fileBrowserApiList(rootDir, path) {
    return await api.ListBrowserFiles(rootDir, path);
}

export async function fileBrowserApiGitStatus(rootDir) {
    return await api.GetGitStatus(rootDir);
}

export async function fileBrowserApiGitHistory(rootDir, offset, limit) {
    return await api.GetGitHistory(rootDir, offset, limit);
}

export async function fileBrowserApiGitHistoryFiles(rootDir, commitHash) {
    return await api.GetGitHistoryFiles(rootDir, commitHash);
}

export async function fileBrowserApiStageFile(rootDir, path) {
    return await api.StageFile(rootDir, path);
}

export async function fileBrowserApiUnstageFile(rootDir, path) {
    return await api.UnstageFile(rootDir, path);
}

export async function fileBrowserApiStageAll(rootDir) {
    return await api.StageAllFiles(rootDir);
}

export async function fileBrowserApiGitCommit(rootDir, message) {
    return await api.GitCommit(rootDir, message);
}

export function fileBrowserGetProxy() {
    var enabled = document.getElementById('proxyEnabled');
    var host = document.getElementById('proxyHost');
    var port = document.getElementById('proxyPort');
    return {
        proxyEnabled: !!(enabled && enabled.checked),
        proxyHost: host ? host.value : '',
        proxyPort: port ? port.value : ''
    };
}

// ======== 文件树：TreeNode 结构 ========
// 节点字段: { title, path, type, children, expanded, loaded }

/** 将后端文件项转为树节点 */
export function createTreeNode(item) {
    // 后端目录的 path 以 / 结尾（如 /src/），统一去掉尾斜杠：
    // 保证「删除/重命名后计算父目录路径」与「树内 findNodeByPath 查找」一致（根目录保持 "/"）。
    var p = String(item.path || '/');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return {
        title: item.name || '',
        path: p || '/',
        type: (item.type === 'dir') ? 'dir' : 'file',
        children: [],
        expanded: false,
        loaded: (item.type !== 'dir') // 文件节点天生就是已加载
    };
}

/** 在树中按 path 查找节点 */
export function findNodeByPath(node, path) {
    if (!node) return null;
    if (node.path === path) return node;
    for (var i = 0; i < (node.children || []).length; i++) {
        var found = findNodeByPath(node.children[i], path);
        if (found) return found;
    }
    return null;
}

/** 由节点路径计算父目录路径：结果以 / 开头且无尾斜杠，根目录的父级仍返回 "/"。
 *  说明：兼容带尾斜杠的输入（目录节点的后端原始格式），避免 substring 误算。 */
function fileBrowserParentPath(p) {
    var clean = String(p || '').replace(/\/+$/, '');
    var idx = clean.lastIndexOf('/');
    return idx <= 0 ? '/' : clean.substring(0, idx);
}

/** 加载目录节点的 children（懒加载） */
export async function loadDirChildren(node) {
    var state = store.fileBrowserState;
    if (!node || node.type !== 'dir' || node.loaded) return;
    try {
        var data = await fileBrowserApiList(state.rootDir, node.path);
        var items = data.items || [];
        node.children = items.map(function(item) {
            return createTreeNode(item);
        });
        node.loaded = true;
    } catch (err) {
        showApiError('加载目录失败: ', err);
    }
}

/** 根据 path 查找节点并重新加载其 children */
export async function reloadDirChildren(dirPath) {
    var state = store.fileBrowserState;
    var node = findNodeByPath(state.rootNode, dirPath);
    if (node && node.type === 'dir') {
        node.loaded = false;
        node.children = [];
        await loadDirChildren(node);
    }
}

/** 递归渲染文件树 */
export function renderFileTree(rootNode) {
    var listEl = document.getElementById('fileBrowserList');
    var emptyEl = document.getElementById('fileBrowserListEmpty');
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!rootNode || !rootNode.children.length) {
        if (emptyEl) {
            emptyEl.textContent = '当前目录为空';
            emptyEl.style.display = 'block';
        }
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    renderTreeChildren(rootNode.children, listEl, 0);
    bindFileTreeEvents(listEl);
}

/** 递归渲染树节点的 children */
export function renderTreeChildren(children, container, depth) {
    for (var i = 0; i < children.length; i++) {
        var node = children[i];
        var row = createTreeNodeRow(node, depth);
        container.appendChild(row);
        if (node.type === 'dir' && node.expanded && node.children.length) {
            renderTreeChildren(node.children, container, depth + 1);
        }
    }
}

/** 创建单个树节点 DOM 行 */
export function createTreeNodeRow(node, depth) {
    var state = store.fileBrowserState;
    var row = document.createElement('div');
    row.className = 'file-browser-item-row file-browser-tree-row';
    row.dataset.path = node.path;

    var indent = document.createElement('span');
    indent.className = 'file-browser-tree-indent';
    indent.style.width = (depth * 18) + 'px';
    row.appendChild(indent);

    var toggle = document.createElement('span');
    toggle.className = 'file-browser-tree-toggle';
    if (node.type === 'dir') {
        // 折叠/展开图标：assets 下 SVG 遮罩（mask），类名切换状态
        toggle.classList.add(node.expanded ? 'is-expanded' : 'is-collapsed');
    }
    row.appendChild(toggle);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'file-browser-item ' + node.type;
    btn.dataset.path = node.path;
    btn.dataset.type = node.type;

    // 文件夹/文件图标改用 assets 下的 SVG 遮罩（mask 机制），颜色随行文字；
    // class 决定具体图形，不再写入 emoji 文本。
    var icon = document.createElement('span');
    icon.className = 'file-browser-item-icon ' + (node.type === 'dir' ? 'folder' : 'file');
    btn.appendChild(icon);

    var name = document.createElement('span');
    name.className = 'file-browser-item-name';
    name.textContent = node.title;
    btn.appendChild(name);

    row.appendChild(btn);

    return row;
}

/** 给文件树容器绑定点击事件 */
export function bindFileTreeEvents(container) {
    var state = store.fileBrowserState;

    // 文件/目录点击
    container.querySelectorAll('.file-browser-item').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var path = this.dataset.path || '/';
            var type = this.dataset.type || 'file';
            if (type === 'dir') {
                handleTreeDirClick(path);
            } else {
                handleTreeFileClick(path);
            }
        });
    });

    // 切换箭头点击
    container.querySelectorAll('.file-browser-tree-toggle').forEach(function(toggle) {
        toggle.addEventListener('click', function(e) {
            e.stopPropagation();
            var row = this.closest('.file-browser-item-row');
            if (!row) return;
            var path = row.dataset.path;
            if (path) handleTreeDirClick(path);
        });
    });
}

/** 处理树目录点击：展开/收起/懒加载 */
export async function handleTreeDirClick(path) {
    var state = store.fileBrowserState;
    var node = findNodeByPath(state.rootNode, path);
    if (!node || node.type !== 'dir') return;
    state.selectedPath = path;
    // 多文件 tab：点击目录只用于展开/收起树，不清空已打开文件的预览。
    // 原逻辑置 selectedItem=null + clearFileBrowserPreview()，
    // 会让已打开的 tab 栏保留但预览区显示"请选择左侧文件进行预览"。

    if (!node.loaded) {
        // 懒加载
        await loadDirChildren(node);
        node.expanded = true;
    } else {
        node.expanded = !node.expanded;
    }

    renderFileTree(state.rootNode);
    markTreeSelection(state.rootNode, state.selectedPath);
}

/** 处理树文件点击：以 tab 打开并预览 */
export function handleTreeFileClick(path) {
    var state = store.fileBrowserState;
    state.selectedPath = path;
    // 构造 item 供预览使用
    state.selectedItem = treeNodeToItem(state.rootNode, path);
    renderFileTree(state.rootNode);
    markTreeSelection(state.rootNode, path);
    if (state.selectedItem) {
        fileBrowserOpenFileTab(state.selectedItem);
    }
}

/** 把树节点信息转成预览用的 item */
export function treeNodeToItem(rootNode, path) {
    var node = findNodeByPath(rootNode, path);
    if (!node) return null;
    return { name: node.title, path: node.path, type: node.type };
}

/** 标记树节点选中状态 */
export function markTreeSelection(rootNode, path) {
    var listEl = document.getElementById('fileBrowserList');
    if (!listEl) return;
    listEl.querySelectorAll('.file-browser-item').forEach(function(el) {
        el.classList.toggle('active', el.dataset.path === path);
    });
}

/** 获取当前目录操作目标路径：选中目录用目录本身，选中文件用其父目录，默认根目录 */
export function getCurrentDirPath() {
    var state = store.fileBrowserState;
    if (!state.rootNode || !state.selectedPath) return '/';
    var node = findNodeByPath(state.rootNode, state.selectedPath);
    if (!node) return '/';
    if (node.type === 'dir') return node.path;
    return fileBrowserParentPath(node.path);
}

/** 删除树节点（文件或空目录） */
export async function deleteBrowserTreeItem(node) {
    var state = store.fileBrowserState;
    if (!node || !state.rootDir) return;
    var confirmed = await fileBrowserConfirmDelete({ name: node.title, type: node.type });
    if (!confirmed) return;
    try {
        var result = await fileBrowserApiDelete(state.rootDir, node.path);
        if (!result.success) {
            showToast(result.error || '删除失败', 'error');
            return;
        }
        if (state.selectedPath === node.path) {
            state.selectedPath = '';
            state.selectedItem = null;
            clearFileBrowserPreview();
        }
        showToast('已删除' + (node.type === 'dir' ? '文件夹' : '文件') + '：' + node.title, 'success');
        // 重新加载父目录（用统一 helper 计算，避免目录路径尾斜杠导致查找失败后静默跳过刷新）
        await reloadDirChildren(fileBrowserParentPath(node.path));
        renderFileTree(state.rootNode);
    } catch (err) {
        showApiError('删除失败: ', err);
    }
}

export async function fileBrowserApiGitPush(rootDir) {
    return await api.GitPush(rootDir, fileBrowserGetProxy());
}

export async function fileBrowserApiGitPull(rootDir) {
    return await api.GitPull(rootDir, fileBrowserGetProxy());
}

export async function fileBrowserApiDiscardFile(rootDir, path) {
    return await api.DiscardFile(rootDir, path);
}

export async function fileBrowserApiUpload(rootDir, path, fileName, base64Data, overwrite) {
    return await api.UploadBrowserFile(rootDir, path, fileName, base64Data, overwrite);
}

export async function fileBrowserApiCreateDir(rootDir, path, dirName) {
    return await api.CreateBrowserDir(rootDir, path, dirName);
}

export async function fileBrowserApiCreateFile(rootDir, path, fileName) {
    return await api.CreateBrowserFile(rootDir, path, fileName);
}

export async function fileBrowserApiRename(rootDir, path, newName) {
    return await api.RenameBrowserEntry(rootDir, path, newName);
}

export async function fileBrowserApiDelete(rootDir, path) {
    return await api.DeleteBrowserEntry(rootDir, path);
}

// 注：fileBrowserApiSave 已由 preview.js 定义并导出（调用 api.SaveBrowserFile），
// 这里不再重复定义，保存入口统一走 preview.js 的 saveCurrentFilePreview。

export function fileToBase64(file) {
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

export function openFileBrowserUploadPicker() {
    var input = document.getElementById('fileBrowserUploadInput');
    if (input) input.click();
}

// 内联输入框当前操作：{ mode: 'create-dir'|'create-file'|'rename', dirPath, targetPath, initialName }
// 工具栏按钮固定会话根目录（dirPath: '/'），右键菜单作用于被右键的目录
var fileBrowserInlineOp = null;

export function setFileBrowserCreateDirLoading(loading) {
    var btn = document.getElementById('btnFileBrowserCreateDir');
    var confirmBtn = document.getElementById('btnFileBrowserCreateDirConfirm');
    var cancelBtn = document.getElementById('btnFileBrowserCreateDirCancel');
    var input = document.getElementById('fileBrowserCreateDirInput');
    if (btn) btn.disabled = !!loading;
    if (confirmBtn) confirmBtn.disabled = !!loading;
    if (cancelBtn) cancelBtn.disabled = !!loading;
    if (input) input.disabled = !!loading;
}

export function closeFileBrowserCreateDirInline() {
    var wrap = document.getElementById('fileBrowserCreateDirInline');
    var input = document.getElementById('fileBrowserCreateDirInput');
    setFileBrowserCreateDirLoading(false);
    if (input) input.value = '';
    if (wrap) wrap.style.display = 'none';
    fileBrowserInlineOp = null;
}

/** 打开内联输入框（新建文件夹/新建文件/重命名共用）
 *  op: { mode, dirPath, targetPath, initialName }
 *      mode='create-dir'  → 在 dirPath 下新建文件夹
 *      mode='create-file' → 在 dirPath 下新建文件
 *      mode='rename'      → 将 targetPath 重命名为 initialName 的新名称（预填） */
export function openFileBrowserInlineInput(op) {
    var wrap = document.getElementById('fileBrowserCreateDirInline');
    var input = document.getElementById('fileBrowserCreateDirInput');
    fileBrowserInlineOp = op || { mode: 'create-dir', dirPath: '/' };
    if (input) {
        if (fileBrowserInlineOp.mode === 'rename') {
            input.placeholder = '输入新名称';
        } else if (fileBrowserInlineOp.mode === 'create-file') {
            input.placeholder = '输入文件名称';
        } else {
            input.placeholder = '输入文件夹名称';
        }
    }
    if (wrap) wrap.style.display = 'flex';
    if (input) {
        // 先写值再聚焦选中，重命名时可覆盖预填名称
        input.value = fileBrowserInlineOp.mode === 'rename' ? String(fileBrowserInlineOp.initialName || '') : '';
        input.focus();
        input.select();
    }
}

/** 提交内联输入框：按当前操作类型分派到新建文件夹/新建文件/重命名接口 */
export async function submitFileBrowserInline() {
    var state = store.fileBrowserState;
    var input = document.getElementById('fileBrowserCreateDirInput');
    var name = input ? String(input.value || '').trim() : '';
    var op = fileBrowserInlineOp || { mode: 'create-dir', dirPath: '/' };
    var emptyMsg = op.mode === 'create-file' ? '请输入文件名称' : (op.mode === 'rename' ? '请输入新名称' : '请输入文件夹名称');
    if (!name) {
        showToast(emptyMsg, 'error');
        if (input) input.focus();
        return;
    }
    setFileBrowserCreateDirLoading(true);
    try {
        var result;
        if (op.mode === 'create-file') {
            result = await fileBrowserApiCreateFile(state.rootDir, op.dirPath || '/', name);
        } else if (op.mode === 'rename') {
            result = await fileBrowserApiRename(state.rootDir, op.targetPath, name);
        } else {
            result = await fileBrowserApiCreateDir(state.rootDir, op.dirPath || '/', name);
        }
        if (!result.success) {
            var failMsg = op.mode === 'create-file' ? '创建文件失败' : (op.mode === 'rename' ? '重命名失败' : '创建文件夹失败');
            showToast(result.error || failMsg, 'error');
            if (input) input.focus();
            return;
        }
        closeFileBrowserCreateDirInline();
        if (op.mode === 'create-file') {
            showToast('已创建文件：' + name, 'success');
            await reloadDirChildren(op.dirPath || '/');
        } else if (op.mode === 'rename') {
            showToast('已重命名：' + name, 'success');
            // 先清理被重命名项相关的选中与打开标签，再刷新其父目录
            handleFileBrowserRenamed(op.targetPath);
            await reloadDirChildren(fileBrowserParentPath(op.targetPath));
        } else {
            showToast('已创建文件夹：' + name, 'success');
            await reloadDirChildren(op.dirPath || '/');
        }
        renderFileTree(state.rootNode);
        markTreeSelection(state.rootNode, state.selectedPath);
    } catch (err) {
        showApiError('操作失败: ', err);
    } finally {
        setFileBrowserCreateDirLoading(false);
    }
}

/** 重命名成功后清理失效的选中与打开标签（被重命名项及其后代路径已失效） */
function handleFileBrowserRenamed(oldPath) {
    var state = store.fileBrowserState;
    var hit = function(p) { return p === oldPath || p.indexOf(oldPath + '/') === 0; };
    if (state.selectedPath && hit(state.selectedPath)) {
        state.selectedPath = '';
        state.selectedItem = null;
        clearFileBrowserPreview();
    }
    if (Array.isArray(state.fileTabs)) {
        var removedActive = false;
        var remain = state.fileTabs.filter(function(tab) {
            if (hit(tab.path || '')) {
                if (tab.path === state.activeFileTabPath) removedActive = true;
                return false;
            }
            return true;
        });
        state.fileTabs = remain;
        if (removedActive) {
            var last = remain[remain.length - 1];
            state.activeFileTabPath = last ? last.path : '';
            if (last) {
                state.selectedItem = last;
                fileBrowserOpenFileTab(last);
            } else {
                state.selectedItem = null;
                clearFileBrowserPreview();
            }
        }
        if (typeof renderFileBrowserTabs === 'function') renderFileBrowserTabs();
    }
}

export function closeFileBrowserUploadConflictModal() {
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

export function openFileBrowserUploadConflictModal(name) {
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

export function showFileBrowserRenameMode() {
    var field = document.getElementById('fileBrowserUploadRenameField');
    var confirmBtn = document.getElementById('btnFileBrowserUploadRenameConfirm');
    if (field) field.style.display = 'block';
    if (confirmBtn) confirmBtn.style.display = 'inline-flex';
}

export async function submitBrowserUpload(fileName, overwrite) {
    var state = store.fileBrowserState;
    var targetDirPath = getCurrentDirPath();
    var result = await fileBrowserApiUpload(state.rootDir, targetDirPath, fileName, state.pendingUploadBase64 || '', overwrite);
    if (result.success) {
        closeFileBrowserUploadConflictModal();
        state.pendingUploadFileName = '';
        state.pendingUploadBase64 = '';
        showToast('上传成功', 'success');
        await reloadDirChildren(targetDirPath);
        renderFileTree(state.rootNode);
        markTreeSelection(state.rootNode, state.selectedPath);
        return;
    }
    if (result.conflict) {
        var error = document.getElementById('fileBrowserUploadConflictError');
        if (error) error.textContent = '文件名已存在，请重新输入';
        return;
    }
    throw new Error(result.error || '上传失败');
}

export async function handleBrowserUploadSelected(file) {
    if (!file) return;
    var state = store.fileBrowserState;
    var targetDirPath = getCurrentDirPath();
    state.pendingUploadFileName = file.name || '';
    state.pendingUploadBase64 = await fileToBase64(file);
    try {
        var result = await fileBrowserApiUpload(state.rootDir, targetDirPath, state.pendingUploadFileName, state.pendingUploadBase64, false);
        if (result.success) {
            state.pendingUploadFileName = '';
            state.pendingUploadBase64 = '';
            showToast('上传成功', 'success');
            await reloadDirChildren(targetDirPath);
            renderFileTree(state.rootNode);
            markTreeSelection(state.rootNode, state.selectedPath);
            return;
        }
        if (result.conflict) {
            openFileBrowserUploadConflictModal(state.pendingUploadFileName);
            return;
        }
        showToast(result.error || '上传失败', 'error');
    } catch (err) {
        showApiError('上传失败: ', err);
    }
}

export async function fileBrowserConfirmDelete(item) {
    var name = item && item.name ? item.name : '该条目';
    var typeLabel = item && item.type === 'dir' ? '文件夹' : '文件';
    var message = '确定删除' + typeLabel + '「' + name + '」吗？';
    // 桌面（WebView2）与浏览器统一使用脚本原生确认框：
    // wails v3 未禁用 WebView2 脚本对话框，window.confirm 可直接使用（与 window.prompt 同机制）。
    return confirm(message);
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

export async function gitPush() {
    var state = store.fileBrowserState;
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
        showApiError('推送失败: ', err);
    }
    setGitRemoteActionLoading('push', false);
}

export async function gitPull() {
    var state = store.fileBrowserState;
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
        showApiError('拉取失败: ', err);
    }
    setGitRemoteActionLoading('pull', false);
}

export function setGitRemoteActionLoading(action, loading) {
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

export async function discardFile(path) {
    var state = store.fileBrowserState;
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
        showApiError('撤销失败: ', err);
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

export function gitStatusClass(code) {
    var c = String(code || '').trim();
    if (c === '??') return 'untracked';
    if (c.indexOf('R') >= 0) return 'rename';
    if (c.indexOf('D') >= 0) return 'delete';
    if (c.indexOf('A') >= 0) return 'add';
    return 'modify';
}

/**
 * 将 git 提交时间格式化为「2026/09/10 12:34:12」。
 * 后端用 --date=iso-strict 输出（如 2026-09-10T12:34:12+08:00），
 * 优先按字符串截取以保留提交记录的原始时区时间，避免浏览器时区换算；
 * 格式不符时回退 Date 解析（本地时区）。
 */
export function formatGitCommitDate(raw) {
    if (!raw) return '';
    var m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
        return m[1] + '/' + m[2] + '/' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + (m[6] || '00');
    }
    var d = new Date(raw);
    if (isNaN(d.getTime())) return String(raw);
    var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' +
        pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/**
 * 在独立窗口打开指定目录的文件浏览器（工作区点击目录入口直接调用，跳过模态）。
 * - 桌面端（Wails）：后端 OpenFileBrowserWindow 创建原生多窗口
 * - Web 端：新标签页打开 /?view=filebrowser&root=...&git=1
 */
export function openFileBrowserStandaloneFor(rootDir, options) {
    if (!rootDir) {
        showToast('当前没有可浏览的目录', 'error');
        return;
    }
    var withGit = !!(options && Array.isArray(options.features) && options.features.indexOf('git') >= 0);
    if (isDesktopRuntime()) {
        // 桌面端：原生多窗口（失败时提示原因）
        Promise.resolve(api.OpenFileBrowserWindow(rootDir, withGit)).catch(function (e) {
            showToast('打开独立窗口失败: ' + (e && e.message ? e.message : e), 'error');
        });
    } else {
        // Web 端：新标签页
        var url = '/?view=filebrowser&root=' + encodeURIComponent(rootDir) + (withGit ? '&git=1' : '');
        var win = window.open(url, '_blank');
        if (!win) {
            showToast('浏览器拦截了新窗口，请允许弹出窗口后重试', 'error');
        }
    }
}

export function openFileBrowserModal(rootDir, options) {
    var modal = document.getElementById('fileBrowserModal');
    var title = document.getElementById('fileBrowserTitle');
    if (!modal) return;
    var features = (options && Array.isArray(options.features)) ? options.features : [];
    var hasExtraFeatures = features.length > 0;
    store.fileBrowserState.mode = 'files';
    store.fileBrowserState.rootDir = rootDir || '';
    store.fileBrowserState.features = features;
    store.fileBrowserState.selectedItem = null;
    // 新目录新会话：重置多文件 tab（tab 编辑缓存随弹窗关闭而清空）
    store.fileBrowserState.fileTabs = [];
    store.fileBrowserState.fileTabCache = {};
    store.fileBrowserState.activeFileTabPath = '';
    renderFileBrowserTabs();
    store.fileBrowserState.rootNode = null;
    store.fileBrowserState.selectedPath = '';
    store.fileBrowserState.previewMode = 'file';
    store.fileBrowserState.previewRenderMode = 'preview';
    store.fileBrowserState.previewEditorValue = '';
    store.fileBrowserState.previewOriginalContent = '';
    store.fileBrowserState.previewEditorInstance = null;
    store.fileBrowserState.previewSearchSyncTimer = null;
    store.fileBrowserState.previewReadResult = null;
    store.fileBrowserState.savingPreview = false;
    store.fileBrowserState.forcedTextPreview = {};
    store.fileBrowserState.previewDownloadPath = '';
    store.fileBrowserState.previewDownloadName = '';
    store.fileBrowserState.pendingUploadFileName = '';
    store.fileBrowserState.pendingUploadBase64 = '';
    store.fileBrowserState.git = {
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
    if (title) title.textContent = '文件管理 - ' + (rootDir || '');
    if (hasExtraFeatures) {
        modal.classList.remove('file-browser-compact');
    } else {
        modal.classList.add('file-browser-compact');
    }
    modal.style.display = 'flex';
    renderFileBrowserMode();
    loadFileBrowserList('/');
}

export function closeFileBrowserModal() {
    var modal = document.getElementById('fileBrowserModal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('file-browser-compact');
    }
    fileBrowserClearObjectURL();
    destroyFileBrowserEditor();
    closeFileBrowserCreateDirInline();
    clearFileBrowserPreview();
}

export async function downloadCurrentFilePreview() {
    var state = store.fileBrowserState;
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
        showApiError('下载失败: ', err);
    }
}

export async function loadFileBrowserGitStatus() {
    var state = store.fileBrowserState;
    if (!state.rootDir) return;
    try {
        var data = await fileBrowserApiGitStatus(state.rootDir);
        state.git.isGitRepo = !!data.isGitRepo;
        state.git.files = data.files || [];
        state.git.message = data.message || '';
    } catch (err) {
        state.git.isGitRepo = false;
        state.git.files = [];
        state.git.message = formatApiError(err);
    }
    renderFileBrowserGitSection();
}

export async function loadFileBrowserGitHistory(loadMore) {
    var state = store.fileBrowserState;
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
        state.git.message = formatApiError(err);
    } finally {
        state.git.historyLoading = false;
        renderFileBrowserGitSection();
    }
}

export async function loadFileBrowserList(path) {
    var state = store.fileBrowserState;
    var listEl = document.getElementById('fileBrowserList');
    var emptyEl = document.getElementById('fileBrowserListEmpty');
    if (!listEl || !state.rootDir) return;
    closeFileBrowserCreateDirInline();
    state.loadingList = true;
    var targetPath = path || '/';
    if (listEl) listEl.innerHTML = '<div class="file-browser-empty">正在读取目录...</div>';
    if (emptyEl) emptyEl.style.display = 'none';
    try {
        var data = await fileBrowserApiList(state.rootDir, targetPath);
        // 构建根节点
        state.rootNode = {
            title: state.rootDir || '/',
            path: '/',
            type: 'dir',
            children: (data.items || []).map(function(item) { return createTreeNode(item); }),
            expanded: true,
            loaded: true
        };
        renderFileTree(state.rootNode);
        markTreeSelection(state.rootNode, state.selectedPath);
        loadFileBrowserGitStatus();
    } catch (err) {
        if (listEl) listEl.innerHTML = '<div class="file-browser-empty error">' + escapeHtml(formatApiError(err)) + '</div>';
    } finally {
        state.loadingList = false;
    }
}

export function renderFileBrowserGitSection() {
    var currentBodyEl = document.getElementById('fileBrowserGitCurrentBody');
    var historyBodyEl = document.getElementById('fileBrowserGitHistoryBody');
    var state = store.fileBrowserState;
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



export function renderFileBrowserGitGroup(title, files, groupName) {
    var html = '<div class="file-browser-git-group">' +
        '<div class="file-browser-git-group-header">' +
            '<div class="file-browser-git-subtitle">' + escapeHtml(title) + '</div>' +
            (groupName === 'unstaged' ? '<button type="button" class="btn file-browser-git-stage-all" id="btnStageAll" ' + (files.length ? '' : 'disabled') + '>全部暂存</button>' : '') +
        '</div>';
    if (!files.length) {
        return html + '<div class="file-browser-empty">当前没有' + escapeHtml(title) + '文件</div></div>';
    }
    // 目录树渲染：按路径层级分组，目录可折叠
    html += renderGitTreeNodes(buildGitFileTree(files), groupName, 0);
    html += '</div>';
    return html;
}

/**
 * 把变更文件列表构建成目录树。
 * 每个文件按 path 的 '/' 分段挂到树上；目录节点携带累计路径（折叠状态 key 用）。
 */
export function buildGitFileTree(files) {
    var root = { name: '', path: '', children: {}, files: [] };
    (files || []).forEach(function(item) {
        var clean = String(item.path || '').replace(/^\//, '');
        var parts = clean.split('/').filter(Boolean);
        parts.pop(); // 去掉文件名，剩下目录段
        var node = root;
        var acc = '';
        parts.forEach(function(seg) {
            acc = acc ? acc + '/' + seg : seg;
            if (!node.children[seg]) {
                node.children[seg] = { name: seg, path: acc, children: {}, files: [] };
            }
            node = node.children[seg];
        });
        node.files.push(item);
    });
    return root;
}

/**
 * 递归渲染变更树节点为 HTML：
 * - 目录行（带展开箭头，点击折叠/展开）
 * - 文件行（缩进 + 状态码 + 文件名 + 暂存/撤销按钮；完整路径放 title）
 */
export function renderGitTreeNodes(node, groupName, depth) {
    var state = store.fileBrowserState;
    var INDENT = 14;
    var html = '';
    var dirNames = Object.keys(node.children).sort(function(a, b) { return a.localeCompare(b); });
    dirNames.forEach(function(dirName) {
        var child = node.children[dirName];
        var collapseKey = groupName + '|' + child.path;
        var collapsed = !!(state.git.collapsedDirs && state.git.collapsedDirs[collapseKey]);
        html += '<div class="file-browser-git-tree-dir" data-tree-dir="' + escapeHtml(collapseKey) + '"' +
            ' style="padding-left:' + (depth * INDENT + 6) + 'px" title="' + escapeHtml(child.path) + '">' +
            '<span class="file-browser-git-tree-toggle ' + (collapsed ? 'is-collapsed' : 'is-expanded') + '"></span>' +
            // 文件夹图标：assets/文件夹.svg 作遮罩（mask 机制），颜色随行文字
            '<span class="file-browser-git-tree-icon"></span>' +
            '<span class="file-browser-git-tree-name">' + escapeHtml(dirName) + '</span>' +
        '</div>';
        if (!collapsed) html += renderGitTreeNodes(child, groupName, depth + 1);
    });
    var fileList = node.files.slice().sort(function(a, b) {
        return String(a.name || a.path).localeCompare(String(b.name || b.path));
    });
    fileList.forEach(function(item) {
        html += renderGitTreeFileRow(item, groupName, depth, INDENT);
    });
    return html;
}

/** 渲染树中的单个文件行（保留状态码与暂存/撤销操作） */
export function renderGitTreeFileRow(item, groupName, depth, indentUnit) {
    var INDENT = indentUnit || 14;
    var fullPath = String(item.path || '').replace(/^\//, '');
    var displayName = item.name || fullPath;
    var actionBtn = '';
    var discardBtn = '<button type="button" class="file-browser-git-action-btn file-browser-git-discard-btn" data-git-path="' + escapeHtml(item.path) + '" data-action="discard" title="撤销变更">↩</button>';
    if (groupName === 'unstaged') {
        actionBtn = '<button type="button" class="file-browser-git-action-btn" data-git-path="' + escapeHtml(item.path) + '" data-action="stage" title="加入暂存区" ' + (store.fileBrowserState.git.stageLoadingPath === item.path || store.fileBrowserState.git.stageAllLoading ? 'disabled' : '') + '>+</button>';
    } else if (groupName === 'staged') {
        actionBtn = '<button type="button" class="file-browser-git-action-btn" data-git-path="' + escapeHtml(item.path) + '" data-action="unstage" title="移出暂存区" ' + (store.fileBrowserState.git.unstageLoadingPath === item.path ? 'disabled' : '') + '>-</button>';
    }
    return '<div class="file-browser-git-item-row" style="padding-left:' + (depth * INDENT) + 'px">' +
        '<button type="button" class="file-browser-git-item" data-git-path="' + escapeHtml(item.path) + '" data-git-group="' + escapeHtml(groupName) + '" title="' + escapeHtml(fullPath) + '">' +
            '<span class="file-browser-git-status status-' + escapeHtml(gitStatusClass(item.statusCode || 'xx')) + '">' + escapeHtml(item.statusCode || '') + '</span>' +
            '<span class="file-browser-git-text">' +
                '<span class="file-browser-git-name">' + escapeHtml(displayName) + '</span>' +
            '</span>' +
        '</button>' +
        discardBtn +
        actionBtn +
    '</div>';
}

export function bindCurrentGitFileEvents(bodyEl) {
    var state = store.fileBrowserState;

    // 目录行点击：切换折叠状态并重渲染变更面板
    bodyEl.querySelectorAll('.file-browser-git-tree-dir').forEach(function(dirEl) {
        dirEl.addEventListener('click', function() {
            var key = this.dataset.treeDir || '';
            if (!key) return;
            if (!state.git.collapsedDirs) state.git.collapsedDirs = {};
            state.git.collapsedDirs[key] = !state.git.collapsedDirs[key];
            renderFileBrowserGitSection();
        });
    });

    bodyEl.querySelectorAll('.file-browser-git-item').forEach(function(btn) {
        btn.addEventListener('click', function() {
            state.selectedItem = null;
            state.git.activeHistoryFileKey = '';
            renderFileBrowserSelection();
            bodyEl.querySelectorAll('.file-browser-git-item').forEach(function(node) {
                node.classList.toggle('active', node === btn);
            });
            // 与文件浏览共用同一套 tab 栏：以 diff 视图打开该变更文件，
            // 可与普通文件 tab 互相切换
            fileBrowserOpenGitTab(this.dataset.gitPath || '/', this.dataset.gitGroup || '');
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
            store.fileBrowserState.git.commitMessage = this.value || '';
            store.fileBrowserState.git.gitActionError = '';
        });
    }
}

export function renderFileBrowserGitHistory(bodyEl) {
    var state = store.fileBrowserState;
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
            '<button type="button" class="file-browser-git-item commit-item' + (expanded ? ' active' : '') + '" data-commit-hash="' + escapeHtml(item.hash) + '" title="提交 ID：' + escapeHtml(item.hash) + '">' +
                '<span class="file-browser-git-text" title="' + escapeHtml(item.subject || '') + '">' +
                    '<span class="file-browser-git-name">' + escapeHtml(item.subject || '(无标题提交)') + '</span>' +
                    '<span class="file-browser-git-path">' + escapeHtml([item.author || '', formatGitCommitDate(item.date || '')].filter(Boolean).join(' · ')) + '</span>' +
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
            renderFileBrowserSelection();
            // 历史提交中的文件同样以 tab 打开（与 git 变更列表、普通文件同一套 tab 栏）
            fileBrowserOpenGitHistoryTab(this.dataset.commitHash || '', this.dataset.historyPath || '/');
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

export function renderFileBrowserSelection() {
    var listEl = document.getElementById('fileBrowserList');
    var state = store.fileBrowserState;
    if (!listEl) return;
    listEl.querySelectorAll('.file-browser-item').forEach(function(node) {
        node.classList.toggle('active', node.dataset.path === state.selectedPath);
    });
    var gitPanel = document.getElementById('fileBrowserGitPanel');
    if (gitPanel) {
        gitPanel.querySelectorAll('.file-browser-git-item').forEach(function(node) {
            node.classList.remove('active');
        });
    }
}

export async function toggleFileBrowserGitHistoryCommit(commitHash) {
    var state = store.fileBrowserState;
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
        state.git.message = formatApiError(err);
    } finally {
        item.loadingFiles = false;
        renderFileBrowserGitSection();
    }
}

export async function stageSingleFile(path) {
    var state = store.fileBrowserState;
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
        state.git.gitActionError = formatApiError(err) || '暂存失败';
    }
    state.git.stageLoadingPath = '';
    await loadFileBrowserGitStatus();
}

export async function unstageSingleFile(path) {
    var state = store.fileBrowserState;
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
        state.git.gitActionError = formatApiError(err) || '取消暂存失败';
    }
    state.git.unstageLoadingPath = '';
    await loadFileBrowserGitStatus();
}

export async function stageAllGitFiles() {
    var state = store.fileBrowserState;
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
        state.git.gitActionError = formatApiError(err) || '全部暂存失败';
    }
    state.git.stageAllLoading = false;
    await loadFileBrowserGitStatus();
}

export async function gitCommit() {
    var state = store.fileBrowserState;
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
        state.git.gitActionError = formatApiError(err) || '提交失败';
    }
    state.git.commitSubmitting = false;
    renderFileBrowserGitSection();
}

export function switchFileBrowserMode(mode) {
    var state = store.fileBrowserState;
    if (mode === 'git' && (!state.features || state.features.indexOf('git') < 0)) return;
    state.mode = (mode === 'git' || mode === 'search') ? mode : 'files';
    renderFileBrowserMode();
    if (state.mode === 'git' && !state.git.historyItems.length && !state.git.historyLoading) {
        loadFileBrowserGitHistory(false);
    }
    if (state.mode === 'search') {
        initFileBrowserSearch();
        var input = document.getElementById('fileBrowserSearchInput');
        if (input) input.focus();
    }
}

// ============================================================
// 内容搜索（文件浏览器"搜索"模式）
// ============================================================
var fbSearchTimer = null;
var fbSearchSeq = 0;
var fbSearchInited = false;

/** 绑定搜索面板交互（幂等；首次进入搜索模式时调用） */
export function initFileBrowserSearch() {
    if (fbSearchInited) return;
    fbSearchInited = true;
    var input = document.getElementById('fileBrowserSearchInput');
    var clearBtn = document.getElementById('btnFileBrowserSearchClear');
    if (input) {
        input.addEventListener('input', function () {
            if (fbSearchTimer) clearTimeout(fbSearchTimer);
            fbSearchTimer = setTimeout(runFileBrowserSearch, 300); // 防抖
        });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && clearBtn) clearBtn.click();
        });
    }
    if (clearBtn) {
        clearBtn.addEventListener('click', function () {
            if (input) { input.value = ''; input.focus(); }
            runFileBrowserSearch();
        });
    }
    ['btnFbSearchCase', 'btnFbSearchRegex', 'btnFbSearchWord'].forEach(function (id) {
        var btn = document.getElementById(id);
        if (btn) btn.addEventListener('click', function () {
            btn.classList.toggle('active');
            runFileBrowserSearch();
        });
    });
}

/** 执行搜索（过期结果丢弃） */
async function runFileBrowserSearch() {
    var input = document.getElementById('fileBrowserSearchInput');
    var results = document.getElementById('fileBrowserSearchResults');
    var stats = document.getElementById('fileBrowserSearchStats');
    if (!input || !results || !stats) return;
    var q = input.value.trim();
    var seq = ++fbSearchSeq;
    if (!q) {
        results.innerHTML = '<div class="file-browser-search-empty"><div class="big">⌕</div>输入关键字，在会话目录内搜索文件内容</div>';
        stats.innerHTML = '';
        return;
    }
    var state = store.fileBrowserState;
    var rootDir = state.rootDir || '';
    if (!rootDir) {
        results.innerHTML = '<div class="file-browser-search-empty">请先选择会话目录</div>';
        stats.innerHTML = '';
        return;
    }
    var caseBtn = document.getElementById('btnFbSearchCase');
    var regexBtn = document.getElementById('btnFbSearchRegex');
    var wordBtn = document.getElementById('btnFbSearchWord');
    var caseSensitive = !!(caseBtn && caseBtn.classList.contains('active'));
    var useRegex = !!(regexBtn && regexBtn.classList.contains('active'));
    var wholeWord = !!(wordBtn && wordBtn.classList.contains('active'));
    results.innerHTML = '<div class="file-browser-search-empty">搜索中…</div>';
    try {
        var res = await api.SearchBrowserFiles(rootDir, '/', q, caseSensitive, useRegex, wholeWord);
        if (seq !== fbSearchSeq) return; // 过期结果丢弃
        renderFileBrowserSearchResults(res || {}, q);
    } catch (err) {
        if (seq !== fbSearchSeq) return;
        results.innerHTML = '<div class="file-browser-search-empty">搜索失败：' + escapeHtml(formatApiError(err) || '未知错误') + '</div>';
        stats.innerHTML = '';
    }
}

/** 渲染搜索结果（按文件分组 + 高亮 + 折叠 + 行选中） */
function renderFileBrowserSearchResults(res, query) {
    var results = document.getElementById('fileBrowserSearchResults');
    var stats = document.getElementById('fileBrowserSearchStats');
    if (!results || !stats) return;
    var files = Array.isArray(res.files) ? res.files : [];
    if (!files.length) {
        results.innerHTML = '<div class="file-browser-search-empty"><div class="big">∅</div>未找到匹配项</div>';
        stats.innerHTML = '共 0 个文件 · 0 处匹配 · ' + (res.elapsedMs || 0) + 'ms';
        return;
    }
    var qEsc = String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = null;
    try { re = new RegExp(qEsc, 'gi'); } catch (e) { re = null; }
    var html = '';
    files.forEach(function (f) {
        // 命中行上下文窗口：超长行只截命中前后一段，两端加省略号
        var CTX_BEFORE = 30;
        var CTX_AFTER = 60;
        var rows = (f.matches || []).map(function (m) {
            // 去行首空白；超长行围绕首处命中裁剪
            var raw = String(m.text || '').replace(/^\s+/, '');
            var text = raw;
            var leadCut = false, tailCut = false;
            if (re) {
                re.lastIndex = 0;
                var firstHit = re.exec(raw);
                if (firstHit !== null) {
                    // 前/后各自独立判断：命中前超 30 字裁前、后超 60 字裁后
                    var s = Math.max(0, firstHit.index - CTX_BEFORE);
                    var e2 = Math.min(raw.length, firstHit.index + firstHit[0].length + CTX_AFTER);
                    leadCut = s > 0;
                    tailCut = e2 < raw.length;
                    if (leadCut || tailCut) text = raw.slice(s, e2);
                }
            }
            var display = escapeHtml(text);
            if (re) {
                re.lastIndex = 0;
                // 仅对纯文本段做高亮：先按匹配位置切分再逐段 escape，避免破坏 HTML 实体
                var out = '', last = 0, hit;
                while ((hit = re.exec(text)) !== null) {
                    if (!hit[0].length) { re.lastIndex++; continue; }
                    out += escapeHtml(text.slice(last, hit.index)) + '<mark>' + escapeHtml(hit[0]) + '</mark>';
                    last = hit.index + hit[0].length;
                }
                out += escapeHtml(text.slice(last));
                display = out;
            }
            if (leadCut) display = '<span class="ellipsis">…</span>' + display;
            if (tailCut) display = display + '<span class="ellipsis">…</span>';
            return '<div class="file-browser-search-row" data-path="' + escapeHtml(f.path || '') + '" data-rel-path="' + escapeHtml(f.relPath || '') + '" data-line="' + (m.line || 0) + '">'
                + '<span class="ln">' + (m.line || '') + '</span>'
                + '<span class="txt">' + display + '</span></div>';
        }).join('');
        var rel = String(f.relPath || f.path || '');
        var name = rel.split('/').pop();
        html += '<div class="file-browser-search-group">'
            + '<div class="file-browser-search-group-head">'
            + '<span class="arrow">▼</span>'
            + '<span class="fname" title="' + escapeHtml(rel) + '">' + escapeHtml(name) + '</span>'
            + '<span class="badge">' + (f.matches || []).length + '</span></div>'
            + '<div class="file-browser-search-group-rows">' + rows + '</div></div>';
    });
    results.innerHTML = html;
    var elapsed = res.elapsedMs != null ? ' · ' + res.elapsedMs + 'ms' : '';
    stats.innerHTML = '共 ' + (res.fileCount || 0) + ' 个文件 · ' + (res.matchCount || 0) + ' 处匹配' + elapsed
        + (res.truncated ? '<span class="warn">（结果已达上限，已截断）</span>' : '');

    results.querySelectorAll('.file-browser-search-group-head').forEach(function (head) {
        head.addEventListener('click', function () {
            head.parentElement.classList.toggle('collapsed');
        });
    });
    results.querySelectorAll('.file-browser-search-row').forEach(function (row) {
        row.addEventListener('click', function () {
            results.querySelectorAll('.file-browser-search-row.selected').forEach(function (r) { r.classList.remove('selected'); });
            row.classList.add('selected');
            // 直接在搜索模式内打开到右侧预览面板（不切换左侧模式，保留搜索结果）
            var rel = row.dataset.relPath || '';
            var line = parseInt(row.dataset.line || '0', 10);
            if (rel) fileBrowserOpenFileAtLine(rel, line);
        });
    });
}

export function renderFileBrowserMode() {
    var state = store.fileBrowserState;
    var filesBtn = document.getElementById('btnFileBrowserModeFiles');
    var gitBtn = document.getElementById('btnFileBrowserModeGit');
    var searchBtn = document.getElementById('btnFileBrowserModeSearch');
    var filesPanel = document.getElementById('fileBrowserFilesPanel');
    var gitPanel = document.getElementById('fileBrowserGitPanel');
    var searchPanel = document.getElementById('fileBrowserSearchPanel');
    var hasGit = state.features && state.features.indexOf('git') >= 0;
    if (filesBtn) filesBtn.classList.toggle('active', state.mode === 'files');
    if (gitBtn) {
        gitBtn.style.display = hasGit ? '' : 'none';
        gitBtn.classList.toggle('active', state.mode === 'git');
    }
    if (searchBtn) searchBtn.classList.toggle('active', state.mode === 'search');
    if (filesPanel) filesPanel.style.display = state.mode === 'files' ? 'flex' : 'none';
    if (gitPanel) gitPanel.style.display = state.mode === 'git' ? 'flex' : 'none';
    if (searchPanel) searchPanel.classList.toggle('active', state.mode === 'search');
}

export function refreshFileBrowser() {
    var state = store.fileBrowserState;
    loadFileBrowserList('/').then(function() {
        var activeTab = state.fileTabs.find(function(tab) {
            return tab.path === state.activeFileTabPath;
        });
        var activeItem = activeTab || state.selectedItem;
        if (activeItem) {
            fileBrowserOpenFileTab(activeItem);
        }
    });
    if (state.mode === 'git') {
        loadFileBrowserGitHistory(false);
    }
}

// ============================================================
// 文件列表右键菜单
// 说明：委托绑定在 #fileBrowserList 静态容器上（行 DOM 动态重建不影响）；
//       目录行显示全部 5 项，文件行仅显示「复制路径 / 重命名 / 删除」。
// ============================================================
var fileBrowserContextTarget = null;

/** 相对路径转系统原生绝对路径（rootDir + relPath 拼接为系统原生分隔符） */
function fileBrowserAbsolutePath(relPath) {
    var root = String(store.fileBrowserState.rootDir || '').replace(/[\\/]+$/, '');
    var sep = root.indexOf('\\') >= 0 ? '\\' : '/';
    var rel = String(relPath || '/').replace(/^\/+/, '').replace(/\//g, sep);
    return rel ? root + sep + rel : root;
}

/** 显示文件列表右键菜单：按目标类型（dir/file）显示或隐藏菜单项 */
function showFileBrowserContextMenu(e, target) {
    var menu = document.getElementById('fileBrowserContextMenu');
    if (!menu) return;
    fileBrowserContextTarget = target;
    menu.querySelectorAll('.oc-tree-context-menu-item').forEach(function(item) {
        var action = item.dataset.action;
        if (target.type === 'dir') {
            // 目录行：新建文件 / 新建文件夹 / 复制路径 / 重命名 / 删除 全显
            item.style.display = '';
        } else {
            // 文件行：仅保留复制路径 / 重命名 / 删除
            item.style.display = (action === 'copy-path' || action === 'rename' || action === 'delete') ? '' : 'none';
        }
    });
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.style.display = 'block';
}

/** 隐藏文件列表右键菜单 */
export function hideFileBrowserContextMenu() {
    var menu = document.getElementById('fileBrowserContextMenu');
    if (menu) menu.style.display = 'none';
    fileBrowserContextTarget = null;
}

/** 初始化文件列表右键菜单事件（只需绑定一次） */
export function initFileBrowserContextMenu() {
    var list = document.getElementById('fileBrowserList');
    if (!list || list.dataset.ctxBound) return;
    list.dataset.ctxBound = 'true';
    list.addEventListener('contextmenu', function(e) {
        var row = e.target.closest('.file-browser-item-row');
        if (!row) return;
        var path = row.dataset.path;
        if (!path) return;
        var state = store.fileBrowserState;
        var node = findNodeByPath(state.rootNode, path);
        if (!node) return;
        e.preventDefault();
        showFileBrowserContextMenu(e, { type: node.type, path: node.path, title: node.title });
    });

    var menu = document.getElementById('fileBrowserContextMenu');
    if (!menu || menu.dataset.ctxBound) return;
    menu.dataset.ctxBound = 'true';
    menu.querySelectorAll('.oc-tree-context-menu-item').forEach(function(item) {
        item.addEventListener('click', function() {
            var action = item.dataset.action;
            var target = fileBrowserContextTarget;
            if (!target) return;
            hideFileBrowserContextMenu();
            if (action === 'new-file') {
                // 右键菜单的新建文件作用于被右键的目录
                openFileBrowserInlineInput({ mode: 'create-file', dirPath: target.path });
            } else if (action === 'new-folder') {
                // 右键菜单的新建文件夹作用于被右键的目录
                openFileBrowserInlineInput({ mode: 'create-dir', dirPath: target.path });
            } else if (action === 'copy-path') {
                copyToClipboard(fileBrowserAbsolutePath(target.path)).then(function() {
                    showToast('已复制路径', 'success');
                }).catch(function() {
                    showToast('复制路径失败', 'error');
                });
            } else if (action === 'rename') {
                openFileBrowserInlineInput({ mode: 'rename', targetPath: target.path, initialName: target.title });
            } else if (action === 'delete') {
                var node = findNodeByPath(store.fileBrowserState.rootNode, target.path);
                if (node) deleteBrowserTreeItem(node);
            }
        });
    });

    // 点击菜单外部任意处关闭：用 pointerdown + 捕获阶段。
    // 原因：文件浏览器模态根节点在冒泡阶段执行 stopPropagation（防点击穿透），
    //       依赖 document 冒泡的 click 监听收不到模态内的点击；
    //       捕获阶段先于目标/冒泡执行，不受 stopPropagation 影响。
    document.addEventListener('pointerdown', function(e) {
        if (menu.style.display !== 'none' && !menu.contains(e.target)) {
            hideFileBrowserContextMenu();
        }
    }, true);
    // Escape 键关闭菜单（与内联输入框的 Escape 互不冲突）
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && menu.style.display !== 'none') {
            hideFileBrowserContextMenu();
        }
    });
}

// ============================================================
// 文件浏览器事件绑定（IIFE，模块加载时执行）
// 说明：btnCloseFileBrowser / btnRefreshFiles / btnFileBrowserDownload /
//       btnFileBrowserModeFiles / btnFileBrowserModeGit / btnFileBrowserUpload /
//       fileBrowserUploadInput / btnFileBrowserUploadOverwrite /
//       btnFileBrowserUploadRenameMode / btnFileBrowserUploadRenameConfirm /
//       btnFileBrowserUploadConflictCancel 的绑定已由 main.js（DOMContentLoaded）
//       统一处理（带 try/catch 错误处理），此处不再重复绑定。
//       本 IIFE 保留 main.js 未覆盖的「新建文件 / 新建文件夹」系列绑定
//       与文件列表右键菜单初始化。
// ============================================================
(function initFileBrowserActions() {
    // 新建文件按钮：固定作用于会话根目录
    var createFileBtn = document.getElementById('btnFileBrowserCreateFile');
    if (createFileBtn && !createFileBtn.dataset.bound) {
        createFileBtn.dataset.bound = 'true';
        createFileBtn.addEventListener('click', function() {
            openFileBrowserInlineInput({ mode: 'create-file', dirPath: '/' });
        });
    }

    // 新建文件夹按钮：固定作用于会话根目录
    var createDirBtn = document.getElementById('btnFileBrowserCreateDir');
    if (createDirBtn && !createDirBtn.dataset.bound) {
        createDirBtn.dataset.bound = 'true';
        createDirBtn.addEventListener('click', function() {
            openFileBrowserInlineInput({ mode: 'create-dir', dirPath: '/' });
        });
    }

    var createDirConfirmBtn = document.getElementById('btnFileBrowserCreateDirConfirm');
    if (createDirConfirmBtn && !createDirConfirmBtn.dataset.bound) {
        createDirConfirmBtn.dataset.bound = 'true';
        createDirConfirmBtn.addEventListener('click', function() {
            submitFileBrowserInline();
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
                submitFileBrowserInline();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                closeFileBrowserCreateDirInline();
            }
        });
    }

    // 初始化文件列表右键菜单
    initFileBrowserContextMenu();
})();
