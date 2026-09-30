// 搜索结果一次最多渲染多少条供应商。
// 实测支持 key 且无凭据的集成有 224 个——一次全塞进 DOM 既没意义也卡，
// 超出的部分如实告诉用户「还有 N 条未显示」，让他们把关键字收窄。
export const CONNECTABLE_RESULT_LIMIT = 30;

// ============================================================
// 凭据面板的纯逻辑
// ============================================================
// 从 views/credentials.js 抽出，便于在 Node 下直接单测——那个文件 import 了
// apicall.js（依赖浏览器环境），无法被测试进程加载。
//
// 覆盖的都是「判错了不会报错、只会给出错误信息」的场景：
// v2 的 location 参数被忽略时不报错，凭据列表会静默变空；
// connections 为 null 时直接遍历会抛异常。

/** 描述一个连接：凭据型展示 label，env 型展示变量名 */
export function describeConnection(conn) {
    if (!conn || typeof conn !== "object") return "";
    if (conn.type === "credential") {
        return conn.label || conn.id || "未命名凭据";
    }
    if (conn.type === "env") {
        return "环境变量 " + (conn.name || "(未命名)");
    }
    return conn.type || "";
}

/** 取出可切换的凭据型连接。
 *
 *  只有 credential 型能通过 /api/credential/{id}/activate 切换；
 *  env 型是进程环境变量，V2 没有切换端点，因此不可点。 */
export function credentialConnections(conns) {
    if (!Array.isArray(conns)) return [];
    return conns.filter((c) => c && c.type === "credential" && c.id);
}

/**
 * 规整后端返回的集成列表。
 *
 * @param raw ListIntegrations 的返回值（已 JSON.parse）
 * @returns {integrations, total, shown, filtered, error, emptyReason}
 */
export function summarizeIntegrations(raw) {
    if (!raw || typeof raw !== "object") {
        return { integrations: [], total: 0, shown: 0, filtered: true, error: "服务端返回格式异常" };
    }
    if (raw.error) {
        return { integrations: [], total: 0, shown: 0, filtered: true, error: String(raw.error) };
    }

    const list = Array.isArray(raw.integrations) ? raw.integrations : [];
    // total 是服务端看到的集成总数（实测 231），list 是本次实际返回的条数。
    // 面板改拉全量后两者相等；仍保留 raw.total 以便服务端将来再收窄时口径不失真。
    const total = typeof raw.total === "number" ? raw.total : list.length;

    // 每个集成补齐 connections 数组：后端可能给 null，
    // 直接遍历会在渲染时抛异常并中断整个面板渲染。
    // methods 同样要透传——「这个供应商能不能再加一把 key」只能从它判断。
    const integrations = list.map((item) => ({
        id: item && item.id ? item.id : "",
        name: item && item.name ? item.name : (item && item.id) || "",
        connections: Array.isArray(item && item.connections) ? item.connections : [],
        methods: Array.isArray(item && item.methods) ? item.methods : [],
    }));

    const shown = integrations.length;
    const filtered = raw.filtered !== false;

    return { integrations, total, shown, filtered, error: "", emptyReason: "" };
}

/**
 * 面板顶部的说明文案。
 *
 * 三种情形各有不同说法，因为「空」的含义不同：
 *  - 全无集成：服务可能刚启动、还没扫到 provider
 *  - 有集成但都没配凭据：正常状态（都在用环境变量）
 *  - 正常有内容
 */
export function credentialsHeaderText(summary) {
    if (!summary || summary.error) return "";
    if (summary.shown > 0) {
        if (summary.filtered && summary.total > summary.shown) {
            return `仅显示已配置凭据的集成（${summary.shown} / ${summary.total} 个集成）`;
        }
        return "";
    }
    if (summary.total > 0) {
        return `没有已配置的凭据（共 ${summary.total} 个集成，均未配置）`;
    }
    return "没有已配置的凭据";
}

/**
 * 某个集成的连接行（按渲染顺序）。
 *
 * 约定：connections[0] 即当前生效的连接——这是服务端的行为，
 * 实测确认（新增的 key 会直接排到 [0]；activate 也会把目标挪到 [0]）。
 * 因此只有 index > 0 的凭据型连接才需要「切到此凭据」按钮。
 */
export function connectionRows(integration) {
    const conns = Array.isArray(integration && integration.connections) ? integration.connections : [];
    // 该供应商一共挂了几把可存管的 key（不含 env）。删一把之前要拿它兜底。
    const credCount = credentialConnections(conns).length;
    return conns.map((conn, index) => {
        const isCredential = !!conn && conn.type === "credential" && !!conn.id;
        return {
            key: (conn && conn.id) || (conn && conn.name) || String(index),
            label: describeConnection(conn),
            isCurrent: index === 0,
            // 只有非当前的凭据型连接可切换
            canSwitch: index > 0 && isCredential,
            credentialId: isCredential ? conn.id : "",
            // 可删除：必须是凭据型，且删完这个供应商还剩至少一把。
            // 不加「还剩一把」这道守卫的话，用户会为了换 key 把唯一一把删掉，
            // 结果供应商彻底没凭据可用——那正是本面板要消灭的「再填一遍」。
            canDelete: isCredential && credCount > 1,
            credentialCount: credCount,
        };
    });
}

/**
 * 该集成能否通过 connect/key 再加一把 key。
 *
 * 只能看 methods 里有没有 type === "key"——这是 v2 服务端声明的
 * 「本集成支持 key 认证」的权威字段。实测 231 个集成里 230 个有它；
 * 剩下的（如仅 oauth 的集成）给了按钮也必然失败。
 *
 * 注意：与「当前用的是不是 key」无关。openai 现在挂的是 env 变量，
 * 但它 methods 里有 key，照样能加——加完新 key 还会直接顶替成当前生效。
 */
export function supportsKeyAuth(integration) {
    const methods = Array.isArray(integration && integration.methods) ? integration.methods : [];
    return methods.some((m) => m && m.type === "key");
}

/** 某个集成是否需要展开才能看到细节。
 *
 *  现在有三种可操作动作：切换、删除、加 key。只要有一个就该能展开。
 *  （旧实现只看 canSwitch，于是「只有一个供应商但想再加一把 key」时
 *    整块折叠区根本不渲染——用户连加 key 的入口都看不到。）
 */
export function isExpandable(integration) {
    const rows = connectionRows(integration);
    return rows.some((r) => r.canSwitch || r.canDelete) || supportsKeyAuth(integration);
}

// ============================================================
// 「接入一个还没有任何凭据的供应商」
// ============================================================
//
// 后端 ListIntegrations 一直有 includeEmpty 开关，但面板写死了 false，
// 于是那 225 个没配凭据的集成被整个挡在外面：用户想接一个新供应商，
// 面板里根本没有它的位置，只能去 TUI 里 /connect。
//
// 候选口径（三条同时成立才进候选）：
//   1. 支持 key 接入（methods 含 type==="key"）
//   2. 当前一把凭据都没有（connections 里没有 credential 型）
//   3. 匹配搜索关键字
//
// 关于第 2 条要小心：集成「有 connections」不等于「有凭据」——
// 绝大多数集成挂着的是 env 型连接（读服务端进程环境变量，不入库）。
// 判据必须是「有没有 credential 型」，不是「connections 是否为空」，
// 否则像 openai（当前用 OPENAI_API_KEY 这个 env、但支持加 key）会被
// 错误地排除，用户明明可以给它再存一把 key 却看不到入口。

/** 该集成是否「还没有任何可存管的凭据」。
 *
 *  注意只数 credential 型：env 型是进程环境变量，不是凭据库里的东西。
 */
export function hasNoStoredCredential(integration) {
    return credentialConnections(integration && integration.connections).length === 0;
}

/**
 * 搜索可接入的供应商。
 *
 * 候选 = 「本面板有办法应对」且「当前没有已存凭据」的集成：
 * 支持 key 的给 key 表单；只支持 oauth/command 的给「去 TUI /connect」说明。
 * 详见下面循环里的注释（这里曾经因为只按 supportsKeyAuth 过滤而让
 * oauth-only 集成选不中，那条说明因此永远不可达）。
 *
 * @param integrations 规整后的全部集成（includeEmpty=true 的结果）
 * @param query 搜索关键字
 * @param limit 最多返回多少条（防止 200+ 条全进 DOM）
 * @returns {items, total, truncated}
 */
export function searchConnectable(integrations, query, limit) {
    const list = Array.isArray(integrations) ? integrations : [];
    const q = String(query == null ? "" : query).trim().toLowerCase();
    // limit 非法（非数字 / ≤0）→ 用默认上限；给了小数则向下取整，但**至少 1**：
    // 截断到 0 条会让「有候选却一条都不显示」，用户看到的是空列表，
    // 比「多显示几条」糟糕得多。
    const rawMax = typeof limit === "number" && isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : CONNECTABLE_RESULT_LIMIT;
    const max = rawMax >= 1 ? rawMax : 1;

    // 空关键字时列出全部候选（受 limit 约束）；有关键字时按 id/name 过滤。
    // id 与 name 都要匹配：供应商 id 常带前缀（opencode-go），
    // 而用户心里的名字是 name（OpenCode Go），只匹配一边会漏。
    //
    // 候选判据是「**本面板有办法应对**」，不是「支持 key」：
    //   - 支持 key → 选中后给 key 表单
    //   - 只支持 oauth/command → 选中后给「去 TUI 用 /connect」的说明
    // 两类都要列。早期版本按 supportsKeyAuth 过滤，结果 github-copilot
    // （实测唯一 methods 仅 env+oauth 的集成）永远选不中，那条 /connect
    // 说明也就永远显示不出来——等于把「OAuth 给出说明」这个决定架空。
    // 官方 /connect 的形态同样是先列出集成、再选接入方法，此处与之一致。
    // 两类都不支持的（既无 key 也无 oauth/command）才排除：给不出任何动作。
    const matched = [];
    for (const it of list) {
        if (!it) continue;
        if (connectMethod(it) === "") continue;
        if (!hasNoStoredCredential(it)) continue;
        if (q && !integrationMatches(it, q)) continue;
        matched.push(it);
    }

    const total = matched.length;
    return {
        items: matched.slice(0, max),
        total,
        truncated: total > max,
    };
}

/** id / name 是否命中关键字（调用方传小写、已 trim 的 q）。 */
function integrationMatches(integration, lowerQuery) {
    const id = String((integration && integration.id) || "").toLowerCase();
    const name = String((integration && integration.name) || "").toLowerCase();
    return id.includes(lowerQuery) || name.includes(lowerQuery);
}

/** 该集成的接入方式提示：给 key 表单、还是让用户去 TUI。
 *
 * 返回 "key" 表示可以填 key；返回 "oauth" 表示只能用 OAuth/Command 接入，
 * 这时**不能**给 key 表单——官方口径是 OAuth 走浏览器 URL / 设备码 / 授权码，
 * 由 TUI 的 /connect 驱动，服务端对应 connect/oauth 端点，需要 attemptID
 * 往返与人工交互，本面板没有承载它的交互面。
 *
 * 注意 key 与 oauth 同时存在时必须返回 "key"：官方明确说
 * 「Saved API keys ... take precedence」，key 是合法接入路径，
 * 不能因为「它也能 oauth」就把加 key 的入口拦掉。实测 6 个集成同时支持两者
 * （openai / opencode / xai / poe / digitalocean / snowflake-cortex）。
 */
export function connectMethod(integration) {
    if (supportsKeyAuth(integration)) return "key";
    const methods = Array.isArray(integration && integration.methods) ? integration.methods : [];
    const hasNonKey = methods.some((m) => m && (m.type === "oauth" || m.type === "command"));
    return hasNonKey ? "oauth" : "";
}

/** 搜索无命中时给用户的一句话。
 *
 * 区分「没搜到」和「搜到了但都被过滤掉了」：后者是本面板的候选规则
 * （只列支持 key 且无凭据的）造成的，用户会以为是自己输错了。
 */
export function connectEmptyText(result, query) {
    const q = String(query == null ? "" : query).trim();
    if (!result || !Array.isArray(result.items)) return "无法搜索供应商";
    if (result.total > 0) return "";
    if (q) return `没有匹配「${q}」且支持用 API Key 接入的供应商`;
    return "没有可用 API Key 接入的供应商";
}
