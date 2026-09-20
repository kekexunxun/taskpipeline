/**
 * 抽取层共享工具。
 *
 * tree-sitter 是纯语法层，这里把各语言的 AST 归一到 ExtractedSymbol。
 * JS/TS/TSX 共用一套（TS 节点类型在 JS 源码里天然不出现，是安全超集），见 extractJsLike。
 */

import type { ASTNode, ExtractedSymbol, ImportInfo, Language, SymbolKind } from '../types.js'

/**
 * web-tree-sitter 0.25 的 Node 没有 namedChildrenOfType 方法，用 namedChildren 过滤替代。
 * 各 extractor 统一走这里，避免运行期 `is not a function`。
 */
export function namedChildrenOf(node: ASTNode | null | undefined, type: string): ASTNode[] {
  if (!node) return []
  return Array.from(node.namedChildren).filter((c) => c.type === type)
}

/** 声明类节点集合（顶层与方法体内都可能）。 */
const FUNCTION_NODE_TYPES = new Set(['function_declaration', 'generator_function_declaration', 'function_expression'])
const CLASS_NODE_TYPES = new Set(['class_declaration', 'class', 'abstract_class_declaration'])

/** 生成一行签名：取声明头（到第一个 `{` 或换行），截断。 */
export function headSignature(node: ASTNode, max = 160): string | undefined {
  const text = node.text
  if (!text) return undefined
  let cut = text.length
  const brace = text.indexOf('{')
  const nl = text.indexOf('\n')
  const stop = [brace, nl].filter((i) => i >= 0)
  if (stop.length) cut = Math.min(...stop)
  const sig = text.slice(0, cut).replace(/\s+/g, ' ').trim()
  if (!sig) return undefined
  return sig.length > max ? sig.slice(0, max - 1) + '…' : sig
}

function isArrowOrFn(node: ASTNode | null): boolean {
  if (!node) return false
  return node.type === 'arrow_function' || node.type === 'function_expression' || FUNCTION_NODE_TYPES.has(node.type)
}

/** const 绑到字面量（原始值）才算常量；绑到调用/表达式（如 ref()/withDefaults()）视作变量。 */
const CONSTANT_LITERAL_TYPES = new Set(['number', 'string', 'true', 'false', 'null', 'undefined'])
function isConstantLiteral(value: ASTNode | null): boolean {
  if (!value) return false
  if (CONSTANT_LITERAL_TYPES.has(value.type)) return true
  // 负数/一元、字符串拼接的纯字面量不做深入判定，保守归变量。
  return false
}

/** 从 variable_declarator 的 name 字段收集绑定标识符（含解构）。 */
function collectBindingNames(nameNode: ASTNode, out: Array<{ name: string; col: number }>): void {
  if (!nameNode) return
  switch (nameNode.type) {
    case 'identifier':
    case 'shorthand_property_identifier_pattern':
      out.push({ name: nameNode.text, col: nameNode.startPosition.column })
      return
    case 'pair': {
      // { a: x } → 绑定名取 value 侧
      const val = nameNode.childForFieldName('value')
      if (val) collectBindingNames(val, out)
      return
    }
    default: {
      for (const c of nameNode.namedChildren) collectBindingNames(c, out)
    }
  }
}

/** 计算方法/字段的可见性（TS/Java 风格 accessibility modifier）。 */
function visibilityOf(node: ASTNode): ExtractedSymbol['visibility'] {
  for (const c of node.children) {
    if (c.type === 'accessibility_modifier') {
      const t = c.text
      if (t.includes('private')) return 'private'
      if (t.includes('protected')) return 'protected'
      return 'public'
    }
  }
  return undefined
}

function mk(p: {
  kind: SymbolKind
  name: string
  qualifiedName?: string
  relPath: string
  language: Language
  node: ASTNode
  signature?: string
  visibility?: ExtractedSymbol['visibility']
  exported?: boolean
  extra?: Record<string, unknown>
}): ExtractedSymbol {
  return {
    kind: p.kind,
    name: p.name,
    qualifiedName: p.qualifiedName,
    filePath: p.relPath,
    language: p.language,
    startLine: p.node.startPosition.row + 1,
    startCol: p.node.startPosition.column,
    endLine: p.node.endPosition.row + 1,
    endCol: p.node.endPosition.column,
    signature: p.signature,
    visibility: p.visibility,
    exported: p.exported,
    extra: p.extra
  }
}

/** 收集 interface_body 的成员为 property 符号（支撑 defineProps<Interface>() 引用型成员落地）。 */
function collectInterfaceMembers(
  ifaceNode: ASTNode,
  ifaceName: string,
  relPath: string,
  language: Language,
  exported: boolean,
  out: ExtractedSymbol[]
): void {
  const body = namedChildrenOf(ifaceNode, 'interface_body')[0] ?? namedChildrenOf(ifaceNode, 'object_type')[0]
  if (!body) return
  for (const m of body.namedChildren) {
    if (m.type !== 'property_signature' && m.type !== 'method_signature') continue
    const nameNode =
      m.childForFieldName('name') ?? namedChildrenOf(m, 'property_identifier')[0] ?? namedChildrenOf(m, 'identifier')[0]
    if (!nameNode) continue
    out.push(
      mk({
        kind: 'property',
        name: nameNode.text,
        qualifiedName: `${ifaceName}.${nameNode.text}`,
        relPath,
        language,
        node: m,
        signature: headSignature(m),
        exported
      })
    )
  }
}

/** 收集 class_body 的方法与字段。 */
function collectClassMembers(
  classNode: ASTNode,
  className: string,
  relPath: string,
  language: Language,
  exported: boolean,
  out: ExtractedSymbol[]
): void {
  const body =
    classNode.childForFieldName('body') ??
    namedChildrenOf(classNode, 'class_body')[0] ??
    namedChildrenOf(classNode, 'object_type')[0]
  if (!body) return
  for (const m of body.namedChildren) {
    switch (m.type) {
      case 'method_definition':
      case 'function_signature': {
        const nameNode = m.childForFieldName('name')
        if (!nameNode || (nameNode.type !== 'property_identifier' && nameNode.type !== 'identifier')) continue
        out.push(
          mk({
            kind: 'method',
            name: nameNode.text,
            qualifiedName: `${className}.${nameNode.text}`,
            relPath,
            language,
            node: m,
            signature: headSignature(m),
            visibility: visibilityOf(m),
            exported
          })
        )
        break
      }
      case 'field_definition':
      case 'property_definition': {
        const nameNode = m.childForFieldName('name') ?? namedChildrenOf(m, 'property_identifier')[0]
        if (!nameNode) continue
        const value = m.childForFieldName('value')
        const kind: SymbolKind = isArrowOrFn(value) ? 'method' : 'field'
        out.push(
          mk({
            kind,
            name: nameNode.text,
            qualifiedName: `${className}.${nameNode.text}`,
            relPath,
            language,
            node: m,
            signature: headSignature(m),
            visibility: visibilityOf(m),
            exported
          })
        )
        break
      }
    }
  }
}

/** 处理一个 lexical/variable_declaration 的 declarators。 */
function collectDeclarators(
  decl: ASTNode,
  relPath: string,
  language: Language,
  exported: boolean,
  out: ExtractedSymbol[]
): void {
  const isConst = decl.children.some((c) => c.type === 'const')
  for (const d of namedChildrenOf(decl, 'variable_declarator')) {
    const nameNode = d.childForFieldName('name')
    const value = d.childForFieldName('value')
    const binds: Array<{ name: string; col: number }> = []
    if (nameNode) collectBindingNames(nameNode, binds)
    for (const b of binds) {
      if (!b.name || b.name === '_') continue
      const kind: SymbolKind = isArrowOrFn(value)
        ? 'function'
        : isConst && isConstantLiteral(value)
          ? 'constant'
          : 'variable'
      out.push({
        kind,
        name: b.name,
        qualifiedName: b.name,
        filePath: relPath,
        language,
        startLine: decl.startPosition.row + 1,
        startCol: b.col,
        endLine: decl.endPosition.row + 1,
        endCol: decl.endPosition.column,
        signature: value ? headSignature(value) : headSignature(d),
        exported
      })
    }
  }
}

function collectEnumMembers(
  enumNode: ASTNode,
  enumName: string,
  relPath: string,
  language: Language,
  out: ExtractedSymbol[]
): void {
  const body = namedChildrenOf(enumNode, 'enum_body')[0]
  if (!body) return
  for (const mem of body.namedChildren) {
    const idn = mem.type === 'identifier' ? mem : mem.childForFieldName('name')
    if (idn && idn.type === 'identifier') {
      out.push(
        mk({
          kind: 'enum_member',
          name: idn.text,
          qualifiedName: `${enumName}.${idn.text}`,
          relPath,
          language,
          node: mem
        })
      )
    }
  }
}

/** 处理单个顶层语句（可能被 export_statement 包裹）。 */
function handleStatement(
  node: ASTNode,
  relPath: string,
  language: Language,
  out: ExtractedSymbol[],
  imports: ImportInfo[],
  exported: boolean
): void {
  switch (node.type) {
    case 'export_statement': {
      const src = node.childForFieldName('source')
      if (src) {
        // export ... from './x' → 视作 import 边（re-export）
        imports.push({ module: stripQuotes(src.text), names: [], line: node.startPosition.row + 1 })
      }
      const decl =
        node.childForFieldName('declaration') ??
        node.namedChildren.find(
          (c) => c.type.endsWith('_declaration') || CLASS_NODE_TYPES.has(c.type) || FUNCTION_NODE_TYPES.has(c.type)
        )
      if (decl) handleStatement(decl, relPath, language, out, imports, true)
      // export default function/class 直接命名
      return
    }
    case 'import_statement': {
      collectJsImport(node, imports)
      return
    }
    case 'function_declaration':
    case 'generator_function_declaration': {
      const nameNode = node.childForFieldName('name')
      if (!nameNode) return
      out.push(
        mk({ kind: 'function', name: nameNode.text, relPath, language, node, signature: headSignature(node), exported })
      )
      return
    }
    case 'class_declaration':
    case 'abstract_class_declaration': {
      const nameNode = node.childForFieldName('name')
      if (!nameNode) return
      out.push(
        mk({ kind: 'class', name: nameNode.text, relPath, language, node, signature: headSignature(node), exported })
      )
      collectClassMembers(node, nameNode.text, relPath, language, exported, out)
      return
    }
    case 'interface_declaration': {
      const nameNode = node.childForFieldName('name')
      if (!nameNode) return
      out.push(
        mk({
          kind: 'interface',
          name: nameNode.text,
          relPath,
          language,
          node,
          signature: headSignature(node),
          exported
        })
      )
      collectInterfaceMembers(node, nameNode.text, relPath, language, exported, out)
      return
    }
    case 'type_alias_declaration': {
      const nameNode = node.childForFieldName('name')
      if (!nameNode) return
      out.push(
        mk({
          kind: 'type_alias',
          name: nameNode.text,
          relPath,
          language,
          node,
          signature: headSignature(node),
          exported
        })
      )
      return
    }
    case 'enum_declaration': {
      const nameNode = node.childForFieldName('name')
      if (!nameNode) return
      out.push(mk({ kind: 'enum', name: nameNode.text, relPath, language, node, exported }))
      collectEnumMembers(node, nameNode.text, relPath, language, out)
      return
    }
    case 'module': // TS namespace/module
    case 'internal_module': {
      const nameNode = node.childForFieldName('name')
      if (nameNode) out.push(mk({ kind: 'namespace', name: nameNode.text, relPath, language, node, exported }))
      return
    }
    case 'lexical_declaration':
    case 'variable_declaration': {
      collectDeclarators(node, relPath, language, exported, out)
      return
    }
  }
}

function collectJsImport(node: ASTNode, imports: ImportInfo[]): void {
  const src = node.childForFieldName('source')
  if (!src) return
  const module = stripQuotes(src.text)
  const line = node.startPosition.row + 1
  const names: string[] = []
  let alias: string | undefined
  const clause = namedChildrenOf(node, 'import_clause')[0]
  if (clause) {
    for (const c of clause.namedChildren) {
      if (c.type === 'identifier')
        alias = c.text // default import local name
      else if (c.type === 'named_imports') {
        for (const spec of namedChildrenOf(c, 'import_specifier')) {
          const imported = spec.childForFieldName('name')
          if (imported) names.push(imported.text)
        }
      } else if (c.type === 'namespace_import') {
        const id = namedChildrenOf(c, 'identifier')[0]
        alias = id ? id.text : '*'
      }
    }
  }
  imports.push({ module, names, alias, line })
}

export function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '')
}

/**
 * JS / TS / TSX 通用抽取。relPath 写进 symbol.filePath，行列为整文件 1-based。
 * @param programNode JS 用 rootNode 的 program 节点，或直接传含 statements 的节点。
 */
export function extractJsLike(
  programNode: ASTNode,
  relPath: string,
  language: Language
): { symbols: ExtractedSymbol[]; imports: ImportInfo[] } {
  const symbols: ExtractedSymbol[] = []
  const imports: ImportInfo[] = []
  const body =
    programNode.type === 'program' ? programNode : (namedChildrenOf(programNode, 'program')[0] ?? programNode)
  for (const stmt of body.children) {
    handleStatement(stmt, relPath, language, symbols, imports, false)
  }
  return { symbols, imports }
}

export { CLASS_NODE_TYPES, FUNCTION_NODE_TYPES }
