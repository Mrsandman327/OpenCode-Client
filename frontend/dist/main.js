// ============================================================
// OpenCode 管理中心 - 全局事件绑定 + 应用启动
// ES Modules 入口：所有业务模块在此统一 import
// ============================================================

// ============================
// 模块导入（依赖关系显式声明）
// ============================
import { toggleTheme } from './core/theme.js';
import { isBrowserRuntimeForMain, showToast, showApiError, isDesktopRuntime, loadWailsRuntime, bindOverlayClose } from './core/utils.js';
import { api } from './core/apicall.js';
import { store, currentDir } from './core/state.js';
import { toModelOptions, formatApiError } from './core/v2compat.js';
import {
    isMobileTreeMode, toggleMobileTree, closeMobileTree,
    toggleSessions, toggleSidepanel,
} from './chat/mobile.js';
import {
    showProxyModal, hideProxyModal, applyProxyConfig, updateProxyPreview, updateProxyButton,
    showFrontendWebModal, closeFrontendWebModal, startFrontendWeb, stopFrontendWeb,
    copyFrontendWebUrl, persistFrontendWebConfigFromInputs, loadFrontendWebConfigToInputs,
    checkFrontendWebStatus,
} from './chat/config.js';
import {
    toggleWeb, checkWebStatus, loadServiceStatus, launchTerminal,
} from './chat/service.js';
import { refreshTree, createNewSession } from './chat/tree.js';
import { isSessionBusy, scrollMessagesToBottom, updateScrollBottomButton } from './chat/render.js';
import { respondPermission } from './chat/permission.js';
import {
    sendPrompt, abortSession, addAttachment, refreshCurrentSession, scheduleRefresh,
    initTreePanelResize, loadTreePanelWidth, applyTreePanelWidth,
    initSidepanelResize, loadSidepanelWidth, applySidepanelWidth,
    treePanelWidth, sidepanelWidth,
} from './chat/session.js';
import { closeDirBrowserModal, goDirBrowserUp, selectDirBrowserCurrent } from './filebrowser/dir.js';
import {
    closeFileBrowserModal, closeFileBrowserUploadConflictModal, refreshFileBrowser,
    openFileBrowserUploadPicker, handleBrowserUploadSelected, submitBrowserUpload,
    showFileBrowserRenameMode, switchFileBrowserMode, downloadCurrentFilePreview,
    openFileBrowserModal,
} from './filebrowser/browser.js';
import {
    showAddPresetModal, loadModelConfig, handleSlimSave, openSlimDir,
} from './views/omo-config.js';
import {
    loadSkillsData, renderSkillList, bindSkillManagerEvents,
} from './views/skill-manager.js';
import {
    renderCommandsCard, renderApiDocs, apiDocLoaded,
} from './views/commands.js';
import { bindKnowledgeEvents } from './views/knowledge.js';
import { loadProviders } from './views/provider.js';
// 知识库 @ 引用：输入框输入 @ 弹出知识库搜索面板（需 DOM 就绪后显式初始化）
import { initKnowledgeRef } from './chat/knowledge-ref.js';
// 副作用模块：聊天命令面板在模块顶层自绑定键盘/输入事件（无导出符号被消费）
import './chat/cmd-palette.js';
// 副作用模块：侧边栏导航在模块顶层绑定点击事件并恢复折叠状态
import './chat/navigation.js';

// ============================
// 工作区事件绑定
// ============================

document.addEventListener('DOMContentLoaded', () => {
    // 全局拦截外部链接点击：防止 WebView/页面导航离开工作台（聊天消息里的 markdown 链接也走这里）
    document.addEventListener('click', function(e) {
        var target = e.target;
        var a = (target && target.closest) ? target.closest('a[href]') : null;
        if (!a) return;
        var href = a.getAttribute('href') || '';
        // 只拦截外部协议链接；锚点(#)和内部相对路径不拦
        if (/^(https?:|mailto:|tel:|file:)/i.test(href)) {
            e.preventDefault();
            if (isDesktopRuntime()) {
                // 桌面端：交给 Go 用系统默认浏览器打开（api.OpenURL 走 wails3 Browser 管理器）
                api.OpenURL(href);
            } else {
                // Web/手机端：新标签页打开，不离开当前工作台
                window.open(href, '_blank');
            }
        }
    }, true);

    if (isBrowserRuntimeForMain()) {
        var btnFrontendWebConfig = document.getElementById('btnFrontendWebConfig');
        if (btnFrontendWebConfig) {
            btnFrontendWebConfig.style.display = 'none';
        }
        var btnWtOpen = document.getElementById('btnWtOpen');
        if (btnWtOpen) {
            btnWtOpen.style.display = 'none';
        }
        var btnOpenSourceDir = document.getElementById('btnOpenSourceDir');
        if (btnOpenSourceDir) {
            btnOpenSourceDir.style.display = 'none';
        }
    }

    // 事件绑定: 服务启动/停止（二合一）
    document.getElementById('btnToggleWeb').addEventListener('click', toggleWeb);
    document.getElementById('btnProxySettings').addEventListener('click', showProxyModal);
    document.getElementById('btnFrontendWebConfig').addEventListener('click', showFrontendWebModal);
    document.getElementById('btnSaveFrontendWeb').addEventListener('click', startFrontendWeb);
    document.getElementById('btnStopFrontendWeb').addEventListener('click', stopFrontendWeb);
    document.getElementById('btnCopyFrontendWebUrl').addEventListener('click', copyFrontendWebUrl);
    document.getElementById('btnCloseFrontendWebModal').addEventListener('click', closeFrontendWebModal);
    ['frontendWebHost', 'frontendWebPort'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', persistFrontendWebConfigFromInputs);
            el.addEventListener('change', persistFrontendWebConfigFromInputs);
        }
    });
    document.getElementById('btnWtOpen').addEventListener('click', launchTerminal);
    document.getElementById('btnRefreshTree').addEventListener('click', refreshTree);
    document.getElementById('btnNewSession').addEventListener('click', createNewSession);
    document.getElementById('btnMobileTree').addEventListener('click', toggleMobileTree);
    document.getElementById('btnMobileTree').addEventListener('click', (e) => {
        e.stopPropagation();
    });
    document.getElementById('ocMobileTreeMask').addEventListener('click', closeMobileTree);

    // 发送/停止按钮
    document.getElementById('btnSendPrompt').addEventListener('click', () => {
        if (isSessionBusy(store.currentSessionId)) {
            abortSession();
        } else {
            sendPrompt();
        }
    });

    // 输入框: 回车发送，Ctrl+Enter / Shift+Enter 换行
    document.getElementById('ocPrompt').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            var mobile = isMobileTreeMode();
            // 桌面端：Ctrl/Shift+Enter=换行，Enter=发送
            // 移动端：Enter=换行（无 Ctrl 键），仅按钮发送
            var insertNewline = (!mobile && (e.ctrlKey || e.shiftKey)) || (mobile && !e.ctrlKey && !e.shiftKey);
            if (insertNewline) {
                e.preventDefault();
                const input = e.target;
                const start = input.selectionStart;
                const end = input.selectionEnd;
                input.value = input.value.slice(0, start) + '\n' + input.value.slice(end);
                input.selectionStart = input.selectionEnd = start + 1;
                return;
            }
            e.preventDefault();
            sendPrompt();
        }
    });

    // 移动端输入时暂停后台轮询，避免与键入争抢渲染
    document.getElementById('ocPrompt').addEventListener('focus', () => {
        if (isMobileTreeMode()) { clearInterval(store.refreshTimer); store.refreshTimer = null; }
    });
    document.getElementById('ocPrompt').addEventListener('blur', () => {
        if (isMobileTreeMode() && !store.refreshTimer) { scheduleRefresh(); }
    });

    // 输入框 placeholder 按平台切换
    function updatePromptPlaceholder() {
        var ta = document.getElementById('ocPrompt');
        if (!ta) return;
        ta.placeholder = isMobileTreeMode() ? '输入内容' : '输入内容，Enter 发送，Ctrl+Enter 换行';
    }
    updatePromptPlaceholder();
    window.addEventListener('resize', updatePromptPlaceholder);

    document.getElementById('btnRefreshStatus').addEventListener('click', loadServiceStatus);
    // 权限请求弹窗按钮
    document.getElementById('btnPermReject').addEventListener('click', () => respondPermission('reject'));
    document.getElementById('btnPermOnce').addEventListener('click', () => respondPermission('once'));
    document.getElementById('btnPermAlways').addEventListener('click', () => respondPermission('always'));
    document.getElementById('btnToggleSessions').addEventListener('click', toggleSessions);
    document.getElementById('btnToggleSidepanel').addEventListener('click', toggleSidepanel);
    document.getElementById('btnScrollBottom').addEventListener('click', scrollMessagesToBottom);
    document.getElementById('btnRefreshCurrentSession').addEventListener('click', refreshCurrentSession);

    if (typeof initTreePanelResize === 'function') {
        initTreePanelResize();
    }
    if (typeof loadTreePanelWidth === 'function') {
        loadTreePanelWidth();
    }
    if (typeof initSidepanelResize === 'function') {
        initSidepanelResize();
    }
    if (typeof loadSidepanelWidth === 'function') {
        loadSidepanelWidth();
    }

    // 消息容器事件绑定到容器池（scroll 事件不冒泡，用 capture 捕获子容器滚动，覆盖所有 tab 容器）
    var msgPool = document.getElementById('ocMessagesPool');
    if (msgPool) {
        msgPool.addEventListener('scroll', updateScrollBottomButton, true);
        msgPool.addEventListener('mousedown', () => { store.userScrolling = true; });
        msgPool.addEventListener('mouseup', () => { store.userScrolling = false; });
        msgPool.addEventListener('mouseleave', () => { store.userScrolling = false; });
    }
    document.querySelector('.oc-chat').addEventListener('click', (e) => {
        if (e.target.closest('.modal-overlay')) return;
        if (isMobileTreeMode()) {
            closeMobileTree();
        }
    });

    // 跟踪用户拖拽滚动条

    // 知识库 @ 引用：绑定输入框的 @ 检测与搜索面板（幂等）
    initKnowledgeRef();

    // 附件
    document.getElementById('btnAttachFile').addEventListener('click', () => {
        document.getElementById('ocFileInput').click();
    });
    document.getElementById('ocFileInput').addEventListener('change', (e) => {
        Array.from(e.target.files).forEach(file => addAttachment(file));
        e.target.value = '';
    });

    // 粘贴图片/文件
    document.getElementById('ocPrompt').addEventListener('paste', (e) => {
        const files = e.clipboardData?.files;
        if (files && files.length) {
            Array.from(files).forEach(file => addAttachment(file));
        }
    });

    // 代理弹窗（仅当按下与松开都在遮罩上才关闭，避免弹窗内拖选误关）
    bindOverlayClose(document.getElementById('proxyModal'), hideProxyModal);
    bindOverlayClose(document.getElementById('frontendWebModal'), closeFrontendWebModal);
    bindOverlayClose(document.getElementById('dirBrowserModal'), closeDirBrowserModal);
    document.getElementById('btnDirBrowserClose').addEventListener('click', closeDirBrowserModal);
    document.getElementById('btnDirBrowserBack').addEventListener('click', goDirBrowserUp);
    document.getElementById('btnDirBrowserSelect').addEventListener('click', selectDirBrowserCurrent);
    // 文件浏览弹窗 (Web 端)：仅当按下与松开都在遮罩上才关闭
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
    document.getElementById('btnCancelProxy').addEventListener('click', hideProxyModal);
    document.getElementById('btnSaveProxy').addEventListener('click', applyProxyConfig);
    ['proxyEnabled', 'proxyHost', 'proxyPort', 'serviceHost', 'servicePort'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener(id === 'proxyEnabled' ? 'change' : 'input', updateProxyPreview);
    });
    updateProxyButton();
    loadFrontendWebConfigToInputs();

    // 右侧面板折叠
    document.querySelector('.oc-sidepanel').addEventListener('click', (e) => {
        const head = e.target.closest('.oc-panel-head');
        if (!head) return;
        if (e.target.closest('button')) return;
        head.closest('.oc-panel-section')?.classList.toggle('collapsed');
    });

    // ========================
    // OMO 配置事件绑定
    // ========================

    // 「📂 打开」：用系统文件管理器打开配置文件所在目录
    document.getElementById('btnOpenSlimDir')?.addEventListener('click', openSlimDir);

    // 刷新模型列表
    document.getElementById('btnRefreshModels')?.addEventListener('click', async () => {
        const btn = document.getElementById('btnRefreshModels');
        btn.disabled = true;
        btn.textContent = '⏳ 刷新中...';
        try {
            // v2：模型列表走 /api/model（v2 的 /api/provider 不再内嵌 models），并归一化为 {value,label}
            // 需带当前目录（location[directory]），否则会回落到服务端 CWD=home
            const dir = currentDir();
            const newModels = dir ? toModelOptions(await api.OpenCodeCall('GET', '/api/model', null, dir)) : [];
            if (newModels.length) store.availableModels = newModels;
            await loadModelConfig();
            showToast(`获取到 ${store.availableModels.length} 个可用模型`, 'success');
        } catch (err) {
            showApiError('刷新模型列表失败: ', err);
        }
        btn.disabled = false;
        btn.textContent = '🔄 刷新';
    });

    // 「➕ 新增方案」：打开模态（方案名 + 可选「继承自」）
    document.getElementById('btnAddModelType').addEventListener('click', showAddPresetModal);

    // 保存 OMO（oh-my-opencode-slim）配置：方案、radio 启用项与模型变更在此统一提交
    document.getElementById('modelActions').addEventListener('click', async (e) => {
        if (e.target.id !== 'btnSaveModels') return;
        await handleSlimSave();
    });

    // ========================
    // 技能管理事件绑定
    // ========================

    document.getElementById('btnRefresh').addEventListener('click', async () => {
        const btn = document.getElementById('btnRefresh');
        btn.disabled = true;
        btn.textContent = '⏳ 刷新中...';
        try {
            await api.Refresh();
            store.skillsLoaded = false;
            await loadSkillsData();
            showToast('列表已刷新', 'success');
        } catch (err) {
            showApiError('刷新失败: ', err);
        }
        btn.disabled = false;
        btn.textContent = '🔄 刷新';
    });

    // 搜索框事件
    var skillSearchInput = document.getElementById('skillSearch');
    if (skillSearchInput) {
        skillSearchInput.addEventListener('input', function(e) {
            renderSkillList(e.target.value);
        });
    }
    if (typeof bindSkillManagerEvents === 'function') {
        bindSkillManagerEvents();
    }

    // ========================
    // 知识库视图事件绑定
    // （数据在切换到「知识库」时按需加载，见 chat/navigation.js）
    // ========================
    bindKnowledgeEvents();

    // ========================
    // 命令视图事件绑定
    // ========================

    document.querySelector('.cmd-tabs').addEventListener('click', (e) => {
        const tabBtn = e.target.closest('.cmd-tab');
        if (!tabBtn || !tabBtn.dataset.cmdTab) return;

        const tab = tabBtn.dataset.cmdTab;
        if (tab === store.cmdActiveTab) return;

        store.cmdActiveTab = tab;

        document.querySelectorAll('.cmd-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.cmdTab === tab);
        });
        renderCommandsCard(tab);
    });

    var apiDocSearchInput = document.getElementById('apiDocSearch');
    if (apiDocSearchInput) {
        apiDocSearchInput.addEventListener('input', function(e) {
            store.apiDocKeyword = e.target.value || '';
            if (store.cmdActiveTab === 'api' && apiDocLoaded) {
                renderApiDocs();
            }
        });
    }

    // ========================
    // 供应商配置事件绑定
    // ========================

    document.querySelectorAll('.nav-item[data-view="view-providers"]').forEach(item => {
        item.addEventListener('click', () => setTimeout(loadProviders, 100));
    });

    // ========================
    // 全局事件
    // ========================

    // 主题切换
    document.getElementById('btnTheme').addEventListener('click', toggleTheme);

    // ESC 关闭面板
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeMobileTree();
        }
    });

    window.addEventListener('resize', () => {
        if (typeof applyTreePanelWidth === 'function' && typeof treePanelWidth !== 'undefined') {
            applyTreePanelWidth(treePanelWidth);
        }
        if (typeof applySidepanelWidth === 'function' && typeof sidepanelWidth !== 'undefined') {
            applySidepanelWidth(sidepanelWidth);
        }
        if (!isMobileTreeMode()) {
            closeMobileTree();
        }
    });

    // Wails v3 窗口就绪（app-ready）→ 前端就绪后检测服务状态
    if (isDesktopRuntime()) {
        loadWailsRuntime().then((rt) => {
            rt.Events.On('app-ready', () => {
                checkWebStatus();
                checkFrontendWebStatus();
            });
        }).catch(() => { /* 运行时加载失败时由下方初始检测兜底 */ });
    }

    // 初始加载：立即检测一次；桌面模式另由 app-ready 事件补一次检测（幂等）
    loadSkillsData();
    checkWebStatus();
    checkFrontendWebStatus();

    // ============ 独立文件浏览器窗口模式 ============
    // 桌面端多窗口 / 浏览器新标签页通过 ?view=filebrowser&root=...&git=1 进入：
    // 自动全屏打开文件浏览器（复用同一份前端资源，rootDir 由 URL 参数传入，不依赖会话状态）。
    (function initStandaloneFileBrowserMode() {
        var params = new URLSearchParams(window.location.search);
        if (params.get('view') !== 'filebrowser') return;
        var root = params.get('root') || '';
        var withGit = params.get('git') === '1';
        document.documentElement.classList.add('standalone-file-browser-mode');
        var modal = document.getElementById('fileBrowserModal');
        if (modal) modal.classList.add('file-browser-standalone');
        openFileBrowserModal(root, withGit ? { features: ['git'] } : undefined);
    })();
});

// ============================
// 输入区域拖动条
// ============================
(function() {
    var handle = document.getElementById('ocInputResizeHandle');
    var inputBar = document.querySelector('.oc-input-bar');
    var chatEl = document.querySelector('.oc-chat');
    if (!handle || !inputBar || !chatEl) return;

    var MIN_HEIGHT = 147;
    var DEFAULT_HEIGHT = 0; // 0 = 使用 CSS 默认高度
    var STORAGE_KEY = 'ocInputHeight';
    var startY, startHeight;
    var dragging = false;

    // 恢复上次保存的高度
    var saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
    if (saved && saved >= MIN_HEIGHT) {
        applyHeight(saved);
    }

    function applyHeight(h) {
        inputBar.style.height = h + 'px';
        inputBar.style.flexShrink = '0';
        inputBar.style.flexBasis = h + 'px';
        inputBar.classList.add('input-expanded');
    }

    function resetHeight() {
        inputBar.style.height = '';
        inputBar.style.flexShrink = '0';
        inputBar.style.flexBasis = '';
        inputBar.classList.remove('input-expanded');
        localStorage.removeItem(STORAGE_KEY);
    }

    function startDrag(clientY) {
        dragging = true;
        startY = clientY;
        startHeight = inputBar.offsetHeight || DEFAULT_HEIGHT || MIN_HEIGHT;
        handle.classList.add('dragging');
        chatEl.classList.add('input-resizing');

        function onMove(ev) {
            if (!dragging) return;
            var y = ev.touches ? ev.touches[0].clientY : ev.clientY;
            var delta = startY - y; // 向上拖动 = 正值
            var newHeight = Math.max(MIN_HEIGHT, startHeight + delta);
            applyHeight(newHeight);
        }

        function onUp() {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            chatEl.classList.remove('input-resizing');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
            var h = parseInt(inputBar.style.height, 10);
            if (h >= MIN_HEIGHT) {
                localStorage.setItem(STORAGE_KEY, h);
            }
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    }

    handle.addEventListener('mousedown', function(e) {
        e.preventDefault();
        startDrag(e.clientY);
    });

    handle.addEventListener('touchstart', function(e) {
        e.preventDefault();
        startDrag(e.touches[0].clientY);
    });

    // 双击恢复默认高度
    handle.addEventListener('dblclick', function() {
        resetHeight();
    });
})();

// ============================
// 右侧面板分区高度拖动条
// ============================
// 规则：仅「子任务 ↔ 代办事项」之间一条拖动条，调整子任务高度；
// 服务状态区不参与固定高度分配（高度完全由内容自适应，见 style.css）；
// 代办事项不设高、始终填满剩余空间；子任务最小高度 100px（拖动上限必须给代办留 100px）。
// 未拖动过时保持现状（CSS auto 高度兜底），首次拖动才以当前实际高度为基准进入固定
// 分配模式；拖动结果持久化 localStorage，双击拖动条恢复默认（含清理存储）。

/** 子任务区最小高度（同时是拖动上限为代办事项保留的最小高度） */
var PANEL_MIN_HEIGHT = 100;
/** 分区高度存储键：JSON 形如 { subtasks: 180 }（缺省键表示子任务区为 auto；
 *  旧版本存储中的 services 键在读取时忽略，不再写入） */
var PANEL_HEIGHTS_KEY = 'panelHeights';

/**
 * 夹取子任务区高度（纯函数，便于单测）
 * @param {number} desired 期望高度（px）
 * @param {number} containerH 容器总高度（px，.oc-sidepanel-content 的 clientHeight）
 * @param {number} otherH 服务区、拖动条与其它已占用空间的高度（px）
 * @returns {number} 夹取后的高度：不小于 100px；且保证代办区至少保留 100px
 */
function clampPanelHeight(desired, containerH, otherH) {
    return Math.max(PANEL_MIN_HEIGHT, Math.min(desired, containerH - otherH - PANEL_MIN_HEIGHT));
}

(function() {
    var content = document.querySelector('.oc-sidepanel-content');
    var servicesSection = document.getElementById('servicePanelSection');
    var subtaskSection = document.getElementById('subtaskPanelSection');
    var todoSection = document.getElementById('todoPanelSection');
    var midHandle = document.getElementById('ocPanelResizeHandleMid');
    if (!content || !servicesSection || !subtaskSection || !todoSection || !midHandle) return;

    // 子任务区当前高度：null 表示保持 auto（未拖过）；数字表示固定高度
    var heights = { subtasks: null };
    var dragging = false;

    /** 将子任务区应用为固定高度或恢复 auto（inline 覆盖 CSS 的 min-height 兜底） */
    function applySectionHeight(section, h) {
        if (h == null) {
            section.style.height = '';
            section.style.flex = '';
            section.style.minHeight = '';
        } else {
            section.style.height = h + 'px';
            section.style.flex = 'none';
            section.style.minHeight = PANEL_MIN_HEIGHT + 'px';
        }
    }

    /** 应用高度分配：只设置子任务区的固定高；
     *  代办区与服务区一样内容自适应（CSS 里 min-height 保底 + 内容撑高、无内部滚动），
     *  不参与剩余空间分配，也不再由这里写任何 inline 样式。 */
    function applyPanelHeights() {
        applySectionHeight(subtaskSection, heights.subtasks);
    }

    /** 持久化高度（子任务恢复 auto 时移除存储） */
    function persistPanelHeights() {
        try {
            if (heights.subtasks != null) {
                localStorage.setItem(PANEL_HEIGHTS_KEY, JSON.stringify({ subtasks: Math.round(heights.subtasks) }));
            } else {
                localStorage.removeItem(PANEL_HEIGHTS_KEY);
            }
        } catch (_) {}
    }

    /** 加载缓存的高度并直接应用；随后按当前容器夹取一次，避免窗口变小后溢出。
     *  兼容旧存储格式：只读取 subtasks 键，services 键直接忽略。 */
    function loadPanelHeights() {
        try {
            var parsed = JSON.parse(localStorage.getItem(PANEL_HEIGHTS_KEY));
            if (parsed && typeof parsed === 'object' && Number.isFinite(parsed.subtasks)) {
                heights.subtasks = parsed.subtasks;
            }
        } catch (_) {}
        if (heights.subtasks == null) return;
        applyPanelHeights();
        // 容器尚未布局（如侧栏隐藏）时跳过夹取，保留缓存值，等布局恢复后自然生效
        var containerH = content.clientHeight;
        if (containerH <= 0) return;
        // 服务区已改为内容自适应、不参与高度分配：上限=容器可视高-代办最小高，
        // 不再扣除服务区高度（服务区超高时若扣除，上限会变负、拖动被瞬间夹到下限）
        var otherH = 0;
        heights.subtasks = clampPanelHeight(heights.subtasks, containerH, otherH);
        subtaskSection.style.height = heights.subtasks + 'px';
        persistPanelHeights();
    }

    /** 恢复子任务区默认（auto 模式）并清理存储 */
    function resetPanel() {
        heights.subtasks = null;
        applyPanelHeights();
        persistPanelHeights();
    }

    /**
     * 开始拖动：仅调整子任务高度
     * 以按下时的实际布局为基准；首次移动才写入固定高度（纯点击不改变现状）
     */
    function startDrag(startClientY, handle) {
        if (dragging) return;
        if (isMobileTreeMode()) return;
        // 拖动期间容器高度视为稳定，按下时冻结测量：
        // 上限只保证代办区至少保留 PANEL_MIN_HEIGHT（=容器可视高-100），
        // 不扣除服务区高度——服务区内容自适应后可能高于一屏（整体滚动场景），
        // 若扣除会让上限变负、一拖动就被夹到下限，表现为“点一下就回原始高度”。
        var containerH = content.clientHeight;
        var otherH = 0;
        var startHeight = subtaskSection.offsetHeight || PANEL_MIN_HEIGHT;
        dragging = true;
        handle.classList.add('dragging');
        content.classList.add('panel-resizing');

        function onMove(ev) {
            if (!dragging) return;
            if (ev.touches) ev.preventDefault();
            var clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
            // 向下拖 = 分区底边界下移 = 高度增大（与拖动条所处分界方向一致）
            var desired = startHeight + (clientY - startClientY);
            heights.subtasks = clampPanelHeight(desired, containerH, otherH);
            applyPanelHeights();
        }

        function onUp() {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            content.classList.remove('panel-resizing');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
            window.removeEventListener('blur', onUp);
            // 纯点击（未移动）时 heights 未被写入，持久化不会产生副作用
            persistPanelHeights();
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
        window.addEventListener('blur', onUp);
    }

    /** 绑定拖动条：按下拖动 + 双击复位 */
    function bindPanelResizeHandle(handle) {
        handle.addEventListener('mousedown', function(e) {
            e.preventDefault();
            startDrag(e.clientY, handle);
        });
        handle.addEventListener('touchstart', function(e) {
            e.preventDefault();
            startDrag(e.touches[0].clientY, handle);
        });
        // 双击恢复默认：清除子任务高度并清理存储
        handle.addEventListener('dblclick', function() {
            resetPanel();
        });
    }

    loadPanelHeights();
    bindPanelResizeHandle(midHandle);
})();
