// ============================================================
// OpenCode 管理中心 - /btw 侧问面板（一次性回答，不写入会话历史）
// ============================================================
// 依赖：core/apicall.js（api）、core/state.js（store）、
//       core/utils.js（showToast, escapeHtml, bindOverlayClose）、
//       core/btw.js（buildBtwPrompt, extractBtwAnswer, btwPanelState）、
//       chat/render.js（sanitizeMarkedHtml）
//
// 交互语义对齐上游 btw-panel.tsx，但**不移植它的框架**（op 没有
// store/tab/layout.open 那套多 tab 能力），因此做成一问一答的单面板：
// 新问题直接替换旧问答，不做多 tab 堆积。
//
// 与普通 prompt 的本质区别：**答案绝不写入会话历史**。这里的「不写入」不是
// 「写完再隐藏」，而是根本走不到会话消息流——请求打的是无状态的
// /api/experimental/generate，响应只进本面板 DOM，全程不调 loadMessages /
// renderMessages，也不动 store.messageCache。
// ============================================================

import { api } from '../core/apicall.js';
import { store } from '../core/state.js';
import { showToast, escapeHtml, bindOverlayClose } from '../core/utils.js';
import { buildBtwPrompt, extractBtwAnswer, btwPanelState } from '../core/btw.js';
import { sanitizeMarkedHtml } from './render.js';

/** 面板状态（一问一答，故只保留一份）。 */
const btwState = {
    /** 当前问题（重试时要原样重发） */
    question: '',
    /** 答案文本；空串表示「还没有可用答案」 */
    answer: '',
    /** 请求在飞行中 */
    pending: false,
    /** 上一次请求失败（无答案且已结束 → 显示重试） */
    failed: false,
};

/** 取面板元素（不存在返回 null：老页面/裁剪过的 DOM 下不应抛错） */
function btwModal() {
    return document.getElementById('btwModal');
}

/**
 * 渲染面板。四个态互斥，优先级与上游 btw-panel.tsx 的 <Switch> 一致：
 * pending → error → answer → 空。
 */
function renderBtwPanel() {
    const modal = btwModal();
    if (!modal) return;

    // 头部问题条：问题为空（尚未提问）时隐藏整块
    const head = modal.querySelector('.btw-question');
    if (head) {
        if (btwState.question) {
            head.textContent = btwState.question;
            head.title = btwState.question;
            head.style.display = '';
        } else {
            head.style.display = 'none';
        }
    }

    const body = modal.querySelector('.btw-body');
    const state = btwPanelState(btwState);
    if (body) {
        if (state === 'pending') {
            body.innerHTML = '<div class="oc-empty">正在生成一次性回答…</div>';
        } else if (state === 'error') {
            body.innerHTML = '<div class="oc-empty">没能回答这个问题</div>';
        } else if (state === 'answer') {
            // 复用消息区的 markdown 渲染口径：marked + sanitizeMarkedHtml（洗脚本/事件属性）
            const el = document.createElement('div');
            el.className = 'oc-part oc-text btw-answer';
            el.innerHTML = typeof marked !== 'undefined'
                ? sanitizeMarkedHtml(marked.parse(btwState.answer, { breaks: true }))
                : '<pre>' + escapeHtml(btwState.answer) + '</pre>';
            body.innerHTML = '';
            body.appendChild(el);
        } else {
            body.innerHTML = '<div class="oc-empty">请输入一个问题</div>';
        }
    }

    // 重试按钮只在「失败且无答案」时出现（上游：无答案且不在 pending 即 error 态）
    const retry = modal.querySelector('.btw-retry');
    if (retry) retry.style.display = state === 'error' ? '' : 'none';
    // 复制按钮只在有答案时出现
    const copy = modal.querySelector('.btw-copy');
    if (copy) copy.style.display = state === 'answer' ? '' : 'none';
}

/** 打开面板 */
function openBtwPanel() {
    const modal = btwModal();
    if (!modal) {
        showToast('侧问面板不可用（缺少 #btwModal）', 'error');
        return false;
    }
    renderBtwPanel();
    modal.style.display = 'flex';
    return true;
}

/** 关闭面板（问答内容随之丢弃：与上游「关 tab 即忘掉」同口径） */
export function hideBtwPanel() {
    const modal = btwModal();
    if (modal) modal.style.display = 'none';
    btwState.question = '';
    btwState.answer = '';
    btwState.pending = false;
    btwState.failed = false;
}

/** 发起（或重发）一次侧问。question 为空时用当前问题（重试路径）。 */
async function generateBtw(question) {
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

    try {
        // 契约（已实测本机 opencode 2.0.26 /api/experimental/generate）：
        // body {sessionID, prompt} → 200 {"data":{"text":"..."}}
        const res = await api.OpenCodeCall('POST', '/api/experimental/generate', { sessionID: sid, prompt });
        const text = extractBtwAnswer(res);
        // 请求成功但信封不对 / 空文本：同样按失败处理并允许重试。
        // 不「假装成功」显示空面板——那与失败无法区分，用户不知道该不该重试。
        if (!text) throw new Error('响应中没有可用文本');
        btwState.answer = text;
        btwState.failed = false;
    } catch (e) {
        btwState.answer = '';
        btwState.failed = true;
        showToast('侧问失败: ' + (e && e.message ? e.message : e), 'error');
    } finally {
        btwState.pending = false;
        renderBtwPanel();
    }
}

/**
 * /btw 入口：由命令面板的 case 'btw' 调用。
 *
 * @param {string} question 用户问题（/btw 后面的内容）
 * @returns {Promise<void>}
 */
export async function askBtw(question) {
    const q = (question == null ? '' : String(question)).trim();
    if (!q) {
        // 上游 btw-model.ts:65-69：空问题只提示，不开 tab、不请求
        showToast('请在 /btw 后输入问题', 'error');
        return;
    }
    if (!openBtwPanel()) return;
    await generateBtw(q);
}

/** 复制答案到剪贴板（上游 btw-panel.tsx 的 copy 动作） */
async function copyBtwAnswer() {
    if (!btwState.answer) return;
    try {
        await navigator.clipboard.writeText(btwState.answer);
        showToast('已复制回答', 'success');
    } catch (_) {
        showToast('复制失败', 'error');
    }
}

/** 绑定面板事件（幂等：重复调用不重复绑） */
export function bindBtwPanelEvents() {
    const modal = btwModal();
    if (!modal || modal.dataset.eventsBound) return;
    modal.dataset.eventsBound = '1';

    const close = modal.querySelector('.btw-close');
    if (close) close.addEventListener('click', hideBtwPanel);
    const copy = modal.querySelector('.btw-copy');
    if (copy) copy.addEventListener('click', copyBtwAnswer);
    const retry = modal.querySelector('.btw-retry');
    if (retry) retry.addEventListener('click', function () { generateBtw(btwState.question); });

    // Esc 关闭（与仓内其它弹窗一致；只在本面板开着时响应）
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (modal.style.display === 'flex') hideBtwPanel();
    });

    // 点遮罩关闭：复用 core/utils.js 的 bindOverlayClose
    // （它按 mousedown+mouseup 都在遮罩上才关，避免弹窗内拖选误关）
    bindOverlayClose(modal, hideBtwPanel);
}
