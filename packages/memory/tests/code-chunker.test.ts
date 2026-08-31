import { describe, it, expect } from 'vitest'
import { splitCode } from '../src/knowledge/code-chunker.js'

describe('splitCode', () => {
  it('空文件返回单 chunk', () => {
    const chunks = splitCode('')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.symbolNames).toEqual([])
  })

  it('无定义行的文件作为一个 chunk', () => {
    const content = `import { foo } from 'bar'
const x = 1
console.log(x)`
    const chunks = splitCode(content)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.symbolNames).toEqual([])
  })

  it('按 TypeScript function 切分', () => {
    const content = `import { x } from 'y'

function hello() {
  return 'hello'
}

function world() {
  return 'world'
}`
    const chunks = splitCode(content)
    expect(chunks.length).toBe(2)
    expect(chunks[0]!.symbolNames).toContain('hello')
    expect(chunks[1]!.symbolNames).toContain('world')
    // 第一个 chunk 包含 preamble（import）
    expect(chunks[0]!.content).toContain("import { x } from 'y'")
  })

  it('按 Python def 切分', () => {
    const content = `# Module docstring

def foo():
    pass

def bar():
    pass`
    const chunks = splitCode(content)
    expect(chunks.length).toBe(2)
    expect(chunks[0]!.symbolNames).toContain('foo')
    expect(chunks[1]!.symbolNames).toContain('bar')
    // preamble 合并到第一个 chunk
    expect(chunks[0]!.content).toContain('# Module docstring')
  })

  it('按 class 切分', () => {
    const content = `export class Foo {
  doSomething() {
    return 1
  }
}

export class Bar {
  doSomething() {
    return 2
  }
}`
    const chunks = splitCode(content)
    // class + 内部 method 都会被识别为定义行，所以 chunk 数 >= 2
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // 所有 chunk 的符号名合集应包含 Foo 和 Bar
    const allSymbols = chunks.flatMap((c) => c.symbolNames)
    expect(allSymbols).toContain('Foo')
    expect(allSymbols).toContain('Bar')
  })

  it('记录行号', () => {
    const content = `function a() {}
function b() {}
function c() {}`
    const chunks = splitCode(content)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]!.startLine).toBe(0)
    expect(chunks[1]!.startLine).toBe(1)
    expect(chunks[2]!.startLine).toBe(2)
  })

  it('Go func 定义', () => {
    const content = `package main

func main() {
  fmt.Println("hello")
}

func helper() {
  // helper
}`
    const chunks = splitCode(content)
    expect(chunks.length).toBe(2)
    expect(chunks[0]!.symbolNames).toContain('main')
    expect(chunks[1]!.symbolNames).toContain('helper')
  })

  it('Rust fn 定义', () => {
    const content = `fn main() {
    println!("hello");
}

pub fn helper() -> i32 {
    42
}`
    const chunks = splitCode(content)
    expect(chunks.length).toBe(2)
    expect(chunks[0]!.symbolNames).toContain('main')
    expect(chunks[1]!.symbolNames).toContain('helper')
  })
})
