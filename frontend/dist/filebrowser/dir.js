// ============================
// 目录浏览器 —— Web 端工作目录选择
//
// 布局：左侧根目录（Windows 盘符 / Linux /、/home、/var、/data），
//       右侧地址栏 + 子目录列表。
// 交互：单击选中，双击进入；地址栏可直接输入路径；底部按钮确认。
// ============================

import { api } from '../core/apicall.js';
import { store } from '../core/state.js';
import { showToast, escapeHtml, escapeAttr, showApiError } from '../core/utils.js';
import { dirname } from '../core/path.js';

var dirBrowserRoots = [];
var dirBrowserCurrentPath = '';
var dirBrowserSelectedPath = '';

/** 打开目录浏览器；确认时 resolve 选中的目录，取消时 reject。
 *
 *  initialDir 可选：传入绝对路径时以该目录作为起始位置（比如连接器的 cwd），
 *  不传或路径无效时回退到第一个根目录，与旧行为一致。 */
export async function openDirBrowserModal(initialDir) {
    dirBrowserCurrentPath = '';
    dirBrowserSelectedPath = '';
    store.dirBrowserCurrentPath = '';
    document.getElementById('dirBrowserModal').style.display = 'flex';

    await loadDirBrowserRoots();
    // 起始目录：调用方给的路径优先，否则进入第一个根目录（Windows 为第一个盘符，Linux 为 /）
    const fallback = dirBrowserRoots.length ? dirBrowserRoots[0].path : '';
    const start = initialDir || fallback;
    const ok = await loadDirBrowserList(start);
    // 调用方给的路径不存在/无权限时，回退到根目录，避免用户看到空列表以为坏了。
    // 只在「确实传了不同的初始路径」时回退，避免默认路径失败时重复请求。
    if (!ok && start && fallback && start !== fallback) {
        await loadDirBrowserList(fallback);
    }

    // 只保留 resolve：取消时由 closeDirBrowserModal 以空串 resolve
    return new Promise((resolve) => {
        store.dirBrowserResolver = resolve;
        store.dirBrowserRejecter = null;
    });
}

/** 关闭目录浏览器 */
/** 关闭目录浏览器（取消选择）。
 *
 *  取消是正常操作，用空串 resolve，让调用方走「未选择」分支。
 *  不要 reject：多数调用点在 try 之外直接 await，reject 会变成未处理异常，
 *  用户会看到「移动失败」「添加失败」这类误报。 */
export function closeDirBrowserModal() {
    if (store.dirBrowserResolver) {
        store.dirBrowserResolver('');
        store.dirBrowserResolver = null;
    }
    store.dirBrowserRejecter = null;
    document.getElementById('dirBrowserModal').style.display = 'none';
}

/** 加载根目录列表：Windows 盘符；Linux 为 /、/home、/var、/data */
async function loadDirBrowserRoots() {
    try {
        dirBrowserRoots = (await api.ListBrowsableDirs('')) || [];
    } catch (e) {
        dirBrowserRoots = [];
    }
    renderDirBrowserPlaces();
}

/** 渲染左侧根目录 */
function renderDirBrowserPlaces() {
    var box = document.getElementById('dirBrowserPlaces');
    if (!box) return;

    box.innerHTML = '<div class="dir-browser-places-label">根目录</div>' +
        dirBrowserRoots.map(function(root) {
            var active = root.path === dirBrowserCurrentPath ? ' active' : '';
            return '<button type="button" class="dir-browser-place' + active + '" data-path="' + escapeAttr(root.path) + '">' +
                '<span class="oc-fb-icon oc-fb-icon-root" aria-hidden="true"></span>' +
                '<span>' + escapeHtml(root.name || root.path) + '</span>' +
                '</button>';
        }).join('');

    box.querySelectorAll('[data-path]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            loadDirBrowserList(btn.dataset.path || '');
        });
    });
}

/** 加载指定目录的子目录列表。
 *  @returns {Promise<boolean>} 是否加载成功（调用方可不关心，现有调用点都忽略返回值） */
export async function loadDirBrowserList(path) {
    dirBrowserCurrentPath = path || '';
    dirBrowserSelectedPath = dirBrowserCurrentPath;
    store.dirBrowserCurrentPath = dirBrowserCurrentPath;
    updateDirBrowserAddress();
    renderDirBrowserPlaces();

    var list = document.getElementById('dirBrowserList');
    list.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在读取目录...</p></div>';
    try {
        var dirs = await api.ListBrowsableDirs(dirBrowserCurrentPath);
        renderDirBrowserList(dirs || []);
        return true;
    } catch (e) {
        list.innerHTML = '<div class="oc-empty">读取目录失败</div>';
        showApiError('读取目录失败: ', e);
        return false;
    }
}

/** 渲染右侧目录列表：单击选中，双击进入 */
function renderDirBrowserList(dirs) {
    var list = document.getElementById('dirBrowserList');
    if (!dirs.length) {
        list.innerHTML = '<div class="oc-empty">当前目录没有可进入的子目录</div>';
        return;
    }

    list.innerHTML = dirs.map(function(dir) {
        var selected = dir.path === dirBrowserSelectedPath ? ' selected' : '';
        return '<button type="button" class="dir-browser-item' + selected + '" data-path="' + escapeAttr(dir.path) + '">' +
            '<span class="oc-fb-icon oc-fb-icon-folder" aria-hidden="true"></span>' +
            '<span>' + escapeHtml(dir.name) + '</span>' +
            '</button>';
    }).join('');

    list.querySelectorAll('[data-path]').forEach(function(btn) {
        var path = btn.dataset.path || '';
        btn.addEventListener('click', function() {
            dirBrowserSelectedPath = path;
            store.dirBrowserCurrentPath = path;
            list.querySelectorAll('.dir-browser-item').forEach(function(el) {
                el.classList.toggle('selected', el === btn);
            });
            updateDirBrowserAddress();
        });
        btn.addEventListener('dblclick', function() {
            loadDirBrowserList(path);
        });
    });
}

/** 同步地址栏与底部「已选」文本 */
function updateDirBrowserAddress() {
    var input = document.getElementById('dirBrowserPath');
    if (input) input.value = dirBrowserCurrentPath || '';
    var selected = document.getElementById('dirBrowserSelected');
    if (selected) {
        selected.textContent = '已选：' + (dirBrowserSelectedPath || dirBrowserCurrentPath || '未选择');
    }
}

/** 确认选择：优先选中的子目录，否则当前目录 */
export async function selectDirBrowserCurrent() {
    var target = dirBrowserSelectedPath || dirBrowserCurrentPath;
    if (!target) {
        showToast('请先进入或选择一个目录', 'warning');
        return;
    }
    if (store.dirBrowserResolver) {
        store.dirBrowserResolver(target);
        store.dirBrowserResolver = null;
        store.dirBrowserRejecter = null;
    }
    document.getElementById('dirBrowserModal').style.display = 'none';
}

/** 返回上一级；已经在根目录时回到根目录列表 */
export async function goDirBrowserUp() {
    if (!dirBrowserCurrentPath) return;
    var parent = dirname(dirBrowserCurrentPath);
    if (!parent || parent === dirBrowserCurrentPath || parent === '/') {
        await loadDirBrowserList('');
        return;
    }
    await loadDirBrowserList(parent);
}

/** 地址栏跳转到指定路径 */
export async function goDirBrowserPath(path) {
    var value = String(path == null ? '' : path).trim();
    if (!value) return;
    await loadDirBrowserList(value);
}
