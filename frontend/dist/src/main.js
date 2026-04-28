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
        UpdateModels: async (entries) => ({ success: true }),
        GetConfigPath: async () => '~/.config/opencode/oh-my-openagent.jsonc',
        // 命令
        GetCommands: async () => JSON.parse(JSON.stringify(mockCommands)),
        // OpenCode 启动
        startTerminal: async () => { console.log('mock: terminal started'); },
        RunOpenCode: async (dir, model, agent, continueFlag, sessionId) => {
            console.log('mock run opencode:', { dir, model, agent, continueFlag, sessionId });
            showToast(`模拟启动: opencode${model ? ' -m '+model : ''}${agent ? ' --agent '+agent : ''}`, 'success');
        },
        OpenDirectoryDialog: async () => {
            console.log('mock: returning test dir');
            return 'C:\\projects\\my-project';
        },
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
        loadOpenCodeOptions();
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
// View 1: OpenCode
// ============================================================

// 加载模型和 Agent 选项
async function loadOpenCodeOptions() {
    const modelSelect = document.getElementById('ocModelSelect');
    const agentSelect = document.getElementById('ocAgentSelect');

    // 仅在未加载时填充
    if (modelSelect.options.length > 1) return;

    try {
        const [models, configEntries] = await Promise.all([
            api.GetAvailableModels().catch(() => []),
            api.GetModelConfig().catch(() => []),
        ]);

        // 模型下拉
        if (models && models.length > 0) {
            models.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m;
                opt.textContent = m;
                modelSelect.appendChild(opt);
            });
        }

        // Agent 下拉（从模型配置中提取 agent 类型条目）
        if (configEntries && configEntries.length > 0) {
            const agents = configEntries.filter(e => e.type === 'agent');
            agents.forEach(a => {
                const opt = document.createElement('option');
                opt.value = a.key;
                opt.textContent = a.label ? `${a.key} (${a.label})` : a.key;
                agentSelect.appendChild(opt);
            });
        }
    } catch (err) {
        console.warn('加载启动选项失败:', err);
    }
}

// 浏览工作目录
document.getElementById('ocBrowseBtn').addEventListener('click', async () => {
    try {
        const dir = await api.OpenDirectoryDialog();
        if (dir) {
            document.getElementById('ocWorkDir').value = dir;
        }
    } catch (err) {
        showToast('选择目录失败: ' + (err.message || err), 'error');
    }
});

// 启动 OpenCode
document.getElementById('ocLaunchBtn').addEventListener('click', async () => {
    const dir = document.getElementById('ocWorkDir').value;
    const model = document.getElementById('ocModelSelect').value;
    const agent = document.getElementById('ocAgentSelect').value;
    const continueFlag = document.getElementById('ocContinueSession').checked;
    const sessionId = document.getElementById('ocSessionId').value;

    if (!dir) {
        showToast('请先选择工作目录', 'error');
        return;
    }

    const btn = document.getElementById('ocLaunchBtn');
    btn.disabled = true;
    btn.textContent = '⏳ 启动中...';

    try {
        await api.RunOpenCode(dir, model, agent, continueFlag, sessionId);
        showToast('OpenCode 已启动', 'success');
    } catch (err) {
        showToast('启动失败: ' + (err.message || err), 'error');
    }

    btn.disabled = false;
    btn.textContent = '🚀 启动 OpenCode';
});

// ============================================================
// 嵌入式终端 (xterm.js)
// ============================================================
let terminalInstance = null;

function initTerminal() {
    const container = document.getElementById('terminalContainer');
    if (!container) return;
    if (terminalInstance) return;

    // 确保 xterm 已加载
    if (typeof Terminal === 'undefined') {
        console.warn('xterm.js 未加载');
        return;
    }

    terminalInstance = new Terminal({
        cursorBlink: true,
        cursorStyle: 'block',
        fontSize: 13,
        fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
        theme: {
            background: '#1e1e1e',
            foreground: '#cccccc',
            cursor: '#007acc',
            selectionBackground: '#264f78',
            black: '#1e1e1e',
            red: '#f44747',
            green: '#4ec9b0',
            yellow: '#dcdcaa',
            blue: '#569cd6',
            magenta: '#c586c0',
            cyan: '#4fc1ff',
            white: '#d4d4d4',
            brightBlack: '#808080',
            brightRed: '#f44747',
            brightGreen: '#4ec9b0',
            brightYellow: '#dcdcaa',
            brightBlue: '#569cd6',
            brightMagenta: '#c586c0',
            brightCyan: '#4fc1ff',
            brightWhite: '#d4d4d4',
        },
        rows: 24,
        allowTransparency: false,
    });

    terminalInstance.open(container);

    // 写个欢迎信息
    terminalInstance.writeln('\x1b[36m╔══════════════════════════════════════╗\x1b[0m');
    terminalInstance.writeln('\x1b[36m║  \x1b[1mOpenCode 管理中心 - 嵌入式终端\x1b[0m\x1b[36m    ║\x1b[0m');
    terminalInstance.writeln('\x1b[36m║  输入命令与 OpenCode 后端交互        ║\x1b[0m');
    terminalInstance.writeln('\x1b[36m╚══════════════════════════════════════╝\x1b[0m');
    terminalInstance.write('\r\n$ ');

    // 发送用户输入到后端
    terminalInstance.onData(data => {
        if (window.runtime) {
            window.runtime.EventsEmit('terminal-input', data);
        }
        // 本地回显（mock 模式）
        if (!window.runtime) {
            if (data === '\r') {
                terminalInstance.write('\r\n$ ');
            } else {
                terminalInstance.write(data);
            }
        }
    });

    // 监听后端输出
    if (window.runtime) {
        window.runtime.EventsOn('terminal-output', (output) => {
            if (terminalInstance && output) {
                terminalInstance.write(output);
            }
        });

        window.runtime.EventsOn('terminal-error', (errMsg) => {
            if (terminalInstance && errMsg) {
                terminalInstance.writeln('\r\n\x1b[31m[终端错误] ' + errMsg + '\x1b[0m');
            }
        });
    }

    // 尝试启动终端
    if (api.startTerminal) {
        api.startTerminal().catch(err => {
            console.warn('启动终端失败:', err);
        });
    }

    // 自适应大小
    const resizeTerminal = () => {
        if (terminalInstance && container) {
            const cols = Math.floor(container.clientWidth / 9.5);
            const rows = Math.floor(container.clientHeight / 18);
            if (cols > 10 && rows > 3) {
                terminalInstance.resize(cols, rows);
            }
        }
    };

    // 延迟等渲染完成后再 resize
    setTimeout(resizeTerminal, 100);
    window.addEventListener('resize', resizeTerminal);

    // 使用 ResizeObserver 更精确地监听容器大小变化
    if (window.ResizeObserver) {
        const observer = new ResizeObserver(() => resizeTerminal());
        observer.observe(container);
    }

    const status = document.getElementById('terminalStatus');
    if (status) status.textContent = '已连接';
}

// OpenCode 视图显示时初始化终端（仅一次）
const opencodeObserver = new MutationObserver(() => {
    const panel = document.getElementById('view-opencode');
    if (panel && panel.classList.contains('active') && !terminalInstance) {
        setTimeout(initTerminal, 200);
    }
});
opencodeObserver.observe(document.getElementById('view-opencode'), {
    attributes: true,
    attributeFilter: ['class'],
});

// ============================================================
// View 2: 模型配置
// ============================================================
let modelEntries = [];
let availableModels = [];
let originalEntries = [];
let modelSectionsLoaded = false;

async function loadModelConfig() {
    const container = document.getElementById('modelConfig');
    if (modelSectionsLoaded) return;

    container.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在加载模型配置...</p></div>';

    try {
        const [entries, models, confPath] = await Promise.all([
            api.GetModelConfig(),
            api.GetAvailableModels(),
            api.GetConfigPath(),
        ]);

        modelEntries = entries.map(e => ({ ...e }));
        originalEntries = entries.map(e => ({ ...e }));
        availableModels = models || [];

        document.getElementById('configPath').textContent = confPath || '未知';
        modelSectionsLoaded = true;
        renderModelConfig();
    } catch (err) {
        container.innerHTML = `<div class="error">
            <p>⚠️ 加载模型配置失败</p>
            <p class="error-detail">${escapeHtml(err.message || err)}</p>
            <button class="btn btn-primary" onclick="loadModelConfig()">重试</button>
        </div>`;
    }
}

function renderModelConfig() {
    const container = document.getElementById('modelConfig');
    const actions = document.getElementById('modelActions');

    if (modelEntries.length === 0) {
        container.innerHTML = '<div class="empty"><p>📭 未找到模型配置</p></div>';
        actions.style.display = 'none';
        return;
    }

    const agents = modelEntries.filter(e => e.type === 'agent');
    const categories = modelEntries.filter(e => e.type === 'category');

    container.innerHTML = '';
    actions.style.display = 'flex';

    // Agents 分组
    if (agents.length > 0) {
        const group = createModelGroup('🤖 Agents', agents);
        container.appendChild(group);
    }

    // Categories 分组
    if (categories.length > 0) {
        const group = createModelGroup('📦 Categories', categories);
        container.appendChild(group);
    }

    updateSaveStatus();
}

function createModelGroup(title, entries) {
    const group = document.createElement('div');
    group.className = 'model-group';

    const header = document.createElement('h3');
    header.className = 'model-group-title';
    header.textContent = title;

    const body = document.createElement('div');
    body.className = 'model-group-body';

    entries.forEach(entry => {
        const isChanged = originalEntries.find(o => o.key === entry.key)?.model !== entry.model;
        const row = document.createElement('div');
        row.className = 'model-row' + (isChanged ? ' changed' : '');
        row.dataset.key = entry.key;

        const topRow = document.createElement('div');
        topRow.className = 'model-row-top';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'model-key';
        nameSpan.textContent = entry.key;

        const select = document.createElement('select');
        select.className = 'model-select';
        select.dataset.key = entry.key;

        availableModels.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            if (m === entry.model) opt.selected = true;
            select.appendChild(opt);
        });

        select.addEventListener('change', (e) => {
            const key = e.target.dataset.key;
            const ent = modelEntries.find(en => en.key === key);
            if (ent) {
                ent.model = e.target.value;
                // 更新变更标记
                const orig = originalEntries.find(o => o.key === key);
                const changed = orig && orig.model !== ent.model;
                row.classList.toggle('changed', changed);
                updateSaveStatus();
            }
        });

        const badge = document.createElement('span');
        badge.className = 'model-type-badge';
        badge.textContent = entry.type;

        topRow.appendChild(nameSpan);
        topRow.appendChild(select);
        topRow.appendChild(badge);
        row.appendChild(topRow);

        if (entry.comment) {
            const commentDiv = document.createElement('div');
            commentDiv.className = 'model-comment';
            commentDiv.textContent = entry.comment;
            row.appendChild(commentDiv);
        }

        body.appendChild(row);
    });

    group.appendChild(header);
    group.appendChild(body);

    // 折叠功能
    header.addEventListener('click', () => {
        header.classList.toggle('collapsed');
        body.classList.toggle('collapsed');
    });

    return group;
}

function updateSaveStatus() {
    const changedCount = modelEntries.filter(e => {
        const orig = originalEntries.find(o => o.key === e.key);
        return orig && orig.model !== e.model;
    }).length;

    const status = document.getElementById('saveStatus');
    if (changedCount > 0) {
        status.textContent = `${changedCount} 项未保存`;
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
        const newModels = await api.GetAvailableModels();
        if (newModels) availableModels = newModels;
        // 重新获取配置（可能外部已修改）
        const [entries] = await Promise.all([
            api.GetModelConfig(),
        ]);
        modelEntries = entries.map(e => ({ ...e }));
        originalEntries = entries.map(e => ({ ...e }));
        renderModelConfig();
        showToast(`获取到 ${availableModels.length} 个可用模型`, 'success');
    } catch (err) {
        showToast('刷新模型列表失败: ' + (err.message || err), 'error');
    }
    btn.disabled = false;
    btn.textContent = '🔄 刷新列表';
});

// 保存模型配置
document.getElementById('btnSaveModels').addEventListener('click', async () => {
    const changedEntries = modelEntries.filter(e => {
        const orig = originalEntries.find(o => o.key === e.key);
        return orig && orig.model !== e.model;
    });

    if (changedEntries.length === 0) {
        showToast('没有需要保存的更改', 'info');
        return;
    }

    const btn = document.getElementById('btnSaveModels');
    btn.disabled = true;
    btn.textContent = '⏳ 保存中...';

    try {
        const result = await api.UpdateModels(modelEntries);
        if (result.success) {
            originalEntries = modelEntries.map(e => ({ ...e }));
            updateSaveStatus();
            showToast(`已保存 ${changedEntries.length} 项更改`, 'success');
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

// 技能管理 - OpenCode 配置按钮 → 跳转到模型配置视图
document.getElementById('btnOpenConfig').addEventListener('click', () => {
    switchView('view-models');
});

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
    // 默认视图为 OpenCode，加载其选项
    loadOpenCodeOptions();

    // 如果 OpenCode 视图默认激活，立即初始化终端
    const opencodePanel = document.getElementById('view-opencode');
    if (opencodePanel && opencodePanel.classList.contains('active')) {
        setTimeout(initTerminal, 300);
    }
});

// Wails 就绪事件
if (window.runtime) {
    window.runtime.EventsOn('wails:ready', () => {
        loadOpenCodeOptions();
        const opencodePanel = document.getElementById('view-opencode');
        if (opencodePanel && opencodePanel.classList.contains('active') && !terminalInstance) {
            setTimeout(initTerminal, 300);
        }
    });
}
