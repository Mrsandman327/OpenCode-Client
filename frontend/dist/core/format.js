// ============================================================
// core/format.js — 时间/数字格式化公共函数
// ============================================================
// 各视图历史上各有一套同名但输出格式不同的格式化函数，这里统一收敛，
// 并保持每个调用场景的输出与原来完全一致（用不同函数名区分格式）：
//   - formatToolDuration    工具调用用时（紧凑：850ms / 3.2s / 1m 23s）
//   - formatSubtaskDuration 子任务时长（中文口语：3秒 / 1分20秒 / 2小时5分）
//   - formatCompactNumber   数字缩写（1000 → 1.00k，1000000 → 1.00M）
//   - formatDateTime        时间戳 → 'YYYY-MM-DD HH:MM:SS'
//   - formatMinuteTime      时间戳 → 'YYYY-MM-DD HH:MM'
//   - formatRelativeTime    'YYYY-MM-DD HH:MM' 字符串 → 相对时间（如 '3 分钟前'）

/** 毫秒 → 友好用时文本（工具调用头部紧凑格式：850ms / 3.2s / 1m 23s） */
export function formatToolDuration(ms) {
    if (!ms || ms < 0 || !isFinite(ms)) return '';
    ms = Math.round(ms);
    if (ms < 1000) return ms + 'ms';
    const s = ms / 1000;
    if (s < 60) return (s >= 10 ? Math.round(s) : Math.round(s * 10) / 10) + 's';
    const m = Math.floor(s / 60);
    const rs = Math.round(s % 60);
    return m + 'm ' + rs + 's';
}

/** 毫秒 → 中文时长（子任务面板：3秒 / 1分20秒 / 2小时5分） */
export function formatSubtaskDuration(ms) {
    if (ms == null) return '—';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return seconds + '秒';
    const minutes = Math.floor(seconds / 60);
    const remainSec = seconds % 60;
    if (minutes < 60) return minutes + '分' + (remainSec > 0 ? remainSec + '秒' : '');
    const hours = Math.floor(minutes / 60);
    const remainMin = minutes % 60;
    return hours + '小时' + (remainMin > 0 ? remainMin + '分' : '');
}

/** 数字缩写：<1000 原样显示；≥1000 显示 xx.xxk；≥1000000 显示 xx.xxM */
export function formatCompactNumber(num) {
    if (isNaN(num) || num === null || num === undefined) return '0';
    if (num < 1000) {
        return num.toFixed(0);
    } else if (num < 1000000) {
        return (num / 1000).toFixed(2) + 'k';
    } else {
        return (num / 1000000).toFixed(2) + 'M';
    }
}

/** 格式化时间戳为「年月日时分秒」，非法值返回空串 */
export function formatDateTime(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/** 格式化时间戳为「年月日时分」，非法值返回 '—'（子任务详情弹窗用） */
export function formatMinuteTime(ts) {
    if (ts == null) return '—';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** "YYYY-MM-DD HH:MM" 字符串 → 相对时间（如 "3分钟前"/"昨天"），无法解析时返回空串 */
export function formatRelativeTime(t) {
    if (!t) return '';
    const m = String(t).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!m) return '';
    const then = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    const diff = Date.now() - then.getTime();
    if (diff < 0) return '';
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' 小时前';
    const day = Math.floor(hr / 24);
    if (day === 1) return '昨天';
    if (day < 7) return day + ' 天前';
    return t.slice(0, 10);
}
