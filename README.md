# Command Center for Herdr

A [Herdr](https://herdr.dev) app layout for running many coding agents at once, built on Herdr's own `main`: the same
spaces and agents sidebar, plus an **Inbox** of what needs you (blocked or finished agents, Slack asks, failed CI,
review requests), your **Linear** issues linked to the agents working on them, a **Tasks** summary per issue, a
**Board** of all work, a **standup** draft, and Claude Code and Codex **usage** bars.

![Command Center: terminals with the Inbox](preview.png)

![The Board, with the Tasks panel](docs/board.png)

Needs macOS (the Keychain, `pbcopy`), the Herdr app, Node, `gh` signed in, and Claude Code. Linear and Slack are
read through the claude.ai connectors, so connect those in claude.ai if you want them.

Both screenshots are made by `node scripts/preview.mjs` from made-up data (`scripts/preview/demo.json`) in a
separate Herdr window with its own home folder and herdr-core, so it never touches your spaces or logins.

## Install

```sh
node install.mjs            # copy layouts/ and mods/cc-* into ~/.config/herdr-app, then check each mod
node install.mjs --switch   # and switch the window to it (⌘⇧L cycles back)
node install.mjs --hooks    # also set up task notes (see below)
node install.mjs --uninstall
```

Edit here, then run `node install.mjs` again: Herdr reloads the mods in place. The installer only replaces folders
it installed itself (marked `.cc-managed`), and binds ⌘⌥1 and ⌘⌥2 (Terminals, Board) and ⌘⌥I, ⌘⌥L, ⌘⌥T (Inbox,
Linear, Tasks) in `keys.json`, leaving any key you already use.

## Settings

`~/.config/herdr-app/command-center.json`, edited from **Settings** in the status bar or by hand (read again each
minute). The installer writes it only when it's missing. New installs start with the paid Claude runs off:

| | Default | Cost |
|---|---|---|
| GitHub | on, every 3 min, review requests asked of you, mentions and replies | free (`gh`) |
| Linear | on, every 15 min, 07–22, Haiku | about 1¢ a run |
| Slack sweep | **off**; when on, hourly, 09–19, Sonnet | 30–45¢ a run on Sonnet |
| Standup draft | **off**; when on, 23:00 on weekdays, Sonnet | about 25¢ a run |
| Repo folders | the folders of the repos open in Herdr | |
| Usage bars | Claude Code and Codex | free |

The dialog shows what a day costs at the settings you pick. When the Linear or Slack connector isn't signed in, its
panel says how to connect it (with **Check again** and **I don't use …**) and the scheduled runs wait instead of
paying to fail; a free check of Claude Code's own "needs sign-in" list catches most of these first.

## What's in it

| Mod | Where | What it does |
|---|---|---|
| `cc-tabs` | tab bar | Herdr's tab bar, with a Terminals | Board toggle (⌘⌥1, ⌘⌥2) and Inbox · Linear · Tasks · Files · Changes buttons (⌘⌥I, ⌘⌥L, ⌘⌥T), the Inbox count and each tab's Linear issue |
| `cc-board` | center (stack with the terminals) | One card per piece of work (agent, Linear issue and PR joined by branch) in Needs you, In progress, In review and Todo; filters by the Start dialog's folders; click selects the tab and shows Tasks, Open goes to the terminal, plus Fix CI, PR, Start and Linear |
| `cc-inbox` | side panel | Blocked agents with their prompt, finished agents, Slack asks, failed CI on your branches' PRs (Fix CI starts Claude with `/fix-ci`), PRs that request your review directly, GitHub mentions and replies on your threads (Mark read clears them on GitHub), Copy link on every row that points to a PR, comment or Slack thread; the standup draft at its foot |
| Slack panel | side panel | `cc-inbox` with `props: {only: "slack"}`: the Slack asks, FYIs and today's closed ones on their own, with Check now (⌘⌥S). Shown while the Slack sweep is on |
| `cc-linear` | side panel | Your open Linear issues by state, each linked to the space and tab on its branch, with agent status and PR checks; Start on unlinked ones |
| `cc-start` | dialog | Start from issue: a new worktree on Linear's branch name, next to the repo as `<repo>-<issue id>` (or a tab), Claude in plan, auto or ask-first mode, the whole issue as its first message (description and comments, read from Linear as the dialog opens: about 10 s and half a cent), and optionally move the issue to In Progress |
| `cc-tasks` | side panel | For each tab of the shown space: goal, plan, decisions, assumptions, what's not done (from `.agents/tasks/`), plus changed files, commits and PR checks from git; a red box when the agent is waiting on you |
| `cc-handoff` | dialog | Hand a Slack ask to an agent: a new one (plan mode) or a free one in this space, optionally searching Slack first; the message is editable |
| `cc-standup` | pane | The standup draft as bullets: click to edit, × to drop, press-and-release on another bullet to move it there, ✦ or the box below to have Claude change one bullet or the whole draft; Undo (10 steps), Write now, Copy. Opened from the Inbox footer |
| `cc-usage` | sidebar foot | Claude Code and Codex plan usage: a bar per limit window with its reset time; amber from 70%, red from 90%; click to refresh |
| `cc-status` | status bar | Status bar, and the only fetcher: writes `cc.github`, `cc.snippets`, `cc.linear` and `cc.slack` to shared state |

What it runs: `git rev-parse` once per folder, `gh pr view` for each local space's feature branch every 3 minutes,
`gh search prs user-review-requested:@me` every 5, and `hc read` once when an agent becomes blocked. Remote spaces
and `main`/`master` branches are skipped.

AI review: each review-request row has **AI review**. It opens a background tab in a local space running Claude
Code's `/code-review <PR url> --comment`, which reviews the PR and posts its findings as inline review comments. It runs
in `~/.herdr/reviews` (one folder, trusted once), never in your checkouts; Claude's permission prompts still apply, and
the tab shows in the Inbox while it waits on you. Started reviews are marked on the row.

Mentions and replies: on the same schedule, `gh api notifications?participating=true` lists unread threads where you
were @-mentioned (or your team), assigned, or someone answered on a PR or issue you opened or commented on. Each row
shows who acted last and what they said (one `gh api` call per new comment or review, cached). Review requests,
merges, closes and CI notifications are left out; repos matching Settings → GitHub → Hide repos (`github.hideRepos`) are left out of every GitHub row; threads where you had the last word, and activity on merged PRs, are skipped. **Mark read**
marks the thread read on GitHub. Turn it off with Settings → GitHub → Mentions and replies. Click the GitHub time in the status bar to check now.

Linear is read through the claude.ai Linear connector: a headless `claude -p` (read-only tools, $0.50 cap) on the
schedule in settings, or when you click refresh. Moving an issue to In
Progress is a second run with Linear's update tools, only when you tick it in Start from issue. The runs work in
`~/.config/herdr-app/data/cc-claude` and keep no session.

Slack app feed (free): cc-status reads the notifications the macOS Slack app posts from the macOS notification
database every 20 seconds (`sqlite3` read-only + `plutil`), keeps them in `data/cc-slack/app.json` (macOS deletes
them once cleared) and shows them as LIVE rows in the Slack panel and Inbox, with Hand to agent and Done. It needs Full
Disk Access for Herdr.app (System Settings → Privacy & Security); terminals run under Herdr Core and don't get it.
It sees only what Slack notifies (not while Slack is focused, muted, or silenced by Focus), and notifications carry no
channel ID: the first time a channel (or DM sender) shows up, one Haiku run (about 1¢) searches Slack for the message and
takes its channel ID and permalink from the search results, matched by message timestamp; after that links for that
channel are built locally. A click opens the message in the Slack app (`slack://channel?team&id&message&thread_ts`),
and Copy link copies the https permalink. A private macOS format: if it
changes, the feed stops adding items. Toggle: Settings → Slack app feed.

Headless runs start with `MCP_CONNECTION_NONBLOCKING=false`: without it `claude -p` begins before the claude.ai
connectors connect and sees no Slack or Linear tools, so every run reports "not connected".

Slack: a headless sweep of your DMs and @-mentions since the last sweep, on the schedule in settings, or Check now
in the Inbox. Read-only Slack tools only; it never posts. It also marks earlier
asks resolved once you've replied. Done means handled; Skip means set aside; FYIs get Seen. State is
`~/.config/herdr-app/data/cc-slack/state.json`; Done, Skip, Seen, Undo and Clear in
the Inbox go through cc-status, which owns that file. Urgent or dated new asks become toasts. Hand to agent opens
Claude in plan mode in the shown space to research the answer across Slack, Linear and the code, and draft a reply.

Standup: the Inbox footer holds a draft answer to "What did you accomplish?" for the previous working day (Friday on
Monday), or for today from 18:00. Your commits in every repo under the Start dialog's folders, your PRs (`gh`), the
day's task summaries and the Slack asks you closed (marked Done, or replied to; never skipped ones, kept two weeks even
after Clear) are gathered locally; one Sonnet run (about $0.25) adds Linear and your own Slack messages and
writes it. It runs at the times in settings (before the "new day from" hour it writes the previous working day, after it
today), catches up a missed time within 12 hours if Herdr was closed or asleep, and runs on demand from Write now in the Inbox footer or `herdr-app do cc-status.standup`. Once you edit a day's draft, the
schedule leaves it alone; Write now still replaces it (Undo brings yours back). Asking Claude to change it is one
Sonnet run with no tools, a few cents.

Usage: Claude Code's numbers come from the usage endpoint `/usage` uses, with Claude Code's login read from the macOS
Keychain (read only, never refreshed or stored), every 3 minutes, backing off to 15 after failures. Codex's come from
the newest session log under `~/.codex/sessions`, so they update when Codex runs.

## Task notes

`mods/cc-tasks/cc-task.mjs` decides where a task's notes live: `<repo>/.agents/tasks/<ISSUE>.md` when the branch belongs
to a Linear issue, else `<repo>/.agents/tasks/<space>.md` with a `## <tab>` section. It adds `.agents/tasks/` to the
repo's `.git/info/exclude`. `node install.mjs --hooks` sets up the two pieces that use it (backing up both files
first; adding twice changes nothing; `--uninstall` takes them out):

- `~/.claude/CLAUDE.md`: agents in Herdr terminals run `cc-task.mjs path` and keep that file current.
- `~/.claude/settings.json` Stop hook `cc-task.mjs hook`: after a turn that edited files, in a Herdr terminal only,
  starts a background Haiku run (about 1–2¢) that rewrites `.agents/tasks/.summary/<key>.json`. It returns at once.


## Credits

Ideas and approaches from [Bettr](https://github.com/dissimulate/bettr) (usage bars read from Claude Code's usage
endpoint and Codex's session logs, and the separate-window preview script) and from slack-panel in
[sachin-philip/wizardry](https://github.com/sachin-philip/wizardry) (a headless Claude sweep for Slack asks and a
standup draft). The code here is new.

## Licence

MIT, see [LICENSE](LICENSE).
