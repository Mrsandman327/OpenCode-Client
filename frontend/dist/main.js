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
        var openGlobalDirBtn = document.getElementById('btnOpenDir');
        var btnFrontendWebConfig = document.getElementById('btnFrontendWebConfig');
        var btnWtOpen = document.getElementById('btnWtOpen');
        if (openSchemeBtn) {
            openSchemeBtn.style.display = 'none';
        }
        if (openGlobalDirBtn) {
            openGlobalDirBtn.style.display = 'none';
        }
        if (btnFrontendWebConfig) {
            btnFrontendWebConfig.style.display = 'none';
        }
        if (btnWtOpen) {
            btnWtOpen.style.display = 'none';
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
            if (e.ctrlKey || e.shiftKey) {
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

    document.getElementById('btnLoadDiff').addEventListener('click', loadDiff);
    document.getElementById('btnRefreshStatus').addEventListener('click', loadServiceStatus);
    document.getElementById('btnToggleSessions').addEventListener('click', toggleSessions);
    document.getElementById('btnToggleSidepanel').addEventListener('click', toggleSidepanel);
    document.getElementById('btnScrollBottom').addEventListener('click', scrollMessagesToBottom);
    document.getElementById('ocMessages').addEventListener('scroll', updateScrollBottomButton);

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
            const newModels = await api.RefreshAvailableModels();
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

    document.getElementById('btnOpenDir').addEventListener('click', async () => {
        const path = document.getElementById('sourcePath').textContent;
        if (!path || path === '加载中...' || path === '未知') {
            showToast('目录路径无效', 'error');
            return;
        }
        try {
            await api.OpenDir(path);
        } catch (err) {
            showToast('打开目录失败: ' + (err.message || err), 'error');
        }
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

    // Modal 关闭事件
    document.getElementById('skillModalClose').addEventListener('click', closeSkillModal);
    document.getElementById('skillModal').addEventListener('click', function(e) {
        if (e.target.id === 'skillModal') closeSkillModal();
    });
    document.getElementById('skillModalEdit').addEventListener('click', function() {
        editSkill(document.getElementById('skillModal').dataset.skillPath);
    });
    document.getElementById('skillModalSave').addEventListener('click', saveSkillEdit);
    document.getElementById('skillModalCancel').addEventListener('click', function() {
        if (currentSkillBrowserState && currentSkillBrowserState.selectedPath) {
            cancelSkillBrowserEdit();
            return;
        }
    });

    // ========================
    // 命令视图事件绑定
    // ========================

    document.querySelector('.cmd-tabs').addEventListener('click', (e) => {
        const tabBtn = e.target.closest('.cmd-tab');
        if (!tabBtn || !tabBtn.dataset.cmdTab) return;

        const tab = tabBtn.dataset.cmdTab;
        if (tab === cmdActiveTab && commandsLoaded) return;

        cmdActiveTab = tab;

        document.querySelectorAll('.cmd-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.cmdTab === tab);
        });

        if (commandsLoaded) {
            renderCommands(tab);
        } else {
            loadCommands();
        }
    });

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
            // 预留
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
