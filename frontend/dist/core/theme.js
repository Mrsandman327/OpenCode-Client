// ============================================================
// OpenCode 管理中心 - 主题切换
// ============================================================
export const THEME_KEY = 'oc-manager-theme';
export const NETWORK_CONFIG_KEY = 'oc-manager-proxy-config';

export function getTheme() {
    return localStorage.getItem(THEME_KEY) || 'dark';
}

export function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
    updateThemeIcon(theme);
    if (typeof window.syncProjectConfigEditorTheme === 'function') {
        window.syncProjectConfigEditorTheme(theme);
    }
    if (typeof window.syncFileBrowserEditorTheme === 'function') {
        window.syncFileBrowserEditorTheme(theme);
    }
}

export function toggleTheme() {
    const current = getTheme();
    setTheme(current === 'dark' ? 'light' : 'dark');
}

function updateThemeIcon(theme) {
    const btn = document.getElementById('btnTheme');
    if (btn) btn.textContent = theme === 'dark' ? '🌙' : '☀️';
}

setTheme(getTheme());
