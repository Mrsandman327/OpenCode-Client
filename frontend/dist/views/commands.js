// ============================================================
// OpenCode 管理中心 - 常用命令视图
// ============================================================
// 说明：ES Modules 化改造。core 层依赖静态导入；本文件不依赖
// filebrowser/chat 模块，无守卫调用。
import { api } from '../core/apicall.js';
import { escapeHtml } from '../core/utils.js';
import { store } from '../core/state.js';

export let commandsData = [];
export let commandsLoaded = false;
export let apiDocData = null;
export let apiDocLoaded = false;

export function updateApiDocSearchVisibility(tab) {
    const searchBar = document.getElementById('apiDocSearchBar');
    if (!searchBar) return;
    searchBar.style.display = tab === 'api' ? '' : 'none';
}

export function renderCommandsCard(tab) {
    updateApiDocSearchVisibility(tab);
    if (tab === 'api') {
        if (apiDocLoaded) {
            renderApiDocs();
        } else {
            loadApiDocs();
        }
        return;
    }
    if (commandsLoaded) {
        renderCommands(tab);
    } else {
        loadCommands();
    }
}

export async function loadCommands() {
    const content = document.getElementById('cmdContent');
    if (commandsLoaded) return;

    content.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在加载命令列表...</p></div>';

    try {
        const data = await api.GetCommands();
        commandsData = data || [];
        commandsLoaded = true;
        renderCommands(store.cmdActiveTab);
    } catch (err) {
        content.innerHTML = `<div class="error">
            <p>⚠️ 加载命令失败</p>
            <p class="error-detail">${escapeHtml(err.message || err)}</p>
            <button class="btn btn-primary">重试</button>
        </div>`;
        // ESM 下内联 onclick 失效，改为事件监听绑定
        var retryBtn = content.querySelector('.btn.btn-primary');
        if (retryBtn) retryBtn.addEventListener('click', loadCommands);
    }
}

export function renderCommands(tab) {
    const content = document.getElementById('cmdContent');
    const isCLI = tab === 'cli';
    const filtered = commandsData.filter(g => g.isTui === !isCLI);

    if (filtered.length === 0) {
        content.innerHTML = '<div class="empty"><p>📭 没有找到命令</p></div>';
        return;
    }

    content.innerHTML = '';
    filtered.forEach(group => {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'cmd-group';

        const titleEl = document.createElement('h3');
        titleEl.className = 'cmd-group-title';
        titleEl.textContent = group.title;
        groupDiv.appendChild(titleEl);

        const grid = document.createElement('div');
        grid.className = 'cmd-grid';

        (group.cmds || []).forEach(cmd => {
            const card = document.createElement('div');
            card.className = 'cmd-card';

            const top = document.createElement('div');
            top.className = 'cmd-card-top';

            const nameEl = document.createElement('span');
            nameEl.className = 'cmd-card-name';
            nameEl.textContent = cmd.name;

            top.appendChild(nameEl);

            if (cmd.sub) {
                const subEl = document.createElement('span');
                subEl.className = 'cmd-card-sub';
                subEl.textContent = cmd.sub;
                top.appendChild(subEl);
            }

            if (cmd.options) {
                const shortcutEl = document.createElement('span');
                shortcutEl.className = 'cmd-card-shortcut';
                shortcutEl.textContent = cmd.options;
                top.appendChild(shortcutEl);
            }

            card.appendChild(top);

            if (cmd.desc) {
                const descEl = document.createElement('p');
                descEl.className = 'cmd-card-desc';
                descEl.textContent = cmd.desc;
                card.appendChild(descEl);
            }

            grid.appendChild(card);
        });

        groupDiv.appendChild(grid);
        content.appendChild(groupDiv);
    });
}

export function filterApiDocsEntries(entries) {
    const keyword = store.apiDocKeyword.trim().toLowerCase();
    if (!keyword) return entries;

    return entries.filter(({ path, detail }) => {
        const summary = (detail.summary || '').toLowerCase();
        const description = (detail.description || '').toLowerCase();
        const lowerPath = (path || '').toLowerCase();

        return lowerPath.indexOf(keyword) >= 0
            || summary.indexOf(keyword) >= 0
            || description.indexOf(keyword) >= 0;
    });
}

/**
 * 加载 opencode 服务的 API 文档（OpenAPI 3.1.0 JSON）
 * 从网络配置中读取 ip:port，访问 http://ip:port/doc
 */
export async function loadApiDocs() {
    const content = document.getElementById('cmdContent');
    content.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在加载 API 文档...</p></div>';

    try {
        const data = await api.OpenCodeCall('GET', '/doc');
        apiDocData = data;
        apiDocLoaded = true;
        renderApiDocs();
    } catch (err) {
        content.innerHTML = `<div class="error">
            <p>⚠️ 加载 API 文档失败</p>
            <p class="error-detail">${escapeHtml(err.message || err)}（请确认 OpenCode 服务已启动）</p>
            <button class="btn btn-primary">重试</button>
        </div>`;
        // ESM 下内联 onclick 失效，改为事件监听绑定
        var retryBtn = content.querySelector('.btn.btn-primary');
        if (retryBtn) retryBtn.addEventListener('click', function() { apiDocLoaded = false; loadApiDocs(); });
    }
}

/**
 * 渲染 API 文档：按 tag 分组，表格展示端点
 */
export function renderApiDocs() {
    const content = document.getElementById('cmdContent');
    content.innerHTML = '';

    if (!apiDocData || !apiDocData.paths) {
        content.innerHTML = '<div class="empty"><p>📭 未获取到 API 文档</p></div>';
        return;
    }

    // 按 tag 分组
    const tags = {};
    const entries = [];
    Object.entries(apiDocData.paths).forEach(([path, methods]) => {
        Object.entries(methods).forEach(([method, detail]) => {
            if (method === 'parameters') return;
            (detail.tags || ['默认']).forEach(tag => {
                if (!tags[tag]) tags[tag] = [];
                const entry = { path, method: method.toUpperCase(), detail, tag };
                tags[tag].push(entry);
                entries.push(entry);
            });
        });
    });

    const filteredEntries = filterApiDocsEntries(entries);
    if (filteredEntries.length === 0) {
        content.innerHTML = '<div class="empty"><p>未找到匹配的 API 接口</p></div>';
        return;
    }

    const filteredTags = {};
    filteredEntries.forEach(entry => {
        if (!filteredTags[entry.tag]) filteredTags[entry.tag] = [];
        filteredTags[entry.tag].push(entry);
    });

    // 渲染每个 tag 组
    const sortedTags = Object.keys(filteredTags).sort();
    sortedTags.forEach(tag => {
        const group = document.createElement('div');
        group.className = 'cmd-group';

        const title = document.createElement('h3');
        title.className = 'cmd-group-title';
        title.textContent = tag;
        group.appendChild(title);

        const grid = document.createElement('div');
        grid.className = 'api-doc-grid';

        title.addEventListener('click', () => {
            grid.classList.toggle('collapsed');
            title.classList.toggle('collapsed');
        });

        filteredTags[tag].forEach(({ path, method, detail }) => {
            const row = document.createElement('div');
            row.className = 'api-doc-row';

            // 方法标签
            const methodSpan = document.createElement('span');
            methodSpan.className = 'api-method ' + method.toLowerCase();
            methodSpan.textContent = method;
            row.appendChild(methodSpan);

            // 路径 + 摘要
            const pathSpan = document.createElement('span');
            pathSpan.className = 'api-path';
            pathSpan.textContent = path;
            row.appendChild(pathSpan);

            const summarySpan = document.createElement('span');
            summarySpan.className = 'api-summary';
            summarySpan.textContent = detail.summary || detail.description || '';
            row.appendChild(summarySpan);

            row.addEventListener('click', () => {
                row.classList.toggle('expanded');
            });

            // 展开详情
            const detailDiv = document.createElement('div');
            detailDiv.className = 'api-detail';

            // 参数
            if (detail.parameters && detail.parameters.length) {
                const paramsDiv = document.createElement('div');
                paramsDiv.className = 'api-params';
                paramsDiv.innerHTML = '<strong>参数：</strong>';
                const paramList = document.createElement('ul');
                detail.parameters.forEach(p => {
                    const li = document.createElement('li');
                    li.innerHTML = `<code>${escapeHtml(p.name)}</code> (${p.in})${p.required ? ' <em>必填</em>' : ''} — ${escapeHtml(p.description || '')}`;
                    paramList.appendChild(li);
                });
                paramsDiv.appendChild(paramList);
                detailDiv.appendChild(paramsDiv);
            }

            // 请求体
            if (detail.requestBody) {
                const bodyDiv = document.createElement('div');
                bodyDiv.className = 'api-request-body';
                bodyDiv.innerHTML = `<strong>请求体：</strong><pre><code style="font-size:1.2em;line-height:1.5;color: rgb(31, 80, 227);font-family:'Consolas'">${escapeHtml(JSON.stringify(detail.requestBody, null, 2))}</code></pre>`;
                detailDiv.appendChild(bodyDiv);
            }

            // 响应
            if (detail.responses) {
                const respDiv = document.createElement('div');
                respDiv.className = 'api-request-body';
                respDiv.innerHTML = `<strong>响应体：</strong><pre><code style="font-size:1.2em;line-height:1.5;color: rgb(31, 80, 227);font-family:'Consolas'">${escapeHtml(JSON.stringify(detail.responses, null, 2))}</code></pre>`;
                detailDiv.appendChild(respDiv);
            }

            row.appendChild(detailDiv);
            grid.appendChild(row);
        });

        group.appendChild(grid);
        content.appendChild(group);
    });
}
