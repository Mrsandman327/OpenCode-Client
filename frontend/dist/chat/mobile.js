// ============================================================
// OpenCode 管理中心 - 移动端树切换
// ============================================================

/** 判断当前是否为移动端窄屏模式（宽度 ≤ 800px） */
export function isMobileTreeMode() {
    return window.matchMedia('(max-width: 800px)').matches;
}

/** 打开移动端项目树（仅在移动端模式下生效） */
export function openMobileTree() {
    if (!isMobileTreeMode()) return;
    document.getElementById('webContainer').classList.add('mobile-tree-open');
}

/** 关闭移动端项目树 */
export function closeMobileTree() {
    document.getElementById('webContainer').classList.remove('mobile-tree-open');
}

/** 切换移动端项目树的打开/关闭状态 */
export function toggleMobileTree() {
    if (!isMobileTreeMode()) return;
    const client = document.getElementById('webContainer');
    if (client.classList.contains('mobile-tree-open')) {
        closeMobileTree();
        return;
    }
    openMobileTree();
}

/** 切换左侧会话栏的显示/隐藏（桌面端折叠加按钮图标） */
export function toggleSessions() {
    if (isMobileTreeMode()) {
        toggleMobileTree();
        return;
    }
    const client = document.getElementById('webContainer');
    const btn = document.getElementById('btnToggleSessions');
    const hidden = client.classList.toggle('hide-left');
    btn.textContent = hidden ? '▶' : '◀';
    btn.title = hidden ? '显示会话栏' : '隐藏会话栏';
}

/** 切换右侧信息栏的显示/隐藏（桌面端折叠加按钮图标） */
export function toggleSidepanel() {
    if (isMobileTreeMode()) return;
    const client = document.getElementById('webContainer');
    const btn = document.getElementById('btnToggleSidepanel');
    const hidden = client.classList.toggle('hide-right');
    btn.textContent = hidden ? '◀' : '▶';
    btn.title = hidden ? '显示信息栏' : '隐藏信息栏';
}
