# Security

## Reporting a vulnerability

Please report security issues privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue. You'll get a reply within a few days, and a fix or a plan before anything is disclosed.

## What AI Agent Manager is, from a security point of view

AI Agent Manager runs coding agents (Claude Code, Codex, Antigravity) **as your user, on your machine**, in real terminals. Anyone who can drive AI Agent Manager can run commands as you. The design goal is that only you can drive it, from this machine, unless you deliberately open it up.

### Trust boundaries

| Part | Who can reach it by default | How it is protected |
| --- | --- | --- |
| Daemon and web UI (`127.0.0.1:4717`) | Processes on this machine | Listens on loopback only. The `Host` header must be loopback (blocks DNS rebinding), a browser `Origin` must be the UI itself (blocks cross-site requests and WebSockets), and every write needs the `x-agentmgr` header, which a web page on another site can't send without a CORS preflight that is never granted. |
| Remote access (`https://<ip>:4718`) | Nobody: **off until you run `agentmgr remote on`** | HTTPS with a certificate made on this machine. Every API call needs a signed-in device session (sign-in with the access token or its QR code; sessions last 30 days, can be revoked one by one, and rotating the token signs everyone out). Only this machine's own addresses are accepted as `Host`. Turning remote access on or off, the token, devices and shutdown are local-only. |
| Hub (`agentmgr hub serve`, port 4720) | This machine and its Tailscale address | One admin token (or Google sign-in limited to listed emails); browsers get a 30-day session cookie. Plain `http://` is accepted only on loopback or Tailscale, which encrypts traffic; anything else must be `https://`. |
| A machine joined to a hub | The hub, over a connection the machine opens | Ed25519 key per machine (private key in `~/.agentmanager/hub-link.json`, mode 600); each connection signs a fresh challenge. The machine decides what the hub may do (`hub.allow`, default `view` only), checks every request itself, matches agents by exact ID, runs only a fixed list of actions (never deletes) and logs each request and refusal to `~/.agentmanager/hub-audit.log`. |
| Site relays (browser tabs from another device) | Signed-in remote devices | Never relay to AI Agent Manager's own ports; its sign-in cookie is stripped before forwarding; sites other than localhost must present a valid certificate; relays close when remote access is turned off. |
| CLI sign-in callbacks | The UI | Delivered only to the loopback port the sign-in link itself named. |

### What is stored, and where

Everything lives in `~/.agentmanager/` (or `$AGENTMGR_HOME`):

- `remote/state.json`: remote access token and device sessions (mode 600).
- `hub-link.json`: this machine's hub key (mode 600). `hub/state.json` on the hub: its token and joined machines' public keys (mode 600).
- `notify.json`: the Slack webhook or bot token, if you set one (mode 600).
- `config.json`: your settings. Keep the whole folder private to your user.
- `browser-profile/`: the live browser's Chrome profile. Sites you sign in to there stay signed in, as in any browser.
- `scrollback/`, `briefs/`, `state.json`: terminal output and agent state. These can contain anything an agent printed, including secrets it read.

AI Agent Manager sends **no telemetry**. It talks to the network only for what you set up: git remotes, GitHub (`gh`), Slack, a hub you joined, and the agents' own model providers. **Check for updates** in the About box (or `agentmgr about --check`) asks the npm registry for the newest version, only when you click it.

### Things to be aware of

- **Agents act as you.** Each agent's permission mode (for Claude: `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`) is passed to the engine; AI Agent Manager doesn't sandbox agents beyond that. Run agents in folders and with modes you'd be comfortable running the engine in by hand.
- **Other processes running as your user** can call the local API, just as they could run `claude` themselves. AI Agent Manager doesn't defend against malware already running as you.
- **The AI judge** sends short summaries of an agent's screen, activity and brief to the same engine the agents use (by default Claude `haiku`), as separate calls. Turn it off with `agentmgr judge off`.
- **Remote access on an untrusted network** (café Wi-Fi) exposes the sign-in page on your local network. Leave it off there, or use Tailscale and the hub instead.

## Supported versions

Security fixes go into the latest release.
