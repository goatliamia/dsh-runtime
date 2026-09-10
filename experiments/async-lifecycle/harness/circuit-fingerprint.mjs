// circuit-fingerprint.mjs — does the LIVE circuit tell two DIFFERENT filesystem
// failures apart? Imports the tracker from the installed seam package (not a
// copy), feeds it real model-visible error texts captured from live sessions,
// and prints the resulting signatures.
//
//   node circuit-fingerprint.mjs
import { CircuitTracker } from 'file:///C:/Users/14100/.dsh/profiles/web/node_modules/dsh-runtime-seam/lib/core.mjs'

// Verbatim tool-result texts, as the model saw them (trajectory query, 2026-09-11).
const cases = [
  ['edit/unread-A', 'edit', 'Error: edit requires reading "D:\\projects\\runtime\\dsh-runtime\\experiments\\async-lifecycle\\harness\\sync-to-repo.mjs" first — read the file, then retry\nFsError\nFS_NOT_OBSERVED'],
  ['edit/unread-B', 'edit', 'Error: edit requires reading "C:\\Users\\14100\\Documents\\other\\totally-different-file.mjs" first — read the file, then retry\nFsError\nFS_NOT_OBSERVED'],
  ['edit/other-reason', 'edit', 'Error: old_string not found in "D:\\projects\\x\\y.mjs". The file was read but the anchor does not match.'],
  ['read/missing-A', 'read', 'Error: cannot read "D:\\projects\\runtime\\gone.mjs": file not found'],
  ['read/missing-B', 'read', 'Error: cannot read "D:\\projects\\runtime\\also-gone.mjs": file not found'],
  ['write/unread', 'write', 'Error: cannot modify "D:\\projects\\runtime\\dsh-runtime\\core\\runtime-circuit\\lib\\index.js": file has not been read — read the file, then retry\nFsError\nFS_NOT_OBSERVED'],
  ['control/coded-A', 'exp_flaky', 'Error: E32001 the flaky capability failed'],
  ['control/coded-B', 'exp_flaky', 'Error: E32002 a DIFFERENT coded failure'],
]

const tracker = new CircuitTracker({ threshold: 2 })
const seen = new Map()
console.log('threshold = 2 (settings default; live settings.yaml sets no override)\n')
console.log('case              tool        signature          count  opened')
console.log('-'.repeat(72))
for (const [label, tool, text] of cases) {
  const code = /E\d+/.exec(text)?.[0] ?? 'generic-error'
  const out = tracker.observeFailure(tool, text, 2)
  seen.set(out.signature, (seen.get(out.signature) ?? []).concat(label))
  console.log(
    `${label.padEnd(17)} ${tool.padEnd(11)} ${out.signature}  ${String(out.count).padEnd(6)} ${out.opened}`,
  )
  console.log(`${' '.repeat(17)} extracted code = ${code}`)
}

console.log('\nsignature -> the DIFFERENT failures that collapsed into it:')
for (const [sig, labels] of seen) {
  if (labels.length > 1) console.log(`  ${sig}  <- ${labels.join('  +  ')}   (COLLAPSED)`)
}
console.log('\ntools now under an open circuit:', [...tracker.open].join(', ') || '(none)')
