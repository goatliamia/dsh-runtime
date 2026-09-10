// analyze-ts.mjs - Phase-4 fold: the turn-stopping continuation probe.
// Prints, per case, what the model actually did: its answer sequence, how the
// injected message was recorded, and how the turn ended.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const results = process.argv[2] ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Documents', 'async-spike', 'results-ts')
const cases = (process.argv[3] ?? 't1,t2,t3').split(',')

function load(id) {
  const path = join(results, `${id}.jsonl`)
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
}

const clip = (text, max = 110) => {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}...` : one
}

for (const id of cases) {
  const rows = load(id)
  console.log(`\n${'='.repeat(76)}\n${id.toUpperCase()}\n${'='.repeat(76)}`)
  if (rows === undefined) {
    console.log('NO ARTIFACT')
    continue
  }
  const parent = rows.find((row) => row.kind === 'app/parent-session')?.sessionId
  const parentRows = rows.filter((row) => row.sessionId === parent)

  console.log('-- runtime action --')
  for (const row of rows.filter((r) => r.kind === 'ts/inject' || r.kind === 'ts/throw' || r.kind === 'ts/inject-always' || r.kind === 'ts/inject-early')) {
    console.log(`  ${String(row.t).padStart(6)}ms  ${row.kind}${row.seq ? ` seq=${row.seq}` : ''} turn=${row.turn} ${row.text ? `text="${clip(row.text, 80)}"` : ''}`)
  }

  console.log('-- parent timeline --')
  for (const row of parentRows) {
    if (row.kind === 'session/turn-start') console.log(`  ${String(row.t).padStart(6)}ms  turn/start turn=${row.turn}`)
    else if (row.kind === 'session/turn-end') console.log(`  ${String(row.t).padStart(6)}ms  turn/end turn=${row.turn} reason=${row.reason}`)
    else if (row.kind === 'session/assistant-message' && row.text) console.log(`  ${String(row.t).padStart(6)}ms  ASSISTANT "${clip(row.text)}"`)
    else if (row.kind === 'session/user-message') console.log(`  ${String(row.t).padStart(6)}ms  user/message src=${row.source?.kind}${row.source?.form ? '/' + row.source.form : ''} plugin=${row.source?.plugin ?? '-'} "${clip(row.text, 80)}"`)
    else if (row.kind === 'session/tool-call') console.log(`  ${String(row.t).padStart(6)}ms  tool/call ${row.name}`)
  }

  const turns = rows.filter((r) => r.kind === 'session/turn-start' && r.sessionId === parent).length
  const answers = rows.filter((r) => r.kind === 'session/assistant-message' && r.sessionId === parent && r.text).map((r) => r.text.trim())
  const end = rows.filter((r) => r.kind === 'session/turn-end' && r.sessionId === parent).map((r) => r.reason)
  console.log(`VERDICT: turns=${turns} assistantAnswers=${answers.length} [${answers.map((a) => JSON.stringify(clip(a, 30))).join(', ')}] turnEnds=[${end.join(', ')}]`)
}
