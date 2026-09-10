// dsh-notify host plugin.
//
// Sends the user an OS notification (with sound by default) whenever the AI
// finishes a conversation turn. This targets the exact scenario of working in
// another browser tab or window: as soon as the agent stops running — a turn
// ends in a completed / error / max-tokens / blocked state — a system toast
// pops up and an alert sound plays.
//
// How it works
// ------------
// Every DSH session is an append-only event log. The agent loop brackets each
// AI conversation turn with `turn/start` and `turn/end` events, and all live
// appends are broadcast on the Cordis `session/event` hook. This plugin:
//
//   1. listens to `session/event` (global scope → sees every live session),
//   2. on `turn/end` checks the end reason and conversation eligibility,
//   3. composes a short summary (from the last assistant message of the turn),
//   4. raises an OS notification through `./notify.js` (fire-and-forget).
//
// Notifications never block or break the agent loop: handlers are defensive,
// the notifier swallows its own errors, and events are dispatched in a way the
// session layer isolates per listener.

import { notify } from "./notify.js";

export const name = "dsh-notify";

/** Human labels for the turn-end reasons we notify about by default. */
const REASON_LABELS = {
  completed: "AI 已完成对话",
  error: "AI 对话出错",
  "max-tokens": "AI 达到输出上限",
  blocked: "对话等待处理",
};

const DEFAULT_CONFIG = Object.freeze({
  /** Master switch. Set to false to load the plugin without any effect. */
  enabled: true,
  /** Play an alert sound together with the notification. */
  sound: true,
  /** Optional explicit path to a .wav to play instead of the system sound. */
  soundFile: undefined,
  /** Turn-end reasons that trigger a notification. */
  reasons: ["completed", "error", "max-tokens", "blocked"],
  /**
   * Only notify for conversations that received direct human input. Internal
   * sessions (subagents, scheduled/plugin-injected work) never notify, which
   * prevents a burst of toasts while one main task fans out.
   */
  onlyDirectConversations: true,
  /**
   * Ignore turns that finished faster than this (ms). The agent loop opens a
   * turn for every claimed queue item, including empty ones that end almost
   * instantly with no work; this filters that noise out. Set 0 to notify for
   * every turn.
   */
  minTurnMs: 250,
  /** Cap the notification body preview (in characters). */
  previewChars: 160,
  /** How long the notification stays visible (ms). */
  balloonMs: 8000,
  /** Optional fixed notification title override. */
  title: undefined,
});

/** Build a scoped logger that degrades to console output. */
function createLogger(ctx) {
  try {
    if (ctx && typeof ctx.logger === "function") {
      const logger = ctx.logger("dsh-notify");
      if (logger && typeof logger.info === "function") return logger;
    }
  } catch {
    /* fall through to console */
  }
  return {
    info: (...args) => console.log("[dsh-notify]", ...args),
    warn: (...args) => console.warn("[dsh-notify]", ...args),
    error: (...args) => console.error("[dsh-notify]", ...args),
  };
}

/** Did this conversation ever receive a direct human message? */
function hasDirectUserInput(events) {
  for (const event of events) {
    if (event.type === "user/message" && event.data?.source?.kind === "user") {
      return true;
    }
  }
  return false;
}

/** Plain text of an assistant message, ignoring non-text blocks. */
function assistantText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  let text = "";
  for (const block of blocks) {
    if (block && typeof block === "object" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text.trim();
}

/** Last assistant message text belonging to `turn`, whitespace-collapsed. */
function lastTurnAssistantText(events, turn, maxChars) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type !== "assistant/message") continue;
    if (event.data?.turn !== turn) continue;
    const text = assistantText(event.data?.message);
    if (!text) continue;
    const collapsed = text.replace(/\s+/gu, " ").trim();
    if (collapsed.length <= maxChars) return collapsed;
    const head = [...collapsed].slice(0, Math.max(0, maxChars - 1)).join("");
    return `${head}…`;
  }
  return "";
}

/** ms the turn took to run, or null when no matching turn/start exists. */
function turnDurationMs(events, turn, endTime) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === "turn/start" && event.data?.turn === turn) {
      const start = Number(event.time);
      const end = Number(endTime);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        return Math.max(0, end - start);
      }
      return null;
    }
  }
  return null;
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const reasons = Array.isArray(cfg.reasons) ? cfg.reasons.map(String) : [];
  const logger = createLogger(ctx);
  // Per (session, turn) deduplication for the rare double-delivery case.
  const notified = new Map();

  const pruneNotified = () => {
    while (notified.size > 512) {
      const oldest = notified.keys().next();
      if (oldest.done) break;
      notified.delete(oldest.value);
    }
  };

  if (!cfg.enabled) {
    logger.info("disabled by config — loaded without effect");
    return;
  }

  const handleTurnEnd = (session, event) => {
    const { data } = event;
    const kind = data?.reason?.kind;
    const turn = data?.turn;
    if (typeof kind !== "string" || typeof turn !== "number") return;
    if (reasons.length > 0 && !reasons.includes(kind)) return;

    // A delegation child is not a conversation the user is waiting on. Its
    // initial prompt is recorded with source.kind === "user" (measured on
    // 0.1.3-alpha.2 and 0.1.5-rc.1), so the user-input heuristic below cannot
    // filter it — the session header can.
    if (session?.header?.origin === "subagent") return;

    const events = Array.isArray(session?.events) ? session.events : [];
    if (events.length === 0) return;

    // Skip work that never talked to a human (subagent/plugin sessions).
    if (cfg.onlyDirectConversations && !hasDirectUserInput(events)) return;

    // Skip instant no-op turns (empty queue claims etc.).
    if (cfg.minTurnMs > 0) {
      const duration = turnDurationMs(events, turn, event.time);
      if (duration !== null && duration < cfg.minTurnMs) return;
    }

    const key = `${session.id}:${turn}`;
    if (notified.has(key)) return;
    notified.set(key, true);
    pruneNotified();

    const preview = lastTurnAssistantText(events, turn, cfg.previewChars);
    const label = REASON_LABELS[kind] ?? `对话结束（${kind}）`;
    const title = cfg.title || `DeepSeek Harness · ${label}`;
    const body = preview || (turn ? `第 ${turn} 轮对话结束（${kind}）` : label);

    logger.info(
      `session ${session.id} · turn ${turn} ended as ${kind} — notifying`,
      preview ? `「${preview}」` : "(no assistant text)",
    );

    notify({
      title,
      body,
      sound: cfg.sound !== false,
      ...(cfg.soundFile ? { soundFile: cfg.soundFile } : {}),
      balloonMs: Number(cfg.balloonMs) > 0 ? Number(cfg.balloonMs) : 8000,
    }).then((delivered) => {
      if (!delivered) {
        logger.warn(`notification could not be delivered (session ${session.id}, turn ${turn})`);
      }
    });
  };

  // `global: true` keeps the listener authoritative no matter which subtree
  // the plugin is loaded into; live appends are the only events delivered, so
  // replayed/seed history never triggers a notification.
  ctx.on(
    "session/event",
    (session, event) => {
      try {
        if (event?.type === "turn/end") handleTurnEnd(session, event);
      } catch (error) {
        logger.error(`error handling ${event?.type}:`, error);
      }
    },
    { global: true },
  );

  ctx.on("session/disposed", (session) => {
    // Drop dedupe state for gone sessions.
    for (const key of notified.keys()) {
      if (key.startsWith(`${session.id}:`)) notified.delete(key);
    }
  });

  logger.info(
    `ready — will notify when a conversation turn ends (reasons: ${reasons.join(", ") || "none"}; sound: ${cfg.sound ? "on" : "off"})`,
  );
}
