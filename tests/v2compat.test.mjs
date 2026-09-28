// v2 适配层测试：直接用 OpenCode v2 真实采集的载荷作为 fixture，无外部依赖。
//
// 运行：node tests/v2compat.test.mjs
// 说明：前端无测试框架（纯静态 ES Modules，无 package.json），
// 故这里用 Node 内置 assert 手写最小测试，避免为项目引入构建/测试依赖。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    unwrap, unwrapList, dirQuery, locationQuery, toModelOptions, toModelRef,
    toPromptBody, adaptMessages, adaptEvent, normalizeStatuses, prevCursor, nextCursor,
} from "../frontend/dist/core/v2compat.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", n), "utf8"));

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ============ 信封拆解 ============

test("unwrap 拆 {data:...}，裸值原样返回", () => {
    assert.deepEqual(unwrap({ data: [1, 2] }), [1, 2]);
    assert.deepEqual(unwrap([1, 2]), [1, 2]);
    assert.equal(unwrap("x"), "x");
    assert.equal(unwrap(null), null);
});

test("unwrapList 恒返回数组", () => {
    assert.equal(unwrapList({ data: [1] }).length, 1);
    assert.equal(unwrapList([1, 2]).length, 2);
    assert.deepEqual(unwrapList(undefined), []);
    assert.deepEqual(unwrapList(null), []);
    assert.deepEqual(unwrapList({ data: null }), []);
});

// ============ 查询串 ============

test("dirQuery 生成 v1/v2 通用会话作用域", () => {
    assert.equal(dirQuery(""), "");
    assert.equal(dirQuery("C:\\a b"), "?directory=C%3A%5Ca%20b");
});

test("locationQuery 用 deepObject 编码（写成 location= 会被服务端忽略）", () => {
    assert.equal(locationQuery(""), "");
    const q = locationQuery("C:\\work");
    assert.ok(q.startsWith("?location%5Bdirectory%5D="), "实际: " + q);
    assert.ok(!q.includes("?location="), "不得写成 location=");
});

// ============ 模型选项 ============

test("toModelOptions 生成 value=provider/model 与 label", () => {
    const list = toModelOptions({
        data: [
            { providerID: "openai", modelID: "gpt-x", name: "GPT X", variants: [{ id: "high" }], enabled: true },
            { providerID: "p", modelID: "m", name: "", variants: [] },
        ],
    });
    assert.equal(list.length, 2);
    assert.equal(list[0].value, "openai/gpt-x");
    assert.equal(list[0].label, "GPT X");
    assert.deepEqual(list[0].variants, ["high"]);
    assert.deepEqual(list[1].variants, []);
    assert.equal(list[1].label, "m", "name 缺失时回退 modelID");
});

test("toModelOptions 容忍裸数组，并剔除无法表达为 provider/model 的条目", () => {
    assert.equal(toModelOptions([{ providerID: "a", modelID: "b" }]).length, 1);
    assert.deepEqual(toModelOptions(undefined), []);
    // 缺 providerID 的条目 value 会是空串，下拉框提交时按 '/' 切分必然失败，应剔除而非展示
    assert.deepEqual(toModelOptions({ data: [{ modelID: "solo" }] }), []);
    assert.deepEqual(toModelOptions({ data: [{ providerID: "p" }] }), []);
    // 正常条目不受影响
    assert.equal(toModelOptions({ data: [{ providerID: "p", modelID: "m" }] }).length, 1);
});

test("toModelRef 拆分 provider/model 并挂 variant", () => {
    assert.deepEqual(toModelRef("openai/gpt-x", "high"), { providerID: "openai", id: "gpt-x", variant: "high" });
    assert.deepEqual(toModelRef("openai/gpt-x", null), { providerID: "openai", id: "gpt-x" });
    assert.equal(toModelRef("no-slash", null), null);
    assert.equal(toModelRef("", null), null);
    assert.equal(toModelRef(null, null), null);
    // 斜杠开头（无 provider）应拒绝
    assert.equal(toModelRef("/gpt", null), null);
});

// ============ prompt 请求体 ============

test("toPromptBody 合并多个 text part", () => {
    const b = toPromptBody({ parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
    assert.equal(b.text, "a\nb");
});

test("toPromptBody 无 parts 时 text 为空串而非 undefined", () => {
    assert.equal(toPromptBody({}).text, "");
    assert.equal(toPromptBody(null).text, "");
});

test("toPromptBody files 用 {uri,name}（非内容块字符串）", () => {
    const b = toPromptBody({
        parts: [
            { type: "text", text: "x" },
            { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAA" },
        ],
    });
    assert.equal(b.files.length, 1);
    assert.deepEqual(b.files[0], { uri: "data:image/png;base64,AAA", name: "a.png" });
});

test("toPromptBody agents 用 [{name}] 对象数组", () => {
    const b = toPromptBody({ parts: [{ type: "text", text: "x" }], agent: "build" });
    assert.deepEqual(b.agents, [{ name: "build" }]);
    assert.equal(toPromptBody({ parts: [] }).agents, undefined);
});

test("toPromptBody 透传 messageID 为顶层 id（否则乐观消息重复显示）", () => {
    const b = toPromptBody({ parts: [{ type: "text", text: "x" }], messageID: "msg_abc" });
    assert.equal(b.id, "msg_abc");
    assert.equal(b.messageID, undefined, "不得残留 v1 字段名");
    assert.equal(toPromptBody({ parts: [] }).id, undefined);
});

test("toPromptBody 忽略无 url 的附件", () => {
    const b = toPromptBody({ parts: [{ type: "file", filename: "no-url.png" }] });
    assert.equal(b.files, undefined);
});

// ============ 会话状态归一化 ============

test("normalizeStatuses 把 {type:'running'} 归一为 'busy'", () => {
    assert.deepEqual(normalizeStatuses({ data: { ses_1: { type: "running" } } }), { ses_1: "busy" });
    assert.deepEqual(normalizeStatuses({ data: { ses_1: { type: "busy" } } }), { ses_1: "busy" });
    assert.deepEqual(normalizeStatuses({ data: { ses_1: { type: "idle" } } }), { ses_1: "idle" });
});

test("normalizeStatuses 保留 retry 对象（isSessionBusy 依赖 status.type）", () => {
    const r = normalizeStatuses({ data: { ses_1: { type: "retry", attempt: 2, message: "x" } } });
    assert.equal(r.ses_1.type, "retry");
    assert.equal(r.ses_1.attempt, 2);
});

test("normalizeStatuses 兼容已是 v1 形态的字符串值", () => {
    assert.deepEqual(normalizeStatuses({ data: { ses_1: "busy" } }), { ses_1: "busy" });
    assert.deepEqual(normalizeStatuses({ ses_1: "idle" }), { ses_1: "idle" });
});

test("normalizeStatuses 空输入返回空对象（空闲时 v2 返回 {}）", () => {
    assert.deepEqual(normalizeStatuses({ data: {} }), {});
    assert.deepEqual(normalizeStatuses(null), {});
    assert.deepEqual(normalizeStatuses(undefined), {});
});

// ============ 消息还原 ============

test("adaptMessages 过滤 idle 伪消息并按旧→新排列", () => {
    const raw = fx("messages-basic.json");
    const out = adaptMessages("ses_x", raw);
    assert.equal(out.length, 2, "应只剩 user + assistant");
    assert.equal(out[0].info.role, "user");
    assert.equal(out[1].info.role, "assistant");
    assert.equal(out[0].info.id, raw.data[raw.data.length - 1].id, "首条应为最旧的消息");
});

test("adaptMessages 给每条消息与 part 补齐 sessionID / messageID", () => {
    const out = adaptMessages("ses_x", fx("messages-basic.json"));
    for (const m of out) {
        assert.equal(m.info.sessionID, "ses_x");
        for (const p of m.parts) {
            assert.ok(p.id, "part 缺 id");
            assert.equal(p.messageID, m.info.id, "part.messageID 应等于消息 id");
            assert.equal(p.sessionID, "ses_x");
        }
    }
});

test("adaptMessages 把 v2 的 model 拍平成 v1 的 providerID/modelID/variant", () => {
    const out = adaptMessages("ses_x", fx("messages-basic.json"));
    const a = out.find(m => m.info.role === "assistant");
    // render.js:179-180 / 296-297 按 v1 形态读这三个字段
    assert.equal(a.info.modelID, "longcat-2.5-preview-free");
    assert.equal(a.info.providerID, "opencode-go");
    assert.ok(a.info.model && a.info.model.id, "同时保留 v2 的 model");
    // 复刻 render.js 的拼装逻辑
    const mm = a.info.providerID ? a.info.providerID + "/" + a.info.modelID : a.info.modelID;
    assert.equal(mm, "opencode-go/longcat-2.5-preview-free");
});

test("adaptMessages 还原 reasoning / text part", () => {
    const a = adaptMessages("ses_x", fx("messages-basic.json")).find(m => m.info.role === "assistant");
    assert.ok(a.parts.some(p => p.type === "reasoning" && p.text.length > 0));
    assert.ok(a.parts.some(p => p.type === "text" && p.text === "OK-42"));
});

test("adaptMessages 还原 tool part（名称/输入/输出/终态）", () => {
    const a = adaptMessages("ses_x", fx("messages-tool.json")).find(m => m.info.role === "assistant");
    const t = a.parts.find(p => p.type === "tool");
    assert.ok(t, "应含 tool part");
    assert.equal(t.tool, "shell");
    assert.equal(t.state.status, "completed");
    assert.equal(t.state.input.command, "echo hello-tool-42");
    assert.ok(t.state.output.includes("hello-tool-42"));
    assert.ok(t.id.startsWith("tool_"), "tool part id 应稳定可合并");
});

test("adaptMessages 丢弃 agent/model/location-switched（无内容，仅 UI 状态）", () => {
    for (const type of ["idle", "agent-switched", "model-switched", "location-switched"]) {
        const out = adaptMessages("ses_x", { data: [{ id: "m1", type, time: { created: 1 } }] });
        assert.equal(out.length, 0, type + " 应被丢弃");
    }
});

test("adaptMessages 还原 system / synthetic 为系统说明消息", () => {
    for (const type of ["system", "synthetic"]) {
        const out = adaptMessages("ses_x", { data: [{ id: "m1", type, time: { created: 1 }, text: "提示内容" }] });
        assert.equal(out.length, 1, type + " 应被还原");
        assert.equal(out[0].info.role, "system");
        assert.equal(out[0].parts[0].text, "提示内容");
    }
});

test("adaptMessages 还原 shell 消息为工具卡片", () => {
    const out = adaptMessages("ses_x", {
        data: [{
            id: "sh1", type: "shell", time: { created: 1, completed: 2 },
            shellID: "sh_x", command: "ls -la", status: "exited", exit: 0,
            output: { output: "file1\n", cursor: 6, size: 6, truncated: false },
        }],
    });
    assert.equal(out.length, 1);
    const p = out[0].parts[0];
    assert.equal(p.type, "tool");
    assert.equal(p.tool, "shell");
    assert.equal(p.state.status, "completed", "exit 0 应视为成功");
    assert.equal(p.state.input.command, "ls -la");
    assert.equal(p.state.output, "file1\n");
});

test("adaptMessages shell 非零退出视为 error", () => {
    const out = adaptMessages("ses_x", {
        data: [{ id: "sh1", type: "shell", time: { created: 1 }, command: "false", status: "exited", exit: 1 }],
    });
    assert.equal(out[0].parts[0].state.status, "error");
    assert.ok(out[0].parts[0].state.error.includes("1"));
});

test("adaptMessages 还原 skill 消息", () => {
    const out = adaptMessages("ses_x", {
        data: [{ id: "sk1", type: "skill", time: { created: 1 }, skill: "dataviz", name: "数据可视化", text: "已加载" }],
    });
    assert.equal(out.length, 1);
    assert.ok(out[0].parts[0].text.includes("数据可视化"));
    assert.ok(out[0].parts[0].text.includes("已加载"));
});

test("adaptMessages 还原 compaction 为压缩标记", () => {
    const out = adaptMessages("ses_x", { data: [{ id: "c1", type: "compaction", time: { created: 1 } }] });
    assert.equal(out.length, 1);
    assert.ok(out[0].parts[0].text.includes("压缩"));
});

test("adaptMessages 空/异常输入不抛错", () => {
    assert.deepEqual(adaptMessages("s", undefined), []);
    assert.deepEqual(adaptMessages("s", { data: [] }), []);
    assert.deepEqual(adaptMessages("s", []), []);
});

test("adaptMessages 忽略没有 id 的消息", () => {
    assert.deepEqual(adaptMessages("s", { data: [{ type: "user", text: "x" }] }), []);
});

// ============ 事件翻译 ============

// 模拟 cache.js 的合并语义，把事件流还原成缓存。
// 返回时统一把 parts 从 Map 转成数组，与 adaptMessages 的产物同形，便于直接比较。
function replay(events, sessionID) {
    const cache = new Map();
    const order = [];
    const msg = (id) => {
        if (!cache.has(id)) {
            cache.set(id, { info: { id, sessionID, role: "assistant" }, parts: new Map() });
            order.push(id);
        }
        return cache.get(id);
    };
    for (const ev of events) {
        for (const e of adaptEvent(ev)) {
            if (e.type === "message.updated" && e.info) {
                Object.assign(msg(e.info.id).info, e.info);
            } else if (e.type === "message.part.updated" && e.part) {
                const m = msg(e.part.messageID);
                const prev = m.parts.get(e.part.id);
                m.parts.set(e.part.id, prev
                    ? { ...prev, ...e.part, state: { ...(prev.state || {}), ...(e.part.state || {}) } }
                    : e.part);
            } else if (e.type === "message.part.delta") {
                const m = msg(e.messageID);
                let p = m.parts.get(e.partID);
                if (!p) {
                    p = { id: e.partID, messageID: e.messageID, sessionID, type: e.field === "text" ? "text" : "reasoning", [e.field]: "" };
                    m.parts.set(e.partID, p);
                }
                p[e.field] = (p[e.field] || "") + e.delta;
            }
        }
    }
    return order.map(id => {
        const m = cache.get(id);
        return { info: m.info, parts: [...m.parts.values()] };
    });
}

test("事件翻译不泄漏 v2 事件词汇（交给 v1 分发器）", () => {
    const events = fx("events-tool.json");
    const out = events.flatMap(e => adaptEvent(e)).map(e => e.type);
    for (const t of out) {
        assert.ok(!/^session\.(text|reasoning|tool|step|compaction|inbox|execution)/.test(t),
            "泄漏了 v2 事件类型: " + t);
    }
    assert.ok(out.includes("message.part.delta"));
    assert.ok(out.includes("message.part.updated"));
    assert.ok(out.includes("message.updated"));
});

test("user 入队产生 role=user 的消息与正文 part", () => {
    const events = fx("events-basic.json");
    const out = events.flatMap(e => adaptEvent(e));
    const upd = out.find(e => e.type === "message.updated" && e.info?.role === "user");
    assert.ok(upd, "应产生 user 消息");
    const part = out.find(e => e.type === "message.part.updated" && e.part?.messageID === upd.info.id);
    assert.ok(part && part.part.text.length > 0, "应同时产生正文 part");
});

test("工具名只在 input.started 出现，后续事件不得抹掉（mergePart 是浅合并）", () => {
    const out = replay(fx("events-tool.json"), "ses_x");
    const t = out.flatMap(m => [...m.parts.values()]).find(p => p.type === "tool");
    assert.ok(t, "应有 tool part");
    assert.equal(t.tool, "shell", "tool.called 不带 name，若浅合并写入 undefined 会丢名字");
});

// 对比两条路径还原出的消息：角色、条数、各 part 的类型与文本
function shape(ms) {
    return ms.map(m => ({
        role: m.info.role,
        id: m.info.id,
        parts: m.parts.map(p => ({
            type: p.type,
            tool: p.tool,
            text: (p.text || '').trim(),
            status: p.state?.status,
        })),
    }));
}

test("流式重放结果与静息态读取一致（纯文本会话）", () => {
    assert.deepEqual(shape(replay(fx("events-basic.json"), "ses_x")),
                     shape(adaptMessages("ses_x", fx("messages-basic.json"))));
});

test("流式重放结果与静息态读取一致（含工具调用的会话）", () => {
    assert.deepEqual(shape(replay(fx("events-tool.json"), "ses_x")),
                     shape(adaptMessages("ses_x", fx("messages-tool.json"))));
});

test("流式重放与静息态都还原出非空正文（防「两边同时为空」式假一致）", () => {
    for (const [ef, mf] of [["events-basic.json", "messages-basic.json"], ["events-tool.json", "messages-tool.json"]]) {
        const streamed = replay(fx(ef), "ses_x").flatMap(m => m.parts).filter(p => p.type === "text").map(p => p.text).join("");
        const rest = adaptMessages("ses_x", fx(mf)).flatMap(m => m.parts).filter(p => p.type === "text").map(p => p.text).join("");
        assert.ok(streamed.trim().length > 0, ef + " 事件流正文为空");
        assert.ok(rest.trim().length > 0, mf + " 静息态正文为空");
    }
});

test("流式重放结果与静息态读取一致（消息条数与角色）", () => {
    const streamed = replay(fx("events-basic.json"), "ses_x");
    const rest = adaptMessages("ses_x", fx("messages-basic.json"));
    assert.equal(streamed.length, rest.length);
    assert.deepEqual(streamed.map(m => m.info.role).sort(), rest.map(m => m.info.role).sort());
});

test("执行结束映射为 session.idle", () => {
    const events = fx("events-basic.json");
    const out = events.flatMap(e => adaptEvent(e));
    assert.ok(out.some(e => e.type === "session.idle"));
});

test("执行失败映射为 session.error 且带错误文本", () => {
    const out = adaptEvent({
        type: "session.execution.failed",
        data: { sessionID: "ses_x", error: { message: "boom" } },
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].type, "session.error");
    assert.equal(out[0].error, "boom");
});

test("重命名映射为 session.updated", () => {
    const out = adaptEvent({ type: "session.renamed", data: { sessionID: "ses_x", title: "新标题" } });
    assert.equal(out[0].type, "session.updated");
    assert.equal(out[0].title, "新标题");
});

test("权限与表单事件原样透传（props 解析会回落到 event.data）", () => {
    for (const type of ["permission.asked", "permission.replied", "form.created", "form.replied"]) {
        const out = adaptEvent({ type, data: { sessionID: "ses_x", id: "per_1" } });
        assert.equal(out.length, 1, type);
        assert.equal(out[0].type, type);
        assert.equal(out[0].data.id, "per_1", "data 需保留，供 showPermissionRequest 读取");
    }
});

test("未知事件被忽略（不产生垃圾事件）", () => {
    assert.deepEqual(adaptEvent({ type: "provider.updated", data: {} }), []);
    assert.deepEqual(adaptEvent({}), []);
    assert.deepEqual(adaptEvent(null), []);
});

test("缺关键字段的事件被安全丢弃（不抛错）", () => {
    assert.deepEqual(adaptEvent({ type: "session.text.delta", data: {} }), []);
    assert.deepEqual(adaptEvent({ type: "session.tool.called", data: { assistantMessageID: "m" } }), []);
});

// ============ 游标 ============

test("prevCursor / nextCursor 读取服务端游标", () => {
    const raw = fx("messages-basic.json");
    assert.equal(typeof prevCursor(raw), "string");
    assert.equal(typeof nextCursor(raw), "string");
    assert.notEqual(prevCursor(raw), nextCursor(raw));
    assert.equal(prevCursor({}), null);
    assert.equal(nextCursor(null), null);
});

// ============ 其余端点信封 ============

test("项目列表是裸数组（v2 的 /api/project 不包 data）", () => {
    const p = fx("project.json");
    assert.ok(Array.isArray(p));
    assert.ok(unwrapList(p).length > 0);
    assert.ok(p.every(x => x.canonical !== undefined && x.worktree === undefined));
});

test("agent / command / mcp 是 {location,data} 信封", () => {
    for (const f of ["agent.json", "command.json", "mcp.json"]) {
        const j = fx(f);
        assert.ok(Array.isArray(j.data), f + " 应含 data 数组");
        assert.ok(j.location !== undefined, f + " 应含 location");
        assert.equal(unwrapList(j).length, j.data.length);
    }
});

// ============ 运行 ============

let failed = 0;
for (const [name, fn] of tests) {
    try {
        fn();
        passed++;
        console.log("  ok   " + name);
    } catch (e) {
        failed++;
        console.log("  FAIL " + name + "\n         " + (e && e.message ? e.message.split("\n")[0] : e));
    }
}
console.log("");
console.log(`${passed}/${tests.length} 通过` + (failed ? `，${failed} 失败` : ""));
process.exit(failed ? 1 : 0);
