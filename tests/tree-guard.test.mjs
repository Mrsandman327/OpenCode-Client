// 项目树重建节流 + 「本地已删会话」去重 的纯逻辑测试
//
// 这个模块存在的理由是「删除会话时树一直闪」，所以用例全部按
// 「把 bug 放回去是否会被抓住」来设计，而不是只测 happy path。
//
// 原始 bug 的两种形态各有对应对照组：
//   A. 不合并并发重建 → N 次调用 = N 次整树拆建 = 连续闪烁
//   B. 用单个布尔标志跳过重建 → 多条事件只跳过第一条，其余照样重建；
//      且分不清是哪个会话，会吞掉别的会话的删除（删了却还留在树里）
//
// 运行：node --test tests/

import assert from "node:assert/strict";
import test from "node:test";

import {
    createBuildGate,
    createRecentlyDeleted,
    RECENTLY_DELETED_TTL_MS,
} from "../frontend/dist/chat/tree-guard.js";

/** 可手动推进的假时钟，避免测试真的 sleep */
function fakeClock(start = 1000) {
    let t = start;
    return {
        now: () => t,
        advance(ms) { t += ms; },
    };
}

/** 计数用的 job：记录每次真正执行的次数 */
function countingJob(result = true) {
    const state = { calls: 0 };
    state.job = () => {
        state.calls++;
        return Promise.resolve(result);
    };
    return state;
}

// ===== createBuildGate =====

test("串行调用：每次都执行", async () => {
    const run = createBuildGate();
    const c = countingJob();
    await run(c.job);
    await run(c.job);
    assert.equal(c.calls, 2);
});

test("并发请求被合并成 1 + 1 次，而不是 N 次（bug A 的对照组）", async () => {
    const run = createBuildGate();
    const c = countingJob();
    // 50 个调用者同时涌入（删一个带子会话的会话就会来好几条事件）
    await Promise.all(Array.from({ length: 50 }, () => run(c.job)));
    // 恰好 2 次：第 1 次是首个请求发起的，后 49 个是在它取数期间到的，
    // 合并成 1 次补跑。**不是 50 次**——那才是「一直闪」的形态。
    // 这里不能断言 1：第 1 次的取数可能早于后 49 个请求对应的删除落地，
    // 省掉补跑就会漏掉那些删除（树里会留着已删会话）。少渲染一次不能换来漏删。
    assert.equal(c.calls, 2, "50 个并发请求应被合并成 1 + 1 次");
});

test("串行到达的请求不会触发多余补跑", async () => {
    const run = createBuildGate();
    const c = countingJob();
    // 每个都 await 到结束，下一个才算「在途」——不该产生补跑
    await run(c.job);
    await run(c.job);
    await run(c.job);
    assert.equal(c.calls, 3);
});

test("执行期间涌入的请求只补跑一次，不按 N 跑", async () => {
    const run = createBuildGate();
    const c = countingJob();
    let release;
    const gate = new Promise((r) => { release = r; });

    const first = run(() => gate.then(() => { c.calls++; return true; }));
    // 第一轮还在跑的时候，来 3 个请求
    const extra = [run(c.job), run(c.job), run(c.job)];
    release();

    await first;
    await Promise.all(extra);

    assert.equal(c.calls, 2, "在跑的 1 次 + 合并后补的 1 次，共 2 次；不应是 4 次");
});

test("合并进来的调用方拿到同一个 promise（即最终那次的结果）", async () => {
    const run = createBuildGate();
    let release;
    const gate = new Promise((r) => { release = r; });

    const a = run(() => gate.then(() => "first"));
    const b = run(() => Promise.resolve("second"));
    release();

    assert.equal(await a, "first");
    assert.equal(await b, "first", "b 是在途请求，应等同一个结果而不是自己那次");
    assert.equal(a, b, "在途请求应复用同一个 promise 对象");
});

test("job 抛异常后闸门仍能再次使用（否则一次异常就让树永远不再重建）", async () => {
    const run = createBuildGate();
    await assert.rejects(run(() => Promise.reject(new Error("boom"))), /boom/);

    const c = countingJob("ok");
    assert.equal(await run(c.job), "ok");
    assert.equal(c.calls, 1);
});

test("job 抛异常时也会消化掉在途请求，不会让它们永久挂起", async () => {
    const run = createBuildGate();
    const p1 = run(() => Promise.reject(new Error("boom")));
    const p2 = run(() => Promise.resolve("never"));
    await assert.rejects(p1, /boom/);
    // p2 只是复用了 p1 的链；它自己不会独立执行，但必须会 settle
    await assert.rejects(p2, /boom/);
});

test("job 同步重入 run 不会爆栈，且只补跑一次", async () => {
    const run = createBuildGate();
    let calls = 0;
    let reentered = false;
    const result = await run(() => {
        calls++;
        // 只在第一轮重入一次。若每轮都重入，pending 永远为真会转成死循环，
        // 那是调用方的用法问题（job 不该无条件地要求再来一轮）。
        if (!reentered) {
            reentered = true;
            // 同步重入：闸门必须已占位，否则这里会无限递归直到爆栈
            run(() => { calls++; return Promise.resolve(true); });
        }
        return Promise.resolve("outer");
    });
    assert.equal(result, "outer");
    assert.equal(calls, 2, "重入恰好触发一次补跑");
});

// ===== createRecentlyDeleted =====

test("标记后该会话被认作已删", () => {
    const rd = createRecentlyDeleted(3000, fakeClock().now);
    assert.equal(rd.has("s1"), false);
    rd.mark("s1");
    assert.equal(rd.has("s1"), true);
});

test("多条事件对同一会话都被吸收（bug B 的对照组：布尔只吸收第一条）", () => {
    const rd = createRecentlyDeleted(3000, fakeClock().now);
    rd.mark("s1");
    // 同一次删除会发多条 session.deleted（会话 + 子会话）
    assert.equal(rd.has("s1"), true);
    assert.equal(rd.has("s1"), true, "第 2 条事件也必须被吸收");
    assert.equal(rd.has("s1"), true, "第 3 条事件也必须被吸收");
});

test("别的会话不被误吞（bug B 的对照组：布尔会吞掉 2 秒内任意会话的删除）", () => {
    const rd = createRecentlyDeleted(3000, fakeClock().now);
    rd.mark("s1");
    assert.equal(rd.has("s2"), false, "s2 的删除必须照常触发重建，否则它会永远留在树里");
});

test("超过 TTL 后不再认为是本地删除（退路：事件迟到也得能重建）", () => {
    const clock = fakeClock();
    const rd = createRecentlyDeleted(3000, clock.now);
    rd.mark("s1");
    assert.equal(rd.has("s1"), true);
    clock.advance(3001);
    assert.equal(rd.has("s1"), false);
});

test("空 ID 一律不记账也不命中", () => {
    const rd = createRecentlyDeleted(3000, fakeClock().now);
    assert.equal(rd.mark(""), false);
    assert.equal(rd.mark(undefined), false);
    assert.equal(rd.has(""), false);
    assert.equal(rd.has(undefined), false);
});

test("过期条目在写入时被清掉，不无界增长", () => {
    const clock = fakeClock();
    const rd = createRecentlyDeleted(3000, clock.now);
    for (let i = 0; i < 50; i++) {
        clock.advance(100);
        rd.mark("s" + i);
    }
    clock.advance(5000);
    rd.mark("fresh");
    assert.ok(rd.size() <= 2, "50 条历史记录应被 prune 掉，实际剩 " + rd.size());
});

test("clear 清空全部记账", () => {
    const rd = createRecentlyDeleted(3000, fakeClock().now);
    rd.mark("s1");
    rd.mark("s2");
    rd.clear();
    assert.equal(rd.size(), 0);
    assert.equal(rd.has("s1"), false);
});

// ===== 常量 =====

test("TTL 默认为 3 秒", () => {
    assert.equal(RECENTLY_DELETED_TTL_MS, 3000);
});
