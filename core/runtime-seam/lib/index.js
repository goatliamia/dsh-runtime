/**
 * dsh-runtime-seam host half.
 *
 * The DSH adapter over the evidence-backed core (E1-E7). Defaults follow the
 * Minimal preset: teaching guard + no-progress circuit + critical delta only +
 * silence everywhere else. Everything is opt-in through the `runtime-seam`
 * settings namespace (preset + capability overrides).
 */
import { isIP } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Schema from "@deepseek-ai/schemastery";

import {
  CircuitTracker,
  FactRegistry,
  PRESET_NAMES,
  activityRecord,
  circuitOpenReason,
  resolvePreset,
  teachingReason,
} from "./core.mjs";

export const name = "dsh-runtime-seam";
export const inject = ["tools", "settings", "commands"];

const API_PREFIX = "/api/runtime-seam";
const STATE_DIR = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "plugins", "dsh-runtime-seam");
const STATE_FILE = join(STATE_DIR, "state.json");
const ACTIVITY_CAP = 200;

const SETTINGS_SCHEMA = Schema.object({
  preset: Schema.union(PRESET_NAMES.map((value) => Schema.const(value))).default("minimal"),
  continuation: Schema.boolean().default(false),
  authority: Schema.boolean().default(false),
  circuitThreshold: Schema.number().default(2),
  capabilities: Schema.dict(Schema.any()).default({}),
  experimental: Schema.object({
    autoPickupInjection: Schema.boolean().default(false),
    broadExposure: Schema.boolean().default(false),
    reconcile: Schema.boolean().default(false),
  }).default({ autoPickupInjection: false, broadExposure: false, reconcile: false }),
});

function trustedRequest(req) {
  const remote = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
  const loopback = remote === "::1" || remote === "127.0.0.1" || (isIP(remote) === 4 && remote.startsWith("127."));
  if (!loopback) return false;
  if (req.headers?.["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers?.origin;
  const host = req.headers?.host;
  if (typeof origin !== "string" || typeof host !== "string") return req.headers?.["sec-fetch-site"] === "same-origin";
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader?.("content-type", "application/json; charset=utf-8");
  res.setHeader?.("cache-control", "no-store");
  res.end(body);
}

export function apply(ctx, _config) {
  const tools = ctx.tools;
  const settingsScope = ctx.settings.register("runtime-seam", SETTINGS_SCHEMA);

  const registry = new FactRegistry();
  const circuit = new CircuitTracker({ threshold: 2 });
  const guardRules = new Map(); // action -> rule
  const commitments = new Map(); // factPath -> { desired }
  const goalRecords = new Map(); // factPath -> goal record (view + dispose)
  const activity = [];
  const pendingDeltas = []; // messages to inject at the next pre-step
  let sessionId = null;
  let currentStep = 0;
  let teachingFailures = 0;

  const recordActivity = (kind, data) => {
    const payload = { ...data };
    // A payload field must never clobber the record kind.
    delete payload.kind;
    const entry = activityRecord(kind, payload);
    activity.push(entry);
    if (activity.length > ACTIVITY_CAP) activity.shift();
    for (const listener of activityListeners) {
      try {
        listener(entry);
      } catch {
        /* an activity listener must never break the runtime */
      }
    }
    return entry;
  };
  const activityListeners = new Set();

  const readConfig = () => {
    let settings;
    try {
      settings = settingsScope.get() ?? { preset: "minimal" };
    } catch {
      settings = { preset: "minimal" };
    }
    const preset = settings.preset ?? "minimal";
    const customCaps = settings.capabilities ?? {};
    // PRE (continuation) is an independent axis: it rides on whatever POST
    // preset is selected and can also be flipped inside custom mode.
    const continuationOverride = typeof settings.continuation === "boolean" ? { continuation: settings.continuation } : {};
    return {
      settings,
      capabilities: resolvePreset(preset, preset === "custom" ? { ...customCaps, ...continuationOverride } : continuationOverride),
    };
  };

  const configNow = () => readConfig().capabilities;
  const settingsNow = () => readConfig().settings;

  // ---- persistence (Strict / Goal only; the load is preset-gated so a
  // persisted world can never leak into off/minimal sessions) ----
  if (readConfig().capabilities.persistence && existsSync(STATE_FILE)) {
    try {
      const saved = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      for (const [path, fact] of Object.entries(saved.facts ?? {})) {
        registry.setFact(path, fact.value, {
          status: fact.status ?? "known",
          authority: fact.authority ?? "host",
          reason: fact.reason ?? null,
        });
      }
    } catch {
      /* corrupt state file: start empty, never fail boot */
    }
  }

  function persist() {
    if (!configNow().persistence) return;
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(
        STATE_FILE,
        JSON.stringify({ savedAt: new Date().toISOString(), facts: registry.toJSON() }, null, 2),
      );
    } catch {
      /* persistence must never fail the run */
    }
  }

  // ---- seam service for other runtime-* plugins ----
  const seam = {
    fact: (path) => registry.fact(path),
    setFact: (path, value, options) => {
      const result = registry.setFact(path, value, options);
      if (result.changed) {
        recordActivity("change", { path, value, revision: result.fact.revision });
        for (const [commitPath, commitment] of commitments) {
          if (commitPath === path && commitment.desired === value) {
            pendingDeltas.push({
              kind: "committed-delta",
              fact: registry.fact(path),
              text: `[runtime-observation committed-delta]\n${path} = ${JSON.stringify(value)} (authority: ${result.fact.authority}, revision: ${result.fact.revision}, fingerprint: ${result.fact.fingerprint})`,
            });
          }
        }
        for (const goal of goalRecords.values()) {
          if (goal.factPath === path) {
            goal.state = value === goal.desired ? "satisfied" : "pending";
            recordActivity("goal", { factPath: path, desired: goal.desired, state: goal.state });
          }
        }
        persist();
      }
      return result;
    },
    declareUnknown: (path, reason) => seam.setFact(path, null, { status: "unknown", reason }),
    commit: ({ factPath, desired }) => {
      commitments.set(factPath, { desired });
      return () => commitments.delete(factPath);
    },
    /**
     * Goal v1 (narrow, per design review): Current + Desired + known transition.
     * Runtime announces (committed delta on change) and guards (existing guard
     * rules) — it NEVER executes the transition itself; runtime-executed
     * reconcile stays behind the experimental switch.
     */
    registerGoal: ({ factPath, desired, transitionNote = null }) => {
      const dispose = seam.commit({ factPath, desired });
      const current = registry.fact(factPath);
      const goal = {
        factPath,
        desired,
        transitionNote,
        state: current?.value === desired ? "satisfied" : "pending",
        declaredAt: new Date().toISOString(),
        dispose: () => {
          goalRecords.delete(factPath);
          dispose();
        },
      };
      goalRecords.set(factPath, goal);
      recordActivity("goal", { factPath, desired, state: goal.state });
      return goal;
    },
    removeGoal: (factPath) => {
      const record = goalRecords.get(factPath);
      if (!record) return false;
      try {
        record.dispose();
      } catch {
        /* dispose must be silent */
      }
      recordActivity("goal-removed", { factPath });
      return true;
    },
    goals: () =>
      [...goalRecords.values()].map(({ factPath, desired, transitionNote, state, declaredAt }) => ({
        factPath,
        desired,
        transitionNote,
        state,
        declaredAt,
      })),
    registerGuard: ({ action, factPath, predicate, predicateText, temporal = false, promise = false }) => {
      if (guardRules.has(action)) throw new Error(`runtime-seam: guard already registered for ${action}`);
      guardRules.set(action, { action, factPath, predicate, predicateText, temporal, promise });
      recordActivity("guard-registered", { action, factPath });
      return () => guardRules.delete(action);
    },
    activity: () => [...activity],
    onActivity: (listener) => {
      activityListeners.add(listener);
      return () => activityListeners.delete(listener);
    },
    teachingFailures: () => teachingFailures,
    capabilities: () => configNow(),
  };
  ctx.provide("runtimeSeam", seam);

  // ---- one monotonic guard dispatcher over all registered rules ----
  ctx.effect(() =>
    tools.guard((exec) => {
      if (!configNow().guard) return undefined;
      const toolName = String(exec?.name ?? "");
      const rule = guardRules.get(toolName);
      if (!rule) return undefined;
      const fact = registry.fact(rule.factPath);
      if (!fact) return undefined;
      let allowed = true;
      try {
        allowed = rule.predicate(fact.value, exec);
      } catch {
        allowed = false;
      }
      if (allowed) return undefined;
      const reason = teachingReason({
        action: rule.action,
        fact,
        predicate: rule.predicateText,
        temporal: rule.temporal,
        promise: rule.promise,
        authority: settingsNow().authority,
      });
      const pair = `${rule.factPath}:${rule.action}`;
      const repeats = activity.filter((entry) => entry.kind === "guard" && entry.pair === pair).length;
      if (repeats >= 1) teachingFailures += 1;
      recordActivity("guard", { action: rule.action, reason, pair, revision: fact.revision, step: currentStep });
      return reason;
    }),
  );

  // ---- circuit observation (tools/result, the E4/E4b fingerprint loop) ----
  ctx.on("tools/result", (exec, result) => {
    if (!configNow().circuit) return;
    // A delegated child runs its own agent loop: folding its failures into this
    // fingerprint would let a child open a circuit that blocks the PRIMARY
    // agent's tool, and would inject the child's failure as the parent's
    // observation. Only the primary conversation owns a circuit.
    if (exec?.agent?.session?.header?.origin === "subagent") return;
    if (!result?.isError) return;
    const toolName = String(exec?.name ?? "");
    if (!toolName) return;
    const text = (result?.content ?? [])
      .map((block) => (block?.type === "text" ? block.text : ""))
      .join("");
    // A guard denial is a teaching outcome, not a tool failure: it must never
    // open a circuit (caught by the mode test, 2026-09-01).
    if (text.includes("[action-rejected]")) return;
    const outcome = circuit.observeFailure(toolName, text, Number(settingsNow().circuitThreshold) || 2);
    if (outcome.opened) {
      const factPath = `capabilities.${toolName}.state`;
      const factResult = seam.setFact(factPath, "failed", { authority: "runtime" });
      recordActivity("circuit", {
        tool: toolName,
        fingerprint: outcome.signature,
        repeated: outcome.count,
        progress: "none",
        result: "opened",
        step: currentStep,
      });
      pendingDeltas.push({
        kind: "circuit-open",
        fact: factResult.fact,
        text: `[runtime-observation circuit-open]\n${factPath} = "failed" (authority: runtime, revision: ${factResult.fact.revision}, fingerprint: ${factResult.fact.fingerprint})\nrepeated identical failure detected; do not retry ${toolName}.`,
      });
      persist();
    }
  });

  // ---- the guard dispatcher also rejects calls to tools with an open circuit
  // (E4b: reject + announce was the best variant) ----
  // handled inside the dispatcher below.

  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    try {
      sessionId = payload?.agent?.id ?? sessionId;
      currentStep = payload.step;
      const capabilities = configNow();
      if (decision.kind !== "enter") return decision;
      const messages = [...decision.messages];
      if (capabilities.delta === "none") return decision;
      for (const delta of pendingDeltas.splice(0)) {
        if (capabilities.delta === "critical" && delta.kind !== "committed-delta" && delta.kind !== "circuit-open") continue;
        recordActivity("delta", { type: delta.kind, path: delta.fact?.path, step: currentStep });
        messages.push({
          id: `rtx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "user",
          content: [{ type: "text", text: delta.text }],
          source: { kind: "plugin", plugin: "dsh-runtime-seam" },
        });
      }
      return { kind: "enter", messages };
    } catch {
      return decision;
    }
  });

  // ---- /runtime-goal command: surfaces in the "+" trigger menu and the
  // slash input, matching the official /goal convention. ----
  ctx.effect(() =>
    ctx.commands.register({
      name: "runtime-goal",
      description: "declare or view a Runtime goal (environment fact -> desired value)",
      input: {
        hint: "[<factPath> <desired> [transition-note] | remove <factPath> | clear]",
      },
      handler: (invocation) => {
        const raw = String(invocation?.rawInput ?? "").trim();
        const parts = raw.split(/\s+/).filter(Boolean);
        const render = () => {
          const goals = seam.goals();
          const lines = goals.length
            ? goals.map((goal) => `- ${goal.factPath} → ${String(goal.desired)} (${goal.state === "satisfied" ? "satisfied" : "pending"})`).join("\n")
            : "- (none)";
          return `Runtime goals:\n${lines}\n\n用法: /runtime-goal <factPath> <desired> [transition-note]\n      /runtime-goal remove <factPath>  /runtime-goal clear`;
        };
        if (!parts.length) return { kind: "success", text: render() };
        if (parts[0] === "remove" && parts[1]) {
          const removed = seam.removeGoal(parts[1]);
          return removed
            ? { kind: "success", text: `已移除 Runtime 目标 ${parts[1]}。` }
            : { kind: "error", text: `没有找到目标 ${parts[1]}。\n${render()}` };
        }
        if (parts[0] === "clear") {
          for (const goal of seam.goals()) seam.removeGoal(goal.factPath);
          return { kind: "success", text: "已清除全部 Runtime 目标。" };
        }
        if (parts.length >= 2) {
          const desiredRaw = parts[1];
          let desired;
          if (desiredRaw === "true") desired = true;
          else if (desiredRaw === "false") desired = false;
          else if (desiredRaw !== "" && !Number.isNaN(Number(desiredRaw))) desired = Number(desiredRaw);
          else desired = desiredRaw;
          const goal = seam.registerGoal({
            factPath: parts[0],
            desired,
            transitionNote: parts.slice(2).join(" ") || null,
          });
          return {
            kind: "success",
            text: `已声明 Runtime 目标：${goal.factPath} → ${String(goal.desired)}（当前 ${goal.state === "satisfied" ? "已满足" : "等待中"}）。`,
          };
        }
        return { kind: "error", text: `无法解析。\n${render()}` };
      },
    }),
  );

  // ---- activity + config route for the client ("Why did Runtime intervene?")
  // webServer does not exist in headless profiles: the seam must stay
  // fully functional without any HTTP surface.
  const webServer = ctx.get("webServer");
  if (webServer) {
    ctx.effect(() =>
      webServer.register({
        kind: "exact",
        path: `${API_PREFIX}/activity`,
        handler(req, res) {
          if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
          if (!trustedRequest(req)) return writeJson(res, 403, { ok: false, error: "forbidden" });
          writeJson(res, 200, {
            ok: true,
            data: {
              preset: settingsNow().preset,
              capabilities: configNow(),
              activity: [...activity].slice(-50).reverse(),
              goals: seam.goals(),
              teachingFailures,
              facts: registry.list().map((fact) => ({
                path: fact.path,
                value: fact.value,
                status: fact.status,
                authority: fact.authority,
                revision: fact.revision,
                fingerprint: fact.fingerprint,
              })),
            },
          });
        },
      }),
    );
    ctx.effect(() =>
      webServer.register({
        kind: "exact",
        path: `${API_PREFIX}/config`,
        handler: async (req, res) => {
          if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
          if (!trustedRequest(req)) return writeJson(res, 403, { ok: false, error: "forbidden" });
          try {
            const chunks = [];
            for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
            // Custom mode: capability toggles live in the settings namespace
            // (settings.yaml) so users can also hand-edit the file.
            if (body.preset === "custom" && body.capabilities && typeof body.capabilities === "object") {
              const patch = {};
              for (const key of ["guard", "circuit", "reconcile", "investigate", "persistence", "query", "goal"]) {
                if (typeof body.capabilities[key] === "boolean") patch[key] = body.capabilities[key];
              }
              if (body.capabilities.delta === "critical" || body.capabilities.delta === "none") {
                patch.delta = body.capabilities.delta;
              }
              await ctx.settings.update("runtime-seam", { preset: "custom", capabilities: patch });
              return writeJson(res, 200, { ok: true, data: { preset: "custom", capabilities: patch } });
            }
            if (typeof body.preset === "string" && PRESET_NAMES.includes(body.preset)) {
              const update = { preset: body.preset };
              if (typeof body.continuation === "boolean") update.continuation = body.continuation;
              await ctx.settings.update("runtime-seam", update);
              return writeJson(res, 200, { ok: true, data: update });
            }
            // PRE-axis flip without changing the POST mode.
            if (typeof body.continuation === "boolean" && body.preset === undefined) {
              await ctx.settings.update("runtime-seam", { continuation: body.continuation });
              return writeJson(res, 200, { ok: true, data: { continuation: body.continuation } });
            }
            return writeJson(res, 400, { ok: false, error: "invalid-preset" });
          } catch {
            return writeJson(res, 400, { ok: false, error: "bad-request" });
          }
        },
      }),
    );
    ctx.effect(() =>
      webServer.register({
        kind: "exact",
        path: `${API_PREFIX}/goals`,
        handler: async (req, res) => {
          if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
          if (!trustedRequest(req)) return writeJson(res, 403, { ok: false, error: "forbidden" });
          try {
            const chunks = [];
            for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
            if (body.action === "add") {
              if (typeof body.factPath !== "string" || !body.factPath.trim()) {
                return writeJson(res, 400, { ok: false, error: "factPath-required" });
              }
              const goal = seam.registerGoal({
                factPath: body.factPath.trim(),
                desired: body.desired ?? null,
                transitionNote: typeof body.transitionNote === "string" ? body.transitionNote : null,
              });
              return writeJson(res, 200, { ok: true, data: goal });
            }
            if (body.action === "remove") {
              if (typeof body.factPath !== "string") return writeJson(res, 400, { ok: false, error: "factPath-required" });
              const removed = seam.removeGoal(body.factPath);
              return writeJson(res, 200, { ok: true, data: { removed } });
            }
            return writeJson(res, 400, { ok: false, error: "invalid-action" });
          } catch {
            return writeJson(res, 400, { ok: false, error: "bad-request" });
          }
        },
      }),
    );
  }
}
