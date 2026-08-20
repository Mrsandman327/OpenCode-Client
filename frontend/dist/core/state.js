// ============================================================
// OpenCode 管理中心 - 工作区全局状态（单例 store）
// 所有状态集中在此，其他文件通过 `import { store }` 读写：
//   读：store.currentSessionId
//   写：store.currentSessionId = 'xxx'
// 说明：ES Modules 的 import 绑定是只读的，裸变量无法被外部模块
//       赋值，因此统一收敛为 store 对象的属性。
// ============================================================

export const store = {
    // ============================
    // Web 服务状态
    // ============================
    /** opencode serve 的访问 URL */
    webURL: '',
    /** 页面 Web 服务（静态文件分发）的访问 URL */
    frontendWebURL: '',
    /** opencode serve 是否正在运行 */
    webRunning: false,
    /** 页面 Web 服务是否正在运行 */
    frontendWebRunning: false,

    // ============================
    // 会话管理
    // ============================
    /** 当前选中的会话 ID */
    currentSessionId: '',
    /** 会话列表（原始数据，用于项目树刷新） */
    sessions: [],
    /** 会话状态映射表，key=会话ID，value='busy'|'idle' */
    sessionStatuses: {},
    /** 会话错误信息映射表 */
    sessionErrors: {},
    /** 新建会话的待用工作目录（tree.js 写入，session.js 首次发送时读取） */
    pendingWorkDir: '',

    // ============================
    // 多会话 Tab 页
    // ============================
    /** 已打开的 tab 列表：{ sessionID, title } */
    openTabs: [],
    /** 当前活动 tab 的会话 ID（与 currentSessionId 保持一致） */
    activeTabId: '',
    /** 每个会话的缓存版本号，SSE 更新缓存时自增 */
    tabCacheVersion: {},
    /** 每个会话最后渲染的版本号，切回时对比以决定是否重建 DOM */
    tabRenderedVersion: {},
    /** 每个会话的滚动位置快照 */
    tabScrollPositions: {},
    /** 每个会话的展开状态快照 */
    tabExpandedParts: {},

    // ============================
    // 定时器
    // ============================
    /** 4s 定时刷新定时器（状态轮询、消息更新、diff 刷新） */
    refreshTimer: null,
    /** 防抖刷新项目树的定时器（2s 防抖） */
    sessionRefreshTimer: null,

    // ============================
    // 服务器状态
    // ============================
    /** 服务器状态信息：URL、健康状态、版本 */
    serverStatus: { url: '', health: '未知', version: '' },
    /** MCP 服务状态 */
    mcpStatus: null,
    /** LSP 服务状态 */
    lspStatus: null,

    // ============================
    // 消息缓存
    // ============================
    /** 消息缓存，key=会话ID，value=消息数组 */
    messageCache: {},
    /** 上一次渲染时的消息总数（用于增量更新判断） */
    lastMessageCount: 0,
    /** 上一次渲染时的原始消息总数（过滤前） */
    lastSourceMessageCount: 0,
    /** 消息加载序列号，用于竞态检测（每次加载递增） */
    messageLoadSeq: 0,
    /** 每个会话独立的消息加载序列号：key=会话ID，value=seq。
     *  快速连点多个 tab 时，各会话的加载请求互不干扰（修复竞态导致的历史 tab 空白）。 */
    sessionLoadSeq: {},
    /** 待渲染的会话 ID（调度到下一帧的消息渲染） */
    pendingMessageRenderSession: '',
    /** 待渲染的帧计数 */
    pendingMessageRenderFrame: 0,

    // ============================
    // 展开状态 & 滚动
    // ============================
    /** part 展开状态映射表，key=partID，value=true/false */
    expandedParts: {},
    /** Markdown 渲染缓存，key=文本，value=HTML */
    markdownCache: {},
    /** 用户是否正在拖拽滚动条（为 true 时不自动滚动到底部） */
    userScrolling: false,

    // ============================
    // 附件
    // ============================
    /** 已添加的附件列表，每项含 data/filename/mime/size */
    attachedFiles: [],
    /** question 工具自定义输入框的值，防止 DOM 重建时丢失 */
    questionCustomInput: '',

    // ============================
    // 目录浏览器
    // ============================
    /** 目录浏览器的当前路径 */
    dirBrowserCurrentPath: '',
    /** 目录浏览器 Promise resolve 回调 */
    dirBrowserResolver: null,
    /** 目录浏览器 Promise reject 回调 */
    dirBrowserRejecter: null,

    // ============================
    // 移动端消息截断
    // ============================
    /** 当前可见消息数量（移动端），初始等于渲染上限 */
    visibleMessageCount: 500,

    // ============================
    // Agent / Model 选择器
    // ============================
    /** 可用代理列表 */
    agentList: [],
    /** 可用模型列表 */
    modelList: [],
    /** 当前选中的 agent 名称 */
    selectedAgent: '',
    /** 当前选中的模型标识 */
    selectedModel: '',
    /** 当前选中的变体（minimal/low/medium/high/xhigh/max） */
    selectedVariant: '',
    /** Agent/Model 选择器是否已初始化加载 */
    agentModelSelectorsLoaded: false,

    // ============================
    // 子任务面板
    // ============================
    /** 当前会话的子任务摘要列表 */
    subtaskSummaries: [],
    /** 子任务提取是否正在进行（防重入） */
    subtaskExtractionPending: false,
    /** 子任务提取的 requestAnimationFrame 句柄 */
    subtaskExtractionFrame: 0,

    // ============================
    // 子会话详情弹窗
    // ============================
    /** 子会话详情消息缓存，key=子会话ID */
    detailMessageCache: {},
    /** 子会话详情加载状态，key=子会话ID，value=true/false */
    detailLoading: {},
    /** 子会话消息加载序列号，用于竞态检测 */
    detailMessageLoadSeq: 0,
    /** 详情弹窗展开状态（独立于 expandedParts） */
    detailExpandedParts: {},

    // ============================
    // 独立视图状态（views/ 层跨文件共享）
    // ============================
    /** 可用模型列表（provider 扁平 id，views/omo-config.js 读写，main.js 刷新时写） */
    availableModels: [],
    /** 技能数据是否已加载（views/skill-manager.js 读写，main.js 刷新时写） */
    skillsLoaded: false,
    /** 命令视图当前激活 tab：'cli'|'api'（views/commands.js 读写，main.js 切换时写） */
    cmdActiveTab: 'cli',
    /** 命令视图 API 文档搜索关键字（views/commands.js 读写，main.js 输入时写） */
    apiDocKeyword: '',
};

// ============================
// 常量（与状态分开导出，只读语义明确）
// ============================
/** 移动端最多渲染的消息条数 */
export const MOBILE_MESSAGE_RENDER_LIMIT = 30;
/** 移动端点击「加载更多」时每次增加的消息条数 */
export const MOBILE_MESSAGE_LOAD_MORE_STEP = 20;
/** PC端最多渲染的消息条数 */
export const PC_MESSAGE_RENDER_LIMIT = 500;
/** PC端点击「加载更多」时每次增加的消息条数 */
export const PC_MESSAGE_LOAD_MORE_STEP = 50;
/** 页面 Web 服务配置的 localStorage 键名 */
export const FRONTEND_WEB_CONFIG_KEY = 'oc-frontend-web-config';
