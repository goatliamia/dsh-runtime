/**
 * dsh-runtime-orchestration — host wiring for the child orchestration core.
 *
 * Provides `ctx.childOrchestration`. It registers NO model tool: the semantic
 * contract puts `wait` in an orchestration layer, not in the model's toolset
 * (`docs/20-child-orchestration-semantic-contract.md`, Layer boundary).
 *
 * Events consumed (all official, no patch):
 *   - `agent/created` -> register a per-agent `subagent/start` listener so the
 *     delegation edge carries the exact delegating parent (the unscoped
 *     `subagent/start` payload names no parent);
 *   - `subagent/end`  -> the only terminal fact;
 *   - `agent/status`  -> running/idle, for the residency derivation.
 *
 * @module dsh-runtime-orchestration
 */
import { createOrchestrator } from './core.mjs'

export const name = 'runtime-orchestration'
export const inject = []

export function apply(ctx) {
  const orchestrator = createOrchestrator()

  ctx.on('agent/created', ({ agent }) => {
    const parentId = agent?.session?.id
    const agentCtx = agent?.ctx
    if (typeof parentId !== 'string' || agentCtx === undefined) return
    agentCtx.on('subagent/start', (info) => {
      orchestrator.noteStart(info.id, parentId, info.provider)
    })
  })

  ctx.on('subagent/end', (info) => {
    orchestrator.noteEnd(info.id, {
      provider: info.provider,
      runId: info.runId,
      stopReason: info.stopReason,
      lastAssistantMessage: typeof info.lastAssistantMessage === 'string' ? info.lastAssistantMessage : undefined,
    })
  })

  ctx.on('agent/status', ({ agent, status }) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId === 'string') orchestrator.noteStatus(sessionId, status)
  })

  ctx.effect(() => () => orchestrator.dispose(), 'runtime-orchestration: pending waiters')
  ctx.provide('childOrchestration', orchestrator)
}
