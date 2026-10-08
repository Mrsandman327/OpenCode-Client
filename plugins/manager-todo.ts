// manager-todo.ts — OC Manager 配套的待办工具插件（OpenCode v2 服务器端插件）
//
// 背景：
//   OpenCode v2 移除了内置的 todowrite 工具（官方迁移代码将其列为 REMOVED_TOOLS），
//   本插件为管理器补回该能力：注册一个名为 `todo_write` 的工具，让模型可以
//   创建/更新当前会话的待办列表。
//
// ⚠ 零依赖约定（请勿添加任何 import）：
//   全局插件目录里的"裸单文件"插件没有可用的 node_modules；一旦书写
//   `import { Plugin } from "@opencode/plugin"`，服务加载时会报
//   Cannot find package '@opencode/plugin'，插件加载失败（管理器显示「失败」）。
//   v2 的加载器接受「默认导出 { id, setup } 的普通对象」这一形态：
//   Plugin.define 仅是恒等函数 + 类型辅助（见 packages/plugin/src/promise/plugin.ts），
//   加载器按默认导出的 { id, setup } 校验（见 packages/core/src/plugin/module.ts）。
//   因此本文件不导入任何模块；ctx 的结构参见 packages/plugin/src/promise/plugin.ts
//   的 Context 接口（tool / storage / event / session 等领域）。
//
// 与管理器的约定（改动前务必确认 frontend/dist/chat/sidepanel.js）：
//   1. 工具名必须为 `todo_write`（命名空间 todo + 名称 write），与
//      sidepanel.js 中 TODO_TOOL_NAMES 的取值匹配；
//   2. 输入参数保持 { todos: [{ content, status, priority? }] } 形状：
//      管理器从会话消息中提取 state.input.todos 渲染；
//      渲染使用 content（文本）、status（进行中/已完成分组）、priority（样式类）。
//   3. 工具直接暴露（codemode: false），保证会话事件流中记录的工具名干净。
//
// 部署位置（OpenCode v2 自动发现，二选一）：
//   - 全局：$XDG_CONFIG_HOME/opencode/plugins/manager-todo.ts
//     · 默认模式 → ~/.config/opencode/plugins/
//     · 便携模式 → <程序目录>/agentdatas/config/opencode/plugins/
//   - 项目级：<项目>/.opencode/plugins/manager-todo.ts
// 插件文件会被服务监听：覆盖保存后通常自动热重载；若未生效再重启服务。
export default {
  id: "oc-manager.todo",
  /**
   * 插件初始化：注册 `todo_write` 工具。
   * ctx 为插件上下文（Promise 版），此处只使用 ctx.tool 域。
   */
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      // 命名空间：用于工具分组与命名，最终工具名为 `todo_write`
      editor.namespace({ name: "todo", description: "会话待办事项" })

      editor.add({
        name: "write",
        // 工具描述决定模型何时调用：多步任务开始时建立列表、推进过程中更新状态。
        // 描述写得越具体，模型使用越稳定（对齐官方 v1 todowrite 的引导方式）。
        description:
          "创建或更新当前会话的待办列表。多步骤任务开始时调用一次建立列表；" +
          "每开始或完成其中一步时，更新对应条目的 status。每次都要传入完整列表（全量覆盖，不要只传变化项）。",
        input: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              description: "完整的待办列表（全量覆盖上一版）",
              items: {
                type: "object",
                properties: {
                  content: { type: "string", description: "待办内容" },
                  status: {
                    type: "string",
                    description: "状态：pending=待处理；in_progress=进行中；completed=已完成；cancelled=已取消",
                    enum: ["pending", "in_progress", "completed", "cancelled"],
                  },
                  priority: {
                    type: "string",
                    description: "优先级（可选）",
                    enum: ["high", "medium", "low"],
                  },
                },
                required: ["content", "status"],
              },
            },
          },
          required: ["todos"],
          additionalProperties: false,
        },
        // codemode: false —— 工具直接暴露给模型（不进入代码模式），
        // 会话事件流中记录的工具名为 `todo_write`，便于管理器提取。
        options: { namespace: "todo", codemode: false },
        execute: async (input) => {
          const todos = (input as { todos?: Array<{ content?: string; status?: string }> }).todos ?? []
          const pending = todos.filter((t) => t.status === "pending" || t.status === "in_progress").length
          return {
            content: `待办已更新：共 ${todos.length} 项，未完成 ${pending} 项`,
          }
        },
      })
    })
  },
}
