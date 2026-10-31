// The studio: browse and edit an agent's files from the app (a file tree and an editor), search
// them, compare a file with where the agent started, and open the folder in VS Code or Cursor.
// Every path is resolved inside the agent's folder; links that point outside it are refused.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as git from './git.js';
import { NO_REPO } from './manager.js';

const err = (status, message) => Object.assign(new Error(message), { status });
export const MAX_FILE_BYTES = 2_000_000;
// Listed but not opened by default: noisy, huge or generated.
export const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv', 'dist', 'build', '.next', 'target', 'coverage']);
const EDITORS = {
  vscode: { label: 'VS Code', bins: ['code', '/usr/local/bin/code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'] },
  cursor: { label: 'Cursor', bins: ['cursor', '/usr/local/bin/cursor', '/Applications/Cursor.app/Contents/Resources/app/bin/cursor'] },
};

/**
 * `rel` inside `root`, as an absolute path, or an error. Refuses "..", absolute paths and
 * symlinks that resolve outside the folder (checked on the nearest part that exists).
 */
export function resolveInside(root, rel = '') {
  const realRoot = fs.realpathSync(root);
  const clean = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.split('/').includes('..')) throw err(400, 'Paths may not contain ".."');
  const abs = path.join(realRoot, clean);
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== realRoot) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw err(403, 'That path is outside the agent folder');
  return abs;
}

const statOf = (abs, rel) => {
  try {
    return fs.statSync(abs);
  } catch {
    throw err(404, `${rel || 'That path'} doesn't exist`);
  }
};

/** True when the bytes look like text (no NUL in the first 8 KB). */
export const isText = (buf) => !buf.subarray(0, 8192).includes(0);

/** A language id for the editor from a file name. */
export function languageOf(name) {
  const ext = path.extname(name).toLowerCase().slice(1);
  const base = path.basename(name).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const map = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp',
    cs: 'csharp', php: 'php', sh: 'shell', bash: 'shell', zsh: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', html: 'html', css: 'css',
    scss: 'scss', less: 'less', sql: 'sql', xml: 'xml', svg: 'xml', vue: 'html', graphql: 'graphql', lua: 'lua', r: 'r', scala: 'scala', dart: 'dart',
  };
  return map[ext] ?? 'plaintext';
}

const which = (bin) => new Promise((resolve) => (bin.startsWith('/') ? resolve(fs.existsSync(bin) ? bin : null) : execFile('/usr/bin/env', ['which', bin], (e, out) => resolve(e ? null : out.trim() || null))));

export class Studio {
  constructor({ manager, review }) {
    this.manager = manager;
    this.review = review;
  }

  agentDir(ref) {
    const agent = this.manager.mustGet(ref);
    if (NO_REPO.has(agent.kind) && !agent.workdir) throw err(400, 'This session has no folder');
    if (!agent.workdir || !fs.existsSync(agent.workdir)) throw err(409, 'The agent folder is not ready yet');
    return { agent, root: agent.workdir };
  }

  check(agent, action, details = {}) {
    this.manager.plugins.check(action, { agent: this.manager.auditView(agent), ...details });
  }

  /** One folder's entries: folders first, then files, by name. */
  list(ref, dir = '') {
    const { root } = this.agentDir(ref);
    const abs = resolveInside(root, dir);
    if (!statOf(abs, dir).isDirectory()) throw err(400, 'Not a folder');
    const entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .map((d) => {
        const rel = path.posix.join(String(dir).replace(/^\/+|\/+$/g, ''), d.name);
        let type = d.isDirectory() ? 'dir' : 'file';
        let size = null;
        if (d.isSymbolicLink()) {
          try {
            const st = fs.statSync(resolveInside(root, rel));
            type = st.isDirectory() ? 'dir' : 'file';
            size = st.isFile() ? st.size : null;
          } catch {
            type = 'link';
          }
        } else if (type === 'file') {
          try {
            size = fs.statSync(path.join(abs, d.name)).size;
          } catch {}
        }
        return { name: d.name, path: rel, type, size, hidden: HIDDEN.has(d.name) };
      })
      .sort((a, b) => (a.type === 'dir') - (b.type === 'dir') ? (b.type === 'dir') - (a.type === 'dir') : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return { root, dir: String(dir).replace(/^\/+|\/+$/g, ''), entries };
  }

  read(ref, rel) {
    const { root } = this.agentDir(ref);
    const abs = resolveInside(root, rel);
    const st = statOf(abs, rel);
    if (!st.isFile()) throw err(400, 'Not a file');
    const base = { path: rel, size: st.size, mtimeMs: st.mtimeMs, language: languageOf(rel) };
    if (st.size > MAX_FILE_BYTES) return { ...base, tooLarge: true, max: MAX_FILE_BYTES };
    const buf = fs.readFileSync(abs);
    if (!isText(buf)) return { ...base, binary: true };
    return { ...base, content: buf.toString('utf8') };
  }

  /** Save a file. With `mtimeMs` (from when it was opened), refuses if it changed since. */
  write(ref, rel, content, { mtimeMs = null, force = false } = {}) {
    const { agent, root } = this.agentDir(ref);
    if (typeof content !== 'string') throw err(400, 'content (string) is required');
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw err(413, `Files over ${MAX_FILE_BYTES / 1e6} MB can't be saved from the editor`);
    const abs = resolveInside(root, rel);
    this.check(agent, 'agent.files', { op: 'write', path: rel });
    if (fs.existsSync(abs)) {
      const st = fs.statSync(abs);
      if (!st.isFile()) throw err(400, 'Not a file');
      if (mtimeMs != null && !force && Math.abs(st.mtimeMs - Number(mtimeMs)) > 1) {
        throw Object.assign(err(409, 'The file changed on disk since you opened it (the agent may have edited it)'), { conflict: true });
      }
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    const st = fs.statSync(abs);
    return { path: rel, size: st.size, mtimeMs: st.mtimeMs };
  }

  create(ref, rel, type = 'file') {
    const { agent, root } = this.agentDir(ref);
    if (!String(rel ?? '').trim()) throw err(400, 'A name is required');
    const abs = resolveInside(root, rel);
    if (fs.existsSync(abs)) throw err(409, `${rel} already exists`);
    this.check(agent, 'agent.files', { op: 'create', path: rel });
    if (type === 'dir') fs.mkdirSync(abs, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '');
    }
    return { path: rel, type };
  }

  rename(ref, from, to) {
    const { agent, root } = this.agentDir(ref);
    const a = resolveInside(root, from);
    const b = resolveInside(root, to);
    if (!fs.existsSync(a)) throw err(404, `${from} doesn't exist`);
    if (fs.existsSync(b)) throw err(409, `${to} already exists`);
    if (a === fs.realpathSync(root)) throw err(400, "The agent folder itself can't be renamed");
    this.check(agent, 'agent.files', { op: 'rename', path: from, to });
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
    return { from, to };
  }

  remove(ref, rel) {
    const { agent, root } = this.agentDir(ref);
    const abs = resolveInside(root, rel);
    if (abs === fs.realpathSync(root) || !String(rel ?? '').trim()) throw err(400, "The agent folder itself can't be deleted here");
    if (!fs.existsSync(abs)) throw err(404, `${rel} doesn't exist`);
    this.check(agent, 'agent.files', { op: 'delete', path: rel });
    fs.rmSync(abs, { recursive: true, force: true });
    return { path: rel, deleted: true };
  }

  /** Text search: git grep in a repository (ignored files skipped), else a bounded walk. */
  async search(ref, q, { max = 200 } = {}) {
    const { root } = this.agentDir(ref);
    const term = String(q ?? '');
    if (term.trim().length < 2) throw err(400, 'Search for at least 2 characters');
    const hits = [];
    if (await git.isGitRepo(root)) {
      const out = await git
        .run('git', ['grep', '-n', '-I', '--untracked', '--fixed-strings', '-i', '--full-name', '-e', term], { cwd: root, timeout: 20_000 })
        .catch((e) => (e.code === 1 ? '' : Promise.reject(e)));
      for (const line of out.split('\n')) {
        const m = line.match(/^(.*?):(\d+):(.*)$/);
        if (m) hits.push({ path: m[1], line: Number(m[2]), text: m[3].slice(0, 300) });
        if (hits.length >= max) break;
      }
      return { q: term, hits, truncated: hits.length >= max };
    }
    const lower = term.toLowerCase();
    const walk = (dir) => {
      for (const d of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        if (hits.length >= max) return;
        if (HIDDEN.has(d.name)) continue;
        const rel = path.posix.join(dir, d.name);
        if (d.isDirectory()) walk(rel);
        else if (d.isFile()) {
          const buf = fs.readFileSync(path.join(root, rel));
          if (buf.length > MAX_FILE_BYTES || !isText(buf)) continue;
          buf.toString('utf8').split('\n').forEach((text, i) => {
            if (hits.length < max && text.toLowerCase().includes(lower)) hits.push({ path: rel, line: i + 1, text: text.slice(0, 300) });
          });
        }
      }
    };
    walk('');
    return { q: term, hits, truncated: hits.length >= max };
  }

  /** The file as it was where the agent started (its base), for a side-by-side diff. */
  async original(ref, rel) {
    const { agent, root } = this.agentDir(ref);
    resolveInside(root, rel);
    if (!(await git.isGitRepo(root))) return { path: rel, content: null, why: 'Not a git repository' };
    const base = await this.review.base(agent).catch(() => null);
    const at = base?.sha ?? 'HEAD';
    const prefix = (await git.run('git', ['rev-parse', '--show-prefix'], { cwd: root }).catch(() => '')).trim();
    const content = await git.run('git', ['show', `${at}:${prefix}${rel}`], { cwd: root, timeout: 10_000, trim: false }).catch(() => null);
    return { path: rel, content, base: base?.ref ?? 'HEAD', new: content === null };
  }

  /** Editors on this machine that can open the folder. */
  async editors() {
    const found = [];
    for (const [id, e] of Object.entries(EDITORS)) {
      for (const bin of e.bins) {
        const at = await which(bin);
        if (at) {
          found.push({ id, label: e.label, bin: at });
          break;
        }
      }
    }
    return found;
  }

  /** Open the agent's folder (and a file in it) in VS Code or Cursor on this machine. */
  async openIn(ref, editor = 'vscode', rel = null) {
    const { root } = this.agentDir(ref);
    const e = (await this.editors()).find((x) => x.id === editor);
    if (!e) throw err(404, `${EDITORS[editor]?.label ?? editor} isn't installed (its "${editor === 'cursor' ? 'cursor' : 'code'}" command wasn't found)`);
    const args = [root];
    if (rel) args.push('--goto', resolveInside(root, rel));
    const child = spawn(e.bin, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return { ok: true, editor: e.label, folder: root };
  }
}
