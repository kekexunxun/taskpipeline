/**
 * JavaScript 抽取器（含 JSX，tree-sitter-javascript 语法天然支持 JSX）。
 */

import type { ExtractInput, Extractor, ExtractResult, ParserBackend } from '../types.js'
import { extractJsLike } from './base.js'

export class JavaScriptExtractor implements Extractor {
  readonly language = 'javascript' as const
  constructor(private readonly backend: ParserBackend) {}

  extract(input: ExtractInput): ExtractResult {
    const tree = this.backend.parse(input.content, 'javascript')
    const { symbols, imports } = extractJsLike(tree.rootNode, input.relPath, this.language)
    return { symbols, imports, hadParseError: tree.rootNode.hasError }
  }
}
