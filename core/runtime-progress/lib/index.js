/**
 * dsh-runtime-progress — the ProgressContract as a pure fold over DSH
 * session events. FACT LAYER: owns no policy, never retries/stops/waits,
 * never calls the model, registers zero tools.
 *
 * Migrated 1:1 from the accepted native-pp projection (docs/status/
 * native-pp-*.md): live fold == official cross-process replay == independent
 * implementation, field-by-field equal.
 *
 *   - createFolder(): an incremental pure fold consuming session records;
 *   - foldProjection(events): the one-shot form over an event list;
 *   - a host plugin that subscribes to `session/event` only, times its own
 *     per-event handling (blocking_host_cost), and writes one projection JSON
 *     per run at disposal (diagnostic output, gated by EXP_RESULTS_DIR).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

export const name = "runtime-progress";

/**
 * Capability effect model: for each capability, the session event types whose
 * records embody the capability's world effect. An empty list means the effect
 * produces no observable event → the effect verdict must be `unknown` whenever
 * the capability was called (constraint #2: unobservable effects are unknown,
 * never fabricated).
 */
export const EFFECT_EVENT_TYPES = {
  exp_report: ["tool/result"],
  exp_flaky: ["tool/result"],
  exp_unobservable: [], // file write emits no session event
};

const USAGE_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"];

/** Incremental pure fold over session records. */
export function createFolder() {
  const state = {
    events: 0,
    turns: [],
    openTurn: null,
    steps: 0,
    toolCalls: [], // {seq, name, id}
    callIdToName: new Map(),
    goal: null,
    effects: {}, // tool -> {called, calls, callResult, worldEffect, support}
    usage: Object.fromEntries(USAGE_FIELDS.map((f) => [f, 0])),
    turnOutcome: null,
    unknownFields: [],
  };

  function closeTurn() {
    if (state.openTurn) state.turns.push(state.openTurn);
    state.openTurn = null;
  }

  function onEvent(event) {
    // session/end-seed is a log-only seed-boundary marker appended by the
    // Session constructor on official restore (E3 table). It carries no
    // execution/effect semantics; the live stream never contains it.
    if (event?.type === "session/end-seed") return;
    state.events += 1;
    const data = event?.data ?? {};
    switch (event?.type) {
      case "turn/start": {
        closeTurn();
        state.openTurn = {
          turn: data.turn ?? null,
          steps: 0,
          toolCalls: 0,
          toolErrors: 0,
          reason: null,
        };
        break;
      }
      case "step/start": {
        state.steps += 1;
        if (state.openTurn) state.openTurn.steps += 1;
        break;
      }
      case "tool/call": {
        const id = data.callId ?? data.id ?? data.call_id ?? null;
        const tname = String(data.name ?? data.toolName ?? "unknown");
        state.toolCalls.push({ seq: event.seq, name: tname, id });
        if (id !== null) state.callIdToName.set(String(id), tname);
        break;
      }
      case "tool/result": {
        // E3 semantics table: tool/result carries callId at
        // data.message.source.callId; the error signal is EMPIRICALLY the
        // ToolResultBlock-level isError flag inside data.message.content[]
        // (data.error stays absent for thrown tools on this DSH version).
        const id = data.callId ?? data.id ?? data.call_id ?? data.message?.source?.callId ?? null;
        const resolved = String(data.name ?? data.toolName ?? (id !== null ? state.callIdToName.get(String(id)) : null) ?? "unknown");
        const blocks = Array.isArray(data.message?.content) ? data.message.content : [];
        const isError = Boolean(
          data.isError === true ||
          data.error !== undefined ||
          blocks.some((block) => block?.isError === true),
        );
        if (state.openTurn) {
          state.openTurn.toolCalls += 1;
          if (isError) state.openTurn.toolErrors += 1;
        }
        const effect = state.effects[resolved] ?? (state.effects[resolved] = {
          called: false,
          calls: [],
          callResult: null,
          worldEffect: "unknown",
          support: [],
        });
        effect.called = true;
        effect.calls.push({ seq: event.seq, isError });
        effect.callResult = isError ? "failed" : "success";
        break;
      }
      case "turn/end": {
        if (state.openTurn) state.openTurn.reason = data.reason ?? null;
        closeTurn();
        state.turnOutcome = data.reason?.kind ?? null;
        break;
      }
      case "goal/change": {
        const change = data.change ?? data;
        state.goal = {
          operation: change.operation ?? null,
          phase: change.goal?.phase ?? null,
          revision: change.goal?.revision ?? null,
          roundsStarted: change.roundsStarted ?? null,
          support: [event.seq],
        };
        break;
      }
      case "assistant/message": {
        const usage = data.usage ?? {};
        for (const field of USAGE_FIELDS) {
          if (typeof usage[field] === "number") state.usage[field] += usage[field];
        }
        break;
      }
      default:
        break;
    }
  }

  function result() {
    if (state.openTurn) closeTurn();
    // World-effect verdicts: event-support rule (constraints #1-#3).
    // Each verdict cites the supporting record seqs; a called capability whose
    // effect has no supporting record (or whose effect model declares it
    // unobservable) is reported unknown — never fabricated.
    for (const [toolName, effect] of Object.entries(state.effects)) {
      const types = EFFECT_EVENT_TYPES[toolName] ?? ["tool/result"];
      if (types.length > 0 && types.includes("tool/result")) {
        // The recorded tool result embodies this capability's effect.
        effect.support = effect.calls.map((call) => call.seq);
        effect.worldEffect = effect.callResult ?? "unknown";
        if (effect.callResult === null) state.unknownFields.push(`effects.${toolName}.worldEffect`);
      } else {
        // Declared unobservable effect: no event type embodies it.
        effect.support = [];
        effect.worldEffect = "unknown";
        if (effect.called) state.unknownFields.push(`effects.${toolName}.worldEffect`);
      }
    }
    const toolErrors = state.turns.reduce((sum, t) => sum + t.toolErrors, 0);
    const verdict = {
      turn: state.turnOutcome,
      execution: state.toolCalls.length === 0 ? "none" : toolErrors > 0 ? "failed" : "success",
      effect: Object.fromEntries(Object.entries(state.effects).map(([k, e]) => [k, e.worldEffect])),
    };
    return {
      axes: {
        execution: {
          turns: state.turns.length,
          steps: state.steps,
          toolCalls: state.toolCalls.length,
          toolErrors,
          turnHistory: state.turns,
          turnOutcome: state.turnOutcome,
        },
        goal: state.goal,
        effect: state.effects,
      },
      verdict,
      unknownFields: [...state.unknownFields],
      usage: { ...state.usage },
      foldStats: { events: state.events, foldMs: null },
    };
  }

  return { onEvent, result };
}

/** One-shot fold over an event list (replay / offline verification). */
export function foldProjection(events) {
  const t0 = performance.now();
  const folder = createFolder();
  for (const event of events) folder.onEvent(event);
  const projection = folder.result();
  projection.foldStats.foldMs = Math.round((performance.now() - t0) * 1000) / 1000;
  return projection;
}

// ---------------------------------------------------------------------------
// Host plugin: live subscription to session/event only.
// ---------------------------------------------------------------------------

export function apply(ctx) {
  // Replay cells (pp-r) mount this plugin too; the fold there is driven by the
  // fixture's replay runner over the RESTORED log, so the live subscription
  // (and its exit-time write) must stay silent in replay mode — otherwise the
  // empty live fold would overwrite the live projection file.
  if (String(process.env.EXP_MODE ?? "live").trim().toLowerCase() === "replay") return;
  const resultsDir = String(process.env.EXP_RESULTS_DIR ?? "").trim();
  if (!resultsDir) return;

  const scenario = String(process.env.EXP_SCENARIO ?? "ok").toLowerCase();
  const run = String(process.env.EXP_RUN ?? "r1").replace(/[^a-zA-Z0-9_-]/g, "");
  const runId = `${scenario}-${run}`;

  let sessionId = null;
  let finalized = false;
  const folder = createFolder();
  const hostTiming = { totalUs: 0, events: 0, avgUsPerEvent: 0 };
  let lastEventTime = 0;

  const surface = {
    toolsRegistered: 0,
    agentApisCalled: 0,
    llmApisCalled: 0,
    promptEdits: 0,
  };

  ctx.on("session/event", (session, event) => {
    try {
      // A delegated child session is not the primary conversation: never let a
      // subagent take the latch, and never fold its events into the fact layer.
      // (Subagent prompts are recorded as source.kind === "user", so nothing
      // else distinguishes them here.)
      if (session?.header?.origin === "subagent") return;
      if (sessionId !== null && session?.id !== sessionId) return;
      if (sessionId === null) sessionId = session?.id ?? null;
      const t0 = performance.now();
      folder.onEvent(event);
      const dt = performance.now() - t0;
      hostTiming.totalUs += dt * 1000;
      hostTiming.events += 1;
      lastEventTime = event.time ?? lastEventTime;
    } catch {
      /* the fold must never break the session */
    }
  });

  function finalize() {
    if (finalized) return;
    finalized = true;
    try {
      hostTiming.avgUsPerEvent = hostTiming.events > 0 ? Math.round((hostTiming.totalUs / hostTiming.events) * 100) / 100 : 0;
      const projection = folder.result();
      projection.foldStats.foldMs = Math.round(hostTiming.totalUs) / 1000;
      const payload = {
        run: runId,
        sessionId,
        writtenAt: Date.now(),
        lastEventTime,
        projection,
        hostTiming,
        surface,
      };
      writeFileSync(join(resultsDir, `${runId}.projection.json`), `${JSON.stringify(payload, null, 2)}\n`);
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
