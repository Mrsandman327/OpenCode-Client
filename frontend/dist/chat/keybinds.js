// ============================================================
// OpenCode 管理中心 - 声明式键位表（唯一入口）
// ============================================================
// 设计约束（来自本次工单）：
//   1. 所有全局快捷键集中在这**一个文件**里，不再散落到 25 个文件各写监听；
//      纯匹配逻辑在 core/keybinds.js（无 import，可 Node 单测）。
//   2. **不得劫持输入框内已有按键**：事件 target 落在 input/textarea/select/
//      contenteditable 里时整表让位——命令面板的 ↑↓/Enter/Tab/Esc、搜索的
//      Ctrl+F、发送的 Enter 都免受影响。
//   3. 有弹窗打开时整表让位（复用 .modal-overlay display:flex 的既有判据），
//      避免「弹窗开着却触发背后的切换会话」。
//   4. 无对应服务端端点的项一律**不实现**，不造假 UI（见文件末「未实现清单」）。
//   5. 与既有监听不冲突：本机已存在的全局键只有 Escape（main.js:447）、
//      Ctrl+F（chat/search.js:42）、Esc（knowledge/project-config/sidepanel），
//      输入框内 Enter（main.js:136）、↑↓/Enter/Tab/Esc（cmd-palette.js:167）、
//      Esc（tree.js:411）。本表键位与它们零重叠（由 tests/keybinds.test.mjs
//      用「不应命中的既有按键」用例锁住）。
//
// 语法：逗号=序列，加号=修饰键+主键，mod=⌘(mac)/Ctrl(其它)。
// ============================================================

import { api } from '../core/apicall.js';
import { store } from '../core/state.js';
import { showToast, markManualSelection } from '../core/utils.js';
import { parseKeybind, eventMatchesStep, isEditableTarget, hasOpenModal, isMacPlatform, formatKeybind, isMacPlatformNow } from '../core/keybinds.js';
import { createNewSession } from './tree.js';
import { toggleSessions, toggleSidepanel } from './mobile.js';
import { openFileBrowserStandaloneFor } from '../filebrowser/browser.js';
import { navigateUserMessage } from './search.js';
import { closeSessionTab } from './tabs.js';
import { isSessionBusy } from './render.js';
import { openCmdPaletteByKeybind } from './cmd-palette.js';

/** 序列匹配的超时（ms）：超时后重新从第一步开始，避免上一次按了一半的残留误触发。 */
const SEQUENCE_TIMEOUT = 1500;

/** 平台判定结果（mac 上 mod = meta，其它平台 mod = ctrl）。 */
function currentMac() {
    return isMacPlatform((typeof navigator !== 'undefined' && navigator.platform) || '');
}

// ============================
// 各键位的具体动作
// ============================

/** 聚焦主输入框（上游 viewCommand input.focus） */
function focusPromptInput() {
    const input = document.getElementById('ocPrompt');
    if (!input) return;
    input.focus();
    // 光标落到末尾：聚焦后默认可能在原处，落在末尾更符合「接着写」的预期
    try {
        const len = input.value.length;
        input.setSelectionRange(len, len);
    } catch (_) { /* 某些 input 类型不支持 setSelectionRange，忽略 */ }
}

/** 打开文件：op 的「打开文件」就是工作区文件浏览器（独立窗口，带 git 特性）。 */
function openFile() {
    const dir = (window._sessionMap && store.currentSessionId
        && window._sessionMap[store.currentSessionId]
        && window._sessionMap[store.currentSessionId].directory) || '';
    const dirEl = document.getElementById('ocSideDirPath');
    const root = dir || (dirEl && dirEl.textContent) || '';
    if (!root || root === '--') {
        showToast('当前没有可浏览的目录', 'error');
        return;
    }
    openFileBrowserStandaloneFor(root, { features: ['git'] });
}

/** 左侧会话/项目树开关（上游 fileTree.toggle 在本仓的对应物） */
function toggleFileTree() {
    toggleSessions();
}

/** MCP：op 没有独立的 MCP 弹窗，MCP 状态在右栏「服务状态」分区里。
 *  动作 = 展开右栏 + 展开该分区，等价于「打开 MCP 面板」。 */
function openMcpPanel() {
    const client = document.getElementById('webContainer');
    if (client && client.classList.contains('hide-right')) toggleSidepanel();
    const section = document.querySelector('.oc-panel-section');
    if (section) section.classList.remove('collapsed');
}

/** review 侧栏（上游 review.toggle → 右栏显隐） */
function toggleReviewSidebar() {
    toggleSidepanel();
}

/** 新建会话（上游 session.new） */
function newSession() {
    createNewSession();
}

/** 关闭当前 tab（上游 file.close / tab.close） */
function closeCurrentTab() {
    if (!store.activeTabId) {
        showToast('当前没有打开的会话', 'error');
        return;
    }
    closeSessionTab(store.activeTabId);
}

/**
 * 把会话的阻塞中工具移到后台观察（上游 session.background，键位 ctrl+b）。
 *
 * 端点已实测存在：POST /api/session/{id}/background → 204 No Content，
 * 语义（服务端自述）是「Move active foreground backgroundable tools for this
 * session into background observation. Idle requests are a no-op.」——
 * 会话空闲时是空操作，因此这里只在会话繁忙时才提示，避免做成一个假按钮。
 */
async function backgroundSession() {
    const sid = store.currentSessionId;
    if (!sid) {
        showToast('请先选择会话', 'error');
        return;
    }
    if (!isSessionBusy(sid)) {
        showToast('当前会话没有在后台运行的工具', 'info');
        return;
    }
    try {
        await api.OpenCodeCall('POST', `/api/session/${encodeURIComponent(sid)}/background`, {});
        showToast('已将会话中的阻塞工具移到后台', 'success');
    } catch (e) {
        showToast('移到后台失败: ' + (e && e.message ? e.message : e), 'error');
    }
}

/** 在选项列表里按方向取下一个值（循环）。返回空串表示无可选项。 */
function cycleValue(list, current, dir) {
    if (!Array.isArray(list) || !list.length) return '';
    const values = list.map(function (item) {
        if (item == null) return '';
        if (typeof item === 'string') return item;
        return item.value || item.id || item.name || '';
    }).filter(Boolean);
    if (!values.length) return '';
    const idx = values.indexOf(current);
    // 当前值不在列表里（未选/已失效）时，正向从第一项开始，反向从最后一项开始
    const next = idx < 0 ? (dir >= 0 ? 0 : values.length - 1) : (idx + dir + values.length) % values.length;
    return values[next];
}

/** 切换 agent（上游 agent.cycle / agent.cycle.reverse） */
function cycleAgent(dir) {
    const list = store.agentList || [];
    if (!list.length) {
        showToast('智能体列表尚未加载', 'error');
        return;
    }
    const next = cycleValue(list, store.selectedAgent || '', dir);
    if (!next) return;
    applySelection('agent', next);
}

/** 切换模型（上游 model.choose / 与 agent 成对的反向口径） */
function cycleModel(dir) {
    const list = store.modelList || [];
    if (!list.length) {
        showToast('模型列表尚未加载', 'error');
        return;
    }
    const next = cycleValue(list, store.selectedModel || '', dir);
    if (!next) return;
    applySelection('model', next);
}

/** 切换思考力度 variant（上游 model.variant.cycle，键位 shift+mod+d）。
 *  op 的 variant 选项是 index.html 里静态定义的那几档，无服务端端点依赖。 */
function cycleVariant() {
    const sel = document.getElementById('ocVariantSelect');
    if (!sel || !sel.options || !sel.options.length) {
        showToast('思考力度选择器不可用', 'error');
        return;
    }
    const values = Array.prototype.slice.call(sel.options)
        .map(function (o) { return o.value; })
        .filter(function (v) { return v !== ''; }); // 空值 = 「默认」，不参与轮转
    if (!values.length) return;
    const cur = sel.value || '';
    const idx = values.indexOf(cur);
    const next = values[(idx + 1 + values.length) % values.length];
    applySelection('variant', next);
}

/**
 * 应用一次选择器变更。**不走 change 事件而直接赋值**——因为 change 监听是
 * session.js 绑在 select 元素上的，程序赋值不会触发它，store 与下拉框会不一致。
 * 这里按同样的口径写三处：select.value、store、manualSelectionBySession 标记。
 */
function applySelection(kind, value) {
    const sel = document.getElementById(kind === 'agent' ? 'ocAgentSelect'
        : kind === 'model' ? 'ocModelSelect' : 'ocVariantSelect');
    if (sel) sel.value = value || '';
    if (kind === 'agent') store.selectedAgent = value || '';
    else if (kind === 'model') store.selectedModel = value || '';
    else store.selectedVariant = value || '';
    markManualSelection(kind, value || '');
    if (kind === 'agent' || kind === 'model') {
        // 与 select change 监听同一口径：标记本会话已同步，阻止历史回填覆盖
        store.agentModelSyncedSession = store.currentSessionId || '';
    }
}

/** 上一条/下一条用户消息（上游 message.previous / message.next） */
function navigateMessage(dir) {
    if (!store.currentSessionId) {
        showToast('请先选择会话', 'error');
        return;
    }
    navigateUserMessage(dir);
}

// ============================
// 声明式键位表（id → 键位 + handler）
// ============================

export const KEYBINDS = [
    { id: 'palette.open', title: '命令面板', spec: 'mod+k,mod+shift+p', run: openCmdPaletteByKeybind },
    { id: 'session.new', title: '新会话', spec: 'mod+shift+s', run: newSession },
    { id: 'session.background', title: '移到后台', spec: 'ctrl+b', run: backgroundSession },
    { id: 'input.focus', title: '聚焦输入框', spec: 'ctrl+l', run: focusPromptInput },
    { id: 'file.open', title: '打开文件', spec: 'mod+p', run: openFile },
    { id: 'fileTree.toggle', title: '文件树开关', spec: 'mod+\\', run: toggleFileTree },
    { id: 'mcp.toggle', title: 'MCP', spec: 'mod+;', run: openMcpPanel },
    { id: 'review.toggle', title: 'review 侧栏', spec: 'mod+shift+r', run: toggleReviewSidebar },
    { id: 'agent.cycle', title: '切换智能体（正）', spec: 'mod+.', run: function () { cycleAgent(1); } },
    { id: 'agent.cycle.reverse', title: '切换智能体（反）', spec: 'shift+mod+.', run: function () { cycleAgent(-1); } },
    { id: 'model.cycle', title: '切换模型（正）', spec: "mod+'", run: function () { cycleModel(1); } },
    { id: 'model.cycle.reverse', title: '切换模型（反）', spec: "shift+mod+'", run: function () { cycleModel(-1); } },
    { id: 'model.variant.cycle', title: '思考力度', spec: 'shift+mod+d', run: cycleVariant },
    { id: 'message.previous', title: '上一条消息', spec: 'mod+alt+[', run: function () { navigateMessage(-1); } },
    { id: 'message.next', title: '下一条消息', spec: 'mod+alt+]', run: function () { navigateMessage(1); } },
    { id: 'tab.close', title: '关闭标签页', spec: 'mod+w', run: closeCurrentTab },
];

/** 预解析：避免每次按键都重新 parse 字符串（匹配是热路径）。 */
const COMPILED = KEYBINDS.map(function (item) {
    return { id: item.id, title: item.title, run: item.run, steps: parseKeybind(item.spec) };
});

/** 当前等待第二步（及以后）的序列：{ entry, index, timer } */
let sequence = null;

/** 清空进行中的序列 */
function clearSequence() {
    if (sequence && sequence.timer) clearTimeout(sequence.timer);
    sequence = null;
}

/**
 * 全局键位监听。整表共此一个监听，散落监听一律不再新增。
 *
 * 让位顺序（任一命中即整表不响应）：
 *   1. 事件 target 在可输入元素里 → 让位给输入框自己的按键（Enter/Ctrl+F/Esc/↑↓/Tab）
 *   2. 有弹窗打开 → 让位给弹窗自己的按键
 */
function onKeydown(event) {
    if (event.defaultPrevented || event.repeat) return;
    if (isEditableTarget(event.target)) return;
    if (hasOpenModal(document)) {
        clearSequence();
        return;
    }
    const mac = currentMac();

    // 先看是不是在等第二步
    if (sequence) {
        const entry = sequence.entry;
        const idx = sequence.index;
        if (idx < entry.steps.length && eventMatchesStep(event, entry.steps[idx], mac)) {
            const isLast = idx === entry.steps.length - 1;
            if (isLast) {
                const run = entry.run;
                clearSequence();
                event.preventDefault();
                event.stopPropagation();
                try { run(); } catch (e) { showToast('快捷键「' + entry.title + '」执行失败: ' + (e && e.message ? e.message : e), 'error'); }
                return;
            }
            // 中间步命中：推进进度（沿用原超时定时器）
            sequence.index = idx + 1;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        // 没接上：清掉旧进度，按下面流程从第一步重新匹配
        clearSequence();
    }

    for (let i = 0; i < COMPILED.length; i++) {
        const entry = COMPILED[i];
        if (!entry.steps.length) continue;
        if (!eventMatchesStep(event, entry.steps[0], mac)) continue;
        if (entry.steps.length === 1) {
            event.preventDefault();
            event.stopPropagation();
            try { entry.run(); } catch (e) { showToast('快捷键「' + entry.title + '」执行失败: ' + (e && e.message ? e.message : e), 'error'); }
            return;
        }
        // 多步序列：等下一步
        sequence = { entry: entry, index: 1, timer: null };
        sequence.timer = setTimeout(function () { sequence = null; }, SEQUENCE_TIMEOUT);
        event.preventDefault();
        event.stopPropagation();
        return;
    }
}

/** 初始化键位表（幂等）。由 main.js 在 DOMContentLoaded 后调用。 */
export function initKeybinds() {
    if (document.body && document.body.dataset.ocKeybindsBound) return;
    if (document.body) document.body.dataset.ocKeybindsBound = '1';
    document.addEventListener('keydown', onKeydown);
}

/**
 * 键位速查表用的展示数据（界面显示用，不参与匹配）。
 *
 * 为什么单独给：界面要「看得见有哪些快捷键」，而 KEYBINDS 里的 run 是函数、
 * spec 是平台无关写法，直接渲染给用户看不懂（mod/ctrl 混用）。
 * 这里统一翻译成当前平台标签，并按官方分组排序。
 *
 * @returns {Array<{id: string, title: string, label: string}>}
 */
export function keybindDisplayList() {
    return KEYBINDS.map(function (item) {
        return {
            id: item.id,
            title: item.title,
            label: formatKeybind(item.spec, isMacPlatformNow()),
        };
    });
}

/**
 * 面板命令名 → 键位 spec 的显式映射。
 *
 * ⚠️ 当前固定命令（summarize/revert/unrevert/fork/btw/keys）**官方均未分配
 * 默认键位**（见官方 use-session-commands.tsx：它们只有 slash，没有 keybind），
 * 故这里全部留空——宁可不显示，也不凭空造一个会和既有键撞车的组合。
 * 新的键位（session.new 等）走的是另一套键位表，不属于面板命令。
 */
const COMMAND_KEYBIND = {
    summarize: '',
    revert: '',
    unrevert: '',
    fork: '',
    btw: '',
    keys: '',
};

/** 某个面板命令对应的键位标签；未绑定返回 ''。 */
export function keybindLabelForCommand(name) {
    const want = String(name || '').trim();
    if (!Object.prototype.hasOwnProperty.call(COMMAND_KEYBIND, want)) return '';
    const spec = COMMAND_KEYBIND[want];
    return spec ? formatKeybind(spec, isMacPlatformNow()) : '';
}

// ============================
// 未实现清单（无对应服务端端点，宁可不做也不造假）
// ============================
// 1. permissions.autoaccept（mod+shift+a，「权限自动放行」）——**未实现**。
//    已核对本机 opencode 2.0.26 的 /openapi.json：
//      - 没有任何「全局自动放行开关」端点；权限面只有
//        GET  /api/permission/saved            （列出已保存的授权，只读）
//        GET  /api/session/{id}/permission     （列出待审批请求）
//        POST /api/session/{id}/permission/{requestID}/reply （逐条回复）
//      - 唯一能改配置的 PATCH /api/experimental/config 的 Config.Patch
//        schema 只有 {shell} 一个字段（additionalProperties:false），
//        碰不到 permission。
//    要做得先有服务端能力；本仓不写一个只改前端状态的假开关。
// 2. context.addSelection（mod+shift+l，「选中加入上下文」）——**未实现**。
//    op 的消息区没有「文件选中行」的概念（上游依赖编辑器的
//    file.selectedLines(path) + selection bridge），仓内也没有可取的选区源。
// ============================
