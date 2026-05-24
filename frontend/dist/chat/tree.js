// ============================================================
// chat-tree.js — 项目树 & 目录浏览器
// 依赖：core/state.js（webRunning, currentSessionId, expandedParts, subtaskSummaries, detailMessageCache）、
//       chat/service.js（api.OpenCodeCall）、chat/mobile.js（isMobileTreeMode, closeMobileTree）、core/utils.js（escapeHtml, showToast）
// ============================================================

// ============================
// 项目树 — 构建、渲染、操作
// ============================

/** 构建项目树（从后端获取项目→目录→会话三层结构） */
async function buildTree() {
    if (!webRunning) return;
    try {
        const knownDirs = JSON.parse(localStorage.getItem('oc-known-dirs') || '[]');
        const json = await api.GetProjectTree(JSON.stringify(knownDirs));
        if (json && json !== '[]') {
            const tree = JSON.parse(json);
            window._lastProjectTree = tree;
            renderTree(tree);
            return true;
        } else {
            window._lastProjectTree = [];
            document.getElementById('ocTree').innerHTML = '<div class="oc-empty">暂无项目，新建会话后将自动出现</div>';
            return false;
        }
    } catch (_) {
        window._lastProjectTree = [];
        document.getElementById('ocTree').innerHTML = '<div class="oc-empty">加载树失败</div>';
        return false;
    }
}

/** 手动刷新项目树 */
async function refreshTree() {
    const ok = await buildTree();
    showToast(ok ? '刷新成功' : '刷新失败', ok ? 'success' : 'error');
}

/** 渲染项目树 DOM */
function renderTree(tree) {
    const container = document.getElementById('ocTree');
    if (!tree || tree.length === 0) {
        container.innerHTML = '<div class="oc-empty">暂无项目</div>';
        return;
    }
    window._sessionMap = {};
    let html = '';
    for (const proj of tree) {
        html += `<div class="oc-tree-node oc-tree-project" data-id="${escapeHtml(proj.id)}">`;
        html += `<div class="oc-tree-row oc-tree-project-row"><div class="oc-tree-toggle">▼</div><span class="oc-tree-label" title="${escapeHtml(proj.title)}">📁 ${escapeHtml(proj.title)}</span><button class="oc-tree-add-dir" data-project-id="${escapeHtml(proj.id)}" title="添加工作目录">＋</button></div>`;
        html += `<div class="oc-tree-children">`;
        for (const dir of (proj.children || [])) {
            html += `<div class="oc-tree-node oc-tree-directory" data-id="${escapeHtml(dir.id)}">`;
            html += `<div class="oc-tree-row oc-tree-dir-row"><div class="oc-tree-toggle">▼</div><span class="oc-tree-label" title="${escapeHtml(dir.title)}">📂 ${escapeHtml(dir.title)}</span><button class="oc-tree-config" data-config-dir="${escapeHtml(dir.title)}" title="项目配置">⚙</button></div>`;
            html += `<div class="oc-tree-children">`;
            for (const ses of (dir.children || [])) {
                const fullTitle = ses.title;
                const updatedAt = ses.updatedAt || '';
                const sesDir = ses.directory || dir.title;
                window._sessionMap[ses.id] = { title: ses.title, directory: sesDir, updatedAt: updatedAt };
                html += `<div class="oc-tree-node oc-tree-session" data-session-id="${escapeHtml(ses.id)}">`;
                html += `<div class="oc-tree-indent"></div><span class="oc-tree-label" title="${escapeHtml(ses.title+'\n📂 '+sesDir+'\n⏰ '+updatedAt)}">💬 ${escapeHtml(ses.title)}</span>`;
                html += `<div class="oc-tree-tooltip"><div class="oc-tree-tooltip-title">${escapeHtml(ses.title)}</div><div class="oc-tree-tooltip-row">📂 ${escapeHtml(sesDir)}</div><div class="oc-tree-tooltip-row">⏰ ${escapeHtml(updatedAt)}</div></div>`;
                html += `<button class="oc-tree-del" data-del-id="${escapeHtml(ses.id)}" title="删除会话">✕</button>`;
                html += `</div>`;
            }
            html += `</div></div>`;
        }
        html += `</div></div>`;
    }
    container.innerHTML = html;

    container.querySelectorAll('.oc-tree-toggle').forEach(el => {
        el.addEventListener('click', () => {
            const node = el.closest('.oc-tree-node');
            const children = node.querySelector('.oc-tree-children');
            if (children) {
                const isOpen = children.style.display !== 'none';
                children.style.display = isOpen ? 'none' : '';
                el.textContent = isOpen ? '▶' : '▼';
            }
        });
    });

    container.querySelectorAll('.oc-tree-session').forEach(el => {
        el.addEventListener('click', async (e) => {
            if (e.target.closest('.oc-tree-del')) return;
            const sid = el.dataset.sessionId;
            if (sid && sid !== currentSessionId) {
                if (isMobileTreeMode()) {
                    closeMobileTree();
                }
                await switchSession(sid);
            }
            if (isMobileTreeMode()) {
                closeMobileTree();
            }
        });
    });
    container.querySelectorAll('.oc-tree-add-dir').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await addDirectoryToProject(btn.dataset.projectId || '');
        });
    });
    container.querySelectorAll('.oc-tree-del').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const sid = btn.dataset.delId;
            if (!sid) return;
            await deleteSession(sid);
            await buildTree();
        });
    });
    container.querySelectorAll('.oc-tree-config').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const dir = btn.dataset.configDir;
            if (dir && typeof openProjectConfig === 'function') {
                openProjectConfig(dir);
            }
        });
    });
}

/** 记住用户添加过的目录（存 localStorage 以便下次自动加载） */
function rememberKnownDir(dir) {
    if (!dir) return;
    try {
        const dirs = JSON.parse(localStorage.getItem('oc-known-dirs') || '[]');
        if (!dirs.includes(dir)) {
            dirs.push(dir);
            localStorage.setItem('oc-known-dirs', JSON.stringify(dirs));
        }
    } catch (_) {}
}

/** 检测指定目录下项目树中是否有会话记录 */
function treeHasSessionsForDir(tree, dir) {
    const target = String(dir || '').replace(/\\+$/).toLowerCase();
    for (const proj of (tree || [])) {
        for (const child of (proj.children || [])) {
            const title = String(child.title || '').replace(/\\+$/).toLowerCase();
            if (title === target && (child.children || []).length > 0) {
                return true;
            }
        }
    }
    return false;
}

/** 向项目中添加工作目录 */
async function addDirectoryToProject() {
    if (!webRunning) return;
    try {
        if (isBrowserRuntimeForMain()) {
            const dir = await openDirBrowserModal();
            if (!dir) return;
            rememberKnownDir(dir);
            const ok = await buildTree();
            if (!ok || !treeHasSessionsForDir(window._lastProjectTree, dir)) {
                document.getElementById('ocChatTitle').textContent = '工作目录 @ ' + dir;
                document.getElementById('ocMessages').innerHTML = '<div class="oc-empty">该目录下没有会话记录，请先在该目录下新建会话</div>';
                showToast('该目录下没有会话记录，请先在该目录下新建会话', 'warning');
                return;
            }
            showToast('已加载目录会话: ' + dir, 'success');
            return;
        }
        const dir = await api.OpenDirectoryDialog();
        if (!dir) return;
        rememberKnownDir(dir);
        const ok = await buildTree();
        if (!ok || !treeHasSessionsForDir(window._lastProjectTree, dir)) {
            document.getElementById('ocChatTitle').textContent = '工作目录 @ ' + dir;
            document.getElementById('ocMessages').innerHTML = '<div class="oc-empty">该目录下没有会话记录，请先在该目录下新建会话</div>';
            showToast('该目录下没有会话记录，请先在该目录下新建会话', 'warning');
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
async function loadSessions() {
    if (!webRunning) return;
    await buildTree();
}

/** 防抖刷新项目树（2s 内多次触发只执行最后一次） */
function debounceRefreshTree() {
    clearTimeout(sessionRefreshTimer);
    sessionRefreshTimer = setTimeout(() => {
        if (webRunning) buildTree();
    }, 2000);
}

/** 删除指定会话及相关缓存 */
async function deleteSession(id) {
    if (!id) return;
    if (!confirm('确定要删除该会话吗？此操作不可撤销。')) return;
    try {
        await api.OpenCodeCall('DELETE', `/session/${encodeURIComponent(id)}`);
        showToast('已删除', 'success');
        if (id === currentSessionId) {
            currentSessionId = '';
            messageCache[currentSessionId] = null;
            expandedParts = {};
            document.getElementById('ocMessages').innerHTML = '<div class="oc-empty">选择会话后查看消息，或输入内容创建新会话</div>';
            document.getElementById('ocChatTitle').textContent = '未选择会话';
            updateModelInfo(null);
        }
        await loadSessions();
    } catch (e) {
        showToast('删除失败: ' + (e.message || e), 'error');
    }
}

/** 创建新会话（打开目录选择器，在首次发送时创建） */
async function createNewSession() {
    if (!webRunning) return;
    try {
        let dir = '';
        if (isBrowserRuntimeForMain()) {
            dir = await openDirBrowserModal();
        } else {
            dir = await api.OpenDirectoryDialog();
        }
        if (!dir) return;
        pendingWorkDir = dir;
        if (isMobileTreeMode()) {
            closeMobileTree();
        }
        currentSessionId = '';
        sessionStatuses = {};
        sessionErrors = {};
        subtaskSummaries = [];
        detailMessageCache = {};
        document.getElementById('ocChatTitle').textContent = '新建会话 @ ' + dir;
        document.getElementById('ocMessages').innerHTML = '<div class="oc-empty">输入内容后 Enter 发送，会话将在首次发送时创建</div>';
        document.getElementById('ocDiff').innerHTML = '<div class="oc-empty">选择会话后查看变更</div>';
        document.getElementById('ocPrompt').value = '';
        document.getElementById('ocPrompt').focus();
    } catch (e) {
        showToast('选择目录失败: ' + (e.message || e), 'error');
    }
}

/** 用目录创建新会话（Wails API 版本，立即创建）*/
async function newSessionWithDir() {
    if (!webRunning) return;
    try {
        const dir = await api.OpenDirectoryDialog();
        if (!dir) return;
        const session = await createSessionWithDir(dir);
        currentSessionId = session.id || session.ID;
        await buildTree();
        await loadMessages();
        showToast('会话已创建: ' + dir, 'success');
    } catch (e) {
        showToast('创建失败: ' + (e.message || e), 'error');
    }
}


