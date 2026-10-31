# Changelog

## Unreleased

- **Code:** a **Code** tab on every agent: the agent's files in a tree, tabs and Monaco (the editor inside VS Code). Save (refused if the agent changed the file meanwhile, unless you overwrite), search the folder, compare with where the agent started, create, rename and delete. Open files pick up the agent's edits. Paths can't leave the agent's folder. Plugins can check changes with the `agent.files` policy.
- **Open in VS Code or Cursor:** opens the agent's folder and file in the editor installed on this computer.
- **Terminal:** a shell on this computer in your home folder, from the top bar, from any signed-in device (phone included). Several at once; they keep running when hidden.
- **Update from the app:** when a new release is out, **Update to …** appears in the top bar (checked twice a day; can be turned off), and one click installs it and restarts; running agents resume. **About → Update and restart** does the same, and so does `agentmgr update`. A clone at a release tag moves to the newest tag (dependencies installed when they changed); an npm install runs `npm install -g`. A clone on a branch or with uncommitted changes is left alone.
- **☰ menu:** the top bar's menu shows who this runs as (your Claude account and organization, and the computer's user) and holds **Settings**, **Clean up**, **Alerts**, **Remote access** and **About**.
- **A limit on open agents:** keep at most N agents open (**Settings**, or `agentmgr cleanup --max-open N`); above it, the ones idle longest are closed and resume when opened. Agents working, waiting for an answer, active in the last 5 minutes, marked Keep or in a running team are never closed for it. Off by default.
- **Drag to move:** drag an agent onto another project in the list to move it there.
- **Home:** clicking **AI Agent Manager** in the top bar goes back to the agent list with nothing open.

## 1.3.1 (2026-10-31)

- **Restart comes back:** `agentmgr restart` waits for the old daemon to exit (it closes every agent first, which takes a while with many), instead of giving up after 20 seconds and reporting success with no daemon left. `serve` started while one is shutting down waits for it instead of exiting, and `shutdown` returns once the daemon has stopped. `/api/health` says `closing` while it shuts down.
- **Pull request status is current:** checking an agent's pull requests while a check is already running (after an update, a stop or a push) waits for it and checks again, instead of returning what that earlier check read, so a pull request ready to merge could still show as needing fixes.

## 1.3.0 (2026-10-31)

- **Review changes:** each agent's changes in one screen: changed files, the diff file by file (new files included), line comments sent to the agent as one message, **Commit all**, and **Push & open PR** with `gh`. `agentmgr changes`, `comment`, `commit`, `pr`.
- **Land tab:** every agent's open pull request by what it needs: ready to merge, needs fixes, behind its base, waiting, drafts, with **Merge**, **Auto-merge**, **Update** (merge the base branch in and push, or ask the agent) and **Ask to fix**. `agentmgr land`.
- **Failing checks and requested changes go back to the agent:** once per commit, at most 3 times per pull request (`landing` in config.json).
- **Pull request status:** checks, review decision and conflicts on each agent's pull requests.
- **Triggers:** labeled GitHub issues start agents (in the repos or owners you list, once per issue), `/agent …` comments on an agent's pull request from the repo's owners, members or collaborators reach the agent, and `POST /api/hooks/agents` with a token starts agents from Jira automation, CI or scripts. No session watches, so no tokens are spent. **Assistant → Triggers…**, `agentmgr triggers`.
- **Linear:** Linear issue links are recognized like Jira's (the agent is named `ENG-42`, one agent per issue for the assistant), and the assistant can watch Linear issues assigned to you.
- **Repo memory:** agents record what they learn about a repository (`agentmgr learn`, allowed without a prompt), and every later agent there starts with it. **Repo memory** on an agent to view and tidy it, `agentmgr memory`.
- **Playbooks:** saved requests with `{{values}}` filled in at run time, run in several projects at once (one agent each), by hand or on a schedule (every hour, day, weekday or week). **Backlog → Playbooks**, **Save as playbook…** in New agents, `agentmgr playbook`.
- **Results:** **Results** in the top bar shows how agents did over a period: PRs opened and merged, merge rate, median time to a first PR and to merge, cost per merged PR, by engine and model, by source and by project. `agentmgr stats`.
- **Spend and budgets:** the same dialog shows today's cost, the last two weeks and the costliest agents. A budget per agent (an alert at 80%, the session closed at 100% until you raise it) and a daily limit that stops new agents from starting. `agentmgr spend`, `agentmgr edit --budget`.
- **Getting started:** with no agent open, a checklist shows what is set up (first agent, Slack alerts, assistant or triggers, phone access, a budget), each with the button that does it, and anything this machine is missing (from `agentmgr doctor`).
- **Refresh** no longer does nothing when a background refresh is already running; it waits and then checks pull requests.

## 1.2.1 (2026-10-30)

- **Edit an agent:** **Edit** on an agent changes its name, its request (and can tell the agent about the change), priority, permission mode and model (from its next launch). `agentmgr edit`.
- **Move an agent to another project:** **✎ Move** next to its project, the Edit dialog, or `agentmgr move <agent> <project>`. Pick any known project, a new project name, or its own repo again. Only where it is listed changes; its code stays in its own repo and branch.

## 1.2.0 (2026-10-30)

- **Assistant:** an always-on session that works on your behalf. Every few minutes it checks Jira (new assignments, comments and mentions), GitHub (review requests, failing checks on your PRs) and Slack with its own tools, and starts agents for new work, or passes the news to the agent already on it. The daemon enforces a daily cap, a cap on its running agents and one agent per Jira key; agents it starts are marked **by assistant**, and Slack alerts can announce them. **Assistant** in the top bar, or `agentmgr assistant`.
- **Project names** in the agent list are larger and bold, so they stand out from the agents under them.

## 1.1.0 (2026-10-30)

- **Teams:** give one problem to a team of agents in roles. An analyst writes the analysis and critics challenge it until they agree; an implementer builds it, a tester tests it, and a reviewer approves it or sends it back to the implementer. They hand off through files with a verdict line, which you can read in the team view. The team asks you only at the end (open a PR, keep the branch, or send it back) or when they can't agree within the round limits. **+ New agents → Team**, or `agentmgr team start`.
- **One lead session by default:** a team is one agent whose Claude Code sub-agents play the roles, so your list shows one agent instead of five. **Separate agents** (one per role, any engine) is still available: the form's "How the team runs", or `--separate`.
- **The lead decides:** it runs a whole request without asking you between steps, records its decisions in the handoff files, and stops only when the reviewer approves or it needs something only you can give. Sub-agents return their work as text and the lead saves it (Claude Code doesn't let sub-agents write report files).
- **The lead stays:** after a request is done, ask the lead for more in its terminal (or **New request** in the team view, `agentmgr team ask`), and it runs the same team flow again as the next quest. Earlier quests stay in the team view.
- **Gap rounds:** the reviewer also checks the work against the whole request and lists what isn't built yet. When good work still has gaps, the team shows them to you and asks: **Run a gap round** (`agentmgr team fix-gaps`) builds them in another round, from analysis to review. To let it run some rounds without asking: **Gap rounds without asking** in the form, `--gap-rounds`, `teams.gapRounds`. The form also sets the analysis and build round limits.
- **Clean up old agents:** close agents with no activity for a while (14 days by default) and delete ones that stayed closed long after that (14 more days), with their worktrees. Pick the strategy in **Clean up** (top bar) or `agentmgr cleanup --strategy`: close then delete automatically, close automatically and delete when you say (the default), manual, or off. Agents marked **Keep**, working agents, members of a running team, and agents with an open pull request or work found only in their worktree are left alone.
- **Only recent agents:** **Created in the last N days** above the agent list hides older agents (the open one stays). The list says how many it hides, with **Show all**. Remembered in this browser.
- **Agent counts per project:** each project in the list shows how many agents it has ("2 of 5 agents" while some are hidden), and how many are running.
- **Jira names:** an agent whose request starts with a Jira link is named after the issue (`OPS-7`), not the link.
- **Teams on a new project:** with no repository or folder, a team starts a new project: a folder with a git repository and an empty first commit, so it still gets its own branch. At the end, merge the branch into the local `main`, publish to a new private GitHub repository with a pull request, or keep the branch.

## 1.0.2 (2026-10-28)

- **Resize and expand:** drag the edge of the agent list, or the line between the brief and the terminal; double-click a line to reset it. **Expand** (Ctrl+Shift+E) fills the window with the terminal, shell or browser tab, and **Full screen** fills the screen.
- **Active agents first:** agents that did real work or got your input in the last day sort to the top, and projects with active agents come before idle ones. Idle agents are dimmed and show how long they've been idle. A restart that resumes an agent doesn't count as activity.
- **`agentmgr doctor`:** checks Node.js, Claude Code and its sign-in, git, `gh`, the data folder, the daemon's port and Chrome, and says how to fix what's missing.
- **Clearer first run:** when Claude Code (or another engine) isn't installed or isn't on the daemon's PATH, the agent says so and how to fix it, instead of `spawn claude ENOENT`. Running from a git checkout without `npm install` says to run it, instead of `Cannot find package`.
- **AI judge:** no longer reads Claude Code's status bar ("accept edits on", "shift+tab to cycle", "update available") as a question, which raised false "waiting on you" items.
- **Install as an app:** Chrome and Edge can install AI Agent Manager as an app (the install icon in the address bar), so it opens in its own window with a Dock or taskbar icon.

## 1.0.1 (2026-10-26)

- **Name:** the product is now called **AI Agent Manager**, matching the `ai-agentmanager` package. The command is still `agentmgr`.
- **About:** the version next to the title opens an About box with the release date, author, license, links and this daemon's details; **Check for updates** asks npm for the newest version. `agentmgr about` (`--check`) in a terminal.
- **Dependencies:** DOMPurify 3.4.17, body-parser 2.4.0, Mermaid 12.

## 1.0.0 (2026-10-25)

- **License:** Apache-2.0 (was MIT).
- **Remote access is off until you turn it on** (`agentmgr remote on`). Installs that had it on keep it on.
- **AI judge visibility:** the bottom of the Inbox shows today's calls with **Turn off** / **Turn on**; also `agentmgr judge [on|off]`.
- **Hub:** `agentmgr hub serve` also listens on this Mac's Tailscale address, and **Add machine** gives a join command other machines can reach (or says why they can't).
- **Linux:** a clear message when Chrome's sandbox can't start; `browserNoSandbox` to run without it.
- **Upgrades:** the state file is versioned, backed up at startup, migrated with a backup, and never overwritten by an older version.
- **Plugins:** policies that can refuse actions, audit listeners, extra API routes and engines on the daemon; sign-in methods, request policies and audit on the hub ([docs/plugins.md](docs/plugins.md)).
- **Packaging:** `npm i -g ai-agentmanager` (the command is `agentmgr`), `agentmgr --version`.
- **Installer:** the site's `install.sh` puts the program in `~/.local/share/agentmanager` and never touches `~/.agentmanager`, where your agents and workspaces live. It used to replace that folder.
- **Start at login:** `agentmgr service install` keeps `AGENTMGR_PLUGINS` and `AGENTMGR_HUB_PLUGINS`.
- **UI:** long agent names stay on one line, with the buttons below.
- **Project:** CI on macOS and Linux, SECURITY.md, CONTRIBUTING.md, code of conduct, architecture notes.

## 0.5.0 (2026-10-23)

- **AI judge:** rules decide when to look, a fast model decides what is going on: stuck agents (with a specific nudge), idle screens no rule matched, whether "done" work meets the intent, colliding changes, backlog order and splits, and which alerts interrupt you. Learns from your reactions.
- **CLI sign-in links:** `railway login`, `gh auth login --web` and similar open where the callback reaches the waiting CLI, from any device.
- **Live browser tabs:** a real Chrome on the machine, streamed into the tab, with typing, scrolling, popups as tabs, the phone keyboard, sharp frames on retina screens and one-way sound.
- **Continue terminal sessions:** import Claude Code sessions started with a plain `claude` and continue them as agents.

## 0.4.0 (2026-10-21)

- **Engines:** Codex CLI and Antigravity CLI next to Claude Code, behind one adapter.
- **Browser tabs:** open any address next to an agent's terminals, relayed over HTTPS to signed-in remote devices.
- **Human vs AI** review with a second-model critique; optional plan review before an agent implements.
- **Hub sign-in links:** open a machine's own page signed in, with a one-time ticket.

## 0.3.0 (2026-10-18)

- **Hub:** one place for agents on several machines: fleet view, control, a shared backlog that starts work where there's room, Google sign-in.

## 0.2.0 (2026-10-18)

- **Decision inbox, conflict radar, stuck detection, checkpoints and forks, races.**

## 0.1.x (2026-10-03 to 2026-10-09)

- First release: one background agent per intent, CLI, daemon and web UI, worktrees per agent, briefs, results, phone access, multiple shells and file attachments, swipe to scroll on phones.
