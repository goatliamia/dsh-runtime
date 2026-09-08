/**
 * Child orchestration core — the semantic contract's minimal layer, as pure
 * logic (no Cordis, no timers beyond the wait bound, no polling).
 *
 * It consumes exactly three official facts and nothing else:
 *   - the delegation edge (childId -> parentId), observed at the parent's scope;
 *   - `subagent/end` (the ONLY terminal fact);
 *   - `agent/status` (running / idle), for the residency derivation.
 *
 * Non-goals, per `docs/20-child-orchestration-semantic-contract.md`:
 *   no waiting event, no result primitive, no polling, no core patch.
 *
 * `idle` is never a terminal outcome: a child that is quiescent while it still
 * owns a live child derives `waiting`, and `wait` stays pending until the real
 * terminal edge arrives. A timed-out wait never resolves retroactively.
 */

/**
 * Create one orchestrator instance.
 * @returns the fact registry plus wait/residency operations.
 */
export function createOrchestrator() {
  const edges = new Map()
  const terminals = new Map()
  const statuses = new Map()
  const waiters = new Map()

  /** Resolve every pending waiter for a child whose terminal fact just landed. */
  function notify(childId) {
    const pending = waiters.get(childId)
    if (pending === undefined) return
    const fact = terminals.get(childId)
    if (fact === undefined) return
    waiters.delete(childId)
    for (const waiter of pending) {
      clearTimeout(waiter.timer)
      waiter.resolve({ outcome: 'settled', childId, ...fact })
    }
  }

  /** The recorded terminal fact, if any. */
  function terminalFact(childId) {
    const fact = terminals.get(childId)
    return fact === undefined ? undefined : { outcome: 'settled', childId, ...fact }
  }

  /** Wait for one child's terminal fact. Resolves early only from a real fact. */
  function wait(childId, timeoutMs) {
    const known = terminalFact(childId)
    if (known !== undefined) return Promise.resolve(known)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = (waiters.get(childId) ?? []).filter((waiter) => waiter.timer !== timer)
        if (pending.length === 0) waiters.delete(childId)
        else waiters.set(childId, pending)
        resolve({ outcome: 'timeout', childId })
      }, timeoutMs)
      const pending = waiters.get(childId)
      if (pending === undefined) waiters.set(childId, [{ resolve, timer }])
      else pending.push({ resolve, timer })
    })
  }

  /** Wait for every child; each result is settled or timeout, never mixed up. */
  function waitAll(childIds, timeoutMs) {
    return Promise.all(childIds.map((childId) => wait(childId, timeoutMs)))
  }

  return {
    /** Record one delegation edge observed at the delegating parent's scope. */
    noteStart(childId, parentId, provider) {
      if (typeof childId !== 'string') return
      edges.set(childId, { parentId, provider, at: Date.now() })
    },
    /** Record one terminal edge. First terminal wins, like the platform. */
    noteEnd(childId, info) {
      if (typeof childId !== 'string') return
      if (!terminals.has(childId)) terminals.set(childId, { at: Date.now(), ...info })
      notify(childId)
    },
    /** Record one observed agent status, for the residency derivation. */
    noteStatus(sessionId, status) {
      if (typeof sessionId !== 'string' || typeof status !== 'string') return
      statuses.set(sessionId, status)
    },
    /** The child ids this parent delegated to, in observation order. */
    childrenOf(parentId) {
      const out = []
      for (const [childId, edge] of edges) if (edge.parentId === parentId) out.push(childId)
      return out
    },
    terminalFact,
    /**
     * Derive one session's residency from official facts only.
     * @returns 'settled' | 'running' | 'waiting' | 'idle' | 'unknown'.
     */
    residency(sessionId) {
      if (terminals.has(sessionId)) return 'settled'
      if (statuses.get(sessionId) === 'running') return 'running'
      for (const [childId, edge] of edges) {
        if (edge.parentId === sessionId && !terminals.has(childId)) return 'waiting'
      }
      return statuses.has(sessionId) ? 'idle' : 'unknown'
    },
    wait,
    waitAll,
    /** Release every pending waiter. */
    dispose() {
      for (const pending of waiters.values()) {
        for (const waiter of pending) {
          clearTimeout(waiter.timer)
          waiter.resolve({ outcome: 'disposed' })
        }
      }
      waiters.clear()
    },
  }
}
