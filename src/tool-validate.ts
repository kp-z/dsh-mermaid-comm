import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { ALL_DIAGRAM_TYPES } from './config.ts'
import { verifyMermaid } from './verify.ts'

/** 注册 mermaid_validate 工具（模型输出前自检语法；L2 真校验）。 */
export function registerValidateTool(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'mermaid_validate',
    description: '校验 Mermaid 图语法，避免渲染失败。输出前先调用它检查要生成的图。' +
      '会用渲染器同款 mermaid 解析器严格判定：Unicode 箭头（→）、裸引号、' +
      'subgraph 特殊字符（★·中文冒号）都会被检出。' +
      `支持类型：${ALL_DIAGRAM_TYPES.join(' / ')}。`,
    parameters: {
      type: {
        type: 'string',
        required: true,
        description: `图类型，支持：${ALL_DIAGRAM_TYPES.join(' / ')}。`,
      },
      code: {
        type: 'string',
        required: true,
        description: 'Mermaid 源码（不含 ```mermaid 围栏）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          mode: { type: 'string', required: true },
          built: { type: 'string', required: true, description: '修正后的代码（若 ok 且无 fixes 则与输入一致）' },
          fixes: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
          errors: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
          type: { type: 'string', required: true, description: '返回实际生效图代码类型（优先使用传入类型，否则从源码首行推断）' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value, null, 2),
      }],
    },
    async execute(args) {
      const result = await verifyMermaid(args.code, args.type)
      return {
        ok: result.ok,
        mode: 'true-runtime',
        built: result.built,
        fixes: result.fixes,
        errors: result.errors,
        type: result.type,
      }
    },
  }))
}
