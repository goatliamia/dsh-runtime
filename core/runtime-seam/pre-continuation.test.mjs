// pre-continuation.test.mjs — projection/classification unit test (multi-file).
import { _internals as I } from "./lib/pre-continuation.mjs";

const tc = [];
const mk = (seq, type, data) => ({ type, seq, data });
const contracts = Object.values(I.DAILY_CONTRACTS);

// 1. single write of lib/calc.js arms with one pending check
let ev = [mk(1, "user/message", {}), mk(10, "tool/call", { callId: "c1", name: "write", arguments: JSON.stringify({ file_path: "lib/calc.js", content: "x" }) })];
let p = I.project({ events: ev });
let cl = I.classify(p, contracts);
tc.push(["write arms", p.pendingChecks.length === 1 && p.pendingChecks[0].path === "lib/calc.js" && cl.kind === "required"]);

// 2. node --check after disarms
ev.push(mk(12, "tool/call", { callId: "c2", name: "pwsh", arguments: JSON.stringify({ command: "node --check 'lib/calc.js'" }) }));
p = I.project({ events: ev });
cl = I.classify(p, contracts);
tc.push(["check disarms", p.pendingChecks.length === 0 && cl.kind === "none"]);

// 3. burst of three writes in one step -> all three pending
ev.push(
  mk(20, "tool/call", { callId: "c3", name: "write", arguments: JSON.stringify({ file_path: "lib/a.js" }) }),
  mk(21, "tool/call", { callId: "c4", name: "write", arguments: JSON.stringify({ file_path: "lib/b.js" }) }),
  mk(22, "tool/call", { callId: "c5", name: "write", arguments: JSON.stringify({ file_path: "test/run.mjs" }) }),
);
p = I.project({ events: ev });
cl = I.classify(p, contracts);
tc.push(["burst keeps all files", p.pendingChecks.length === 3 && cl.kind === "required"]);

// 4. action command covers every pending file
if (cl.kind === "required") {
  const a = cl.contract.action(p);
  tc.push(["action covers all", a.name === "pwsh" && ["lib/a.js", "lib/b.js", "test/run.mjs"].every((f) => a.arguments.command.includes(f))]);
} else tc.push(["action covers all", false]);

// 5. str_replace_editor path form counts too; node_modules + non-js ignored
ev.push(mk(30, "tool/call", { callId: "c6", name: "str_replace_editor", arguments: JSON.stringify({ command: "str_replace", path: "C:/ws/lib/a.js" }) }));
ev.push(mk(31, "tool/call", { callId: "c7", name: "write", arguments: JSON.stringify({ file_path: "node_modules/x/y.js" }) }));
ev.push(mk(32, "tool/call", { callId: "c8", name: "write", arguments: JSON.stringify({ file_path: "lib/readme.md" }) }));
p = I.project({ events: ev });
tc.push(["editor + ignores", p.pendingChecks.some((f) => f.path === "C:/ws/lib/a.js") && p.pendingChecks.length === 4]);

// 6. edit tool arms too (dedupe by path keeps one entry per file)
ev.push(mk(40, "tool/call", { callId: "c9", name: "edit", arguments: JSON.stringify({ file_path: "lib/b.js", old_string: "a", new_string: "b" }) }));
p = I.project({ events: ev });
tc.push(["edit tool arms + dedupe", p.pendingChecks.filter((f) => f.path === "lib/b.js").length === 1 && p.pendingChecks.length === 4]);

const fails = tc.filter(([, ok]) => !ok);
for (const [name, ok] of tc) console.log((ok ? "PASS" : "FAIL") + " " + name);
console.log(fails.length === 0 ? "ALL PASS" : fails.length + " FAILURES");
process.exit(fails.length ? 1 : 0);
