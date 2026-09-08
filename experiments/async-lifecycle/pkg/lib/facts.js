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
const statuses = new Map()
const derived = new Map()
const derivedWatchers = new Set()

/**
 * Derive a third-party residency state from OFFICIAL facts only:
 *   settled  - the terminal edge was observed
 *   running  - the agent reports running
 *   waiting  - quiescent but still owns a live child (the manager's private
 *              `waiting`, reconstructed without any private access)
 *   idle     - quiescent with no live child (parked between turns)
 * @param sessionId - the agent/session to classify.
 * @returns one of the four labels.
 */
export function stateOf(sessionId) {
  if (settlements.has(sessionId)) return 'settled'
  if (statuses.get(sessionId) === 'running') return 'running'
  const owns = childrenOf(sessionId).some((childId) => !settlements.has(childId))
  return owns ? 'waiting' : 'idle'
}

/** Recompute one agent's derived state and notify watchers on change. */
export function refreshDerived(sessionId) {
  if (typeof sessionId !== 'string') return
  const next = stateOf(sessionId)
  if (derived.get(sessionId) === next) return
  derived.set(sessionId, next)
  for (const watcher of derivedWatchers) watcher(sessionId, next)
}

/** Subscribe to derived-state changes. */
export function watchDerived(callback) {
  derivedWatchers.add(callback)
  return () => derivedWatchers.delete(callback)
}

/** Feed one observed agent status into the derivation. */
export function recordStatus(sessionId, status) {
  if (typeof sessionId !== 'string' || typeof status !== 'string') return
  statuses.set(sessionId, status)
  refreshDerived(sessionId)
}

/** One delegation edge as observed from the delegating parent's own scope. */
export function recordStart(childId, parentId, provider) {
  if (typeof childId !== 'string') return
  starts.set(childId, { parentId, provider, at: Date.now() })
  refreshDerived(childId)
  refreshDerived(parentId)
}

/** Record one terminal edge. Idempotent: first terminal wins, like the platform. */
export function recordEnd(childId, info) {
  if (typeof childId !== 'string') return
  if (!settlements.has(childId)) settlements.set(childId, { at: Date.now(), ...info })
  const edge = starts.get(childId)
  refreshDerived(childId)
  if (edge !== undefined) refreshDerived(edge.parentId)
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
