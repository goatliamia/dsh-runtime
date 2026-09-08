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

const clip = (text, max) => {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}...` : one
}

/** Fold one child's own trajectory into the scalar facts a digest needs. */
function summarizeTrajectory(events) {
  let turns = 0
  let toolCalls = 0
  let errors = 0
  let final = ''
  let report = ''
  // Collaboration text travels inside a send_message TOOL CALL, not a text
  // block, so extraction must read tool-call arguments too (same rule the
  // trajectory-query plugin's textOf applies).
  const blocksText = (blocks) => {
    if (!Array.isArray(blocks)) return ''
    let out = ''
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') out += `${block.text}\n`
      else if (block.type === 'tool-call') out += `${block.name ?? ''} ${typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments)}\n`
      else if (block.type === 'tool-result') out += blocksText(block.content)
    }
    return out
  }
  for (const event of events ?? []) {
    if (event.type === 'turn/start') turns += 1
    else if (event.type === 'tool/call') toolCalls += 1
    else if (event.type === 'tool/result' && event.data?.error !== undefined) errors += 1
    else if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content
      const text = blocksText(blocks)
      if (text === '') continue
      // The child's closing line is its plain text; the collaboration message
      // it chose to send is the send_message tool call.
      const plain = Array.isArray(blocks) ? blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('').trim() : ''
      if (plain !== '') final = plain
      if (text.includes('send_message')) report = text
    }
  }
  return { turns, toolCalls, errors, final: clip(final, 160), report: clip(report, 160) }
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

  // End-to-end demo: the ORCHESTRATOR (this driver, not the model) waits for
  // every child, queries each settled child's own trajectory through the
  // official sessionQuery service, and hands the model one digest. The model
  // never sees `waiting`, never polls, and never reads a lifecycle event.
  if (process.env.SPIKE_DEMO === 'e2e') {
    const subagents = ctx.get('subagents')
    const query = ctx.get('sessionQuery')
    const children = childrenOf(parentSessionId)
    record('demo/children', { count: children.length, ids: children.map((id) => id.slice(0, 8)) })

    const outcomes = []
    for (const childId of children) {
      let fact = await awaitSettlement(childId, 30000)
      if (fact.outcome === 'timeout' && subagents !== undefined) {
        record('demo/interrupt', { childId: childId.slice(0, 8) })
        try {
          subagents.interrupt(childId, { kind: 'ancestor', agent })
        } catch (error) {
          record('demo/interrupt-error', { message: String(error?.message ?? error) })
        }
        fact = await awaitSettlement(childId, 20000)
      }
      outcomes.push({ childId, fact })
      record('demo/settled', {
        childId: childId.slice(0, 8),
        outcome: fact.outcome ?? 'settled',
        stopReason: fact.stopReason,
      })
    }

    const lines = ["CHILD DIGEST - one line per child, read from that child's own session trajectory after its execution finished."]
    for (const { childId, fact } of outcomes) {
      let summary = { turns: 0, toolCalls: 0, errors: 0, final: '', report: '' }
      if (query !== undefined) {
        try {
          const snapshot = await query.readSession(childId)
          summary = summarizeTrajectory(snapshot.events)
        } catch (error) {
          record('demo/query-error', { childId: childId.slice(0, 8), message: String(error?.message ?? error) })
        }
      }
      record('demo/digest-line', {
        childId: childId.slice(0, 8),
        stop: fact.stopReason ?? fact.outcome,
        ...summary,
      })
      lines.push(`- child ${childId.slice(0, 8)}: stop=${fact.stopReason ?? fact.outcome ?? 'unknown'} turns=${summary.turns} toolCalls=${summary.toolCalls} errors=${summary.errors} final="${summary.final}" collaboration="${summary.report}"`)
    }
    const digest = `${lines.join('\n')}\n\nSynthesize: which children finished, and what each reported. End with SYNTHESIZED.`
    record('demo/digest', { text: digest })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: digest }],
      source: { kind: 'plugin', plugin: 'async-spike-demo', form: 'notice' },
    }))
    await agent.whenIdle()
    record('demo/synth-done', { status: agent.status, parentTurnStarts: state.parentTurnStarts })
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
