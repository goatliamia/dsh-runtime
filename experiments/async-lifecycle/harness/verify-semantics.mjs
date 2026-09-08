// verify-semantics.mjs - structural checklist for one spike run set.
// Prints PASS/FAIL per pinned semantic so two runs (rc.1 vs alpha) can be
// compared without being confused by run-to-run timing noise.
//
//   node verify-semantics.mjs <results-v2-dir> <results-orch-dir>

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Documents', 'async-spike', 'results-v2')
const orchDir = process.argv[3] ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Documents', 'async-spike', 'results-orch')

function load(from, name) {
  const path = join(from, `${name}.jsonl`)
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
}

const results = []
function check(id, label, ok, detail = '') {
  results.push({ id, label, ok, detail })
}

// ---- lifecycle ----
const c1 = load(dir, 'case1')
if (c1) {
  const notice = c1.find((r) => r.kind === 'inbox/inserted' && r.source?.kind === 'subagent-settled')
  const end = c1.find((r) => r.kind === 'subagent/end')
  const relay = c1.find((r) => r.kind === 'inbox/inserted' && r.source?.kind === 'agent-message')
  check('case1', 'settlement notice precedes subagent/end', notice !== undefined && end !== undefined && notice.t < end.t, `${notice?.t} < ${end?.t}`)
  check('case1', 'child-authored relay also reaches the parent', relay !== undefined, `relay@${relay?.t}`)
  const dup = notice?.text?.includes('C-PONG') === true && relay?.text?.includes('C-PONG') === true
  check('case1', 'relay and notice carry the same closing text (duplicate)', dup, '')
}

const c2 = load(dir, 'case2')
if (c2) {
  const listResult = c2.find((r) => r.kind === 'session/tool-result' && typeof r.text === 'string' && r.text.includes('[idle]'))
  const end = c2.find((r) => r.kind === 'subagent/end')
  check('case2', 'list_agents reports the child [idle]', listResult !== undefined, `list@${listResult?.t}`)
  check('case2', 'that idle is BEFORE the child terminal edge', listResult !== undefined && end !== undefined && listResult.t < end.t, `${listResult?.t} < ${end?.t}`)
  check('case2', 'no waiting notice exists', c2.every((r) => r.kind !== 'inbox/inserted' || r.source?.kind !== 'subagent-waiting'), '')
}

const c3 = load(dir, 'case3')
if (c3) {
  const ends = c3.filter((r) => r.kind === 'subagent/end')
  check('case3', 'two terminal edges observed (grandchild then child)', ends.length === 2, `n=${ends.length}`)
  if (ends.length === 2) check('case3', 'grandchild terminal precedes child terminal', ends[0].t < ends[1].t, `${ends[0].t} < ${ends[1].t}`)
}

const c4 = load(dir, 'case4')
if (c4) {
  const end = c4.find((r) => r.kind === 'subagent/end')
  const notice = c4.find((r) => r.kind === 'inbox/inserted' && r.source?.kind === 'subagent-settled')
  check('case4', 'disposed terminal is aborted', end?.stopReason === 'aborted', `stop=${end?.stopReason}`)
  check('case4', 'notice says it was stopped', notice?.text?.includes('was stopped before it finished') === true, '')
  const turnStarts = c4.filter((r) => r.kind === 'session/turn-start' && r.isParent === true)
  check('case4', 'notice did NOT open a new parent turn', turnStarts.length === 1, `turns=${turnStarts.length}`)
}

const c5 = load(dir, 'case5')
if (c5) {
  const notice = c5.find((r) => r.kind === 'inbox/inserted' && r.source?.kind === 'subagent-settled')
  const parentMsgs = c5.filter((r) => r.kind === 'session/assistant-message' && r.isParent === true)
  const turnStarts = c5.filter((r) => r.kind === 'session/turn-start' && r.isParent === true)
  check('case5', 'parent already answered before the settlement notice', notice !== undefined && parentMsgs.some((r) => r.t < notice.t), `msgs=${parentMsgs.length}`)
  // The extra work after settlement is stable; whether it lands as a new turn
  // (parent idle) or inside the running turn (parent busy) is a race.
  const pulledBack = notice !== undefined && (parentMsgs.some((r) => r.t > notice.t) || turnStarts.some((r) => r.t > notice.t))
  check('case5', 'parent is pulled back after the settlement notice', pulledBack, `turns=${turnStarts.length}`)
  const newTurnAfterNotice = notice !== undefined && turnStarts.some((r) => r.t > notice.t)
  check('case5', 'branch recorded (idle=>new turn / busy=>steered)', true, newTurnAfterNotice ? 'new turn opened' : 'steered into running turn')
}

// ---- orchestration ----
for (const id of ['a1', 'a2', 'a3', 'a4']) {
  const rows = load(orchDir, id)
  if (!rows) continue
  const waitEnd = rows.find((r) => r.kind === 'orch/wait-end')
  const end = rows.find((r) => r.kind === 'subagent/end')
  if (id === 'a1') {
    check('a1', 'wait resolved via the terminal fact', waitEnd?.outcome === 'settled' && waitEnd?.via === 'fact', `via=${waitEnd?.via}`)
    check('a1', 'wait returned at/after the terminal fact', waitEnd !== undefined && end !== undefined && waitEnd.t >= end.t, `${waitEnd?.t} >= ${end?.t}`)
  }
  if (id === 'a2') {
    check('a2', 'already-settled resolves immediately', waitEnd?.via === 'already-settled' && waitEnd?.elapsedMs <= 5, `via=${waitEnd?.via} elapsed=${waitEnd?.elapsedMs}`)
  }
  if (id === 'a3') {
    const idle = rows.find((r) => r.kind === 'agent/status' && r.status === 'idle' && r.sessionId !== rows.find((x) => x.kind === 'app/parent-session')?.sessionId)
    check('a3', 'wait stayed blocked through the idle window', waitEnd !== undefined && idle !== undefined && waitEnd.t - idle.t > 20000, `idle@${idle?.t} waitEnd@${waitEnd?.t}`)
    check('a3', 'wait resolved via the terminal fact', waitEnd?.via === 'fact', `via=${waitEnd?.via}`)
  }
  if (id === 'a4') {
    const tail = rows.find((r) => r.kind === 'orch/tail-end')
    check('a4', 'timeout is a distinct outcome', waitEnd?.outcome === 'timeout', `outcome=${waitEnd?.outcome}`)
    check('a4', 'the late fact did not resolve the timed-out wait', tail?.facts?.settlements >= 1 && rows.filter((r) => r.kind === 'orch/wait-end').length === 1, `settlements=${tail?.facts?.settlements}`)
  }
}

let pass = 0
for (const row of results) {
  if (row.ok) pass += 1
  console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.id.padEnd(6)} ${row.label}${row.detail ? `  (${row.detail})` : ''}`)
}
console.log(`\n${pass}/${results.length} pinned semantics hold`)
