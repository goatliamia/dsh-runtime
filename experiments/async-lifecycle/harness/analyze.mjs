// analyze.mjs - fold the spike JSONL artifacts into a human-readable report.
// Pure ASCII output. Reads only what the fixture recorded (leaf fields).

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const results = process.argv[2] ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Documents', 'async-spike', 'results')
const cells = ['a', 'b', 'c']

function load(id) {
  const path = join(results, `${id}.jsonl`)
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

function count(rows, kind) {
  return rows.filter((row) => row.kind === kind).length
}

function first(rows, kind) {
  return rows.find((row) => row.kind === kind)
}

for (const id of cells) {
  const rows = load(id)
  if (rows === undefined) {
    console.log(`\n## cell ${id}: NO ARTIFACT`)
    continue
  }
  const parent = first(rows, 'app/parent-session')?.sessionId
  const parentRows = rows.filter((row) => row.isParent === true)
  const turnStarts = parentRows.filter((row) => row.kind === 'session/turn-start')
  const subStarts = rows.filter((row) => row.kind === 'subagent/start')
  const subEnds = rows.filter((row) => row.kind === 'subagent/end')
  const claimed = rows.filter((row) => row.kind === 'inbox/claimed')
  const inserted = rows.filter((row) => row.kind === 'inbox/inserted')
  const userMsgs = rows.filter((row) => row.kind === 'session/user-message')
  const toolCalls = parentRows.filter((row) => row.kind === 'session/tool-call')
  const holdEnd = first(rows, 'app/hold-end')
  const jobDone = rows.filter((row) => row.kind === 'jobs/done')
  const jobChanged = rows.filter((row) => row.kind === 'jobs/changed')
  const agentScopeStart = rows.filter((row) => row.kind === 'agent-scope/subagent-start')
  const agentScopeEnd = rows.filter((row) => row.kind === 'agent-scope/subagent-end')

  console.log(`\n## cell ${id}`)
  console.log(`- parent session: ${parent ?? '(none)'}`)
  console.log(`- rows: ${rows.length}; parent turn/start: ${turnStarts.length}; unscoped subagent/start: ${subStarts.length}; subagent/end: ${subEnds.length}`)
  console.log(`- agent-scope subagent/start: ${agentScopeStart.length}; agent-scope subagent/end: ${agentScopeEnd.length} (scope=${[...new Set(agentScopeStart.concat(agentScopeEnd).map((row) => row.scopeSessionId))].join(',') || '-'})`)
  const scopeReg = rows.filter((row) => row.kind === 'agent-scope/registered' || row.kind === 'agent-scope/register-error')
  if (scopeReg.length > 0) {
    console.log(`- agent-scope registration: ${scopeReg.map((row) => row.kind === 'agent-scope/registered' ? 'ok' : `error: ${row.message}`).join('; ')}`)
  }
  console.log(`- parent tool calls: ${toolCalls.map((row) => row.name).join(', ') || '(none)'}`)
  console.log(`- inbox inserted: ${inserted.length}; inbox claimed: ${claimed.length}; user/message events: ${userMsgs.length}`)
  console.log(`- jobs/done (unscoped listener): ${jobDone.length}; jobs/changed: ${jobChanged.length}`)
  console.log(`- hold-end: ${holdEnd ? JSON.stringify(holdEnd) : '(none)'}`)

  const parentTimeline = rows
    .filter((row) => row.isParent === true || row.kind === 'app/first-idle' || row.kind === 'app/hold-end' || row.kind === 'subagent/start' || row.kind === 'subagent/end' || row.kind === 'jobs/done' || row.kind === 'agent/status')
    .map((row) => {
      const bits = [`t=${row.t}ms`, row.kind]
      if (row.sessionId !== undefined) bits.push(row.isParent ? 'PARENT' : 'other')
      if (row.status !== undefined) bits.push(`status=${row.status}`)
      if (row.turn !== undefined) bits.push(`turn=${row.turn}`)
      if (row.source !== undefined) bits.push(`src=${row.source.kind}${row.source.form ? '/' + row.source.form : ''}`)
      if (row.stopReason !== undefined) bits.push(`stop=${row.stopReason}`)
      if (row.jobId !== undefined) bits.push(`job=${row.jobId}/${row.jobKind}`)
      if (row.childId !== undefined) bits.push(`child=${row.childId.slice(0, 24)}`)
      if (row.text !== undefined && row.text !== '') bits.push(`text=${JSON.stringify(row.text.slice(0, 60))}`)
      return '  ' + bits.join(' ')
    })
  console.log('- timeline:')
  console.log(parentTimeline.join('\n'))
}
