// ============================================================
// OpenCode 管理中心 - 命令面板（输入 / 触发快捷命令选择）
// ============================================================

let cmdPaletteItems = [];
let cmdPaletteLoaded = false;
let cmdPaletteIndex = -1;
let cmdPaletteVisible = false;

const cmdPaletteEl = document.getElementById('ocCmdPalette');
const cmdPaletteScroll = cmdPaletteEl.querySelector('.oc-cmd-palette-scroll');
const cmdInputEl = document.getElementById('ocPrompt');

// ============================
// 数据加载
// ============================

async function loadCmdPalette() {
    if (cmdPaletteLoaded) return;
    try {
        cmdPaletteItems = await api.GetOpenCodeCommands() || [];
    } catch (_) {
        cmdPaletteItems = [];
    }
    cmdPaletteLoaded = true;
}

function filterCmdItems(query) {
    if (!query) return cmdPaletteItems;
    const q = query.toLowerCase();
    return cmdPaletteItems.filter(item =>
        item.name.toLowerCase().includes(q) ||
        (item.description || '').toLowerCase().includes(q)
    );
}

// ============================
// 显示/隐藏
// ============================

async function showCmdPalette() {
    await loadCmdPalette();
    if (!cmdPaletteItems.length) return;

    cmdPaletteVisible = true;
    cmdPaletteIndex = 0;
    const query = cmdInputEl.value.slice(1);
    renderCmdPalette(query);
    cmdPaletteEl.style.display = 'block';
}

function hideCmdPalette() {
    cmdPaletteVisible = false;
    cmdPaletteIndex = -1;
    cmdPaletteEl.style.display = 'none';
}

// ============================
// 渲染
// ============================

function renderCmdPalette(query) {
    const filtered = filterCmdItems(query);
    if (cmdPaletteIndex >= filtered.length) cmdPaletteIndex = Math.max(0, filtered.length - 1);

    if (!filtered.length) {
        cmdPaletteScroll.innerHTML = '<div class="oc-cmd-empty">无匹配命令</div>';
        return;
    }

    let html = '';
    filtered.forEach((item, i) => {
        const active = i === cmdPaletteIndex ? ' active' : '';
        html += `<div class="oc-cmd-item${active}" data-cmd="${escapeHtml(item.name)}" data-idx="${i}">
            <span class="oc-cmd-name">/${escapeHtml(item.name)}</span>
            <span class="oc-cmd-desc">${escapeHtml(item.description || '')}</span>
            <span class="oc-cmd-source">${escapeHtml(item.source || '')}</span>
        </div>`;
    });

    cmdPaletteScroll.innerHTML = html;

    // 点击选中（mousedown 避免 blur 导致焦点丢失）
    cmdPaletteScroll.querySelectorAll('.oc-cmd-item').forEach(el => {
        el.addEventListener('mousedown', (e) => {
            e.preventDefault();
            insertCmdToPrompt(el.dataset.cmd);
        });
    });

    // 滚动到高亮项
    const active = cmdPaletteScroll.querySelector('.oc-cmd-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
}

// ============================
// 键盘交互（捕获阶段，优先于 main.js 的 Enter 发送逻辑）
// ============================

cmdInputEl.addEventListener('keydown', (e) => {
    if (!cmdPaletteVisible) return;

    switch (e.key) {
        case 'Escape':
            e.preventDefault();
            hideCmdPalette();
            break;
        case 'ArrowDown':
            e.preventDefault();
            navigateCmdPalette('down');
            break;
        case 'ArrowUp':
            e.preventDefault();
            navigateCmdPalette('up');
            break;
        case 'Enter':
            e.preventDefault();
            selectCmdPalette();
            break;
        case 'Tab':
            e.preventDefault();
            selectCmdPalette();
            break;
    }
}, true); // capture = true，先于 main.js 的绑定

// ============================
// 输入过滤
// ============================

cmdInputEl.addEventListener('input', () => {
    const value = cmdInputEl.value;
    if (value.startsWith('/') && !value.slice(1).includes(' ')) {
        if (!cmdPaletteVisible) {
            showCmdPalette();
        } else {
            renderCmdPalette(value.slice(1));
        }
    } else {
        hideCmdPalette();
    }
});

// 点击面板外关闭（click 优于 blur，不会在点击面板时先失去焦点）
document.addEventListener('click', (e) => {
    if (!cmdPaletteVisible) return;
    if (!cmdPaletteEl.contains(e.target) && e.target !== cmdInputEl) {
        hideCmdPalette();
    }
});

// ============================
// 导航与选中
// ============================

function navigateCmdPalette(direction) {
    const filtered = filterCmdItems(cmdInputEl.value.slice(1));
    if (!filtered.length) return;

    if (direction === 'up') {
        cmdPaletteIndex = (cmdPaletteIndex - 1 + filtered.length) % filtered.length;
    } else {
        cmdPaletteIndex = (cmdPaletteIndex + 1) % filtered.length;
    }
    renderCmdPalette(cmdInputEl.value.slice(1));
}

function selectCmdPalette() {
    const active = cmdPaletteScroll.querySelector('.oc-cmd-item.active');
    if (active) {
        insertCmdToPrompt(active.dataset.cmd);
    }
}

function insertCmdToPrompt(cmdName) {
    cmdInputEl.value = '/' + cmdName + ' ';
    cmdInputEl.focus();
    hideCmdPalette();
}
