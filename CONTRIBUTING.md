# Contributing

Thanks for helping. Bug reports, fixes, docs and new engines are all welcome.

## Getting set up

```sh
git clone https://github.com/jdmunta/ai-agentmanager-core.git
cd ai-agentmanager-core
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

## Sign your commits (DCO)

By contributing, you certify the [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change, or have the right to submit it under the project's license. Add a sign-off line to each commit with `git commit -s`:

```
Signed-off-by: Your Name <you@example.com>
```

## Releases (maintainers)

`main` is for development. Each release is a tag on `main`; a `release/1.0` branch is made from a tag only when a fix must ship for 1.0 after `main` has moved on.

1. Update `version` in `package.json` and `package-lock.json`, and date the release in `CHANGELOG.md`.
2. Update the version in the README's install commands (`ai-agentmanager@1.0.1`, `--branch v1.0.1`).
3. Merge to `main` with CI passing, then tag: `git tag -a v1.0.1 -m "AI Agent Manager 1.0.1" && git push origin v1.0.1`.
4. Create the GitHub Release from the changelog entry, and run `npm publish`.
