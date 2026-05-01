# OpenCode 管理中心 — 改造方案

## 整体布局

侧边栏导航（4 个模块），右侧内容区切换：

```
┌────────────┬──────────────────────────────────┐
│ 📂 OpenCode │  当前模块内容                      │
│ ⚙️ 模型配置  │                                  │
│ 🔗 技能管理  │                                  │
│ 📋 常用命令  │                                  │
└────────────┴──────────────────────────────────┘
```

---

## 模块 1：OpenCode

| 功能 | 实现 |
|------|------|
| **工作目录选择** | 路径输入框 + 浏览按钮 |
| **参数选项** | 下拉：模型选择、Agent 选择、`--continue`、`--session` |
| **一键启动** | 按钮直接执行 `opencode [dir] [flags]`，弹出终端窗口 |
| **嵌入命令行** | 页面底部嵌入 xterm.js 终端组件，连接到本地 shell，可直接输入 `opencode run "..."` 等命令 |

终端嵌入方案：
- WebSocket 连接到 Go 后端 PTY 伪终端
- 前端 xterm.js 渲染，完整颜色/快捷键支持
- 可在终端内直接交互式使用 OpenCode TUI

---

## 模块 2：模型配置（现有，不变）

右侧抽屉：agent/category 模型下拉选择 + 注释显示 + 保存

---

## 模块 3：技能管理（现有，不变）

源目录 → 符号链接到 OpenCode / Claude / Codex，toggle 开关

---

## 模块 4：常用命令

两组卡片：

### CLI 命令（16 个）

| 分组 | 命令 | 说明 |
|------|------|------|
| 会话 | `run`、`session`、`stats`、`export`、`import` | 运行/管理/导出会话 |
| 代理 | `agent`、`github` | 代理管理 |
| 服务 | `serve`、`web`、`acp`、`attach` | 启动/连接服务 |
| 配置 | `auth`、`mcp`、`models` | 认证/模型/协议 |
| 维护 | `upgrade`、`uninstall` | 升级/卸载 |

每个命令卡片显示：命令语法、子命令、常用选项，点击复制到剪贴板或填充到嵌入式终端

#### CLI 命令详情

| 命令 | 子命令 | 主要选项 | 用途 |
|------|--------|----------|------|
| `agent` | `create`、`list` | — | 管理代理 |
| `attach` | — | `--dir`、`--session` | 连接远程后端 |
| `auth` | `login`、`list`、`logout` | — | 管理 API 密钥 |
| `github` | `install`、`run` | `--event`、`--token` | GitHub 自动化 |
| `mcp` | `add`、`list`、`auth`、`logout`、`debug` | — | MCP 服务器管理 |
| `models` | — | `--refresh`、`--verbose` | 列出可用模型 |
| `run` | — | `-m`、`-c`、`-s`、`-f`、`--agent` | 非交互式运行 |
| `serve` | — | `--port`、`--hostname` | 启动 API 服务器 |
| `session` | `list` | `-n`、`--format` | 管理会话 |
| `stats` | — | `--days`、`--models` | Token 统计 |
| `export` | — | — | 导出会话 |
| `import` | — | — | 导入会话 |
| `web` | — | `--port`、`--hostname` | 启动 Web 界面 |
| `acp` | — | `--port`、`--hostname` | ACP 服务器 |
| `uninstall` | — | `-c`、`-d`、`--force` | 卸载 |
| `upgrade` | — | `-m` | 更新版本 |

---

### TUI 命令（17 个）

| 分组 | 命令 | 快捷键 | 说明 |
|------|------|--------|------|
| 会话 | `new`、`compact`、`undo`、`redo`、`exit` | ctrl+x n/c/u/r/q | 会话管理 |
| 信息 | `help`、`models`、`themes`、`thinking`、`details` | ctrl+x h/m/t/d | 帮助/模型/主题 |
| 操作 | `init`、`connect`、`editor`、`export`、`share`、`unshare`、`sessions` | ctrl+x i/e/x/s/l | 初始化/编辑/分享 |

#### TUI 命令详情

| 命令 | 别名 | 快捷键 | 说明 |
|------|------|--------|------|
| `/connect` | — | — | 添加提供商 |
| `/compact` | `/summarize` | `ctrl+x c` | 压缩会话上下文 |
| `/details` | — | `ctrl+x d` | 切换执行详情 |
| `/editor` | — | `ctrl+x e` | 外部编辑器编写消息 |
| `/exit` | `/quit` `/q` | `ctrl+x q` | 退出 |
| `/export` | — | `ctrl+x x` | 导出对话为 Markdown |
| `/help` | — | `ctrl+x h` | 显示帮助 |
| `/init` | — | `ctrl+x i` | 创建 AGENTS.md |
| `/models` | — | `ctrl+x m` | 列出模型 |
| `/new` | `/clear` | `ctrl+x n` | 新会话 |
| `/redo` | — | `ctrl+x r` | 重做撤销 |
| `/sessions` | `/resume` `/continue` | `ctrl+x l` | 列出/切换会话 |
| `/share` | — | `ctrl+x s` | 分享会话 |
| `/themes` | — | `ctrl+x t` | 主题列表 |
| `/thinking` | — | — | 切换思考可见性 |
| `/undo` | — | `ctrl+x u` | 撤销最后消息 |
| `/unshare` | — | — | 取消分享 |

---

## 技术实现

| 组件 | 方案 |
|------|------|
| 侧边栏导航 | CSS flex + JS 切换，替代当前 Tab |
| 嵌入式终端 | Go `github.com/creack/pty` + WebSocket + xterm.js |
| 命令卡片 | 静态数据（从文档提取），点击复制/填充 |
| OpenCode 启动 | `exec.Command("opencode", args...)` 带参数 |

---

## 待确认

1. **嵌入式终端**是否必须？还是只需"一键启动打开外部终端窗口"即可？
   - 嵌入式终端依赖 pty + websocket，复杂度较高
2. **命令卡片**是否需要可执行（点击后在终端执行），还是纯参考卡片？
3. 侧边栏导航和现有的技能管理 UI 是否需要保留刷新/主题等顶部操作？
