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
import { showToast, escapeAttr, bindOverlayClose } from '../core/utils.js';
import { store, currentDir } from '../core/state.js';
import { toModelOptions, formatApiError } from '../core/v2compat.js';

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

// ========== 全局覆盖状态 ==========
// 对应配置文件顶层 agents：覆盖下方启用方案里的同名 agent。
export let rootAgents = [];          // 当前生效的顶层覆盖（保存时提交，仅非「跟随方案」行）
export let disabledAgents = [];      // 全局禁用名单（保存时提交完整数组）
export let agentNames = [];          // 后端给出的可选 agent 名单
export let agentComments = {};       // agent 职责说明表（agents-comments.json），行内注释用

// 全局覆盖区的编辑态：agentNames ∪ rootAgents.key（另兜底补入 disabled_agents 中的自定义项）
let globalRows = [];
// 默认收起；同一次页面会话内保留展开状态（保存后重新加载也不强制收起）
let globalOverrideOpen = false;
let globalOverrideBound = false;

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
        return `<option value="${escapeAttr(m.value)}"${selected}>${escapeAttr(m.label)}</option>`;
    }).join('');
}

/** variant 下拉选项 HTML：空值显示「（空）」；合并文件里的自定义当前值 */
function variantOptionsHtml(current) {
    const options = [...SLIM_VARIANT_OPTIONS];
    if (current && !options.includes(current)) options.push(current);
    return options.map(v => {
        const selected = v === current ? ' selected' : '';
        return `<option value="${escapeAttr(v)}"${selected}>${v === '' ? '（空）' : escapeAttr(v)}</option>`;
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
        container.innerHTML = `<div class="error"><p>⚠️ 加载失败</p><p class="error-detail">${escapeAttr(formatApiError(err))}</p><button class="btn btn-primary" id="btnRetryOmoLoad">重试</button></div>`;
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

    // 全局覆盖数据：解析失败 / 文件不存在时后端返回空数组，这里同样按空处理，
    // 保证上方全局覆盖区照常显示（不因缺少字段而报错）。
    rootAgents = (Array.isArray(d.rootAgents) ? d.rootAgents : [])
        .filter(a => a && a.key)
        .map(a => ({
            key: String(a.key),
            model: typeof a.model === 'string' ? a.model : '',
            variant: typeof a.variant === 'string' ? a.variant : '',
            inheritModelFrom: typeof a.inheritModelFrom === 'string' ? a.inheritModelFrom : '',
            unsupported: !!a.unsupported,
        }));
    disabledAgents = Array.isArray(d.disabledAgents)
        ? d.disabledAgents.filter(Boolean).map(String)
        : [];
    agentNames = Array.isArray(d.agentNames)
        ? d.agentNames.filter(Boolean).map(String)
        : [];
    agentComments = (d.agentComments && typeof d.agentComments === 'object')
        ? Object.fromEntries(Object.entries(d.agentComments).filter(([, v]) => typeof v === 'string' && v))
        : {};

    // 渲染行 = agentNames ∪ rootAgents 的 key（disabled_agents 中的自定义项兜底补入）；
    // 同时把状态归一化为当前编辑态
    buildGlobalRows();

    hasUnsavedChanges = false;
    originalSnapshot = serializeState();
}

// ========== 全局覆盖：状态构建与同步 ==========
/**
 * 由 agentNames ∪ rootAgents.key 构建可编辑行（disabled_agents 中残留的自定义项也会补入）。
 * 每个 rootAgents 条目按 inheritModelFrom 推导模型来源：
 *   session / orchestrator → 跟随会话 / 跟随 orchestrator；
 *   其余（含 unsupported / 未知继承来源）→ 显式指定。
 * 只要条目存在于 rootAgents，就视为覆盖行，避免保存时静默丢掉未知配置。
 */
function buildGlobalRows() {
    const keys = [];
    const seen = new Set();
    const addKey = (key) => {
        if (!key || seen.has(key)) return;
        seen.add(key);
        keys.push(key);
    };
    agentNames.forEach(addKey);
    rootAgents.forEach(a => addKey(a.key));
    // 兜底：自定义 agent 若只出现在 disabled_agents 里，也要给一行，否则无法重新启用
    disabledAgents.forEach(addKey);

    const rootMap = new Map(rootAgents.map(a => [a.key, a]));
    const disabledSet = new Set(disabledAgents);

    globalRows = keys.map(key => {
        const root = rootMap.get(key) || null;
        let source = 'preset';
        if (root) {
            if (root.unsupported) {
                source = 'explicit'; // 实际控件只读，这里仅用于行状态判断
            } else if (root.inheritModelFrom === 'session') {
                source = 'session';
            } else if (root.inheritModelFrom === 'orchestrator') {
                source = 'orchestrator';
            } else {
                // model / variant 为空也按「显式指定」保留，保存时该键仍在顶层 agents 内
                source = 'explicit';
            }
        }
        return {
            key,
            role: key === 'orchestrator' ? '主调度器' : '子代理',
            protected: key === 'orchestrator',
            // 主调度器不可禁用；其它 agent 按后端 disabled_agents 还原
            enabled: key === 'orchestrator' ? true : !disabledSet.has(key),
            source,
            model: root ? root.model : '',
            variant: root ? root.variant : '',
            unsupported: !!(root && root.unsupported),
        };
    });

    syncGlobalStateFromRows();
}

/** 把编辑行回写为保存用的 rootAgents / disabledAgents（也供未保存检测使用） */
function syncGlobalStateFromRows() {
    rootAgents = globalRows
        .filter(r => r.source !== 'preset')
        .map(r => ({
            key: r.key,
            model: !r.unsupported && r.source === 'explicit' ? (r.model || '') : '',
            variant: !r.unsupported && r.source === 'explicit' ? (r.variant || '') : '',
            inheritModelFrom: !r.unsupported && (r.source === 'session' || r.source === 'orchestrator')
                ? r.source
                : '',
            unsupported: !!r.unsupported,
        }));
    disabledAgents = globalRows
        .filter(r => !r.enabled && !r.protected)
        .map(r => r.key);
}

/** 全局覆盖区的任何结构性改动：同步状态 → 未保存提示 → 重绘本区 → 更新方案行标签 */
function commitGlobalRows() {
    syncGlobalStateFromRows();
    checkUnsavedChanges();
    renderGlobalOverride();
    refreshPresetGlobalTags();
}

/** 只改模型 / variant 时无需重建行，仅同步状态并刷新未保存提示 */
function commitGlobalValues() {
    syncGlobalStateFromRows();
    checkUnsavedChanges();
    // 顶层模型/variant 改动后，方案行的展示值要立即跟随（显式覆盖显示顶层值），
    // 否则用户会看到顶层改了思考强度、下方方案行仍是旧值。
    refreshPresetGlobalTags();
}

/**
 * 组装 SaveSlimConfig 的 rootAgents：
 *   - 只提交非「跟随方案」行；
 *   - 显式指定提交 model / variant；
 *   - 跟随会话 / orchestrator 提交 inheritModelFrom；
 *   - unsupported（原配置为备选模型链）只保留 key，不传 model/variant，交由后端原样保留。
 */
function buildRootAgentsPayload() {
    return globalRows
        .filter(r => r.source !== 'preset')
        .map(r => {
            if (r.unsupported) return { key: r.key };
            return {
                key: r.key,
                model: r.source === 'explicit' ? (r.model || '') : '',
                variant: r.source === 'explicit' ? (r.variant || '') : '',
                inheritModelFrom: r.source === 'session' || r.source === 'orchestrator' ? r.source : '',
            };
        });
}

// ========== 全局覆盖：渲染 ==========
/** 渲染全局覆盖区（默认收起；解析失败 / 文件不存在时同样渲染为空列表） */
function renderGlobalOverride() {
    const section = document.getElementById('globalOverride');
    const rowsWrap = document.getElementById('goRows');
    if (!section || !rowsWrap) return;

    bindGlobalOverrideEvents();

    rowsWrap.innerHTML = '';
    if (globalRows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'go-empty';
        empty.textContent = '暂无可配置的 agent';
        rowsWrap.appendChild(empty);
    } else {
        globalRows.forEach(row => rowsWrap.appendChild(createGlobalAgentRow(row)));
    }

    updateGlobalSummary();
    applyGlobalOverrideOpenState(false);
}

/** 表头点击：展开 / 收起（仅绑定一次） */
function bindGlobalOverrideEvents() {
    if (globalOverrideBound) return;
    const header = document.getElementById('goHeader');
    const body = document.getElementById('goBody');
    if (!header || !body) return;
    header.addEventListener('click', () => {
        globalOverrideOpen = !globalOverrideOpen;
        applyGlobalOverrideOpenState(true);
    });
    globalOverrideBound = true;
}

/** 同步展开状态到 DOM；初次渲染用 animate=false，避免页面加载时播放动画 */
function applyGlobalOverrideOpenState(animate) {
    const section = document.getElementById('globalOverride');
    const header = document.getElementById('goHeader');
    const body = document.getElementById('goBody');
    if (!section || !header || !body) return;

    if (!animate) section.classList.add('no-motion');
    section.classList.toggle('open', globalOverrideOpen);
    header.setAttribute('aria-expanded', String(globalOverrideOpen));
    if (globalOverrideOpen) {
        body.removeAttribute('inert');
    } else {
        body.setAttribute('inert', '');
    }
    const toggleText = document.getElementById('goToggleText');
    if (toggleText) toggleText.textContent = globalOverrideOpen ? '收起' : '展开';

    if (!animate) {
        window.requestAnimationFrame(() => section.classList.remove('no-motion'));
    }
}

/** 收起态摘要：N 个覆盖 · M 个禁用；为 0 时弱化显示 */
function updateGlobalSummary() {
    const overrideCount = globalRows.filter(r => r.source !== 'preset').length;
    const disabledCount = globalRows.filter(r => !r.enabled).length;

    const overrideNum = document.getElementById('overrideCount');
    const disabledNum = document.getElementById('disabledCount');
    if (overrideNum) overrideNum.textContent = String(overrideCount);
    if (disabledNum) disabledNum.textContent = String(disabledCount);

    const chipOverride = document.getElementById('chipOverride');
    const chipDisabled = document.getElementById('chipDisabled');
    if (chipOverride) chipOverride.classList.toggle('is-zero', overrideCount === 0);
    if (chipDisabled) chipDisabled.classList.toggle('is-zero', disabledCount === 0);
}

/** 单个全局覆盖行：开关 · agent 名/角色 · 模型来源 · 模型/variant · 覆盖状态 */
function createGlobalAgentRow(row) {
    const el = document.createElement('div');
    el.className = 'go-row'
        + (row.source !== 'preset' ? ' is-override' : '')
        + (!row.enabled ? ' is-disabled' : '')
        + (row.unsupported ? ' is-unsupported' : '');
    el.dataset.key = row.key;

    // ---------- 第一列：启用开关 + agent 名 + 只读角色徽标 ----------
    const agentCell = document.createElement('div');
    agentCell.className = 'go-agent-cell';

    const switchLabel = document.createElement('label');
    switchLabel.className = 'go-switch';
    switchLabel.title = row.protected
        ? '主调度器，不可禁用'
        : (row.enabled ? '禁用 ' + row.key : '启用 ' + row.key);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = row.enabled;
    checkbox.disabled = row.protected;
    checkbox.setAttribute('aria-label', '启用 ' + row.key);
    checkbox.addEventListener('change', () => {
        if (row.protected) {
            checkbox.checked = true;
            return;
        }
        row.enabled = checkbox.checked;
        commitGlobalRows();
    });

    const track = document.createElement('span');
    track.className = 'go-switch-track';
    track.setAttribute('aria-hidden', 'true');
    switchLabel.appendChild(checkbox);
    switchLabel.appendChild(track);
    agentCell.appendChild(switchLabel);

    const agentInfo = document.createElement('div');
    agentInfo.className = 'go-agent-info';

    const name = document.createElement('span');
    name.className = 'go-agent-name';
    name.textContent = row.key;
    agentInfo.appendChild(name);

    const role = document.createElement('span');
    role.className = 'go-role-badge' + (row.protected ? ' is-primary' : '');
    role.textContent = row.role;
    agentInfo.appendChild(role);

    if (row.protected) {
        const note = document.createElement('span');
        note.className = 'go-protected-note';
        note.title = '主调度器，不可禁用';
        note.textContent = '不可禁用';
        agentInfo.appendChild(note);
    }

    // agent 职责说明：与方案行注释同口径（agents-comments.json），最多两行
    const commentText = (agentComments[row.key] || '').trim();
    if (commentText) {
        const comment = document.createElement('span');
        comment.className = 'go-agent-comment';
        comment.textContent = commentText;
        comment.title = commentText;
        agentInfo.appendChild(comment);
    }

    agentCell.appendChild(agentInfo);
    el.appendChild(agentCell);

    // ---------- 第二列：模型来源 ----------
    const sourceCell = document.createElement('div');
    sourceCell.className = 'go-source-cell';

    if (row.unsupported) {
        // 原配置是 model 数组：来源不可改，只读展示
        const locked = createLockedSelect('原配置（只读）', '原配置为备选模型链，需手动编辑文件');
        locked.classList.add('go-source-select');
        sourceCell.appendChild(locked);
    } else {
        const sourceSelect = document.createElement('select');
        sourceSelect.className = 'go-select go-source-select';
        sourceSelect.title = '决定该 agent 是否写入配置文件顶层 agents';
        sourceSelect.setAttribute('aria-label', row.key + ' 的模型来源');
        [
            ['preset', '跟随方案（不覆盖）'],
            ['explicit', '显式指定'],
            ['session', '跟随会话'],
            ['orchestrator', '跟随 orchestrator'],
        ].forEach(([value, label]) => {
            sourceSelect.appendChild(new Option(label, value));
        });
        sourceSelect.value = row.source;
        sourceSelect.disabled = !row.enabled;
        sourceSelect.addEventListener('change', () => {
            row.source = sourceSelect.value;
            // 切到「显式指定」时给一个可用的起点；已保留的值不覆盖
            if (row.source === 'explicit') {
                if (!row.model && store.availableModels && store.availableModels.length) {
                    row.model = store.availableModels[0].value;
                }
                if (!row.variant) row.variant = 'high';
            }
            commitGlobalRows();
        });
        sourceCell.appendChild(sourceSelect);
    }
    el.appendChild(sourceCell);

    // ---------- 第三列：模型 + variant（跟随类来源置灰并提示） ----------
    const modelCell = document.createElement('div');
    modelCell.className = 'go-model-cell';

    if (row.unsupported) {
        const note = document.createElement('span');
        note.className = 'go-readonly-note';
        note.textContent = '原配置为备选模型链，需手动编辑文件';
        note.title = '保存时原样保留该行配置';
        modelCell.appendChild(note);
    } else if (row.source === 'explicit') {
        const modelSelect = document.createElement('select');
        modelSelect.className = 'go-select go-model-pick';
        modelSelect.innerHTML = globalModelOptionsHtml(row.model);
        modelSelect.value = row.model || '';
        modelSelect.disabled = !row.enabled;
        modelSelect.setAttribute('aria-label', row.key + ' 模型');
        modelSelect.title = '写入 agents[' + row.key + '].model';
        modelSelect.addEventListener('change', () => {
            row.model = modelSelect.value;
            commitGlobalValues();
        });

        const variantSelect = document.createElement('select');
        variantSelect.className = 'go-select go-variant-pick';
        variantSelect.innerHTML = variantOptionsHtml(row.variant);
        variantSelect.value = row.variant || '';
        variantSelect.disabled = !row.enabled;
        variantSelect.setAttribute('aria-label', row.key + ' variant');
        variantSelect.title = '写入 agents[' + row.key + '].variant';
        variantSelect.addEventListener('change', () => {
            row.variant = variantSelect.value;
            commitGlobalValues();
        });

        modelCell.appendChild(modelSelect);
        modelCell.appendChild(variantSelect);
    } else {
        let text = '使用下方方案中的模型';
        let title = '顶层不覆盖该 agent，沿用启用方案中的模型';
        if (row.source === 'session') {
            text = '跟随当前会话模型，无需指定';
            title = '跟随模型由运行时决定，无需在此指定';
        } else if (row.source === 'orchestrator') {
            text = '跟随 orchestrator 模型，无需指定';
            title = '跟随模型由运行时决定，无需在此指定';
        }
        const locked = createLockedSelect(text, title);
        locked.setAttribute('aria-label', text);
        modelCell.appendChild(locked);
    }
    el.appendChild(modelCell);

    // ---------- 第四列：覆盖状态 ----------
    const statusCell = document.createElement('div');
    statusCell.className = 'go-status-cell';
    if (!row.enabled) {
        statusCell.appendChild(createStatusPill('已禁用', 'disabled', '该 agent 已在全局禁用列表中'));
    } else if (row.source !== 'preset') {
        statusCell.appendChild(createStatusPill(
            '覆盖',
            'override',
            row.unsupported ? '原配置为备选模型链，保存时原样保留' : '该 agent 由配置文件顶层 agents 覆盖'
        ));
    } else {
        const text = document.createElement('span');
        text.className = 'go-status-text';
        text.textContent = '未覆盖';
        statusCell.appendChild(text);
    }
    el.appendChild(statusCell);

    return el;
}

/** 置灰的只读下拉（跟随类来源 / 备选模型链） */
function createLockedSelect(text, title) {
    const select = document.createElement('select');
    select.className = 'go-select go-locked-select';
    select.disabled = true;
    select.title = title;
    select.setAttribute('aria-label', text);
    select.appendChild(new Option(text, ''));
    return select;
}

/** 覆盖状态胶囊 */
function createStatusPill(text, kind, title) {
    const pill = document.createElement('span');
    pill.className = 'go-status-pill is-' + kind;
    if (title) pill.title = title;
    const dot = document.createElement('span');
    dot.className = 'go-dot';
    dot.setAttribute('aria-hidden', 'true');
    pill.appendChild(dot);
    pill.appendChild(document.createTextNode(text));
    return pill;
}

/** 模型下拉：空值时补「未指定模型」，避免浏览器默认选中第一项造成误解 */
function globalModelOptionsHtml(current) {
    const options = modelOptionsHtml(current || '');
    if (!current && store.availableModels && store.availableModels.length) {
        return '<option value="">（未指定模型）</option>' + options;
    }
    return options;
}

// ========== 全局覆盖：方案行标签与锁定 ==========
/** 某 agent 的全局状态：顶层覆盖条目（可能为 null）与是否被全局禁用 */
function globalRowState(key) {
    const root = rootAgents.find(a => a.key === key) || null;
    return { root, disabled: disabledAgents.includes(key) };
}

/** 方案行被全局覆盖/禁用时，锁住模型与 variant 下拉。
 *  显式指定（顶层有 model/variant）时显示顶层值；跟随会话/orchestrator 时显示方案原值。 */
function applyPresetRowGlobalLock(row, key) {
    const { root, disabled } = globalRowState(key);
    const locked = !!root || disabled;
    row.querySelectorAll('.model-select, .model-reasoning-select').forEach(sel => {
        sel.disabled = locked;
    });
}

/**
 * 方案行的展示值：
 *   - 顶层「显式指定」（inheritModelFrom 为空且非 unsupported）：模型与 variant 都以顶层为准，
 *     因为实际运行时顶层会完全取代方案值；
 *   - 跟随会话 / 跟随 orchestrator / 未覆盖 / 禁用：显示方案自身的原值。
 * 只影响展示，不写回 agent.model / agent.variant。
 */
function presetRowDisplay(agent) {
    const { root } = globalRowState(agent.key);
    const explicit = !!(root && !root.unsupported && !root.inheritModelFrom);
    return {
        explicit,
        model: explicit ? (root.model || '') : (agent.model || ''),
        variant: explicit ? (root.variant || '') : (agent.variant || ''),
    };
}

/** 方案行里追加全局状态小标签（顺序固定，且不重复） */
function appendPresetGlobalTags(top, key, anchor) {
    const { root, disabled } = globalRowState(key);
    const tags = [];

    if (root) {
        // 细分来源：显式指定 → 顶层覆盖；其余两种跟随模式直接标注
        let label = '顶层覆盖';
        if (root.inheritModelFrom === 'session') label = '跟随会话';
        else if (root.inheritModelFrom === 'orchestrator') label = '跟随 orchestrator';
        tags.push(createPresetGlobalTag(label, false));
    }
    if (disabled) {
        tags.push(createPresetGlobalTag('全局禁用', true));
    }

    tags.forEach(tag => {
        if (anchor && anchor.parentNode === top) {
            top.insertBefore(tag, anchor);
        } else {
            top.appendChild(tag);
        }
    });
}

function createPresetGlobalTag(text, danger) {
    const tag = document.createElement('span');
    tag.className = 'go-tag' + (danger ? ' danger' : '');
    tag.dataset.goTag = '1';
    tag.textContent = text;
    return tag;
}

/** 全局覆盖编辑后，原地刷新下方方案行的标签、锁定状态与展示值，避免整块方案列表重绘 */
function refreshPresetGlobalTags() {
    document.querySelectorAll('#modelConfig .model-row[data-agent-key]').forEach(row => {
        row.querySelectorAll('.go-tag[data-go-tag]').forEach(tag => tag.remove());
        const top = row.querySelector('.model-row-top');
        if (!top) return;
        appendPresetGlobalTags(top, row.dataset.agentKey, top.querySelector('.model-select'));
        applyPresetRowGlobalLock(row, row.dataset.agentKey);
        // 顶层显式覆盖 → 显示顶层模型/variant；撤销覆盖或改成跟随类 → 恢复方案原值
        const agent = row._agentRef;
        if (!agent) return;
        const display = presetRowDisplay(agent);
        const modelSel = row.querySelector('.model-select');
        const variantSel = row.querySelector('.model-reasoning-select');
        if (modelSel) {
            modelSel.innerHTML = modelOptionsHtml(display.model);
            modelSel.value = display.model;
        }
        if (variantSel) {
            variantSel.innerHTML = variantOptionsHtml(display.variant);
            variantSel.value = display.variant;
        }
    });
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
        // 全局覆盖也参与「未保存更改」判断：展开状态与 focus 等纯 UI 字段不参与
        rootAgents: rootAgents.map(a => ({
            key: a.key,
            model: a.model,
            variant: a.variant,
            inheritModelFrom: a.inheritModelFrom,
            unsupported: !!a.unsupported,
        })),
        disabledAgents: [...disabledAgents],
    });
}

/** 数据变更后调用：刷新未保存状态与工具栏提示 */
function checkUnsavedChanges() {
    hasUnsavedChanges = serializeState() !== originalSnapshot;
    updateSaveStatus();
}

/** 工具栏保存状态文案（解析失败时提示禁用保存） */
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

    // 全局覆盖区独立于方案列表：解析失败 / 文件不存在时也要正常显示（数据为空）
    renderGlobalOverride();

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
        err.innerHTML = `<p>⚠️ 配置文件解析失败</p><p class="error-detail">${escapeAttr(parseError)}</p><p class="error-detail">${escapeAttr(slimPath)}</p>`;
        container.appendChild(err);
        updateSaveStatus();
        return;
    }

    const visiblePresets = presets.filter(p => !p.deleted);

    // 3) 空状态：文件不存在且没有任何方案（仍可用工具栏「新增方案」创建）
    if (!slimExists && visiblePresets.length === 0) {
        clearBatchBar();
        container.innerHTML = '<div class="empty"><p>📭 未找到 oh-my-opencode-slim 配置文件</p><p class="empty-hint">点击工具栏「新增方案」创建第一个方案，保存后自动创建配置文件</p></div>';
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

    // 组头右侧操作：[+ 加条目] [重命名] [删除] [全选]（图标紧排，全选独立放在最右）
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

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-add-entry';
    addBtn.title = '添加条目';
    addBtn.innerHTML = '<span class="omo-ic omo-ic-add" aria-hidden="true"></span>';
    addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showAddEntryModal(preset.name);
    });
    actions.appendChild(addBtn);

    // 重命名方案（assets/重命名.svg 图标；prompt 输入新名，同步 extends 引用与激活项，随保存统一提交）
    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn-rename-preset';
    renameBtn.title = '重命名方案';
    renameBtn.innerHTML = '<span class="omo-ic omo-ic-rename" aria-hidden="true"></span>';
    renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        renamePreset(preset);
    });
    actions.appendChild(renameBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-delete-type';
    delBtn.title = '删除方案';
    delBtn.innerHTML = '<span class="omo-ic omo-ic-del" aria-hidden="true"></span>';
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
    // 全选独立放在最右（与左侧三个图标拉开间距，由 CSS margin-left 控制）
    actions.appendChild(selectAll);

    header.appendChild(actions);

    // ---------- 组体 ----------
    const body = document.createElement('div');
    body.className = 'model-group-body' + (preset.collapsed ? ' collapsed' : '');

    // 点击组头空白处折叠 / 展开（radio、按钮、全选区域不触发）。
    const GROUP_BODY_ANIM_MS = 300;
    header.addEventListener('click', (e) => {
        if (e.target.closest('input, button, .model-group-actions')) return;
        preset.collapsed = !preset.collapsed;
        header.classList.toggle('collapsed');
        if (preset.collapsed) {
            // 折叠：钉住当前实际高度为起点 → reflow → 切类过渡到 0
            body.style.maxHeight = body.scrollHeight + 'px';
            void body.offsetHeight;
            body.style.maxHeight = '';
            body.classList.add('collapsed');
        } else {
            // 展开：钉住 0 为起点 → reflow → 过渡到实际高度，结束后解除内联
            body.classList.remove('collapsed');
            body.style.maxHeight = '0px';
            void body.offsetHeight;
            body.style.maxHeight = body.scrollHeight + 'px';
            setTimeout(() => { body.style.maxHeight = ''; }, GROUP_BODY_ANIM_MS + 40);
        }
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
    // 供全局覆盖编辑后原地刷新「顶层覆盖 / 全局禁用」标签
    row.dataset.agentKey = agent.key;
    // 保留行与数据对象的引用：顶层覆盖改动后可只刷新本行展示值，不必整块重绘
    row._agentRef = agent;

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

    // 顶层覆盖 / 全局禁用小标签（按 rootAgents / disabledAgents 判断）
    appendPresetGlobalTags(top, agent.key);

    // 模型下拉：改动继承行即标记为「已覆盖」
    // 顶层显式覆盖时展示顶层模型（置灰），其余情况展示方案自身值
    const display = presetRowDisplay(agent);
    const select = document.createElement('select');
    select.className = 'model-select';
    select.title = '模型';
    select.innerHTML = modelOptionsHtml(display.model);
    select.value = display.model;
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
    variantSelect.innerHTML = variantOptionsHtml(display.variant);
    variantSelect.value = display.variant;
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

    // 被全局覆盖 / 全局禁用的 agent：模型与 variant 下拉置灰（保留方案原值展示）
    applyPresetRowGlobalLock(row, agent.key);

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
 *   保存由「保存配置」统一提交（后端会按新名重建 presets 块）。
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
        <div class="modal modal-card proxy-modal">
            <div class="modal-header">
                <h3>添加条目 · ${escapeAttr(presetName)}</h3>
                <button type="button" class="modal-close-btn" id="btnCloseAddEntry" title="关闭"><span class="oc-fb-icon oc-fb-icon-close" aria-hidden="true"></span></button>
            </div>
            <div class="modal-body">
                <div class="modal-field">
                    <label>Agent 名</label>
                    <select id="modalEntryKey" class="modal-select">
                        <option value="">（选择内置 agent）</option>
                        ${SLIM_AGENT_KEYS.map(k => `<option value="${escapeAttr(k)}">${escapeAttr(k)}</option>`).join('')}
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
            </div>
            <div class="modal-footer">
                <button class="btn-cancel" id="btnCancelAddEntry">取消</button>
                <button class="btn btn-primary" id="btnConfirmAddEntry">确定</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    // 点遮罩关闭（仅当按下与松开都在遮罩上才触发；新机制不再需要子元素 stopPropagation）
    bindOverlayClose(overlay, () => overlay.remove());

    // 头部关闭按钮：移除当前弹窗
    overlay.querySelector('#btnCloseAddEntry').addEventListener('click', () => overlay.remove());

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
                    ${names.map(n => `<option value="${escapeAttr(n)}">${escapeAttr(n)}</option>`).join('')}
                </select>
            </div>
            <div class="modal-actions">
                <button class="btn btn-cancel" id="btnCancelAddPreset">取消</button>
                <button class="btn btn-primary" id="btnConfirmAddPreset">确定</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    // 点遮罩关闭（仅当按下与松开都在遮罩上才触发；新机制不再需要子元素 stopPropagation）
    bindOverlayClose(overlay, () => overlay.remove());

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
 * 保存配置（工具栏「保存配置」按钮的单一入口）：
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
        // 顶层覆盖：只提交非「跟随方案」行；禁用名单提交完整数组
        rootAgents: buildRootAgentsPayload(),
        disabledAgents: globalRows.filter(r => !r.enabled).map(r => r.key),
    };

    const btn = document.getElementById('btnSaveModels');
    const btnText = document.getElementById('btnSaveModelsText');
    if (btn) {
        btn.disabled = true;
        // 图标在按钮内独立 span，这里只改文字（保存中状态）
        if (btnText) btnText.textContent = '保存中...';
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
        showToast('保存失败: ' + formatApiError(err) + '。文件可能已被外部修改，请点「🔄 刷新」后重试', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            if (btnText) btnText.textContent = '保存配置';
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
