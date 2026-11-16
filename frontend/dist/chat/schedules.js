// ============================================================
// chat/schedules.js — 会话定时任务
// 依赖：core/state.js、core/utils.js、core/apicall.js、core/format.js
// 数据源：/api/experimental/schedule（OpenCode experimental）
// ============================================================

import { api } from '../core/apicall.js';
import { store } from '../core/state.js';
import { escapeHtml, showToast, showApiError, bindOverlayClose } from '../core/utils.js';
import { showConfirm } from '../core/dialog.js';
import { formatDateTime } from '../core/format.js';

const API_BASE = '/api/experimental/schedule';
const POLL_MS = 30000;

const scheduleState = {
    sessionID: '',
    items: [],
    loading: false,
    enabled: true,
    error: '',
    pollTimer: 0,
    tab: 'repeat',
    freq: 'daily',
    weekdays: [1, 2, 3, 4, 5],
};

const PAUSE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14M15 5v14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z" fill="currentColor"/></svg>';
// 垃圾桶图标：与 MCP 连接器列表、知识库卡片保持同一套路径与线宽
const TRASH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function $(id) { return document.getElementById(id); }

function currentSessionID() {
    return store.currentSessionId || '';
}

/** 服务端时间字段统一成毫秒；兼容秒级时间戳。 */
function toMs(value) {
    const n = Number(value || 0);
    return n > 0 && n < 1e12 ? n * 1000 : n;
}

/** 判断 403 是否是「实验性定时任务未启用」。 */
function isDisabledError(e) {
    const text = String((e && (e.message || e.error)) || e || '');
    return text.indexOf('Scheduled tasks are disabled') >= 0 || text.indexOf('Forbidden') >= 0;
}

function statusText(status) {
    return ({
        active: '运行中',
        paused: '已暂停',
        done: '已完成',
        completed: '已完成',
        error: '失败',
        pending: '等待中',
    })[status] || status || '';
}

/** 状态圆点类名：active 蓝、paused 黄、done 绿、error 红。 */
function statusDotClass(status) {
    if (status === 'active') return 'running';
    if (status === 'paused') return 'paused';
    if (status === 'done' || status === 'completed') return 'done';
    if (status === 'error') return 'error';
    return 'pending';
}

/** 把 Schedule.Info.when 转成可读规则。 */
function describeWhen(task) {
    const when = task && task.when ? task.when : {};
    const tz = task.tz || when.tz || '';
    if (when.in) return '延迟 ' + when.in;
    if (when.at) return '指定时间 ' + String(when.at).replace('T', ' ');
    if (when.every) return '每 ' + when.every;
    if (when.cron) return 'cron ' + when.cron + (tz ? ' · ' + tz : '');
    return '';
}

function schedulePrompt(task) {
    const action = task && task.action;
    return action && action.prompt ? String(action.prompt) : '';
}

function scheduleName(task) {
    if (task && task.name) return String(task.name);
    const prompt = schedulePrompt(task);
    return prompt ? prompt.slice(0, 28) : '定时任务';
}

function renderActionButtons(task) {
    const id = escapeHtml(task.id || '');
    let html = '';
    if (task.status === 'active') {
        html += '<button type="button" class="oc-schedule-icon-btn" data-schedule-action="pause" data-schedule-id="' + id + '" title="暂停" aria-label="暂停">' + PAUSE_SVG + '</button>';
    } else if (task.status === 'paused') {
        html += '<button type="button" class="oc-schedule-icon-btn" data-schedule-action="resume" data-schedule-id="' + id + '" title="恢复" aria-label="恢复">' + PLAY_SVG + '</button>';
    }
    html += '<button type="button" class="oc-schedule-icon-btn danger" data-schedule-action="delete" data-schedule-id="' + id + '" title="删除" aria-label="删除">' + TRASH_SVG + '</button>';
    return html;
}

function renderScheduleItem(task) {
    const status = task.status || 'pending';
    const rule = describeWhen(task);
    const next = task.nextDueAt ? formatDateTime(toMs(task.nextDueAt)) : '';
    const meta = [rule, next ? '下次 ' + next : ''].filter(Boolean).join(' · ');
    const prompt = schedulePrompt(task);

    return '<div class="oc-schedule-item" data-schedule-id="' + escapeHtml(task.id || '') + '">'
        + '<div class="oc-schedule-main">'
        + '<div class="oc-schedule-title">'
        + '<span class="oc-schedule-dot ' + statusDotClass(status) + '" title="' + escapeHtml(statusText(status)) + '"></span>'
        + '<span class="oc-schedule-name">' + escapeHtml(scheduleName(task)) + '</span>'
        + '<span class="oc-schedule-actions">' + renderActionButtons(task) + '</span>'
        + '</div>'
        + (meta ? '<div class="oc-schedule-meta">' + escapeHtml(meta) + '</div>' : '')
        + (prompt ? '<div class="oc-schedule-prompt" title="' + escapeHtml(prompt) + '">' + escapeHtml(prompt) + '</div>' : '')
        + '</div>'
        + '</div>';
}

export function renderSchedulePanel() {
    const box = $('ocSchedules');
    if (!box) return;

    if (!scheduleState.sessionID) {
        box.innerHTML = '<div class="empty-state empty-state--sm">请先选择会话</div>';
        return;
    }
    if (scheduleState.loading && !scheduleState.items.length) {
        box.innerHTML = '<div class="empty-state empty-state--sm">正在加载定时任务…</div>';
        return;
    }
    if (!scheduleState.enabled) {
        box.innerHTML = '<div class="empty-state empty-state--sm">定时任务未启用'
            + '<div style="margin-top:4px;font-size:10.5px">在 opencode.jsonc 开启 <code>experimental.schedules</code> 后重启服务</div>'
            + '</div>';
        return;
    }
    if (scheduleState.error) {
        box.innerHTML = '<div class="empty-state empty-state--sm empty-state--error">' + escapeHtml(scheduleState.error) + '</div>';
        return;
    }
    if (!scheduleState.items.length) {
        box.innerHTML = '<div class="empty-state empty-state--sm">当前会话暂无定时任务</div>';
        return;
    }
    box.innerHTML = scheduleState.items.map(renderScheduleItem).join('');
}

/** 读取计划列表。403 表示实验性功能未开启，不当作错误弹窗。 */
export async function refreshSchedulePanel(options) {
    const sessionID = (options && options.sessionID) || currentSessionID();
    if (!sessionID) {
        scheduleState.sessionID = '';
        scheduleState.items = [];
        scheduleState.enabled = true;
        scheduleState.error = '';
        renderSchedulePanel();
        return;
    }

    const requestSID = sessionID;
    scheduleState.sessionID = sessionID;
    scheduleState.loading = true;
    scheduleState.error = '';
    renderSchedulePanel();

    try {
        const res = await api.OpenCodeCall('GET', API_BASE + '?sessionID=' + encodeURIComponent(requestSID));
        const data = res && res.data !== undefined ? res.data : res;
        if (scheduleState.sessionID !== requestSID) return;
        scheduleState.items = Array.isArray(data) ? data : [];
        scheduleState.enabled = true;
    } catch (e) {
        if (scheduleState.sessionID !== requestSID) return;
        scheduleState.items = [];
        if (isDisabledError(e)) {
            scheduleState.enabled = false;
            scheduleState.error = '';
        } else {
            scheduleState.enabled = true;
            scheduleState.error = String((e && (e.message || e.error)) || e || '加载失败');
        }
    } finally {
        if (scheduleState.sessionID === requestSID) {
            scheduleState.loading = false;
            renderSchedulePanel();
        }
    }
}

function onScheduleListClick(event) {
    const button = event.target.closest('[data-schedule-action]');
    if (button) {
        event.stopPropagation();
        const id = button.dataset.scheduleId;
        const action = button.dataset.scheduleAction;
        if (action === 'pause') pauseSchedule(id);
        else if (action === 'resume') resumeSchedule(id);
        else if (action === 'delete') deleteSchedule(id);
        return;
    }
    const card = event.target.closest('.oc-schedule-item');
    if (card) openScheduleDetail(card.dataset.scheduleId);
}

async function pauseSchedule(id) {
    if (!id) return;
    try {
        await api.OpenCodeCall('POST', API_BASE + '/' + encodeURIComponent(id) + '/pause');
        showToast('已暂停', 'success');
        refreshSchedulePanel();
    } catch (e) {
        showApiError('暂停失败: ', e);
    }
}

async function resumeSchedule(id) {
    if (!id) return;
    try {
        await api.OpenCodeCall('POST', API_BASE + '/' + encodeURIComponent(id) + '/resume');
        showToast('已恢复', 'success');
        refreshSchedulePanel();
    } catch (e) {
        showApiError('恢复失败: ', e);
    }
}

async function deleteSchedule(id) {
    if (!id) return;
    const confirmed = await showConfirm({
        title: '删除定时任务',
        message: '确定要删除这个定时任务吗？删除后无法恢复。',
        okText: '删除'
    });
    if (!confirmed) return;
    try {
        await api.OpenCodeCall('DELETE', API_BASE + '/' + encodeURIComponent(id));
        showToast('已删除', 'success');
        refreshSchedulePanel();
    } catch (e) {
        showApiError('删除失败: ', e);
    }
}

// ============================================================
// 新建弹窗
// ============================================================

function modalEl() { return $('scheduleModal'); }

function setVisible(el, visible) {
    if (!el) return;
    el.style.display = visible ? 'flex' : 'none';
}

function selectedOnceMode() {
    const el = document.querySelector('input[name="scheduleOnceMode"]:checked');
    return el ? el.value : 'delay';
}

function selectedEndsMode() {
    const el = document.querySelector('input[name="scheduleEndsMode"]:checked');
    return el ? el.value : 'never';
}

function selectedScheduleTab() {
    const active = document.querySelector('#scheduleTabs .oc-schedule-tab.active');
    return active ? active.dataset.tab : 'repeat';
}

function switchScheduleTab(tab) {
    scheduleState.tab = tab;
    document.querySelectorAll('#scheduleTabs .oc-schedule-tab').forEach(function (button) {
        button.classList.toggle('active', button.dataset.tab === tab);
    });
    $('schedulePanelOnce').hidden = tab !== 'once';
    $('schedulePanelRepeat').hidden = tab !== 'repeat';
    syncScheduleForm();
}

function syncScheduleForm() {
    const tab = selectedScheduleTab();
    const onceMode = selectedOnceMode();
    const freq = scheduleState.freq;

    if ($('scheduleDelayRow')) $('scheduleDelayRow').hidden = tab !== 'once' || onceMode !== 'delay';
    if ($('scheduleOnceAtRow')) $('scheduleOnceAtRow').hidden = tab !== 'once' || onceMode === 'delay';
    if ($('scheduleIntervalRow')) $('scheduleIntervalRow').hidden = tab !== 'repeat' || freq !== 'hourly';
    if ($('scheduleTimeRow')) $('scheduleTimeRow').hidden = tab !== 'repeat' || freq === 'hourly' || freq === 'custom';
    if ($('scheduleWeekdayRow')) $('scheduleWeekdayRow').hidden = tab !== 'repeat' || freq !== 'weekly';
    if ($('scheduleMonthDayRow')) $('scheduleMonthDayRow').hidden = tab !== 'repeat' || freq !== 'monthly';
    if ($('scheduleCronRow')) $('scheduleCronRow').hidden = tab !== 'repeat' || freq !== 'custom';
    if ($('scheduleEndsRow')) $('scheduleEndsRow').hidden = tab === 'once';
    updateCronExplain();
}

function updateCronExplain() {
    const el = $('scheduleCronExplain');
    if (!el) return;
    const expr = ($('scheduleCron') && $('scheduleCron').value || '').trim();
    const parts = expr.split(/\s+/);
    if (parts.length !== 5) {
        el.textContent = '需要 5 段：分 时 日 月 周';
        return;
    }
    el.textContent = 'cron：' + expr;
}

function syncWeekdayChips() {
    document.querySelectorAll('#scheduleWeekdays [data-day]').forEach(function (chip) {
        chip.classList.toggle('active', scheduleState.weekdays.indexOf(Number(chip.dataset.day)) !== -1);
    });
}

function resetScheduleForm() {
    if ($('scheduleName')) $('scheduleName').value = '';
    if ($('schedulePrompt')) $('schedulePrompt').value = '';
    if ($('scheduleCron')) $('scheduleCron').value = '0 9 * * *';
    if ($('scheduleOnceAt')) $('scheduleOnceAt').value = '';
    if ($('scheduleEndsTimes')) $('scheduleEndsTimes').value = '20';
    if ($('scheduleEndsAt')) $('scheduleEndsAt').value = '';
    if ($('scheduleTime')) $('scheduleTime').value = '09:00';
    if ($('scheduleIntervalValue')) $('scheduleIntervalValue').value = '2';
    if ($('scheduleIntervalUnit')) $('scheduleIntervalUnit').value = 'hours';
    if ($('scheduleMonthDay')) $('scheduleMonthDay').value = '1';

    const delayRadio = document.querySelector('input[name="scheduleOnceMode"][value="delay"]');
    if (delayRadio) delayRadio.checked = true;
    const neverRadio = document.querySelector('input[name="scheduleEndsMode"][value="never"]');
    if (neverRadio) neverRadio.checked = true;
    if ($('scheduleEndsTimes')) $('scheduleEndsTimes').disabled = true;
    if ($('scheduleEndsAt')) $('scheduleEndsAt').disabled = true;

    scheduleState.freq = 'daily';
    if ($('scheduleFreq')) $('scheduleFreq').value = 'daily';
    scheduleState.weekdays = [1, 2, 3, 4, 5];
    syncWeekdayChips();
    switchScheduleTab('repeat');
}

function openScheduleModal() {
    resetScheduleForm();
    setVisible(modalEl(), true);
}

function closeScheduleModal() {
    setVisible(modalEl(), false);
}

function buildWhen() {
    const tab = selectedScheduleTab();
    if (tab === 'once') {
        if (selectedOnceMode() === 'delay') {
            const value = ($('scheduleDelayValue') && $('scheduleDelayValue').value) || '20';
            const unit = ($('scheduleDelayUnit') && $('scheduleDelayUnit').value) || 'minutes';
            return { in: value + ' ' + unit };
        }
        const at = $('scheduleOnceAt') && $('scheduleOnceAt').value;
        return at ? { at: at } : null;
    }

    const tz = ($('scheduleTz') && $('scheduleTz').value) || 'Asia/Shanghai';
    const freq = scheduleState.freq;
    if (freq === 'hourly') {
        const value = ($('scheduleIntervalValue') && $('scheduleIntervalValue').value) || '2';
        const unit = ($('scheduleIntervalUnit') && $('scheduleIntervalUnit').value) || 'hours';
        return { every: value + ' ' + unit };
    }
    if (freq === 'daily') {
        return { cron: timeCron('*'), tz: tz };
    }
    if (freq === 'weekly') {
        if (!scheduleState.weekdays.length) return null;
        const days = scheduleState.weekdays.slice().sort(function (a, b) { return a - b; }).join(',');
        return { cron: timeCron(days), tz: tz };
    }
    if (freq === 'monthly') {
        const day = ($('scheduleMonthDay') && $('scheduleMonthDay').value) || '1';
        return { cron: timeCron(day, true), tz: tz };
    }
    const custom = ($('scheduleCron') && $('scheduleCron').value || '').trim();
    return custom ? { cron: custom, tz: tz } : null;
}

function timeCron(dayPart, monthly) {
    const value = ($('scheduleTime') && $('scheduleTime').value) || '09:00';
    const parts = value.split(':');
    const h = String(parseInt(parts[0], 10) || 0);
    const m = String(parseInt(parts[1], 10) || 0);
    if (monthly) return m + ' ' + h + ' ' + dayPart + ' * *';
    return m + ' ' + h + ' * * ' + dayPart;
}

function buildEnds() {
    const mode = selectedEndsMode();
    if (mode === 'times') {
        return { times: parseInt(($('scheduleEndsTimes') && $('scheduleEndsTimes').value) || '1', 10) || 1 };
    }
    if (mode === 'at') {
        const at = $('scheduleEndsAt') && $('scheduleEndsAt').value;
        return at ? { at: at } : null;
    }
    return undefined;
}

async function createSchedule() {
    const prompt = ($('schedulePrompt') && $('schedulePrompt').value || '').trim();
    if (!prompt) {
        showToast('请填写到点后发送的内容', 'warning');
        return;
    }
    const when = buildWhen();
    if (!when) {
        showToast(selectedScheduleTab() === 'once' ? '请填写指定时间' : '请补全重复规则', 'warning');
        return;
    }
    const body = {
        sessionID: currentSessionID(),
        prompt: prompt,
        when: when,
    };
    const name = ($('scheduleName') && $('scheduleName').value || '').trim();
    if (name) body.name = name;
    if (selectedScheduleTab() !== 'once') {
        const ends = buildEnds();
        if (ends) body.ends = ends;
    }

    try {
        await api.OpenCodeCall('POST', API_BASE, body);
        closeScheduleModal();
        showToast('已创建定时任务', 'success');
        refreshSchedulePanel();
    } catch (e) {
        showApiError('创建失败: ', e);
    }
}

// ============================================================
// 只读详情
// ============================================================

function openScheduleDetail(id) {
    const task = scheduleState.items.find(function (item) { return item.id === id; });
    if (!task) return;
    const set = function (field, value) {
        const el = $(field);
        if (el) el.textContent = value || '—';
    };
    set('scheduleDetailName', scheduleName(task));
    set('scheduleDetailStatus', statusText(task.status));
    set('scheduleDetailRule', describeWhen(task));
    set('scheduleDetailNext', task.nextDueAt ? formatDateTime(toMs(task.nextDueAt)) : '');
    set('scheduleDetailPrompt', schedulePrompt(task));
    setVisible($('scheduleDetailModal'), true);
}

function closeScheduleDetail() {
    setVisible($('scheduleDetailModal'), false);
}

// ============================================================
// 初始化与轮询
// ============================================================

function syncSchedulePolling() {
    const section = $('schedulePanelSection');
    const active = section && !section.classList.contains('collapsed') && scheduleState.enabled && scheduleState.sessionID;
    if (!active) {
        if (scheduleState.pollTimer) {
            clearInterval(scheduleState.pollTimer);
            scheduleState.pollTimer = 0;
        }
        return;
    }
    if (scheduleState.pollTimer) return;
    scheduleState.pollTimer = setInterval(function () {
        refreshSchedulePanel();
    }, POLL_MS);
}

export function initSchedules() {
    const list = $('ocSchedules');
    if (list) list.addEventListener('click', onScheduleListClick);

    const newBtn = $('btnNewSchedule');
    if (newBtn) {
        newBtn.addEventListener('click', function (event) {
            event.stopPropagation();
            openScheduleModal();
        });
    }

    $('btnScheduleClose')?.addEventListener('click', closeScheduleModal);
    $('btnScheduleCancel')?.addEventListener('click', closeScheduleModal);
    $('btnScheduleCreate')?.addEventListener('click', createSchedule);
    $('btnScheduleDetailClose')?.addEventListener('click', closeScheduleDetail);

    // 遮罩关闭统一走项目公共实现：只有按下与松开都在遮罩本身才关闭，
    // 避免在弹窗内按下、拖到遮罩上松开时被 click 的最近共同祖先规则误关。
    const modal = modalEl();
    if (modal) bindOverlayClose(modal, closeScheduleModal);
    const detail = $('scheduleDetailModal');
    if (detail) bindOverlayClose(detail, closeScheduleDetail);

    const tabs = $('scheduleTabs');
    if (tabs) {
        tabs.addEventListener('click', function (event) {
            const button = event.target.closest('[data-tab]');
            if (button) switchScheduleTab(button.dataset.tab);
        });
    }

    $('scheduleFreq')?.addEventListener('change', function (event) {
        scheduleState.freq = event.target.value;
        syncScheduleForm();
    });

    document.querySelectorAll('input[name="scheduleOnceMode"]').forEach(function (input) {
        input.addEventListener('change', syncScheduleForm);
    });
    document.querySelectorAll('input[name="scheduleEndsMode"]').forEach(function (input) {
        input.addEventListener('change', function (event) {
            const mode = event.target.value;
            if ($('scheduleEndsTimes')) $('scheduleEndsTimes').disabled = mode !== 'times';
            if ($('scheduleEndsAt')) $('scheduleEndsAt').disabled = mode !== 'at';
            syncScheduleForm();
        });
    });

    const weekdays = $('scheduleWeekdays');
    if (weekdays) {
        weekdays.addEventListener('click', function (event) {
            const chip = event.target.closest('[data-day]');
            if (!chip) return;
            const day = Number(chip.dataset.day);
            const index = scheduleState.weekdays.indexOf(day);
            if (index === -1) scheduleState.weekdays.push(day);
            else scheduleState.weekdays.splice(index, 1);
            syncWeekdayChips();
            syncScheduleForm();
        });
    }

    $('scheduleCron')?.addEventListener('input', updateCronExplain);

    const head = $('schedulePanelHead');
    if (head) {
        head.addEventListener('click', function () {
            setTimeout(syncSchedulePolling, 0);
        });
    }

    // 初始化时如果侧栏已展开，拉一次当前会话
    refreshSchedulePanel();
    syncSchedulePolling();
}
