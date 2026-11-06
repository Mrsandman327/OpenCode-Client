// ============================================================
// 文件浏览器入口（主工作台弹窗 与 独立窗口 共用）
// 主工作台：由 main.js 导入并调用 bindFileBrowserEvents()
// 独立窗口：index.html 在入口处分流，直接加载本文件并调用 initStandaloneFileBrowser()，
//          不加载 main.js 及其依赖（会话树、服务探测、消息面板、配置弹窗等），
//          因此这里必须自带文件浏览器所需的全部绑定。
// ============================================================

import { store } from '../core/state.js';
// 主题模块在模块求值时就会应用 localStorage 中保存的主题（data-theme），
// 独立窗口不加载 main.js，必须在这里显式引入，否则始终使用默认暗色。
import { THEME_KEY } from '../core/theme.js';
import { api } from '../core/apicall.js';
import { bindOverlayClose, showApiError, isDesktopRuntime } from '../core/utils.js';
import { formatApiError } from '../core/v2compat.js';
import {
    closeFileBrowserModal, closeFileBrowserUploadConflictModal, refreshFileBrowser,
    openFileBrowserUploadPicker, handleBrowserUploadSelected, submitBrowserUpload,
    showFileBrowserRenameMode, switchFileBrowserMode, downloadCurrentFilePreview,
    openFileBrowserModal, gitCommit,
} from './browser.js';
import { bindTerminalEvents } from './terminal.js';
import { fileBrowserReloadActiveFromDisk } from './preview.js';

/** 绑定文件浏览器工具栏、上传弹窗、模式切换等交互（主窗口与独立窗口共用一套）。 */
export function bindFileBrowserEvents() {
    // 仅当按下与松开都在遮罩上才关闭，避免弹窗内拖选误关
    bindOverlayClose(document.getElementById('fileBrowserModal'), closeFileBrowserModal);
    bindOverlayClose(document.getElementById('fileBrowserUploadConflictModal'), closeFileBrowserUploadConflictModal);
    document.getElementById('btnCloseFileBrowser')?.addEventListener('click', closeFileBrowserModal);
    document.getElementById('btnRefreshFiles')?.addEventListener('click', refreshFileBrowser);
    document.getElementById('btnFileBrowserUpload')?.addEventListener('click', openFileBrowserUploadPicker);
    document.getElementById('btnFileBrowserDownload')?.addEventListener('click', async function() {
        try {
            await downloadCurrentFilePreview();
        } catch (e) {
            showApiError('下载失败: ', e);
        }
    });
    document.getElementById('fileBrowserUploadInput')?.addEventListener('change', async function(e) {
        var file = e.target.files && e.target.files[0];
        if (file) await handleBrowserUploadSelected(file);
        e.target.value = '';
    });
    document.getElementById('btnFileBrowserUploadOverwrite')?.addEventListener('click', async function() {
        try {
            await submitBrowserUpload(store.fileBrowserState.pendingUploadFileName || '', true);
        } catch (e) {
            showApiError('上传失败: ', e);
        }
    });
    document.getElementById('btnFileBrowserUploadRenameMode')?.addEventListener('click', showFileBrowserRenameMode);
    document.getElementById('btnFileBrowserUploadRenameConfirm')?.addEventListener('click', async function() {
        var input = document.getElementById('fileBrowserUploadRenameInput');
        var error = document.getElementById('fileBrowserUploadConflictError');
        var name = input ? String(input.value || '').trim() : '';
        if (!name) {
            if (error) error.textContent = '文件名不能为空';
            return;
        }
        try {
            await submitBrowserUpload(name, false);
        } catch (e) {
            if (error) error.textContent = formatApiError(e);
        }
    });
    document.getElementById('btnFileBrowserUploadConflictCancel')?.addEventListener('click', closeFileBrowserUploadConflictModal);
    document.getElementById('btnFileBrowserModeFiles')?.addEventListener('click', function() {
        switchFileBrowserMode('files');
    });
    document.getElementById('btnFileBrowserModeGit')?.addEventListener('click', function() {
        switchFileBrowserMode('git');
    });
    document.getElementById('btnFileBrowserModeSearch')?.addEventListener('click', function() {
        switchFileBrowserMode('search');
    });
    // 内嵌终端：状态栏入口、抽屉按钮、尺寸自适应
    bindTerminalEvents();
    // git 提交栏是静态 DOM（列表刷新时不重建），因此在这里一次性绑定
    document.getElementById('btnFileBrowserGitCommit')?.addEventListener('click', function(e) {
        e.stopPropagation();
        gitCommit();
    });
    document.getElementById('fileBrowserGitCommitInput')?.addEventListener('input', function() {
        store.fileBrowserState.git.commitMessage = this.value || '';
        store.fileBrowserState.git.gitActionError = '';
    });
    // 外部修改提示条：放弃本地编辑，重新读取磁盘内容
    document.getElementById('btnFileBrowserExternalReload')?.addEventListener('click', function() {
        fileBrowserReloadActiveFromDisk();
    });
}

/** 独立文件浏览器窗口初始化：全屏打开浏览器，rootDir 完全由 URL 参数提供。 */
export function initStandaloneFileBrowser() {
    function run() {
        document.documentElement.classList.add('standalone-file-browser-mode');
        var modal = document.getElementById('fileBrowserModal');
        if (modal) modal.classList.add('file-browser-standalone');
        // 主窗口切换主题时实时跟随：跨窗口修改 localStorage 不会触发本页的变更事件，
        // 只会收到 storage 事件（仅在其他页面写入时触发）。
        window.addEventListener('storage', function(e) {
            if (e.key !== THEME_KEY || !e.newValue) return;
            document.documentElement.setAttribute('data-theme', e.newValue);
            if (typeof window.syncFileBrowserEditorTheme === 'function') {
                window.syncFileBrowserEditorTheme(e.newValue);
            }
        });
        // 与主工作台一致：外部链接交给系统浏览器（桌面）/ 新标签页（Web），
        // 否则文件预览里的 <a href> 会直接把 WebView 导航离开文件浏览器。
        document.addEventListener('click', function(e) {
            var a = (e.target && e.target.closest) ? e.target.closest('a[href]') : null;
            if (!a) return;
            var href = a.getAttribute('href') || '';
            // 只拦截外部协议；锚点与内部相对路径放行
            if (!/^(https?:|mailto:|tel:|file:)/i.test(href)) return;
            e.preventDefault();
            if (isDesktopRuntime()) {
                api.OpenURL(href);
            } else {
                window.open(href, '_blank');
            }
        }, true);
        var params = new URLSearchParams(window.location.search);
        var root = params.get('root') || '';
        var withGit = params.get('git') === '1';
        bindFileBrowserEvents();
        openFileBrowserModal(root, withGit ? { features: ['git'] } : undefined);
    }
    // 入口分流脚本是 module（默认 defer），正常情况下 DOM 已就绪；
    // 兼容直接以 script 方式加载本文件的情形。
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
        run();
    }
}