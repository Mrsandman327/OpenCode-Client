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
    const total = typeof raw.total === "number" ? raw.total : list.length;

    // 每个集成补齐 connections 数组：后端可能给 null，
    // 直接遍历会在渲染时抛异常并中断整个面板渲染。
    const integrations = list.map((item) => ({
        id: item && item.id ? item.id : "",
        name: item && item.name ? item.name : (item && item.id) || "",
        connections: Array.isArray(item && item.connections) ? item.connections : [],
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
 * 实测确认。因此只有 index > 0 的凭据型连接才需要「切到此凭据」按钮。
 */
export function connectionRows(integration) {
    const conns = Array.isArray(integration && integration.connections) ? integration.connections : [];
    return conns.map((conn, index) => ({
        key: (conn && conn.id) || (conn && conn.name) || String(index),
        label: describeConnection(conn),
        isCurrent: index === 0,
        // 只有非当前的凭据型连接可切换
        canSwitch: index > 0 && !!conn && conn.type === "credential" && !!conn.id,
        credentialId: conn && conn.type === "credential" ? conn.id : "",
    }));
}
