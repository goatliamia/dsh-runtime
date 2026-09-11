// pre-continuation.mjs — productized 事前 (Pre) engine for dsh-runtime-seam.
//
// Origin: experiments/native-pp/rc/continuation (rounds 1-4 + rn A/B) validated
// the mechanism end to end. This module carries the SAME general machinery —
//   pre-step projection of the session event log -> contract classification
//   (unique / ambiguous / none) -> CAS re-projection -> dispatch through the
//   public tool pipeline (ctx.tools.execute: normal guards / approval /
//   cancel apply) -> loop-contract records -> ONE digest handed to the model —
// and drops the experiment scaffolding (scenario env, results dirs, fixture
// worlds, the 4 s cancel-injection handshake window that only test harnesses
// use). Activation is a live boolean read at each pre-step, so toggling
// settings.continuation takes effect immediately without remounting.
//
// Protocol notes kept from the experiments:
//   * dispatch appends assistant/message (tool-call block) + tool/call +
//     tool/result + runtime/continuation with surfaceOp:"append", so the
//     session log stays the single source of truth (水位哲学);
//   * the appended tool records use callIds prefixed `cont_`; the llm/stream
//     filter below strips those protocol pairs from the MODEL request — they
//     stay durable but are never model-visible, and DeepSeek never sees an
//     orphan tool message;
//   * staleness: the CAS re-projection discards an intent whose premise moved
//     during the handoff — the runtime never executes a stale action;
//   * cancellation: the loop's own signal rides on the dispatch; it
//     materializes as the canonical aborted outcome, never a bypass.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONTINUATION_PREFIX = "cont_";

const JS_MODULE = /\.(?:mjs|cjs|js)$/i;

/** Daily contract table. required(projection) -> boolean; action(projection)
 *  -> the unique deterministic next step. v1 carries the ONE contract with
 *  demonstrated real-loop value (rn A/B finding): after the model writes or
 *  edits a JavaScript module in the workspace, the deterministic next step is
 *  a syntax check (`node --check`). `write` counts — the A/B arm proved a
 *  single write + never-edit evades a str_replace-only contract. */
const DAILY_CONTRACTS = {
  "post-write-syntax-check": {
    id: "post-write-syntax-check",
    kind: "pre",
    // Every workspace JS module written/edited since the last `node --check`
    // still needs its deterministic syntax check. A burst (several writes in
    // one step) yields ALL of them, not just the newest.
    required: (proj) => proj.pendingChecks.length > 0,
    action: (proj) => ({
      name: "pwsh",
      arguments: {
        command: proj.pendingChecks.map((f) => `node --check ${psSingleQuote(f.path)}`).join("; "),
        description: `Syntax-check ${proj.pendingChecks.length} JavaScript module(s) just written/edited`,
      },
    }),
  },
};

/** Single-quote for embedding a path in a pwsh command line. */
function psSingleQuote(value) {
  return "'" + String(value ?? "").replaceAll("'", "''") + "'";
}

function textOf(content) {
  return (content ?? [])
    .map((block) => (block?.type === "text" ? String(block.text ?? "") : ""))
    .join("");
}

/** Unwrap a tool-result MESSAGE into its flat text. */
function toolResultText(message) {
  const content = message?.content ?? [];
  let text = "";
  for (const block of content) {
    if (block?.type === "text") text += String(block.text ?? "");
    else if (block?.type === "tool-result" && Array.isArray(block.content)) text += textOf(block.content);
  }
  return text;
}

/** Extract a file path from a tool/call record's JSON argument string. The
 *  editor tools each carry the target under a different key. */
function extractFilePath(argumentsText) {
  let parsed;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return null;
  }
  if (typeof parsed === "string") return parsed;
  if (parsed && typeof parsed === "object") {
    if (typeof parsed.file_path === "string") return parsed.file_path;
    if (typeof parsed.path === "string") return parsed.path;
    // str_replace_editor also nests under args.command + args.path when the
    // arguments object came from the editor bridge; plain path above covers it.
  }
  return null;
}

function isWorkspaceJs(path) {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  if (!normalized) return false;
  if (normalized.includes("node_modules")) return false;
  return JS_MODULE.test(normalized);
}

/** Canonical full event-log read across runtimes: some expose `.events`,
 *  dsh-session >= 0.1.2-rc.1 exposes only snapshotEvents()/eventAt(). */
function eventsOf(session) {
  if (!session) return [];
  if (Array.isArray(session.events)) return session.events;
  if (typeof session.snapshotEvents === "function") {
    try {
      const snap = session.snapshotEvents();
      return Array.isArray(snap) ? snap : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Pure projection over the session event log — the ONLY fact source. */
function project(session) {
  const events = eventsOf(session);
  // Pass 1: the seq of the LAST `node --check` (any pwsh that ran one). A
  // check retroactively covers every earlier write, so writes are judged
  // against this single boundary, not against in-order iteration state.
  let lastCheckSeq = 0;
  for (const event of events) {
    if (event.type !== "tool/call" || event.data?.callId === undefined) continue;
    if (String(event.data.name ?? "") !== "pwsh") continue;
    const seq = Number(event.seq);
    if (!Number.isFinite(seq)) continue;
    if (/node\s+--check/.test(String(event.data.arguments ?? ""))) lastCheckSeq = seq;
  }
  // Pass 2: workspace JS writes strictly newer than the last check, one entry
  // per file (the newest mutation is what the check command will validate).
  const pendingChecks = []; // { seq, path }
  const byPath = new Map();
  for (const event of events) {
    if (event.type !== "tool/call" || event.data?.callId === undefined) continue;
    const name = String(event.data.name ?? "");
    if (name !== "write" && name !== "str_replace_editor" && name !== "edit") continue;
    const seq = Number(event.seq);
    if (!Number.isFinite(seq) || seq <= lastCheckSeq) continue;
    const path = extractFilePath(event.data.arguments);
    if (path === null || !isWorkspaceJs(path)) continue;
    const key = path.replace(/\\/g, "/");
    const prev = byPath.get(key);
    if (prev === undefined || seq > prev.seq) byPath.set(key, { seq, path });
  }
  for (const entry of byPath.values()) pendingChecks.push(entry);
  pendingChecks.sort((a, b) => a.seq - b.seq);
  return { pendingChecks, lastCheckSeq };
}

function classify(proj, contracts) {
  const candidates = contracts.filter((contract) => contract.required(proj));
  if (candidates.length === 0) return { kind: "none", candidates: [] };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return { kind: "required", contract: candidates[0] };
}

function isGuardDenial(result) {
  const text = textOf(result?.content ?? []);
  return result?.isError === true && text.startsWith("Error: ");
}

/** Wire filter: cont_ protocol pairs stay durable, never model-visible. */
function stripRuntimePairs(messages) {
  const blocked = new Set();
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      const id =
        block?.type === "tool-call"
          ? String(block.id ?? "")
          : block?.type === "tool-result"
            ? String(block.toolCallId ?? "")
            : "";
      if (id.startsWith(CONTINUATION_PREFIX)) blocked.add(id);
    }
  }
  if (blocked.size === 0) return messages;
  return (messages ?? []).filter((message) => {
    for (const block of message?.content ?? []) {
      if (block?.type === "tool-call" && blocked.has(String(block.id ?? ""))) return false;
      if (block?.type === "tool-result" && blocked.has(String(block.toolCallId ?? ""))) return false;
    }
    return true;
  });
}

/**
 * Mount the Pre engine on ctx. Safe to call unconditionally: every hook is
 * gated by isEnabled() read live at each step, so a disabled Pre costs one
 * boolean check per event and nothing else.
 * @param ctx - cordis context (tools + session/event plumbing).
 * @param deps.isEnabled - () => boolean; true = the continuation axis is on.
 * @param deps.recordActivity - (kind, data) => void (seam activity ledger).
 * @returns an object with the active contract table (for tests/UI) and the
 *   last classification (diagnostics).
 */
export function mountContinuation(ctx, { isEnabled, recordActivity }) {
  const contracts = Object.values(DAILY_CONTRACTS);
  const state = { metrics: { dispatches: 0, blocked: 0, aborted: 0, discards: 0, ambiguous: 0 } };
  let hopCounter = 0;
  // Lightweight persistent diagnostics for headless validation: every hook
  // failure is swallowed by design (never break the loop), so without this
  // file a silent engine is indistinguishable from a broken one.
  const diag = { mountedAt: new Date().toISOString(), enabledAtMount: false, classifications: [], failures: [] };
  const diagPath = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "plugins", "dsh-runtime-seam", "pre-diag.json");
  const writeDiag = () => {
    try {
      mkdirSync(join(diagPath, ".."), { recursive: true });
      writeFileSync(diagPath, JSON.stringify({ ...diag, metrics: state.metrics }, null, 2));
    } catch {
      /* diagnostics must never throw */
    }
  };
  const fail = (stage, error) => {
    diag.failures.push({ at: new Date().toISOString(), stage, message: String(error?.message ?? error) });
    writeDiag();
  };
  diag.enabledAtMount = isEnabled();
  ctx.on("agent/disposed", writeDiag);
  process.on("exit", writeDiag);
  const note = (kind, data) => {
    diag.classifications.push({ at: Date.now(), kind, ...(data ?? {}) });
    if (diag.classifications.length > 400) diag.classifications.splice(0, diag.classifications.length - 400);
  };

  /** One continuation dispatch: CAS happened already; run + record. */
  async function dispatchHop(session, payload, contract, proj) {
    const execSpec = contract.action(proj);
    const exec = {
      name: execSpec.name,
      arguments: { ...execSpec.arguments },
      callId: `${CONTINUATION_PREFIX}${Date.now()}_${(hopCounter += 1)}`,
      agent: payload.agent,
      signal: payload.signal,
    };

    let result;
    try {
      result = await ctx.tools.execute(exec);
    } catch (error) {
      state.metrics.blocked += 1;
      fail("dispatch-execute", error);
      recordActivity("continuation", { contract: contract.id, outcome: "dispatch-error", step: payload.step, message: String(error?.message ?? error) });
      return { outcome: "blocked", exec, result: null, text: "" };
    }

    const outcome = payload.signal.aborted ? "aborted" : isGuardDenial(result) ? "blocked" : "dispatched";
    let callSeq = null;
    let resultSeq = null;
    try {
      session.append(
        "assistant/message",
        {
          turn: payload.turn,
          step: payload.step,
          message: {
            role: "assistant",
            id: randomUUID(),
            source: { kind: "runtime-continuation", contract: contract.id, callId: exec.callId },
            content: [{ type: "tool-call", id: exec.callId, name: exec.name, arguments: JSON.stringify(exec.arguments) }],
          },
        },
        { surfaceOp: "append" },
      );
      callSeq = session.append("tool/call", {
        turn: payload.turn,
        step: payload.step,
        callId: exec.callId,
        name: exec.name,
        arguments: JSON.stringify(exec.arguments),
      }).seq;
      const resultEvent = session.append(
        "tool/result",
        {
          turn: payload.turn,
          step: payload.step,
          message: {
            role: "user",
            id: randomUUID(),
            source: { kind: "tool", callId: exec.callId },
            content: [
              { type: "tool-result", toolCallId: exec.callId, content: result.content ?? [], isError: result.isError === true },
            ],
          },
        },
        { surfaceOp: "append", sourceEventSeqs: [callSeq] },
      );
      resultSeq = resultEvent.seq;
      session.append("runtime/continuation", {
        kind: "runtime/continuation",
        version: 1,
        contract: contract.id,
        authority: "runtime-observation",
        outcome,
        callSeq,
        resultSeq,
        resultIsError: result.isError === true,
      });
    } catch (error) {
      // Record failures must never break the loop; the action already ran.
      fail("record-append", error);
      recordActivity("continuation", { contract: contract.id, outcome, stage: "record-failure", step: payload.step, message: String(error?.message ?? error) });
    }

    state.metrics[outcome === "dispatched" ? "dispatches" : outcome === "blocked" ? "blocked" : "aborted"] += 1;
    recordActivity("continuation", {
      contract: contract.id,
      outcome,
      action: `${exec.name} ${String(execSpec.arguments?.command ?? "")}`.slice(0, 120),
      files: proj.pendingChecks.map((f) => f.path),
      step: payload.step,
    });
    return { outcome, exec, result, text: result === null ? "" : toolResultText({ content: result.content ?? [] }) };
  }

  ctx.on(
    "agent/pre-step",
    async (payload, next) => {
      const decision = await next();
      try {
        {
          const evs = eventsOf(payload?.agent?.session);
          note("prestep-fired", {
            step: payload?.step ?? null,
            agent: payload?.agent?.id ?? null,
            eventsLen: evs.length,
            tail: evs.slice(-4).map((e) => `${e.type}${e.data?.name ? ":" + e.data.name : ""}${typeof e.seq === "number" ? "#" + e.seq : ""}`),
          });
        }
        if (!isEnabled()) return decision;
        // NOTE: no single-session lock — this host serves many agents
        // concurrently; every agent's pre-step carries its own session.
        const session = payload?.agent?.session;
        if (!session || typeof session.append !== "function") return decision;

        const proj = project(session);
        const classification = classify(proj, contracts);
        if (classification.kind !== "none") {
          note(classification.kind, {
            contract: classification.kind === "required" ? classification.contract.id : undefined,
            pending: proj.pendingChecks.map((f) => `${f.seq}:${f.path}`),
          });
        }
        if (classification.kind === "ambiguous") {
          state.metrics.ambiguous += 1;
          note("ambiguous", { contracts: classification.candidates.map((c) => c.id) });
          recordActivity("continuation-ambiguous", {
            contracts: classification.candidates.map((c) => c.id),
            step: payload.step,
          });
          return decision;
        }
        if (classification.kind === "none") return decision;

        // CAS: re-project; the premise moved while the loop was deciding?
        const now = project(session);
        const casKey = (p) => p.pendingChecks.map((f) => `${f.seq}:${f.path}`).join("|");
        if (casKey(now) !== casKey(proj)) {
          state.metrics.discards += 1;
          note("discarded-stale", { was: casKey(proj), now: casKey(now) });
          recordActivity("continuation", { contract: classification.contract.id, outcome: "discarded-stale", step: payload.step });
          return decision;
        }

        const hop = await dispatchHop(session, payload, classification.contract, now);
        if (!isEnabled() || decision.kind !== "enter" || payload.signal.aborted) return decision;
        const label =
          hop.outcome === "dispatched"
            ? `the runtime dispatched ${hop.exec.name} (${String(hop.exec.arguments?.command ?? "")}) through the normal tool pipeline; result: ${hop.text}`
            : `outcome ${hop.outcome} (no world change)`;
        const injected = {
          role: "user",
          id: randomUUID(),
          source: { kind: "plugin", plugin: "dsh-runtime-seam" },
          content: [
            {
              type: "text",
              text:
                `[runtime-continuation] deterministic step already executed by the runtime: ${label}. ` +
                `Do not re-run it; digest the outcome and continue from the current world state.`,
            },
          ],
        };
        return { kind: "enter", messages: [...decision.messages, injected] };
      } catch (error) {
        fail("prestep-handler", error);
        recordActivity("continuation", { outcome: "prestep-error", message: String(error?.message ?? error) });
      }
      return decision;
    },
  );

  ctx.on("llm/stream", (options, next) => {
    try {
      const messages = options?.messages;
      if (Array.isArray(messages)) {
        const filtered = stripRuntimePairs(messages);
        if (filtered !== messages) return next({ ...options, messages: filtered });
      }
    } catch (error) {
      fail("stream-filter", error);
    }
    return next();
  });

  return { contracts, state };
}

/** Internals exposed for projection/classification unit tests. */
export const _internals = { project, classify, DAILY_CONTRACTS, extractFilePath, isWorkspaceJs };
