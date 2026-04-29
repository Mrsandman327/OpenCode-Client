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
    StartTerminal: async () => { console.log('mock terminal start'); },
    TerminalWrite: async (data) => { console.log('mock term write:', data); },
    GetSessions: async () => [
        { id: 'ses_abc123', title: '开发 Skill 桌面管理工具' },
        { id: 'ses_def456', title: 'OpenCode 模型配置管理' },
    ],
    RunOpenCode: async (sid, cont) => { console.log('mock launch:', sid, cont); },
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
        // 初始化终端
        if (!terminalInstance) setTimeout(initTerminal, 300);
        scheduleTerminalFit();
    }
}

async function syncTerminalSize() {
    fitTerminalToContainer();
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
    fitTerminalToContainer();
}

// 侧边栏点击事件（事件委托）
document.getElementById('sidebar').addEventListener('click', (e) => {
    const navItem = e.target.closest('.nav-item');
    if (navItem && navItem.dataset.view) {
        switchView(navItem.dataset.view);
    }
});

// ============================================================
// View 1: OpenCode (终端)
// ============================================================

// ============================================================
// 嵌入式终端 (xterm.js)
// ============================================================
let terminalInstance = null;
let terminalFitAddon = null;
let terminalReady = false;
let terminalResizeObserver = null;
let lastTerminalSize = { cols: 0, rows: 0 };
const TERMINAL_FONT_SIZE = 14;
const TERMINAL_FONT_FAMILY = "'Cascadia Mono', 'Consolas', 'Courier New', monospace";
const TERMINAL_LINE_HEIGHT = 1.15;

function initTerminal() {
    const container = document.getElementById('terminalContainer');
    if (!container) return;
    if (terminalInstance) return;

    if (typeof Terminal === 'undefined') {
        console.warn('xterm.js 未加载');
        return;
    }

    try {
        terminalInstance = new Terminal({
        cursorBlink: true,
        cursorStyle: 'block',
        cols: 160,
        rows: 40,
        fontSize: TERMINAL_FONT_SIZE,
        fontFamily: TERMINAL_FONT_FAMILY,
        fontWeight: 'normal',
        fontWeightBold: 'bold',
        letterSpacing: 0,
        lineHeight: TERMINAL_LINE_HEIGHT,
        scrollback: 10000,
        fastScrollModifier: 'alt',
        fastScrollSensitivity: 8,
        smoothScrollDuration: 80,
        theme: {
            background: '#1e1e1e',
            foreground: '#cccccc',
            cursor: '#007acc',
            selectionBackground: '#264f78',
        },
        allowTransparency: false,
        });
    } catch (err) {
        container.textContent = '终端初始化失败: ' + (err.message || err);
        return;
    }

    terminalInstance.open(container);

    if (typeof Unicode11Addon !== 'undefined') {
        try {
            const unicode11Addon = new Unicode11Addon.Unicode11Addon();
            terminalInstance.loadAddon(unicode11Addon);
            terminalInstance.unicode.activeVersion = '11';
        } catch (err) {
            console.warn('Unicode11Addon 加载失败，使用 xterm 默认宽度表', err);
        }
    }

    // FitAddon 精确填充容器
    if (typeof FitAddon !== 'undefined') {
        terminalFitAddon = new FitAddon.FitAddon();
        terminalInstance.loadAddon(terminalFitAddon);
        scheduleTerminalFit();
    }

    setTimeout(() => terminalInstance.focus(), 300);
    container.addEventListener('click', () => terminalInstance.focus());
    container.addEventListener('wheel', (event) => {
        if (!terminalInstance) return;
        const lineDelta = Math.max(1, Math.ceil(Math.abs(event.deltaY) / 18));
        terminalInstance.scrollLines(event.deltaY > 0 ? lineDelta : -lineDelta);
        event.preventDefault();
    }, { passive: false });

    terminalInstance.writeln('\x1b[36mTerminal ready\x1b[0m');
    terminalInstance.write('$ ');

    // 自适应大小 + ConPTY 同步
    const doFit = () => {
        fitTerminalToContainer();
    };

    setTimeout(doFit, 200);
    setTimeout(doFit, 600);
    setTimeout(doFit, 1200);
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => scheduleTerminalFit()).catch(() => {});
    }
    window.addEventListener('resize', doFit);
    if (window.ResizeObserver && container) {
        if (terminalResizeObserver) terminalResizeObserver.disconnect();
        terminalResizeObserver = new ResizeObserver(() => scheduleTerminalFit());
        terminalResizeObserver.observe(container);
    }

    // PTY 先绑事件再启动，避免启动瞬间输出丢失。
    const startAndBind = async () => {
        // Go → 前端输出。先绑定事件再启动 PTY，避免启动瞬间输出丢失。
        if (window.runtime) {
            window.runtime.EventsOn('terminal-output', (output) => {
                if (terminalInstance && output) terminalInstance.write(output);
            });
            window.runtime.EventsOn('terminal-error', (errMsg) => {
                if (terminalInstance && errMsg)
                    terminalInstance.writeln('\r\n\x1b[31m[错误] ' + errMsg + '\x1b[0m');
            });
            window.runtime.EventsOn('terminal-closed', (msg) => {
                terminalReady = false;
                if (terminalInstance) {
                    terminalInstance.writeln('\r\n\x1b[33m[' + (msg || '终端已退出，按任意键自动重启') + ']\x1b[0m');
                    terminalInstance.write('\r\n$ ');
                }
            });
        }

        // 用户输入 → Go PTY。先绑定输入，即使 StartTerminal 失败，下一次输入也会尝试重启。
        terminalInstance.onData(async data => {
            if (api.TerminalWrite) {
                try {
                    if (!terminalReady && api.StartTerminal) {
                        await api.StartTerminal();
                        terminalReady = true;
                        scheduleTerminalFit();
                    }
                    await api.TerminalWrite(data);
                } catch (err) {
                    terminalReady = false;
                    terminalInstance.writeln('\r\n\x1b[31m[输入失败] ' + (err.message || err) + '\x1b[0m');
                }
            }
        });

        if (api.StartTerminal) {
            try {
                const result = await api.StartTerminal();
                terminalReady = true;
                scheduleTerminalFit();
                terminalInstance.writeln('\r\n\x1b[33m[StartTerminal: ' + result + ']\x1b[0m');
            } catch (err) {
                terminalReady = false;
                terminalInstance.writeln('\r\n\x1b[31m[StartTerminal failed] ' + (err.message || err) + '\x1b[0m');
            }
        } else {
            terminalInstance.writeln('\r\n\x1b[31m[StartTerminal not found]\x1b[0m');
        }
    };

    startAndBind();
}

function fitTerminalToContainer() {
    if (!terminalFitAddon || !terminalInstance) return;
    requestAnimationFrame(() => {
        const proposed = typeof terminalFitAddon.proposeDimensions === 'function'
            ? terminalFitAddon.proposeDimensions()
            : null;
        if (proposed && proposed.cols > 0 && proposed.rows > 0) {
            terminalInstance.resize(proposed.cols, proposed.rows);
        } else {
            terminalFitAddon.fit();
        }
        const cols = terminalInstance.cols;
        const rows = terminalInstance.rows;
        if (cols > 0 && rows > 0 && api.ResizeTerminal) {
            api.ResizeTerminal(cols, rows);
        }
        if (cols !== lastTerminalSize.cols || rows !== lastTerminalSize.rows) {
            lastTerminalSize = { cols, rows };
            console.info(`Terminal resized: ${cols}x${rows}`);
        }
    });
}

async function runOpenCodeInTerminal(sessionId = '', continueFlag = false) {
    if (!terminalInstance) initTerminal();
    await syncTerminalSize();
    if (api.RunOpenCode) {
        await api.RunOpenCode(sessionId, continueFlag);
        setTimeout(fitTerminalToContainer, 120);
        setTimeout(fitTerminalToContainer, 500);
    }
}

function scheduleTerminalFit() {
    requestAnimationFrame(() => fitTerminalToContainer());
    setTimeout(fitTerminalToContainer, 80);
    setTimeout(fitTerminalToContainer, 240);
    setTimeout(fitTerminalToContainer, 600);
}

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
    initTerminal();
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
        loadOpenCodeOptions();
        const opencodePanel = document.getElementById('view-opencode');
        if (opencodePanel && opencodePanel.classList.contains('active') && !terminalInstance) {
            setTimeout(initTerminal, 300);
        }
        if (opencodePanel && opencodePanel.classList.contains('active')) {
            scheduleTerminalFit();
        }
    });
}
