// Evidence fixture: a ROOT-scope (unscoped) observer of the async Execution
// lifecycle. It never polls, never drives, never synthesizes a model message.
// It only folds what the platform already publishes into one JSONL artifact.
//
// Spike ① asks whether an unscoped `ctx.on('subagent/end')` reaches a plugin
// that is not the parent agent and not the child, and whether that is enough to
// fold a settlement into a Runtime-owned completion fact.

import { record, sourceOf, sessionIdOf, state, textOf } from './state.js'
import { recordEnd, recordStart, recordStatus, watchDerived } from './facts.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'async-spike-fixture'
export const inject = ['jobs']

export function apply(ctx) {
  const jobs = ctx.jobs

  record('fixture/boot', {
    pid: process.pid,
    jobsVisibleToUnscopedCaller: jobs.list().length,
  })

  // Phase 4 probe: the LEGAL turn-extension route.
  //
  // `agent/turn-stopping` is an emit checkpoint the loop runs immediately before
  // it would end the turn (only when no next-step work is pending), and it then
  // RE-CHECKS `inbox.nextStep.length`. `agent.inject()` appends to exactly that
  // list, so injecting here makes the turn continue with a normal loop-owned
  // step. Throwing instead makes the turn end as `error` rather than as a clean
  // finish. Nothing is forged: the injected message is user-role with a plugin
  // source, and the next step is generated and logged by the loop itself.
  const tsMode = process.env.SPIKE_TS
  if (tsMode === 'inject' || tsMode === 'throw' || tsMode === 'inject-early') {
    const injected = new Set()
    const injectOnce = (agent, turn, kind) => {
      const sessionId = sessionIdOf(agent)
      // Only the primary conversation participates; children have their own turns.
      if (sessionId === undefined || sessionId !== state.parentSessionId) return
      if (injected.has(sessionId)) return
      injected.add(sessionId)
      const text = process.env.SPIKE_TS_TEXT ?? 'Runtime observation: a required check has not run yet.'
      record(kind, { sessionId, turn, text })
      agent.inject(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'async-spike-fixture', form: 'notice', summary: 'runtime observation' },
      }))
    }
    if (tsMode === 'inject-early') {
      // Deliver the SAME observation, but while the turn is still running: a
      // tool result is a step-internal boundary, so the loop claims the message
      // at the next step and the turn continues with no checkpoint needed.
      ctx.on('tools/result', (exec) => {
        if (exec?.agent === undefined) return
        injectOnce(exec.agent, undefined, 'ts/inject-early')
      })
    } else {
      ctx.on('agent/turn-stopping', ({ agent, turn }) => {
        const sessionId = sessionIdOf(agent)
        if (sessionId === undefined || sessionId !== state.parentSessionId) return
        if (tsMode === 'throw') {
          record('ts/throw', { sessionId, turn })
          throw new Error('runtime-observation: a required check has not run')
        }
        injectOnce(agent, turn, 'ts/inject')
      })
    }
  }

  // Phase 3: the residency state a THIRD PARTY can derive from official facts.
  ctx.effect(() => watchDerived((sessionId, derivedState) => {
    record('derived/state', { sessionId, state: derivedState })
  }))

  ctx.on('agent/created', ({ agent }) => {
    const sessionId = sessionIdOf(agent)
    record('agent/created', { sessionId })
    // The parent-scope form of spike 1: a listener registered on the delegating
    // agent's OWN scope must observe exactly its own delegations. Registered
    // from the agent ctx, so it unwinds with that agent.
    const agentCtx = agent.ctx
    if (agentCtx === undefined) return
    try {
      agentCtx.on('subagent/start', (info) => {
        record('agent-scope/subagent-start', {
          scopeSessionId: sessionId,
          provider: info.provider,
          childId: info.id,
        })
        recordStart(info.id, sessionId, info.provider)
      })
      agentCtx.on('subagent/end', (info) => {
        record('agent-scope/subagent-end', {
          scopeSessionId: sessionId,
          provider: info.provider,
          childId: info.id,
          stopReason: info.stopReason,
          lastAssistantMessage: textOf(info.lastAssistantMessage, 300),
        })
      })
      record('agent-scope/registered', { scopeSessionId: sessionId })
    } catch (error) {
      record('agent-scope/register-error', {
        scopeSessionId: sessionId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })

  ctx.on('agent/status', ({ agent, status }) => {
    const sessionId = sessionIdOf(agent)
    record('agent/status', { sessionId, status })
    recordStatus(sessionId, status)
  })

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    record('inbox/inserted', {
      sessionId: sessionIdOf(agent),
      source: sourceOf(message),
      text: textOf(message?.content),
    })
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    record('inbox/claimed', {
      sessionId: sessionIdOf(agent),
      turn,
      source: sourceOf(message),
      text: textOf(message?.content),
    })
  })

  ctx.on('subagent/start', (info) => {
    state.subagentStarts += 1
    record('subagent/start', {
      provider: info.provider,
      childId: info.id,
      runId: info.runId,
      local: info.local,
    })
  })

  ctx.on('subagent/end', (info) => {
    state.subagentEnds += 1
    record('subagent/end', {
      provider: info.provider,
      childId: info.id,
      runId: info.runId,
      local: info.local,
      stopReason: info.stopReason,
      lastAssistantMessage: textOf(info.lastAssistantMessage, 300),
    })
    // The ONE terminal predicate the orchestration layer consumes.
    recordEnd(info.id, {
      provider: info.provider,
      stopReason: info.stopReason,
      lastAssistantMessage: textOf(info.lastAssistantMessage, 300),
    })
  })

  ctx.on('session/event', (session, event) => {
    const sessionId = sessionIdOf({ session })
    const isParent = sessionId !== undefined && sessionId === state.parentSessionId
    const type = event.type
    const seq = Number(event.seq)
    if (type === 'turn/start') {
      if (isParent) state.parentTurnStarts += 1
      record('session/turn-start', { sessionId, isParent, seq, turn: event.data.turn })
      return
    }
    if (type === 'turn/end') {
      record('session/turn-end', {
        sessionId,
        isParent,
        seq,
        turn: event.data.turn,
        reason: event.data.reason?.kind,
      })
      return
    }
    if (type === 'user/message') {
      record('session/user-message', {
        sessionId,
        isParent,
        seq,
        source: sourceOf(event.data),
        text: textOf(event.data?.content),
      })
      return
    }
    if (type === 'assistant/message') {
      record('session/assistant-message', {
        sessionId,
        isParent,
        seq,
        source: sourceOf(event.data.message),
        text: textOf(event.data.message?.content),
      })
      return
    }
    if (type === 'tool/call') {
      record('session/tool-call', { sessionId, isParent, seq, name: event.data.name })
      return
    }
    if (type === 'tool/result') {
      record('session/tool-result', {
        sessionId,
        isParent,
        seq,
        error: event.data.error?.code,
        text: textOf(event.data.message?.content, 400),
      })
    }
  })

  // The jobs seam exposes effect-scoped listeners (public API, not a Cordis
  // event). Spike ③ asks whether this is enough for a third party to fold job
  // settlement without polling, and whether it survives a host restart.
  ctx.effect(() => jobs.onJobDone((snapshot, owner) => {
    state.jobDone += 1
    record('jobs/done', {
      jobId: snapshot.id,
      jobKind: snapshot.kind,
      label: snapshot.label,
      status: snapshot.status,
      ownerSessionId: sessionIdOf(owner),
    })
  }))

  ctx.effect(() => jobs.onJobsChanged((owner) => {
    state.jobChanged += 1
    record('jobs/changed', { ownerSessionId: sessionIdOf(owner) })
  }))
}
