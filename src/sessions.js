// Claude Code sessions started outside AI Agent Manager (a plain `claude` in a terminal), so they
// can be continued here. Claude Code keeps each session as ~/.claude/projects/<cwd>/<id>.jsonl;
// the start and end of each file say where it ran, its title, branch and first ask.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const encode = (p) => {
  let real = p;
  try {
    real = fs.realpathSync(p);
  } catch {}
  return real.replace(/[^a-zA-Z0-9]/g, '-');
};

/** The first and last `bytes` of a file as JSON records (partial lines dropped). */
function edges(file, size, bytes = 96 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const read = (start, len) => {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8');
    };
    const head = read(0, Math.min(size, bytes));
    const tail = size > bytes ? read(size - bytes, bytes) : '';
    const parse = (text, dropFirst) =>
      text
        .split('\n')
        .slice(dropFirst ? 1 : 0)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    return { head: parse(head, false), tail: parse(tail, true) };
  } finally {
    fs.closeSync(fd);
  }
}

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');
/** A message the person typed (not a tool result, a slash command's output or a system note). */
const typed = (r) => {
  if (r.type !== 'user' || r.isMeta || r.isSidechain) return null;
  const t = textOf(r.message?.content).trim();
  if (!t || /^<(command-|local-command|bash-|system-reminder)|^Caveat:/.test(t)) return null;
  return t;
};

/** Running `claude` processes: session IDs they named, and the folders they run in. */
export function runningClaude() {
  const ids = new Set();
  const cwds = new Set();
  let ps = '';
  try {
    ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return { ids, cwds };
  }
  const pids = [];
  for (const line of ps.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const cmd = m[2];
    // The claude CLI itself (native binary or node script), not this daemon or a one-off -p call.
    if (!/(^|\/)claude(\s|$)|@anthropic-ai\/claude-code/.test(cmd) || /\s(-p|--print)(\s|$)/.test(cmd)) continue;
    const id = cmd.match(/--(?:resume|session-id)[ =]([0-9a-f-]{36})/)?.[1];
    if (id) ids.add(id);
    else pids.push(m[1]);
  }
  if (pids.length) {
    try {
      const out = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')], { encoding: 'utf8' });
      for (const l of out.split('\n')) if (l.startsWith('n')) cwds.add(l.slice(1));
    } catch {}
  }
  return { ids, cwds };
}

/**
 * Interactive Claude Code sessions from the last `days`, newest first, leaving out `known`
 * session IDs (AI Agent Manager's own) and anything run under `excludeDir` (its one-off calls and
 * workspaces). inUse: "open" when a running claude names the session, "maybe" when one runs in
 * its folder and the session was active in the last 10 minutes.
 */
export function scanClaudeSessions({ days = 30, known = new Set(), excludeDir, limit = 400 } = {}) {
  const root = projectsDir();
  const since = Date.now() - days * 86_400_000;
  const skip = excludeDir ? encode(excludeDir) : null;
  const files = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  for (const d of dirs) {
    if (skip && d.name.startsWith(skip)) continue;
    let names = [];
    try {
      names = fs.readdirSync(path.join(root, d.name));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const id = n.slice(0, -6);
      if (known.has(id)) continue;
      const file = path.join(root, d.name, n);
      try {
        const st = fs.statSync(file);
        if (st.mtimeMs >= since) files.push({ id, file, size: st.size, mtimeMs: st.mtimeMs });
      } catch {}
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const running = runningClaude();
  const out = [];
  for (const f of files.slice(0, limit)) {
    let recs;
    try {
      recs = edges(f.file, f.size);
    } catch {
      continue;
    }
    const all = [...recs.head, ...recs.tail];
    const withCwd = all.find((r) => r.cwd);
    if (!withCwd) continue;
    // Headless runs (claude -p, the SDK) aren't conversations to continue.
    if (all.some((r) => r.entrypoint && r.entrypoint !== 'cli')) continue;
    const firstAsk = recs.head.map(typed).find(Boolean);
    if (!firstAsk) continue;
    const cwd = withCwd.cwd;
    if (excludeDir && (cwd === excludeDir || cwd.startsWith(`${excludeDir}/`))) continue;
    const last = (type, key) => [...all].reverse().find((r) => r.type === type && r[key])?.[key];
    const lastAsk = [...recs.tail, ...recs.head].reverse().map(typed).find(Boolean);
    const branch = [...all].reverse().find((r) => r.gitBranch)?.gitBranch ?? null;
    const recent = Date.now() - f.mtimeMs < 10 * 60_000;
    out.push({
      engine: 'claude',
      sessionId: f.id,
      cwd,
      exists: fs.existsSync(cwd),
      title: last('custom-title', 'customTitle') || last('agent-name', 'agentName') || last('ai-title', 'aiTitle') || last('summary', 'summary') || null,
      firstAsk: firstAsk.slice(0, 300),
      lastAsk: lastAsk && lastAsk !== firstAsk ? lastAsk.slice(0, 300) : null,
      branch: branch === 'HEAD' ? null : branch,
      lastActivity: new Date(f.mtimeMs).toISOString(),
      bytes: f.size,
      inUse: running.ids.has(f.id) ? 'open' : recent && running.cwds.has(cwd) ? 'maybe' : null,
    });
  }
  return out;
}
