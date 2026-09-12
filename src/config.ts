import z from '@deepseek-ai/schemastery'

/** dsh-mermaid-comm 插件配置（DSH 核心模式：interface 显式声明，schema 显式标注，d.ts 可移植）。 */
export interface MermaidCommConfig {
  /** 总开关：false 时不注入 prompt、不注册校验工具。 */
  enabled: boolean
  /** 行为引导强度：global=所有 agent 注入；off=关闭 prompt 注入（工具仍可用）。 */
  promptLevel: 'global' | 'off'
  /** 允许的图类型（数组）。空/缺省 = 全部类型开放。 */
  diagramTypes: string[]
  /** 提示模型在输出前用 mermaid_validate 自检。 */
  validateBeforeRender: boolean
  /** 图库总开关（Mermaid Vault）。 */
  vaultEnabled: boolean
  /** 图库目录（相对 workspace 根；默认 .dsh/mermaid）。 */
  vaultDir: string
  /** 每主题历史版本保留上限。 */
  maxVersions: number
  /** 是否向 system prompt 注入图库索引段。 */
  injectIndex: boolean
  /** 单文件大小上限（字节）。 */
  maxFileBytes: number
}

/** dsh-mermaid-comm 插件配置 schema（运行时校验 + 默认值）。 */
export const MermaidCommConfig: z<MermaidCommConfig> = z.object({
  /** 总开关：false 时不注入 prompt、不注册校验工具。 */
  enabled: z.boolean().default(true),
  /** 行为引导强度：global=所有 agent 注入；off=关闭 prompt 注入（工具仍可用）。 */
  promptLevel: z.union(['global', 'off']).default('global'),
  /** 允许的图类型（数组）。空/缺省 = 全部类型开放。 */
  diagramTypes: z.array(z.string()).default([]),
  /** 提示模型在输出前用 mermaid_validate 自检。 */
  validateBeforeRender: z.boolean().default(true),
  /** 图库总开关（Mermaid Vault）。 */
  vaultEnabled: z.boolean().default(true),
  /** 图库目录（相对 workspace 根；默认 .dsh/mermaid）。 */
  vaultDir: z.string().default('.dsh/mermaid'),
  /** 每主题历史版本保留上限。 */
  maxVersions: z.number().default(20),
  /** 是否向 system prompt 注入图库索引段。 */
  injectIndex: z.boolean().default(true),
  /** 单文件大小上限（字节）。 */
  maxFileBytes: z.number().default(256 * 1024),
})

/** 兼容别名：从 schema 推导的配置类型（schemastery 无 z.infer，用全局命名空间 TypeT）。 */
export type MermaidCommConfigType = MermaidCommConfig

/** 支持的全部 Mermaid 图类型（用于描述 prompt 与校验工具）。 */
export const ALL_DIAGRAM_TYPES = [
  'flowchart',
  'sequenceDiagram',
  'classDiagram',
  'stateDiagram-v2',
  'erDiagram',
  'gantt',
  'pie',
  'gitGraph',
  'journey',
  'timeline',
  'architecture',
  'radar',
  'treeView',
  'packet',
  'info',
] as const

export type DiagramType = (typeof ALL_DIAGRAM_TYPES)[number]
