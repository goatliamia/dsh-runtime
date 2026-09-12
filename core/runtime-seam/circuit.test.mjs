// circuit.test.mjs -- CircuitTracker fingerprint semantics (see
// docs/status/circuit-fingerprint-vs-fs-errors-2026-09-11.md).
//
// The bug this pins down: `code = /E\d+/ ?? "generic-error"` gave every
// filesystem failure of a tool the SAME signature, so two unread-file errors on
// two different paths opened a circuit on `edit`, `write` or `read`.
import { CircuitTracker, circuitObservationText, errorShape, errorTarget, remediatedFsCode } from "./lib/core.mjs";

const tc = [];
const ok = (name, condition) => tc.push([name, condition === true]);

const UNREAD_EDIT = (path) =>
  `Error: edit requires reading "${path}" first \u2014 read the file, then retry\nFsError\nFS_NOT_OBSERVED`;
const STALE = (path) =>
  `Error: cannot modify "${path}": file changed on disk \u2014 re-read the file, then retry\nFsError\nFS_STALE_VERSION`;

// 1. remediated filesystem errors are never counted, whatever the path
{
  const t = new CircuitTracker({ threshold: 2 });
  const a = t.observeFailure("edit", UNREAD_EDIT("D:\\repo\\src\\a.mjs"));
  const b = t.observeFailure("edit", UNREAD_EDIT("D:\\repo\\src\\b.mjs"));
  const c = t.observeFailure("read", UNREAD_EDIT("D:\\repo\\src\\c.mjs"));
  ok("fs protocol errors are exempt", a.exempt === true && b.exempt === true && c.exempt === true);
  ok("no circuit from fs protocol errors", a.opened === false && b.opened === false && c.opened === false);
  ok("open set stays empty", t.open.size === 0);
  ok("exemption is counted for diagnostics", t.exempted === 3);
}

// 2. the stale-version code is exempt too
{
  const t = new CircuitTracker({ threshold: 2 });
  const a = t.observeFailure("edit", STALE("D:\\repo\\x.mjs"));
  const b = t.observeFailure("edit", STALE("D:\\repo\\y.mjs"));
  ok("FS_STALE_VERSION is exempt", a.exempt === true && b.exempt === true && t.open.size === 0);
}

// 3. an UNKNOWN filesystem code is not exempt -- only codes that carry a remedy
{
  const t = new CircuitTracker({ threshold: 2 });
  const a = t.observeFailure("write", 'Error: cannot write "x": no space left\nFsError\nFS_DISK_FULL');
  const b = t.observeFailure("write", 'Error: cannot write "y": no space left\nFsError\nFS_DISK_FULL');
  ok("unknown fs code is not exempt", a.exempt === false && b.exempt === false);
  ok("unknown fs code can still open a circuit", b.opened === true);
}

// 4. the same uncoded failure twice is still a loop
{
  const t = new CircuitTracker({ threshold: 2 });
  const text = "Error: tool crashed while rendering the report";
  const a = t.observeFailure("render", text);
  const b = t.observeFailure("render", text);
  ok("identical uncoded failure repeats", a.signature === b.signature);
  ok("identical uncoded failure opens", a.opened === false && b.opened === true);
}

// 5. two DIFFERENT uncoded failures no longer collapse into one signature
{
  const t = new CircuitTracker({ threshold: 2 });
  const a = t.observeFailure("render", "Error: disk quota exceeded");
  const b = t.observeFailure("render", "Error: permission denied");
  ok("different uncoded failures stay separate", a.signature !== b.signature);
  ok("different uncoded failures do not open", a.opened === false && b.opened === false);
}

// 6. coded failures keep their original, correct behaviour
{
  const t = new CircuitTracker({ threshold: 2 });
  const a = t.observeFailure("exp_flaky", "Error: E32001 flaky failure");
  const b = t.observeFailure("exp_flaky", "Error: E32002 other failure");
  ok("distinct codes stay distinct", a.signature !== b.signature);
  const c = t.observeFailure("exp_flaky", "Error: E32001 flaky failure");
  ok("same code twice opens", c.opened === true && c.count === 2);
}

// 7. documented behaviour pinned: once open, it stays open
{
  const t = new CircuitTracker({ threshold: 2 });
  t.observeFailure("render", "Error: same");
  const open = t.observeFailure("render", "Error: same");
  const again = t.observeFailure("render", "Error: same");
  ok("open is announced once", open.opened === true && again.opened === false);
  ok("open persists", t.open.has("render") === true);
}

// 8. the shape helper blanks volatile spans but keeps the message
{
  const one = errorShape('Error: cannot modify "D:\\a\\b.mjs": nope');
  const two = errorShape("Error: cannot modify 'C:\\other\\path.mjs': nope");
  ok("shape blanks quoted spans", one === 'Error: cannot modify "<str>": nope');
  ok("shape is stable across paths", one === two);
  ok("shape keeps distinct messages distinct", errorShape("Error: alpha") !== errorShape("Error: beta"));
  ok("remediatedFsCode ignores unknown codes", remediatedFsCode("FsError\nFS_DISK_FULL") === undefined);
  ok("remediatedFsCode finds the code", remediatedFsCode(UNREAD_EDIT("p")) === "FS_NOT_OBSERVED");
}

// 9. a non-remediated filesystem error is scoped to its TARGET, not just its
//    tool: two missing files are exploration, one missing file twice is a loop
{
  const miss = (p) => `Error: cannot read "${p}": file not found`;
  const t = new CircuitTracker({ threshold: 2 });
  const a = t.observeFailure("read", miss("D:\\repo\\one.mjs"));
  const b = t.observeFailure("read", miss("D:\\repo\\two.mjs"));
  ok("different missing files do not collapse", a.signature !== b.signature);
  ok("two missing files do not open a circuit on read", b.opened === false && t.open.size === 0);
  const c = t.observeFailure("read", miss("D:\\repo\\one.mjs"));
  ok("the SAME missing file twice still opens", c.opened === true && c.count === 2);
  ok("target is folded for case-insensitive paths", errorTarget(miss("D:\\Repo\\ONE.mjs")) === "d:\\repo\\one.mjs");
  ok("no target when the error names no path", errorTarget("Error: connection reset") === undefined);
}

// 10. a loop with no target still behaves exactly as before
{
  const t = new CircuitTracker({ threshold: 2 });
  const a = t.observeFailure("exp_flaky", "Error: E32001 flaky");
  const b = t.observeFailure("exp_flaky", "Error: E32001 flaky");
  ok("coded loop without a target still opens", b.opened === true && a.target === undefined);
}

// 11. the announcement states the observation and gives no order
{
  const fact = { path: "capabilities.read.state", value: "stalled", authority: "runtime", revision: 1, fingerprint: "abc123" };
  const text = circuitObservationText({
    tool: "read",
    target: "c:\\repo\\gone.mjs",
    code: 'Error: cannot read "<str>": not found',
    count: 2,
    threshold: 2,
    factPath: fact.path,
    fact,
  });
  ok("names the tool", text.includes('"read"'));
  ok("names the target", text.includes("c:\\repo\\gone.mjs"));
  ok("states the count and threshold", text.includes("failed 2 times") && text.includes("threshold 2"));
  ok("cites the registry entry", text.includes('fact: capabilities.read.state = "stalled"'));
  ok("carries the authority line", text.includes("authority: runtime") && text.includes("fingerprint: abc123"));
  // The earlier version ended "...; do not retry read." A command the model can
  // disobey is weaker than a fact it can act on, and the measured response was
  // that it routed around the tool instead.
  ok("carries no imperative", !/do not retry|stop retrying|must not|don't retry/i.test(text));
  ok("no target means no 'on' clause", !circuitObservationText({ tool: "x", code: "c", count: 2, threshold: 2, factPath: "p", fact }).includes(" on "));
}

let failed = 0;
for (const [label, pass] of tc) {
  console.log(`${pass ? "PASS" : "FAIL"} ${label}`);
  if (!pass) failed += 1;
}
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
