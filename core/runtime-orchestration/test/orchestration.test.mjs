// Semantic tests for the orchestration core. Plain node, no DSH runtime:
//   node test/orchestration.test.mjs   ->  ALL PASS
import assert from 'node:assert/strict'
import { createOrchestrator } from '../lib/core.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 1) wait resolves on the terminal fact, and not before.
{
  const o = createOrchestrator()
  o.noteStart('c1', 'p1', 'spawn')
  o.noteStatus('c1', 'running')
  let resolved = null
  const pending = o.wait('c1', 5000).then((r) => { resolved = r })
  await sleep(20)
  assert.equal(resolved, null, 'wait must not resolve before the terminal edge')
  o.noteEnd('c1', { stopReason: 'completed', lastAssistantMessage: 'C-OK' })
  await pending
  assert.equal(resolved.outcome, 'settled')
  assert.equal(resolved.stopReason, 'completed')
  assert.equal(resolved.lastAssistantMessage, 'C-OK')
}

// 2) already-settled resolves immediately from the recorded fact.
{
  const o = createOrchestrator()
  o.noteStart('c1', 'p1', 'spawn')
  o.noteEnd('c1', { stopReason: 'completed' })
  const started = Date.now()
  const r = await o.wait('c1', 5000)
  assert.equal(r.outcome, 'settled')
  assert.ok(Date.now() - started < 50, 'already-settled must resolve without waiting')
}

// 3) idle is NOT terminal: a child that is idle while owning a live child is
//    'waiting', and the wait stays pending until the real edge arrives.
{
  const o = createOrchestrator()
  o.noteStart('c1', 'p1', 'spawn')
  o.noteStart('g1', 'c1', 'spawn')
  o.noteStatus('c1', 'idle')
  o.noteStatus('g1', 'running')
  assert.equal(o.residency('c1'), 'waiting')
  let resolved = null
  const pending = o.wait('c1', 5000).then((r) => { resolved = r })
  await sleep(60)
  assert.equal(resolved, null, 'idle/waiting must not resolve a wait')
  o.noteEnd('g1', { stopReason: 'completed' })
  assert.equal(o.residency('c1'), 'idle', 'after its grandchild ended the child is idle, not waiting')
  o.noteEnd('c1', { stopReason: 'completed' })
  await pending
  assert.equal(resolved.outcome, 'settled')
}

// 4) residency labels.
{
  const o = createOrchestrator()
  o.noteStart('c1', 'p1', 'spawn')
  assert.equal(o.residency('p1'), 'waiting', 'a parent owning a live child is waiting')
  o.noteStatus('c1', 'running')
  assert.equal(o.residency('c1'), 'running')
  o.noteStatus('c1', 'idle')
  assert.equal(o.residency('c1'), 'idle', 'idle with no live child is idle, not waiting')
  o.noteEnd('c1', { stopReason: 'aborted' })
  assert.equal(o.residency('c1'), 'settled')
  assert.equal(o.residency('p1'), 'unknown', 'no status recorded for p1')
}

// 5) timeout is a distinct outcome and never resolves retroactively.
{
  const o = createOrchestrator()
  o.noteStart('c1', 'p1', 'spawn')
  const r = await o.wait('c1', 30)
  assert.deepEqual(r, { outcome: 'timeout', childId: 'c1' })
  let late = null
  o.noteEnd('c1', { stopReason: 'completed' })
  await sleep(30)
  assert.equal(late, null)
  // The fact is still recorded, so a later wait sees it.
  assert.equal((await o.wait('c1', 10)).outcome, 'settled')
}

// 6) waitAll keeps per-child outcomes; dispose releases pending waiters.
{
  const o = createOrchestrator()
  o.noteStart('a', 'p1', 'spawn')
  o.noteStart('b', 'p1', 'spawn')
  o.noteEnd('a', { stopReason: 'completed' })
  const results = await o.waitAll(['a', 'b'], 40)
  assert.equal(results[0].outcome, 'settled')
  assert.equal(results[1].outcome, 'timeout')
  assert.deepEqual(o.childrenOf('p1'), ['a', 'b'])

  const d = createOrchestrator()
  d.noteStart('c', 'p1', 'spawn')
  const disposed = d.wait('c', 5000).then((r) => r.outcome)
  d.dispose()
  assert.equal(await disposed, 'disposed')
}

console.log('ALL PASS')
