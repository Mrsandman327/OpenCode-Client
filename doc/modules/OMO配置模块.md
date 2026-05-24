# OMO 配置模块（view-omo）

> 返回 [项目架构深度分析](../项目架构深度分析.md)

---

## 一、概述

管理 `oh-my-openagent.jsonc` 的模型配置。按 agent / category 维度分组编辑模型映射，支持本地方案的导入/导出/入库/切换。

**后端**：`config/omo/model.go`（行级保存）、`config/omo/agent_desc.go`（描述表）、`config/omo/scheme.go`（方案管理）

**前端**：`views/omo-config.js`

---

## 二、配置文件

- **路径**：`~/.config/opencode/oh-my-openagent.jsonc`
- **结构**：agent / category → key → `{ "model": "..." }`

```jsonc
{
    "agents": {
        "sisyphus": { "model": "deepseek/deepseek-v4-pro" },
        "oracle": { "model": "deepseek/deepseek-v4-pro" }
    },
    "categories": {
        "quick": { "model": "opencode/big-pickle" },
        "visual-engineering": { "model": "opencode/big-pickle" }
    }
}
```

---

## 三、页面布局

三层固定结构：**顶部固定 → 中间滚动 → 底部固定**。

```
┌──────────────────────────────────────────────────────┐
│ 顶部固定区（omo-topbar + 批量操作栏）— flex-shrink: 0    │
│                                                      │
│  ┌ 信息栏 ────────────────────────────────────┐     │
│  │ 配置文件：/path/to/oh-my-openagent.jsonc    │     │
│  │                             🔄 刷新列表    │     │
│  │ 方案目录：.sisyphus/omo-schemes/            │     │
│  │                             📂 打开        │     │
│  ├ 方案操作栏 ────────────────────────────────┤     │
│  │ 方案：[下拉]  导入  导出  入库              │     │
│  ├ 状态栏 ────────────────────────────────────┤     │
│  │ 当前编辑内容已修改，尚未保存并应用           │     │
│  └────────────────────────────────────────────┘     │
│  ┌ 批量操作栏 ───────────────────────────────┐     │
│  │ ☑ 全选  [批量模型下拉]  [应用]            │     │
│  └───────────────────────────────────────────┘     │
├──────────────────────────────────────────────────────┤
│ 中间滚动区（#modelConfig）— flex: 1; overflow-y: auto │
│                                                      │
│  ┌ Agents ────────────────────────────────────┐    │
│  │ ▼ 主编排器       deepseek/deepseek-v4-pro  │    │
│  │ ▼ sisyphus       deepseek/deepseek-v4-pro  │    │
│  │ ▼ oracle         deepseek/deepseek-v4-pro  │    │
│  │ ▼ librarian      opencode/minimax-m2.5-free│    │
│  │ ...                                        │    │
│  └──────────────────────────────────────────┘     │
│  ┌ Categories ───────────────────────────────┐    │
│  │ ▼ quick            opencode/big-pickle     │    │
│  │ ▼ visual-engineering opencode/big-pickle  │    │
│  │ ...                                        │    │
│  └──────────────────────────────────────────┘     │
│                                                      │
├──────────────────────────────────────────────────────┤
│ 底部固定区（modelActions）— flex-shrink: 0              │
│  ➕ 添加类型     💾 保存     1 项未保存 (改1 删0)        │
└──────────────────────────────────────────────────────┘
```

### 三段固定实现

```css
#view-omo.active {
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;       /* 视图级裁剪 */
}

.omo-topbar               { flex-shrink: 0 }     /* 顶部固定 */
.omo-batch-bar-wrap       { flex-shrink: 0 }     /* 批量栏固定 */
#view-omo #modelConfig    { flex: 1; height: 0; min-height: 0; overflow-y: auto }  /* 中间滚动 */
.omo-bottom-bar            { flex-shrink: 0 }     /* 底部固定 */
```

`.model-group` 的 `overflow: hidden` 已移除，避免 BFC 阻断子内容高度传导导致 `scrollHeight` 被截断。

---

## 四、数据模型

### 4.1 核心变量

| 变量 | 类型 | 说明 |
|------|------|------|
| `workingConfigJson` | object | 当前编辑区完整配置对象，入库/导出数据来源 |
| `fullConfigJson` | object | 从磁盘读取的原始配置快照 |
| `modelEntries` | array | UI 投影，扁平化模型条目 `[{id, key, type, model, comment}]` |
| `modelTypes` | array | 分组名称列表，如 `["agents", "categories"]` |
| `originalEntries` | array | 修改基线，始终指向系统配置，切换方案**不重置** |
| `originalState` | string | 同上，`JSON.stringify(buildModelConfig())`，用于变更检测 |
| `availableModels` | array | 可用模型名称列表（从后端缓存获取） |
| `hasUnsavedChanges` | boolean | 是否有未保存修改 |

### 4.2 ModelEntry 结构

```go
// model/types.go
type ModelEntry struct {
    Key     string `json:"key"`      // 条目 key，如 "sisyphus"
    Type    string `json:"type"`     // 所属分组，如 "agents"
    Model   string `json:"model"`    // 模型标识，如 "deepseek/deepseek-v4-pro"
    Comment string `json:"comment"`  // 描述文本，来自 agents-comments.json
}
```

### 4.3 SchemeInfo 结构

```go
type SchemeInfo struct {
    Name     string `json:"name"`
    FileName string `json:"fileName"`
    FullPath string `json:"fullPath"`
}
```

---

## 五、数据流

```
系统配置文件 (oh-my-openagent.jsonc)
  ↓ api.GetFullConfig()
  → JSON.parse(stripJsonComments(text))
  → fullConfigJson
  → JSON.parse(JSON.stringify(x)) → workingConfigJson
  → for (entries of workingConfigJson)
      → modelEntries.push({ ... comment: descMap[key] || '' })
      → modelTypes.push(type)

描述文件 (agents-comments.json)
  ↓ api.GetAgentDescriptions()
  → 描述表 descMap = { key: "描述", ... }
  → 匹配 key → 填入 modelEntries[i].comment
```

### 编辑流程

```
用户改变模型下拉框
  → entry.model = e.target.value
  → 同步：workingConfigJson[entry.type][entry.key].model = entry.model
  → updateSaveStatus(): modelEntries vs originalEntries
  → checkUnsavedChanges(): buildModelConfig() vs originalState
```

### 保存流程

```
用户点击 💾 保存
  → 计算差异：modelEntries vs originalEntries
  → 无差异 → toast "没有需要保存的更改"
  → 有差异 → handleSchemeApply()
           ├ → buildMergedConfigForSave()
           ├ → api.SaveFullConfig(JSON.stringify(...))
           ├ → fullConfigJson / workingConfigJson / originalEntries 更新
           └ → updateSaveStatus() / updateSchemeStatus() / renderModelConfig()
```

当前方案切换/导入后的“保存并应用”策略已做收敛：

- 页面保存前会先以“当前保存底稿”作为基底：
  - 初始进入页面时，底稿来自当前系统配置 `fullConfigJson`
  - 切换方案后，底稿更新为该方案的完整原始内容
  - 导入外部方案后，底稿更新为导入内容的完整原始对象
- 页面未显示的顶层字段（如 `$schema`、`sisyphus_agent` 以及其他隐藏字段）完整保留
- 页面可编辑的模型分组（如 `agents`、`categories` 及其他模型 section）使用当前界面条目重建后覆盖
- 最终通过完整 JSON 字符串写回，避免大范围方案切换时由行级 patch 生成非法 JSONC
- 页面底部“保存”按钮与方案“保存并应用”入口已统一收口到 `handleSchemeApply()`，不再直接走 `UpdateModels(modelEntries)` 旧链路
- 保存过程仍保留交互反馈：保存中提示、按钮禁用、按钮文案切换，保存成功后恢复

### 切换方案流程

```
用户选择方案下拉项
  → api.ReadScheme(name) → 磁盘读取方案文件
  → JSON.parse → 填充到 workingConfigJson
  → rebuildModelEntriesFromFull(workingConfigJson)
     → modelEntries = 方案条目
     → originalEntries 保持不变（系统配置基线）
  → await applyDescriptions() → 补充描述
  → renderModelConfig() → 渲染 UI
  → checkUnsavedChanges() → buildModelConfig(方案) vs originalState(系统配置)
     → 差异 → hasUnsavedChanges = true
```

---

## 六、功能详解

### 6.1 模型编辑

#### 分组渲染

```javascript
function createModelGroup(title, entries, entryType) {
    // 创建 .model-group 容器
    //   标题行：▼ 分组名 + [+] 添加条目 + [✕] 删除类型
    //   内容区：model-row × entries 数量
    //     每行：☑ checkbox | key | [模型下拉] | 描述
}
```

#### 折叠/展开

```css
.model-group-title.collapsed::before { transform: rotate(-90deg) }
  → header.addEventListener('click', toggle collapse)
  → body.classList.toggle('collapsed')
```

#### 批量设置

```
☑ 全选 → 选中/取消所有 checkbox
[批量模型下拉] → 选择模型 → [应用]
  → 遍历所有勾选的 checkbox
  → 按 data-id 匹配 modelEntries
  → 更新 model + workingConfigJson
  → 重新渲染
```

#### 增删

- 添加类型：`btnAddModelType` → Modal 输入类型名 → `api.AddModelType(type)`
- 添加条目：分组标题旁 `+` → Modal 输入 key + 模型 + 描述
- 删除类型：分组标题旁 `✕` → 确认 → `api.DeleteModelType(type)`
- 删除条目：每行 `✕` → 标记删除 → 保存时生效

### 6.2 方案管理

| 操作 | 入口 | 交互流程 |
|------|------|---------|
| 切换 | 方案下拉框 | 选择方案名 → `api.ReadScheme(name)` → 加载到编辑区 |
| 导入 | `导入` 按钮 | 选择文件 → FileReader 读取 → `JSON.parse` → 加载到编辑区 |
| 导出 | `导出` 按钮 | `prompt` 输入文件名 → `api.OpenDirectoryDialog()` 选目录 → `api.ExportConfig(dir, name, content)` 写入 |
| 入库 | `入库` 按钮 | `prompt` 输入方案名 → 非法字符校验 → `api.SaveScheme(name, content)` 写入 `.sisyphus/omo-schemes/` |
| 打开 | `📂 打开` | `api.OpenSchemeDir()` → 资源管理器打开方案目录 |

**关键设计**：切换方案和导入**不修改基线**（originalEntries / originalState），只更新编辑区数据。方案和系统配置的差异通过 `checkUnsavedChanges()` 自动检测。

### 6.3 描述管理

```
描述文件路径：exeDir/configs/oh-my-openagent/agents-comments.json

{
  "oracle": "只读高级顾问：架构决策、疑难调试、代码审查，必须使用最强推理模型",
  "sisyphus": "主编排器：拆解、委派、调度复杂任务；直接影响全局工作质量，使用最强模型",
  "quick": "小修、错别字、单文件简单改动：优先低延迟和低成本"
}
```

- 页面加载时：`api.GetAgentDescriptions()` 加载 → 匹配 key → 填充 comment
- 保存时：`handleSchemeApply()` 通过完整合并后的 JSON 直接写回系统配置，描述表不会丢失；模型描述仍在页面加载时和导入/切换后通过 `api.GetAgentDescriptions()` + `applyDescriptions()` 补充
- 切换/导入方案后：`applyDescriptions()` 异步加载补充描述

### 6.4 方案目录

```
项目根目录/.sisyphus/omo-schemes/
├── 方案A.jsonc
├── 方案B.jsonc
└── ...
```

- `config/omo/scheme.go` 管理该目录
- `ListSchemes()` 扫描返回 `SchemeInfo[]`
- `SaveScheme(name, content)` 写入文件
- `ReadScheme(name)` 读取文件
- `OpenSchemeDir()` 在资源管理器中打开

---

## 七、后端实现

### 7.1 行级保存（config/omo/model.go）

```go
func SaveConfig(entries []model.ModelEntry) error {
    // 1. 读取原始文件 → lines[]
    // 2. 对每个 entry：
    //    a. 在对应 section 内查找 entry.Key
    //    b. 正则：("model"\s*:\s*)"[^"]*" → 替换 model 值
    //    c. 不存在则插入新行块
    // 3. 删除原始文件中有但 entries 中没有的条目
    // 4. writeConfigFile: 临时文件 → rename 原子替换
}
```

### 7.2 描述文件读写（config/omo/agent_desc.go）

```go
func LoadAgentDescriptions() (map[string]string, error) {
    // 1. os.Executable() → 获取 exe 目录
    // 2. filepath.Join(exeDir, "configs/oh-my-openagent/agents-comments.json")
    // 3. os.ReadFile → json.Unmarshal
}

func ApplyDescriptions(entries []struct{Key, Comment string}) error {
    // 1. 加载现有描述文件
    // 2. 合并 entries 中的非空 comment
    // 3. json.MarshalIndent → os.WriteFile
}
```

### 7.3 方案文件管理（config/omo/scheme.go）

```go
const schemeDirRel = ".sisyphus\\omo-schemes"

func ListSchemes() []model.SchemeInfo        // 扫描 .jsonc 文件
func ReadScheme(name string) (string, error)  // os.ReadFile
func SaveScheme(name, content string) error   // os.WriteFile
func ExportConfig(dir, filename, content string) (string, error) // 写入目录 + Base 防穿越
func OpenSchemeDir() error                    // exec.Command("explorer", dir)
```

---

## 八、前端事件绑定

```javascript
// main.js DOMContentLoaded 中

// 模型操作
btnRefreshModels  → 强制刷新模型列表缓存
btnAddModelType   → Modal 添加类型

// 方案管理
schemeSelect.change  → handleSchemeSwitch(name)
btnSchemeImport      → handleSchemeImport()
btnSchemeExport      → handleSchemeExport()
btnSchemeSave        → handleSchemeSave()

// 保存
btnSaveModels (事件委托) → api.UpdateModels(modelEntries)
  → 成功后重置 originalEntries / originalState / hasUnsavedChanges
```
