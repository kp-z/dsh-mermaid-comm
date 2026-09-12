/**
 * Mermaid Vault 存储引擎。
 *
 * 图库（Mermaid Vault）把验证通过的图持久化到 workspace 的隐藏目录，
 * 形成「同主题多版本演进」的长期资产：
 * - <name>.mmd          —— 当前活跃版（始终可渲染，供 dsh-mermaid 等直接打开）
 * - <name>.history.md   —— 演进历史（v1/v2/... + 每版变更说明 + 图源码）
 * - INDEX.md            —— 图库索引（主题/类型/版本/最后更新，注入上下文用）
 *
 * 安全边界：
 * - 主题名 sanitize：只允许 [a-zA-Z0-9-_]，杜绝路径穿越
 * - 写入路径锁定在 <workspace>/<vaultDir>/ 内，绝不越界
 * - 原子写：先写 .tmp 再 rename，避免半写文件
 * - 单文件大小上限 + 历史版本上限，防止无限膨胀
 */

import fs from 'node:fs'
import path from 'node:path'

/** 一条图库索引记录。 */
export interface VaultIndexEntry {
  /** 主题名（sanitized，与文件名一致）。 */
  name: string
  /** 图类型（flowchart / sequenceDiagram / ...）。 */
  type: string
  /** 当前版本号（v1/v2/...）。 */
  version: number
  /** 最后更新时间（ISO）。 */
  updatedAt: string
  /** 行数（复杂度参考）。 */
  lines: number
  /** 来源：manual=模型显式保存；auto=自动兜底落盘。 */
  source: 'manual' | 'auto'
}

/** 读取某主题的结果。 */
export interface VaultReadResult {
  name: string
  type: string
  version: number
  /** 当前活跃版源码。 */
  code: string
  /** 演进历史全文（Markdown），无历史时为 ''。 */
  history: string
}

/** 保存操作的结果。 */
export interface VaultSaveResult {
  name: string
  version: number
  /** 是否新建主题（false = 更新已有主题）。 */
  created: boolean
  /** 变更说明（本次保存的 note）。 */
  note: string
}

/** vault 存储引擎。 */
export class MermaidVault {
  constructor(
    private readonly options: {
      /** workspace 根目录（会话 cwd）。 */
      workspace: string
      /** vault 目录（相对 workspace；默认 .dsh/mermaid）。 */
      vaultDir?: string
      /** 历史版本保留上限。 */
      maxVersions?: number
      /** 单文件大小上限（字节）。 */
      maxFileBytes?: number
    },
  ) {}

  /** vault 绝对路径。 */
  get root(): string {
    return path.join(this.options.workspace, this.options.vaultDir ?? '.dsh/mermaid')
  }

  /** 确保 vault 目录存在（递归创建）。 */
  private ensureRoot(): void {
    fs.mkdirSync(this.root, { recursive: true })
  }

  /** 校验绝对路径落在 vault root 内；越界抛错。 */
  private assertInsideVault(abs: string): void {
    const rel = path.relative(this.root, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`vault path escapes root: ${abs}`)
    }
  }

  /** 主题名 sanitize：只保留安全字符，空名/非法名抛错。 */
  private assertSafeName(name: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-_]{0,63}$/.test(name)) {
      throw new Error(`非法主题名 "${name}"：只允许字母/数字/-/_（最长 64 字符），不能以 -/_ 开头`)
    }
  }

  /** 主题名 → 主文件路径。 */
  private mainPath(name: string): string {
    return path.join(this.root, `${name}.mmd`)
  }

  /** 主题名 → 历史文件路径。 */
  private historyPath(name: string): string {
    return path.join(this.root, `${name}.history.md`)
  }

  /** 从 INDEX.md 解析索引（文件不存在返回空数组）。 */
  private readIndex(): VaultIndexEntry[] {
    const indexPath = path.join(this.root, 'INDEX.md')
    if (!fs.existsSync(indexPath)) return []
    const raw = fs.readFileSync(indexPath, 'utf8')
    const entries: VaultIndexEntry[] = []
    // 索引格式：| name | type | vN | updatedAt | lines | source |
    for (const line of raw.split('\n')) {
      const m = /^\|\s*([a-zA-Z0-9-_]+)\s*\|\s*([a-zA-Z0-9]+)\s*\|\s*v(\d+)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*(manual|auto)\s*\|$/.exec(line)
      if (!m) continue
      entries.push({
        name: m[1]!,
        type: m[2]!,
        version: Number(m[3]),
        updatedAt: m[4]!.trim(),
        lines: Number(m[5]),
        source: m[6] as 'manual' | 'auto',
      })
    }
    return entries
  }

  /** 写 INDEX.md（按名称排序）。 */
  private writeIndex(entries: VaultIndexEntry[]): void {
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
    const lines = [
      '# Mermaid Vault 图库索引',
      '',
      '自动生成，勿手改。保存/更新/删除图时由 dsh-mermaid-comm 刷新。',
      '',
      '| name | type | version | updatedAt | lines | source |',
      '|---|---|---|---|---|---|',
      ...sorted.map((e) => `| ${e.name} | ${e.type} | v${e.version} | ${e.updatedAt} | ${e.lines} | ${e.source} |`),
      '',
    ]
    const indexPath = path.join(this.root, 'INDEX.md')
    this.atomicWrite(indexPath, lines.join('\n'))
  }

  /** 原子写：先写 .tmp 再 rename（同目录，rename 原子）。 */
  private atomicWrite(target: string, content: string): void {
    this.assertInsideVault(target)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > (this.options.maxFileBytes ?? 256 * 1024)) {
      throw new Error(`文件超出大小上限：${target} (${bytes} bytes)`)
    }
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, target)
  }

  /**
   * 保存/更新一张图。
   * - 主文件覆盖为当前活跃版；
   * - 历史文件追加 vN 段（含变更说明 + 图源码）；
   * - 刷新索引。
   *
   * @param name 主题名（sanitize 校验）
   * @param type 图类型
   * @param code mermaid 源码（应已通过 mermaid_validate；调用方负责校验）
   * @param note 本次变更说明（可选，写入历史）
   * @param source manual=显式保存 / auto=自动兜底
   */
  save(name: string, type: string, code: string, note = '', source: 'manual' | 'auto' = 'manual'): VaultSaveResult {
    this.assertSafeName(name)
    this.ensureRoot()

    const main = this.mainPath(name)
    const history = this.historyPath(name)
    const now = new Date().toISOString()

    // 已有主题 → 版本 +1；新主题 → v1
    const existed = fs.existsSync(main)
    const entries = this.readIndex()
    const existing = entries.find((e) => e.name === name)
    const version = existed && existing ? existing.version + 1 : 1

    // 写主文件（当前活跃版）
    const trimmed = code.replace(/^\s*\n/, '').replace(/\s+$/, '') + '\n'
    this.atomicWrite(main, trimmed)

    // 追加历史段
    const historyBlock = [
      '',
      `## v${version} · ${now.slice(0, 10)} ${now.slice(11, 16)}`,
      ...(note ? [note] : []),
      '```mermaid',
      trimmed.trimEnd(),
      '```',
      '',
    ].join('\n')
    const historyContent = existed && fs.existsSync(history)
      ? fs.readFileSync(history, 'utf8') + historyBlock
      : `# ${name} 演进历史\n\n自动生成，勿手改。\n${historyBlock}`
    this.atomicWrite(history, historyContent)

    // 刷新索引
    const lines = trimmed.split('\n').filter((l) => l.trim() !== '').length
    const next: VaultIndexEntry[] = [
      ...entries.filter((e) => e.name !== name),
      { name, type, version, updatedAt: now, lines, source },
    ]
    this.writeIndex(next)

    // 裁剪历史（保留最近 maxVersions 段）
    this.pruneHistory(name, history)

    return { name, version, created: !existed, note }
  }

  /** 裁剪历史文件：只保留最近 maxVersions 个版本段。 */
  private pruneHistory(name: string, historyPath: string): void {
    const max = this.options.maxVersions ?? 20
    if (!fs.existsSync(historyPath)) return
    const raw = fs.readFileSync(historyPath, 'utf8')
    const header = raw.split('## v')[0] ?? ''
    const blocks = raw.split('\n## v').slice(1) // 每个块以 '## v' 开头（去掉前缀后重新拼）
    if (blocks.length <= max) return
    const kept = blocks.slice(blocks.length - max)
    const content = header + '\n## v' + kept.join('\n## v')
    this.atomicWrite(historyPath, content)
  }

  /** 列出图库索引（可选过滤）。 */
  list(filter?: { type?: string; source?: 'manual' | 'auto' }): VaultIndexEntry[] {
    this.ensureRoot()
    let entries = this.readIndex()
    if (filter?.type) entries = entries.filter((e) => e.type === filter.type)
    if (filter?.source) entries = entries.filter((e) => e.source === filter.source)
    return entries
  }

  /** 读取某主题：当前活跃版 + 演进历史。 */
  read(name: string): VaultReadResult {
    this.assertSafeName(name)
    this.ensureRoot()
    const main = this.mainPath(name)
    if (!fs.existsSync(main)) {
      throw new Error(`图库中没有主题 "${name}"（可用 mermaid_vault_list 查看）`)
    }
    const code = fs.readFileSync(main, 'utf8')
    const history = fs.existsSync(this.historyPath(name))
      ? fs.readFileSync(this.historyPath(name), 'utf8')
      : ''
    const entry = this.readIndex().find((e) => e.name === name)
    return {
      name,
      type: entry?.type ?? '',
      version: entry?.version ?? 0,
      code,
      history,
    }
  }

  /** 删除某主题（主文件 + 历史文件 + 索引项）。 */
  delete(name: string): { deleted: boolean } {
    this.assertSafeName(name)
    this.ensureRoot()
    const main = this.mainPath(name)
    const history = this.historyPath(name)
    let deleted = false
    if (fs.existsSync(main)) {
      fs.unlinkSync(main)
      deleted = true
    }
    if (fs.existsSync(history)) fs.unlinkSync(history)
    if (deleted) {
      const entries = this.readIndex().filter((e) => e.name !== name)
      this.writeIndex(entries)
    }
    return { deleted }
  }
}

/** 校验 workspace 路径存在且是目录；返回规范化的绝对路径。 */
export function resolveWorkspace(cwd: string | undefined): string {
  const abs = path.resolve(cwd ?? process.cwd())
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`workspace 目录不存在：${abs}`)
  }
  return abs
}
