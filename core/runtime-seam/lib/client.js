// dsh-runtime-seam client half (self-registering bundle).
// 三个入口（全部主题 token 化、文案中文化）：
//   - conversation.input.left：Runtime 控制（事前/事后速览 + 介入原因弹层）
//   - settings.section：Runtime 设置页（场景预设 + 事前开关 + 事后模式 +
//     自定义勾选 + 目标 + 介入日志 + 本次会话摘要）
// 设计依据：docs/18-runtime-frontend-design.md（2026-09-03 双轴改版）：
//   事前 PRE（一个开关）：continuation —— 唯一确定的下一步由 Runtime 执行，
//     模型只消化结果。独立于事后模式。
//   事后 POST（模式选择器）：Off/Minimal/Balanced/Strict/Custom，
//     对应 guard/circuit/reconcile/investigate 职责组合。
window.__ModuleLoader__.load({
  id: "dsh-runtime-seam",
  factory: (require) => {
    const React = require("react");
    const { useEffect, useState } = React;
    const el = React.createElement;

    const POST_MODES = ["off", "minimal", "balanced", "strict", "custom"];
    const POST_LABEL = { off: "Off", minimal: "Minimal", balanced: "Balanced", strict: "Strict", custom: "Custom" };
    // Scene presets are shortcuts over BOTH axes (docs/18 §3 layer 0).
    const SCENES = [
      { key: "creative", label: "Creative", desc: "少打扰：事前不接管、事后仅拦必拦", preset: "minimal", continuation: false },
      { key: "coding", label: "Coding", desc: "确定步骤交给 Runtime，事后重视验证", preset: "balanced", continuation: true },
      { key: "external", label: "External Actions", desc: "重视副作用与超时确认", preset: "balanced", continuation: false },
      { key: "safe", label: "Safe", desc: "宁愿多验证，不轻易当完成", preset: "strict", continuation: true },
    ];
    // POST-axis capability toggles (docs/18 §3 layer 2).
    const POST_ITEMS = [
      { key: "guard", label: "Guard（已知非法的动作）" },
      { key: "circuit", label: "Circuit（连续无进展熔断）" },
      { key: "reconcile", label: "Reconcile（副作用可能已发生时不盲目重试）" },
      { key: "investigate", label: "Verify & repair（成功但未生效 → 验证修复）" },
    ];
    const BASE_ITEMS = [
      { key: "delta", label: "Critical delta（只通知承诺过的变更）" },
      { key: "exposure", label: "Runtime snapshot（全量上下文，实验未显示优势）" },
      { key: "persistence", label: "Persistence（事实跨会话持久化）" },
      { key: "query", label: "Query（权威应答）" },
      { key: "goal", label: "Goal（目标跟踪）" },
    ];

    const font = { fontFamily: "inherit", fontSize: "12px", color: "var(--dsw-alias-label-primary)" };
    const row = { display: "flex", gap: "8px", alignItems: "center" };
    const button = {
      ...font,
      padding: "3px 10px",
      borderRadius: "7px",
      border: "1px solid var(--dsw-alias-border-l1)",
      background: "transparent",
      cursor: "pointer",
      fontWeight: 400,
      outline: "none",
    };
    const activeButton = {
      ...button,
      fontWeight: 700,
    };
    const popover = {
      ...font,
      position: "absolute",
      bottom: "110%",
      left: 0,
      width: 330,
      maxHeight: 380,
      overflow: "auto",
      padding: "10px 12px",
      borderRadius: "10px",
      border: "1px solid var(--dsw-alias-border-l1)",
      background: "var(--dsw-alias-bg-overlay)",
      boxShadow: "0 8px 24px rgba(0,0,0,.35)",
      zIndex: 60,
    };
    const mono = { fontFamily: "ui-monospace, monospace", fontSize: "11px" };
    const sectionTitle = { fontWeight: 600, marginBottom: 4, color: "var(--dsw-alias-label-primary)" };
    const secondary = { color: "var(--dsw-alias-label-secondary)" };
    const summaryCard = {
      ...font,
      padding: "8px 10px",
      borderRadius: "8px",
      border: "1px solid var(--dsw-alias-border-l1)",
      background: "var(--dsw-alias-bg-layer-1)",
      marginBottom: 10,
    };
    const axisCard = {
      ...font,
      fontSize: "13px",
      padding: "10px 12px",
      borderRadius: "10px",
      border: "1px solid var(--dsw-alias-border-l1)",
      background: "var(--dsw-alias-bg-layer-1)",
      marginBottom: 12,
    };

    function useActivity() {
      const [state, setState] = useState({ loading: true, data: null });
      const reload = () => {
        fetch("/api/runtime-seam/activity")
          .then((res) => res.json())
          .then((body) => {
            if (body && body.ok) setState({ loading: false, data: body.data });
          })
          .catch(() => {});
      };
      useEffect(() => {
        reload();
        const timer = setInterval(reload, 5000);
        return () => clearInterval(timer);
      }, []);
      return { ...state, reload };
    }

    function postJson(path, payload) {
      return fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    // ---- "这次帮你做了什么" (docs/18 §3 layer 3) ----
    function summaryOf(entries) {
      const counts = { circuit: 0, guard: 0, delta: 0, continuation: 0 };
      for (const entry of entries ?? []) {
        if (counts[entry.kind] !== undefined) counts[entry.kind] += 1;
      }
      const parts = [];
      if (counts.continuation > 0) parts.push(`executed ${counts.continuation} deterministic step(s)`);
      if (counts.circuit > 0) parts.push(`stopped ${counts.circuit} no-progress retry loop(s)`);
      if (counts.guard > 0) parts.push(`blocked ${counts.guard} invalid action(s)`);
      if (counts.delta > 0) parts.push(`notified ${counts.delta} committed change(s)`);
      return parts.length > 0 ? `这次帮你做了什么：${parts.join(" · ")}` : "这次帮你做了什么：0 interventions — 默认沉默。";
    }

    function ActivityLine(entry) {
      const time = new Date(entry.t).toLocaleTimeString();
      const kind = entry.kind;
      const name =
        kind === "continuation" ? "Pre" :
        kind === "continuation-ambiguous" ? "Pre·ambiguous" :
        kind === "guard" ? "Guard" :
        kind === "circuit" ? "Circuit" :
        kind === "delta" ? "Delta" :
        kind === "reconcile" ? "Reconcile" :
        kind === "investigate" ? "Investigate" :
        kind === "goal" ? "目标" :
        kind === "goal-removed" ? "目标移除" :
        kind === "change" ? "Change" : kind;
      let body = null;
      if (kind === "continuation") body = el("div", { style: mono }, (entry.action ?? "") + (entry.outcome ? " → " + entry.outcome : ""));
      else if (kind === "guard") body = el("div", { style: mono }, entry.action + " · rev " + entry.revision);
      else if (kind === "circuit") body = el("div", { style: mono }, entry.tool + " 重复 " + entry.repeated + " 次 → " + entry.result);
      else if (kind === "delta") body = el("div", { style: mono }, entry.type + " " + (entry.path ?? ""));
      else if (kind === "goal") body = el("div", { style: mono }, entry.factPath + " → " + String(entry.desired) + "（" + (entry.state === "satisfied" ? "已满足" : "等待中") + "）");
      else if (kind === "change") body = el("div", { style: mono }, entry.path + " → rev " + entry.revision);
      return el("div", { key: entry.t + kind + Math.random(), style: { marginBottom: 6 } },
        el("div", { style: row }, el("strong", null, name), el("span", { style: secondary }, time)), body);
    }

    function ActivityList({ entries, empty }) {
      if (!entries || !entries.length) return el("div", { style: secondary }, empty ?? "暂无干预记录——默认沉默。");
      return el("div", null, entries.slice(0, 20).map(ActivityLine));
    }

    // ---- 输入行左侧 Runtime 控制（双轴速览） ----
    function RuntimeButton() {
      const { data } = useActivity();
      const [open, setOpen] = useState(false);
      const preset = data?.preset ?? "…";
      const continuation = data?.capabilities?.continuation === true;
      return el("div", { style: { position: "relative" } },
        el("button", { style: button, title: "Runtime", onClick: () => setOpen((v) => !v) },
          "Runtime · 前" + (continuation ? "✓" : "—") + " · 后" + (POST_LABEL[preset] ?? preset)),
        open ? el("div", { style: popover },
          el("div", { style: summaryCard }, summaryOf(data?.activity)),
          el("div", { style: sectionTitle }, "为什么 Runtime 介入？"),
          el(ActivityList, { entries: data?.activity })) : null);
    }

    // ---- 设置页：事前开关 ----
    function PreAxis({ caps, reload }) {
      const enabled = caps.continuation === true;
      return el("div", { style: axisCard },
        el("div", { style: { ...row, justifyContent: "space-between" } },
          el("div", null,
            el("div", { style: sectionTitle }, "事前 · Pre（替模型走确定性的一步）"),
            el("div", { style: secondary },
              "当事实与契约把下一步压缩到唯一时，Runtime 直接执行（走正常权限/守卫/取消边界），模型只消化已发生的结果。无把握时一律不接管。")),
          el("label", { style: { ...row, cursor: "pointer" } },
            el("span", { style: secondary }, enabled ? "开" : "关"),
            el("input", {
              type: "checkbox",
              checked: enabled,
              onChange: () => postJson("/api/runtime-seam/config", { continuation: !enabled }).then(reload),
              style: { accentColor: "var(--dsw-alias-brand-primary)" },
            }))),
        el("div", { style: { ...secondary, marginTop: 6 } },
          "引擎已上线：代码文件 write/edit 后的语法检查等确定步骤由 Runtime 直接执行，模型只消化结果。合同表持续扩充（当前 v1：post-write-syntax-check）。"));
    }

    // ---- 设置页：事后模式 + 自定义勾选 ----
    function PostAxis({ caps, reload }) {
      const preset = caps.__preset ?? "minimal";
      const enabledOf = (key) => {
        if (key === "delta") return caps.delta === "critical";
        if (key === "exposure") return caps.exposure !== "silent";
        return Boolean(caps[key]);
      };
      const togglePost = (key, current) => {
        const next = { ...caps };
        if (key === "delta") next.delta = current === "critical" ? "none" : "critical";
        else if (key === "exposure") next.exposure = current === "silent" ? "snapshot" : "silent";
        else next[key] = !current;
        const patch = { guard: next.guard, circuit: next.circuit, reconcile: next.reconcile, investigate: next.investigate, persistence: next.persistence, query: next.query, goal: next.goal, delta: next.delta };
        postJson("/api/runtime-seam/config", { preset: "custom", capabilities: patch }).then(reload);
      };
      const pickPreset = (key) => postJson("/api/runtime-seam/config", { preset: key }).then(reload);
      return el("div", { style: axisCard },
        el("div", { style: sectionTitle }, "事后 · Post（执行后纠偏与止损）"),
        el("div", { style: secondary }, "观察事件流，在模型做错之后拦截、纠正与验证。默认沉默，只在必须时介入。"),
        el("div", { style: { ...row, flexWrap: "wrap", marginTop: 8, marginBottom: 8 } },
          POST_MODES.map((key) => el("button", {
            key,
            style: preset === key ? activeButton : button,
            onClick: () => pickPreset(key),
          }, POST_LABEL[key]))),
        preset === "custom"
          ? el("div", null, POST_ITEMS.map(({ key, label }) => el("label", { key, style: { ...row, display: "flex", padding: "3px 0", cursor: "pointer" } },
              el("input", {
                type: "checkbox",
                checked: enabledOf(key),
                onChange: () => togglePost(key, enabledOf(key)),
                style: { accentColor: "var(--dsw-alias-brand-primary)" },
              }),
              el("span", null, label))))
          : el("div", null, POST_ITEMS.map(({ key, label }) => el("div", { key, style: { ...row, justifyContent: "space-between", padding: "3px 0" } },
              el("span", null, label),
              el("span", { style: enabledOf(key) ? { color: "var(--dsw-alias-state-success-primary)" } : secondary }, enabledOf(key) ? "✓" : "—")))));
    }

    function BaseAxis({ caps, reload }) {
      const enabledOf = (key) => {
        if (key === "delta") return caps.delta === "critical";
        if (key === "exposure") return caps.exposure !== "silent";
        return Boolean(caps[key]);
      };
      const toggle = (key, current) => {
        const next = { ...caps };
        if (key === "delta") next.delta = current === "critical" ? "none" : "critical";
        else if (key === "exposure") next.exposure = current === "silent" ? "snapshot" : "silent";
        else next[key] = !current;
        const patch = { guard: next.guard, circuit: next.circuit, reconcile: next.reconcile, investigate: next.investigate, persistence: next.persistence, query: next.query, goal: next.goal, delta: next.delta };
        postJson("/api/runtime-seam/config", { preset: "custom", capabilities: patch }).then(reload);
      };
      return el("div", { style: { marginBottom: 10 } },
        el("div", { style: sectionTitle }, "基础（既有能力，保留）"),
        BASE_ITEMS.map(({ key, label }) => el("label", { key, style: { ...row, display: "flex", padding: "3px 0", cursor: "pointer" } },
          el("input", {
            type: "checkbox",
            checked: enabledOf(key),
            onChange: () => toggle(key, enabledOf(key)),
            style: { accentColor: "var(--dsw-alias-brand-primary)" },
          }),
          el("span", null, label))));
    }

    function GoalSection({ goals }) {
      return el("div", { style: { marginBottom: 10 } },
        el("div", { style: sectionTitle }, "Runtime 目标"),
        goals && goals.length
          ? el("div", null, goals.map((goal) => el("div", { key: goal.factPath, style: { ...mono, marginBottom: 4 } },
              goal.factPath + " → " + String(goal.desired) + "  " +
              el("span", { style: { color: goal.state === "satisfied" ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-warn-primary)" } },
                goal.state === "satisfied" ? "✓ 已满足" : "… 等待中"))))
          : el("div", { style: secondary }, "未声明目标。可在 + 菜单选择 Runtime Goal，或输入 /runtime-goal 声明。"));
    }

    function RuntimeSettingsPage() {
      const { data, reload } = useActivity();
      const preset = data?.preset ?? "minimal";
      const caps = { ...(data?.capabilities ?? {}), __preset: preset };
      const sceneActive = (scene) => scene.preset === preset && (scene.continuation === caps.continuation);
      return el("div", { style: { ...font, fontSize: "13px", maxWidth: 560 } },
        el("h3", null, "Runtime"),
        el("p", { style: secondary },
          "选择你的 Agent 拥有的确定性能力。Runtime 不是第二个 Agent：默认沉默，只在必须时介入。事前与事后是两根独立的轴。"),
        el("div", { style: { marginBottom: 12 } },
          el("div", { style: sectionTitle }, "场景预设（同时设定事前开关与事后模式）"),
          el("div", { style: { ...row, flexWrap: "wrap", marginBottom: 4 } },
            SCENES.map((scene) => el("button", {
              key: scene.key,
              style: sceneActive(scene) ? activeButton : button,
              title: scene.desc,
              onClick: () => postJson("/api/runtime-seam/config", { preset: scene.preset, continuation: scene.continuation }).then(reload),
            }, scene.label)))),
        el(PreAxis, { caps, reload }),
        el(PostAxis, { caps, reload }),
        el(BaseAxis, { caps, reload }),
        el(GoalSection, { goals: data?.goals }),
        el("div", { style: { marginBottom: 10 } },
          el("div", { style: sectionTitle }, "Runtime 介入记录"),
          el("div", { style: summaryCard }, summaryOf(data?.activity)),
          el(ActivityList, { entries: data?.activity })),
        el("div", { style: secondary },
          "Exposure 默认静默：Runtime 只在承诺过的变更或 circuit 开断时进入模型上下文。Custom 也可直接手写 settings.yaml，见 docs/custom-config.md。"));
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        // 槽位内容必须是组件函数（壳层注入 props；传元素会 React #130）。
        ctx.slots.inject("conversation.input.left", () =>
          ctx.slots.register(
            { name: "conversation.input.left", id: "dsh-runtime-seam-trigger", order: 0, label: "Runtime", registrant: "dsh-runtime-seam" },
            RuntimeButton,
          ));
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            { name: "settings.section", id: "dsh-runtime-seam-settings", order: 0, label: "Runtime", registrant: "dsh-runtime-seam" },
            RuntimeSettingsPage,
          ));
      },
    };
  },
});
