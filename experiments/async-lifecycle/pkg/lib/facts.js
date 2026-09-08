// Runtime-owned settlement facts for the orchestration-layer spike.
//
// This module is the ENTIRE terminal predicate: a durable-in-process record of
// `subagent/end` edges plus an event-driven waiter. It deliberately never reads
// `Agent.status`, never calls `list_agents`, and never polls.
//
//   recordStart(childId, parentId, provider)   <- observed delegation edge
//   recordEnd(childId, info)                   <- observed lifecycle terminal edge
//   awaitSettlement(childId, timeoutMs)        <- resolves on the fact, not on idle

const starts = new Map()
const settlements = new Map()
const waiters = new Map()

/** One delegation edge as observed from the delegating parent's own scope. */
export function recordStart(childId, parentId, provider) {
  if (typeof childId !== 'string') return
  starts.set(childId, { parentId, provider, at: Date.now() })
}

/** Record one terminal edge. Idempotent: first terminal wins, like the platform. */
export function recordEnd(childId, info) {
  if (typeof childId !== 'string') return
  if (!settlements.has(childId)) settlements.set(childId, { at: Date.now(), ...info })
  const pending = waiters.get(childId)
  if (pending === undefined) return
  waiters.delete(childId)
  for (const waiter of pending) waiter.resolve({ ...settlements.get(childId), via: 'fact' })
}

/** The child ids this parent delegated to, in observation order. */
export function childrenOf(parentId) {
  const out = []
  for (const [childId, edge] of starts) if (edge.parentId === parentId) out.push(childId)
  return out
}

/** Terminal fact for one child, if it already settled. */
export function settled(childId) {
  const fact = settlements.get(childId)
  return fact === undefined ? undefined : { ...fact, via: 'already-settled' }
}

/**
 * Wait for one child's terminal fact. Resolves from the recorded fact when the
 * child already settled, otherwise from the next recorded edge. A timeout is a
 * distinct outcome, never a silent success.
 * @param childId - the durable child id.
 * @param timeoutMs - bound in milliseconds.
 * @returns the terminal fact, or `{ outcome: 'timeout' }`.
 */
export function awaitSettlement(childId, timeoutMs) {
  const known = settled(childId)
  if (known !== undefined) return Promise.resolve(known)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const pending = waiters.get(childId)
      if (pending !== undefined) {
        const next = pending.filter((waiter) => waiter.timer !== timer)
        if (next.length === 0) waiters.delete(childId)
        else waiters.set(childId, next)
      }
      resolve({ outcome: 'timeout', childId })
    }, timeoutMs)
    const list = waiters.get(childId)
    if (list === undefined) waiters.set(childId, [{ resolve, timer }])
    else list.push({ resolve, timer })
  })
}

/** Observation snapshot for the evidence artifact (leaf fields only). */
export function factSnapshot() {
  return {
    starts: starts.size,
    settlements: settlements.size,
    waiters: waiters.size,
  }
}
