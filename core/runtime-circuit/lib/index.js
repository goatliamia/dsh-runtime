/**
 * dsh-runtime-circuit — policy layer. Consumes dsh-runtime-progress.
 *
 *   Event -> Progress -> stalled x N -> Circuit -> Guard deny
 *
 * Semantics (evidence-backed, docs/status/native-pp-consumer-*.md):
 * repeated failure with NO effect progress (execution=failed, effect=stalled)
 * opens a circuit; further calls of the same capability are denied through the
 * native tools.guard with a teaching reason citing the Progress evidence.
 * Real executions dropped 6 -> 2 (-67%), mean cacheRead -27%, N=4 stable.
 *
 * Contracts are registered by the host/domain (not hardcoded):
 *   registerCircuitContract({ id, match, threshold? })
 * where match = { tool: "exp_flaky" } or { tool: "pwsh", pattern: /deploy\.ps1/i }.
 * This policy never retries/stops/waits itself and never calls the model.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { foldProjection } from "dsh-runtime-progress";

export const name = "runtime-circuit";

export const inject = ["tools"];

const contracts = [];

export function registerCircuitContract(contract) {
  contracts.push({ threshold: 2, ...contract });
}

export function apply(ctx) {
  const resultsDir = String(process.env.EXP_RESULTS_DIR ?? "").trim();
  const scenario = String(process.env.EXP_SCENARIO ?? "ok").toLowerCase();
  const run = String(process.env.EXP_RUN ?? "r1").replace(/[^a-zA-Z0-9_-]/g, "");
  const runId = `${scenario}-${run}`;

  const tools = ctx.tools;
  let sessionId = null;
  let finalized = false;
  const events = [];
  const interventions = [];
  let guardedDenials = 0;

  function matches(contract, exec) {
    const toolName = String(exec?.name ?? "");
    if (toolName !== String(contract.match.tool)) return false;
    if (contract.match.pattern) {
      return contract.match.pattern.test(String(exec?.arguments ?? ""));
    }
    return true;
  }

  function matchedResultSeqs(contract) {
    if (!contract.match.pattern) {
      // Tool-keyed contract: failures come from the Progress fold's effect axis.
      const p = foldProjection(events);
      const effect = p.axes?.effect?.[String(contract.match.tool)];
      if (!effect) return [];
      return effect.calls.filter((call) => call.isError).map((call) => call.seq);
    }
    // Pattern contract (generic tool + script signature): scan the records.
    const matched = new Set();
    for (const event of events) {
      if (
        event.type === "tool/call" &&
        String(event.data?.name ?? "") === String(contract.match.tool) &&
        contract.match.pattern.test(String(event.data?.arguments ?? "")) &&
        event.data?.callId !== undefined
      ) {
        matched.add(String(event.data.callId));
      }
    }
    const seqs = [];
    for (const event of events) {
      if (event.type !== "tool/result") continue;
      const callId = event.data?.callId ?? event.data?.message?.source?.callId;
      if (callId === undefined || !matched.has(String(callId))) continue;
      const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
      const isError = event.data?.error !== undefined || blocks.some((block) => block?.isError === true);
      if (isError) seqs.push(event.seq);
    }
    return seqs;
  }

  function guardFn(exec) {
    try {
      for (const contract of contracts) {
        if (!matches(contract, exec)) continue;
        const failures = matchedResultSeqs(contract);
        if (failures.length >= contract.threshold) {
          const reason =
            `[progress-policy circuit] ${contract.id} has failed ${failures.length} times in a row with no effect progress ` +
            `(execution=failed, effect=stalled). Do not call it again; report the failure and stop retrying.`;
          interventions.push({
            at: Date.now(),
            tool: contract.id,
            kind: "circuit-deny",
            evidence: { failures: failures.length, threshold: contract.threshold, support: failures.slice(-4) },
          });
          guardedDenials += 1;
          return reason;
        }
      }
    } catch {
      /* a failing guard must never break dispatch */
    }
    return;
  }

  if (tools && typeof tools.guard === "function") {
    ctx.effect(() => tools.guard(guardFn));
  }

  ctx.on("session/event", (session, event) => {
    try {
      // Delegated child sessions stay out of the primary fact window.
      if (session?.header?.origin === "subagent") return;
      if (sessionId !== null && session?.id !== sessionId) return;
      if (sessionId === null) sessionId = session?.id ?? null;
      events.push(event);
    } catch {
      /* observe only */
    }
  });

  function finalize() {
    if (finalized) return;
    finalized = true;
    try {
      writeFileSync(
        join(resultsDir, `${runId}.policy.circuit.json`),
        `${JSON.stringify({ run: runId, sessionId, policy: "circuit", contracts, interventions, guardedDenials, surface: { toolsRegistered: 0, promptEdits: 0, modelCallsInitiated: 0 } }, null, 2)}\n`,
      );
    } catch {
      /* last resort */
    }
  }

  ctx.on("agent/disposed", (payload) => {
    if (sessionId !== null && payload?.agent?.id !== sessionId) return;
    finalize();
  });
  process.on("exit", finalize);
}
