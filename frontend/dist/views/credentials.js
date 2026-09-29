// ============================================================
// 凭据与集成面板
// ============================================================
// 展示 OpenCode v2 中**已配置凭据**的集成，并支持切换当前生效的凭据。
//
// 为什么只显示已配置的：实测 v2 有 231 个集成条目，其中只有 6 个配了凭据。
// 把 231 条全列出来既臃肿又无用——这个面板要回答的问题是
// 「我有哪些可切换的凭据、当前用的是哪个」，不是「有哪些 provider」。
// 后端 ListIntegrations 默认已做该过滤，并回传 total/shown 供此处如实说明。
//
// 约定（实测确认）：connections[0] 即当前生效的连接。切换靠
// POST /api/credential/{id}/activate；新增一把靠
// POST /api/integration/{id}/connect/key；删除靠 DELETE /api/credential/{id}。
// 改显示名靠 PATCH（只能改 label，改不了凭据内容）。
//
// 「一个供应商多把 key、点一下就切」这件事的前提是**能把第 2 把 key 登记进来**。
// v2 没有凭据列表的写接口，GET /api/credential 实测 404——凭据只能从
// /api/integration 的 connections 读出来，写入的唯一入口就是 connect/key。
// 在补上这个入口之前，面板只能列和切，用户手里的第二把 key 无处可登记，
// 于是每换一次 key 就得回到别处重填一遍——这正是要消灭的「再填」。
//
// 实测要点：
//  - 新增的 key 会直接成为 connections[0]（即当前生效的那把）
//  - activate 会把目标挪到 connections[0]
//  - connect/key 成功时响应体是空的，不是 {data:...}
//
// 纯逻辑（describeConnection / 行生成 / 展开判定 / 说明文案）在 credential-model.js，
// 便于在 Node 下直接单测——本文件 import 了 apicall.js，测试进程加载不了。

import { api } from '../core/apicall.js';
import { store } from '../core/state.js';
import { showToast, escapeHtml } from '../core/utils.js';
import {
    CONNECTABLE_RESULT_LIMIT,
    connectEmptyText,
    connectMethod,
    connectionRows,
    hasNoStoredCredential,
    isExpandable,
    searchConnectable,
    summarizeIntegrations,
    supportsKeyAuth,
} from './credential-model.js';

/** 面板状态：跨次刷新保留展开项与切换中标记 */
const credState = {
    loading: false,
    /** 已展开的集成 id */
    expanded: new Set(),
    /** 正在切换的凭据 id，避免重复点击 */
    switching: '',
    /** 正在写入/删除的凭据 id，避免重复点击 */
    mutating: '',
    /** 上次规整后的结果，失败时保留旧内容而不是清空 */
    last: null,
    /**
     * 「接入新供应商」搜索框的关键字。
     *
     * 刻意**不存任何 key**：搜索框只放关键字，key 永远只在提交瞬间
     * 从 input.value 读一次就发走，不进状态对象、不进 localStorage、
     * 也不被写回 innerHTML。
     */
    connectQuery: '',
    /** 选中的待接入供应商 id；空串表示未选择 */
    connectPicked: '',
};

/** 把「接入新供应商」区（搜索框 + 候选 + 表单）渲染进 HTML。
 *
 * 单独抽出来是因为它和「已配置凭据的集成列表」是两件事：
 * 前者从全量集成里搜可接入的供应商，后者列已存管凭据的连接。
 */
function renderConnectSection(integrations) {
    const result = searchConnectable(integrations, credState.connectQuery, CONNECTABLE_RESULT_LIMIT);
    const picked = result.items.find((it) => it.id === credState.connectPicked)
        // 选中的若因搜索变化被筛掉了，仍保留在 pickedIntegration 里，
        // 否则用户改一下关键字就会丢失已经填了一半的表单
        || (credState.connectPicked
            ? (Array.isArray(integrations) ? integrations : []).find((it) => it && it.id === credState.connectPicked)
            : null);

    let html = '<div class="oc-cred-connect">';
    html += '<div class="oc-cred-connect-head">接入新供应商</div>';
    html += '<input class="oc-cred-connect-search" type="search" autocomplete="off"'
        + ' placeholder="搜索供应商（名称或 id）" aria-label="搜索供应商"'
        + ' value="' + escapeHtml(credState.connectQuery) + '" />';

    if (result.truncated) {
        const hidden = result.total - result.items.length;
        html += '<div class="oc-cred-connect-note">还有 ' + hidden
            + ' 条未显示（共匹配 ' + result.total + ' 条），请把搜索关键字收窄一些</div>';
    }

    const emptyText = connectEmptyText(result, credState.connectQuery);
    if (emptyText) {
        html += '<div class="oc-cred-connect-empty">' + escapeHtml(emptyText) + '</div>';
    } else {
        html += '<select class="oc-cred-connect-pick" aria-label="选择要接入的供应商">';
        html += '<option value="">— 选择供应商 —</option>';
        result.items.forEach((it) => {
            const selected = picked && it.id === picked.id ? ' selected' : '';
            html += '<option value="' + escapeHtml(it.id) + '"' + selected + '>'
                + escapeHtml(it.name + '（' + it.id + '）') + '</option>';
        });
        html += '</select>';
    }

    if (picked) {
        html += renderConnectForm(picked);
    }

    html += '</div>';
    return html;
}

/** 选中某个供应商后的填 key 表单。
 *
 * 官方口径：接入只负责**存凭据**。对不在模型目录里的供应商，
 * 还得自己去 opencode.json 配 endpoint 和 models——这里如实提示，
 * 免得用户以为存完 key 就能直接对话。
 */
function renderConnectForm(integration) {
    const busy = credState.mutating === integration.id;
    const method = connectMethod(integration);

    let html = '<div class="oc-cred-connect-form" data-integration-id="' + escapeHtml(integration.id) + '">';
    html += '<div class="oc-cred-connect-name">' + escapeHtml(integration.name) + '</div>';

    if (method !== 'key') {
        // 不给 key 表单：OAuth 走浏览器 URL / 设备码 / 授权码，
        // 需要 attemptID 往返与人工交互，本面板没有承载它的交互面。
        html += '<div class="oc-cred-connect-note">该供应商使用 OAuth 接入，'
            + '请在 OpenCode TUI 里用 /connect 完成</div>';
        html += '</div>';
        return html;
    }

    html += '<div class="oc-cred-add">';
    html += '<input class="oc-cred-add-key" type="password" autocomplete="off"'
        + ' placeholder="粘贴 API Key" aria-label="API Key"' + (busy ? ' disabled' : '') + ' />';
    html += '<input class="oc-cred-add-label" type="text" autocomplete="off"'
        + ' placeholder="备注名（可选）" aria-label="凭据备注名"' + (busy ? ' disabled' : '') + ' />';
    html += '<button type="button" class="btn btn-sm oc-cred-add-save"'
        + ' data-integration-id="' + escapeHtml(integration.id) + '"'
        + (busy ? ' disabled' : '') + '>接入</button>';
    html += '</div>';
    html += '<div class="oc-cred-connect-note">凭据保存在 OpenCode 服务端；'
        + '若该供应商不在模型目录里，还需自行在 opencode.json 配置 endpoint 与 models</div>';
    html += '</div>';
    return html;
}

/** 渲染面板 */
export function renderCredentials() {
    const box = document.getElementById('ocCredentials');
    if (!box) return;

    if (credState.loading) {
        box.innerHTML = '<div class="oc-empty">正在读取凭据…</div>';
        return;
    }

    const summary = credState.last;
    if (!summary) {
        box.innerHTML = '<div class="oc-empty">启动服务后查看已配置的凭据</div>';
        return;
    }
    if (summary.error) {
        box.innerHTML = '<div class="oc-empty">读取失败：' + escapeHtml(summary.error) + '</div>';
        return;
    }
    let html = '';
    // 概览：现在拉的是全量（includeEmpty=true），因此这句必须如实说
    // 「共 231 个集成，其中 6 个已存管凭据」，不能再显示旧的
    // 「仅显示已配置凭据的集成（6 / 231）」——那会让人以为另外 225 个
    // 供应商不存在，而它们恰恰是搜索接入的候选来源。
    const stored = summary.integrations.filter((it) => !hasNoStoredCredential(it));
    html += '<div class="oc-cred-note">共 ' + summary.total + ' 个集成，其中 '
        + stored.length + ' 个已存管凭据；其余可用下方搜索接入</div>';

    // 先出「接入新供应商」区：这是用户最常做的事（接一个新供应商），
    // 放在已配置列表之前，避免要先滚过一长串已配置项才看得到入口。
    html += renderConnectSection(summary.integrations);

    // 再列已存管凭据的集成。全量下会有 225 个没有凭据的集成，
    // 若一并渲染就是 200+ 个空壳卡片——只渲染真正存了凭据的那些。
    summary.integrations.filter(function(integration) {
        return !hasNoStoredCredential(integration);
    }).forEach(function(integration) {
        const rows = connectionRows(integration);
        const expandable = isExpandable(integration);
        const expanded = credState.expanded.has(integration.id);
        const credCount = rows.length ? rows[0].credentialCount : 0;
        const canAddKey = supportsKeyAuth(integration);

        html += '<div class="oc-cred-item">';
        html += '<div class="oc-cred-head" data-integration-id="' + escapeHtml(integration.id) + '">';
        html += '<span class="oc-cred-name">' + escapeHtml(integration.name) + '</span>';
        if (credCount > 1) {
            html += '<span class="oc-cred-count">' + credCount + ' 把 key</span>';
        }
        if (expandable) {
            html += '<span class="oc-cred-arrow">' + (expanded ? '▾' : '▸') + '</span>';
        }
        html += '</div>';

        // 没有可操作项就不渲染折叠区：一个点不开的箭头是噪音
        if (expandable) {
            html += '<div class="oc-cred-body"' + (expanded ? '' : ' style="display:none"') + '>';
            rows.forEach(function(row) {
                html += '<div class="oc-cred-row' + (row.isCurrent ? ' current' : '') + '">';
                html += '<span class="oc-cred-label">' + escapeHtml(row.label) + '</span>';
                if (row.isCurrent) {
                    html += '<span class="oc-cred-badge">当前</span>';
                } else if (row.canSwitch) {
                    const busy = credState.switching === row.credentialId;
                    html += '<button type="button" class="btn btn-sm oc-cred-switch"'
                        + ' data-credential-id="' + escapeHtml(row.credentialId) + '"'
                        + (busy ? ' disabled' : '') + '>'
                        + escapeHtml(busy ? '切换中…' : '切到此凭据')
                        + '</button>';
                }
                if (row.canDelete) {
                    const busy = credState.mutating === row.credentialId;
                    html += '<button type="button" class="btn btn-sm btn-del oc-cred-del"'
                        + ' data-credential-id="' + escapeHtml(row.credentialId) + '"'
                        + ' title="删除这把 key"'
                        + (busy ? ' disabled' : '') + '>'
                        + escapeHtml(busy ? '删除中…' : '删除')
                        + '</button>';
                }
                html += '</div>';
            });

            // 加一把新 key。这是「多 key」的前提：v2 没有凭据列表写接口，
            // 新增只能走 connect/key；在没有这个入口之前，用户手里第二把 key
            // 根本没法登记，也就无从「点一下切换」。
            if (canAddKey) {
                const busy = credState.mutating === integration.id;
                html += '<div class="oc-cred-add">';
                html += '<input class="oc-cred-add-key" type="password" autocomplete="off"'
                    + ' placeholder="粘贴新的 API Key" aria-label="新的 API Key"'
                    + (busy ? ' disabled' : '') + ' />';
                html += '<input class="oc-cred-add-label" type="text" autocomplete="off"'
                    + ' placeholder="备注名（可选）" aria-label="凭据备注名"'
                    + (busy ? ' disabled' : '') + ' />';
                html += '<button type="button" class="btn btn-sm oc-cred-add-save"'
                    + ' data-integration-id="' + escapeHtml(integration.id) + '"'
                    + (busy ? ' disabled' : '') + '>添加</button>';
                html += '</div>';
            }

            html += '</div>';
        }
        html += '</div>';
    });

    box.innerHTML = html;
}

/** 拉取凭据并渲染 */
export async function loadCredentials() {
    if (credState.loading) return;
    credState.loading = true;
    renderCredentials();
    try {
        const directory = currentDirectory();
        // includeEmpty=true：必须拉到全量，否则那 225 个没配凭据的集成
        // 不会出现在结果里，「接入一个全新供应商」就没有候选可选。
        // 后端这个开关本来就一直存在，之前只是前端写死了 false。
        const raw = await api.ListIntegrations(directory || '', true);
        let parsed;
        try {
            parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (e) {
            throw new Error('服务端返回的不是合法 JSON');
        }
        credState.last = summarizeIntegrations(parsed);
    } catch (e) {
        // 失败时保留上次内容，不清空面板——一次抖动不该让用户丢掉正在看的信息
        const prev = credState.last;
        credState.last = prev && !prev.error
            ? prev
            : { integrations: [], total: 0, shown: 0, filtered: true, error: (e && e.message) || String(e) };
    } finally {
        credState.loading = false;
        renderCredentials();
    }
}

/** 取当前项目目录。
 *
 *  凭据是按 location 作用域的。这里从侧栏目录条取当前目录（与其它
 *  location 作用域调用保持一致）；读不到就传空串让服务端用默认，
 *  而不是编一个目录——V2 的 location 参数被忽略时不报错，
 *  会静默返回**别的**目录下的结果。
 */
function currentDirectory() {
    const el = document.getElementById('ocSideDirPath');
    if (el) {
        const text = (el.textContent || '').trim();
        if (text && text !== '--') return text;
    }
    try {
        if (typeof store !== 'undefined' && store && store.pendingWorkDir) {
            return store.pendingWorkDir;
        }
    } catch (e) { /* store 可能未就绪 */ }
    return '';
}

/** 切换到指定凭据 */
async function activateCredential(credentialId) {
    if (!credentialId || credState.switching) return;
    credState.switching = credentialId;
    renderCredentials();
    try {
        const res = await api.ActivateCredential(credentialId);
        if (res && res.error) {
            showToast('切换失败：' + res.error, 'error');
        } else if (res && res.success === false) {
            showToast('切换失败：HTTP ' + res.status, 'error');
        } else {
            showToast('已切换凭据', 'success');
        }
        // 必须重新拉取：connections 顺序会变，只有服务端返回的顺序才作准
        await loadCredentials();
    } catch (e) {
        showToast('切换失败: ' + (e.message || e), 'error');
    } finally {
        credState.switching = '';
        renderCredentials();
    }
}

/** 为集成新增一把 API key。
 *
 * key 只在这里读一次、发出去，绝不回显到面板上——面板显示的一律是
 * 服务端给的 label / id。新增的那把会直接成为当前生效的凭据（实测），
 * 所以成功后必须重新拉列表，不能就地乐观改状态。
 */
async function addCredential(integrationId, keyInput, labelInput) {
    if (!integrationId || credState.mutating) return;
    const key = (keyInput && keyInput.value || '').trim();
    if (!key) {
        showToast('请先粘贴 API Key', 'error');
        return;
    }
    const label = (labelInput && labelInput.value || '').trim();

    // 提交前先清空输入框，且不进任何状态对象。
    // 后续 renderCredentials() 会重建 innerHTML，输入框本来就会消失；
    // 这里显式清一次是为了失败重试时也不残留上一次的明文 key。
    if (keyInput) keyInput.value = '';

    credState.mutating = integrationId;
    renderCredentials();
    try {
        const res = await api.AddCredential(integrationId, key, label);
        if (res && res.error) {
            showToast('添加失败：' + res.error, 'error');
        } else if (res && res.success === false) {
            showToast('添加失败：HTTP ' + res.status, 'error');
        } else {
            showToast('已添加凭据（已切换为当前使用）', 'success');
            // 新增的集成（如原先只挂环境变量）此前可能被折叠收起，直接展开它
            credState.expanded.add(integrationId);
        }
        await loadCredentials();
    } catch (e) {
        showToast('添加失败: ' + (e.message || e), 'error');
    } finally {
        // 接入成功后清掉选择，避免下次进来还挂着一个已接入的供应商
        credState.mutating = '';
        credState.connectPicked = '';
        renderCredentials();
    }
}

/** 删除一把凭据。
 *
 * canDelete 的守卫在纯逻辑侧（connectionRows），保证删完该供应商还剩一把；
 * 这里只负责二次确认与失败提示。
 */
async function deleteCredential(credentialId, label) {
    if (!credentialId || credState.mutating) return;
    if (!confirm('确定删除凭据「' + (label || credentialId) + '」吗？此操作不可撤销。')) return;
    credState.mutating = credentialId;
    renderCredentials();
    try {
        const res = await api.DeleteCredential(credentialId);
        if (res && res.error) {
            showToast('删除失败：' + res.error, 'error');
        } else if (res && res.success === false) {
            showToast('删除失败：HTTP ' + res.status, 'error');
        } else {
            showToast('已删除凭据', 'success');
        }
        await loadCredentials();
    } catch (e) {
        showToast('删除失败: ' + (e.message || e), 'error');
    } finally {
        credState.mutating = '';
        renderCredentials();
    }
}

/** 初始化面板事件（展开/折叠、切换按钮、添加/删除） */
export function initCredentials() {
    const box = document.getElementById('ocCredentials');
    if (!box || box.dataset.credBound === '1') return;
    box.dataset.credBound = '1';

    box.addEventListener('click', function(e) {
        const switchBtn = e.target.closest('.oc-cred-switch');
        if (switchBtn) {
            e.stopPropagation();
            activateCredential(switchBtn.dataset.credentialId);
            return;
        }
        const addBtn = e.target.closest('.oc-cred-add-save');
        if (addBtn) {
            e.stopPropagation();
            // 按钮禁用时浏览器不会派发 click，这里再挡一次以防手工构造事件
            if (addBtn.disabled) return;
            // 表单可能在「接入新供应商」区里，也可能在已配置集成卡片里，
            // 两处用 closest('.oc-cred-item') 兜不到前者，故按 form 回退
            const item = addBtn.closest('.oc-cred-item');
            const form = addBtn.closest('.oc-cred-connect-form');
            const scope = item || form;
            addCredential(
                addBtn.dataset.integrationId,
                scope ? scope.querySelector('.oc-cred-add-key') : null,
                scope ? scope.querySelector('.oc-cred-add-label') : null,
            );
            return;
        }
        const delBtn = e.target.closest('.oc-cred-del');
        if (delBtn) {
            e.stopPropagation();
            if (delBtn.disabled) return;
            const row = delBtn.closest('.oc-cred-row');
            const nameEl = row ? row.querySelector('.oc-cred-label') : null;
            deleteCredential(delBtn.dataset.credentialId, nameEl ? nameEl.textContent : '');
            return;
        }
        const head = e.target.closest('.oc-cred-head');
        if (head) {
            const id = head.dataset.integrationId;
            if (!id) return;
            if (credState.expanded.has(id)) {
                credState.expanded.delete(id);
            } else {
                credState.expanded.add(id);
            }
            renderCredentials();
        }
    });

    // 搜索框与下拉的 change 必须**委托**在 box 上，不能直接绑元素。
    // renderCredentials() 每次都重建整块 innerHTML，直接绑在元素上的
    // 监听器会随元素一起被丢弃，第二次重绘后就再也搜不动了。
    // 用 change 而非 input：每敲一个字母就重绘会把输入框换掉，压根没法打字。
    box.addEventListener('change', function(e) {
        const searchEl = e.target.closest('.oc-cred-connect-search');
        if (searchEl) {
            const q = (searchEl.value || '').trim();
            if (q === credState.connectQuery) return;
            credState.connectQuery = q;
            // 关键字变了，之前选中的供应商多半已不在候选里，清掉避免张冠李戴
            credState.connectPicked = '';
            renderCredentials();
            return;
        }
        const pickEl = e.target.closest('.oc-cred-connect-pick');
        if (pickEl) {
            credState.connectPicked = pickEl.value || '';
            renderCredentials();
        }
    });

    const refresh = document.getElementById('btnRefreshCreds');
    if (refresh) {
        refresh.addEventListener('click', function(e) {
            e.stopPropagation();
            loadCredentials();
        });
    }
}
