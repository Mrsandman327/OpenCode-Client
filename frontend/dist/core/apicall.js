// ============================================================
// OpenCode 管理中心 - Wails API 封装（含 mock 回退）
// ============================================================
// api 延迟绑定：wails3 绑定模块依赖 /wails/runtime.js（仅桌面 WebView 存在），
// 浏览器模式加载会失败，因此采用「桌面判定 + 动态 import」策略：
//   - 桌面模式（window._wails 存在）：动态加载 frontend/dist/bindings/oc-manager/app.js
//   - 浏览器模式：走 webApi（fetch /api/app-call）与 mockApi 兜底

import { store } from './state.js';
import { showToast, isDesktopRuntime } from './utils.js';

// 桌面绑定模块懒加载（wails3 generate bindings 生成，位于 dist/bindings/ 下）
let desktopBindingsPromise = null;

/** 加载桌面绑定模块，返回模块命名空间（含各服务方法的 PascalCase 导出） */
function loadDesktopBindings() {
    if (!desktopBindingsPromise) {
        desktopBindingsPromise = import('../../bindings/oc-manager/app.js');
    }
    return desktopBindingsPromise;
}

export const api = new Proxy({}, {
    get(_, prop) {
        if (prop === 'OpenCodeCall') {
            // return async (method, path, data) => {
            //     const result = await api.OpenCodeAPI(method, path, data ? JSON.stringify(data) : '');
            return async (...args) => {
                const requestMethod = args[0];
                const origPath = args[1];
                let requestPath = origPath;
                const requestData = args[2];
                // 可选第 4 参：项目目录 → 附加 location[directory]（v2 的 deepObject 作用域）。
                // 不传则不加。注意：需要 location 的端点，调用方在拿不到目录时必须**跳过请求**，
                // 否则会回落到服务端 CWD（共享服务为 home）并被登记成项目。
                const dir = args[3];
                if (dir) {
                    requestPath += (requestPath.indexOf('?') >= 0 ? '&' : '?') +
                        'location%5Bdirectory%5D=' + encodeURIComponent(dir);
                }
                const requestBody = requestData  ? JSON.stringify(requestData) : '';
                const result = await api.OpenCodeAPI(requestMethod,requestPath,requestBody);
                if (!result.success) {
                    // 抛错时带上状态码与响应体（附加属性，向后兼容）：
                    // 调用方（如 sendPrompt）需要把 HTTP 错误码与 v2 错误体
                    // （{"kind":"Payload","message":"..."}）解析成人话展示给用户，
                    // 否则「发送失败」只有一句无法定位原因的文本。
                    const err = new Error(result.error || result.body || `HTTP ${result.status}`);
                    err.status = result.status;
                    err.body = result.body;
                    throw err;
                }
                if (!result.body) return null;
                if(origPath === '/provider'){
                    var data = JSON.parse(result.body);
                    var models = [];
                    (data.all || []).forEach(function(provider) {
                        Object.values(provider.models || {}).forEach(function(m) {
                            // value 保持 providerID/modelID（对话请求按 '/' 切分，必须是真实模型 ID）
                            // label 用模型 name 展示（name 缺失时兜底用 id）
                            models.push({ value: provider.id + '/' + m.id, label: provider.id + '/' + (m.name || m.id) });
                        });
                    });
                    return models;
                }else{
                    return JSON.parse(result.body);
                }
            };
        }
        if (isDesktopRuntime()) {
            // 桌面模式：统一走 wails3 绑定（首次调用时动态加载绑定模块并转发到对应方法）
            return (...args) => loadDesktopBindings().then((mod) => {
                const fn = mod[prop];
                if (typeof fn !== 'function') {
                    throw new Error('桌面绑定缺少方法: ' + String(prop));
                }
                return fn(...args);
            });
        }
        if (webApi[prop]) {
            return webApi[prop];
        }
        return mockApi[prop];
    }
});

const webApi = new Proxy({}, {
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
    // 浏览器预览用的命令数据，与后端 config/commands/commands.go 保持同一份 V2 口径。
    // 注意：仅当 webApi 不可用时才会命中 mockApi；正常浏览器联调走 /api/app-call。
    const mockCommands = [
        { title: 'CLI - 会话', isTui: false, cmds: [
            { name: 'run', sub: '', options: '-m provider/model#variant, -c, -s ID, -f file, --format json, --fork, --thinking, --auto', desc: '非交互式运行提示词，适合脚本/CI；连接已有服务改用全局 --server' },
            { name: 'session', sub: 'list, delete, export, import', options: 'list: -n N --format json；export: --sanitize；import: --directory', desc: '会话管理（V1 的顶层 export/import 已收进本子命令）' },
            { name: 'stats', sub: '', options: '--days N, --year Y, --all, --project ID, --models, --tools, --cost, --full, --limit N, --json', desc: '会话用量统计：Token、费用、工具可靠性（对应 /api/experimental/session/stats）' },
        ]},
        { title: 'CLI - 服务', isTui: false, cmds: [
            { name: 'serve', sub: '', options: '--hostname, --port, --cors, --service, --stdio', desc: '启动 v2 API 与 Web 服务（V2 已合并原 web 命令，移除 --mdns）' },
            { name: 'service', sub: 'start, restart, status, stop, get, set, unset', options: '', desc: '管理共享后台服务；service set disabled true 可禁止自动拉起' },
            { name: 'reload', sub: '', options: '', desc: '重载配置：重建所有已加载 location（对应 POST /api/location/reload）' },
            { name: 'pair', sub: '', options: '--url, --remote, --yes', desc: '打印一次性配对链接；--remote 经隧道暴露服务到公网（需确认）' },
            { name: 'api', sub: '<operationId | METHOD path>', options: '-d body, -H name:value, --param key=value', desc: '按 OpenAPI 直接请求运行中的服务，调试接口比 Postman 更快' },
            { name: 'mini', sub: '', options: '-c, -s ID, --fork, -m, --agent, --prompt, --replay, --replay-limit', desc: '启动极简交互界面（非全屏 TUI）' },
            { name: 'acp', sub: '', options: '--login', desc: '启动 ACP（Agent Client Protocol）服务器' },
        ]},
        { title: 'CLI - 配置', isTui: false, cmds: [
            { name: 'auth', sub: 'list, login, logout, export, import, switch', options: '', desc: '管理集成与凭据（OAuth/账号）；V2 的 auth export 会输出含密钥的 JSON' },
            { name: 'mcp', sub: 'list, add, auth, logout', options: '', desc: '管理 MCP 服务器；V2 移除了 debug 子命令' },
            { name: 'plugin', sub: 'list, add, check, update, remove', options: 'update 不带参数时更新全部过期插件', desc: '管理插件（add 会写入全局配置；check/update 对应 /api/plugin/check、/api/plugin/update）' },
            { name: 'models', sub: '', options: '--standalone, --server', desc: '列出可用模型；V2 移除了 --refresh / --verbose' },
        ]},
        { title: 'CLI - 维护', isTui: false, cmds: [
            { name: 'upgrade', sub: '', options: '-m curl|npm|pnpm|bun|yarn|vp|brew|winget, [version]', desc: '升级到最新或指定版本' },
            { name: 'uninstall', sub: '', options: '--dry-run, --force', desc: '卸载 OpenCode；V2 始终保留会话数据、配置与状态，不再有 --keep-config' },
            { name: 'debug', sub: 'agents, config, paths', options: 'paths [db|home|data|config|cache|state|tmp|bin|log|repos]', desc: '诊断工具：列 agent、配置来源、各全局路径（替代 V1 的 db 命令）' },
        ]},
        { title: 'TUI - 会话管理', isTui: true, cmds: [
            { name: '/new', sub: '/clear', options: 'ctrl+x n', desc: '新建会话（V2 标签页默认开启）' },
            { name: '/sessions', sub: '/resume /continue', options: 'ctrl+x l', desc: '列出/切换会话；ctrl+o 同时看最近会话与项目' },
            { name: '/compact', sub: '/summarize', options: 'ctrl+x c', desc: '压缩会话上下文' },
            { name: '/undo', sub: '', options: 'ctrl+x u', desc: '撤销最后一条消息及其文件改动（需 Git 仓库）' },
            { name: '/redo', sub: '', options: 'ctrl+x r', desc: '重做已撤销的改动（需 Git 仓库）' },
            { name: '/exit', sub: '/quit /q', options: 'ctrl+c / ctrl+d / ctrl+x q', desc: '退出 OpenCode' },
        ]},
        { title: 'TUI - 信息查看', isTui: true, cmds: [
            { name: '/models', sub: '', options: 'ctrl+x m（F2 循环最近模型）', desc: '选择模型；ctrl+t 切换模型变体' },
            { name: '/agents', sub: '', options: 'ctrl+x a（Shift+Tab 循环）', desc: '选择 agent（V2 新增斜杠命令）' },
            { name: '/themes', sub: '', options: '', desc: '切换主题（V2 默认未绑定快捷键）' },
            { name: '/thinking', sub: '', options: '', desc: '切换思考块可见性（不改变模型推理开关）' },
            { name: '/highlights', sub: '', options: '', desc: '查看本次版本的更新亮点（V2 新增）' },
            { name: '/help', sub: '', options: 'ctrl+p 命令面板', desc: '帮助与当前视图的全部动作' },
        ]},
        { title: 'TUI - 操作', isTui: true, cmds: [
            { name: '/init', sub: '', options: '', desc: '引导创建/更新 AGENTS.md' },
            { name: '/connect', sub: '', options: '', desc: '连接提供商或集成' },
            { name: '/editor', sub: '', options: 'ctrl+x e', desc: '用 $EDITOR/$VISUAL 编辑当前输入并回填' },
            { name: '/export', sub: '', options: 'ctrl+x x', desc: '导出会话（V2 导出到编辑器；CLI 用 session export）' },
            { name: '/btw', sub: '<问题>', options: '', desc: '侧问：用当前上下文回答但不写入会话（V2 新增）' },
        ]},
        { title: 'TUI - 快捷键（V2 变化）', isTui: true, cmds: [
            { name: '命令面板', sub: '', options: 'ctrl+p', desc: '列出当前视图的全部可执行动作' },
            { name: '排队 prompt', sub: '', options: 'ctrl+x 然后 Enter；ctrl+x q 管理', desc: '执行中继续提交：Enter 为 steer，入队则按此键（V2 新增）' },
            { name: '工具转后台', sub: '', options: 'ctrl+b', desc: '把前台阻塞的工具调用转到后台观察（对应 session/background）' },
            { name: '标签页', sub: '', options: 'ctrl+tab / ctrl+shift+tab；ctrl+x w 关闭；ctrl+shift+t 重开', desc: 'V2 默认开启会话标签页' },
            { name: '侧栏 / 终端 / 状态', sub: '', options: 'ctrl+x b / ctrl+x t / ctrl+x s', desc: '切换侧栏、终端面板、运行状态' },
            { name: 'diff 面板', sub: '', options: 'd 切换范围；m 标记已读；v 分屏；s 单文件；n/p 切文件', desc: 'V2 新增 All/Committed/Uncommitted/Last turn/Base 范围' },
            { name: '会话快速槽', sub: '', options: 'ctrl+x 1..9', desc: '快速切换到对应槽位（V2 新增）' },
            { name: '子会话导航', sub: '', options: '方向键（上/下进入或返回子会话）', desc: '在父会话与子 agent 会话之间跳转' },
        ]},
    ];

    const mockSkills = [
        { name: 'afsim-scripts', description: 'AFSIM脚本编写助手', path: '~/.config/opencode/skills/afsim-scripts', linked: true, source: 'global', enableable: true },
        { name: 'code-review', description: '专业的代码审查助手', path: '~/.config/opencode/skills/code-review', linked: true, source: 'global', enableable: true },
        { name: 'docx', description: 'Word文档创建编辑', path: '~/.config/opencode/skills/docx', linked: true, source: 'global', enableable: true },
        { name: 'skill-creator', description: '创建新技能指南', path: '~/.config/opencode/skills/skill-creator', linked: true, source: 'global', enableable: true },
        { name: 'frontend-design', description: '前端UI设计', path: '~/.config/opencode/skills/frontend-design', linked: true, source: 'global', enableable: true },
        { name: 'weather', description: '天气预报', path: '~/.config/opencode/skills/weather', linked: true, source: 'global', enableable: true },
        { name: 'drawio', description: '图表绘制', path: '~/.config/opencode/skills/drawio', linked: true, source: 'global', enableable: true },
        { name: 'karpathy-wiki', description: '本地知识库/wiki管理', path: '~/.config/opencode/skills/karpathy-wiki', linked: false, source: 'global', enableable: true },
        { name: 'pdf', description: 'PDF文档处理', path: '~/.config/opencode/skills/pdf', linked: true, source: 'global', enableable: true },
        { name: 'pptx', description: '幻灯片创建编辑', path: '~/.config/opencode/skills/pptx', linked: false, source: 'global', enableable: true },
        { name: 'web-access', description: '联网搜索与网页抓取', path: '~/.config/opencode/skills/web-access', linked: true, source: 'global', enableable: true },
        { name: 'xlsx', description: '电子表格处理', path: '~/.config/opencode/skills/xlsx', linked: true, source: 'global', enableable: true },
        { name: 'frontend-ui-ux', description: 'UI/UX 设计系统', path: '~/.config/opencode/skills/frontend-ui-ux', linked: true, source: 'global', enableable: true },
        { name: 'git-master', description: 'Git 操作大师', path: '~/.config/opencode/skills/git-master', linked: false, source: 'global', enableable: true },
    ];

    return {
        // 客户端版本号（OC Manager 自身版本）：mock 模式下固定返回，供界面联调
        GetAppVersion: async () => '2.0.0',
        GetSkills: async () => JSON.parse(JSON.stringify(mockSkills)),
        GetSourceDir: async () => '~/.config/opencode/skills/',
        GetStats: async () => ({
            globalSkills: mockSkills.length,
        }),
        GetSkillConfig: async () => ({
            sourceDirs: [],
            skills: JSON.parse(JSON.stringify(mockSkills)).map(function(s) {
                s.enableable = false;
                s.noSources = true;
                s.conflict = false;
                s.sources = [{ path: s.path, source: 'global' }];
                return s;
            }),
            stats: { globalSkills: mockSkills.length }
        }),
        ToggleSkill: async (path, name, enable) => ({ success: true }),
        Refresh: async () => {},
        OpenDir: async (path) => { console.log('mock open:', path); showToast(`模拟打开目录: ${path}`, 'info'); },
        OpenDirectoryDialog: async () => '/home/user/ai_test/skill-manager',
        StartTerminal: async () => { console.log('mock terminal start'); },
        TerminalWrite: async (data) => { console.log('mock term write:', data); },
        unOpenCode: async (sid, cont) => { console.log('mock launch:', sid, cont); },
        // web 管理
        StartOpenCodeWeb: async (port, hostname, password, proxy) => {
            store.webURL = `http://${hostname || '127.0.0.1'}:${port || 49374}`;
            store.webRunning = true;
            store.serverStatus = { url: store.webURL, health: '在线', version: 'mock' };
            // 不再直接调用业务层 updateWebUI，由调用方（service.startWeb）负责 UI 刷新
            return { running: true, success: true, url: store.webURL, health: '在线', version: 'mock' };
        },
        StopOpenCodeWeb: async () => {
            store.webRunning = false; store.webURL = '';
            store.serverStatus = { url: '', health: '离线', version: '' };
            // 不再直接调用业务层 updateWebUI/clearClientUI，由调用方（service.stopWeb）负责 UI 刷新
            return { success: true };
        },
        GetWebStatus: async (hostname, port) => {
            return { running: store.webRunning, url: store.webURL || `http://${hostname || '127.0.0.1'}:${port || 49374}`, health: store.webRunning ? '在线' : '离线', version: store.webRunning ? 'mock' : '' };
        },
        LaunchWindowsTerminal: async (mode, url, dir) => {
            console.log('mock launch wt:', mode, url, dir);
            showToast('模拟启动终端' + (dir ? ' 目录:' + dir : ''), 'info');
            return { success: true };
        },
        OpenCodeAPI: async (method, path, body) => {
            if (path === '/command') return { success: true, status: 200, body: JSON.stringify([
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
            ]) };
            if (path === '/provider') return { success: true, status: 200, body: JSON.stringify({
                all: [
                    { id: 'deepseek', models: { 'deepseek-chat': { id: 'deepseek-chat' }, 'deepseek-reasoner': { id: 'deepseek-reasoner' }, 'deepseek-v4-flash': { id: 'deepseek-v4-flash' }, 'deepseek-v4-pro': { id: 'deepseek-v4-pro' } } },
                    { id: 'openai', models: { 'gpt-5.1-codex': { id: 'gpt-5.1-codex' }, 'gpt-5.5': { id: 'gpt-5.5' } } },
                    { id: 'anthropic', models: { 'claude-sonnet-5': { id: 'claude-sonnet-5' }, 'claude-haiku-5': { id: 'claude-haiku-5' } } },
                ]
            }) };
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
        // mock：与后端一致的两层树（顶层目录 → 会话）
        GetProjectTree: async () => JSON.stringify([
            { id: '/home/user/test', title: '/home/user/test', type: 'directory', children: [
                { id: 'ses_abc', title: '开发 Skill 桌面管理工具', type: 'session', updatedAt: '2026-09-29 10:00', directory: '/home/user/test' },
            ]},
        ]),
        StartOpenCodeEvents: async () => ({ success: true }),
        StopOpenCodeEvents: async () => ({ success: true }),
        // ========== OMO Slim 配置 mock（浏览器预览用） ==========
        GetSlimConfig: async () => ({
            path: '~/.config/opencode/oh-my-opencode-slim.jsonc',
            exists: true,
            activePreset: 'rongsi',
            presets: [
                { name: 'rongsi', agents: [
                    { key: 'orchestrator', model: 'deepseek/deepseek-flash', variant: 'max', comment: '主编排器：拆解任务、调度后台专家、汇总结果' },
                    { key: 'oracle', model: 'deepseek/deepseek-flash', variant: 'max', comment: '高级顾问：架构决策、疑难调试、代码审查' },
                    { key: 'explorer', model: 'deepseek/deepseek-flash', variant: 'low', comment: '代码库侦察：大范围搜索与结构梳理' },
                ] },
                { name: '省流', extends: 'rongsi', agents: [
                    { key: 'orchestrator', model: 'deepseek/deepseek-flash', variant: 'max', comment: '主编排器：拆解任务、调度后台专家、汇总结果', inherited: true },
                    { key: 'explorer', model: 'deepseek/deepseek-v4-flash', variant: 'low', comment: '代码库侦察：大范围搜索与结构梳理', inherited: true, overridden: true },
                ] },
            ],
            envPresetOverride: '',
            projectConfigPath: '',
            revision: 'mock',
        }),
        SaveSlimConfig: async (payload) => ({ success: true }),
        GetSlimConfigPath: async () => '~/.config/opencode/oh-my-opencode-slim.jsonc',
        GetSlimAgentDescriptions: async () => ({
            orchestrator: '主编排器：拆解任务、调度后台专家、汇总结果',
            oracle: '高级顾问：架构决策、疑难调试、代码审查',
        }),
        GetProviders: async () => [
            { key: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-ec****ffe1', enabled: true, models: [{id:'deepseek-v4-pro',name:'DeepSeek-V4-Pro'}] },
            { key: 'siliconflow', name: 'SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1', apiKey: 'sk-vg****bshs', enabled: false, models: [] },
        ],
        SaveProvider: async (p) => ({ success: true }),
        DeleteProvider: async (key) => ({ success: true }),
        GetModelList: async (baseURL, apiKey) => {
            if (baseURL.includes('deepseek')) return ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-pro', 'deepseek-v4-flash'];
            if (baseURL.includes('siliconflow')) return ['Qwen/Qwen2.5-7B-Instruct', 'meta-llama/Meta-Llama-3.1-8B-Instruct', 'deepseek-ai/DeepSeek-V3'];
            return ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'];
        },
        GetProviderConfigPath: async () => '~/.config/opencode/opencode.jsonc',

        GetWorkDir: async () => '/home/user/ai_test/skill-manager',

        AnswerQuestion: async (sessionID, answers) => {
            console.log('mock answer question:', sessionID, answers);
            return { success: true, status: 200 };
        },
        RejectQuestion: async (sessionID) => {
            console.log('mock reject question:', sessionID);
            return { success: true, status: 200 };
        },
        // ========== 技能源目录管理 mock ==========
        AddSkillSourceDir: async (dir) => ({ success: true }),
        RemoveSkillSourceDir: async (dir) => ({ success: true }),
        GetSkillSourceDirs: async () => ['~/.config/opencode/skills', '~/.config/opencode/custom-skills'],
        GetDirEnabledSkills: async (dir) => [],
        LinkSkill: async (path, enable) => ({ success: true }),
        // ========== 技能方案管理 mock ==========
        SaveSkillScheme: async (name) => ({ success: true }),
        ApplySkillScheme: async (name) => ({ success: true, applied: ['afsim-scripts', 'weather'], missing: [], conflicts: [], errors: [] }),
        ListSkillSchemes: async () => (['default', 'minimal', 'full']),
        DeleteSkillScheme: async (name) => ({ success: true }),
    };
})();
