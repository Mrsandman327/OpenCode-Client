// ============================================================
// 权限请求处理
// 收到 OpenCode 的 permission.asked / permission.v2.asked 事件时弹窗，
// 提供 允许一次 / 始终允许 / 拒绝 三种响应。
// v1：POST /permission/{id}/reply  { reply: once|always|reject }
// v2：POST /api/session/{sid}/permission/{id}/reply  { reply: ... }
// 兜底：POST /session/{sid}/permissions/{id}  { response: ... }（旧接口）
// ============================================================

import { store } from '../core/state.js';
import { api } from '../core/apicall.js';
import { escapeHtml, showToast } from '../core/utils.js';

/** 待处理的权限请求队列 */
let pendingQueue = [];
/** 当前正在弹层显示的权限请求 */
let currentPermission = null;

/**
 * 展示权限请求弹窗。
 * 兼容 v1（permission.asked：permission/patterns）与 v2（permission.v2.asked：action/resources）。
 * @param {object} props 事件 properties（含 id/sessionID/action|permission/resources|patterns）
 */
// 权限类型 → 中文描述（参考图「访问项目目录之外的文件」风格）
const ACTION_LABEL = {
    read: '读取文件',
    edit: '编辑文件',
    write: '写入文件',
    bash: '执行命令',
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

export function showPermissionRequest(props) {
    const id = props.id || props.requestID || props.permissionID;
    const sessionID = props.sessionID || props.sessionId || store.currentSessionId;
    if (!id) return;
    // 仅处理当前激活会话的权限请求：避免其他 tab、未打开会话（如网页端操作的会话）的请求打扰当前用户
    if (sessionID && sessionID !== store.currentSessionId) return;
    const action = props.action || props.permission || props.type || 'tool';
    const resources = props.resources || props.patterns || [];
    const isV2 = Array.isArray(props.resources); // v2 用 action/resources，v1 用 permission/patterns
    // 已在队列中（重复事件）则忽略
    if (pendingQueue.some(r => r.id === id)) return;
    pendingQueue.push({ id, sessionID, isV2, action, resources });

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
    document.getElementById('permissionInfo').textContent = ACTION_LABEL[req.action] || req.action;
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
    const body = { reply };
    try {
        if (p.isV2) {
            await api.OpenCodeCall('POST', `/api/session/${encodeURIComponent(p.sessionID)}/permission/${encodeURIComponent(p.id)}/reply`, body);
        } else {
            await api.OpenCodeCall('POST', `/permission/${encodeURIComponent(p.id)}/reply`, body);
        }
        pendingQueue = pendingQueue.filter(r => r.id !== p.id);
        showNextPermission();
        showToast(reply === 'always' ? '已始终允许' : (reply === 'reject' ? '已拒绝' : '已允许一次'), 'success');
    } catch (e) {
        // v1/v2 接口失败时兜底尝试旧接口
        try {
            await api.OpenCodeCall('POST', `/session/${encodeURIComponent(p.sessionID)}/permissions/${encodeURIComponent(p.id)}`, { response: reply });
            pendingQueue = pendingQueue.filter(r => r.id !== p.id);
            showNextPermission();
            showToast('已响应权限请求', 'success');
        } catch (e2) {
            showToast('权限响应失败: ' + (e2.message || e2), 'error');
        }
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
