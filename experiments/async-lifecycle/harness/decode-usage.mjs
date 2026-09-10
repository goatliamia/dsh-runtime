// decode-usage.mjs - decode a DSH session log (frame-split zstd) and report the
// token cost per model request. The trace/analysis plugins report trajectory
// and incidents but not cost, so this reads the durable log directly.
//
//   node decode-usage.mjs <session.v3.jsonl.zstd> [label]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Split a frame-appended zstd log on the frame magic and inflate each frame. */
function decodeFrames(buffer) {
  const offsets = []
  let index = buffer.indexOf(MAGIC, 0)
  while (index !== -1) {
    offsets.push(index)
    index = buffer.indexOf(MAGIC, index + MAGIC.length)
  }
  let text = ''
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
    } catch {
      // A non-frame trailing chunk is not a log frame; skip it.
    }
  }
  return text
}

const path = process.argv[2]
const label = process.argv[3] ?? path
const raw = readFileSync(path)
const text = decodeFrames(raw)
const events = text.split('\n').filter((line) => line.trim().length > 0).flatMap((line) => {
  try { return [JSON.parse(line)] } catch { return [] }
})

const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }
const requests = []
let current = null
/** Fold one model response's usage under the request it answered. */
const addUsage = (usage) => {
  if (usage === undefined) return
  if (current === null) {
    current = { turn: null, step: null }
    requests.push(current)
  }
  for (const [key, field] of [['input', 'inputTokens'], ['output', 'outputTokens'], ['cacheRead', 'cacheReadTokens'], ['cacheWrite', 'cacheWriteTokens'], ['reasoning', 'reasoningTokens'], ['total', 'totalTokens']]) {
    const value = Number(usage[field] ?? 0)
    if (Number.isFinite(value)) {
      totals[key] += value
      current[key] = (current[key] ?? 0) + value
    }
  }
}

for (const event of events) {
  const type = event.type
  const data = event.data ?? {}
  if (type === 'turn/start') {
    current = null
    continue
  }
  if (type === 'step/start') {
    current = { turn: data.turn, step: data.step }
    requests.push(current)
    continue
  }
  if (type === 'assistant/message') addUsage(data.usage)
  if (type === 'request/context') {
    for (const entry of requests) {
      if (entry.provider === undefined) { entry.provider = data.provider; entry.model = data.model }
    }
  }
}

console.log(`\n=== ${label} ===`)
console.log(`events=${events.length} requests=${requests.length}`)
for (const [i, request] of requests.entries()) {
  const parts = [`turn=${request.turn} step=${request.step}`, `model=${request.model ?? '?'}`]
  for (const key of ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'total']) {
    if (request[key] !== undefined) parts.push(`${key}=${request[key]}`)
  }
  console.log(`  req#${i + 1}: ${parts.join(' ')}`)
}
console.log(`TOTALS: input=${totals.input} cacheRead=${totals.cacheRead} cacheWrite=${totals.cacheWrite} output=${totals.output} reasoning=${totals.reasoning} total=${totals.total}`)
