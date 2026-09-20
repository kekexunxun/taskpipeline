/**
 * ParserBackend 的 web-tree-sitter (WASM) 实现。
 *
 * 这是全包唯一直接依赖 tree-sitter 运行时/wasm 的地方；未来切换 Rust/NAPI 内核，
 * 只需另写一个实现 ParserBackend 接口的 adapter，其余代码零改动。
 *
 * 注意（Electron 主进程）：调用方需在 app ready 前设 `--js-flags=--liftoff-only`
 * 以防 V8 WASM Zone OOM。本包不擅自设 flag（headless/Node 无此问题）。
 */

import type { ASTNode, ParserBackend, ParsedTree } from '../types.js'
import { resolveWasmPaths, type GrammarName } from './grammars.js'

// web-tree-sitter 0.25：具名导出 Parser / Language。用 dynamic import 保持 ESM 纯净，
// 且延迟到首次 parse 才真正 init（避免包被 import 即拉起 WASM）。
type ParserInstance = {
  setLanguage(lang: unknown): void
  parse(content: string): { rootNode: unknown }
}
type ParserCtor = {
  new (): ParserInstance
  init(options?: Record<string, unknown>): Promise<unknown>
}
type WebTreeSitterModule = {
  Parser: ParserCtor
  Language: { load(path: string): Promise<unknown> }
}

export interface WebTreeSitterBackendOptions {
  runtimeWasmPath?: string
  grammarsDir?: string
}

export class WebTreeSitterBackend implements ParserBackend {
  private readonly wasmPaths: ReturnType<typeof resolveWasmPaths>
  private mod: WebTreeSitterModule | null = null
  private inited = false
  private parser: ParserInstance | null = null
  private readonly languages = new Map<GrammarName, unknown>()
  private readonly failed = new Set<GrammarName>()

  constructor(options?: WebTreeSitterBackendOptions) {
    this.wasmPaths = resolveWasmPaths(options)
  }

  private async loadModule(): Promise<WebTreeSitterModule> {
    if (this.mod) return this.mod
    const m = (await import('web-tree-sitter')) as unknown as WebTreeSitterModule & {
      default?: WebTreeSitterModule
    }
    // CJS/ESM interop：有的构建把类挂在 default 上。
    this.mod = m.Parser ? m : (m.default as WebTreeSitterModule)
    return this.mod
  }

  private async ensureInited(): Promise<WebTreeSitterModule> {
    const mod = await this.loadModule()
    if (!this.inited) {
      const runtimePath = this.wasmPaths.runtimeWasmPath
      try {
        await mod.Parser.init({ locateFile: () => runtimePath } as never)
      } catch {
        // 某些构建不识别 locateFile option：退回默认（wasm 与 JS 同目录兄弟文件）。
        await mod.Parser.init()
      }
      this.inited = true
    }
    return mod
  }

  async ensureLanguage(language: string): Promise<boolean> {
    const grammar = language as GrammarName
    if (this.languages.has(grammar)) return true
    if (this.failed.has(grammar)) return false
    const path = this.wasmPaths.grammarWasmPath[grammar]
    if (!path) {
      this.failed.add(grammar)
      return false
    }
    try {
      const mod = await this.ensureInited()
      const lang = await mod.Language.load(path)
      this.languages.set(grammar, lang)
      return true
    } catch (err) {
      this.failed.add(grammar)

      console.error(`[codeindex] 加载 grammar '${grammar}' 失败:`, (err as Error).message)
      return false
    }
  }

  parse(content: string, language: string): ParsedTree {
    const grammar = language as GrammarName
    const lang = this.languages.get(grammar)
    if (!lang) {
      throw new Error(`[codeindex] grammar '${grammar}' 尚未 ensureLanguage()。`)
    }
    if (!this.parser) this.parser = new (this.mod as WebTreeSitterModule).Parser()
    this.parser.setLanguage(lang)
    const tree = this.parser.parse(content)
    return { rootNode: tree.rootNode as ASTNode }
  }

  dispose(): void {
    this.parser = null
    this.languages.clear()
  }
}
