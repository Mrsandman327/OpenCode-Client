// ============================================================
// OpenCode 管理中心 - 工作区全局状态
// 所有 let / const 声明集中在此，其他文件直接使用这些变量
// ============================================================

// ============================
// Web 服务状态
// ============================

/** opencode serve 的访问 URL */
let webURL = '';
/** 页面 Web 服务（静态文件分发）的访问 URL */
let frontendWebURL = '';
/** opencode serve 是否正在运行 */
let webRunning = false;
/** 页面 Web 服务是否正在运行 */
let frontendWebRunning = false;
/** 页面 Web 服务配置的 localStorage 键名 */
const FRONTEND_WEB_CONFIG_KEY = 'oc-frontend-web-config';

// ============================
// 会话管理
// ============================

/** 当前选中的会话 ID */
let currentSessionId = '';
/** 会话列表（原始数据，用于项目树刷新） */
let sessions = [];
/** 会话状态映射表，key=会话ID，value='busy'|'idle' */
let sessionStatuses = {};
/** 会话错误信息映射表 */
let sessionErrors = {};

// ============================
// 定时器
// ============================

/** 4s 定时刷新定时器（状态轮询、消息更新、diff 刷新） */
let refreshTimer = null;
/** 防抖刷新项目树的定时器（2s 防抖） */
let sessionRefreshTimer = null;

// ============================
// 服务器状态
// ============================

/** 服务器状态信息：URL、健康状态、版本 */
let serverStatus = { url: '', health: '未知', version: '' };
/** MCP 服务状态 */
let mcpStatus = null;
/** LSP 服务状态 */
let lspStatus = null;

// ============================
// 消息缓存
// ============================

/** 消息缓存，key=会话ID，value=消息数组 */
let messageCache = {};
/** 上一次渲染时的消息总数（用于增量更新判断） */
let lastMessageCount = 0;
/** 上一次渲染时的原始消息总数（过滤前） */
let lastSourceMessageCount = 0;
/** 消息加载序列号，用于竞态检测（每次加载递增） */
let messageLoadSeq = 0;
/** 待渲染的会话 ID（调度到下一帧的消息渲染） */
let pendingMessageRenderSession = '';
/** 待渲染的帧计数 */
let pendingMessageRenderFrame = 0;

// ============================
// 展开状态 & 滚动
// ============================

/** part 展开状态映射表，key=partID，value=true/false */
let expandedParts = {};
/** Markdown 渲染缓存，key=文本，value=HTML */
let markdownCache = {};
/** 用户是否正在拖拽滚动条（为 true 时不自动滚动到底部） */
let userScrolling = false;

// ============================
// 附件
// ============================

/** 已添加的附件列表，每项含 data/filename/mime/size */
let attachedFiles = [];

/** question 工具自定义输入框的值，防止 DOM 重建时丢失 */
let questionCustomInput = '';

// ============================
// 目录浏览器
// ============================

/** 目录浏览器的当前路径 */
let dirBrowserCurrentPath = '';
/** 目录浏览器 Promise resolve 回调 */
let dirBrowserResolver = null;
/** 目录浏览器 Promise reject 回调 */
let dirBrowserRejecter = null;

// ============================
// 移动端消息截断
// ============================

/** 移动端最多渲染的消息条数 */
const MOBILE_MESSAGE_RENDER_LIMIT = 30;
/** 移动端点击「加载更多」时每次增加的消息条数 */
const MOBILE_MESSAGE_LOAD_MORE_STEP = 20;
/** PC端最多渲染的消息条数 */
const PC_MESSAGE_RENDER_LIMIT = 500;
/** PC端点击「加载更多」时每次增加的消息条数 */
const PC_MESSAGE_LOAD_MORE_STEP = 50;
/** 当前可见消息数量（移动端），初始等于渲染上限 */
let visibleMessageCount = PC_MESSAGE_RENDER_LIMIT;

// ============================
// Agent / Model 选择器
// ============================

/** 可用代理列表 */
let agentList = [];
/** 可用模型列表 */
let modelList = [];
/** 当前选中的 agent 名称 */
let selectedAgent = '';
/** 当前选中的模型标识 */
let selectedModel = '';
/** 当前选中的变体（minimal/low/medium/high/xhigh/max） */
let selectedVariant = '';
/** Agent/Model 选择器是否已初始化加载 */
let agentModelSelectorsLoaded = false;

// ============================
// 子任务面板
// ============================

/** 当前会话的子任务摘要列表 */
let subtaskSummaries = [];
/** 子任务提取是否正在进行（防重入） */
let subtaskExtractionPending = false;
/** 子任务提取的 requestAnimationFrame 句柄 */
let subtaskExtractionFrame = 0;

// ============================
// 子会话详情弹窗
// ============================

/** 子会话详情消息缓存，key=子会话ID */
let detailMessageCache = {};
/** 子会话详情加载状态，key=子会话ID，value=true/false */
let detailLoading = {};
/** 子会话消息加载序列号，用于竞态检测 */
let detailMessageLoadSeq = 0;

/** 详情弹窗展开状态（独立于 expandedParts） */
let detailExpandedParts = {};
