// ============================================================
// OpenCode 管理中心 - 侧边栏导航
// 依赖：core/utils.js（$$）、chat/service.js（checkWebStatus）；
//       views/omo-config.js（loadModelConfig）、views/skill-manager.js（loadSkillsData）、
//       views/commands.js（loadCommands）——views 层尚未改造，保留全局守卫调用
// ============================================================

import { $$ } from '../core/utils.js';
import { checkWebStatus } from './service.js';
import { loadModelConfig } from '../views/omo-config.js';
import { loadSkillsData } from '../views/skill-manager.js';
import { loadCommands } from '../views/commands.js';

export function switchView(viewId) {
    // 更新导航项高亮
    $$('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.view === viewId);
    });

    // 切换视图面板
    $$('.view-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === viewId);
    });

    // 延迟加载各视图数据
    if (viewId === 'view-omo') {
        loadModelConfig();
    } else if (viewId === 'view-skills') {
        loadSkillsData();
    } else if (viewId === 'view-commands') {
        loadCommands();
    } else if (viewId === 'view-opencode') {
        // 检查 web 状态
        checkWebStatus();
    }
}

// 侧边栏点击事件（事件委托）
document.getElementById('sidebar').addEventListener('click', (e) => {
    const navItem = e.target.closest('.nav-item');
    if (navItem && navItem.dataset.view) {
        switchView(navItem.dataset.view);
    }
});

const SIDEBAR_COLLAPSED_KEY = 'sidebarCollapsed';

export function applySidebarCollapseState(collapsed) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    sidebar.classList.toggle('collapsed', collapsed);
}

export function loadSidebarCollapseState() {
    let collapsed = true;
    try {
        const saved = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
        if (saved != null) {
            collapsed = saved === 'true';
        }
    } catch (_) {}
    applySidebarCollapseState(collapsed);
}

export function toggleSidebarCollapse() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const nextCollapsed = !sidebar.classList.contains('collapsed');
    try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(nextCollapsed));
    } catch (_) {}
    applySidebarCollapseState(nextCollapsed);
}

const appTitle = document.getElementById('appTitle');
if (appTitle) {
    appTitle.addEventListener('click', toggleSidebarCollapse);
}

loadSidebarCollapseState();
