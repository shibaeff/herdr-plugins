# Command Center

Herdr's own layout for people running many coding agents at once, with one place for what needs you: an Inbox of
blocked and finished agents, Slack asks, failed CI and review requests; your Linear issues linked to the agents on
them; a summary of each task; a Board of all work; a standup draft; and Claude Code and Codex usage bars.

![Command Center](preview.png)

## What you see

- Herdr's `main` look and structure, unchanged except as below: a 268 px sidebar (`spaces`, `agents`), a 42 px tab
  bar, terminals as cards (8 px gap, 10 px corners, 30 px `pane` header, `accent` border on the focused one), a
  28 px status bar. All colours come from `theme()`, so every theme works, light and dark.
- **Tab bar**: at the left a two-way toggle, **Terminals | Board** (13 px icons, 24 px tall, `selected` when on),
  then the tabs (a Linear ID such as `ENG-412` in `accent` after a tab's name when its branch belongs to an issue),
  then `+` and panel buttons **Inbox · Linear · Tasks · Files · Changes**. Inbox carries a count in `blocked`.
- **Side panel**, 392 px (280–900), one panel at a time:
  - **Inbox**: filter chips (All, Agents, Slack, GitHub), a Slack sweep line (time swept, next, Check now), then
    sections NEEDS YOU NOW, REVIEW, NEW FOR YOU. Each row: a 50 px kind tag (AGENT `blocked`, DONE `done`, SLACK
    `working`, CI `blocked`, PR `accent`, MENTION `accent`, REPLY `working`, REVIEW by state), title, age, body, and buttons. A blocked agent's body is its screen's
    question and options. At the foot, the standup: "Standup for Monday · Written 23:00 · next 11:00", Copy, Write now.
  - **Linear**: "My issues", groups by state (started first, Backlog folded), rows with ID, title, Urgent/High,
    and either the linked space › tab with its agent status and PR checks, or **Start**.
  - **Tasks**: the shown space's tabs in git repos, then for the selected one: title, notes file and age, a red
    WAITING ON YOU box when its agent asks something, GOAL, PLAN (✓ ◐ ○), DECISIONS AND ASSUMPTIONS (tagged
    DECISION, ASSUMPTION, YOU SAID), CHANGES (files with +/−, commits, PR), NOT DONE OR RISKY; Review diff, Open notes.
- **Board** (in the centre, instead of the terminals): columns Needs you, In progress, In review, Todo, one card
  per piece of work: Linear ID and space › tab, title, a status line with a dot, and buttons (Open, Fix CI, PR #,
  Start, Linear). Filter chips by repo folder.
- **Sidebar foot** (above Settings): "Claude" and "Codex", each limit as three lines: name and percentage, a 5 px
  bar (`muted`, `working` from 70 %, `blocked` from 90 %), "resets on Mon 02:30" in `dim` 10.5 px.
- **Status bar**: machine, branch, agent count, then "2 Slack to do", "Slack 10m ago", "Linear 5m ago", "GitHub
  just now", **Settings**, the palette hint.
- **Dialogs**: Start from issue, Hand to agent (Slack), Settings (with a daily cost estimate); the standup opens as
  a pane beside the terminals.

## How it behaves

- Agent status: `blocked` → Inbox NEEDS YOU NOW and Board Needs you (red border); `done` → Inbox REVIEW and
  Board Needs you; `working` → Board In progress with time in state; `idle` → off the Board unless its branch
  has an issue or an open PR.
- Clicking an Inbox row opens the agent, thread or PR. Slack asks: **Hand to agent** (a dialog: a new Claude in
  plan mode or a free agent in this space, optionally search Slack first, editable message; it never posts),
  **Done** (counts toward the standup), **Skip** (doesn't); FYIs: **Seen**; closed ones: **Undo**.
- Board: clicking a card selects its tab and opens Tasks beside the Board; **Open** goes to the terminal; clicking
  any tab returns to Terminals. Cards for one issue or PR on several tabs merge (the agent's tab wins).
- Linear **Start**: worktree on Linear's branch name, next to the repo as `<repo>-<issue id>` (a new space), or a
  tab, Claude (plan, auto or ask-first) or Codex or a shell, the whole issue as the first message, repos listed
  from settings' folders with one suggested, and optionally Move to In Progress. The dialog reads the issue's full
  description and comments from Linear as it opens (the list holds only the start of each description) and takes
  them from the Linear tools' own answers, not from what the model writes back; Start waits for that, and a failed
  read offers Retry or a first message that says it is incomplete.
- Standup pane: click a bullet to edit, × drops it, press on one and release on another to move it, ✦ asks
  Claude to change one bullet, the box below changes the whole draft, Undo (10 steps).
- Keys: ⌘⌥1 Terminals, ⌘⌥2 Board, ⌘⌥I Inbox, ⌘⌥L Linear, ⌘⌥T Tasks. Clicking an open panel's button hides it;
  each space remembers its panel.
- When Linear or Slack isn't connected, its place says "Connect Linear to see your tickets" (steps, **Check
  again**, **I don't use Linear**) and scheduled runs wait.

## Built from

- `layouts/command-center.json`: Herdr's `main` tree with `tabs` → `cc-tabs`, `status` → `cc-status`, the `main`
  tab block wrapped in a `stack` `center` with a `board` block (`cc-board`), `panel-body` children `inbox`
  (`cc-inbox`), `linear` (`cc-linear`), `tasks` (`cc-tasks`), `files`, `changes`, and a `usage` block (`cc-usage`)
  before `sidebar-footer`. Shipped mods kept: `workspace-chrome`, `spaces`, `agents`, `pane`, `files`, `changes`,
  `worktree`, `menu`, `new-menu`.
- `cc-status` is the only fetcher, on a one-minute `cx.timer`: `gh pr view` per local space's branch, `gh search
  prs`, `gh api notifications?participating=true` (mentions, replies; Mark read PATCHes the thread), `hc read` when an agent becomes blocked, headless `claude -p` runs (`--json-schema`, read-only tool
  lists) for Linear, the Slack sweep, the standup and standup edits, the Claude usage endpoint with Claude Code's
  Keychain login, and Codex's newest session log. It writes shared state (`cc.github`, `cc.snippets`,
  `cc.linear`, `cc.slack`, `cc.standup`, `cc.usage`, `cc.settings`); every other mod only reads, and sends changes
  back as `cc.*.request` / `cc.*.action` / `cc.settings.update`. It owns `command-center.json` and
  `data/cc-slack`, `data/cc-standup`.
- Dialogs and panes: `cc-start`, `cc-handoff`, `cc-settings` (overlays), `cc-standup` (`pane.split {mod}`).
- `mods/cc-tasks/cc-task.mjs` (Node): `path` for agents, `hook` (Claude Code Stop hook; starts a background Haiku
  summary into `<repo>/.agents/tasks/.summary/<key>.json`). `install.mjs --hooks` adds the CLAUDE.md rule and hook.
- Herdr commands used: `layout.select`, `layout.show/hide/resize`, `space.select`, `tab.select`, `tab.new`,
  `space.new`, `pane.split`, `pane.focus`, `agent.focus`.

## Watch out

- Herdr's `fs/promises` has no `rename`, and reads only inside HOME: write state files directly, keep them under
  the app home.
- `setShared` works only inside a `cx.spawn` task (or a handler), not in a bare promise callback: it fails silently.
- Publishing shared state: spread the previous value first and the fresh fields last, or stale values win.
- Gate paid schedules on an in-memory "started" time as well as saved state, or a failed save re-runs every minute.
- The first tick must wait for saved state to load, or a reload looks like "never ran".
- `claude -p` with `--json-schema` returns the answer in `structured_output`. Ask the model for `connected: false`
  rather than parsing its error text.
- `gh search prs --review-requested=@me` includes team requests (often dozens); `user-review-requested:@me` is direct.
- `git diff --numstat` skips untracked files; list them with `git ls-files --others --exclude-standard`.
- Claude Code's `~/.claude/mcp-needs-auth-cache.json` lists connectors needing sign-in; it's a hint, not an API.
- macOS only as built: Keychain (`security`), `pbcopy`, `open`.

## Done when

- `node install.mjs` prints `ok` for all eleven `cc-*` mods and `herdr-app status` shows no errors.
- `node scripts/preview.mjs` saves `preview.png` and `docs/board.png` showing the Inbox with five items and the
  Board with six cards, Tasks showing ENG-412's goal, plan, decisions, three changed files and two commits.
- ⌘⌥2 shows the Board and ⌘⌥1 the terminals; ⌘⌥I/L/T switch the panel.
- With the connectors signed in, the Linear panel lists your issues and a Check now in the Inbox fills the Slack
  section; with them signed out, both show their Connect message.
- Settings → Save changes `~/.config/herdr-app/command-center.json`, and the status bar follows within a minute.
