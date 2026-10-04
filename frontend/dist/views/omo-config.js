// ============================================================
// OpenCode 管理中心 - OMO 配置视图（oh-my-opencode-slim 方案编辑器）
// ============================================================
// 改造说明：本视图从「编辑 oh-my-openagent 的模型映射」改造为
// 「编辑 oh-my-opencode-slim 插件配置文件」。数据全部来自后端
// GetSlimConfig 的继承合成结果，前端不再自行解析 JSON。
//
// 核心概念：
//   - 方案（preset）= 一组 agent 的「模型 + variant（思考力度）」映射；
//     radio 单选表示「当前启用的方案」，切换后随「保存配置」统一提交。
//   - 带 extends 的方案：agents 中 inherited=true 的行来自父方案，
//     其中被本方案覆盖的行 overridden=true（显示「已覆盖」）。
//   - 保存（SaveSlimConfig）语义：
//       无 extends 方案 → 提交全部行（dirty 恒 true）；
//       有 extends 方案 → 只提交 dirty 行（覆盖行 overridden / 本方案新增行）；
//       deleted=true 显式删除方案（缺失默认保留，必须显式标记）；
//       baseRevision 用于冲突检测（不一致时后端拒绝保存）。
//
// 视觉基准：doc/proto/omo-slim-config-prototype.html（克制、朴素，
// 观感 = 「现在的 OMO 配置界面只换了数据对象」）。
// ============================================================
import { api } from '../core/apicall.js';
import { openFileBrowserModal } from '../filebrowser/browser.js';
import { showToast } from '../core/utils.js';
import { store, currentDir } from '../core/state.js';
import { toModelOptions } from '../core/v2compat.js';

// ========== 视图状态（全部由 loadModelConfig 填充） ==========
export let slimPath = '';           // 配置文件路径
export let slimExists = false;      // 配置文件是否存在（不存在时保存即创建）
export let parseError = '';         // 配置解析错误（非空时禁止保存，避免覆盖坏文件）
export let activePresetName = '';   // 当前启用方案（radio 选中项；来自配置文件）
export let revision = '';           // 内容哈希（保存时做冲突检测的基线）
export let presets = [];            // 方案数组（含前端编辑状态与 deleted 标记）
export let envPresetOverride = '';  // 环境变量指定的方案（非空时提示「可能不生效」）
export let projectConfigPath = '';  // 项目级配置路径（非空时提示「项目级优先」）
export let hasUnsavedChanges = false;

// 变更检测基线：加载/保存成功后的状态 JSON 快照，任何编辑后对比它
let originalSnapshot = '';

// ========== 常量 ==========
// 新增条目时的内置 agent 名建议（下拉允许「自定义…」输入任意名称）
export const SLIM_AGENT_KEYS = [
    'orchestrator', 'oracle', 'librarian', 'explorer',
    'designer', 'fixer', 'observer', 'council',
];
// variant（思考力度）选项；文件里的当前值若不在列表会被合并出现，避免吞掉自定义值
export const SLIM_VARIANT_OPTIONS = ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// ========== 小工具 ==========

/** HTML 转义（统一处理文本与属性两种上下文，防止方案名/模型值里的特殊字符破坏结构） */
function esc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** 模型下拉选项 HTML：当前值不在已知列表时补入（沿用原「不吞掉配置文件现值」的做法） */
function modelOptionsHtml(current) {
    const models = store.availableModels && store.availableModels.length
        ? [...store.availableModels]
        : [];
    if (current && !models.some(m => m.value === current)) {
        models.unshift({ value: current, label: current });
    }
    if (!models.length) return '<option value="">（无可用模型）</option>';
    return models.map(m => {
        const selected = m.value === current ? ' selected' : '';
        return `<option value="${esc(m.value)}"${selected}>${esc(m.label)}</option>`;
    }).join('');
}

/** variant 下拉选项 HTML：空值显示「（空）」；合并文件里的自定义当前值 */
function variantOptionsHtml(current) {
    const options = [...SLIM_VARIANT_OPTIONS];
    if (current && !options.includes(current)) options.push(current);
    return options.map(v => {
        const selected = v === current ? ' selected' : '';
        return `<option value="${esc(v)}"${selected}>${v === '' ? '（空）' : esc(v)}</option>`;
    }).join('');
}

// ========== 加载 ==========
/**
 * 加载 OMO Slim 配置（保留导出名：chat/navigation.js 在切到本视图时调用）。
 * 流程：当前项目目录 → GetSlimConfig → 填充状态 → 渲染；
 * 同时异步拉取模型列表（v2 的 /api/model，需带 location[directory]）。
 */
export async function loadModelConfig() {
    const container = document.getElementById('modelConfig');
    if (!container) return;
    container.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在加载 OMO 配置...</p></div>';

    try {
        const dir = currentDir();
        // projectDir 用于探测项目级配置；拿不到会话目录时传空串（后端按用户级读取）
        const data = await api.GetSlimConfig(dir || '');
        applySlimData(data);

        // 模型列表：拿不到目录就跳过请求（避免回落到服务端 CWD 被登记成项目）
        if (dir) {
            api.OpenCodeCall('GET', '/api/model', null, dir).then(function (res) {
                const models = toModelOptions(res);
                if (models.length) {
                    store.availableModels = models;
                    // 模型列表到位后刷新渲染（下拉可选项从「仅当前值」变为完整列表）
                    if (!parseError) renderModelConfig();
                }
            }).catch(function () { /* 模型列表非关键路径，失败时保留已有列表 */ });
        }

        renderModelConfig();
    } catch (err) {
        container.innerHTML = `<div class="error"><p>⚠️ 加载失败</p><p class="error-detail">${esc(err.message || err)}</p><button class="btn btn-primary" id="btnRetryOmoLoad">重试</button></div>`;
        const retryBtn = container.querySelector('#btnRetryOmoLoad');
        if (retryBtn) retryBtn.addEventListener('click', loadModelConfig);
    }
}

/** 把后端返回的 SlimConfigResult 应用到模块状态（深拷贝为前端可变结构） */
function applySlimData(data) {
    const d = data || {};
    slimPath = d.path || '';
    slimExists = !!d.exists;
    parseError = d.parseError || '';
    activePresetName = d.activePreset || '';
    revision = d.revision || '';
    envPresetOverride = d.envPresetOverride || '';
    projectConfigPath = d.projectConfigPath || '';
    presets = (d.presets || []).map(p => ({
        name: p.name || '',
        extends: p.extends || '',
        inheritMissing: !!p.inheritMissing,
        inheritCycle: !!p.inheritCycle,
        deleted: false,          // 前端删除标记（保存时才提交给后端）
        collapsed: false,        // 折叠状态（纯 UI，不参与保存）
        agents: (p.agents || []).map(a => ({
            key: a.key || '',
            model: a.model || '',
            variant: a.variant || '',
            comment: a.comment || '',
            inherited: !!a.inherited,    // 来自父方案（继承合成结果）
            overridden: !!a.overridden,  // 在继承行基础上被本方案覆盖
        })),
    }));
    hasUnsavedChanges = false;
    originalSnapshot = serializeState();
}

// ========== 变更检测 / 保存状态 ==========
/** 生成「参与保存的内容」快照：用于比较是否有未保存更改 */
function serializeState() {
    return JSON.stringify({
        activePreset: activePresetName,
        presets: presets.map(p => ({
            name: p.name,
            extends: p.extends,
            deleted: !!p.deleted,
            agents: p.agents.map(a => ({
                key: a.key,
                model: a.model,
                variant: a.variant,
                overridden: !!a.overridden,
            })),
        })),
    });
}

/** 数据变更后调用：刷新未保存状态与底部提示 */
function checkUnsavedChanges() {
    hasUnsavedChanges = serializeState() !== originalSnapshot;
    updateSaveStatus();
}

/** 底部保存状态文案（解析失败时提示禁用保存） */
function updateSaveStatus() {
    const status = document.getElementById('saveStatus');
    if (!status) return;
    if (parseError) {
        status.textContent = '配置解析失败，保存已禁用';
        status.className = 'save-status changed';
        return;
    }
    if (hasUnsavedChanges) {
        status.textContent = '有未保存的更改';
        status.className = 'save-status changed';
    } else {
        status.textContent = '已是最新';
        status.className = 'save-status';
    }
}

// ========== 渲染 ==========
/** 渲染整个视图：覆盖提示 → 解析错误/空状态 → 批量栏 → 各方案分组 */
export function renderModelConfig() {
    const container = document.getElementById('modelConfig');
    if (!container) return;
    const actions = document.getElementById('modelActions');
    if (actions) actions.style.display = 'flex';

    // 顶部配置文件路径（保留原 index.html 的 configPath 元素）
    const pathEl = document.getElementById('configPath');
    if (pathEl) pathEl.textContent = slimPath || '未知';

    // 解析错误时禁用保存（避免把坏文件覆盖掉）
    const saveBtn = document.getElementById('btnSaveModels');
    if (saveBtn) saveBtn.disabled = !!parseError;

    container.innerHTML = '';

    // 1) 覆盖提示：环境变量 / 项目级配置优先于本文件
    if (envPresetOverride || projectConfigPath) {
        container.appendChild(buildOverrideHint());
    }

    // 2) 解析错误：只显示错误（不渲染方案）
    if (parseError) {
        clearBatchBar();
        const err = document.createElement('div');
        err.className = 'error';
        err.innerHTML = `<p>⚠️ 配置文件解析失败</p><p class="error-detail">${esc(parseError)}</p><p class="error-detail">${esc(slimPath)}</p>`;
        container.appendChild(err);
        updateSaveStatus();
        return;
    }

    const visiblePresets = presets.filter(p => !p.deleted);

    // 3) 空状态：文件不存在且没有任何方案（仍可用底部「新增方案」创建）
    if (!slimExists && visiblePresets.length === 0) {
        clearBatchBar();
        container.innerHTML = '<div class="empty"><p>📭 未找到 oh-my-opencode-slim 配置文件</p><p class="empty-hint">点击底部「➕ 新增方案」创建第一个方案，保存后自动创建配置文件</p></div>';
        updateSaveStatus();
        return;
    }

    // 4) 批量栏（全选 + 批量设置模型）
    renderBatchBar();

    // 5) 每个方案一个分组
    visiblePresets.forEach(preset => {
        container.appendChild(createPresetGroup(preset));
    });

    updateSaveStatus();
}

/** 清空批量栏（空状态 / 解析错误时不该出现批量操作） */
function clearBatchBar() {
    const batchBar = document.getElementById('omoBatchBar');
    if (batchBar) batchBar.innerHTML = '';
}

/** 顶部覆盖提示条：说明本次编辑可能不生效的原因 */
function buildOverrideHint() {
    const hint = document.createElement('div');
    hint.className = 'slim-override-hint';
    const parts = [];
    if (envPresetOverride) parts.push(`环境变量 OH_MY_OPENCODE_SLIM_PRESET=${envPresetOverride}`);
    if (projectConfigPath) parts.push(`项目级配置（${projectConfigPath}）`);
    hint.textContent = '⚠️ 此处编辑可能不生效：' + parts.join('；') + ' 的优先级高于本配置文件';
    return hint;
}

/** 批量栏（沿用现有「全选 + 批量设置模型 + 应用」结构） */
function renderBatchBar() {
    const batchBar = document.getElementById('omoBatchBar');
    if (!batchBar) return;
    const bar = document.createElement('div');
    bar.className = 'batch-model-bar';
    bar.innerHTML = `
        <label class="batch-check"><input type="checkbox" id="selectAllModels" /> <span>全选</span></label>
        <select class="batch-model-select" id="batchModelSelect">
            <option value="">-- 批量设置模型 --</option>
            ${modelOptionsHtml('')}
        </select>
        <button class="btn btn-sm btn-open" id="btnApplyBatch">应用</button>
    `;
    batchBar.innerHTML = '';
    batchBar.appendChild(bar);

    // 全选：勾选 / 取消所有条目复选框
    document.getElementById('selectAllModels').addEventListener('change', e => {
        document.querySelectorAll('.model-check').forEach(cb => { cb.checked = e.target.checked; });
    });

    // 应用：把选中模型写入所有勾选行（继承行被改写时标记为「已覆盖」）
    document.getElementById('btnApplyBatch').addEventListener('click', () => {
        const model = document.getElementById('batchModelSelect').value;
        if (!model) return;
        let count = 0;
        document.querySelectorAll('.model-check:checked').forEach(cb => {
            const preset = presets.find(p => p.name === cb.dataset.preset);
            const agent = preset && preset.agents.find(a => a.key === cb.dataset.key);
            if (!agent || agent.model === model) return;
            agent.model = model;
            if (agent.inherited) agent.overridden = true; // 改写继承行 = 覆盖
            count++;
        });
        if (!count) return;
        checkUnsavedChanges();
        renderModelConfig();
    });
}

/** 单个方案分组（组头：radio + 名称 + 标记 + 操作；组体：agent 行） */
function createPresetGroup(preset) {
    const group = document.createElement('div');
    group.className = 'model-group' + (preset.name === activePresetName ? ' active' : '');
    group.dataset.preset = preset.name;

    // ---------- 组头 ----------
    const header = document.createElement('h3');
    header.className = 'model-group-title' + (preset.collapsed ? ' collapsed' : '');

    // radio：唯一表达「启用」的元素；切换只改内存状态，随保存统一提交
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'presetActive';
    radio.className = 'preset-radio';
    radio.checked = preset.name === activePresetName;
    radio.title = '设为当前启用的方案（保存后生效）';
    radio.addEventListener('change', () => {
        activePresetName = preset.name;
        checkUnsavedChanges();
        renderModelConfig();
    });
    header.appendChild(radio);

    // 方案名（选中时加粗，由 .model-group.active 样式控制）
    const label = document.createElement('span');
    label.className = 'model-group-label';
    label.textContent = preset.name;
    header.appendChild(label);

    // 「启用中」灰色小字
    if (preset.name === activePresetName) {
        const tag = document.createElement('span');
        tag.className = 'active-tag';
        tag.textContent = '启用中';
        header.appendChild(tag);
    }

    // 「继承自 X」灰色小字
    if (preset.extends) {
        const note = document.createElement('span');
        note.className = 'inherit-note';
        note.textContent = '继承自 ' + preset.extends;
        header.appendChild(note);
    }

    // 继承异常警示（红字；有异常时禁止保存）
    if (preset.inheritCycle) {
        const warn = document.createElement('span');
        warn.className = 'inherit-error';
        warn.textContent = '继承环无效，无法保存';
        header.appendChild(warn);
    } else if (preset.inheritMissing) {
        const warn = document.createElement('span');
        warn.className = 'inherit-error';
        warn.textContent = '继承源缺失，无法保存';
        header.appendChild(warn);
    }

    // 组头右侧操作：[全选] [+ 加条目] [✕ 删方案]
    const actions = document.createElement('span');
    actions.className = 'model-group-actions';

    const selectAll = document.createElement('label');
    selectAll.className = 'model-group-select-all';
    selectAll.innerHTML = '<input type="checkbox"> 全选';
    selectAll.addEventListener('click', (e) => e.stopPropagation());
    selectAll.querySelector('input').addEventListener('change', (e) => {
        const checked = e.target.checked;
        body.querySelectorAll('.model-check').forEach(cb => { cb.checked = checked; });
    });
    actions.appendChild(selectAll);

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-add-entry';
    addBtn.title = '添加条目';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showAddEntryModal(preset.name);
    });
    actions.appendChild(addBtn);

    // ✎ 重命名方案（prompt 输入新名；同步 extends 引用与激活项，随保存统一提交）
    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn-rename-preset';
    renameBtn.title = '重命名方案';
    renameBtn.textContent = '✎';
    renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        renamePreset(preset);
    });
    actions.appendChild(renameBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-delete-type';
    delBtn.title = '删除方案';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`确定删除方案 ${preset.name} ？保存后生效。`)) return;
        // 不从数组移除：标记 deleted，保存时显式提交（后端对「缺失」默认保留）
        preset.deleted = true;
        // 若删除的是当前启用方案，把启用项挪到剩余第一个方案，避免提交悬空引用
        if (activePresetName === preset.name) {
            const next = presets.find(p => !p.deleted);
            activePresetName = next ? next.name : '';
        }
        checkUnsavedChanges();
        renderModelConfig();
        showToast(`已标记删除方案 ${preset.name}（点击保存生效）`, 'info');
    });
    actions.appendChild(delBtn);

    header.appendChild(actions);

    // ---------- 组体 ----------
    const body = document.createElement('div');
    body.className = 'model-group-body' + (preset.collapsed ? ' collapsed' : '');

    // 点击组头空白处折叠 / 展开（radio、按钮、全选区域不触发）
    header.addEventListener('click', (e) => {
        if (e.target.closest('input, button, .model-group-actions')) return;
        preset.collapsed = !preset.collapsed;
        header.classList.toggle('collapsed');
        body.classList.toggle('collapsed');
    });

    if (preset.agents.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'model-group-empty';
        empty.textContent = '暂无条目，点击标题右侧 + 添加';
        body.appendChild(empty);
    } else {
        preset.agents.forEach(agent => {
            body.appendChild(createAgentRow(preset, agent));
        });
    }

    group.appendChild(header);
    group.appendChild(body);
    return group;
}

/** 单行 agent：☑ + 名 + [模型] [variant] [✕]；下方灰色小字描述 */
function createAgentRow(preset, agent) {
    const row = document.createElement('div');
    // 纯继承行（未覆盖）显示左侧淡灰竖线；已覆盖行按普通行显示
    const isPureInherited = agent.inherited && !agent.overridden;
    row.className = 'model-row' + (isPureInherited ? ' inherited' : '');

    const top = document.createElement('div');
    top.className = 'model-row-top';

    // 复选框（仅用于批量选择，不参与保存）
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'model-check';
    cb.dataset.preset = preset.name;
    cb.dataset.key = agent.key;
    top.appendChild(cb);

    // agent 名（等宽字体）
    const keySpan = document.createElement('span');
    keySpan.className = 'model-key';
    keySpan.textContent = agent.key;
    top.appendChild(keySpan);

    // 「继承 / 已覆盖」灰色小字（仅对继承链上的行显示）
    if (agent.inherited) {
        const tag = document.createElement('span');
        tag.className = 'inherit-tag';
        tag.textContent = agent.overridden ? '已覆盖' : '继承';
        top.appendChild(tag);
    }

    // 模型下拉：改动继承行即标记为「已覆盖」
    const select = document.createElement('select');
    select.className = 'model-select';
    select.title = '模型';
    select.innerHTML = modelOptionsHtml(agent.model);
    select.addEventListener('change', () => {
        agent.model = select.value;
        if (agent.inherited) agent.overridden = true;
        checkUnsavedChanges();
        renderModelConfig();
    });
    top.appendChild(select);

    // variant（思考力度）下拉：同样，改动继承行即覆盖
    const variantSelect = document.createElement('select');
    variantSelect.className = 'model-reasoning-select';
    variantSelect.title = 'variant（思考力度）';
    variantSelect.innerHTML = variantOptionsHtml(agent.variant);
    variantSelect.addEventListener('change', () => {
        agent.variant = variantSelect.value;
        if (agent.inherited) agent.overridden = true;
        checkUnsavedChanges();
        renderModelConfig();
    });
    top.appendChild(variantSelect);

    // 行尾 ✕：按方案是否带 extends / 行的来源决定语义
    const rowDel = document.createElement('button');
    rowDel.className = 'btn btn-del';
    rowDel.textContent = '✕';

    if (!preset.extends) {
        // ① 无继承方案：直接删除该行
        rowDel.title = '删除条目';
        rowDel.addEventListener('click', () => {
            if (!confirm(`确定删除条目 ${agent.key} ？保存后生效。`)) return;
            preset.agents = preset.agents.filter(a => a !== agent);
            checkUnsavedChanges();
            renderModelConfig();
            showToast(`已标记删除 ${agent.key}（点击保存生效）`, 'info');
        });
    } else if (isPureInherited) {
        // ② 纯继承行：不可删除，可修改以覆盖（禁用按钮并提示）
        rowDel.title = '继承行不可删除，可修改以覆盖';
        rowDel.disabled = true;
    } else if (agent.overridden) {
        // ③ 已覆盖行：✕ = 撤销覆盖，恢复继承值（回到「继承」态）
        rowDel.title = '撤销覆盖，恢复继承值';
        rowDel.addEventListener('click', () => revertOverride(preset, agent));
    } else {
        // ④ 本方案新增的行：直接删除
        rowDel.title = '删除条目';
        rowDel.addEventListener('click', () => {
            preset.agents = preset.agents.filter(a => a !== agent);
            checkUnsavedChanges();
            renderModelConfig();
        });
    }
    top.appendChild(rowDel);

    row.appendChild(top);

    if (agent.comment) {
        const comment = document.createElement('div');
        comment.className = 'model-comment';
        comment.textContent = agent.comment;
        row.appendChild(comment);
    }

    return row;
}

/** 撤销覆盖：取父方案中同 key 行的当前值恢复，并清除覆盖标记（保存时该行不再写出） */
function revertOverride(preset, agent) {
    const parent = presets.find(p => p.name === preset.extends && !p.deleted);
    const inheritedRow = parent && parent.agents.find(a => a.key === agent.key);
    if (!inheritedRow) {
        showToast('继承源缺失，无法恢复继承值', 'error');
        return;
    }
    agent.model = inheritedRow.model;
    agent.variant = inheritedRow.variant;
    agent.overridden = false;
    checkUnsavedChanges();
    renderModelConfig();
    showToast(`已撤销 ${agent.key} 的覆盖，恢复继承值`, 'info');
}

/**
 * 重命名方案（组头 ✎，prompt 输入新名，风格与项目既有 prompt 一致）：
 *   1) 更新方案自身 name；
 *   2) 同步所有 extends === 旧名 的其它方案（否则继承引用断裂）；
 *   3) 若改的是当前激活方案，activePresetName 一并跟随；
 *   保存由「💾 保存配置」统一提交（后端会按新名重建 presets 块）。
 */
function renamePreset(preset) {
    const oldName = preset.name;
    const input = prompt('请输入新的方案名：', oldName);
    if (input === null) return; // 用户取消
    const newName = input.trim();
    if (!newName) { showToast('方案名不能为空', 'error'); return; }
    if (newName === oldName) return; // 名称未变化，忽略
    // 与现有方案重名检查：含已标记 deleted 但尚未保存的方案（避免 payload 出现同名）
    if (presets.some(p => p.name === newName)) {
        showToast('方案名已存在（含已删除但尚未保存的方案）', 'error');
        return;
    }
    // 非法字符校验（与现有方案名规则一致）
    if (/[\\/:*?"<>|]/.test(newName)) {
        showToast('方案名包含非法字符（\\ / : * ? " < > |）', 'error');
        return;
    }
    // 1) 更新该方案自身名称
    preset.name = newName;
    // 2) 同步所有指向旧名的继承引用，避免 extends 断裂
    presets.forEach(p => {
        if (p.extends === oldName) p.extends = newName;
    });
    // 3) 当前激活项跟随改名
    if (activePresetName === oldName) activePresetName = newName;
    checkUnsavedChanges();
    renderModelConfig();
    showToast(`已重命名为 ${newName}（点击保存生效）`, 'info');
}

// ========== 模态：添加条目 ==========
/**
 * 打开「添加条目」模态：内置 agent 名下拉（可选「自定义…」）+ 模型 + variant。
 * 新增行属于本方案自身定义：无 extends 方案直接保存；带 extends 方案按 dirty 提交。
 */
export function showAddEntryModal(presetName) {
    const preset = presets.find(p => p.name === presetName && !p.deleted);
    if (!preset) return;

    const old = document.querySelector('.modal-overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal">
            <h3>添加条目 · ${esc(presetName)}</h3>
            <div class="modal-field">
                <label>Agent 名</label>
                <select id="modalEntryKey" class="modal-select">
                    <option value="">（选择内置 agent）</option>
                    ${SLIM_AGENT_KEYS.map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join('')}
                    <option value="__custom__">自定义…</option>
                </select>
                <input id="modalEntryKeyCustom" placeholder="输入自定义 agent 名" style="display:none;margin-top:6px" />
            </div>
            <div class="modal-field">
                <label>模型</label>
                <select id="modalEntryModel" class="modal-select">${modelOptionsHtml('')}</select>
            </div>
            <div class="modal-field">
                <label>variant（思考力度）</label>
                <select id="modalEntryVariant" class="modal-select">${variantOptionsHtml('')}</select>
            </div>
            <div class="modal-actions">
                <button class="btn btn-cancel" id="btnCancelAddEntry">取消</button>
                <button class="btn btn-primary" id="btnConfirmAddEntry">确定</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', () => overlay.remove());
    overlay.querySelector('.modal').addEventListener('click', (e) => e.stopPropagation());

    const keySelect = overlay.querySelector('#modalEntryKey');
    const keyCustom = overlay.querySelector('#modalEntryKeyCustom');
    keySelect.addEventListener('change', () => {
        const custom = keySelect.value === '__custom__';
        keyCustom.style.display = custom ? '' : 'none';
        if (custom) keyCustom.focus();
    });

    overlay.querySelector('#btnCancelAddEntry').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#btnConfirmAddEntry').addEventListener('click', () => {
        const key = keySelect.value === '__custom__'
            ? keyCustom.value.trim()
            : keySelect.value;
        if (!key) { showToast('请选择或输入 agent 名', 'error'); return; }
        if (preset.agents.some(a => a.key === key)) {
            showToast(`方案 ${preset.name} 中已存在条目 ${key}`, 'error');
            return;
        }
        const model = overlay.querySelector('#modalEntryModel').value;
        const variant = overlay.querySelector('#modalEntryVariant').value;
        preset.agents.push({
            key,
            model,
            variant: variant || '',
            comment: '',
            inherited: false,
            overridden: false,
        });
        overlay.remove();
        checkUnsavedChanges();
        renderModelConfig();
        showToast(`已添加 ${key}（点击保存生效）`, 'info');
    });

    keySelect.focus();
}

// ========== 模态：新增方案 ==========
/**
 * 打开「新增方案」模态：方案名 + 可选「继承自」。
 * 选继承时，直接用父方案当前的合成结果作为新方案的「继承行」（前端合成，标「继承」）。
 */
export function showAddPresetModal() {
    const old = document.querySelector('.modal-overlay');
    if (old) old.remove();

    // 「继承自」下拉：列出当前可见的方案名
    const names = presets.filter(p => !p.deleted).map(p => p.name);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal">
            <h3>新增方案</h3>
            <div class="modal-field">
                <label>方案名</label>
                <input id="modalPresetName" placeholder="如 my-plan" />
            </div>
            <div class="modal-field">
                <label>继承自</label>
                <select id="modalPresetBase" class="modal-select">
                    <option value="">不继承</option>
                    ${names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}
                </select>
            </div>
            <div class="modal-actions">
                <button class="btn btn-cancel" id="btnCancelAddPreset">取消</button>
                <button class="btn btn-primary" id="btnConfirmAddPreset">确定</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', () => overlay.remove());
    overlay.querySelector('.modal').addEventListener('click', (e) => e.stopPropagation());

    overlay.querySelector('#btnCancelAddPreset').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#btnConfirmAddPreset').addEventListener('click', () => {
        const name = overlay.querySelector('#modalPresetName').value.trim();
        if (!name) { showToast('方案名不能为空', 'error'); return; }
        if (presets.some(p => p.name === name)) {
            showToast('方案名已存在（若刚删除同名方案，请先保存或刷新）', 'error');
            return;
        }
        const baseName = overlay.querySelector('#modalPresetBase').value;
        const basePreset = baseName ? presets.find(p => p.name === baseName && !p.deleted) : null;
        // 前端合成继承行：复制父方案的合成结果，全部标为「继承」（未覆盖）
        const agents = basePreset
            ? basePreset.agents.map(a => ({
                key: a.key,
                model: a.model,
                variant: a.variant,
                comment: a.comment,
                inherited: true,
                overridden: false,
            }))
            : [];
        presets.push({
            name,
            extends: baseName || '',
            inheritMissing: false,
            inheritCycle: false,
            deleted: false,
            collapsed: false,
            agents,
        });
        overlay.remove();
        checkUnsavedChanges();
        renderModelConfig();
        showToast(`已添加方案 ${name}（点击保存生效）`, 'info');
    });

    const nameField = overlay.querySelector('#modalPresetName');
    if (nameField) nameField.focus();
}

// ========== 保存 ==========
/**
 * 保存配置（保留原有「底部保存按钮」的单一入口）：
 *   1) 解析失败 / 继承异常（环、源缺失）时拒绝保存并提示；
 *   2) 组装 payload（deleted 显式提交；dirty = 覆盖行或本方案新增行）；
 *   3) SaveSlimConfig → 成功后重新加载；失败（如基线冲突）提示刷新。
 */
export async function handleSlimSave() {
    if (parseError) {
        showToast('配置文件解析失败，无法保存（请先修复文件内容）', 'error');
        return;
    }

    // 继承环 / 继承源缺失：后端无法完成继承合成，禁止保存
    const broken = presets.filter(p => !p.deleted && (p.inheritCycle || p.inheritMissing));
    if (broken.length) {
        showToast('存在继承异常的方案（' + broken.map(p => p.name).join('、') + '），请先修复后再保存', 'error');
        return;
    }

    const payload = {
        activePreset: activePresetName || '',
        baseRevision: revision || '',
        presets: presets.map(p => ({
            name: p.name,
            extends: p.extends || '',
            deleted: !!p.deleted,
            // deleted 方案不再提交行内容
            agents: p.deleted ? [] : p.agents.map(a => ({
                key: a.key,
                model: a.model || '',
                variant: a.variant || '',
                // 无 extends 方案：全部行提交（dirty 恒 true）
                // 有 extends 方案：只提交 dirty 行（= 覆盖行 / 本方案新增行）
                dirty: !p.extends || !a.inherited || !!a.overridden,
            })),
        })),
    };

    const btn = document.getElementById('btnSaveModels');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ 保存中...';
    }

    try {
        const result = await api.SaveSlimConfig(payload);
        if (!result || result.success === false) {
            const msg = (result && result.error) || '未知错误';
            showToast('保存失败: ' + msg + '。文件可能已被外部修改，请点「🔄 刷新」后重试', 'error');
            return;
        }
        // 保存成功：重新加载以刷新 revision / 继承合成结果 / 变更基线
        await loadModelConfig();
        showToast('已保存。若在运行中的 OpenCode 未生效：请重载（v1）或稍候自动刷新（v2）', 'success');
    } catch (err) {
        showToast('保存失败: ' + (err.message || err) + '。文件可能已被外部修改，请点「🔄 刷新」后重试', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '💾 保存配置';
        }
    }
}

// ========== 打开配置目录 ==========
/** 取文件路径的所在目录（兼容 \ 与 / 两种分隔符；推导不出时返回空串） */
function dirNameOf(filePath) {
    if (!filePath) return '';
    const idx = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'));
    if (idx < 0) return '';             // 无分隔符：无法推断目录
    if (idx === 0) return filePath[0];  // 根目录（如 /file.jsonc → /）
    if (idx === 2 && filePath[1] === ':') {
        return filePath.slice(0, 3);    // 盘符根（如 C:\file.jsonc → C:\）
    }
    return filePath.slice(0, idx);
}

/**
 * 「📂 打开」：用**站内文件浏览器**打开配置文件所在目录（不是文件本身），
 * 与「供应商配置」的 📂 打开行为一致；目录推导失败时 toast 提示。
 */
export function openSlimDir() {
    const dir = dirNameOf(slimPath);
    if (!dir) {
        showToast('尚未获取到配置文件路径，无法打开目录', 'error');
        return;
    }
    openFileBrowserModal(dir);
}
