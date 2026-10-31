# Plugins

A plugin extends AI Agent Manager from a separate package, without changing its code: add policies that can refuse actions, listen to what happens (for an audit trail), serve extra API routes, add an agent engine, or (on the hub) add a sign-in method.

## Loading

**Daemon:** list modules in `~/.agentmanager/config.json`, or in `$AGENTMGR_PLUGINS` (comma separated):

```json
{ "plugins": ["@acme/agentmanager-policy", "./plugins/audit.js"] }
```

Package names are resolved from AI Agent Manager's install; paths are relative to `~/.agentmanager` (`~` works too).

**Hub:** `AGENTMGR_HUB_PLUGINS=@acme/agentmanager-sso,./plugins/hub-audit.js` (paths relative to the hub's state folder).

If a listed plugin fails to load, the daemon or hub doesn't start. A policy that is silently missing is worse than no start.

## Writing one

```js
// audit-and-policy.js
export const name = 'acme'; // routes are served under /api/ext/acme

export default function register(api) {
  // Refuse an action by returning { allow: false, reason }. Anything else allows it.
  api.policy((action, details) => {
    if (action === 'agent.create' && details.input.permissionMode === 'bypassPermissions') {
      return { allow: false, reason: 'bypassPermissions is not allowed on company machines' };
    }
    if (action === 'agent.create' && details.input.repo && !details.input.repo.includes('github.com/acme/')) {
      return { allow: false, reason: 'Only acme repositories' };
    }
  });

  // Hear what happened. Listeners never block or break the action.
  api.on((event, payload) => fs.appendFileSync('/var/log/agentmanager-audit.jsonl', JSON.stringify({ event, ...payload }) + '\n'));

  // Extra endpoints, behind the same sign-in and request checks as the rest of the API.
  api.routes((router) => router.get('/status', (req, res) => res.json({ ok: true })));
}
```

The API object also has `api.name`, `api.config` (the daemon's config) and `api.log(message)`.

Policies are synchronous so every code path can call them. Keep them fast; do slow lookups ahead of time (on load or on a timer) and check against the result.

## Daemon actions (policies)

| Action | When | `details` |
| --- | --- | --- |
| `agent.create` | Before an agent is created (UI, CLI, backlog, races, hub, imports) | `input`: kind, intent, name, repo, dir, worktree, base, permissionMode, model, project, priority, engine, imported |
| `agent.start` | Before an agent's engine is launched or resumed (including after a restart) | `agent`, `fresh` |
| `agent.message` | Before a message is typed into an agent (`tell`, inbox replies) | `agent`, `text`, `source` |
| `agent.remove` | Before an agent is deleted | `agent`, `deleteWorkspace` |
| `agent.commit` | Before Commit in the review screen commits an agent's worktree | `agent`, `message` |
| `agent.pr` | Before the review screen pushes an agent's branch and opens a pull request | `agent`, `title`, `draft` |
| `agent.merge` | Before Merge (or auto-merge) in the Land tab merges an agent's pull request | `agent`, `url`, `method`, `auto` |
| `terminal.open` | Before a live terminal is attached (browser, CLI `attach`, hub) | `agent`, `kind` (`claude` or `shell:N`); for **Open Terminal** (a shell on the machine, not tied to an agent) `agent` is null and `kind` is `machine` |
| `agent.files` | Before the studio changes a file in an agent's folder | `agent`, `op` (`write`, `create`, `rename` or `delete`), `path`, and `to` for a rename |
| `hub.action` | Before an action the hub asked for, after this machine's own `hub.allow` check | `action`, `agent` |

`agent` is a summary: id, name, kind, engine, intent, repo, workdir, branch, permissionMode, model, project, status.

## Daemon events (listeners)

`agent.created`, `agent.starting`, `agent.stopping`, `agent.message`, `agent.removed`, `agent.commit` (with `sha`), `agent.pr` (with `url`), `agent.merge`, `hub.action`, each with the same `agent` summary and an `at` timestamp.

## Engines

`api.engine(def)` adds an agent engine; `def` has the same shape as the built-in adapters in `src/engines/` (see [engines.md](engines.md)). Built-in engines can't be replaced.

## Hub

| Hook | Use |
| --- | --- |
| `api.authenticate((req) => identity \| null)` | A sign-in method next to the access token and Google, for example SSO through a proxy that sets a verified header, or your own API keys. The identity (`{ user, email?, roles? }`) is `req.user` in routes and `details.user` in policies. Browser writes still need the `x-agentmgr` header. |
| `api.policy` with `hub.request` | Before every signed-in API request: `{ method, path, auth, user }`. `auth` is `bearer` (admin token), `session` (token or Google sign-in) or `plugin`. |
| `api.policy` with `hub.terminal` | Before a browser terminal to a machine opens: `{ runner, user }`. |
| `api.on` | `hub.request` for every signed-in write. |
| `api.routes` | Served under `/api/ext/<name>` after sign-in and policies. |

## What plugins can't do

Plugins add checks and features; they can't loosen the built-in ones. A machine's own `hub.allow`, the local-only routes, the request checks in `server.js`, and remote access sign-in all apply first.
