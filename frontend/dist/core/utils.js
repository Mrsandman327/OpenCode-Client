// ============================================================
// OpenCode 管理中心 - 工具函数
// ============================================================

// DOM 快捷引用
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Toast 通知
let toastTimer = null;

function showToast(message, type = 'info') {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove('show');
    }, 2800);
}

// HTML 转义
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================================
// 多会话 Tab 消息容器访问
// 每个 tab 对应一个 .oc-messages-tab 子容器，挂在 #ocMessagesPool 下
// ============================================================

/** 取指定会话的消息容器（tab 容器），不存在返回 null */
function getTabMessagesEl(sessionID) {
    if (!sessionID) return null;
    var pool = document.getElementById('ocMessagesPool');
    if (!pool) return null;
    return pool.querySelector('.oc-messages-tab[data-tab="' + CSS.escape(sessionID) + '"]');
}

/** 取当前活动 tab 的消息容器；无活动 tab 时回退到池本身 */
function getActiveMessagesEl() {
    var pool = document.getElementById('ocMessagesPool');
    if (!pool) return document.getElementById('ocMessages');
    var active = pool.querySelector('.oc-messages-tab.active');
    return active || pool;
}

/** 安全设置消息区空态提示。
 *  避免 getActiveMessagesEl() 在无活动 tab 时回退返回 pool 本身，
 *  导致 innerHTML= 清空整个池（连带销毁所有隐藏的 tab 容器）。
 *  规则：
 *   - 池中有活动 tab 容器 → 只写入该容器
 *   - 无活动但有隐藏 tab 容器（新建会话占位态）→ 更新/创建占位提示，保留 tab 容器
 *   - 无任何 tab 容器 → 直接写 pool */
function setMessagesEmpty(text) {
    var pool = document.getElementById('ocMessagesPool');
    if (!pool) return;
    var active = pool.querySelector('.oc-messages-tab.active');
    if (active) {
        active.innerHTML = '<div class="oc-empty">' + text + '</div>';
        return;
    }
    var hasTabs = pool.querySelector('.oc-messages-tab');
    if (hasTabs) {
        var ph = pool.querySelector('.oc-new-session-placeholder');
        if (!ph) {
            ph = document.createElement('div');
            ph.className = 'oc-new-session-placeholder oc-empty';
            pool.appendChild(ph);
        }
        ph.style.display = 'block';
        ph.textContent = text;
        return;
    }
    pool.innerHTML = '<div class="oc-empty">' + text + '</div>';
}

/** 创建指定会话的消息容器（若不存在），返回容器元素 */
function ensureTabMessagesEl(sessionID) {
    var pool = document.getElementById('ocMessagesPool');
    if (!pool) return null;
    var el = getTabMessagesEl(sessionID);
    if (el) return el;
    // 清掉 pool 里的非 tab 残留（初始空态提示、旧提示），避免与 tab 容器共存
    Array.prototype.slice.call(pool.children).forEach(function(child) {
        if (!child.classList || !child.classList.contains('oc-messages-tab')) {
            pool.removeChild(child);
        }
    });
    el = document.createElement('div');
    el.className = 'oc-messages oc-messages-tab';
    el.dataset.tab = sessionID;
    el.style.display = 'none';
    pool.appendChild(el);
    return el;
}
