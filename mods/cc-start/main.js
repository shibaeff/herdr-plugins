// Start from a Linear issue: a worktree (or a tab) with an agent whose first message is the issue.
// props: { issue, overlay }

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, InputState, Input } from "gpui-base";
import { spaces, panes, props, theme, run, exec, knownAgents, closeOverlay, shared, setShared, pickFolder, home, appHome } from "herdr";

// Folders scanned for git repos, three levels deep: settings' repoRoots, or when unset the parent folders of
// the repos open in Herdr (cc-status works them out). "Change folders" saves them to settings.
const repoRoots = () => shared("cc.settings")?.roots ?? [];
const tilde = (p) => p.replace(home(), "~");
const untilde = (p) => p.trim().replace(/^~(?=\/|$)/, home());

// The repo whose name appears in the issue's project or title (inbound-se for "… Inbound SE"); longest wins.
function suggest(issue, repos) {
  const text = ` ${`${issue.project ?? ""} ${issue.title}`.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return repos.filter((r) => r.name.length >= 4 && text.includes(` ${r.name.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `))
    .sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

const MODES = [
  { id: "plan", label: "Plan mode" },
  { id: "auto", label: "Auto mode" },
  { id: "manual", label: "Ask first" },
];

// A repo's main checkout: a new worktree goes beside it, also when started from another worktree.
async function mainOf(root) {
  const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root }).catch(() => null);
  const dir = r?.code === 0 ? r.stdout.trim() : "";
  return dir.endsWith("/.git") ? dir.slice(0, -5) : root;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
const shortTitle = (s) => s.split(/\s+/).reduce((acc, w) => (acc.length + w.length < 26 ? `${acc} ${w}`.trim() : acc), "");

// The issue list (cc.linear) holds only the start of each description, so the whole issue is read when the dialog
// opens. A headless Claude run calls Linear; the text comes from the tools' own answers in its stream, never from
// what the model writes back.
const ISSUE_TOOLS = ["ToolSearch", "mcp__claude_ai_Linear__get_issue", "mcp__claude_ai_Linear__list_comments"];
const issuePrompt = (id) => `Load the Linear tools with ToolSearch. Call get_issue for ${id}. Call list_comments for ${id} with limit 250, and again with the returned cursor while hasNextPage is true.
Read only: never create, change or comment on anything. Reply with just: done.`;

function readIssue(stdout, id) {
  const calls = new Map(), pages = [];
  let issue = null, said = "";
  for (const line of stdout.split("\n")) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type === "result") said = String(m.result ?? "");
    for (const c of Array.isArray(m.message?.content) ? m.message.content : []) {
      if (c.type === "tool_use") calls.set(c.id, c);
      if (c.type !== "tool_result") continue;
      const call = calls.get(c.tool_use_id);
      let data;
      try { data = JSON.parse(typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x.text ?? "").join("")); } catch { continue; }
      if (call?.name.endsWith("__get_issue") && String(data.id).toUpperCase() === id.toUpperCase() && typeof data.title === "string") issue = data;
      if (call?.name.endsWith("__list_comments") && Array.isArray(data.comments)) pages.push({ of: String(call.input?.issueId ?? ""), ...data });
    }
  }
  if (!issue) throw new Error(/^done\.?$/i.test(said.trim()) ? "" : said.split("\n")[0].slice(0, 160));
  const mine = pages.filter((p) => [id.toUpperCase(), String(issue.uuid).toUpperCase()].includes(p.of.toUpperCase()));
  const comments = [...new Map(mine.flatMap((p) => p.comments).map((c) => [c.id, c])).values()]
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return { description: issue.description ?? "", comments, partial: !mine.length || Boolean(mine[mine.length - 1].hasNextPage) };
}

async function fetchIssue(id) {
  const dir = `${appHome()}/data/cc-claude`;
  await exec("mkdir", ["-p", dir]);
  // Wait for the claude.ai connectors before the turn starts (see cc-status claude()).
  const r = await exec("/usr/bin/env", ["MCP_CONNECTION_NONBLOCKING=false", `${home()}/.local/bin/claude`, "-p", issuePrompt(id), "--model", "haiku", "--tools", "ToolSearch", "--allowedTools", ISSUE_TOOLS.join(","),
    "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--max-budget-usd", "0.3"], { cwd: dir, timeout: 120_000 });
  try { return readIssue(r.stdout ?? "", id); }
  catch (e) { throw new Error(e.message || (r.stderr ?? "").trim().split("\n")[0].slice(0, 160) || `claude exited ${r.code}`); }
}

// full: what fetchIssue read, or null when it failed and only the list's start of the description is known.
function firstMessage(i, full) {
  const head = `Work on ${i.identifier}: ${i.title}\n${i.url}`;
  const tail = `Keep notes on your plan, decisions and assumptions as you go. When done, open a PR titled "${i.identifier}: …" and stop.`;
  if (!full) {
    const start = (i.description ?? "").trim();
    return [head, "The full issue couldn't be loaded from Linear when this started. Read it there first (description, comments, attachments); if you can't, stop and say so.",
      start && `All that is copied here is the start of its description:\n\n${start}…`, tail].filter(Boolean).join("\n\n");
  }
  const said = full.comments.map((c) => `${c.author?.name ?? "Someone"}, ${String(c.createdAt).slice(0, 10)}:\n${String(c.body ?? "").trim()}`).join("\n\n");
  return [head, full.description.trim(), said && `Comments, oldest first:\n\n${said}`, full.partial && "Some comments may be missing here.",
    "The description and comments above were copied from Linear when this started. Before planning, read the issue in Linear yourself if you can, for its images, attachments and anything added since.",
    tail].filter(Boolean).join("\n\n");
}

export default class Start extends View {
  init(_props, cx) {
    const i = props()?.issue;
    if (!i) return;
    this.where = "worktree";
    this.mode = "plan";
    this.agent = "claude";
    this.move = i.stateType !== "started";
    this.repos = [];
    this.repo = null;
    this.agents = [{ key: "claude", name: "Claude Code", run: ["claude"] }, { key: "shell", name: "Shell", run: null }];
    this.message = TextareaState.new({ rows: 7 });
    this.query = "";
    this.filter = InputState.new({ placeholder: "Filter repos" });
    this.filter.on("change", (_e, cx) => { this.query = this.filter.value().trim().toLowerCase(); cx.notify(); });
    this.editingRoots = false;
    this.rootsInput = InputState.new({ value: repoRoots().map(tilde).join(", ") });
    this.rootsInput.on("submit", (_e, cx) => this.saveRoots(cx));
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      const found = await knownAgents().catch(() => []);
      const list = found.filter((a) => a.installed && (a.key === "claude" || a.key === "codex"));
      if (list.length) this.agents = [...list.map((a) => ({ key: a.key, name: a.name, run: a.run })), { key: "shell", name: "Shell", run: null }];
      cx.notify();
    });
    this.scan(cx, true);
    this.load(cx);
  }

  load(cx) {
    const i = props().issue;
    // Demo issues (scripts/preview.mjs) aren't in Linear.
    if (shared("cc.settings")?.demo) return this.message.set_value(firstMessage(i, { description: i.description ?? "", comments: [] }));
    this.loading = true;
    this.loadError = "";
    cx.spawn(async (cx) => {
      try { this.message.set_value(firstMessage(i, await fetchIssue(i.identifier))); }
      catch (e) {
        this.loadError = String(e?.message ?? e).replace(/\.$/, "");
        this.message.set_value(firstMessage(i, null));
      }
      this.loading = false;
      cx.notify();
    });
  }

  // Repos open as local spaces (the shown one first), then every repo under the folders.
  scan(cx, pick, roots = repoRoots()) {
    cx.spawn(async (cx) => {
      const byRoot = new Map();
      const ordered = [...spaces()].sort((a, b) => Number(b.active) - Number(a.active));
      for (const s of ordered) {
        if (s.machine) continue;
        const tabIds = new Set(s.tabs.map((t) => t.id));
        const cwd = panes().find((p) => tabIds.has(p.tab) && p.cwd)?.cwd ?? s.folder;
        if (!cwd) continue;
        const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => null);
        const root = r?.code === 0 ? r.stdout.trim() : null;
        if (root && !byRoot.has(root)) byRoot.set(root, { root, main: await mainOf(root), name: root.split("/").pop(), space: s.id });
      }
      const scanned = [];
      // -type d: a worktree's .git is a file, so only main checkouts are listed.
      for (const dir of roots) {
        const r = await exec("find", [dir, "-maxdepth", "3", "-name", ".git", "-type", "d", "-not", "-path", "*/node_modules/*"], { timeout: 15_000 }).catch(() => null);
        for (const line of (r?.stdout ?? "").split("\n").filter(Boolean)) {
          const root = line.replace(/\/\.git$/, "");
          if (!byRoot.has(root)) scanned.push({ root, main: root, name: root.split("/").pop(), space: null });
        }
      }
      scanned.sort((a, b) => a.name.localeCompare(b.name));
      const picked = this.repo?.root;
      this.repos = [...byRoot.values(), ...scanned];
      this.suggested = suggest(props().issue, this.repos);
      this.repo = (picked && this.repos.find((r) => r.root === picked)) || (pick && this.suggested) || this.repos[0] || null;
      cx.notify();
    });
  }

  saveRoots(cx) {
    const roots = this.rootsInput.value().split(",").map(untilde).filter(Boolean);
    setShared("cc.settings.update", { patch: { repoRoots: roots.length ? roots : null }, at: Date.now() });
    this.editingRoots = false;
    this.scan(cx, false, roots);
    cx.notify();
  }

  pickRepo(cx) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Use this repo" });
      if (!folder) return;
      const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder }).catch(() => null);
      if (r?.code !== 0) { this.pickError = "That folder isn't in a git repo."; cx.notify(); return; }
      const root = r.stdout.trim();
      this.pickError = null;
      this.repo = this.repos.find((x) => x.root === root) ?? { root, main: await mainOf(root), name: root.split("/").pop(), space: null };
      if (!this.repos.includes(this.repo)) this.repos.push(this.repo);
      cx.notify();
    });
  }

  // Beside the repo's main checkout, as <repo>-<issue id>.
  worktreePath() {
    return `${this.repo.main}-${props().issue.identifier.toLowerCase()}`;
  }

  // A branch that exists is checked out; a new one starts from the picked checkout's HEAD. Returns an error or "".
  async addWorktree(branch, path) {
    const git = (args) => exec("git", args, { cwd: this.repo.root, timeout: 600_000 });
    try {
      const exists = (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
      const r = await git(exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"]);
      return r.code === 0 ? "" : (r.stderr || r.stdout || "").trim() || "git worktree add failed.";
    } catch (error) { return String(error); }
  }

  start(cx) {
    if (this.busy || (this.loading && this.agent !== "shell")) return;
    const i = props().issue;
    const msg = this.message.value().trim();
    const agent = this.agents.find((a) => a.key === this.agent);
    const name = `${i.identifier} ${shortTitle(i.title)}`;
    const argv = !agent?.run ? null : agent.key === "claude" ? [...agent.run, "--permission-mode", this.mode] : [...agent.run];
    const move = () => { if (this.move) setShared("cc.linear.move", { identifier: i.identifier, at: Date.now() }); };
    if (this.where === "worktree") {
      const path = this.worktreePath();
      this.busy = true;
      this.error = "";
      cx.notify();
      cx.spawn(async (cx) => {
        this.error = await this.addWorktree(i.branchName || `${i.identifier.toLowerCase()}-${slug(i.title)}`, path);
        this.busy = false;
        if (this.error) return cx.notify();
        // The first message goes on the agent's command line.
        run("space.new", { folder: path, tab: name, argv: argv ? [...argv, ...(msg ? [msg] : [])] : undefined });
        move();
        closeOverlay(props().overlay);
      });
      return;
    }
    closeOverlay(props().overlay);
    if (this.repo.space) {
      run("tab.new", { space: this.repo.space, name, folder: this.repo.root, argv: argv ?? undefined, task: argv && msg ? msg : undefined });
    } else {
      run("space.new", { folder: this.repo.root, tab: name, argv: argv ?? undefined, task: argv && msg ? msg : undefined });
    }
    move();
  }

  render() {
    const t = theme();
    const i = props()?.issue;
    if (!i) return div();
    const label = (text) => div().pt(14).pb(6).text_size(11).font_medium().text_color(t.dim).child(text);
    const seg = (id, options, value, pick) => h_flex().p(3).gap(2).rounded(8).bg(t.background).border_1().border_color(t.border).children(options.map((o) =>
      div().id(`${id}-${o.id}`).flex_1().py(6).rounded(6).text_center().text_size(12.5).cursor_pointer()
        .bg(value === o.id ? t.selected : t.background).text_color(value === o.id ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { pick(o.id); cx.notify(); }).child(o.label)));
    const button = (id, text, primary, action, enabled = true) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).opacity(enabled ? 1 : 0.5)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(enabled ? 0.88 : 0.5)).on_click((_e, cx) => enabled && action(cx)).child(text);
    const check = (id, on, text, toggle) => h_flex().id(id).gap(8).items_center().cursor_pointer().on_click((_e, cx) => { toggle(); cx.notify(); })
      .child(div().size(14).rounded(3).border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background)
        .text_size(10).text_color(t.accent_foreground).text_center().child(on ? "✓" : ""))
      .child(div().text_size(12.5).child(text));
    const branch = i.branchName || `${i.identifier.toLowerCase()}-${slug(i.title)}`;
    const ready = Boolean(this.repo);
    const waiting = Boolean(this.loading) && this.agent !== "shell";

    return v_flex().id("cc-start").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .w_full().p(20).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(12).text_color(t.accent).child(i.identifier))
        .child(div().text_size(11.5).text_color(t.dim).child([i.state, i.cycle, i.project].filter(Boolean).join(" · ")))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(6).text_size(16).font_semibold().child(i.title))
      .child(label("WHERE"))
      .child(seg("where", [{ id: "worktree", label: "New worktree" }, { id: "tab", label: "New tab in its space" }], this.where, (v) => { this.where = v; }))
      .child(h_flex().pt(8).gap(8).items_center()
        .child(Input.new(this.filter).flex_1().h(30).px(9).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5))
        .child(div().id("repo-other").flex_none().text_size(12).text_color(t.muted).cursor_pointer()
          .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.pickRepo(cx)).child("Other repo…")))
      .child(v_flex().id("repo-list").mt(6).h(150).overflow_y_scrollbar().rounded(7).border_1().border_color(t.border)
        .children(this.repos.filter((r) => !this.query || r.name.toLowerCase().includes(this.query) || r.root.toLowerCase().includes(this.query)).map((r, n) =>
          h_flex().id(`repo-${n}`).px(10).py(5).gap(8).items_center().cursor_pointer()
            .bg(this.repo === r ? t.selected : t.background).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.repo = r; cx.notify(); })
            .child(div().flex_none().text_size(12.5).text_color(this.repo === r ? t.foreground : t.muted).child(r.name))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(tilde(r.root)))
            .when(Boolean(r.space), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.done).child("open")))
            .when(this.suggested === r, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.accent).child("suggested"))))))
      .child(h_flex().pt(6).gap(6).items_center().text_size(11.5).text_color(t.dim)
        .when(!this.editingRoots, (el) => el
          .child(div().flex_1().min_w(0).truncate().child(`Repos under ${repoRoots().map(tilde).join(", ")}`))
          .child(div().id("roots-edit").flex_none().cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.editingRoots = true; this.rootsInput.focus(); cx.notify(); }).child("Change folders")))
        .when(this.editingRoots, (el) => el
          .child(Input.new(this.rootsInput).flex_1().h(28).px(8).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(12))
          .child(div().id("roots-save").flex_none().cursor_pointer().text_color(t.foreground).on_click((_e, cx) => this.saveRoots(cx)).child("Save"))))
      .when(Boolean(this.pickError), (el) => el.child(div().pt(6).text_size(11.5).text_color(t.blocked).child(this.pickError)))
      .child(div().pt(6).text_size(11.5).text_color(t.dim).child(!ready ? "Pick a repo"
        : this.where === "worktree" ? `Branch ${branch}, in a new space at ${tilde(this.worktreePath())}` : `In ${this.repo.name}, on the branch it has checked out`))
      .child(label("AGENT"))
      .child(seg("agent", this.agents.map((a) => ({ id: a.key, label: a.name })), this.agent, (v) => { this.agent = v; }))
      .when(this.agent === "claude", (el) => el.child(label("START IN")).child(seg("mode", MODES, this.mode, (v) => { this.mode = v; })))
      .when(this.agent !== "shell", (el) => el.child(label("FIRST MESSAGE"))
        .when(Boolean(this.loading), (el) => el.child(div().h(150).px(10).py(8).rounded(8).border_1().border_color(t.input).bg(t.background)
          .text_size(12.5).text_color(t.dim).child("Loading the full issue from Linear…")))
        .when(!this.loading, (el) => el.child(Textarea.new(this.message).h(150).px(10).py(8).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5)))
        .when(Boolean(this.loadError) && !this.loading, (el) => el.child(h_flex().pt(6).gap(8).items_start().text_size(11.5)
          .child(div().flex_1().min_w(0).text_color(t.blocked).child(`Couldn't load the full issue from Linear: ${this.loadError}. Starting now sends only the start of its description, marked as incomplete.`))
          .child(div().id("issue-retry").flex_none().cursor_pointer().text_color(t.foreground).on_click((_e, cx) => { this.load(cx); cx.notify(); }).child("Retry")))))
      .when(i.stateType !== "started", (el) => el.child(div().pt(14).child(check("move", this.move, `Move ${i.identifier} to In Progress`, () => { this.move = !this.move; }))))
      .when(Boolean(this.error), (el) => el.child(div().pt(10).text_size(11.5).text_color(t.blocked).child(this.error)))
      .child(h_flex().pt(18).gap(8).items_center()
        .child(div().flex_1().text_size(11.5).text_color(t.dim).child(`Opens a tab named “${i.identifier} ${shortTitle(i.title)}”`))
        .child(button("cs-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("cs-start", this.busy ? "Starting…" : "Start", true, (cx) => this.start(cx), ready && !waiting && !this.busy)));
  }
}
