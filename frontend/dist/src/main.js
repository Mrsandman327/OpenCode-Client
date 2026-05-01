// ============================================================
// OpenCode 管理中心 - 前端主逻辑
// ============================================================

// ============================================================
// 主题切换
// ============================================================
const THEME_KEY = 'oc-manager-theme';

function getTheme() {
    return localStorage.getItem(THEME_KEY) || 'dark';
}

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
    updateThemeIcon(theme);
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

// ============================================================
// Wails API 封装（含 mock 回退）
// ============================================================
const api = (() => {
    if (window.go && window.go.main && window.go.main.App) {
        return window.go.main.App;
    }

    console.warn('⚠️ 非 Wails 环境，使用模拟数据');

    const mockCommands = [
        { title: 'CLI - 会话', isTui: false, cmds: [
            { name: 'run', sub: '', options: '-m model, -c, -s ID, -f file, --agent', desc: '非交互式运行提示词，适合脚本/自动化' },
            { name: 'session', sub: 'list', options: '-n N, --format json', desc: '列出所有会话，支持表格/JSON格式' },
            { name: 'stats', sub: '', options: '--days N, --models', desc: '显示Token用量和费用统计' },
            { name: 'export', sub: '', options: '[sessionID]', desc: '导出会话为JSON' },
            { name: 'import', sub: '', options: 'file.json|url', desc: '从JSON文件或分享链接导入会话' },
        ]},
        { title: 'CLI - 代理', isTui: false, cmds: [
            { name: 'agent', sub: 'create, list', options: '', desc: '创建/列出自定义代理' },
            { name: 'github', sub: 'install, run', options: '--event, --token', desc: 'GitHub仓库自动化代理' },
        ]},
        { title: 'CLI - 服务', isTui: false, cmds: [
            { name: 'serve', sub: '', options: '--port, --hostname', desc: '启动无界面API服务器' },
            { name: 'web', sub: '', options: '--port, --hostname', desc: '启动Web界面' },
            { name: 'acp', sub: '', options: '--port, --cwd', desc: '启动ACP(stdin/stdout)服务器' },
            { name: 'attach', sub: '', options: 'url --dir --session', desc: '连接远程OpenCode后端' },
        ]},
        { title: 'CLI - 配置', isTui: false, cmds: [
            { name: 'auth', sub: 'login, list, logout', options: '', desc: '管理提供商API密钥' },
            { name: 'mcp', sub: 'add, list, auth, logout, debug', options: '', desc: '管理MCP服务器配置' },
            { name: 'models', sub: '', options: '--refresh, --verbose, [provider]', desc: '列出已配置提供商的可用模型' },
        ]},
        { title: 'CLI - 维护', isTui: false, cmds: [
            { name: 'upgrade', sub: '', options: '-m curl|npm|brew, [version]', desc: '更新到最新或指定版本' },
            { name: 'uninstall', sub: '', options: '-c, -d, --force, --dry-run', desc: '卸载并删除相关文件' },
        ]},
        { title: 'TUI - 会话管理', isTui: true, cmds: [
            { name: '/new', sub: '/clear', options: 'ctrl+x n', desc: '开始新会话' },
            { name: '/compact', sub: '/summarize', options: 'ctrl+x c', desc: '压缩会话上下文' },
            { name: '/undo', sub: '', options: 'ctrl+x u', desc: '撤销最后消息(需Git仓库)' },
            { name: '/redo', sub: '', options: 'ctrl+x r', desc: '重做撤销(需Git仓库)' },
            { name: '/exit', sub: '/quit /q', options: 'ctrl+x q', desc: '退出OpenCode' },
        ]},
        { title: 'TUI - 信息查看', isTui: true, cmds: [
            { name: '/help', sub: '', options: 'ctrl+x h', desc: '显示帮助/命令面板' },
            { name: '/models', sub: '', options: 'ctrl+x m', desc: '列出可用模型' },
            { name: '/themes', sub: '', options: 'ctrl+x t', desc: '列出可用主题' },
            { name: '/thinking', sub: '', options: '', desc: '切换思考块可见性' },
            { name: '/details', sub: '', options: 'ctrl+x d', desc: '切换工具执行详情' },
        ]},
        { title: 'TUI - 操作', isTui: true, cmds: [
            { name: '/init', sub: '', options: 'ctrl+x i', desc: '创建/更新AGENTS.md' },
            { name: '/connect', sub: '', options: '', desc: '添加提供商API密钥' },
            { name: '/editor', sub: '', options: 'ctrl+x e', desc: '用外部编辑器编写消息($EDITOR)' },
            { name: '/export', sub: '', options: 'ctrl+x x', desc: '导出对话为Markdown' },
            { name: '/share', sub: '', options: 'ctrl+x s', desc: '分享当前会话' },
            { name: '/unshare', sub: '', options: '', desc: '取消分享' },
            { name: '/sessions', sub: '/resume /continue', options: 'ctrl+x l', desc: '列出/切换会话' },
        ]},
    ];

    const mockSkills = [
        { name: 'afsim-scripts', description: 'AFSIM脚本编写助手', sourcePath: '~/.cc-switch/skills/afsim-scripts', targets: { opencode: true, claude: true, codex: true } },
        { name: 'code-review', description: '专业的代码审查助手', sourcePath: '~/.cc-switch/skills/code-review', targets: { opencode: true, claude: true, codex: true } },
        { name: 'docx', description: 'Word文档创建编辑', sourcePath: '~/.cc-switch/skills/docx', targets: { opencode: true, claude: true, codex: true } },
        { name: 'skill-creator', description: '创建新技能指南', sourcePath: '~/.cc-switch/skills/skill-creator', targets: { opencode: true, claude: true, codex: false } },
        { name: 'standards-golang', description: 'Go开发标准', sourcePath: '~/.cc-switch/skills/standards-golang', targets: { opencode: false, claude: true, codex: true } },
        { name: 'weather', description: '天气预报', sourcePath: '~/.cc-switch/skills/weather', targets: { opencode: true, claude: false, codex: false } },
        { name: 'drawio', description: '图表绘制', sourcePath: '~/.cc-switch/skills/drawio', targets: { opencode: true, claude: true, codex: false } },
        { name: 'karpathy-wiki', description: '本地知识库/wiki管理', sourcePath: '~/.cc-switch/skills/karpathy-wiki', targets: { opencode: true, claude: false, codex: false } },
        { name: 'pdf', description: 'PDF文档处理', sourcePath: '~/.cc-switch/skills/pdf', targets: { opencode: false, claude: true, codex: true } },
        { name: 'pptx', description: '幻灯片创建编辑', sourcePath: '~/.cc-switch/skills/pptx', targets: { opencode: false, claude: false, codex: true } },
        { name: 'web-access', description: '联网搜索与网页抓取', sourcePath: '~/.cc-switch/skills/web-access', targets: { opencode: true, claude: true, codex: true } },
        { name: 'xlsx', description: '电子表格处理', sourcePath: '~/.cc-switch/skills/xlsx', targets: { opencode: false, claude: true, codex: true } },
    ];

    return {
        GetSkills: async () => JSON.parse(JSON.stringify(mockSkills)),
        GetTargets: async () => [
            { key: 'opencode', label: 'OpenCode', path: '~/.config/opencode/skills' },
            { key: 'claude',   label: 'Claude Code', path: '~/.claude/skills' },
            { key: 'codex',    label: 'Codex', path: '~/.codex/skills' },
        ],
        GetSourceDir: async () => '~/.cc-switch/skills',
        GetStats: async () => ({
            totalSkills: mockSkills.length,
            targetStats: { opencode: 8, claude: 9, codex: 7 },
        }),
        ToggleSkill: async (name, target, enable) => ({ skillName: name, target, linked: enable, success: true }),
        ToggleAllSkills: async (target, enable) => ({ target, enabled: enable, success: true, errors: [] }),
        Refresh: async () => {},
        OpenDir: async (path) => { console.log('mock open:', path); showToast(`模拟打开目录: ${path}`, 'info'); },
        OpenDirectoryDialog: async () => workDir || 'E:\\data\\ai_test\\feishu\\skill-manager',
    StartTerminal: async () => { console.log('mock terminal start'); },
    TerminalWrite: async (data) => { console.log('mock term write:', data); },
    GetSessions: async () => [
        { id: 'ses_abc123', title: '开发 Skill 桌面管理工具' },
        { id: 'ses_def456', title: 'OpenCode 模型配置管理' },
    ],
    RunOpenCode: async (sid, cont) => { console.log('mock launch:', sid, cont); },
        // web 管理
        StartOpenCodeWeb: async (port) => {
            webPort = port || 4096;
            webRunning = true;
            updateWebUI();
            return { running: true, success: true, port: webPort, url: `http://127.0.0.1:${webPort}` };
        },
        StopOpenCodeWeb: async () => {
            webRunning = false; webPort = 0;
            updateWebUI(); clearClientUI();
            return { success: true };
        },
        GetWebStatus: async () => {
            return { running: webRunning, port: webPort, url: webPort ? `http://127.0.0.1:${webPort}` : '' };
        },
        LaunchWindowsTerminal: async (mode, url, dir) => {
            console.log('mock launch wt:', mode, url, dir);
            showToast('模拟启动终端' + (dir ? ' 目录:' + dir : ''), 'info');
            return { success: true };
        },
        OpenCodeAPI: async (method, path, body) => {
            if (method === 'POST' && path === '/session') return { success: true, status: 200, body: JSON.stringify({ id: 'ses_new_' + Date.now(), title: '新会话' }) };
            if (path === '/session') return { success: true, status: 200, body: JSON.stringify([
                { id: 'ses_abc123', title: '开发 Skill 桌面管理工具' },
                { id: 'ses_def456', title: 'OpenCode 模型配置管理' },
            ]) };
            if (path.includes('/message')) return { success: true, status: 200, body: JSON.stringify([
                { info: { role: 'user' }, parts: [{ text: '这是模拟消息' }] },
                { info: { role: 'assistant' }, parts: [{ type: 'text', text: '这是模拟回复' }, { type: 'tool', tool: 'read', state: { status: 'completed' } }] },
            ]) };
            if (path.includes('/diff')) return { success: true, status: 200, body: JSON.stringify([{ path: 'main.go', hunks: [{ lines: ['+ mock diff'] }] }]) };
            return { success: true, status: 200, body: '{}' };
        },
        StartOpenCodeEvents: async () => ({ success: true }),
        StopOpenCodeEvents: async () => ({ success: true }),
        // 模型配置
        GetModelConfig: async () => [
            { key: 'sisyphus', type: 'agent', model: 'deepseek/deepseek-v4-pro', label: '执行者', comment: '执行者：负责执行具体任务' },
            { key: 'oracle', type: 'agent', model: 'deepseek/deepseek-v4-flash', label: '分析师', comment: '分析师：代码质量审查与安全分析' },
            { key: 'librarian', type: 'agent', model: 'deepseek/deepseek-v4-flash', label: '搜索员', comment: '搜索员：代码库搜索与知识检索' },
            { key: 'quick', type: 'category', model: 'deepseek/deepseek-v4-flash', label: '快速', comment: '快速：简单问答和日常快速任务' },
            { key: 'visual-engineering', type: 'category', model: 'deepseek/deepseek-v4-flash', label: '视觉', comment: '视觉工程：UI设计和前端实现' },
        ],
        GetAvailableModels: async () => [
            'deepseek/deepseek-chat', 'deepseek/deepseek-reasoner',
            'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro',
            'openai/gpt-5.1-codex', 'openai/gpt-5.5',
            'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-5',
        ],
    RefreshAvailableModels: async () => [
        'deepseek/deepseek-chat', 'deepseek/deepseek-reasoner',
        'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro',
        'openai/gpt-5.1-codex', 'openai/gpt-5.5',
        'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-5',
    ],
    GetProviders: async () => [
        { key: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-ec****ffe1', enabled: true, models: [{id:'deepseek-v4-pro',name:'DeepSeek-V4-Pro'}] },
        { key: 'siliconflow', name: 'SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1', apiKey: 'sk-vg****bshs', enabled: false, models: [] },
    ],
        SaveProvider: async (p) => ({ success: true }),
        DeleteProvider: async (key) => ({ success: true }),
        GetProviderConfigPath: async () => '~/.config/opencode/opencode.jsonc',
        GetWorkDir: async () => 'E:\\data\\ai_test\\feishu\\skill-manager',
        AddModelType: async () => ({ success: true }),
        DeleteModelType: async () => ({ success: true }),
};
})();

// ============================================================
// DOM 快捷引用
// ============================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ============================================================
// Toast 通知
// ============================================================
let toastTimer = null;

function showToast(message, type = 'info') {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove('show');
    }, 2800);
}

// ============================================================
// 工具函数
// ============================================================
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================================
// 侧边栏导航
// ============================================================
function switchView(viewId) {
    // 更新导航项高亮
    $$('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.view === viewId);
    });

    // 切换视图面板
    $$('.view-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === viewId);
    });

    // 延迟加载各视图数据
    if (viewId === 'view-models') {
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

// ============================================================
// View 1: 工作区 (opencode web)
// ============================================================

let webPort = 0;
let webRunning = false;
let workDir = '';
let currentSessionId = '';
let sessions = [];
let sessionStatuses = {};
let sessionErrors = {};
let refreshTimer = null;
let mcpStatus = null;
let lspStatus = null;
let expandedParts = {};      // 记录展开状态
let markdownCache = {};      // markdown 渲染缓存（key: part id）
let lastMessageCount = 0;    // 上次消息数量
let messageLoadSeq = 0;      // 消息加载序号，避免旧请求覆盖新内容
let messageCache = {};       // 会话消息缓存，用于 SSE 流式增量渲染

async function pickDirectory() {
    try {
        const dir = await api.OpenDirectoryDialog();
        if (dir) {
            workDir = dir;
            updateDirDisplay();
        }
    } catch (e) {
        console.warn('OpenDirectoryDialog failed:', e);
    }
}

function updateDirDisplay() {
    const el = document.getElementById('dirPath');
    if (el) {
        el.value = workDir || '';
        el.className = 'oc-dir-input' + (workDir ? ' set' : '');
    }
    const sideEl = document.getElementById('ocSideDirPath');
    if (sideEl) {
        sideEl.textContent = workDir || '--';
        sideEl.title = workDir || '';
    }
}

async function initWorkDir() {
    try {
        const dir = await api.GetWorkDir();
        if (dir) {
            workDir = dir;
            updateDirDisplay();
        }
    } catch (e) {
        console.warn('GetWorkDir failed:', e);
    }
}

async function checkWebStatus() {
    try {
        const status = await api.GetWebStatus();
        webRunning = status.running;
        webPort = status.port;
        updateWebUI();
        if (webRunning) {
            startEventStream();
            loadSessions();
            loadServiceStatus();
        }
    } catch (e) {
        console.warn('GetWebStatus failed:', e);
    }
}

async function ocApi(method, path, data) {
    const result = await api.OpenCodeAPI(method, path, data ? JSON.stringify(data) : '');
    if (!result.success) {
        throw new Error(result.error || result.body || `HTTP ${result.status}`);
    }
    if (!result.body) return null;
    return JSON.parse(result.body);
}

function safeText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
}

function extractPartText(part) {
    if (!part) return '';
    return part.text || part.content || part.message || part.value || safeText(part);
}

function messageText(item) {
    const parts = item?.parts || item?.info?.parts || [];
    const list = Array.isArray(parts) ? parts : [parts];
    return list.map(part => extractPartText(part)).join('\n').trim();
}

function isInternalUserMessage(item) {
    const info = item?.info || item || {};
    const role = info.role || info.author || '';
    if (role !== 'user') return false;
    const text = messageText(item);
    return text.includes('OMO_INTERNAL_INITIATOR')
        || text.includes('<system-reminder>')
        || text.includes('</system-reminder>')
        || /^\s*\[(?:BACKGROUND TASK COMPLETED|ALL BACKGROUND TASKS COMPLETE)\]/.test(text)
        || (text.includes('background_output(') && text.includes('task_id='));
}

function parseEventPayload(raw) {
    try {
        const event = JSON.parse(raw);
        if (event.payload?.type) {
            return {
                ...event.payload,
                directory: event.directory,
                project: event.project,
            };
        }
        return event;
    } catch { return { type: 'raw', data: raw }; }
}

function startEventStream() {
    if (window.runtime && !startEventStream.bound) {
        window.runtime.EventsOn('oc-event', (raw) => handleOcEvent(parseEventPayload(raw)));
        window.runtime.EventsOn('oc-event-error', (msg) => showToast('事件流异常: ' + msg, 'error'));
        startEventStream.bound = true;
    }
    if (api.StartOpenCodeEvents) api.StartOpenCodeEvents();
}

function handleOcEvent(event) {
    const type = event.type || event.name || '';
    const props = event.properties || event.data || event;
    const sid = props.sessionID || props.sessionId || props.info?.sessionID || props.part?.sessionID || currentSessionId;

    if (type === 'server.connected' || type === 'server.heartbeat') return;

    if (type.includes('permission')) {
        const permission = props.permission ? { ...props.permission, ...props } : props;
        const kind = permission.permission || permission.type || 'tool';
        showToast('权限请求: ' + escapeHtml(kind), 'warning');
    }

    if (type === 'session.error' && sid && props.error) {
        sessionErrors[sid] = typeof props.error === 'string' ? props.error : (props.error.message || safeText(props.error));
        if (sid === currentSessionId) loadMessages();
        return;
    }
    if (type === 'session.status' && sid) {
        sessionStatuses[sid] = props.status || props;
        if (sid === currentSessionId) {
            updateSendButton();
            const status = props.status || props;
            if (status?.type === 'idle') {
                loadMessages();
            } else if (getCachedMessages(sid).length) {
                renderCachedMessages(sid);
            } else {
                loadMessages();
            }
        }
        return;
    }
    if (type === 'session.idle' && sid) {
        delete sessionErrors[sid];
        sessionStatuses[sid] = 'idle';
        if (sid === currentSessionId) {
            updateSendButton();
            loadMessages();
        }
        return;
    }

    if (type === 'message.updated' && props.info) {
        upsertMessage(props.info);
        renderCachedMessages(sid);
        return;
    }
    if (type === 'message.part.updated' && props.part) {
        upsertPart(props.part);
        renderCachedMessages(sid);
        return;
    }
    if (type === 'message.part.delta') {
        applyPartDelta(props);
        renderCachedMessages(sid);
        return;
    }
    if (type === 'message.part.removed') {
        removePart(props);
        renderCachedMessages(sid);
        return;
    }
    if (type === 'message.removed') {
        removeMessage(props);
        renderCachedMessages(sid);
        return;
    }

    if (type === 'session.created' || type === 'session.updated' || type === 'session.deleted') {
        loadSessions();
        loadDiff();
    }
}

function normalizeMessageItem(item) {
    const info = item.info || item;
    const parts = item.parts || info.parts || [];
    return {
        info,
        parts: Array.isArray(parts) ? parts : [parts],
    };
}

function cacheMessages(sessionID, items) {
    const incoming = (items || []).map(normalizeMessageItem).filter(item => !isInternalUserMessage(item));
    if (!isSessionBusy(sessionID) || !messageCache[sessionID]?.length) {
        messageCache[sessionID] = incoming;
        return;
    }
    // 忙碌期间只追加新消息、更新已有消息的元信息，不替换 parts
    // parts 由 delta 事件(applyPartDelta)和 message.part.updated(upsertPart)驱动
    const existing = getCachedMessages(sessionID);
    for (const item of incoming) {
        const key = item.info?.id || item.id;
        const existingIndex = existing.findIndex(old => (old.info?.id || old.id) === key);
        if (existingIndex >= 0) {
            existing[existingIndex].info = { ...existing[existingIndex].info, ...item.info };
        } else {
            existing.push(item);
        }
    }
    messageCache[sessionID] = existing;
}

function mergeMessage(existing, incoming) {
    if (!existing) return incoming;
    const existingParts = Array.isArray(existing.parts) ? existing.parts : [];
    const incomingParts = Array.isArray(incoming.parts) ? incoming.parts : [];
    return {
        info: { ...existing.info, ...incoming.info },
        parts: incomingParts.map(part => mergePart(existingParts.find(old => old.id && old.id === part.id), part)),
    };
}

function mergePart(existing, incoming) {
    if (!existing) return incoming;
    const merged = { ...existing, ...incoming };
    for (const field of ['text', 'content']) {
        const oldText = typeof existing[field] === 'string' ? existing[field] : '';
        const newText = typeof incoming[field] === 'string' ? incoming[field] : '';
        if (oldText && newText && newText.length < oldText.length && !incoming.time?.end) {
            merged[field] = oldText;
        }
    }
    return merged;
}

function getCachedMessages(sessionID) {
    if (!messageCache[sessionID]) messageCache[sessionID] = [];
    return messageCache[sessionID];
}

function renderCachedMessages(sessionID) {
    if (!sessionID || sessionID !== currentSessionId) return;
    renderMessages(getCachedMessages(sessionID));
}

function upsertMessage(info) {
    if (!info?.sessionID || !info.id) return;
    const list = getCachedMessages(info.sessionID);
    if (info.role === 'assistant') {
        messageCache[info.sessionID] = list.filter(item => !(item.info?.id || item.id || '').startsWith('pending_'));
    }
    const nextList = getCachedMessages(info.sessionID);
    const index = nextList.findIndex(item => (item.info?.id || item.id) === info.id);
    if (index >= 0) {
        nextList[index].info = { ...nextList[index].info, ...info };
    } else {
        nextList.push({ info, parts: [] });
    }
}

function upsertPart(part) {
    if (!part?.sessionID || !part.messageID || !part.id) return;
    const list = getCachedMessages(part.sessionID);
    let message = list.find(item => (item.info?.id || item.id) === part.messageID);
    if (!message) {
        message = { info: { id: part.messageID, sessionID: part.sessionID, role: 'assistant' }, parts: [] };
        list.push(message);
    }
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const index = parts.findIndex(item => item.id === part.id);
    if (index >= 0) {
        parts[index] = mergePart(parts[index], part);
    } else {
        parts.push(part);
    }
    message.parts = parts;
}

function applyPartDelta(props) {
    const sessionID = props.sessionID || currentSessionId;
    const field = props.field || 'text';
    if (!sessionID || !props.messageID || !props.partID || typeof props.delta !== 'string') return;
    const list = getCachedMessages(sessionID);
    let message = list.find(item => (item.info?.id || item.id) === props.messageID);
    if (!message) {
        message = { info: { id: props.messageID, sessionID, role: 'assistant' }, parts: [] };
        list.push(message);
    }
    const parts = Array.isArray(message.parts) ? message.parts : [];
    let part = parts.find(item => item.id === props.partID);
    if (!part) {
        part = { id: props.partID, sessionID, messageID: props.messageID, type: field === 'text' ? 'text' : 'reasoning', [field]: '' };
        parts.push(part);
    }
    part[field] = (part[field] || '') + props.delta;
    message.parts = parts;
}

function removePart(props) {
    const sessionID = props.sessionID || currentSessionId;
    if (!sessionID || !props.messageID || !props.partID) return;
    const message = getCachedMessages(sessionID).find(item => (item.info?.id || item.id) === props.messageID);
    if (!message || !Array.isArray(message.parts)) return;
    message.parts = message.parts.filter(part => part.id !== props.partID);
}

function removeMessage(props) {
    const sessionID = props.sessionID || currentSessionId;
    if (!sessionID || !props.messageID) return;
    messageCache[sessionID] = getCachedMessages(sessionID).filter(item => (item.info?.id || item.id) !== props.messageID);
}

function ensurePendingAssistant(sessionID) {
    if (!sessionID) return;
    const list = getCachedMessages(sessionID);
    const last = list[list.length - 1];
    const role = last?.info?.role || last?.role;
    if (role === 'assistant') return;
    list.push({
        info: {
            id: 'pending_' + Date.now(),
            sessionID,
            role: 'assistant',
            time: { created: Date.now() },
        },
        parts: [],
    });
}

async function loadSessions() {
    if (!webRunning) return;
    const list = document.getElementById('ocSessionList');
    list.innerHTML = '<div class="oc-empty">加载会话中...</div>';
    try {
        const [nextSessions, nextStatuses] = await Promise.all([
            ocApi('GET', '/session'),
            loadSessionStatuses(),
        ]);
        sessions = nextSessions || [];
        sessionStatuses = nextStatuses || {};
        renderSessions();
        if (!currentSessionId && sessions.length > 0) {
            await selectSession(sessions[0].id || sessions[0].ID);
        }
    } catch (e) {
        list.innerHTML = `<div class="oc-empty error">${escapeHtml(e.message || e)}</div>`;
    }
}

function renderSessions() {
    const list = document.getElementById('ocSessionList');
    if (!sessions.length) {
        list.innerHTML = '<div class="oc-empty">暂无会话，发送 prompt 将创建新会话</div>';
        return;
    }
    list.innerHTML = '';
    sessions.forEach(session => {
        const id = session.id || session.ID;
        const item = document.createElement('button');
        item.className = 'oc-session-item' + (id === currentSessionId ? ' active' : '');
        item.textContent = session.title || session.name || id;
        item.title = id;
        item.addEventListener('click', () => selectSession(id));
        list.appendChild(item);
    });
}

async function loadSessionStatuses() {
    try {
        return await ocApi('GET', '/session/status') || {};
    } catch {
        return {};
    }
}

async function selectSession(id) {
    currentSessionId = id;
    expandedParts = {};
    markdownCache = {};
    lastMessageCount = 0;
    messageLoadSeq++;
    renderSessions();
    const current = sessions.find(s => (s.id || s.ID) === id);
    document.getElementById('ocChatTitle').textContent = current?.title || current?.name || id || '未选择会话';
    // 显示会话工作目录
    const dirEl = document.getElementById('ocSideDirPath');
    if (dirEl) {
        const dir = current?.directory || '';
        dirEl.textContent = dir || '--';
        dirEl.title = dir || '';
    }
    await loadMessages();
    smartScroll(document.getElementById('ocMessages'), true);
    await loadDiff();
}

async function createNewSession() {
    if (!webRunning) return;
    currentSessionId = '';
    sessionStatuses = {};
    sessionErrors = {};
    document.getElementById('ocChatTitle').textContent = '新建会话';
    document.getElementById('ocMessages').innerHTML = '<div class="oc-empty">输入内容后 Enter 发送，会话将在首次发送时创建</div>';
    document.getElementById('ocDiff').innerHTML = '<div class="oc-empty">选择会话后查看变更</div>';
    document.getElementById('ocPrompt').value = '';
    document.getElementById('ocPrompt').focus();
    // 取消当前会话高亮
    Array.from(document.querySelectorAll('.oc-session-item')).forEach(el => el.classList.remove('active'));
}

async function loadMessages() {
    const box = document.getElementById('ocMessages');
    const seq = ++messageLoadSeq;
    if (!currentSessionId) {
        box.innerHTML = '<div class="oc-empty">选择会话后查看消息，或输入内容创建新会话</div>';
        return;
    }
    try {
        const messages = await ocApi('GET', `/session/${encodeURIComponent(currentSessionId)}/message`);
        if (seq !== messageLoadSeq) return;
        cacheMessages(currentSessionId, messages || []);
        renderMessages(getCachedMessages(currentSessionId));
    } catch (e) {
        if (seq !== messageLoadSeq) return;
        box.innerHTML = `<div class="oc-empty error">${escapeHtml(e.message || e)}</div>`;
    }
}

function renderMessages(items) {
    const box = document.getElementById('ocMessages');
    const scrollState = captureScrollState(box);
    const list = (items || []).map(normalizeMessageItem).filter(item => !isInternalUserMessage(item));
    if (!list.length) {
        box.innerHTML = '<div class="oc-empty">该会话暂无消息</div>';
        lastMessageCount = 0;
        updateModelInfo(null);
        updateScrollBottomButton();
        return;
    }

    const sameCount = list.length === lastMessageCount;
    lastMessageCount = list.length;

    // 消息数没变时做增量更新（只更新最后一条 assistant 消息的 parts）
    if (sameCount && list.length > 0 && webRunning && isSessionBusy(currentSessionId)) {
        const last = list[list.length - 1];
        const lastRole = (last.info || last).role;
        if (lastRole === 'assistant') {
            const lastMsg = box.lastElementChild;
            if (lastMsg && lastMsg.classList.contains('assistant')) {
                const body = lastMsg.querySelector('.oc-message-parts');
                if (body) {
                    const partList = Array.isArray(last.parts) ? last.parts : [last.parts];
                    const newIds = partList.map(p => p.id || '');
                    const existingIds = Array.from(body.children).map(c => c.dataset.partId || '');
                    if (newIds.length > existingIds.length && existingIds.every((id, index) => id === newIds[index])) {
                        // 只追加新增片段，避免正在滚动时整块内容闪动
                        for (let i = existingIds.length; i < newIds.length; i++) {
                            const partEl = renderPart(partList[i]);
                            if (partList[i].id) partEl.dataset.partId = partList[i].id;
                            body.appendChild(partEl);
                        }
                    } else {
                        // 片段数量不变时也可能是流式文本在增长，需要刷新最后一条消息内容
                        body.replaceChildren(...partList.map(part => renderPart(part)));
                    }
                    updateModelInfo(list);
                    restoreScroll(box, scrollState, false);
                    updateScrollBottomButton();
                    return;
                }
            }
        }
    }

    // 全量重建
    box.innerHTML = '';
    list.forEach(item => {
        const info = item.info || item;
        const role = info.role || info.author || 'message';
        const displayRole = role === 'user' ? '你' : (role === 'assistant' ? '助手' : role);
        const parts = item.parts || [];
        const node = document.createElement('div');
        node.className = `oc-message ${role}`;
        node.innerHTML = `<div class="oc-message-role">${escapeHtml(displayRole)}</div>`;
        const body = document.createElement('div');
        body.className = 'oc-message-parts';
        const partList = Array.isArray(parts) ? parts : [parts];
        if (partList.length) {
            partList.forEach(part => body.appendChild(renderPart(part)));
        } else if (role === 'assistant') {
            if (isSessionBusy(currentSessionId)) {
                const pending = document.createElement('div');
                pending.className = 'oc-part pending';
                pending.textContent = getSessionPendingText(currentSessionId);
                body.appendChild(pending);
            } else if (hasSessionError(currentSessionId)) {
                const errEl = document.createElement('div');
                errEl.className = 'oc-part error-msg';
                errEl.textContent = '模型调用失败：' + (sessionErrors[currentSessionId] || '未知错误，请检查 opencode 提供商配置');
                body.appendChild(errEl);
            } else {
                const empty = document.createElement('div');
                empty.className = 'oc-part pending';
                empty.textContent = info.time?.completed ? '已停止或本次未产生回复内容' : '正在等待模型回复...';
                body.appendChild(empty);
            }
        } else {
            const pre = document.createElement('pre');
            pre.textContent = safeText(item);
            body.appendChild(pre);
        }
        node.appendChild(body);
        box.appendChild(node);
    });

    updateModelInfo(items);
    restoreScroll(box, scrollState, false);
    updateScrollBottomButton();
}

function updateModelInfo(items) {
    const agentEl = document.getElementById('ocAgentTag');
    const modelEl = document.getElementById('ocModelTag');
    // 从消息列表中提取最后一条 assistant 消息的 agent/model
    const list = items || [];
    let agent = '';
    let model = '';
    for (let i = list.length - 1; i >= 0; i--) {
        const info = list[i].info || list[i];
        if (info.role === 'assistant') {
            agent = info.agent || '';
            model = info.modelID || (info.model && info.model.modelID) || '';
            if (info.providerID) model = info.providerID + '/' + model;
            break;
        }
    }
    agentEl.textContent = agent ? '🤖 ' + agent : '--';
    agentEl.title = agent || '';
    modelEl.textContent = model ? '🧠 ' + model : '--';
    modelEl.title = model || '';
}

function smartScroll(box, force) {
    const scrollState = captureScrollState(box);
    restoreScroll(box, scrollState, force);
    updateScrollBottomButton();
}

function captureScrollState(box) {
    const distanceToBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
    return {
        top: box.scrollTop,
        height: box.scrollHeight,
        nearBottom: distanceToBottom < 120,
    };
}

function restoreScroll(box, state, force) {
    if (force || state.nearBottom) {
        box.scrollTop = box.scrollHeight;
        updateScrollBottomButton();
        return;
    }
    const heightDelta = box.scrollHeight - state.height;
    box.scrollTop = Math.max(0, state.top + Math.min(0, heightDelta));
    updateScrollBottomButton();
}

function updateScrollBottomButton() {
    const box = document.getElementById('ocMessages');
    const btn = document.getElementById('btnScrollBottom');
    if (!box || !btn) return;
    const canScroll = box.scrollHeight > box.clientHeight + 8;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    btn.classList.toggle('visible', canScroll && !nearBottom);
}

function scrollMessagesToBottom() {
    const box = document.getElementById('ocMessages');
    if (!box) return;
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    setTimeout(updateScrollBottomButton, 180);
}

function isSessionBusy(id) {
    const status = sessionStatuses[id];
    return status === 'busy' || status?.type === 'busy' || status?.type === 'retry' || status?.status === 'busy';
}

function hasSessionError(id) {
    return !!sessionErrors[id];
}

function getSessionPendingText(id) {
    const status = sessionStatuses[id];
    if (status?.type === 'retry') {
        return `模型连接失败，正在第 ${status.attempt || 1} 次重试：${status.message || '等待下一次重试'}`;
    }
    return '正在等待模型回复...';
}

function renderPart(part) {
    const type = part?.type || '';
    const id = part?.id || '';
    let el;
    switch (type) {
        case 'step-start': el = renderStepDivider(part, 'start'); break;
        case 'step-finish': el = renderStepDivider(part, 'finish'); break;
        case 'reasoning': el = renderReasoning(part); break;
        case 'tool': el = renderTool(part); break;
        case 'text': el = renderTextPart(part); break;
        case 'file': el = renderFilePart(part); break;
        case 'patch': el = renderPatchPart(part); break;
        case 'agent':
        case 'subtask': el = renderAgentPart(part, type); break;
        default: el = renderFallback(part); break;
    }
    if (id) el.dataset.partId = id;
    return el;
}

function partExpandKey(part, fallback) {
    return part?.id || `${part?.type || 'part'}:${part?.messageID || ''}:${fallback || ''}`;
}

// ── 步骤分割线 ──
function renderStepDivider(part, phase) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-step-divider';
    if (phase === 'finish' && part.tokens) {
        const t = part.tokens;
        const total = t.total || (t.input || 0) + (t.output || 0) + (t.reasoning || 0);
        el.innerHTML = `<span class="oc-step-label">步骤结束</span><span class="oc-step-cost">↥${t.input||0} ↧${t.output||0} 🧠${t.reasoning||0} ≈${total} tokens</span>`;
    } else {
        el.innerHTML = '<span class="oc-step-label">步骤开始</span>';
    }
    return el;
}

// ── 思考过程 ──
function renderReasoning(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-reasoning';
    const key = partExpandKey(part, 'reasoning');
    const head = document.createElement('div');
    head.className = 'oc-reasoning-head';
    head.innerHTML = '<span class="oc-reasoning-icon">🧠</span> 思考过程 <span class="oc-reasoning-toggle">展开</span>';
    const body = document.createElement('div');
    const expanded = !!expandedParts[key];
    body.className = 'oc-reasoning-body' + (expanded ? '' : ' hidden');
    body.innerHTML = `<pre>${escapeHtml(part.text || '')}</pre>`;
    head.querySelector('.oc-reasoning-toggle').textContent = expanded ? '收起' : '展开';
    head.addEventListener('click', () => {
        expandedParts[key] = !expandedParts[key];
        body.classList.toggle('hidden', !expandedParts[key]);
        head.querySelector('.oc-reasoning-toggle').textContent = expandedParts[key] ? '收起' : '展开';
    });
    el.appendChild(head);
    el.appendChild(body);
    return el;
}

// ── 工具调用 ──
function renderTool(part) {
    const tool = part.tool || part.name || '';
    const state = part.state || {};
    const status = state.status || '';
    const isCompleted = status === 'completed';
    const isError = status === 'error';
    const isRunning = status === 'running';
    const key = partExpandKey(part, tool || 'tool');

    // 工具类型分类
    const isShell = tool === 'bash' || tool === 'shell';
    const isFileOp = /^(read|write|edit|glob|grep|look_at|ast_grep_search|ast_grep_replace)$/.test(tool);
    const category = isShell ? 'shell' : (isFileOp ? 'file' : 'tool');

    const el = document.createElement('div');
    el.className = `oc-part oc-tool oc-tool-${category}` + (isCompleted ? ' done' : '') + (isError ? ' error' : '') + (isRunning ? ' running' : '');

    const head = document.createElement('div');
    head.className = 'oc-tool-head';

    // 图标和标签
    const iconMap = { shell: '💻', file: '📄', tool: '🔧' };
    const labelMap = { shell: '指令执行', file: '文件操作', tool: '工具调用' };
    const icon = iconMap[category];
    const label = labelMap[category];

    // 状态指示
    let statusText = '';
    let statusClass = '';
    if (isCompleted) { statusText = '✓ 完成'; statusClass = 'ok'; }
    else if (isError) { statusText = '✗ 失败'; statusClass = 'err'; }
    else if (isRunning) { statusText = '⏳ 运行中'; statusClass = 'running'; }
    else { statusText = status || '等待'; statusClass = 'pending'; }

    const title = state.title || tool;
    head.innerHTML = `<span class="oc-tool-icon">${icon}</span> ${label}: <strong>${escapeHtml(title)}</strong> <span class="oc-tool-status ${statusClass}">${statusText}</span>`;

    const body = document.createElement('div');
    body.className = 'oc-tool-body';

    // 输入
    if (state.input) {
        const inputDiv = document.createElement('div');
        inputDiv.className = 'oc-tool-io oc-tool-input';
        if (isShell && state.input.command) {
            inputDiv.innerHTML = `<div class="oc-tool-io-label">命令</div><pre><code>${escapeHtml(state.input.command)}</code></pre>`;
        } else {
            inputDiv.innerHTML = `<div class="oc-tool-io-label">输入</div><pre><code>${escapeHtml(safeText(state.input))}</code></pre>`;
        }
        body.appendChild(inputDiv);
    }

    // 输出
    if (state.output) {
        const outDiv = document.createElement('div');
        outDiv.className = 'oc-tool-io oc-tool-output';
        outDiv.innerHTML = `<div class="oc-tool-io-label">输出</div><pre><code>${escapeHtml(safeText(state.output))}</code></pre>`;
        body.appendChild(outDiv);
    }

    // 错误
    if (state.error) {
        const errDiv = document.createElement('div');
        errDiv.className = 'oc-tool-io oc-tool-error';
        errDiv.innerHTML = `<div class="oc-tool-io-label">错误</div><pre><code>${escapeHtml(safeText(state.error))}</code></pre>`;
        body.appendChild(errDiv);
    }

    // 无输入输出时显示原始数据
    if (!state.input && !state.output && !state.error) {
        body.innerHTML = `<div class="oc-tool-io"><pre><code>${escapeHtml(safeText(part))}</code></pre></div>`;
    }

    const expanded = expandedParts[key] ?? isRunning; // 运行中默认展开
    if (!expanded) body.classList.add('hidden');

    head.addEventListener('click', () => {
        expandedParts[key] = !(expandedParts[key] ?? isRunning);
        body.classList.toggle('hidden', !expandedParts[key]);
    });

    el.appendChild(head);
    el.appendChild(body);
    return el;
}

// ── 模型回复 ──
function renderTextPart(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-text';
    el.innerHTML = typeof marked !== 'undefined'
        ? marked.parse(part.text || '', { breaks: true })
        : `<pre>${escapeHtml(part.text || '')}</pre>`;
    return el;
}

// ── 文件内容 ──
function renderFilePart(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-file';
    const key = partExpandKey(part, part.filename || part.path || 'file');
    const filename = part.filename || part.path || part.file || '附件';
    const mime = part.mime || part.type || 'file';
    const raw = part.content || part.url || safeText(part);
    const size = raw.length > 1024 ? `${Math.round(raw.length / 1024)} KB` : `${raw.length} B`;
    const expanded = !!expandedParts[key];
    const head = document.createElement('div');
    head.className = 'oc-file-path';
    head.innerHTML = `<span>📎 ${escapeHtml(filename)}</span><span class="oc-file-meta">${escapeHtml(mime)} · ${size} · ${expanded ? '收起' : '展开'}</span>`;
    const body = document.createElement('pre');
    body.className = expanded ? '' : 'hidden';
    body.textContent = raw;
    head.addEventListener('click', () => {
        expandedParts[key] = !expandedParts[key];
        body.classList.toggle('hidden', !expandedParts[key]);
        head.querySelector('.oc-file-meta').textContent = `${mime} · ${size} · ${expandedParts[key] ? '收起' : '展开'}`;
    });
    el.appendChild(head);
    el.appendChild(body);
    return el;
}

// ── 代码补丁 ──
function renderPatchPart(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-patch';
    el.innerHTML = `<div class="oc-patch-path">📝 ${escapeHtml(part.path || part.file || '')}</div><pre><code>${escapeHtml(part.patch || safeText(part))}</code></pre>`;
    return el;
}

// ── 代理/子任务 ──
function renderAgentPart(part, type) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-agent';
    const label = type === 'agent' ? '🤖 代理' : '📋 子任务';
    el.innerHTML = `<div class="oc-agent-head">${label}: ${escapeHtml(part.name || part.agent || type)}</div><pre>${escapeHtml(safeText(part))}</pre>`;
    return el;
}

// ── 回退渲染 ──
function renderFallback(part) {
    const el = document.createElement('div');
    el.className = 'oc-part oc-fallback';
    const pre = document.createElement('pre');
    pre.textContent = extractPartText(part) || safeText(part);
    el.appendChild(pre);
    return el;
}

async function loadDiff() {
    const box = document.getElementById('ocDiff');
    if (!currentSessionId || !webRunning) {
        box.innerHTML = '<div class="oc-empty">选择会话后查看变更</div>';
        return;
    }
    try {
        const diff = await ocApi('GET', `/session/${encodeURIComponent(currentSessionId)}/diff`);
        renderDiff(diff || []);
    } catch (e) {
        box.innerHTML = `<div class="oc-empty error">${escapeHtml(e.message || e)}</div>`;
    }
}

function renderDiff(diff) {
    const box = document.getElementById('ocDiff');
    const files = Array.isArray(diff) ? diff : Object.values(diff || {});
    if (!files.length) {
        box.innerHTML = '<div class="oc-empty">暂无文件变更</div>';
        return;
    }
    box.innerHTML = '';
    const root = buildFileTree(files);
    renderTreeNode(box, root, 0);
}

function buildFileTree(files) {
    const root = { name: '', isDir: true, children: {} };
    files.forEach(file => {
        const path = (file.file || file.path || file.name || 'unknown').replace(/^\.\//, '');
        const parts = path.split('/');
        let node = root;
        for (let i = 0; i < parts.length; i++) {
            const name = parts[i];
            const isLast = i === parts.length - 1;
            if (!node.children[name]) {
                node.children[name] = isLast
                    ? { name, isDir: false, data: file }
                    : { name, isDir: true, children: {} };
            }
            node = node.children[name];
        }
    });
    return root;
}

function renderTreeNode(container, node, depth) {
    const dirs = [];
    const leafs = [];
    for (const child of Object.values(node.children || {})) {
        child.isDir ? dirs.push(child) : leafs.push(child);
    }
    // 目录在前，文件在后
    [...dirs, ...leafs].forEach(child => {
        const el = document.createElement('div');
        el.className = 'oc-tree-node';
        el.style.paddingLeft = (depth * 14) + 'px';

        const head = document.createElement('div');
        head.className = 'oc-tree-head';

        if (child.isDir) {
            head.classList.add('dir');
            const icon = document.createElement('span');
            icon.className = 'oc-tree-arrow expanded';
            icon.textContent = '▼';
            head.appendChild(icon);
            head.appendChild(document.createTextNode(' 📁 ' + child.name));
            const sub = document.createElement('div');
            sub.className = 'oc-tree-children';
            renderTreeNode(sub, child, depth + 1);
            el.appendChild(head);
            el.appendChild(sub);
            head.addEventListener('click', () => {
                icon.classList.toggle('expanded');
                icon.classList.toggle('collapsed');
                icon.textContent = icon.classList.contains('expanded') ? '▼' : '▶';
                sub.classList.toggle('hidden');
            });
        } else {
            head.classList.add('file');
            const fileName = child.name;
            const stats = child.data;
            const adds = stats.additions || 0;
            const dels = stats.deletions || 0;
            head.innerHTML = `<span class="oc-tree-file-icon">📄</span> ${escapeHtml(fileName)} <span class="oc-tree-stats">+${adds} −${dels}</span>`;
            const body = document.createElement('div');
            body.className = 'oc-tree-body';
            body.innerHTML = `<pre>${escapeHtml(safeText(stats))}</pre>`;
            body.classList.add('hidden');
            el.appendChild(head);
            el.appendChild(body);
            head.addEventListener('click', () => {
                body.classList.toggle('hidden');
                el.classList.toggle('expanded');
            });
        }
        container.appendChild(el);
    });
}

function renderPermissions() {
    // 面板已改为服务状态，保留空实现避免引用报错
}

async function respondPermission(permission, reply) {
    const id = permission.id || permission.permissionID || permission.permissionId;
    const sessionID = permission.sessionID || permission.sessionId || currentSessionId;
    if (!id) return;
    try {
        try {
            await ocApi('POST', `/permission/${encodeURIComponent(id)}/reply`, { reply });
        } catch {
            if (!sessionID) throw new Error('缺少会话编号，无法兼容旧权限接口');
            await ocApi('POST', `/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(id)}`, { response: reply, remember: reply === 'always' });
        }
        showToast('权限已响应', 'success');
    } catch (e) {
        showToast('权限响应失败: ' + (e.message || e), 'error');
    }
}

async function loadServiceStatus() {
    if (!webRunning) return;
    try {
        const [mcp, lsp] = await Promise.all([
            ocApi('GET', '/mcp').catch(() => null),
            ocApi('GET', '/lsp').catch(() => null),
        ]);
        mcpStatus = mcp;
        lspStatus = lsp;
        renderServiceStatus();
    } catch (e) {
        document.getElementById('ocServices').innerHTML = `<div class="oc-empty error">${escapeHtml(e.message || e)}</div>`;
    }
}

function renderServiceStatus() {
    const box = document.getElementById('ocServices');
    if (!mcpStatus && !lspStatus) {
        box.innerHTML = '<div class="oc-empty">暂无服务数据</div>';
        return;
    }
    box.innerHTML = '';

    // MCP 服务
    if (mcpStatus) {
        const sec = document.createElement('div');
        sec.className = 'oc-service-group';
        sec.innerHTML = '<div class="oc-service-group-title">MCP 服务</div>';
        const entries = typeof mcpStatus === 'object' ? Object.entries(mcpStatus) : [];
        if (!entries.length) {
            sec.innerHTML += '<div class="oc-service-item"><span class="oc-service-dot off"></span>无已配置的 MCP 服务</div>';
        } else {
            entries.forEach(([name, info]) => {
                const running = info?.status === 'connected' || info?.connected || info?.running;
                const div = document.createElement('div');
                div.className = 'oc-service-item';
                div.innerHTML = `<span class="oc-service-dot ${running ? 'on' : 'off'}"></span>${escapeHtml(name)} <span class="oc-service-state">${running ? '已连接' : '未连接'}</span>`;
                sec.appendChild(div);
            });
        }
        box.appendChild(sec);
    }

    // LSP 服务
    if (lspStatus) {
        const sec = document.createElement('div');
        sec.className = 'oc-service-group';
        sec.innerHTML = '<div class="oc-service-group-title">LSP 服务</div>';
        const entries = Array.isArray(lspStatus) ? lspStatus : Object.values(lspStatus || {});
        if (!entries.length) {
            sec.innerHTML += '<div class="oc-service-item"><span class="oc-service-dot off"></span>无已配置的 LSP 服务</div>';
        } else {
            entries.forEach(info => {
                const name = info?.name || info?.server || info?.language || '?';
                const running = info?.status === 'running' || info?.running || info?.connected;
                const div = document.createElement('div');
                div.className = 'oc-service-item';
                div.innerHTML = `<span class="oc-service-dot ${running ? 'on' : 'off'}"></span>${escapeHtml(name)} <span class="oc-service-state">${running ? '运行中' : '未启动'}</span>`;
                sec.appendChild(div);
            });
        }
        box.appendChild(sec);
    }
}

async function sendPrompt() {
    if (!webRunning) return;
    const input = document.getElementById('ocPrompt');
    const text = input.value.trim();
    if (!text) return;
    const btn = document.getElementById('btnSendPrompt');
    btn.disabled = true;
    const isNew = !currentSessionId;
    try {
        if (isNew) {
            const session = await ocApi('POST', '/session');
            currentSessionId = session.id || session.ID;
            await loadSessions();
        }
        if (currentSessionId) {
            sessionStatuses[currentSessionId] = 'busy';
            ensurePendingAssistant(currentSessionId);
            renderCachedMessages(currentSessionId);
            smartScroll(document.getElementById('ocMessages'), true);
            updateSendButton();
        }
        await ocApi('POST', `/session/${encodeURIComponent(currentSessionId)}/prompt_async`, {
            parts: [{ type: 'text', text }]
        });
        if (isNew) {
            const title = text.slice(0, 15) + (text.length > 15 ? '...' : '');
            await ocApi('PATCH', `/session/${encodeURIComponent(currentSessionId)}`, { title })
                .catch(() => {}); // 静默失败，不影响主流程
            await loadSessions();
        }
        input.value = '';
        await loadMessages();
        smartScroll(document.getElementById('ocMessages'), true);
        scheduleRefresh();
        updateSendButton();
    } catch (e) {
        showToast('发送失败: ' + (e.message || e), 'error');
    }
    btn.disabled = false;
}

function scheduleRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
        if (webRunning && currentSessionId) {
            loadSessionStatuses().then(statuses => {
                const nextStatuses = statuses || {};
                if (currentSessionId && isSessionBusy(currentSessionId) && !nextStatuses[currentSessionId]) {
                    nextStatuses[currentSessionId] = sessionStatuses[currentSessionId];
                }
                sessionStatuses = nextStatuses;
                updateSendButton();
                loadMessages();
            });
            loadDiff();
        }
    }, 4000);
}

function updateSendButton() {
    const btn = document.getElementById('btnSendPrompt');
    if (!webRunning || !currentSessionId) {
        btn.textContent = '发送';
        btn.className = 'btn btn-primary';
        return;
    }
    const busy = isSessionBusy(currentSessionId);
    if (busy) {
        btn.textContent = '⏹ 停止';
        btn.className = 'btn btn-danger-outline';
    } else {
        btn.textContent = '发送';
        btn.className = 'btn btn-primary';
    }
}

async function abortSession() {
    if (!webRunning || !currentSessionId) return;
    const btn = document.getElementById('btnSendPrompt');
    btn.disabled = true;
    const sessionID = currentSessionId;
    try {
        await ocApi('POST', `/session/${encodeURIComponent(sessionID)}/abort`);
        showToast('已停止', 'info');
        sessionStatuses[sessionID] = 'idle';
        updateSendButton();
        await loadMessages();
        loadSessionStatuses().then(statuses => {
            sessionStatuses = statuses || sessionStatuses;
            updateSendButton();
        });
    } catch (e) {
        showToast('停止失败: ' + (e.message || e), 'error');
    }
    btn.disabled = false;
}

async function startWeb() {
    const btn = document.getElementById('btnStartWeb');
    btn.disabled = true;
    btn.textContent = '⏳ 启动中...';
    try {
        const result = await api.StartOpenCodeWeb(4096);
        if (result.running) {
            webRunning = true;
            webPort = result.port;
            updateWebUI();
            btn.textContent = '▶ 启动 opencode';
            startEventStream();
            await loadSessions();
            loadServiceStatus();
            showToast('OpenCode Web 已启动', 'success');
        } else if (result.error) {
            showToast('启动失败: ' + result.error, 'error');
            btn.disabled = false;
            btn.textContent = '▶ 启动 opencode';
        }
    } catch (e) {
        showToast('启动失败: ' + (e.message || e), 'error');
        btn.disabled = false;
        btn.textContent = '▶ 启动 opencode';
    }
}

async function stopWeb() {
    const btn = document.getElementById('btnStopWeb');
    btn.disabled = true;
    btn.textContent = '⏳ 停止中...';
    try {
        await api.StopOpenCodeWeb();
        if (api.StopOpenCodeEvents) await api.StopOpenCodeEvents();
        webRunning = false;
        webPort = 0;
        currentSessionId = '';
        sessions = [];
        sessionStatuses = {};
        sessionErrors = {};
        messageCache = {};
        expandedParts = {};
        markdownCache = {};
        lastMessageCount = 0;
        mcpStatus = null;
        lspStatus = null;
        clearInterval(refreshTimer);
        updateWebUI();
        btn.textContent = '■ 停止';
        clearClientUI();
        showToast('已停止', 'info');
    } catch (e) {
        showToast('停止失败: ' + (e.message || e), 'error');
        btn.disabled = false;
        btn.textContent = '■ 停止';
    }
}

async function launchTerminal() {
    try {
        const url = webPort ? `http://127.0.0.1:${webPort}` : '';
        const result = await api.LaunchWindowsTerminal('attach', url, workDir);
        if (!result.success && result.error) {
            showToast('启动失败: ' + result.error, 'error');
        }
    } catch (e) {
        showToast('启动终端失败: ' + (e.message || e), 'error');
    }
}

function clearClientUI() {
    document.getElementById('ocSessionList').innerHTML = '<div class="oc-empty">启动服务后加载会话</div>';
    document.getElementById('ocChatTitle').textContent = '未选择会话';
    document.getElementById('ocMessages').innerHTML = '<div class="oc-empty">选择会话后查看消息，或输入内容创建新会话</div>';
    document.getElementById('ocServices').innerHTML = '<div class="oc-empty">启动服务后查看</div>';
    document.getElementById('ocDiff').innerHTML = '<div class="oc-empty">选择会话后查看变更</div>';
    document.getElementById('ocPrompt').value = '';
    updateModelInfo(null);
}

function updateWebUI() {
    const statusEl = document.getElementById('webStatus');
    const btnStart = document.getElementById('btnStartWeb');
    const btnStop = document.getElementById('btnStopWeb');
    const btnWt = document.getElementById('btnWtOpen');
    const btnPick = document.getElementById('btnPickDir');
    const btnRefresh = document.getElementById('btnRefreshSessions');
    const btnNewSession = document.getElementById('btnNewSession');
    const btnSend = document.getElementById('btnSendPrompt');
    const btnDiff = document.getElementById('btnLoadDiff');
    const btnRefreshStatus = document.getElementById('btnRefreshStatus');
    const prompt = document.getElementById('ocPrompt');

    if (webRunning) {
        statusEl.textContent = `运行中 :${webPort}`;
        statusEl.className = 'oc-web-status running';
        btnStart.disabled = true;
        btnStop.disabled = false;
        btnWt.disabled = false;
        btnPick.disabled = false;
        btnRefresh.disabled = false;
        btnNewSession.disabled = false;
        btnSend.disabled = false;
        btnDiff.disabled = false;
        btnRefreshStatus.disabled = false;
        prompt.disabled = false;
    } else {
        statusEl.textContent = '未启动';
        statusEl.className = 'oc-web-status';
        btnStart.disabled = false;
        btnStop.disabled = true;
        btnWt.disabled = true;
        btnPick.disabled = true;
        btnRefresh.disabled = true;
        btnNewSession.disabled = true;
        btnSend.disabled = true;
        btnDiff.disabled = true;
        btnRefreshStatus.disabled = true;
        prompt.disabled = true;
    }
}

function toggleSessions() {
    const client = document.getElementById('webContainer');
    const btn = document.getElementById('btnToggleSessions');
    const hidden = client.classList.toggle('hide-left');
    btn.textContent = hidden ? '▶' : '◀';
    btn.title = hidden ? '显示会话栏' : '隐藏会话栏';
}

function toggleSidepanel() {
    const client = document.getElementById('webContainer');
    const btn = document.getElementById('btnToggleSidepanel');
    const hidden = client.classList.toggle('hide-right');
    btn.textContent = hidden ? '◀' : '▶';
    btn.title = hidden ? '显示信息栏' : '隐藏信息栏';
}

// 事件绑定
document.getElementById('btnStartWeb').addEventListener('click', startWeb);
document.getElementById('btnStopWeb').addEventListener('click', stopWeb);
document.getElementById('btnWtOpen').addEventListener('click', launchTerminal);
document.getElementById('btnPickDir').addEventListener('click', pickDirectory);
document.getElementById('btnRefreshSessions').addEventListener('click', loadSessions);
document.getElementById('btnNewSession').addEventListener('click', createNewSession);
document.getElementById('btnSendPrompt').addEventListener('click', () => {
    if (isSessionBusy(currentSessionId)) {
        abortSession();
    } else {
        sendPrompt();
    }
});

// 输入框：回车发送，Ctrl+Enter 换行
document.getElementById('ocPrompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey) {
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

// ============================================================
// View 2: 模型配置
// ============================================================
let modelEntries = [];
let modelTypes = [];
let availableModels = [];
let originalEntries = [];
let modelSectionsLoaded = false;

let fullConfigJson = {};
let fullConfigRaw = '';  // 原始文本，用于替换模型值

async function loadModelConfig() {
    const container = document.getElementById('modelConfig');

    container.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在加载模型配置...</p></div>';

    try {
        const [fullConfig, models, confPath] = await Promise.all([
            api.GetFullConfig(),
            api.GetAvailableModels(),
            api.GetConfigPath(),
        ]);

        fullConfigRaw = fullConfig || '';
        fullConfigJson = JSON.parse(stripJsonComments(fullConfig) || '{}');
        availableModels = models || [];

        modelEntries = [];
        modelTypes = [];
        // 提取注释（从原始文本中解析）
        const commentMap = extractComments(fullConfigRaw);
        for (const [type, section] of Object.entries(fullConfigJson)) {
            if (!isModelSection(section) && !(section && Object.keys(section).length === 0 && isEmptyModelSectionName(type))) continue;
            modelTypes.push(type);
            for (const [key, val] of Object.entries(section)) {
                modelEntries.push({ id: modelEntryId(type, key), key, type, model: val.model || '', comment: commentMap[key] || '' });
            }
        }
        originalEntries = modelEntries.map(e => ({ ...e }));

        document.getElementById('configPath').textContent = confPath || '未知';
        renderModelConfig();
    } catch (err) {
        container.innerHTML = `<div class="error"><p>⚠️ 加载失败</p><p class="error-detail">${escapeHtml(err.message||err)}</p><button class="btn btn-primary" onclick="loadModelConfig()">重试</button></div>`;
    }
}

function modelEntryId(type, key) {
    return `${type}\u0000${key}`;
}

function sameModelEntry(a, b) {
    return a && b && a.type === b.type && a.key === b.key;
}

function isModelSection(section) {
    if (!section || Array.isArray(section) || typeof section !== 'object') return false;
    const values = Object.values(section);
    if (values.length === 0) return false;
    return values.every(value => value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'model'));
}

function isEmptyModelSectionName(type) {
    if (type === 'agents' || type === 'categories') return true;
    if (['mcp', 'provider', 'providers', 'commands', 'settings'].includes(type)) return false;
    return type.length > 3 && type.endsWith('s');
}

function stripJsonComments(jsonStr) {
    return jsonStr.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// 从原始 JSONC 文本中提取每个 key 后的注释
function extractComments(text) {
    const map = {};
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // 匹配 "key": { 模式
        const keyMatch = line.match(/"([^"]+)"\s*:\s*\{/);
        if (!keyMatch) continue;

        const key = keyMatch[1];
        // 在当前行及后续几行中查找 // 注释
        for (let j = i; j < lines.length && j < i + 5; j++) {
            const cmtIdx = lines[j].indexOf('//');
            if (cmtIdx >= 0) {
                // 确保 // 在引号外
                const before = lines[j].substring(0, cmtIdx);
                if ((before.match(/"/g) || []).length % 2 === 0) {
                    map[key] = lines[j].substring(cmtIdx + 2).trim();
                    break;
                }
            }
            if (lines[j].includes('}') && !lines[j].includes('{')) break;
        }
    }
    return map;
}

// ============================================================
// 渲染模型配置
// ============================================================
function renderModelConfig() {
    const container = document.getElementById('modelConfig');
    const actions = document.getElementById('modelActions');

    container.innerHTML = '';
    actions.style.display = 'flex';

    if (modelTypes.length === 0) {
        container.innerHTML = '<div class="empty"><p>📭 未找到模型配置类型</p><p class="empty-hint">点击底部“添加类型”创建 agents、categories 等分组</p></div>';
        updateSaveStatus();
        return;
    }

    // 全选栏
    const bar = document.createElement('div');
    bar.className = 'batch-model-bar';
    bar.innerHTML = `
        <label class="batch-check"><input type="checkbox" id="selectAllModels" /> <span>全选</span></label>
        <select class="batch-model-select" id="batchModelSelect">
            <option value="">-- 批量设置模型 --</option>
            ${availableModels.map(m => `<option value="${m}">${m}</option>`).join('')}
        </select>
        <button class="btn btn-sm" id="btnApplyBatch">应用</button>
    `;
    container.appendChild(bar);

    document.getElementById('selectAllModels').addEventListener('change', e => {
        document.querySelectorAll('.model-check').forEach(cb => cb.checked = e.target.checked);
    });
    document.getElementById('btnApplyBatch').addEventListener('click', () => {
        const model = document.getElementById('batchModelSelect').value;
        if (!model) return;
        document.querySelectorAll('.model-check:checked').forEach(cb => {
            const entry = modelEntries.find(e => e.id === cb.dataset.id);
            if (entry) entry.model = model;
        });
        renderModelConfig();
        updateSaveStatus();
    });

    modelTypes.forEach(type => {
        const entries = modelEntries.filter(e => e.type === type);
        container.appendChild(createModelGroup(modelTypeTitle(type), entries, type));
    });

    container.querySelectorAll('.model-select').forEach(select => {
        select.addEventListener('change', e => {
            const entry = modelEntries.find(en => en.id === e.target.dataset.id);
            if (entry) { entry.model = e.target.value; updateSaveStatus(); }
        });
    });

    updateSaveStatus();
}

function modelTypeTitle(type) {
    const builtIn = { agents: '🤖 Agents', categories: '📦 Categories' };
    return builtIn[type] || `🧩 ${type}`;
}

function createModelGroup(title, entries, entryType) {
    const group = document.createElement('div');
    group.className = 'model-group';

    const header = document.createElement('h3');
    header.className = 'model-group-title';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'model-group-label';
    titleSpan.textContent = title;
    const headerActions = document.createElement('span');
    headerActions.className = 'model-group-actions';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-add-entry';
    addBtn.dataset.type = entryType;
    addBtn.title = '添加条目';
    addBtn.textContent = '+';
    const deleteTypeBtn = document.createElement('button');
    deleteTypeBtn.className = 'btn-delete-type';
    deleteTypeBtn.dataset.type = entryType;
    deleteTypeBtn.title = '删除类型';
    deleteTypeBtn.textContent = '✕';
    headerActions.appendChild(addBtn);
    headerActions.appendChild(deleteTypeBtn);
    header.appendChild(titleSpan);
    header.appendChild(headerActions);

    addBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        showAddEntryModal(entryType);
    });

    deleteTypeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteModelType(entryType, entries.length);
    });

    header.addEventListener('click', (e) => {
        if (e.target.closest('.model-group-actions')) return;
        header.classList.toggle('collapsed');
        body.classList.toggle('collapsed');
    });

    const body = document.createElement('div');
    body.className = 'model-group-body';

    entries.forEach(entry => {
        const isChanged = originalEntries.find(o => sameModelEntry(o, entry))?.model !== entry.model;
        const row = document.createElement('div');
        row.className = 'model-row' + (isChanged ? ' changed' : '');
        row.dataset.key = entry.key;
        row.dataset.id = entry.id;

        const topRow = document.createElement('div');
        topRow.className = 'model-row-top';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'model-check';
        cb.dataset.key = entry.key;
        cb.dataset.id = entry.id;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'model-key';
        nameSpan.textContent = entry.key;

        const select = document.createElement('select');
        select.className = 'model-select';
        select.dataset.key = entry.key;
        select.dataset.id = entry.id;
        availableModels.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m; opt.textContent = m;
            if (m === entry.model) opt.selected = true;
            select.appendChild(opt);
        });

        const badge = document.createElement('span');
        badge.className = 'model-type-badge';
        badge.textContent = entry.type;

        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-del';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', () => {
            if (!confirm(`确定删除 ${entry.key}?`)) return;
            modelEntries = modelEntries.filter(e => !sameModelEntry(e, entry));
            renderModelConfig();
            updateSaveStatus();
            showToast(`已标记删除 ${entry.key}（点击保存生效）`, 'info');
        });

        topRow.appendChild(cb);
        topRow.appendChild(nameSpan);
        topRow.appendChild(select);
        topRow.appendChild(badge);
        topRow.appendChild(delBtn);
        row.appendChild(topRow);

        if (entry.comment) {
            const commentDiv = document.createElement('div');
            commentDiv.className = 'model-comment';
            commentDiv.textContent = entry.comment;
            row.appendChild(commentDiv);
        }

        body.appendChild(row);
    });

    if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'model-group-empty';
        empty.textContent = '暂无条目，点击标题右侧 + 添加';
        body.appendChild(empty);
    }

    group.appendChild(header);
    group.appendChild(body);
    return group;
}

async function deleteModelType(entryType, entryCount) {
    const warning = entryCount > 0 ? `，其中包含 ${entryCount} 个条目` : '';
    if (!confirm(`确定删除类型 ${entryType}${warning}？此操作会立即写入配置文件。`)) return;
    const result = await api.DeleteModelType(entryType);
    if (!result.success) {
        showToast('删除类型失败: ' + (result.error || '未知错误'), 'error');
        return;
    }
    modelTypes = modelTypes.filter(type => type !== entryType);
    modelEntries = modelEntries.filter(entry => entry.type !== entryType);
    originalEntries = originalEntries.filter(entry => entry.type !== entryType);
    delete fullConfigJson[entryType];
    renderModelConfig();
    showToast(`已删除类型 ${entryType}`, 'success');
}

function showAddTypeModal() {
    const old = document.querySelector('.modal-overlay');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal" onclick="event.stopPropagation()">
            <h3>添加模型配置类型</h3>
            <div class="modal-field"><label>类型名称（顶层 section）</label><input id="modalTypeKey" placeholder="如 agents / categories / reviewers" /></div>
            <div class="modal-actions"><button class="btn btn-cancel" id="btnCancelAddType">取消</button><button class="btn btn-primary" id="btnConfirmAddType">➕ 添加类型</button></div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', () => overlay.remove());
    overlay.querySelector('#btnCancelAddType').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#btnConfirmAddType').addEventListener('click', async () => {
        const type = overlay.querySelector('#modalTypeKey').value.trim();
        if (!type) { showToast('类型名称不能为空', 'error'); return; }
        if (modelTypes.includes(type)) { showToast('类型已存在', 'error'); return; }
        const result = await api.AddModelType(type);
        if (!result.success) { showToast('添加类型失败: ' + (result.error || '未知错误'), 'error'); return; }
        modelTypes.push(type);
        fullConfigJson[type] = {};
        overlay.remove();
        renderModelConfig();
        showToast(`已添加类型 ${type}`, 'success');
    });
}

// 添加弹窗
function showAddEntryModal(entryType) {
    const old = document.querySelector('.modal-overlay');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal" onclick="event.stopPropagation()">
            <h3>添加 ${modelTypeTitle(entryType).replace(/^[^\w\u4e00-\u9fa5]+\s*/, '')}</h3>
            <div class="modal-field"><label>Key（唯一标识）</label><input id="modalEntryKey" placeholder="如 my-agent" /></div>
            <div class="modal-field"><label>模型</label><select id="modalEntryModel" style="width:100%;padding:6px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text-primary)">${availableModels.map(m => `<option value="${m}">${m}</option>`).join('')}</select></div>
            <div class="modal-field"><label>描述（作为注释）</label><input id="modalEntryComment" placeholder="简要描述用途" /></div>
            <div class="modal-actions"><button class="btn btn-cancel" id="btnCancelAdd">取消</button><button class="btn btn-primary" id="btnConfirmAdd">💾 添加</button></div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', () => overlay.remove());
    overlay.querySelector('#btnCancelAdd').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#btnConfirmAdd').addEventListener('click', () => {
        const key = overlay.querySelector('#modalEntryKey').value.trim();
        const model = overlay.querySelector('#modalEntryModel').value;
        const comment = overlay.querySelector('#modalEntryComment').value.trim();
        if (!key) { showToast('Key 不能为空', 'error'); return; }
        if (modelEntries.find(e => e.type === entryType && e.key === key)) { showToast('当前类型下 Key 已存在', 'error'); return; }
        modelEntries.push({ id: modelEntryId(entryType, key), key, type: entryType, model: model || 'deepseek-v4-flash', comment });
        overlay.remove();
        renderModelConfig();
        updateSaveStatus();
        showToast(`已添加 ${key}（点击保存生效）`, 'info');
    });
}

function updateSaveStatus() {
    const changed = modelEntries.filter(e => {
        const orig = originalEntries.find(o => sameModelEntry(o, e));
        return !orig || orig.model !== e.model;
    }).length;
    const deleted = originalEntries.filter(o => !modelEntries.find(e => sameModelEntry(e, o))).length;
    const total = changed + deleted;

    const status = document.getElementById('saveStatus');
    if (total > 0) {
        status.textContent = `${total} 项未保存 (改${changed} 删${deleted})`;
        status.className = 'save-status changed';
    } else {
        status.textContent = '已是最新';
        status.className = 'save-status';
    }
}

// 刷新模型列表
document.getElementById('btnRefreshModels').addEventListener('click', async () => {
    const btn = document.getElementById('btnRefreshModels');
    btn.disabled = true;
    btn.textContent = '⏳ 刷新中...';
    try {
        const newModels = await api.RefreshAvailableModels();
        if (newModels) availableModels = newModels;
        // 重新获取完整配置（可能外部已修改，也能保留空类型分组）
        await loadModelConfig();
        showToast(`获取到 ${availableModels.length} 个可用模型`, 'success');
    } catch (err) {
        showToast('刷新模型列表失败: ' + (err.message || err), 'error');
    }
    btn.disabled = false;
    btn.textContent = '🔄 刷新列表';
});

document.getElementById('btnAddModelType').addEventListener('click', showAddTypeModal);

// 保存模型配置（事件委托，确保元素存在）
document.getElementById('modelActions').addEventListener('click', async (e) => {
    if (e.target.id !== 'btnSaveModels') return;
    showToast('保存中...', 'info');
    const totalChanges = modelEntries.filter(e => {
            const orig = originalEntries.find(o => sameModelEntry(o, e));
            return !orig || orig.model !== e.model;
    }).length + originalEntries.filter(o => !modelEntries.find(e => sameModelEntry(e, o))).length;

    if (totalChanges === 0) {
        showToast('没有需要保存的更改', 'info');
        return;
    }

    const btn = e.target;
    btn.disabled = true;
    btn.textContent = '⏳ 保存中...';

    try {
        const result = await api.UpdateModels(modelEntries);
        if (result.success) {
            originalEntries = modelEntries.map(e => ({ ...e }));
            updateSaveStatus();
            showToast(`已保存 ${totalChanges} 项更改`, 'success');
            renderModelConfig();
        } else {
            showToast('保存失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (err) {
        showToast('保存失败: ' + (err.message || err), 'error');
    }

    btn.disabled = false;
    btn.textContent = '💾 保存';
});

// ============================================================
// View 3: 技能管理
// ============================================================
let targets = [];
let skills = [];
let skillsLoaded = false;

async function loadSkillsData() {
    const skillList = document.getElementById('skillList');
    if (skillsLoaded) return;

    try {
        skillList.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在加载技能列表...</p></div>';

        const [skillsData, targetsData, sourceDir, statsData] = await Promise.all([
            api.GetSkills(),
            api.GetTargets(),
            api.GetSourceDir(),
            api.GetStats(),
        ]);

        skills = skillsData || [];
        targets = targetsData || [];
        skillsLoaded = true;

        document.getElementById('sourcePath').textContent = (sourceDir || '未知');
        renderStats(statsData);
        renderBatchButtons();
        renderSkillList();
    } catch (err) {
        console.error('加载技能数据失败:', err);
        skillList.innerHTML = `<div class="error">
            <p>⚠️ 加载失败</p>
            <p class="error-detail">${escapeHtml(err.message || err)}</p>
            <button class="btn btn-primary" onclick="loadSkillsData()">重试</button>
        </div>`;
    }
}

function renderStats(stats) {
    if (!stats) return;
    const total = stats.totalSkills || skills.length;
    document.getElementById('statTotal').textContent = total;
}

function renderBatchButtons() {
    const batchButtons = document.getElementById('batchButtons');
    batchButtons.innerHTML = '';
    targets.forEach(target => {
        const enabledCount = skills.filter(s => s.targets[target.key]).length;
        const allEnabled = enabledCount === skills.length;

        const group = document.createElement('div');
        group.className = 'batch-group';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'batch-target-name';
        nameSpan.textContent = target.label;

        const btn = document.createElement('button');
        btn.className = 'btn btn-sm ' + (allEnabled ? 'btn-danger-outline' : 'btn-success');
        btn.dataset.target = target.key;
        btn.dataset.enable = String(!allEnabled);
        btn.textContent = allEnabled ? '全部移除' : '全部启用';

        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = '处理中...';
            try {
                const result = await api.ToggleAllSkills(target.key, !allEnabled);
                if (result.success) {
                    showToast(`${target.label} 批量操作完成`, 'success');
                    skillsLoaded = false;
                    await loadSkillsData();
                } else {
                    showToast(`部分操作失败: ${result.errors.length} 个错误`, 'error');
                }
            } catch (err) {
                showToast(`操作失败: ${err.message || err}`, 'error');
            }
        });

        group.appendChild(nameSpan);
        group.appendChild(btn);
        batchButtons.appendChild(group);
    });
}

function renderSkillList() {
    const skillList = document.getElementById('skillList');
    if (skills.length === 0) {
        skillList.innerHTML = '<div class="empty"><p>📭 没有找到技能文件</p><p class="empty-hint">请检查源目录是否有技能文件夹</p></div>';
        return;
    }

    skillList.innerHTML = '';
    skills.forEach(skill => {
        const card = createSkillCard(skill);
        skillList.appendChild(card);
    });
}

function createSkillCard(skill) {
    const card = document.createElement('div');
    card.className = 'skill-card';

    const header = document.createElement('div');
    header.className = 'skill-header';

    const info = document.createElement('div');
    info.className = 'skill-info';

    const nameEl = document.createElement('h3');
    nameEl.className = 'skill-name';
    nameEl.textContent = skill.name;

    const descEl = document.createElement('p');
    descEl.className = 'skill-desc';
    descEl.textContent = skill.description || '';

    info.appendChild(nameEl);
    if (skill.description) info.appendChild(descEl);
    header.appendChild(info);

    const toggles = document.createElement('div');
    toggles.className = 'skill-toggles';

    targets.forEach(target => {
        const isLinked = skill.targets[target.key] || false;

        const toggle = document.createElement('label');
        toggle.className = 'toggle';

        const labelSpan = document.createElement('span');
        labelSpan.className = 'toggle-label';
        labelSpan.textContent = target.label;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = isLinked;
        checkbox.dataset.skill = skill.name;
        checkbox.dataset.target = target.key;

        const slider = document.createElement('span');
        slider.className = 'toggle-slider';

        checkbox.addEventListener('change', async (e) => {
            const enable = e.target.checked;
            const skillName = e.target.dataset.skill;
            const targetKey = e.target.dataset.target;

            e.target.disabled = true;

            try {
                const result = await api.ToggleSkill(skillName, targetKey, enable);
                if (result.success) {
                    skill.targets[targetKey] = enable;
                    showToast(
                        `${skillName} → ${targets.find(t => t.key === targetKey)?.label || targetKey} ${enable ? '✅ 已启用' : '❌ 已禁用'}`,
                        'success'
                    );
                } else {
                    e.target.checked = !enable;
                    showToast(`操作失败: ${result.error || '未知错误'}`, 'error');
                }
            } catch (err) {
                e.target.checked = !enable;
                showToast(`操作失败: ${err.message || err}`, 'error');
            }

            e.target.disabled = false;
            // 刷新批量按钮状态
            renderBatchButtons();
        });

        toggle.appendChild(labelSpan);
        toggle.appendChild(checkbox);
        toggle.appendChild(slider);
        toggles.appendChild(toggle);
    });

    header.appendChild(toggles);
    card.appendChild(header);
    return card;
}

// 技能管理 - 刷新按钮
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

// 技能管理 - 打开源目录
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

// ============================================================
// 事件绑定
// ============================================================
// View 4: 常用命令
// ============================================================
let commandsData = [];
let commandsLoaded = false;
let cmdActiveTab = 'cli';

async function loadCommands() {
    const content = document.getElementById('cmdContent');
    if (commandsLoaded) return;

    content.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在加载命令列表...</p></div>';

    try {
        const data = await api.GetCommands();
        commandsData = data || [];
        commandsLoaded = true;
        renderCommands(cmdActiveTab);
    } catch (err) {
        content.innerHTML = `<div class="error">
            <p>⚠️ 加载命令失败</p>
            <p class="error-detail">${escapeHtml(err.message || err)}</p>
            <button class="btn btn-primary" onclick="loadCommands()">重试</button>
        </div>`;
    }
}

function renderCommands(tab) {
    const content = document.getElementById('cmdContent');
    const isCLI = tab === 'cli';
    const filtered = commandsData.filter(g => g.isTui === !isCLI);

    if (filtered.length === 0) {
        content.innerHTML = '<div class="empty"><p>📭 没有找到命令</p></div>';
        return;
    }

    content.innerHTML = '';
    filtered.forEach(group => {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'cmd-group';

        const titleEl = document.createElement('h3');
        titleEl.className = 'cmd-group-title';
        titleEl.textContent = group.title;
        groupDiv.appendChild(titleEl);

        const grid = document.createElement('div');
        grid.className = 'cmd-grid';

        (group.cmds || []).forEach(cmd => {
            const card = document.createElement('div');
            card.className = 'cmd-card';

            const top = document.createElement('div');
            top.className = 'cmd-card-top';

            const nameEl = document.createElement('span');
            nameEl.className = 'cmd-card-name';
            nameEl.textContent = cmd.name;

            top.appendChild(nameEl);

            if (cmd.sub) {
                const subEl = document.createElement('span');
                subEl.className = 'cmd-card-sub';
                subEl.textContent = cmd.sub;
                top.appendChild(subEl);
            }

            if (cmd.options) {
                const shortcutEl = document.createElement('span');
                shortcutEl.className = 'cmd-card-shortcut';
                shortcutEl.textContent = cmd.options;
                top.appendChild(shortcutEl);
            }

            card.appendChild(top);

            if (cmd.desc) {
                const descEl = document.createElement('p');
                descEl.className = 'cmd-card-desc';
                descEl.textContent = cmd.desc;
                card.appendChild(descEl);
            }

            grid.appendChild(card);
        });

        groupDiv.appendChild(grid);
        content.appendChild(groupDiv);
    });
}

// 命令选项卡切换
document.querySelector('.cmd-tabs').addEventListener('click', (e) => {
    const tabBtn = e.target.closest('.cmd-tab');
    if (!tabBtn || !tabBtn.dataset.cmdTab) return;

    const tab = tabBtn.dataset.cmdTab;
    if (tab === cmdActiveTab && commandsLoaded) return;

    cmdActiveTab = tab;

    // 更新 tab 高亮
    document.querySelectorAll('.cmd-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.cmdTab === tab);
    });

    if (commandsLoaded) {
        renderCommands(tab);
    } else {
        loadCommands();
    }
});

// ============================================================
// 全局事件绑定
// ============================================================

// 主题切换
document.getElementById('btnTheme').addEventListener('click', toggleTheme);

// ESC 关闭任何打开的状态（当前没有抽屉，保留以备后用）
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        // 预留
    }
});

// ============================================================
// 应用启动
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    loadSkillsData();
    checkWebStatus();
    initWorkDir();
});

// ============================================================
// 供应商配置（内联编辑）
// ============================================================
async function loadProviders() {
    const list = document.getElementById('providersList');
    list.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在加载供应商...</p></div>';
    try {
        const [providers, cfgPath] = await Promise.all([
            api.GetProviders(),
            api.GetProviderConfigPath(),
        ]);
        document.getElementById('providerConfigPath').textContent = cfgPath || '未知';
        renderProviders(providers || []);
    } catch (err) {
        list.innerHTML = `<div class="error"><p>⚠️ 加载失败</p><p class="error-detail">${escapeHtml(err.message||err)}</p></div>`;
    }
}

function emptyProvider() {
    return { key: '', name: '', baseURL: '', apiKey: '', enabled: true, models: [], _new: true };
}

function renderProviders(providers) {
    const list = document.getElementById('providersList');
    const html = providers.map(p => providerCardHtml(p)).join('');
    list.innerHTML = html + `
        <div class="provider-card provider-card-add" id="btnAddCard" style="border:dashed 1px var(--border);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:24px;color:var(--text-muted)">
            <span>➕ 添加供应商</span>
        </div>`;
    // 绑定事件
    bindProviderEvents(providers);
    document.getElementById('btnAddCard').addEventListener('click', () => addNewCard());
}

function providerCardHtml(p) {
    const isNew = p._new;
    return `
        <div class="provider-card" data-key="${escapeHtml(p.key)}">
            <div class="provider-card-header">
                <div style="flex:1;display:flex;gap:8px;align-items:center">
                    <input class="prov-edit-key" value="${escapeHtml(p.key)}" placeholder="key (如 deepseek)" style="width:140px;font-size:13px;font-weight:600" ${isNew?'':'readonly'} />
                    <input class="prov-edit-name" value="${escapeHtml(p.name||'')}" placeholder="名称" style="width:160px;font-size:12px" />
                </div>
                <div class="provider-card-actions" style="display:flex;gap:6px;align-items:center">
                    <label style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:4px;cursor:pointer">
                        <input type="checkbox" class="prov-edit-enabled" ${p.enabled!==false?'checked':''} /> 启用
                    </label>
                    <button class="btn btn-sm btn-save-card" data-key="${escapeHtml(p.key)}">💾 保存</button>
                    <button class="btn btn-del btn-del-card" data-key="${escapeHtml(p.key)}" title="删除">✕</button>
                </div>
            </div>
            <div class="provider-card-body">
                <div style="display:flex;gap:10px">
                    <label style="flex:1">
                        <span style="font-size:10px;color:var(--text-muted)">请求地址 (baseURL)</span>
                        <input class="prov-edit-url" value="${escapeHtml(p.baseURL||'')}" placeholder="https://api.xxx.com/v1" style="width:100%;margin-top:2px" />
                    </label>
                    <label style="flex:1">
                        <span style="font-size:10px;color:var(--text-muted)">API Key</span>
                        <div style="display:flex;gap:0;margin-top:2px">
                            <input class="prov-edit-apikey" value="${escapeHtml(p.apiKey||'')}" type="password" placeholder="sk-..." style="width:100%;border-right:none;border-radius:4px 0 0 4px" />
                            <button class="btn-eye" type="button" title="切换明文">👁</button>
                        </div>
                    </label>
                </div>
                <div class="provider-models">
                    <div class="provider-models-title">📦 模型 <button class="btn btn-sm btn-add btn-add-model-card" data-key="${escapeHtml(p.key)}" style="font-size:10px;padding:2px 8px">+</button></div>
                    <div class="card-models-list" data-key="${escapeHtml(p.key)}">
                        ${(p.models||[]).map((m,i) => `
                            <div class="model-subcard">
                                <div style="display:flex;align-items:center;gap:8px;flex:1">
                                    <span style="font-size:10px;color:var(--text-muted);width:45px;flex-shrink:0">模型ID</span>
                                    <input class="model-edit-id" value="${escapeHtml(m.id)}" placeholder="deepseek-v4-pro" style="font-size:12px;flex:1;width:50%" />
                                    <span style="font-size:10px;color:var(--text-muted);width:45px;flex-shrink:0">名称</span>
                                    <input class="model-edit-name" value="${escapeHtml(m.name||'')}" placeholder="DeepSeek-V4-Pro" style="font-size:12px;flex:1;width:50%" />
                                </div>
                                <button class="btn btn-del btn-del-model" title="删除">✕</button>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        </div>`;
}

let providerCache = [];

function bindProviderEvents(providers) {
    providerCache = providers;

    // 保存按钮
    document.querySelectorAll('.btn-save-card').forEach(btn => {
        btn.addEventListener('click', () => saveProviderFromDom(btn.dataset.key));
    });

    // 删除按钮
    document.querySelectorAll('.btn-del-card').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.key;
            if (!confirm(`确定删除供应商 "${key}" 吗？`)) return;
            api.DeleteProvider(key).then(r => {
                if (r.success) { showToast(`已删除 ${key}`, 'success'); loadProviders(); }
                else showToast('删除失败: '+r.error, 'error');
            });
        });
    });

    // 添加模型
    document.querySelectorAll('.btn-add-model-card').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.key;
            const list = document.querySelector(`.card-models-list[data-key="${CSS.escape(key)}"]`);
            const row = document.createElement('div');
            row.className = 'model-subcard';
            row.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;flex:1">
                    <span style="font-size:10px;color:var(--text-muted);width:45px;flex-shrink:0">模型ID</span>
                    <input class="model-edit-id" placeholder="deepseek-v4-pro" style="font-size:12px;font-family:monospace;flex:1;width:50%" />
                    <span style="font-size:10px;color:var(--text-muted);width:45px;flex-shrink:0">名称</span>
                    <input class="model-edit-name" placeholder="DeepSeek-V4-Pro" style="font-size:12px;flex:1;width:50%" />
                </div>
                <button class="btn btn-del btn-del-model" title="删除">✕</button>
            `;
            row.querySelector('.btn-del-model').addEventListener('click', () => row.remove());
            list.appendChild(row);
        });
    });

    // 删除模型
    document.querySelectorAll('.btn-del-model').forEach(btn => {
        btn.addEventListener('click', () => btn.parentElement.remove());
    });

    // API Key 小眼睛切换
    document.querySelectorAll('.btn-eye').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = btn.parentElement.querySelector('.prov-edit-apikey');
            if (input.type === 'password') {
                input.type = 'text';
                btn.textContent = '🙈';
            } else {
                input.type = 'password';
                btn.textContent = '👁';
            }
        });
    });
}

function addNewCard() {
    const isNew = providerCache.some(p => p._new);
    if (isNew) { showToast('请先保存当前新增的供应商', 'info'); return; }
    providerCache.push(emptyProvider());
    renderProviders(providerCache);
}

function saveProviderFromDom(key) {
    const card = document.querySelector(`.provider-card[data-key="${CSS.escape(key)}"]`);
    if (!card) return;

    const data = {
        key: card.querySelector('.prov-edit-key').value.trim(),
        name: card.querySelector('.prov-edit-name').value.trim(),
        baseURL: card.querySelector('.prov-edit-url').value.trim(),
        apiKey: card.querySelector('.prov-edit-apikey').value.trim(),
        enabled: card.querySelector('.prov-edit-enabled').checked,
        models: []
    };

    if (!data.key) { showToast('Key 不能为空', 'error'); return; }

    card.querySelectorAll('.model-subcard').forEach(row => {
        const id = row.querySelector('.model-edit-id')?.value?.trim();
        const name = row.querySelector('.model-edit-name')?.value?.trim();
        if (id) data.models.push({ id, name: name || id });
    });

    const btn = card.querySelector('.btn-save-card');
    btn.disabled = true; btn.textContent = '...';

    api.SaveProvider(data).then(r => {
        if (r.success) {
            showToast(`供应商 ${data.key} 已保存`, 'success');
            loadProviders();
        } else {
            showToast('保存失败: ' + r.error, 'error');
            btn.disabled = false; btn.textContent = '💾 保存';
        }
    });
}

// 侧边栏导航触发
document.querySelectorAll('.nav-item[data-view="view-providers"]').forEach(item => {
    item.addEventListener('click', () => setTimeout(loadProviders, 100));
});

// Wails 就绪事件
if (window.runtime) {
    window.runtime.EventsOn('wails:ready', () => {
        checkWebStatus();
    });
}
