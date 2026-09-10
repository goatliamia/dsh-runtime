/**
 * dsh-runtime-reconcile — policy layer. Consumes dsh-runtime-progress.
 *
 *   failure + progressed/unknown -> do not blindly retry
 *
 * Non-atomic protection (evidence: duplicate side effects 4 -> 1, -75%,
 * docs/status/native-pp-consumer-*.md): for a non-atomic capability, ANY prior
 * invocation means the effect may already be applied — a repeat can duplicate
 * the side effect. Repeats are denied through the native tools.guard with a
 * teaching reason citing the observed calls.
 *
 * Distinct from Circuit by design: Circuit stops no-progress loops;
 * Reconcile stops duplicate side effects.
 *
 * Contracts are registered by the host/domain:
 *   registerNonAtomicContract({ id, match })
 * where match = { tool: "exp_apply" } or { tool: "pwsh", pattern: /deploy\.ps1/i }.
 * This policy never retries/stops/waits itself and never calls the model.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const name = "runtime-reconcile";

export const inject = ["tools"];

const contracts = [];

export function registerNonAtomicContract(contract) {
  contracts.push(contract);
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

  function priorResults(contract) {
    if (!contract.match.pattern) {
      const matched = new Set();
      for (const event of events) {
        if (event.type === "tool/call" && String(event.data?.name ?? "") === String(contract.match.tool) && event.data?.callId !== undefined) {
          matched.add(String(event.data.callId));
        }
      }
      const results = [];
      for (const event of events) {
        if (event.type !== "tool/result") continue;
        const callId = event.data?.callId ?? event.data?.message?.source?.callId;
        if (callId === undefined || !matched.has(String(callId))) continue;
        const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
        results.push({ seq: event.seq, isError: event.data?.error !== undefined || blocks.some((block) => block?.isError === true) });
      }
      return results;
    }
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
    const results = [];
    for (const event of events) {
      if (event.type !== "tool/result") continue;
      const callId = event.data?.callId ?? event.data?.message?.source?.callId;
      if (callId === undefined || !matched.has(String(callId))) continue;
      const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
      results.push({ seq: event.seq, isError: event.data?.error !== undefined || blocks.some((block) => block?.isError === true) });
    }
    return results;
  }

  function guardFn(exec) {
    try {
      for (const contract of contracts) {
        if (!matches(contract, exec)) continue;
        const prior = priorResults(contract);
        if (prior.length >= 1) {
          const anyFailure = prior.some((result) => result.isError);
          const reason =
            `[progress-policy non-atomic] ${contract.id} was already invoked once${anyFailure ? " and its confirmation was lost" : ""}; ` +
            "the effect may already be applied, so a retry can duplicate the side effect. " +
            "Do not run it again; verify the state by other means instead.";
          interventions.push({
            at: Date.now(),
            tool: contract.id,
            kind: "non-atomic-deny",
            evidence: { matchedCalls: prior.length, anyFailure, support: prior.map((result) => result.seq) },
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
        join(resultsDir, `${runId}.policy.reconcile.json`),
        `${JSON.stringify({ run: runId, sessionId, policy: "reconcile", contracts, interventions, guardedDenials, surface: { toolsRegistered: 0, promptEdits: 0, modelCallsInitiated: 0 } }, null, 2)}\n`,
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
