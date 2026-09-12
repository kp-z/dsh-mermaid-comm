# dsh-mermaid-comm

让 AI 在开发交流中**默认、优先用 Mermaid 图**表达。渲染由 [`dsh-mermaid`](https://github.com/MrmoLabs/dsh-mermaid) 负责，本插件专注于提示词、校验和输出安全闸。

[![npm](https://img.shields.io/npm/v/dsh-mermaid-comm)](https://www.npmjs.com/package/dsh-mermaid-comm)

## 功能

| 能力 | 作用 |
|---|---|
| **A. 行为引导** | 注入 `systemPrompt.section`：架构、数据流、时序、状态、依赖等开发话题优先用 Mermaid，先图后简短解释。 |
| **B. 语法校验** | 注册 `mermaid_validate` 工具，先做危险字符扫描，再调用 dsh-mermaid 同版本 `mermaid-runtime` 真解析。 |
| **C. 输出闸** | 监听 assistant 消息落盘事件；对 Mermaid 围栏自动修复 Unicode 箭头/危险标签，无法确认通过时从可见 surface 摘除坏图。 |
| **D. 图库（Mermaid Vault）** | 把验证通过的图持久化到 `<workspace>/.dsh/mermaid/`，形成同主题多版本资产：`<name>.mmd`（当前版）+ `<name>.history.md`（演进历史）+ `INDEX.md`。索引注入系统提示，后续对话基于旧图演进而非从零重画。 |

## 图库（Mermaid Vault）——图的持久化与演进

0.2.0 新增。值得长期保留的图——架构、数据模型、核心流程——会保存到图库，形成**同主题版本化系列**：

```
<workspace>/.dsh/mermaid/
├── INDEX.md                 # 图库索引（主题/类型/版本/更新时间）
├── payment-flow.mmd         # 当前活跃版（始终可渲染）
└── payment-flow.history.md  # v1/v2/... 各版本变更说明
```

4 个模型可见工具：

- `mermaid_vault_list` — 列出图库索引（可选按类型过滤）
- `mermaid_vault_read` — 读某主题：当前源码 + 演进历史
- `mermaid_vault_save` — 保存/更新一张图（强制真解析校验，语法错拒绝保存，图库里永远是能渲染的图）
- `mermaid_vault_delete` — 删除某主题（主文件 + 历史 + 索引项）

图库索引会注入系统提示（只注入轻量表格，图内容按需用 `mermaid_vault_read` 读取）。当某主题已在库中时，模型被引导先读历史再 `save` 演进（生成 v2/v3/...），而不是从零重画——这样后续对话能看到图的持续变化，并与之前的工作保持一致。

安全边界：主题名 sanitize 为 `[a-zA-Z0-9-_]`（杜绝路径穿越）、写入锁定在 vault 目录内、原子写、大小与版本上限防止无限膨胀。

## 安装

```sh
dsh plugin --profile web add dsh-mermaid-comm
# 同时安装 dsh-mermaid（负责聊天渲染）
dsh plugin --profile web add dsh-mermaid
```

重启 `dsh web`。如果 dsh-mermaid 未安装或运行时不可用，`mermaid_validate` 会明确返回失败，不会把未校验的图误报为通过；输出闸也不会把坏图静默放行。

## 使用

涉及以下内容时，模型会默认优先输出 Mermaid：

- 架构 / 模块关系 → `flowchart` 或 `classDiagram`
- 调用链 / 请求时序 → `sequenceDiagram`
- 状态 / 生命周期 → `stateDiagram-v2`
- 数据模型 / 表关系 → `erDiagram`
- 分支策略 / Git 历史 → `gitGraph`
- 计划 / 排期 → `gantt`

## 校验规则

`mermaid_validate` 返回：

- `ok`：当前代码是否通过；
- `built`：规则修复后的代码；
- `fixes`：执行过的修复；
- `errors`：危险字符、运行时缺失或解析错误；
- `mode: "true-runtime"`：兼容旧调用方的模式标记。

输出闸支持 ` ```mermaid ` 与 ` ```mermaidd ` 围栏。每个坏块会被独立复评；能通过同款运行时解析的修正版会替换原块，仍失败的块会替换为安全提示，不会交给渲染器。

## 安全边界

- Unicode 箭头、未配对引号、subgraph 特殊字符会先被扫描/修复；
- 真解析直接使用 dsh-mermaid 的 `lib/mermaid-runtime.js`，不再依赖容易误判的 `.hash` 错误字段；
- 原始事件仍保留在 transcript，修正版通过 surface `replace` 覆盖可见消息；
- 输出闸只处理 `assistant/message` 的 append 事件，并通过 `gateFixed` 标记防止重复处理。

## 开发

```sh
pnpm install
pnpm --filter dsh-mermaid-comm build
pnpm --filter dsh-mermaid-comm typecheck
```

从 checkout 安装：

```sh
dsh plugin --profile web add file:/path/to/packages/dsh-mermaid-comm
```

## 许可证

MIT
