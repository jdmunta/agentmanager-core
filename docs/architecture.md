# Architecture

Agent Manager is one long-running **daemon** per machine. It owns every agent's terminal and state. The **web UI** and the **CLI** are clients of its HTTP and WebSocket API. Optionally, daemons on several machines connect out to a **hub**.

```
 browser (UI) ──┐                       ┌── claude / codex / agy in PTYs (one per agent, plus shells)
 phone (HTTPS) ─┼── daemon (server.js) ─┼── git worktrees under ~/.agentmanager
 agentmgr CLI ──┘        │  manager.js  └── headless Chrome (live browser tabs)
                         │
                         └── hub link (outbound WebSocket) ──► hub (hub.js) ◄── other machines
```

No build step: Node ES modules on the server, plain ES modules in the browser. State is JSON files in `~/.agentmanager` (or `$AGENTMGR_HOME`).

## The daemon

| File | Role |
| --- | --- |
| `src/server.js` | Express API and WebSockets on `127.0.0.1:4717`, the optional HTTPS remote listener, and the request checks described in [SECURITY.md](../SECURITY.md). Thin: routes call the manager. |
| `src/manager.js` | The core. Creates agents (clone or worktree, branch, launch), runs their PTYs (`node-pty`), keeps scrollback, resumes sessions after restarts, and runs a periodic tick that refreshes git, PRs, transcripts, stuck and conflict checks, inbox items and the judge. Emits events the server pushes to clients. |
| `src/store.js` | `state.json`: agent records, saved atomically and versioned (`STATE_VERSION`, migrations, backups). |
| `src/config.js` | Paths, defaults and `config.json`. |
| `src/engines/` | One adapter per agent CLI (Claude Code, Codex, Antigravity): launch and resume arguments, permission modes, where transcripts live and how to read them. See [engines.md](engines.md). |
| `src/git.js` | Clones (partial), worktrees, branches, diffs, PR lookup through `gh`. |
| `src/tracker.js` | Reads transcripts: tokens, cost, PR and bug references, activity. |
| `src/brief.js` | Each agent's living brief (`BRIEF.md` outside the repo), results, explain, insights and review documents. |
| `src/inbox.js`, `src/stuck.js`, `src/conflicts.js` | The decision inbox (prompts and questions), stuck detection and the conflict radar: the rules that decide *when* to look. |
| `src/judge.js` | The AI judge: one-shot, tool-less model calls that decide *what is going on* (stuck, waiting, done, collisions, backlog order, alert triage), with a daily cap and feedback examples. Falls back to the rules. |
| `src/backlog.js`, `src/races.js` | Work orders picked up per project; several agents on one intent, compared. |
| `src/notify.js` | Slack alerts, triaged by the judge. |
| `src/preview.js`, `src/livebrowser.js` | Browser tabs: HTTPS relays for remote devices, and a headless Chrome streamed over the Chrome DevTools Protocol (frames, input, sound). |
| `src/sessions.js` | Finds Claude Code sessions started in a terminal so they can be continued as agents. |
| `src/remote.js` | Remote access: certificate, token, device sessions. |
| `src/service.js` | Start at login (launchd or systemd). |
| `src/trust.js` | Pre-accepts Claude Code's folder trust prompt for agent folders. |
| `src/plugins.js` | Plugins from a separate package: policies before actions, listeners after, extra routes, engines and hub sign-in. See [plugins.md](plugins.md). |

## The clients

| File | Role |
| --- | --- |
| `public/index.html`, `public/app.js`, `public/style.css` | The web UI: agents tree, inbox, backlog, terminals (xterm.js), briefs, browser tabs. |
| `public/transport.js` | WebSockets locally; over remote HTTPS, server-sent events plus POSTs (works through more networks). |
| `src/cli.js`, `src/client.js` | The `agentmgr` command: starts the daemon when needed and calls the same API. `attach` pipes your terminal to an agent's PTY. |

## Several machines

| File | Role |
| --- | --- |
| `src/hub.js`, `bin/agentmgr-hub.js` | The hub: sign-in, enrolled machines, the fleet view, the shared backlog, terminals relayed from machines. Runs alone in a container (`hub/Dockerfile`). |
| `src/hublink.js` | A daemon's outbound link to its hub: signed challenge per connection, policy checks on every request, audit log. |
| `src/hubactions.js` | The fixed list of actions a hub may ask for, and the permission each needs. |
| `src/fleet.js` | The whitelisted view of agents a machine shares. |
| `src/hubbacklog.js` | Placing shared backlog items on machines with room. |

Design notes: [distributed.md](distributed.md) (hub) and [engines.md](engines.md) (engines).

## Lifecycle of an agent

1. **Create** (`POST /api/agents`): the manager makes a record, prepares the workspace (clone or worktree and branch, or a folder), and pre-trusts the folder.
2. **Launch**: the engine adapter builds the command with a session ID chosen up front; the PTY starts in the workspace. Instructions about the brief and questions are passed with the first prompt.
3. **Track**: the tick reads git, the transcript and the screen; the brief, inbox, stuck, conflicts and the judge update the record; clients get events.
4. **Close and resume**: closing keeps the session ID; starting again resumes it. On daemon shutdown, scrollback and state are flushed, and running agents come back on the next start.

## Tests

`test/e2e.test.js` starts a real daemon on a temporary home and port, with fake engines that print what the real CLIs print. `test/unit.test.js` covers parsers and pure functions. CI runs both on macOS and Linux, Node 20 and 22.
