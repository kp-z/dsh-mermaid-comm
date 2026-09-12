/** 危险字符扫描 + 真 mermaid 解析共同文件。
 *
 * L2/L3 共用：
 * - postprocessCode()：重写最高频坏图写法（Unicode 箭头、裸引号标签、subgraph 危险字符）
 * - scanDangerous()：扫描重写后仍可能有的危险字符
 * - loadMermaidRuntime()：懒加载 dsh-mermaid 的 runtime bundle（与浏览器渲染同一份 mermaid），
 *   一参 parse() 对真语法错稳定抛带 .hash 的 SYNTAX-ERR，DOM 噪音错不带 .hash。
 */

interface MermaidRuntime {
  parse(text: string): Promise<unknown>
}

const globalForMermaid = globalThis as typeof globalThis & {
  __dsh_mermaid_comm_runtime?: Promise<MermaidRuntime | null>
}

/** 懒解析 dsh-mermaid 的 runtime bundle（与渲染插件同版本，判定最权威）。 */
export function loadMermaidRuntime(): Promise<MermaidRuntime | null> {
  if (!globalForMermaid.__dsh_mermaid_comm_runtime) {
    globalForMermaid.__dsh_mermaid_comm_runtime = (async () => {
      try {
        const { createRequire } = await import('node:module')
        const path = await import('node:path')
        const require = createRequire(import.meta.url)
        const pkgJsonPath = require.resolve('dsh-mermaid/package.json')
        const runtimePath = path.join(path.dirname(pkgJsonPath), 'lib', 'mermaid-runtime.js')
        const mod = await import(runtimePath)
        const runtime = mod?.default ?? mod
        if (typeof runtime?.parse === 'function') return runtime as MermaidRuntime
        return null
      } catch {
        return null
      }
    })()
  }
  return globalForMermaid.__dsh_mermaid_comm_runtime
}

/** 真解析错误：mermaid 的 jison 语法错带 .hash（解析表状态），DOM 噪音错不带。 */
export function isTrueSyntaxError(error: unknown): boolean {
  return error != null && typeof error === 'object' && 'hash' in (error as Record<string, unknown>)
}

/** 重写高频坏图写法；返回 { code, fixes }。 */
export function postprocessCode(input: string): { code: string; fixes: string[] } {
  const fixes: string[] = []
  let code = input

  // 1. 所有 Unicode 箭头统一成 Mermaid 可解析的 ASCII 长箭头。
  // flowchart 的单短箭头 `->` 不是合法边，不能直接替换成 `-->` 以外的形式。
  code = code
    .replace(/[→⇒]/g, '-->')
    .replace(/[←⇐]/g, '<--')
    .replace(/[↔⇔]/g, '<-->')
  if (code !== input) fixes.push('Unicode 箭头已改写为 ASCII')

  // 2. 节点标签 [xxx] 文本内裸双引号 → 全体加引号并转义内部引号。
  // 只处理首字符非引号的标签；已正确成对的 ["..."] 标签原样跳过，避免重复转义。
  const beforeQuote = code
  code = code.replace(/\[(?!")([^\[\]]*"[^\[\]]*)\]/g, (_m, inner: string) => {
    return `["${inner.replaceAll('"', '\\"')}"]`
  })
  if (code !== beforeQuote) fixes.push('节点标签内裸双引号已转义')

  // 3. subgraph 标题内的危险字符（★ 和 · 会直接炸语法）
  const beforeStar = code
  code = code.replace(/(subgraph\s+[^\n[]*)[★·◆●▲■]/g, (_m, head: string) => {
    return head + _m.slice(head.length).replace(/[★·◆●▲■]/g, '/')
  })
  if (code !== beforeStar) fixes.push('subgraph 标题特殊字符已替换为 /')

  return { code, fixes }
}

/** 扫描重写后仍残留的危险写法（给模型的可读错误）。 */
export function scanDangerous(code: string): string[] {
  const errors: string[] = []

  // 残留的 Unicode 箭头（重写后不该有；有说明出现了新变体）
  if (/[→←⇒⇐↔⇕⇗⇘⇙⇖↓↑↕⟶⟵⟹⟸]/.test(code)) {
    errors.push('仍含 Unicode 箭头字符，请只使用 -> / -.-> / ==> / ---')
  }
  // 标签或 subgraph 文本里的裸双引号（排除已配对的 ["..."]）
  const washed = code.replaceAll(/"([^"]*)"/g, '')
  if (/"/.test(washed)) {
    errors.push('含未配对引号：节点/subgraph 标题里的引号必须写 ["..."] 并成对')
  }
  // ★ 等会导致解析器死掉的字符
  if (/★/.test(code)) errors.push('含 ★ 字符：请用其他符号或文字表达')

  return errors
}

export function parseCheck(runtime: MermaidRuntime, code: string): Promise<{ ok: boolean; error: string }> {
  return runtime.parse(code).then(
    () => ({ ok: true, error: '' }),
    (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        error: message.split('\n').slice(0, 3).join(' ').slice(0, 200),
      }
    },
  )
}

export interface VerifyResult {
  ok: boolean
  built: string
  fixes: string[]
  errors: string[]
  hints: string[]
  type: string
}

/** 从代码首行推断 Mermaid 图类型，用于工具回显与诊断。 */
export function inferDiagramType(code: string): string {
  const first = code.split('\n').find((line) => {
    const value = line.trim()
    return value !== '' && !value.startsWith('%%')
  })?.trim() ?? ''
  const token = first.split(/[\s;]/, 1)[0] ?? ''
  return token
}

/** 综合判定：规则重写 + 危险扫描 + 真解析。bad = 真语法错。 */
export async function verifyMermaid(codeInput: string, requestedType = ''): Promise<VerifyResult> {
  const hints: string[] = []
  const { code, fixes } = postprocessCode(codeInput)
  const type = requestedType.trim() || inferDiagramType(code)
  const errors = scanDangerous(code)
  if (errors.length > 0) return { ok: false, built: code, fixes, errors, hints, type }

  const runtime = await loadMermaidRuntime()
  // 无运行时不能声称「通过真解析」，即使规则修复成功也必须失败。
  if (runtime == null) {
    hints.push('无渲染运行时，未做真解析；请在 dsh-mermaid 可用的环境重试')
    return {
      ok: false,
      built: code,
      fixes,
      errors: ['缺少 Mermaid 运行时，无法执行语法校验'],
      hints,
      type,
    }
  }

  const check = await parseCheck(runtime, code)
  if (check.ok) return { ok: true, built: code, fixes, errors, hints, type }

  return {
    ok: false,
    built: code,
    fixes,
    errors: [...errors, '真解析器判定语法错误：' + check.error],
    hints,
    type,
  }
}