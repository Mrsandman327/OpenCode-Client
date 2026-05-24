# Go 后端模块

> 返回 [项目架构深度分析](../项目架构深度分析.md)

---

## 一、模块定位

Go 后端是应用的业务逻辑核心和前后端桥梁，通过 Wails v2 将 Go 方法绑定到前端 JavaScript。

---

## 二、核心文件：app.go + app_dispatcher.go

`App` 结构体是 Wails 绑定的唯一入口，所有前端调用的 Go 方法都定义在此。`app.go`（~700行）包含所有 Wails 绑定方法，`app_dispatcher.go`（~400行）包含 AppCall switch 统一分发。

### 2.1 结构体

```go
type App struct {
    ctx context.Context
}
```

### 2.2 方法分组（app_dispatcher.go AppCall switch）

| 分组 | 方法示例 | 委托 |
|------|---------|------|
| 技能管理 | `GetSkillConfig`, `ToggleSkill`, `ReadSkillContent`, `SaveSkillContent`, `GetSkills`, `GetAggregatedSkills`, `GetSourceDir`, `GetStats`, `AddSkillSourceDir`, `RemoveSkillSourceDir` | `config/skill/` |
| 模型配置 | `GetModelConfig`, `GetAgentDescriptions`, `UpdateModels`, `AddModelEntry`, `DeleteModelType`, `GetFullConfig`, `SaveFullConfig` | `config/omo/` |
| 供应商配置 | `GetProviders`, `SaveProvider`, `DeleteProvider`, `GetModelList`, `GetProviderConfigPath` | `config/provider/` |
| 方案管理 | `ListSchemes`, `ReadScheme`, `SaveScheme`, `DeleteScheme`, `ExportConfig`, `ListSkillSchemes`, `ApplySkillScheme`, `SaveSkillScheme` | `config/omo/` + `config/skill/` |
| Web 服务 | `StartOpenCodeWeb`, `StopOpenCodeWeb`, `GetWebStatus`, `StartFrontendWeb`, `StopFrontendWeb`, `GetFrontendWebStatus` | `service/opencode/` + `service/web/` |
| API 代理 | `OpenCodeAPI`, `GetProjectTree`, `AnswerQuestion`, `RejectQuestion`, `StartOpenCodeEvents`, `StopOpenCodeEvents` | `service/opencode/` |
| 文件浏览 | `ListBrowsableDirs`, `ListBrowserFiles`, `ReadBrowserFile`, `UploadBrowserFile`, `DeleteBrowserEntry` | `service/filebrowser/` |
| Git 操作 | `GetGitStatus`, `StageFile`, `GitCommit`, `GitPush`, `GitPull`, `GetGitHistory` | `service/filebrowser/` |
| 通用 | `OpenDir`, `Refresh`, `GetCommands`, `LaunchWindowsTerminal`, `OpenDirectoryDialog` | — |

其中与工作区最相关的链路：

- `GetProjectTree()` → `service/opencode/api.go` 构建项目 → 目录 → 会话树
- `StartOpenCodeEvents()` / `StopOpenCodeEvents()` → `service/opencode/sse.go` 转发 OpenCode 全局 SSE
- `OpenCodeAPI()` → `service/opencode/api.go` 泛用透传（自动提取 directory 设置 x-opencode-directory 头）

### 2.3 类型别名

```go
type (
    SkillInfo    = model.SkillInfo
    ModelEntry   = model.ModelEntry
    ProviderInfo = model.ProviderInfo
    WebResult    = model.WebResult
    APIResult    = model.APIResult
    SchemeInfo   = model.SchemeInfo
    // ...
)
```

### 2.4 统一解码

```go
func decodeArgs(args []json.RawMessage, targets ...interface{}) error {
    if len(args) < len(targets) {
        return fmt.Errorf("参数数量不足: need %d got %d", len(targets), len(args))
    }
    for i, target := range targets {
        if err := json.Unmarshal(args[i], target); err != nil {
            return fmt.Errorf("参数 %d 解析失败: %w", i, err)
        }
    }
    return nil
}
```

---

## 三、数据契约：model/types.go

前后端共享数据结构（约 40 个类型）：

| 结构体 | 用途 |
|--------|------|
| `ModelEntry` | 前端展示的模型条目（key, type, model, comment） |
| `ModelConfig` | JSONC 中的 model 配置块 |
| `SchemeInfo` | 方案文件元信息（name, fileName, fullPath） |
| `ProviderInfo` / `ProviderSave` | 供应商信息与保存载荷 |
| `SkillInfo` / `Stats` / `SkillConfigResult` | 技能信息和配置结果 |
| `WebResult` / `APIResult` | Web 服务状态和 API 响应 |
| `TreeNode` / `DirectoryEntry` | 项目树节点和目录条目 |
| `CmdPaletteItem` | 命令面板条目 |
| `GitStatusResult` / `GitActionResult` | Git 操作结果 |
| `FileBrowserListResult` / `FilePreviewResult` | 文件浏览结果 |

---

## 四、内部工具包：internal/

| 包 | 职责 |
|------|------|
| `internal/symlink/` | 跨平台符号链接/联接创建与删除（Windows mklink /J 回退） |
| `internal/pathutil/` | 路径规范化、相等比较、子路径判定 |
| `internal/executil/` | exec.Command 统一封装（HideWindow）+ RunGit |
| `internal/fileutil/` | AtomicWrite（原子写入）+ JSONC 校验清洗 |

---

## 五、配置包：config/

| 包 | 职责 |
|------|------|
| `config/provider/` | opencode.jsonc 供应商配置的完整序列化读写 |
| `config/omo/model.go` | oh-my-openagent.jsonc 的行级 model 值替换 |
| `config/omo/agent_desc.go` | 智能体描述表的加载与应用 |
| `config/omo/scheme.go` | OMO 方案管理 + ExportConfig |
| `config/skill/manager.go` | 技能 Manager 结构体 + parseFrontmatter |
| `config/skill/scanner.go` | 多来源目录技能扫描与聚合 |
| `config/skill/linker.go` | 符号链接管理（ToggleSkill/LinkSkill） |
| `config/skill/fileops.go` | 技能文件读写 |
| `config/skill/scheme.go` | 技能方案存储与应用 |
| `config/skill/source.go` | skill-config.json 源目录配置 |
| `config/commands/` | GetCommands() 静态命令参考数据 |

---

## 六、服务层：service/

| 包 | 职责 |
|------|------|
| `service/opencode/process.go` | OpenCode serve 进程管理（启动/停止/健康检查） |
| `service/opencode/api.go` | 泛用 HTTP API 透传 + 项目树构建 + question 应答 |
| `service/opencode/sse.go` | SSE 事件流透传到前端（Wails Events + 浏览器 SSE） |
| `service/opencode/models.go` | AI 模型列表缓存 |
| `service/filebrowser/browser.go` | 文件浏览 CRUD（列表/读取/上传/删除） |
| `service/filebrowser/dir.go` | 目录选择器（根目录枚举/子目录枚举/隐藏过滤） |
| `service/filebrowser/preview.go` | 文件预览类型判定（按扩展名分类） |
| `service/filebrowser/git.go` | Git 操作（状态/暂存/提交/推送/拉取/历史） |
| `service/web/server.go` | 前端 HTTP 服务器（仅 `/api/app-call` + `/events`） |

---

## 七、模块间依赖

```
main.go
  └── app.go ── 创建 App → 协调所有子模块
       ├── config/skill (技能扫描/链接/文件操作)
       ├── config/omo (模型配置/智能体描述/方案管理)
       ├── config/provider (供应商配置)
       ├── config/commands (命令参考)
       ├── service/opencode (进程管理/API代理/SSE)
       ├── service/filebrowser (文件浏览/Git操作)
       ├── service/web (前端HTTP服务)
       ├── internal/symlink (符号链接)
       ├── internal/pathutil (路径工具)
       ├── internal/executil (命令执行)
       └── internal/fileutil (文件工具)
```

`app.go` 是纯门面（Facade），所有实质操作委托给子包。`app_dispatcher.go` 通过 switch 将所有方法统一暴露给 Web 端 `/api/app-call` RPC。
