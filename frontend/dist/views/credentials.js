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
// POST /api/credential/{id}/activate；改显示名靠 PATCH（只能改 label，
// 改不了凭据内容——换 key 需要在 opencode 侧操作）。
//
// 纯逻辑（describeConnection / 行生成 / 说明文案）在 credential-model.js，
// 便于在 Node 下直接单测——本文件 import 了 apicall.js，测试进程加载不了。

import { api } from '../core/apicall.js';
import { store } from '../core/state.js';
import { showToast, escapeHtml } from '../core/utils.js';
import {
    connectionRows,
    credentialsHeaderText,
    summarizeIntegrations,
} from './credential-model.js';

/** 面板状态：跨次刷新保留展开项与切换中标记 */
const credState = {
    loading: false,
    /** 已展开的集成 id */
    expanded: new Set(),
    /** 正在切换的凭据 id，避免重复点击 */
    switching: '',
    /** 上次规整后的结果，失败时保留旧内容而不是清空 */
    last: null,
};

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
    if (summary.shown === 0) {
        box.innerHTML = '<div class="oc-empty">' + escapeHtml(credentialsHeaderText(summary)) + '</div>';
        return;
    }

    let html = '';
    // 过滤说明：让用户知道这里不是全量，而不是以为只有这几个集成
    const note = credentialsHeaderText(summary);
    if (note) {
        html += '<div class="oc-cred-note">' + escapeHtml(note) + '</div>';
    }

    summary.integrations.forEach(function(integration) {
        const rows = connectionRows(integration);
        const hasSwitchable = rows.some(function(r) { return r.canSwitch; });
        const expanded = credState.expanded.has(integration.id);

        html += '<div class="oc-cred-item">';
        html += '<div class="oc-cred-head" data-integration-id="' + escapeHtml(integration.id) + '">';
        html += '<span class="oc-cred-name">' + escapeHtml(integration.name) + '</span>';
        if (hasSwitchable) {
            html += '<span class="oc-cred-count">' + rows.length + ' 个连接</span>';
            html += '<span class="oc-cred-arrow">' + (expanded ? '▾' : '▸') + '</span>';
        }
        html += '</div>';

        // 没有可切换的连接就不渲染折叠区：一个点不开的箭头是噪音
        if (hasSwitchable) {
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
                html += '</div>';
            });
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
        const raw = await api.ListIntegrations(directory || '', false);
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

/** 初始化面板事件（展开/折叠、切换按钮） */
export function initCredentials() {
    const box = document.getElementById('ocCredentials');
    if (!box || box.dataset.credBound === '1') return;
    box.dataset.credBound = '1';

    box.addEventListener('click', function(e) {
        const btn = e.target.closest('.oc-cred-switch');
        if (btn) {
            e.stopPropagation();
            activateCredential(btn.dataset.credentialId);
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

    const refresh = document.getElementById('btnRefreshCreds');
    if (refresh) {
        refresh.addEventListener('click', function(e) {
            e.stopPropagation();
            loadCredentials();
        });
    }
}
