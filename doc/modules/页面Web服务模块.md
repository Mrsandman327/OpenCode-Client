# 页面 Web 服务模块

> 返回 [技术方案](../技术方案.md)

---

## 一、模块定位

页面 Web 服务模块负责把桌面应用的前端页面、App 门面方法和 SSE 事件流暴露为可浏览器访问的 HTTP 服务。该模块位于 `service/web/server.go`，由 `app.go` 通过薄桥接暴露给前端按钮和 Wails 绑定。

---

## 二、核心职责

1. 启动/停止页面 Web 服务
2. 提供前端静态资源（`frontend/dist`，通过 `//go:embed all:frontend/dist` 嵌入）
3. 暴露 `/api/app-call` 统一 RPC 入口（所有业务调用）
4. 提供 `/events` SSE 事件流（浏览器端 OpenCode 事件推送）
5. 维护页面 Web 服务状态（运行中 / 离线、URL、端口）

---

## 三、关键文件

| 文件 | 职责 |
|------|------|
| `service/web/server.go` | 页面 Web 服务宿主、路由（仅 /api/app-call + /events）、SSE 输出 |
| `app.go` | `StartFrontendWeb` / `StopFrontendWeb` / `GetFrontendWebStatus` / `AppCall` 桥接 |
| `app_dispatcher.go` | AppCall switch 统一分发所有业务方法 |
| `test/frontend/frontend_web_test.go` | 页面 Web HTTP 路由与状态测试 |

---

## 四、服务模型

```go
type FrontendWebBridge interface {
    GetProjectTree(string) string
    OpenCodeAPI(string, string, string) model.APIResult
    StartOpenCodeEvents() model.APIResult
    StopOpenCodeEvents() model.APIResult
    StartOpenCodeWeb(int, string, model.ProxyConfig) model.WebResult
    GetWebStatus(string, int) model.WebResult
    StopOpenCodeWeb() model.WebResult
    AppCall(string, []json.RawMessage) (interface{}, error)
}
```

注：`CreateSession`、`GetAvailableModels` 已统一为前端通过 `OpenCodeCall` → `OpenCodeAPI` 直接调用 OpenCode serve 端点，不再需要独立桥接方法。

桥接接口保证页面 Web 服务位于 `service/`，而实际业务仍由 `App` 门面统一分发。

---

## 五、HTTP 路由

Web 端路由已统一精简，所有业务调用通过 `/api/app-call` 单一入口：

| 路由 | 说明 |
|------|------|
| `/` | 前端静态页面（`http.FileServer`） |
| `/api/app-call` | 统一 RPC 入口（POST，`{method, args}` → AppCall switch） |
| `/events` | SSE 事件推送（浏览器 EventSource） |

独立路由（`/api/project-tree`、`/api/open-code`、`/api/session/create`、`/api/models` 等）已全部移除，功能均通过 AppCall 分发实现。

---

## 六、测试策略

`test/frontend/frontend_web_test.go` 放在 `test/` 目录下，通过 stub bridge 直接验证：

- 首页静态资源可访问
- 页面 Web 服务启停与状态
- `app-call` 路由返回合法 JSON
- 目录树、技能浏览、技能保存等 Web 协议层行为

---

## 七、与其他模块的关系

- 目录浏览器见 [Web 目录浏览器模块](Web目录浏览器模块.md)
- 技能文件浏览/编辑见 [技能文件浏览编辑模块](技能文件浏览编辑模块.md)
- 工作区与移动端布局见 [工作区模块](工作区模块.md) 与 [手机端工作区模块](手机端工作区模块.md)
