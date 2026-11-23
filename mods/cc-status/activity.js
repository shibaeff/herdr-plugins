// Activity log: how you spend time in Herdr and how you work with AI agents. Files only, local, no UI.
// <appHome>/data/cc-activity/
//   YYYY-MM-DD.jsonl          one event per line (local date):
//     focus   every minute: front app, Herdr's focused space/repo/branch/tab/program, idle seconds
//     agent   an agent in Herdr changed status (working, blocked, done, idle) or appeared/went away
//     prompt  a message you sent to Claude Code or Codex (any terminal, in Herdr or not), from their session logs
//     usage   tokens per Claude Code / Codex session since the last scan
//   YYYY-MM-DD.summary.json   rolled up each hour and at the end of the day:
//     minutes per app / project / space, agent runs, minutes agents worked and waited on you, how fast you
//     answered them, prompts per agent / project, tokens
//   state.json                where each session log was last read up to
// Only new lines of session logs are read (tail -n from the last line read), so history before the first run isn't
// imported.

import { exec, home, appHome } from "herdr";
import * as fs from "fs/promises";

export const FOCUS_EVERY = 60_000;
export const SESSIONS_EVERY = 10 * 60_000;
const IDLE_AFTER = 300; // seconds without keyboard or mouse = away
const PROMPT_CHARS = 500;

export const dir = () => `${appHome()}/data/cc-activity`;
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// Appends events to their day's file. Herdr's fs has no append, so read + write; one writer (cc-status) at a time.
let queue = Promise.resolve();
export function log(events) {
  const list = (Array.isArray(events) ? events : [events]).filter(Boolean);
  if (!list.length) return queue;
  queue = queue.then(async () => {
    await fs.mkdir(dir(), { recursive: true });
    const byDay = new Map();
    for (const e of list) {
      const day = ymd(e.t);
      byDay.set(day, (byDay.get(day) ?? "") + JSON.stringify(e) + "\n");
    }
    for (const [day, lines] of byDay) {
      const path = `${dir()}/${day}.jsonl`;
      let old = "";
      try { old = await fs.readFile(path, "utf8"); } catch { /* new day */ }
      await fs.writeFile(path, old + lines);
    }
  }).catch((e) => console.log("cc-status activity:", e));
  return queue;
}

// Seconds since the last keyboard or mouse input on this Mac.
export async function idleSeconds() {
  const r = await exec("sh", ["-c", "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'"], { timeout: 5000 }).catch(() => null);
  return Number(r?.stdout.trim()) || 0;
}

export async function frontApp() {
  const r = await exec("sh", ["-c", 'lsappinfo info -only name "$(lsappinfo front)"'], { timeout: 5000 }).catch(() => null);
  return r?.stdout.match(/"LSDisplayName"="([^"]*)"/)?.[1] ?? null;
}

// One focus sample. repoOf: cwd → repo root (cached by the caller).
export async function focusSample({ focused, spaces, panes, window, repoOf }) {
  const [idle, app] = await Promise.all([idleSeconds(), frontApp()]);
  const f = focused, space = spaces.find((s) => s.id === f?.space), tab = space?.tabs.find((t) => t.id === f?.tab);
  const pane = panes.find((p) => p.pane === f?.pane);
  const cwd = f?.cwd ?? pane?.cwd ?? null;
  const repo = cwd && !space?.machine ? await repoOf(cwd) : null;
  return {
    t: Date.now(), kind: "focus", away: idle >= IDLE_AFTER, idle, app, herdr: Boolean(window?.active),
    machine: space?.machine ?? null, space: space?.name ?? null, tab: tab?.name ?? null,
    repo: repo ? repo.split("/").pop() : null, branch: pane?.branch ?? space?.branch ?? null, cwd,
    program: pane?.program?.name ?? null, agent: f?.agent ? true : Boolean(pane?.program?.agent),
  };
}

// Agent status changes since the last call: { events, next }. prev: address → {status, ...}.
export function agentChanges(prev, agents, panes) {
  const now = Date.now(), next = {}, events = [];
  for (const a of agents) {
    const pane = panes.find((p) => p.pane === a.pane);
    const info = { status: a.status, program: a.program?.name ?? a.app ?? "agent", space: a.space_name, tab: a.tab_name,
      cwd: pane?.cwd ?? null, branch: pane?.branch ?? null, machine: a.address.includes("/") ? a.address.split("/")[0] : null };
    next[a.address] = info;
    const was = prev[a.address];
    if (!was) events.push({ t: now, kind: "agent", event: "appeared", address: a.address, ...info, from: null, to: a.status, title: a.title });
    else if (was.status !== a.status) events.push({ t: now, kind: "agent", event: "status", address: a.address, ...info, from: was.status, to: a.status, title: a.title });
  }
  for (const [address, was] of Object.entries(prev)) if (!next[address]) events.push({ t: now, kind: "agent", event: "gone", address, ...was, from: was.status, to: null });
  return { events, next };
}

// ---- Claude Code and Codex session logs ----

const SKIP_TEXT = /^(<system-reminder>|<local-command-|<command-message>|Caveat: |<environment_context>|<user_instructions>|<permissions instructions>|# AGENTS\.md|\[Request interrupted|<task-notification>|<bash-notification>)/;
const textOf = (content) => (typeof content === "string" ? content
  : (content ?? []).filter((c) => c?.type === "text" || c?.type === "input_text").map((c) => c.text ?? "").join("\n"));
const project = (cwd) => (cwd ? cwd.replace(home(), "~") : null);

// New complete lines of a file after line `done`, via tail (files can be hundreds of MB). A last line without its
// newline is still being written: left for next time.
async function newLines(path, done) {
  const r = await exec("tail", ["-n", `+${done + 1}`, path], { timeout: 30_000 }).catch(() => null);
  const text = r?.stdout ?? "";
  const end = text.lastIndexOf("\n");
  if (end < 0) return { lines: [], read: 0 };
  const lines = text.slice(0, end).split("\n");
  return { lines, read: lines.length };
}

export function claudeEvents(lines, path) {
  const out = [], tokens = {};
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    const t = Date.parse(o.timestamp) || Date.now();
    if (o.type === "user" && !o.isMeta && !o.isSidechain && o.message?.role === "user") {
      const text = textOf(o.message.content).trim();
      if (!text || SKIP_TEXT.test(text) || (Array.isArray(o.message.content) && o.message.content.some((c) => c.type === "tool_result"))) continue;
      const src = o.promptSource ?? o.origin ?? o.userType ?? null, source = typeof src === "object" && src ? src.kind ?? null : src;
      if (source === "system") continue; // injected (task notifications and the like), not you
      out.push({ t, kind: "prompt", agent: "claude-code", session: o.sessionId, project: project(o.cwd), branch: o.gitBranch ?? null,
        source, permissionMode: o.permissionMode ?? null,
        slash: text.startsWith("/") ? text.split(/\s/)[0] : null, chars: text.length, text: text.slice(0, PROMPT_CHARS) });
    }
    const u = o.type === "assistant" ? o.message?.usage : null;
    if (u && !o.isSidechain) {
      const k = o.sessionId ?? path;
      const x = (tokens[k] ??= { t, kind: "usage", agent: "claude-code", session: o.sessionId, project: project(o.cwd), model: o.message?.model ?? null,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 });
      x.input += u.input_tokens ?? 0; x.output += u.output_tokens ?? 0;
      x.cacheRead += u.cache_read_input_tokens ?? 0; x.cacheWrite += u.cache_creation_input_tokens ?? 0; x.turns += 1; x.t = t;
    }
  }
  return [...out, ...Object.values(tokens)];
}

export function codexEvents(lines, path, meta) {
  const out = [];
  let last = null;
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    const p = o.payload ?? {}, t = Date.parse(o.timestamp) || Date.now();
    if (o.type === "session_meta") { meta.cwd = p.cwd ?? meta.cwd; meta.session = p.id ?? meta.session; continue; }
    if (o.type === "turn_context" && p.model) meta.model = p.model;
    if (o.type === "response_item" && p.type === "message" && p.role === "user") {
      const text = textOf(p.content).trim();
      if (!text || SKIP_TEXT.test(text)) continue;
      out.push({ t, kind: "prompt", agent: "codex", session: meta.session ?? path, project: project(meta.cwd),
        slash: text.startsWith("/") ? text.split(/\s/)[0] : null, chars: text.length, text: text.slice(0, PROMPT_CHARS) });
    }
    if (o.type === "event_msg" && p.type === "token_count" && p.info?.total_token_usage) last = { t, u: p.info.total_token_usage };
  }
  if (last) {
    const u = last.u, prevTotal = meta.total ?? { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
    out.push({ t: last.t, kind: "usage", agent: "codex", session: meta.session ?? path, project: project(meta.cwd), model: meta.model ?? null,
      // Codex's input_tokens include the cached ones; count them apart, as Claude's logs do.
      input: ((u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)) - ((prevTotal.input_tokens ?? 0) - (prevTotal.cached_input_tokens ?? 0)), output: (u.output_tokens ?? 0) - (prevTotal.output_tokens ?? 0),
      cacheRead: (u.cached_input_tokens ?? 0) - (prevTotal.cached_input_tokens ?? 0), cacheWrite: 0 });
    meta.total = u;
  }
  return out;
}

// Reads what's new in Claude Code and Codex session logs; first run only records where each file ends.
export async function scanSessions() {
  const statePath = `${dir()}/state.json`;
  let state = {};
  try { state = JSON.parse(await fs.readFile(statePath, "utf8")); } catch { /* first run */ }
  state.files ??= {};
  const first = !state.started;
  // Files changed in the last 2 days, with sizes: "<size> <path>".
  const r = await exec("sh", ["-c", 'for d in "$HOME/.claude/projects" "$HOME/.codex/sessions"; do [ -d "$d" ] && find "$d" -name "*.jsonl" -type f -mtime -2 -exec stat -f "%z %N" {} +; done'], { timeout: 30_000 }).catch(() => null);
  const events = [];
  for (const line of (r?.stdout ?? "").split("\n").filter(Boolean)) {
    const i = line.indexOf(" "), size = Number(line.slice(0, i)), path = line.slice(i + 1);
    if (path.includes("/subagents/")) continue;
    let f = state.files[path];
    if (!f) {
      // First run: start at the end of what's there. Files new since then: from the top.
      let lines = 0;
      if (first) lines = Number((await exec("sh", ["-c", 'wc -l < "$1"', "sh", path], { timeout: 30_000 }).catch(() => null))?.stdout.trim()) || 0;
      f = state.files[path] = { lines, size: first ? size : 0, meta: {} };
    }
    f.seen = Date.now();
    if (size < f.size) { f.lines = 0; f.meta = {}; } // rewritten
    if (size === f.size) continue;
    const { lines, read } = await newLines(path, f.lines);
    f.lines += read;
    f.size = size;
    events.push(...(path.includes("/.codex/") ? codexEvents(lines, path, f.meta) : claudeEvents(lines, path)));
  }
  // Forget files untouched for a week.
  for (const [p, f] of Object.entries(state.files)) if (Date.now() - (f.seen ?? Date.now()) > 7 * 86_400_000) delete state.files[p];
  state.started ??= Date.now();
  await log(events);
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state));
  return events.length;
}

// ---- Daily summary ----

const add = (o, k, n = 1) => { if (k != null) o[k] = (o[k] ?? 0) + n; };
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

export async function summarize(day) {
  let text = "";
  try { text = await fs.readFile(`${dir()}/${day}.jsonl`, "utf8"); } catch { return null; }
  const ev = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const s = { day, minutes: { active: 0, away: 0, inHerdr: 0, byApp: {}, byProject: {}, bySpace: {}, onAgents: 0 },
    agents: { runs: 0, byProgram: {}, workingMin: {}, waitingOnYouMin: 0, answers: 0, answerMedianMin: null, finished: 0 },
    prompts: { total: 0, byAgent: {}, byProject: {}, slash: {}, avgChars: 0, byHour: {} },
    tokens: { byAgent: {}, byProject: {} } };
  const answerTimes = [], open = {};
  let chars = 0;
  for (const e of ev) {
    if (e.kind === "focus") {
      if (e.away) { s.minutes.away++; continue; }
      s.minutes.active++; add(s.minutes.byApp, e.app ?? "?");
      if (e.herdr) { s.minutes.inHerdr++; add(s.minutes.byProject, e.repo ?? e.space ?? "?"); add(s.minutes.bySpace, e.space ?? "?"); if (e.agent) s.minutes.onAgents++; }
    } else if (e.kind === "agent") {
      const o = open[e.address];
      if (o) {
        const min = (e.t - o.since) / 60_000;
        if (o.status === "working") add(s.agents.workingMin, e.program, Math.round(min * 10) / 10);
        if (o.status === "blocked") { s.agents.waitingOnYouMin += min; if (e.to === "working") { answerTimes.push(min); s.agents.answers++; } }
      }
      if (e.to === "working" && o?.status !== "working") { s.agents.runs++; add(s.agents.byProgram, e.program); }
      if (e.to === "done") s.agents.finished++;
      if (e.to) open[e.address] = { status: e.to, since: e.t }; else delete open[e.address];
    } else if (e.kind === "prompt") {
      s.prompts.total++; chars += e.chars ?? 0; add(s.prompts.byAgent, e.agent); add(s.prompts.byProject, e.project ?? "?");
      add(s.prompts.slash, e.slash); add(s.prompts.byHour, String(new Date(e.t).getHours()).padStart(2, "0"));
    } else if (e.kind === "usage") {
      const n = (e.input ?? 0) + (e.output ?? 0) + (e.cacheWrite ?? 0);
      add(s.tokens.byAgent, e.agent, n); add(s.tokens.byProject, e.project ?? "?", n);
    }
  }
  s.agents.waitingOnYouMin = Math.round(s.agents.waitingOnYouMin);
  s.agents.answerMedianMin = median(answerTimes) == null ? null : Math.round(median(answerTimes) * 10) / 10;
  s.prompts.avgChars = s.prompts.total ? Math.round(chars / s.prompts.total) : 0;
  for (const g of [s.minutes, s.agents, s.prompts, s.tokens]) for (const [k, v] of Object.entries(g)) if (v && typeof v === "object" && !Array.isArray(v)) g[k] = sortObj(v);
  s.updatedAt = Date.now();
  await fs.writeFile(`${dir()}/${day}.summary.json`, JSON.stringify(s, null, 2));
  return s;
}

export const today = () => ymd(Date.now());
export const yesterday = () => ymd(Date.now() - 86_400_000);
