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
// 路径：v1 → v2
// ============================

const enc = encodeURIComponent;

/** 会话目录作用域查询串。v1 用 ?directory=，v2 统一为 ?directory=。 */
export function dirQuery(directory) {
    return directory ? '?directory=' + enc(directory) : '';
}

/**
 * v2 中 /api/agent、/api/model、/api/command、/api/mcp、/api/config、/api/form
 * 等端点的作用域参数是 `location`，且为 **deepObject** 风格
 * （style=deepObject, explode=true），必须编码成 `location[directory]=...`。
 * 写成 `location=...` 会被服务端忽略，列表就退回服务端 CWD 而非当前会话目录。
 */
export function locationQuery(directory) {
    return directory ? '?location%5Bdirectory%5D=' + enc(directory) : '';
}

/** 把 v1 的 prompt 请求体转换为 v2 的 {text, files, agents, ...} 形态。
 *  v1 发送 {parts:[{type:'text',text},{type:'file',...}], model, variant, agent}；
 *  v2 改为顶层 text + files/agents/skills，且**不再随 prompt 提交 model/agent**——
 *  两者分别改由 POST /api/session/{id}/model 与 /agent 单独设置（见 applySessionModel）。 */
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
    }).filter(m => m.value);
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

/** v2 的工具输出是 content 块数组，v1 是 state.output 字符串。 */
function toolOutput(content) {
    if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
    return content
        .map(block => {
            if (block == null) return '';
            if (typeof block === 'string') return block;
            if (typeof block.text === 'string') return block.text;
            if (typeof block.content === 'string') return block.content;
            return '';
        })
        .filter(Boolean)
        .join('\n');
}

/** v2 的结构化错误 → v1 渲染层读取的 error 字符串。 */
function errorText(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    return error.message || error.data?.message || JSON.stringify(error);
}

/** part id：v1 用 part.id 做合并键，这里按 v2 的分段标识稳定生成。 */
function textPartId(messageID, ordinal) { return messageID + '_text_' + ordinal; }
function reasoningPartId(messageID, ordinal) { return messageID + '_reasoning_' + ordinal; }
function toolPartId(toolID) { return 'tool_' + toolID; }

/** v2 的一条 content 项 → v1 的 part。 */
function contentToPart(content, sessionID, messageID, index) {
    if (!content || typeof content !== 'object') return null;
    const base = { messageID, sessionID };
    switch (content.type) {
        case 'text':
            return { ...base, id: textPartId(messageID, index), type: 'text', text: content.text || '' };
        case 'reasoning':
            return {
                ...base,
                id: reasoningPartId(messageID, index),
                type: 'reasoning',
                text: content.text || '',
                time: content.time,
                state: content.state,
            };
        case 'tool':
            return {
                ...base,
                id: toolPartId(content.id),
                type: 'tool',
                tool: content.name,
                state: {
                    status: content.state?.status || 'pending',
                    input: content.state?.input,
                    output: toolOutput(content.state?.content),
                    error: errorText(content.state?.error),
                    metadata: content.state?.metadata,
                    time: content.time,
                },
            };
        default:
            // v2 还有 system / shell / synthetic / skill / compaction 等内容类型，
            // v1 渲染层没有对应卡片，统一忽略而不是伪造 part。
            return null;
    }
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
            parts.push({
                id: msg.id + '_file_' + i,
                messageID: msg.id,
                sessionID,
                type: 'file',
                mime: f.mime,
                filename: f.filename,
                url: f.url,
            });
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
        const parts = (Array.isArray(msg.content) ? msg.content : [])
            .map((c, i) => contentToPart(c, sessionID, msg.id, i))
            .filter(Boolean);
        return { info, parts };
    }

    // v2 除 user/assistant 外还有若干消息类型。idle 是状态边界标记，必须丢弃
    // （否则界面上出现空卡片）；agent/model/location-switched 只是 UI 状态切换，
    // 没有可渲染内容，同样丢弃。其余类型按下表还原。
    switch (msg.type) {
        case 'system':
        case 'synthetic': {
            // {id, time, type, text, description?} —— 服务端注入的说明性消息
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

/** 从 v2 消息列表响应中取出可用于翻页的游标。 */
export function nextCursor(res) {
    return res && typeof res === 'object' ? (res.cursor?.next || null) : null;
}

/** 取出「更早一页」的游标。
 *  v2 的游标是服务端生成的 base64（内含 id / order / directory），
 *  客户端无法自行构造，必须沿用上一次响应里的 cursor.previous。 */
export function prevCursor(res) {
    return res && typeof res === 'object' ? (res.cursor?.previous || null) : null;
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
            return [{
                type: 'message.updated',
                info: {
                    id: msgID,
                    sessionID,
                    role: 'assistant',
                    agent: data.agent,
                    model: data.model,
                    time: { created: data.started || event.created },
                },
            }];
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
        // 工具入参增量：v2 按 delta 追加，v1 渲染层直接读 state.input，
        // 因此这里维护一份 __rawInput 原始串，避免反复解析半截 JSON。
        case 'session.tool.input.delta': {
            const msgID = data.assistantMessageID;
            if (!msgID || !data.id) return [];
            return [{
                type: 'message.part.updated',
                part: {
                    id: toolPartId(data.id), messageID: msgID, sessionID, type: 'tool',
                    state: { status: 'running', __rawInput: (data.partial || '') + (data.delta || '') },
                },
            }];
        }
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

        // 消息收尾：补齐完成时间、结束原因与用量
        case 'session.step.streamed':
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

        // 一次执行结束：成功对应 v1 的 session.idle，失败对应 v1 的 session.error
        case 'session.execution.succeeded':
            return [{ type: 'session.idle', sessionID }];
        case 'session.execution.interrupted':
            return [{ type: 'session.idle', sessionID }];
        case 'session.execution.failed':
            return [{ type: 'session.error', sessionID, error: errorText(data.error) }];

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
