// 凭据面板纯逻辑测试
//
// 覆盖的都是「判错了不报错、只给出错误信息」的场景：
//   - v2 的 location 参数被忽略时不报错，凭据列表会静默变空
//   - connections 为 null 时直接遍历会抛异常并中断整个面板渲染
//   - connections[0] 才是当前生效；把 env 型连接做成可点是错的（V2 无切换端点）

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
    connectionRows,
    credentialConnections,
    credentialsHeaderText,
    describeConnection,
    summarizeIntegrations,
} from "../frontend/dist/views/credential-model.js";

// ===== describeConnection =====

test("凭据型连接展示 label", () => {
    assert.equal(describeConnection({ type: "credential", id: "cred_1", label: "主账号" }), "主账号");
});

test("凭据型连接缺 label 时回退到 id", () => {
    assert.equal(describeConnection({ type: "credential", id: "cred_1" }), "cred_1");
});

test("env 型连接展示变量名并标明来源", () => {
    assert.equal(describeConnection({ type: "env", name: "OPENAI_API_KEY" }), "环境变量 OPENAI_API_KEY");
});

test("未知类型回落到 type 本身", () => {
    assert.equal(describeConnection({ type: "oauth" }), "oauth");
});

test("null / 非对象不抛异常", () => {
    assert.equal(describeConnection(null), "");
    assert.equal(describeConnection(undefined), "");
    assert.equal(describeConnection("x"), "");
});

// ===== credentialConnections =====

test("只挑出有 id 的凭据型连接", () => {
    const conns = [
        { type: "credential", id: "cred_1" },
        { type: "env", name: "K" },
        { type: "credential" }, // 缺 id，无法构造 activate 路径
    ];
    assert.deepEqual(credentialConnections(conns).map((c) => c.id), ["cred_1"]);
});

test("非数组返回空数组而非抛异常", () => {
    assert.deepEqual(credentialConnections(null), []);
    assert.deepEqual(credentialConnections(undefined), []);
});

// ===== summarizeIntegrations =====

test("正常返回被保留", () => {
    const s = summarizeIntegrations({
        integrations: [{ id: "openai", name: "OpenAI", connections: [{ type: "env", name: "K" }] }],
        total: 6,
        shown: 1,
        filtered: true,
    });
    assert.equal(s.error, "");
    assert.equal(s.total, 6);
    assert.equal(s.shown, 1);
    assert.equal(s.integrations[0].id, "openai");
});

test("connections 为 null 时补空数组（否则渲染时遍历会抛）", () => {
    const s = summarizeIntegrations({
        integrations: [{ id: "x", name: "X", connections: null }],
        total: 1,
    });
    assert.deepEqual(s.integrations[0].connections, []);
});

test("后端返回 error 时如实带出，不当成功处理", () => {
    const s = summarizeIntegrations({ error: "opencode 服务未启动" });
    assert.equal(s.error, "opencode 服务未启动");
    assert.equal(s.shown, 0);
});

test("非对象输入给出错误而不是空成功", () => {
    assert.ok(summarizeIntegrations(null).error);
    assert.ok(summarizeIntegrations("x").error);
});

test("缺 total 时按列表长度兜底", () => {
    const s = summarizeIntegrations({ integrations: [{ id: "a", connections: [] }, { id: "b", connections: [] }] });
    assert.equal(s.total, 2);
});

test("集成缺 name 时回退到 id", () => {
    const s = summarizeIntegrations({ integrations: [{ id: "abc", connections: [] }] });
    assert.equal(s.integrations[0].name, "abc");
});

// ===== credentialsHeaderText =====

test("有内容且被过滤时说明是部分视图", () => {
    const s = summarizeIntegrations({
        integrations: [{ id: "a", connections: [] }],
        total: 231,
        shown: 1,
        filtered: true,
    });
    const text = credentialsHeaderText(s);
    assert.ok(text.includes("仅显示已配置凭据"));
    assert.ok(text.includes("1 / 231"));
});

test("有内容且未过滤时不加说明（不制造噪音）", () => {
    const s = summarizeIntegrations({ integrations: [{ id: "a", connections: [] }], total: 1, filtered: false });
    assert.equal(credentialsHeaderText(s), "");
});

test("有集成但都没配凭据：说明数量，与「没有集成」区分开", () => {
    const s = summarizeIntegrations({ integrations: [], total: 231, shown: 0, filtered: true });
    const text = credentialsHeaderText(s);
    assert.ok(text.includes("231"));
    assert.ok(text.includes("均未配置"));
});

test("完全没有集成", () => {
    const s = summarizeIntegrations({ integrations: [], total: 0, shown: 0, filtered: true });
    assert.equal(credentialsHeaderText(s), "没有已配置的凭据");
});

test("出错时不输出说明文案（错误另有渲染路径）", () => {
    assert.equal(credentialsHeaderText({ error: "x" }), "");
});

// ===== connectionRows =====

test("connections[0] 标记为当前且不提供切换", () => {
    const rows = connectionRows({
        connections: [
            { type: "credential", id: "cred_a", label: "A" },
            { type: "credential", id: "cred_b", label: "B" },
        ],
    });
    assert.equal(rows[0].isCurrent, true);
    assert.equal(rows[0].canSwitch, false);
    assert.equal(rows[1].canSwitch, true);
    assert.equal(rows[1].credentialId, "cred_b");
});

test("env 型连接永不可切换（V2 没有 env 切换端点）", () => {
    const rows = connectionRows({
        connections: [
            { type: "env", name: "K1" },
            { type: "env", name: "K2" },
        ],
    });
    assert.equal(rows[1].canSwitch, false);
    assert.equal(rows[1].credentialId, "");
});

test("只有一个连接时它就是当前，且没有可切换项", () => {
    const rows = connectionRows({ connections: [{ type: "credential", id: "cred_a" }] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].isCurrent, true);
    assert.equal(rows.some((r) => r.canSwitch), false);
});

test("connections 缺失时不抛异常", () => {
    assert.deepEqual(connectionRows({}), []);
    assert.deepEqual(connectionRows(null), []);
});

test("行 key 稳定可复现（用于 DOM 复用与测试定位）", () => {
    const rows = connectionRows({
        connections: [
            { type: "credential", id: "cred_a" },
            { type: "env", name: "K" },
        ],
    });
    assert.equal(rows[0].key, "cred_a");
    assert.equal(rows[1].key, "K");
});

// ===== 静态门禁：凭据面板确实接到了 App 方法 =====
//
// 这一条比单测更重要：V2 的 SPA 兜底会对未注册路径返回 200 + text/html，
// 写成 OpenCodeCall('GET','/api/wrong') 不会报错，只会静默拿到首页 HTML。

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "frontend", "dist");
const credSrc = fs.readFileSync(path.join(DIST, "views", "credentials.js"), "utf-8");
const treeSrc = fs.readFileSync(path.join(DIST, "chat", "tree.js"), "utf-8");

test("凭据面板通过 App 方法调用（而非裸 HTTP 路径）", () => {
    assert.ok(credSrc.includes("api.ListIntegrations("), "应调用 ListIntegrations");
    assert.ok(credSrc.includes("api.ActivateCredential("), "应调用 ActivateCredential");
});

test("凭据面板不含 v1 风格裸路径调用", () => {
    // /api/credential 的 activate 走 App 方法，避免前端自己拼路径出错
    assert.ok(
        !/OpenCodeCall\(\s*['"](?:GET|POST|PATCH)['"]\s*,\s*['"]\/api\/(?:integration|credential|worktree|pty|vcs)/.test(credSrc),
        "凭据面板不应自行拼 /api/integration 等路径",
    );
});

test("会话导出/移动走 App 方法", () => {
    assert.ok(treeSrc.includes("api.ExportSession("), "应调用 ExportSession");
    assert.ok(treeSrc.includes("api.MoveSession("), "应调用 MoveSession");
});

test("导出先判 error 再解析（错误 JSON 不能被当导出内容写入文件）", () => {
    const idx = treeSrc.indexOf("api.ExportSession(");
    assert.ok(idx > 0, "应存在 ExportSession 调用");
    const after = treeSrc.slice(idx, idx + 1200);
    assert.ok(after.includes("parsed.error"), "必须先判服务端返回的 error 字段");
});

test("导出会清洗文件名中的路径分隔符", () => {
    const idx = treeSrc.indexOf("api.ExportSession(");
    const after = treeSrc.slice(idx, idx + 1600);
    assert.ok(after.includes("replace(/["), "应清洗非法文件名字符");
});

// ===== 静态门禁：菜单项不能是死的 =====
//
// 加了菜单项却没接 handler，是最容易漏且最难发现的缺陷：用户点了没反应，
// 而代码里看不出任何异常。这里把「菜单里出现的每个 data-action」
// 与「代码里实际处理的 action」做双向比对。

const html = fs.readFileSync(path.join(DIST, "index.html"), "utf-8");

test("右键菜单的每个 data-action 都有对应处理分支", () => {
    const menuMatch = html.match(/id="ocTreeContextMenu"[\s\S]*?<\/div>\s*<\/div>/);
    assert.ok(menuMatch, "应能找到右键菜单容器");
    const actions = [...menuMatch[0].matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(actions.length > 0, "菜单应至少有一个动作项");

    const unhandled = actions.filter(
        (a) => !treeSrc.includes(`action === '${a}'`),
    );
    assert.deepEqual(
        unhandled,
        [],
        `这些菜单项点了没反应（缺少 action === 'x' 分支）: ${unhandled.join(", ")}`,
    );
});

test("导入是全局动作，对 project 类型也可见", () => {
    const idx = treeSrc.indexOf("type === 'project'");
    const after = treeSrc.slice(idx, idx + 200);
    assert.ok(after.includes("import"), "project 右键也应显示导入项");
});

test("导入走 App 方法而非裸路径", () => {
    assert.ok(treeSrc.includes("api.ImportSession("), "应调用 ImportSession");
});

test("已读标记用 idle 原值，缺 idle 时不发请求", () => {
    const sess = fs.readFileSync(path.join(DIST, "chat", "session.js"), "utf-8");
    assert.ok(sess.includes("api.MarkSessionViewed("), "应调用 MarkSessionViewed");
    const idx = sess.indexOf("async function markSessionViewed");
    assert.ok(idx > 0, "应定义 markSessionViewed");
    const body = sess.slice(idx, idx + 400);
    assert.ok(body.includes("!idle"), "缺 idle 时应直接返回，不发注定失败的请求");
});
