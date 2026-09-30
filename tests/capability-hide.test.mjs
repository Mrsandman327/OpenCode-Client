// 能力缺失项的隐藏策略测试
//
// V2 移除了两项能力：LSP（不运行语言服务器、无 /api/lsp 端点）与
// 代办（工具清单里已无 todowrite，类型定义与事件流中亦无任何 todo 项）。
//
// 处理策略：**服务端不支持时整段隐藏**（LSP 分组、代办分区连标题一起），
// 而不是渲染「当前服务端不支持」的占位。占位会长期占住侧栏位置，
// 且永远不会有内容，看起来像个坏了的功能。
//
// 关键前提：隐藏必须是**条件性**的——由 lspSupported / todoSupported 驱动，
// 而非写死。若将来接上支持这两项能力的服务端，分区应自动恢复，
// 因此这里断言开关仍在被读取，而不是断言「一定不渲染」。

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "frontend", "dist");

const read = (...p) => fs.readFileSync(path.join(DIST, ...p), "utf-8");
const service = read("chat", "service.js");
const sidepanel = read("chat", "sidepanel.js");
const state = read("core", "state.js");
const html = read("index.html");

test("代办与 LSP 的占位文案已移除", () => {
    for (const src of [service, sidepanel, html]) {
        assert.ok(
            !/当前服务端(不支持|未提供代办)/.test(src),
            "不应再出现「不支持」占位文案",
        );
        assert.ok(
            !/请改用项目的 lint/.test(src),
            "不应再出现 LSP 替代方案的提示文案",
        );
    }
});

test("LSP 分组仅在 lspSupported 时渲染", () => {
    assert.ok(service.includes("if (store.lspStatus) {"), "LSP 渲染应由状态驱动");
    // 不再有「不支持时插入说明分组」的分支
    assert.ok(
        !/lspSupported\s*\)\s*\{\s*\n\s*const lspSec/.test(service),
        "不应存在 lspSupported 为假时插入占位分组的分支",
    );
});

test("代办分区整块隐藏（含标题），而非只清空内容", () => {
    assert.ok(sidepanel.includes("todoPanelSection"), "应通过整个分区控制显隐");
    assert.ok(
        /todoPanelSection[\s\S]{0,200}style\.display\s*=\s*store\.todoSupported\s*===\s*false\s*\?\s*'none'\s*:/.test(sidepanel),
        "应对分区设置 display:none，而不是只清空内容区",
    );
    assert.ok(
        /todoSupported\s*===\s*false\s*\)\s*\{\s*\n\s*return;/.test(sidepanel),
        "不支持时应直接返回，不再渲染任何内容",
    );
});

test("index.html 给代办分区加了 id 供显隐控制", () => {
    assert.ok(
        /id="todoPanelSection"/.test(html),
        "代办分区需要有可被 JS 定位的 id",
    );
});

test("两个能力开关仍被保留并作为显隐依据（可恢复性）", () => {
    assert.ok(state.includes("lspSupported"), "state 仍应保留 lspSupported");
    assert.ok(state.includes("todoSupported"), "state 仍应保留 todoSupported");
    assert.ok(service.includes("store.lspSupported = false"), "lspSupported 仍由服务端能力决定");
});

test("隐藏是条件性的：开关为真时分区应恢复显示", () => {
    // 三元里保留了 '' 分支 —— 开关转真即恢复显示，而非永久写死 none
    assert.ok(
        /todoSupported\s*===\s*false\s*\?\s*'none'\s*:\s*''/.test(sidepanel),
        "todoSupported 为真时必须恢复显示（不能永久隐藏）",
    );
});
