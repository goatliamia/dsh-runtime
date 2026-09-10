/**
 * dsh-runtime-investigate — policy layer. Consumes dsh-runtime-progress.
 *
 *   success + stalled/unknown -> investigate -> verify -> repair
 *
 * A claimed success whose effect is not confirmed by the Event stream must be
 * verified, not trusted. This policy injects ONE pre-step instruction naming
 * the verification and repair capabilities, turning a silent false success
 * into an observable recovery (evidence: silent failure 2/2 -> 0/2, world
 * correctness 0/2 -> 2/2; docs/status/native-pp-real-*.md).
 *
 * Deliberately separate from Circuit: stalled does NOT mean stop. Known cost
 * profile: buys correctness, costs extra model calls — do not judge this
 * policy by token savings.
 *
 * Contracts are registered by the host/domain:
 *   registerClaimedContract({ id, match, verify, repair })
 * where match = { tool: "exp_pretend" } or { tool: "pwsh", pattern: /apply-config/i }.
 * Also consumes host event `exp/job-changed` (platform event substrate) to
 * notify "job complete, check once" instead of polling.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const name = "runtime-investigate";

const contracts = [];

export function registerClaimedContract(contract) {
  contracts.push(contract);
}

export function apply(ctx) {
  const resultsDir = String(process.env.EXP_RESULTS_DIR ?? "").trim();
  const scenario = String(process.env.EXP_SCENARIO ?? "ok").toLowerCase();
  const run = String(process.env.EXP_RUN ?? "r1").replace(/[^a-zA-Z0-9_-]/g, "");
  const runId = `${scenario}-${run}`;

  let sessionId = null;
  let finalized = false;
  const events = [];
  const interventions = [];
  const injected = new Set();
  let jobCompletePending = false;
  let jobInjected = false;

  function matchedResults(contract) {
    const matched = new Set();
    for (const event of events) {
      if (event.type !== "tool/call") continue;
      const toolName = String(event.data?.name ?? "");
      if (toolName !== String(contract.match.tool)) continue;
      if (contract.match.pattern && !contract.match.pattern.test(String(event.data?.arguments ?? ""))) continue;
      if (event.data?.callId !== undefined) matched.add(String(event.data.callId));
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

  ctx.on("exp/job-changed", (payload) => {
    try {
      if (jobCompletePending || payload?.state !== "complete") return;
      jobCompletePending = true;
    } catch {
      /* observe only */
    }
  });

  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    try {
      if (sessionId !== null && payload?.agent?.id !== sessionId) return decision;
      let kind = null;
      let evidence = null;
      let text = null;
      for (const contract of contracts) {
        if (injected.has(contract.id)) continue;
        const results = matchedResults(contract);
        const success = results.find((result) => !result.isError);
        if (!success) continue;
        injected.add(contract.id);
        kind = "investigate-inject";
        evidence = { contract: contract.id, matchedCalls: results.length, lastResultSeq: success.seq };
        text =
          `[progress-policy investigate] the "${contract.id}" capability reported success but its effect is not ` +
          `confirmed by the event stream (execution=success, effect=unknown). Verify the outcome with ${contract.verify}, ` +
          `and if the result is stale or missing, recover with ${contract.repair} and re-verify.`;
        break;
      }
      if (kind === null && jobCompletePending && !jobInjected) {
        jobInjected = true;
        kind = "job-complete-inject";
        evidence = { state: "complete", source: "exp/job-changed" };
        text =
          "[progress-policy job-complete] the background job just reached state complete. " +
          "Check its status once now and wrap up; no further polling is needed.";
      }
      if (kind === null) return decision;
      interventions.push({ at: Date.now(), kind, evidence });
      const injectedMessage = {
        id: `ppx-${Date.now()}`,
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "dsh-runtime-investigate" },
      };
      if (decision.kind === "enter") {
        return { kind: "enter", messages: [...decision.messages, injectedMessage] };
      }
    } catch {
      /* an injecting listener must never break the loop */
    }
    return decision;
  });

  function finalize() {
    if (finalized) return;
    finalized = true;
    try {
      writeFileSync(
        join(resultsDir, `${runId}.policy.investigate.json`),
        `${JSON.stringify({ run: runId, sessionId, policy: "investigate", contracts, interventions, surface: { toolsRegistered: 0, promptEdits: interventions.filter((i) => i.kind === "investigate-inject").length, modelCallsInitiated: 0 } }, null, 2)}\n`,
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
