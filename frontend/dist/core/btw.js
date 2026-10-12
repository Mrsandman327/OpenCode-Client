// ============================================================
// OpenCode 管理中心 - /btw 侧问（一次性回答，不写入会话历史）
// ============================================================
// 本文件是**纯逻辑层**：不 import 任何仓内模块、不触碰 DOM，
// 因此 Node 单测（node --test / node tests/*.mjs）可以直接加载它。
// 界面与请求部分在同级的 chat/btw.js。
//
// 与普通 prompt 的本质区别：答案**绝不写入会话历史**。官方实现是在一个独立
// 面板（Panel + tab）里渲染 /api/experimental/generate 的返回文本，
// 该端点是「无状态模型生成」，与 session 的消息流完全隔离。
//
// 权威契约（上游 btw-model.ts + btw-panel.tsx，已实测本机 opencode 2.0.26）：
//   POST /api/experimental/generate
//   body：{ sessionID, prompt }
//   响应信封：{"data":{"text":"..."}}   ← 是 data.text，不是裸 text
//   instructions 三句按空格 join（上游 `[...].join(" ")`），
//   prompt = instructions + "\n\n" + 用户问题（上游 `[instructions, question].join("\n\n")`）
// ============================================================

/** 命令名：/btw */
export const BTW_COMMAND = 'btw';

/** 侧问端点（官方 experimental 前缀，服务端自标实验性，路径将来可能变）。 */
export const BTW_ENDPOINT = '/api/experimental/generate';

/** 上游 btw 扩展的三句指令，**逐字使用，不要改写、不要增删**。
 *  上游拼接方式是 `[...].join(" ")`——句间是单个空格，不是换行。 */
export const BTW_INSTRUCTIONS = [
    'The user is asking a quick side question about the conversation so far.',
    'Answer directly and concisely in markdown from what you already know.',
    'Do not call any tools and do not take any actions.',
].join(' ');

/**
 * 组装发给 /api/experimental/generate 的 prompt。
 *
 * 上游口径（btw-model.ts:44）：`[instructions, question].join("\n\n")`，
 * 即「指令段 + 空行 + 问题」。问题为空（trim 后）时返回空串，由调用方提示
 * 「请在 /btw 后输入问题」而**不发请求**（上游 btw-model.ts:65-69 同此口径：
 * 空问题只弹 toast，不落 tab、不请求）。
 *
 * @param {string} question 用户输入的问题（可含首尾空白）
 * @returns {string} 完整 prompt；问题为空时返回空串
 */
export function buildBtwPrompt(question) {
    const q = question == null ? '' : String(question).trim();
    return q ? BTW_INSTRUCTIONS + '\n\n' + q : '';
}

/**
 * 从响应里取出答案文本。只认 `{data:{text}}` 信封。
 *
 * 为什么不做「裸 text 也接受」的宽松兜底：那会让「服务端换了契约/返回了错误页」
 * 与「真的答了」无法区分，用户看到空面板却不知道要重试。宁可判失败（返回空串），
 * 让上层走重试路径并给出可见错误。
 *
 * @param {*} payload 已 JSON.parse 的响应体
 * @returns {string} 答案文本（trim 后）；信封不符返回空串
 */
export function extractBtwAnswer(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const data = payload.data;
    if (typeof data === 'string') return data.trim();
    if (data && typeof data === 'object' && typeof data.text === 'string') return data.text.trim();
    return '';
}

/**
 * 判断输入文本是否是 `/btw` 命令，并取出参数（问题）。
 *
 * 与 session.js 发送路径里的 `/^\/([^\s/]+)(?:\s+([\s\S]*))?$/` 保持同一套
 * 正则口径：命令名不允许含空格与斜杠，参数是第一个空白之后的全部内容。
 *
 * @param {string} text 输入框原文
 * @returns {{command:string, args:string}|null} 命中返回命令名与 trim 后的参数；未命中返回 null
 */
export function parseBtwCommand(text) {
    const raw = text == null ? '' : String(text);
    if (raw.charAt(0) !== '/') return null;
    const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(raw);
    if (!m || m[1] !== BTW_COMMAND) return null;
    return { command: BTW_COMMAND, args: (m[2] || '').trim() };
}

/**
 * 面板该显示哪一态。优先级与上游 btw-panel.tsx 的 `<Switch>` 分支顺序一致：
 * pending → error → answer（上游 error() 的定义是「答案未就绪且不在 pending」）。
 *
 * @param {{pending?:boolean, answer?:string, failed?:boolean}} state
 * @returns {'pending'|'error'|'answer'|'empty'}
 */
export function btwPanelState(state) {
    const s = state || {};
    if (s.pending) return 'pending';
    if (s.answer) return 'answer';
    if (s.failed) return 'error';
    return 'empty';
}
