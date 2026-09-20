/**
 * Python 抽取器。
 *
 * tree-sitter-python 关键节点：module / function_definition / class_definition /
 * decorated_definition（装饰器包裹）/ expression_statement→assignment /
 * import_statement / import_from_statement。函数/类体是缩进的 `block` 节点。
 */

import type {
  ExtractInput,
  ExtractedSymbol,
  Extractor,
  ExtractResult,
  ImportInfo,
  ParserBackend,
  SymbolKind
} from '../types.js'
import { namedChildrenOf } from './base.js'

function line(node: { startPosition: { row: number }; endPosition: { row: number } }): [number, number] {
  return [node.startPosition.row + 1, node.endPosition.row + 1]
}
function headSignature(text: string, max = 160): string | undefined {
  const first = text.split('\n')[0] ?? ''
  const cut = first.replace(/:\s*$/, '').trim()
  return cut ? (cut.length > max ? cut.slice(0, max - 1) + '…' : cut) : undefined
}
function collectTargets(node: any, out: string[]): void {
  if (!node) return
  switch (node.type) {
    case 'identifier':
      out.push(node.text)
      return
    case 'pattern_list':
    case 'tuple_pattern':
    case 'expression_list':
      for (const c of node.namedChildren) collectTargets(c, out)
      return
    case 'attribute':
      return // self.x = ... 不作为符号
    default:
      for (const c of node.namedChildren ?? []) collectTargets(c, out)
  }
}

export class PythonExtractor implements Extractor {
  readonly language = 'python' as const
  constructor(private readonly backend: ParserBackend) {}

  extract(input: ExtractInput): ExtractResult {
    const tree = this.backend.parse(input.content, 'python')
    const symbols: ExtractedSymbol[] = []
    const imports: ImportInfo[] = []
    this.walk(tree.rootNode, input.relPath, null, symbols, imports)
    return { symbols, imports, hadParseError: tree.rootNode.hasError }
  }

  private decoratorsOf(node: any): string[] {
    const list = namedChildrenOf(node, 'decorator')
    return list.map((d: any) => (d.text || '').replace(/^@/, '').split('(')[0].trim()).filter(Boolean)
  }

  private walk(
    container: any,
    relPath: string,
    className: string | null,
    out: ExtractedSymbol[],
    imports: ImportInfo[]
  ): void {
    if (!container) return
    const stmts =
      container.type === 'module' || container.type === 'block' ? container.children : container.namedChildren
    for (const node of stmts ?? []) {
      if (!node) continue
      switch (node.type) {
        case 'function_definition': {
          const nameNode = node.childForFieldName?.('name')
          if (!nameNode) break
          const isAsync = node.children.some((c: any) => c.type === 'async')
          const decorators = this.decoratorsOf(node.parent ?? node)
          out.push({
            kind: className ? 'method' : 'function',
            name: nameNode.text,
            qualifiedName: className ? `${className}.${nameNode.text}` : nameNode.text,
            filePath: relPath,
            language: 'python',
            startLine: line(node)[0],
            startCol: node.startPosition.column,
            endLine: line(node)[1],
            endCol: node.endPosition.column,
            signature: headSignature(node.text.split('\n')[0]),
            extra: { ...(isAsync ? { async: true } : {}), ...(decorators.length ? { decorators } : {}) }
          })
          const body = node.childForFieldName?.('body')
          this.walk(body, relPath, className, out, imports)
          break
        }
        case 'class_definition': {
          const nameNode = node.childForFieldName?.('name')
          if (!nameNode) break
          const [sl, el] = line(node)
          const decorators = this.decoratorsOf(node.parent ?? node)
          out.push({
            kind: 'class',
            name: nameNode.text,
            qualifiedName: nameNode.text,
            filePath: relPath,
            language: 'python',
            startLine: sl,
            startCol: node.startPosition.column,
            endLine: el,
            endCol: node.endPosition.column,
            signature: headSignature(node.text.split('\n')[0]),
            exported: !nameNode.text.startsWith('_'),
            extra: decorators.length ? { decorators } : undefined
          })
          const body = node.childForFieldName?.('body')
          this.walk(body, relPath, nameNode.text, out, imports)
          break
        }
        case 'decorated_definition': {
          const inner = node.namedChildren?.find(
            (c: any) => c.type === 'function_definition' || c.type === 'class_definition'
          )
          if (inner) this.walk({ type: 'block', children: [inner] }, relPath, className, out, imports)
          break
        }
        case 'expression_statement': {
          for (const child of node.namedChildren ?? []) {
            if (child.type === 'assignment') this.assignment(child, relPath, className, out)
          }
          break
        }
        case 'assignment':
          this.assignment(node, relPath, className, out)
          break
        case 'import_statement': {
          for (const t of namedChildrenOf(node, 'dotted_name'))
            imports.push({ module: t.text, names: [], line: line(node)[0] })
          for (const a of namedChildrenOf(node, 'aliased_import')) {
            const d = namedChildrenOf(a, 'dotted_name')[0]
            if (d)
              imports.push({
                module: d.text,
                alias: a.childForFieldName?.('alias')?.text,
                names: [],
                line: line(node)[0]
              })
          }
          break
        }
        case 'import_from_statement': {
          const mod =
            node.childForFieldName?.('module_name') ??
            namedChildrenOf(node, 'dotted_name')[0] ??
            namedChildrenOf(node, 'relative_import')[0]
          const names: string[] = []
          for (const n of namedChildrenOf(node, 'dotted_name').slice(1)) names.push(n.text)
          for (const n of namedChildrenOf(node, 'identifier')) if (n !== mod) names.push(n.text)
          for (const al of namedChildrenOf(node, 'aliased_import')) {
            const d = namedChildrenOf(al, 'dotted_name')[0] ?? al.childForFieldName?.('name')
            if (d) names.push(d.text)
          }
          const wildcard = node.children?.some((c: any) => c.type === 'wildcard_import')
          imports.push({ module: mod ? mod.text : '', names: wildcard ? ['*'] : names, line: line(node)[0] })
          break
        }
        case 'future_import_statement':
          break
      }
    }
  }

  private assignment(node: any, relPath: string, className: string | null, out: ExtractedSymbol[]): void {
    const left = node.childForFieldName?.('left')
    const value = node.childForFieldName?.('right')
    const names: string[] = []
    if (left) collectTargets(left, names)
    for (const name of names) {
      if (!name || name === '_') continue
      let kind: SymbolKind
      if (value && (value.type === 'lambda' || /lambda\b/.test(value.text ?? ''))) kind = 'function'
      else if (!className && /^[A-Z][A-Z0-9_]*$/.test(name)) kind = 'constant'
      else kind = className ? 'field' : 'variable'
      const [sl, el] = line(node)
      out.push({
        kind,
        name,
        qualifiedName: className ? `${className}.${name}` : name,
        filePath: relPath,
        language: 'python',
        startLine: sl,
        startCol: node.startPosition.column,
        endLine: el,
        endCol: node.endPosition.column,
        signature: value ? headSignature(value.text) : undefined,
        exported: !name.startsWith('_')
      })
    }
  }
}
