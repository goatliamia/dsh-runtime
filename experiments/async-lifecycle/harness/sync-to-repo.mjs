/**
 * Materialize the async-lifecycle spike (harness + evidence) into this repo,
 * desensitized: home paths -> <HOME>, repo paths -> <REPO>, and every distinct
 * session id -> a stable alias (session-A, session-B, ...) so rows stay
 * correlatable without carrying real ids.
 *
 * One-shot ingestion tool, like scripts/sanitize-evidence.mjs. Run it from the
 * machine that produced the artifacts:
 *   node experiments/async-lifecycle/harness/sync-to-repo.mjs
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC = process.env.ASYNC_SPIKE_SRC ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Documents', 'async-spike')
const DST = process.env.ASYNC_SPIKE_DST ?? resolve(import.meta.dirname, '..')

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''
const REPO = process.env.ASYNC_SPIKE_REPO ?? 'D:\\projects\\runtime\\dsh-runtime'

const SESSION_RE = /(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const aliases = new Map()

function aliasFor(id) {
  if (!aliases.has(id)) aliases.set(id, `session-${String.fromCharCode(65 + aliases.size)}`)
  return aliases.get(id)
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sanitize(text) {
  let out = String(text)
  const slash = (value) => value.replace(/\//g, '\\')
  const pairs = []
  for (const [from, to] of [
    [HOME, '<HOME>'],
    [HOME.replace(/\\/g, '\\\\'), '<HOME>'],
    [HOME.replace(/\\/g, '/'), '<HOME>'],
    [REPO, '<REPO>'],
    [REPO.replace(/\\/g, '\\\\'), '<REPO>'],
    [REPO.replace(/\\/g, '/'), '<REPO>'],
  ]) {
    if (from.length > 1) pairs.push([from, to])
  }
  // The bare account name also appears inside DSH's encoded workspace
  // directory names (`--C-Users-<user>-Documents--`).
  const account = slash(HOME).split('\\').filter(Boolean).pop()
  if (account !== undefined && account.length > 1) pairs.push([account, '<user>'])
  for (const [from, to] of pairs) out = out.replace(new RegExp(escapeRe(from), 'gi'), to)
  return out.replace(SESSION_RE, (match) => aliasFor(match))
}

function copySanitized(from, to) {
  if (!existsSync(from)) return false
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from)) copySanitized(join(from, entry), to ? join(to, entry) : entry)
    return true
  }
  mkdirSync(resolve(to, '..'), { recursive: true })
  writeFileSync(to, sanitize(readFileSync(from, 'utf8')))
  return true
}

// 1) harness sources, verbatim structure (no node_modules)
mkdirSync(join(DST, 'pkg', 'lib'), { recursive: true })
for (const name of ['package.json', 'cordis.patch.yml']) copySanitized(join(SRC, 'pkg', name), join(DST, 'pkg', name))
for (const name of ['app.js', 'fixture.js', 'state.js']) copySanitized(join(SRC, 'pkg', 'lib', name), join(DST, 'pkg', 'lib', name))

mkdirSync(join(DST, 'tasks'), { recursive: true })
for (const name of ['task-a.txt', 'task-b.txt', 'task-c.txt']) copySanitized(join(SRC, name), join(DST, 'tasks', name))

mkdirSync(join(DST, 'tasks-v2'), { recursive: true })
for (const name of ['task-1.txt', 'task-2.txt', 'task-3.txt', 'task-4.txt', 'task-5.txt']) copySanitized(join(SRC, name), join(DST, 'tasks-v2', name))

mkdirSync(join(DST, 'harness'), { recursive: true })
copySanitized(join(SRC, 'run-spike.ps1'), join(DST, 'harness', 'run-spike.ps1'))
copySanitized(join(SRC, 'analyze.mjs'), join(DST, 'harness', 'analyze.mjs'))
copySanitized(join(SRC, 'run-lifecycle.ps1'), join(DST, 'harness', 'run-lifecycle.ps1'))
copySanitized(join(SRC, 'analyze-lifecycle.mjs'), join(DST, 'harness', 'analyze-lifecycle.mjs'))

// 2) evidence: JSONL artifacts + driver log + home snapshots. No credentials,
//    no settings, no session logs.
mkdirSync(join(DST, 'results'), { recursive: true })
for (const name of readdirSync(join(SRC, 'results'))) {
  if (!/\.(jsonl|txt|log)$/.test(name)) continue
  if (name === 'dump-config.txt') continue
  copySanitized(join(SRC, 'results', name), join(DST, 'results', name))
}

mkdirSync(join(DST, 'results-v2'), { recursive: true })
for (const name of readdirSync(join(SRC, 'results-v2'))) {
  if (!/\.(jsonl|txt|log)$/.test(name)) continue
  copySanitized(join(SRC, 'results-v2', name), join(DST, 'results-v2', name))
}

console.log(`materialized ${aliases.size} session aliases into ${DST}`)
for (const [id, alias] of aliases) console.log(`  ${alias} <- ${id.slice(0, 8)}...`)
