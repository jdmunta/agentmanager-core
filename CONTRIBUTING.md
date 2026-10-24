# Contributing

Thanks for helping. Bug reports, fixes, docs and new engines are all welcome.

## Getting set up

```sh
git clone https://github.com/jdmunta/agentmanager-core.git
cd agentmanager-core
npm install
npm test
```

You need Node 20+ and `git`. The tests don't need Claude, Codex or a network account: they run fake engines (`test/fake-claude.js`, `test/fake-codex.js`, `test/fake-agy.js`). The live browser test runs when Chrome or Chromium is installed and skips otherwise. On Linux where Chrome's sandbox can't start (containers, Ubuntu 23.10+), run `AGENTMGR_TEST_NO_SANDBOX=1 npm test`.

**Never point a test or experiment at your real daemon.** The tests make their own `AGENTMGR_HOME` and port. When you try a change by hand, do the same:

```sh
AGENTMGR_HOME=/tmp/agentmgr-dev AGENTMGR_PORT=4795 node bin/agentmgr.js serve
```

Don't run `agentmgr restart` or `shutdown` against your everyday daemon while testing; it closes your agents' sessions (they resume, but it interrupts them).

## How the code is organised

See [docs/architecture.md](docs/architecture.md). In short: one daemon (`src/server.js` + `src/manager.js`) owns the agents' terminals and state; the web UI (`public/`) and the CLI (`src/cli.js`) are clients of its HTTP API. No build step: plain ES modules in Node and in the browser.

## Making a change

- **Keep it small.** One change per pull request, with a test. `test/e2e.test.js` drives the real daemon over HTTP; `test/unit.test.js` covers pure functions.
- **Match the surrounding code.** Two-space indent, single quotes, semicolons, short comments that say *why*. No new runtime dependencies without discussing it first: the install has to stay quick and native builds rare.
- **User-facing text** (UI, CLI, README) is plain and short: say what happens, not how clever it is.
- **Security-sensitive areas** (`server.js` request checks, `remote.js`, `hub*.js`, `preview.js` relays, `livebrowser.js`) get extra review. Read [SECURITY.md](SECURITY.md) first, and keep the defaults closed.
- **State files** in `~/.agentmanager` must keep working across upgrades. If you change the shape of saved agent records, bump `STATE_VERSION` in `src/store.js` and add a migration.
- **Docs.** Update the README section for any behaviour you change, and add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).

## Adding an engine

Engines live in `src/engines/`. Each one says how to launch and resume the CLI, where its sessions are stored and how to read them. [docs/engines.md](docs/engines.md) describes the adapter; `codex.js` and `antigravity.js` are full examples with recorded fixtures in `test/fixtures/`.

## Reporting bugs and ideas

Open an issue with the template. For security problems, use GitHub's private reporting instead (see [SECURITY.md](SECURITY.md)).

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
