// 模型选择器「加载失败不该被永久缓存」的回归测试。
//
// 背景：真实故障是「op2 升级后服务地址变成绑定地址 0.0.0.0 → 鉴权一时不通 →
// 模型列表取失败」，而调用方把「已加载」守卫无条件置位，于是失败被永久固化、
// 再也不重试。用户看到下拉框只剩「默认」+ 从会话历史兜底补进来的零星几项，
// 症状是「模型列表不全 / 选不到模型」，而日志里一条线索都没有。
//
// 这里锁住的是判据本身：只有拿到非空列表才算加载成功。
//
// 运行：node --test tests/*.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    modelSelectorsUsable,
    MODEL_LIST_EMPTY_HINT,
    toModelOptions,
} from "../frontend/dist/core/v2compat.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// ===== modelSelectorsUsable =====

test("空列表不算加载成功（否则失败会被永久缓存）", () => {
    assert.equal(modelSelectorsUsable([]), false);
});

test("非空列表才算成功", () => {
    assert.equal(modelSelectorsUsable([{ value: "p/m", label: "m" }]), true);
});

test("非数组一律不算成功", () => {
    for (const bad of [null, undefined, "x", 42, {}]) {
        assert.equal(modelSelectorsUsable(bad), false, `输入 ${JSON.stringify(bad)}`);
    }
});

test("空提示文案非空且含可行动信息", () => {
    assert.equal(typeof MODEL_LIST_EMPTY_HINT, "string");
    assert.ok(MODEL_LIST_EMPTY_HINT.length > 0);
    // 用户要能从中看出「这不是我没得选，是没加载出来」
    assert.ok(/未加载|重试/.test(MODEL_LIST_EMPTY_HINT), MODEL_LIST_EMPTY_HINT);
});

// ===== 反例：真实载荷应产出全部模型（防止判据改坏映射） =====

test("真实规模的模型载荷映射后判定为可用", () => {
    // 用与 /api/model 同构的构造载荷：232 条、每条含 providerID + modelID
    const data = Array.from({ length: 232 }, (_, i) => ({
        id: `m${i}`,
        modelID: `m${i}`,
        providerID: i % 2 ? "opencode-go" : "opencode",
        name: `Model ${i}`,
    }));
    const opts = toModelOptions({ location: { directory: "C:\\x" }, data });
    assert.equal(opts.length, 232);
    assert.equal(modelSelectorsUsable(opts), true);
});

test("服务端返回空 data 时判定为不可用（这正是要重试的场景）", () => {
    const res = { location: { directory: "C:\\x" }, data: [] };
    assert.equal(modelSelectorsUsable(toModelOptions(res)), false);
});

// ===== 源码级断言 =====
//
// session.js 依赖浏览器环境（apicall/state/document），测试进程加载不了，
// 只能做源码级断言。这类断言天生偏脆，但锁的正是本次修掉的那个回归：
// 「守卫被无条件置位 → 一次失败被永久固化」。不锁住它，下次有人顺手改回去
// 也不会有任何测试变红。

test("agentModelSelectorsLoaded 的置位必须被可用性判据包住", () => {
    const src = fs.readFileSync(path.join(root, "frontend", "dist", "chat", "session.js"), "utf8");

    assert.ok(src.includes("modelSelectorsUsable("), "未使用 modelSelectorsUsable 判据");

    // 必须在 if (modelSelectorsUsable(...)) 花括号内置位
    const guarded =
        /if\s*\(\s*modelSelectorsUsable\([^)]*\)\s*\)\s*\{[^}]*store\.agentModelSelectorsLoaded\s*=\s*true/.test(
            src,
        );
    assert.equal(guarded, true, "agentModelSelectorsLoaded 没有放在可用性判断块内");

    // 且不得在判据之外再出现一处无条件置位
    const allTrueAssigns = [...src.matchAll(/store\.agentModelSelectorsLoaded\s*=\s*true/g)].length;
    assert.equal(allTrueAssigns, 1, `应只有 1 处置 true（且在判断块内），实际 ${allTrueAssigns} 处`);
});

test("session.js 不得用 .catch(() => []) 吞掉模型请求的错误", () => {
    const src = fs.readFileSync(path.join(root, "frontend", "dist", "chat", "session.js"), "utf8");
    assert.equal(
        /OpenCodeCall\('GET',\s*'\/api\/model'\)\s*\.catch\(/.test(src),
        false,
        "模型请求仍带静默 catch；失败必须可见（console.error + 重试）",
    );
    assert.ok(/console\.error/.test(src), "失败路径缺少 console.error，问题会再次无痕");
});
