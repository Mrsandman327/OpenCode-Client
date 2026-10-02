// ============================================================
// chat-tree.js — 会话树 & 目录浏览器
// 依赖：core/state.js（webRunning, currentSessionId, pendingWorkDir 等）、core/apicall.js（api）、
//       core/utils.js（escapeHtml, showToast, setMessagesEmpty, isBrowserRuntimeForMain, updateModelInfo）、
//       chat/mobile.js（isMobileTreeMode, closeMobileTree）、chat/events.js（switchSession）、
//       chat/tabs.js（closeSessionTab, renderTabsBar）、chat/search.js（resetUserNav）、
//       views/project-config.js（openProjectConfig）、filebrowser/dir.js（openDirBrowserModal）
// 解环说明：updateModelInfo 经 core/utils.js 注册中心调用，不再静态 import render.js。
// ============================================================

import { api } from '../core/apicall.js';
import { store, currentDir } from '../core/state.js';
import { escapeHtml, showToast, setMessagesEmpty, isBrowserRuntimeForMain, updateModelInfo, updateTreeActiveSession } from '../core/utils.js';
import { isMobileTreeMode, closeMobileTree } from './mobile.js';
import { switchSession } from './events.js';
import { closeSessionTab, renderTabsBar } from './tabs.js';
import { resetUserNav } from './search.js';
import { openProjectConfig } from '../views/project-config.js';
import { openDirBrowserModal } from '../filebrowser/dir.js';
import { createBuildGate, createRecentlyDeleted, RECENTLY_DELETED_TTL_MS } from './tree-guard.js';

// ============================
// 项目树 — 构建、渲染、操作
// ============================

let treeSearchQuery = '';
let treeSearchDebounceTimer = null;
let treeSearchSnapshotTaken = false;

// 重建并发闸门 + 「本地已删会话」记账。
// 动机与设计见 tree-guard.js 顶部：删除会话时多条 session.deleted 会引发
// 多次整树重建（肉眼连续闪烁），且 async 重建可能乱序返回把渲染覆盖回去。
const treeGate = createBuildGate();
const recentlyDeleted = createRecentlyDeleted(RECENTLY_DELETED_TTL_MS, null);

/** 记下「这个会话已被本地删除」，让随之而来的 session.deleted 事件跳过整树重建。
 *
 *  节点此时已被 deleteSession 直接从 DOM 摘掉，重建只会闪一下。 */
export function markSessionDeletedLocally(id) {
    return recentlyDeleted.mark(id);
}

/** 该会话是否刚被本地删除（供 chat/events.js 判定是否跳过重建） */
export function wasSessionDeletedLocally(id) {
    return recentlyDeleted.has(id);
}

/** 构建会话树（从后端获取「目录 → 会话」两层结构）
 *
 *  并发请求会被闸门合并：执行期间再来的请求只补跑一次，且所有调用方
 *  await 到的是同一个结果。**所有入口都必须走这里**，不要直接调
 *  buildTreeOnce —— 绕过闸门等于把并发重建又放回来。 */
export async function buildTree() {
    if (!store.webRunning) return false;
    return treeGate(buildTreeOnce);
}

/** 单次重建：拉全量树 + 整树渲染。不对外。 */
async function buildTreeOnce() {
    try {
        // dirs 仍按既有绑定签名传给 Go（GetProjectTree(string)），但 v2 侧已忽略该参数：
        // 后端不传 directory 直接返回全部根会话，再在本地按 location.directory 分组。
        const knownDirs = JSON.parse(localStorage.getItem('oc-known-dirs') || '[]');
        const dirs = Array.isArray(knownDirs) ? knownDirs.slice() : [];
        const cur = currentDir();
        if (cur && !dirs.includes(cur)) dirs.unshift(cur);
        const json = await api.GetProjectTree(JSON.stringify(dirs));
        if (json && json !== '[]') {
            const tree = JSON.parse(json);
            window._lastProjectTree = tree;
            renderTree(tree);
            return true;
        } else {
            window._lastProjectTree = [];
            document.getElementById('ocTree').innerHTML = '<div class="oc-empty">暂无会话，新建会话后将自动出现</div>';
            return false;
        }
    } catch (_) {
        window._lastProjectTree = [];
        document.getElementById('ocTree').innerHTML = '<div class="oc-empty">加载树失败</div>';
        return false;
    }
}

/** 手动刷新会话树 */
export async function refreshTree() {
    const ok = await buildTree();
    showToast(ok ? '刷新成功' : '刷新失败', ok ? 'success' : 'error');
}

/** 渲染会话树 DOM（「目录 → 会话」两层：顶层即目录节点） */
export function renderTree(tree) {
    const container = document.getElementById('ocTree');
    /** 绑定「添加工作目录」按钮（空树与非空树分支共用） */
    const bindAddDirButton = () => {
        container.querySelectorAll('.oc-tree-add-dir').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await addDirectoryToProject();
            });
        });
    };

    if (!tree || tree.length === 0) {
        container.innerHTML = '<div class="oc-tree-add-dir-row"><button class="oc-tree-add-dir" title="添加工作目录">＋ 添加工作目录</button></div>'
            + '<div class="oc-empty">暂无会话</div>';
        bindAddDirButton();
        updateTreeSearchStatus(0, 0);
        return;
    }

    // 保存展开状态和滚动位置
    var expandedMap = {};
    container.querySelectorAll('.oc-tree-node').forEach(function(node) {
        var children = node.querySelector('.oc-tree-children');
        if (children && children.style.display === 'none') {
            var key = node.dataset.id || '';
            if (key) expandedMap[key] = true;
        }
    });
    var savedScrollTop = container.scrollTop;

    // 排序：顶层目录按标题排序（会话排序在目录内单独处理）
    tree.sort(function(a, b) {
        return (a.title || '').localeCompare(b.title || '');
    });

    window._sessionMap = {};
    let html = '';
    const toggleIcon = (expanded) => expanded ? '▼' : '⯈';

    // 树容器顶部：独立的「添加工作目录」操作行。
    // 原实现在 global 项目行上挂 ＋ 按钮，项目层取消后改为常驻操作行，保证入口仍可用。
    html += `<div class="oc-tree-add-dir-row"><button class="oc-tree-add-dir" title="添加工作目录">＋ 添加工作目录</button></div>`;

    /** 把 "YYYY-MM-DD HH:MM" 转成相对时间（如 "3分钟前"/"昨天"），无法解析时原样返回 */
    const formatRelativeTime = (t) => {
        if (!t) return '';
        const m = String(t).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
        if (!m) return '';
        const then = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
        const diff = Date.now() - then.getTime();
        if (diff < 0) return '';
        const min = Math.floor(diff / 60000);
        if (min < 1) return '刚刚';
        if (min < 60) return min + ' 分钟前';
        const hr = Math.floor(min / 60);
        if (hr < 24) return hr + ' 小时前';
        const day = Math.floor(hr / 24);
        if (day === 1) return '昨天';
        if (day < 7) return day + ' 天前';
        return t.slice(0, 10);
    };

    for (const dir of tree) {
        // 目录行：分组标题 + 会话计数徽章（沿用原目录行标记与类名）
        const dirSesCount = (dir.children || []).length;
        html += `<div class="oc-tree-node oc-tree-directory" data-id="${escapeHtml(dir.id)}">`;
        html += `<div class="oc-tree-row oc-tree-dir-row"><div class="oc-tree-toggle">${toggleIcon(true)}</div><span class="oc-tree-label oc-tree-dir-label" title="${escapeHtml(dir.title)}">${escapeHtml(dir.title)}</span><span class="oc-tree-dir-count">${dirSesCount}</span><button class="oc-tree-config" data-config-dir="${escapeHtml(dir.title)}" title="项目配置">⚙</button></div>`;
        html += `<div class="oc-tree-children">`;
        // 目录内会话按更新时间倒序，保持会话位置固定
        var sesList = (dir.children || []).slice();
        sesList.sort(function(a, b) {
            return (b.updatedAt || '').localeCompare(a.updatedAt || '');
        });
        for (const ses of sesList) {
            const fullTitle = ses.title;
            const updatedAt = ses.updatedAt || '';
            const sesDir = ses.directory || dir.title;
            window._sessionMap[ses.id] = { title: ses.title, directory: sesDir, updatedAt: updatedAt };
            // 会话卡片：图标 + 标题 + 相对时间 + 删除按钮；active 由 updateTreeActiveSession 维护
            html += `<div class="oc-tree-node oc-tree-session" data-session-id="${escapeHtml(ses.id)}">`;
            html += `<div class="oc-tree-indent"></div><span class="oc-tree-session-icon">💬</span><span class="oc-tree-label" title="${escapeHtml(ses.title+'\n📂 '+sesDir+'\n⏰ '+updatedAt)}">${escapeHtml(ses.title)}</span>`;
            if (updatedAt) html += `<span class="oc-tree-session-time">${escapeHtml(formatRelativeTime(updatedAt))}</span>`;
            html += `<div class="oc-tree-tooltip"><div class="oc-tree-tooltip-title">${escapeHtml(ses.title)}</div><div class="oc-tree-tooltip-row">📂 ${escapeHtml(sesDir)}</div><div class="oc-tree-tooltip-row">⏰ ${escapeHtml(updatedAt)}</div></div>`;
            html += `<button class="oc-tree-del" data-del-id="${escapeHtml(ses.id)}" title="删除会话">✕</button>`;
            html += `</div>`;
        }
        html += `</div></div>`;
    }
    container.innerHTML = html;

    // 恢复展开状态
    if (Object.keys(expandedMap).length) {
        container.querySelectorAll('.oc-tree-node').forEach(function(node) {
            var key = node.dataset.id || '';
            if (expandedMap[key]) {
                var children = node.querySelector('.oc-tree-children');
                if (children) {
                    children.style.display = 'none';
                    var toggle = node.querySelector('.oc-tree-toggle');
                    if (toggle) toggle.textContent = toggleIcon(false);
                }
            }
        });
    }
    container.scrollTop = savedScrollTop;

    // 点击目录行（非按钮区域）触发展开/折叠（项目层已取消，只剩目录行）
    container.querySelectorAll('.oc-tree-dir-row').forEach(row => {
        row.addEventListener('click', (e) => {
            // 排除按钮点击（添加目录、项目配置、删除）
            if (e.target.closest('button')) return;
            const node = row.closest('.oc-tree-node');
            const children = node.querySelector('.oc-tree-children');
            if (!children) return;
            const isOpen = children.style.display !== 'none';
            children.style.display = isOpen ? 'none' : '';
            var toggle = row.querySelector('.oc-tree-toggle');
            if (toggle) toggle.textContent = toggleIcon(!isOpen);
        });
    });

    // 小箭头单独绑定（保留，防止事件冒泡问题）
    container.querySelectorAll('.oc-tree-toggle').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const node = el.closest('.oc-tree-node');
            const children = node.querySelector('.oc-tree-children');
            if (children) {
                const isOpen = children.style.display !== 'none';
                children.style.display = isOpen ? 'none' : '';
                el.textContent = toggleIcon(!isOpen);
            }
        });
    });

    container.querySelectorAll('.oc-tree-session').forEach(el => {
        el.addEventListener('click', async (e) => {
            if (e.target.closest('.oc-tree-del')) return;
            const sid = el.dataset.sessionId;
            if (sid && sid !== store.currentSessionId) {
                if (isMobileTreeMode()) {
                    closeMobileTree();
                }
                await switchSession(sid);
            }
            // 同步树节点高亮（switchSession → selectSession 内部会调 updateTreeActiveSession，这里兜底）
            updateTreeActiveSession();
            if (isMobileTreeMode()) {
                closeMobileTree();
            }
        });
    });
    bindAddDirButton();
    container.querySelectorAll('.oc-tree-del').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const sid = btn.dataset.delId;
            if (!sid) return;
            await deleteSession(sid);
        });
    });
    container.querySelectorAll('.oc-tree-config').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const dir = btn.dataset.configDir;
            if (dir) {
                openProjectConfig(dir);
            }
        });
    });

    applyTreeSearchFilter();
}

export function updateTreeSearchStatus(matchCount, totalCount) {
    var countEl = document.getElementById('ocTreeSearchCount');
    var clearBtn = document.getElementById('ocTreeSearchClear');
    if (countEl) {
        if (!treeSearchQuery) {
            countEl.textContent = totalCount > 0 ? ('共 ' + totalCount + ' 项') : '-';
        } else {
            countEl.textContent = matchCount + '/' + totalCount;
        }
    }
    if (clearBtn) {
        clearBtn.disabled = !treeSearchQuery;
    }
}

export function captureTreeSearchSnapshot() {
    if (treeSearchSnapshotTaken) return;
    document.querySelectorAll('#ocTree .oc-tree-children').forEach(function(children) {
        children.dataset.searchPrevDisplay = children.style.display || '';
    });
    treeSearchSnapshotTaken = true;
}

export function restoreTreeSearchSnapshot() {
    document.querySelectorAll('#ocTree .oc-tree-children').forEach(function(children) {
        if (children.dataset.searchPrevDisplay !== undefined) {
            children.style.display = children.dataset.searchPrevDisplay;
            delete children.dataset.searchPrevDisplay;
        }
    });
    treeSearchSnapshotTaken = false;
}

export function applyTreeSearchFilter() {
    var container = document.getElementById('ocTree');
    if (!container) return;
    var nodes = Array.prototype.slice.call(container.querySelectorAll('.oc-tree-node'));
    var totalCount = container.querySelectorAll('.oc-tree-label').length;

    nodes.forEach(function(node) {
        node.classList.remove('oc-tree-search-hit', 'oc-tree-search-path', 'oc-tree-search-hidden');
    });

    if (!treeSearchQuery) {
        restoreTreeSearchSnapshot();
        nodes.forEach(function(node) {
            var toggle = node.querySelector(':scope > .oc-tree-row .oc-tree-toggle');
            var children = node.querySelector(':scope > .oc-tree-children');
            if (toggle && children) {
                toggle.textContent = children.style.display === 'none' ? '⯈' : '▼';
            }
        });
        updateTreeSearchStatus(0, totalCount);
        return;
    }

    captureTreeSearchSnapshot();
    var query = treeSearchQuery.toLowerCase();
    var matchCount = 0;

    function filterNode(node) {
        var label = node.querySelector(':scope > .oc-tree-row .oc-tree-label, :scope > .oc-tree-label');
        var labelText = label ? String(label.textContent || '').toLowerCase() : '';
        var selfMatched = !!labelText && labelText.indexOf(query) >= 0;
        var descendantsMatched = false;
        var children = node.querySelector(':scope > .oc-tree-children');
        var toggle = node.querySelector(':scope > .oc-tree-row .oc-tree-toggle');

        if (children) {
            Array.prototype.slice.call(children.children || []).forEach(function(child) {
                if (child.classList && child.classList.contains('oc-tree-node')) {
                    if (filterNode(child)) {
                        descendantsMatched = true;
                    }
                }
            });
        }

        var visible = selfMatched || descendantsMatched;
        if (!visible) {
            node.classList.add('oc-tree-search-hidden');
        } else if (selfMatched) {
            node.classList.add('oc-tree-search-hit');
            matchCount += 1;
        } else {
            node.classList.add('oc-tree-search-path');
        }

        if (children) {
            children.style.display = visible ? '' : 'none';
            if (toggle) {
                toggle.textContent = visible ? '▼' : '⯈';
            }
        }
        return visible;
    }

    Array.prototype.slice.call(container.children || []).forEach(function(child) {
        if (child.classList && child.classList.contains('oc-tree-node')) {
            filterNode(child);
        }
    });

    if (!matchCount) {
        container.querySelectorAll('.oc-tree-node').forEach(function(node) {
            node.classList.add('oc-tree-search-hidden');
        });
        container.insertAdjacentHTML('beforeend', '<div class="oc-empty oc-tree-search-empty">未找到匹配项</div>');
    }

    var empty = container.querySelector('.oc-tree-search-empty');
    if (empty && matchCount) {
        empty.remove();
    }
    updateTreeSearchStatus(matchCount, totalCount);
}

export function setTreeSearchQuery(value) {
    treeSearchQuery = String(value || '').trim();
    var empty = document.querySelector('#ocTree .oc-tree-search-empty');
    if (empty) empty.remove();
    applyTreeSearchFilter();
}

export function clearTreeSearch() {
    var input = document.getElementById('ocTreeSearchInput');
    if (input) {
        input.value = '';
    }
    setTreeSearchQuery('');
}

export function initTreeSearch() {
    var input = document.getElementById('ocTreeSearchInput');
    var clearBtn = document.getElementById('ocTreeSearchClear');
    if (!input || input.dataset.boundTreeSearch === '1') return;

    input.dataset.boundTreeSearch = '1';
    input.addEventListener('input', function(e) {
        clearTimeout(treeSearchDebounceTimer);
        treeSearchDebounceTimer = setTimeout(function() {
            setTreeSearchQuery(e.target.value || '');
        }, 200);
    });
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            clearTreeSearch();
        }
    });
    if (clearBtn) {
        clearBtn.addEventListener('click', clearTreeSearch);
    }
    updateTreeSearchStatus(0, 0);
}

initTreeSearch();

/** 记住用户添加过的目录（存 localStorage 以便下次自动加载） */
export function rememberKnownDir(dir) {
    if (!dir) return;
    try {
        const dirs = JSON.parse(localStorage.getItem('oc-known-dirs') || '[]');
        if (!dirs.includes(dir)) {
            dirs.push(dir);
            localStorage.setItem('oc-known-dirs', JSON.stringify(dirs));
        }
    } catch (_) {}
}

/** 检测指定目录下会话树中是否有会话记录（两层：顶层即目录节点） */
export function treeHasSessionsForDir(tree, dir) {
    const target = String(dir || '').replace(/\\+$/).toLowerCase();
    for (const node of (tree || [])) {
        const title = String(node.title || '').replace(/\\+$/).toLowerCase();
        if (title === target && (node.children || []).length > 0) {
            return true;
        }
    }
    return false;
}

/** 添加工作目录：选择已有会话的目录并加载；无会话记录时仅 toast 提示，不引导新建会话 */
/** 选择目录（供「新建会话 / 添加工作目录 / 移动会话」等入口复用）。
 *  Web 端 → 站内目录浏览器；桌面端 → 系统原生目录对话框。用户取消时返回 ''。 */
export async function pickDirectory() {
    if (isBrowserRuntimeForMain()) {
        return (await openDirBrowserModal()) || '';
    }
    return (await api.OpenDirectoryDialog()) || '';
}

export async function addDirectoryToProject() {
    if (!store.webRunning) return;
    try {
        let dir = await pickDirectory();
        if (!dir) return;
        rememberKnownDir(dir);
        const ok = await buildTree();
        if (!ok || !treeHasSessionsForDir(window._lastProjectTree, dir)) {
            showToast('该目录下没有会话记录', 'warning');
            return;
        }
        showToast('已加载目录会话: ' + dir, 'success');
    } catch (e) {
        showToast('选择目录失败: ' + (e.message || e), 'error');
    }
}

// ============================
// 会话 CRUD
// ============================

/** 加载会话列表（刷新树的简易入口） */
export async function loadSessions() {
    if (!store.webRunning) return;
    await buildTree();
}

/** 删除指定会话及相关缓存 */
export async function deleteSession(id) {
    if (!id) return;
    if (!confirm('确定要删除该会话吗？此操作不可撤销。')) return;
    try {
        // 记一笔，让随之而来的 session.deleted 事件跳过整树重建。
        // 节点下方已直接从 DOM 摘掉，重建只会闪一下。
        markSessionDeletedLocally(id);
        await api.OpenCodeCall('DELETE', `/api/session/${encodeURIComponent(id)}`);
        showToast('已删除', 'success');
        if (id === store.currentSessionId) {
            store.currentSessionId = '';
            // 旧会话缓存由下方 closeSessionTab(id) 统一清理（tabs.js 内 delete messageCache[id]）。
            // 此处原先写入 messageCache[currentSessionId]，但 currentSessionId 已置空，
            // 实际只产生 messageCache[''] 这个无效键，属无效代码，故删除。
            store.expandedParts = {};
            setMessagesEmpty('选择会话后查看消息，或输入内容创建新会话');
            document.getElementById('ocChatTitle').textContent = '未选择会话';
            updateModelInfo(null);
        }
        // 从 DOM 移除会话节点，避免整树重建闪烁
        var container = document.getElementById('ocTree');
        if (container) {
            var sessions = container.querySelectorAll('.oc-tree-session');
            for (var i = 0; i < sessions.length; i++) {
                if (sessions[i].dataset.sessionId === id) {
                    sessions[i].remove();
                    break;
                }
            }
        }
        delete window._sessionMap[id];
        // 清理对应 Tab（若被删除的是活动 Tab，自动切到相邻 Tab）
        closeSessionTab(id);
    } catch (e) {
        showToast('删除失败: ' + (e.message || e), 'error');
    }
}

/** 创建新会话（打开目录选择器，在首次发送时创建）。
 *  如果指定了 dir 字符串则跳过目录选择器。 */
export async function createNewSession(dir) {
    if (!store.webRunning) return;
    try {
        var hasDirParam = typeof dir === 'string' && dir.length > 0;
        if (!hasDirParam) {
            dir = await pickDirectory();
            if (!dir) return;
        }
        store.pendingWorkDir = dir;
        if (isMobileTreeMode()) {
            closeMobileTree();
        }
        store.currentSessionId = '';
        store.activeTabId = '';   // 不再指向旧 tab
        store.sessionStatuses = {};
        store.sessionErrors = {};
        store.subtaskSummaries = [];
        store.detailMessageCache = {};
        document.getElementById('ocChatTitle').textContent = '新建会话 @ ' + dir;
        // 隐藏所有已打开 tab 容器（保留其内容，切回时还在），显示新建会话占位提示；
        // 不再直接写 getActiveMessagesEl().innerHTML，否则会清空当前活动 tab 的会话内容
        var poolEl = document.getElementById('ocMessagesPool');
        if (poolEl) {
            poolEl.querySelectorAll('.oc-messages-tab').forEach(function(c) {
                c.classList.remove('active');
                c.style.display = 'none';
            });
            var ph = poolEl.querySelector('.oc-new-session-placeholder');
            if (!ph) {
                ph = document.createElement('div');
                ph.className = 'oc-new-session-placeholder oc-empty';
                poolEl.appendChild(ph);
            }
            ph.style.display = 'block';
            ph.textContent = '输入内容后 Enter 发送，会话将在首次发送时创建';
        }
        // 刷新 Tab 栏激活态（activeTabId 已置空，所有 tab 显示为非激活）
        renderTabsBar();
        // 重置用户消息导航索引（旧会话的定位索引不再适用）
        resetUserNav();
        document.getElementById('ocPrompt').value = '';
        document.getElementById('ocPrompt').focus();
    } catch (e) {
        showToast('选择目录失败: ' + (e.message || e), 'error');
    }
}

// ===== 会话树右键菜单 =====

/** 当前右键菜单关联的数据 */
var treeContextData = null;

/** 显示右键菜单 */
export function showTreeContextMenu(e, type, data) {
    e.preventDefault();
    e.stopPropagation();
    treeContextData = { type: type, data: data };
    var menu = document.getElementById('ocTreeContextMenu');
    if (!menu) return;
    menu.querySelectorAll('.oc-tree-context-menu-item').forEach(function(item) {
        var action = item.dataset.action;
        if (type === 'dir') {
            // 「导入会话」是全局动作，挂在目录行上保持入口可达
            item.style.display = (action === 'new-session' || action === 'project-config' || action === 'import') ? '' : 'none';
        } else if (type === 'session') {
            item.style.display = (action === 'rename' || action === 'delete'
                || action === 'export' || action === 'move') ? '' : 'none';
        } else {
            item.style.display = 'none';
        }
    });
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.style.display = 'block';
}

/** 隐藏右键菜单 */
export function hideTreeContextMenu() {
    var menu = document.getElementById('ocTreeContextMenu');
    if (menu) menu.style.display = 'none';
    treeContextData = null;
}

/** 初始化右键菜单事件 */
export function initTreeContextMenu() {
    var tree = document.getElementById('ocTree');
    if (!tree) return;
    tree.addEventListener('contextmenu', function(e) {
        var dirRow = e.target.closest('.oc-tree-dir-row');
        if (dirRow) {
            // 从 config 按钮的 data-config-dir 取纯净目录路径，避免获取到标签里的 📂 图标
            var configBtn = dirRow.querySelector('.oc-tree-config');
            var title = configBtn ? configBtn.dataset.configDir : '';
            if (!title) {
                var label = dirRow.querySelector('.oc-tree-label');
                title = label ? label.textContent.replace(/^📂\s*/, '').trim() : '';
            }
            showTreeContextMenu(e, 'dir', { title: title });
            return;
        }
        var sesDiv = e.target.closest('.oc-tree-session');
        if (sesDiv) {
            var sid = sesDiv.dataset.sessionId;
            if (!sid) return;
            showTreeContextMenu(e, 'session', { sid: sid });
            return;
        }
    });

    var menu = document.getElementById('ocTreeContextMenu');
    if (!menu) return;
    menu.querySelectorAll('.oc-tree-context-menu-item').forEach(function(item) {
        item.addEventListener('click', function() {
            var action = item.dataset.action;
            if (!treeContextData) return;
            var type = treeContextData.type;
            var data = treeContextData.data;
            hideTreeContextMenu();
            if (type === 'dir' && action === 'new-session') {
                createNewSession(data.title);
            } else if (type === 'dir' && action === 'project-config') {
                openProjectConfig(data.title);
            } else if (type === 'session' && action === 'rename') {
                renameSession(data.sid);
            } else if (type === 'session' && action === 'delete') {
                deleteSession(data.sid);
            } else if (type === 'session' && action === 'export') {
                exportSession(data.sid);
            } else if (type === 'session' && action === 'move') {
                moveSessionDialog(data.sid);
            } else if (action === 'import') {
                importSessionDialog();
            }
        });
    });

    document.addEventListener('click', function(e) {
        if (menu.style.display !== 'none' && !menu.contains(e.target)) {
            hideTreeContextMenu();
        }
    });
}

/** 重命名会话 */
export async function renameSession(sid) {
    if (!sid) return;
    var info = window._sessionMap && window._sessionMap[sid];
    var oldTitle = (info && info.title) || sid;
    var newTitle = prompt('请输入新名称：', oldTitle);
    if (!newTitle || newTitle.trim() === '' || newTitle.trim() === oldTitle) return;
    newTitle = newTitle.trim();
    try {
        await api.OpenCodeCall('PATCH', '/api/session/' + encodeURIComponent(sid), { title: newTitle });
        showToast('已重命名', 'success');
        // 同步更新当前会话标题
        if (sid === store.currentSessionId) {
            document.getElementById('ocChatTitle').textContent = newTitle;
        }
        // 同步更新已打开 Tab 的标题（tab 标题取自 store.openTabs）
        var tab = store.openTabs.find(function(t) { return t.sessionID === sid; });
        if (tab) tab.title = newTitle;
        renderTabsBar();
        await buildTree();
    } catch (e) {
        showToast('重命名失败: ' + (e.message || e), 'error');
    }
}

/** 导出会话为 JSON 文件。
 *
 *  v2 的导出端点在 /api/experimental 下（服务端自标 experimental，路径可能变）。
 *  导出体积可能很大（含全部消息），因此落盘而不是塞进前端状态。
 *  服务端返回失败时统一是 {error: "..."}，必须先判这个再解析，
 *  否则会把错误 JSON 当导出内容写进文件。 */
export async function exportSession(sid) {
    if (!sid) return;
    try {
        var raw = await api.ExportSession(sid, false);
        if (typeof raw !== 'string' || !raw) {
            showToast('导出失败：服务端未返回内容', 'error');
            return;
        }
        var parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            showToast('导出内容不是合法 JSON', 'error');
            return;
        }
        if (parsed && parsed.error) {
            showToast('导出失败：' + parsed.error, 'error');
            return;
        }
        var info = (parsed && parsed.data && parsed.data.info) || {};
        var title = (info.title || sid).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
        var blob = new Blob([raw], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = title + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('已导出 ' + title + '.json', 'success');
    } catch (e) {
        showToast('导出失败: ' + (e.message || e), 'error');
    }
}

/** 移动会话到另一个项目目录。
 *
 *  v2 的 move 目标是**项目目录**，不是目录树里的子路径。
 *  会话若正在运行，服务端可能拒绝（实测未验证 move 在运行态的行为，
 *  失败时如实回传服务端原因，不做静默重试）。 */
export async function moveSessionDialog(sid) {
    if (!sid) return;
    // 目录选择与「新建会话」完全一致：Web 端站内目录浏览器、桌面端原生目录对话框；
    // 用户取消（返回空）则中止移动。
    var target = await pickDirectory();
    if (!target) return;
    target = String(target).trim();
    if (!target) return;
    try {
        var res = await api.MoveSession(sid, target, '');
        if (res && res.error) {
            showToast('移动失败：' + res.error, 'error');
            return;
        }
        if (res && res.success === false) {
            showToast('移动失败：HTTP ' + res.status, 'error');
            return;
        }
        showToast('会话已移动', 'success');
        // 移动是服务端异步落库：紧跟其后的一次建树常早于数据更新，表现为"树没变化"。
        // 因此先刷一次，再在稍后补刷一次（与其它异步变更的处理方式一致）。
        await buildTree();
        setTimeout(function() { buildTree(); }, 1200);
    } catch (e) {
        showToast('移动失败: ' + (e.message || e), 'error');
    }
}

/** 导入会话（从导出的 JSON 文件）。
 *
 *  v2 的导入端点在 /api/experimental 下，服务端要求 info 与 messages 都存在；
 *  若导出数据带 parentID 而父会话不存在，服务端返回 409——后端已在本地
 *  拦下这种情况并给出可操作提示（先导父会话），这里只负责把错误如实展示。
 *
 *  导入后刷新会话树，让新会话立即可见。 */
export async function importSessionDialog() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    document.body.appendChild(input);

    var file = await new Promise(function(resolve) {
        input.onchange = function() { resolve(input.files && input.files[0]); };
        // 用户取消时 change 不会触发；用 focus 兜底避免 input 永久残留
        window.addEventListener('focus', function once() {
            window.removeEventListener('focus', once);
            setTimeout(function() { if (!input.files || !input.files.length) resolve(null); }, 800);
        }, { once: true });
        input.click();
    });

    document.body.removeChild(input);
    if (!file) return;

    try {
        var text = await file.text();
        var res = await api.ImportSession(text);
        if (res && res.error) {
            showToast('导入失败：' + res.error, 'error');
            return;
        }
        if (res && res.success === false) {
            showToast('导入失败：HTTP ' + res.status, 'error');
            return;
        }
        showToast('导入成功', 'success');
        await buildTree();
    } catch (e) {
        showToast('导入失败: ' + (e.message || e), 'error');
    }
}

initTreeContextMenu();

