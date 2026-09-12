import type { Context } from '@deepseek-ai/cordis'
import { MermaidCommConfig, type MermaidCommConfig as MermaidCommConfigType } from './config.ts'
import { registerMermaidPrompt, registerVaultIndexSection } from './prompt.ts'
import { registerValidateTool } from './tool-validate.ts'
import { registerVaultTools } from './tool-vault.ts'
import { registerOutputGate } from './gate.ts'

/** Loader entry id（kebab-case，全局唯一）。 */
export const name = 'mermaid-comm'

/** 依赖的 service：工具注册表 + 系统提示组装。渲染交给 dsh-mermaid（MrmoLabs），不再依赖 webServer。 */
export const inject = ['tools', 'systemPrompt']

/**
 * 插件入口。
 *
 * 注意：Loader 传入的 config 是 patch 原始值（可为 undefined），必须提供默认值兜底——
 * schema 的 default 只影响设置页/校验，不自动填进 config。
 */
export function apply(ctx: Context, config: Partial<MermaidCommConfigType> = {}) {
  const {
    enabled = true,
    promptLevel = 'global',
    diagramTypes = [],
    validateBeforeRender = true,
    vaultEnabled = true,
    vaultDir = '.dsh/mermaid',
    maxVersions = 20,
    injectIndex = true,
    maxFileBytes = 256 * 1024,
  } = config

  if (!enabled) return

  // A. 行为引导：全局注入「用 Mermaid 交流」prompt 段（L1 禁 Unicode 箭头等危险写法）
  if (promptLevel === 'global') {
    registerMermaidPrompt(ctx, { diagramTypes, validateBeforeRender })
  }

  // C. 语法校验工具（L2 真解析器 + 危险字符扫描）
  registerValidateTool(ctx)

  // D. Mermaid Vault：图库持久化 + 版本演进 + 上下文回馈
  if (vaultEnabled) {
    registerVaultTools(ctx, { vaultDir, maxVersions, maxFileBytes })
    if (injectIndex) {
      registerVaultIndexSection(ctx, { vaultDir, maxVersions, maxFileBytes })
    }
  }

  // L3. 输出闸：assistant/message 落盘前自动清洗/摘除坏图
  registerOutputGate(ctx)
}

// 导出配置 schema 供设置页/其他插件使用
export { MermaidCommConfig }