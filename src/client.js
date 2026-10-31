import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHome, HOST, paths, PORT } from './config.js';

export const BASE = `http://${HOST}:${PORT}`;
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agentmgr.js');

export async function api(method, route, body) {
  const res = await fetch(`${BASE}/api${route}`, {
    method,
    // From inside an agent's session, say which agent is asking (the assistant's limits use it).
    headers: { 'content-type': 'application/json', 'x-agentmgr': '1', ...(process.env.AGENTMGR_AGENT_ID ? { 'x-agentmgr-agent': process.env.AGENTMGR_AGENT_ID } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${route} failed with HTTP ${res.status}`);
  return data;
}

/** The daemon's /health answer ({ ok, pid, closing, … }), or null when nothing answers. */
export async function health() {
  try {
    return await api('GET', '/health');
  } catch {
    return null;
  }
}

/** A daemon that answers and isn't shutting down. */
export async function isRunning() {
  const h = await health();
  return Boolean(h && !h.closing);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/**
 * Wait for a daemon process to exit. Shutting down closes every agent first (to save their
 * sessions), which takes a while with many agents, and it answers /health until then.
 * Returns true once it is gone, false after `timeoutMs`.
 */
export async function waitForExit(pid, { timeoutMs = 300_000, onWait = null } = {}) {
  if (!pid) return true;
  const start = Date.now();
  let told = 0;
  while (alive(pid)) {
    if (Date.now() - start > timeoutMs) return false;
    if (onWait && Date.now() - told > 10_000) {
      told = Date.now();
      onWait(Math.round((Date.now() - start) / 1000));
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return true;
}

/** Start the daemon in the background if it is not already listening (waiting out one that is shutting down). */
export async function ensureDaemon({ quiet = false } = {}) {
  const h = await health();
  if (h && !h.closing) return false;
  if (h?.closing) {
    if (!quiet) process.stderr.write(`agentmgr: waiting for the daemon (pid ${h.pid}) to finish shutting down…\n`);
    if (!(await waitForExit(h.pid))) throw new Error(`The daemon (pid ${h.pid}) is still shutting down; try again in a minute`);
  }
  ensureHome();
  const log = fs.openSync(paths.log, 'a');
  const child = spawn(process.execPath, [BIN, 'serve'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isRunning()) {
      if (!quiet) process.stderr.write(`agentmgr: started daemon at ${BASE} (log: ${paths.log})\n`);
      return true;
    }
  }
  throw new Error(`Daemon did not start; see ${paths.log}`);
}
