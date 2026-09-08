// analyze-result.mjs - Phase-2 (result) evidence fold.
// For each case, prints the parent-side arrival order of the child-authored
// channel (agent-message relay) versus the runtime channels (settlement notice,
// subagent/end), plus the child's terminal edges.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const results = process.argv[2] ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Documents', 'async-spike', 'results-result')
const cases = ['r1', 'r2', 'r3', 'r4']

function load(id) {
  const path = join(results, `${id}.jsonl`)
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
}

const short = (text, max = 46) => {
  if (typeof text !== 'string') return ''
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}...` : one
}

function roles(rows) {
  const parent = rows.find((row) => row.kind === 'app/parent-session')?.sessionId
  const edges = rows.filter((row) => row.kind === 'agent-scope/subagent-start')
  const labels = new Map()
  if (parent !== undefined) labels.set(parent, 'P')
  const queue = parent === undefined ? [] : [parent]
  while (queue.length > 0) {
    const from = queue.shift()
    for (const [index, edge] of edges.filter((e) => e.scopeSessionId === from).entries()) {
      if (labels.has(edge.childId)) continue
      labels.set(edge.childId, labels.get(from) === 'P' ? 'C' : `${labels.get(from)}${index + 1}`)
      queue.push(edge.childId)
    }
  }
  return { parent, labels }
}

for (const id of cases) {
  const rows = load(id)
  console.log(`\n${'='.repeat(78)}\n${id.toUpperCase()}\n${'='.repeat(78)}`)
  if (rows === undefined) {
    console.log('NO ARTIFACT')
    continue
  }
  const { parent, labels } = roles(rows)
  const who = (sid) => labels.get(sid) ?? '-'

  console.log('-- terminal edges --')
  for (const row of rows.filter((r) => r.kind === 'subagent/end')) {
    console.log(`  ${String(row.t).padStart(6)}ms  ${who(row.childId).padEnd(2)} end stop=${row.stopReason} last="${short(row.lastAssistantMessage, 40)}"`)
  }

  console.log('-- parent-visible arrival order --')
  const parentRows = rows.filter((row) => row.sessionId === parent || (row.kind === 'agent/status' && row.sessionId === parent))
  for (const row of parentRows) {
    const bits = []
    switch (row.kind) {
      case 'session/turn-start': bits.push(`turn/start turn=${row.turn}`); break
      case 'session/turn-end': bits.push(`turn/end turn=${row.turn} reason=${row.reason}`); break
      case 'agent/status': bits.push(`status=${row.status}`); break
      case 'inbox/inserted':
        bits.push(`INBOX ${row.source?.kind}${row.source?.form ? '/' + row.source.form : ''} "${short(row.text)}"`)
        break
      case 'inbox/claimed':
        bits.push(`CLAIM turn=${row.turn} ${row.source?.kind}${row.source?.form ? '/' + row.source.form : ''}`)
        break
      case 'session/assistant-message': bits.push(`ASSISTANT "${short(row.text, 60)}"`); break
      case 'session/tool-call': bits.push(`tool/call ${row.name}`); break
      default: continue
    }
    console.log(`  ${String(row.t).padStart(6)}ms  ${bits.join(' ')}`)
  }

  // One-line verdict: which channel reached the parent first.
  const relay = rows.find((row) => row.kind === 'inbox/inserted' && row.source?.kind === 'agent-message')
  const notice = rows.find((row) => row.kind === 'inbox/inserted' && row.source?.kind === 'subagent-settled')
  const end = rows.find((row) => row.kind === 'subagent/end')
  const order = [relay, notice, end].filter(Boolean).sort((a, b) => a.t - b.t)
    .map((row) => `${row.kind === 'inbox/inserted' ? (row.source.kind === 'agent-message' ? 'report' : 'settlement-notice') : 'subagent/end'}@${row.t}ms`)
  console.log(`ORDER: ${order.join(' -> ') || '(none)'}`)
}
