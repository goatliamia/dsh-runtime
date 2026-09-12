/**
 * dsh-runtime-seam — host-independent core (evidence-backed primitives E1-E7).
 *
 * This module never touches DSH APIs. It owns:
 *   - the fact registry (value/status/authority/revision/fingerprint)
 *   - teaching-reason templates (plain / authority-bearing)
 *   - the no-progress circuit tracker
 *   - preset definitions (Minimal / Strict / Goal / Custom)
 *   - activity records ("Why did Runtime intervene?")
 */
import { createHash } from "node:crypto";

// ---- deterministic hashing ----
export function stableValue(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
}

export function digest(value) {
  return createHash("sha256").update(stableValue(value)).digest("hex").slice(0, 16);
}

// ---- fact registry ----
const FACT_STATUSES = new Set(["known", "unknown", "stale", "conflicting"]);

export class FactRegistry {
  constructor() {
    this.facts = new Map();
  }

  setFact(path, value, { status = "known", authority = "host", reason = null } = {}) {
    if (!FACT_STATUSES.has(status)) throw new Error(`invalid fact status: ${status}`);
    const previous = this.facts.get(path);
    if (previous && previous.value === value && previous.status === status) {
      return { changed: false, fact: previous };
    }
    const revision = (previous?.revision ?? 0) + 1;
    const fact = {
      path,
      value: value === undefined ? null : value,
      status,
      authority,
      reason,
      revision,
      fingerprint: digest({ path, value }),
      changedAt: new Date().toISOString(),
      previousValue: previous ? previous.value : null,
    };
    this.facts.set(path, fact);
    return { changed: true, fact };
  }

  declareUnknown(path, reason = "host_did_not_expose_fact") {
    return this.setFact(path, null, { status: "unknown", reason });
  }

  fact(path) {
    return this.facts.get(path) ?? null;
  }

  list() {
    return [...this.facts.values()];
  }

  toJSON() {
    return Object.fromEntries([...this.facts.entries()].map(([path, fact]) => [path, fact]));
  }
}

// ---- teaching reasons (E1/E3/E5 format) ----
export function teachingReason({ action, fact, predicate, temporal = false, promise = false, authority = false }) {
  const lines = [`[action-rejected] ${action}`];
  lines.push(`fact: ${fact.path} = ${JSON.stringify(fact.value)}`);
  if (authority) {
    lines.push(
      `status: ${fact.status} | authority: ${fact.authority} | revision: ${fact.revision} | fingerprint: ${fact.fingerprint}`,
    );
  }
  lines.push(`predicate: ${predicate}`);
  if (temporal) {
    lines.push(`temporal: yes — the fact is expected to change`);
    lines.push(
      promise
        ? "next: wait for the runtime to announce the change (a delta will arrive), then retry"
        : "next: the precondition is not met yet; retry later",
    );
  } else {
    lines.push("temporal: no");
    lines.push("next: this action is not valid; drop it");
  }
  return lines.join("\n");
}

/**
 * The model-facing render of a circuit observation.
 *
 * Facts only: what was observed, how often, on what, and which registry entry
 * holds it. There is deliberately NO imperative. The first version ended with
 * "do not retry <tool>", and the measured response to that command was that the
 * model routed around the tool (edit -> write) while continuing the same work:
 * a command it can disobey is weaker than a fact it can act on. See
 * docs/status/circuit-fingerprint-vs-fs-errors-2026-09-11.md.
 */
export function circuitObservationText({ tool, target, code, count, threshold, factPath, fact }) {
  const where = target === undefined || target === null ? "" : ` on ${target}`;
  return [
    "[runtime-observation circuit-open]",
    `observed: "${tool}" failed ${count} times with the same failure${where} (threshold ${threshold}).`,
    `failure: ${code}`,
    `fact: ${factPath} = "${fact.value}" (authority: ${fact.authority}, revision: ${fact.revision}, fingerprint: ${fact.fingerprint})`,
  ].join("\n");
}

export function circuitOpenReason({ fact, authority = false }) {
  const lines = ["[action-rejected] circuit-open"];
  lines.push(`fact: ${fact.path} = "${fact.value}"`);
  if (authority) {
    lines.push(`status: known | authority: ${fact.authority} | revision: ${fact.revision} | fingerprint: ${fact.fingerprint}`);
  }
  lines.push("predicate: the same tool + failure + target repeated with no effect progress");
  lines.push("temporal: no");
  return lines.join("\n");
}

// ---- circuit tracker (E4/E4b) ----
// LEGACY (2026-09-02): superseded by core/runtime-circuit, which consumes the
// Progress fold (stalled x N). Kept exported for seam-internal compatibility
// until the preset rewiring lands; new policies must NOT depend on this class.
//
// 2026-09-11 -- fingerprint repaired. It used to be digest({tool, code}) with
// `code = /E\d+/ ?? "generic-error"`. DSH's filesystem errors carry codes like
// FS_NOT_OBSERVED, which contain no E<digits>, so EVERY filesystem failure of a
// tool collapsed into one counter: different files and unrelated causes piled
// up under a single signature and opened a circuit on `read`, `write` and
// `edit` -- three tools that are each other's remedy. Two changes:
//
//   1. A remediated protocol error is a TEACHING outcome carrying its own
//      remedy ("read the file, then retry"), exactly like a guard denial
//      ("[action-rejected]"), and must never open a circuit. It is not counted.
//   2. The fallback is the normalized error SHAPE rather than one shared token,
//      so the same mistake on two files still groups while "unread file" and
//      "old_string not found" no longer do.

/** Filesystem codes that carry their own remedy. Never evidence of a loop. */
const REMEDIATED_FS_CODES = new Set(["FS_NOT_OBSERVED", "FS_STALE_VERSION"]);

/**
 * The stable identity of an error: quoted spans and absolute paths are blanked
 * and whitespace is collapsed, so two occurrences of the same failure compare
 * equal while two different failures do not.
 */
export function errorShape(errorText) {
  return String(errorText ?? "")
    .replace(/"[^"\n]*"/g, '"<str>"')
    .replace(/'[^'\n]*'/g, '"<str>"')
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/** The remediated filesystem code in an error text, if it carries one. */
export function remediatedFsCode(errorText) {
  const match = /(?:^|\n)\s*(FS_[A-Z_]+)\s*$/m.exec(String(errorText ?? ""));
  const code = match?.[1];
  return code !== undefined && REMEDIATED_FS_CODES.has(code) ? code : undefined;
}

/**
 * The path an error is about, when it names one.
 *
 * A circuit is per TOOL, but the natural unit of a loop in a filesystem tool is
 * (tool, path): "read this path twice" is a loop, "read two different paths
 * that both 404" is exploration. Without the target, the second case opens a
 * circuit on `read` -- the very tool the model needs to make progress.
 * Windows paths are case-insensitive, so the target is folded.
 */
export function errorTarget(errorText) {
  const match = /"([^"\n]*[\\/][^"\n]*)"|'([^'\n]*[\\/][^'\n]*)'/.exec(String(errorText ?? ""));
  const path = match?.[1] ?? match?.[2];
  return path === undefined ? undefined : path.toLowerCase();
}

export class CircuitTracker {
  constructor({ threshold = 2 } = {}) {
    this.threshold = threshold;
    this.counts = new Map();
    this.open = new Set(); // tool names with an open circuit
    this.exempted = 0;
  }

  /**
   * Same tool + same error identity + same target = same loop.
   * A remediated protocol error is exempt: it returns `exempt: true` and is
   * never counted towards a circuit.
   */
  observeFailure(tool, errorText, threshold = this.threshold) {
    const text = String(errorText ?? "");
    const remediated = remediatedFsCode(text);
    if (remediated !== undefined) {
      this.exempted += 1;
      return { opened: false, exempt: true, tool, code: remediated, signature: null, count: 0 };
    }
    const code = /E\d+/.exec(text)?.[0] ?? errorShape(text);
    const target = errorTarget(text);
    const signature = digest(target === undefined ? { tool, code } : { tool, code, target });
    const count = (this.counts.get(signature) ?? 0) + 1;
    this.counts.set(signature, count);
    if (count >= threshold && !this.open.has(tool)) {
      this.open.add(tool);
      return { opened: true, exempt: false, tool, code, target, signature, count };
    }
    return { opened: false, exempt: false, tool, code, target, signature, count };
  }
}

// ---- presets: responsibility combinations, not strength levels ----
// 2026-09-02 reframe (docs/17, docs/18): presets select WHICH deterministic
// responsibilities the Runtime takes, not "how strict" it is.
// 2026-09-03 two-axis reframe (docs/18 update):
//   PRE  (事前)  continuation  单一开关：唯一确定的下一步由 Runtime 执行
//   POST (事后)  guard/circuit/reconcile/investigate 模式选择器
//   基础          delta/persistence/goal/query/exposure
// PRE 与 POST 是独立轴（不必落在同一个模式里）：preset 键只表示 POST 模式，
// continuation 键独立开关。POST 职责：
//   guard       已知非法动作拦截（执行前：能不能做）
//   circuit     连续无进展熔断（消费 progress 的 stalled）
//   reconcile   副作用可能已发生时不盲目重试（failure + progressed）
//   investigate 成功但未生效 → 验证修复（success + stalled）
//   delta       critical-delta-first 上下文（placement 实验定稿：不折腾）
export const PRESETS = Object.freeze({
  off: Object.freeze({ continuation: false, guard: false, circuit: false, reconcile: false, investigate: false, delta: "none", persistence: false, goal: false, query: false, exposure: "silent" }),
  minimal: Object.freeze({ continuation: false, guard: true, circuit: true, reconcile: false, investigate: false, delta: "critical", persistence: false, goal: false, query: true, exposure: "silent" }),
  balanced: Object.freeze({ continuation: false, guard: true, circuit: true, reconcile: true, investigate: false, delta: "critical", persistence: false, goal: false, query: true, exposure: "silent" }),
  strict: Object.freeze({ continuation: false, guard: true, circuit: true, reconcile: true, investigate: true, delta: "critical", persistence: true, goal: false, query: true, exposure: "silent" }),
  goal: Object.freeze({ continuation: false, guard: true, circuit: true, reconcile: false, investigate: false, delta: "critical", persistence: true, goal: true, query: true, exposure: "silent" }),
  custom: null, // resolved from explicit capability overrides
});

export const PRESET_NAMES = ["off", "minimal", "balanced", "strict", "goal", "custom"];

/** POST-axis mode names shown in the UI (goal stays a legacy preset value). */
export const POST_PRESET_NAMES = ["off", "minimal", "balanced", "strict", "custom"];

export function resolvePreset(preset, capabilities) {
  const base = PRESETS[preset] ?? PRESETS.minimal;
  return { ...base, ...(capabilities ?? {}) };
}

// ---- activity record ("Why did Runtime intervene?") ----
export function activityRecord(kind, data) {
  return { t: new Date().toISOString(), kind, ...data };
}
