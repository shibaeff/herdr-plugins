// Command Center settings: ~/.config/herdr-app/command-center.json. cc-status owns the file and publishes the
// merged settings as shared "cc.settings"; the dialog and other mods change it with shared "cc.settings.update".
// Paid features (Slack sweep, standup) start off. install.mjs imports DEFAULTS to write a new file.

import * as fs from "fs/promises";

export const DEFAULTS = {
  repoRoots: null, // null: the parent folders of the repos open in Herdr
  github: { enabled: true, everyMin: 3, reviews: "direct", notifications: true },
  linear: { enabled: true, everyMin: 15, hours: [7, 22], model: "haiku" },
  slack: { enabled: false, everyMin: 60, hours: [9, 19], model: "sonnet" },
  standup: { enabled: false, times: [23], weekdaysOnly: true, cutover: 18, model: "sonnet" },
  usage: { claude: true, codex: true },
  demo: false, // sample data and no fetching, for scripts/preview.mjs
};

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

// Defaults under whatever the file sets, one level deep, so a new setting appears without editing the file.
export function withDefaults(s) {
  const out = {};
  for (const [k, v] of Object.entries(DEFAULTS)) out[k] = isObject(v) ? { ...v, ...(isObject(s?.[k]) ? s[k] : {}) } : s?.[k] !== undefined ? s[k] : v;
  return out;
}

export function patch(s, p) {
  const out = { ...s };
  for (const [k, v] of Object.entries(p ?? {})) out[k] = isObject(v) && isObject(s[k]) ? { ...s[k], ...v } : v;
  return out;
}

export async function loadSettings(path) {
  try { return { settings: withDefaults(JSON.parse(await fs.readFile(path, "utf8"))), error: null, missing: false }; }
  catch (e) { return { settings: withDefaults({}), error: String(e?.message ?? e).includes("No such") || String(e).includes("ENOENT") ? null : String(e?.message ?? e), missing: true }; }
}

export async function saveSettings(path, s) {
  await fs.writeFile(path, JSON.stringify(s, null, 2) + "\n");
}

// [from, to) in local hours; [0, 24] is all day, and a range can wrap past midnight.
export const inHours = (h, [from, to]) => (from <= to ? h >= from && h < to : h >= from || h < to);
