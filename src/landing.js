// Landing: getting agents' pull requests merged. Failing checks and requested changes are sent
// back to the agent that owns the PR (a few times per PR at most), a branch that fell behind is
// brought up to date with the branch it targets, and ready PRs are merged with one click.
import os from 'node:os';
import * as git from './git.js';
import { NO_REPO } from './manager.js';
import { ghBin } from './tracker.js';
import { parseBaseRef } from './review.js';

export const MERGE_METHODS = ['squash', 'merge', 'rebase'];
export const LANDING_DEFAULTS = { fixChecks: true, fixReviews: true, maxFixes: 3, mergeMethod: 'squash', deleteBranch: true };
const LAND_ORDER = ['ready', 'fix', 'behind', 'waiting', 'draft'];

const err = (status, message) => Object.assign(new Error(message), { status });

/** Settings from config.json's "landing", with defaults and sane bounds. */
export function landingSettings(config = {}) {
  const c = { ...LANDING_DEFAULTS, ...config.landing };
  const n = Number(c.maxFixes);
  return {
    fixChecks: c.fixChecks !== false,
    fixReviews: c.fixReviews !== false,
    maxFixes: Number.isFinite(n) && n >= 0 ? Math.min(20, Math.floor(n)) : LANDING_DEFAULTS.maxFixes,
    mergeMethod: MERGE_METHODS.includes(c.mergeMethod) ? c.mergeMethod : LANDING_DEFAULTS.mergeMethod,
    deleteBranch: c.deleteBranch !== false,
  };
}

export function checksMessage(pr) {
  const names = pr.checks?.failed?.length ? pr.checks.failed.join(', ') : 'some checks';
  return [
    `CI is failing on your pull request ${pr.url} (${names}).`,
    `Look at the failures (\`gh pr checks ${pr.number ?? pr.url}\`, and \`gh run view <run id> --log-failed\` for the logs), fix the cause, run the relevant tests locally, then commit and push.`,
    'If a failure is unrelated to your change (a flaky test or a broken main), say so instead of changing unrelated code.',
  ].join('\n');
}

export function reviewMessage(pr) {
  return [
    `A reviewer requested changes on your pull request ${pr.url}.`,
    `Read the review and its comments (\`gh pr view ${pr.number ?? pr.url} --comments\`, and \`gh api repos/{owner}/{repo}/pulls/${pr.number ?? '<number>'}/comments\` for line comments), address each one, then commit and push and reply on the PR with what you changed.`,
  ].join('\n');
}

export function updateMessage(base) {
  return `Your branch is behind ${base}. Merge ${base} into it (git fetch, then git merge ${base}), resolve any conflicts keeping both sides' intent, run the tests, then commit and push.`;
}

export class Landing {
  constructor({ manager, store, config = {}, log = (m) => console.log(`[agentmgr] ${m}`) }) {
    this.manager = manager;
    this.store = store;
    this.config = config;
    this.log = log;
    this.onPrs = (agent) => this.react(agent).catch((e) => this.log(`landing: ${e.message}`));
    manager.on('prs', this.onPrs);
    // Running agents' PRs are refreshed by the manager; closed agents with an open PR every few minutes.
    this.timer = setInterval(() => this.refreshClosed().catch(() => {}), (config.landingRefreshMin ?? 6) * 60_000);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
    this.manager.off('prs', this.onPrs);
  }

  get settings() {
    return landingSettings(this.config);
  }

  update(patch = {}) {
    if (patch.mergeMethod !== undefined && !MERGE_METHODS.includes(patch.mergeMethod)) throw err(400, `mergeMethod must be one of ${MERGE_METHODS.join(', ')}`);
    if (patch.maxFixes !== undefined && !(Number(patch.maxFixes) >= 0)) throw err(400, 'maxFixes must be 0 or more');
    const next = landingSettings({ landing: { ...this.config.landing, ...patch } });
    this.config.landing = next;
    return next;
  }

  /** Open PRs that the agent opened or that were found on its branch (not ones it only mentioned). */
  openPrs(agent) {
    return Object.values(agent.prs ?? {}).filter((p) => p.state === 'OPEN' && p.source !== 'mentioned');
  }

  /** After a PR refresh: send failing checks and requested changes back to the agent, once per commit. */
  async react(agent) {
    const s = this.settings;
    if (!this.store.get(agent.id) || NO_REPO.has(agent.kind) || !s.maxFixes) return;
    agent.landing ??= { sent: {} };
    let sent = false;
    for (const pr of this.openPrs(agent)) {
      if (!pr.head) continue;
      const count = Object.keys(agent.landing.sent).filter((k) => k.startsWith(`${pr.url}#`)).length;
      if (count >= s.maxFixes) continue;
      const send = (kind, text) => {
        const key = `${pr.url}#${kind}@${pr.head}`;
        if (agent.landing.sent[key]) return;
        agent.landing.sent[key] = new Date().toISOString();
        this.manager.tell(agent.id, text, { source: 'landing' });
        this.log(`landing: told ${agent.name} about ${kind} on ${pr.url}`);
        sent = true;
      };
      if (s.fixChecks && pr.checks?.state === 'failed') send('checks', checksMessage(pr));
      else if (s.fixReviews && pr.review === 'CHANGES_REQUESTED') send('review', reviewMessage(pr));
    }
    if (sent) this.store.save();
  }

  async refreshClosed() {
    for (const agent of this.store.list()) {
      if (this.manager.runtimes.get(agent.id)?.pty || !agent.workdir || !this.openPrs(agent).length) continue;
      await this.manager.refresh(agent.id, { withPrs: true }).catch(() => {});
    }
  }

  /** Every agent's open pull request with where it stands, ready ones first. */
  list() {
    const rows = [];
    for (const agent of this.store.list()) {
      const view = this.manager.view(agent);
      for (const pr of view.prs.filter((p) => p.state === 'OPEN' && p.source !== 'mentioned')) {
        const fixes = Object.keys(agent.landing?.sent ?? {}).filter((k) => k.startsWith(`${pr.url}#`)).length;
        rows.push({ agent: { id: agent.id, name: agent.name, priority: view.priority, busy: view.runtime.busy, running: view.runtime.running }, pr, land: pr.land ?? 'waiting', fixes });
      }
    }
    const rank = (r) => (LAND_ORDER.includes(r.land) ? LAND_ORDER.indexOf(r.land) : LAND_ORDER.length);
    return { settings: this.settings, rows: rows.sort((a, b) => rank(a) - rank(b) || a.agent.priority - b.agent.priority) };
  }

  agentPr(ref, url) {
    const agent = this.manager.mustGet(ref);
    const open = this.openPrs(agent);
    const pr = url ? open.find((p) => p.url === url) : open[0];
    if (!pr) throw err(404, url ? 'That pull request is not open on this agent' : 'This agent has no open pull request');
    return { agent, pr };
  }

  /**
   * Bring the branch up to date with the one it targets: merge it in here when the agent is idle
   * and its worktree clean (and push), else ask the agent. A conflict is aborted and handed to the agent.
   */
  async updateBranch(ref, { via = 'auto' } = {}) {
    const agent = this.manager.mustGet(ref);
    if (!agent.workdir || NO_REPO.has(agent.kind)) throw err(400, 'This agent has no repository');
    const dir = agent.workdir;
    const opts = { cwd: dir, timeout: 120_000 };
    const b = parseBaseRef(agent.baseRef);
    const target = b?.ref && b.ref !== 'HEAD' ? b.ref : (await git.resolveBase(dir).catch(() => null))?.ref;
    if (!target || target === 'HEAD') throw err(409, "Couldn't tell which branch this one should follow");
    const ask = (why) => {
      this.manager.tell(agent.id, updateMessage(target), { source: 'landing' });
      return { asked: true, why, target };
    };
    if (via === 'agent') return ask('asked');
    const rt = this.manager.runtimes.get(agent.id);
    if (rt?.pty && rt.busy) return ask('the agent is working');
    if ((await git.run('git', ['status', '--porcelain'], opts)).trim()) return ask('it has uncommitted changes');
    if (target.startsWith('origin/')) await git.fetch(dir).catch(() => {});
    const behind = Number(await git.run('git', ['rev-list', '--count', `HEAD..${target}`], opts).catch(() => '0')) || 0;
    if (!behind) return { upToDate: true, target };
    try {
      await git.run('git', ['merge', '--no-edit', target], { ...opts, env: { GIT_MERGE_AUTOEDIT: 'no' } });
    } catch (e) {
      await git.run('git', ['merge', '--abort'], opts).catch(() => {});
      return { ...ask('the merge has conflicts'), conflict: true };
    }
    let pushed = false;
    const upstream = await git.run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], opts).catch(() => '');
    if (upstream) {
      await git.run('git', ['push'], opts);
      pushed = true;
    }
    this.manager.refresh(agent.id, { withPrs: true }).catch(() => {});
    return { merged: behind, target, pushed };
  }

  /** Ask the agent to fix what stands in the way: failing checks, requested changes, conflicts. */
  fix(ref, { url } = {}) {
    const { agent, pr } = this.agentPr(ref, url);
    const parts = [];
    if (pr.checks?.state === 'failed') parts.push(checksMessage(pr));
    if (pr.review === 'CHANGES_REQUESTED') parts.push(reviewMessage(pr));
    if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY' || pr.mergeState === 'BEHIND') {
      const b = parseBaseRef(agent.baseRef);
      parts.push(updateMessage(b?.ref && b.ref !== 'HEAD' ? b.ref : 'the base branch'));
    }
    if (!parts.length) throw err(409, 'Nothing to fix on this pull request right now');
    this.manager.tell(agent.id, parts.join('\n\n'), { source: 'landing' });
    return { sent: parts.length };
  }

  /** Merge the PR with gh (or turn on auto-merge so GitHub merges it once it may). */
  async merge(ref, { url, method, auto = false } = {}) {
    const { agent, pr } = this.agentPr(ref, url);
    const s = this.settings;
    method = method ?? s.mergeMethod;
    if (!MERGE_METHODS.includes(method)) throw err(400, `method must be one of ${MERGE_METHODS.join(', ')}`);
    this.manager.plugins.check('agent.merge', { agent: this.manager.auditView(agent), url: pr.url, method, auto: Boolean(auto) });
    const args = ['pr', 'merge', pr.url, `--${method}`];
    if (auto) args.push('--auto');
    if (s.deleteBranch && !auto) args.push('--delete-branch');
    try {
      // Outside the worktree, so gh deletes only the remote branch and leaves the worktree alone.
      await git.run(ghBin(), args, { cwd: os.tmpdir(), timeout: 120_000 });
    } catch (e) {
      throw err(502, e.message.replace(/^\S+ pr merge .*? failed: /, ''));
    }
    this.manager.plugins.emit('agent.merge', { agent: this.manager.auditView(agent), url: pr.url, method, auto: Boolean(auto) });
    this.log(`landing: ${auto ? 'auto-merge on for' : 'merged'} ${pr.url}`);
    await this.manager.refresh(agent.id, { withPrs: true }).catch(() => {});
    return { url: pr.url, merged: !auto, auto: Boolean(auto) };
  }
}
