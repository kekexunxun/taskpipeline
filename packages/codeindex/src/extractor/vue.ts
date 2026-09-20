/**
 * Vue SFC 抽取器 —— 混合式（Phase 0.5 实测坐定，见 docs/codeindex-vue-grammar-findings.md）。
 *
 *  - 脚本符号：`@vue/compiler-sfc` 拆 `<script>`/`<script setup>` 块 → 内容喂 TS/JS grammar，
 *    复用 extractJsLike；行坐标按 block.loc.start.line 偏移还原到整文件（实测 99.9% 正确）。
 *  - defineProps<T>() / defineEmits<T>()：从脚本 AST 的调用 + 泛型 type literal / 对象字面量抽成员。
 *  - 模板符号：`tree-sitter-vue` 读 `<template>` 里的组件标签使用（PascalCase 元素）。
 *  - 注意：tree-sitter-vue 把 script 当 raw_text、不解析其内部符号——这正是必须走拆分的根因。
 */

import { parse as parseSFC } from '@vue/compiler-sfc'
import type { ExtractInput, ExtractedSymbol, Extractor, ExtractResult, ImportInfo, ParserBackend } from '../types.js'
import { grammarForVueScript, type GrammarName } from '../backend/grammars.js'
import { extractJsLike, namedChildrenOf } from './base.js'

interface SFCBlockLike {
  content: string
  lang?: string
  setup?: boolean
  loc: { start: { line: number; column: number }; end: { line: number; column: number } }
}

const BUILTIN_TEMPLATE_TAGS = new Set([
  'template',
  'slot',
  'component',
  'transition',
  'transition-group',
  'keep-alive',
  'teleport',
  'suspense',
  'router-view',
  'router-link',
  'nuxt-link',
  'fragment'
])

export class VueExtractor implements Extractor {
  readonly language = 'vue' as const
  constructor(private readonly backend: ParserBackend) {}

  extract(input: ExtractInput): ExtractResult {
    const symbols: ExtractedSymbol[] = []
    const imports: ImportInfo[] = []
    let hadParseError = false

    // ── 脚本块：compiler-sfc 拆分 ──────────────────────────────────────────
    let descriptor
    try {
      descriptor = parseSFC(input.content, { filename: input.absPath }).descriptor
    } catch {
      hadParseError = true
      descriptor = undefined
    }
    const blocks: SFCBlockLike[] = []
    const setup = descriptor?.scriptSetup as SFCBlockLike | undefined
    const normal = descriptor?.script as SFCBlockLike | undefined
    if (normal) blocks.push(normal)
    if (setup) blocks.push(setup)

    for (const block of blocks) {
      const grammar: GrammarName = grammarForVueScript(block.lang, /generic\s*=/.test(block.content))
      let scriptSymbols: ExtractedSymbol[]
      let scriptImports: ImportInfo[]
      try {
        const tree = this.backend.parse(block.content, grammar)
        const r = extractJsLike(tree.rootNode, input.relPath, 'vue')
        scriptSymbols = r.symbols
        scriptImports = r.imports
        if (tree.rootNode.hasError) hadParseError = true
        // defineProps / defineEmits 宏成员
        symbols.push(...this.extractMacros(tree.rootNode, input.relPath, block))
      } catch {
        hadParseError = true
        continue
      }
      const lineOffset = block.loc.start.line - 1 // 内容第 1 行 ↔ 文件第 block.loc.start.line 行
      for (const s of scriptSymbols) {
        symbols.push({
          ...s,
          startLine: s.startLine + lineOffset,
          endLine: Math.max(s.startLine + lineOffset, s.endLine + lineOffset),
          extra: { ...s.extra, vue_block: block.setup ? 'script-setup' : 'script' }
        })
      }
      for (const imp of scriptImports) imports.push({ ...imp, line: imp.line + lineOffset })
    }

    // ── 模板块：vue grammar 读组件使用 ────────────────────────────────────
    try {
      const vtree = this.backend.parse(input.content, 'vue')
      symbols.push(...this.extractTemplateComponents(vtree.rootNode, input.relPath))
      if (vtree.rootNode.hasError) hadParseError = true
    } catch {
      hadParseError = true
    }

    return { symbols, imports, hadParseError }
  }

  private extractMacros(root: any, relPath: string, block: SFCBlockLike): ExtractedSymbol[] {
    const out: ExtractedSymbol[] = []
    const lineOffset = block.loc.start.line - 1
    const visit = (node: any): void => {
      if (node.type === 'call_expression') {
        const fn = node.childForFieldName?.('function')
        const fname = fn?.text
        if (fname === 'defineProps' || fname === 'defineEmits') {
          const names = this.macroMemberNames(node)
          for (const m of names) {
            out.push({
              kind: 'property',
              name: m,
              qualifiedName: `${fname === 'defineProps' ? 'props' : 'emits'}.${m}`,
              filePath: relPath,
              language: 'vue',
              startLine: node.startPosition.row + 1 + lineOffset,
              startCol: node.startPosition.column,
              endLine: node.endPosition.row + 1 + lineOffset,
              endCol: node.endPosition.column,
              extra: { macro: fname }
            })
          }
        }
      }
      for (const c of node.children ?? []) visit(c)
    }
    visit(root)
    return out
  }

  private macroMemberNames(callNode: any): string[] {
    const names: string[] = []
    // 类型参数形式：defineProps<{ a: T; b: T }>()
    const typeArgs = callNode.childForFieldName?.('type_arguments')
    const literal =
      (typeArgs ? namedChildrenOf(typeArgs, 'type_literal')[0] : undefined) ?? findFirst(callNode, 'type_literal')
    if (literal) {
      for (const p of namedChildrenOf(literal, 'property_signature')) {
        const n = p.childForFieldName?.('name') ?? namedChildrenOf(p, 'property_identifier')[0]
        if (n) names.push(n.text)
      }
    }
    // 运行时对象形式：defineProps({ a: ..., b: ... })
    const args = callNode.childForFieldName?.('arguments')
    const obj = args ? namedChildrenOf(args, 'object')[0] : undefined
    if (obj) {
      for (const p of namedChildrenOf(obj, 'pair')) {
        const k = p.childForFieldName?.('key') ?? namedChildrenOf(p, 'property_identifier')[0]
        if (k) names.push(k.text)
      }
    }
    return names
  }

  private extractTemplateComponents(root: any, relPath: string): ExtractedSymbol[] {
    const out: ExtractedSymbol[] = []
    const seen = new Set<string>()
    const template = findFirst(root, 'template_element')
    if (!template) return out
    const visit = (node: any): void => {
      if (node.type === 'element' || node.type === 'self_closing_tag') {
        const startTag =
          node.type === 'start_tag' ? node : (findFirst(node, 'start_tag') ?? findFirst(node, 'self_closing_tag'))
        const tagNode = startTag ? findFirst(startTag, 'tag_name') : null
        const tag = tagNode?.text
        if (tag && /^[A-Z]/.test(tag) && !BUILTIN_TEMPLATE_TAGS.has(tag.toLowerCase())) {
          const key = `${tag}@${node.startPosition.row}`
          if (!seen.has(key)) {
            seen.add(key)
            out.push({
              kind: 'component',
              name: tag,
              qualifiedName: tag,
              filePath: relPath,
              language: 'vue',
              startLine: node.startPosition.row + 1,
              startCol: node.startPosition.column,
              endLine: node.endPosition.row + 1,
              endCol: node.endPosition.column,
              extra: { usage: 'template' }
            })
          }
        }
      }
      for (const c of node.namedChildren ?? []) if (c !== node) visit(c)
    }
    visit(template)
    return out
  }
}

function findFirst(node: any, type: string): any | null {
  if (!node) return null
  if (node.type === type) return node
  for (const c of node.children ?? []) {
    const found = findFirst(c, type)
    if (found) return found
  }
  return null
}
