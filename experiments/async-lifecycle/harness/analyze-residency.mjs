// analyze-residency.mjs - Phase-3 (residency) evidence fold.
//
// Cross-checks the third-party derived state against the platform's own
// terminal edges: 'waiting' must appear while the child owns a live child and
// the child has NOT settled; 'settled' must never precede subagent/end.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const results = process.argv[2] ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Documents', 'async-spike', 'results-residency')
const cases = ['w1', 'w2', 'w3']

function load(id) {
  const path = join(results, `${id}.jsonl`)
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
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

let pass = 0
let total = 0
const check = (id, label, ok, detail = '') => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${label}${detail ? `  (${detail})` : ''}`)
}

for (const id of cases) {
  const rows = load(id)
  console.log(`\n${'='.repeat(74)}\n${id.toUpperCase()}\n${'='.repeat(74)}`)
  if (rows === undefined) {
    console.log('NO ARTIFACT')
    continue
  }
  const { parent, labels } = roles(rows)
  const who = (sid) => labels.get(sid) ?? '-'
  console.log(`roles: ${[...labels.entries()].map(([sid, l]) => `${l}=${sid.slice(0, 8)}`).join('  ')}`)

  console.log('-- derived state timeline (third-party, official facts only) --')
  for (const row of rows.filter((r) => r.kind === 'derived/state')) {
    console.log(`  ${String(row.t).padStart(6)}ms  ${who(row.sessionId).padEnd(2)} -> ${row.state}`)
  }
  console.log('-- terminal edges --')
  for (const row of rows.filter((r) => r.kind === 'subagent/end')) {
    console.log(`  ${String(row.t).padStart(6)}ms  ${who(row.childId).padEnd(2)} end stop=${row.stopReason} last="${row.lastAssistantMessage ?? ''}"`)
  }

  const child = [...labels.entries()].find(([, l]) => l === 'C')?.[0]
  const childDerived = rows.filter((r) => r.kind === 'derived/state' && r.sessionId === child)
  const childEnd = rows.find((r) => r.kind === 'subagent/end' && r.childId === child)
  const waitingRow = childDerived.find((r) => r.state === 'waiting')
  const settledRow = childDerived.find((r) => r.state === 'settled')

  if (id === 'w1' || id === 'w3') {
    check(id, "child derived 'waiting' exists", waitingRow !== undefined, `@${waitingRow?.t}`)
    check(id, "'waiting' occurs before the child terminal edge", waitingRow !== undefined && childEnd !== undefined && waitingRow.t < childEnd.t, `${waitingRow?.t} < ${childEnd?.t}`)
    check(id, "child derived 'settled' only at/after the terminal edge", settledRow !== undefined && childEnd !== undefined && settledRow.t >= childEnd.t, `${settledRow?.t} >= ${childEnd?.t}`)
  }
  if (id === 'w2') {
    check(id, "child never derived 'waiting' (parked with no live child)", waitingRow === undefined, '')
    check(id, "child derived 'idle' at least once", childDerived.some((r) => r.state === 'idle'), '')
  }
}

console.log(`\n${pass}/${total} residency semantics hold`)
