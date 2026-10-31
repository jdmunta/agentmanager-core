// Updating Agent Manager in place, then restarting so agents resume on the new version. Two kinds
// of install: a git checkout (cloned at a release tag, or `npm link`ed from one) moves to the
// newest release tag; an npm install runs `npm install -g <package>@<version>`. A checkout on a
// branch or with uncommitted changes is someone's working copy, so it is left alone.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './config.js';
import { latestRelease, newerThan } from './about.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(root, 'bin', 'agentmgr.js');
const err = (status, message) => Object.assign(new Error(message), { status });
const CHECK_EVERY_MS = 12 * 3_600_000;

const run = (cmd, args, { cwd = root, timeoutMs = 120_000 } = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 8 << 20, env: process.env }, (e, stdout, stderr) => {
      if (e) reject(Object.assign(new Error(`${cmd} ${args.join(' ')}: ${(stderr || e.message).trim().split('\n').pop()}`), { status: 500 }));
      else resolve(stdout.trim());
    });
  });

const pkg = (dir = root) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

/** The newest release tag (vX.Y.Z, no pre-releases) among `tags`, or null. */
export function newestTag(tags) {
  return (
    tags
      .map((t) => t.trim())
      .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
      .sort((a, b) => (newerThan(a.slice(1), b.slice(1)) ? -1 : newerThan(b.slice(1), a.slice(1)) ? 1 : 0))[0] ?? null
  );
}

/** How this copy was installed: 'git' (a checkout, worktrees included) or 'npm'. */
export const installKind = (dir = root) => (fs.existsSync(path.join(dir, '.git')) ? 'git' : 'npm');

/** Why a git checkout can't be moved to a release tag, or null when it can. */
export async function gitBlocker(dir = root) {
  const branch = await run('git', ['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: dir }).catch(() => '');
  if (branch) return `This copy is a git checkout on branch "${branch}" (someone's working copy); update it with git, or run a release from a checkout at a release tag`;
  const changed = await run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: dir });
  if (changed) return 'This checkout has uncommitted changes; commit or discard them first';
  return null;
}

/** What is installed, the newest release, and whether this copy can update itself to it. */
export async function checkUpdate({ dir = root, fetchTags = true } = {}) {
  const kind = installKind(dir);
  const current = pkg(dir).version;
  if (kind === 'git') {
    if (fetchTags) await run('git', ['fetch', '--tags', '--quiet', 'origin'], { cwd: dir, timeoutMs: 60_000 });
    const tag = newestTag((await run('git', ['tag', '-l', 'v*'], { cwd: dir })).split('\n'));
    const latest = tag ? tag.slice(1) : current;
    const newer = newerThan(latest, current);
    return { kind, current, latest, newer, blocker: newer ? await gitBlocker(dir) : null, checkedAt: new Date().toISOString() };
  }
  const r = await latestRelease();
  return { kind, current, latest: r.latest, newer: r.newer, blocker: null, checkedAt: new Date().toISOString() };
}

/** Put the newest release in place (no restart). Returns { from, to } or { upToDate }. */
export async function installUpdate({ dir = root, log = () => {} } = {}) {
  const info = await checkUpdate({ dir });
  if (!info.newer) return { upToDate: true, current: info.current };
  if (info.blocker) throw err(409, info.blocker);
  if (info.kind === 'git') {
    const lockBefore = await run('git', ['rev-parse', 'HEAD:package-lock.json'], { cwd: dir }).catch(() => '');
    log(`checking out v${info.latest}`);
    await run('git', ['checkout', '--quiet', '--detach', `v${info.latest}`], { cwd: dir });
    const lockAfter = await run('git', ['rev-parse', 'HEAD:package-lock.json'], { cwd: dir }).catch(() => '');
    if (lockAfter !== lockBefore || !fs.existsSync(path.join(dir, 'node_modules'))) {
      log('installing dependencies');
      await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, timeoutMs: 600_000 });
    }
  } else {
    const name = pkg(dir).name;
    log(`npm install -g ${name}@${info.latest}`);
    await run('npm', ['install', '-g', `${name}@${info.latest}`], { timeoutMs: 600_000 }).catch((e) => {
      throw err(500, `${e.message}${/EACCES|permission/i.test(e.message) ? ' (npm needs write access to its global folder)' : ''}`);
    });
  }
  return { from: info.current, to: info.latest, kind: info.kind };
}

/** Restart the daemon from a separate process, so it outlives this one (`agentmgr restart`). */
export function restartDetached() {
  const out = fs.openSync(paths.log, 'a');
  const child = spawn(process.execPath, [BIN, 'restart'], { detached: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
}

/** The daemon's side: a check twice a day (config "updates": { "check": false } turns it off). */
export class Updates {
  constructor({ config = {}, log = (m) => console.log(`[agentmgr] ${m}`), check = checkUpdate } = {}) {
    this.config = config;
    this.log = log;
    this.check = check;
    this.last = null;
    this.busy = null;
    this.schedule();
  }

  get enabled() {
    return this.config.updates?.check !== false && process.env.AGENTMGR_UPDATE_CHECK !== '0';
  }

  /** Start or stop the periodic check to match the setting. */
  schedule() {
    this.close();
    if (!this.enabled) return;
    this.first = setTimeout(() => this.refresh().catch(() => {}), 30_000);
    this.timer = setInterval(() => this.refresh().catch(() => {}), CHECK_EVERY_MS);
    this.first.unref?.();
    this.timer.unref?.();
  }

  setCheck(on) {
    this.config.updates = { ...this.config.updates, check: Boolean(on) };
    this.schedule();
    return this.config.updates;
  }

  close() {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  async refresh() {
    try {
      this.last = await this.check();
    } catch (e) {
      this.last = { ...(this.last ?? {}), error: e.message, checkedAt: new Date().toISOString() };
      throw e;
    }
    return this.last;
  }

  status() {
    return { check: this.enabled, updating: Boolean(this.busy), ...(this.last ?? {}) };
  }

  /** Install the newest release, then restart onto it. Answers before the restart begins. */
  async apply({ restart = restartDetached } = {}) {
    if (this.busy) throw err(409, 'An update is already running');
    this.busy = installUpdate({ log: (m) => this.log(`update: ${m}`) });
    try {
      const r = await this.busy;
      if (r.upToDate) return r;
      this.log(`update: ${r.from} → ${r.to} installed; restarting`);
      this.last = { ...(this.last ?? {}), current: r.to, newer: false };
      setTimeout(restart, 200);
      return { ...r, restarting: true };
    } finally {
      this.busy = null;
    }
  }
}
