// ============================================================
// 文件浏览器内嵌终端（PTY）
// - 入口：底部状态栏「终端」项 / 终端抽屉右上角「＋」
// - 工作目录：文件浏览器当前根目录（即项目根），不随左侧选中的子目录变化
// - 关闭标签 = 断开连接 + 删除 PTY（结束进程），不留下前端看不到的孤儿进程
// - 输出采用轮询拉取：桌面模式（Wails 绑定）与浏览器模式（/api/app-call）共用一套逻辑
// ============================================================

import { api } from '../core/apicall.js';
import { store } from '../core/state.js';
import { showToast } from '../core/utils.js';

// 终端状态容器：每次打开文件浏览器都重置（不跨项目复用）
var terminals = [];
var activeId = '';
var terminalSeq = 0;
var xtermLoadPromise = null;
// 轮询间隔：太小会频繁 IPC，太大手感发粘；40ms 接近 25fps，肉眼基本无感
var PUMP_INTERVAL_MS = 40;

/** 读取元素是否已挂载（独立窗口与主窗口共用同一份 DOM id） */
function el(id) {
    return document.getElementById(id);
}

/** 终端抽屉根节点 */
function drawer() {
    return el('fileBrowserTerminal');
}

/** 载入外部脚本（失败抛错，供调用方降级） */
function loadScript(src) {
    return new Promise(function(resolve, reject) {
        var s = document.createElement('script');
        s.src = src;
        s.onload = function() { resolve(); };
        s.onerror = function() { reject(new Error('加载失败: ' + src)); };
        document.head.appendChild(s);
    });
}

/** 载入外部样式（失败静默：xterm 缺样式会明显变形，但功能仍可用） */
function loadStyle(href) {
    if (document.querySelector('link[data-xterm-style]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-xterm-style', '1');
    document.head.appendChild(link);
}

/**
 * 确保 xterm.js 与 FitAddon 可用。
 * 优先使用本地 /lib/（离线可用、启动快）；本地缺失时回退到 CDN。
 * 两者都失败则抛出可读错误，由调用方提示用户补齐依赖。
 */
function ensureXterm() {
    if (window.Terminal && window.FitAddon) return Promise.resolve();
    if (xtermLoadPromise) return xtermLoadPromise;

    xtermLoadPromise = (async function() {
        // 本地资源：frontend/dist/lib/xterm.js（含 CSS 与 addon-fit.js）
        try {
            await loadScript('/lib/xterm.js');
            await loadScript('/lib/xterm-addon-fit.js');
            loadStyle('/lib/xterm.css');
        } catch (localErr) {
            // 本地资源缺失时回退 CDN，保证开发环境/未打包场景也能用
            await loadScript('https://unpkg.com/@xterm/xterm@5.5.0/lib/xterm.js');
            await loadScript('https://unpkg.com/@xterm/addon-fit@0.10.0/lib/addon-fit.js');
            loadStyle('https://unpkg.com/@xterm/xterm@5.5.0/css/xterm.css');
        }
        if (!window.Terminal || !window.FitAddon) {
            throw new Error('xterm.js 加载失败，请检查 frontend/dist/lib 下的终端依赖');
        }
    })();

    // 失败后允许重试（例如用户补上文件再点一次）
    xtermLoadPromise.catch(function() { xtermLoadPromise = null; });
    return xtermLoadPromise;
}

/** 从主题变量推导 xterm 配色，跟随浅色/深色主题 */
function readTermTheme() {
    var cs = getComputedStyle(document.documentElement);
    function v(name, fallback) {
        var value = (cs.getPropertyValue(name) || '').trim();
        return value || fallback;
    }
    var fg = v('--text-primary', '#1d1d1f');
    return {
        background: v('--bg-card', '#ffffff'),
        foreground: fg,
        cursor: fg,
        selectionBackground: 'rgba(64,128,255,0.28)',
        // ANSI 标准色不做主题适配：终端程序依赖固定语义色
        black: '#1d1d1f',
        red: '#c62828',
        green: '#2e7d32',
        yellow: '#a15c00',
        blue: '#1565c0',
        magenta: '#6a1b9a',
        cyan: '#00838f',
        white: '#9e9e9e',
        brightBlack: '#616161',
        brightRed: '#ef5350',
        brightGreen: '#43a047',
        brightYellow: '#f9a825',
        brightBlue: '#1e88e5',
        brightMagenta: '#ab47bc',
        brightCyan: '#00acc1',
        brightWhite: '#ffffff'
    };
}

/** base64 → 二进制。必须按字节交给 xterm，直接转字符串会切断多字节字符 */
function base64ToBytes(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

/** 读取当前文件浏览器根目录（终端固定在此目录） */
function currentRootDir() {
    return (store.fileBrowserState && store.fileBrowserState.rootDir) || '';
}

function findTerminal(id) {
    for (var i = 0; i < terminals.length; i++) {
        if (terminals[i].key === id) return terminals[i];
    }
    return null;
}

function activeTerminal() {
    return findTerminal(activeId);
}

function setStatusText(text, ok) {
    var node = el('fileBrowserTerminalStatus');
    if (!node) return;
    node.textContent = text;
    node.classList.toggle('is-ok', !!ok);
}

/** 同步标签栏、状态栏计数与抽屉显隐 */
function syncChrome() {
    var tabsEl = el('fileBrowserTerminalTabs');
    var countEl = el('fileBrowserTerminalCount');
    var toggleEl = el('btnFileBrowserTerminalToggle');
    var root = drawer();

    if (tabsEl) {
        tabsEl.textContent = '';
        terminals.forEach(function(t) {
            var tab = document.createElement('div');
            tab.className = 'fb-term-tab' + (t.key === activeId ? ' active' : '');
            tab.dataset.key = t.key;

            var dot = document.createElement('span');
            dot.className = 'fb-term-tab-dot' + (t.alive ? ' on' : '');
            tab.appendChild(dot);

            var name = document.createElement('span');
            name.className = 'fb-term-tab-name';
            name.textContent = t.title;
            tab.appendChild(name);

            var close = document.createElement('span');
            close.className = 'fb-term-tab-close';
            close.dataset.close = t.key;
            close.title = '关闭终端（结束进程）';
            close.textContent = '×';
            tab.appendChild(close);

            tab.addEventListener('click', function(e) {
                if (e.target && e.target.dataset && e.target.dataset.close) {
                    e.stopPropagation();
                    closeTerminal(t.key);
                    return;
                }
                activateTerminal(t.key);
            });
            tabsEl.appendChild(tab);
        });
    }

    if (countEl) countEl.textContent = String(terminals.length);
    if (toggleEl) toggleEl.classList.toggle('on', terminals.length > 0 && !!root && !root.classList.contains('collapsed'));
    if (root) {
        root.classList.toggle('open', terminals.length > 0);
        if (terminals.length === 0) root.classList.add('collapsed');
        var collapseBtn = el('btnFileBrowserTerminalCollapse');
        if (collapseBtn) {
            var collapsed = root.classList.contains('collapsed');
            // 图标用 CSS 旋转表示方向，不再替换文字字符
            collapseBtn.classList.toggle('is-collapsed', collapsed);
            collapseBtn.title = collapsed ? '展开终端' : '折叠终端';
            collapseBtn.setAttribute('aria-label', collapseBtn.title);
        }
    }
}

// 可选 shell 列表（按平台由后端提供）；null 表示尚未加载
var shellOptions = null;
var shellOptionsPromise = null;

/** 载入可选 shell 列表；失败时退化为「默认终端」一项，保证下拉仍可用 */
function loadShellOptions() {
    if (shellOptions) return Promise.resolve(shellOptions);
    if (shellOptionsPromise) return shellOptionsPromise;
    shellOptionsPromise = api.PtyShells()
        .then(function(list) {
            shellOptions = (Array.isArray(list) && list.length)
                ? list
                : [{ command: '', label: '默认终端', default: true }];
            return shellOptions;
        })
        .catch(function() {
            // 后端不可用时也要能下拉，否则用户看不到任何选项
            shellOptions = [{ command: '', label: '默认终端', default: true }];
            return shellOptions;
        })
        .finally(function() { shellOptionsPromise = null; });
    return shellOptionsPromise;
}

/** 渲染 shell 菜单项 */
function renderShellMenu(options) {
    var menu = el('fileBrowserTerminalShellMenu');
    if (!menu) return;
    menu.textContent = '';
    options.forEach(function(opt) {
        var item = document.createElement('div');
        item.className = 'fb-term-shell-item';

        var label = document.createElement('span');
        label.textContent = opt.label || opt.command || '终端';
        item.appendChild(label);

        if (opt.default) {
            var tag = document.createElement('span');
            tag.className = 'fb-term-shell-tag';
            tag.textContent = '默认';
            item.appendChild(tag);
        }

        item.addEventListener('click', function(e) {
            e.stopPropagation();
            hideShellMenu();
            var root = drawer();
            if (root) {
                root.classList.add('open');
                root.classList.remove('collapsed');
            }
            createTerminal(opt.command || '');
        });
        menu.appendChild(item);
    });
}

/** 打开展开目录时预先加载 shell 列表，点击小三角时就不必等 */
function preloadShellOptions() {
    loadShellOptions().then(function(options) {
        // 只有一个选项（类 Unix）时，下拉没有意义，隐藏小三角
        var moreBtn = el('btnFileBrowserTerminalAddMore');
        if (moreBtn) moreBtn.style.display = (options.length > 1) ? '' : 'none';
    }).catch(function() {});
}

function showShellMenu() {
    var menu = el('fileBrowserTerminalShellMenu');
    if (!menu) return;
    loadShellOptions().then(function(options) {
        renderShellMenu(options);
        menu.style.display = 'block';
    }).catch(function() {});
}

function hideShellMenu() {
    var menu = el('fileBrowserTerminalShellMenu');
    if (menu) menu.style.display = 'none';
}

/** 切换活动终端（同屏只显示一个 xterm） */
function activateTerminal(key) {
    var target = findTerminal(key);
    if (!target) return;
    activeId = key;
    terminals.forEach(function(t) {
        if (t.hostEl) t.hostEl.classList.toggle('active', t.key === key);
    });
    syncChrome();
    if (target.ptyId) setStatusText(target.alive ? '已连接' : '已断开', target.alive);
    // 切换后必须重新 fit：隐藏期间容器尺寸为 0，xterm 缓存的 cols/rows 会过期
    setTimeout(function() { fitTerminal(target); }, 20);
}

/** 调整终端尺寸并同步给上游 PTY */
function fitTerminal(t) {
    if (!t || !t.fit || !t.term || !t.hostEl || !t.hostEl.classList.contains('active')) return;
    try {
        t.fit.fit();
    } catch (e) {
        return; // 容器不可见（抽屉折叠）时 fit 会抛错，忽略即可
    }
}

function scheduleFitAll() {
    terminals.forEach(function(t) {
        if (t.hostEl && t.hostEl.classList.contains('active')) setTimeout(function() { fitTerminal(t); }, 30);
    });
}

/** 创建一条终端：后端建 PTY → 建 xterm → 启动输出轮询。
 *  shellCommand 为空时由后端按平台选择默认 shell（Windows→CMD，Unix→$SHELL）。 */
async function createTerminal(shellCommand) {
    var rootDir = currentRootDir();
    if (!rootDir) {
        showToast('当前没有可用的项目目录，无法打开终端', 'error');
        return;
    }

    var drawerEl = drawer();
    var bodyEl = el('fileBrowserTerminalBody');
    if (!drawerEl || !bodyEl) return;

    try {
        await ensureXterm();
    } catch (e) {
        showToast(e.message || '终端组件加载失败', 'error');
        return;
    }

    setStatusText('正在创建…', false);
    drawerEl.classList.add('open');
    drawerEl.classList.remove('collapsed');

    var key = 'term-' + (++terminalSeq);
    // 标题先占位，创建成功后用后端返回的 shell 名（PowerShell / bash / zsh…）替换
    var title = '终端';
    var hostEl = document.createElement('div');
    hostEl.className = 'fb-term-host';
    hostEl.dataset.key = key;
    bodyEl.appendChild(hostEl);

    var term = new window.Terminal({
        fontSize: 12.5,
        fontFamily: 'Consolas, "Cascadia Mono", "DejaVu Sans Mono", "Liberation Mono", Menlo, "Courier New", monospace',
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 5000,
        theme: readTermTheme()
    });
    var fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(hostEl);
    // xterm 内部需要一层绝对定位容器撑满宿主，否则收起/展开后高度算不对
    hostEl.classList.add('active');

    var entry = {
        key: key,
        title: title,
        ptyId: '',
        term: term,
        fit: fit,
        hostEl: hostEl,
        alive: false,
        stopped: false
    };
    terminals.push(entry);
    activeId = key;
    syncChrome();
    setTimeout(function() { fitTerminal(entry); }, 60);

    // 键盘输入 → 后端 → 上游 PTY
    term.onData(function(data) {
        if (!entry.ptyId || !entry.alive) return;
        api.PtyInput(entry.ptyId, data).catch(function(err) {
            // 输入失败通常意味着连接已断，标记后由轮询收尾，避免刷屏报错
            entry.alive = false;
            setStatusText('输入失败: ' + (err && err.message ? err.message : err), false);
        });
    });

    // 尺寸变化 → 上游 PTY（需要在容器可见时才有意义）
    // 拖拽调整高度时 fit 会连续触发，这里做 120ms 防抖，避免每移动一像素就发一次请求
    term.onResize(function(size) {
        if (!entry.ptyId || !entry.alive) return;
        clearTimeout(entry.resizeTimer);
        entry.resizeTimer = setTimeout(function() {
            if (!entry.ptyId || !entry.alive) return;
            api.PtyResize(entry.ptyId, size.rows, size.cols).catch(function() {});
        }, 120);
    });

    try {
        // command 传空表示用后端默认 shell；title 也交给后端（CMD / PowerShell / bash…）
        var info = await api.PtyCreate(rootDir, shellCommand || '', '');
        entry.ptyId = info && info.id ? info.id : '';
        if (!entry.ptyId) throw new Error('后端未返回终端 id');
        entry.alive = true;
        // 用后端回显的 title 作为标签名（PowerShell / bash / zsh…）
        if (info.title) entry.title = info.title;
        setStatusText('已连接', true);
        syncChrome();
        setTimeout(function() { fitTerminal(entry); }, 60);
        pumpOutput(entry);
    } catch (e) {
        entry.alive = false;
        setStatusText('创建失败', false);
        term.writeln('\x1b[31m[终端] ' + (e && e.message ? e.message : String(e)) + '\x1b[0m');
        term.writeln('\x1b[90m[终端] 请确认 OpenCode 服务正在运行且版本支持 /api/pty\x1b[0m');
    }
}

/**
 * 输出轮询：把后端缓冲的字节块写入 xterm。
 * 用「拉」而不是「推」，桌面/浏览器两种运行环境共用同一套代码。
 */
async function pumpOutput(entry) {
    while (!entry.stopped && entry.alive) {
        var res;
        try {
            res = await api.PtyRead(entry.ptyId);
        } catch (e) {
            if (entry.stopped) return;
            entry.alive = false;
            setStatusText('读取失败: ' + (e && e.message ? e.message : e), false);
            syncChrome();
            return;
        }
        if (entry.stopped) return;

        if (res && res.chunks && res.chunks.length) {
            for (var i = 0; i < res.chunks.length; i++) {
                entry.term.write(base64ToBytes(res.chunks[i]));
            }
        }
        if (res && res.truncated) {
            entry.term.write('\r\n\x1b[33m[终端] 输出过多，已丢弃早期内容\x1b[0m\r\n');
        }
        if (res && !res.alive) {
            entry.alive = false;
            if (res.error) entry.term.write('\r\n\x1b[90m[终端] ' + res.error + '\x1b[0m');
            setStatusText('已断开', false);
            syncChrome();
            return;
        }
        await sleep(PUMP_INTERVAL_MS);
    }
}

/** 关闭一条终端：断开连接 + 删除 PTY（结束进程） */
async function closeTerminal(key) {
    var t = findTerminal(key);
    if (!t) return;
    t.stopped = true;
    t.alive = false;

    if (t.ptyId) {
        try {
            // 这是「关闭即杀进程」的关键：DELETE 会让上游结束 shell
            await api.PtyDelete(t.ptyId);
        } catch (e) {
            // 上游可能已自行退出，不算致命错误
        }
        t.ptyId = '';
    }

    try { t.term.dispose(); } catch (e) {}
    if (t.hostEl && t.hostEl.parentNode) t.hostEl.parentNode.removeChild(t.hostEl);

    terminals = terminals.filter(function(x) { return x.key !== key; });
    if (activeId === key) {
        activeId = terminals.length ? terminals[terminals.length - 1].key : '';
    }
    if (activeId) {
        activateTerminal(activeId);
    } else {
        setStatusText('未连接', false);
    }
    syncChrome();
}

/** 展开/折叠终端抽屉 */
function toggleDrawer(forceOpen) {
    var root = drawer();
    if (!root) return;
    hideShellMenu();
    if (!terminals.length) {
        // 没有任何终端时，点击入口直接新建一条
        createTerminal();
        return;
    }
    var collapsed = root.classList.contains('collapsed');
    var next = typeof forceOpen === 'boolean' ? !forceOpen : !collapsed;
    root.classList.toggle('collapsed', next);
    root.classList.add('open');
    syncChrome();
    if (!next) {
        setTimeout(function() {
            var t = activeTerminal();
            if (t) fitTerminal(t);
        }, 30);
    }
}

/** 文件浏览器打开时刷新终端入口状态（根目录已显示在标题里，这里只同步角标） */
export function syncTerminalEntry(_rootDir) {
    // 打开文件浏览器时顺便拉一次可选 shell 列表，点小三角时无需等待
    preloadShellOptions();
    syncChrome();
}

/**
 * 关闭文件浏览器时释放全部终端。
 * 抽屉随弹窗一起隐藏，但进程必须在此时结束，否则会留下无法观察的 shell。
 */
export function disposeTerminals() {
    var ids = terminals.map(function(t) { return t.key; });
    ids.forEach(function(key) {
        var t = findTerminal(key);
        if (!t) return;
        t.stopped = true;
        t.alive = false;
        if (t.ptyId) {
            // 这里不等待返回值：关闭流程要同步走完，后端删除是幂等的
            api.PtyDelete(t.ptyId).catch(function() {});
            t.ptyId = '';
        }
        try { t.term.dispose(); } catch (e) {}
        if (t.hostEl && t.hostEl.parentNode) t.hostEl.parentNode.removeChild(t.hostEl);
    });
    terminals = [];
    activeId = '';
    var root = drawer();
    if (root) {
        root.classList.remove('open');
        root.classList.add('collapsed');
    }
    setStatusText('未连接', false);
    hideShellMenu();
    syncChrome();
}

/** 绑定状态栏入口、抽屉按钮与窗口尺寸变化（主窗口与独立窗口共用） */
export function bindTerminalEvents() {
    var toggleBtn = el('btnFileBrowserTerminalToggle');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', function() { toggleDrawer(); });
    }
    var collapseBtn = el('btnFileBrowserTerminalCollapse');
    if (collapseBtn) {
        collapseBtn.addEventListener('click', function() { toggleDrawer(); });
    }
    var addBtn = el('btnFileBrowserTerminalAdd');
    if (addBtn) {
        addBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            hideShellMenu();
            var root = drawer();
            if (root) {
                root.classList.add('open');
                root.classList.remove('collapsed');
            }
            // 直接新建默认 shell（Windows 为 CMD）
            createTerminal('');
        });
    }
    // 小三角：选择 CMD / PowerShell
    var moreBtn = el('btnFileBrowserTerminalAddMore');
    if (moreBtn) {
        moreBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            var menu = el('fileBrowserTerminalShellMenu');
            if (menu && menu.style.display === 'block') {
                hideShellMenu();
            } else {
                showShellMenu();
            }
        });
    }
    // 点击其它地方关闭下拉。
    // 必须用捕获阶段：文件浏览器弹窗自身有 onclick="event.stopPropagation()"（阻止点内部关弹窗），
    // 冒泡到 document 的 click 会被拦掉，导致只有再点一次小三角才能关闭菜单。
    document.addEventListener('click', function(e) {
        var group = e.target && e.target.closest ? e.target.closest('.fb-term-add-group') : null;
        if (!group) hideShellMenu();
    }, true);
    // 菜单打开时按 ESC 关闭（其余情况把 ESC 留给终端里的程序）
    document.addEventListener('keydown', function(e) {
        if (e.key !== 'Escape') return;
        var menu = el('fileBrowserTerminalShellMenu');
        if (menu && menu.style.display === 'block') {
            e.preventDefault();
            e.stopPropagation();
            hideShellMenu();
        }
    }, true);
    // 窗口/弹窗尺寸变化时重新计算行列，否则终端会停留在旧尺寸
    window.addEventListener('resize', scheduleFitAll);
    // 主题切换时同步终端配色（xterm 不会读取 CSS 变量，必须显式重设）
    if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(function(mutations) {
            mutations.forEach(function(m) {
                if (m.attributeName !== 'data-theme') return;
                var theme = readTermTheme();
                terminals.forEach(function(t) {
                    try { t.term.options.theme = theme; } catch (e) {}
                });
            });
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    // 弹窗内左右分栏拖拽会改变预览区宽度，用 ResizeObserver 兜住这种场景
    var panel = document.querySelector('.file-browser-preview-panel');
    if (panel && typeof ResizeObserver !== 'undefined') {
        var ro = new ResizeObserver(function() { scheduleFitAll(); });
        ro.observe(panel);
    }
    // 页面被直接关闭/刷新时尽力回收终端（后端还有空闲回收兜底）
    window.addEventListener('beforeunload', function() { disposeTerminals(); });
    // 抽屉上边框可上下拖动调整高度
    initTerminalResize();
    syncChrome();
}

/**
 * 终端高度拖拽：抓住抽屉上边缘上下拖动。
 * 高度写入 CSS 变量 --fb-term-height，抽屉展开时按该变量取值，
 * 折叠再展开能保持用户调好的高度。
 */
function initTerminalResize() {
    var grip = el('fileBrowserTerminalGrip');
    var root = drawer();
    if (!grip || !root) return;

    var dragging = false;
    var startY = 0;
    var startHeight = 0;

    // 上限：预览区高度减去 120px，保证文件预览始终留有空间
    function maxHeight() {
        var panel = document.querySelector('.file-browser-preview-panel');
        var panelHeight = panel ? panel.clientHeight : 600;
        return Math.max(180, panelHeight - 120);
    }

    function onMove(e) {
        if (!dragging) return;
        // 向上拖 = 变高，因此用 startY - clientY
        var next = startHeight + (startY - e.clientY);
        next = Math.min(maxHeight(), Math.max(140, next));
        root.style.setProperty('--fb-term-height', next + 'px');
        // 拖动过程中持续重算行列；PtyResize 由 onResize 的防抖控制
        var t = activeTerminal();
        if (t) fitTerminal(t);
    }

    function onUp() {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('fb-term-resizing');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        // 松手后再 fit 一次，确保最终行列与高度一致
        var t = activeTerminal();
        if (t) setTimeout(function() { fitTerminal(t); }, 0);
    }

    grip.addEventListener('mousedown', function(e) {
        // 折叠状态下不响应拖动（此时只有 32px 标题条）
        if (root.classList.contains('collapsed')) return;
        e.preventDefault();
        dragging = true;
        startY = e.clientY;
        startHeight = root.getBoundingClientRect().height;
        document.body.classList.add('fb-term-resizing');
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });
}
