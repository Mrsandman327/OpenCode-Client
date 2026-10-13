// ============================================================
// OC Manager - /btw 侧问（一次性回答，不写入会话历史）
// ============================================================
// 纯逻辑层：不 import 仓内模块、不触碰 DOM（可被 Node 直接加载测试）。
//
// 实现结合 OpenCode-Client PR #9 的上游契约，并按本机实测对端点做了修正：
//   PR 用的 /api/experimental/generate 是 stateless 端点（openapi 的请求体
//   没有 sessionID 字段、描述为「stateless model generation」，传 sessionID
//   会被忽略、回答不带对话上下文）；本实现改用 /api/session/{sessionID}/generate
//   ——服务端自述「Generate transient text from the current session context
//   without mutating session history」，正是侧问语义（已核对本机 2.0.26 openapi）。
//   两个端点的响应信封一致：{"data":{"text":"..."}}（SessionGenerateResponse：
//   data.text 为必填）。因此 prompt 构建与答案提取逻辑与 PR 保持同口径。
// ============================================================

/** 命令名：/btw */
export const BTW_COMMAND = 'btw';

/** 侧问端点（按会话 ID 拼路径；prompt 走请求体，不再带 sessionID 字段）。 */
export function btwEndpoint(sessionID) {
    return '/api/session/' + encodeURIComponent(sessionID) + '/generate';
}

/** 上游 btw 扩展的三句指令，**逐字使用，不要改写、不要增删**。
 *  上游拼接方式是 join(" ")——句间是单个空格，不是换行。 */
export const BTW_INSTRUCTIONS = [
    'The user is asking a quick side question about the conversation so far.',
    'Answer directly and concisely in markdown from what you already know.',
    'Do not call any tools and do not take any actions.',
].join(' ');

/**
 * 组装侧问 prompt：指令段 + 空行 + 问题。
 * 问题为空（trim 后）时返回空串，由调用方提示「请在 /btw 后输入问题」而不发请求。
 */
export function buildBtwPrompt(question) {
    const q = question == null ? '' : String(question).trim();
    return q ? BTW_INSTRUCTIONS + '\n\n' + q : '';
}

/**
 * 从响应里取答案文本。只认 `{data:{text}}` 信封（本机 openapi 的权威形状）；
 * 不符则返回空串 → 上层走失败重试，不显示空面板冒充成功。
 */
export function extractBtwAnswer(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const data = payload.data;
    if (data && typeof data === 'object' && typeof data.text === 'string') return data.text.trim();
    return '';
}

/**
 * 判断输入文本是否是 `/btw` 命令，并取出参数（问题）。
 * 与 session.js 发送路径的 `/^\/([^\s/]+)(?:\s+([\s\S]*))?$/` 保持同一套正则口径：
 * 命令名不允许含空格与斜杠，参数是第一个空白之后的全部内容。
 */
export function parseBtwCommand(text) {
    const raw = text == null ? '' : String(text);
    if (raw.charAt(0) !== '/') return null;
    const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(raw);
    if (!m || m[1] !== BTW_COMMAND) return null;
    return { command: BTW_COMMAND, args: (m[2] || '').trim() };
}
