// The assistant: one always-on session that works on the person's behalf. Every few minutes the
// daemon asks it to check for new work (newly assigned Jira issues, GitHub review requests,
// failing checks on the person's PRs, new Jira comments, Slack messages) with its own tools, and
// it starts agents for that work through agentmgr, or passes news to the agent already on it.
// The daemon keeps the limits: a daily cap, a cap on its agents running at once, and no second
// agent for the same issue.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './config.js';
import { leadingJiraKey } from './tracker.js';

export const SOURCES = {
  jira: 'Jira issues newly assigned to the person',
  reviews: "GitHub pull requests where the person's review is requested",
  ci: "the person's own open GitHub pull requests whose checks fail",
  comments: 'new comments and mentions on Jira issues the person owns',
  slack: 'Slack messages to the person (direct messages and mentions) that ask for work',
  linear: 'Linear issues newly assigned to the person',
};
export const ASSISTANT_DEFAULTS = {
  everyMin: 15,
  // Linear only when chosen: most people use Jira or Linear, not both.
  sources: Object.keys(SOURCES).filter((k) => k !== 'linear'),
  maxPerDay: 10,
  maxRunning: 5,
  permissionMode: 'auto',
  model: null,
  notes: '',
};
const DAY = 86_400_000;
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agentmgr.js');

const err = (status, message) => Object.assign(new Error(message), { status });

export const assistantDir = () => path.join(paths.home, 'assistant');

/** Settings from config.json's "assistant", with defaults and sane bounds. */
export function assistantSettings(config = {}) {
  const c = { ...ASSISTANT_DEFAULTS, ...config.assistant };
  const n = (v, d, lo, hi) => (Number.isFinite(Number(v)) && Number(v) >= lo ? Math.min(hi, Math.floor(Number(v))) : d);
  const sources = Array.isArray(c.sources) ? c.sources.filter((s) => SOURCES[s]) : ASSISTANT_DEFAULTS.sources;
  return {
    everyMin: n(c.everyMin, ASSISTANT_DEFAULTS.everyMin, 1, 1440),
    sources,
    maxPerDay: n(c.maxPerDay, ASSISTANT_DEFAULTS.maxPerDay, 0, 500),
    maxRunning: n(c.maxRunning, ASSISTANT_DEFAULTS.maxRunning, 0, 100),
    permissionMode: typeof c.permissionMode === 'string' && c.permissionMode ? c.permissionMode : null,
    model: typeof c.model === 'string' && c.model ? c.model : null,
    notes: typeof c.notes === 'string' ? c.notes.slice(0, 4000) : '',
  };
}

/** The assistant's standing instructions (appended to its system prompt on every launch). */
export function assistantPrompt(s, dir, bin = `node ${BIN}`) {
  const am = bin;
  const watch = s.sources.map((k) => `- ${SOURCES[k]}`).join('\n');
  const how = [];
  if (s.sources.includes('jira')) {
    how.push(
      `Jira, new assignments: with your Jira / Atlassian tools, find unresolved issues assigned to the person that were created or assigned since your last check (on the first check, the last 2 days). ` +
        `For each one you haven't handled, start an agent: ${am} add @<project> "<the issue link> <a one-line summary of what to do>". ` +
        `Start the request with the issue link: the agent is then named after the issue key, and the daemon refuses a second agent for the same key.`,
    );
  }
  if (s.sources.includes('linear')) {
    how.push(
      `Linear, new assignments: with your Linear tools, find open issues assigned to the person that were created or assigned since your last check (on the first check, the last 2 days). ` +
        `For each one you haven't handled, start an agent: ${am} add @<project> "<the issue link> <a one-line summary of what to do>". ` +
        `Start the request with the issue link (https://linear.app/<team>/issue/<KEY>/…): the agent is then named after the issue key, and the daemon refuses a second agent for the same key. ` +
        `New comments on issues that already have an agent: pass them on with ${am} tell, as for Jira.`,
    );
  }
  if (s.sources.includes('comments')) {
    how.push(
      `Jira, comments and mentions: find new comments on issues the person owns or is mentioned in, since your last check. ` +
        `If an agent is already working on that issue (its name is the issue key; see ${am} ls --json), pass the comment on: ${am} tell <agent id> "New comment on <key> from <author>: <the comment>". ` +
        `A comment that asks for new work on an issue with no agent: start one as above. Otherwise just record it.`,
    );
  }
  if (s.sources.includes('reviews')) {
    how.push(
      `GitHub reviews: gh search prs --review-requested=@me --state=open --json url,title,repository,updatedAt. ` +
        `For each pull request you haven't handled, start a review agent in its project: ${am} add @<project> "Review <the PR link>: read the change, check out the branch if needed, and write the review as comments for the person to post. Don't approve, request changes or post anything yourself."`,
    );
  }
  if (s.sources.includes('ci')) {
    how.push(
      `Failing checks: gh search prs --author=@me --state=open --json url,title,repository, then gh pr checks <url> for each. ` +
        `For a pull request with failing checks: if an agent already works on it (${am} ls --json lists each agent's PRs), tell that agent: ${am} tell <agent id> "Checks fail on <PR link>: <which checks>. Find out why and fix it." ` +
        `Otherwise start one: ${am} add @<project> "Checks fail on <PR link>: find out why and fix it on that branch."`,
    );
  }
  if (s.sources.includes('slack')) {
    how.push(
      `Slack: with your Slack tools, read direct messages to the person and messages that mention them, since your last check. ` +
        `When one clearly asks for work in a known project, start an agent for it and include the message link in the request. Don't reply in Slack; record what you did.`,
    );
  }
  return [
    `You are the person's assistant inside AI Agent Manager (agentmgr). You run all the time in the background and work on their behalf: you find new work and start agents for it, so the work is under way before they look. You don't do the work yourself.`,
    `Watch:\n${watch}`,
    `Each time you get a message starting with "Check now", do one check of every source above, act, record it, and wait for the next message. Don't loop or sleep on your own.`,
    `How:\n${how.map((h, i) => `${i + 1}. ${h}`).join('\n')}`,
    `Projects: ${am} project ls shows the projects and their shortcuts. Pick the project whose repository matches the work (the Jira or Linear project, the GitHub repository). ` +
      `If no project fits, use --repo <git URL> when you know the repository; if you don't know where the work belongs, don't start an agent: list it under "Needs you" in the activity file.`,
    `Limits: the daemon allows at most ${s.maxPerDay} new agents a day and ${s.maxRunning} of yours running at once, and refuses a second agent for the same issue. When ${am} add is refused, don't retry it in this check: record the reason.`,
    `Memory: keep ${path.join(dir, 'handled.json')} as a JSON object from item keys (a Jira key, a PR URL, "<key>#comment-<id>", a Slack message link) to { "at": time, "action": "started <agent id>" | "told <agent id>" | "skipped: why" }. Read it at the start of each check and add what you handled, so you never act on the same item twice. Keep "lastCheck" in it too.`,
    `Activity: after each check, append a short entry to ${path.join(dir, 'activity.md')}: a "## <date and time>" heading, then one line per action ("Started OPS-7 (agent 3fa2b1) in @cc: fix the login timeout", "Told 3fa2b1 about a new comment on OPS-7"), and a "Needs you" list for anything you couldn't decide. Write "Nothing new." when nothing came in. AI Agent Manager shows this file to the person.`,
    `Never merge, approve, close, reassign or comment on anything in Jira, Linear, GitHub or Slack, and never send messages as the person. Reading, and starting or telling agents, is all you do.`,
    s.notes ? `The person's notes for you:\n${s.notes}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export class Assistant {
  constructor({ manager, store, config = {}, log = (m) => console.log(`[agentmgr] ${m}`) }) {
    this.manager = manager;
    this.store = store;
    this.config = config;
    this.log = log;
    store.data.assistant ??= {};
    this.timer = setInterval(() => this.tick(), 30_000);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
  }

  get settings() {
    return assistantSettings(this.config);
  }

  get state() {
    return this.store.data.assistant;
  }

  /** The assistant agent, if there is one. */
  agent() {
    const id = this.state.agentId;
    const a = id && this.store.get(id);
    return a?.kind === 'assistant' ? a : null;
  }

  /** Change settings; kept in config.json by the caller. Running sessions get them on the next launch. */
  update(patch = {}) {
    if (patch.sources !== undefined && (!Array.isArray(patch.sources) || patch.sources.some((s) => !SOURCES[s]))) {
      throw err(400, `sources must be a list of: ${Object.keys(SOURCES).join(', ')}`);
    }
    for (const k of ['everyMin', 'maxPerDay', 'maxRunning']) {
      if (patch[k] !== undefined && !(Number(patch[k]) >= (k === 'everyMin' ? 1 : 0))) throw err(400, `${k} must be ${k === 'everyMin' ? 1 : 0} or more`);
    }
    const next = assistantSettings({ assistant: { ...this.config.assistant, ...patch } });
    this.config.assistant = next;
    return next;
  }

  /** Create the assistant if needed and start it; the first check follows once it is ready. */
  start() {
    let a = this.agent();
    if (!a) {
      const s = this.settings;
      fs.mkdirSync(assistantDir(), { recursive: true });
      a = this.manager.create({ kind: 'assistant', name: 'Assistant', permissionMode: s.permissionMode || undefined, model: s.model || undefined, start: true });
      this.state.agentId = a.id;
      this.state.nextAt = new Date(Date.now() + 20_000).toISOString();
      this.store.save();
      this.log('assistant started');
      return this.status();
    }
    this.state.paused = false;
    this.state.nextAt ??= new Date(Date.now() + 20_000).toISOString();
    this.store.save();
    if (!this.manager.runtimes.get(a.id)?.pty) this.manager.start(a.id);
    return this.status();
  }

  /** Stop checking and close the session (it keeps its memory; start resumes it). */
  async pause() {
    const a = this.agent();
    this.state.paused = true;
    this.store.save();
    if (a && this.manager.runtimes.get(a.id)?.pty) await this.manager.stop(a.id);
    return this.status();
  }

  /** Ask for a check now (queued until the session is idle). */
  check({ by = 'person' } = {}) {
    const a = this.agent();
    if (!a) throw err(409, 'The assistant is not set up yet: start it first');
    const last = this.state.lastCheckAt;
    const n = (this.state.checks ?? 0) + 1;
    const text = `Check now (check ${n}, ${new Date().toISOString()}${last ? `; last check ${last}` : '; first check'}${by === 'person' ? ', asked by the person' : ''}).`;
    this.manager.tell(a.id, text, { source: 'assistant' });
    this.state.checks = n;
    this.state.lastCheckAt = new Date().toISOString();
    this.state.nextAt = new Date(Date.now() + this.settings.everyMin * 60_000).toISOString();
    this.store.save();
    return this.status();
  }

  /** The scheduler: a check every everyMin minutes while the assistant is on and free. */
  tick(t = Date.now()) {
    const a = this.agent();
    // Paused, or closed by hand: no checks until it is started again.
    if (!a || this.state.paused || a.desired === 'stopped') return;
    if (Date.parse(this.state.nextAt ?? 0) > t) return;
    const rt = this.manager.runtimes.get(a.id);
    // Busy with the last check, or a message still waiting to be typed in: try again shortly.
    if (rt?.busy || this.manager.outbox.get(a.id)?.length) return;
    if (!rt?.pty && a.status === 'preparing') return;
    try {
      this.check({ by: 'schedule' });
    } catch (e) {
      this.log(`assistant: ${e.message}`);
    }
  }

  /** Agents the assistant started. */
  started() {
    const a = this.agent();
    return a ? this.store.list().filter((x) => x.startedBy === a.id) : [];
  }

  /**
   * Called before the assistant's own session creates agents: enforces the daily cap, the cap on
   * its running agents, and one agent per issue. Returns the creation options to add.
   */
  admit(callerId, intents, opts = {}) {
    const a = this.agent();
    if (!a || callerId !== a.id) return {};
    const s = this.settings;
    const mine = this.started();
    const today = mine.filter((x) => Date.now() - Date.parse(x.createdAt) < DAY).length;
    if (today + intents.length > s.maxPerDay) throw err(429, `The assistant's limit is ${s.maxPerDay} new agents a day (${today} so far); not started`);
    const running = mine.filter((x) => this.manager.runtimes.get(x.id)?.pty || x.status === 'preparing').length;
    if (running + intents.length > s.maxRunning) throw err(429, `The assistant's limit is ${s.maxRunning} of its agents running at once (${running} now); not started`);
    for (const intent of intents) {
      const key = opts.name?.trim() || leadingJiraKey(intent);
      const dup = key && this.store.list().find((x) => x.kind === 'task' && x.name.toLowerCase() === key.toLowerCase());
      if (dup) throw err(409, `An agent for ${key} already exists: ${dup.name} (${dup.id}); tell it instead`);
    }
    return { startedBy: a.id };
  }

  activity({ chars = 20_000 } = {}) {
    try {
      const text = fs.readFileSync(path.join(assistantDir(), 'activity.md'), 'utf8');
      return text.length > chars ? text.slice(text.indexOf('\n## ', text.length - chars) + 1 || text.length - chars) : text;
    } catch {
      return '';
    }
  }

  status() {
    const a = this.agent();
    const rt = a && this.manager.runtimes.get(a.id);
    const mine = this.started();
    return {
      ...this.settings,
      agentId: a?.id ?? null,
      on: Boolean(a && !this.state.paused),
      running: Boolean(rt?.pty),
      busy: Boolean(rt?.busy),
      checks: this.state.checks ?? 0,
      lastCheckAt: this.state.lastCheckAt ?? null,
      nextAt: a && !this.state.paused ? (this.state.nextAt ?? null) : null,
      startedToday: mine.filter((x) => Date.now() - Date.parse(x.createdAt) < DAY).length,
      startedTotal: mine.length,
      started: mine
        .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
        .slice(0, 20)
        .map((x) => ({ id: x.id, name: x.name, intent: x.intent, createdAt: x.createdAt })),
      activity: this.activity(),
    };
  }
}
