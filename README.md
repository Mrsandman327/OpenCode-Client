# OC Manager

Wails v2 桌面应用，为 [OpenCode](https://github.com/nicepkg/opencode) 提供可视化管理界面。

## 功能

- **服务管理** — 启动/停止 OpenCode Web Serve，自动检测已运行服务
- **会话管理** — 项目→目录→会话三级树，新建/切换/删除会话
- **消息查看** — Markdown 渲染、工具调用折叠、推理过程展示
- **实时推送** — SSE 事件流，流式输出增量更新
- **右侧面板** — 服务健康状态、代办事项、文件变更 diff
- **模型配置** — 按 agent/category 配置模型
- **技能管理** — 符号链接管理，多平台 toggle
- **常用命令** — CLI/TUI 命令参考

## 构建

```bash
# 安装 Wails CLI
go install github.com/wailsapp/wails/v2/cmd/wails@latest

# 构建
wails build

# 开发模式（热重载）
wails dev
```

构建产物：`build/bin/oc-manager.exe`

## 技术栈

| 层面 | 技术 |
|------|------|
| 桌面框架 | Wails v2.12 |
| 后端 | Go 1.25 |
| 前端 | HTML/CSS/JS（无框架） |
| Markdown | marked.js |
| 浏览器 | WebView2（Windows） |

## 项目结构

```
skill-manager/
├── main.go              # 入口，Wails 配置
├── app.go               # 技能管理、生命周期钩子
├── web.go               # 服务管理、API 代理、会话 CRUD
├── skills.go            # 技能符号链接管理
├── models.go            # 模型列表加载
├── web_test.go          # 单元测试
├── 技术方案.md           # 详细技术文档
├── frontend/
│   └── dist/
│       ├── index.html   # 页面结构
│       └── src/
│           ├── main.js  # 前端主逻辑
│           └── style.css # 主题样式
└── build/
    └── bin/
        └── oc-manager.exe
```

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| Enter | 发送消息 |
| Ctrl+Enter / Shift+Enter | 输入框换行 |
