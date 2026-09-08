// Direct app driver for the spike. It is a deliberate stand-in for a Runtime
// owner: it drives ONE task turn and then holds the process open instead of
// exiting at the first idle, so platform-native async settlement has a live
// process to resume into. It never waits on, checks, or polls a child/job.

import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { record, sessionIdOf, state } from './state.js'
import { awaitSettlement, childrenOf, factSnapshot } from './facts.js'

export const name = 'async-spike-app'
export const inject = ['agents', 'agentDefaultModel', 'sessions']

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function holdMs() {
  const raw = Number(process.env.SPIKE_HOLD_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 90000
}

/**
 * Why the hold window closed, for the evidence trail.
 * @param turnStarts - parent turn/start count observed so far.
 * @returns a stable label.
 */
function holdOutcome(turnStarts) {
  if (turnStarts >= 2) return 'resumed'
  return 'timeout'
}

async function run(ctx, io) {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  if (agents === undefined || defaultModel === undefined || sessions === undefined) {
    io.stderr.write('async-spike-app: missing agents/agentDefaultModel/sessions\n')
    io.exit(2)
    return
  }
  const task = process.env.SPIKE_TASK
  if (typeof task !== 'string' || task.trim().length === 0) {
    io.stderr.write('async-spike-app: SPIKE_TASK is required\n')
    io.exit(2)
    return
  }
  const selection = defaultModel.currentSelection()
  const { agent } = await agents.create({
    sessionId: brandString(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: {
      provider: selection.provider,
      model: selection.model,
    },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    },
  })
  await agent.whenIdle()
  const parentSessionId = sessionIdOf(agent)
  state.parentSessionId = parentSessionId
  record('app/parent-session', {
    sessionId: parentSessionId,
    provider: selection.provider,
    model: selection.model,
    cwd: process.cwd(),
  })
  record('app/task', { text: task })

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  record('app/first-idle', {
    parentTurnStarts: state.parentTurnStarts,
    subagentEnds: state.subagentEnds,
    jobDone: state.jobDone,
    status: agent.status,
  })

  // Phase-1 orchestration probe: a Runtime-side waiter that consumes ONLY the
  // recorded terminal fact. The model is never given a wait tool (option 2).
  const orchestrate = process.env.SPIKE_ORCHESTRATE
  if (orchestrate === 'wait') {
    const delay = Number(process.env.SPIKE_WAIT_DELAY_MS ?? '0')
    const timeout = Number(process.env.SPIKE_WAIT_TIMEOUT_MS ?? '60000')
    const tail = Number(process.env.SPIKE_TAIL_MS ?? '2000')
    const children = childrenOf(parentSessionId)
    record('orch/wait-plan', {
      children,
      delay,
      timeout,
      facts: factSnapshot(),
    })
    if (delay > 0) {
      record('orch/wait-delay', { ms: delay })
      await sleep(delay)
    }
    for (const childId of children) {
      const started = Date.now()
      record('orch/wait-begin', { childId, timeout })
      const fact = await awaitSettlement(childId, timeout)
      record('orch/wait-end', {
        childId,
        elapsedMs: Date.now() - started,
        outcome: fact.outcome ?? 'settled',
        via: fact.via,
        stopReason: fact.stopReason,
        lastAssistantMessage: fact.lastAssistantMessage,
        facts: factSnapshot(),
      })
    }
    // Tail window: a timed-out wait must NOT resolve retroactively.
    if (tail > 0) {
      record('orch/tail-begin', { ms: tail })
      await sleep(tail)
      record('orch/tail-end', { facts: factSnapshot() })
    }
  }

  // Hold the process open. This is the ONLY thing the driver does after the
  // task turn: it does not wait on any child or job, it only lets the platform
  // deliver whatever it delivers. `SPIKE_EXIT_ON` chooses which platform-native
  // completion signal ends the window early.
  const exitOn = process.env.SPIKE_EXIT_ON ?? 'none'
  const [exitKind, exitCountRaw] = exitOn.split(':')
  const exitCount = Number(exitCountRaw)
  const deadline = Date.now() + holdMs()
  while (Date.now() < deadline) {
    const resumed = state.parentTurnStarts >= 2
    const wanted = Number.isFinite(exitCount) && exitCount > 0 ? exitCount : 1
    // `subagent-end:N` waits for N lifecycle ends AND a platform resume.
    if (exitKind === 'subagent-end' && resumed && state.subagentEnds >= wanted) break
    if (exitKind === 'job-done' && resumed && state.jobDone >= wanted) break
    await sleep(250)
  }

  record('app/hold-end', {
    outcome: holdOutcome(state.parentTurnStarts),
    exitOn,
    parentTurnStarts: state.parentTurnStarts,
    subagentStarts: state.subagentStarts,
    subagentEnds: state.subagentEnds,
    jobDone: state.jobDone,
    jobChanged: state.jobChanged,
    status: agent.status,
  })
  await sessions.flush(agent.session)
  io.exit(0)
}

export function apply(ctx) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('async-spike-app: the launcher must provide ctx.appExit')
  const io = {
    stdout: process.stdout,
    stderr: process.stderr,
    exit,
  }
  run(ctx, io).catch((error) => {
    io.stderr.write(`async-spike-app: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    io.exit(1)
  })
}
