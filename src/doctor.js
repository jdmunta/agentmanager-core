// `agentmgr doctor`: checks what AI Agent Manager needs on this machine and says how to fix
// what's missing. Each check is { name, status: 'ok' | 'warn' | 'fail' | 'info', detail, fix }.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { HOST, PORT, loadConfig, paths } from './config.js';
import { api, BASE, isRunning } from './client.js';
import { ENGINES, installed, notInstalled } from './engines/index.js';
import { findBrowser } from './livebrowser.js';

const run = (bin, args, timeout = 8000) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim(), err }));
  });

const firstLine = (s) => s.split('\n')[0].trim();

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, HOST, () => srv.close(() => resolve(true)));
  });
}

/** Whether Claude Code has credentials, without reading them: an API key, or a signed-in account. */
function claudeSignedIn() {
  if (process.env.ANTHROPIC_API_KEY) return 'an API key (ANTHROPIC_API_KEY)';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    if (cfg.oauthAccount) return 'a Claude account';
  } catch {}
  return null;
}

async function ptyWorks() {
  try {
    const pty = (await import('node-pty')).default;
    return await new Promise((resolve) => {
      const p = pty.spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/c', 'exit 0'] : ['-c', 'exit 0'], {});
      const t = setTimeout(() => resolve('started but did not finish'), 5000);
      p.onExit(() => {
        clearTimeout(t);
        resolve(null);
      });
    });
  } catch (err) {
    return err.message;
  }
}

export async function doctor() {
  const config = loadConfig();
  const checks = [];
  const add = (name, status, detail, fix) => checks.push({ name, status, detail, ...(fix ? { fix } : {}) });

  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js', major >= 20 ? 'ok' : 'fail', `${process.versions.node}`, major >= 20 ? null : 'Install Node.js 20 or newer (https://nodejs.org)');

  const ptyErr = await ptyWorks();
  add('Terminals (node-pty)', ptyErr ? 'fail' : 'ok', ptyErr ? `can't start a terminal: ${ptyErr}` : 'can start terminals',
    ptyErr ? 'Reinstall: npm install -g ai-agentmanager (or npm rebuild node-pty in a git checkout)' : null);

  // The daemon's view wins: a login service may have a different PATH than this shell.
  const running = await isRunning();
  const daemonEngines = running ? await api('GET', '/engines').catch(() => null) : null;
  for (const engine of Object.values(ENGINES)) {
    const has = daemonEngines ? daemonEngines.find((e) => e.id === engine.id)?.installed : installed(engine, config);
    const main = engine.id === (config.engine ?? 'claude');
    if (!has) {
      add(engine.label, main ? 'fail' : 'info', main ? 'not found' : 'not installed (optional)', main ? notInstalled(engine, config) : null);
      continue;
    }
    const v = await run(engine.bin(config), ['--version']);
    add(engine.label, 'ok', v.ok ? firstLine(v.out) : 'installed');
  }

  const signedIn = claudeSignedIn();
  add('Claude sign-in', signedIn ? 'ok' : 'warn', signedIn ? `uses ${signedIn}` : "couldn't tell whether Claude Code is signed in",
    signedIn ? null : 'Run `claude` in a terminal once and sign in');

  const git = await run('git', ['--version']);
  add('git', git.ok ? 'ok' : 'fail', git.ok ? firstLine(git.out) : 'not found', git.ok ? null : 'Install git (agents work in git worktrees)');

  const gh = await run('gh', ['auth', 'status']);
  if (gh.err?.code === 'ENOENT') add('GitHub CLI (gh)', 'warn', 'not installed: PRs and checks are not tracked', 'Install it (https://cli.github.com) and run `gh auth login`');
  else add('GitHub CLI (gh)', gh.ok ? 'ok' : 'warn', gh.ok ? 'signed in' : 'not signed in: PRs and checks are not tracked', gh.ok ? null : 'Run `gh auth login`');

  try {
    fs.mkdirSync(paths.home, { recursive: true });
    fs.accessSync(paths.home, fs.constants.W_OK);
    add('Data folder', 'ok', paths.home);
  } catch (err) {
    add('Data folder', 'fail', `${paths.home}: ${err.message}`, 'Make it writable, or point AGENTMGR_HOME at another folder');
  }

  if (running) {
    const a = await api('GET', '/about').catch(() => null);
    add('Daemon', 'ok', `running at ${BASE}${a ? ` (version ${a.version}, pid ${a.daemon.pid})` : ''}`);
  } else if (await portFree(PORT)) {
    add('Daemon', 'info', `not running; port ${PORT} is free`, 'Start it with `agentmgr ui`');
  } else {
    add('Daemon', 'fail', `port ${PORT} is used by another program`, 'Stop that program, or set AGENTMGR_PORT to another port');
  }

  const chrome = findBrowser(config);
  add('Chrome (live browser tabs)', chrome ? 'ok' : 'warn', chrome ?? 'not found: live browser tabs are unavailable (Lite mode still works)',
    chrome ? null : 'Install Chrome, Chromium, Brave or Edge, or set "browserBin" in config.json');

  return checks;
}
