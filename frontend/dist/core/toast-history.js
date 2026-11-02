// ============================================================
// 通知历史存储（纯数据层，不操作 DOM）
// 说明：Toast 消失后仍可在左下角「消息历史」里回看。
//      数据存本机 localStorage，最多保留 50 条；
//      每次应用启动由 chat/notifications.js 清空，只保留本次运行的消息。
// ============================================================

export const TOAST_HISTORY_KEY = 'oc-manager-toast-history';
export const TOAST_READ_KEY = 'oc-manager-toast-read-at';
export const TOAST_HISTORY_EVENT = 'oc-toast-history-changed';

const MAX_ITEMS = 50;
const MAX_MESSAGE_LENGTH = 1000;
const DEDUPE_WINDOW_MS = 1200;

function readJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch (_) {
        return fallback;
    }
}

function writeJson(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (_) {
        return false;
    }
}

function notifyChange() {
    try {
        window.dispatchEvent(new CustomEvent(TOAST_HISTORY_EVENT));
    } catch (_) {
        // 事件派发失败不影响数据本身
    }
}

/** 读取历史（按时间升序，旧 → 新）。非法数据直接忽略。 */
export function readToastHistory() {
    const list = readJson(TOAST_HISTORY_KEY, []);
    if (!Array.isArray(list)) return [];
    return list.filter(item => item && typeof item.message === 'string' && Number.isFinite(item.time));
}

/** 读取最近一次「已读」时间戳（毫秒）。 */
export function getToastReadAt() {
    try {
        const value = Number(localStorage.getItem(TOAST_READ_KEY));
        return Number.isFinite(value) && value > 0 ? value : 0;
    } catch (_) {
        return 0;
    }
}

/** 未读通知数量（打开面板后清零）。 */
export function unreadToastCount() {
    const readAt = getToastReadAt();
    return readToastHistory().filter(item => item.time > readAt).length;
}

/** 记录一条 Toast。相同内容在 1.2 秒内重复出现时只记一次，避免刷屏。 */
export function recordToast(message, type = 'info') {
    const text = String(message == null ? '' : message).trim();
    if (!text) return;

    const list = readToastHistory();
    const now = Date.now();
    const last = list[list.length - 1];
    if (last && last.message === text && last.type === type && now - last.time < DEDUPE_WINDOW_MS) {
        return;
    }

    list.push({
        time: now,
        type: type === 'success' || type === 'error' ? type : 'info',
        message: text.slice(0, MAX_MESSAGE_LENGTH),
    });
    while (list.length > MAX_ITEMS) list.shift();
    writeJson(TOAST_HISTORY_KEY, list);
    notifyChange();
}

/** 标记全部已读。 */
export function markToastHistoryRead() {
    try {
        localStorage.setItem(TOAST_READ_KEY, String(Date.now()));
    } catch (_) {
        return;
    }
    notifyChange();
}

/** 清空历史与已读时间。 */
export function clearToastHistory() {
    try {
        localStorage.removeItem(TOAST_HISTORY_KEY);
        localStorage.removeItem(TOAST_READ_KEY);
    } catch (_) {
        return;
    }
    notifyChange();
}
