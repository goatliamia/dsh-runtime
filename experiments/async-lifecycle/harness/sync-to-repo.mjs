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

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC = process.env.ASYNC_SPIKE_SRC ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Documents', 'async-spike')
const DST = process.env.ASYNC_SPIKE_DST ?? resolve(import.meta.dirname, '..')

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''
const REPO = process.env.ASYNC_SPIKE_REPO ?? 'D:\\projects\\runtime\\dsh-runtime'

const SESSION_RE = /(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const aliases = new Map()

/**
 * Bijective base-26 label: A..Z, AA, AB, ... A plain `fromCharCode(65 + n)`
 * walks off the ASCII alphabet as soon as the corpus exceeds 26 sessions and
 * writes unprintable characters into the evidence files.
 */
function aliasLabel(index) {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

function aliasFor(id) {
  if (!aliases.has(id)) aliases.set(id, `session-${aliasLabel(aliases.size)}`)
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

/** Copy every text artifact of one results directory. */
function copyResults(fromDir, toDir) {
  if (!existsSync(fromDir)) return
  mkdirSync(toDir, { recursive: true })
  for (const name of readdirSync(fromDir)) {
    if (!/\.(jsonl|txt|log)$/.test(name)) continue
    if (name === 'dump-config.txt') continue
    copySanitized(join(fromDir, name), join(toDir, name))
  }
}

// 1) harness sources, verbatim structure (no node_modules)
mkdirSync(join(DST, 'pkg', 'lib'), { recursive: true })
for (const name of ['package.json', 'cordis.patch.yml']) copySanitized(join(SRC, 'pkg', name), join(DST, 'pkg', name))
for (const name of ['app.js', 'fixture.js', 'state.js', 'facts.js']) copySanitized(join(SRC, 'pkg', 'lib', name), join(DST, 'pkg', 'lib', name))

mkdirSync(join(DST, 'tasks'), { recursive: true })
for (const name of ['task-a.txt', 'task-b.txt', 'task-c.txt']) copySanitized(join(SRC, name), join(DST, 'tasks', name))

mkdirSync(join(DST, 'tasks-v2'), { recursive: true })
for (const name of ['task-1.txt', 'task-2.txt', 'task-3.txt', 'task-4.txt', 'task-5.txt']) copySanitized(join(SRC, name), join(DST, 'tasks-v2', name))

mkdirSync(join(DST, 'tasks-orch'), { recursive: true })
for (const name of ['task-a1.txt', 'task-a2.txt', 'task-a3.txt', 'task-a4.txt']) copySanitized(join(SRC, name), join(DST, 'tasks-orch', name))

mkdirSync(join(DST, 'tasks-result'), { recursive: true })
for (const name of ['task-r1.txt', 'task-r2.txt', 'task-r3.txt', 'task-r4.txt']) copySanitized(join(SRC, name), join(DST, 'tasks-result', name))

mkdirSync(join(DST, 'tasks-residency'), { recursive: true })
for (const name of ['task-w1.txt', 'task-w2.txt', 'task-w3.txt']) copySanitized(join(SRC, name), join(DST, 'tasks-residency', name))

mkdirSync(join(DST, 'tasks-e2e'), { recursive: true })
for (const name of ['task-e2e.txt']) copySanitized(join(SRC, name), join(DST, 'tasks-e2e', name))

mkdirSync(join(DST, 'tasks-turnstopping'), { recursive: true })
for (const name of ['task-t1.txt', 'task-c1.txt']) copySanitized(join(SRC, name), join(DST, 'tasks-turnstopping', name))

mkdirSync(join(DST, 'harness'), { recursive: true })
for (const name of [
  'run-spike.ps1',
  'analyze.mjs',
  'run-lifecycle.ps1',
  'analyze-lifecycle.mjs',
  'run-orchestration.ps1',
  'analyze-orchestration.mjs',
  'run-result.ps1',
  'run-result-par.ps1',
  'analyze-result.mjs',
  'run-residency-par.ps1',
  'analyze-residency.mjs',
  'run-e2e.ps1',
  'run-turnstopping-par.ps1',
  'run-ts-live.ps1',
  'run-conflict-par.ps1',
  'analyze-ts.mjs',
  'decode-usage.mjs',
  'verify-semantics.mjs',
]) {
  copySanitized(join(SRC, name), join(DST, 'harness', name))
}

// 2) evidence: JSONL artifacts + driver logs. No credentials, no settings, no
//    session logs. (rc.1 baselines live in git history; only the current run
//    set is materialized.)
copyResults(join(SRC, 'results'), join(DST, 'results'))
copyResults(join(SRC, 'results-v2'), join(DST, 'results-v2'))
copyResults(join(SRC, 'results-orch'), join(DST, 'results-orch'))
copyResults(join(SRC, 'results-result'), join(DST, 'results-result'))
copyResults(join(SRC, 'results-residency'), join(DST, 'results-residency'))
copyResults(join(SRC, 'results-e2e'), join(DST, 'results-e2e'))
copyResults(join(SRC, 'results-ts'), join(DST, 'results-ts'))
copyResults(join(SRC, 'results-ts-live'), join(DST, 'results-ts-live'))
copyResults(join(SRC, 'results-conflict'), join(DST, 'results-conflict'))
copySanitized(join(SRC, 'verification.txt'), join(DST, 'verification.txt'))

console.log(`materialized ${aliases.size} session aliases into ${DST}`)
for (const [id, alias] of aliases) console.log(`  ${alias} <- ${id.slice(0, 8)}...`)
