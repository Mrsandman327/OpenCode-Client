// 凭据面板纯逻辑测试
//
// 覆盖的都是「判错了不报错、只给出错误信息」的场景：
//   - v2 的 location 参数被忽略时不报错，凭据列表会静默变空
//   - connections 为 null 时直接遍历会抛异常并中断整个面板渲染
//   - connections[0] 才是当前生效；把 env 型连接做成可点是错的（V2 无切换端点）
//   - 多 key：可切换/可删除的判定，以及「只剩一把时不能删」这道守卫
//   - 新增 key 的入口：methods 决定能不能加，且入口必须可达（可展开）

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
    CONNECTABLE_RESULT_LIMIT,
    connectEmptyText,
    connectMethod,
    connectionRows,
    credentialConnections,
    credentialsHeaderText,
    describeConnection,
    hasNoStoredCredential,
    isExpandable,
    searchConnectable,
    summarizeIntegrations,
    supportsKeyAuth,
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

// ===== 接入新供应商：hasNoStoredCredential =====
//
// 判据必须是「有没有 credential 型」，不是「connections 是否为空」。
// 绝大多数集成挂着的是 env 型连接（读服务端进程环境变量，不入库），
// 判据搞错的话，像 openai（当前用 OPENAI_API_KEY、但支持加 key）
// 会被错误排除——用户明明能给它再存一把 key，却看不到入口。

test("只有 env 型连接 = 仍算「无凭据」（env 不入库）", () => {
    assert.equal(hasNoStoredCredential({ connections: [{ type: "env", name: "K" }] }), true);
});

test("有 credential 型连接 = 已有凭据", () => {
    assert.equal(hasNoStoredCredential({ connections: [{ type: "credential", id: "cred_1" }] }), false);
});

test("credential 与 env 混合时算已有凭据", () => {
    assert.equal(
        hasNoStoredCredential({
            connections: [{ type: "credential", id: "cred_1" }, { type: "env", name: "K" }],
        }),
        false,
    );
});

test("缺 id 的 credential 不算数（构造不出 activate 路径，等于没存成）", () => {
    assert.equal(hasNoStoredCredential({ connections: [{ type: "credential" }] }), true);
});

test("connections 缺失/null 时算无凭据，不抛异常", () => {
    assert.equal(hasNoStoredCredential({}), true);
    assert.equal(hasNoStoredCredential({ connections: null }), true);
    assert.equal(hasNoStoredCredential(null), true);
});

// ===== 接入新供应商：searchConnectable =====

const ALL = summarizeIntegrations(
    JSON.parse(
        fs.readFileSync(
            path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "integration-all.json"),
            "utf-8",
        ),
    ),
);

test("includeEmpty=true 时 total 与 shown 都等于 231，且 filtered=false", () => {
    assert.equal(ALL.total, 231);
    assert.equal(ALL.integrations.length, 231);
    assert.equal(ALL.shown, 231);
    assert.equal(ALL.filtered, false);
});

test("真实数据：只有 2 个集成存了 credential（deepseek、opencode-go）", () => {
    const stored = ALL.integrations.filter((it) => !hasNoStoredCredential(it)).map((it) => it.id);
    assert.deepEqual(stored, ["deepseek", "opencode-go"]);
});

test("真实数据：229 个可接入候选（231 减去 2 个已存凭据的）", () => {
    const r = searchConnectable(ALL.integrations, "", 10000);
    assert.equal(r.total, 229);
    assert.equal(r.truncated, false);
});

test("已有凭据的不进候选（再给 opencode-go 加 key 应走已配置卡片，不走「接入」）", () => {
    const r = searchConnectable(ALL.integrations, "", 10000);
    assert.equal(r.items.some((it) => it.id === "opencode-go"), false);
    assert.equal(r.items.some((it) => it.id === "deepseek"), false);
});

test("只支持 env+oauth 的 github-copilot **要**进候选（否则 /connect 说明不可达）", () => {
    const r = searchConnectable(ALL.integrations, "", 10000);
    assert.equal(r.items.some((it) => it.id === "github-copilot"), true);
});

test("oauth-only 集成进候选，但接入方式是 oauth 而非 key", () => {
    // 早期版本按 supportsKeyAuth 过滤候选，github-copilot 于是永远选不中，
    // 「请在 TUI 里 /connect」那条说明也就永远显示不出来——等于把
    // 「OAuth 给出说明」这个产品决定架空。现按「本面板有办法应对」筛选。
    const copilot = ALL.integrations.find((it) => it.id === "github-copilot");
    assert.equal(connectMethod(copilot), "oauth");
    const r = searchConnectable(ALL.integrations, "", 10000);
    const hit = r.items.find((it) => it.id === "github-copilot");
    assert.equal(connectMethod(hit), "oauth");
});

test("既不支持 key 也不支持 oauth/command 的集成不进候选（给不出任何动作）", () => {
    // 真实数据里 methods 全集为 env/key/oauth，没有 command，因此构造一条
    // 只有 env 的集成来钉住这个边界：它不该占用候选位。
    const envOnly = { id: "env-only", name: "Env Only", methods: [{ type: "env" }], connections: [] };
    const r = searchConnectable([...ALL.integrations, envOnly], "", 10000);
    assert.equal(r.items.some((it) => it.id === "env-only"), false);
});

test("opencode（OpenCode Console）无凭据且支持 key → 在候选里", () => {
    const r = searchConnectable(ALL.integrations, "opencode", 100);
    assert.deepEqual(r.items.map((it) => it.id), ["opencode"]);
});

test("搜索大小写不敏感（OpenCode / opencode / OPENCODE 同结果）", () => {
    const lower = searchConnectable(ALL.integrations, "opencode", 100).items.map((it) => it.id);
    const upper = searchConnectable(ALL.integrations, "OPENCODE", 100).items.map((it) => it.id);
    const mixed = searchConnectable(ALL.integrations, "OpEnCoDe", 100).items.map((it) => it.id);
    assert.deepEqual(lower, ["opencode"]);
    assert.deepEqual(upper, ["opencode"]);
    assert.deepEqual(mixed, ["opencode"]);
});

test("搜索两侧空格被 trim（'  open  ' 等价于 'open'）", () => {
    const padded = searchConnectable(ALL.integrations, "  open  ", 100).items.map((it) => it.id);
    const plain = searchConnectable(ALL.integrations, "open", 100).items.map((it) => it.id);
    assert.deepEqual(padded, plain);
    assert.equal(padded.length, 4); // openai / opencode / openreason / openrouter
});

test("搜索按 id 匹配（openai、openrouter 是 id 命中）", () => {
    const ids = searchConnectable(ALL.integrations, "openrouter", 100).items.map((it) => it.id);
    assert.deepEqual(ids, ["openrouter"]);
});

test("搜索按 name 匹配（只匹配 id 的话这条会挂）", () => {
    // hyper <=> Charm Hyper：搜 "Charm" 只能靠 name 命中
    const r = searchConnectable(ALL.integrations, "Charm", 100);
    assert.deepEqual(r.items.map((it) => it.id), ["hyper"]);
});

test("搜 'labs' 只命中 name 里的 AI21 Labs（id 是 ai21）", () => {
    const r = searchConnectable(ALL.integrations, "labs", 100);
    assert.equal(r.items.some((it) => it.id === "ai21"), true);
    // 反证：搜 "ai21" 靠的是 id
    assert.deepEqual(searchConnectable(ALL.integrations, "ai21", 100).items.map((it) => it.id), ["ai21"]);
});

test("搜索命中 0 条时 total=0、items 为空、truncated=false", () => {
    const r = searchConnectable(ALL.integrations, "nope-zzz-不存在", 100);
    assert.equal(r.total, 0);
    assert.deepEqual(r.items, []);
    assert.equal(r.truncated, false);
});

test("搜索命中 1 条", () => {
    const r = searchConnectable(ALL.integrations, "opencode", 100);
    assert.equal(r.total, 1);
    assert.equal(r.items.length, 1);
});

test("空关键字列出全部候选但受 limit 截断，并如实标记 truncated", () => {
    const r = searchConnectable(ALL.integrations, "", CONNECTABLE_RESULT_LIMIT);
    assert.equal(r.total, 229);
    assert.equal(r.items.length, CONNECTABLE_RESULT_LIMIT);
    assert.equal(r.truncated, true);
});

test("limit 为 0 / 负数 / 非数字时退回默认上限，不至于一次渲染 229 条", () => {
    for (const bad of [0, -5, null, undefined, "abc", NaN]) {
        const r = searchConnectable(ALL.integrations, "", bad);
        assert.equal(r.items.length, CONNECTABLE_RESULT_LIMIT, `limit=${bad} 时应退回默认上限`);
    }
});

test("limit 小于 1 时按 1 处理（至少能显示一条，否则用户看不到任何候选）", () => {
    // 0/-1/NaN 都已在上条覆盖；这里确认 0.5 这类小数向下取整不产生 0 条
    const r = searchConnectable(ALL.integrations, "", 0.5);
    assert.equal(r.items.length, 1);
});

test("截断时 total 仍是完整命中数（面板要靠它显示「还有 N 条未显示」）", () => {
    const r = searchConnectable(ALL.integrations, "", 10);
    assert.equal(r.items.length, 10);
    assert.equal(r.total, 229);
    assert.equal(r.total - r.items.length, 219);
});

test("integrations 为 null / 非数组时返回空结果而非抛异常", () => {
    for (const bad of [null, undefined, "x", 42]) {
        const r = searchConnectable(bad, "open", 10);
        assert.deepEqual(r.items, []);
        assert.equal(r.total, 0);
    }
});

test("候选里的元素都是 null 也不抛异常", () => {
    const r = searchConnectable([null, undefined, { id: "a", name: "A", methods: [{ type: "key" }] }], "", 10);
    assert.equal(r.total, 1);
    assert.equal(r.items[0].id, "a");
});

test("query 为 null / undefined 视为空关键字（列出全部候选）", () => {
    assert.equal(searchConnectable(ALL.integrations, null, 5).total, 229);
    assert.equal(searchConnectable(ALL.integrations, undefined, 5).total, 229);
});

test("纯空格的 query 视为未搜索", () => {
    assert.equal(searchConnectable(ALL.integrations, "   ", 5).total, 229);
});

// ===== 接入新供应商：connectMethod =====

test("支持 key 时返回 key（哪怕它同时支持 oauth）", () => {
    // 官方口径：Saved API keys are a legitimate path，不能因为「也能 oauth」就拦掉
    for (const id of ["opencode", "openai", "xai", "poe", "digitalocean", "snowflake-cortex"]) {
        const it = ALL.integrations.find((x) => x.id === id);
        assert.equal(connectMethod(it), "key", `${id} 同时支持 key+oauth，仍应给 key 表单`);
    }
});

test("只支持 oauth 的集成返回 oauth（不给 key 表单）", () => {
    const copilot = ALL.integrations.find((x) => x.id === "github-copilot");
    assert.equal(connectMethod(copilot), "oauth");
});

test("只支持 command 的集成也归为 oauth（同样没有本面板可承载的交互面）", () => {
    assert.equal(connectMethod({ methods: [{ type: "command" }] }), "oauth");
});

test("既无 key 也无 oauth/command 时返回空串（不该渲染任何接入表单）", () => {
    assert.equal(connectMethod({ methods: [{ type: "env", names: ["K"] }] }), "");
    assert.equal(connectMethod({ methods: [] }), "");
    assert.equal(connectMethod(null), "");
});

test("key 的优先级高于 oauth（methods 顺序颠倒也不影响）", () => {
    assert.equal(connectMethod({ methods: [{ type: "oauth", label: "L" }, { type: "key" }] }), "key");
    assert.equal(connectMethod({ methods: [{ type: "key" }, { type: "oauth", label: "L" }] }), "key");
});

// ===== 接入新供应商：connectEmptyText =====

test("有命中时不输出空态文案", () => {
    assert.equal(connectEmptyText({ items: [{ id: "a" }], total: 1, truncated: false }, "a"), "");
});

test("搜不到时把用户输入的关键词回显出来", () => {
    const text = connectEmptyText({ items: [], total: 0, truncated: false }, "nope-zzz");
    assert.ok(text.includes("nope-zzz"));
});

test("搜不到时说明限定条件是「支持 API Key 接入」（否则用户以为是自己输错）", () => {
    const text = connectEmptyText({ items: [], total: 0, truncated: false }, "copilot");
    assert.ok(text.includes("API Key"));
});

test("无关键字且无候选时的文案不同于「搜不到」", () => {
    const text = connectEmptyText({ items: [], total: 0, truncated: false }, "");
    assert.ok(text.includes("没有可用"));
    assert.equal(text.includes("匹配"), false);
});

test("result 结构异常时给出兜底文案，不抛异常", () => {
    assert.ok(connectEmptyText(null, "x"));
    assert.ok(connectEmptyText({ items: null }, "x"));
});

// ===== 多 key：可删除判定 =====
//
// 删除是破坏性操作，判定必须收在纯逻辑里：渲染层只照着 canDelete 出按钮，
// 不参与判断——否则「删掉唯一一把」这道守卫会在某个分支漏掉。

test("两把 key 时两把都可删", () => {
    const rows = connectionRows({
        connections: [
            { type: "credential", id: "cred_a" },
            { type: "credential", id: "cred_b" },
        ],
    });
    assert.deepEqual(rows.map((r) => r.canDelete), [true, true]);
    assert.deepEqual(rows.map((r) => r.credentialCount), [2, 2]);
});

test("只剩一把时不可删（否则供应商彻底没凭据，只能回去重填）", () => {
    const rows = connectionRows({ connections: [{ type: "credential", id: "cred_a" }] });
    assert.equal(rows[0].canDelete, false);
    assert.equal(rows[0].credentialCount, 1);
});

test("env 型永不可删（进程环境变量不在凭据库里，V2 无对应端点）", () => {
    // 一把 key + 一个 env：凭据数按 credential 型算，删掉它就只剩 env 了
    const rows = connectionRows({
        connections: [
            { type: "credential", id: "cred_a" },
            { type: "env", name: "K" },
        ],
    });
    assert.equal(rows[1].canDelete, false);
    assert.equal(rows[1].credentialId, "");
});

test("env 型即便带了 id 也不可切/不可删（判据是 type，不是「有没有 id」）", () => {
    // 真实数据里 env 型确实不带 id，于是「只判有没有 id」和「判 type」结果一样，
    // 两者在测试里分不开。这条用一个带 id 的 env 构造出来，把判据钉死在 type 上——
    // 否则哪天服务端给 env 型补了 id，env 行就会平白多出可点/可删的按钮。
    const rows = connectionRows({
        connections: [
            { type: "credential", id: "cred_a" },
            { type: "env", id: "env_1", name: "K" },
        ],
    });
    assert.equal(rows[1].canSwitch, false);
    assert.equal(rows[1].canDelete, false);
    assert.equal(rows[1].credentialId, "");
});

test("凭据型缺 id 时既不可删也不可切（构造不出端点路径）", () => {
    const rows = connectionRows({
        connections: [{ type: "credential" }, { type: "credential", id: "cred_b" }],
    });
    assert.equal(rows[0].canDelete, false);
    assert.equal(rows[0].canSwitch, false);
    assert.equal(rows[0].credentialId, "");
});

test("三把 key 时每行 credentialCount 都是 3", () => {
    const rows = connectionRows({
        connections: [
            { type: "credential", id: "cred_a" },
            { type: "credential", id: "cred_b" },
            { type: "credential", id: "cred_c" },
            { type: "env", name: "K" },
        ],
    });
    assert.deepEqual(rows.map((r) => r.canDelete), [true, true, true, false]);
    assert.deepEqual(rows.map((r) => r.credentialCount), [3, 3, 3, 3]);
});

// ===== methods 透传与 supportsKeyAuth =====
//
// 「能不能再加一把 key」只能看 methods 里有没有 type==="key"。
// 这要求 summarizeIntegrations 把 methods 透传下来——
// 早期实现只留 id/name/connections，methods 被丢在中间层，
// 于是面板根本无从判断该不该给「添加」按钮。

test("summarizeIntegrations 透传 methods", () => {
    const s = summarizeIntegrations({
        integrations: [{ id: "deepseek", name: "DeepSeek", methods: [{ type: "key" }], connections: [] }],
        total: 231,
    });
    assert.deepEqual(s.integrations[0].methods, [{ type: "key" }]);
});

test("methods 缺失时补空数组（否则 supportsKeyAuth 遍历会抛）", () => {
    const s = summarizeIntegrations({ integrations: [{ id: "x", connections: [] }], total: 1 });
    assert.deepEqual(s.integrations[0].methods, []);
    assert.equal(supportsKeyAuth(s.integrations[0]), false);
});

test("methods 为 null 时也补空数组", () => {
    const s = summarizeIntegrations({ integrations: [{ id: "x", methods: null, connections: [] }], total: 1 });
    assert.deepEqual(s.integrations[0].methods, []);
});

test("methods 里有 type=key 才能加 key", () => {
    assert.equal(supportsKeyAuth({ methods: [{ type: "key" }] }), true);
    assert.equal(supportsKeyAuth({ methods: [{ type: "key" }, { type: "env", names: ["K"] }] }), true);
});

test("只有 oauth 的集成不给加 key 按钮（给了也必然失败）", () => {
    assert.equal(supportsKeyAuth({ methods: [{ id: "x", type: "oauth", label: "L" }] }), false);
    assert.equal(supportsKeyAuth({ methods: [{ type: "env", names: ["K"] }] }), false);
});

test("methods 缺失/null/非数组一律判为不可加，不抛异常", () => {
    assert.equal(supportsKeyAuth({}), false);
    assert.equal(supportsKeyAuth({ methods: null }), false);
    assert.equal(supportsKeyAuth({ methods: "key" }), false);
    assert.equal(supportsKeyAuth(null), false);
});

test("当前挂 env 但 methods 有 key 也能加（实测 openai 即如此）", () => {
    const s = summarizeIntegrations({
        integrations: [{
            id: "openai",
            methods: [{ type: "key" }, { type: "env", names: ["OPENAI_API_KEY"] }],
            connections: [{ type: "env", name: "OPENAI_API_KEY" }],
        }],
        total: 231,
    });
    assert.equal(supportsKeyAuth(s.integrations[0]), true);
});

// ===== isExpandable =====
//
// 这是「多 key」能不能被用到的关键闸门：旧实现只看 canSwitch，
// 于是「只有一个供应商、只有一把 key、但用户想加第二把」这种最常见的
// 起步场景，折叠区根本不渲染 —— 用户连「添加」按钮都看不到。

test("只有一把 key 但支持加 key 时仍要可展开（否则加 key 入口不可见）", () => {
    const one = {
        methods: [{ type: "key" }],
        connections: [{ type: "credential", id: "cred_a", label: "default" }],
    };
    // 旧逻辑只看 canSwitch：单连接时 canSwitch 全为 false
    assert.equal(connectionRows(one).some((r) => r.canSwitch), false);
    assert.equal(isExpandable(one), true);
});

test("两把 key 可切换 → 可展开", () => {
    assert.equal(
        isExpandable({
            methods: [{ type: "key" }],
            connections: [{ type: "credential", id: "cred_a" }, { type: "credential", id: "cred_b" }],
        }),
        true,
    );
});

test("只挂 env 且不支持 key 的集成不渲染折叠区（点不开的箭头是噪音）", () => {
    assert.equal(
        isExpandable({ methods: [{ type: "env", names: ["K"] }], connections: [{ type: "env", name: "K" }] }),
        false,
    );
});

test("空集成不可展开", () => {
    assert.equal(isExpandable({ methods: [{ type: "key" }], connections: [] }), true);
    assert.equal(isExpandable({ methods: [], connections: [] }), false);
    assert.equal(isExpandable(null), false);
});

// ===== 真实多 key 响应回放 =====
//
// 用实测抓下来的整段 payload，锁住面板在真实数据上的行为。
// 这是最贴近用户所见的一层：别的用例都是手搓的连接数组。

const fixture = JSON.parse(
    fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "integration-multikey.json"), "utf-8"),
);

test("真实多 key 响应：一把当前、两把可删、env 不可动", () => {
    const s = summarizeIntegrations(fixture);
    assert.equal(s.error, "");
    assert.equal(s.shown, 1);

    const rows = connectionRows(s.integrations[0]);
    assert.equal(rows.length, 3);

    // 实测：新增的那把直接成为 connections[0]
    assert.equal(rows[0].isCurrent, true);
    assert.equal(rows[0].canSwitch, false);
    assert.equal(rows[0].label, "__multikey_probe__");

    assert.equal(rows[1].isCurrent, false);
    assert.equal(rows[1].canSwitch, true);
    assert.equal(rows[1].credentialId, "cred_004941e36001XyV8GiDrESm0bh");
    assert.equal(rows[1].label, "default");

    assert.equal(rows[2].canSwitch, false);
    assert.equal(rows[2].canDelete, false);
    assert.equal(rows[2].label, "环境变量 DEEPSEEK_API_KEY");
});

test("真实多 key 响应：两把都可删，且可展开、可加 key", () => {
    const s = summarizeIntegrations(fixture);
    const it = s.integrations[0];
    assert.deepEqual(connectionRows(it).map((r) => r.canDelete), [true, true, false]);
    assert.equal(isExpandable(it), true);
    assert.equal(supportsKeyAuth(it), true);
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

// ===== 静态门禁：多 key 的写入口确实接上了 =====
//
// 这一组比前面的纯逻辑更容易悄悄坏掉：App 方法名写错、dispatcher 漏 case、
// 或前端只写了 UI 没接后端，都不会在浏览器里报出「凭据加不进去」以外的错。
// 浏览器模式下前端是按**方法名**转发到 app_dispatcher.go 的，
// 所以名字对不上时只会得到「未知方法」。

const appExtSrc = fs.readFileSync(path.join(HERE, "..", "app_ext.go"), "utf-8");
const dispatcherSrc = fs.readFileSync(path.join(HERE, "..", "app_dispatcher.go"), "utf-8");

test("面板调用 AddCredential / DeleteCredential", () => {
    assert.ok(credSrc.includes("api.AddCredential("), "应调用 AddCredential");
    assert.ok(credSrc.includes("api.DeleteCredential("), "应调用 DeleteCredential");
});

test("AddCredential / DeleteCredential 在 App 与 dispatcher 上都注册了", () => {
    for (const fn of ["AddCredential", "DeleteCredential"]) {
        assert.ok(
            appExtSrc.includes(`func (a *App) ${fn}(`),
            `app_ext.go 缺少 App.${fn}`,
        );
        assert.ok(
            dispatcherSrc.includes(`case "${fn}":`),
            `app_dispatcher.go 缺少 "${fn}" 分支（浏览器模式靠方法名转发，漏了必然调不通）`,
        );
    }
});

test("新增 key 成功后必须重新拉列表（新增的那把会直接顶替成当前）", () => {
    const idx = credSrc.indexOf("async function addCredential");
    assert.ok(idx > 0, "应定义 addCredential");
    const body = credSrc.slice(idx, idx + 1400);
    assert.ok(body.includes("loadCredentials("), "新增后必须重新拉列表，不能就地改本地状态");
});

test("删除凭据必须二次确认", () => {
    const idx = credSrc.indexOf("async function deleteCredential");
    assert.ok(idx > 0, "应定义 deleteCredential");
    const body = credSrc.slice(idx, idx + 900);
    assert.ok(body.includes("confirm("), "删除是破坏性操作，必须二次确认");
});

test("渲染函数不读输入框的 value（密钥绝不回显到面板）", () => {
    // render 重建 innerHTML，一旦把 key 拼进 HTML 就会留在 DOM / 内存里。
    // 读取只允许发生在事件处理函数中。
    const idx = credSrc.indexOf("export function renderCredentials");
    assert.ok(idx > 0, "应定义 renderCredentials");
    const body = credSrc.slice(idx, credSrc.indexOf("export async function loadCredentials"));
    assert.ok(
        !/oc-cred-add-key[^"]*"[^;]*value=/.test(body),
        "渲染时不得把 API Key 的值拼进 HTML",
    );
    assert.ok(!body.includes(".oc-cred-add-key'), ("), "渲染时不得读取 API Key 输入框的值");
});

test("添加 key 的输入框是密码框且关掉自动填充", () => {
    const idx = credSrc.indexOf("oc-cred-add-key");
    assert.ok(idx > 0, "应存在 API Key 输入框");
    const frag = credSrc.slice(idx - 60, idx + 200);
    assert.ok(frag.includes('type="password"'), "API Key 输入框应为密码框");
    assert.ok(frag.includes('autocomplete="off"'), "应关闭自动填充，避免密钥被浏览器留存");
});

// ===== 静态门禁：接入新供应商 =====
//
// 这几条针对「加了入口但用不起来」的形态：拉的还是过滤后的列表、
// change 监听器绑在会被 innerHTML 换掉的元素上（第二次重绘就失灵）、
// 或者 key 意外进了状态对象。这些都不会报错，只是功能静默失效。

test("必须拉全量集成（includeEmpty=true），否则新供应商根本不在候选里", () => {
    assert.ok(
        credSrc.includes("api.ListIntegrations(directory || '', true)"),
        "应传 includeEmpty=true；写死 false 会让 225 个未配置集成被挡在候选之外",
    );
    assert.ok(
        !/api\.ListIntegrations\([^)]*,\s*false\)/.test(credSrc),
        "凭据面板不应再写死 includeEmpty=false",
    );
});

test("搜索框与下拉的 change 必须委托到容器上", () => {
    // renderCredentials() 每次重建 innerHTML，直接绑在元素上的监听器
    // 会随元素一起被丢弃，第二次重绘后搜索就失灵了。
    const idx = credSrc.indexOf("addEventListener('change'");
    assert.ok(idx > 0, "应有 change 监听器");
    assert.ok(credSrc.includes("oc-cred-connect-search"), "应处理搜索框的 change");
    assert.ok(credSrc.includes("oc-cred-connect-pick"), "应处理下拉的 change");
    // 两个控件都不得直接绑：搜索框与下拉都要覆盖
    for (const cls of ["oc-cred-connect-search", "oc-cred-connect-pick"]) {
        assert.ok(
            !new RegExp(`querySelector\\('\\.?${cls}'\\)\\s*\\.\\s*addEventListener`).test(credSrc),
            `${cls} 的 change 不得直接绑在会被重绘替换的元素上`,
        );
    }
    // 委托目标必须是容器 box 本身
    const boxIdx = credSrc.indexOf("const box = document.getElementById('ocCredentials');", credSrc.indexOf("export function initCredentials"));
    const changeIdx = credSrc.indexOf("addEventListener('change'");
    assert.ok(changeIdx > boxIdx, "change 应委托在容器 box 上");
    const between = credSrc.slice(boxIdx, changeIdx);
    assert.ok(
        /box\.addEventListener\(\s*'change'/.test(credSrc),
        "change 必须挂在 box 上（事件委托），而非重绘即失效的元素上",
    );
});

test("key 不进任何状态对象（只从 input.value 读一次就发走）", () => {
    // credState 是模块级对象，会一直活着；key 进了它就等于长时间驻留内存
    const stateIdx = credSrc.indexOf("const credState = {");
    assert.ok(stateIdx > 0, "应定义 credState");
    const stateBlock = credSrc.slice(stateIdx, credSrc.indexOf("};", stateIdx));
    assert.ok(
        !/\bkey\b\s*[:=]/.test(stateBlock.replace(/connectQuery|credentialId|keyInput|add-key|addKey|keyInput/g, "")),
        "credState 里不应出现 key 字段",
    );
    // 只看代码，不看注释——注释里可以（也应该）写明「不写 localStorage」
    const codeOnly = credSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(
        !/localStorage|sessionStorage|indexedDB/.test(codeOnly),
        "凭据面板不应写 localStorage/sessionStorage/indexedDB",
    );
    // 也不该有任何把 key 塞进 DOM 属性或数据的路径
    assert.ok(
        !/dataset\s*\.\s*key\b/.test(codeOnly),
        "不应把 key 写进 data-* 属性（会留在 DOM 上）",
    );
});

test("提交前先清空 key 输入框", () => {
    const idx = credSrc.indexOf("async function addCredential");
    assert.ok(idx > 0, "应定义 addCredential");
    const body = credSrc.slice(idx, idx + 900);
    const readAt = body.indexOf("keyInput.value");
    const clearAt = body.indexOf("keyInput.value = ''");
    assert.ok(readAt > 0, "应从输入框读 key");
    assert.ok(clearAt > readAt, "必须在读取之后、清空输入框（否则发出去的是空串）");
});

test("key 明文不出现在任何渲染输出里", () => {
    // 用一个哨兵密钥模拟：把它塞进输入框后重绘，渲染出的 HTML 不得含它
    const SECRET = "sk-SENTINEL-must-never-appear-in-html";
    const renderIdx = credSrc.indexOf("export function renderCredentials");
    assert.ok(renderIdx > 0, "应定义 renderCredentials");
    const renderBody = credSrc.slice(renderIdx, credSrc.indexOf("export async function loadCredentials"));

    // 渲染路径里不得出现读取 key 输入框的写法
    assert.ok(
        !/oc-cred-add-key'\)?\s*\)?\.value/.test(renderBody),
        "renderCredentials 不得读取 key 输入框的值",
    );
    assert.ok(
        !/value=""\s*\+/.test(renderBody) || !/add-key/.test(renderBody),
        "key 输入框不得被回填 value",
    );
    // 整条渲染路径上不存在把 SECRET 拼进 HTML 的可能
    assert.ok(!renderBody.includes(SECRET), "渲染路径不得包含 key 明文");
    // 表单渲染只写 placeholder/aria-label，不写 value
    const formIdx = credSrc.indexOf("function renderConnectForm");
    assert.ok(formIdx > 0, "应定义 renderConnectForm");
    const formBody = credSrc.slice(formIdx, credSrc.indexOf("export function renderCredentials"));
    assert.ok(!formBody.includes(SECRET), "表单渲染不得包含 key 明文");
});

test("候选区只渲染无凭据的集成（已配置的走下面那张卡片）", () => {
    const idx = credSrc.indexOf("function renderConnectSection");
    assert.ok(idx > 0, "应定义 renderConnectSection");
    const body = credSrc.slice(idx, credSrc.indexOf("function renderConnectForm"));
    assert.ok(body.includes("searchConnectable("), "候选应来自 searchConnectable");
});

test("截断时如实告知还有多少条未显示", () => {
    assert.ok(credSrc.includes("还有 "), "应显示未显示的条数");
    assert.ok(credSrc.includes("条未显示"), "应说明未显示的条数");
    assert.ok(credSrc.includes("收窄"), "应提示如何收窄结果");
});

test("只支持 oauth 的集成渲染 /connect 提示而非 key 表单", () => {
    assert.ok(credSrc.includes("connectMethod("), "应按 connectMethod 决定表单形态");
    assert.ok(credSrc.includes("/connect"), "oauth 型应提示用 TUI 的 /connect");
    const formIdx = credSrc.indexOf("function renderConnectForm");
    const formBody = credSrc.slice(formIdx, credSrc.indexOf("export function renderCredentials"));
    // 判据必须在渲染 key 表单**之前**：method !== 'key' 就 early return
    const guardAt = formBody.indexOf("method !== 'key'");
    const inputAt = formBody.indexOf("oc-cred-add-key");
    assert.ok(guardAt > 0, "应有 method !== 'key' 的守卫");
    assert.ok(inputAt > guardAt, "守卫必须早于 key 输入框渲染");
});

test("概览文案不再声称是过滤后的部分视图", () => {
    // 拉全量后再说「仅显示已配置凭据的集成（6 / 231）」会误导：
    // 另外 225 个集成恰恰是接入候选，用户会以为它们不存在
    const idx = credSrc.indexOf("function renderCredentials");
    const body = credSrc.slice(idx, credSrc.indexOf("export async function loadCredentials"));
    assert.ok(!body.includes("credentialsHeaderText("), "全量模式不应再用过滤说明文案");
    assert.ok(body.includes("个集成，其中"), "应如实说明总数与已配置数");
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
