/**
 * mermaid_validate 校验链单测。
 *
 * 覆盖三件事：
 * 1. 真语法错（jison 带 .hash）仍然判错；
 * 2. DOM 噪音错（不带 .hash，例如运行时拿不到 DOM 时的 `Zs.addHook is not a function`）
 *    不得被冒充成「真解析器判定语法错误」；
 * 3. runtime 导入后不得把临时 DOM 留在宿主全局。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadMermaidRuntime, parseCheck, postprocessCode, verifyMermaid } from '../lib/verify.js'

const LABELED_FLOWCHART = 'flowchart LR\n  A["开始"] --> B["结束"]'
const BROKEN_FLOWCHART = 'flowchart LR\n  A["x" --> B'

/** 往 verifyMermaid 用的 runtime 缓存里塞一个假 runtime，返回还原函数。 */
function withFakeRuntime(runtime: { parse(text: string): Promise<unknown> }) {
  const globals = globalThis as unknown as Record<string, unknown>
  const key = '__dsh_mermaid_comm_runtime'
  const previous = globals[key]
  globals[key] = Promise.resolve(runtime)
  return () => {
    if (previous === undefined) delete globals[key]
    else globals[key] = previous
  }
}

test('parseCheck：带 .hash 的错判为真语法错', async () => {
  const error = Object.assign(new Error('Parse error on line 2'), { hash: { text: 'x' } })
  const result = await parseCheck({ parse: async () => { throw error } }, BROKEN_FLOWCHART)
  assert.equal(result.ok, false)
  assert.equal(result.syntax, true)
})

test('parseCheck：DOM 噪音错（无 .hash）不算语法错', async () => {
  const result = await parseCheck(
    { parse: async () => { throw new TypeError('Zs.addHook is not a function') } },
    LABELED_FLOWCHART,
  )
  assert.equal(result.ok, false)
  assert.equal(result.syntax, false)
})

test('verifyMermaid：DOM 噪音失败必须报「未能完成真解析」，不得冒充语法错', async () => {
  const restore = withFakeRuntime({
    parse: async () => { throw new TypeError('Zs.addHook is not a function') },
  })
  try {
    const result = await verifyMermaid(LABELED_FLOWCHART)
    assert.equal(result.ok, false)
    assert.ok(
      result.errors.some((e) => e.includes('未能完成真解析校验')),
      `errors 应提到未能完成真解析：${result.errors.join(' | ')}`,
    )
    assert.ok(
      !result.errors.some((e) => e.includes('真解析器判定语法错误')),
      `errors 不应再冒充语法错：${result.errors.join(' | ')}`,
    )
    assert.ok(result.hints.some((h) => h.includes('DOM')), `应给出 DOM 提示：${result.hints.join(' | ')}`)
  } finally {
    restore()
  }
})

test('verifyMermaid：真语法错仍然判错', async () => {
  const error = Object.assign(new Error('Parse error on line 2'), { hash: { text: 'x' } })
  const restore = withFakeRuntime({ parse: async () => { throw error } })
  try {
    const result = await verifyMermaid(BROKEN_FLOWCHART)
    assert.equal(result.ok, false)
    assert.ok(
      result.errors.some((e) => e.includes('真解析器判定语法错误')),
      `errors 应报语法错：${result.errors.join(' | ')}`,
    )
  } finally {
    restore()
  }
})

test('postprocessCode：Unicode 箭头改写为 ASCII（回归）', () => {
  const result = postprocessCode('flowchart LR\n  A → B')
  assert.match(result.code, /-->/)
  assert.ok(result.fixes.length > 0)
})

test('集成：带标签的图能真解析通过，且临时 DOM 不留在全局', async (t) => {
  const runtime = await loadMermaidRuntime()
  if (runtime === null) {
    t.skip('dsh-mermaid 未安装，跳过集成用例')
    return
  }

  const flowchart = await verifyMermaid(LABELED_FLOWCHART)
  assert.equal(flowchart.ok, true, flowchart.errors.join(' | '))

  const state = await verifyMermaid('stateDiagram-v2\n  [*] --> A', 'stateDiagram-v2')
  assert.equal(state.ok, true, state.errors.join(' | '))

  const broken = await verifyMermaid(BROKEN_FLOWCHART)
  assert.equal(broken.ok, false)
  assert.ok(broken.errors.some((e) => e.includes('真解析器判定语法错误')))

  // 关键性质：runtime 导入用的临时 DOM 必须已经还原，不能污染宿主进程。
  const globals = globalThis as unknown as Record<string, unknown>
  assert.equal(globals.window, undefined, '临时 window 应已还原')
  assert.equal(globals.document, undefined, '临时 document 应已还原')
})
