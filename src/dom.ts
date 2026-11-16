/** 校验用的临时 DOM 引导。
 *
 * 为什么需要：mermaid 对节点标签做消毒时要过 DOMPurify，而 DOMPurify 在**创建时**
 * 就要求一个 window/document。校验跑在宿主进程（Node / Electron 主进程）里没有 DOM，
 * 于是带标签的图（flowchart / state / timeline / classDiagram / gantt 等）会以
 * `Zs.addHook is not a function`（securityLevel: strict）或
 * `Zs.sanitize is not a function`（loose）这类 DOM 噪音错失败——sequenceDiagram /
 * erDiagram 的标签不走这条消毒路径，所以它们在同样环境下正常。
 *
 * 为什么可以立即摘掉：DOM 只在 DOMPurify 初始化那一刻（即 import dsh-mermaid 的
 * runtime）被读取；之后的 parse 只用到实例内部持有的引用，不再读全局。所以这里只在
 * 导入窗口内临时挂上，导入完立刻还原，不把假 DOM 留给宿主进程——很多宿主插件靠
 * `typeof window === 'undefined'` 判断自己跑在 Node 还是浏览器里。
 */

const EMPTY_HTML = '<html><body></body></html>'

interface DomLike {
  window: unknown
  document: { nodeType?: number }
}

/** 取一个可用的 DOM；返回 null 表示一个都拿不到（此时校验只能退化为「未能真解析」）。 */
async function createDom(): Promise<DomLike | null> {
  // 主路径：linkedom（本包声明的依赖）。
  try {
    const { parseHTML } = await import('linkedom')
    const { window, document } = parseHTML(EMPTY_HTML)
    if (document.nodeType === 9) return { window, document }
  } catch {
    // 落到后备
  }

  // 后备：宿主依赖链里可能已经有 server DOM（例如 dsh 自身带的 domino）。
  // 用变量做 specifier，避免把未声明的包写进静态解析。
  const fallback = '@mixmark-io/domino'
  try {
    const imported: unknown = await import(fallback)
    const domino = ((imported as { default?: unknown }).default ?? imported) as {
      createWindow(html: string): { document?: { nodeType?: number } }
    }
    const window = domino.createWindow(EMPTY_HTML)
    const document = window?.document
    if (document?.nodeType === 9) return { window, document }
  } catch {
    // 没有后备
  }

  return null
}

/**
 * 在 import mermaid runtime 之前临时挂上 DOM。
 *
 * @returns 还原函数；环境里本来就有 DOM（浏览器、happy-dom 测试环境）或一个 DOM 都拿不到时返回 null。
 */
export async function installDomForImport(): Promise<(() => void) | null> {
  const globals = globalThis as unknown as Record<string, unknown>
  // 已经有 DOM 就不要动它：浏览器里 DOMPurify 本来就能用，测试环境也不该被替换。
  if (globals.window !== undefined && globals.document !== undefined) return null

  const dom = await createDom()
  if (dom === null) return null

  const hadWindow = 'window' in globals
  const hadDocument = 'document' in globals
  const previousWindow = globals.window
  const previousDocument = globals.document

  globals.window = dom.window
  globals.document = dom.document

  return () => {
    if (hadWindow) globals.window = previousWindow
    else delete globals.window
    if (hadDocument) globals.document = previousDocument
    else delete globals.document
  }
}
