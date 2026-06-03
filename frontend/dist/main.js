// ============================================================
// OpenCode 管理中心 - 全局事件绑定 + 应用启动
// 模块文件按顺序在 index.html 中加载
// ============================================================

// ============================
// 工作区事件绑定
// ============================

function isBrowserRuntimeForMain() {
    return !window.runtime;
}

document.addEventListener('DOMContentLoaded', () => {
    if (isBrowserRuntimeForMain()) {
        var openSchemeBtn = document.getElementById('btnOpenSchemeDir');
        if (openSchemeBtn) {
            openSchemeBtn.style.display = 'none';
        }
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

    // 事件绑定: 服务启动/停止
    document.getElementById('btnStartWeb').addEventListener('click', startWeb);
    document.getElementById('btnProxySettings').addEventListener('click', showProxyModal);
    document.getElementById('btnStopWeb').addEventListener('click', stopWeb);
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
        if (isSessionBusy(currentSessionId)) {
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
        if (isMobileTreeMode()) { clearInterval(refreshTimer); refreshTimer = null; }
    });
    document.getElementById('ocPrompt').addEventListener('blur', () => {
        if (isMobileTreeMode() && !refreshTimer) { scheduleRefresh(); }
    });

    // 输入框 placeholder 按平台切换
    function updatePromptPlaceholder() {
        var ta = document.getElementById('ocPrompt');
        if (!ta) return;
        ta.placeholder = isMobileTreeMode() ? '输入内容' : '输入内容，Enter 发送，Ctrl+Enter 换行';
    }
    updatePromptPlaceholder();
    window.addEventListener('resize', updatePromptPlaceholder);

    document.getElementById('btnLoadDiff').addEventListener('click', loadDiff);
    document.getElementById('btnRefreshStatus').addEventListener('click', loadServiceStatus);
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

    document.getElementById('ocMessages').addEventListener('scroll', updateScrollBottomButton);
    document.querySelector('.oc-chat').addEventListener('click', (e) => {
        if (e.target.closest('.modal-overlay')) return;
        if (isMobileTreeMode()) {
            closeMobileTree();
        }
    });

    // 跟踪用户拖拽滚动条
    document.getElementById('ocMessages').addEventListener('mousedown', () => { userScrolling = true; });
    document.getElementById('ocMessages').addEventListener('mouseup', () => { userScrolling = false; });
    document.getElementById('ocMessages').addEventListener('mouseleave', () => { userScrolling = false; });

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

    // 代理弹窗
    document.getElementById('proxyModal').addEventListener('click', (e) => {
        if (e.target.id === 'proxyModal') hideProxyModal();
    });
    document.getElementById('frontendWebModal').addEventListener('click', (e) => {
        if (e.target.id === 'frontendWebModal') closeFrontendWebModal();
    });
    document.getElementById('dirBrowserModal').addEventListener('click', (e) => {
        if (e.target.id === 'dirBrowserModal') closeDirBrowserModal();
    });
    document.getElementById('btnDirBrowserClose').addEventListener('click', closeDirBrowserModal);
    document.getElementById('btnDirBrowserBack').addEventListener('click', goDirBrowserUp);
    document.getElementById('btnDirBrowserSelect').addEventListener('click', selectDirBrowserCurrent);
    // 文件浏览弹窗 (Web 端)
    document.getElementById('fileBrowserModal')?.addEventListener('click', function(e) {
        if (e.target.id === 'fileBrowserModal') closeFileBrowserModal();
    });
    document.getElementById('fileBrowserUploadConflictModal')?.addEventListener('click', function(e) {
        if (e.target.id === 'fileBrowserUploadConflictModal') closeFileBrowserUploadConflictModal();
    });
    document.getElementById('btnCloseFileBrowser')?.addEventListener('click', closeFileBrowserModal);
    document.getElementById('btnRefreshFiles')?.addEventListener('click', refreshFileBrowser);
    document.getElementById('btnFileBrowserUpload')?.addEventListener('click', openFileBrowserUploadPicker);
    document.getElementById('btnFileBrowserDownload')?.addEventListener('click', async function() {
        try {
            await downloadCurrentFilePreview();
        } catch (e) {
            showToast('下载失败: ' + (e.message || e), 'error');
        }
    });
    document.getElementById('fileBrowserUploadInput')?.addEventListener('change', async function(e) {
        var file = e.target.files && e.target.files[0];
        if (file) await handleBrowserUploadSelected(file);
        e.target.value = '';
    });
    document.getElementById('btnFileBrowserUploadOverwrite')?.addEventListener('click', async function() {
        try {
            await submitBrowserUpload(window.fileBrowserState.pendingUploadFileName || '', true);
        } catch (e) {
            showToast('上传失败: ' + (e.message || e), 'error');
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
            if (error) error.textContent = e.message || String(e);
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

    // 刷新模型列表
    document.getElementById('btnRefreshModels')?.addEventListener('click', async () => {
        const btn = document.getElementById('btnRefreshModels');
        btn.disabled = true;
        btn.textContent = '⏳ 刷新中...';
        try {
            const newModels = await api.OpenCodeCall('GET', '/provider');
            if (newModels) availableModels = newModels;
            await loadModelConfig();
            showToast(`获取到 ${availableModels.length} 个可用模型`, 'success');
        } catch (err) {
            showToast('刷新模型列表失败: ' + (err.message || err), 'error');
        }
        btn.disabled = false;
        btn.textContent = '🔄 刷新列表';
    });

    document.getElementById('btnAddModelType').addEventListener('click', showAddTypeModal);

    // ========================
    // 方案管理事件绑定
    // ========================

    // 方案下拉框切换
    document.getElementById('schemeSelect')?.addEventListener('change', async (e) => {
        const name = e.target.value;
        if (!name) return;
        if (typeof handleSchemeSwitch === 'function') {
            await handleSchemeSwitch(name);
        }
    });

    // 导入方案
    document.getElementById('btnSchemeImport')?.addEventListener('click', async () => {
        if (typeof handleSchemeImport === 'function') {
            await handleSchemeImport();
        }
    });

    // 导出方案
    document.getElementById('btnSchemeExport')?.addEventListener('click', async () => {
        if (typeof handleSchemeExport === 'function') {
            await handleSchemeExport();
        }
    });

    // 入库（保存到方案目录）
    document.getElementById('btnSchemeSave')?.addEventListener('click', async () => {
        if (typeof handleSchemeSave === 'function') {
            await handleSchemeSave();
        }
    });

    // 打开方案目录
    document.getElementById('btnOpenSchemeDir')?.addEventListener('click', async () => {
        try {
            await api.OpenSchemeDir();
        } catch (e) {
            showToast('打开方案目录失败: ' + (e.message || e), 'error');
        }
    });

    // 保存 OMO 配置
    document.getElementById('modelActions').addEventListener('click', async (e) => {
        if (e.target.id !== 'btnSaveModels') return;
        if (typeof handleSchemeApply === 'function') {
            await handleSchemeApply();
        } else {
            showToast('当前页面未加载 OMO 保存逻辑', 'error');
        }
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
            skillsLoaded = false;
            await loadSkillsData();
            showToast('列表已刷新', 'success');
        } catch (err) {
            showToast('刷新失败: ' + (err.message || err), 'error');
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
    // 技能管理 - L2 来源目录事件
    // ========================
    document.getElementById('btnAddSourceDir')?.addEventListener('click', async () => {
        if (typeof addSourceDir === 'function') await addSourceDir();
    });
    document.getElementById('btnRemoveSourceDir')?.addEventListener('click', async () => {
        if (typeof removeSourceDir === 'function') await removeSourceDir();
    });
    document.getElementById('btnOpenSourceDir')?.addEventListener('click', async () => {
        if (typeof openSelectedSourceDir === 'function') await openSelectedSourceDir();
    });

    // ========================
    // 技能管理 - L6 方案管理事件
    // ========================
    document.getElementById('btnSaveSkillScheme')?.addEventListener('click', async () => {
        if (typeof saveSkillScheme === 'function') await saveSkillScheme();
    });
    document.getElementById('btnDeleteSkillScheme')?.addEventListener('click', async () => {
        if (typeof deleteSkillScheme === 'function') await deleteSkillScheme();
    });
    document.getElementById('btnApplySkillScheme')?.addEventListener('click', async () => {
        if (typeof applySkillScheme === 'function') await applySkillScheme();
    });


    // ========================
    // 命令视图事件绑定
    // ========================

    document.querySelector('.cmd-tabs').addEventListener('click', (e) => {
        const tabBtn = e.target.closest('.cmd-tab');
        if (!tabBtn || !tabBtn.dataset.cmdTab) return;

        const tab = tabBtn.dataset.cmdTab;
        if (tab === cmdActiveTab) return;

        cmdActiveTab = tab;

        document.querySelectorAll('.cmd-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.cmdTab === tab);
        });
        renderCommandsCard(tab);
    });

    var apiDocSearchInput = document.getElementById('apiDocSearch');
    if (apiDocSearchInput) {
        apiDocSearchInput.addEventListener('input', function(e) {
            apiDocKeyword = e.target.value || '';
            if (cmdActiveTab === 'api' && apiDocLoaded) {
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

    // Wails OnDomReady → 前端就绪后检测服务状态
    if (window.runtime) {
        window.runtime.EventsOn('app-ready', () => {
            checkWebStatus();
            checkFrontendWebStatus();
        });
    }

    // 初始加载（非 Wails 环境）
    loadSkillsData();
    if (!window.runtime) {
        checkWebStatus();
        checkFrontendWebStatus();
    }
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
