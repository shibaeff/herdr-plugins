// Live Slack feed from the macOS Slack app, free: the notifications Slack posts land in macOS's notification
// database, which Herdr can read once Herdr.app has Full Disk Access (System Settings → Privacy & Security).
// macOS drops a notification from the database when it's cleared, so everything seen is kept in
// <appHome>/data/cc-slack/app.json. A private macOS format: if it changes, the feed just stops adding items.
// The Inbox sees it as shared "cc.slackapp".

import { exec } from "herdr";
import * as fs from "fs/promises";

export const SLACKAPP_EVERY = 20_000;
const BUNDLE = "com.tinyspeck.slackmacgap";
const DB = '"$HOME/Library/Group Containers/group.com.apple.usernoted/db2/db"';
const APPLE_EPOCH = 978_307_200; // 2001-01-01 in Unix seconds
const KEEP = 7 * 86_400_000;

// rec_id and delivered date of every Slack notification still in the database.
const LIST = `db=${DB}; /usr/bin/sqlite3 -readonly "$db" "select rec_id||' '||delivered_date from record where app_id=(select app_id from app where identifier='${BUNDLE}')"`;
// The request part (title, body, id) of the given records, one JSON line each. Args: rec_ids (numbers only).
const READ = `db=${DB}; t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
for id in "$@"; do
  /usr/bin/sqlite3 -readonly "$db" "select writefile('$t/$id', data) from record where rec_id=$id" >/dev/null || continue
  r=$(/usr/bin/plutil -extract req json -o - "$t/$id" 2>/dev/null) || continue
  printf '{"rec":%s,"req":%s}\\n' "$id" "$r"
done`;

export const emptyAppState = () => ({ seen: [], items: [], channels: {}, domain: null });

// Links. A notification has the workspace and message timestamp but not the channel, so the channel ID is looked up
// once per channel (or DM sender) through the Slack connector and kept in state.channels; after that the link is
// built here for free. slack:// opens the message in the desktop app; the https permalink is what Copy link copies.
const where = (x) => (x.channel === "DM" ? `dm:${x.from}` : x.channel);
export function linkFor(state, x) {
  const cid = state.channels?.[where(x)];
  if (!cid || !x.ts) return null;
  return {
    channelId: cid,
    open: `slack://channel?team=${x.team}&id=${cid}&message=${x.ts}${x.threadTs ? `&thread_ts=${x.threadTs}` : ""}`,
    link: state.domain ? `https://${state.domain}.slack.com/archives/${cid}/p${x.ts.replace(".", "")}${x.threadTs ? `?thread_ts=${x.threadTs}&cid=${cid}` : ""}` : null,
  };
}
export const needsLink = (x) => !x.channelId && x.ts && (x.tries ?? 0) < 3;

export const RESOLVE_TOOLS = ["ToolSearch", "mcp__claude_ai_Slack__slack_search_public_and_private"];
const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
// A search per message: a few of its words, its channel, its day. Quotes and modifiers stripped from the words.
export function resolvePrompt(items) {
  const q = (x) => {
    const words = x.text.replace(/["“”<>@#*`]/g, " ").replace(/\b\w+:/g, " ").split(/\s+/).filter(Boolean).slice(0, 8).join(" ");
    return `"${words}"${x.channel.startsWith("#") ? ` in:${x.channel}` : ""} on:${day(x.at)}`;
  };
  return `Load the Slack search tool with ToolSearch, then call slack_search_public_and_private once for each query below, with limit 5 and include_context false. Read only: never post, react or change anything. Reply with just: done.
${items.map((x) => `- ${q(x)}`).join("\n")}`;
}

// The search results in the run's stream, matched to items by message timestamp: { ts: {channelId, permalink, threadTs} }.
export function parseResolved(stdout) {
  const out = {};
  for (const line of stdout.split("\n")) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    for (const c of Array.isArray(m.message?.content) ? m.message.content : []) {
      if (c.type !== "tool_result") continue;
      let text = typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x.text ?? "").join("");
      try { text = JSON.parse(text).results ?? text; } catch { /* plain text */ }
      for (const block of String(text).split(/### Result/)) {
        const ts = block.match(/Message_ts:\s*([\d.]+)/)?.[1];
        const cid = block.match(/Channel:[^\n]*\(ID:\s*([A-Z0-9]+)\)/)?.[1];
        const link = block.match(/Permalink:\s*\[link\]\((https:[^)\s]+)\)/)?.[1]?.replace(/\\\//g, "/");
        if (ts && cid) out[ts] = { channelId: cid, permalink: link ?? null, threadTs: link?.match(/thread_ts=([\d.]+)/)?.[1] ?? null };
      }
    }
  }
  return out;
}

// Folds a lookup into state: remembers each channel, links every item in it.
export function applyResolved(state, asked, found) {
  state.channels ??= {};
  for (const x of asked) {
    x.tries = (x.tries ?? 0) + 1;
    const f = found[x.ts];
    if (!f) continue;
    state.channels[where(x)] = f.channelId;
    const domain = f.permalink?.match(/^https:\/\/([\w-]+)\.slack\.com\//)?.[1];
    if (domain) state.domain = domain;
    x.threadTs = f.threadTs;
  }
  for (const x of state.items) if (!x.channelId) Object.assign(x, linkFor(state, x) ?? {});
  for (const x of asked) { const f = found[x.ts]; if (f?.permalink) x.link = f.permalink; }
}

export async function loadAppState(path) {
  try { return { ...emptyAppState(), ...JSON.parse(await fs.readFile(path, "utf8")) }; } catch { return emptyAppState(); }
}

export async function saveAppState(path, state) {
  await fs.mkdir(path.replace(/\/[^/]+$/, ""), { recursive: true });
  await fs.writeFile(path, JSON.stringify(state, null, 2));
}

// "New message in #infra-team-only" / "Phil Ngo: text" → who, where, what. Titles Slack uses for DMs and
// threads vary, so anything unrecognised keeps the raw title as the place.
export function parse(req) {
  const title = String(req.titl ?? "").trim(), sub = String(req.subt ?? "").trim();
  let body = String(req.body ?? "").trim(), from = "";
  const said = body.match(/^([^:\n]{1,60}):\s([\s\S]*)$/);
  if (said) { from = said[1].trim(); body = said[2].trim(); }
  const inChannel = `${title} ${sub}`.match(/\bin\s+(#?[\w.-]+)/i);
  const fromWho = title.match(/^(?:new message from|message from|from)\s+(.+)$/i);
  const channel = inChannel ? (inChannel[1].startsWith("#") ? inChannel[1] : `#${inChannel[1]}`) : fromWho ? "DM" : title || "Slack";
  if (!from) from = fromWho ? fromWho[1].trim() : sub || title;
  const [team, ts] = String(req.iden ?? "").split("_");
  return { from, channel, text: body.slice(0, 400), team: team || null, ts: ts || null, title };
}

// Reads new notifications into state; returns the new items. Throws when the database can't be read.
export async function poll(state, now) {
  const list = await exec("sh", ["-c", LIST], { timeout: 10_000 });
  if (list.code !== 0) {
    const why = (list.stderr || list.stdout || "").trim();
    throw new Error(/not permitted|unable to open|authoriz/i.test(why)
      ? "Herdr needs Full Disk Access to read Slack's notifications"
      : why.split("\n")[0] || "couldn't read the notification database");
  }
  const seen = new Set(state.seen);
  const fresh = list.stdout.split("\n").map((l) => l.trim().split(" ")).filter(([id, d]) => /^\d+$/.test(id) && d)
    .map(([id, d]) => ({ id, key: `${id}|${d}`, at: Math.round((Number(d) + APPLE_EPOCH) * 1000) }))
    .filter((r) => !seen.has(r.key));
  const added = [];
  if (fresh.length) {
    const read = await exec("sh", ["-c", READ, "sh", ...fresh.map((r) => r.id)], { timeout: 20_000 });
    const byRec = new Map();
    for (const line of (read.stdout ?? "").split("\n")) { try { const o = JSON.parse(line); byRec.set(String(o.rec), o.req); } catch { /* skip */ } }
    for (const r of fresh) {
      state.seen.push(r.key);
      const req = byRec.get(r.id);
      if (!req) continue;
      const item = { key: req.iden || r.key, ...parse(req), at: Number.isFinite(r.at) ? r.at : now, ticked: false, tickedAt: null };
      Object.assign(item, linkFor(state, item) ?? {});
      if (state.items.some((x) => x.key === item.key)) continue;
      state.items.push(item);
      added.push(item);
    }
  }
  state.items = state.items.filter((x) => now - x.at < KEEP).slice(-300);
  state.seen = state.seen.slice(-1000);
  return added;
}

// Done / Undo / Clear from the Slack panel (shared "cc.slackapp.action").
export function applyApp(state, action, now) {
  const ids = new Set(action.ids ?? []);
  for (const x of state.items) {
    if (!ids.has(x.key)) continue;
    if (action.op === "tick") Object.assign(x, { ticked: true, tickedAt: now });
    if (action.op === "untick") Object.assign(x, { ticked: false, tickedAt: null });
  }
  if (action.op === "clear") state.items = state.items.filter((x) => !x.ticked);
}

// What the panel needs: open items and ones closed today.
export function publishApp(state, status) {
  const today = new Date().setHours(0, 0, 0, 0);
  return { ...status, items: state.items.filter((x) => !x.ticked || x.tickedAt >= today) };
}
