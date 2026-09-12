import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type { Context } from '@deepseek-ai/cordis'
import { ALL_DIAGRAM_TYPES } from './config.ts'

/** 生成「用 Mermaid 交流」的系统提示段文本。 */
export function buildPromptText(opts: {
  diagramTypes: string[]
  validateBeforeRender: boolean
}): string {
  const types = opts.diagramTypes.length > 0
    ? opts.diagramTypes.join(' / ')
    : ALL_DIAGRAM_TYPES.join(' / ')

  const validateLine = opts.validateBeforeRender
    ? '输出 Mermaid 前，先用 mermaid_validate 工具校验语法，确认无误再输出。'
    : ''

  return `## 开发交流优先用 Mermaid 图表达

与用户进行开发相关的技术交流时，**默认、优先用 Mermaid 图来表达**，目标是「用图说清楚，少说废话」。以下场景**必须配图**（不要等用户要求，也不要先用长篇文字）：

- 架构说明、模块关系、组件依赖 → **flowchart** 或 classDiagram（架构图优先）
- 数据流 / 调用链 / 请求时序 / 接口交互 → **sequenceDiagram（时序图优先）**
- 状态流转 / 生命周期 / 工作流 → stateDiagram-v2
- 数据模型 / 表关系 → erDiagram
- 分支策略 / 提交历史 / 依赖演化 → gitGraph
- 计划排期 → gantt
- 其他适合的图 → ${types}

规则：
1. **图是第一表达**：先给一句话结论（不超过一两句），立即用 \`\`\`mermaid 围栏给出图；图要能独立表达核心信息，配简短图例。文字解释保持精简，不要长篇赘述。
2. **默认画图**：只要涉及结构、流程、时序、状态、依赖关系，就默认输出 Mermaid 图，不用等用户明确要求。
3. **信息入图**：事实、要点、结论尽量写在图的节点/注释/图例里，正文不再复述；多对象对比用表格横向承载（单元格只放关键字）；正文只留无法入图的取舍理由。
4. 图必须语法正确。${validateLine}
5. 一次回复里多张图时，每张图聚焦一个主题，不要塞进一张图。

**语法红线（违反必改，这些是最高频的坏图原因）：**
- 箭头一律只用 ASCII：\`-->\`、\`-.->\`、\`==>\`、\`---\` 及其组合；**严禁 Unicode 箭头**（→ ← ⇒ ⇐ ↔ ↑ ↓ 及 \`-.\` 后跟 \`→\` 等一切变体）。
- 节点标签含引号时写作 \`A["..."]\`（引号成对），subgraph 标题同样用 \`["..."]\` 包裹。
- subgraph/label 文本避开 \`★\`、\`·\`、中文冒号 \`：\` 与裸引号；要表达层级用 \`/\` 或空格。
- 边标签写 \`A -->|标签| B\`，标签内不要出现未配对的引号。
- **每改一次图（哪怕是改一个字），都必须重新调用 mermaid_validate 校验**——已校验过再小改也可能改坏，不重新校验不准输出。`
}

/** 注入 systemPrompt.section（order 150，工具引导带）。 */
export function registerMermaidPrompt(ctx: Context, opts: {
  diagramTypes: string[]
  validateBeforeRender: boolean
}) {
  ctx.systemPrompt.section({
    name: 'mermaid-comm:guidance',
    order: 150,
    text: buildPromptText(opts),
  })
}
