/**
 * grammar 与文件类型的映射，以及 .wasm 路径解析。
 *
 * 解析策略（按优先级）：
 *  1. 调用方显式注入的 runtimeWasmPath / grammarsDir（Electron 打包后随包分发的位置）。
 *  2. 通过 createRequire 从 node_modules 里解析 web-tree-sitter / tree-sitter-wasms 的安装目录。
 * 这样包在纯 Node（vitest）与 Electron（打包）两种环境都能定位到 wasm，且不写死绝对路径。
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import type { Language } from '../types.js'

const require = createRequire(import.meta.url)

/** grammar 名（对应 tree-sitter-wasms/out/tree-sitter-<grammar>.wasm）。 */
export type GrammarName = 'javascript' | 'typescript' | 'tsx' | 'vue' | 'python' | 'java' | 'php'

const EXTENSION_MAP: Record<string, { language: Language; grammar: GrammarName }> = {
  '.js': { language: 'javascript', grammar: 'javascript' },
  '.jsx': { language: 'javascript', grammar: 'javascript' },
  '.mjs': { language: 'javascript', grammar: 'javascript' },
  '.cjs': { language: 'javascript', grammar: 'javascript' },
  '.ts': { language: 'typescript', grammar: 'typescript' },
  '.mts': { language: 'typescript', grammar: 'typescript' },
  '.cts': { language: 'typescript', grammar: 'typescript' },
  '.tsx': { language: 'tsx', grammar: 'tsx' },
  '.vue': { language: 'vue', grammar: 'vue' },
  '.py': { language: 'python', grammar: 'python' },
  '.pyi': { language: 'python', grammar: 'python' },
  '.java': { language: 'java', grammar: 'java' },
  '.php': { language: 'php', grammar: 'php' }
}

/** 受支持的可索引扩展名集合（discover 用它做准入过滤）。 */
export const SUPPORTED_EXTENSIONS = new Set(Object.keys(EXTENSION_MAP))

export function resolveByExtension(ext: string): { language: Language; grammar: GrammarName } | null {
  return EXTENSION_MAP[ext.toLowerCase()] ?? null
}

/** 语言 → 主 grammar（vue 的主 grammar 是 vue，脚本块另行按 lang 选 ts/js）。 */
export function grammarForLanguage(language: Language): GrammarName {
  switch (language) {
    case 'javascript':
      return 'javascript'
    case 'typescript':
      return 'typescript'
    case 'tsx':
      return 'tsx'
    case 'vue':
      return 'vue'
    case 'python':
      return 'python'
    case 'java':
      return 'java'
    case 'php':
      return 'php'
  }
}

/**
 * 索引一个文件前需要预加载的 grammar 集合（extractor 保持同步、由 indexer 统一 ensure）。
 * vue 是混合式：模板用 vue grammar，脚本按 lang 走 ts/js/tsx，故一次性备齐常见脚本 grammar。
 */
export function grammarsForLanguage(language: Language): GrammarName[] {
  switch (language) {
    case 'vue':
      return ['vue', 'typescript', 'javascript', 'tsx']
    case 'typescript':
      return ['typescript']
    case 'tsx':
      return ['tsx']
    case 'javascript':
      return ['javascript']
    case 'python':
      return ['python']
    case 'java':
      return ['java']
    case 'php':
      return ['php']
  }
}

/** <script lang="..."> → 脚本 grammar。默认按 TypeScript 处理（vue3 setup 主流）。 */
export function grammarForVueScript(lang: string | undefined, hasGeneric = false): GrammarName {
  switch ((lang ?? 'ts').toLowerCase()) {
    case 'js':
    case 'javascript':
      return 'javascript'
    case 'jsx':
      return 'javascript'
    case 'tsx':
      return 'tsx'
    case 'ts':
    case 'typescript':
    default:
      // 纯 TS 脚本用 typescript grammar；若含 JSX（少见）应改走 tsx，由调用方探测。
      void hasGeneric
      return 'typescript'
  }
}

export interface WasmPaths {
  runtimeWasmPath: string
  grammarWasmPath: Record<GrammarName, string>
}

function resolveInstalledDir(spec: string): string | null {
  try {
    // 解析 <pkg>/package.json（许多包在 exports 里放行 ./package.json），取其所在目录。
    return dirname(require.resolve(`${spec}/package.json`))
  } catch {
    try {
      return dirname(require.resolve(spec))
    } catch {
      return null
    }
  }
}

/**
 * 解析 runtime wasm 与各 grammar wasm 的磁盘路径。
 * @param override 允许注入显式目录（Electron 打包场景）。
 */
export function resolveWasmPaths(override?: { runtimeWasmPath?: string; grammarsDir?: string }): WasmPaths {
  const grammarNames: GrammarName[] = ['javascript', 'typescript', 'tsx', 'vue', 'python', 'java', 'php']

  let grammarsDir = override?.grammarsDir ?? ''
  if (!grammarsDir) {
    const wasmsPkgDir = resolveInstalledDir('tree-sitter-wasms')
    if (wasmsPkgDir) grammarsDir = join(wasmsPkgDir, 'out')
  }
  if (!grammarsDir) throw new Error('[codeindex] 无法定位 tree-sitter-wasms/out 目录，请通过 grammarsDir 注入。')

  let runtimeWasmPath = override?.runtimeWasmPath ?? ''
  if (!runtimeWasmPath) {
    const webTsDir = resolveInstalledDir('web-tree-sitter')
    if (webTsDir) {
      for (const cand of [join(webTsDir, 'tree-sitter.wasm'), join(webTsDir, 'lib', 'tree-sitter.wasm')]) {
        if (existsSync(cand)) {
          runtimeWasmPath = cand
          break
        }
      }
    }
  }
  if (!runtimeWasmPath)
    throw new Error('[codeindex] 无法定位 web-tree-sitter/tree-sitter.wasm，请通过 runtimeWasmPath 注入。')

  const grammarWasmPath = {} as Record<GrammarName, string>
  for (const g of grammarNames) grammarWasmPath[g] = join(grammarsDir, `tree-sitter-${g}.wasm`)

  return { runtimeWasmPath, grammarWasmPath }
}
