// ============================================================
// OpenCode 管理中心 - 知识库视图
// 视觉与交互对齐 doc/知识库原型.html（Apple 风格）；
// 数据来自后端 knowledge.Store（KnowledgeList / KnowledgeGet / KnowledgeSave /
// KnowledgeDelete / KnowledgeCategories / KnowledgeSaveCategories）。
// 说明：P0 只做「主页 + 分类管理 + 编辑弹窗」，不含 @ 调用与转化（P1/P2）。
// ============================================================
import { api } from '../core/apicall.js';
import { escapeHtml, showToast } from '../core/utils.js';
// 当前会话所在目录（转化弹窗的「目标项目」默认值）取自会话状态
import { store } from '../core/state.js';
// 复用文件浏览器的 Markdown 白名单清洗（与 project-config.js 的用法一致），不重复实现安全逻辑
import { fileBrowserSanitizeMarkedHtml } from '../filebrowser/preview.js';

// ---------- 内联线性图标（不使用 emoji） ----------
var ICONS = {
    doc: '<svg class="kb-i" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    caret: '<svg class="kb-i kb-i-14" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    folder: '<svg class="kb-i kb-i-14" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    layers: '<svg class="kb-i kb-i-14" viewBox="0 0 24 24"><path d="M12 2l9 5-9 5-9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 17l9 5 9-5"/></svg>',
    close: '<svg class="kb-i kb-i-14" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    search: '<svg class="kb-i kb-i-20" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7.5"/><path d="M20.5 20.5l-4.2-4.2"/></svg>',
    plus: '<svg class="kb-i kb-i-14" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    // 垃圾桶：条目卡片 / 列表行右上角删除按钮，与分类菜单的删除图标保持同一套线性语言
    trash: '<svg class="kb-i kb-i-14" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/><path d="M10 11v5M14 11v5"/></svg>'
};

// ---------- 视图状态 ----------
var kbState = {
    entries: [],        // 条目列表（元数据，content 为空）
    categories: [],     // 分类树（纯数据，保存时原样回传后端）
    collapsed: {},      // 分类折叠状态 { 分类id: true }，只影响渲染，不落盘
    view: 'card',       // 视图模式：'card'（默认）| 'list'
    cat: 'all',         // 当前选中分类：'all' 表示全部条目
    keyword: '',        // 搜索关键词
    tagFilter: '',      // 标签筛选（与分类筛选相互独立）
    contentMode: 'edit', // 内容区模式：'edit'（默认）| 'preview'，每次打开弹窗都重置为编辑
    modalTags: [],      // 编辑弹窗内当前标签
    editingId: null,    // 编辑中的条目 id；null 表示新建
    editingEntry: null, // 编辑中的条目原始对象（用于保留 created / converted）
    loading: false,     // 加载防重入
    bound: false        // 事件是否已绑定
};

/** 属性值转义：escapeHtml 只处理 & < >，属性里还需要把引号转成实体 */
function attr(value) {
    return escapeHtml(value).replace(/"/g, '&quot;');
}

function $(sel) { return document.querySelector(sel); }

// ============================================================
// 分类树工具
// ============================================================

/** 按 id 查找分类节点（递归，支持任意层级） */
function kbFindCat(id, list) {
    list = list || kbState.categories;
    for (var i = 0; i < list.length; i++) {
        var cat = list[i];
        if (cat.id === id) return cat;
        var found = kbFindCat(id, cat.children || []);
        if (found) return found;
    }
    return null;
}

/** 从根到目标节点的路径数组，未找到返回 null */
function kbFindPath(id, list, trail) {
    list = list || kbState.categories;
    trail = trail || [];
    for (var i = 0; i < list.length; i++) {
        var cat = list[i];
        var path = trail.concat([cat]);
        if (cat.id === id) return path;
        var found = kbFindPath(id, cat.children || [], path);
        if (found) return found;
    }
    return null;
}

/** 分类显示路径，如「项目 / 服务端」 */
function kbCatPath(id) {
    var path = kbFindPath(id);
    if (!path) return '未分类';
    return path.map(function (c) { return c.name; }).join(' / ');
}

/** 分类识别色的键：子分类继承顶层分类的颜色；未匹配到则返回空串（回退中性灰） */
function kbCatColorKey(id) {
    var path = kbFindPath(id);
    return path && path.length ? path[0].id : '';
}

/** 该分类及其全部后代的 id */
function kbCatSubtreeIds(cat) {
    var ids = [cat.id];
    (cat.children || []).forEach(function (child) {
        ids = ids.concat(kbCatSubtreeIds(child));
    });
    return ids;
}

/** 该分类下的条目（含所有子分类） */
function kbEntriesOfCat(catId) {
    if (catId === 'all') return kbState.entries;
    var cat = kbFindCat(catId);
    if (!cat) return [];
    var ids = kbCatSubtreeIds(cat);
    return kbState.entries.filter(function (e) { return ids.indexOf(e.category) !== -1; });
}

/** 分类计数（含所有子分类） */
function kbCountOfCat(catId) { return kbEntriesOfCat(catId).length; }

/** 生成新的分类 id（分类 id 与条目文件名无关，仅作稳定标识） */
function kbNewCatId() {
    return 'cat-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

/** 同级是否已存在同名分类（excludeId 用于重命名时排除自身） */
function kbSiblingNameExists(list, name, excludeId) {
    return list.some(function (c) { return c.id !== excludeId && c.name === name; });
}

/** 剥离 UI 状态，构造回传后端的纯分类树（叶子统一给空数组） */
function kbPureCats(list) {
    return (list || []).map(function (cat) {
        return { id: cat.id, name: cat.name, children: kbPureCats(cat.children || []) };
    });
}

/** 从树中移除指定节点（连同其子树） */
function kbRemoveCat(list, id) {
    for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) {
            list.splice(i, 1);
            return true;
        }
        if (kbRemoveCat(list[i].children || [], id)) return true;
    }
    return false;
}

/**
 * 递归把「有子节点」的分类标记为折叠。
 * 用于数据加载后设定默认态：分类树默认收起，只露出顶层分类。
 */
function kbCollapseAllParents(list) {
    (list || []).forEach(function (cat) {
        var kids = cat.children || [];
        if (kids.length) {
            kbState.collapsed[cat.id] = true;
            kbCollapseAllParents(kids);
        }
    });
}

// ============================================================
// 数据加载
// ============================================================

/**
 * 加载知识库数据并整体重绘。
 * @param {boolean} force 强制重新拉取（保存后刷新用）
 */
export async function loadKnowledgeView(force) {
    if (kbState.loading) return;
    kbState.loading = true;
    try {
        var results = await Promise.all([api.KnowledgeList(), api.KnowledgeCategories()]);
        kbState.entries = results[0] || [];
        kbState.categories = results[1] || [];
        kbState.collapsed = {};   // 数据重新加载后重置折叠状态，避免残留无效 id
        // 默认折叠：所有带子分类的节点一律收起，用户手动展开的状态在本次会话内由 collapsed 保持
        kbCollapseAllParents(kbState.categories);
        // 当前选中的分类若已不存在，回退到「全部条目」
        if (kbState.cat !== 'all' && !kbFindCat(kbState.cat)) kbState.cat = 'all';
        renderKbCatTree();
        fillKbCatSelect();
        renderKbTagFilterPop();
        updateKbTagFilterBtn();
        applyKbView();
        renderKbEntries();
        if (force) showToast('知识库已刷新', 'success');
    } catch (err) {
        showToast('加载知识库失败: ' + (err.message || err), 'error');
        renderKbError();
    } finally {
        kbState.loading = false;
    }
}

/** 加载失败时的兜底渲染 */
function renderKbError() {
    var cardView = $('#kbCardView');
    var listView = $('#kbListView');
    var empty = '<div class="kb-empty">' + ICONS.search + '<span>知识库加载失败，请稍后重试</span></div>';
    if (cardView) cardView.innerHTML = empty;
    if (listView) listView.innerHTML = empty;
    var countEl = $('#kbListCount');
    if (countEl) countEl.textContent = '';
}

// ============================================================
// 渲染：分类树
// ============================================================

export function renderKbCatTree() {
    var host = $('#kbCatTree');
    if (!host) return;

    var html = '';

    // 顶部「全部条目」虚拟节点（不参与分类管理）
    html += kbCatNodeHtml({ id: 'all', name: '全部条目' }, 0, false, kbState.entries.length, kbState.cat === 'all', false);

    if (kbState.categories.length) {
        // 细分隔线：把「全部条目」这个特殊汇总项与普通分类树在视觉上分开（保持克制）
        html += '<div class="kb-cat-divider" aria-hidden="true"></div>';
        // 顶层分类与「全部条目」同层级：level 0（缩进一致）；子级由 kbCatListHtml 逐层 +1
        html += kbCatListHtml(kbState.categories, 0);
    } else {
        html += '<div class="kb-tag-pop-empty">暂无分类，可在下方新建</div>';
    }

    host.innerHTML = html;
}

/** 递归渲染分类列表 */
function kbCatListHtml(list, level) {
    var html = '';
    (list || []).forEach(function (cat) {
        var children = cat.children || [];
        var hasKids = children.length > 0;
        var collapsed = !!kbState.collapsed[cat.id];
        html += kbCatNodeHtml(cat, level, hasKids, kbCountOfCat(cat.id), kbState.cat === cat.id, collapsed);
        if (hasKids) {
            html += '<div class="kb-cat-children' + (collapsed ? ' hidden' : '') + '">' +
                        kbCatListHtml(children, level + 1) +
                    '</div>';
        }
    });
    return html;
}

/** 单个分类节点：缩进按层级内联写入，支持任意深度 */
function kbCatNodeHtml(cat, level, hasKids, count, active, collapsed) {
    var paddingLeft = 8 + level * 14;
    return '<div class="kb-cat-node' + (active ? ' active' : '') + (collapsed ? ' collapsed' : '') + '"' +
                ' data-kb-cat="' + attr(cat.id) + '"' +
                (hasKids ? ' data-kb-toggle="1"' : '') +
                ' style="padding-left:' + paddingLeft + 'px" title="' + attr(cat.name) + '">' +
                '<span class="kb-cat-caret' + (hasKids ? '' : ' is-leaf') + '">' + ICONS.caret + '</span>' +
                '<span class="kb-cat-icon">' + (level === 0 ? ICONS.folder : ICONS.layers) + '</span>' +
                '<span class="kb-cat-name">' + escapeHtml(cat.name) + '</span>' +
                '<span class="kb-cat-count">' + count + '</span>' +
            '</div>';
}

// ============================================================
// 渲染：条目列表 / 卡片
// ============================================================

/**
 * 当前筛选结果：分类 + 标签 + 关键词三者叠加。
 * 关键词命中标题的条目优先排前（其次保持后端返回的更新时间倒序）。
 */
function kbFilteredEntries() {
    var list = kbEntriesOfCat(kbState.cat);

    if (kbState.tagFilter) {
        list = list.filter(function (e) {
            return (e.tags || []).indexOf(kbState.tagFilter) !== -1;
        });
    }

    var kw = kbState.keyword.toLowerCase();
    if (kw) {
        list = list.filter(function (e) {
            var hay = (e.title + ' ' + (e.summary || '') + ' ' + (e.tags || []).join(' ')).toLowerCase();
            return hay.indexOf(kw) !== -1;
        });
        // 标题命中优先；Array#sort 稳定，故未命中标题的条目保持原有顺序
        list = list.slice().sort(function (a, b) {
            var aTitle = a.title.toLowerCase().indexOf(kw) !== -1 ? 0 : 1;
            var bTitle = b.title.toLowerCase().indexOf(kw) !== -1 ? 0 : 1;
            return aTitle - bTitle;
        });
    }
    return list;
}

/** 标签胶囊组 */
function tagListHtml(tags) {
    tags = tags || [];
    if (!tags.length) return '';
    return '<div class="tag-list">' + tags.map(function (t) {
        return '<span class="tag-pill">#' + escapeHtml(t) + '</span>';
    }).join('') + '</div>';
}

/**
 * 条目删除按钮：绝对定位在卡片 / 列表行的右上角，鼠标悬停在该条目上才显形（样式见 .kb-del-btn）。
 * 这里只负责产出 HTML，点击统一由容器上的委托事件分发到 deleteKbEntryById。
 * @param {string} id 条目 id
 */
function kbDeleteBtnHtml(id) {
    return '<button type="button" class="kb-del-btn" data-kb-del="' + attr(id) + '"' +
                ' title="删除条目" aria-label="删除条目">' + ICONS.trash +
           '</button>';
}

export function renderKbEntries() {
    var list = kbFilteredEntries();

    var countEl = $('#kbListCount');
    if (countEl) countEl.textContent = list.length + ' 条';

    var crumbEl = $('#kbListCrumb');
    if (crumbEl) {
        var crumb = kbState.cat === 'all' ? '全部条目' : kbCatPath(kbState.cat);
        if (kbState.tagFilter) crumb += ' · #' + kbState.tagFilter;
        crumbEl.textContent = crumb;
    }

    // 空状态文案按原因区分，便于用户定位问题
    var emptyText = '知识库还没有条目，点右上角「新建条目」开始记录';
    if (kbState.keyword || kbState.tagFilter) {
        emptyText = '没有匹配的条目，换个关键词或标签试试';
    } else if (kbState.cat !== 'all') {
        emptyText = '该分类下还没有条目';
    }

    var listView = $('#kbListView');
    var cardView = $('#kbCardView');

    // ---- 列表视图 ----
    if (listView) {
        if (!list.length) {
            listView.innerHTML = '<div class="kb-empty">' + ICONS.search + '<span>' + escapeHtml(emptyText) + '</span></div>';
        } else {
            listView.innerHTML = list.map(function (e) {
                var colorKey = kbCatColorKey(e.category);
                return '<div class="kb-row' + (colorKey ? ' cat-' + attr(colorKey) : '') + '" data-kb-entry="' + attr(e.id) + '">' +
                            kbDeleteBtnHtml(e.id) +
                            '<div class="kb-row-icon">' + ICONS.doc + '</div>' +
                            '<div class="kb-row-main">' +
                                '<div class="kb-row-title-line">' +
                                    '<span class="kb-row-title">' + escapeHtml(e.title) + '</span>' +
                                '</div>' +
                                '<div class="kb-row-summary">' + escapeHtml(e.summary || '（暂无说明）') + '</div>' +
                            '</div>' +
                            '<div class="kb-row-meta">' +
                                tagListHtml(e.tags) +
                                '<span class="kb-row-cat">' + ICONS.folder + escapeHtml(kbCatPath(e.category)) + '</span>' +
                            '</div>' +
                        '</div>';
            }).join('');
        }
    }

    // ---- 卡片视图（默认） ----
    if (cardView) {
        if (!list.length) {
            cardView.innerHTML = '<div class="kb-empty">' + ICONS.search + '<span>' + escapeHtml(emptyText) + '</span></div>';
        } else {
            cardView.innerHTML = list.map(function (e) {
                var colorKey = kbCatColorKey(e.category);
                return '<div class="kb-card' + (colorKey ? ' cat-' + attr(colorKey) : '') + '" data-kb-entry="' + attr(e.id) + '">' +
                            kbDeleteBtnHtml(e.id) +
                            '<div class="kb-card-head">' +
                                '<div class="kb-row-icon">' + ICONS.doc + '</div>' +
                                '<span class="kb-card-title" title="' + attr(e.title) + '">' + escapeHtml(e.title) + '</span>' +
                            '</div>' +
                            '<div class="kb-card-summary">' + escapeHtml(e.summary || '（暂无说明）') + '</div>' +
                            '<div class="kb-card-foot">' +
                                tagListHtml(e.tags) +
                                '<span class="kb-row-cat">' + escapeHtml(kbCatPath(e.category)) + '</span>' +
                            '</div>' +
                        '</div>';
            }).join('');
        }
    }
}

/** 同步分段控件高亮与两个容器的显隐 */
export function applyKbView() {
    document.querySelectorAll('#kbViewSeg .kb-seg-btn').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.view === kbState.view);
    });
    var listView = $('#kbListView');
    var cardView = $('#kbCardView');
    if (listView) listView.style.display = kbState.view === 'list' ? '' : 'none';
    if (cardView) cardView.style.display = kbState.view === 'card' ? '' : 'none';
}

// ============================================================
// 渲染：标签筛选下拉
// ============================================================

export function renderKbTagFilterPop() {
    var host = $('#kbTagPop');
    if (!host) return;

    var counts = {};
    kbState.entries.forEach(function (e) {
        (e.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    var tags = Object.keys(counts).sort(function (a, b) {
        return counts[b] - counts[a] || a.localeCompare(b, 'zh');
    });

    var html = '<div class="kb-tag-pop-item' + (kbState.tagFilter ? '' : ' active') + '" data-kb-tag="">' +
                   '全部标签' +
               '</div>';
    if (!tags.length) {
        html += '<div class="kb-tag-pop-empty">暂无标签</div>';
    } else {
        tags.forEach(function (t) {
            html += '<div class="kb-tag-pop-item' + (kbState.tagFilter === t ? ' active' : '') + '"' +
                        ' data-kb-tag="' + attr(t) + '">#' + escapeHtml(t) +
                        '<span class="kb-tag-pop-count">' + counts[t] + '</span>' +
                    '</div>';
        });
    }
    host.innerHTML = html;
}

/** 同步标签筛选按钮的文本与激活态 */
function updateKbTagFilterBtn() {
    var btn = $('#kbTagFilterBtn');
    var label = $('#kbTagFilterLabel');
    if (!btn || !label) return;
    label.className = 'kb-tag-btn-label';
    label.textContent = kbState.tagFilter ? ('#' + kbState.tagFilter) : '标签';
    btn.classList.toggle('active', !!kbState.tagFilter);
    btn.title = kbState.tagFilter ? ('当前筛选：# ' + kbState.tagFilter) : '按标签筛选';
}

function toggleKbTagPop(show) {
    var pop = $('#kbTagPop');
    if (!pop) return;
    var next = (typeof show === 'boolean') ? show : (pop.style.display === 'none');
    pop.style.display = next ? 'block' : 'none';
    if (next) renderKbTagFilterPop();
}

// ============================================================
// 渲染：编辑弹窗内的分类下拉与标签编辑器
// ============================================================

/** 展平分类树为「层级路径」下拉选项 */
export function fillKbCatSelect() {
    var select = $('#kbEntryCat');
    if (!select) return;
    var prev = select.value;

    var options = ['<option value="">未分类</option>'];
    (function walk(list) {
        (list || []).forEach(function (cat) {
            options.push('<option value="' + attr(cat.id) + '">' + escapeHtml(kbCatPath(cat.id)) + '</option>');
            walk(cat.children || []);
        });
    })(kbState.categories);

    select.innerHTML = options.join('');
    // 恢复原选中值；分类已被删除时回退到「未分类」
    if (prev && kbFindCat(prev)) select.value = prev;
}

function renderKbTagEditor() {
    var host = $('#kbTagEditor');
    if (!host) return;
    var html = kbState.modalTags.map(function (t, i) {
        return '<span class="kb-tag-edit">#' + escapeHtml(t) +
                    '<button type="button" class="kb-tag-x" data-kb-tag-del="' + i + '" title="删除标签">' + ICONS.close + '</button>' +
                '</span>';
    }).join('');
    html += '<button type="button" class="kb-tag-add" id="kbAddTagBtn">' + ICONS.plus + '添加</button>';
    host.innerHTML = html;
}

// ============================================================
// 编辑弹窗：三个必填区（标题 / 说明 / 内容）与校验
// ============================================================

/** 三个必填区块的 DOM 映射：field 为区块容器（错误态加 .invalid），input 为输入控件，err 为错误文案节点 */
var KB_REQUIRED_FIELDS = [
    { key: 'title',   field: '#kbFieldTitle',   input: '#kbEntryTitle',   err: '#kbErrTitle',   label: '标题' },
    { key: 'summary', field: '#kbFieldSummary', input: '#kbEntrySummary', err: '#kbErrSummary', label: '说明' },
    { key: 'content', field: '#kbFieldContent', input: '#kbEntryContent', err: '#kbErrContent', label: '内容' }
];

/** 清除全部必填区的错误态 */
function clearKbFieldErrors() {
    KB_REQUIRED_FIELDS.forEach(function (cfg) {
        var field = $(cfg.field);
        if (field) field.classList.remove('invalid');
        var err = $(cfg.err);
        if (err) err.textContent = '';
    });
}

/** 标记单个必填区为错误态并写入提示文案 */
function markKbFieldError(cfg, message) {
    var field = $(cfg.field);
    if (field) field.classList.add('invalid');
    var err = $(cfg.err);
    if (err) err.textContent = message;
}

/**
 * 校验三个必填区，返回 trim 后的取值。
 * 任一区块 trim 后为空即不通过：加错误态、聚焦首个缺失项、Toast 汇总提示，
 * 由调用方直接拦截保存（不发请求）。
 * @returns {{ok: boolean, values: {title: string, summary: string, content: string}}}
 */
function collectKbEntryValues() {
    clearKbFieldErrors();
    var values = {};
    var missing = [];
    var firstMissing = null;

    KB_REQUIRED_FIELDS.forEach(function (cfg) {
        var el = $(cfg.input);
        values[cfg.key] = el ? String(el.value || '').trim() : '';
        if (!values[cfg.key]) {
            missing.push(cfg.label);
            markKbFieldError(cfg, cfg.label + '不能为空');
            if (!firstMissing) firstMissing = el;
        }
    });

    if (missing.length) {
        // 前端先行拦截；后端同样会校验，但这里不依赖其报错
        showToast('请填写：' + missing.join('、'), 'error');
        if (firstMissing) firstMissing.focus();
        return { ok: false, values: values };
    }
    return { ok: true, values: values };
}

// ============================================================
// 编辑弹窗：内容区「编辑 / 预览」切换
// ============================================================

/**
 * 应用内容区模式：'edit' 显示 textarea；'preview' 用全局 marked 渲染其当前内容后显示预览层。
 * 只切换显隐与预览内容，textarea 自身的值不受影响，所以来回切不会丢已输入的内容。
 */
function applyKbContentMode() {
    var isPreview = kbState.contentMode === 'preview';

    document.querySelectorAll('#kbContentSeg .kb-seg-btn').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.kbContentMode === kbState.contentMode);
    });

    var input = $('#kbEntryContent');
    var preview = $('#kbContentPreview');
    if (input) input.style.display = isPreview ? 'none' : '';
    if (!preview) return;
    preview.style.display = isPreview ? '' : 'none';
    if (!isPreview) return;

    var text = input ? String(input.value || '') : '';
    if (!text.trim()) {
        preview.innerHTML = '<div class="kb-preview-empty">内容为空，切回「编辑」开始输入</div>';
        return;
    }
    // marked 由 index.html 全局引入；渲染结果先经白名单清洗再写入，避免脚本注入
    if (typeof marked === 'undefined') {
        preview.textContent = text;
        return;
    }
    preview.innerHTML = fileBrowserSanitizeMarkedHtml(marked.parse(text, { breaks: true }));
}

// ============================================================
// 编辑弹窗：打开 / 关闭 / 保存 / 删除
// ============================================================

/**
 * 打开编辑弹窗。
 * @param {string|null} id 条目 id；为空表示新建（空白态）
 */
export async function openKbEntryModal(id) {
    var modal = $('#kbEntryModal');
    if (!modal) return;

    var entry = null;
    if (id) {
        try {
            // 列表接口不返回正文，正文需单独拉取
            entry = await api.KnowledgeGet(id);
        } catch (err) {
            showToast('加载条目失败: ' + (err.message || err), 'error');
            return;
        }
    }

    kbState.editingId = entry ? entry.id : null;
    kbState.editingEntry = entry;
    kbState.modalTags = entry ? (entry.tags || []).slice() : [];

    var titleEl = $('#kbEntryModalTitle');
    if (titleEl) titleEl.textContent = entry ? '编辑条目' : '新建条目';

    var titleInput = $('#kbEntryTitle');
    if (titleInput) titleInput.value = entry ? (entry.title || '') : '';

    // 说明：用户手填的短文本，列表 / 卡片视图展示这条
    var summaryInput = $('#kbEntrySummary');
    if (summaryInput) summaryInput.value = entry ? (entry.summary || '') : '';

    var contentInput = $('#kbEntryContent');
    if (contentInput) contentInput.value = entry ? (entry.content || '') : '';

    // 每次打开都是干净状态，不残留上一次的红色错误框
    clearKbFieldErrors();

    fillKbCatSelect();
    var catSelect = $('#kbEntryCat');
    if (catSelect) catSelect.value = entry ? (entry.category || '') : '';

    renderKbTagEditor();

    // 每次打开都回到「编辑」模式，避免上一次退出时停留在预览态
    kbState.contentMode = 'edit';
    applyKbContentMode();

    // 说明：删除入口已移到条目卡片 / 列表行右上角的删除按钮（见 kbDeleteBtnHtml），弹窗内不再提供
    // 「转化为资产」仅对已保存（有 id）的条目可用：新建未保存时没有 id，无法发起转化
    var convertBtn = $('#kbEntryConvertBtn');
    if (convertBtn) {
        convertBtn.disabled = !entry;
        convertBtn.title = entry ? '转化为 OpenCode 资产' : '保存后才能转化为资产';
    }

    modal.style.display = 'flex';
    if (titleInput) setTimeout(function () { titleInput.focus(); }, 30);
}

export function closeKbEntryModal() {
    var modal = $('#kbEntryModal');
    if (modal) modal.style.display = 'none';
    kbState.editingId = null;
    kbState.editingEntry = null;
}

export async function saveKbEntry() {
    // 三个必填区一起校验：任一为空直接拦截，不发请求
    var check = collectKbEntryValues();
    if (!check.ok) {
        // 内容为空又停在预览态时，编辑框是隐藏的——既看不到错误提示也没法修改，这里自动切回「编辑」
        if (kbState.contentMode === 'preview' && !check.values.content) {
            kbState.contentMode = 'edit';
            applyKbContentMode();
            var contentEl = $('#kbEntryContent');
            if (contentEl) contentEl.focus();
        }
        return;
    }
    var values = check.values;

    var catSelect = $('#kbEntryCat');
    var original = kbState.editingEntry;
    var title = values.title;

    // 组装完整 entry：id 为空表示新建；
    // created / converted 由后端生成或历史保留，这里原样回传以免丢失
    var payload = {
        id: kbState.editingId || '',
        title: title,
        category: catSelect ? catSelect.value : '',
        tags: kbState.modalTags.slice(),
        summary: values.summary,
        created: original ? (original.created || '') : '',
        updated: '',
        converted: original ? (original.converted || []).slice() : [],
        content: values.content
    };

    var saveBtn = $('#kbEntrySaveBtn');
    var isNew = !kbState.editingId;
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中…';
    }
    try {
        await api.KnowledgeSave(payload);
        showToast(isNew ? '已新建条目：' + title : '已保存条目：' + title, 'success');
        closeKbEntryModal();
        await loadKnowledgeView();
    } catch (err) {
        showToast('保存失败: ' + (err.message || err), 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = '保存';
        }
    }
}

/** 按 id 取出列表中的条目元数据（列表接口不含正文，但含标题，用于确认文案） */
function kbFindEntryMeta(id) {
    for (var i = 0; i < kbState.entries.length; i++) {
        if (kbState.entries[i].id === id) return kbState.entries[i];
    }
    return null;
}

/**
 * 删除指定条目（入口：条目卡片 / 列表行右上角的删除按钮）。
 * 二次确认后调用后端接口，成功后刷新列表并 Toast 提示。
 * @param {string} id 条目 id
 */
export async function deleteKbEntryById(id) {
    if (!id) return;
    var meta = kbFindEntryMeta(id);
    var title = meta ? meta.title : id;
    if (!confirm('确定删除条目「' + title + '」？删除后不可恢复。')) return;

    try {
        // 成功后后端无返回值，失败会抛错
        await api.KnowledgeDelete(id);
        showToast('已删除条目：' + title, 'success');
        // 若该条目正在编辑弹窗中，一并关闭，避免残留已删除的数据
        if (kbState.editingId === id) closeKbEntryModal();
        await loadKnowledgeView();
    } catch (err) {
        showToast('删除失败: ' + (err.message || err), 'error');
    }
}

// ============================================================
// 分类管理（右键菜单：新建子分类 / 重命名 / 删除）
// ============================================================

var kbCatMenuCatId = null;    // 分类右键菜单当前指向的分类 id

/** 弹出菜单定位：写入 left/top 并收敛到视口内，避免越界 */
function kbPositionMenu(menu, x, y) {
    var w = menu.offsetWidth;
    var h = menu.offsetHeight;
    var left = Math.max(8, Math.min(x, document.documentElement.clientWidth - w - 8));
    var top = Math.max(8, Math.min(y, document.documentElement.clientHeight - h - 8));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
}

function showKbCatMenu(x, y, catId) {
    var menu = $('#kbCatMenu');
    if (!menu) return;
    kbCatMenuCatId = catId;
    menu.style.display = 'block';
    kbPositionMenu(menu, x, y);
}

function hideKbCatMenu() {
    var menu = $('#kbCatMenu');
    if (menu) menu.style.display = 'none';
    kbCatMenuCatId = null;
}

/** 持久化完整分类树；失败时回滚为服务端状态 */
async function saveKbCategories(successText) {
    try {
        await api.KnowledgeSaveCategories(kbPureCats(kbState.categories));
        renderKbCatTree();
        fillKbCatSelect();
        renderKbEntries();
        if (successText) showToast(successText, 'success');
    } catch (err) {
        showToast('保存分类失败: ' + (err.message || err), 'error');
        await loadKnowledgeView();
    }
}

/** 新建顶层分类 */
export function kbAddRootCategory() {
    var name = prompt('请输入新分类名称：');
    if (name === null) return;
    name = String(name).trim();
    if (!name) return;
    if (kbSiblingNameExists(kbState.categories, name, null)) {
        showToast('同级已存在同名分类：' + name, 'error');
        return;
    }
    kbState.categories.push({ id: kbNewCatId(), name: name, children: [] });
    saveKbCategories('已新建分类：' + name);
}

/** 在指定分类下新建子分类 */
export function kbCreateSubCategory(parentId) {
    var parent = kbFindCat(parentId);
    if (!parent) return;
    var name = prompt('请输入「' + parent.name + '」下的子分类名称：');
    if (name === null) return;
    name = String(name).trim();
    if (!name) return;
    parent.children = parent.children || [];
    if (kbSiblingNameExists(parent.children, name, null)) {
        showToast('该分类下已存在同名子分类：' + name, 'error');
        return;
    }
    parent.children.push({ id: kbNewCatId(), name: name, children: [] });
    kbState.collapsed[parentId] = false;   // 展开父节点，让新节点可见
    saveKbCategories('已新建子分类：' + name);
}

/** 重命名分类 */
export function kbRenameCategory(catId) {
    var cat = kbFindCat(catId);
    if (!cat) return;
    var name = prompt('重命名分类「' + cat.name + '」：', cat.name);
    if (name === null) return;
    name = String(name).trim();
    if (!name || name === cat.name) return;
    // 同级查重（排除自身）
    var siblings = kbState.categories;
    var parentPath = kbFindPath(catId);
    if (parentPath && parentPath.length > 1) siblings = parentPath[parentPath.length - 2].children || [];
    if (kbSiblingNameExists(siblings, name, catId)) {
        showToast('同级已存在同名分类：' + name, 'error');
        return;
    }
    cat.name = name;
    saveKbCategories('已重命名分类：' + name);
}

/** 删除分类及其子树 */
export function kbDeleteCategory(catId) {
    var cat = kbFindCat(catId);
    if (!cat) return;
    var ids = kbCatSubtreeIds(cat);
    var affected = kbState.entries.filter(function (e) { return ids.indexOf(e.category) !== -1; }).length;

    var msg = '确定删除分类「' + kbCatPath(catId) + '」？';
    if (cat.children && cat.children.length) msg += '\n该分类下的子分类会一并删除。';
    if (affected) msg += '\n有 ' + affected + ' 个条目属于该分类，删除后这些条目将显示为「未分类」。';
    if (!confirm(msg)) return;

    kbRemoveCat(kbState.categories, catId);
    // 当前选中的分类被删除时回到「全部条目」
    if (ids.indexOf(kbState.cat) !== -1) kbState.cat = 'all';
    saveKbCategories('已删除分类：' + cat.name);
}

// ============================================================
// 按行 diff（覆盖预览用）
// 不引入任何第三方库：先裁掉公共前缀 / 后缀，只对中间段做 LCS 动态规划；
// 中间段规模超过上限时退化为「整段删除 + 整段新增」，保证大文件也不卡界面。
// ============================================================

/** LCS 中间段规模上限（两段行数的乘积，约 100 万格 ≈ 4MB 内存），超出即退化处理 */
var KB_DIFF_CELL_LIMIT = 1000000;

/** 拆分文本为行数组：末尾换行不计为额外空行，空文本为 0 行（与后端 countLines 同语义） */
function kbSplitLines(text) {
    if (!text) return [];
    var t = String(text);
    if (t.charAt(t.length - 1) === '\n') t = t.slice(0, -1);
    return t.split('\n');
}

/**
 * 计算 oldText → newText 的逐行差异。
 * @returns {Array<{type:'same'|'del'|'add', text:string, oldLine:number, newLine:number}>}
 *          oldLine / newLine 为 1 基行号，该侧没有对应行时为 0
 */
function kbDiffLines(oldText, newText) {
    var a = kbSplitLines(oldText);
    var b = kbSplitLines(newText);

    // 1) 公共前缀：相同行原样作为上下文，不参与 LCS
    var prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    // 2) 公共后缀（不越过前缀）
    var endA = a.length;
    var endB = b.length;
    while (endA > prefix && endB > prefix && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

    var ops = [];
    for (var i = 0; i < prefix; i++) {
        ops.push({ type: 'same', text: a[i], oldLine: i + 1, newLine: i + 1 });
    }
    ops = ops.concat(kbDiffMiddle(a.slice(prefix, endA), b.slice(prefix, endB), prefix));
    // 后缀区：两侧行号各自延续（前缀等长，故偏移按各自所在段计算）
    for (var j = endA; j < a.length; j++) {
        ops.push({ type: 'same', text: a[j], oldLine: j + 1, newLine: endB + (j - endA) + 1 });
    }
    return ops;
}

/**
 * 对中间段做 LCS 动态规划并回溯出操作序列。
 * @param {string[]} a 旧行
 * @param {string[]} b 新行
 * @param {number} offset 该段在原文中的行偏移（= 公共前缀行数）
 */
function kbDiffMiddle(a, b, offset) {
    var n = a.length;
    var m = b.length;
    if (n === 0 && m === 0) return [];
    if (n * m > KB_DIFF_CELL_LIMIT) return kbDiffFallback(a, b, offset);

    // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度；用 Int32Array 逐行存储，内存可控
    var dp = [];
    for (var r = 0; r <= n; r++) dp.push(new Int32Array(m + 1));
    for (var i = n - 1; i >= 0; i--) {
        for (var j = m - 1; j >= 0; j--) {
            dp[i][j] = (a[i] === b[j])
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    // 回溯：相同行取公共行；否则优先删除旧行（相等时取删除，让成对改动呈现为「先删后增」）
    var ops = [];
    var x = 0, y = 0;
    while (x < n && y < m) {
        if (a[x] === b[y]) {
            ops.push({ type: 'same', text: a[x], oldLine: offset + x + 1, newLine: offset + y + 1 });
            x++; y++;
        } else if (dp[x + 1][y] >= dp[x][y + 1]) {
            ops.push({ type: 'del', text: a[x], oldLine: offset + x + 1, newLine: 0 });
            x++;
        } else {
            ops.push({ type: 'add', text: b[y], oldLine: 0, newLine: offset + y + 1 });
            y++;
        }
    }
    while (x < n) { ops.push({ type: 'del', text: a[x], oldLine: offset + x + 1, newLine: 0 }); x++; }
    while (y < m) { ops.push({ type: 'add', text: b[y], oldLine: 0, newLine: offset + y + 1 }); y++; }
    return ops;
}

/** 超规模退化：中间段整体删除再整体新增（结果依然正确，只是不够精细） */
function kbDiffFallback(a, b, offset) {
    var ops = [];
    a.forEach(function (line, k) { ops.push({ type: 'del', text: line, oldLine: offset + k + 1, newLine: 0 }); });
    b.forEach(function (line, k) { ops.push({ type: 'add', text: line, oldLine: 0, newLine: offset + k + 1 }); });
    return ops;
}

// ============================================================
// 转化为 OpenCode 资产（P2）
// 入口：编辑弹窗底部「转化为资产」。弹窗内任一选项变化都会重新调用
// KnowledgeConvertPreview（纯读取）并刷新预览，确认后才调用 KnowledgeConvert 落盘。
// ============================================================

/** 转化弹窗状态 */
var kbConv = {
    open: false,          // 弹窗是否打开
    seq: 0,               // 预览请求序号：单调递增，旧响应回来时直接丢弃（防竞态）
    debounceTimer: null,  // 名称输入的防抖定时器
    preview: null,        // 最近一次成功的预览结果
    previewOk: false,     // 当前预览是否可用（决定「确认写入」是否可点）
    writing: false,       // 写入中，避免重复提交
    projects: null,       // 项目根目录候选（来自 api.GetProjectTree，惰性加载并缓存）
    nameEdited: false     // 用户是否手动改过名称（用于区分「默认 slug」与「用户输入」）
};

/** 类型说明：选类型时就让用户知道产物落在哪、长什么样 */
var KB_CONV_KIND_NOTES = {
    skill: '技能 → 独立目录下的 SKILL.md（名称即目录名）',
    command: '命令 → 单个 .md 文件',
    rule: '规则 → 单个 .md 文件',
    agents: '项目准则 → 追加到 AGENTS.md 末尾（不新建文件）'
};

/** 同步方式说明 */
var KB_CONV_SYNC_NOTES = {
    copy: '复制：写入独立文件，之后各管各的；改知识库后需重新转化',
    symlink: '软链接：目标指向知识库条目文件，改知识库立即生效（Windows 可能因权限失败并自动回退为复制）'
};

/** 读取当前表单选择 */
function kbConvFormValues() {
    var kindEl = document.querySelector('input[name="kbConvKind"]:checked');
    var scopeEl = document.querySelector('input[name="kbConvScope"]:checked');
    var syncEl = document.querySelector('input[name="kbConvSync"]:checked');
    var projEl = $('#kbConvProject');
    var nameEl = $('#kbConvName');
    return {
        kind: kindEl ? kindEl.dataset.kind : 'command',
        scope: scopeEl ? scopeEl.dataset.scope : 'global',
        syncMode: syncEl ? syncEl.dataset.sync : 'copy',
        projectDir: projEl ? String(projEl.value || '').trim() : '',
        name: nameEl ? String(nameEl.value || '').trim() : ''
    };
}

/** 按后端契约拼装请求：全局作用域不带 projectDir，agents 的名称固定 AGENTS */
function kbConvBuildRequest(v) {
    return {
        id: kbState.editingId || '',
        kind: v.kind,
        scope: v.scope,
        projectDir: v.scope === 'project' ? v.projectDir : '',
        name: v.kind === 'agents' ? 'AGENTS' : v.name,
        syncMode: v.syncMode
    };
}

/** 设置单选组选中项（dataKey 为承载取值的 data-* 键名） */
function kbSetRadio(groupName, dataKey, value) {
    document.querySelectorAll('input[name="' + groupName + '"]').forEach(function (el) {
        el.checked = (el.dataset[dataKey] === value);
    });
}

/** 由标题生成目标名 slug（小写 + 连字符）；标题没有可用 ASCII 时回退条目 id */
function kbSlugFromTitle(title, fallback) {
    var s = String(title || '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48)
        .replace(/-+$/g, '');
    return s || fallback;
}

/** 取路径末段作为项目显示名（如 E:\code\git\xxx → xxx） */
function kbDirLabel(path) {
    var parts = String(path || '').replace(/[\\/]+$/, '').split(/[\\/]/);
    return (parts.length && parts[parts.length - 1]) || String(path || '');
}

/**
 * 当前会话所在项目根目录；取不到返回空串。
 * 取法与 chat/session.js 一致：优先侧栏目录文本，其次会话映射表（并要求含路径分隔符，排除把会话 id 当目录的情况）。
 */
function kbCurrentProjectDir() {
    var el = $('#ocSideDirPath');
    var text = el ? String(el.textContent || '').trim() : '';
    if (text && text !== '--' && /[\\/]/.test(text)) return text;
    var sid = store.currentSessionId;
    var info = (sid && window._sessionMap) ? window._sessionMap[sid] : null;
    var dir = info && info.directory ? String(info.directory).trim() : '';
    return /[\\/]/.test(dir) ? dir : '';
}

/** 惰性加载项目根目录候选（api.GetProjectTree 的目录层），失败返回空数组 */
async function kbLoadConvertProjects() {
    if (kbConv.projects) return kbConv.projects;
    var dirs = [];
    try {
        var knownDirs = JSON.parse(localStorage.getItem('oc-known-dirs') || '[]');
        var raw = await api.GetProjectTree(JSON.stringify(knownDirs));
        var tree = raw ? JSON.parse(raw) : [];
        (tree || []).forEach(function (proj) {
            (proj.children || []).forEach(function (dir) {
                var path = String(dir.title || '').trim();
                if (path && dirs.indexOf(path) === -1) dirs.push(path);
            });
        });
    } catch (err) {
        console.warn('[知识库] 加载项目列表失败：', err);
    }
    kbConv.projects = dirs;
    return dirs;
}

/** 填充「目标项目」下拉：默认选中当前项目；无当前项目时停在下拉第一项「请选择项目」（此时确认写入禁用） */
function kbFillConvertProjects() {
    var sel = $('#kbConvProject');
    if (!sel) return;
    var current = kbCurrentProjectDir();
    var dirs = (kbConv.projects || []).slice();
    // 当前项目不在候选里（如项目树尚未刷新）时补一项，保证默认值可用
    if (current && dirs.indexOf(current) === -1) dirs.unshift(current);

    var options = dirs.map(function (d) {
        var label = kbDirLabel(d) + (d === current ? '（当前项目）' : '');
        return '<option value="' + attr(d) + '"' + (d === current ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }).join('');

    if (!current) {
        // 无当前项目：默认空值 + 提示，用户仍可手动选择
        sel.innerHTML = '<option value="">请选择项目</option>' + options;
    } else {
        sel.innerHTML = options;
    }
}

/** 按当前选择同步表单的显隐、扩展名提示与说明文案 */
function kbApplyConvertForm() {
    var v = kbConvFormValues();

    // 类型：准则固定 AGENTS，故隐藏名称行；技能的名称是目录名，提示其入口文件
    var nameRow = $('#kbConvNameRow');
    if (nameRow) nameRow.hidden = (v.kind === 'agents');
    var extHint = $('#kbConvExtHint');
    if (extHint) extHint.textContent = (v.kind === 'skill') ? '/SKILL.md' : '.md';
    var kindNote = $('#kbConvKindNote');
    if (kindNote) kindNote.textContent = KB_CONV_KIND_NOTES[v.kind] || '';
    var nameNote = $('#kbConvNameNote');
    if (nameNote) {
        nameNote.textContent = (v.kind === 'skill')
            ? '名称作为技能目录名，入口文件固定为 SKILL.md'
            : '名称即文件名（不含扩展名）；不能包含 / \\ : * ? " < > |';
    }

    // 作用域：仅「项目」需要目标项目
    var projRow = $('#kbConvProjectRow');
    if (projRow) projRow.hidden = (v.scope !== 'project');
    var scopeNote = $('#kbConvScopeNote');
    if (scopeNote) {
        scopeNote.textContent = (v.scope === 'global')
            ? '全局：写入 ~/.config/opencode/，所有项目都能用'
            : '项目：写入所选项目的 .opencode/（项目准则写入项目根 AGENTS.md）';
    }
    var projNote = $('#kbConvProjectNote');
    if (projNote) {
        var hasCurrent = !!kbCurrentProjectDir();
        projNote.textContent = hasCurrent
            ? '默认写入当前项目，可切换'
            : '请选择项目（当前没有可用的会话目录）';
        projNote.classList.toggle('is-error', !hasCurrent);
    }

    var syncNote = $('#kbConvSyncNote');
    if (syncNote) syncNote.textContent = KB_CONV_SYNC_NOTES[v.syncMode] || '';

    // 预览基于已保存内容：编辑弹窗里未保存的改动不会出现在预览中
    var footNote = $('#kbConvFootNote');
    if (footNote) footNote.textContent = '预览与写入均基于已保存的条目内容';
}

/** 同步「确认写入」可用性 */
function kbConvUpdateConfirm() {
    var btn = $('#kbConvertConfirmBtn');
    if (!btn) return;
    btn.disabled = !(kbConv.open && kbConv.previewOk && !kbConv.writing);
}

/** 预览区显示状态提示（并收起路径条与内容块），同时禁用「确认写入」 */
function kbConvSetState(message, isError) {
    kbConv.previewOk = false;
    var state = $('#kbConvState');
    if (state) {
        state.style.display = '';
        state.textContent = message;
        state.classList.toggle('is-error', !!isError);
    }
    var bar = $('#kbConvPathBar');
    if (bar) bar.style.display = 'none';
    var block = $('#kbConvPreviewBlock');
    if (block) block.style.display = 'none';
    kbConvUpdateConfirm();
}

/** 单行 HTML：lineNo 为 0 时留空；sign 为 '+'/'-'，上下文行留空 */
function kbCodeLineHtml(cls, lineNo, sign, text) {
    return '<div class="kb-code-line' + (cls ? ' ' + cls : '') + '">' +
                '<span class="kb-ln">' + (lineNo ? lineNo : '') + '</span>' +
                '<span class="kb-sign">' + (sign || '') + '</span>' +
                '<span class="kb-txt">' + escapeHtml(text) + '</span>' +
            '</div>';
}

/**
 * 按预览结果渲染预览区。
 * 三种模式的差别只在「路径条文案 + 行渲染方式」：
 *   create    → 全部行按新增（+）渲染
 *   overwrite → oldContent vs newContent 的逐行 diff（红 - / 绿 + / 无色上下文）
 *   append    → 原文件末尾若干上下文行 + 「第 N 行插入 ↓」+ 其后全部为新增行
 */
function kbRenderConvertPreview(pv) {
    var bar = $('#kbConvPathBar');
    var block = $('#kbConvPreviewBlock');
    var state = $('#kbConvState');
    var label = $('#kbConvPreviewLabel');
    var legend = $('#kbConvLegend');
    var code = $('#kbConvCode');
    if (!bar || !block || !code) return;

    var pathCode = '<code>' + escapeHtml(pv.targetPath) + '</code>';
    var html = '';
    var barClass = 'create';
    var legendHtml = '';

    if (pv.mode === 'append') {
        barClass = 'append';
        var oldLines = kbSplitLines(pv.oldContent);
        var allNew = kbSplitLines(pv.newContent);
        var atLine = Math.max(1, pv.appendAtLine || (oldLines.length + 1));
        var added = allNew.slice(atLine - 1);           // 追加块 = 第 N 行起的全部行
        // 末尾最多 5 行上下文，便于确认插入位置
        var ctxStart = Math.max(0, oldLines.length - 5);
        for (var i = ctxStart; i < oldLines.length; i++) {
            html += kbCodeLineHtml('', i + 1, '', oldLines[i]);
        }
        html += '<div class="kb-code-line insert-mark">' +
                    '<span class="kb-ln"></span><span class="kb-sign"></span>' +
                    '<span class="kb-txt">第 ' + atLine + ' 行插入 ↓</span>' +
                '</div>';
        added.forEach(function (line, k) {
            html += kbCodeLineHtml('add', atLine + k, '+', line);
        });
        bar.innerHTML = '将追加到：' + pathCode + '（当前 ' + oldLines.length + ' 行）· 原有内容不动';
        if (label) label.textContent = '追加内容预览';
        legendHtml = '<span><i class="kb-diff-swatch add"></i>新增 ' + added.length + ' 行</span>' +
                     '<span>插入位置：文件末尾</span>';
    } else if (pv.mode === 'overwrite') {
        barClass = 'overwrite';
        var ops = kbDiffLines(pv.oldContent, pv.newContent);
        var delCount = 0, addCount = 0;
        ops.forEach(function (op) {
            if (op.type === 'del') { delCount++; html += kbCodeLineHtml('del', op.oldLine, '-', op.text); }
            else if (op.type === 'add') { addCount++; html += kbCodeLineHtml('add', op.newLine, '+', op.text); }
            else html += kbCodeLineHtml('', op.newLine, '', op.text);
        });
        bar.innerHTML = '将覆盖：' + pathCode + '（已有文件，整文件替换）';
        if (label) label.textContent = '变更预览';
        legendHtml = '<span><i class="kb-diff-swatch del"></i>删除 ' + delCount + ' 行</span>' +
                     '<span><i class="kb-diff-swatch add"></i>新增 ' + addCount + ' 行</span>';
    } else {
        // create：目标不存在，全部内容都是新增
        var newLines = kbSplitLines(pv.newContent);
        newLines.forEach(function (line, k) {
            html += kbCodeLineHtml('add', k + 1, '+', line);
        });
        bar.innerHTML = '将创建：' + pathCode;
        if (label) label.textContent = '写入内容预览';
        legendHtml = '<span>共 ' + newLines.length + ' 行</span>';
    }

    bar.className = 'kb-path-bar ' + barClass;
    bar.style.display = '';
    if (legend) legend.innerHTML = legendHtml;
    code.innerHTML = html || '<div class="kb-code-line"><span class="kb-ln"></span><span class="kb-sign"></span><span class="kb-txt">（内容为空）</span></div>';
    block.style.display = '';
    if (state) state.style.display = 'none';
    kbConv.previewOk = true;
    kbConvUpdateConfirm();
}

/**
 * 刷新预览：任一选项变化都会调用。
 * 用自增序号丢弃过期响应，避免慢请求覆盖新选择的结果。
 */
async function kbRefreshConvertPreview() {
    if (!kbConv.open) return;
    var v = kbConvFormValues();

    // 前置校验：这些情况不必发请求，直接给出可操作的提示
    if (v.scope === 'project' && !v.projectDir) return kbConvSetState('请先选择目标项目', true);
    if (v.kind !== 'agents' && !v.name) return kbConvSetState('请填写目标名称', true);

    var seq = ++kbConv.seq;
    kbConvSetState('正在计算预览…', false);

    try {
        var pv = await api.KnowledgeConvertPreview(kbConvBuildRequest(v));
        if (seq !== kbConv.seq) return;      // 已有更新的请求，丢弃本次结果
        kbConv.preview = pv;
        kbRenderConvertPreview(pv);
    } catch (err) {
        if (seq !== kbConv.seq) return;
        kbConv.preview = null;
        kbConvSetState('预览失败：' + ((err && err.message) || err), true);
    }
}

/** 名称输入防抖刷新（不阻塞输入，也避免每个字符都发请求） */
function kbScheduleConvertPreview() {
    if (kbConv.debounceTimer) clearTimeout(kbConv.debounceTimer);
    kbConv.debounceTimer = setTimeout(function () {
        kbConv.debounceTimer = null;
        kbRefreshConvertPreview();
    }, 250);
}

/** 打开转化弹窗：带入当前编辑条目，重置为默认选项并拉取首次预览 */
export async function openKbConvertModal() {
    var modal = $('#kbConvertModal');
    if (!modal) return;
    if (!kbState.editingId) {
        showToast('请先保存条目，再转化为资产', 'error');
        return;
    }

    var entry = kbState.editingEntry || {};
    kbConv.seq++;                 // 让上一次残留的在途请求失效
    kbConv.open = true;
    kbConv.preview = null;
    kbConv.previewOk = false;
    kbConv.nameEdited = false;

    // 默认：命令 + 项目 + 复制（与界面原型一致）
    kbSetRadio('kbConvKind', 'kind', 'command');
    kbSetRadio('kbConvScope', 'scope', 'project');
    kbSetRadio('kbConvSync', 'sync', 'copy');

    var nameEl = $('#kbConvName');
    if (nameEl) nameEl.value = kbSlugFromTitle(entry.title, kbState.editingId);

    modal.style.display = 'flex';

    await kbLoadConvertProjects();
    kbFillConvertProjects();
    kbApplyConvertForm();
    kbConvUpdateConfirm();
    kbRefreshConvertPreview();
}

/** 关闭转化弹窗：回到编辑弹窗，编辑上下文不丢 */
export function closeKbConvertModal() {
    var modal = $('#kbConvertModal');
    if (modal) modal.style.display = 'none';
    kbConv.open = false;
    kbConv.seq++;                 // 让在途预览响应失效
    kbConv.previewOk = false;
    if (kbConv.debounceTimer) {
        clearTimeout(kbConv.debounceTimer);
        kbConv.debounceTimer = null;
    }
}

/** 确认写入：调用 KnowledgeConvert 落盘，成功后提示写入路径并刷新列表 */
export async function confirmKbConvert() {
    if (!kbConv.open || !kbConv.previewOk || kbConv.writing) return;
    var req = kbConvBuildRequest(kbConvFormValues());
    var btn = $('#kbConvertConfirmBtn');
    var fallbackPath = kbConv.preview ? kbConv.preview.targetPath : '';

    kbConv.writing = true;
    if (btn) { btn.disabled = true; btn.textContent = '写入中…'; }
    try {
        var savedPath = await api.KnowledgeConvert(req);
        showToast('已写入：' + (savedPath || fallbackPath), 'success');
        closeKbConvertModal();
        // 刷新列表与条目详情：转化记录（converted）已由后端回填
        await loadKnowledgeView();
        var edited = kbState.editingId;
        if (edited) {
            try { kbState.editingEntry = await api.KnowledgeGet(edited); } catch (_) { /* 详情刷新失败不影响主流程 */ }
        }
    } catch (err) {
        showToast('转化失败: ' + ((err && err.message) || err), 'error');
    } finally {
        kbConv.writing = false;
        if (btn) btn.textContent = '确认写入';
        kbConvUpdateConfirm();
    }
}

// ============================================================
// 事件绑定
// ============================================================

export function bindKnowledgeEvents() {
    if (kbState.bound) return;
    var view = $('#view-knowledge');
    if (!view) return;
    kbState.bound = true;

    // ---- 搜索：与分类、标签筛选叠加 ----
    var search = $('#kbSearch');
    if (search) {
        search.addEventListener('input', function (e) {
            kbState.keyword = e.target.value.trim();
            renderKbEntries();
        });
    }

    // ---- 视图切换（列表 / 卡片） ----
    var seg = $('#kbViewSeg');
    if (seg) {
        seg.addEventListener('click', function (e) {
            var btn = e.target.closest('.kb-seg-btn');
            if (!btn || !btn.dataset.view) return;
            kbState.view = btn.dataset.view;
            applyKbView();
        });
    }

    // ---- 标签筛选下拉 ----
    var tagBtn = $('#kbTagFilterBtn');
    if (tagBtn) {
        tagBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            toggleKbTagPop();
        });
    }
    var tagPop = $('#kbTagPop');
    if (tagPop) {
        tagPop.addEventListener('click', function (e) {
            e.stopPropagation();
            var item = e.target.closest('[data-kb-tag]');
            if (!item) return;
            kbState.tagFilter = item.dataset.kbTag || '';
            toggleKbTagPop(false);
            updateKbTagFilterBtn();
            renderKbEntries();
        });
    }
    // 点击别处收起标签下拉
    document.addEventListener('click', function (e) {
        if (!e.target.closest('#kbTagPop') && !e.target.closest('#kbTagFilterBtn')) {
            toggleKbTagPop(false);
        }
    });

    // ---- 新建条目 ----
    var newBtn = $('#kbNewEntryBtn');
    if (newBtn) newBtn.addEventListener('click', function () { openKbEntryModal(null); });

    // ---- 新建顶层分类 ----
    var addCatBtn = $('#kbAddCatBtn');
    if (addCatBtn) addCatBtn.addEventListener('click', kbAddRootCategory);

    // ---- 分类树：展开折叠 / 选中 / 右键菜单 ----
    var catTree = $('#kbCatTree');
    if (catTree) {
        catTree.addEventListener('click', function (e) {
            var node = e.target.closest('.kb-cat-node');
            if (!node) return;
            var catId = node.dataset.kbCat;
            // 点父节点的箭头区域只切换折叠
            if (e.target.closest('.kb-cat-caret') && node.dataset.kbToggle === '1') {
                kbState.collapsed[catId] = !kbState.collapsed[catId];
                renderKbCatTree();
                return;
            }
            kbState.cat = catId;
            renderKbCatTree();
            renderKbEntries();
        });

        catTree.addEventListener('contextmenu', function (e) {
            var node = e.target.closest('.kb-cat-node');
            if (!node) return;
            e.preventDefault();
            // 「全部条目」是虚拟汇总节点，不参与分类管理
            if (node.dataset.kbCat === 'all') return;
            showKbCatMenu(e.clientX, e.clientY, node.dataset.kbCat);
        });

        catTree.addEventListener('scroll', hideKbCatMenu);
    }
    window.addEventListener('resize', hideKbCatMenu);

    // ---- 右键菜单项 ----
    var catMenu = $('#kbCatMenu');
    if (catMenu) {
        catMenu.addEventListener('click', function (e) {
            var item = e.target.closest('[data-cat-action]');
            if (!item) return;
            var catId = kbCatMenuCatId;
            var action = item.dataset.catAction;
            hideKbCatMenu();
            if (!catId) return;
            if (action === 'new-sub') kbCreateSubCategory(catId);
            else if (action === 'rename') kbRenameCategory(catId);
            else if (action === 'delete') kbDeleteCategory(catId);
        });
    }
    document.addEventListener('click', function (e) {
        if (!e.target.closest('#kbCatMenu')) hideKbCatMenu();
    });

    // ---- 条目：左键打开编辑弹窗；右上角删除按钮的点击优先拦截 ----
    ['#kbListView', '#kbCardView'].forEach(function (sel) {
        var host = $(sel);
        if (!host) return;
        host.addEventListener('click', function (e) {
            // 删除按钮优先：命中时只执行删除，不再打开编辑弹窗
            var delBtn = e.target.closest('[data-kb-del]');
            if (delBtn) {
                e.stopPropagation();
                deleteKbEntryById(delBtn.dataset.kbDel);
                return;
            }
            var item = e.target.closest('[data-kb-entry]');
            if (!item) return;
            openKbEntryModal(item.dataset.kbEntry);
        });
    });

    // ---- 内容区：编辑 / 预览 切换 ----
    var contentSeg = $('#kbContentSeg');
    if (contentSeg) {
        contentSeg.addEventListener('click', function (e) {
            var btn = e.target.closest('.kb-seg-btn');
            if (!btn || !btn.dataset.kbContentMode) return;
            kbState.contentMode = btn.dataset.kbContentMode;
            applyKbContentMode();
        });
    }

    // ---- 编辑弹窗内标签增删 ----
    var tagEditor = $('#kbTagEditor');
    if (tagEditor) {
        tagEditor.addEventListener('click', function (e) {
            var del = e.target.closest('[data-kb-tag-del]');
            if (del) {
                kbState.modalTags.splice(Number(del.dataset.kbTagDel), 1);
                renderKbTagEditor();
                return;
            }
            var addBtn = e.target.closest('#kbAddTagBtn');
            if (!addBtn) return;
            addBtn.outerHTML = '<input class="kb-tag-add-input" id="kbAddTagInput" placeholder="标签名，回车确认" />';
            var input = $('#kbAddTagInput');
            if (!input) return;
            input.focus();
            var committed = false;
            function commit() {
                if (committed) return;
                committed = true;
                var v = String(input.value || '').trim().replace(/^#/, '');
                if (v && kbState.modalTags.indexOf(v) === -1) kbState.modalTags.push(v);
                renderKbTagEditor();
            }
            input.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter') commit();
                if (ev.key === 'Escape') { committed = true; renderKbTagEditor(); }
            });
            input.addEventListener('blur', commit);
        });
    }

    // ---- 必填区：重新输入即清除该区块的错误态 ----
    KB_REQUIRED_FIELDS.forEach(function (cfg) {
        var el = $(cfg.input);
        if (!el) return;
        el.addEventListener('input', function () {
            var field = $(cfg.field);
            if (field) field.classList.remove('invalid');
            var err = $(cfg.err);
            if (err) err.textContent = '';
        });
    });

    // ---- 编辑弹窗：关闭 / 取消 / 保存 / 点遮罩关闭 ----
    var closeBtn = $('#kbEntryCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeKbEntryModal);
    var cancelBtn = $('#kbEntryCancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', closeKbEntryModal);
    var saveBtn = $('#kbEntrySaveBtn');
    if (saveBtn) saveBtn.addEventListener('click', saveKbEntry);

    var modal = $('#kbEntryModal');
    if (modal) {
        modal.addEventListener('click', function (e) {
            // 点遮罩（面板之外的区域）关闭
            if (e.target === modal) closeKbEntryModal();
        });
    }

    // ---- 转化弹窗（P2）：入口在编辑弹窗底部 ----
    var convertBtn = $('#kbEntryConvertBtn');
    if (convertBtn) convertBtn.addEventListener('click', openKbConvertModal);

    var convModal = $('#kbConvertModal');
    if (convModal) {
        // 点遮罩关闭
        convModal.addEventListener('click', function (e) {
            if (e.target === convModal) closeKbConvertModal();
        });
        // 类型 / 作用域 / 同步方式 / 目标项目：change 后立即刷新预览
        convModal.addEventListener('change', function (e) {
            if (!e.target.closest('.kb-convert-modal')) return;
            kbApplyConvertForm();
            kbRefreshConvertPreview();
        });
        // 名称：输入防抖刷新（手动改过名称后不再被标题 slug 覆盖）
        convModal.addEventListener('input', function (e) {
            if (e.target.id !== 'kbConvName') return;
            kbConv.nameEdited = true;
            kbScheduleConvertPreview();
        });
    }
    var convCloseBtn = $('#kbConvertCloseBtn');
    if (convCloseBtn) convCloseBtn.addEventListener('click', closeKbConvertModal);
    var convCancelBtn = $('#kbConvertCancelBtn');
    if (convCancelBtn) convCancelBtn.addEventListener('click', closeKbConvertModal);
    var convConfirmBtn = $('#kbConvertConfirmBtn');
    if (convConfirmBtn) convConfirmBtn.addEventListener('click', confirmKbConvert);

    // ---- Esc：先关转化弹窗，再关编辑弹窗，最后收分类右键菜单与标签下拉 ----
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        var convEl = $('#kbConvertModal');
        if (convEl && convEl.style.display === 'flex') {
            closeKbConvertModal();
            return;
        }
        var modalEl = $('#kbEntryModal');
        if (modalEl && modalEl.style.display === 'flex') {
            closeKbEntryModal();
            return;
        }
        hideKbCatMenu();
        toggleKbTagPop(false);
    });
}
