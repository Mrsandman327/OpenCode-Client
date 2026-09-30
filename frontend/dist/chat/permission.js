// ============================================================
// 权限请求处理
// 收到 OpenCode 的 permission.asked 事件时弹窗，
// 提供 允许一次 / 始终允许 / 拒绝 三种响应。
// 子任务（subagent）运行在独立子会话中，其权限事件的 sessionID 是子会话 ID，
// 需回溯 parentID 链确认属于当前会话后才弹窗（标注「子任务权限」）。
// 响应（OpenCode v2）：POST /api/session/{sid}/permission/{id}/reply
//   { decision: once|always|reject }
// v1 的全局 /permission/{id}/reply 与 /session/{sid}/permissions/{id} 均已移除。
// ============================================================

import { store } from '../core/state.js';
import { api } from '../core/apicall.js';
import { escapeHtml, showToast } from '../core/utils.js';
import { unwrap } from '../core/v2compat.js';

/** 待处理的权限请求队列 */
let pendingQueue = [];
/** 当前正在弹层显示的权限请求 */
let currentPermission = null;

/**
 * 会话 parentID 链回溯结果缓存：sessionID → { ok, refSession }
 * ok=是否属于判定时的激活会话（refSession）。会话切换后缓存失效，避免跨会话误判。
 * 避免每个权限请求都重复查询 /session/{sid}
 */
const descendantCache = new Map();

/**
 * 判断 sessionID 是否属于当前激活会话（自身或其子任务子会话）。
 * 通过 GET /session/{sid} 获取 parentID 逐级上溯，直到命中当前会话或链头。
 * @param {string} sessionID 待判断的会话 ID
 * @returns {Promise<boolean>}
 */
async function isDescendantOfCurrent(sessionID) {
    const refSession = store.currentSessionId;
    const cached = descendantCache.get(sessionID);
    // 缓存仅在同一激活会话下有效：切换会话后重新判定
    if (cached && cached.refSession === refSession) return cached.ok;
    let sid = sessionID;
    let depth = 0;
    // 防御：链深上限，防止异常数据导致死循环
    while (sid && depth < 10) {
        if (sid === refSession) {
            descendantCache.set(sessionID, { ok: true, refSession });
            return true;
        }
        // 中间节点命中缓存则直接复用结论（同样校验 refSession）
        const mid = descendantCache.get(sid);
        if (mid && mid.refSession === refSession) {
            descendantCache.set(sessionID, { ok: mid.ok, refSession });
            return mid.ok;
        }
        try {
            const res = await api.OpenCodeCall('GET', `/api/session/${encodeURIComponent(sid)}`);
            const info = unwrap(res);
            const parent = info && info.parentID;
            if (!parent) break; // 无父级 → 已到链头，非当前会话后代
            sid = parent;
        } catch {
            break; // 查询失败（会话已删等）→ 视为非当前会话后代
        }
        depth++;
    }
    descendantCache.set(sessionID, { ok: false, refSession });
    return false;
}

// 权限类型 → 中文描述（参考图「访问项目目录之外的文件」风格）
const ACTION_LABEL = {
    read: '读取文件',
    edit: '编辑文件',
    write: '写入文件',
    bash: '执行命令',
    // v2 权限动作改名：bash→shell、task→subagent（旧的保留，兼容混合版本）
    shell: '执行命令',
    subagent: '运行子任务',
    // v2 新增：patch 面向支持它的 GPT 模型，其余模型仍用 edit/write；
    // execute 是 Code Mode 运行时（权限动作为 execute，resource 为 *）
    patch: '批量修改文件',
    execute: '执行代码模式',
    webfetch: '发起网络请求',
    websearch: '发起网络搜索',
    lsp: '调用语言服务',
    task: '运行子任务',
    todowrite: '更新待办事项',
    question: '发起提问',
    skill: '使用技能',
    glob: '搜索文件',
    grep: '内容搜索',
    list: '列出文件',
    external_directory: '访问外部目录',
};

/**
 * 展示权限请求弹窗。
 * 兼容 v1（permission.asked：permission/patterns）与 v2（permission.v2.asked：action/resources）。
 * 仅处理当前激活会话及其子任务子会话的权限请求：避免其他 tab、未打开会话（如网页端操作的会话）的请求打扰当前用户。
 * @param {object} props 事件 properties（含 id/sessionID/action|permission/resources|patterns）
 */
export async function showPermissionRequest(props) {
    const id = props.id || props.requestID || props.permissionID;
    const sessionID = props.sessionID || props.sessionId || store.currentSessionId;
    if (!id) return;
    // 非当前会话的请求：回溯 parentID 链，仅当属于当前会话的子任务时继续
    let isSubtask = false;
    if (sessionID && sessionID !== store.currentSessionId) {
        const isDescendant = await isDescendantOfCurrent(sessionID);
        if (!isDescendant) return;
        isSubtask = true;
    }
    const action = props.action || props.permission || props.type || 'tool';
    const resources = props.resources || props.patterns || [];
    // 已在队列中（重复事件）则忽略
    if (pendingQueue.some(r => r.id === id)) return;
    pendingQueue.push({ id, sessionID, isSubtask, action, resources });

    const modal = document.getElementById('permissionModal');
    if (!modal) {
        // 弹层未挂载时降级为 toast 提示
        showToast('权限请求: ' + action, 'warning');
        return;
    }
    // 弹层空闲（未显示且无当前项）→ 显示队列中第一个待处理项
    if (!currentPermission) showNextPermission();
}

/** 显示队列中下一个待处理的权限请求；队列空则关闭弹层 */
function showNextPermission() {
    if (!pendingQueue.length) {
        closePermissionModal();
        return;
    }
    const req = pendingQueue[0];
    currentPermission = req;
    const modal = document.getElementById('permissionModal');
    if (!modal) return;
    const actionLabel = ACTION_LABEL[req.action] || req.action;
    document.getElementById('permissionInfo').textContent = req.isSubtask
        ? '子任务权限: ' + actionLabel
        : actionLabel;
    const resBox = document.getElementById('permissionResources');
    resBox.innerHTML = req.resources.length
        ? req.resources.map(r => '<div class="oc-perm-res">' + escapeHtml(r) + '</div>').join('')
        : '<div class="oc-perm-res muted">（无特定资源）</div>';
    modal.style.display = 'flex';
}

/**
 * 响应权限请求。
 * @param {string} reply once | always | reject
 */
export async function respondPermission(reply) {
    const p = currentPermission;
    if (!p) return;
    try {
        // v2 只提供按会话的回复端点（v1 的全局 /permission/{id}/reply 已移除）：
        // POST /api/session/{id}/permission/{requestID}/reply，请求体字段为 decision 而非 reply。
        // 枚举值 once / always / reject 与 v2 的 Permission.Reply 一致，无需转换。
        await api.OpenCodeCall(
            'POST',
            `/api/session/${encodeURIComponent(p.sessionID)}/permission/${encodeURIComponent(p.id)}/reply`,
            { decision: reply }
        );
        pendingQueue = pendingQueue.filter(r => r.id !== p.id);
        showNextPermission();
        showToast(reply === 'always' ? '已始终允许' : (reply === 'reject' ? '已拒绝' : '已允许一次'), 'success');
    } catch (e) {
        pendingQueue = pendingQueue.filter(r => r.id !== p.id);
        showNextPermission();
        showToast('权限响应失败: ' + (e.message || e), 'error');
    }
}

/**
 * 关闭权限请求弹层。
 * 带 requestID（replied 事件）时：从队列移除该请求；若正是当前显示的项则处理下一个。
 * 不带参数：清空队列并关闭（会话切换等场景）。
 */
export function closePermissionModal(requestID) {
    if (requestID) {
        pendingQueue = pendingQueue.filter(r => r.id !== requestID);
        if (currentPermission && currentPermission.id === requestID) {
            currentPermission = null;
            showNextPermission();
        }
        return;
    }
    pendingQueue = [];
    currentPermission = null;
    const modal = document.getElementById('permissionModal');
    if (modal) modal.style.display = 'none';
}
