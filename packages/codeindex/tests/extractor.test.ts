import { describe, it, expect, beforeAll } from 'vitest'
import type { ParserBackend } from '../src/types.js'
import { JavaScriptExtractor } from '../src/extractor/javascript.js'
import { TypeScriptExtractor } from '../src/extractor/typescript.js'
import { PythonExtractor } from '../src/extractor/python.js'
import { VueExtractor } from '../src/extractor/vue.js'
import { makeBackend } from './test-utils.js'

let backend: ParserBackend
beforeAll(async () => {
  backend = await makeBackend()
})

type Sym = {
  kind: string
  name: string
  startLine: number
  endLine: number
  qualifiedName?: string
  extra?: Record<string, unknown>
  language?: string
}
type Res = { symbols: Sym[]; imports: Array<{ module: string; names?: string[] }> }

function extract(ex: { extract: (i: never) => unknown }, relPath: string, content: string, language: never): Res {
  return ex.extract({ absPath: '/repo/' + relPath, relPath, content, language } as never) as unknown as Res
}
function names(res: ReturnType<typeof extract>) {
  return new Set(res.symbols.map((s) => s.name))
}
function has(res: ReturnType<typeof extract>, name: string, kind?: string) {
  return res.symbols.some((s) => s.name === name && (!kind || s.kind === kind))
}
/** 行坐标校验：符号名应出现在其 startLine 对应的那一行。 */
function lineHas(content: string, startLine: number, name: string) {
  const line = content.split('\n')[startLine - 1] ?? ''
  return line.includes(name)
}

const TS_SRC = `import { EventEmitter } from 'node:events';
export interface MnsMessage { id: string; }
export type MnsHandler = (m: MnsMessage) => void;
const DEFAULT_TIMEOUT = 30000;
export function buildQueueUrl(a: string): string { return a; }
export class MnsClient extends EventEmitter {
  private readonly timeout: number;
  async sendMessage(q: string): Promise<void> { void q; }
  private sign(p: string): string { return p; }
}
`

const PY_SRC = `from dataclasses import dataclass
MAX_RETRIES = 3

@dataclass
class Record:
    id: str

class ApiClient:
    def __init__(self, host: str):
        self.host = host
    def fetch(self, path: str):
        return []

async def collect(c: ApiClient) -> int:
    return 0
`

const VUE_SRC = `<template>
  <div><UserRow :u="u" @click="onSelect" /><button @click="onSubmit">go</button></div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import UserRow from './UserRow.vue';
interface Props { accountId: string; pageSize?: number; }
const props = withDefaults(defineProps<Props>(), { pageSize: 20 });
const users = ref([]);
async function onSubmit() { void props; }
function onSelect(id: string) { void id; void users; }
</script>
`

describe('TypeScript extractor', () => {
  const ex = () => new TypeScriptExtractor(backend, { language: 'typescript' })
  it('抽取 class/function/interface/type_alias/constant/method', () => {
    const r = extract(ex() as never, 'src/mns.ts', TS_SRC, 'typescript' as never)
    expect(has(r, 'MnsClient', 'class')).toBe(true)
    expect(has(r, 'buildQueueUrl', 'function')).toBe(true)
    expect(has(r, 'MnsMessage', 'interface')).toBe(true)
    expect(has(r, 'MnsHandler', 'type_alias')).toBe(true)
    expect(has(r, 'DEFAULT_TIMEOUT', 'constant')).toBe(true)
    expect(has(r, 'sendMessage', 'method')).toBe(true)
    expect(has(r, 'sign', 'method')).toBe(true)
  })
  it('方法带限定名 Class.method', () => {
    const r = extract(ex() as never, 'src/mns.ts', TS_SRC, 'typescript' as never)
    const sm = r.symbols.find((s) => s.name === 'sendMessage')
    expect(sm?.qualifiedName).toBe('MnsClient.sendMessage')
  })
  it('import 记录 module', () => {
    const r = extract(ex() as never, 'src/mns.ts', TS_SRC, 'typescript' as never)
    expect(r.imports.some((i) => i.module === 'node:events')).toBe(true)
  })
  it('行坐标正确（名字落在报告行上）', () => {
    const r = extract(ex() as never, 'src/mns.ts', TS_SRC, 'typescript' as never)
    for (const s of r.symbols.filter((x) => ['MnsClient', 'buildQueueUrl', 'sendMessage'].includes(x.name))) {
      expect(lineHas(TS_SRC, s.startLine, s.name)).toBe(true)
    }
  })
})

describe('JavaScript (CJS) extractor', () => {
  const JS_SRC = `const helpers = require('./helpers');
function legacyFormat(v) { return String(v); }
class LegacyParser {
  constructor(o) { this.o = o; }
  parse(input) { return legacyFormat(input); }
}
module.exports = { legacyFormat };
`
  it('function + class + method', () => {
    const r = extract(new JavaScriptExtractor(backend) as never, 'src/l.js', JS_SRC, 'javascript' as never)
    expect(has(r, 'legacyFormat', 'function')).toBe(true)
    expect(has(r, 'LegacyParser', 'class')).toBe(true)
    expect(has(r, 'parse', 'method')).toBe(true)
  })
})

describe('TSX extractor', () => {
  it('默认导出组件 + 顶层函数', () => {
    const r = extract(
      new TypeScriptExtractor(backend, { language: 'tsx', grammar: 'tsx' }) as never,
      'src/App.tsx',
      `import { useState } from 'react';
export function useAuth() { return useState(false); }
export default function App() { const [a] = useAuth(); return <div>{a}</div>; }
`,
      'tsx' as never
    )
    expect(has(r, 'useAuth', 'function')).toBe(true)
    expect(has(r, 'App', 'function')).toBe(true)
    expect(names(r).has('useState') === false).toBe(true) // import 名不混入符号
  })
})

describe('Python extractor', () => {
  const r = () => extract(new PythonExtractor(backend) as never, 'src/client.py', PY_SRC, 'python' as never)
  it('class/method/function/constant + 装饰器', () => {
    const res = r()
    expect(has(res, 'ApiClient', 'class')).toBe(true)
    expect(has(res, 'Record', 'class')).toBe(true)
    expect(has(res, 'collect', 'function')).toBe(true)
    expect(has(res, 'MAX_RETRIES', 'constant')).toBe(true)
    expect(has(res, 'fetch', 'method')).toBe(true)
    const rec = res.symbols.find((s) => s.name === 'Record')
    expect(rec?.extra?.decorators as string[] | undefined).toContain('dataclass')
    const collect = res.symbols.find((s) => s.name === 'collect')
    expect(collect?.extra?.async).toBe(true)
  })
  it('from-import 记录模块与名字', () => {
    const res = r()
    const imp = res.imports.find((i) => i.module === 'dataclasses')
    expect(imp?.names).toContain('dataclass')
  })
  it('行坐标正确', () => {
    const res = r()
    for (const s of res.symbols.filter((x) => ['ApiClient', 'collect', 'fetch'].includes(x.name))) {
      expect(lineHas(PY_SRC, s.startLine, s.name)).toBe(true)
    }
  })
})

describe('Vue extractor（混合式）', () => {
  const res = () => extract(new VueExtractor(backend) as never, 'src/UserList.vue', VUE_SRC, 'vue' as never)
  it('脚本符号：onSubmit/onSelect/props 变量', () => {
    const r = res()
    expect(has(r, 'onSubmit', 'function')).toBe(true)
    expect(has(r, 'onSelect', 'function')).toBe(true)
    expect(has(r, 'props', 'variable')).toBe(true)
    expect(has(r, 'Props', 'interface')).toBe(true)
  })
  it('defineProps 宏成员抽出为 property', () => {
    const r = res()
    expect(has(r, 'accountId', 'property')).toBe(true)
    expect(has(r, 'pageSize', 'property')).toBe(true)
  })
  it('模板组件 UserRow', () => {
    const r = res()
    expect(has(r, 'UserRow', 'component')).toBe(true)
  })
  it('行偏移还原到整文件（onSubmit 落在 script 内真实行）', () => {
    const r = res()
    const onSubmit = r.symbols.find((s) => s.name === 'onSubmit')
    expect(onSubmit).toBeTruthy()
    expect(lineHas(VUE_SRC, onSubmit!.startLine, 'onSubmit')).toBe(true)
  })
  it('language 标为 vue', () => {
    expect(res().symbols.every((s) => s.language !== 'typescript')).toBe(true)
  })
})
