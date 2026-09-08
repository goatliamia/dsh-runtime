// analyze-orchestration.mjs - Phase-1 (wait) evidence fold.
// Prints, per case, what the Runtime-side waiter actually observed: the child's
// status transitions, the recorded terminal fact, and the wait outcome.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const results = process.argv[2] ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Documents', 'async-spike', 'results-orch')
const cases = ['a1', 'a2', 'a3', 'a4']

function load(id) {
  const path = join(results, `${id}.jsonl`)
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
}

for (const id of cases) {
  const rows = load(id)
  console.log(`\n${'='.repeat(74)}\n${id.toUpperCase()}\n${'='.repeat(74)}`)
  if (rows === undefined) {
    console.log('NO ARTIFACT')
    continue
  }
  const parent = rows.find((row) => row.kind === 'app/parent-session')?.sessionId
  const edges = rows.filter((row) => row.kind === 'agent-scope/subagent-start')
  const child = edges.find((row) => row.scopeSessionId === parent)?.childId
  const grand = child === undefined ? undefined : edges.find((row) => row.scopeSessionId === child)?.childId

  const statuses = (sid) => rows.filter((row) => row.kind === 'agent/status' && row.sessionId === sid).map((row) => `${row.status}@${row.t}`).join(' -> ')
  console.log(`parent=${parent?.slice(0, 8)}  child=${child?.slice(0, 8) ?? '-'}  grandchild=${grand?.slice(0, 8) ?? '-'}`)
  if (child !== undefined) console.log(`child status:      ${statuses(child) || '(none)'}`)
  if (grand !== undefined) console.log(`grandchild status: ${statuses(grand) || '(none)'}`)

  const end = rows.find((row) => row.kind === 'subagent/end' && row.childId === child)
  console.log(`child subagent/end: ${end ? `t=${end.t} stop=${end.stopReason}` : '(none)'}`)
  const notice = rows.find((row) => row.kind === 'inbox/inserted' && row.source?.kind === 'subagent-settled')
  console.log(`settlement notice:  ${notice ? `t=${notice.t}` : '(none)'}`)

  for (const row of rows.filter((r) => r.kind.startsWith('orch/'))) {
    const extra = []
    if (row.outcome !== undefined) extra.push(`outcome=${row.outcome}`)
    if (row.via !== undefined) extra.push(`via=${row.via}`)
    if (row.stopReason !== undefined) extra.push(`stop=${row.stopReason}`)
    if (row.elapsedMs !== undefined) extra.push(`elapsed=${row.elapsedMs}ms`)
    if (row.childId !== undefined) extra.push(`child=${row.childId.slice(0, 8)}`)
    if (row.facts !== undefined) extra.push(`facts=${JSON.stringify(row.facts)}`)
    if (row.children !== undefined) extra.push(`children=${row.children.length}`)
    if (row.ms !== undefined) extra.push(`ms=${row.ms}`)
    console.log(`  ${String(row.t).padStart(6)}ms  ${row.kind} ${extra.join(' ')}`)
  }

  const waitEnd = rows.find((row) => row.kind === 'orch/wait-end')
  if (waitEnd !== undefined && child !== undefined) {
    const idleRow = rows.find((row) => row.kind === 'agent/status' && row.sessionId === child && row.status === 'idle')
    const endRow = rows.find((row) => row.kind === 'subagent/end' && row.childId === child)
    const parts = []
    if (idleRow !== undefined) parts.push(`child first idle at ${idleRow.t}ms`)
    if (endRow !== undefined) parts.push(`terminal fact at ${endRow.t}ms`)
    parts.push(`wait returned at ${waitEnd.t}ms (${waitEnd.outcome})`)
    console.log(`VERDICT: ${parts.join(' | ')}`)
    if (idleRow !== undefined && endRow !== undefined && idleRow.t < endRow.t) {
      console.log(`         idle happened ${endRow.t - idleRow.t}ms BEFORE the terminal fact, and the wait did not resolve on it.`)
    }
  }
}
