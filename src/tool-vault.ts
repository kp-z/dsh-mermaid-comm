/**
 * Mermaid Vault 工具层：把图库暴露给模型。
 *
 * 4 个工具：
 * - mermaid_vault_list   —— 列出图库索引（主题/类型/版本/更新时间）
 * - mermaid_vault_read   —— 读某主题：当前活跃版 + 演进历史
 * - mermaid_vault_save   —— 保存/更新一张图（强制真解析校验，语法不过拒绝保存）
 * - mermaid_vault_delete —— 删除某主题（谨慎）
 *
 * workspace 根：模型调用时传 cwd（不传用 process.cwd() 兜底）。
 * save 必须通过 verifyMermaid 真解析，保证图库里永远是可渲染的图。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { MermaidVault, resolveWorkspace } from './vault.ts'
import { verifyMermaid } from './verify.ts'

/** 工具入参中的 cwd 归一化：不传/空用 process.cwd()。 */
function pickCwd(cwd: string | undefined): string {
  return resolveWorkspace(cwd?.trim() || process.cwd())
}

/** 从代码首行推断图类型（与 verify.ts 一致）。 */
function inferType(code: string): string {
  const first = code.split('\n').find((line) => {
    const v = line.trim()
    return v !== '' && !v.startsWith('%%')
  })?.trim() ?? ''
  return first.split(/[\s;]/, 1)[0] ?? ''
}

/** 注册 4 个 vault 工具。 */
export function registerVaultTools(ctx: Context, config: {
  vaultDir?: string
  maxVersions?: number
  maxFileBytes?: number
}) {
  const newVault = (cwd: string | undefined): MermaidVault =>
    new MermaidVault({
      workspace: pickCwd(cwd),
      ...(config.vaultDir !== undefined ? { vaultDir: config.vaultDir } : {}),
      ...(config.maxVersions !== undefined ? { maxVersions: config.maxVersions } : {}),
      ...(config.maxFileBytes !== undefined ? { maxFileBytes: config.maxFileBytes } : {}),
    })

  ctx.tools.register(defineTool({
    name: 'mermaid_vault_list',
    description: '列出 Mermaid 图库索引：已有主题、图类型、版本号、最后更新时间。' +
      '画图前先查图库，若已有同主题的图，应基于它演进而不是从零画。' +
      '可选按类型过滤。',
    parameters: {
      type: {
        type: 'string',
        description: '按图类型过滤（如 flowchart / sequenceDiagram）；不传列出全部。',
      },
      cwd: {
        type: 'string',
        description: 'workspace 目录（通常就是当前项目根）。不传用默认。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                type: { type: 'string', required: true },
                version: { type: 'number', required: true },
                updatedAt: { type: 'string', required: true },
                lines: { type: 'number', required: true },
                source: { type: 'string', required: true },
              },
            },
          },
          vaultRoot: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value, null, 2),
      }],
    },
    async execute(args) {
      const vault = newVault(args.cwd)
      const entries = vault.list(args.type ? { type: args.type } : undefined)
      return {
        ok: true,
        entries,
        vaultRoot: vault.root,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mermaid_vault_read',
    description: '读取图库中某主题的图：返回当前活跃版源码 + 演进历史（各版本变更说明）。' +
      '用于在旧图基础上迭代——先读，再改，再 save。',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: '主题名（如 payment-flow）。',
      },
      cwd: {
        type: 'string',
        description: 'workspace 目录。不传用默认。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          name: { type: 'string', required: true },
          type: { type: 'string', required: true },
          version: { type: 'number', required: true },
          code: { type: 'string', required: true },
          history: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value, null, 2),
      }],
    },
    async execute(args) {
      try {
        const vault = newVault(args.cwd)
        const result = vault.read(args.name)
        return { ok: true, ...result }
      } catch (error) {
        return {
          ok: false,
          name: args.name,
          type: '',
          version: 0,
          code: '',
          history: '',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mermaid_vault_save',
    description: '把一张图保存/更新到图库（Mermaid Vault）。' +
      '保存前强制语法真解析校验——语法错误直接拒绝，图库里永远是可渲染的图。' +
      '同一主题多次保存会形成版本演进（v1/v2/...），历史自动记录。' +
      '涉及架构/数据模型/核心流程等长期资产时务必保存；临时解释性示意图不用保存。',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: '主题名（如 payment-flow）。同一主题后续更新沿用同名。',
      },
      code: {
        type: 'string',
        required: true,
        description: 'Mermaid 源码（不含 ```mermaid 围栏）。',
      },
      type: {
        type: 'string',
        description: '图类型（如 flowchart）；不传从源码首行推断。',
      },
      note: {
        type: 'string',
        description: '本次变更说明（写入演进历史，类似 commit message）。',
      },
      cwd: {
        type: 'string',
        description: 'workspace 目录。不传用默认。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          name: { type: 'string', required: true },
          version: { type: 'number', required: true },
          created: { type: 'boolean', required: true },
          errors: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value, null, 2),
      }],
    },
    async execute(args) {
      // 1. 真解析校验：语法不过拒绝保存
      const result = await verifyMermaid(args.code, args.type ?? '')
      if (!result.ok || result.errors.length > 0) {
        return {
          ok: false,
          name: args.name,
          version: 0,
          created: false,
          errors: result.errors.length > 0 ? result.errors : ['语法校验失败'],
          path: '',
        }
      }

      // 2. 保存（用修正后的 built 代码）
      try {
        const vault = newVault(args.cwd)
        const type = result.type || inferType(result.built)
        const saved = vault.save(args.name, type, result.built, args.note ?? '', 'manual')
        return {
          ok: true,
          name: saved.name,
          version: saved.version,
          created: saved.created,
          errors: [],
          path: vault.root,
        }
      } catch (error) {
        return {
          ok: false,
          name: args.name,
          version: 0,
          created: false,
          errors: [error instanceof Error ? error.message : String(error)],
          path: '',
        }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mermaid_vault_delete',
    description: '删除图库中的某主题（主文件 + 历史 + 索引项）。' +
      '谨慎使用：删除不可恢复。只在用户明确要求或主题已废弃时调用。',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: '要删除的主题名。',
      },
      cwd: {
        type: 'string',
        description: 'workspace 目录。不传用默认。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          deleted: { type: 'boolean', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value, null, 2),
      }],
    },
    async execute(args) {
      try {
        const vault = newVault(args.cwd)
        const { deleted } = vault.delete(args.name)
        return { ok: true, deleted, name: args.name }
      } catch (error) {
        return {
          ok: false,
          deleted: false,
          name: args.name,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }))
}
