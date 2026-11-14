// ============================================================
// mcp-config.js — MCP 连接器配置弹窗（全局 mcp.servers）
// ============================================================
// 入口：模型服务工具栏「MCP 连接器」按钮（#btnOpenMcp）。
// 数据：api.GetMcpConfig() 读取；api.SaveMcpServer / DeleteMcpServer /
// SaveMcpTimeouts 写入。接口经 core/apicall.js 的 Proxy 自动分发，
// 桌面端走 wails 绑定，Web 端走 /api/app-call。
//
// 界面语义映射（与后端契约严格对应）：
//   「启用」开关     = disabled 取反
//   「Code Mode」勾选 = 不传该字段（默认开启）；取消 = codemode: false
//   「共享连接」勾选 = pool: true；不勾选时不传该字段
//   OAuth 三态       = 自动不传 / 关闭 oauth:false / 自定义对象
//   超时留空         = 不传该子项（绝不传 0）
//   extra（未识别字段）仅展示提示，保存时不回传
import { api } from '../core/apicall.js';
import { escapeHtml, showToast, showApiError, bindOverlayClose, isBrowserRuntimeForMain } from '../core/utils.js';
import { formatApiError } from '../core/v2compat.js';
import { showConfirm } from '../core/dialog.js';
// 目录选择：桌面端走系统对话框（可指定起始路径），Web 端走站内目录浏览器
// （与「新建会话」同一个组件，支持从当前 cwd 继续浏览）
import { openDirBrowserModal } from '../filebrowser/dir.js';

// ============================================================
// 模块内状态（不引入全局变量）
// ============================================================
const state = {
    servers: [],          // GetMcpConfig().servers
    globalTimeout: {},    // GetMcpConfig().timeout
    current: -1,          // 当前选中服务器下标（新增时为 -1）
    isNew: false,         // 是否处于新增态
    view: 'empty',        // server | global | empty
    emptyText: '从左侧选择一个连接器，或点「新增连接器」',
    emptyRetry: false,    // 空状态是否显示「重新加载」按钮
    initialized: false
};

// DOM 引用（initMcpConfig 时统一收集）
let el = null;

// ============================================================
// 通用小工具
// ============================================================

/** 获取弹窗内元素（el.modal 尚未初始化时返回 null） */
function query(selector) {
    return el && el.modal ? el.modal.querySelector(selector) : null;
}

/** 按 id 绑定点击（元素不存在时静默跳过，兼容旧版 index.html） */
function bindClick(id, handler) {
    const node = document.getElementById(id);
    if (node) node.addEventListener('click', handler);
}

/** 按钮忙碌态切换：禁用 + 文案，结束后恢复 */
function setBusy(btn, busy, busyText, idleText) {
    if (!btn) return;
    btn.disabled = !!busy;
    btn.textContent = busy ? busyText : idleText;
}

/** 接口返回体校验：{ error } 或 { success:false } 视为失败并抛错 */
function assertOk(res, fallback) {
    if (!res || typeof res !== 'object') return;
    if (res.error) throw new Error(String(res.error));
    if (res.success === false) throw new Error(fallback || '操作失败');
}

/** 规范化为工具前缀可用的名称（仅用于实时预览，不改写用户输入） */
function normalizedName(name) {
    return String(name || '').replace(/[^A-Za-z0-9_-]/g, '_');
}

/** 判断是否为绝对路径：Windows 盘符、POSIX 根、UNC 共享。
 *  目录选择器只接受绝对路径；相对路径（~、.、空）一律当作「没有起始目录」。 */
function isAbsoluteDir(p) {
    return /^[A-Za-z]:[\\/]/.test(p) || /^\//.test(p) || /^\\\\/.test(p);
}

/** 读取数字输入：留空返回 undefined（超时留空 = 不传该子项） */
function readNumber(input) {
    if (!input) return undefined;
    const raw = String(input.value == null ? '' : input.value).trim();
    if (raw === '') return undefined;
    return Number(raw);
}

/** 超时对象校验：每项必须是正整数毫秒 */
function firstInvalidTimeout(timeout) {
    const keys = Object.keys(timeout || {});
    for (let i = 0; i < keys.length; i += 1) {
        const value = timeout[keys[i]];
        if (!Number.isInteger(value) || value <= 0) return keys[i];
    }
    return '';
}

// ============================================================
// 键值对（Headers / environment）
// ============================================================

/** 从键值对容器收集对象；空键忽略，值原样保留 */
function readKv(container) {
    const out = {};
    if (!container) return out;
    container.querySelectorAll('.mcp-kv-row').forEach(function (row) {
        const keyInput = row.querySelector('.mcp-kv-key');
        const valueInput = row.querySelector('.mcp-kv-value');
        if (!keyInput) return;
        const key = keyInput.value.trim();
        if (key) out[key] = valueInput ? valueInput.value : '';
    });
    return out;
}

/** 追加一行键值对输入（DOM API 构建，天然避免 HTML 注入） */
function appendKvRow(container, key, value) {
    if (!container) return null;
    const row = document.createElement('div');
    row.className = 'mcp-kv-row';

    const keyInput = document.createElement('input');
    keyInput.className = 'mcp-kv-key';
    keyInput.placeholder = 'KEY';
    keyInput.autocomplete = 'off';
    keyInput.value = key == null ? '' : String(key);

    const valueInput = document.createElement('input');
    valueInput.className = 'mcp-kv-value';
    valueInput.placeholder = 'value';
    valueInput.autocomplete = 'off';
    valueInput.value = value == null ? '' : String(value);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'mcp-kv-del';
    delBtn.title = '删除这一项';
    delBtn.setAttribute('aria-label', '删除这一项');
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', function () { row.remove(); });

    row.appendChild(keyInput);
    row.appendChild(valueInput);
    row.appendChild(delBtn);
    container.appendChild(row);
    return row;
}

/** 用对象重建键值对列表 */
function renderKv(container, obj) {
    if (!container) return;
    container.innerHTML = '';
    Object.keys(obj || {}).forEach(function (key) {
        appendKvRow(container, key, obj[key]);
    });
}

// ============================================================
// 表单类型 / OAuth / 高级折叠
// ============================================================

/** 当前选中的类型（以高亮按钮为唯一事实源） */
function currentType() {
    const active = query('[data-mcp-type].btn-primary');
    return active ? active.dataset.mcpType : 'local';
}

/** 切换类型：按钮高亮 + 对应字段组显隐（remote / local） */
function applyType(type) {
    if (!el || !el.modal) return;
    el.modal.querySelectorAll('[data-mcp-type]').forEach(function (btn) {
        btn.classList.toggle('btn-primary', btn.dataset.mcpType === type);
    });
    el.modal.querySelectorAll('[data-mcp-group]').forEach(function (group) {
        group.hidden = group.dataset.mcpGroup !== type;
    });
}

/** 当前 OAuth 单选模式：auto / off / custom */
function readOauthMode() {
    const checked = el && el.oauthModes
        ? el.oauthModes.querySelector('input[name="mcpOauthMode"]:checked')
        : null;
    return checked ? checked.value : 'auto';
}

/** 自定义 OAuth 区块仅在「自定义客户端」时展开 */
function syncOauthCustom() {
    if (el.oauthCustom) el.oauthCustom.hidden = readOauthMode() !== 'custom';
}

/** 高级设置折叠：force 省略时为切换 */
function toggleAdvanced(force) {
    if (!el.advancedBody) return;
    const open = typeof force === 'boolean' ? force : el.advancedBody.hidden;
    el.advancedBody.hidden = !open;
    if (el.advanced) el.advanced.classList.toggle('open', open);
}

/** 未识别字段提示：只展示，不回传（保存时不带 extra） */
function renderUnknown(extra) {
    const keys = Object.keys(extra || {});
    if (el.unknownCount) el.unknownCount.textContent = String(keys.length);
    if (el.unknownWrap) el.unknownWrap.hidden = keys.length === 0;
    if (el.unknownJson) {
        el.unknownJson.textContent = keys.length ? JSON.stringify(extra, null, 2) : '';
        el.unknownJson.hidden = true;
    }
    if (el.btnToggleUnknown) el.btnToggleUnknown.textContent = '查看';
}

/** 名称预览：context7 → context7_ */
function updateNamePreview() {
    if (!el.namePreview || !el.name) return;
    el.namePreview.textContent = (normalizedName(el.name.value.trim()) || 'server') + '_';
}

// ============================================================
// 渲染：列表 / 表单 / 全局超时 / 空状态
// ============================================================

/** 左侧服务器列表：状态点（disabled 为灰）+ 名称 + 类型徽章 */
function renderList() {
    if (!el.list) return;
    el.list.innerHTML = '';
    state.servers.forEach(function (server, index) {
        const item = document.createElement('div');
        const active = state.view === 'server' && !state.isNew && index === state.current;
        item.className = 'mcp-item' + (active ? ' active' : '');
        item.dataset.index = String(index);
        // 名称与类型来自配置文件，统一 escapeHtml 后再拼接
        item.innerHTML =
            '<span class="mcp-dot' + (server.disabled ? '' : ' on') + '"></span>' +
            '<span class="mcp-name">' + escapeHtml(server.name || '(未命名)') + '</span>' +
            '<span class="mcp-tag">' + escapeHtml(server.type || 'local') + '</span>';
        item.title = (server.name || '') + '（' + (server.type || '') + '）' +
            (server.disabled ? ' · 已停用' : '');
        item.addEventListener('click', function () {
            state.current = index;
            state.isNew = false;
            state.view = 'server';
            if (el.formScroll) el.formScroll.scrollTop = 0;
            render();
        });
        el.list.appendChild(item);
    });
}

/** 空状态文本（加载中 / 失败重试 / 无连接器） */
function renderEmptyPanel() {
    if (!el.emptyPanel) return;
    if (el.emptyText) el.emptyText.textContent = state.emptyText || '';
    if (el.emptyReload) el.emptyReload.style.display = state.emptyRetry ? '' : 'none';
}

/** 主渲染入口：按 view 切换右侧三个面板 */
function render() {
    renderList();

    const showForm = state.view === 'server';
    const showGlobal = state.view === 'global';
    const showEmpty = state.view === 'empty';

    if (el.formPanel) el.formPanel.style.display = showForm ? '' : 'none';
    if (el.globalPanel) el.globalPanel.style.display = showGlobal ? '' : 'none';
    if (el.emptyPanel) el.emptyPanel.style.display = showEmpty ? '' : 'none';

    if (showForm) renderForm();
    if (showGlobal) renderGlobalTimeout();
    if (showEmpty) renderEmptyPanel();
}

/** 表单回填：新增态用空白默认值，编辑态用 state.servers[current] */
function renderForm() {
    const blank = {
        name: '',
        type: 'local',
        url: '',
        headers: {},
        command: [],
        cwd: '',
        environment: {},
        disabled: false,
        codemode: undefined,
        pool: undefined,
        protocol: 'legacy',
        timeout: {},
        oauth: undefined,
        extra: {}
    };
    const server = state.isNew
        ? blank
        : (state.servers[state.current] || blank);

    // 基础字段
    el.name.value = server.name || '';
    el.url.value = server.url || '';
    el.command.value = (server.command || []).join('\n');
    el.cwd.value = server.cwd || '';
    // 界面「启用」= !disabled
    el.enabled.checked = !server.disabled;

    // Code Mode 默认开启：只有显式 codemode:false 才是关闭（未设置也视为开启）
    el.codemode.checked = server.codemode !== false;
    el.pool.checked = server.pool === true;
    el.protocol.value = server.protocol || 'legacy';

    // 单个连接器超时（留空即不传）
    const timeout = server.timeout || {};
    el.timeoutStartup.value = timeout.startup === undefined ? '' : timeout.startup;
    el.timeoutCatalog.value = timeout.catalog === undefined ? '' : timeout.catalog;
    el.timeoutExecution.value = timeout.execution === undefined ? '' : timeout.execution;

    // 类型按钮与字段组
    applyType(server.type === 'remote' ? 'remote' : 'local');

    // 键值对
    renderKv(el.headers, server.headers);
    renderKv(el.env, server.environment);

    // OAuth 三态回填
    const mode = server.oauth === false
        ? 'off'
        : (server.oauth && typeof server.oauth === 'object' ? 'custom' : 'auto');
    if (el.oauthModes) {
        el.oauthModes.querySelectorAll('input[name="mcpOauthMode"]').forEach(function (radio) {
            radio.checked = radio.value === mode;
        });
    }
    const oauth = (server.oauth && typeof server.oauth === 'object') ? server.oauth : {};
    el.oauthClientId.value = oauth.client_id || '';
    el.oauthClientSecret.value = oauth.client_secret || '';
    el.oauthScope.value = oauth.scope || '';
    el.oauthCallbackPort.value = oauth.callback_port === undefined ? '' : oauth.callback_port;
    el.oauthRedirectUri.value = oauth.redirect_uri || '';
    el.oauthMetadataUrl.value = oauth.auth_server_metadata_url || '';
    syncOauthCustom();

    // 未识别字段提示
    renderUnknown(server.extra || {});

    // 标题 / 删除按钮 / 名称预览
    if (el.formTitle) el.formTitle.textContent = state.isNew ? '新增连接器' : (server.name || '连接器');
    if (el.btnDelete) el.btnDelete.style.visibility = state.isNew ? 'hidden' : 'visible';
    updateNamePreview();
}

/** 全局超时面板回填 */
function renderGlobalTimeout() {
    const timeout = state.globalTimeout || {};
    el.gStartup.value = timeout.startup === undefined ? '' : timeout.startup;
    el.gCatalog.value = timeout.catalog === undefined ? '' : timeout.catalog;
    el.gExecution.value = timeout.execution === undefined ? '' : timeout.execution;
}

// ============================================================
// 数据加载
// ============================================================

/**
 * 拉取全局 MCP 配置并渲染。
 * @param {string} [preferredName] 拉取后希望选中的连接器名称（保存/删除后定位用）
 */
async function loadMcpConfig(preferredName) {
    if (!el) return;

    let data;
    try {
        data = await api.GetMcpConfig();
    } catch (e) {
        // 后端方法尚未就绪 / Web 通道异常：显示可重试的空状态，而不是白屏
        state.servers = [];
        state.globalTimeout = {};
        state.current = -1;
        state.isNew = false;
        state.view = 'empty';
        state.emptyText = '读取 MCP 配置失败：' + formatApiError(e);
        state.emptyRetry = true;
        render();
        showApiError('读取 MCP 配置失败: ', e);
        return;
    }

    data = data && typeof data === 'object' ? data : {};
    state.servers = Array.isArray(data.servers)
        ? data.servers.filter(function (item) { return item && typeof item === 'object'; })
        : [];
    state.globalTimeout = (data.timeout && typeof data.timeout === 'object') ? data.timeout : {};
    state.isNew = false;
    state.emptyRetry = false;

    // 定位到指定连接器；否则默认第一个
    let index = -1;
    if (preferredName) {
        index = state.servers.findIndex(function (server) {
            return (server.name || '') === preferredName;
        });
    }
    if (index < 0) index = 0;

    if (!state.servers.length) {
        state.current = -1;
        state.view = 'empty';
        state.emptyText = '还没有 MCP 连接器。点左侧「+ 新增连接器」创建第一个。';
    } else {
        state.current = index;
        state.view = 'server';
        state.emptyText = '从左侧选择一个连接器，或点「新增连接器」';
    }
    render();
}

// ============================================================
// 表单收集与校验
// ============================================================

/** 收集表单值（不含 extra；extra 保存时不回传） */
function collectForm() {
    const timeout = {};
    const startup = readNumber(el.timeoutStartup);
    const catalog = readNumber(el.timeoutCatalog);
    const execution = readNumber(el.timeoutExecution);
    if (startup !== undefined) timeout.startup = startup;
    if (catalog !== undefined) timeout.catalog = catalog;
    if (execution !== undefined) timeout.execution = execution;

    // OAuth 三态：auto 不传；off 传 false；custom 传对象
    let oauth;
    const mode = readOauthMode();
    if (mode === 'off') {
        oauth = false;
    } else if (mode === 'custom') {
        oauth = {};
        const clientId = el.oauthClientId.value.trim();
        const clientSecret = el.oauthClientSecret.value;
        const scope = el.oauthScope.value.trim();
        const callbackPort = readNumber(el.oauthCallbackPort);
        const redirectUri = el.oauthRedirectUri.value.trim();
        const metadataUrl = el.oauthMetadataUrl.value.trim();
        if (clientId) oauth.client_id = clientId;
        if (clientSecret) oauth.client_secret = clientSecret;
        if (scope) oauth.scope = scope;
        if (callbackPort !== undefined) oauth.callback_port = callbackPort;
        if (redirectUri) oauth.redirect_uri = redirectUri;
        if (metadataUrl) oauth.auth_server_metadata_url = metadataUrl;
    }

    return {
        name: el.name.value.trim(),
        type: currentType(),
        url: el.url.value.trim(),
        headers: readKv(el.headers),
        command: el.command.value.split('\n').map(function (line) {
            return line.trim();
        }).filter(Boolean),
        cwd: el.cwd.value.trim(),
        environment: readKv(el.env),
        disabled: !el.enabled.checked,
        // 勾选 Code Mode = 使用默认（不写该键）；取消 = 显式关闭
        codemode: el.codemode.checked ? undefined : false,
        pool: el.pool.checked ? true : undefined,
        protocol: el.protocol.value,
        timeout: timeout,
        oauth: oauth
    };
}

/** 表单校验：名称必填/不重复、local 有命令、remote 是 http(s)、超时正整数、端口范围 */
function validateServer(data) {
    if (!data.name) {
        showToast('请填写连接器名称', 'error');
        el.name.focus();
        return false;
    }

    // 名称不重复：编辑态排除自身
    const duplicated = state.servers.some(function (server, index) {
        if (!state.isNew && index === state.current) return false;
        return (server.name || '') === data.name;
    });
    if (duplicated) {
        showToast('名称「' + data.name + '」已存在', 'error');
        el.name.focus();
        return false;
    }

    if (data.type === 'local' && data.command.length === 0) {
        showToast('local 类型必须填写启动命令', 'error');
        el.command.focus();
        return false;
    }

    if (data.type === 'remote' && !/^https?:\/\/\S+$/i.test(data.url)) {
        showToast('remote 类型需要 http(s) 开头的绝对 URL', 'error');
        el.url.focus();
        return false;
    }

    const invalidTimeoutKey = firstInvalidTimeout(data.timeout);
    if (invalidTimeoutKey) {
        showToast('超时必须是正整数毫秒（' + invalidTimeoutKey + '）', 'error');
        return false;
    }

    // callback_port 仅自定义 OAuth 时有意义
    if (data.oauth && typeof data.oauth === 'object' && data.oauth.callback_port !== undefined) {
        const port = data.oauth.callback_port;
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            showToast('callback_port 必须是 1–65535 的整数', 'error');
            el.oauthCallbackPort.focus();
            return false;
        }
    }
    return true;
}

// ============================================================
// 保存 / 删除 / 全局超时保存
// ============================================================

/** 保存单个连接器 */
async function saveServer() {
    const data = collectForm();
    if (!validateServer(data)) return;

    const oldName = (!state.isNew && state.servers[state.current])
        ? (state.servers[state.current].name || '')
        : '';

    // 契约字段：类型无关字段也传空值，保证后端能完整覆盖条目
    const payload = {
        oldName: oldName,
        name: data.name,
        type: data.type,
        command: data.type === 'local' ? data.command : [],
        cwd: data.type === 'local' ? data.cwd : '',
        environment: data.type === 'local' ? data.environment : {},
        url: data.type === 'remote' ? data.url : '',
        headers: data.type === 'remote' ? data.headers : {},
        disabled: data.disabled,
        protocol: data.protocol,
        timeout: data.timeout
    };
    // 三态字段：仅在需要表达语义时传（不勾选/自动 = 不传）
    if (data.codemode === false) payload.codemode = false;
    if (data.pool === true) payload.pool = true;
    if (data.type === 'remote' && data.oauth !== undefined) payload.oauth = data.oauth;

    setBusy(el.btnSave, true, '保存中…', '保存');
    try {
        const res = await api.SaveMcpServer(payload);
        assertOk(res, '保存失败');
        showToast(oldName ? ('已更新连接器: ' + data.name) : ('已新增连接器: ' + data.name), 'success');
        // 重新拉取，保持列表与表单一致，并定位到刚保存的条目
        await loadMcpConfig(data.name);
    } catch (e) {
        showApiError('保存失败: ', e);
    } finally {
        setBusy(el.btnSave, false, '保存中…', '保存');
    }
}

/** 删除当前连接器（需二次确认） */
async function deleteServer() {
    if (state.isNew || state.current < 0) return;
    const server = state.servers[state.current];
    if (!server) return;

    const name = server.name || '';
    const confirmed = await showConfirm({
        title: '删除连接器',
        message: '确定要删除连接器「' + name + '」吗？该操作会立即写入配置文件。',
        okText: '删除'
    });
    if (!confirmed) return;

    setBusy(el.btnDelete, true, '删除中…', '删除');
    try {
        const res = await api.DeleteMcpServer(name);
        assertOk(res, '删除失败');
        showToast('已删除连接器: ' + name, 'success');
        // 重新拉取：列表与表单同步（默认选中第一个，空列表时进入空状态）
        await loadMcpConfig();
    } catch (e) {
        showApiError('删除失败: ', e);
    } finally {
        setBusy(el.btnDelete, false, '删除中…', '删除');
    }
}

/** 保存全局默认超时（留空 = 不传该子项） */
async function saveGlobalTimeouts() {
    const next = {};
    const startup = readNumber(el.gStartup);
    const catalog = readNumber(el.gCatalog);
    const execution = readNumber(el.gExecution);
    if (startup !== undefined) next.startup = startup;
    if (catalog !== undefined) next.catalog = catalog;
    if (execution !== undefined) next.execution = execution;

    const invalidKey = firstInvalidTimeout(next);
    if (invalidKey) {
        showToast('超时必须是正整数毫秒（' + invalidKey + '）', 'error');
        return;
    }

    setBusy(el.btnGlobalSave, true, '保存中…', '保存');
    try {
        const res = await api.SaveMcpTimeouts(next);
        assertOk(res, '保存失败');
        state.globalTimeout = next;
        showToast('全局默认超时已保存', 'success');
    } catch (e) {
        showApiError('保存失败: ', e);
    } finally {
        setBusy(el.btnGlobalSave, false, '保存中…', '保存');
    }
}

// ============================================================
// 视图动作
// ============================================================

/** 打开弹窗：每次打开都重新拉取，避免读到旧数据 */
function openMcpModal() {
    if (!el) return;
    el.overlay.style.display = 'flex';
    state.view = 'empty';
    state.current = -1;
    state.isNew = false;
    state.emptyText = '正在读取 MCP 配置…';
    state.emptyRetry = false;
    toggleAdvanced(false);
    render();
    loadMcpConfig();
}

/** 关闭弹窗（不提交任何修改） */
function closeMcpModal() {
    if (!el) return;
    el.overlay.style.display = 'none';
}

/** 进入新增态 */
function startNewServer() {
    if (!el) return;
    state.view = 'server';
    state.isNew = true;
    state.current = -1;
    toggleAdvanced(false);
    if (el.formScroll) el.formScroll.scrollTop = 0;
    render();
    if (el.name) el.name.focus();
}

/** 进入全局超时面板 */
function openGlobalTimeout() {
    if (!el) return;
    state.isNew = false;
    state.view = 'global';
    render();
}

/** 从全局超时面板返回连接器表单 */
function backFromGlobal() {
    if (!el) return;
    if (state.servers.length) {
        if (state.current < 0 || state.current >= state.servers.length) state.current = 0;
        state.view = 'server';
    } else {
        state.current = -1;
        state.view = 'empty';
    }
    render();
}

/** 取消：放弃当前未保存输入；新增态回到列表第一个 */
function cancelEdit() {
    if (!el) return;
    if (state.isNew) {
        state.isNew = false;
        state.current = state.servers.length ? 0 : -1;
        state.view = state.servers.length ? 'server' : 'empty';
    }
    render();
}

/** 展开/收起未识别字段 JSON */
function toggleUnknownJson() {
    if (!el.unknownJson) return;
    el.unknownJson.hidden = !el.unknownJson.hidden;
    if (el.btnToggleUnknown) el.btnToggleUnknown.textContent = el.unknownJson.hidden ? '查看' : '收起';
}

/** 新增一行键值对（header / env），并聚焦键名输入 */
function addKvRow(kind) {
    const container = kind === 'env' ? el.env : el.headers;
    const row = appendKvRow(container, '', '');
    if (row) {
        const keyInput = row.querySelector('.mcp-kv-key');
        if (keyInput) keyInput.focus();
    }
}

// ============================================================
// DOM 引用收集与事件绑定
// ============================================================

function collectEl() {
    return {
        overlay: document.getElementById('mcpModal'),
        modal: document.querySelector('#mcpModal .mcp-modal'),
        list: document.getElementById('mcpList'),

        formPanel: document.getElementById('mcpFormPanel'),
        formScroll: document.getElementById('mcpFormScroll'),
        globalPanel: document.getElementById('mcpGlobalPanel'),
        emptyPanel: document.getElementById('mcpEmpty'),
        emptyText: document.getElementById('mcpEmptyText'),
        emptyReload: document.getElementById('btnMcpReload'),

        formTitle: document.getElementById('mcpFormTitle'),

        name: document.getElementById('mcpName'),
        namePreview: document.getElementById('mcpNamePreview'),
        enabled: document.getElementById('mcpEnabled'),
        url: document.getElementById('mcpUrl'),
        command: document.getElementById('mcpCommand'),
        cwd: document.getElementById('mcpCwd'),
        headers: document.getElementById('mcpHeaders'),
        env: document.getElementById('mcpEnv'),

        codemode: document.getElementById('mcpCodemode'),
        pool: document.getElementById('mcpPool'),
        protocol: document.getElementById('mcpProtocol'),
        timeoutStartup: document.getElementById('mcpTimeoutStartup'),
        timeoutCatalog: document.getElementById('mcpTimeoutCatalog'),
        timeoutExecution: document.getElementById('mcpTimeoutExecution'),

        oauthModes: document.getElementById('mcpOauthModes'),
        oauthCustom: document.getElementById('mcpOauthCustom'),
        oauthClientId: document.getElementById('mcpOauthClientId'),
        oauthClientSecret: document.getElementById('mcpOauthClientSecret'),
        oauthScope: document.getElementById('mcpOauthScope'),
        oauthCallbackPort: document.getElementById('mcpOauthCallbackPort'),
        oauthRedirectUri: document.getElementById('mcpOauthRedirectUri'),
        oauthMetadataUrl: document.getElementById('mcpOauthMetadataUrl'),

        unknownWrap: document.getElementById('mcpUnknownWrap'),
        unknownCount: document.getElementById('mcpUnknownCount'),
        unknownJson: document.getElementById('mcpUnknownJson'),
        btnToggleUnknown: document.getElementById('btnMcpToggleUnknown'),

        advanced: document.getElementById('mcpAdvanced'),
        advancedBody: document.getElementById('mcpAdvancedBody'),

        gStartup: document.getElementById('mcpGlobalStartup'),
        gCatalog: document.getElementById('mcpGlobalCatalog'),
        gExecution: document.getElementById('mcpGlobalExecution'),

        btnDelete: document.getElementById('btnMcpDelete'),
        btnSave: document.getElementById('btnMcpSave'),
        btnGlobalSave: document.getElementById('btnMcpGlobalSave')
    };
}

/**
 * 初始化 MCP 连接器弹窗：绑定入口按钮、关闭方式与表单交互（幂等）。
 * 由 main.js 在 initMain 中调用。
 */
export function initMcpConfig() {
    if (state.initialized) return;
    el = collectEl();
    // index.html 未提供弹窗（旧版本）时直接跳过，不影响其它模块
    if (!el.overlay || !el.modal) return;

    // 入口按钮
    bindClick('btnOpenMcp', openMcpModal);

    // 关闭：按钮 + 遮罩（按下/松开都在遮罩上才算）+ Esc
    bindClick('btnMcpClose', closeMcpModal);
    bindOverlayClose(el.overlay, closeMcpModal);
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (el.overlay.style.display !== 'flex') return;
        closeMcpModal();
    });

    // 左侧操作
    bindClick('btnMcpAdd', startNewServer);
    bindClick('btnMcpGlobalTimeout', openGlobalTimeout);
    bindClick('btnMcpReload', function () { loadMcpConfig(); });

    // cwd 目录选择：桌面端 = 系统原生对话框，Web 端 = 站内目录浏览器。
    // 传入当前 cwd（仅绝对路径）作为起始位置，让用户从已有目录继续浏览。
    bindClick('btnMcpPickCwd', async function () {
        const current = (el.cwd.value || '').trim();
        const start = isAbsoluteDir(current) ? current : '';
        try {
            const dir = isBrowserRuntimeForMain()
                ? await openDirBrowserModal(start)
                : await api.OpenDirectoryDialogAt(start);
            if (dir) el.cwd.value = dir;
        } catch (e) {
            // 取消选择已由 openDirBrowserModal 以空串 resolve，这里只会是真正的错误
            showApiError('选择目录失败: ', e);
        }
    });

    // 表单底部操作
    bindClick('btnMcpSave', saveServer);
    bindClick('btnMcpDelete', deleteServer);
    bindClick('btnMcpCancel', cancelEdit);

    // 全局超时面板
    bindClick('btnMcpGlobalBack', backFromGlobal);
    bindClick('btnMcpGlobalSave', saveGlobalTimeouts);

    // 类型切换（remote / local）
    if (el.modal) {
        el.modal.querySelectorAll('[data-mcp-type]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                applyType(btn.dataset.mcpType);
            });
        });
    }

    // 高级设置折叠
    if (el.advanced) {
        el.advanced.addEventListener('click', function () { toggleAdvanced(); });
    }

    // 键值对新增
    if (el.modal) {
        el.modal.querySelectorAll('[data-mcp-add-kv]').forEach(function (btn) {
            btn.addEventListener('click', function () { addKvRow(btn.dataset.mcpAddKv); });
        });
    }

    // 名称预览
    if (el.name) {
        el.name.addEventListener('input', updateNamePreview);
    }

    // OAuth 模式切换：仅自定义时展开详细字段
    if (el.oauthModes) {
        el.oauthModes.addEventListener('change', syncOauthCustom);
    }

    // 未识别字段 JSON 展开/收起
    if (el.btnToggleUnknown) {
        el.btnToggleUnknown.addEventListener('click', toggleUnknownJson);
    }

    state.initialized = true;
}
