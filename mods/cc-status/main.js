// Status bar, and the layout's only fetcher: other cc-* mods read what it writes to shared state.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, panes, focused, theme, run, exec, hc, keys, window, shared, setShared, home, appHome, notify, nextCommand, layout, openOverlay } from "herdr";
import { SLACK_TIMEOUT, SLACK_TOOLS, SLACK_SCHEMA, slackPrompt, loadState, saveState, merge, apply, publish } from "./slack.js";
import { STANDUP_TIMEOUT, STANDUP_TOOLS, STANDUP_SCHEMA, ASK_SCHEMA, windowFor, gatherLocal, standupPrompt, standupSlot,
  toBullets, toText, remember, applyEdit, askPrompt, applyAsk } from "./standup.js";
import * as fs from "fs/promises";
import { USAGE_EVERY, claudeUsage, codexUsage, backoff } from "./usage.js";
import { SLACKAPP_EVERY, loadAppState, saveAppState, poll, applyApp, publishApp, needsLink, resolvePrompt, parseResolved, applyResolved, RESOLVE_TOOLS } from "./slackapp.js";
import { withDefaults, patch, loadSettings, saveSettings, inHours } from "./settings.js";
import * as activity from "./activity.js";

// Claude Code lists connectors that need a sign-in here: a free way to know Linear or Slack isn't connected
// before paying for a run that would find out. Not an official interface, so it's only a hint.
async function needsAuth(name) {
  try { return Object.keys(JSON.parse(await fs.readFile(`${home()}/.claude/mcp-needs-auth-cache.json`, "utf8"))).some((k) => k.includes(name)); }
  catch { return false; }
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
}

// Linear goes through the claude.ai connector in a headless claude run, so it's slow and costs a little:
// on settings' schedule (linear.everyMin, linear.hours), or when asked (cc.linear.request).
const LINEAR_TIMEOUT = 240_000;
const LINEAR_READ = ["ToolSearch", "mcp__claude_ai_Linear__list_issues", "mcp__claude_ai_Linear__get_issue", "mcp__claude_ai_Linear__list_teams", "mcp__claude_ai_Linear__get_user", "mcp__claude_ai_Linear__whoami"];
const LINEAR_WRITE = ["ToolSearch", "mcp__claude_ai_Linear__get_issue", "mcp__claude_ai_Linear__list_issue_statuses", "mcp__claude_ai_Linear__save_issue"];
const LINEAR_SCHEMA = JSON.stringify({
  type: "object", required: ["issues", "error", "connected"],
  properties: {
    error: { type: "string" }, connected: { type: "boolean" },
    issues: { type: "array", items: { type: "object", required: ["identifier", "title", "state", "stateType", "url"], properties: {
      identifier: { type: "string" }, title: { type: "string" }, state: { type: "string" }, stateType: { type: "string" },
      priority: { type: "number" }, url: { type: "string" }, branchName: { type: "string" }, description: { type: "string" },
      cycle: { type: "string" }, project: { type: "string" } } } },
  },
});
const LINEAR_PROMPT = `List every Linear issue assigned to me that is not completed or canceled. Load the Linear tools with ToolSearch first.
For each issue: identifier, title, state name, state type (backlog, unstarted, started or triage), priority number (0 none, 1 urgent, 2 high, 3 medium, 4 low), url, gitBranchName as branchName, the first 600 characters of the description, cycle name, project name.
Read only: never create, change or comment on anything.
connected: false when no Linear tools are available or they say I need to sign in; then return an empty list.
If the Linear tools are there but keep failing, return an empty list and one short reason in error; otherwise error is "".`;

const REVIEWS_EVERY = 5 * 60_000;
const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "trunk"]);
const FAILED = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"]);

function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

function ciState(rollup) {
  if (!rollup?.length) return { ci: "none", failed: [] };
  const failed = [];
  let pending = false;
  for (const c of rollup) {
    const result = (c.conclusion || c.state || "").toUpperCase();
    if (FAILED.has(result)) failed.push({ name: c.name || c.context || "check", url: c.detailsUrl || c.targetUrl || null });
    else if ((c.__typename === "CheckRun" && (c.status || "").toUpperCase() !== "COMPLETED") || result === "PENDING" || result === "EXPECTED") pending = true;
  }
  return { ci: failed.length ? "fail" : pending ? "pending" : "pass", failed };
}

// The last meaningful lines of a blocked agent's screen: usually its question or permission prompt.
function snippet(text) {
  const lines = (text ?? "").split("\n")
    .map((l) => l.replace(/[│─╭╮╰╯┌┐└┘├┤┬┴┼═║▔▁▏▕]/g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => /[\p{L}\p{N}]/u.test(l));
  // A question then its options (a permission or choice prompt): start at the question, so it's what you read first.
  const asked = lines.slice(-8).findLastIndex((l) => l.endsWith("?"));
  return (asked >= 0 ? lines.slice(-8).slice(asked) : lines.slice(-4)).join(" · ").slice(0, 240);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// GitHub notifications worth an Inbox row: you were @-mentioned (or your team was), assigned, or someone answered
// on a thread you opened or commented on. Review requests have their own rows; merges, closes and CI are left out.
const NOTIF_REASONS = new Set(["mention", "team_mention", "comment", "author", "assign", "manual"]);
const NOTIF_MAX = 25;
// https://api.github.com/repos/o/r/pulls/12 → https://github.com/o/r/pull/12 (issues keep their path).
const webUrl = (api) => api ? api.replace("https://api.github.com/repos/", "https://github.com/").replace(/\/pulls\/(\d+)$/, "/pull/$1") : null;
const ghJson = (path) => exec("gh", ["api", path], { timeout: 20_000 })
  .then((r) => (r.code === 0 ? JSON.parse(r.stdout) : null)).catch(() => null);

export default class CcStatus extends View {
  init(_props, cx) {
    this.roots = {};
    this.busy = false;
    this.lastRun = 0;
    this.reviewsAt = 0;
    this.error = null;
    this.reading = new Set();
    this.notifCache = new Map(); // "<thread id>|<updated_at>" → its latest comment or review (or null)
    this.notifRead = new Set();  // threads marked read here, kept out until GitHub stops listing them
    this.mergedPrs = new Set();  // PR API URLs known to be merged (merging is final, so never asked again)
    this.ghLogin = null;
    this.linearBusy = false;
    this.handled = { request: shared("cc.linear.request") ?? 0, move: shared("cc.linear.move")?.at ?? 0,
      slackRequest: shared("cc.slack.request") ?? 0, slackAction: shared("cc.slack.action")?.at ?? 0,
      githubAction: shared("cc.github.action")?.at ?? 0, appAction: shared("cc.slackapp.action")?.at ?? 0 };
    this.slackBusy = false;
    this.slackPath = `${appHome()}/data/cc-slack/state.json`;
    this.slackQueue = Promise.resolve();
    this.appPath = `${appHome()}/data/cc-slack/app.json`;
    this.appQueue = Promise.resolve();
    this.appBusy = false;
    this.standupPath = `${appHome()}/data/cc-standup/standup.json`;
    this.standupBusy = false;
    this.handled.standup = shared("cc.standup.request") ?? 0;
    this.handled.standupAction = shared("cc.standup.action")?.at ?? 0;
    this.su = {};
    this.suQueue = Promise.resolve();
    this.settings = withDefaults({});
    this.settingsPath = `${appHome()}/command-center.json`;
    this.handled.settings = shared("cc.settings.update")?.at ?? 0;
    // Settings first, then what the last sweep saved (dropping a "running" left by a build replaced mid-sweep).
    // Only then the first tick: before this, the schedule would think Slack was never swept.
    cx.spawn(async (cx) => {
      await this.readSettings();
      if (this.settings.demo) { await this.loadDemo(); return; }
      await this.slackChange(() => ({ running: false }));
      try { this.su = JSON.parse(await fs.readFile(this.standupPath, "utf8")); } catch { this.su = {}; }
      if (!this.su.bullets && this.su.text) this.su.bullets = toBullets(this.su.text);
      this.publishStandup({ running: false, asking: false });
      this.tick(cx);
      this.slackApp(cx);
      this.activityFocus(cx);
      this.activitySessions(cx);
    });
    cx.timer.every(60_000, (cx) => this.tick(cx));
    // The Slack app's notifications: free, so every 20 seconds (macOS drops them once cleared).
    cx.timer.every(SLACKAPP_EVERY, (cx) => this.slackApp(cx));
    // Activity log (files only, data/cc-activity): focus each minute, session logs every 10 minutes, summaries hourly.
    this.agentSnap = null;
    cx.timer.every(activity.FOCUS_EVERY, (cx) => this.activityFocus(cx));
    cx.timer.every(activity.SESSIONS_EVERY, (cx) => this.activitySessions(cx));
    // `herdr-app do cc-status.linear` / `cc-status.github`: check now.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "linear") this.linear(cx, true);
        if (c === "github") this.refresh(cx, true);
        if (c === "slack") this.slack(cx, true);
        if (c === "standup") this.standup(cx);
        if (c === "usage") this.usage(cx, true);
        if (c === "activity") { this.activitySessions(cx); cx.spawn(async () => { await activity.summarize(activity.today()); }); }
        if (c === "settings") openOverlay({ mod: "cc-settings", kind: "dialog", width: 640, height: 0.85 });
        cx.notify();
      }
    });
  }

  // Claude and Codex plan usage into shared "cc.usage". Claude's endpoint is rate-limited, so failures back off;
  // a click (forced) asks at once, but not twice within 30 seconds.
  usage(cx, forced = false) {
    const now = Date.now();
    this.usageState ??= { next: 0, failures: 0, last: 0 };
    const u = this.usageState;
    if (this.usageBusy || (forced ? now - u.last < 30_000 : now < u.next)) return;
    this.usageBusy = true;
    u.last = now;
    u.next = now + USAGE_EVERY;
    cx.spawn(async (cx) => {
      const prev = shared("cc.usage") ?? {};
      const out = { ...prev };
      try {
        out.claude = this.settings.usage.claude ? { windows: await claudeUsage(), at: Date.now(), error: null } : null;
        u.failures = 0;
      } catch (e) {
        u.failures = Math.min(u.failures + 1, 8);
        u.next = Date.now() + backoff(u.failures, e.retryAfter);
        out.claude = { ...(prev.claude ?? {}), error: String(e?.message ?? e).slice(0, 120) };
      }
      try {
        const windows = this.settings.usage.codex ? await codexUsage() : null;
        out.codex = windows ? { windows, at: Date.now(), error: null } : prev.codex ?? null;
      } catch (e) {
        out.codex = { ...(prev.codex ?? {}), error: String(e?.message ?? e).slice(0, 120) };
      }
      if (!same(out, prev)) setShared("cc.usage", out);
      this.usageBusy = false;
      cx.notify();
    });
  }

  // The settings file, read again each minute so hand edits apply; call from inside a task.
  async readSettings() {
    const { settings, error } = await loadSettings(this.settingsPath);
    this.settingsError = error;
    if (!same(settings, this.settings) || !shared("cc.settings")) { this.settings = settings; this.publishSettings(); }
  }

  // What every mod reads: the settings, plus `roots` (repoRoots, or the parents of the repos open in Herdr).
  publishSettings() {
    const next = { ...this.settings, roots: this.settings.repoRoots ?? this.autoRoots ?? [], file: this.settingsPath, fileError: this.settingsError ?? null };
    if (!same(next, shared("cc.settings"))) setShared("cc.settings", next);
  }

  // The folders that hold the repos open in local spaces, for settings with no repoRoots.
  async findAutoRoots() {
    const parents = new Set();
    for (const s of spaces()) {
      if (s.machine) continue;
      const tabIds = new Set(s.tabs.map((t) => t.id));
      for (const p of panes().filter((x) => tabIds.has(x.tab) && x.cwd)) {
        const repo = await this.repoOf(p.cwd);
        if (repo) parents.add(repo.replace(/\/[^/]+$/, ""));
      }
    }
    const roots = [...parents].sort();
    if (!same(roots, this.autoRoots)) { this.autoRoots = roots; this.publishSettings(); }
  }

  // Demo mode (settings "demo": true, used by scripts/preview.mjs): no fetching and no Claude runs; the shared
  // state comes from command-center-demo.json beside the settings, with times given as seconds ago.
  async loadDemo() {
    let demo = {};
    try { demo = JSON.parse(await fs.readFile(`${appHome()}/command-center-demo.json`, "utf8")); } catch { return; }
    const now = Date.now();
    const ago = (v) => (Array.isArray(v) ? v.map(ago) : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /^(at|lastAt|tickedAt|resetsAt|updatedAt)$/.test(k) && typeof x === "number" ? now - x * 1000 : ago(x)]))
      : v);
    for (const [key, value] of Object.entries(ago(demo.shared ?? {}))) setShared(key, value);
    if (demo.standup) { this.su = ago(demo.standup); this.publishStandup({ running: false, asking: false }); }
  }

  tick(cx) {
    if (this.settings.demo) { cx.notify(); return; }
    const st = this.settings, now = Date.now(), hour = new Date().getHours();
    cx.spawn(async () => { await this.readSettings(); if (!st.repoRoots) await this.findAutoRoots(); });
    this.usage(cx);
    if (st.github.enabled && now - this.lastRun >= st.github.everyMin * 60_000) this.refresh(cx, false);
    // While a connector isn't connected, scheduled runs wait; opening the panel or Check again asks.
    const l = shared("cc.linear") ?? {};
    if (st.linear.enabled && !l.notConnected && inHours(hour, st.linear.hours)
      && now - Math.max(l.at ?? 0, l.failedAt ?? 0, this.linearStarted ?? 0) >= st.linear.everyMin * 60_000) this.linear(cx);
    // this.slackStarted also counts: a sweep whose result failed to save must not rerun every minute.
    const sl = shared("cc.slack") ?? {};
    if (st.slack.enabled && !sl.notConnected && inHours(hour, st.slack.hours)
      && now - Math.max(sl.lastAt ?? 0, sl.failedAt ?? 0, this.slackStarted ?? 0) >= st.slack.everyMin * 60_000) this.slack(cx);
    // Standup at settings' times; a slot missed while Herdr was closed or asleep runs once within 12 hours.
    // A draft written after the slot's time (Write now, say) already covers it.
    // A draft you've edited for that day is yours: the slot passes without a run.
    const slot = st.standup.enabled ? standupSlot(new Date(), st.standup.times, st.standup.weekdaysOnly) : null, su = this.su;
    if (slot && slot.id !== su.slot && (su.at ?? 0) < slot.at && now - slot.at < 12 * 3600_000
      && now - (this.standupStarted ?? 0) > 30 * 60_000) {
      if (su.edited && su.key === windowFor(new Date(slot.at), st.standup.cutover).key) cx.spawn(async () => { await this.changeStandup((s) => { s.slot = slot.id; }); });
      else this.standup(cx, slot);
    }
    cx.notify();
  }

  // What the Inbox footer and the Standup pane read: the draft without its undo history.
  publishStandup(status = {}) {
    const { history, ...rest } = this.su;
    this.suStatus = { ...(this.suStatus ?? {}), ...status };
    setShared("cc.standup", { ...rest, text: toText(this.su.bullets), canUndo: Boolean(history?.length), ...this.suStatus });
  }

  // One change at a time, saved and published; call from inside a cx.spawn task.
  async changeStandup(change, status = {}) {
    const before = this.suQueue;
    let release;
    this.suQueue = new Promise((r) => { release = r; });
    await before;
    try {
      change(this.su);
      await fs.mkdir(this.standupPath.replace(/\/[^/]+$/, ""), { recursive: true });
      await fs.writeFile(this.standupPath, JSON.stringify(this.su, null, 2));
      this.publishStandup(status);
    } catch (e) {
      console.log("cc-status standup:", e);
    } finally {
      release();
    }
  }

  standup(cx, slot = null) {
    if (this.standupBusy) return;
    this.standupBusy = true;
    this.standupStarted = Date.now();
    // A scheduled run writes the day its slot belongs to, even when caught up later.
    const win = windowFor(slot ? new Date(slot.at) : new Date(), this.settings.standup.cutover);
    this.publishStandup({ running: true, error: null });
    cx.spawn(async (cx) => {
      try {
        const local = await gatherLocal(win);
        const r = await this.claude(standupPrompt(win, local), STANDUP_TOOLS, ["--json-schema", STANDUP_SCHEMA], STANDUP_TIMEOUT, this.settings.standup.model, "1");
        const out = JSON.parse(r.stdout || "{}");
        const s = out.structured_output;
        if (!s?.text) throw new Error(String(out.result || s?.error || r.stderr || `claude exited ${r.code}`).split("\n")[0]);
        await this.changeStandup((st) => {
          // A rewrite of the same day can be undone; a new day starts fresh.
          if (st.key === win.key) remember(st); else st.history = [];
          Object.assign(st, { key: win.key, label: win.label, date: win.date, bullets: toBullets(s.text), edited: false,
            note: s.error || null, at: Date.now(), slot: slot?.id ?? st.slot ?? null,
            sources: { commits: local.commits.length, prs: local.prs.length, tasks: local.tasks.length, asks: local.slack.length }, cost: out.total_cost_usd });
        }, { running: false, error: null });
      } catch (e) {
        // A failed scheduled run still uses up its slot; Write now retries.
        const error = String(e?.message ?? e).slice(0, 160);
        await this.changeStandup((st) => { if (slot) st.slot = slot.id; }, { running: false, error });
      } finally {
        this.standupBusy = false;
        cx.notify();
      }
    });
  }

  // Edits from the Standup pane; "ask" has Claude change one bullet or the whole draft.
  standupAction(cx, a) {
    if (a.op !== "ask") { cx.spawn(async () => { await this.changeStandup((st) => applyEdit(st, a)); }); return; }
    if (this.suAsking || !this.su.bullets?.length) return;
    this.suAsking = true;
    this.publishStandup({ asking: a.id ?? "all", askError: null });
    cx.spawn(async (cx) => {
      try {
        const r = await this.claude(askPrompt(this.su, a.instruction, a.id), ["ToolSearch"], ["--json-schema", ASK_SCHEMA], 180_000, this.settings.standup.model, "0.3");
        const out = JSON.parse(r.stdout || "{}");
        const bullets = out.structured_output?.bullets;
        if (!Array.isArray(bullets)) throw new Error(String(out.result || r.stderr || `claude exited ${r.code}`).split("\n")[0]);
        await this.changeStandup((st) => applyAsk(st, a.id, bullets), { asking: false });
      } catch (e) {
        this.publishStandup({ asking: false, askError: String(e?.message ?? e).slice(0, 160) });
      } finally {
        this.suAsking = false;
        cx.notify();
      }
    });
  }

  claude(prompt, tools, extra, timeout, model = "haiku", budget = "0.5") {
    const dir = `${appHome()}/data/cc-claude`;
    // MCP_CONNECTION_NONBLOCKING=false: in -p mode the turn otherwise starts before the claude.ai connectors
    // (Slack, Linear) connect, and the run sees no Slack or Linear tools at all.
    return exec("mkdir", ["-p", dir]).then(() => exec("/usr/bin/env", ["MCP_CONNECTION_NONBLOCKING=false", `${home()}/.local/bin/claude`,
      "-p", prompt, "--model", model, "--tools", "ToolSearch", "--allowedTools", tools.join(","),
      "--output-format", "json", "--no-session-persistence", "--max-budget-usd", budget, ...extra,
    ], { cwd: dir, timeout }));
  }

  activityOn() { return !this.settings.demo && this.settings.activity?.enabled !== false; }

  activityFocus(cx) {
    if (!this.activityOn()) return;
    cx.spawn(async () => {
      try {
        await activity.log(await activity.focusSample({ focused: focused(), spaces: spaces(), panes: panes(), window: window(), repoOf: (c) => this.repoOf(c) }));
        // Summaries: today's every hour, and yesterday's once after midnight.
        const hour = new Date().getHours();
        if (hour !== this.summaryHour) {
          if (this.summaryHour !== undefined && hour < this.summaryHour) await activity.summarize(activity.yesterday());
          this.summaryHour = hour;
          await activity.summarize(activity.today());
        }
      } catch (e) { console.log("cc-status activity focus:", e); }
    });
  }

  activitySessions(cx) {
    if (!this.activityOn() || this.sessionsBusy) return;
    this.sessionsBusy = true;
    cx.spawn(async () => {
      try { await activity.scanSessions(); } catch (e) { console.log("cc-status activity sessions:", e); }
      this.sessionsBusy = false;
    });
  }

  // Agent status changes, logged as they happen (render runs on every change to agents()).
  activityAgents(cx) {
    if (!this.activityOn()) return;
    const { events, next } = activity.agentChanges(this.agentSnap ?? {}, agents(), panes());
    // The first look only learns who's there, so a reload doesn't log every agent as new.
    // Files and promises only run inside a task, so the write goes through cx.spawn.
    if (this.agentSnap && events.length) cx.spawn(async () => { await activity.log(events); });
    this.agentSnap = next;
  }

  // Reads, changes and writes the Slack app feed one at a time; call from inside a cx.spawn task.
  async appChange(change) {
    const before = this.appQueue;
    let release;
    this.appQueue = new Promise((r) => { release = r; });
    await before;
    try {
      const state = await loadAppState(this.appPath);
      const status = (await change(state)) ?? {};
      await saveAppState(this.appPath, state);
      const next = publishApp(state, { ...(shared("cc.slackapp") ?? {}), ...status });
      if (!same(next, shared("cc.slackapp"))) setShared("cc.slackapp", next);
    } catch (e) {
      console.log("cc-status slack app:", e);
    } finally {
      release();
    }
  }

  slackApp(cx) {
    if (this.settings.demo || this.settings.slack.app === false || this.appBusy) return;
    this.appBusy = true;
    cx.spawn(async (cx) => {
      let unlinked = [];
      await this.appChange(async (st) => {
        try { await poll(st, Date.now()); unlinked = st.items.filter(needsLink).slice(-10); return { error: null, at: Date.now() }; }
        catch (e) { return { error: String(e?.message ?? e).slice(0, 160) }; }
      });
      this.appBusy = false;
      if (unlinked.length) this.resolveSlackLinks(cx, unlinked);
      cx.notify();
    });
  }

  // Links for live items in channels or DMs not seen before: one Haiku run (about 1¢) searches Slack for each message
  // and the channel ID and permalink are taken from the search results by message timestamp, not from the model's words.
  // Each channel is looked up once; at most one lookup every 2 minutes; an item is given up on after 3 tries.
  resolveSlackLinks(cx, items) {
    if (this.resolving || Date.now() - (this.resolvedAt ?? 0) < 120_000) return;
    this.resolving = true;
    this.resolvedAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        const dir = `${appHome()}/data/cc-claude`;
        await exec("mkdir", ["-p", dir]);
        const r = await exec("/usr/bin/env", ["MCP_CONNECTION_NONBLOCKING=false", `${home()}/.local/bin/claude`, "-p", resolvePrompt(items),
          "--model", "haiku", "--tools", "ToolSearch", "--allowedTools", RESOLVE_TOOLS.join(","), "--output-format", "stream-json", "--verbose",
          "--no-session-persistence", "--max-budget-usd", "0.2"], { cwd: dir, timeout: 180_000 });
        const found = parseResolved(r.stdout ?? "");
        const keys = new Set(items.map((x) => x.key));
        await this.appChange((st) => { applyResolved(st, st.items.filter((x) => keys.has(x.key)), found); });
      } catch (e) {
        console.log("cc-status slack links:", e);
      } finally {
        this.resolving = false;
        cx.notify();
      }
    });
  }

  // Reads, changes and writes the Slack state one at a time, so a tick never races a sweep.
  // Awaited from inside a cx.spawn task: Herdr calls like setShared need one.
  async slackChange(change) {
    const before = this.slackQueue;
    let release;
    this.slackQueue = new Promise((r) => { release = r; });
    await before;
    try {
      const state = await loadState(this.slackPath);
      const status = change(state) ?? {};
      await saveState(this.slackPath, state);
      setShared("cc.slack", publish(state, { ...(shared("cc.slack") ?? {}), ...status }));
    } catch (e) {
      console.log("cc-status slack:", e);
    } finally {
      release();
    }
  }

  // forced: you asked (Check now), so it runs even when Claude Code says Slack needs a sign-in.
  slack(cx, forced = false) {
    if (this.slackBusy) return;
    this.slackBusy = true;
    this.slackStarted = Date.now();
    cx.spawn(async (cx) => {
      const started = Date.now();
      if (!forced && await needsAuth("Slack")) {
        await this.slackChange(() => ({ running: false, notConnected: true, error: null, failedAt: started }));
        this.slackBusy = false;
        return;
      }
      setShared("cc.slack", { ...(shared("cc.slack") ?? {}), running: true });
      try {
        const state = await loadState(this.slackPath);
        const r = await this.claude(slackPrompt(state, started), SLACK_TOOLS, ["--json-schema", SLACK_SCHEMA], SLACK_TIMEOUT, this.settings.slack.model, "1");
        const out = JSON.parse(r.stdout || "{}");
        const s = out.structured_output;
        if (!s) throw new Error(String(out.result || r.stderr || `claude exited ${r.code}`).split("\n")[0]);
        if (s.connected === false) {
          await this.slackChange(() => ({ running: false, notConnected: true, error: null, failedAt: started }));
          return;
        }
        if (s.error) throw new Error(s.error);
        let fresh = [];
        await this.slackChange((st) => {
          fresh = merge(st, s, started);
          st.runs = [...st.runs, { at: started, ok: true, cost: out.total_cost_usd, items: s.items.length }].slice(-50);
          return { running: false, error: null, failedAt: null, notConnected: false };
        });
        for (const it of fresh.slice(0, 3)) notify({ title: `${it.from} in ${it.channel}`, body: it.text, level: "warning", timeout: 15_000 });
      } catch (e) {
        const error = String(e?.message ?? e).slice(0, 160);
        await this.slackChange((st) => { st.runs = [...st.runs, { at: started, ok: false, error }].slice(-50); return { running: false, error, failedAt: Date.now() }; });
      } finally {
        this.slackBusy = false;
        cx.notify();
      }
    });
  }

  // forced: you asked (panel, Check again, status bar), so it runs even when Claude Code says Linear needs a sign-in.
  linear(cx, forced = false) {
    if (this.linearBusy) return;
    this.linearBusy = true;
    this.linearStarted = Date.now();
    cx.spawn(async (cx) => {
      const prev = shared("cc.linear") ?? {};
      if (!forced && await needsAuth("Linear")) {
        setShared("cc.linear", { ...prev, running: false, notConnected: true, error: null, failedAt: Date.now() });
        this.linearBusy = false;
        return;
      }
      setShared("cc.linear", { ...prev, running: true });
      try {
        const r = await this.claude(LINEAR_PROMPT, LINEAR_READ, ["--json-schema", LINEAR_SCHEMA], LINEAR_TIMEOUT, this.settings.linear.model);
        const out = JSON.parse(r.stdout || "{}");
        const s = out.structured_output;
        if (!s) throw new Error(String(out.result || r.stderr || `claude exited ${r.code}`).split("\n")[0]);
        if (s.connected === false) setShared("cc.linear", { ...prev, running: false, notConnected: true, error: null, failedAt: Date.now() });
        else if (s.error) setShared("cc.linear", { ...prev, running: false, notConnected: false, error: s.error, failedAt: Date.now() });
        else setShared("cc.linear", { issues: s.issues, at: Date.now(), running: false, notConnected: false, error: null });
      } catch (e) {
        setShared("cc.linear", { ...prev, running: false, error: String(e?.message ?? e).slice(0, 160), failedAt: Date.now() });
      } finally {
        this.linearBusy = false;
        cx.notify();
      }
    });
  }

  // Start from issue asks for this; the dialog closes before a headless run could finish.
  moveToStarted(cx, identifier) {
    cx.spawn(async (cx) => {
      const prompt = `Move Linear issue ${identifier} to its team's "In Progress" state (or the team's first state of type started). Change nothing else: no comments, no other fields. Reply with one short sentence.`;
      const r = await this.claude(prompt, LINEAR_WRITE, [], 180_000).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      let ok = r.code === 0, text = "";
      try { const o = JSON.parse(r.stdout); ok = ok && !o.is_error; text = o.result ?? ""; } catch { ok = false; }
      notify({ title: ok ? `${identifier} moved to In Progress` : `Couldn't move ${identifier}`, body: ok ? undefined : (text || r.stderr || "").slice(0, 160), level: ok ? "success" : "warning" });
      this.linear(cx);
    });
  }

  syncRequests(cx) {
    if (this.settings.demo) return;
    // Settings changes from the dialog or the Start dialog: merged, saved, published.
    const up = shared("cc.settings.update");
    if (up?.at > this.handled.settings) {
      this.handled.settings = up.at;
      const next = patch(this.settings, up.patch);
      cx.spawn(async () => {
        try { await saveSettings(this.settingsPath, next); this.settings = next; this.settingsError = null; }
        catch (e) { this.settingsError = String(e?.message ?? e); }
        this.publishSettings();
        if (!next.repoRoots) await this.findAutoRoots();
      });
    }
    const request = shared("cc.linear.request") ?? 0, move = shared("cc.linear.move");
    if (request > this.handled.request) { this.handled.request = request; this.linear(cx, true); }
    if (move?.at > this.handled.move) { this.handled.move = move.at; this.moveToStarted(cx, move.identifier); }
    const ureq = shared("cc.usage.request") ?? 0;
    if (ureq > (this.handled.usage ?? 0)) { this.handled.usage = ureq; this.usage(cx, true); }
    const streq = shared("cc.standup.request") ?? 0;
    if (streq > this.handled.standup) { this.handled.standup = streq; this.standup(cx); }
    const sua = shared("cc.standup.action");
    if (sua?.at > this.handled.standupAction) { this.handled.standupAction = sua.at; this.standupAction(cx, sua); }
    const sreq = shared("cc.slack.request") ?? 0, sact = shared("cc.slack.action");
    if (sreq > this.handled.slackRequest) { this.handled.slackRequest = sreq; this.slack(cx, true); }
    const aact = shared("cc.slackapp.action");
    if (aact?.at > this.handled.appAction) {
      this.handled.appAction = aact.at;
      cx.spawn(async () => { await this.appChange((st) => { applyApp(st, aact, Date.now()); }); });
    }
    if (sact?.at > this.handled.slackAction) {
      this.handled.slackAction = sact.at;
      cx.spawn(async () => { await this.slackChange((st) => { apply(st, sact, Date.now()); }); });
    }
    // Mark read from the Inbox: gone from the list at once, then marked read on GitHub too.
    const gact = shared("cc.github.action");
    if (gact?.at > this.handled.githubAction) {
      this.handled.githubAction = gact.at;
      const ids = new Set((gact.ids ?? []).map(String));
      for (const id of ids) this.notifRead.add(id);
      cx.spawn(async () => {
        const gh = shared("cc.github") ?? {};
        setShared("cc.github", { ...gh, notifications: (gh.notifications ?? []).filter((n) => !ids.has(n.id)) });
        for (const id of ids) await exec("gh", ["api", "-X", "PATCH", `notifications/threads/${id}`], { timeout: 20_000 }).catch(() => null);
      });
    }
  }

  // Unread GitHub notifications that are about you, each with who answered last and what they said.
  // Returns null when they're off in settings; throws when gh can't read them.
  async notifications() {
    if (!this.settings.github.notifications) return null;
    this.ghLogin ??= (await ghJson("user"))?.login ?? null;
    const r = await exec("gh", ["api", "notifications?participating=true&per_page=50"], { timeout: 20_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "gh api notifications failed");
    const list = JSON.parse(r.stdout);
    const listed = new Set(list.map((n) => String(n.id)));
    for (const id of this.notifRead) if (!listed.has(id)) this.notifRead.delete(id);
    const out = [], keys = new Set();
    for (const n of list) {
      const id = String(n.id);
      if (!n.unread || !NOTIF_REASONS.has(n.reason) || this.notifRead.has(id)) continue;
      // Activity on a merged PR is history, not something to answer.
      if (n.subject?.type === "PullRequest" && await this.prMerged(n.subject.url)) continue;
      const key = `${id}|${n.updated_at}`;
      keys.add(key);
      if (!this.notifCache.has(key)) this.notifCache.set(key, await this.latestActivity(n));
      const last = this.notifCache.get(key);
      // You had the last word: nothing new from anyone else.
      if (last?.who && last.who === this.ghLogin) continue;
      out.push({
        id, reason: n.reason, type: n.subject?.type ?? "", repo: n.repository?.full_name ?? "", title: n.subject?.title ?? "",
        number: Number((n.subject?.url ?? "").match(/\/(\d+)$/)?.[1]) || null,
        url: last?.url ?? webUrl(n.subject?.url) ?? n.repository?.html_url ?? "https://github.com/notifications",
        who: last?.who ?? null, review: last?.review ?? null,
        body: (last?.body ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*[#>]+\s*/gm, "").replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim().slice(0, 200),
        at: Date.parse(n.updated_at) || Date.now(),
      });
      if (out.length >= NOTIF_MAX) break;
    }
    for (const k of this.notifCache.keys()) if (!keys.has(k)) this.notifCache.delete(k);
    return out;
  }

  // Whether a PR is merged; open PRs are asked again on every refresh, since they may merge at any time.
  async prMerged(url) {
    if (!url) return false;
    if (this.mergedPrs.has(url)) return true;
    const pr = await ghJson(url);
    if (pr?.merged) { this.mergedPrs.add(url); return true; }
    return false;
  }

  // The newest comment on the thread, else (for a PR) its newest review; null if neither is newer than your last read.
  async latestActivity(n) {
    const seen = Date.parse(n.last_read_at ?? "") || 0;
    const c = n.subject?.latest_comment_url;
    if (c && /\/comments\/\d+$/.test(c)) {
      const x = await ghJson(c);
      const at = Date.parse(x?.created_at ?? "") || 0;
      if (x && at > seen) return { who: x.user?.login ?? null, body: x.body ?? "", url: x.html_url ?? null, at };
    }
    if (n.subject?.type === "PullRequest" && n.subject.url) {
      const reviews = await ghJson(`${n.subject.url}/reviews?per_page=100`);
      const last = Array.isArray(reviews) ? reviews.filter((x) => x.submitted_at && x.state !== "PENDING").at(-1) : null;
      const at = Date.parse(last?.submitted_at ?? "") || 0;
      if (last && at > seen) {
        const said = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes", COMMENTED: "left review comments", DISMISSED: "review dismissed" }[last.state] ?? "";
        return { who: last.user?.login ?? null, body: last.body || said, url: last.html_url ?? null, at, review: last.state };
      }
    }
    return null;
  }

  async repoOf(cwd) {
    if (!(cwd in this.roots)) {
      const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => null);
      this.roots[cwd] = r?.code === 0 ? r.stdout.trim() : null;
    }
    return this.roots[cwd];
  }

  // One PR lookup per (repo, branch) shown in a local space.
  async targets() {
    const all = panes(), out = new Map();
    for (const s of spaces()) {
      if (s.machine) continue;
      const tabIds = new Set(s.tabs.map((t) => t.id));
      for (const p of all) {
        if (!tabIds.has(p.tab) || !p.cwd || !p.branch || DEFAULT_BRANCHES.has(p.branch)) continue;
        const repo = await this.repoOf(p.cwd);
        const key = `${repo}|${p.branch}`;
        if (repo && !out.has(key)) out.set(key, { space: s.id, spaceName: s.name, repo, branch: p.branch });
      }
    }
    return [...out.values()];
  }

  refresh(cx, forceReviews) {
    if (this.busy) return;
    this.busy = true;
    this.lastRun = Date.now();
    cx.spawn(async (cx) => {
      try {
        const prev = shared("cc.github") ?? {};
        const prs = [];
        for (const t of await this.targets()) {
          const r = await exec("gh", ["pr", "view", t.branch, "--json", "number,title,url,state,isDraft,reviewDecision,statusCheckRollup"], { cwd: t.repo, timeout: 20_000 }).catch(() => null);
          if (r?.code !== 0) continue;
          const pr = JSON.parse(r.stdout);
          if (pr.state !== "OPEN") continue;
          prs.push({ ...t, number: pr.number, title: pr.title, url: pr.url, draft: pr.isDraft, review: pr.reviewDecision, ...ciState(pr.statusCheckRollup) });
        }
        let reviews = prev.reviews ?? [];
        if (forceReviews || Date.now() - this.reviewsAt >= REVIEWS_EVERY) {
          // Direct requests by default: team requests (review-requested) can flood the list.
          const scope = this.settings.github.reviews === "all" ? "--review-requested=@me" : "user-review-requested:@me";
          const r = await exec("gh", ["search", "prs", scope, "--state=open", "--json", "number,title,url,repository,author", "--limit", "50"], { timeout: 20_000 });
          if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "gh search failed");
          reviews = JSON.parse(r.stdout).map((x) => ({ number: x.number, title: x.title, url: x.url, repo: x.repository?.nameWithOwner ?? "", author: x.author?.login ?? "" }));
          this.reviewsAt = Date.now();
        }
        // A failed notifications read keeps the last list and says why; PRs and reviews still update.
        let notifications = prev.notifications ?? [], notificationsError = null;
        try { notifications = (await this.notifications()) ?? []; }
        catch (e) { notificationsError = String(e?.message ?? e).slice(0, 120); }
        // Repos hidden in settings (github.hideRepos, matched as case-insensitive substrings of "owner/name").
        const hidden = (this.settings.github.hideRepos ?? []).map((h) => String(h).trim().toLowerCase()).filter(Boolean);
        const shown = (repo) => !hidden.some((h) => String(repo ?? "").toLowerCase().includes(h));
        const repoOfUrl = (url) => String(url ?? "").match(/github\.com\/([^/]+\/[^/]+)/)?.[1] ?? "";
        const next = {
          prs: prs.filter((p) => shown(repoOfUrl(p.url))),
          reviews: reviews.filter((r) => shown(r.repo)).slice(0, 20),
          notifications: notifications.filter((n) => shown(n.repo)),
          notificationsError,
        };
        if (!same(next, { prs: prev.prs, reviews: prev.reviews, notifications: prev.notifications, notificationsError: prev.notificationsError ?? null })) setShared("cc.github", next);
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e).slice(0, 120);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  // Reads a blocked agent's screen once per blocked spell; drops agents that moved on.
  syncSnippets(cx) {
    const blocked = new Set(agents().filter((a) => a.status === "blocked").map((a) => a.address));
    const stored = shared("cc.snippets") ?? {};
    const kept = Object.fromEntries(Object.entries(stored).filter(([k]) => blocked.has(k)));
    if (!same(kept, stored)) setShared("cc.snippets", kept);
    for (const address of blocked) {
      if (address in kept || this.reading.has(address)) continue;
      this.reading.add(address);
      cx.spawn(async () => {
        const r = await hc(["read", address, "--lines", "0"]).catch(() => null);
        this.reading.delete(address);
        if (r?.code === 0) setShared("cc.snippets", { ...(shared("cc.snippets") ?? {}), [address]: snippet(r.stdout) });
      });
    }
  }

  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render(cx) {
    this.activityAgents(cx);
    this.syncSnippets(cx);
    this.syncRequests(cx);
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const sync = this.error ? `GitHub: ${this.error}` : this.busy ? "GitHub: checking…" : this.lastRun ? `GitHub ${ago(this.lastRun)}` : "GitHub";
    const lin = shared("cc.linear") ?? {};
    const linSync = lin.running ? "Linear: checking…" : lin.notConnected ? "Linear: not connected" : lin.error ? "Linear: failed" : lin.at ? `Linear ${ago(lin.at)}` : "Linear";
    const sl = shared("cc.slack") ?? {};
    const asks = (sl.items ?? []).filter((i) => i.kind === "ask" && !i.ticked).length;
    const slSync = sl.running ? "Slack: sweeping…" : sl.notConnected ? "Slack: not connected" : sl.error ? "Slack: failed" : sl.lastAt ? `Slack ${ago(sl.lastAt)}` : "Slack";
    const st = this.settings;
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .when(st.slack.enabled && asks > 0, (el) => el.child(h_flex().id("cc-slack-asks").gap(4).cursor_pointer()
        .on_click(() => { run("layout.select", { stack: "panel-body", child: "inbox" }); run("layout.show", { id: "panel" }); setShared("cc.inbox.filter", "slack"); })
        .child(div().font_semibold().text_color(t.blocked).child(String(asks))).child("Slack to do")))
      .when(st.slack.enabled, (el) => el.child(div().id("cc-slack-sync").text_color(sl.error || sl.notConnected ? t.blocked : t.dim).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.slack(cx, true); cx.notify(); }).child(slSync)))
      .when(st.linear.enabled, (el) => el.child(div().id("cc-linear-sync").text_color(lin.error || lin.notConnected ? t.blocked : t.dim).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.linear(cx, true); cx.notify(); }).child(linSync)))
      .when(st.github.enabled, (el) => el.child(div().id("cc-sync").text_color(this.error ? t.blocked : t.dim).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.refresh(cx, true); cx.notify(); }).child(sync)))
      .child(div().id("cc-settings").text_color(this.settingsError ? t.blocked : t.dim).hover((s) => s.text_color(t.foreground))
        .on_click(() => openOverlay({ mod: "cc-settings", kind: "dialog", width: 640, height: 0.85 }))
        .child(this.settingsError ? "Settings: file has an error" : "Settings"))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint()));
  }
}
