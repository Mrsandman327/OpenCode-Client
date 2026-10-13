// ============================================================
// OC Manager - /btw 侧问面板（一次性回答，不写入会话历史）
// ============================================================
// 依赖：core/apicall.js（api）、core/state.js（store）、
//       core/utils.js（showToast/escapeHtml/bindOverlayClose）、
//       core/btw.js（纯逻辑：prompt 构建 / 答案提取 / 命令解析 / 端点）、
//       core/sanitize.js（sanitizeMarkedHtml，与消息区同款渲染口径）。
//
// 交互（在 OpenCode-Client PR #9 基础上按需求改进）：
//   - 关闭（遮罩 / ✕）= 只隐藏：任务与结果保留（PR 原版关闭即清空、无恢复入口）；
//   - 关闭后面板位置出现「悬浮按钮」：生成中外圈转圈、完成亮绿点；点击重开；
//   - 悬浮按钮右上角小 ✕ = 完全关闭并清除数据；
//   - 生成完成时若面板未打开 → toast 提醒（悬浮按钮同步亮绿点）；
//   - 答案绝不写入会话历史：请求打 /api/session/{id}/generate（无状态于历史），
//     响应只进本面板 DOM，全程不碰消息缓存与 loadMessages。
// ============================================================

import { api } from '../core/apicall.js';
import { store } from '../core/state.js';
import { showToast, showApiError, escapeHtml, bindOverlayClose } from '../core/utils.js';
import { buildBtwPrompt, extractBtwAnswer, parseBtwCommand, btwEndpoint } from '../core/btw.js';
import { sanitizeMarkedHtml } from '../core/sanitize.js';

/** 面板状态（一问一答，只保留一份）。
 *  visible 与任务状态分离：关闭只改 visible，不清 pending/answer/failed。 */
const btwState = {
    /** 当前问题（重试时原样重发） */
    question: '',
    /** 答案文本；空串表示「还没有可用答案」 */
    answer: '',
    /** 请求在飞行中 */
    pending: false,
    /** 上一次请求失败（无答案且已结束 → 显示重试） */
    failed: false,
    /** 面板当前是否可见（关闭 = 仅隐藏，悬浮按钮接管入口） */
    visible: false,
};

function btwModal() {
    return document.getElementById('btwModal');
}

function btwFloat() {
    return document.getElementById('btwFloat');
}

/** 渲染面板线程（会话区卡片口径：用户问题靠右 / 助手回答靠左）。
 *  四态互斥，优先级：pending → answer → error → 空。 */
function renderBtwPanel() {
    const modal = btwModal();
    if (!modal) return;
    const thread = modal.querySelector('#btwThread');
    if (!thread) return;

    let html = '';
    // 用户卡（靠右）——复用消息区 .oc-message.user 的对齐与配色
    if (btwState.question) {
        html += '<div class="oc-message user">'
            + '<div class="oc-message-role">用户</div>'
            + '<div class="oc-message-parts"><div class="oc-part oc-text">' + escapeHtml(btwState.question) + '</div></div>'
            + '</div>';
    }
    // 助手卡（靠左）
    if (btwState.pending) {
        html += '<div class="oc-message assistant">'
            + '<div class="oc-message-role">助手</div>'
            + '<div class="oc-message-parts"><div class="oc-part pending">正在生成一次性回答…</div></div>'
            + '</div>';
    } else if (btwState.answer) {
        // 与消息区同款渲染口径（oc-part oc-text + marked + sanitizeMarkedHtml）
        const answerHtml = typeof marked !== 'undefined'
            ? sanitizeMarkedHtml(marked.parse(btwState.answer, { breaks: true }))
            : '<pre>' + escapeHtml(btwState.answer) + '</pre>';
        html += '<div class="oc-message assistant">'
            + '<div class="oc-message-role">助手</div>'
            + '<div class="oc-message-parts"><div class="oc-part oc-text btw-answer">' + answerHtml + '</div></div>'
            + '</div>';
    } else if (btwState.failed) {
        html += '<div class="oc-message assistant">'
            + '<div class="oc-message-role">助手</div>'
            + '<div class="oc-message-parts"><div class="oc-part error-msg">没能回答这个问题</div></div>'
            + '</div>';
    }
    if (!html) html = '<div class="oc-empty">请输入一个问题</div>';
    thread.innerHTML = html;

    // 长答案立即可见：滚动到线程底部
    const body = modal.querySelector('.modal-body');
    if (body) body.scrollTop = body.scrollHeight;

    // 重试按钮只在「失败且无答案」时出现（对齐 PR 口径）
    const retry = modal.querySelector('.btw-retry');
    if (retry) retry.style.display = (btwState.failed && !btwState.pending && !btwState.answer) ? '' : 'none';
    // 复制按钮只在有答案时出现
    const copy = modal.querySelector('.btw-copy');
    if (copy) copy.style.display = btwState.answer ? '' : 'none';
}

/** 悬浮按钮（首次使用时动态创建，固定定位在消息区右下、输入区上方）。 */
function ensureBtwFloat() {
    let f = btwFloat();
    if (f) return f;
    f = document.createElement('div');
    f.id = 'btwFloat';
    f.className = 'btw-float';
    f.style.display = 'none';
    f.innerHTML = '<button type="button" class="btw-float-main" title="打开侧问">'
        + '<span class="btw-float-icon">💬</span>'
        + '<span class="btw-float-spinner"></span>'
        + '<span class="btw-float-dot" style="display:none"></span>'
        + '</button>'
        + '<button type="button" class="btw-float-close" title="完全关闭并清除侧问">✕</button>';
    // 与「回到会话底部」按钮同容器同基准（.oc-messages-wrap 是其 absolute 定位基准），
    // 两个按钮垂直堆叠：侧问在上（bottom:54）、回底在下（bottom:12）。
    const host = document.querySelector('.oc-messages-wrap') || document.body;
    host.appendChild(f);
    return f;
}

/** 同步悬浮按钮外观：生成中外圈转圈；完成亮绿点。 */
function renderBtwFloat() {
    const f = btwFloat();
    if (!f) return;
    f.classList.toggle('processing', !!btwState.pending);
    const dot = f.querySelector('.btw-float-dot');
    if (dot) dot.style.display = (!btwState.pending && btwState.answer) ? '' : 'none';
    const main = f.querySelector('.btw-float-main');
    if (main) {
        main.title = btwState.pending
            ? '打开侧问（生成中…）'
            : (btwState.answer ? '打开侧问（有新回答）' : '打开侧问');
    }
}

/** 可见性联动：面板开 → 悬浮隐藏；面板关且存在任务（生成中/有结果/失败）→ 悬浮显示。 */
function refreshFloatVisibility() {
    const f = ensureBtwFloat();
    const hasTask = !!(btwState.pending || btwState.answer || btwState.failed);
    f.style.display = (!btwState.visible && hasTask) ? '' : 'none';
    renderBtwFloat();
}

/** 关闭面板 = 只隐藏（任务与结果保留；悬浮按钮接管常驻入口）。 */
export function hideBtwPanel() {
    btwState.visible = false;
    const modal = btwModal();
    if (modal) modal.style.display = 'none';
    refreshFloatVisibility();
}

/** 完全关闭 + 清除数据（悬浮按钮右上角小 ✕ 调用）。 */
export function discardBtw() {
    btwState.question = '';
    btwState.answer = '';
    btwState.pending = false;
    btwState.failed = false;
    btwState.visible = false;
    const modal = btwModal();
    if (modal) modal.style.display = 'none';
    renderBtwPanel(); // 同步清空面板 DOM 残留（下次打开显示「请输入一个问题」）
    refreshFloatVisibility();
    showToast('侧问已关闭，内容已清除', 'info');
}

/** 打开（或从悬浮按钮恢复）面板。 */
export function openBtwPanel() {
    btwState.visible = true;
    renderBtwPanel();
    const modal = btwModal();
    if (modal) modal.style.display = 'flex';
    refreshFloatVisibility();
    return true;
}

/** 是否有进行中或已完成的侧问（命令面板 case 'btw' 无参数时用来决定「重开」还是「放回输入框」）。 */
export function hasActiveBtw() {
    return !!(btwState.pending || btwState.answer || btwState.failed);
}

/** 发起（或重试）一次侧问。question 为空时用当前问题（重试路径）。 */
export async function generateBtw(question) {
    const q = (question == null ? '' : String(question)).trim() || btwState.question;
    const prompt = buildBtwPrompt(q);
    if (!prompt) {
        showToast('请在 /btw 后输入问题', 'error');
        return;
    }
    const sid = store.currentSessionId;
    if (!sid) {
        showToast('请先选择会话', 'error');
        return;
    }
    btwState.question = q;
    btwState.pending = true;
    btwState.failed = false;
    btwState.answer = '';
    renderBtwPanel();
    refreshFloatVisibility();

    try {
        // 契约（本机 opencode 2.0.26 openapi 核对）：
        // POST /api/session/{id}/generate，body {prompt} →
        // 200 {"data":{"text":"..."}}。服务端描述「Generate transient text from
        // the current session context without mutating session history」。
        const res = await api.OpenCodeCall('POST', btwEndpoint(sid), { prompt });
        const text = extractBtwAnswer(res);
        // 请求成功但信封不对 / 空文本：同样按失败处理并允许重试（不「假装成功」）。
        if (!text) throw new Error('响应中没有可用文本');
        btwState.answer = text;
        btwState.failed = false;
    } catch (e) {
        btwState.answer = '';
        btwState.failed = true;
        // 错误展示统一走 showApiError（→ v2compat.formatApiError）：
        // 解析 v2 错误体的 message、压空白并截断，避免直接拼 e.message 糊一屏 JSON。
        showApiError('侧问失败: ', e);
    } finally {
        btwState.pending = false;
        renderBtwPanel();
        refreshFloatVisibility();
        // 面板关着完成 → 提醒（悬浮按钮已同步亮绿点）
        if (!btwState.visible && btwState.answer) {
            showToast('侧问已完成——点右下角悬浮按钮查看', 'success');
        }
    }
}

/**
 * /btw 入口：命令面板选「btw」或输入框 `/btw <问题>` 时调用。
 * @param {string} question 用户问题（/btw 后面的内容）
 */
export async function askBtw(question) {
    const q = (question == null ? '' : String(question)).trim();
    if (!q) {
        showToast('请在 /btw 后输入问题', 'error');
        return;
    }
    openBtwPanel();
    await generateBtw(q);
}

/** 复制答案到剪贴板（面板头部按钮）。 */
async function copyBtwAnswer() {
    if (!btwState.answer) return;
    try {
        await navigator.clipboard.writeText(btwState.answer);
        showToast('已复制回答', 'success');
    } catch (_) {
        showToast('复制失败', 'error');
    }
}

/** 绑定面板与悬浮按钮事件（幂等：重复调用不重复绑）。由 main.js 启动时调用。 */
export function bindBtwPanelEvents() {
    ensureBtwFloat();
    const modal = btwModal();
    if (modal && !modal.dataset.eventsBound) {
        modal.dataset.eventsBound = '1';
        const close = modal.querySelector('.btw-close');
        if (close) close.addEventListener('click', hideBtwPanel);
        const copy = modal.querySelector('.btw-copy');
        if (copy) copy.addEventListener('click', copyBtwAnswer);
        const retry = modal.querySelector('.btw-retry');
        if (retry) retry.addEventListener('click', function () { generateBtw(btwState.question); });
        // 点遮罩关闭 = 只隐藏（与 PR 的 bindOverlayClose 行为兼容）
        bindOverlayClose(modal, hideBtwPanel);
    }
    const f = btwFloat();
    if (f && !f.dataset.eventsBound) {
        f.dataset.eventsBound = '1';
        const main = f.querySelector('.btw-float-main');
        if (main) main.addEventListener('click', function () {
            if (btwState.pending || btwState.answer || btwState.failed) openBtwPanel();
        });
        const close = f.querySelector('.btw-float-close');
        if (close) close.addEventListener('click', function (e) {
            e.stopPropagation();
            discardBtw();
        });
    }
}
