// 静态门禁：禁止 V1 API 路径残留。
//
// 背景：v2 把路径收拢到 /api/*，且对未注册路径返回 200 + text/html（SPA 兜底），
// 因此残留一个 v1 路径不会报错，只会静默失效（fork 就是这样漏掉的）。
// 这里做纯文本扫描，命中即失败。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "frontend", "dist");
const SRC = path.join(HERE, "..", "service");

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "lib" && e.name !== "bindings") walk(p, out); }
        else if (e.name.endsWith(".js") || e.name.endsWith(".go")) out.push(p);
    }
    return out;
}

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };

// ===== 1) 前端：OpenCodeAPI / OpenCodeCall 的第一个路径参数必须是 /api 或白名单 =====
const WHITELIST = ["/openapi.json", "/api/", "/events", "/api/app-call"];

console.log("=== 前端 OpenCodeAPI/OpenCodeCall 路径 ===");
for (const f of walk(DIST)) {
    const rel = path.relative(DIST, f);
    const src = fs.readFileSync(f, "utf8");
    // 匹配 OpenCodeCall('M', `path`  与 OpenCodeAPI('M', `path`
    const re = /OpenCode(?:Call|API)\(\s*['"][A-Z]+['"]\s*,\s*[`'"]([^`'"]+)[`'"]/g;
    for (const m of src.matchAll(re)) {
        const p = m[1];
        if (p.startsWith("/api/") || p === "/api") continue;
        if (WHITELIST.some(w => p === w || p.startsWith(w))) continue;
        fail(`${rel}: 残留 V1 路径 ${p}`);
    }
    // 模板字符串里拼接的目录也检查前缀
    for (const m of src.matchAll(/OpenCode(?:Call|API)\(\s*['"][A-Z]+['"]\s*,\s*`([^`]*\$\{[^`]*)`/g)) {
        if (!m[1].startsWith("/api/") && !m[1].startsWith("/api`")) {
            fail(`${rel}: 模板路径未以 /api 开头 -> ${m[1].slice(0, 60)}`);
        }
    }
}

// ===== 2) Go：拼接 opencode 服务路径的地方 =====
// 只扫 opencode 服务包——service/filebrowser 等包里的 base 是本地文件路径，与 API 无关。
const API_PKGS = [path.join(SRC, "opencode")];
console.log("=== Go 侧服务路径（service/opencode） ===");
for (const pkg of API_PKGS) {
    for (const f of walk(pkg)) {
        const rel = path.relative(path.join(HERE, ".."), f);
        const src = fs.readFileSync(f, "utf8");
        for (const m of src.matchAll(/base\s*\+\s*"(\/[^"]*)"/g)) {
            const p = m[1];
            if (p.startsWith("/api/") || p === "/api") continue;
            fail(`${rel}: base + "${p}" 不是 /api 路径`);
        }
        for (const m of src.matchAll(/"http:\/\/%s:%d(\/[^"]*)"/g)) {
            const p = m[1];
            if (p.startsWith("/api/") || p === "/api") continue;
            fail(`${rel}: 绝对 URL 路径 "${p}" 不是 /api 路径`);
        }
    }
}

// ===== 3) 已移除的端点（V2 明确没有）=====
console.log("=== V2 已移除的端点 ===");
const REMOVED = {
    "/global/event": "V2 改为 /api/event",
    "/global/health": "V2 改为 /api/info",
    "/question": "V2 改为表单 API /api/form",
    "/lsp": "V2 不运行语言服务器，已移除",
    "/doc": "V2 改为 /openapi.json",
};
for (const f of [...walk(DIST), ...walk(SRC)]) {
    const rel = path.relative(path.join(HERE, ".."), f);
    const src = fs.readFileSync(f, "utf8");
    for (const [ep, why] of Object.entries(REMOVED)) {
        // 只在「作为请求路径」时告警：出现在注释里不算
        const re = new RegExp("(OpenCode(?:Call|API)\\([^)]*['\"`]" + ep + "|base\\s*\\+\\s*['\"]" + ep + ")");
        if (re.test(src)) fail(`${rel}: 仍请求已移除端点 ${ep}（${why}）`);
    }
}

if (failures === 0) {
    console.log("\n  ok   未发现 V1 路径残留");
    console.log("\nSTATIC GATE PASS");
} else {
    console.log(`\nSTATIC GATE FAIL（${failures} 项）`);
}
process.exit(failures === 0 ? 0 : 1);
