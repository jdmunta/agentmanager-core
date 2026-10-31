// Triggers: start agents and pass on instructions from where the work lives, with no model
// watching (no tokens spent). Three sources:
// - GitHub label: open issues with a label (default "agentmgr") in the repos or owners you list
//   each get an agent in that repo. Labeling needs triage access, so it is the go-ahead.
// - "/agent" comments on an agent's own pull request, by the repo's owners, members or
//   collaborators, are typed into that agent.
// - Webhook: POST /api/hooks/agents with the secret token creates an agent (Jira automation,
//   CI, scripts). Off until a token is set; reachable from other machines only with remote access.
import crypto from 'node:crypto';
import { run } from './git.js';
import { ghBin } from './tracker.js';

export const TRIGGER_DEFAULTS = {
  github: { enabled: false, label: 'agentmgr', repos: [], owners: [], everyMin: 5, comment: false },
  prCommands: { enabled: true, prefix: '/agent' },
  webhook: { enabled: false, token: null, repos: [] },
  maxPerDay: 20,
};
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

const err = (status, message) => Object.assign(new Error(message), { status });
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);

/** Settings from config.json's "triggers", with defaults; the webhook token is never returned by `view`. */
export function triggerSettings(config = {}) {
  const t = config.triggers ?? {};
  const gh = { ...TRIGGER_DEFAULTS.github, ...t.github };
  const pc = { ...TRIGGER_DEFAULTS.prCommands, ...t.prCommands };
  const wh = { ...TRIGGER_DEFAULTS.webhook, ...t.webhook };
  const every = Number(gh.everyMin);
  const max = Number(t.maxPerDay ?? TRIGGER_DEFAULTS.maxPerDay);
  return {
    github: {
      enabled: Boolean(gh.enabled),
      label: String(gh.label || 'agentmgr').trim(),
      repos: list(gh.repos).filter((r) => REPO_RE.test(r)),
      owners: list(gh.owners).filter((o) => /^[\w.-]+$/.test(o)),
      everyMin: Number.isFinite(every) && every >= 1 ? Math.min(1440, Math.floor(every)) : 5,
      comment: Boolean(gh.comment),
    },
    prCommands: { enabled: pc.enabled !== false, prefix: String(pc.prefix || '/agent').trim() },
    webhook: { enabled: Boolean(wh.enabled && wh.token), token: wh.token || null, repos: list(wh.repos) },
    maxPerDay: Number.isFinite(max) && max >= 0 ? Math.min(500, Math.floor(max)) : TRIGGER_DEFAULTS.maxPerDay,
  };
}

/** The request for an agent started from a GitHub issue. */
export function issueIntent(issue) {
  const body = String(issue.body ?? '').trim();
  return `${issue.url}\n\n${issue.title}${body ? `\n\n${body.slice(0, 6000)}` : ''}\n\nWhen you are done, open a pull request that says "Fixes #${issue.number}".`;
}

/** A PR comment for the agent, or null when it isn't a command from someone trusted. */
export function prCommand(comment, prefix = '/agent') {
  const body = String(comment?.body ?? '').trim();
  if (!body.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  if (!TRUSTED.has(comment.authorAssociation)) return null;
  const text = body.slice(prefix.length).trim();
  return text || null;
}

/** Same length and same bytes, without leaking where they differ. */
export function tokenMatches(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class Triggers {
  constructor({ manager, store, config = {}, notifier = null, log = (m) => console.log(`[agentmgr] ${m}`) }) {
    this.manager = manager;
    this.store = store;
    this.config = config;
    this.notifier = notifier;
    this.log = log;
    store.data.triggers ??= { issues: {}, comments: {}, started: [], lastPoll: null, lastError: null };
    this.schedule();
  }

  get state() {
    return this.store.data.triggers;
  }

  get settings() {
    return triggerSettings(this.config);
  }

  schedule() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.poll().catch((e) => this.fail(e)), this.settings.github.everyMin * 60_000);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
  }

  fail(e) {
    this.state.lastError = { at: new Date().toISOString(), message: e.message.split('\n')[0].slice(0, 300) };
    this.log(`triggers: ${this.state.lastError.message}`);
  }

  /** Settings for the UI: the token is replaced by whether one is set. */
  view() {
    const s = this.settings;
    const today = this.startedToday();
    return {
      ...s,
      webhook: { enabled: s.webhook.enabled, hasToken: Boolean(s.webhook.token), repos: s.webhook.repos },
      startedToday: today.length,
      recent: this.state.started.slice(-20).reverse(),
      lastPoll: this.state.lastPoll,
      lastError: this.state.lastError,
    };
  }

  update(patch = {}) {
    const cur = this.config.triggers ?? {};
    const next = {
      github: { ...cur.github, ...patch.github },
      prCommands: { ...cur.prCommands, ...patch.prCommands },
      webhook: { ...cur.webhook, ...patch.webhook },
      maxPerDay: patch.maxPerDay ?? cur.maxPerDay,
    };
    if (patch.webhook?.newToken) {
      next.webhook.token = crypto.randomBytes(24).toString('base64url');
      delete next.webhook.newToken;
    }
    if (next.github.enabled && !list(next.github.repos).length && !list(next.github.owners).length) {
      throw err(400, 'List the repos (owner/name) or owners to watch, so issues elsewhere on GitHub never start agents');
    }
    const s = triggerSettings({ triggers: next });
    this.config.triggers = { github: s.github, prCommands: s.prCommands, webhook: { enabled: s.webhook.enabled, token: s.webhook.token, repos: s.webhook.repos }, maxPerDay: s.maxPerDay };
    this.schedule();
    return { saved: this.config.triggers, token: patch.webhook?.newToken ? s.webhook.token : undefined };
  }

  startedToday() {
    const since = Date.now() - 86_400_000;
    return this.state.started.filter((x) => Date.parse(x.at) > since);
  }

  /** Create one agent for a trigger, within the daily cap. */
  start({ source, url, intent, repo, name, project, priority }) {
    if (this.startedToday().length >= this.settings.maxPerDay) throw err(429, `Triggers started ${this.settings.maxPerDay} agents in the last day (triggers.maxPerDay)`);
    const [agent] = this.manager.createMany([intent], {
      repo,
      name,
      project,
      priority,
      trigger: { source, url: url ?? null, at: new Date().toISOString() },
    });
    this.state.started = [...this.state.started, { at: new Date().toISOString(), source, url: url ?? null, agent: agent.id, name: agent.name }].slice(-200);
    this.store.save();
    this.notifier?.send?.('assistant', agent, `was started from ${source === 'github' ? 'a GitHub label' : 'a webhook'}${url ? `: ${url}` : ''}`);
    this.log(`triggers: started ${agent.name} from ${source}${url ? ` (${url})` : ''}`);
    return agent;
  }

  async gh(args) {
    return run(ghBin(), args, { timeout: 60_000 });
  }

  /** One pass: labeled issues, then commands on agents' pull requests. */
  async poll() {
    if (process.env.AGENTMGR_NO_GH) return { issues: 0, commands: 0 };
    const s = this.settings;
    let issues = 0;
    let commands = 0;
    if (s.github.enabled && (s.github.repos.length || s.github.owners.length)) issues = await this.pollIssues(s.github);
    if (s.prCommands.enabled) commands = await this.pollPrCommands(s.prCommands.prefix);
    this.state.lastPoll = { at: new Date().toISOString(), issues, commands };
    this.state.lastError = null;
    this.store.save();
    return { issues, commands };
  }

  async pollIssues(g) {
    const scopes = [...g.repos.map((r) => ['--repo', r]), ...g.owners.map((o) => ['--owner', o])];
    let started = 0;
    for (const scope of scopes) {
      const out = await this.gh(['search', 'issues', '--label', g.label, '--state', 'open', ...scope, '--limit', '30', '--json', 'number,title,body,url,repository']);
      for (const issue of JSON.parse(out || '[]')) {
        if (this.state.issues[issue.url]) continue;
        const nwo = issue.repository?.nameWithOwner;
        if (!nwo || !REPO_RE.test(nwo)) continue;
        // Mark first: a failure must not start the same issue again on every pass.
        this.state.issues[issue.url] = { at: new Date().toISOString() };
        try {
          // A project already on this repo reuses its clone and settings.
          const project = this.projectFor(nwo);
          const agent = this.start({ source: 'github', url: issue.url, intent: issueIntent(issue), ...(project ? { project: project.shortcut } : { repo: `https://github.com/${nwo}` }), name: `${issue.repository.name}#${issue.number}` });
          this.state.issues[issue.url].agent = agent.id;
          started += 1;
          if (g.comment) {
            await this.gh(['issue', 'comment', issue.url, '--body', `AI Agent Manager started an agent on this (\`${agent.name}\`). It will open a pull request.`]).catch(() => {});
          }
        } catch (e) {
          this.state.issues[issue.url].error = e.message;
          if (e.status === 429) break;
        }
      }
    }
    return started;
  }

  projectFor(nwo) {
    const re = new RegExp(`github\\.com[:/]${nwo.replace(/[.]/g, '\\.')}(\\.git)?/?$`, 'i');
    return Object.values(this.store.data.projects ?? {}).find((p) => p.repo && re.test(p.repo) && p.shortcut) ?? null;
  }

  async pollPrCommands(prefix) {
    let sent = 0;
    for (const agent of this.store.list()) {
      for (const pr of Object.values(agent.prs ?? {})) {
        if (pr.state !== 'OPEN' || pr.source === 'mentioned') continue;
        const out = await this.gh(['pr', 'view', pr.url, '--json', 'comments']).catch(() => null);
        if (!out) continue;
        const comments = JSON.parse(out).comments ?? [];
        const seen = (this.state.comments[pr.url] ??= { ids: [], since: new Date().toISOString() });
        for (const c of comments) {
          const id = c.id ?? c.url ?? `${c.author?.login}:${c.createdAt}`;
          if (seen.ids.includes(id)) continue;
          seen.ids = [...seen.ids, id].slice(-200);
          // Comments from before we started watching this PR are history, not commands.
          if (Date.parse(c.createdAt) < Date.parse(seen.since)) continue;
          const text = prCommand(c, prefix);
          if (!text) continue;
          try {
            this.manager.tell(agent.id, `${c.author?.login ?? 'Someone'} asked on your pull request ${pr.url}:\n${text}\n\nDo it, push, and reply on the pull request when done.`, { source: 'github' });
            sent += 1;
          } catch (e) {
            this.log(`triggers: couldn't pass a comment to ${agent.name}: ${e.message}`);
          }
        }
      }
    }
    return sent;
  }

  /** The webhook: { intent, repo?, project?, name?, priority? } with the token. */
  hook(body = {}) {
    const s = this.settings;
    if (!s.webhook.enabled) throw err(404, 'Not found');
    const intent = String(body.intent ?? '').trim();
    if (!intent) throw err(400, 'intent is required');
    const repo = body.repo ? String(body.repo).trim() : undefined;
    const project = body.project ? String(body.project).trim() : undefined;
    if (!repo && !project) throw err(400, 'repo or project is required');
    if (s.webhook.repos.length && repo && !s.webhook.repos.some((r) => repo === r || repo.endsWith(`/${r}`) || repo.endsWith(`/${r}.git`))) {
      throw err(403, 'That repo is not in triggers.webhook.repos');
    }
    const agent = this.start({ source: 'webhook', url: body.url ? String(body.url) : null, intent, repo, project, name: body.name ? String(body.name) : undefined, priority: body.priority });
    return { id: agent.id, name: agent.name };
  }
}
