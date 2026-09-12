/**
 * Mermaid Vault 存储引擎单测。
 * 覆盖：保存/版本演进、sanitize 防路径穿越、索引刷新、历史裁剪、读取、删除。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MermaidVault } from '../lib/vault.js'

function makeVault(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'))
  const vault = new MermaidVault({
    workspace: dir,
    vaultDir: '.dsh/mermaid',
    maxVersions: 3,
    ...opts,
  })
  return { vault, dir }
}

const FLOW = `flowchart TD
  A[下单] --> B[支付]
  B --> C[完成]`

test('save 新主题 → v1，主文件可读，索引有记录', () => {
  const { vault } = makeVault()
  const r = vault.save('payment-flow', 'flowchart', FLOW, '初版')
  assert.equal(r.version, 1)
  assert.equal(r.created, true)

  const code = fs.readFileSync(path.join(vault.root, 'payment-flow.mmd'), 'utf8')
  assert.ok(code.includes('A[下单]'))
  assert.ok(code.endsWith('\n'))

  const idx = vault.list()
  assert.equal(idx.length, 1)
  assert.equal(idx[0]!.name, 'payment-flow')
  assert.equal(idx[0]!.version, 1)
  assert.equal(idx[0]!.type, 'flowchart')
})

test('同主题再保存 → v2，历史记录 v1+v2', () => {
  const { vault } = makeVault()
  vault.save('payment-flow', 'flowchart', FLOW, '初版')
  const r2 = vault.save('payment-flow', 'flowchart', FLOW + '\n  C --> D[对账]', '新增对账')
  assert.equal(r2.version, 2)
  assert.equal(r2.created, false)

  const read = vault.read('payment-flow')
  assert.equal(read.version, 2)
  assert.ok(read.code.includes('对账'))
  assert.ok(read.history.includes('## v1'))
  assert.ok(read.history.includes('## v2'))
  assert.ok(read.history.includes('初版'))
  assert.ok(read.history.includes('新增对账'))
})

test('历史裁剪：超过 maxVersions 只留最近 N 版', () => {
  const { vault } = makeVault({ maxVersions: 3 })
  for (let i = 1; i <= 5; i++) {
    vault.save('t', 'flowchart', `flowchart TD\n  A --> B${i}`, `v${i}`)
  }
  const read = vault.read('t')
  assert.equal(read.version, 5)
  const versions = [...read.history.matchAll(/## v(\d+)/g)].map((m) => Number(m[1]))
  assert.deepEqual(versions, [3, 4, 5])
})

test('sanitize：非法主题名抛错，防路径穿越', () => {
  const { vault } = makeVault()
  assert.throws(() => vault.save('../evil', 'flowchart', FLOW))
  assert.throws(() => vault.save('a/b', 'flowchart', FLOW))
  assert.throws(() => vault.save('', 'flowchart', FLOW))
  assert.throws(() => vault.save('-x', 'flowchart', FLOW))
  assert.throws(() => vault.save('中文名', 'flowchart', FLOW))
  // 合法名不受影响
  vault.save('a_b-c1', 'flowchart', FLOW)
  assert.equal(vault.list().length, 1)
})

test('delete 删除主文件+历史+索引项', () => {
  const { vault } = makeVault()
  vault.save('x', 'flowchart', FLOW)
  const r = vault.delete('x')
  assert.equal(r.deleted, true)
  assert.equal(vault.list().length, 0)
  assert.throws(() => vault.read('x'))
})

test('read 不存在的主题抛错', () => {
  const { vault } = makeVault()
  assert.throws(() => vault.read('nope'))
})

test('list 支持类型过滤', () => {
  const { vault } = makeVault()
  vault.save('a', 'flowchart', FLOW)
  vault.save('b', 'sequenceDiagram', 'sequenceDiagram\n  A->>B: hi')
  assert.equal(vault.list({ type: 'flowchart' }).length, 1)
  assert.equal(vault.list({ type: 'sequenceDiagram' }).length, 1)
})

test('写越界被拒：vaultDir 之外的路径不可写', () => {
  const { vault } = makeVault()
  // 通过原子写直接验证 assertInsideVault
  assert.throws(() => {
    ;(vault as unknown as { atomicWrite(t: string, c: string): void }).atomicWrite(
      path.join(vault.root, '..', 'escape.txt'),
      'x',
    )
  })
})

test('INDEX.md 格式可被 readIndex 重新解析（round-trip）', () => {
  const { vault } = makeVault()
  vault.save('a', 'flowchart', FLOW)
  vault.save('b', 'erDiagram', 'erDiagram\n  USER ||--o{ ORDER : places')
  const entries = vault.list()
  assert.equal(entries.length, 2)
  const names = entries.map((e) => e.name).sort()
  assert.deepEqual(names, ['a', 'b'])
})
