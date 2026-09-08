// Shared module-level evidence state for the spike bundle.
//
// Both rows of this bundle (fixture + app) resolve into the same package
// directory, so this module has one instance and one shared state object.
// Records are leaf-field only: no live Service/Agent/Session object is ever
// serialized, only the scalar facts the analysis needs.

import { appendFileSync } from 'node:fs'

const start = Date.now()

function artifactPath() {
  const path = process.env.SPIKE_EVENTS
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

export function record(kind, data) {
  const path = artifactPath()
  if (path === undefined) return
  const row = { t: Date.now() - start, kind }
  if (data !== undefined && data !== null) {
    for (const key of Object.keys(data)) {
      const value = data[key]
      // `kind` belongs to the record envelope; a payload's own kind travels
      // under its own field name so the envelope stays unambiguous.
      if (key === 'kind' || value === undefined) continue
      row[key] = value
    }
  }
  try {
    appendFileSync(path, `${JSON.stringify(row)}\n`)
  } catch {
    // Evidence loss must never break the run under observation.
  }
}

/** Render a message's user-visible text, bounded. */
export function textOf(content, max = 600) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out += block.text
    // A tool-result block nests the model-facing content one level deeper.
    if (block.type === 'tool-result') out += textOf(block.content, max)
  }
  return out.length > max ? `${out.slice(0, max)}...[truncated]` : out
}

/** Extract only the scalar source identity of a message. */
export function sourceOf(message) {
  const source = message !== null && typeof message === 'object' ? message.source : undefined
  if (source === null || typeof source !== 'object') return undefined
  const out = {}
  if (typeof source.kind === 'string') out.kind = source.kind
  if (typeof source.form === 'string') out.form = source.form
  if (typeof source.plugin === 'string') out.plugin = source.plugin
  if (typeof source.provider === 'string') out.provider = source.provider
  if (typeof source.senderSessionId === 'string') out.senderSessionId = source.senderSessionId
  return out
}

/** Bounded label for a live agent, read as a leaf field only. */
export function sessionIdOf(agent) {
  const session = agent !== null && typeof agent === 'object' ? agent.session : undefined
  const id = session !== null && typeof session === 'object' ? session.id : undefined
  return typeof id === 'string' ? id : undefined
}

export const state = {
  parentSessionId: undefined,
  parentTurnStarts: 0,
  subagentStarts: 0,
  subagentEnds: 0,
  jobDone: 0,
  jobChanged: 0,
}
