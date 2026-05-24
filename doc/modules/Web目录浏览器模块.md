# Web 目录浏览器模块

> 返回 [技术方案](../技术方案.md)

---

## 一、模块定位

该模块服务于 Web 端工作区项目树中的“添加目录”按钮。用户在浏览器中无法使用桌面系统目录选择器，因此改为站内目录浏览器：从盘符根目录开始，逐级进入目录，最终选定工作目录，再复用 `GetProjectTree(knownDirs)` 读取会话记录。

---

## 二、核心职责

### 后端
位于 `service/filebrowser/dir.go`：

- `ListBrowsableDirs("")` 返回系统根目录列表（Windows 盘符，Unix `/`）
- `ListBrowsableDirs(path)` 返回指定目录下的一级子目录
- 只返回目录，不返回文件
- 过滤隐藏/系统目录（`.` 开头、`$` 开头、Windows FILE_ATTRIBUTE_HIDDEN/SYSTEM）

### 前端
目录选择弹窗位于 `filebrowser/dir.js`，项目树 `＋` 按钮处理位于 `chat/tree.js`：

- `openDirBrowserModal()`
- `loadDirBrowserList(path)`
- `goDirBrowserUp()`
- `selectDirBrowserCurrent()`

并在 `index.html` 中提供 `dirBrowserModal`、路径显示、返回上一级、选择当前目录等 DOM。

---

## 三、交互流程

1. 用户点击项目树目录旁的 `＋`
2. Web 端打开站内目录浏览器弹窗
3. 首次请求返回盘符根目录（如 `C:\`、`D:\`、`E:\`）
4. 用户逐级进入目录
5. 点击“选择当前目录”
6. 前端把目录写入 `oc-known-dirs`
7. 再调用 `GetProjectTree(JSON.stringify(knownDirs))`

---

## 四、边界

- 只读
- 只列目录
- 不支持文件浏览/下载/上传
- 每次只返回一级子目录
- 不扩展成通用文件管理器
