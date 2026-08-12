import { readFileSync } from 'node:fs'

const file = process.argv[2]
const range = process.argv[3] ? process.argv[3].split('-').map(Number) : [0, Infinity]
const onlyEnd = process.argv[4] === 'end'
const content = readFileSync(file, 'utf8')
const lines = content.split('\n').filter(Boolean)
const showInput = process.argv[5] === 'input'

for (const l of lines) {
  const r = JSON.parse(l)
  const sp = r.span
  if (sp.sequence < range[0] || sp.sequence > range[1]) continue
  if (onlyEnd && r.op !== 'span_end') continue
  let os = ''
  const out = sp.output
  if (typeof out === 'string') os = out.slice(0, 100).replace(/\n/g, '⏎')
  else if (out && typeof out === 'object') os = '[obj:' + Object.keys(out).join(',') + ']'
  let is = ''
  if (showInput && sp.input !== undefined) {
    is = typeof sp.input === 'string' ? sp.input.slice(0, 80) : JSON.stringify(sp.input).slice(0, 100)
  }
  console.log(
    `seq=${sp.sequence} ${r.op} ${sp.type} ${sp.name} | parent=${sp.parentSpanId ?? '-'} | in:${is} | out:${os}`
  )
}
