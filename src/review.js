// Review an agent's changes: the diff against where its branch started, line comments sent
// back to the agent as one message, and commit / push / open a pull request from the UI.
import * as git from './git.js';
import { NO_REPO } from './manager.js';
import { ghBin } from './tracker.js';

const err = (status, message) => Object.assign(new Error(message), { status });
const MAX_COMMENTS = 100;

/** "origin/main @ 1a2b3c4d5" -> { ref: 'origin/main', sha: '1a2b3c4d5' } */
export function parseBaseRef(baseRef) {
  const m = /^(.*) @ ([0-9a-f]{4,40})$/.exec(baseRef ?? '');
  return m ? { ref: m[1], sha: m[2] } : null;
}

/** The branch a pull request should target, from the ref the agent branched from. */
export function prBase(ref) {
  if (!ref || ref === 'HEAD' || /^[0-9a-f]{7,40}$/.test(ref)) return null;
  return ref.replace(/^origin\//, '');
}

/** One message for the agent with every comment, its place and the line it is about. */
export function commentsMessage(comments, note = '') {
  const lines = ['Review of your changes. Please address each comment, then say what you changed.', ''];
  comments.forEach((c, i) => {
    const where = c.file ? `${c.file}${c.line ? `:${c.line}` : ''}` : 'General';
    lines.push(`${i + 1}. ${where}${c.side === 'old' ? ' (removed line)' : ''}`);
    if (c.code) lines.push(`   > ${String(c.code).trim().slice(0, 200)}`);
    lines.push(`   ${String(c.text).trim().replace(/\n/g, '\n   ')}`);
  });
  if (note.trim()) lines.push('', note.trim());
  return lines.join('\n');
}

/** Per-file status from `git diff --name-status` plus untracked files. */
function fileStatuses(nameStatus, untracked) {
  const out = {};
  const kinds = { A: 'added', D: 'deleted', M: 'modified', T: 'modified' };
  for (const line of nameStatus.split('\n').filter(Boolean)) {
    const [code, ...paths] = line.split('\t');
    out[paths.at(-1)] = kinds[code[0]] ?? (code[0] === 'R' ? 'renamed' : 'modified');
  }
  for (const f of untracked) out[f] = 'added';
  return out;
}

function addedLines(diff, file) {
  const start = diff.indexOf(`diff --git a/${file} b/${file}\n`);
  if (start < 0) return null;
  const end = diff.indexOf('\ndiff --git ', start + 1);
  const part = diff.slice(start, end < 0 ? undefined : end);
  if (/^Binary files /m.test(part)) return null;
  return part.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
}

export class Review {
  constructor({ manager }) {
    this.manager = manager;
  }

  agentWithRepo(ref) {
    const agent = this.manager.mustGet(ref);
    if (!agent.workdir || NO_REPO.has(agent.kind)) {
      throw err(400, 'This agent has no repository to review');
    }
    return agent;
  }

  /** Where the diff starts: the merge base with the branch it came from, else the recorded commit. */
  async base(agent) {
    const b = parseBaseRef(agent.baseRef);
    const opts = { cwd: agent.workdir, timeout: 30_000 };
    if (b?.ref && b.ref !== 'HEAD') {
      const mb = await git.run('git', ['merge-base', 'HEAD', b.ref], opts).catch(() => null);
      if (mb) return { ref: b.ref, sha: mb };
    }
    if (b?.sha) return { ref: b.ref, sha: b.sha };
    // No record (imported folders): the remote default branch, if there is one.
    const r = await git.resolveBase(agent.workdir).catch(() => null);
    if (r && r.ref !== 'HEAD') {
      const mb = await git.run('git', ['merge-base', 'HEAD', r.ref], opts).catch(() => null);
      if (mb) return { ref: r.ref, sha: mb };
    }
    return null;
  }

  async get(ref) {
    const agent = this.agentWithRepo(ref);
    const dir = agent.workdir;
    if (!(await git.isGitRepo(dir))) throw err(400, 'The agent folder is not a git repository');
    const opts = { cwd: dir, timeout: 30_000 };
    const safe = (p) => p.catch(() => '');
    const base = await this.base(agent);
    const branch = await safe(git.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts));
    const from = base?.sha ?? 'HEAD';
    const [nameStatus, numstat, untrackedOut, log, status, upstream] = await Promise.all([
      safe(git.run('git', ['diff', '--name-status', from], opts)),
      safe(git.run('git', ['diff', '--numstat', from], opts)),
      safe(git.run('git', ['ls-files', '--others', '--exclude-standard'], opts)),
      base ? safe(git.run('git', ['log', '--format=%h%x09%s%x09%cI', '-n', '50', `${base.sha}..HEAD`], opts)) : '',
      safe(git.run('git', ['status', '--porcelain'], opts)),
      safe(git.run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], opts)),
    ]);
    const untracked = untrackedOut.split('\n').filter(Boolean);
    const statuses = fileStatuses(nameStatus, untracked);
    const counts = {};
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [a, d, ...p] = line.split('\t');
      counts[p.join('\t').replace(/^.*=> /, '').replace(/[{}]/g, '')] = { added: a === '-' ? null : Number(a), removed: d === '-' ? null : Number(d) };
    }
    const diff = await git.fullDiff(dir, from);
    const files = Object.entries(statuses)
      .map(([path, st]) => ({ path, status: st, ...(counts[path] ?? { added: null, removed: 0 }), untracked: untracked.includes(path) }))
      .sort((x, y) => (x.path < y.path ? -1 : 1));
    // New files git doesn't count yet: their added lines, from the diff.
    for (const f of files.filter((x) => x.untracked && x.added == null)) f.added = addedLines(diff, f.path);
    let ahead = 0;
    if (upstream) ahead = Number(await safe(git.run('git', ['rev-list', '--count', `${upstream}..HEAD`], opts))) || 0;
    const rt = this.manager.runtimes.get(agent.id);
    return {
      id: agent.id,
      name: agent.name,
      branch,
      base,
      prBase: prBase(base?.ref),
      commits: log.split('\n').filter(Boolean).map((l) => {
        const [sha, subject, at] = l.split('\t');
        return { sha, subject, at };
      }),
      files,
      uncommitted: status ? status.split('\n').length : 0,
      upstream: upstream || null,
      unpushed: upstream ? ahead : null,
      hasRemote: await git.hasRemote(dir),
      prs: Object.values(agent.prs ?? {}),
      busy: Boolean(rt?.pty && rt.busy),
      diff,
      truncated: diff.endsWith('… (diff truncated)'),
    };
  }

  /** Send the comments to the agent as one message (typed in when it is idle). */
  comment(ref, { comments = [], note = '' } = {}) {
    const agent = this.agentWithRepo(ref);
    const list = (Array.isArray(comments) ? comments : []).filter((c) => String(c?.text ?? '').trim()).slice(0, MAX_COMMENTS);
    if (!list.length && !String(note).trim()) throw err(400, 'Add a comment first');
    const text = commentsMessage(list, String(note));
    this.manager.tell(agent.id, text, { source: 'review' });
    agent.reviewsSent = [...(agent.reviewsSent ?? []), { at: new Date().toISOString(), comments: list.length }].slice(-20);
    this.manager.store.save();
    return { sent: list.length, text };
  }

  /** Commit everything in the worktree (new files included) with the person's git identity. */
  async commit(ref, { message } = {}) {
    const agent = this.agentWithRepo(ref);
    message = String(message ?? '').trim();
    if (!message) throw err(400, 'A commit message is required');
    this.manager.plugins.check('agent.commit', { agent: this.manager.auditView(agent), message });
    const opts = { cwd: agent.workdir, timeout: 60_000 };
    const status = await git.run('git', ['status', '--porcelain'], opts);
    if (!status.trim()) throw err(409, 'Nothing to commit');
    await git.run('git', ['add', '-A'], opts);
    await git.run('git', ['commit', '-m', message], opts);
    const sha = await git.run('git', ['rev-parse', '--short', 'HEAD'], opts);
    this.manager.plugins.emit('agent.commit', { agent: this.manager.auditView(agent), message, sha });
    this.manager.refresh(agent.id).catch(() => {});
    return { sha, files: status.split('\n').length };
  }

  /** Push the branch and open a pull request (or return the one already open). */
  async pr(ref, { title = '', body = '', draft = false } = {}) {
    const agent = this.agentWithRepo(ref);
    const dir = agent.workdir;
    this.manager.plugins.check('agent.pr', { agent: this.manager.auditView(agent), title: String(title), draft: Boolean(draft) });
    const opts = { cwd: dir, timeout: 120_000 };
    if (!(await git.hasRemote(dir))) throw err(409, 'The repository has no "origin" remote to push to');
    const branch = await git.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts);
    if (!branch || branch === 'HEAD') throw err(409, 'The worktree is not on a branch');
    const dirty = await git.run('git', ['status', '--porcelain'], opts);
    if (dirty.trim()) throw err(409, 'There are uncommitted changes: commit them first');
    const base = await this.base(agent);
    const target = prBase(base?.ref);
    if (target && branch === target) throw err(409, `The worktree is on ${branch} itself; a pull request needs its own branch`);
    await git.run('git', ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`], opts);
    const open = Object.values(agent.prs ?? {}).find((p) => p.state === 'OPEN');
    if (open) {
      this.manager.refresh(agent.id, { withPrs: true }).catch(() => {});
      return { url: open.url, pushed: true, existing: true };
    }
    const args = ['pr', 'create', '--head', branch];
    if (target) args.push('--base', target);
    if (String(title).trim()) args.push('--title', String(title).trim(), '--body', String(body ?? ''));
    else args.push('--fill');
    if (draft) args.push('--draft');
    let out;
    try {
      out = await git.run(ghBin(), args, opts);
    } catch (e) {
      const m = /https:\/\/\S+\/pull\/\d+/.exec(e.message);
      if (m && /already exists/i.test(e.message)) out = m[0];
      else throw err(502, `Pushed, but opening the pull request failed: ${e.message.replace(/^gh .*? failed: /, '')}`);
    }
    const url = /https:\/\/\S+\/pull\/\d+/.exec(out)?.[0];
    if (url) this.manager.addLink(agent.id, { type: 'pr', value: url });
    this.manager.plugins.emit('agent.pr', { agent: this.manager.auditView(agent), url });
    return { url: url ?? null, pushed: true, existing: false };
  }
}
