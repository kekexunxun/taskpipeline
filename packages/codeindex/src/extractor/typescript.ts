/**
 * TypeScript 抽取器。同一实现覆盖 .ts(typescript grammar) 与 .tsx(tsx grammar)，
 * 差别仅在构造时选择的 grammar / 落库 language 标签。
 */

import type { ExtractInput, Extractor, ExtractResult, Language, ParserBackend } from '../types.js'
import type { GrammarName } from '../backend/grammars.js'
import { extractJsLike } from './base.js'

export class TypeScriptExtractor implements Extractor {
  readonly language: Language
  constructor(
    private readonly backend: ParserBackend,
    opts: { language?: Language; grammar?: GrammarName } = {}
  ) {
    this.language = opts.language ?? 'typescript'
    this.grammar = opts.grammar ?? (this.language === 'tsx' ? 'tsx' : 'typescript')
  }
  private readonly grammar: GrammarName

  extract(input: ExtractInput): ExtractResult {
    const tree = this.backend.parse(input.content, this.grammar)
    const { symbols, imports } = extractJsLike(tree.rootNode, input.relPath, this.language)
    return { symbols, imports, hadParseError: tree.rootNode.hasError }
  }
}
