// ============================================================
// core/v2compat.js — OpenCode v2 API 适配层
//
// 背景：OpenCode v2 对 server API 做了不兼容改动（路径收拢到 /api、
// 响应普遍改为 {data:...} 信封、消息由 {info, parts} 扁平化为 {content:[]}、
// SSE 事件词汇整体替换）。若直接改 chat/render.js 里的渲染逻辑，影响面过大。
//
// 做法：本模块在「网络边界」把 v2 的响应与事件**还原**成 v1 的数据契约
// （消息仍是 {info, parts}，事件仍是 message.part.updated / message.part.delta 等），
// 使 chat/cache.js 与 chat/render.js 完全无需改动。
// ============================================================

// ============================
// 通用：拆信封
// ============================

/**
 * 拆开 v2 的 {data: ...} 响应信封。
 * v2 多数列表端点返回 {location, data:[...]}，部分（如 /api/config）返回裸数组，
 * 因此这里两种形态都要兼容。
 */
export function unwrap(res) {
    if (res && typeof res === 'object' && !Array.isArray(res) && 'data' in res) {
        return res.data;
    }
    return res;
}

/** 拆信封并保证结果是数组（v1 端点普遍返回裸数组）。 */
export function unwrapList(res) {
    const data = unwrap(res);
    return Array.isArray(data) ? data : [];
}

// ============================
// 请求失败信息：把 OpenCodeCall 抛出的 Error 整理成人话
// ============================

/**
 * 把请求失败的 Error 整理成可展示文本（toast 用，需短）。
 *
 * OpenCodeCall 失败时抛出的 Error 带 status / body（见 core/apicall.js）：
 *  - 非 2xx：body 是服务端原始响应体，v2 错误形如
 *    {"_tag":"InvalidRequestError","message":"...","kind":"Payload"}；
 *  - HTML 兜底 / 网络错误：error 字段有说明文案，body 为空。
 * 解析优先级：body 里的 message/error（人话）→ e.message。
 * 输出形如 "HTTP 400: Missing key at [\"text\"]"；整体截断 300 字符。
 */
export function formatApiError(e) {
    if (!e) return '未知错误';
    const status = Number(e.status) || 0;
    const body = typeof e.body === 'string' ? e.body : '';
    let detail = '';
    if (body) {
        try {
            const parsed = JSON.parse(body);
            detail = parsed.message || parsed.error || (parsed.data && parsed.data.message) || '';
        } catch (_) {
            // 非 JSON 响应体（如 HTML 片段）：原样展示（下面统一截断）
            detail = body;
        }
    }
    if (!detail) detail = e.message || '';
    detail = String(detail).replace(/\s+/g, ' ').trim().slice(0, 300);
    return status ? ('服务端返回错误（' + status + '）：' + detail) : detail;
}

// ============================
// 路径：v1 → v2
// ============================

/** 把 v1 的 prompt 请求体转换为 v2 的 {text, files, agents, ...} 形态。
 *  v1 发送 {parts:[{type:'text',text},{type:'file',...}], model, variant, agent}；
 *  v2 改为顶层 text + files/agents/skills，且**不再随 prompt 提交 model/agent**——
 *  两者分别改由 POST /api/session/{id}/model 与 /agent 单独设置（见 applySessionModel）。
 *
 *  形状为**扁平**顶层字段（不是 {prompt:{text}} 嵌套）。依据（2026-09 对本机
 *  opencode 2.0.6 实测）：
 *   1. POST /api/session/{id}/prompt body {"text":"ping"} → 200 且 agent 真实执行；
 *      带顶层 {"text":"...","id":"msg_..."} → 200 且服务端原样采纳该 id；
 *   2. 嵌套 {"prompt":{"text":"ping"}} → 400
 *      {"_tag":"InvalidRequestError","message":"Missing key at [\"text\"]","kind":"Payload"}；
 *   3. 服务端 /openapi.json 的该端点 schema 也是扁平：
 *      {id?, text(required), files?, agents?, skills?, metadata?, delivery?, resume?}，
 *      additionalProperties=false。
 *  注意：仓库内 @opencode-ai/sdk 1.18.31 的生成代码把该端点标为嵌套 {prompt}，
 *  与服务端 2.0.6 实际契约不符——若未来要改回嵌套，必须先按上述方式重新实测。
 */
export function toPromptBody(v1body) {
    const body = v1body || {};
    const parts = Array.isArray(body.parts) ? body.parts : [];
    const text = parts
        .filter(p => p && p.type === 'text' && typeof p.text === 'string')
        .map(p => p.text)
        .join('\n');
    // v2 的 files 是 {uri, name?}（PromptInput.FileAttachment），不是模型 API 的内容块字符串
    const files = parts
        .filter(p => p && (p.type === 'file' || p.type === 'image') && p.url)
        .map(p => (p.filename ? { uri: p.url, name: p.filename } : { uri: p.url }));
    const out = { text };
    if (files.length) out.files = files;
    // v2 的 agents 是 [{name}]（Prompt.AgentAttachment），不是字符串数组
    if (body.agent) out.agents = [{ name: body.agent }];
    // v2 把「客户端指定消息 id」放在顶层 id（v1 是 messageID）。
    // 必须透传：发送后本地会先乐观插入一条 user 消息，只有 id 与服务端一致，
    // 服务端回执（session.inbox.enqueued 的 inboxID）才能按 id 命中并合并，
    // 否则同一条输入会显示两遍。服务端会原样采纳该 id（已实测）。
    // v2 的 skills 附件：[{id}]（PromptInput.SkillAttachment）——调用技能的唯一方式。
    // 调用方（session.js）在正文以 "/<技能id>" 开头时通过 body.skills 传入技能 id。
    if (Array.isArray(body.skills) && body.skills.length) {
        const skills = body.skills
            .map(s => ({ id: typeof s === 'string' ? s : (s && s.id) }))
            .filter(s => s.id);
        if (skills.length) out.skills = skills;
    }
    if (body.messageID) out.id = body.messageID;
    return out;
}

/** 由 "providerID/modelID" 与 variant 组装 v2 的 Model.Ref。 */
export function toModelRef(modelId, variant) {
    if (!modelId) return null;
    const slashIdx = modelId.indexOf('/');
    if (slashIdx <= 0) return null;
    const ref = { providerID: modelId.slice(0, slashIdx), id: modelId.slice(slashIdx + 1) };
    if (variant) ref.variant = variant;
    return ref;
}

// ============================
// 模型列表：v2 Model.Info → 前端既有的 {value,label}
// ============================

/**
 * v2 的 /api/model 返回 Model.Info[]（{providerID, modelID, name, variants...}），
 * 而前端各处（聊天模型下拉、OMO 配置、供应商刷新）统一消费 {value, label}，
 * 其中 value 是 "providerID/modelID"。这里做一次归一化，三处调用点共用。
 */
export function toModelOptions(res) {
    return unwrapList(res).map(m => {
        const modelID = m.modelID || m.id || '';
        const providerID = m.providerID || '';
        // value 必须是非空且可被 toModelRef 拆成 provider/model：
        // 下拉框提交时按 '/' 切分，缺 provider 会得到空串并被静默丢弃。
        // 只有 provider 没有 model（或反之）的条目无法表达，直接剔除。
        const value = providerID && modelID ? providerID + '/' + modelID : '';
        return {
            value,
            // label 带「供应商/」前缀：不同供应商常有同名模型（如各家都有 glm-5.2 / deepseek-v4-pro），
            // 只显示模型名无法区分，故统一显示为 provider/model 形式（与 value 同构、便于核对）。
            label: providerID + '/' + (m.name || modelID),
            variants: Array.isArray(m.variants) ? m.variants.map(v => v.id) : [],
            enabled: m.enabled !== false,
        };
    }).filter(m => m.value)
      // 按「供应商/模型」排序：同一供应商的模型必须连续，否则下拉里会被打散
      // （服务端返回顺序按发布时间，provider 是交错的）。大小写不敏感，保证分组稳定。
      .sort((a, b) => a.value.toLowerCase().localeCompare(b.value.toLowerCase()));
}

// ============================
// 会话状态：v2 的 {type:'running'} → v1 的 'busy' / 'idle'
// ============================

/**
 * 归一化 /api/session/active 的返回。
 *
 * v2 实测形状：{"data":{"<sessionID>":{"type":"running"}}}，且**只列出活跃会话**
 * （空闲时整个 data 为 {}）。而 v1 是扁平字符串映射 {sessionID: 'busy'|'idle'}，
 * 现有代码（isSessionBusy 认 status==='busy' 或 status?.type==='busy'、
 * abortSession 判 statuses[id]==='idle'）都按 v1 契约写，直接透传会导致
 * 「会话正在跑但发送按钮仍显示发送」「停止后的状态确认永远不成立」。
 *
 * 这里统一转成 v1 形态：running → 'busy'；idle → 'idle'；
 * 其它类型（如 retry）保留对象，使 isSessionBusy 的 retry 分支仍可命中。
 */
export function normalizeStatuses(res) {
    const map = unwrap(res) || {};
    const out = {};
    for (const sid of Object.keys(map)) {
        const v = map[sid];
        if (v == null) continue;
        if (typeof v === 'string') { out[sid] = v; continue; }
        const t = v.type ?? v.status;
        if (t === 'running' || t === 'busy') out[sid] = 'busy';
        else if (t === 'idle') out[sid] = 'idle';
        else out[sid] = v; // retry 等：保留原对象
    }
    return out;
}

// ============================
// 消息：v2 扁平消息 → v1 {info, parts}
// ============================

/** v2 的工具输出是 content 块数组，v1 是 state.output 字符串。
 *  v2 的块类型（packages/schema/src/tool.ts 的 Tool.Content）：
 *   - {type:'text', text}      → 取 text 正文
 *   - {type:'file', uri, mime, name?} → 无正文可并入字符串，保留可读引用
 *  （v1 侧只有字符串输出位，文件块走这一行引用；`content` 字符串分支是 v1 遗留兜底。） */
function toolOutput(content) {
    if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
    return content
        .map(block => {
            if (block == null) return '';
            if (typeof block === 'string') return block;
            if (typeof block.text === 'string') return block.text;
            if (block.type === 'file' && typeof block.uri === 'string') {
                return '[文件] ' + (block.name || block.uri);
            }
            if (typeof block.content === 'string') return block.content;
            return '';
        })
        .filter(Boolean)
        .join('\n');
}

/** v2 的分段时间戳 {created, ran?, completed?} → v1 的 {start, end?}。
 *  v1 渲染层读 state.time.start / state.time.end（render.js 的 buildDurationHtml、
 *  sidepanel.js 的子任务时长统计），而 v2 的字段名完全不同，直接透传会全部读空。
 *  start 取 created（工具块创建/分片开始），缺失时退回 ran（真正执行时刻）；
 *  end 取 completed；同时兼容已是 v1 形态（start/end）的输入。 */
function toSpanTime(time) {
    if (!time || typeof time !== 'object') return undefined;
    const start = time.created ?? time.ran ?? time.start;
    const end = time.completed ?? time.end;
    if (start == null && end == null) return undefined;
    const out = {};
    if (start != null) out.start = start;
    if (end != null) out.end = end;
    return out;
}

/** v2 事件 → 其落库消息的 id。服务端投影规则：消息 id = 事件 id 去掉 evt_ 前缀换成 msg_
 *  （见 core/src/session/message-updater.ts 的 SessionMessage.ID.fromEvent）。
 *  用同一规则生成，保证实时事件渲染出的消息与随后历史刷新按 id 合并、不重复。 */
function messageIDFromEvent(event) {
    const id = event && event.id;
    if (typeof id !== 'string' || !id) return null;
    const msgID = id.replace(/^evt_/, 'msg_');
    return msgID.startsWith('msg_') ? msgID : null;
}

/** v2 的结构化错误 → v1 渲染层读取的 error 字符串。
 *  空对象/空数组不含任何信息，返回空串——否则界面会出现 "执行失败: {}" 这类噪音，
 *  并挡住上层的兜底文案（如 session.step.failed 的 finish 说明）。 */
function errorText(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    const msg = error.message || error.data?.message;
    if (typeof msg === 'string' && msg) return msg;
    const json = JSON.stringify(error);
    return json === '{}' || json === '[]' ? '' : json;
}

/** part id：v1 用 part.id 做合并键，这里按 v2 的分段标识稳定生成。
 *  text / reasoning 的序号必须用「该消息内同类型的出现序号」，而不是 content 数组下标：
 *  v2 流式事件（session.text.delta 等）携带的 ordinal 就是类型内序号
 *  （publisher 对 text、reasoning 各自独立计数，见 core/src/session/runner/publish-llm-event.ts），
 *  而历史响应里 tool / reasoning 与 text 在 content 数组中混排，数组下标 ≠ 类型内序号。
 *  两条路径用同一规则，忙碌期间「事件流 part + 历史 part」合并时才不会重复显示。 */
function textPartId(messageID, ordinal) { return messageID + '_text_' + ordinal; }
function reasoningPartId(messageID, ordinal) { return messageID + '_reasoning_' + ordinal; }
function toolPartId(toolID) { return 'tool_' + toolID; }

/** v2 的一条 content 项 → v1 的 part。
 *  counters：同消息内 text / reasoning 的类型内计数（与事件流 ordinal 同规则，见上）。 */
function contentToPart(content, sessionID, messageID, counters) {
    if (!content || typeof content !== 'object') return null;
    const base = { messageID, sessionID };
    switch (content.type) {
        case 'text':
            return { ...base, id: textPartId(messageID, counters.text++), type: 'text', text: content.text || '' };
        case 'reasoning': {
            const part = {
                ...base,
                id: reasoningPartId(messageID, counters.reasoning++),
                type: 'reasoning',
                text: content.text || '',
                state: content.state,
            };
            // v2 的 {created, completed} → v1 的 {start, end}
            const time = toSpanTime(content.time);
            if (time) part.time = time;
            return part;
        }
        case 'tool': {
            // v2 的 ToolState 是 tagged union（streaming | running | completed | error），
            // v1 渲染层只认 pending | running | completed | error。streaming（参数仍在流式生成）
            // 归一为 pending，否则卡片状态会原样显示英文 "streaming"。
            const st = content.state || {};
            const state = {
                status: st.status === 'streaming' ? 'pending' : (st.status || 'pending'),
                input: st.input,
                output: toolOutput(st.content),
                error: errorText(st.error),
                metadata: st.metadata,
            };
            // v2 的时间戳在 tool 项顶层（time.created/ran/completed），
            // v1 在 state.time（start/end）——映射后工具卡片才能显示「用时」。
            const time = toSpanTime(content.time);
            if (time) state.time = time;
            return { ...base, id: toolPartId(content.id), type: 'tool', tool: content.name, state };
        }
        default:
            // v2 还有 system / shell / synthetic / skill / compaction 等内容类型，
            // v1 渲染层没有对应卡片，统一忽略而不是伪造 part。
            return null;
    }
}

/** v2 user 消息的附件（Prompt.FileAttachment）→ v1 的 file part。
 *  v2 形态：{data: base64, mime, source: {type:'uri',uri}|{type:'inline'}, name?}
 *  v1 形态：{mime, filename?, url?}——render.js 的 renderFilePart 用 filename 作标题、
 *  用 url 作图片预览 src（缺失时整块降级为文本，图片不可见）。
 *  url 优先取 source.uri（文件路径/远程地址），内联数据还原为 data URL；
 *  同时兼容 v1 直传的 filename/url 字段名，避免回归。 */
function filePartFromAttachment(f, sessionID, messageID, id) {
    const mime = typeof f.mime === 'string' ? f.mime : '';
    const filename = f.name || f.filename || '';
    let url = typeof f.url === 'string' ? f.url : '';
    if (!url && f.source && f.source.type === 'uri' && typeof f.source.uri === 'string') {
        url = f.source.uri;
    }
    if (!url && typeof f.data === 'string' && f.data) {
        url = 'data:' + (mime || 'application/octet-stream') + ';base64,' + f.data;
    }
    const part = { id, messageID, sessionID, type: 'file', mime };
    if (filename) part.filename = filename;
    if (url) part.url = url;
    return part;
}

/** 剥离服务端 synthetic 正文的包装标签：`<subagent ...>…</subagent>` 外层与 `<summary>` 包裹。
 *  服务端落库文本形如 `<subagent ...>\n<summary>\n报告（markdown）\n</subagent>`，其中
 *  `<summary>` 常未闭合——HTML 解析时会把后续所有内容吞进 summary 元素、导致正文被"压平"
 *  （标题/列表等块级结构全部丢失、连成一段）。在适配层剥离包装，正文保持原始 markdown，
 *  交给 render.js 的 renderTextPart（marked + 白名单清洗）正常渲染。
 *  只锚定首尾，不误伤正文内部的同类标签。 */
function stripSyntheticWrapper(text) {
    if (!text) return '';
    return String(text)
        .replace(/^\s*<subagent\b[^>]*>\s*/i, '')
        .replace(/<\/subagent>\s*$/i, '')
        .replace(/^\s*<summary>\s*/i, '')
        .replace(/<\/summary>\s*$/i, '');
}

/** v2 的单条消息 → v1 的 {info, parts}。 */
function adaptMessage(msg, sessionID) {
    if (!msg || !msg.id) return null;
    const info = {
        id: msg.id,
        sessionID,
        time: msg.time,
        error: errorText(msg.error) || undefined,
    };

    if (msg.type === 'user') {
        info.role = 'user';
        const parts = [];
        if (msg.text) {
            parts.push({ id: msg.id + '_text', messageID: msg.id, sessionID, type: 'text', text: msg.text });
        }
        (msg.files || []).forEach((f, i) => {
            if (!f || typeof f !== 'object') return;
            parts.push(filePartFromAttachment(f, sessionID, msg.id, msg.id + '_file_' + i));
        });
        return { info, parts };
    }

    if (msg.type === 'assistant') {
        info.role = 'assistant';
        info.agent = msg.agent;
        info.model = msg.model;
        // v2 把模型收在 model 里（Model.Ref = {id, providerID, variant}），
        // 而 v1 是顶层 providerID / modelID，variant 也在顶层。
        // render.js、sidepanel.js 按 v1 形态读取，这里拍平，否则模型徽章不显示、
        // 模型选择器也无法从历史同步。model 字段一并保留，兼容已适配 v2 的读法。
        if (msg.model) {
            if (msg.model.providerID) info.providerID = msg.model.providerID;
            if (msg.model.id) info.modelID = msg.model.id;
            if (msg.model.variant) info.variant = msg.model.variant;
        }
        info.cost = msg.cost;
        info.tokens = msg.tokens;
        info.finish = msg.finish;
        // 类型内计数（见 contentToPart 的 id 规则注释）：保证与事件流 ordinal 对齐
        const counters = { text: 0, reasoning: 0 };
        const parts = (Array.isArray(msg.content) ? msg.content : [])
            .map((c) => contentToPart(c, sessionID, msg.id, counters))
            .filter(Boolean);
        return { info, parts };
    }

    // synthetic 合成通知（子任务完成 / 回复中断自动继续 / 未来其它）：v2 的 synthetic
    // 消息统一渲染为通用折叠通知块（render.js buildSyntheticNoticeCard），不做 source 专用识别。
    // description 作为摘要行文案（info.syntheticNotice.description），
    // metadata.state 作为摘要行状态（completed / failed / interrupted，其它值原样显示）；
    // 正文只放 text（description 不再拼进正文，避免与摘要行重复）。
    // 完全无 text 也无 description 的 synthetic 仍丢弃（与旧行为一致，避免空卡片）。
    if (msg.type === 'synthetic') {
        // 剥离服务端包装（<subagent ...>/<summary>）——正文保持 markdown，交由渲染层正常渲染
        const body = stripSyntheticWrapper(msg.text);
        if (!body && !msg.description) return null;
        info.role = 'system'; // 保持 system 角色（渲染分发用；卡片外观仍是系统卡）
        // 标记字段，供渲染层统一识别并渲染为通用折叠通知块
        info.syntheticNotice = {
            description: msg.description || '', // 摘要行后缀（有值时显示「系统通知：<description>」）
            state: (msg.metadata && msg.metadata.state) || '', // 摘要行右侧状态；无 metadata/state 则不显示
        };
        return { info, parts: [{ id: msg.id + '_text', messageID: msg.id, sessionID, type: 'text', text: body }] };
    }

    // v2 除 user/assistant 外还有若干消息类型。idle 是状态边界标记，必须丢弃
    // （否则界面上出现空卡片）；agent/model/location-switched 只是 UI 状态切换，
    // 没有可渲染内容，同样丢弃。其余类型按下表还原。
    switch (msg.type) {
        case 'system': {
            // {id, time, type, text, description?} —— 服务端注入的说明性消息
            // （instructions 更新通知等普通系统消息；synthetic 已在上方分支统一处理）
            const text = [msg.description, msg.text].filter(Boolean).join('\n');
            if (!text) return null;
            info.role = 'system';
            return { info, parts: [{ id: msg.id + '_text', messageID: msg.id, sessionID, type: 'text', text }] };
        }
        case 'skill': {
            // {id, time, type, skill, name, text} —— 技能激活记录
            const title = msg.name || msg.skill || '';
            const text = [title ? '**' + title + '**' : '', msg.text || ''].filter(Boolean).join('\n');
            if (!text) return null;
            info.role = 'system';
            return { info, parts: [{ id: msg.id + '_text', messageID: msg.id, sessionID, type: 'text', text }] };
        }
        case 'shell': {
            // {id, time, type, shellID, command, status, exit?, output?}
            // 还原为通用工具卡片（renderTool 对非 question 的工具走通用渲染）
            const exited = msg.status === 'exited' || msg.status === 'timeout' || msg.status === 'killed';
            const isErr = msg.status === 'killed' || (msg.status === 'exited' && typeof msg.exit === 'number' && msg.exit !== 0);
            return {
                info,
                parts: [{
                    id: msg.id + '_shell', messageID: msg.id, sessionID, type: 'tool',
                    tool: 'shell',
                    state: {
                        status: exited ? (isErr ? 'error' : 'completed') : 'running',
                        input: { command: msg.command },
                        output: msg.output?.output || '',
                        error: isErr ? `命令以 ${msg.exit} 退出` : '',
                        time: { start: msg.time?.created, end: msg.time?.completed },
                    },
                }],
            };
        }
        case 'compaction': {
            // 上下文压缩标记：渲染为一条系统说明
            info.role = 'system';
            return { info, parts: [{ id: msg.id + '_text', messageID: msg.id, sessionID, type: 'text', text: '⟳ 上下文已压缩' }] };
        }
        default:
            // idle / agent-switched / model-switched / location-switched / provider-state 等
            return null;
    }
}

/**
 * v2 会话消息列表 → v1 的 [{info, parts}]。
 * v2 返回 {data:[...], cursor:{...}} 且按「新 → 旧」排列，
 * 而 v1 缓存与渲染都假定「旧 → 新」，故这里过滤伪消息后整体反转。
 */
export function adaptMessages(sessionID, res) {
    const list = unwrapList(res);
    const out = [];
    for (let i = list.length - 1; i >= 0; i--) {
        const adapted = adaptMessage(list[i], sessionID);
        if (adapted) out.push(adapted);
    }
    return out;
}

/** 从 v2 消息列表响应中取出「沿时间线继续翻」的游标。
 *  语义（对照 v2 服务端 SessionStore.messages 确证）：游标是服务端生成的
 *  base64url（内含 id / order / direction），客户端无法自行构造，必须沿用
 *  上一次响应签发的值。默认 desc（新→旧）顺序下：cursor.next 指向更早，
 *  用于向上加载历史；cursor.previous 指向更新（反向）。
 *  v1 的 before= 已废弃，v2 一律用 cursor= 透传服务端游标。 */
export function nextCursor(res) {
    return res && typeof res === 'object' ? (res.cursor?.next || null) : null;
}

// ============================
// 内部指令/合成消息判定（渲染层过滤用）
// ============================

/**
 * 判断一条（已还原的）消息是否属于「内部指令/合成内容」，不应作为聊天消息渲染。
 *
 * 已知来源（由 opencode v2 服务端实现确认）：
 *  - session.instructions.updated 事件带 text 时，服务端会落一条 system 消息：
 *    {type:'system', description:'Instructions updated: <变更的指令键>', text:<完整指令正文>}，
 *    正文可能包含 Code Mode 工具目录等大段内部说明（用户反馈界面里出现的就是它）。
 *  - 官方客户端对这类 system 消息只显示 description 一行，不展示完整正文。
 *
 * 判定保持保守（宁可漏过滤，也不误伤正常回答）：
 *  1) 只处理 role==='system' 的消息——adaptMessage 把 v2 的 system/synthetic 统一还原为该角色；
 *     用户自己在提问里引用同类文本（role==='user'）不受影响；
 *  2) 只命中两个强特征：文本以 'Instructions updated:' 开头（服务端固定前缀），
 *     或包含 Code Mode 工具目录标题 'The Code Mode tool catalog'。
 * 调用方只跳过渲染，数据仍保留在缓存与接口响应里，便于以后排查。
 */
export function isInternalInstructionMessage(item) {
    const info = item?.info || item || {};
    const role = info.role || info.author || '';
    if (role !== 'system') return false;
    const parts = item?.parts;
    const list = Array.isArray(parts) ? parts : (parts ? [parts] : []);
    // 与 utils.messageText 同构的轻量提取（本模块保持零依赖，便于 Node 测试直接导入）
    const text = list
        .map(p => (p && (p.text || p.content)) || '')
        .filter(Boolean)
        .join('\n')
        .trim();
    if (!text) return false;
    return text.startsWith('Instructions updated:')
        || text.includes('The Code Mode tool catalog');
}

// ============================
// SSE 事件：v2 → v1 事件
// ============================

/**
 * 把一条 v2 事件翻译成 v1 形态的事件数组。
 * 返回空数组表示该事件无需处理。
 *
 * 之所以返回数组：v2 的一条事件有时需要落成多条 v1 事件
 * （例如 user 入队既产生 message.updated 也产生 message.part.updated）。
 */
export function adaptEvent(event) {
    if (!event || !event.type) return [];
    const data = event.data || {};
    const sessionID = data.sessionID || '';

    // —— 权限与表单：v1 处理逻辑已按「type 含 permission 即弹窗」编写，
    // 且 props 解析会回落到 event.data，因此只需保留 type 即可直接透传。
    if (event.type.startsWith('permission.') || event.type.startsWith('form.')) {
        return [event];
    }

    // —— MCP 运行时事件（连接状态 / 工具列表 / 资源列表变化）：
    // v1 没有对应形态，但服务面板需要据此刷新 MCP 状态（见 chat/events.js 的防抖刷新），
    // 因此原样透传而不是落入 default 被丢弃。
    if (event.type === 'mcp.status.changed' || event.type === 'mcp.tools.changed' || event.type === 'mcp.resources.changed') {
        return [event];
    }
    if (event.type === 'session.deleted' || event.type === 'session.created') {
        return [event];
    }

    switch (event.type) {
        // 用户消息入队：补一条 role=user 的 message.updated 与其正文 part
        case 'session.inbox.enqueued': {
            if (data.item?.type !== 'user') return [];
            const msgID = data.inboxID;
            const text = data.item.payload?.text || '';
            return [
                { type: 'message.updated', info: { id: msgID, sessionID, role: 'user', time: { created: event.created } } },
                { type: 'message.part.updated', part: { id: msgID + '_text', messageID: msgID, sessionID, type: 'text', text } },
            ];
        }

        // 助手消息开始：建立 role=assistant 的消息壳
        case 'session.step.started': {
            const msgID = data.assistantMessageID;
            if (!msgID) return [];
            const info = {
                id: msgID,
                sessionID,
                role: 'assistant',
                agent: data.agent,
                model: data.model,
                time: { created: data.started || event.created, completed: undefined },
                // v2 在重试/继续时会对同一消息重发 step.started，并在服务端把上一次的
                // error / finish 等清空（message-updater 的 step.started 分支）。前端缓存
                // 的 info 是浅合并（time 为深合并），必须显式带 error / completed: undefined
                // 才能清掉残留的错误卡片与完成时间（否则旧 completed 会让新消息被误判为已完成）。
                error: undefined,
            };
            // v2 的 model 是 Model.Ref = {id, providerID, variant?}，而 render.js
            // 按 v1 顶层 providerID / modelID / variant 读取（模型徽章、下拉同步）；
            // 与 adaptMessage 的历史路径保持一致地拍平，否则实时消息缺模型徽章。
            if (data.model) {
                if (data.model.providerID) info.providerID = data.model.providerID;
                if (data.model.id) info.modelID = data.model.id;
                if (data.model.variant) info.variant = data.model.variant;
            }
            return [{ type: 'message.updated', info }];
        }

        // 思考过程：started 建 part，delta 追加，ended 落最终文本
        case 'session.reasoning.started': {
            const msgID = data.assistantMessageID;
            if (!msgID) return [];
            return [{
                type: 'message.part.updated',
                part: { id: reasoningPartId(msgID, data.ordinal), messageID: msgID, sessionID, type: 'reasoning', text: '', state: data.state },
            }];
        }
        case 'session.reasoning.delta': {
            const msgID = data.assistantMessageID;
            if (!msgID) return [];
            return [{
                type: 'message.part.delta',
                sessionID,
                messageID: msgID,
                partID: reasoningPartId(msgID, data.ordinal),
                field: 'text',
                delta: data.delta || '',
            }];
        }
        case 'session.reasoning.ended': {
            const msgID = data.assistantMessageID;
            if (!msgID) return [];
            return [{
                type: 'message.part.updated',
                part: { id: reasoningPartId(msgID, data.ordinal), messageID: msgID, sessionID, type: 'reasoning', text: data.text || '', time: { end: event.created } },
            }];
        }

        // 正文输出
        case 'session.text.started': {
            const msgID = data.assistantMessageID;
            if (!msgID) return [];
            return [{
                type: 'message.part.updated',
                part: { id: textPartId(msgID, data.ordinal), messageID: msgID, sessionID, type: 'text', text: '' },
            }];
        }
        case 'session.text.delta': {
            const msgID = data.assistantMessageID;
            if (!msgID) return [];
            return [{
                type: 'message.part.delta',
                sessionID,
                messageID: msgID,
                partID: textPartId(msgID, data.ordinal),
                field: 'text',
                delta: data.delta || '',
            }];
        }
        case 'session.text.ended': {
            const msgID = data.assistantMessageID;
            if (!msgID) return [];
            return [{
                type: 'message.part.updated',
                part: { id: textPartId(msgID, data.ordinal), messageID: msgID, sessionID, type: 'text', text: data.text || '', time: { end: event.created } },
            }];
        }

        // 工具调用
        // 注意：工具名（name）只出现在 session.tool.input.started 上，
        // 后续 input.ended / called / progress / success 都不再携带，
        // 因此必须在这里先把 part 建出来并记下名字。
        // 另外 cache.js 的 mergePart 是浅合并（{...existing, ...incoming}），
        // 若后续事件显式带上 tool: undefined 会把已记下的名字抹掉，故一律不设该键。
        case 'session.tool.input.started': {
            const msgID = data.assistantMessageID;
            if (!msgID || !data.id) return [];
            return [{
                type: 'message.part.updated',
                part: {
                    id: toolPartId(data.id), messageID: msgID, sessionID, type: 'tool',
                    tool: data.name,
                    state: { status: 'running', time: { start: event.created } },
                },
            }];
        }
        case 'session.tool.called': {
            const msgID = data.assistantMessageID;
            if (!msgID || !data.id) return [];
            const part = {
                id: toolPartId(data.id), messageID: msgID, sessionID, type: 'tool',
                state: { status: 'running', input: data.input, time: { start: event.created } },
            };
            if (data.name) part.tool = data.name;
            return [{ type: 'message.part.updated', part }];
        }
        // 工具入参的流式增量：v2 的载荷只有 {delta} 片段（schema 无 partial 字段，
        // 旧代码读的 data.partial 是 v1 假设；__rawInput 也从未被渲染层消费）。
        // 渲染所需的完整 input 由 input.ended（text 为 JSON 串）与 called（对象）提供，
        // 运行期间用户可见的是秒表提示，故这里不产生任何 UI 更新。
        case 'session.tool.input.delta':
            return [];
        case 'session.tool.input.ended': {
            const msgID = data.assistantMessageID;
            if (!msgID || !data.id) return [];
            let input = data.input;
            if (input === undefined) {
                try { input = JSON.parse(data.text || '{}'); } catch { input = data.text; }
            }
            return [{
                type: 'message.part.updated',
                part: {
                    id: toolPartId(data.id), messageID: msgID, sessionID, type: 'tool',
                    state: { status: 'running', input },
                },
            }];
        }
        case 'session.tool.progress': {
            const msgID = data.assistantMessageID;
            if (!msgID || !data.id) return [];
            return [{
                type: 'message.part.updated',
                part: {
                    id: toolPartId(data.id), messageID: msgID, sessionID, type: 'tool',
                    state: { status: 'running', metadata: data.metadata },
                },
            }];
        }
        case 'session.tool.success': {
            const msgID = data.assistantMessageID;
            if (!msgID || !data.id) return [];
            return [{
                type: 'message.part.updated',
                part: {
                    id: toolPartId(data.id), messageID: msgID, sessionID, type: 'tool',
                    state: { status: 'completed', output: toolOutput(data.content || data.output), metadata: data.metadata, time: { end: event.created } },
                },
            }];
        }
        case 'session.tool.failed': {
            const msgID = data.assistantMessageID;
            if (!msgID || !data.id) return [];
            return [{
                type: 'message.part.updated',
                part: {
                    id: toolPartId(data.id), messageID: msgID, sessionID, type: 'tool',
                    state: { status: 'error', error: errorText(data.error), output: toolOutput(data.content), metadata: data.metadata, time: { end: event.created } },
                },
            }];
        }

        // provider 响应体结束（工具可能仍在执行）：v2 的该事件载荷只有
        // {assistantMessageID}，语义是 time.streamed，**不是**消息完成——完成在
        // step.ended，且 finish/cost/tokens 都只在 ended 上。若在这里写
        // time.completed，空卡片会提前显示「已停止/未产生回复内容」等完成态文案。
        case 'session.step.streamed':
            return [];

        // 消息收尾：补齐完成时间、结束原因与用量
        case 'session.step.ended': {
            const msgID = data.assistantMessageID;
            if (!msgID) return [];
            return [{
                type: 'message.updated',
                info: {
                    id: msgID,
                    sessionID,
                    role: 'assistant',
                    finish: data.finish,
                    cost: data.cost,
                    tokens: data.tokens,
                    time: { completed: event.created },
                },
            }];
        }

        // 合成通知（子任务完成 / 回复中断自动继续等）：服务端也会把它落库为 synthetic 消息，
        // 消息 id = msg_<事件 id>（message-updater 的 SessionMessage.ID.fromEvent），
        // 这里用同一规则生成，保证随后历史刷新按 id 合并、不重复。
        // 必须与 adaptMessage 的 synthetic 分支同构：info 带 syntheticNotice（description +
        // metadata.state）、正文只放 text（不拼 description）——否则实时渲染与历史刷新后的
        // 通用折叠通知块不一致，且 mergePart 的长文本保护会让正文残留 description。
        case 'session.synthetic': {
            const msgID = messageIDFromEvent(event);
            if (!msgID) return [];
            // 与历史路径同构：剥离服务端包装标签（<subagent ...>/<summary>），正文保持 markdown
            const body = stripSyntheticWrapper(data.text);
            if (!body && !data.description) return [];
            return [
                { type: 'message.updated', info: {
                    id: msgID, sessionID, role: 'system', time: { created: event.created },
                    syntheticNotice: {
                        description: data.description || '',
                        state: (data.metadata && data.metadata.state) || '',
                    },
                } },
                { type: 'message.part.updated', part: { id: msgID + '_text', messageID: msgID, sessionID, type: 'text', text: body } },
            ];
        }

        // 技能激活记录：同样按 msg_<事件 id> 生成消息 id，形态与历史适配的 skill 分支一致
        case 'session.skill.activated': {
            const msgID = messageIDFromEvent(event);
            if (!msgID) return [];
            const title = data.name || data.id || '';
            const text = [title ? '**' + title + '**' : '', data.text || ''].filter(Boolean).join('\n');
            if (!text) return [];
            return [
                { type: 'message.updated', info: { id: msgID, sessionID, role: 'system', time: { created: event.created } } },
                { type: 'message.part.updated', part: { id: msgID + '_text', messageID: msgID, sessionID, type: 'text', text } },
            ];
        }

        // 一次执行结束：成功对应 v1 的 session.idle，失败对应 v1 的 session.error
        case 'session.execution.succeeded':
            return [{ type: 'session.idle', sessionID }];
        // 执行被中断（reason 为服务端枚举 user|shutdown|superseded|inactivity）：
        //  - user：用户主动停止（含本应用调用 interrupt），与既有语义一致，按 idle 处理；
        //  - 其它（或缺失）：属于异常终止，转成错误让用户看到（官方 TUI 同样把非 user 视为失败）。
        case 'session.execution.interrupted': {
            const reason = data.reason || '';
            if (!reason || reason === 'user') return [{ type: 'session.idle', sessionID }];
            return [{ type: 'session.error', sessionID, error: '会话执行被中断（' + reason + '）' }];
        }
        case 'session.execution.failed':
            return [{ type: 'session.error', sessionID, error: errorText(data.error) }];

        // 单个 step 失败（如模型调用报错）：服务端会把 error 记入 assistant 消息，
        // 但事件流层面先直接提示，避免消息列表尚未刷新时界面上看不到任何失败信号。
        // finish 用于兜底文案（error 缺 message 时至少说明中止原因）。
        case 'session.step.failed': {
            const msg = errorText(data.error) || (data.finish ? '模型输出被中止（' + data.finish + '）' : '');
            if (!msg) return [];
            return [{ type: 'session.error', sessionID, error: msg }];
        }

        // 会话运行状态（idle | retry | busy，retry 带 attempt/message）：
        // 透传为 v1 事件，由 events.js 归一化后驱动发送按钮与等待/重试提示。
        case 'session.status':
            return [{ type: 'session.status', sessionID, status: data.status }];

        // 重试计划（带 error 与 attempt，官方在每次重试前发出）：
        // 合成 retry 状态，让等待提示直接显示失败原因，而不是静默等到下一次重试。
        case 'session.retry.scheduled': {
            const retryMsg = errorText(data.error);
            return [{
                type: 'session.status',
                sessionID,
                status: { type: 'retry', attempt: data.attempt, message: retryMsg || undefined },
            }];
        }

        // 重命名 / 用量：v1 无对应增量事件，统一按会话更新处理
        case 'session.renamed':
            return [{ type: 'session.updated', sessionID, title: data.title }];
        case 'session.usage.updated':
            return [{ type: 'session.updated', sessionID, cost: data.cost, tokens: data.tokens }];

        // 上下文压缩：v1 侧刷新消息即可反映最新上下文
        case 'session.compaction.started':
        case 'session.compaction.ended':
        case 'session.compaction.failed':
            return [{ type: 'session.updated', sessionID, compacted: true }];

        default:
            return [];
    }
}
