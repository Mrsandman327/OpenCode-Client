// ============================================================
// OpenCode 管理中心 - 主题切换
// ============================================================
const THEME_KEY = 'oc-manager-theme';
const NETWORK_CONFIG_KEY = 'oc-manager-proxy-config';

function getTheme() {
    return localStorage.getItem(THEME_KEY) || 'dark';
}

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
    updateThemeIcon(theme);
    updateHighlightTheme(theme);
}

function updateHighlightTheme(theme) {
    var light = document.getElementById('highlightLight');
    var dark = document.getElementById('highlightDark');
    if (light) light.disabled = (theme !== 'light');
    if (dark) dark.disabled = (theme !== 'dark');
}

function toggleTheme() {
    const current = getTheme();
    setTheme(current === 'dark' ? 'light' : 'dark');
}

function updateThemeIcon(theme) {
    const btn = document.getElementById('btnTheme');
    if (btn) btn.textContent = theme === 'dark' ? '🌙' : '☀️';
}

setTheme(getTheme());
