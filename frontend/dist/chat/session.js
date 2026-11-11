// ============================================================
// chat-session.js — 会话管理与消息收发
// 负责会话选择/创建/加载、Agent/Model 选择器、附件管理、消息发送、轮询与中止
// 依赖：core/state.js、core/utils.js（showToast, escapeHtml, getActiveMessagesEl, ensureTabMessagesEl, getCachedMessages）、
//       core/apicall.js（api）、chat/btw.js（syncBtwToSession）、chat/mobile.js（isMobileTreeMode）、chat/tabs.js（openSessionTab, renderTabsBar, setTabActivationHandler）、
//       chat/sidepanel.js（refreshSubtaskPanel, scheduleSubtaskExtraction）、chat/events.js（loadSessionStatuses）、
//       chat/render.js（isSessionBusy, smartScroll, updateSendButton, renderMessages）、
//       chat/search.js（resetUserNav）、chat/cache.js（cacheMessages, ensurePendingAssistant, renderPendingAssistantPlaceholder, renderCachedMessages）
//       filebrowser/browser.js（openFileBrowserStandaloneFor）——保留全局守卫调用
// 解环说明：updateSendButton 已移入 chat/render.js；pendingWorkDir 已移入 core/state.js 的 store；
//           通过 setTabActivationHandler 向 tabs.js 注入会话激活加载回调，避免 tabs↔session 循环依赖；
//           本模块对外提供的动作（loadMessages 等 7 个）经 core/utils.js 的 setSessionActionHandlers
//           注册，events.js / cmd-palette.js 不再静态 import 本模块（解 session↔events、session↔cmd-palette 环）。
// ============================================================

import { api } from '../core/apicall.js';
import { store } from '../core/state.js';
import { showToast, showApiError, escapeHtml, getActiveMessagesEl, ensureTabMessagesEl, getCachedMessages, updateTreeActiveSession, isKnownAgentName, isKnownModelId, resolveKnownValue, markManualSelection, restoreSessionSelection, hasManualSessionSelection, setSessionActionHandlers, syncVariantSelect, variantValuesForModel, variantLabel } from '../core/utils.js';
import { isMobileTreeMode } from './mobile.js';
import { openSessionTab, renderTabsBar, setTabActivationHandler } from './tabs.js';
import { refreshSubtaskPanel, scheduleSubtaskExtraction } from './sidepanel.js';
import { loadSessionStatuses, refreshSessionStatusFromActive } from './events.js';
import { smartScroll, updateSendButton, setSessionStatus, renderMessages, ensureSelectOption, updateScrollBottomButton } from './render.js';
// 解环后与 cmd-palette 的依赖为单向：它经 core/utils.js 注册中心调用本模块的
// loadMessages 等动作（见 setSessionActionHandlers），本模块只在发送流程运行时
// 调用它的 isKnownCommand/isKnownSkill。
import { isKnownCommand, isKnownSkill, isFixedCommand, executeFixedCmd } from './cmd-palette.js';
import { parseBtwCommand } from '../core/btw.js';
import { syncBtwToSession } from './btw.js';
import { resetUserNav, updateUserNav, shiftUserNavIndex } from './search.js';
import { cacheMessages, ensurePendingAssistant, renderPendingAssistantPlaceholder, renderCachedMessages, cacheLocalUserMessage, removeLocalUserMessage, removePendingAssistant, prependMessages } from './cache.js';
import { openFileBrowserStandaloneFor } from '../filebrowser/browser.js';
// 知识库 @ 引用：collectKnowledgeRefs 取引用全文注入发送 parts，clearKnowledgeRefs 在发送成功后清空引用区。
// 该模块不识 session.js，无循环依赖。
import { collectKnowledgeRefs, clearKnowledgeRefs, hasKnowledgeRefs } from './knowledge-ref.js';
// OpenCode v2 适配层：拆 {data:...} 信封、把 v2 扁平消息还原为 v1 的 {info,parts}、转换 prompt 请求体。
import { unwrap, unwrapList, toModelOptions, adaptMessages, adaptInboxMessages, nextCursor, toPromptBody, toModelRef, formatApiError } from '../core/v2compat.js';

// ============================
// 全局 Agent/Model 选择器
// ============================

// agent/model 冷启动重试：v2 的 /api/agent、/api/model 按 location **逐步就绪**——
// 首次可能为空、或只返回「已加载完的部分供应商」，稍后才补齐（实测同一目录先 29 条、
// 紧接着 0 条、随后又 29 条）。故不能把首次结果当成完整结果缓存。
// 这里用「数量是否仍在增长」判断未就绪：为空或仍在增长就短延迟复查，稳定后停止。
let agentModelRetryAttempt = 0;
let agentModelRetryTimer = 0;
let agentModelLastCounts = { agents: -1, models: -1 };

/** 加载 Agent/Model 下拉选择器（从 API 获取可用列表）
 *  @param {string} dir  目录（v2 的 agent 列表按 location 取）
 *  @param {boolean} [force] 为 true 时忽略「同目录已加载」守卫强制重拉
 *         （用于 model.updated / provider.updated 等事件驱动的刷新） */
export async function loadAgentModelSelectors(dir, force) {
    const directory = (dir || '').trim();
    // 无目录时不请求：v2 的 /api/agent、/api/model 需要 location[directory]，
    // 缺省会退回服务端 CWD（共享服务为 home），把 home 误登记为项目。
    // 同时**不得清空已有列表**：空目录调用（如无会话时的状态刷新）若清空，
    // 会让用户手选的合法值在发送前的严格校验里被误判回退（真机 bug 的输入端成因）。
    if (!directory) {
        return;
    }
    // 目录变化：取消旧目录的重试定时器并复位计数，避免旧目录的延迟回调覆盖新目录数据
    if (store.agentModelSelectorsDir && store.agentModelSelectorsDir !== directory) {
        clearTimeout(agentModelRetryTimer);
        agentModelRetryAttempt = 0;
        agentModelLastCounts = { agents: -1, models: -1 };
    }
    // 同目录已加载则跳过；目录变了才重新拉取（v2 的 agent/model 是项目级配置）
    // force=true 时忽略该守卫（事件驱动的强制刷新）
    if (!force && store.agentModelSelectorsLoaded && store.agentModelSelectorsDir === directory) return;
    try {
        // v2：/api/agent、/api/model 返回 {location, data:[...]} 信封，需拆包。
        // 注意模型列表必须用 /api/model——v2 的 /api/provider 不再内嵌 models 字段。
        const [agentsRes, modelsRes] = await Promise.all([
            api.OpenCodeCall('GET', '/api/agent', null, directory).catch(() => []),
            api.OpenCodeCall('GET', '/api/model', null, directory).catch(() => []),
        ]);
        const agentsAll = unwrapList(agentsRes);
        // 只保留可直选的主代理：过滤子代理与隐藏项（title/summary 等内部 agent）
        const agents = agentsAll.filter(a => a && a.mode !== 'subagent' && !a.hidden);
        const models = toModelOptions(modelsRes);
        // 空响应不得覆盖已有非空列表：v2 的 /api/agent、/api/model 是「逐步就绪」的，
        // 实测存在「先 29 条 → 紧接着 0 条 → 随后又 29 条」的中间态；若把 0 条写回 store，
        // 用户手选的合法值会在发送前的严格校验（isKnownAgentName/isKnownModelId）里被
        // 误判回退，服务端转而用会话残留的旧 agent 执行（报 Agent not found）。
        // 非空响应照常更新（数量收敛正常生效）；空响应仅在「本就没有数据」时保持为空。
        if (agents.length || !store.agentList.length) store.agentList = agents;
        if (models.length || !store.modelList.length) store.modelList = models;
        store.agentModelSelectorsLoaded = true;
        store.agentModelSelectorsDir = directory;
        // 懒加载冷启动：为空、或数量相比上次仍在增长（说明其余供应商尚未就绪）时复查，
        // 直到连续一轮不再增长（视为已齐全）或达到上限，避免下拉停在「部分模型」状态。
        const grew = agentsAll.length > agentModelLastCounts.agents || models.length > agentModelLastCounts.models;
        const empty = !agentsAll.length || !models.length;
        agentModelLastCounts = { agents: agentsAll.length, models: models.length };
        if ((empty || grew) && agentModelRetryAttempt < 8) {
            agentModelRetryAttempt++;
            clearTimeout(agentModelRetryTimer);
            agentModelRetryTimer = setTimeout(() => {
                store.agentModelSelectorsLoaded = false; // 复位守卫，允许同目录重新拉取
                loadAgentModelSelectors(directory);
            }, 2500);
        } else {
            agentModelRetryAttempt = 0;
        }
    } catch (_) {
        // 请求失败同样不得清空已有列表：保留上一次成功的数据（stale-while-revalidate），
        // 下一轮刷新或事件驱动重拉时再校正；清空式失败处理会让手选值在发送前被误判回退。
        if (!store.agentList.length) store.agentList = [];
        if (!store.modelList.length) store.modelList = [];
    }

    const agentSel = document.getElementById('ocAgentSelect');
    const modelSel = document.getElementById('ocModelSelect');
    if (!agentSel || !modelSel) return;

    // 填充 agent 下拉框
    agentSel.innerHTML = '<option value="">默认</option>';
    store.agentList.forEach(a => {
        const opt = document.createElement('option');
        // value 必须是 agent 的 **id**（如 build）：v2 服务端按 id 解析 agent，
        // 传显示名（如 Build）会在**执行期**报 Agent not found（接口本身不校验）。
        // text 仍是给人看的 name。
        opt.value = a.id || a.name;
        opt.textContent = a.name || a.id;
        if (a.description) opt.title = a.description;
        agentSel.appendChild(opt);
    });
    // 列表为空（数据不可用）而已有手选值时补齐选项：保证「显示 == 即将发送的值」，
    // 不因列表抖动让用户以为选择被重置（发送端对无手选的历史值仍走保守回退）。
    if (!store.agentList.length && store.selectedAgent) ensureSelectOption(agentSel, store.selectedAgent, store.selectedAgent);
    agentSel.value = store.selectedAgent;

    // 填充 model 下拉框（value 用真实模型 ID 供对话请求切分；文字显示 name）
    modelSel.innerHTML = '<option value="">默认</option>';
    store.modelList.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.label;
        modelSel.appendChild(opt);
    });
    // 与 agent 同一口径：列表不可用时补齐手选的模型项
    if (!store.modelList.length && store.selectedModel) ensureSelectOption(modelSel, store.selectedModel, store.selectedModel);
    modelSel.value = store.selectedModel;

    // change 事件（带绑定守卫：启停多次只绑一次，避免重复监听）
    // 用户手动选择后立即标记「本会话已完成同步」，阻止后续重渲染用消息历史覆盖该选择；
    // 同时写入 per-session 手动标记（manualSelectionBySession），使「切走再切回」
    // 时历史同步也不得覆盖手选项（render.js doUpdateModelInfo / tabs.js switchTab 都会读它）。
    if (!agentSel.dataset.modelBound) {
        agentSel.dataset.modelBound = '1';
        agentSel.addEventListener('change', () => {
            store.selectedAgent = agentSel.value;
            markManualSelection('agent', agentSel.value);
            store.agentModelSyncedSession = store.currentSessionId || '';
        });
    }
    if (!modelSel.dataset.modelBound) {
        modelSel.dataset.modelBound = '1';
        modelSel.addEventListener('change', () => {
            store.selectedModel = modelSel.value;
            markManualSelection('model', modelSel.value);
            store.agentModelSyncedSession = store.currentSessionId || '';
            // 换模型后思考强度档位随模型变化（模型自带 variants 为唯一事实源）。
            // syncVariantSelect 默认严格模式：旧档位若新模型不支持（如 A 模型选 xHigh
            // 切到无 xHigh 的 B 模型）会回落到「默认」，绝不再补入非法选项。
            // 必须把返回值写回 store，否则发送端仍会拿到上一个模型的残留档位。
            const nextVariant = syncVariantSelect(
                document.getElementById('ocVariantSelect'),
                modelSel.value,
                store.selectedVariant
            );
            store.selectedVariant = nextVariant;
            // 同步刷新会话级手动标记：切走再切回时 restoreSessionSelection 恢复的是
            // 校正后的值，而不是旧模型留下的非法档位。
            markManualSelection('variant', nextVariant);
        });
    }

    // Variant 选择器
    const variantSel = document.getElementById('ocVariantSelect');
    if (variantSel) {
        // 按当前模型重建档位（唯一事实源：/api/model 返回的 variants）。
        // 严格模式下不在名单里的旧值会回落「默认」，因此必须写回 store。
        store.selectedVariant = syncVariantSelect(variantSel, store.selectedModel, store.selectedVariant);
        if (!variantSel.dataset.modelBound) {
            variantSel.dataset.modelBound = '1';
            variantSel.addEventListener('change', () => {
                store.selectedVariant = variantSel.value;
                // variant 与 agent/model 同一口径，手动选择打会话级标记，历史同步不得覆盖
                markManualSelection('variant', variantSel.value);
            });
        }
    }

    store.agentModelSelectorsLoaded = true;
}

let currentSessionRefreshPending = false;

/** 从 OpenCode API 获取当前会话的最新标题，更新标题栏、store.sessionMap 和项目树节点 */
export async function refreshSessionTitle() {
    if (!store.currentSessionId) return;
    try {
        const res = await api.OpenCodeCall('GET', `/api/session/${encodeURIComponent(store.currentSessionId)}`);
        const data = unwrap(res);
        const title = data?.title || data?.Title;
        // 标题尚未生成（OpenCode 异步生成，晚于 idle 事件）：直接返回，
        // 由 scheduleSessionTitleRefresh 的轮询持续驱动，避免 tab 页 / 项目树停留在占位名
        if (!title) return;
        // 从 store.sessionMap 读取旧标题（可能因时序问题尚未存在）
        const oldTitle = store.sessionMap?.[store.currentSessionId]?.title;
        if (oldTitle === title) return;
        // 确保会话映射表项存在并更新
        if (!store.sessionMap) store.sessionMap = {};
        if (!store.sessionMap[store.currentSessionId]) store.sessionMap[store.currentSessionId] = {};
        store.sessionMap[store.currentSessionId].title = title;
        // 会话标题只显示在对应 Tab 上（标题行已移除）
        // 同步 Tab 标题
        if (store.openTabs && Array.isArray(store.openTabs)) {
            var tab = store.openTabs.find(function(t) { return t.sessionID === store.currentSessionId; });
            if (tab) {
                tab.title = title;
                renderTabsBar();
            }
        }
        // 更新项目树中的会话节点
        const escapedId = store.currentSessionId.replace(/[&<>"']/g, function(m) {
            return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m];
        });
        const treeNode = document.querySelector('.oc-tree-session[data-session-id="' + escapedId + '"]');
        if (treeNode) {
            // 注意：标题图标已由 renderTree 渲染为独立的 .oc-tree-session-icon 元素，
            // 这里只更新 label 文本（不再加 💬 前缀，否则与图标重复）
            const label = treeNode.querySelector('.oc-tree-label');
            if (label) {
                label.textContent = title;
            }
            const tooltipTitle = treeNode.querySelector('.oc-tree-tooltip-title');
            if (tooltipTitle) tooltipTitle.textContent = title;
        }
    } catch (_) {}
}

/**
 * 新会话标题由 OpenCode 异步生成：主动轮询更新（兜底 idle 事件/现有轮询未触发的情况）。
 * 标题刷新轮询的唯一驱动——refreshSessionTitle 内部不再自带重试。
 */
let titlePollTimer = null;
let titlePollCount = 0;
const TITLE_POLL_MAX = 20;
const TITLE_POLL_INTERVAL = 1000;

/** 是否是「服务端还没生成真标题」的占位值。
 *  轮询必须能区分「已有标题」和「只有占位标题」，否则一见到占位值就停，
 *  真标题永远补不上（新建会话最常见：树里先出现默认标题，轮询第一秒就自杀）。 */
function isPlaceholderSessionTitle(title, sessionID) {
    const t = String(title == null ? '' : title).trim();
    if (!t) return true;
    if (t === sessionID) return true;
    // 新建会话期间前端写入的占位标题
    if (t.indexOf('新建会话') === 0) return true;
    // 服务端默认标题
    if (t === '新会话' || t.toLowerCase() === 'untitled' || t.toLowerCase() === 'new session') return true;
    return false;
}

function scheduleSessionTitleRefresh(sessionID) {
    if (!sessionID) return;
    titlePollCount = 0;
    if (titlePollTimer) clearInterval(titlePollTimer);
    titlePollTimer = setInterval(function() {
        // 已切换会话：旧轮询立即停止
        if (sessionID !== store.currentSessionId) {
            clearInterval(titlePollTimer);
            titlePollTimer = null;
            return;
        }
        // 拿到真标题才停止；占位标题（默认标题 / 会话 id / 新建会话 @ 目录）继续轮询
        const mappedTitle = store.sessionMap?.[sessionID]?.title;
        if (!isPlaceholderSessionTitle(mappedTitle, sessionID)) {
            clearInterval(titlePollTimer);
            titlePollTimer = null;
            return;
        }
        titlePollCount++;
        if (titlePollCount > TITLE_POLL_MAX) {
            clearInterval(titlePollTimer);
            titlePollTimer = null;
            return;
        }
        refreshSessionTitle();
    }, TITLE_POLL_INTERVAL);
}

/**
 * 刷新当前会话视图。
 * 与切换会话后的加载流程类似，但保留当前会话的局部阅读状态，
 * 不清空展开状态、不清空 question 自定义输入，也不切换会话本身。
 */
export async function refreshCurrentSession() {
    if (!store.webRunning) return;
    if (!store.currentSessionId) {
        showToast('当前没有可刷新的会话', 'info');
        return;
    }
    if (currentSessionRefreshPending) return;

    const refreshBtn = document.getElementById('btnRefreshCurrentSession');
    const box = getActiveMessagesEl();
    const refreshSessionId = store.currentSessionId;

    currentSessionRefreshPending = true;
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.classList.add('is-loading');
        refreshBtn.title = '正在刷新当前会话';
    }

    store.markdownCache = {};
    store.lastMessageCount = 0;
    store.messageLoadSeq++;
    if (box) {
        box.innerHTML = '<div class="oc-empty">正在刷新会话消息...</div>';
    }

    try {
        await loadMessages();
        if (refreshSessionId !== store.currentSessionId) return;

        if (!isMobileTreeMode()) {
            // 子任务面板数据源为服务端 child sessions：刷新会话后立即重拉一次
            refreshSubtaskPanel();
        }

        try {
            // 会话状态请求同样无超时，这里加超时，避免它挂起整个刷新流程导致刷新锁无法释放
            const statuses = await withTimeout(loadSessionStatuses(), SESSION_STATUS_TIMEOUT_MS, '会话状态');
            if (refreshSessionId === store.currentSessionId && statuses) {
                // 手动刷新视为一次纠偏：快照缺 key ⇒ idle；请求失败（null）时不动。
                // setSessionStatus 会遵守本地发送/停止的保护窗口，不会被延迟快照打回。
                setSessionStatus(refreshSessionId, statuses[refreshSessionId] ?? 'idle', 'snapshot');
            }
        } catch (_) {}

        if (refreshSessionId !== store.currentSessionId) return;

        updateSendButton();
        smartScroll(getActiveMessagesEl(), true);
        showToast('已刷新当前会话', 'success');
    } catch (e) {
        if (refreshSessionId === store.currentSessionId) {
            showApiError('刷新当前会话失败: ', e);
        }
    } finally {
        currentSessionRefreshPending = false;
        if (refreshBtn) {
            refreshBtn.disabled = !store.webRunning || !store.currentSessionId;
            refreshBtn.classList.remove('is-loading');
            refreshBtn.title = '刷新当前会话';
        }
    }
}

/**
 * 标记会话已读。
 *
 * v2 的 POST /api/session/{id}/view 要求 body 里带 idle，且必须是该会话
 * Session.Info.time.idle 的**原值**——服务端拿它对账「viewer 是否观察到了
 * 这次 idle 转换」。填 0 或当前时间戳都会被判无效（实测缺 idle 直接 400
 * Missing key ["idle"]），所以 idle 由后端随会话列表一起透出。
 *
 * 从未空闲过的会话没有 idle 值，此时跳过而不是发一个注定失败的请求。
 */
async function markSessionViewed(sessionId, idle) {
    if (!sessionId || !idle) return;
    try {
        await api.MarkSessionViewed(sessionId, Number(idle));
    } catch (e) {
        console.warn('标记会话已读失败:', e);
    }
}

/** 选择/切换会话：更新标题、目录路径，加载消息和子任务 */
export async function selectSession(id) {
    if (!id) return;
    var info = store.sessionMap?.[id];
    // 已打开的 Tab：走 Tab 快速切换（保存快照 + 秒切/分帧渲染）
    if (store.openTabs.some(function(t) { return t.sessionID === id; })) {
        openSessionTab(id, info?.title);
        return;
    }
    // 首次打开：注册 Tab 并走原有完整加载流程
    openSessionTab(id, info?.title);
    store.currentSessionId = id;
    store.activeTabId = id;
    // 首次打开新会话：先用本地状态同步重算按钮（避免文案停留在上一个会话），
    // 再用 active 快照纠偏一次。active 有延迟，但此刻没有本地发送/停止意图，
    // 只影响“打开时是否已在运行”的判断；不引入轮询。
    updateSendButton();
    refreshSessionStatusFromActive(id, true);
    // 首次打开不经过 switchTab，这里补一次「会话已激活」通知，
    // 否则占位标题的轮询不会启动（新建会话标题停在占位值）。
    try {
        document.dispatchEvent(new CustomEvent('oc-session-activated', { detail: { sessionID: id } }));
    } catch (_) {}
    // 切会话：重置历史同步守卫，并按该会话自己的选择上下文恢复——
    // 有手动标记用标记值（手动选择优先于历史），无标记则清空等待本会话历史
    // 同步一次。避免把上一个会话的选择带进新会话，也避免历史回填覆盖手选项。
    store.agentModelSyncedSession = '';
    restoreSessionSelection(id);
    // 同步项目树高亮
    updateTreeActiveSession();
    // 重新渲染 Tab 栏，确保新 tab 呈激活态（openSessionTab 内部已渲染一次，但此时 activeTabId 还未更新）
    renderTabsBar();
    store.expandedParts = {};
    store.markdownCache = {};
    store.lastMessageCount = 0;
    store.messageLoadSeq++;
    store.questionCustomInput = ''; // 清除 question 自定义输入
    // 标记已读：v2 的 /api/session/{id}/view 用 time.idle 原值做对账凭据，
    // 缺了返回 400。失败只记日志，不阻断会话打开——已读是附加语义。
    markSessionViewed(id, info?.idle);
    const dirEl = document.getElementById('ocSideDirPath');
    const dirBar = document.getElementById('ocDirBar');
    if (dirEl && dirBar) {
        var dirPath = info?.directory || '';
        dirEl.textContent = dirPath || id;
        dirEl.title = dirPath || '';
        // path 上的 title 保留为"完整路径"预览（省略号截断时悬浮可见）。
        dirBar.onclick = function() {
            var p = info?.directory || '';
            if (!p) return;
            // 右侧面板会话目录：点击直接打开独立窗口（桌面端原生窗口 / Web 端新标签页）
            openFileBrowserStandaloneFor(p, { features: ['git'] });
        };
    }
    // 创建并激活该会话容器，显示加载态
    var sessBox = ensureTabMessagesEl(id);
    if (sessBox) {
        sessBox.classList.add('active');
        sessBox.style.display = 'flex';
        sessBox.innerHTML = '<div class="oc-empty">正在加载会话消息...</div>';
        // 隐藏其他 tab 容器
        var poolEl = document.getElementById('ocMessagesPool');
        if (poolEl) {
            poolEl.querySelectorAll('.oc-messages-tab').forEach(function(c) {
                if (c !== sessBox) { c.classList.remove('active'); c.style.display = 'none'; }
            });
        }
    }
    // 重置用户消息导航状态（必须在容器激活后、loadMessages 前调用，
    // 避免 getActiveMessagesEl 仍指向旧容器导致 userNavIndex 被污染）
    resetUserNav();
    // 传 id 加载到该会话自己的容器：快速连点时各会话独立加载，互不丢弃
    loadMessages(id).then(() => {
        if (id !== store.currentSessionId) return;
        if (!isMobileTreeMode()) {
            // 子任务面板数据源为服务端 child sessions：选择会话后立即重拉一次
            refreshSubtaskPanel();
        }
        smartScroll(sessBox || getActiveMessagesEl(), true);
    }).catch(() => {});
}

/** 用指定目录创建会话。
 *  v2 的 POST /api/session 不接受任何查询参数（v1 用 ?directory=），
 *  工作目录必须放在请求体的 location.directory 里，否则会话会落到服务端 CWD。 */
export async function createSessionWithDir(dir) {
    const res = await api.OpenCodeCall('POST', '/api/session', dir ? { location: { directory: dir } } : {});
    const session = unwrap(res);
    return session;
}

/** 加载会话消息列表（含竞态保护；渲染到该会话自己的 tab 容器）。
 *  @param {string} [sessionID] 指定要加载的会话；缺省用当前会话。
 *  竞态保护按「每个会话独立 seq」：快速连点多个 tab 时，各会话的加载请求
 *  互不丢弃（原全局 seq 会因连点导致前序会话的加载被整体放弃 → 容器停在占位态）。 */
/** 每会话分页状态：{ loadedAll: 是否已全部加载, loading: 是否加载中 } */
const sessionPaging = {};

/** 是否已全部加载该会话的消息（分页） */
export function isSessionLoadedAll(sessionID) {
    return !!(sessionPaging[sessionID] && sessionPaging[sessionID].loadedAll);
}

/**
 * 加载更早的消息（分页历史，向上滚动 / 用户定位到边界时调用）。
 * 每次拉取 200 条，前置合并后保持滚动位置。
 *
 * v1 用 before=<本地构造的 {id,time} 游标> 翻页；v2 改为 cursor=<服务端游标>，
 * 游标由服务端签发（base64url 内含 id/order/direction），客户端无法自造。
 * 语义（对照 v2 服务端 SessionStore.messages 确证）：默认 desc（新→旧）顺序下
 * cursor.next 沿时间线继续 → 指向「更早」，cursor.previous 反向 → 指向「更新」。
 * 因此向更早翻页必须续用响应里的 cursor.next；误用 previous 会得到空页，
 * 并被立即判定为「已全部加载」，导致上滑分页永久失效（历史 bug）。
 */
export async function loadOlderMessages(sessionID) {
    const targetId = sessionID || store.currentSessionId;
    if (!targetId) return;
    if (!sessionPaging[targetId]) sessionPaging[targetId] = {};
    const paging = sessionPaging[targetId];
    // 一次性提示：用平实语言告诉用户"为什么没有更早的消息"，避免暴露游标/limit 等术语
    const note = (msg) => {
        if (paging.diagShown === msg) return; // 同一原因只提示一次，避免滚动时刷屏
        paging.diagShown = msg;
        showToast(msg, 'info');
    };
    if (paging.loading) return;
    if (paging.loadedAll) { note('已经是最早的消息了'); return; }
    const cursor = paging.cursor;
    if (!cursor) {
        // 没有续翻游标通常意味着「本来就没有更早的消息」或「首屏尚未完成」，
        // 属于内部状态而非用户可处理的问题，静默标记即可，不弹提示。
        paging.loadedAll = true;
        return;
    }
    paging.loading = true;
    try {
        const res = await api.OpenCodeCall('GET', `/api/session/${encodeURIComponent(targetId)}/message?limit=200&cursor=${encodeURIComponent(cursor)}`);
        const messages = adaptMessages(targetId, res);
        // 一次性诊断：成功取到更早消息时也给个反馈（便于确认"上滑确实命中了"）
        if (messages.length) {
            paging.diagShown = '';
            showToast('已加载 ' + messages.length + ' 条更早的消息', 'success');
        }
        // 渲染到目标会话自己的容器；仅当前激活会话保持滚动位置与同步用户定位
        const isCurrent = targetId === store.currentSessionId;
        const box = isCurrent ? ensureTabMessagesEl(targetId) : null;
        // 续翻游标：desc 顺序下 cursor.next 指向更早（见函数头注释）
        const moreCursor = nextCursor(res);
        if (!messages.length) {
            paging.loadedAll = true; paging.loadedAllReason = '服务端返回空页';
        } else {
            paging.cursor = moreCursor;
            prependMessages(targetId, messages);
            // 到顶判定必须看**原始页条数**：解析层会丢弃 idle/agent-switched 等边界消息，
            // 用解析后的条数会把"满页但被过滤了几条"误判成"不足一页 → 已到顶"。
            const rawCount = Array.isArray(res && res.data) ? res.data.length : messages.length;
            if (rawCount < 200 || !moreCursor) {
                paging.loadedAll = true;
                paging.loadedAllReason = '本页原始 ' + rawCount + ' 条(limit=200)，续翻游标=' + (moreCursor ? '有' : '无');
            }
            // 新加载的用户消息插入缓存头部，用户定位索引整体偏移（保持"看到的那条"位置）
            const addedUserCount = messages.filter(m => (m.info?.role || m.role) === 'user').length;
            shiftUserNavIndex(addedUserCount);
            if (box && isCurrent) {
                // 上滑分页时用户必然在顶部，强制不跟随底部；
                // renderMessages 内部会按消息锚点把视口停回「原来看到的那一条」。
                // （此前用「高度差补偿」，但 followBottom 判定会被陈旧状态置真，
                //   结果推进来的历史消息反而把列表滚到了最底部。）
                // 加载更早的消息属于「改变上方内容」，语义上永远不该跟随底部；
                // 这里显式声明，避免经由非滚动入口（命令面板、用户定位按钮）触发时
                // 依赖滚动状态而出现跳底。
                store.tabStickBottom[targetId] = false;
                renderMessages(getCachedMessages(targetId), box);
                updateUserNav(); // 同步用户定位（新加载的用户消息可定位、计数更新）
            } else if (box) {
                renderCachedMessages(targetId); // 非当前会话：仅合并缓存，激活时渲染
            }
        }
    } catch (_) {
    } finally {
        paging.loading = false;
    }
}

/** 加载会话消息请求的最长等待时间。页面 fetch 与本地 API 都没有超时，
 *  一旦某次请求永不 settle，在途锁会永久为 true，之后所有刷新都被静默跳过。 */
const LOAD_MESSAGES_TIMEOUT_MS = 15000;
/** 刷新流程中「会话状态」请求的最长等待时间，避免其挂起整个刷新流程。 */
const SESSION_STATUS_TIMEOUT_MS = 10000;

/**
 * 给 Promise 套一层超时，保证 await 必然 settle。
 * 前端 fetch 与服务端代理都没有超时机制，请求可能永久挂起；
 * 超时后抛出错误，调用方的 finally 才会执行、在途锁才会被释放。
 */
function withTimeout(promise, ms, label) {
    let timer = null;
    // 原请求在超时之后仍可能 reject（fetch 无法真正取消），
    // 先挂一个空 catch，避免它变成 unhandled rejection 污染控制台。
    promise.catch(function () {});
    return Promise.race([
        promise,
        new Promise(function (_, reject) {
            timer = setTimeout(function () {
                reject(new Error((label || '请求') + '超时（' + ms + 'ms）'));
            }, ms);
        }),
    ]).finally(function () {
        if (timer) clearTimeout(timer);
    });
}

/** 各会话是否有消息校正请求在途：用于去重，避免刷新按钮 / SSE 状态事件 / 4 秒轮询
 *  在同一会话上密集触发 loadMessages 时重复发起请求（请求风暴）。 */
const loadMessagesInflight = {};

export async function loadMessages(sessionID) {
    const targetId = sessionID || store.currentSessionId;
    // 侧问悬浮按钮跟随会话（无会话时传空串，按空会话刷新显隐）
    syncBtwToSession(targetId || '');
    if (!targetId) {
        // 无当前会话：仅当池中没有 tab 容器时才写空态提示；
        // 否则保留隐藏的 tab 容器与新建会话占位提示，避免误清空
        var poolEl = document.getElementById('ocMessagesPool');
        if (poolEl && !poolEl.querySelector('.oc-messages-tab')) {
            poolEl.innerHTML = '<div class="oc-empty">选择会话后查看消息，或输入内容创建新会话</div>';
        }
        return;
    }
    const box = ensureTabMessagesEl(targetId);
    if (!box) return;
    // 兜底：确保滚动分页的监听已绑定（模块求值时 #ocMessagesPool 可能尚未就绪）
    bindMessagePagingEvents();
    const existing = getCachedMessages(targetId);
    const hasCache = existing.length > 0;
    if (hasCache) {
        // 已有缓存：先把旧内容渲染出来，让用户立即看到消息、不出现加载态闪烁。
        // 但不再像以前那样“直接渲染缓存并 return”——那样会让 SSE 丢事件造成的
        // 残缺缓存永远无法通过刷新校正（只能重开会话），这正是本次修复的根因。
        // 这里继续往下走 API 拉取，用服务端权威数据修正缓存。
        renderMessages(existing, box);
    } else {
        // 无缓存 = 全新加载（会话被关闭后重开、或刚 fork 出的新会话）：
        // 重置分页状态，防止 closeSessionTab 未清理的 loadedAll 残留（来自关闭前的滚动加载）
        // 把向上滚动加载永久拦截，导致只能看到最近 20 条。
        // 注意：有缓存时绝不能重置，否则会破坏已加载的分页历史。
        sessionPaging[targetId] = { loadedAll: false, loading: false };
    }
    // 在途去重：必须在自增 seq 之前判断，否则本次被跳过的调用会把在途请求的 seq
    // 挤成“过期”，导致在途请求拉回数据后被竞态保护丢弃、双方都不渲染。
    if (loadMessagesInflight[targetId]) return;
    const seq = (store.sessionLoadSeq[targetId] = (store.sessionLoadSeq[targetId] || 0) + 1);
    loadMessagesInflight[targetId] = true;
    // 兜底看门狗：即使 withTimeout 因意外未生效，也在稍后强制释放在途锁，
    // 确保「刷新被永久跳过」不可能发生（幂等，重复置 false 无副作用）。
    const inflightWatchdog = setTimeout(function () {
        loadMessagesInflight[targetId] = false;
    }, LOAD_MESSAGES_TIMEOUT_MS + 2000);
    // 校正前的缓存快照：用于判断校正后数据是否变化，避免无谓的整列表重渲染
    const beforeJson = hasCache ? JSON.stringify(existing) : '';
    try {
        // 首次加载与缓存校正共用：并行拉取最新 20 条 + 排队中的 inbox 消息。
        // inbox（delivery: steer）是模型运行中「已发送但尚未执行」的提示词：
        // 它们不在 /message 列表里。若不合并，点「停止」时 abortSession 会先置 idle，
        // 随后的 loadMessages 走全量覆盖，把这些本地乐观卡片一并抹掉，直到下一轮
        // 输出把 inbox 消费掉才重新出现（用户反馈的「停止后输入消失」）。
        // inbox 端点不存在或请求失败时按空列表处理，绝不影响正常消息加载。
        const [res, inboxRes] = await withTimeout(
            Promise.all([
                api.OpenCodeCall('GET', `/api/session/${encodeURIComponent(targetId)}/message?limit=20`),
                api.OpenCodeCall('GET', `/api/session/${encodeURIComponent(targetId)}/inbox`)
                    .catch(function () { return null; }),
            ]),
            LOAD_MESSAGES_TIMEOUT_MS,
            '加载会话消息'
        );
        if (seq !== store.sessionLoadSeq[targetId]) return;
        // v2 返回 {data:[扁平消息], cursor}，需还原为 v1 的 [{info,parts}] 且按旧→新排列
        const incoming = adaptMessages(targetId, res);
        // 把队列中的用户提示词并入同一页数据：与正式消息共用同一个 id，
        // 消费后按 id 天然去重，不会重复渲染。
        const queued = inboxRes ? adaptInboxMessages(targetId, inboxRes) : [];
        if (queued.length) {
            const seen = new Set(incoming.map(function (it) { return it.info?.id || it.id; }));
            queued.forEach(function (item) {
                const qid = item.info?.id || item.id;
                if (qid && !seen.has(qid)) incoming.push(item);
            });
        }
        // 记下「更早一页」的服务端游标，供向上滚动分页使用。
        // desc 顺序下 cursor.next 指向更早（cursor.previous 指向更新，不能用于加载历史）
        if (!sessionPaging[targetId]) sessionPaging[targetId] = {};
        sessionPaging[targetId].cursor = nextCursor(res);
        // 校正缓存：缓存里可能已含向上分页加载的更早历史，直接整体覆盖会把它们抹掉
        // （并使“加载更多”因 loadedAll 残留而永久失效）。以 API 首条消息为锚点：
        //  - 找得到（anchorIdx>0）→ 保留锚点之前的更早历史 + 新页；
        //  - 锚点就是缓存首条（=0）→ 无更早历史，直接整体覆盖；
        //  - 找不到（窗口已被新消息错开，例如期间新增 ≥20 条）→ **按时间合并**：
        //    保留缓存中早于新页首条的全部条目，再拼新页，按 id 去重并保持旧→新，
        //    避免"刷新把已滚动加载出来的历史吞掉"。
        const idOf = (it) => String(it?.info?.id || it?.id || '');
        const createdOf = (it) => Number(it?.info?.time?.created ?? it?.time?.created ?? 0);
        const firstId = idOf(incoming[0]);
        const anchorIdx = firstId ? existing.findIndex(it => idOf(it) === firstId) : -1;
        let merged;
        if (anchorIdx > 0) {
            merged = existing.slice(0, anchorIdx).concat(incoming);
        } else if (anchorIdx === 0) {
            merged = incoming;
        } else {
            const firstTime = incoming.length ? createdOf(incoming[0]) : 0;
            const older = firstTime ? existing.filter(it => createdOf(it) < firstTime) : [];
            const seen = new Set();
            merged = older
                .concat(incoming)
                .sort((a, b) => createdOf(a) - createdOf(b))
                .filter(it => {
                    const k = idOf(it);
                    if (!k || seen.has(k)) return false;
                    seen.add(k);
                    return true;
                });
        }
        // 新页为空（极端情况）时保持缓存不动，避免把已加载历史清空
        if (incoming.length) cacheMessages(targetId, merged);
        // 仅在"全新加载"路径判断是否已全部加载，避免覆盖有分页历史会话的分页状态。
        // 判据只看**服务端是否签发续翻游标**：服务端只要页非空就会签发 next（到顶的空页会在
        // loadOlderMessages 里被识别）；不能再用解析后的条数（解析层会丢弃 idle 等边界消息）。
        if (!hasCache && !nextCursor(res)) {
            if (!sessionPaging[targetId]) sessionPaging[targetId] = {};
            sessionPaging[targetId].loadedAll = true;
            sessionPaging[targetId].loadedAllReason = '首屏无续翻游标（服务端未签发 next）';
        }
        const after = getCachedMessages(targetId);
        // 校正后数据与校正前一致时跳过重渲染，避免多余的全量重建与闪烁
        if (!hasCache || JSON.stringify(after) !== beforeJson) {
            renderMessages(after, box);
        }
    } catch (e) {
        if (seq !== store.sessionLoadSeq[targetId]) return;
        // 有缓存时校正失败不覆盖已显示内容（保留旧数据优于显示报错）
        if (!hasCache) {
            box.innerHTML = `<div class="oc-empty error">${escapeHtml(formatApiError(e))}</div>`;
        }
    } finally {
        clearTimeout(inflightWatchdog);
        loadMessagesInflight[targetId] = false;
        // 消息加载/校正完成后刷新子任务面板：数据源为服务端 child sessions，
        // 经节流调度合并高频调用（4 秒轮询 / SSE 补齐 / 用户刷新都会经过这里），
        // 不再依赖消息缓存——打开或刷新会话后子任务面板必然反映服务端最新列表。
        if (!isMobileTreeMode()) {
            scheduleSubtaskExtraction(targetId);
        }
    }
}

// ============================
// 项目树面板宽度状态
// ============================

/** 项目树面板宽度的 localStorage 键名（全局共享） */
const TREE_PANEL_WIDTH_KEY = 'treePanelWidth';
/** 项目树面板默认宽度（无记录时使用） */
const TREE_PANEL_DEFAULT_WIDTH = 240;
/** 项目树面板允许的最小宽度 */
const TREE_PANEL_MIN_WIDTH = 180;
/** 项目树面板允许的理论最大宽度 */
const TREE_PANEL_MAX_WIDTH = 420;
/** 最近一次有效的展开宽度（收起后保留，展开时恢复） */
export let treePanelWidth = TREE_PANEL_DEFAULT_WIDTH;

/**
 * 归一化用户偏好宽度
 * 仅做静态范围约束（180~420），不考虑当前窗口可用宽度
 */
export function normalizeTreePanelWidth(width) {
    const numeric = Number(width);
    if (!Number.isFinite(numeric)) return TREE_PANEL_DEFAULT_WIDTH;
    return Math.max(TREE_PANEL_MIN_WIDTH, Math.min(TREE_PANEL_MAX_WIDTH, numeric));
}

/**
 * 计算当前窗口下允许的动态最大宽度
 * 需要为中间聊天区保留至少 360px，为右侧栏保留 320px
 */
export function getTreePanelDynamicMaxWidth() {
    const client = document.getElementById('webContainer');
    if (!client) return TREE_PANEL_MAX_WIDTH;
    const availableWidth = client.clientWidth;
    // 容器隐藏（祖先 .view-panel 非 active → display:none）或尚未完成布局时，
    // clientWidth 为 0，此时无法计算动态上限。
    // 若继续用 0 参与计算（0 - 360 - 320），结果会被夹到最小值，
    // 导致窗口 resize 时把用户宽度错误钳制到最小宽度（切回工作区后面板变窄）。
    // 因此这里返回静态上限，让宽度保持用户偏好值，不参与钳制。
    if (availableWidth <= 0) return TREE_PANEL_MAX_WIDTH;
    return Math.max(TREE_PANEL_MIN_WIDTH, Math.min(TREE_PANEL_MAX_WIDTH, availableWidth - 360 - 320));
}

/**
 * 根据当前窗口大小夹取实际渲染宽度
 * 该宽度可能小于用户偏好值，但不会覆盖用户偏好本身
 */
export function clampTreePanelWidth(width) {
    return Math.max(TREE_PANEL_MIN_WIDTH, Math.min(getTreePanelDynamicMaxWidth(), normalizeTreePanelWidth(width)));
}

/**
 * 将项目树面板宽度应用到桌面端布局
 * 通过 `--tree-panel-width` 同时驱动左栏列宽与收起按钮定位
 */
export function applyTreePanelWidth(width) {
    const client = document.getElementById('webContainer');
    if (!client || isMobileTreeMode()) return;
    const nextWidth = clampTreePanelWidth(width);
    client.style.setProperty('--tree-panel-width', nextWidth + 'px');
}

/**
 * 持久化用户偏好宽度
 * 保存的是用户偏好值，不是当前窗口下的临时夹取值
 */
export function persistTreePanelWidth(width) {
    const nextWidth = normalizeTreePanelWidth(width);
    treePanelWidth = nextWidth;
    try {
        localStorage.setItem(TREE_PANEL_WIDTH_KEY, String(nextWidth));
    } catch (_) {}
    return nextWidth;
}

/**
 * 初始化项目树面板宽度
 * 优先恢复 localStorage 中的值；无记录或非法值时回退到默认值 240px
 */
export function loadTreePanelWidth() {
    let width = TREE_PANEL_DEFAULT_WIDTH;
    try {
        const saved = localStorage.getItem(TREE_PANEL_WIDTH_KEY);
        if (saved != null) {
            width = saved;
        }
    } catch (_) {}
    treePanelWidth = normalizeTreePanelWidth(width);
    applyTreePanelWidth(treePanelWidth);
    persistTreePanelWidth(treePanelWidth);
}

/**
 * 绑定项目树拖拽调宽逻辑（仅桌面端）
 * 收起状态下不响应拖拽；拖拽结束后写入 localStorage
 */
export function initTreePanelResize() {
    const treeResizeHandle = document.getElementById('ocTreeResizeHandle');
    if (!treeResizeHandle) return;
    // 同时兼容鼠标与触摸拖拽，保证移动端也能调整项目树宽度。
    const startResize = (startClientX) => {
        if (isMobileTreeMode()) return;
        const client = document.getElementById('webContainer');
        if (!client || client.classList.contains('hide-left')) return;
        const startWidth = treePanelWidth;
        let currentWidth = startWidth;
        client.classList.add('tree-resizing');
        treeResizeHandle.classList.add('dragging');

        const onMove = (moveEvent) => {
            if (moveEvent.touches) moveEvent.preventDefault();
            const clientX = moveEvent.touches ? moveEvent.touches[0].clientX : moveEvent.clientX;
            const delta = clientX - startClientX;
            currentWidth = startWidth + delta;
            applyTreePanelWidth(currentWidth);
        };

        const stopResize = () => {
            persistTreePanelWidth(currentWidth);
            applyTreePanelWidth(treePanelWidth);
            client.classList.remove('tree-resizing');
            treeResizeHandle.classList.remove('dragging');
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', stopResize);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', stopResize);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', stopResize);
            window.removeEventListener('blur', stopResize);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', stopResize);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', stopResize);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', stopResize);
        window.addEventListener('blur', stopResize);
    };

    treeResizeHandle.addEventListener('pointerdown', (event) => {
        startResize(event.clientX);
        treeResizeHandle.setPointerCapture?.(event.pointerId);
    });

    treeResizeHandle.addEventListener('touchstart', (event) => {
        event.preventDefault();
        startResize(event.touches[0].clientX);
    });
}

// ============================
// 右侧面板宽度状态
// ============================

/** 右侧面板宽度的 localStorage 键名（全局共享） */
const SIDEPANEL_WIDTH_KEY = 'sidepanelWidth';
/** 右侧面板默认宽度（无记录时使用） */
const SIDEPANEL_DEFAULT_WIDTH = 320;
/** 右侧面板允许的最小宽度 */
const SIDEPANEL_MIN_WIDTH = 220;
/** 右侧面板允许的理论最大宽度 */
const SIDEPANEL_MAX_WIDTH = 420;
/** 最近一次有效的右侧面板展开宽度 */
export let sidepanelWidth = SIDEPANEL_DEFAULT_WIDTH;

/**
 * 归一化右侧面板用户偏好宽度
 * 仅做静态范围约束（220~420），不考虑当前窗口可用宽度
 */
export function normalizeSidepanelWidth(width) {
    const numeric = Number(width);
    if (!Number.isFinite(numeric)) return SIDEPANEL_DEFAULT_WIDTH;
    return Math.max(SIDEPANEL_MIN_WIDTH, Math.min(SIDEPANEL_MAX_WIDTH, numeric));
}

/**
 * 计算当前窗口下允许的右侧面板动态最大宽度
 * 需要为中间聊天区保留至少 360px，并考虑左侧项目树当前渲染宽度
 */
export function getSidepanelDynamicMaxWidth() {
    const client = document.getElementById('webContainer');
    if (!client) return SIDEPANEL_MAX_WIDTH;
    const availableWidth = client.clientWidth;
    // 与项目树面板同理：容器隐藏或未布局时 clientWidth 为 0，
    // 无法计算动态上限，直接返回静态上限，避免把用户宽度错误钳制到最小宽度。
    if (availableWidth <= 0) return SIDEPANEL_MAX_WIDTH;
    const leftWidth = client.classList.contains('hide-left')
        ? 0
        : (parseFloat(getComputedStyle(client).getPropertyValue('--tree-panel-width')) || TREE_PANEL_DEFAULT_WIDTH);
    return Math.max(SIDEPANEL_MIN_WIDTH, Math.min(SIDEPANEL_MAX_WIDTH, availableWidth - leftWidth - 360));
}

/**
 * 根据当前窗口大小夹取右侧面板实际渲染宽度
 * 该宽度可能小于用户偏好值，但不会覆盖用户偏好本身
 */
export function clampSidepanelWidth(width) {
    return Math.max(SIDEPANEL_MIN_WIDTH, Math.min(getSidepanelDynamicMaxWidth(), normalizeSidepanelWidth(width)));
}

/**
 * 将右侧面板宽度应用到桌面端布局
 * 通过 `--sidepanel-width` 同时驱动第三列宽度与收起按钮定位
 */
export function applySidepanelWidth(width) {
    const client = document.getElementById('webContainer');
    if (!client || isMobileTreeMode()) return;
    const nextWidth = clampSidepanelWidth(width);
    client.style.setProperty('--sidepanel-width', nextWidth + 'px');
}

/**
 * 持久化用户偏好的右侧面板宽度
 * 保存的是用户偏好值，不是当前窗口下的临时夹取值
 */
export function persistSidepanelWidth(width) {
    const nextWidth = normalizeSidepanelWidth(width);
    sidepanelWidth = nextWidth;
    try {
        localStorage.setItem(SIDEPANEL_WIDTH_KEY, String(nextWidth));
    } catch (_) {}
    return nextWidth;
}

/**
 * 初始化右侧面板宽度
 * 优先恢复 localStorage 中的值；无记录或非法值时回退到默认值 320px
 */
export function loadSidepanelWidth() {
    let width = SIDEPANEL_DEFAULT_WIDTH;
    try {
        const saved = localStorage.getItem(SIDEPANEL_WIDTH_KEY);
        if (saved != null) {
            width = saved;
        }
    } catch (_) {}
    sidepanelWidth = normalizeSidepanelWidth(width);
    applySidepanelWidth(sidepanelWidth);
    persistSidepanelWidth(sidepanelWidth);
}

/**
 * 绑定右侧面板拖拽调宽逻辑（仅桌面端）
 * 收起状态下不响应拖拽；拖拽结束后写入 localStorage
 */
export function initSidepanelResize() {
    const sidepanelResizeHandle = document.getElementById('ocSidepanelResizeHandle');
    if (!sidepanelResizeHandle) return;
    // 同时兼容鼠标与触摸拖拽，保证移动端也能调整右侧面板宽度。
    const startResize = (startClientX) => {
        if (isMobileTreeMode()) return;
        const client = document.getElementById('webContainer');
        if (!client || client.classList.contains('hide-right')) return;
        const startWidth = sidepanelWidth;
        let currentWidth = startWidth;
        client.classList.add('sidepanel-resizing');
        sidepanelResizeHandle.classList.add('dragging');

        const onMove = (moveEvent) => {
            if (moveEvent.touches) moveEvent.preventDefault();
            const clientX = moveEvent.touches ? moveEvent.touches[0].clientX : moveEvent.clientX;
            const delta = startClientX - clientX;
            currentWidth = startWidth + delta;
            applySidepanelWidth(currentWidth);
        };

        const stopResize = () => {
            persistSidepanelWidth(currentWidth);
            applySidepanelWidth(sidepanelWidth);
            client.classList.remove('sidepanel-resizing');
            sidepanelResizeHandle.classList.remove('dragging');
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', stopResize);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', stopResize);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', stopResize);
            window.removeEventListener('blur', stopResize);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', stopResize);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', stopResize);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', stopResize);
        window.addEventListener('blur', stopResize);
    };

    sidepanelResizeHandle.addEventListener('pointerdown', (event) => {
        startResize(event.clientX);
        sidepanelResizeHandle.setPointerCapture?.(event.pointerId);
    });

    sidepanelResizeHandle.addEventListener('touchstart', (event) => {
        event.preventDefault();
        startResize(event.touches[0].clientX);
    });
}


// ============================
// 附件管理
// ============================

/** 读取文件为 DataURL（用 FileReader） */
export function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
    });
}

/** 添加附件（20MB 限制，防重复） */
export function addAttachment(file) {
    const size = file.size;
    if (size > 20 * 1024 * 1024) {
        showToast('附件过大，请选择 20MB 以内的文件', 'error');
        return;
    }
    const filename = file.name;
    if (store.attachedFiles.some(f => f.filename === filename && f.size === size)) {
        showToast('文件已添加: ' + filename, 'info');
        return;
    }
    readFileAsDataURL(file).then(data => {
        store.attachedFiles.push({ data, filename, mime: file.type || 'application/octet-stream', size });
        renderAttachedFiles();
    }).catch(e => {
        showToast('读取附件失败: ' + e.message, 'error');
    });
}

/** 移除指定索引的附件 */
export function removeAttachment(index) {
    store.attachedFiles.splice(index, 1);
    renderAttachedFiles();
}

/** 渲染附件列表 DOM（含删除按钮） */
export function renderAttachedFiles() {
    const list = document.getElementById('ocAttachList');
    if (!list) return;
    if (!store.attachedFiles.length) {
        list.innerHTML = '';
        return;
    }
    list.innerHTML = store.attachedFiles.map((f, i) =>
        `<span class="oc-attach-chip"><span class="oc-attach-chip-name">📎 ${escapeHtml(f.filename)}</span><span class="oc-attach-chip-remove" data-index="${i}">✕</span></span>`
    ).join('');
    list.querySelectorAll('.oc-attach-chip-remove').forEach(el => {
        el.addEventListener('click', () => removeAttachment(parseInt(el.dataset.index)));
    });
}

/** 清空全部附件 */
export function clearAttachments() {
    store.attachedFiles = [];
    renderAttachedFiles();
}

/** 构建发送消息的 parts 数组（文本 + 附件）
 *  @param {string} text 正文
 *  @param {Array} [files] 附件快照；不传时读取 store.attachedFiles。
 *  发送流程会先快照并清空附件区，用快照构建 parts，避免提交后重复触发时
 *  再次带上同一批附件（没有请求级锁时这是防重复的关键）。 */
export function buildParts(text, files) {
    const parts = [];
    if (text.trim()) {
        parts.push({ type: 'text', text });
    }
    const source = Array.isArray(files) ? files : store.attachedFiles;
    source.forEach(f => {
        parts.push({ type: 'file', mime: f.mime, filename: f.filename, url: f.data });
    });
    return parts;
}

/** 生成本地乐观消息 id，随请求通过 body.messageID 交给 opencode。
 *  opencode 的 MessageID 只校验「必须以 msg 开头」，且 createUserMessage 采用
 *  `input.messageID ?? MessageID.ascending()`，因此这个 id 会成为真实的消息 id，
 *  乐观卡片与服务端确认后的消息天然同 id，回执无需任何猜测即可精确命中。
 *  形状模仿 MessageID.ascending()（msg_ + 12 位 + 14 位，共 30 字符），
 *  前 12 位取时间戳的十六进制，保证与其他消息比较时字典序不回退。 */
export function makeLocalMessageId() {
    const stamp = Date.now().toString(16).padStart(12, '0').slice(-12);
    let suffix = '';
    while (suffix.length < 14) {
        suffix += Math.random().toString(36).slice(2);
    }
    return 'msg_' + stamp + suffix.slice(0, 14);
}

// ============================
// 会话轮询与发送按钮
// ============================

// ============================
// 会话状态与发送按钮
// ============================
// 状态写入统一走 render.js 的 setSessionStatus()。
// active 快照只在“打开会话 / SSE 重连 / 手动刷新会话”时纠偏，不做周期轮询：
// 它有登记/清除延迟，不能决定发送/停止瞬间的按钮状态。

/** 中止当前会话（调用 API，刷新状态和消息） */
/**
 * 中止当前会话
 * 调用 API 停止会话处理，更新状态并刷新消息列表
 */
export async function abortSession() {
    if (!store.webRunning || !store.currentSessionId) return;
    const btn = document.getElementById('btnSendPrompt');
    btn.disabled = true;
    const sessionID = store.currentSessionId;
    try {
        // v1 为 POST /session/{id}/abort，v2 改名为 /api/session/{id}/interrupt。
        // v2 的 interrupt 不接收 directory 查询参数（工作目录由会话自身携带），故不再拼接。
        await api.OpenCodeCall('POST', `/api/session/${encodeURIComponent(sessionID)}/interrupt`);
        showToast('已停止', 'info');
        delete store.sessionErrors[sessionID];
        // 本地意图：立即写 idle 并进入保护窗口。active 的清除有延迟，若此刻
        // 仍返回 running，快照会在窗口内被忽略，按钮不会闪回「停止」。
        setSessionStatus(sessionID, 'idle', 'local');
        await loadMessages();
        // 再用快照确认一次：服务端已 idle 时同向采纳；仍 running 则被 hold 挡住
        refreshSessionStatusFromActive(sessionID);
    } catch (e) {
        showApiError('停止失败: ', e);
    }
    btn.disabled = false;
}

// ============================
// 发送消息
// ============================

/** 发送消息主函数：新会话创建 → 构建 body → 同步发送 → 刷新消息 */
/** 不做请求级发送锁：OpenCode 自身有消息队列，模型回复期间也允许继续提交。
 *  重复触发（双击 / Enter 连按）由「提交前清空输入框 + 空文本检查」拦截，
 *  同一条内容不会被重复发送；失败回滚按各自的局部消息 id 处理。 */

// ============================
// 发送后无响应看门狗
// ============================
// 背景：发送请求可能返回 200，但模型/agent 侧迟迟不产出任何内容，界面上毫无反应
// （事件流断了、模型不可用、上游限流等都会如此）。这里以「最近一次模型活动时间」为基线，
// 发送成功 20 秒内既无流式输出、也无任何失败事件时提示用户，避免再次"石沉大海"。
// 维护方式：
//   - markPromptSendStart()：每次点击发送进入发送流程时调用（重置基线 + 清旧定时器）；
//   - notePromptActivity()：events.js 收到任意模型活动事件（text/reasoning/tool/step/execution/retry）时调用；
//   - armPromptWatch()：prompt 请求成功返回后调用（启动 20s 检查定时器）；
//   - clearPromptWatch()：发送失败或需要主动取消时调用（幂等）。
const PROMPT_WATCH_TIMEOUT_MS = 20000;
let promptActivityAt = 0;        // 最近一次（本次发送会话的）模型活动事件时间戳（毫秒）
let promptWatchSessionID = '';   // 本次发送的会话 id（arm 时写入；多 Tab 并行时只认它的活动）
let promptWatchTimer = null;

/** 发送流程开始：重置活动基线并取消上一轮看门狗 */
export function markPromptSendStart() {
    promptActivityAt = Date.now();
    promptWatchSessionID = '';
    clearPromptWatch();
}

/** 收到模型活动事件：刷新基线（由 events.js 对每条活动类 v2 事件调用）。
 *  仅认本次发送会话的事件——其它会话（多 Tab 并行）的流式输出不应掩盖本会话的静默。 */
export function notePromptActivity(sessionID) {
    if (promptWatchSessionID && sessionID && sessionID !== promptWatchSessionID) return;
    promptActivityAt = Date.now();
}

/** prompt 请求成功返回：启动无响应检查（定时器触发时若基线仍停留在 20s 前，说明始终无活动） */
export function armPromptWatch(sessionID) {
    clearPromptWatch();
    if (sessionID) promptWatchSessionID = sessionID;
    promptWatchTimer = setTimeout(function () {
        promptWatchTimer = null;
        if (Date.now() - promptActivityAt < PROMPT_WATCH_TIMEOUT_MS) return; // 期间有活动，静默
            showToast('已发送，但一直没有回应；请检查模型或智能体是否可用', 'error');
    }, PROMPT_WATCH_TIMEOUT_MS);
}

/** 取消看门狗（幂等；发送失败、流程异常时调用） */
export function clearPromptWatch() {
    if (promptWatchTimer) {
        clearTimeout(promptWatchTimer);
        promptWatchTimer = null;
    }
}

export async function sendPrompt() {
    if (!store.webRunning) return;
        const input = document.getElementById('ocPrompt');
        const text = input.value.trim();
        // 仅有知识库引用（无正文、无附件）时同样允许发送
        if (!text.trim() && !store.attachedFiles.length && !hasKnowledgeRefs()) return;
        // 立即清空输入框（不等请求返回）：即使发送中锁已复位，
        // 重复触发（键盘抖动/双击）也因无文本而被拦截，不会发两条一样的。
        input.value = '';
        // ===== /btw 侧问：命中面板固定命令时**不进会话消息流** =====
        // 普通 prompt 走「乐观用户消息 → prompt 端点 → 写入历史」；/btw 必须在此
        // 之前拦下：问题打给 /api/session/{id}/generate（transient、不写历史），
        // 答案只进侧问面板。若不拦，/btw 会因 isKnownCommand('btw') 为真
        // 被当成服务端命令 POST 出去，而服务端并不认识 btw。
        // 注意插在「乐观消息」之前：晚一步会先闪一条假用户消息。
        const btwCmd = parseBtwCommand(text);
        if (btwCmd) {
            if (!store.currentSessionId) {
                showToast('请先选择会话', 'error');
                return;
            }
            await executeFixedCmd('btw', btwCmd.args);
            return;
        }
        // ===== 面板内置命令（无参数）：前端本地执行，不发给服务端 /command =====
        // summarize/background/revert/unrevert/fork 由 OC Manager 自己实现
        // （见 chat/cmd-palette.js 的 FIXED_COMMANDS），服务端并不认识这些名字；
        // 若放行会被 POST /api/session/{id}/command 当成未知命令报错。
        const fixedMatch = /^\/([^\s/]+)\s*$/.exec(text);
        if (fixedMatch && isFixedCommand(fixedMatch[1])) {
            if (!store.currentSessionId) {
                showToast('请先选择会话', 'error');
                return;
            }
            await executeFixedCmd(fixedMatch[1]);
            return;
        }
    const btn = document.getElementById('btnSendPrompt');
    btn.disabled = true;
    // 发送中标记：updateWebUI 会无条件恢复 btnSend.disabled，靠该标记保住禁用态。
    btn.dataset.sending = '1';
    // 本次发送对应的会话 id：发送期间用户可能切换 Tab，失败回滚必须针对发起会话。
    let sendSessionID = '';
    // prompt/command 是否已被服务端接受：决定失败时能否回滚乐观 busy。
    // 已接受后的错误（如随后的 loadMessages 失败）不能回滚，否则会把运行中的会话误标空闲。
    let promptAccepted = false;
    const isNew = !store.currentSessionId;
    let sessionDir = '';
    // 本地生成消息 id 并随请求发给 opencode（body.messageID）：
    // opencode 的 MessageID 只要求以 "msg" 开头，且 createUserMessage 采用
    // input.messageID ?? MessageID.ascending()，因此乐观消息与服务端确认后的消息是
    // 同一个 id —— 回执按 id 精确命中，不再需要「取最近一条」或文本比对这类猜测。
    const localMessageId = makeLocalMessageId();
    // 附件备份：请求发出前会立即清空附件区（prompt 可能等到模型开始输出才返回），
    // 失败时用这份快照恢复，避免用户重新选择。
    let attachedBackup = [];
    try {
        // 发送流程开始：重置无响应看门狗基线（20s 内无任何模型活动会提示，见 armPromptWatch）
        markPromptSendStart();
        if (isNew) {
            if (store.pendingWorkDir) {
                sessionDir = store.pendingWorkDir;
                store.pendingWorkDir = '';
                const session = await createSessionWithDir(sessionDir);
                //设置当前目录
                document.getElementById('ocSideDirPath').textContent = sessionDir;
                store.currentSessionId = session.id || session.ID;
                store.activeTabId = store.currentSessionId;
                // 新建会话自动打开 Tab
                var newTitle = (store.sessionMap && store.sessionMap[store.currentSessionId] && store.sessionMap[store.currentSessionId].title) || store.currentSessionId;
                openSessionTab(store.currentSessionId, newTitle);
                // 标题由 OpenCode 异步生成：主动轮询更新 tab/树/标题栏
                scheduleSessionTitleRefresh(store.currentSessionId);
                // 首开的 Tab 只注册未建容器，这里手动创建并激活，否则消息会渲染进隐藏容器导致界面空白
                var sessBox = ensureTabMessagesEl(store.currentSessionId);
                if (sessBox) {
                    sessBox.classList.add('active');
                    sessBox.style.display = 'flex';
                    var poolEl = document.getElementById('ocMessagesPool');
                    if (poolEl) {
                        poolEl.querySelectorAll('.oc-messages-tab').forEach(function(c) {
                            if (c !== sessBox) { c.classList.remove('active'); c.style.display = 'none'; }
                        });
                    }
                }
                // 新建会话后重置用户消息导航索引（否则残留上一个会话的定位）
                resetUserNav();
            } else {
                 showToast('请先新建会话，设置会话目录', 'error');
                 return;
            }
        }
        if (store.currentSessionId) {
            // 先记录发起会话：写 busy 之后、sid 赋值之前也可能抛错
            // （如 collectKnowledgeRefs 失败），catch 必须能回滚这个会话。
            sendSessionID = store.currentSessionId;
            delete store.sessionErrors[sendSessionID];
            // 本地意图：立即标 busy 并进入保护窗口。active 的登记有延迟，
            // 若此刻快照仍为空，窗口内的快照不会把按钮打回「发送」。
            setSessionStatus(sendSessionID, 'busy', 'local');
            ensurePendingAssistant(store.currentSessionId);
            // 先快照并清空附件区：没有请求级发送锁，第二次触发必须看不到这批附件，
            // 否则会在等待知识库引用的间隙把同一附件再发一遍。
            attachedBackup = store.attachedFiles.slice();
            clearAttachments();
            // 乐观添加用户消息到缓存，立即显示用户输入（不等 API/事件推送）
            // 传入 localMessageId 与完整 parts（正文 + 附件快照）：该 id 会随请求发给 opencode，
            // 服务端确认后的消息 id 与本地一致，回执按 id 精确命中；附件也立即可见。
            cacheLocalUserMessage(store.currentSessionId, localMessageId, buildParts(text, attachedBackup));
            if (isMobileTreeMode()) {
                renderPendingAssistantPlaceholder(store.currentSessionId);
            } else {
                renderCachedMessages(store.currentSessionId);
            }
            smartScroll(getActiveMessagesEl(), true);
            updateSendButton();
        }
        // 知识库引用：正文与引用全文拆成独立 part，模型可区分「用户的话」与「参考资料」
        const refs = await collectKnowledgeRefs();
        const parts = buildParts(text, attachedBackup);
        refs.forEach(r => {
            parts.push({ type: 'text', text: `【知识库引用：${r.title}】\n${r.content}` });
        });
        // messageID：把本地生成的 id 交给 opencode，让乐观消息与服务端确认后的消息同 id
        // （createUserMessage 采用 input.messageID ?? MessageID.ascending()，仅校验必须以 "msg" 开头）
        const body = { parts, messageID: localMessageId };
        // 注：v2 的 prompt 请求体没有单数 agent 字段（schema 为
        // {id?, text, files?, agents?, skills?, metadata?, delivery?, resume?}，additionalProperties:false），
        // 且顶层 agents 是「附加 agent」语义、不能替代会话级配置；v2 的 agent/model
        // 必须通过会话级切换端点单独提交：
        //   POST /api/session/{id}/agent  body {agent:"<name>"}
        //   POST /api/session/{id}/model  body {model:{providerID,id,variant?}}
        // （把 agent 塞进 body、或让会话残留失效名，都会在执行时抛 Agent not found）
        const dirEl = document.getElementById('ocSideDirPath');
        const sid = store.currentSessionId;
        // 记录发起会话：发送期间切 Tab 后，catch 仍能精确回滚该会话的状态与乐观消息
        sendSessionID = sid;
        // ===== 发送前严格校验（agent）=====
        // 取值必须存在于当前 /api/agent 列表（store.agentList）：列表为空或值不在其中
        // 一律不发（回退默认），并把选择器同步复位 + 界面提示——防止历史同步回填的失效
        // 旧名（如插件改名前的「Sisyphus - Ultraworker」）被当作有效值发出去。
        // 校验通过时用列表中的当前真实值（规范化匹配消除零宽字符/大小写差异），
        // 保证发送名与服务端注册名一致。
        let agentName = '';
        const rawAgent = store.selectedAgent || '';
        if (rawAgent) {
            if (isKnownAgentName(rawAgent)) {
                    agentName = resolveKnownValue(store.agentList, rawAgent, function(a) { return a && (a.id || a.name); }) || rawAgent;
            } else if (!store.agentList.length && hasManualSessionSelection('agent')) {
                // 列表数据不可用（尚未就绪/被异步清空）但该值是用户在本会话手选的：
                // 以用户最后操作为准照发（服务端会做最终裁决），不得把手选的合法值判掉。
                // 无手选标记（历史回填）的旧名仍走下方保守回退，防止失效名漏出。
                agentName = rawAgent;
            } else {
                store.selectedAgent = '';
                const agentSelEl = document.getElementById('ocAgentSelect');
                if (agentSelEl) agentSelEl.value = '';
                showToast('原智能体 `' + rawAgent + '` 已不存在，已改用默认', 'warning');
            }
        }
        // ===== 发送前严格校验（model）=====
        // 与 agent 同理：值必须存在于当前 /api/model 列表（store.modelList），
        // 否则不切换模型（回退会话默认）并提示。
        let modelRef = null;
        let resolvedModel = '';
        const rawModel = store.selectedModel || '';
        if (rawModel) {
            resolvedModel = isKnownModelId(rawModel)
                ? (resolveKnownValue(store.modelList, rawModel, function(m) { return m && m.value; }) || rawModel)
                : '';
            if (!resolvedModel && !store.modelList.length && hasManualSessionSelection('model')) {
                // 与 agent 同一口径：列表不可用但值为用户手选时以用户最后操作为准，
                // 仍交给 toModelRef 做形状校验（"provider/model" 形式不合法则回退默认）。
                resolvedModel = rawModel;
            }
            if (resolvedModel) {
                // ===== 发送前严格校验（variant）=====
                // 思考强度必须属于当前模型的 variants 名单：切换模型后若仍残留上一个模型的
                // 档位（如 xhigh），会话级模型切换端点会直接拒绝，导致整条提示词发送失败。
                // 名单为空（模型无 variants 元数据，或列表尚未就绪）时保持用户选择照发，
                // 交由服务端做最终裁决——与 agent/model 的「手选优先」口径一致。
                const supportedVariants = variantValuesForModel(resolvedModel);
                const rawVariant = store.selectedVariant || '';
                // 只在模型列表已加载时做严格校验：列表不可用（走手选照发分支）时
                // 无法判定，保持原值交给服务端裁决。
                if (rawVariant && store.modelList.length && supportedVariants.indexOf(rawVariant) < 0) {
                    store.selectedVariant = '';
                    const variantSelEl = document.getElementById('ocVariantSelect');
                    if (variantSelEl) syncVariantSelect(variantSelEl, resolvedModel, '');
                    showToast('原思考强度 `' + variantLabel(rawVariant) + '` 当前模型不支持，已改用默认', 'warning');
                }
                modelRef = toModelRef(resolvedModel, store.selectedVariant);
            }
            if (!modelRef) {
                store.selectedModel = '';
                const modelSelEl = document.getElementById('ocModelSelect');
                if (modelSelEl) modelSelEl.value = '';
                showToast('原模型 `' + rawModel + '` 已不存在，已回退默认', 'warning');
            }
        }
        // 会话级切换先于 prompt：任一失败都中止本次发送并给出「HTTP 状态码 + 响应体 message」
        // 的可见报错（formatApiError），绝不带着失效/未经确认的选择继续发送。
        // 注：v2 的 prompt / model / interrupt 端点均不接收 directory 查询参数
        // （工作目录由会话自身携带），故这里不再拼接目录查询串。
        if (agentName) {
            try {
                await api.OpenCodeCall('POST', `/api/session/${encodeURIComponent(sid)}/agent`, { agent: agentName });
            } catch (e) {
                throw new Error('切换 agent（' + agentName + '）失败: ' + formatApiError(e));
            }
        }
        if (modelRef) {
            try {
                await api.OpenCodeCall('POST', `/api/session/${encodeURIComponent(sid)}/model`, { model: modelRef });
            } catch (e) {
                throw new Error('切换模型（' + resolvedModel + '）失败: ' + formatApiError(e));
            }
        }
        // v2 命令与提示词是两个端点：正文形如 "/命令名 [参数]"：
        //  - 命中**技能 id** → 不调命令端点，而是把技能作为 prompt 的 skills 附件（下文 body.skills）；
        //  - 命中**服务端命令** → 走 POST /api/session/{id}/command（body {command,text,delivery}），
        //    否则会被当普通文本喂给模型、命令不会执行；
        //  - 都不命中 → 照常走 prompt。
        // 附件区已在进入发送流程时快照并清空（见上方），这里不再重复清空。
        const cmdMatch = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text);
        const skillId = cmdMatch && isKnownSkill(cmdMatch[1]) ? cmdMatch[1] : '';
        if (cmdMatch && !skillId && isKnownCommand(cmdMatch[1])) {
            // v2 的 /api/session/{id}/command 载荷字段是 name（不是 command）；
            // 传错字段会被 Effect Schema 拒绝：400 Missing key at ["name"]。
            await api.OpenCodeCall('POST', `/api/session/${encodeURIComponent(sid)}/command`, {
                name: cmdMatch[1],
                text: (cmdMatch[2] || '').trim(),
                delivery: 'steer',
            });
        } else {
            if (skillId) body.skills = [{ id: skillId }];
            await api.OpenCodeCall('POST', `/api/session/${encodeURIComponent(sid)}/prompt`, toPromptBody(body));
        }
        // 请求已被服务端接受：后续步骤（刷新消息等）失败不能回滚 busy，
        // 否则会把真正运行中的会话误标为空闲。
        promptAccepted = true;
        // 发送成功：启动无响应看门狗——20s 内既无流式输出也无失败事件时提示（见 armPromptWatch）
        armPromptWatch(sid);
        if (isNew) {
            dirEl.onclick = function() {
                // 右侧面板会话目录：点击直接打开独立窗口（桌面端原生窗口 / Web 端新标签页）
                openFileBrowserStandaloneFor(requestDir, { features: ['git'] });
            };
        }
        clearKnowledgeRefs();
        if (!isMobileTreeMode()) {
            await loadMessages();
        }
        smartScroll(getActiveMessagesEl(), true);
        // 状态由本地意图 + SSE 事件/活动事件驱动；active 不参与发送后的周期判定。
        updateSendButton();
    } catch (e) {
        // 发送失败：取消无响应看门狗，按 id 精确移除乐观用户消息，避免残留"已发送"假象。
        // 错误信息经 formatApiError 展开：带 HTTP 状态码 + 响应体解析后的人话（v2 错误体
        // 形如 {"kind":"Payload","message":"..."}，直接显示原始正文用户难以理解）。
        clearPromptWatch();
        if (sendSessionID) {
            // 服务端已接受本次 prompt 时，消息与占位都已是服务端状态的一部分：
            // 后续步骤异常（例如刷新消息、切目录回调）不得回滚它们，否则会把用户
            // 已经发出的提问和正在生成的回复从界面删掉。
            if (!promptAccepted) {
                removeLocalUserMessage(sendSessionID, localMessageId);
                // 同时移除 ensurePendingAssistant 生成的占位，否则失败后消息区会一直
                // 显示「正在等待模型回复...」，让用户误以为消息已发出。
                removePendingAssistant(sendSessionID);
                if (sendSessionID === store.currentSessionId) {
                    // 缓存已回滚：重渲染当前会话，清掉刚渲染出的乐观消息与等待占位
                    renderCachedMessages(sendSessionID);
                }
                // 请求未被服务端接受（agent/model 切换失败、prompt/command 报错）：
                // 立即回滚乐观 busy（holdMs:0，不进入保护窗口），否则按钮会停在「停止」，
                // 点击走 abort 而非发送。已接受后的错误不回滚（见 promptAccepted）。
                setSessionStatus(sendSessionID, 'idle', 'local', { holdMs: 0 });
            }
        }
        // 发送失败：恢复发送前清空的附件，避免用户重新选择
        if (attachedBackup.length) {
            store.attachedFiles = attachedBackup;
            renderAttachedFiles();
        }
        showToast('发送失败: ' + formatApiError(e), 'error');
    }
    btn.dataset.sending = '';
    btn.disabled = !store.webRunning;
}

// ============================================================
// Tab 激活加载回调注入
// tabs.js 的 activateTabContainer 在目标容器不存在时会触发加载，
// ESM 下为避免 tabs↔session 循环依赖，由本模块在加载完成后注入回调。
// ============================================================
setTabActivationHandler(function() {
    if (store.currentSessionId) loadMessages();
});

// 切回会话时：若标题仍是占位值，重新启动轮询补齐。
// 轮询在切走时已自行停止（sessionID !== currentSessionId），不重启就再也拿不到真标题。
// tabs.js 用自定义事件通知，避免 tabs↔session 循环依赖。
document.addEventListener('oc-session-activated', function(e) {
    const sid = e && e.detail && e.detail.sessionID;
    if (!sid || sid !== store.currentSessionId) return;
    if (isPlaceholderSessionTitle(store.sessionMap?.[sid]?.title, sid)) {
        scheduleSessionTitleRefresh(sid);
    }
});

// ============================================================
// 分页事件绑定：消息容器滚动到顶加载更早；用户定位到边界触发
// ============================================================
// 注意：不能只在模块求值时绑定一次——若那时 #ocMessagesPool 尚未就绪，
// 监听会永远绑不上（表现为"上滑毫无反应"）。故做成幂等函数，
// 在模块加载、DOMContentLoaded、以及每次 loadMessages 时各尝试一次。
export function bindMessagePagingEvents() {
    const pool = document.getElementById('ocMessagesPool');
    if (pool && !pool.dataset.pagingBound) {
        pool.dataset.pagingBound = 'true';
        let scrollTimer = null;
        let scrollStateTimer = null;
        // 第三个参数 true = 捕获阶段：scroll 不冒泡，但捕获可到达子容器的滚动事件
        pool.addEventListener('scroll', function(e) {
            // 滚动时同步「是否贴底」并刷新「滚到底」按钮。
            // 缺了这一步：用户在顶部停留后 store.tabStickBottom 仍是上次渲染的值
            // （默认视为贴底），触发上滑加载时 renderMessages 会把列表滚到底部。
            if (scrollStateTimer) clearTimeout(scrollStateTimer);
            scrollStateTimer = setTimeout(updateScrollBottomButton, 60);
            if (scrollTimer) clearTimeout(scrollTimer);
            scrollTimer = setTimeout(function() {
                const box = getActiveMessagesEl();
                if (!box) return;
                const sid = store.currentSessionId;
                // 内容不满一屏时 scrollTop 恒为 0，这是布局结果而非「用户上滑」，
                // 不能据此触发分页（新建会话只发一两条消息时最典型）。
                if (box.scrollHeight - box.clientHeight <= 8) return;
                if (box.scrollTop <= 5) {
                    loadOlderMessages(sid);
                }
            }, 250);
        }, true);
    }
    if (document.body && !document.body.dataset.pagingOcBound) {
        document.body.dataset.pagingOcBound = '1';
        // 用户定位（▲ 到最早一条）触发加载更早消息
        document.addEventListener('oc-load-older', function() {
            loadOlderMessages(store.currentSessionId);
        });
    }
}
bindMessagePagingEvents();
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindMessagePagingEvents, { once: true });
}

// ============================================================
// 会话动作注册中心注册
// events.js / cmd-palette.js 经 core/utils.js 调用以下实现（解环，说明见 core/utils.js）。
// 函数声明提升保证此处可引用；注册在模块求值期完成，先于任何运行时调用。
// ============================================================
setSessionActionHandlers({
    loadMessages,
    loadOlderMessages,
    isSessionLoadedAll,
    refreshSessionTitle,
    selectSession,
    loadAgentModelSelectors,
    notePromptActivity,
});
