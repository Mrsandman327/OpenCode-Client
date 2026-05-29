// ============================
// 目录浏览器 — 弹窗式目录选择
// ============================

/** 打开目录浏览器弹窗，返回 Promise<dir> */
async function openDirBrowserModal() {
	dirBrowserCurrentPath = '';
	document.getElementById('dirBrowserModal').style.display = 'flex';
	await loadDirBrowserList('');
	return new Promise((resolve, reject) => {
		dirBrowserResolver = resolve;
		dirBrowserRejecter = reject;
	});
}

/** 关闭目录浏览器弹窗 */
function closeDirBrowserModal() {
	if (dirBrowserRejecter) {
		dirBrowserRejecter(new Error('已取消目录选择'));
		dirBrowserRejecter = null;
		dirBrowserResolver = null;
	}
	document.getElementById('dirBrowserModal').style.display = 'none';
}

/** 加载目录浏览器列表 */
async function loadDirBrowserList(path) {
	dirBrowserCurrentPath = path || '';
	document.getElementById('dirBrowserPath').textContent = dirBrowserCurrentPath || '根目录';
	const list = document.getElementById('dirBrowserList');
	list.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在读取目录...</p></div>';
	try {
		const dirs = await api.ListBrowsableDirs(path || '');
		if (!dirs || !dirs.length) {
			list.innerHTML = '<div class="oc-empty">当前层没有可进入的目录</div>';
			return;
		}
		list.innerHTML = dirs.map(dir => '<button type="button" class="btn btn-sm skill-file-dir-toggle" data-path="' + escapeHtml(dir.path) + '" style="width:100%;height:3.4vh;">📁 ' + escapeHtml(dir.name) + '</button>').join('');
		list.querySelectorAll('[data-path]').forEach(btn => {
			btn.addEventListener('click', async () => {
				await loadDirBrowserList(btn.dataset.path || '');
			});
		});
	} catch (e) {
		list.innerHTML = '<div class="oc-empty">读取目录失败</div>';
		showToast('读取目录失败: ' + (e.message || e), 'error');
	}
}

/** 选中目录浏览器当前路径 */
async function selectDirBrowserCurrent() {
	if (!dirBrowserCurrentPath) {
		showToast('请先进入目标目录', 'warning');
		return;
	}
	const selected = dirBrowserCurrentPath;
	if (dirBrowserResolver) {
		dirBrowserResolver(selected);
		dirBrowserResolver = null;
		dirBrowserRejecter = null;
	}
	document.getElementById('dirBrowserModal').style.display = 'none';
}

/** 目录浏览器返回上一级 */
async function goDirBrowserUp() {
	if (!dirBrowserCurrentPath) return;
	const current = String(dirBrowserCurrentPath).replace(/[\\/]+$/);
	let parent = current.replace(/[\\/][^\\/]+$/, '');
	if (!parent || parent === current) {
		await loadDirBrowserList('');
		return;
	}
	// Windows 盘符（如 E:）不是根目录，需补 \ 才能正确指向盘符根
	if (/^[A-Za-z]:$/.test(parent)) {
		parent += '\\';
	}
	await loadDirBrowserList(parent);
}