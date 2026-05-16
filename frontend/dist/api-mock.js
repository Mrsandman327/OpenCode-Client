// ============================================================
// OpenCode 管理中心 - Wails API 封装（含 mock 回退）
// ============================================================
// api 延迟绑定：Wails 就绪前脚本可能已执行，此时 window.go 不存在
// 因此每次调用时先检测真实 API，就绪后自动切换
const api = new Proxy({}, {
    get(_, prop) {
        if (window.go && window.go.main && window.go.main.App && window.go.main.App[prop]) {
            return window.go.main.App[prop];
        }
        if (webApi[prop]) {
            return webApi[prop];
        }
        return mockApi[prop];
    }
});

const webApiHandlers = {
    async StartOpenCodeWeb(port, hostname, proxy) {
        const resp = await fetch('/api/open-code-web/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port: port || 0, hostname: hostname || '', proxy: proxy || {} })
        });
        return await resp.json();
    },
    async StopOpenCodeWeb() {
        const resp = await fetch('/api/open-code-web/stop', { method: 'POST' });
        return await resp.json();
    },
    async GetWebStatus(hostname, port) {
        const resp = await fetch('/api/open-code-web/status?hostname=' + encodeURIComponent(hostname || '') + '&port=' + encodeURIComponent(String(port || '')));
        return await resp.json();
    },
    async GetProjectTree(knownDirs) {
        const resp = await fetch('/api/project-tree?knownDirs=' + encodeURIComponent(knownDirs || '[]'));
        return await resp.text();
    },
    async OpenCodeAPI(method, path, body) {
        const resp = await fetch('/api/open-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method, path, body: body || '' })
        });
        return await resp.json();
    },
    async CreateSession(dir) {
        const resp = await fetch('/api/session/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir: dir || '' })
        });
        return await resp.json();
    },
    async GetAvailableModels() {
        const resp = await fetch('/api/models');
        return await resp.json();
    },
    async StartOpenCodeEvents() {
        const resp = await fetch('/api/open-code-events/start', { method: 'POST' });
        return await resp.json();
    },
    async StopOpenCodeEvents() {
        const resp = await fetch('/api/open-code-events/stop', { method: 'POST' });
        return await resp.json();
    }
};

const webApi = new Proxy(webApiHandlers, {
    get(target, prop) {
        if (target[prop]) return target[prop];
        return async (...args) => {
            const resp = await fetch('/api/app-call', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: String(prop), args })
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => null);
                throw new Error((err && (err.error || err.message)) || ('HTTP ' + resp.status));
            }
            return await resp.json();
        };
    }
});

const mockApi = (() => {
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
        { name: 'afsim-scripts', description: 'AFSIM脚本编写助手', path: '~/.config/opencode/skills/afsim-scripts', linked: true, source: 'global' },
        { name: 'code-review', description: '专业的代码审查助手', path: '~/.config/opencode/skills/code-review', linked: true, source: 'global' },
        { name: 'docx', description: 'Word文档创建编辑', path: '~/.config/opencode/skills/docx', linked: true, source: 'global' },
        { name: 'skill-creator', description: '创建新技能指南', path: '~/.config/opencode/skills/skill-creator', linked: true, source: 'global' },
        { name: 'frontend-design', description: '前端UI设计', path: '~/.config/opencode/skills/frontend-design', linked: true, source: 'global' },
        { name: 'weather', description: '天气预报', path: '~/.config/opencode/skills/weather', linked: true, source: 'global' },
        { name: 'drawio', description: '图表绘制', path: '~/.config/opencode/skills/drawio', linked: true, source: 'global' },
        { name: 'karpathy-wiki', description: '本地知识库/wiki管理', path: '~/.config/opencode/skills/karpathy-wiki', linked: false, source: 'global' },
        { name: 'pdf', description: 'PDF文档处理', path: '~/.config/opencode/skills/pdf', linked: true, source: 'global' },
        { name: 'pptx', description: '幻灯片创建编辑', path: '~/.config/opencode/skills/pptx', linked: false, source: 'global' },
        { name: 'web-access', description: '联网搜索与网页抓取', path: '~/.config/opencode/skills/web-access', linked: true, source: 'global' },
        { name: 'xlsx', description: '电子表格处理', path: '~/.config/opencode/skills/xlsx', linked: true, source: 'global' },
        { name: 'frontend-ui-ux', description: 'UI/UX 设计系统', path: '~/.config/opencode/skills/frontend-ui-ux', linked: true, source: 'global' },
        { name: 'git-master', description: 'Git 操作大师', path: '~/.config/opencode/skills/git-master', linked: false, source: 'global' },
    ];

    return {
        GetSkills: async () => JSON.parse(JSON.stringify(mockSkills)),
        GetSourceDir: async () => '~/.config/opencode/skills/',
        GetStats: async () => ({
            globalSkills: mockSkills.length,
        }),
        ToggleSkill: async (path, name, enable) => ({ success: true }),
        ReadSkillContent: async (path) => {
            var name = path.replace(/\\/g, '/').split('/').pop().replace('.md', '');
            return '# ' + name + '\n\n## 描述\n\n这是 ' + name + ' 技能的 mock SKILL.md 内容。\n\n## 使用\n\n当用户请求相关任务时自动加载。\n\n## 配置\n\n```json\n{\n  \"enabled\": true\n}\n```';
        },
        ListSkillFiles: async (path) => ({
            name: path.replace(/\\/g, '/').split('/').pop() || 'mock-skill',
            path: '.',
            type: 'dir',
            children: [
                { name: 'SKILL.md', path: 'SKILL.md', type: 'file' },
                { name: 'docs', path: 'docs', type: 'dir', children: [
                    { name: 'note.txt', path: 'docs/note.txt', type: 'file' }
                ] }
            ]
        }),
        ReadSkillFile: async (skillPath, relativePath) => ({
            path: relativePath,
            content: 'mock file preview for ' + relativePath
        }),
        SaveSkillFile: async (skillPath, relativePath, content) => ({
            success: true,
            path: relativePath,
            content: content
        }),
        SaveSkillContent: async (path, content) => ({ success: true }),
        Refresh: async () => {},
        OpenDir: async (path) => { console.log('mock open:', path); showToast(`模拟打开目录: ${path}`, 'info'); },
        OpenDirectoryDialog: async () => 'E:\\data\\ai_test\\feishu\\skill-manager',
        StartTerminal: async () => { console.log('mock terminal start'); },
        TerminalWrite: async (data) => { console.log('mock term write:', data); },
        GetSessions: async () => [
            { id: 'ses_abc123', title: '开发 Skill 桌面管理工具' },
            { id: 'ses_def456', title: 'OpenCode 模型配置管理' },
        ],
        unOpenCode: async (sid, cont) => { console.log('mock launch:', sid, cont); },
        // web 管理
        StartOpenCodeWeb: async (port, hostname, proxy) => {
            webURL = `http://${hostname || '127.0.0.1'}:${port || 4096}`;
            webRunning = true;
            serverStatus = { url: webURL, health: '在线', version: 'mock' };
            updateWebUI();
            return { running: true, success: true, url: webURL, health: '在线', version: 'mock' };
        },
        StopOpenCodeWeb: async () => {
            webRunning = false; webURL = '';
            serverStatus = normalizeServerStatus(null);
            updateWebUI(); clearClientUI();
            return { success: true };
        },
        GetWebStatus: async (hostname, port) => {
            return { running: webRunning, url: webURL || `http://${hostname || '127.0.0.1'}:${port || 4096}`, health: webRunning ? '在线' : '离线', version: webRunning ? 'mock' : '' };
        },
        LaunchWindowsTerminal: async (mode, url, dir) => {
            console.log('mock launch wt:', mode, url, dir);
            showToast('模拟启动终端' + (dir ? ' 目录:' + dir : ''), 'info');
            return { success: true };
        },
        OpenCodeAPI: async (method, path, body) => {
            if (method === 'POST' && path === '/session') return { success: true, status: 200, body: JSON.stringify({ id: 'ses_new_' + Date.now(), title: '新会话' }) };
            if (path === '/agent') return { success: true, status: 200, body: JSON.stringify([
                { name: 'build', description: '主执行代理，负责编写代码和实现功能', mode: 'primary', builtIn: true },
                { name: 'plan', description: '规划代理，负责架构设计和计划制定', mode: 'primary', builtIn: true },
                { name: 'general', description: '通用代理，处理一般性问答', mode: 'primary', builtIn: true },
                { name: 'explore', description: '探索代理，负责代码库搜索和研究', mode: 'subagent', builtIn: true },
            ]) };
            if (path === '/session') return { success: true, status: 200, body: JSON.stringify([
                { id: 'ses_abc123', title: '开发 Skill 桌面管理工具' },
                { id: 'ses_def456', title: 'OpenCode 模型配置管理' },
            ]) };
            if (path.includes('/message')) return { success: true, status: 200, body: JSON.stringify([
                { info: { role: 'user' }, parts: [{ text: '这是模拟消息' }] },
                { info: { role: 'assistant' }, parts: [{ type: 'text', text: '这是模拟回复' }, { type: 'tool', tool: 'read', state: { status: 'completed' } }] },
            ]) };
            if (path.includes('/diff')) return { success: true, status: 200, body: JSON.stringify([{ path: 'main.go', hunks: [{ lines: ['+ mock diff'] }] }]) };
            if (path.includes('/summarize')) return { success: true, status: 200, body: 'true' };
            if (path.includes('/revert')) return { success: true, status: 200, body: 'true' };
            if (path.includes('/unrevert')) return { success: true, status: 200, body: 'true' };
            return { success: true, status: 200, body: '{}' };
        },
        CreateSession: async (dir) => ({ success: true, status: 200, body: JSON.stringify({ id: 'ses_new_' + Date.now(), title: '新会话' }) }),
        GetProjectTree: async () => JSON.stringify([
            { id: 'global', title: '全局项目', type: 'project', children: [
                { id: 'global|D:\\test', title: 'D:\\test', type: 'directory', children: [
                    { id: 'ses_abc', title: '开发 Skill 桌面管理工具', type: 'session' },
                ]},
            ]},
        ]),
        StartOpenCodeEvents: async () => ({ success: true }),
        StopOpenCodeEvents: async () => ({ success: true }),
        // OMO 配置
        GetModelConfig: async () => [
            { key: 'sisyphus', type: 'agent', model: 'deepseek/deepseek-v4-pro', comment: '执行者：负责执行具体任务' },
            { key: 'oracle', type: 'agent', model: 'deepseek/deepseek-v4-flash', comment: '分析师：代码质量审查与安全分析' },
            { key: 'librarian', type: 'agent', model: 'deepseek/deepseek-v4-flash', comment: '搜索员：代码库搜索与知识检索' },
            { key: 'quick', type: 'category', model: 'deepseek/deepseek-v4-flash', comment: '快速：简单问答和日常快速任务' },
            { key: 'visual-engineering', type: 'category', model: 'deepseek/deepseek-v4-flash', comment: '视觉工程：UI设计和前端实现' },
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
        GetConfigPath: async () => '~/.config/opencode/oh-my-openagent.jsonc',
        GetFullConfig: async () => `{
            // 执行者：负责执行具体任务
            "agents": {
                "sisyphus": { "model": "deepseek/deepseek-v4-pro" },
                "oracle": { "model": "deepseek/deepseek-v4-flash" },
                "librarian": { "model": "deepseek/deepseek-v4-flash" },
                "explore": { "model": "deepseek/deepseek-v4-pro" },
                "sisyphus-junior": { "model": "deepseek/deepseek-v4-flash" },
                "momus": { "model": "deepseek/deepseek-v4-flash" },
                "metis": { "model": "deepseek/deepseek-v4-pro" },
                "hephaestus": { "model": "deepseek/deepseek-v4-flash" },
                "prometheus": { "model": "deepseek/deepseek-v4-flash" },
                "atlas": { "model": "deepseek/deepseek-v4-pro" },
                "multimodal-looker": { "model": "deepseek/deepseek-v4-flash" }
            },
            "categories": {
                "quick": { "model": "deepseek/deepseek-v4-flash" },
                "visual-engineering": { "model": "deepseek/deepseek-v4-flash" },
                "ultrabrain": { "model": "deepseek/deepseek-v4-flash" },
                "deep": { "model": "deepseek/deepseek-v4-flash" },
                "artistry": { "model": "deepseek/deepseek-v4-flash" },
                "unspecified-low": { "model": "deepseek/deepseek-v4-flash" },
                "unspecified-high": { "model": "deepseek/deepseek-v4-flash" }
            }
        }`,
        GetWorkDir: async () => 'E:\\data\\ai_test\\feishu\\skill-manager',
        AddModelType: async () => ({ success: true }),
        DeleteModelType: async () => ({ success: true }),
        AnswerQuestion: async (sessionID, label) => {
            console.log('mock answer question:', sessionID, label);
            return { success: true, status: 200 };
        },
        RejectQuestion: async (sessionID) => {
            console.log('mock reject question:', sessionID);
            return { success: true, status: 200 };
        },
        GetOpenCodeCommands: async () => [
            { name: 'new', description: '开始新会话', source: 'builtin' },
            { name: 'compact', description: '压缩会话上下文', source: 'builtin' },
            { name: 'undo', description: '撤销最后消息(需Git仓库)', source: 'builtin' },
            { name: 'redo', description: '重做撤销(需Git仓库)', source: 'builtin' },
            { name: 'exit', description: '退出OpenCode', source: 'builtin' },
            { name: 'help', description: '显示帮助/命令面板', source: 'builtin' },
            { name: 'models', description: '列出可用模型', source: 'builtin' },
            { name: 'themes', description: '列出可用主题', source: 'builtin' },
            { name: 'thinking', description: '切换思考块可见性', source: 'builtin' },
            { name: 'details', description: '切换工具执行详情', source: 'builtin' },
            { name: 'init', description: '创建/更新AGENTS.md', source: 'builtin' },
            { name: 'connect', description: '添加提供商API密钥', source: 'builtin' },
            { name: 'editor', description: '用外部编辑器编写消息', source: 'builtin' },
            { name: 'export', description: '导出对话为Markdown', source: 'builtin' },
            { name: 'share', description: '分享当前会话', source: 'builtin' },
            { name: 'unshare', description: '取消分享', source: 'builtin' },
            { name: 'sessions', description: '列出/切换会话', source: 'builtin' },
            { name: 'brainstorming', description: '在设计开发前头脑风暴，分析需求', source: 'skill' },
            { name: 'writing-plans', description: '将需求/设计拆解为可执行的实施方案', source: 'skill' },
            { name: 'code-review', description: '专业代码审查，多维度评估代码质量', source: 'skill' },
        ],
        // ========== 方案管理 mock ==========
        GetSchemeDir: async () => '.sisyphus\\omo-schemes',
        ListSchemes: async () => [
            { name: 'default', fileName: 'default.jsonc', fullPath: '.sisyphus\\omo-schemes\\default.jsonc' },
            { name: 'custom', fileName: 'custom.jsonc', fullPath: '.sisyphus\\omo-schemes\\custom.jsonc' },
        ],
        ReadScheme: async (name) => {
            const mockData = {
                agents: {
                    sisyphus: { model: 'deepseek/deepseek-v4-pro' },
                    oracle: { model: 'deepseek/deepseek-v4-flash' },
                    librarian: { model: 'deepseek/deepseek-v4-flash'}
                },
                categories: {
                    quick: { model: 'deepseek/deepseek-v4-flash' },
                    'visual-engineering': { model: 'deepseek/deepseek-v4-pro' }
                }
            };
            return JSON.stringify(mockData, null, 2);
        },
        SaveScheme: async (name, content) => {},
        OpenSchemeDir: async () => { showToast('模拟打开方案目录', 'info'); },
    };
})();
