// analyze-lifecycle.mjs - fold the Child Lifecycle spike artifacts into a
// causal timeline per case. Roles are derived from the observed ownership
// edges (`agent-scope/subagent-start`: delegating parent -> child), not assumed.
//
//   node analyze-lifecycle.mjs <results-v2-dir>

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const results = process.argv[2] ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Documents', 'async-spike', 'results-v2')
const cases = ['1', '2', '3', '4', '5']

function load(id) {
  const path = join(results, `case${id}.jsonl`)
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
}

/** Build role labels from the observed delegation edges. */
function roles(rows) {
  const parent = rows.find((row) => row.kind === 'app/parent-session')?.sessionId
  const edges = rows.filter((row) => row.kind === 'agent-scope/subagent-start')
  const labels = new Map()
  if (parent !== undefined) labels.set(parent, 'P')
  const queue = parent === undefined ? [] : [parent]
  while (queue.length > 0) {
    const from = queue.shift()
    const kids = edges.filter((edge) => edge.scopeSessionId === from).map((edge) => edge.childId)
    kids.forEach((kid, index) => {
      if (labels.has(kid)) return
      const base = labels.get(from)
      labels.set(kid, base === 'P' ? 'C' : `${base}${index + 1}`)
      queue.push(kid)
    })
  }
  return labels
}

function role(labels, id) {
  return labels.get(id) ?? (id === undefined ? '-' : id.slice(0, 8))
}

const short = (text, max = 110) => {
  if (typeof text !== 'string') return ''
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}...` : one
}

for (const id of cases) {
  const rows = load(id)
  console.log(`\n${'='.repeat(78)}\nCASE ${id}\n${'='.repeat(78)}`)
  if (rows === undefined) {
    console.log('NO ARTIFACT')
    continue
  }
  const labels = roles(rows)
  const tree = [...labels.entries()].map(([sid, label]) => `${label}=${sid.slice(0, 8)}`).join('  ')
  console.log(`tree: ${tree}`)
  const hold = rows.find((row) => row.kind === 'app/hold-end')
  console.log(`hold-end: ${hold ? JSON.stringify(hold) : '(none)'}`)

  console.log('\n-- causal timeline --')
  for (const row of rows) {
    const sid = row.sessionId ?? row.ownerSessionId ?? row.scopeSessionId
    const who = role(labels, sid)
    const bits = []
    switch (row.kind) {
      case 'subagent/start':
        bits.push(`subagent/start ${role(labels, row.childId)} provider=${row.provider}`)
        break
      case 'subagent/end':
        bits.push(`subagent/end ${role(labels, row.childId)} stop=${row.stopReason} last="${short(row.lastAssistantMessage, 40)}"`)
        break
      case 'agent-scope/subagent-start':
        bits.push(`own-child-start -> ${role(labels, row.childId)}`)
        break
      case 'agent-scope/subagent-end':
        bits.push(`own-child-end -> ${role(labels, row.childId)} stop=${row.stopReason}`)
        break
      case 'agent/status':
        bits.push(`status=${row.status}`)
        break
      case 'session/turn-start':
        bits.push(`turn/start turn=${row.turn}`)
        break
      case 'session/turn-end':
        bits.push(`turn/end turn=${row.turn} reason=${row.reason}`)
        break
      case 'session/tool-call':
        bits.push(`tool/call ${row.name}`)
        break
      case 'session/tool-result':
        bits.push(`tool/result${row.error ? ` error=${row.error}` : ''} "${short(row.text)}"`)
        break
      case 'inbox/inserted':
        bits.push(`inbox/inserted src=${row.source?.kind}${row.source?.form ? '/' + row.source.form : ''} "${short(row.text, 70)}"`)
        break
      case 'inbox/claimed':
        bits.push(`inbox/claimed turn=${row.turn} src=${row.source?.kind}${row.source?.form ? '/' + row.source.form : ''}`)
        break
      case 'session/user-message':
        bits.push(`user/message src=${row.source?.kind}${row.source?.form ? '/' + row.source.form : ''} "${short(row.text, 70)}"`)
        break
      case 'session/assistant-message':
        bits.push(`assistant/message src=${row.source?.kind} "${short(row.text, 70)}"`)
        break
      case 'app/parent-session':
        bits.push('parent established')
        break
      case 'app/first-idle':
        bits.push(`first-idle turns=${row.parentTurnStarts} subEnds=${row.subagentEnds}`)
        break
      case 'app/hold-end':
        bits.push(`hold-end ${row.outcome} turns=${row.parentTurnStarts} subStarts=${row.subagentStarts} subEnds=${row.subagentEnds}`)
        break
      case 'fixture/boot':
      case 'agent/created':
      case 'agent-scope/registered':
        continue
      default:
        bits.push(row.kind)
    }
    console.log(`  ${String(row.t).padStart(6)}ms  ${who.padEnd(3)}  ${bits.join(' ')}`)
  }
}
