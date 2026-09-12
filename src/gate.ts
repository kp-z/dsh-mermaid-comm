import type { Context } from '@deepseek-ai/cordis'
import { verifyMermaid } from './verify.ts'

/**
 * L3 输出闸：监听每条 assistant/message 落盘事件，把所有 mermaid 代码块
 * 在用户可见前「重写 + 真解析」复评：
 * - 能改好的（Unicode 箭头、裸引号、subgraph 特殊字符），替换成干净版本；
 * - 改不好且真语法错（jison SYNTAX-ERR）的，把坏块从可见消息里摘掉并附注原因，
 *   模型与用户之后看到的都是修正版 —— 用户永远看不到渲染失败卡片。
 *
 * 实现：session surface 的原子 replace 机制
 *   session.append('assistant/message', {...fixed}, { surfaceOp: {op:'replace', start: seq, end: seq}, sourceEventSeqs: [seq] })
 * 原始 append 事件仍留在日志（transcript 完整），可见面被修正版遮蔽——
 * agent-loop 的 canonical transcript 过滤 replacement copy，历史对账不受影响。
 */

interface GateBlock {
  code: string
}

/** 从文本中提取所有 mermaid 代码块。 */
function extractBlocks(text: string): GateBlock[] {
  const blocks: GateBlock[] = []
  const fence = /```(?:mermaid|mermaidd)[^\S\n]*\n([^]*?)\n?```/gi
  for (const match of text.matchAll(fence)) {
    blocks.push({ code: match[1] ?? '' })
  }
  return blocks
}

/** 逐块替换法重写整段文本（按出现顺序应用 changes）。 */
function rewriteText(text: string, changes: (string | null)[]): string {
  let index = 0
  return text.replace(/```(?:mermaid|mermaidd)[^\S\n]*\n[^]*?\n?```/gi, (raw) => {
    const replacement = changes[index]
    index += 1
    if (replacement == null) return raw
    if (replacement === '') {
      return `<!-- mermaid-comm: 该图语法错误且无法自动修复，已从可见消息中移除 -->`
    }
    return replacement
  })
}

export function registerOutputGate(ctx: Context) {
  // 注意：沙箱 ctx 只暴露白名单动词与已声明服务。不能读 ctx.logger / ctx.root（会被沙箱拒绝）。
  // 直接 ctx.on 订阅即可：插件 ctx 无 scope 标签，能收到 web 主会话与各子代理分 scope 的所有事件。

  const warn = (...args: unknown[]) => {
    try { console.warn('[mermaid-comm]', ...args) } catch {}
  }

  const isAppend = (value: unknown): boolean => value === 'append'
    || (value !== null && typeof value === 'object' && (value as { op?: unknown }).op === 'append')

  const handle = async (session: any, event: any) => {
    if (event?.type !== 'assistant/message') return
    if (!isAppend(event?.surfaceOp)) return
    if (event.data?.gateFixed === true) return
    const message = event.data?.message
    if (message?.role !== 'assistant') return
    const content = Array.isArray(message.content) ? message.content : []
    const textBlocks = content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    if (textBlocks.length === 0) return
    if (!textBlocks.some((b: any) => /```\s*(?:mermaid|mermaidd)/i.test(b.text))) return

    const hasFence = (t: string) => /```(?:mermaid|mermaidd)[^\S\n]*\n[^]*?\n?```/i.test(t)

    // 第一个异步边界前做同步快速判定，避免 async listener 的时序怪癖
    const plan = textBlocks.map((b: any) => ({ block: b, has: hasFence(b.text as string) }))
    const touched = plan.some((p: { has: boolean }) => p.has)
    if (!touched) return

    // 只有真渲染失败的块才需要动；尝试与其同循环内完成重写
    let finalTouched = false
    const perBlock: Map<any, (string | null)[]> = new Map()
    for (const { block } of plan) {
      const raw = block.text
      const extracted = extractBlocks(raw)
      if (extracted.length === 0) { perBlock.set(block, []); continue }
      const changes: (string | null)[] = extracted.map(() => null)

      for (let i = 0; i < extracted.length; i++) {
        const orig = extracted[i]?.code ?? ''
        const v = await verifyMermaid(orig)
        if (v.ok) {
          if (v.fixes.length > 0) {
            changes[i] = '```mermaid\n' + v.built.replace(/^\s*\n/, '').replace(/\s+$/, '') + '\n```'
            finalTouched = true
          }
          continue
        }
        if (v.fixes.length > 0) {
          // 重写过但依旧失败——重写版不再展示，摘块并说明
          changes[i] = ''
          finalTouched = true
        } else {
          // 原样失败——摘块并说明
          changes[i] = ''
          finalTouched = true
        }
      }
      perBlock.set(block, changes)
    }

    if (!finalTouched) return

    // 构造修正版消息：保留原 message id 与 source，只改正文
    const fixedMessage: any = JSON.parse(JSON.stringify(message))
    const fixedContent = Array.isArray(fixedMessage.content) ? [...fixedMessage.content] : []
    for (const [blockIndex, block] of textBlocks.entries()) {
      const changes = perBlock.get(block)
      if (!changes || !changes.some((c) => c != null)) continue
      let textIndex = 0
      const idx = fixedContent.findIndex((b: any) => {
        if (b?.type !== 'text') return false
        const matches = textIndex === blockIndex && b.text === block.text
        textIndex += 1
        return matches
      })
      if (idx === -1) continue
      const newText = rewriteText(fixedContent[idx].text, changes)
      const note = changes.some((c) => c === '')
        ? '\n> mermaid-comm：一条图语法错误且无法自动修复，已从可见消息移除（重画时请先过 mermaid_validate）。'
        : ''
      fixedContent[idx] = { ...fixedContent[idx], text: newText + note }
    }
    fixedMessage.content = fixedContent

    try {
      session.append('assistant/message', {
        turn: event.data.turn,
        step: event.data.step,
        message: fixedMessage,
        ...(event.data.usage === void 0 ? {} : { usage: event.data.usage }),
        gateFixed: true as boolean,
      }, {
        surfaceOp: { op: 'replace' as const, start: event.seq, end: event.seq },
        sourceEventSeqs: [event.seq],
      })
    } catch (error) {
      warn('gate replacement failed:', String(error))
    }
  }

  ctx.on('session/event', (session: unknown, event: unknown) => {
    handle(session, event).catch((error) => {
      warn('gate validation failed:', String(error))
    })
  })
}