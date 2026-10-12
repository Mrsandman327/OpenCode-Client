// /btw 侧问 + 全局键位表测试。
//
// 运行：node tests/btw-keybinds.test.mjs
// 说明：前端无测试框架（纯静态 ES Modules，无 package.json），故用 Node 内置
// assert 手写最小测试，风格对齐 tests/v2compat.test.mjs。
// 只测**纯逻辑**（core/btw.js、core/keybinds.js）与**源码级结构门禁**
// （chat/keybinds.js、chat/cmd-palette.js、chat/session.js）——
// 后三者模块顶层就碰 DOM，无法在 Node 里 import。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    BTW_INSTRUCTIONS, BTW_COMMAND, buildBtwPrompt, extractBtwAnswer,
    parseBtwCommand, btwPanelState,
} from "../frontend/dist/core/btw.js";
import {
    parseKeybind, parseKeybindStep, stepMatches, isEditableTarget,
    isMacPlatform, hasOpenModal,
} from "../frontend/dist/core/keybinds.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "frontend", "dist");
const read = (rel) => fs.readFileSync(path.join(DIST, rel), "utf8");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ============ 辅助：造一个最小 KeyboardEvent 形状 ============
function ev(key, mods) {
    const m = mods || {};
    return {
        key: key,
        ctrlKey: !!m.ctrl,
        metaKey: !!m.meta,
        altKey: !!m.alt,
        shiftKey: !!m.shift,
    };
}
/** 把书写里的转义反解出来（源码中 mod+\ 写成 'mod+\\'） */
function unescape(spec) { return spec.replace(/\\\\/g, "\\"); }

// ============ /btw：instructions 与拼包 ============

test("BTW_INSTRUCTIONS 三句逐字等于上游，且用单空格 join", () => {
    // 上游 btw-model.ts:7-11 是 [...].join(" ")——句间一个空格，不是换行
    assert.equal(BTW_INSTRUCTIONS, [
        "The user is asking a quick side question about the conversation so far.",
        "Answer directly and concisely in markdown from what you already know.",
        "Do not call any tools and do not take any actions.",
    ].join(" "));
    assert.equal(BTW_INSTRUCTIONS.split(" ").length > 3, true);
    assert.equal(BTW_INSTRUCTIONS.includes("\n"), false, "instructions 内部不得有换行");
});

test("buildBtwPrompt = instructions + 空行 + 问题", () => {
    const p = buildBtwPrompt("这个函数在做什么？");
    assert.equal(p, BTW_INSTRUCTIONS + "\n\n" + "这个函数在做什么？");
    // 分隔必须是两个换行（上游 join("\n\n")）
    assert.equal(p.indexOf("\n\n"), BTW_INSTRUCTIONS.length);
});

test("buildBtwPrompt 对空问题/纯空白返回空串（不发请求）", () => {
    assert.equal(buildBtwPrompt(""), "");
    assert.equal(buildBtwPrompt("   \n\t "), "");
    assert.equal(buildBtwPrompt(null), "");
    assert.equal(buildBtwPrompt(undefined), "");
});

test("buildBtwPrompt 会 trim 问题（前后空白不进 prompt）", () => {
    assert.equal(buildBtwPrompt("  hi  "), BTW_INSTRUCTIONS + "\n\n" + "hi");
});

// ============ /btw：响应信封解包 ============

test("extractBtwAnswer 解 {data:{text}}", () => {
    assert.equal(extractBtwAnswer({ data: { text: "答案" } }), "答案");
    assert.equal(extractBtwAnswer({ data: { text: "  带空白  " } }), "带空白");
});

test("extractBtwAnswer 不收裸 {text}（契约写死 data.text）", () => {
    // 对错误实现必须敏感：把「裸 text 也接受」的实现判成错
    assert.equal(extractBtwAnswer({ text: "答案" }), "");
    assert.equal(extractBtwAnswer({ data: "整段字符串" }), "整段字符串", "data 直接是字符串时按文本收");
});

test("extractBtwAnswer 对空/非法输入返回空串", () => {
    assert.equal(extractBtwAnswer(null), "");
    assert.equal(extractBtwAnswer(undefined), "");
    assert.equal(extractBtwAnswer("字符串"), "");
    assert.equal(extractBtwAnswer(42), "");
    assert.equal(extractBtwAnswer({}), "");
    assert.equal(extractBtwAnswer({ data: {} }), "");
    assert.equal(extractBtwAnswer({ data: { text: "" } }), "");
    assert.equal(extractBtwAnswer({ data: { text: 123 } }), "");
});

test("信封不符时答案为空 → 上层走失败重试，不显示空面板冒充成功", () => {
    // btwPanelState 把「非 pending + 无答案 + 失败」判成 error（有重试按钮）
    assert.equal(btwPanelState({ pending: false, answer: extractBtwAnswer({ text: "x" }), failed: true }), "error");
});

// ============ /btw：命令解析 ============

test("parseBtwCommand 命中 /btw 并取参数", () => {
    assert.equal(BTW_COMMAND, "btw");
    assert.deepEqual(parseBtwCommand("/btw 这个函数在做什么？"), { command: "btw", args: "这个函数在做什么？" });
    assert.deepEqual(parseBtwCommand("/btw  a  b  "), { command: "btw", args: "a  b" });
});

test("parseBtwCommand 无参数时返回空 args（由上层提示补问题）", () => {
    assert.deepEqual(parseBtwCommand("/btw"), { command: "btw", args: "" });
    assert.deepEqual(parseBtwCommand("/btw   "), { command: "btw", args: "" });
});

test("parseBtwCommand 不误吞其它命令与普通文本", () => {
    assert.equal(parseBtwCommand("/summarize"), null);
    assert.equal(parseBtwCommand("/revert x"), null);
    assert.equal(parseBtwCommand("btw 问题"), null, "缺少前导斜杠不是命令");
    assert.equal(parseBtwCommand("普通提问"), null);
    assert.equal(parseBtwCommand(""), null);
    assert.equal(parseBtwCommand(null), null);
    // 命令名含斜杠不算命中（与 session.js 的正则口径一致）
    assert.equal(parseBtwCommand("/foo/btw bar"), null);
});

// ============ /btw：面板状态机 ============

test("btwPanelState 优先级对齐上游 Switch：pending → error → answer", () => {
    assert.equal(btwPanelState({ pending: true, failed: true, answer: "x" }), "pending");
    assert.equal(btwPanelState({ pending: true, answer: "" }), "pending");
    assert.equal(btwPanelState({ pending: false, answer: "", failed: true }), "error");
    assert.equal(btwPanelState({ pending: false, answer: "x", failed: true }), "answer");
    assert.equal(btwPanelState({}), "empty");
    assert.equal(btwPanelState(null), "empty");
});

// ============ 键位解析与匹配 ============

test("parseKeybind 拆序列与修饰键，主键是最后一段", () => {
    const steps = parseKeybind("mod+k,mod+shift+p");
    assert.equal(steps.length, 2);
    assert.equal(steps[0].key, "k");
    assert.equal(steps[0].mod, true);
    assert.equal(steps[1].key, "p");
    assert.equal(steps[1].mod, true);
    assert.equal(steps[1].shift, true);
    assert.equal(parseKeybind("").length, 0);
    assert.equal(parseKeybind(null).length, 0);
    // 主键是最后一段：mod+alt+[ 的主键是 '['
    assert.equal(parseKeybindStep("mod+alt+[").key, "[");
});

test("mod 在 Windows/Linux 落到 ctrl", () => {
    for (const p of ["Win32", "Linux x86_64", ""]) {
        assert.equal(isMacPlatform(p), false, p);
        assert.equal(stepMatches(ev("p", { ctrl: true }), parseKeybindStep("mod+p"), false), true);
        assert.equal(stepMatches(ev("p", { meta: true }), parseKeybindStep("mod+p"), false), false);
    }
});

test("mod 在 macOS 落到 meta", () => {
    for (const p of ["MacIntel", "iPhone", "MacARM"]) {
        assert.equal(isMacPlatform(p), true, p);
        assert.equal(stepMatches(ev("p", { meta: true }), parseKeybindStep("mod+p"), true), true);
        assert.equal(stepMatches(ev("p", { ctrl: true }), parseKeybindStep("mod+p"), true), false);
    }
});

test("未声明的修饰键必须都没按，否则不得命中", () => {
    const b = parseKeybindStep("ctrl+b");
    assert.equal(stepMatches(ev("b", { ctrl: true }), b, false), true);
    assert.equal(stepMatches(ev("b", { ctrl: true, alt: true }), b, false), false, "ctrl+alt+b 不是 ctrl+b");
    assert.equal(stepMatches(ev("b", { ctrl: true, shift: true }), b, false), false);
    assert.equal(stepMatches(ev("B", { ctrl: true, shift: true }), b, false), false);
    assert.equal(stepMatches(ev("b", { ctrl: true, meta: true }), b, false), false);
    assert.equal(stepMatches(ev("b", {}), b, false), false, "没按修饰键不得命中");
    assert.equal(stepMatches(ev("c", { ctrl: true }), b, false), false);
});

test("shift 孪生键：shift+mod+' 实际等到的 event.key 是双引号", () => {
    const q = parseKeybindStep("shift+mod+'");
    assert.equal(q.shift, true);
    assert.equal(q.key, "'");
    // US 布局下 ctrl+shift+' 给出的 event.key 是 '"'
    assert.equal(stepMatches(ev('"', { ctrl: true, shift: true }), q, false), true);
    assert.equal(stepMatches(ev("'", { ctrl: true, shift: true }), q, false), true, "不给孪生的布局也认原键");
    // 不按 shift 不得命中（否则 mod+' 与 shift+mod+' 分不开）
    assert.equal(stepMatches(ev("'", { ctrl: true }), q, false), false);
});

test("shift 孪生键：shift+mod+. 实际等到的 event.key 是 >", () => {
    const d = parseKeybindStep("shift+mod+.");
    assert.equal(stepMatches(ev(">", { ctrl: true, shift: true }), d, false), true);
    assert.equal(stepMatches(ev(".", { ctrl: true }), d, false), false);
});

test("主键大小写不敏感（event.key 给 'K' 也算 'k'）", () => {
    const k = parseKeybindStep("mod+shift+p");
    assert.equal(stepMatches(ev("P", { ctrl: true, shift: true }), k, false), true);
    assert.equal(stepMatches(ev("p", { ctrl: true, shift: true }), k, false), true);
});

test("序列第二步要重新按修饰键（Ctrl+K 松开后 Ctrl+Shift+P）", () => {
    const steps = parseKeybind("mod+k,mod+shift+p");
    assert.equal(stepMatches(ev("k", { ctrl: true }), steps[0], false), true);
    // 第一步后不按修饰键直接敲 p 不应命中第二步
    assert.equal(stepMatches(ev("p", {}), steps[1], false), false);
    assert.equal(stepMatches(ev("p", { ctrl: true }), steps[1], false), false, "缺 shift");
    assert.equal(stepMatches(ev("P", { ctrl: true, shift: true }), steps[1], false), true);
});

// ============ 输入框/弹窗让位 ============

test("isEditableTarget 覆盖输入类元素与 contenteditable", () => {
    assert.equal(isEditableTarget({ tagName: "INPUT" }), true);
    assert.equal(isEditableTarget({ tagName: "TEXTAREA" }), true);
    assert.equal(isEditableTarget({ tagName: "SELECT" }), true);
    assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: true }), true);
    assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: false }), false);
    assert.equal(isEditableTarget({ tagName: "BODY" }), false);
    assert.equal(isEditableTarget(null), false);
    assert.equal(isEditableTarget({}), false);
});

test("hasOpenModal 按 .modal-overlay display:flex 判定", () => {
    const mk = (list) => ({ querySelectorAll: () => list });
    assert.equal(hasOpenModal(mk([{ style: { display: "none" } }])), false);
    assert.equal(hasOpenModal(mk([{ style: { display: "none" } }, { style: { display: "flex" } }])), true);
    assert.equal(hasOpenModal(mk([])), false);
    assert.equal(hasOpenModal(null), false);
});

// ============ 源码级结构门禁 ============

test("chat/keybinds.js 的键位表：每条 spec 都能解析、id 唯一", () => {
    const src = read(path.join("chat", "keybinds.js"));
    const block = /export const KEYBINDS = \[([\s\S]*?)\n\];/.exec(src);
    assert.ok(block, "找不到 export const KEYBINDS = [...]");
    const re = /\{\s*id:\s*'([^']+)'\s*,\s*title:\s*'([^']+)'\s*,\s*spec:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,\s*run:/g;
    const seen = [];
    let m;
    while ((m = re.exec(block[1])) !== null) {
        const id = m[1];
        const spec = unescape(m[3] != null ? m[3] : m[4]);
        assert.ok(spec.length, id + " 的 spec 不能为空");
        const steps = parseKeybind(spec);
        assert.ok(steps.length > 0, id + " 的 spec 解析不出步骤: " + spec);
        for (const s of steps) assert.ok(s.key, id + " 有一步没有主键: " + spec);
        seen.push(id);
    }
    assert.ok(seen.length >= 14, "键位表条目过少，只解析到 " + seen.length);
    assert.equal(new Set(seen).size, seen.length, "键位 id 重复: " + seen.join(","));
    // 官方表里必须有的那几条
    for (const id of ["palette.open", "session.new", "session.background", "input.focus", "file.open",
        "fileTree.toggle", "mcp.toggle", "review.toggle", "agent.cycle", "agent.cycle.reverse",
        "model.cycle", "model.cycle.reverse", "model.variant.cycle", "message.previous",
        "message.next", "tab.close"]) {
        assert.ok(seen.indexOf(id) >= 0, "键位表缺少 " + id);
    }
});

test("键位表不劫持仓内既有快捷键（Enter/Ctrl+F/Esc/↑↓/Tab）", () => {
    const src = read(path.join("chat", "keybinds.js"));
    const block = /export const KEYBINDS = \[([\s\S]*?)\n\];/.exec(src);
    const re = /\{\s*id:\s*'([^']+)'\s*,\s*title:\s*'([^']+)'\s*,\s*spec:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,\s*run:/g;
    // 既有快捷键全集（main.js / chat/search.js / cmd-palette.js / tree.js 的既有监听）
    const EXISTING = [
        ev("Enter"), ev("Enter", { ctrl: true }), ev("Enter", { shift: true }),
        ev("f", { ctrl: true }),          // chat/search.js:43 Ctrl+F 打开搜索
        ev("Escape"),                     // main.js:448 / search.js:54 / sidepanel / tree
        ev("ArrowUp"), ev("ArrowDown"),   // cmd-palette.js:170-182
        ev("Tab"), ev("Tab", { shift: true }), // cmd-palette.js:188
    ];
    let m;
    while ((m = re.exec(block[1])) !== null) {
        const id = m[1];
        const spec = unescape(m[3] != null ? m[3] : m[4]);
        const first = parseKeybind(spec)[0];
        for (const e of EXISTING) {
            for (const mac of [false, true]) {
                assert.equal(stepMatches(e, first, mac), false,
                    "键位 " + id + "（" + spec + "）与既有快捷键 " + e.key + " 冲突");
            }
        }
    }
});

test("键位表在输入框内整体让位（target 判据已接进 chat/keybinds.js）", () => {
    const src = read(path.join("chat", "keybinds.js"));
    assert.ok(src.includes("isEditableTarget(event.target)"), "监听里必须判 event.target");
    assert.ok(src.includes("hasOpenModal(document)"), "监听里必须判弹窗打开");
    // 全表只有一个 keydown 监听：不允许再散落
    assert.equal((src.match(/document\.addEventListener\('keydown'/g) || []).length, 1);
});

test("/btw 已接进命令面板与发送路径", () => {
    const palette = read(path.join("chat", "cmd-palette.js"));
    assert.ok(/\{\s*name:\s*'btw'/.test(palette), "FIXED_COMMANDS 里要有 btw");
    assert.ok(/case\s+'btw'/.test(palette), "executeFixedCmd 里要有 case 'btw'");
    assert.ok(/import\s*\{\s*askBtw\s*\}\s*from\s*'\.\/btw\.js'/.test(palette), "命令面板要引用 askBtw");

    const session = read(path.join("chat", "session.js"));
    assert.ok(/parseBtwCommand\(text\)/.test(session), "发送路径要解析 /btw");
    assert.ok(/executeFixedCmd\('btw'/.test(session), "发送路径要转交 executeFixedCmd('btw', args)");

    // /btw 的插值必须在「乐观消息」之前，否则会先闪一条假用户消息
    const idxBtw = session.indexOf("parseBtwCommand(text)");
    const idxOptimistic = session.indexOf("cacheLocalUserMessage(store.currentSessionId, localMessageId, buildParts(text));");
    assert.ok(idxBtw > 0 && idxOptimistic > 0, "两个标记点都要找得到");
    assert.ok(idxBtw < idxOptimistic, "/btw 判定必须早于乐观用户消息");
});

test("侧问面板 DOM 与样式已就位（复用既有 modal 范式）", () => {
    const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
    assert.ok(/id="btwModal"/.test(html), "缺少 #btwModal");
    assert.ok(/class="modal-overlay"\s+id="btwModal"/.test(html), "btw 面板必须用 .modal-overlay（hasOpenModal 才认）");
    assert.ok(/class="modal btw-modal"/.test(html), "btw 面板必须用 .modal（居中模态）");
    const css = fs.readFileSync(path.join(DIST, "css", "style.css"), "utf8");
    assert.ok(/\.btw-modal\s*\{/.test(css), "缺少 .btw-modal 样式");
    const btw = read(path.join("chat", "btw.js"));
    assert.ok(/bindOverlayClose\(modal,\s*hideBtwPanel\)/.test(btw), "要复用 core/utils.js 的 bindOverlayClose");
    assert.ok(/api\/experimental\/generate/.test(btw), "要打 /api/experimental/generate");
});

// ============ 跑 ============
for (const [name, fn] of tests) {
    try {
        fn();
        passed++;
        console.log("  ok   " + name);
    } catch (e) {
        console.log("  FAIL " + name + "\n       " + (e && e.message ? e.message : e));
        process.exitCode = 1;
    }
}
console.log("\n" + passed + "/" + tests.length + " 通过");
if (passed !== tests.length) process.exit(1);
