import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import { expandHome, paths } from './config.js';
import { DEFAULT_ENGINE, ENGINES, engineOf, installed, notInstalled } from './engines/index.js';
import {
  DOC_KINDS,
  briefDir,
  briefPath,
  briefPrompt,
  conventionsPrompt,
  docPrompt,
  explainPrompt,
  insightsPrompt,
  loadBrief,
  critiquePrompt,
  humanAiMarkdown,
  humanAiMessage,
  humanAiPrompt,
  parseJsonReply,
  loadPlanFile,
  planApprovedPrompt,
  planPath,
  planReviewPrompt,
} from './brief.js';

// One-off summaries / documents built from an agent's live context.
const SUMMARIES = {
  explain: { field: 'explanation', prompt: explainPrompt },
  insights: { field: 'insights', prompt: insightsPrompt },
  ...Object.fromEntries(Object.keys(DOC_KINDS).map((k) => [k, { doc: k, prompt: (ctx) => docPrompt(k, ctx) }])),
  humanai: { doc: 'humanai', run: 'runHumanAi' },
};
/** Read / write where a summary of `kind` is kept on the agent record. */
const getSummary = (agent, kind) => (SUMMARIES[kind].doc ? agent.docs?.[kind] : agent[SUMMARIES[kind].field]);
const summaryPatch = (agent, kind, value) =>
  SUMMARIES[kind].doc ? { docs: { ...agent.docs, [kind]: value } } : { [SUMMARIES[kind].field]: value };
import { spawn } from 'node:child_process';
import * as git from './git.js';
import { conflictMessage, findConflicts, related, repoKey, summarize as summarizeConflicts } from './conflicts.js';
import { answerMessage, loadQuestions, questionsPath, questionsPrompt } from './inbox.js';
import { STUCK_DEFAULTS, detectStuck } from './stuck.js';
import { Judge, clashPrompt, finishMessage, hash, reviewPrompt, screenPrompt, stripChrome, stuckPrompt } from './judge.js';
import { findLocalUrls, findSignInLinks, parseCallback, parseUrl } from './preview.js';
import { Plugins } from './plugins.js';
import { leadPrompt, subagents, teamDir, teamPrompt } from './teams.js';
import { assistantDir, assistantPrompt, assistantSettings } from './assistant.js';
import { learnCommand, memoryKey, memoryPrompt, memoryText } from './memory.js';
import { runningClaude, scanClaudeSessions } from './sessions.js';
import {
  bugFromRef,
  extractRefs,
  landState,
  leadingJiraKey,
  prDetails,
  prFromUrl,
  prsForBranch,
  sumUsage,
} from './tracker.js';

// Per-session markers a parent Claude Code session sets. Inherited, they make the
// agent think it is a nested child session (which, among other things, turns
// transcript saving off, so the session could never be resumed).
const STRIP_ENV = [
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
];
// Prompts that block a background agent until someone answers in its terminal.
// Matched against output with ANSI codes and all whitespace removed, because
// Claude's TUI positions words with cursor moves instead of spaces.
const ANSI = /\x1b(\[[0-9;?<>=]*[ -\/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[()][0-9A-B]|[=>78c])/g;
// When a link is found from several sources, the higher-ranked source is kept.
const SOURCE_RANK = { manual: 5, intent: 4, session: 3, branch: 2, mentioned: 1 };
const BUSY_IDLE_MS = 3000;
/** Looser stuck thresholds: candidates the judge looks at before anyone is bothered. */
const loosen = (o) => ({
  repeatFailures: Math.max(2, Math.ceil(o.repeatFailures / 2)),
  thrashReverts: Math.max(1, o.thrashReverts - 1),
  thrashEdits: Math.max(4, Math.ceil(o.thrashEdits * 0.6)),
  driftMinutes: Math.max(5, Math.ceil(o.driftMinutes / 2)),
  driftActions: Math.max(10, Math.ceil(o.driftActions * 0.6)),
});

const planningPrompt = (agent) =>
  `You are in a planning phase. The working copy of ${agent.repo || 'the repository'} is still being ` +
  'prepared (cloned) and is not available yet, so do not look for project files in the current folder ' +
  'and do not create or edit files here. Use this time with the user: restate the task, ask focused ' +
  'questions, gather requirements and constraints, and agree on an approach and a step-by-step plan. ' +
  'When the repository is ready, this session will move into it and you will be told.';

const handoffMessage = (agent) =>
  `The repository is ready. You are now in its working copy at ${agent.workdir}` +
  `${agent.branch ? ` (branch ${agent.branch})` : ''}. First review its CLAUDE.md, skills and hooks as instructed, ` +
  'then continue with the plan we agreed on.';

/**
 * The project an agent belongs to, for grouping: a user-set name, else its repo
 * (URL or the clone's origin remote, so a URL and a local clone of the same repo
 * group together), else the folder's name.
 */
/** Shell number for a terminal kind ('shell' -> 1, 'shell:3' -> 3), or 0 for Claude's own terminal. */
export function shellNumber(kind) {
  const m = /^shell(?::(\d{1,3}))?$/.exec(kind ?? '');
  return m ? Math.max(1, Number(m[1] ?? 1)) : 0;
}

/** Where the shared clone of a repo URL lives. */
export function repoCacheDir(repo) {
  const hash = crypto.createHash('sha1').update(repo).digest('hex').slice(0, 6);
  return path.join(paths.repos, `${git.repoNameFromUrl(repo)}-${hash}`);
}

/** Sessions with no repo or folder of their own. */
export const NO_REPO = new Set(['general', 'assistant']);

export function projectOf(agent) {
  // Moved under another known project by hand.
  if (agent.projectMove?.key) return { key: agent.projectMove.key, name: agent.projectMove.name, ...(agent.projectMove.full ? { full: agent.projectMove.full } : {}), source: 'moved' };
  if (agent.project) return { key: `custom:${agent.project.toLowerCase()}`, name: agent.project, source: 'custom' };
  if (agent.kind === 'general') return { key: 'general', name: 'General', source: 'general' };
  if (agent.kind === 'assistant') return { key: 'assistant', name: 'Assistant', source: 'assistant' };
  const url = agent.repo || agent.git?.remote;
  if (url && /[:/]/.test(url)) {
    const path = url
      .trim()
      .replace(/^[a-z+]+:\/\//i, '')
      .replace(/^[^@/]+@/, '')
      .replace(':', '/')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
    const parts = path.split('/').filter(Boolean);
    const name = parts.at(-1) || path;
    // github.com/org/repo -> key "github.com/org/repo"; file:// paths keep their full path.
    return { key: `repo:${path.toLowerCase()}`, name, full: parts.slice(-2).join('/'), source: 'repo' };
  }
  const folder = agent.sourceDir || agent.requestedDir || (agent.workdir?.startsWith(paths.workspaces) ? null : agent.workdir);
  if (folder) return { key: `dir:${folder}`, name: path.basename(folder), full: folder, source: 'folder' };
  return { key: 'other', name: 'Other', source: 'other' };
}

/** A short, memorable shortcut for a project name: initials of its parts, or its first letters. */
export function suggestShortcut(name, taken = new Set()) {
  const parts = String(name ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let base = parts.length > 1 ? parts.map((p) => p[0]).join('').slice(0, 4) : (parts[0] ?? 'p').slice(0, 3);
  if (base.length < 2) base = (parts.join('') || 'proj').slice(0, 3);
  let candidate = base;
  for (let i = 2; taken.has(candidate); i++) candidate = `${base}${i}`;
  return candidate;
}

export const validShortcut = (s) => /^[a-z][a-z0-9-]{0,15}$/.test(s);

export function slugify(text, max = 30) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '') || 'agent'
  );
}

const now = () => new Date().toISOString();
/** Priority 0 (P0, most urgent) to 3 (P3); P2 is the default. Accepts 0-3, "P0"-"P3". */
export const parsePriority = (v, fallback = 2) => {
  const n = Number(String(v ?? '').replace(/^p/i, ''));
  return v !== undefined && v !== null && v !== '' && Number.isInteger(n) && n >= 0 && n <= 3 ? n : fallback;
};
const scrollbackFile = (id) => path.join(paths.scrollback, `${id}.log`);

/** Terminal output saved by the last flush, so a restarted daemon's terminal isn't blank. */
function loadScrollback(id) {
  try {
    const text = fs.readFileSync(scrollbackFile(id), 'utf8');
    return text ? { chunks: [text], size: text.length } : { chunks: [], size: 0 };
  } catch {
    return { chunks: [], size: 0 };
  }
}
const baseLabel = ({ ref, sha }) => `${ref} @ ${sha.slice(0, 9)}`;

/** The id of the machine terminal's shells (agent ids are hex, so it can't clash). */
export const MACHINE = '__machine__';

export class AgentManager extends EventEmitter {
  constructor({ store, config, plugins = new Plugins() }) {
    super();
    this.store = store;
    this.config = config;
    this.plugins = plugins; // policies before actions, listeners after (src/plugins.js)
    this.runtimes = new Map(); // agent id -> { pty, chunks, size, clients, lastOutputAt, busy, stopping, exited }
    this.inputAt = new Map(); // agent id -> when you last typed into its session or a shell
    this.shells = new Map(); // agent id -> ancillary shell runtime in the agent's folder
    this.cursors = new Map(); // session id -> transcript scan cursor
    this.locks = new Map();
    this.refreshing = new Map(); // agent id -> the refresh in progress
    this.lastPrCheck = new Map();
    this.changeSets = new Map(); // agent id -> { files, baseSha, at }: what its branch changed (conflict radar)
    this.conflicts = new Map(); // agent id -> [conflict]
    this.activity = new Map(); // session id -> transcript activity window (stuck detection)
    this.stuck = new Map(); // agent id -> [finding]
    this.outbox = new Map(); // agent id -> [message] waiting to be typed into its session
    // The AI judge: rules decide when to look, a model decides what is going on (see judge.js).
    this.judge = new Judge({ config, call: (agent, prompt, { timeoutMs }) => this.oneShot(agent, prompt, { ...this.judgeModel(agent), timeoutMs }) });
    this.stuckVerdicts = new Map(); // agent id -> Map(finding key -> { at, since, data })
    this.signIns = new Map(); // agent id -> { url, port, callback, terminal, at, finished } from a CLI's sign-in link
    this.seenLinks = new Map(); // agent id -> Set of sign-in links already raised
    this.clashVerdicts = new Map(); // 'idA|idB' (sorted) -> { at, hash, a, b, data, pending }

    // Processes do not survive a daemon restart, but their session IDs do.
    // `desired` records whether the user wants the agent running; a restart,
    // crash or reboot leaves it alone, so resumeAll() can bring agents back.
    for (const agent of store.list()) {
      if (!agent.desired) store.patch(agent.id, { desired: agent.status === 'running' ? 'running' : 'stopped' });
      if (agent.status === 'running' || agent.status === 'preparing') {
        const interrupted = agent.status === 'preparing';
        store.patch(agent.id, {
          status: interrupted ? 'error' : 'stopped',
          error: interrupted ? 'Workspace setup was interrupted by a daemon restart' : agent.error,
          // resumeAll() retries interrupted setups the user still wants running.
          setupInterrupted: interrupted || undefined,
          pid: null,
        });
      }
      if (agent.progress) store.patch(agent.id, { progress: null });
      for (const kind of Object.keys(SUMMARIES)) {
        const cur = store.get(agent.id);
        const v = getSummary(cur, kind);
        if (v?.pending) store.patch(agent.id, summaryPatch(cur, kind, { ...v, pending: false }));
      }
    }
    this.preparing = new Map(); // agent id -> { controller, done } for workspace setup in flight
    // Project shortcuts ("cc" -> cloud-console), keyed by shortcut; every project gets one.
    store.data.projects ??= {};
    for (const agent of store.list()) this.registerProject(agent);

    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tickCount = 0;
  }

  // ---------------------------------------------------------------- queries

  list() {
    return this.store.list().map((a) => this.view(a));
  }

  get(ref) {
    const agent = this.store.resolve(ref);
    return agent && this.view(agent);
  }

  mustGet(ref) {
    const agent = this.store.resolve(ref);
    if (!agent) throw Object.assign(new Error(`No agent matches "${ref}"`), { status: 404 });
    return agent;
  }

  view(agent) {
    const rt = this.runtimes.get(agent.id);
    const usage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, requests: 0, total: 0 };
    for (const s of agent.sessions ?? []) for (const k of Object.keys(usage)) usage[k] += s.usage?.[k] ?? 0;
    usage.io = usage.input + usage.output;
    const costs = (agent.sessions ?? []).map((s) => s.cost?.usd).filter((c) => c != null);
    const prs = Object.values(agent.prs ?? {});
    return {
      ...agent,
      results: this.results(agent, rt, prs),
      priority: agent.priority ?? 2,
      activeAt: this.activeAt(agent, rt),
      projectInfo: this.projectInfo(agent),
      usage,
      // Claude Code's own cost figure from the transcripts (absent until it records one).
      costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      prs: Object.values(agent.prs ?? {}).map((p) => ({ ...p, land: landState(p) })),
      bugs: Object.values(agent.bugs ?? {}),
      conflicts: this.conflictGroups(agent),
      stuck: this.activeStuck(agent),
      questions: this.questionsView(agent),
      outbox: this.outbox.get(agent.id)?.length ?? 0,
      signIn: this.signInView(agent),
      runtime: {
        running: Boolean(rt?.pty),
        busy: Boolean(rt?.pty && rt.busy),
        planning: Boolean(rt?.pty && rt.planning),
        attention: (rt?.pty && !rt.busy && rt.attention) || null,
        // What the AI judge read on an idle screen no rule matched: a question or an error.
        waiting: (rt?.pty && !rt.busy && !rt.attention && rt.waiting) || null,
        clients: rt?.clients.size ?? 0,
        shell: this.shellNumbers(agent.id).length > 0,
        shells: this.shellNumbers(agent.id),
        lastOutputAt: rt?.lastOutputAt ? new Date(rt.lastOutputAt).toISOString() : null,
        prompt: rt?.pty && !rt.busy && rt.attention ? engineOf(agent).promptChoices(rt.tail) : null,
      },
    };
  }

  /**
   * When the agent last did real work or you last worked with it: its conversation,
   * its brief, your typing, or output while busy (not the redraw after a restart).
   */
  activeAt(agent, rt) {
    const times = [agent.createdAt, agent.brief?.updatedAt, ...(agent.sessions ?? []).map((s) => s.lastMessageAt ?? s.lastActivity)]
      .map((t) => (t ? Date.parse(t) : 0));
    times.push(this.inputAt.get(agent.id) ?? 0);
    if (rt?.pty && rt.busy && rt.lastOutputAt - (rt.startedAt ?? 0) > 60_000) times.push(rt.lastOutputAt);
    const t = Math.max(0, ...times.filter(Number.isFinite));
    return t ? new Date(t).toISOString() : null;
  }

  /**
   * The end result / status / blockers for an agent: what the agent wrote under
   * "## Results", plus what AI Agent Manager knows (PRs, checks, prompts, errors).
   */
  results(agent, rt, prs) {
    const r = agent.brief?.results;
    const delivered = (r?.delivered ?? []).map((text) => ({ text, source: 'agent' }));
    const blockers = (r?.blockers ?? []).map((text) => ({ text, source: 'agent' }));
    for (const p of prs) {
      if (p.source === 'mentioned') continue;
      const label = `PR ${p.number ? `#${p.number} ` : ''}${p.title ?? p.url}${p.state ? ` (${p.isDraft ? 'draft' : p.state.toLowerCase()})` : ''}`;
      if (!delivered.some((d) => d.text.includes(p.url) || (p.number && d.text.includes(`#${p.number}`)))) {
        delivered.push({ text: label, url: p.url, source: 'tracked' });
      }
    }
    const failed = (agent.brief?.checks ?? []).filter((c) => c.state === 'failed');
    for (const c of failed) blockers.push({ text: `Failing check: ${c.text}`, source: 'checks' });
    const attention = rt?.pty && !rt.busy && rt.attention;
    if (attention) blockers.push({ text: `${attention}: waiting for an answer in the terminal`, source: 'live' });
    if (agent.status === 'error') blockers.push({ text: agent.error ?? 'Setup or launch failed', source: 'live' });

    let outcome = r?.outcome ?? null;
    if (!outcome) {
      if (agent.status === 'error' || agent.brief?.status === 'blocked') outcome = 'blocked';
      else if (agent.brief?.status === 'done') outcome = 'done';
      else if (agent.brief?.status || rt?.pty || agent.status === 'preparing') outcome = 'in progress';
    }
    if (!outcome && !delivered.length && !blockers.length) return null;
    return { outcome: outcome ?? 'in progress', delivered, blockers, notes: r?.notes ?? '', fromAgent: Boolean(r) };
  }

  changed(agent) {
    this.emit('change', this.view(agent));
  }

  patch(id, fields) {
    const agent = this.store.patch(id, fields);
    if (agent) this.changed(agent);
    return agent;
  }

  // --------------------------------------------------------------- projects

  projectInfo(agent) {
    const info = projectOf(agent);
    const entry = Object.values(this.store.data.projects).find((p) => p.key === info.key);
    return { ...info, shortcut: entry?.shortcut ?? null };
  }

  /** Make sure the agent's project has a shortcut; remember where it lives for "add @cc". */
  registerProject(agent) {
    if (!agent || NO_REPO.has(agent.kind)) return null;
    // A moved agent's repo says nothing about the project it was moved to.
    if (agent.projectMove) return null;
    const info = projectOf(agent);
    if (info.key === 'other') return null;
    const reg = this.store.data.projects;
    let entry = Object.values(reg).find((p) => p.key === info.key);
    if (!entry) {
      const shortcut = suggestShortcut(info.name, new Set(Object.keys(reg)));
      entry = reg[shortcut] = { shortcut, name: info.name, key: info.key, repo: null, dir: null, base: null, auto: true, createdAt: now() };
    }
    let changed = !entry.updatedAt;
    const fill = { repo: agent.repo && git.isRemoteUrl(agent.repo) ? agent.repo : null, dir: agent.repo ? null : agent.sourceDir || agent.requestedDir || null };
    for (const [k, v] of Object.entries(fill)) {
      if (v && !entry[k]) {
        entry[k] = v;
        changed = true;
      }
    }
    if (changed) {
      entry.updatedAt = now();
      this.store.save();
    }
    return entry;
  }

  /** Find a project by shortcut, name or full name (case-insensitive). */
  resolveProject(ref) {
    const r = String(ref ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!r) return null;
    const all = Object.values(this.store.data.projects);
    return all.find((p) => p.shortcut === r) ?? all.find((p) => p.name.toLowerCase() === r) ?? null;
  }

  listProjects() {
    const agents = this.store.list();
    return Object.values(this.store.data.projects)
      .map((p) => {
        const mine = agents.filter((a) => projectOf(a).key === p.key);
        return { ...p, agents: mine.length, running: mine.filter((a) => this.runtimes.get(a.id)?.pty).length };
      })
      .sort((a, b) => a.shortcut.localeCompare(b.shortcut));
  }

  /** Whether new agents in this project start without a clone: its folder or repo is already here. */
  projectWarm(entry) {
    if (entry.dir) return fs.existsSync(entry.dir);
    if (entry.repo && git.isRemoteUrl(entry.repo)) return fs.existsSync(repoCacheDir(entry.repo));
    return true;
  }

  /** Register a project ahead of time: `{ shortcut, name?, repo? | dir?, base? }`. */
  addProject({ shortcut, name, repo, dir, base }) {
    const sc = String(shortcut ?? '').trim().toLowerCase();
    if (!validShortcut(sc)) throw Object.assign(new Error('Shortcut: 1-16 lowercase letters, digits or "-", starting with a letter'), { status: 400 });
    if (this.store.data.projects[sc]) throw Object.assign(new Error(`Shortcut "${sc}" is taken`), { status: 409 });
    if (!repo && !dir && !name) throw Object.assign(new Error('Give a repo URL, a folder, or a name'), { status: 400 });
    const pseudo = { project: repo || dir ? null : name, repo: repo || null, requestedDir: dir ? path.resolve(expandHome(dir)) : null };
    const info = projectOf(pseudo);
    const clash = Object.values(this.store.data.projects).find((p) => p.key === info.key);
    if (clash) throw Object.assign(new Error(`That project already has the shortcut "${clash.shortcut}"`), { status: 409 });
    this.store.data.projects[sc] = {
      shortcut: sc,
      name: name || info.name,
      key: info.key,
      repo: repo || null,
      dir: pseudo.requestedDir,
      base: base || null,
      auto: false,
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.save();
    this.emitAll();
    return this.store.data.projects[sc];
  }

  updateProject(ref, { shortcut, base }) {
    const entry = this.resolveProject(ref);
    if (!entry) throw Object.assign(new Error(`No project "${ref}"`), { status: 404 });
    const reg = this.store.data.projects;
    if (shortcut !== undefined && shortcut !== entry.shortcut) {
      const sc = String(shortcut).trim().toLowerCase();
      if (!validShortcut(sc)) throw Object.assign(new Error('Shortcut: 1-16 lowercase letters, digits or "-", starting with a letter'), { status: 400 });
      if (reg[sc]) throw Object.assign(new Error(`Shortcut "${sc}" is taken`), { status: 409 });
      delete reg[entry.shortcut];
      entry.shortcut = sc;
      reg[sc] = entry;
    }
    if (base !== undefined) entry.base = base || null;
    entry.auto = false;
    entry.updatedAt = now();
    this.store.save();
    this.emitAll();
    return entry;
  }

  removeProject(ref) {
    const entry = this.resolveProject(ref);
    if (!entry) throw Object.assign(new Error(`No project "${ref}"`), { status: 404 });
    delete this.store.data.projects[entry.shortcut];
    this.store.save();
    this.emitAll();
    return { shortcut: entry.shortcut };
  }

  /** Re-broadcast every agent (their project shortcut may have changed). */
  emitAll() {
    for (const a of this.store.list()) this.changed(a);
    this.emit('projects', this.listProjects());
  }

  // --------------------------------------------------------------- creation

  /** Create one agent per intent. Workspace prep and launch continue in the background. */
  createMany(intents, opts = {}) {
    const list = intents.map((i) => i.trim()).filter(Boolean);
    if (!list.length) throw Object.assign(new Error('At least one intent is required'), { status: 400 });
    // Several intents against one folder would trample each other; isolate them.
    const worktree = opts.worktree ?? (list.length > 1 && Boolean(opts.dir));
    return list.map((intent, i) =>
      this.create({ ...opts, intent, worktree, name: list.length > 1 && opts.name ? `${opts.name}-${i + 1}` : opts.name }),
    );
  }

  /** A general Claude session with no repo or folder; the question (if any) is its first prompt. */
  createGeneral({ question, name, permissionMode, model } = {}) {
    return this.create({ kind: 'general', intent: question, name, permissionMode, model });
  }

  create({
    kind = 'task',
    intent,
    name,
    repo,
    dir,
    worktree = false,
    base,
    permissionMode,
    model,
    start = true,
    plan = false,
    planReview,
    project,
    priority,
    workspace,
    race,
    team,
    engine,
    sessionId: adopt,
    imported,
    startedBy,
    trigger,
  }) {
    intent = (intent ?? '').trim();
    const engineDef = engineOf(engine || this.config.engine || DEFAULT_ENGINE);
    const engineId = engineDef.id;
    this.plugins.check('agent.create', {
      input: { kind, intent, name, repo, dir, worktree, base, permissionMode: permissionMode || this.config.permissionMode || null, model, project, priority, engine: engineId, imported: Boolean(imported) },
    });
    if (permissionMode && !engineDef.permissionModes.includes(permissionMode)) {
      throw Object.assign(new Error(`${engineDef.label} has no "${permissionMode}" mode (use ${engineDef.permissionModes.join(', ')})`), { status: 400 });
    }
    // Planning while cloning moves the session between folders, which needs the engine's support.
    if (!engineDef.supports.planHandoff) plan = false;
    const general = NO_REPO.has(kind);
    // A project shortcut (or name) fills in the repo / folder / base branch.
    const entry = !general && project ? this.resolveProject(project) : null;
    if (entry) {
      if (!repo && !dir) {
        repo = entry.repo ?? undefined;
        dir = entry.dir ?? undefined;
        // Agents started from a project's own clone always get their own worktree.
        if (dir) worktree = true;
      }
      base ??= entry.base ?? undefined;
      project = entry.key.startsWith('custom:') ? entry.name : null;
    }
    if (!intent && !general) throw Object.assign(new Error('Intent is required'), { status: 400 });
    const id = crypto.randomBytes(3).toString('hex');
    // An imported session keeps its ID, so the first start resumes it.
    const sessionId = adopt || crypto.randomUUID();
    // A request that starts with a Jira link is named after the issue ("ABC-123"), not the link.
    const jiraKey = !name?.trim() && intent ? leadingJiraKey(intent) : null;
    const slug = name || intent ? slugify(name || jiraKey || intent) : `general-${id}`;
    const refs = extractRefs(intent, this.config.bugPatterns);

    const agent = {
      id,
      kind: general ? kind : 'task',
      engine: engineId,
      project: project?.trim() || null,
      priority: parsePriority(priority),
      ...(startedBy ? { startedBy } : {}),
      ...(trigger ? { trigger } : {}),
      name: name?.trim() || jiraKey || slug,
      slug,
      intent,
      repo: general ? null : repo?.trim() || null,
      requestedDir: general ? null : dir?.trim() || null,
      workdir: null,
      sourceDir: null,
      branch: null,
      worktree: !general && Boolean(worktree),
      // Requested start point for the agent's branch (null = the repo's default branch).
      base: general ? null : base?.trim() || null,
      baseRef: null,
      permissionMode: permissionMode || this.config.permissionMode,
      model: model || null,
      // Review the implementation plan before the agent implements it: null = no review.
      // Team members get their review from the team instead.
      planReview: !general && !team && (planReview ?? this.config.planReview ?? false) ? { status: 'writing' } : null,
      status: 'preparing',
      desired: start ? 'running' : 'stopped',
      error: null,
      exitCode: null,
      pid: null,
      sessionId,
      sessions: [{ id: sessionId, createdAt: now(), starts: 0 }],
      git: null,
      prs: {},
      bugs: {},
      dismissed: [],
      notes: '',
      createdAt: now(),
      updatedAt: now(),
      lastStartedAt: null,
      stoppedAt: null,
      ...(race ? { raceId: race.id, variant: race.variant } : {}),
      ...(team ? { team } : {}),
      ...(imported ? { imported } : {}),
    };
    for (const pr of refs.prs) agent.prs[pr.url] = { ...pr, source: 'intent' };
    for (const bug of refs.bugs) agent.bugs[bug.key] = { ...bug, source: 'intent' };
    this.store.put(agent);
    this.registerProject(agent);
    this.changed(agent);

    this.plugins.emit('agent.created', { agent: this.auditView(agent) });
    this.prepare(agent, { start, workspace }).catch(() => {});
    // Planning only makes sense while there is a clone to wait for.
    if (plan && agent.repo && git.isRemoteUrl(agent.repo)) {
      try {
        this.startPlanning(agent.id);
      } catch {}
    }
    return this.view(agent);
  }

  prepare(agent, { start, workspace }) {
    const controller = new AbortController();
    const { signal } = controller;
    // Progress is transient: broadcast it, but don't rewrite state.json for every tick.
    let last = 0;
    const progress = (p) => {
      const cur = this.store.get(agent.id);
      if (!cur) return;
      const t = Date.now();
      if (t - last < 500 && p.percent !== 100 && cur.progress?.phase === p.phase) return;
      last = t;
      cur.progress = { ...p, at: new Date(t).toISOString() };
      this.changed(cur);
    };
    const done = (async () => {
      try {
        const ws = await (workspace ?? ((a, o) => this.prepareWorkspace(a, o)))(agent, { signal, progress });
        progress({ phase: 'Reading git info' });
        const info = await git.gitInfo(ws.workdir);
        if (!this.store.get(agent.id)) return;
        this.patch(agent.id, {
          ...ws,
          repo: ws.repo || agent.repo || info?.remote || null,
          git: info,
          status: 'stopped',
          progress: null,
          setupInterrupted: undefined,
        });
        this.registerProject(this.store.get(agent.id));
        const rt = this.runtimes.get(agent.id);
        if (this.closing) return; // shutting down: it resumes on the next start (desired is kept)
        if (rt?.pty && rt.planning) this.maybeHandoff(agent.id).catch(() => {});
        else if (this.store.get(agent.id)?.desired === 'running') this.start(agent.id);
      } catch (err) {
        if (this.store.get(agent.id)) {
          this.patch(agent.id, { status: 'error', error: err.message, progress: null, setupInterrupted: undefined });
        }
        throw err;
      } finally {
        this.preparing.delete(agent.id);
      }
    })();
    this.preparing.set(agent.id, { controller, done });
    return done;
  }

  /** Re-run workspace setup for an agent whose setup failed or was interrupted. */
  retrySetup(ref) {
    const agent = this.mustGet(ref);
    if (agent.status !== 'error' || agent.workdir) {
      throw Object.assign(new Error('Only agents whose setup failed can be retried'), { status: 409 });
    }
    this.patch(agent.id, { status: 'preparing', error: null, desired: 'running' });
    this.prepare(agent, { start: true }).catch(() => {});
    // Bring back a planning session that a daemon restart interrupted.
    if (agent.planning && !agent.planning.handedOffAt && !this.runtimes.get(agent.id)?.pty) {
      try {
        this.startPlanning(agent.id);
      } catch {}
    }
    return this.view(agent);
  }

  withLock(key, fn) {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(key, next);
    return next;
  }

  async prepareWorkspace(agent, { signal, progress = () => {} } = {}) {
    const { id, slug } = agent;
    const cloneOpts = (phase) => ({
      signal,
      filter: this.config.cloneFilter || undefined,
      onProgress: (p) => progress({ phase, ...p }),
    });
    if (agent.kind === 'general') {
      fs.mkdirSync(paths.general, { recursive: true });
      return { workdir: paths.general };
    }
    if (agent.kind === 'assistant') {
      fs.mkdirSync(assistantDir(), { recursive: true });
      return { workdir: assistantDir() };
    }
    let repo = agent.repo;
    let dir = agent.requestedDir ? path.resolve(expandHome(agent.requestedDir)) : null;
    const branch = `agent/${slug}-${id}`;

    // A "repo" that is really a local path is treated as the folder.
    if (repo && !git.isRemoteUrl(repo)) {
      dir ??= path.resolve(expandHome(repo));
      repo = null;
    }

    if (repo && !dir) {
      // One shared clone per repo; each agent gets its own worktree + branch off it.
      const name = git.repoNameFromUrl(repo);
      const base = repoCacheDir(repo);
      if (this.locks.has(base)) progress({ phase: 'Waiting for another agent to finish cloning' });
      await this.withLock(base, async () => {
        signal?.throwIfAborted();
        // A clone interrupted by a crash or restart is unusable; start it over.
        if (fs.existsSync(base) && !(await git.isValidClone(base))) fs.rmSync(base, { recursive: true, force: true });
        if (!fs.existsSync(base)) {
          progress({ phase: 'Cloning' });
          await git.clone(repo, base, { ...cloneOpts('Cloning'), noCheckout: true });
        } else {
          progress({ phase: 'Fetching' });
          await git.fetch(base, { signal }).catch((err) => {
            if (err.cancelled) throw err;
          });
        }
      });
      const workdir = path.join(paths.workspaces, `${name}-${slug}-${id}`);
      let start;
      await this.withLock(base, async () => {
        signal?.throwIfAborted();
        progress({ phase: 'Checking out' });
        start = await git.resolveBase(base, agent.base);
        await git.addWorktree(base, workdir, branch, start.sha, cloneOpts('Checking out'));
      });
      return { workdir, sourceDir: base, branch, worktree: true, repo, baseRef: baseLabel(start) };
    }

    if (repo && dir && !fs.existsSync(dir)) {
      progress({ phase: 'Cloning' });
      await git.clone(repo, dir, cloneOpts('Cloning'));
      return { workdir: dir, repo };
    }

    if (!dir) {
      const workdir = path.join(paths.workspaces, `${slug}-${id}`);
      fs.mkdirSync(workdir, { recursive: true });
      return { workdir, repo };
    }

    fs.mkdirSync(dir, { recursive: true });
    // A worktree needs a git repo; for any other folder (the UI asks for worktrees by default) use it as is.
    if (agent.worktree && (await git.isGitRepo(dir))) {
      const top = await git.run('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
      const workdir = path.join(paths.workspaces, `${path.basename(top)}-${slug}-${id}`);
      let start;
      await this.withLock(top, async () => {
        // Branch off the latest default branch (or the requested base), not whatever is checked out.
        if (await git.hasRemote(top)) {
          progress({ phase: 'Fetching' });
          await git.fetch(top, { signal }).catch((err) => {
            if (err.cancelled) throw err; // offline / no access: use the refs we already have
          });
        }
        start = await git.resolveBase(top, agent.base);
        progress({ phase: 'Checking out' });
        await git.addWorktree(top, workdir, branch, start.sha, cloneOpts('Checking out'));
      });
      return { workdir, sourceDir: top, branch, worktree: true, repo, baseRef: baseLabel(start) };
    }
    return { workdir: dir, repo, worktree: false };
  }

  // -------------------------------------------------------------- lifecycle

  /**
   * Launch (or re-launch) claude for an agent. Resumes the current session if
   * its transcript exists; `fresh` starts a new session ID, `sessionId` switches
   * back to an earlier one.
   */
  start(ref, { fresh = false, sessionId } = {}) {
    const agent = this.mustGet(ref);
    if (this.closing) throw Object.assign(new Error('AI Agent Manager is shutting down'), { status: 503 });
    const live = this.runtimes.get(agent.id);
    if (!live?.pty) {
      this.plugins.check('agent.start', { agent: this.auditView(agent), fresh });
      this.plugins.emit('agent.starting', { agent: this.auditView(agent), fresh });
    }
    if (live?.pty) {
      // "Start" on a planning session whose workspace is ready means: move it into the repo.
      if (live.planning && agent.workdir && agent.status !== 'preparing') return this.maybeHandoff(agent.id, { force: true });
      // Retry setup while the planning session keeps running.
      if (agent.status === 'error' && !agent.workdir) return this.retrySetup(agent.id);
      return this.view(agent);
    }
    if (agent.status === 'preparing') {
      throw Object.assign(
        new Error(`Workspace is still being prepared; plan with Claude meanwhile: agentmgr plan ${agent.id}`),
        { status: 409 },
      );
    }
    if (agent.status === 'error' && !agent.workdir) return this.retrySetup(agent.id);
    if (!agent.workdir || !fs.existsSync(agent.workdir)) {
      throw Object.assign(new Error(`Working folder ${agent.workdir} no longer exists`), { status: 409 });
    }

    if (sessionId) {
      if (!agent.sessions.some((s) => s.id === sessionId)) {
        throw Object.assign(new Error(`Session ${sessionId} does not belong to this agent`), { status: 400 });
      }
      agent.sessionId = sessionId;
    } else if (fresh) {
      agent.sessionId = crypto.randomUUID();
      agent.sessions.push({ id: agent.sessionId, createdAt: now(), starts: 0 });
    }

    let sid = agent.sessionId;
    // A planning session ran in the holding folder: move its transcript into the
    // workspace so the same session (same ID, full history) continues there.
    const handoff = Boolean(agent.planning && !agent.planning.handedOffAt);
    const engine = engineOf(agent);
    if (handoff) engine.copySession({ fromCwd: agent.planning.dir, toCwd: agent.workdir, fromId: sid });
    let resume = engine.hasSession(agent.workdir, sid);
    if (!resume && !engine.supports.chooseSessionId && agent.lastStartedAt) {
      // The engine picks its own IDs and we stopped before adopting one: find it rather than start over.
      const known = new Set(this.store.list().flatMap((a) => a.sessions.map((s) => s.id)));
      const prior = engine.recentSessions(agent.workdir, Date.parse(agent.lastStartedAt) - 1000).filter((f) => !known.has(f.sessionId));
      if (prior.length === 1) {
        sid = prior[0].sessionId;
        agent.sessions.push({ id: sid, createdAt: now(), starts: 0, adopted: true });
        resume = true;
      }
    }
    const args = engine.launchArgs({
      ...this.launchOptions(agent),
      sessionId: sid,
      resume,
      name: agent.name,
      // A team member's first message is its first step, not just the problem.
      prompt: resume ? (handoff ? handoffMessage(agent) : null) : (agent.kickoff ?? agent.intent),
    });
    const proc = this.spawnAgent(agent, agent.workdir, args);

    const session = agent.sessions.find((s) => s.id === sid);
    if (session) {
      session.starts = (session.starts ?? 0) + 1;
      session.lastStartedAt = now();
    }
    this.patch(agent.id, {
      status: 'running',
      desired: 'running',
      error: null,
      exitCode: null,
      pid: proc.pid,
      lastStartedAt: now(),
      sessions: agent.sessions,
      sessionId: sid,
      kickoff: undefined,
      ...(handoff ? { planning: { ...agent.planning, ready: false, handedOffAt: now() } } : {}),
    });
    return this.view(this.store.get(agent.id));
  }

  /** What every launch of this agent passes its engine: options, its brief folder, instructions. */
  launchOptions(agent, { planning = false } = {}) {
    const engine = engineOf(agent);
    let writableDir = null;
    let agents = null;
    const prompts = [];
    const task = !NO_REPO.has(agent.kind);
    const withBrief = Boolean(this.config.brief && task);
    if (this.config.reviewConventions && task) prompts.push(conventionsPrompt({ withBrief, rulesFiles: engine.rulesFiles ?? null }));
    if (withBrief) {
      // Let the agent write its brief without a permission prompt: that one folder only.
      fs.mkdirSync(briefDir(agent.id), { recursive: true });
      const dir = fs.realpathSync(briefDir(agent.id));
      writableDir = dir;
      prompts.push(briefPrompt(path.join(dir, path.basename(briefPath(agent.id)))));
      if (this.config.inbox !== false) prompts.push(questionsPrompt(path.join(dir, path.basename(questionsPath(agent.id)))));
    }
    if (agent.planReview && task) {
      fs.mkdirSync(briefDir(agent.id), { recursive: true });
      const file = path.join(fs.realpathSync(briefDir(agent.id)), path.basename(planPath(agent.id)));
      writableDir ??= path.dirname(file);
      prompts.push(agent.planReview.status === 'approved' ? planApprovedPrompt(file) : planReviewPrompt(file));
    }
    if (planning) prompts.push(planningPrompt(agent));
    // What earlier agents learned in this repo, and the one command to add to it.
    let allowedTools = null;
    if (task && this.config.memory !== false) {
      prompts.push(memoryPrompt(memoryText(memoryKey(agent))));
      allowedTools = [`Bash(${learnCommand()}:*)`];
    }
    if (agent.kind === 'assistant') {
      fs.mkdirSync(assistantDir(), { recursive: true });
      const dir = fs.realpathSync(assistantDir());
      writableDir = dir;
      prompts.push(assistantPrompt(assistantSettings(this.config), dir));
    }
    if (agent.team) {
      // Team members write their handoff files in the team's folder.
      fs.mkdirSync(teamDir(agent.team.id), { recursive: true });
      const dir = fs.realpathSync(teamDir(agent.team.id));
      writableDir = writableDir ? [writableDir, dir] : dir;
      const team = this.store.data.teams?.[agent.team.id];
      if (agent.team.role === 'lead' && team) {
        prompts.push(leadPrompt(team, dir, agent.baseRef));
        agents = subagents(team, dir);
      } else {
        prompts.push(teamPrompt(agent.team.role, dir));
      }
    }
    // Appended system prompts last only for the process they're passed to, so they go on every launch.
    return { extra: engine.extraArgs(this.config), permissionMode: agent.permissionMode, model: agent.model, writableDir, instructions: prompts.join('\n\n') || null, agents, allowedTools };
  }

  /** Spawn the agent's engine in a PTY, reusing its terminal clients and scrollback. */
  spawnAgent(agent, cwd, args, { planning = false } = {}) {
    const engine = engineOf(agent);
    const prev = this.runtimes.get(agent.id) ?? { pty: null, ...loadScrollback(agent.id), restored: true };
    const rt = {
      pty: null,
      planning,
      chunks: prev?.chunks ?? [],
      size: prev?.size ?? 0,
      version: prev?.version ?? 0,
      clients: prev?.clients ?? new Set(),
      cols: prev?.cols ?? 120,
      rows: prev?.rows ?? 34,
      lastOutputAt: null,
      busy: false,
      stopping: false,
      startedAt: Date.now(),
      tail: '',
      attention: null,
    };
    if (prev?.pty === null && rt.size) {
      const note = prev.restored
        ? 'daemon restarted; session resumed'
        : prev.planning && !planning
          ? 'moved into the repository'
          : 'agent restarted';
      this.appendOutput(rt, `\r\n\x1b[2m── ${note} ──\x1b[0m\r\n`);
    }

    if (this.config.trustAgentFolders) {
      try {
        engine.trust(cwd);
      } catch (err) {
        console.error(`[agentmgr] could not pre-trust ${cwd}: ${err.message}`);
      }
    }

    if (!installed(engine, this.config)) {
      const error = notInstalled(engine, this.config);
      this.patch(agent.id, { status: 'error', error });
      throw Object.assign(new Error(error), { status: 400 });
    }
    let proc;
    try {
      proc = pty.spawn(engine.bin(this.config), args, {
        name: 'xterm-256color',
        cols: rt.cols,
        rows: rt.rows,
        cwd,
        env: this.childEnv(agent),
      });
    } catch (err) {
      this.patch(agent.id, { status: 'error', error: `Failed to launch ${engine.bin(this.config)}: ${err.message}` });
      throw err;
    }
    rt.pty = proc;
    this.runtimes.set(agent.id, rt);

    proc.onData((data) => {
      rt.linkScan = true;
      rt.lastOutputAt = Date.now();
      rt.tail = (rt.tail + data).slice(-4000);
      this.appendOutput(rt, data);
      this.broadcast(rt, { t: 'o', d: data });
      if (!rt.busy) {
        rt.busy = true;
        rt.waiting = null;
        rt.screenChecked = false;
        const a = this.store.get(agent.id);
        if (a) this.changed(a);
      }
    });
    proc.onExit(({ exitCode, signal }) => {
      clearTimeout(rt.killTimer);
      rt.pty = null;
      rt.busy = false;
      rt.attention = null;
      this.broadcast(rt, { t: 'exit', code: exitCode, signal });
      const a = this.store.get(agent.id);
      if (!a) return;
      if (rt.planning) {
        // The agent's own status (preparing / ready / error) is about the workspace; leave it.
        this.patch(agent.id, { pid: null });
        return;
      }
      this.patch(agent.id, {
        status: rt.stopping ? 'stopped' : 'exited',
        // Claude exiting by itself (e.g. /exit) is a deliberate close; don't auto-resume it.
        ...(rt.stopping ? {} : { desired: 'stopped' }),
        exitCode,
        pid: null,
        stoppedAt: now(),
      });
      this.refresh(agent.id, { withPrs: true }).catch(() => {});
    });
    return proc;
  }

  // -------------------------------------------------------------- planning

  /**
   * Run a planning session while the workspace is still being prepared: same
   * session ID, in a holding folder, told that the repo is not there yet.
   */
  startPlanning(ref) {
    const agent = this.mustGet(ref);
    if (this.runtimes.get(agent.id)?.pty) return this.view(agent);
    const waiting = agent.status === 'preparing' || (agent.status === 'error' && !agent.workdir);
    if (!waiting) return this.start(agent.id); // workspace is ready: just run the agent there
    if (!engineOf(agent).supports.planHandoff) {
      throw Object.assign(new Error(`Planning while the repo clones isn't available for ${engineOf(agent).label} agents; it starts once the clone is ready`), { status: 409 });
    }
    if (agent.planning?.handedOffAt) {
      throw Object.assign(new Error('This agent already moved into its workspace'), { status: 409 });
    }
    fs.mkdirSync(paths.planning, { recursive: true });
    const sid = agent.sessionId;
    const engine = engineOf(agent);
    const resume = engine.hasSession(paths.planning, sid);
    const args = engine.launchArgs({ ...this.launchOptions(agent, { planning: true }), sessionId: sid, resume, name: agent.name, prompt: resume ? null : agent.intent });
    const proc = this.spawnAgent(agent, paths.planning, args, { planning: true });
    this.patch(agent.id, {
      desired: 'running',
      pid: proc.pid,
      planning: { dir: paths.planning, startedAt: agent.planning?.startedAt ?? now(), ready: false },
    });
    return this.view(this.store.get(agent.id));
  }

  /**
   * Move a planning session into its now-ready workspace. Without `force` it
   * only does so when nobody is looking at the terminal and Claude is idle, so
   * it never yanks the session away mid-conversation; otherwise it flags the
   * agent "ready" and waits for Continue in repo.
   */
  async maybeHandoff(id, { force = false } = {}) {
    const agent = this.store.get(id);
    const rt = this.runtimes.get(id);
    if (!agent?.workdir || agent.status === 'preparing' || !(rt?.pty && rt.planning)) return agent && this.view(agent);
    const idleMs = (this.config.handoffIdleSec ?? 5) * 1000;
    const quiet = !rt.clients.size && !rt.busy && Date.now() - (rt.lastOutputAt ?? 0) >= idleMs;
    if (!force && !quiet) {
      if (!agent.planning?.ready) this.patch(id, { planning: { ...agent.planning, ready: true } });
      return this.view(agent);
    }
    if (this.handingOff?.has(id)) return this.view(agent);
    (this.handingOff ??= new Set()).add(id);
    try {
      await this.stop(id, { keepDesired: true });
      return this.start(id);
    } finally {
      this.handingOff.delete(id);
    }
  }

  /**
   * Close the claude process. Session IDs are kept so it can be resumed later.
   * `keepDesired` is for daemon shutdown: the agent comes back on next start.
   */
  stop(ref, { timeoutMs = 5000, keepDesired = false } = {}) {
    const agent = this.mustGet(ref);
    if (this.runtimes.get(agent.id)?.pty) this.plugins.emit('agent.stopping', { agent: this.auditView(agent) });
    // When it was closed (not a daemon shutdown): clean up counts from here.
    if (!keepDesired) this.patch(agent.id, { desired: 'stopped', closedAt: now(), closedBy: null });
    const rt = this.runtimes.get(agent.id);
    if (!rt?.pty) return Promise.resolve(this.view(agent));
    rt.stopping = true;
    return new Promise((resolve) => {
      const done = rt.pty.onExit(() => {
        done.dispose();
        resolve(this.view(this.store.get(agent.id) ?? agent));
      });
      rt.pty.kill('SIGHUP');
      rt.killTimer = setTimeout(() => rt.pty?.kill('SIGKILL'), timeoutMs);
    });
  }

  /** Daemon shutdown: close everything but remember which agents should come back. */
  async stopAll({ final = false } = {}) {
    // On a real shutdown, a workspace that finishes preparing afterwards must not launch its agent.
    if (final) this.closing = true;
    for (const id of this.shells.keys()) this.closeShell(id);
    await Promise.all(
      [...this.runtimes.entries()].filter(([, rt]) => rt.pty).map(([id]) => this.stop(id, { keepDesired: true })),
    );
  }

  /**
   * Write everything a restart would otherwise lose: each terminal's scrollback,
   * session IDs Claude switched to (e.g. after /clear), token usage, and the
   * state file itself (fsynced). Runs every flushSec, on shutdown and on demand.
   */
  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      let scrollback = 0;
      const live = [...this.runtimes.entries()].filter(([id, rt]) => rt.pty && this.store.get(id));
      for (const [id] of live) await this.refresh(id).catch(() => {});
      fs.mkdirSync(paths.scrollback, { recursive: true });
      for (const [id, rt] of this.runtimes) {
        if (!this.store.get(id) || !rt.size || rt.savedVersion === rt.version) continue;
        const file = scrollbackFile(id);
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, rt.chunks.join(''));
        fs.renameSync(tmp, file);
        rt.savedVersion = rt.version;
        scrollback++;
      }
      this.store.save();
      this.lastFlushAt = now();
      this.emit('flushed', this.lastFlushAt);
      return { at: this.lastFlushAt, agents: this.store.list().length, running: live.length, scrollback };
    })();
    try {
      return await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  /** Bring back every agent that was running when the daemon last stopped. */
  async resumeAll({ staggerMs = 400 } = {}) {
    const resumed = [];
    for (const agent of this.store.list()) {
      const retry = agent.setupInterrupted && !agent.workdir;
      if (agent.desired !== 'running' || (!agent.workdir && !retry) || this.runtimes.get(agent.id)?.pty) continue;
      try {
        this.start(agent.id);
        resumed.push(agent.id);
      } catch (err) {
        this.patch(agent.id, { status: 'error', error: `Auto-resume failed: ${err.message}` });
      }
      await new Promise((r) => setTimeout(r, staggerMs));
    }
    return resumed;
  }

  childEnv(agent) {
    const env = { ...process.env, ...(agent ? { AGENTMGR_AGENT_ID: agent.id } : {}), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const key of STRIP_ENV) delete env[key];
    return env;
  }

  async remove(ref, { deleteWorkspace = false } = {}) {
    const agent = this.mustGet(ref);
    this.plugins.check('agent.remove', { agent: this.auditView(agent), deleteWorkspace });
    this.plugins.emit('agent.removed', { agent: this.auditView(agent), deleteWorkspace });
    const setup = this.preparing.get(agent.id);
    if (setup) {
      // Cancel the clone / checkout; git helpers clean up their partial output.
      setup.controller.abort();
      await setup.done.catch(() => {});
    }
    await this.stop(agent.id);
    const warnings = [];
    if (deleteWorkspace && agent.workdir && agent.sharedWith) {
      warnings.push(`Kept ${agent.workdir}: it belongs to ${this.store.get(agent.sharedWith)?.name ?? 'another agent'}`);
    } else if (deleteWorkspace && agent.workdir) {
      try {
        if (agent.worktree && agent.sourceDir) {
          await git.removeWorktree(agent.sourceDir, agent.workdir);
        } else if (agent.workdir.startsWith(paths.workspaces + path.sep)) {
          fs.rmSync(agent.workdir, { recursive: true, force: true });
        } else {
          warnings.push(`Kept ${agent.workdir}: it is a folder you provided, not one agentmgr created`);
        }
      } catch (err) {
        warnings.push(err.message);
      }
    }
    this.closeShell(agent.id);
    if (agent.workdir && fs.existsSync(agent.workdir)) await git.deleteRefs(agent.workdir, `refs/agentmgr/${agent.id}/`).catch(() => {});
    else if (agent.sourceDir && fs.existsSync(agent.sourceDir)) await git.deleteRefs(agent.sourceDir, `refs/agentmgr/${agent.id}/`).catch(() => {});
    this.changeSets.delete(agent.id);
    for (const k of this.clashVerdicts.keys()) if (k.split('|').includes(agent.id)) this.clashVerdicts.delete(k);
    this.stuck.delete(agent.id);
    this.outbox.delete(agent.id);
    this.recomputeConflicts();
    fs.rmSync(briefDir(agent.id), { recursive: true, force: true });
    fs.rmSync(scrollbackFile(agent.id), { force: true });
    fs.rmSync(path.join(paths.uploads, agent.id), { recursive: true, force: true });
    for (const rt of this.shells.get(agent.id)?.values() ?? []) for (const client of rt.clients) client.close?.();
    this.shells.delete(agent.id);
    for (const key of this.cursors.keys()) {
      if (agent.sessions.some((s) => key.startsWith(`${s.id}:`) || key.includes(`/${s.id}/subagents/`))) {
        this.cursors.delete(key);
      }
    }
    for (const client of this.runtimes.get(agent.id)?.clients ?? []) client.close?.();
    this.runtimes.delete(agent.id);
    this.store.remove(agent.id);
    this.emit('removed', agent.id);
    return { id: agent.id, warnings };
  }

  update(ref, fields) {
    const agent = this.mustGet(ref);
    const bad = (m) => Object.assign(new Error(m), { status: 400 });
    const allowed = {};
    for (const key of ['notes']) if (key in fields) allowed[key] = fields[key];
    if ('name' in fields) {
      const name = String(fields.name ?? '').trim();
      if (!name) throw bad('Name is required');
      allowed.name = name.slice(0, 80);
    }
    // The request as recorded; the session only hears about a change when told.
    if ('intent' in fields) {
      const intent = String(fields.intent ?? '').trim();
      if (!intent && !NO_REPO.has(agent.kind)) throw bad('The request is required');
      allowed.intent = intent;
    }
    // Permission mode and model apply from the next launch.
    if ('permissionMode' in fields) {
      const mode = fields.permissionMode || null;
      const modes = engineOf(agent).permissionModes;
      if (mode && !modes.includes(mode)) throw bad(`${engineOf(agent).label} has no "${mode}" mode (use ${modes.join(', ')})`);
      allowed.permissionMode = mode;
    }
    if ('model' in fields) allowed.model = String(fields.model ?? '').trim() || null;
    // Keep: clean up never closes or deletes it.
    if ('keep' in fields) allowed.keep = Boolean(fields.keep);
    if ('budgetUsd' in fields) {
      // Its own spending limit in US dollars; empty for the default (budgets.perAgentUsd).
      const raw = fields.budgetUsd;
      const b = raw === null || raw === '' ? null : Number(raw);
      if (b !== null && !(Number.isFinite(b) && b > 0)) throw Object.assign(new Error('budgetUsd must be a positive number of dollars, or empty'), { status: 400 });
      allowed.budgetUsd = b === null ? null : Math.round(b * 100) / 100;
      allowed.budgetHit = null;
    }
    if ('priority' in fields) {
      const p = parsePriority(fields.priority, null);
      if (p === null) throw Object.assign(new Error('priority must be P0, P1, P2 or P3'), { status: 400 });
      allowed.priority = p;
    }
    // Move: under a known project (shortcut or name), under a new project name, or back to its own ("").
    if ('project' in fields) {
      if (NO_REPO.has(agent.kind)) throw bad(`A ${agent.kind} session has no project`);
      const ref = String(fields.project ?? '').trim();
      const entry = ref ? this.resolveProject(ref) : null;
      if (!ref) Object.assign(allowed, { project: null, projectMove: null });
      else if (entry && entry.key !== projectOf({ ...agent, project: null, projectMove: null }).key) {
        // Its full name (org/repo), as the project's own agents show it.
        const info = this.store.list().map((a) => (a.projectMove ? null : projectOf(a))).find((i) => i?.key === entry.key);
        Object.assign(allowed, { project: null, projectMove: { key: entry.key, name: entry.name, ...(info?.full ? { full: info.full } : {}), at: now() } });
      } else if (entry) Object.assign(allowed, { project: null, projectMove: null });
      else Object.assign(allowed, { project: ref.slice(0, 60), projectMove: null });
    }
    if ('intent' in allowed) {
      const refs = extractRefs(allowed.intent, this.config.bugPatterns);
      const bugs = { ...(agent.bugs ?? {}) };
      for (const b of refs.bugs) bugs[b.key] ??= { ...b, source: 'intent' };
      allowed.bugs = bugs;
    }
    return this.view(this.patch(agent.id, allowed));
  }

  // --------------------------------------------------------------- terminal

  appendOutput(rt, data) {
    rt.version = (rt.version ?? 0) + 1;
    rt.chunks.push(data);
    rt.size += data.length;
    const max = this.config.scrollbackBytes;
    while (rt.size > max && rt.chunks.length > 1) rt.size -= rt.chunks.shift().length;
  }

  broadcast(rt, msg) {
    for (const client of rt.clients) client.send(msg);
  }

  /** Attach a terminal client ({ send(msg), close() }). Returns the scrollback and a detach fn. */
  attach(ref, client) {
    const agent = this.mustGet(ref);
    this.plugins.check('terminal.open', { agent: this.auditView(agent), kind: 'claude' });
    let rt = this.runtimes.get(agent.id);
    if (!rt) {
      rt = { pty: null, ...loadScrollback(agent.id), restored: true, clients: new Set(), cols: 120, rows: 34 };
      this.runtimes.set(agent.id, rt);
    }
    rt.clients.add(client);
    this.changed(agent);
    return {
      backlog: rt.chunks.join(''),
      running: Boolean(rt.pty),
      detach: () => {
        rt.clients.delete(client);
        const a = this.store.get(agent.id);
        if (a) this.changed(a);
      },
    };
  }

  /** The runtime behind a terminal kind: 'claude', or 'shell' / 'shell:N' for shell N (default 1). */
  termRuntime(id, kind) {
    const n = shellNumber(kind);
    return n ? this.shells.get(id)?.get(n) : this.runtimes.get(id);
  }

  write(id, data, kind = 'claude') {
    // Focus reports and terminal replies are not you typing.
    if (!/^(\x1b\[[\d;?>]*[IOcRnt])+$/.test(data)) this.inputAt.set(id, Date.now());
    this.termRuntime(id, kind)?.pty?.write(data);
  }

  resize(id, cols, rows, kind = 'claude') {
    const rt = this.termRuntime(id, kind);
    if (!rt || !(cols > 0 && rows > 0)) return;
    rt.cols = cols;
    rt.rows = rows;
    try {
      rt.pty?.resize(cols, rows);
    } catch {}
  }

  // ------------------------------------------------------- ancillary shells

  /** The agent's shells (number -> runtime), created on first use. */
  shellsOf(agentId) {
    let m = this.shells.get(agentId);
    if (!m) this.shells.set(agentId, (m = new Map()));
    return m;
  }

  /** Numbers of the agent's shells that are running, ascending. */
  shellNumbers(agentId) {
    return [...(this.shells.get(agentId)?.entries() ?? [])].filter(([, rt]) => rt.pty).map(([n]) => n).sort((a, b) => a - b);
  }

  /** Start (if needed) login shell number `n` in the agent's folder, for running commands by hand. */
  openShell(ref, n = 1) {
    // The machine terminal: a shell in the home folder, not tied to any agent.
    const agent = ref === MACHINE ? { id: MACHINE, workdir: os.homedir(), machine: true } : this.mustGet(ref);
    const shells = this.shellsOf(agent.id);
    const prev = shells.get(n);
    if (prev?.pty) return prev;
    if (!agent.workdir || !fs.existsSync(agent.workdir)) {
      throw Object.assign(new Error('The working folder is not ready yet'), { status: 409 });
    }
    const rt = {
      pty: null,
      chunks: prev?.chunks ?? [],
      size: prev?.size ?? 0,
      clients: prev?.clients ?? new Set(),
      cols: prev?.cols ?? 120,
      rows: prev?.rows ?? 34,
    };
    if (rt.size) this.appendOutput(rt, '\r\n\x1b[2m── new shell ──\x1b[0m\r\n');
    const proc = pty.spawn(this.config.shell, ['-l'], {
      name: 'xterm-256color',
      cols: rt.cols,
      rows: rt.rows,
      cwd: agent.workdir,
      env: this.childEnv(agent.machine ? null : agent),
    });
    rt.pty = proc;
    shells.set(n, rt);
    proc.onData((data) => {
      rt.linkScan = true;
      this.appendOutput(rt, data);
      this.broadcast(rt, { t: 'o', d: data });
    });
    proc.onExit(({ exitCode }) => {
      rt.pty = null;
      this.broadcast(rt, { t: 'exit', code: exitCode });
      const a = this.store.get(agent.id);
      if (a) this.changed(a);
    });
    if (!agent.machine) this.changed(agent);
    return rt;
  }

  /** Lowest shell number the agent isn't using. */
  nextShellNumber(agentId) {
    const used = new Set(this.shellNumbers(agentId));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  attachShell(ref, client, n = 1) {
    const agent = ref === MACHINE ? { id: MACHINE } : this.mustGet(ref);
    this.plugins.check('terminal.open', ref === MACHINE ? { agent: null, kind: 'machine' } : { agent: this.auditView(agent), kind: `shell:${n}` });
    const rt = this.openShell(agent.id, n);
    rt.clients.add(client);
    return {
      backlog: rt.chunks.join(''),
      running: true,
      detach: () => rt.clients.delete(client),
    };
  }

  /** Close one shell, or all of the agent's shells when `n` is omitted. */
  closeShell(ref, n) {
    const id = this.store.resolve(ref)?.id ?? ref;
    for (const [num, rt] of this.shells.get(id) ?? []) {
      if (n === undefined || num === n) rt.pty?.kill('SIGHUP');
    }
    return { ok: true };
  }

  /** Forget a closed shell's scrollback so its tab goes away. */
  dropShell(ref, n) {
    const id = this.store.resolve(ref)?.id ?? ref;
    const rt = this.shells.get(id)?.get(n);
    if (rt?.pty) rt.pty.kill('SIGHUP');
    for (const client of rt?.clients ?? []) client.close?.();
    this.shells.get(id)?.delete(n);
    const a = this.store.get(id);
    if (a) this.changed(a);
    return { ok: true };
  }

  // --------------------------------------------------------------- browser tabs

  /** Open a browser tab on an address (kept with the agent, so other devices see it too). */
  /**
   * Browser tabs: { n, url, mode } where mode "live" is a real browser on this machine streamed
   * to the tab, and "lite" loads the page in a frame (relayed to other devices). `raw` keeps an
   * address the browser itself reported (a popup's about:blank, a file: page) as it is.
   */
  addBrowser(ref, input, { mode, raw = false } = {}) {
    const agent = this.mustGet(ref);
    const url = raw ? String(input) : parseUrl(input).href;
    const tabs = agent.browsers ?? [];
    let n = 1;
    while (tabs.some((t) => t.n === n)) n++;
    const tab = { n, url, ...(mode === 'live' || mode === 'lite' ? { mode } : {}) };
    this.patch(agent.id, { browsers: [...tabs, tab] });
    return tab;
  }

  setBrowser(ref, n, input, { mode, raw = false } = {}) {
    const agent = this.mustGet(ref);
    const cur = (agent.browsers ?? []).find((t) => t.n === n);
    if (!cur) throw Object.assign(new Error(`No browser tab ${n}`), { status: 404 });
    const url = input === undefined ? cur.url : raw ? String(input) : parseUrl(input).href;
    const tab = { ...cur, url, ...(mode === 'live' || mode === 'lite' ? { mode } : {}) };
    if (JSON.stringify(tab) !== JSON.stringify(cur)) this.patch(agent.id, { browsers: agent.browsers.map((t) => (t.n === n ? tab : t)) });
    return tab;
  }

  dropBrowser(ref, n) {
    const agent = this.mustGet(ref);
    this.patch(agent.id, { browsers: (agent.browsers ?? []).filter((t) => t.n !== n) });
    return { ok: true };
  }

  /** Local addresses the agent's session or shells printed recently, as suggestions. */
  localUrls(ref) {
    const agent = this.mustGet(ref);
    const tail = (rt) => (rt?.chunks ?? []).join('').slice(-200_000);
    const text = [...(this.shells.get(agent.id)?.values() ?? [])].map(tail).join('\n') + '\n' + tail(this.runtimes.get(agent.id));
    return findLocalUrls(text);
  }

  // --------------------------------------------------- sign-in links (CLI OAuth)

  /**
   * Terminals that printed something since the last look: a CLI's sign-in link (`railway login`,
   * `gh auth login --web`...) is raised so the UI can open it in a real browser window. Sign-in
   * pages refuse to show inside another page, and their callback goes to a port on this machine.
   */
  scanSignIns() {
    const look = (agentId, rt, terminal) => {
      if (!rt?.linkScan) return;
      rt.linkScan = false;
      const [link] = findSignInLinks(rt.chunks.join('').slice(-12_000), rt.cols);
      if (link) this.raiseSignIn(agentId, link, terminal);
    };
    for (const [id, rt] of this.runtimes) look(id, rt, engineOf(this.store.get(id) ?? {}).label);
    for (const [id, shells] of this.shells) for (const [n, rt] of shells) look(id, rt, `Shell ${n}`);
  }

  raiseSignIn(agentId, link, terminal) {
    const seen = this.seenLinks.get(agentId) ?? new Set();
    this.seenLinks.set(agentId, seen);
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    this.signIns.set(agentId, { ...link, terminal, at: now(), finished: null });
    const a = this.store.get(agentId);
    if (a) this.changed(a);
    return true;
  }

  /** The sign-in link the person should open, for 15 minutes (a CLI waits about that long). */
  signInView(agent) {
    const s = this.signIns.get(agent.id);
    if (!s || Date.now() - Date.parse(s.at) > 15 * 60_000) return null;
    return s;
  }

  /** A sign-in link pasted into a browser tab: raise it like one a terminal printed. */
  addSignIn(ref, url) {
    const agent = this.mustGet(ref);
    const [link] = findSignInLinks(String(url ?? ''));
    if (!link) throw Object.assign(new Error('That is not a sign-in link that returns to this machine'), { status: 400 });
    this.seenLinks.get(agent.id)?.delete(link.url);
    this.raiseSignIn(agent.id, link, 'Browser');
    return this.view(this.store.get(agent.id));
  }

  dismissSignIn(ref) {
    const agent = this.mustGet(ref);
    this.signIns.delete(agent.id);
    this.changed(agent);
    return this.view(agent);
  }

  /**
   * Finish a sign-in from another device: after approving, that device's browser lands on the
   * CLI's callback (http://127.0.0.1:PORT/...), which only exists on this machine. The person
   * pastes that address and it is requested here, only on the port the link named.
   */
  async finishSignIn(ref, input) {
    const agent = this.mustGet(ref);
    const s = this.signInView(agent);
    if (!s) throw Object.assign(new Error('No sign-in is waiting for this agent'), { status: 409 });
    const u = parseCallback(input, s.port);
    if (!u) throw Object.assign(new Error(`Paste the address your browser landed on; it starts with ${s.callback}`), { status: 400 });
    const { default: http } = await import(u.protocol === 'https:' ? 'node:https' : 'node:http');
    const result = await new Promise((resolve) => {
      const req = http.get(u, { timeout: 10_000, rejectUnauthorized: false }, (res) => {
        let body = '';
        res.on('data', (d) => body.length < 4000 && (body += d));
        res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, text: body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) }));
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (e) => resolve({ ok: false, status: 0, text: e.code === 'ECONNREFUSED' ? 'Nothing is listening there any more; the CLI may have timed out. Run the login again.' : e.message }));
    });
    this.signIns.set(agent.id, { ...s, finished: { ...result, at: now() } });
    this.changed(agent);
    return this.view(this.store.get(agent.id));
  }

  // ------------------------------------------------- sessions started elsewhere

  /** Claude Code sessions started outside AI Agent Manager (in a terminal), to continue here. */
  scanSessions({ days = 30 } = {}) {
    const known = new Set(this.store.list().flatMap((a) => a.sessions.map((x) => x.id)));
    return scanClaudeSessions({ days: Math.max(1, Math.min(365, Number(days) || 30)), known, excludeDir: paths.home });
  }

  /**
   * Continue sessions as agents, in the folder each ran in. One still open in a terminal is
   * refused (two places writing one conversation mixes it up) unless `copy`: then the agent
   * continues a copy under a new session ID and the terminal keeps the original.
   */
  importSessions(list, { start = true, copy = false } = {}) {
    const wanted = new Set((Array.isArray(list) ? list : []).map((x) => String(x?.sessionId ?? x)));
    if (!wanted.size) throw Object.assign(new Error('Pick at least one session'), { status: 400 });
    const found = this.scanSessions({ days: 365 }).filter((x) => wanted.has(x.sessionId));
    const out = [];
    for (const s of found) {
      if (!s.exists) {
        out.push({ sessionId: s.sessionId, error: `Its folder ${s.cwd} no longer exists` });
        continue;
      }
      if (s.inUse && !copy) {
        out.push({ sessionId: s.sessionId, error: 'Still open in a terminal: close it there first, or continue a copy' });
        continue;
      }
      let sessionId = s.sessionId;
      if (s.inUse) {
        sessionId = crypto.randomUUID();
        ENGINES.claude.copySession({ fromCwd: s.cwd, toCwd: s.cwd, fromId: s.sessionId, toId: sessionId });
      }
      const intent = (s.title && s.title.length > 8 ? s.title : s.firstAsk).replace(/\s+/g, ' ').slice(0, 300);
      const agent = this.create({
        intent,
        dir: s.cwd,
        worktree: false,
        engine: 'claude',
        start,
        sessionId,
        imported: { from: 'terminal', sessionId: s.sessionId, copy: sessionId !== s.sessionId, at: now() },
      });
      out.push({ sessionId: s.sessionId, agentId: agent.id, name: agent.name });
    }
    for (const id of wanted) if (!found.some((x) => x.sessionId === id)) out.push({ sessionId: id, error: 'No such session (or it belongs to an agent already)' });
    return out;
  }

  /** Save a file the user attached in the UI, so its path can be handed to Claude. */
  saveUpload(ref, name, data) {
    const agent = this.mustGet(ref);
    const safe = path.basename(String(name || 'file')).replace(/[^\w.@+-]+/g, '_').slice(-120) || 'file';
    const dir = path.join(paths.uploads, agent.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safe}`);
    fs.writeFileSync(file, data);
    return { path: file, size: data.length };
  }

  // --------------------------------------------------------------- tracking

  addLink(ref, { type, value, title }) {
    const agent = this.mustGet(ref);
    value = (value ?? '').trim();
    if (!value) throw Object.assign(new Error('Link value is required'), { status: 400 });
    if (type === 'pr') {
      const pr = { ...prFromUrl(value, 'manual'), ...(title ? { title } : {}) };
      agent.prs[pr.url] = { ...agent.prs[pr.url], ...pr };
      agent.dismissed = agent.dismissed.filter((k) => k !== pr.url);
    } else if (type === 'bug') {
      const bug = { ...bugFromRef(value, 'manual'), ...(title ? { title } : {}) };
      agent.bugs[bug.key] = { ...agent.bugs[bug.key], ...bug };
      agent.dismissed = agent.dismissed.filter((k) => k !== bug.key);
    } else {
      throw Object.assign(new Error('type must be "pr" or "bug"'), { status: 400 });
    }
    this.store.save();
    this.changed(agent);
    if (type === 'pr') this.refresh(agent.id, { withPrs: true }).catch(() => {});
    return this.view(agent);
  }

  removeLink(ref, { type, key }) {
    const agent = this.mustGet(ref);
    const bag = type === 'pr' ? agent.prs : agent.bugs;
    if (bag[key]) {
      delete bag[key];
      if (!agent.dismissed.includes(key)) agent.dismissed.push(key);
      this.store.save();
      this.changed(agent);
    }
    return this.view(agent);
  }

  mergeLinks(agent, bag, items, keyOf) {
    let changed = false;
    for (const item of items) {
      const key = keyOf(item);
      if (!key || agent.dismissed.includes(key)) continue;
      const cur = bag[key];
      if (!cur) {
        bag[key] = item;
        changed = true;
        continue;
      }
      const merged = { ...cur };
      for (const [k, v] of Object.entries(item)) {
        if (k === 'source') continue;
        if (v != null && merged[k] !== v) merged[k] = v;
      }
      if ((SOURCE_RANK[item.source] ?? 0) > (SOURCE_RANK[cur.source] ?? 0)) merged.source = item.source;
      if (JSON.stringify(merged) !== JSON.stringify(cur)) {
        bag[key] = merged;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Claude may switch to a new session ID mid-run (e.g. /clear). Adopt a new
   * transcript in this agent's folder if nothing else claims it.
   */
  adoptSessions(agent) {
    const rt = this.runtimes.get(agent.id);
    if (!rt?.pty) return false;
    const known = new Set(this.store.list().flatMap((a) => a.sessions.map((s) => s.id)));
    const engine = engineOf(agent);
    const candidates = engine.recentSessions(agent.workdir, rt.startedAt - 1000).filter((f) => !known.has(f.sessionId));
    if (candidates.length !== 1) return false;
    const [cand] = candidates;
    // Not someone else's: a headless run (claude -p) in this folder, or a session a claude in a
    // terminal has open (or may have: a plain claude running in this same folder).
    if (agent.engine === 'claude' || !agent.engine) {
      try {
        const fd = fs.openSync(engine.sessionFile(agent.workdir, cand.sessionId), 'r');
        const buf = Buffer.alloc(8192);
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        if (/"entrypoint":"(?!cli")/.test(buf.toString('utf8'))) return false;
      } catch {}
      const running = runningClaude();
      let here = agent.workdir;
      try {
        here = fs.realpathSync(agent.workdir);
      } catch {}
      if (running.ids.has(cand.sessionId) || running.cwds.has(here) || running.cwds.has(agent.workdir)) return false;
    }
    let currentMtime = 0;
    try {
      currentMtime = fs.statSync(engine.sessionFile(agent.workdir, agent.sessionId)).mtimeMs;
    } catch {}
    if (currentMtime > cand.mtimeMs) return false;
    agent.sessions.push({ id: cand.sessionId, createdAt: now(), starts: 1, lastStartedAt: now(), adopted: true });
    agent.sessionId = cand.sessionId;
    return true;
  }

  /** Pick up changes to the agent's brief file. */
  reloadBrief(id) {
    const agent = this.store.get(id);
    if (!agent) return;
    const brief = loadBrief(id, agent.brief);
    if (brief) {
      this.patch(id, { brief });
      // The agent says it is done: have the judge check the work before the person looks.
      if (brief.status === 'done' && agent.brief?.status !== 'done' && this.judge.enabled) this.requestReview(id, { trigger: 'brief' }).catch(() => {});
    }
    if (agent.planReview) {
      const file = loadPlanFile(id, agent.planReview);
      // A new or revised plan waits for review again, unless it was already approved (then it's a progress update).
      if (file) this.patch(id, { planReview: { ...agent.planReview, ...file, status: agent.planReview.status === 'approved' ? 'approved' : 'review' } });
    }
  }

  // -------------------------------------------------------------- plan review

  /** Approve the plan (optionally with notes); the agent starts implementing. */
  approvePlan(ref, note, { force = false } = {}) {
    const agent = this.mustGet(ref);
    if (!agent.planReview || agent.planReview.status === 'approved' || (!force && agent.planReview.status !== 'review')) throw Object.assign(new Error('There is no plan waiting for review'), { status: 409 });
    this.patch(agent.id, { planReview: { ...agent.planReview, status: 'approved', decidedAt: now(), note: note?.trim() || null } });
    return this.tell(agent.id, `Plan approved. Go ahead and implement it.${note?.trim() ? `\n\nNotes from the review:\n${note.trim()}` : ''}`);
  }

  /** Send the plan back with what to change; the agent revises PLAN.md and waits again. */
  requestPlanChanges(ref, note) {
    const agent = this.mustGet(ref);
    if (!agent.planReview || agent.planReview.status === 'approved') throw Object.assign(new Error('There is no plan waiting for review'), { status: 409 });
    if (!note?.trim()) throw Object.assign(new Error('Say what should change'), { status: 400 });
    this.patch(agent.id, { planReview: { ...agent.planReview, status: 'changes', decidedAt: now(), note: note.trim() } });
    return this.tell(agent.id, `Plan changes requested. Revise the plan file and wait for approval again:\n${note.trim()}`);
  }

  /** Turn plan review on (before the agent has implemented anything) or off (no longer waits). */
  setPlanReview(ref, on) {
    const agent = this.mustGet(ref);
    if (on && !agent.planReview) {
      this.patch(agent.id, { planReview: { status: 'writing' } });
      const file = path.join(briefDir(agent.id), path.basename(planPath(agent.id)));
      fs.mkdirSync(briefDir(agent.id), { recursive: true });
      // A running session got its instructions at launch; tell it now.
      if (this.runtimes.get(agent.id)?.pty) return this.tell(agent.id, `Change of process: ${planReviewPrompt(file)} If you already changed files, list them in the plan.`);
    }
    if (!on && agent.planReview && agent.planReview.status !== 'approved') return this.approvePlan(agent.id, null, { force: true });
    return this.view(this.store.get(agent.id));
  }

  /**
   * Plain-language explanation of the intent and the brief's problem / solution, from a
   * separate one-shot Claude call with no tools and no MCP servers. The agent's own
   * session is never touched, so this never interrupts or adds context to its work.
   */
  explain(ref) {
    return this.summarize(ref, 'explain');
  }

  /** Why / What / How / Now in three tidy points each. */
  insights(ref) {
    return this.summarize(ref, 'insights');
  }

  /**
   * At most `summaryConcurrency` one-off Claude calls (documents, explain,
   * insights) at once; the rest wait. Resolves to a release function.
   */
  summarySlot() {
    this.summaryRunning ??= 0;
    this.summaryQueue ??= [];
    const max = this.config.summaryConcurrency ?? 2;
    const release = () => {
      this.summaryRunning--;
      this.summaryQueue.shift()?.();
    };
    if (this.summaryRunning < max) {
      this.summaryRunning++;
      return Promise.resolve(release);
    }
    return new Promise((resolve) =>
      this.summaryQueue.push(() => {
        this.summaryRunning++;
        resolve(release);
      }),
    );
  }

  /** Start one or more summaries without waiting; returns the agent view right away. */
  summarizeInBackground(ref, kinds) {
    const agent = this.mustGet(ref);
    for (const kind of kinds) {
      if (!SUMMARIES[kind]) throw Object.assign(new Error(`Unknown document "${kind}"`), { status: 400 });
    }
    for (const kind of kinds) this.summarize(agent.id, kind).catch(() => {}); // errors are stored on the agent
    return this.view(this.store.get(agent.id));
  }

  /** A stakeholder document: analysis, design, flow or proposal. */
  document(ref, kind) {
    if (!SUMMARIES[kind]?.doc) throw Object.assign(new Error(`Unknown document "${kind}"`), { status: 400 });
    return this.summarize(ref, kind);
  }

  summarize(ref, kind) {
    const agent = this.mustGet(ref);
    this.explaining ??= new Map();
    const key = `${kind}:${agent.id}`;
    if (this.explaining.has(key)) return this.explaining.get(key);
    this.patch(agent.id, summaryPatch(agent, kind, { ...getSummary(agent, kind), pending: true, error: null }));
    const run = this.summarySlot()
      .then((release) =>
        this.explainContext(agent)
          .then((ctx) => (SUMMARIES[kind].run ? this[SUMMARIES[kind].run](agent, ctx) : this.runExplain(agent, { ...ctx, agentName: agent.name }, kind)))
          .finally(release),
      )
      .catch((e) => {
        const cur = this.store.get(agent.id);
        if (cur) this.patch(agent.id, summaryPatch(cur, kind, { ...getSummary(cur, kind), pending: false, error: e.message }));
        throw e;
      })
      .finally(() => this.explaining.delete(key));
    this.explaining.set(key, run);
    return run;
  }

  /** What the agent is actually doing: its session, repo changes, live status and brief. */
  async explainContext(agent) {
    const v = this.view(agent);
    const file = briefPath(agent.id);
    const briefMarkdown = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const planningOnly = agent.planning && !agent.planning.handedOffAt && !agent.workdir;
    const sessionDir = planningOnly ? agent.planning.dir : agent.workdir;
    const engine = engineOf(agent);
    const { digest } = sessionDir ? engine.digest(engine.sessionFile(sessionDir, agent.sessionId)) : { digest: '' };
    const phase = v.runtime.planning ? 'planning while the workspace is prepared' : agent.status;
    const status = [
      `status: ${phase}${v.runtime.running ? (v.runtime.busy ? ' (working right now)' : ' (idle, waiting for the next instruction)') : ''}`,
      `priority: P${agent.priority ?? 2}`,
      v.runtime.attention ? `blocked on: ${v.runtime.attention} (waiting for the user to answer in the terminal)` : null,
      v.runtime.waiting ? `seems to be waiting on the user: ${v.runtime.waiting.summary}` : null,
      agent.error ? `error: ${agent.error}` : null,
      `last activity: ${v.runtime.lastOutputAt ?? agent.sessions.find((s) => s.id === agent.sessionId)?.lastActivity ?? 'unknown'}`,
      agent.repo ? `repo: ${agent.repo}` : null,
      agent.git?.branch ? `branch: ${agent.git.branch}${agent.baseRef ? ` (branched from ${agent.baseRef})` : ''}` : null,
      v.prs.length ? `PRs: ${v.prs.map((p) => `${p.url}${p.state ? ` [${p.state}]` : ''}${p.title ? ` ${p.title}` : ''}`).join('; ')}` : null,
      v.bugs.length ? `issues: ${v.bugs.map((b) => b.key).join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    let repo = '';
    if (agent.workdir) {
      const sha = agent.baseRef?.split(' @ ')[1];
      const ch = await git.changeSummary(agent.workdir, sha).catch(() => null);
      if (ch) {
        repo = [
          ch.commits.length ? `commits since branching:\n${ch.commits.join('\n')}` : 'no commits since branching',
          ch.uncommitted.length ? `uncommitted changes:\n${ch.uncommitted.join('\n')}` : 'no uncommitted changes',
          ch.diffstat ? `diffstat:\n${ch.diffstat}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');
      }
    }
    return { intent: agent.intent, status, digest, repo, briefMarkdown };
  }

  /** The engine (and model) that writes an agent's summaries: its own when it can make a one-shot call, else Claude Code. */
  writerFor(agent) {
    const engine = engineOf(agent).supports.oneShot ? engineOf(agent) : engineOf(DEFAULT_ENGINE);
    return { engine, model: engine.id === DEFAULT_ENGINE ? this.config.explainModel : this.config.engines?.[engine.id]?.explainModel };
  }

  /**
   * Who double-checks the writer: `critique: { engine, model }` from config.json if set, else
   * another installed engine (a different provider sees different things), else the same
   * engine with another model.
   */
  criticFor(writer) {
    const pick = this.config.critique ?? {};
    const usable = (e) => e?.supports.oneShot && installed(e, this.config);
    if (pick.engine && usable(ENGINES[pick.engine])) return { engine: ENGINES[pick.engine], model: pick.model ?? this.config.engines?.[pick.engine]?.explainModel };
    const other = Object.values(ENGINES).find((e) => e.id !== writer.engine.id && usable(e));
    if (other) return { engine: other, model: other.id === DEFAULT_ENGINE ? this.config.explainModel : this.config.engines?.[other.id]?.explainModel };
    if (writer.engine.id === DEFAULT_ENGINE) return { engine: writer.engine, model: pick.model ?? (/opus/i.test(writer.model ?? '') ? 'sonnet' : 'opus') };
    return { engine: writer.engine, model: pick.model ?? writer.model };
  }

  runExplain(agent, ctx, kind = 'explain') {
    const { prompt } = SUMMARIES[kind];
    return this.oneShot(agent, prompt(ctx), this.writerFor(agent)).then((markdown) => {
      const cur = this.store.get(agent.id);
      if (!cur) return null;
      return this.view(
        this.patch(
          agent.id,
          summaryPatch(cur, kind, { markdown, at: now(), briefUpdatedAt: cur.brief?.updatedAt ?? null, pending: false, error: null }),
        ),
      );
    });
  }

  /** One tool-less, read-only call to an engine; resolves to its text output. */
  oneShot(agent, text, { engine, model, timeoutMs = 300_000 }) {
    // Some engines take the prompt as an argument instead of on stdin.
    const args = [...engine.extraArgs(this.config), ...engine.oneShotArgs(this.config, { model, prompt: text })];
    return new Promise((resolve, reject) => {
      const child = spawn(engine.bin(this.config), args, { cwd: paths.home, env: this.childEnv(agent), stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && out.trim()) resolve(out.trim());
        else reject(new Error(`${engine.label} one-shot call failed (exit ${code}): ${(err || out).trim().slice(-300)}`));
      });
      child.stdin.end(engine.oneShotStdin === false ? '' : text);
    });
  }

  /** Human vs AI: the writer splits and answers the open questions, then another model double-checks it. */
  async runHumanAi(agent, ctx) {
    const writer = this.writerFor(agent);
    const data = parseJsonReply(await this.oneShot(agent, humanAiPrompt(ctx), writer));
    if (!Array.isArray(data.human) || !Array.isArray(data.ai)) throw new Error('The reply was missing the "human" or "ai" list');
    data.human = data.human.slice(0, 5);
    data.ai = data.ai.slice(0, 5);
    const critic = this.criticFor(writer);
    const label = `${critic.engine.label}${critic.model ? ` (${critic.model})` : ''}`;
    let critique;
    try {
      critique = { label, data: parseJsonReply(await this.oneShot(agent, critiquePrompt(ctx, data), critic)) };
    } catch (err) {
      critique = { label, error: err.message.slice(0, 300) };
    }
    const cur = this.store.get(agent.id);
    if (!cur) return null;
    const doc = { data, critique, answers: {}, writer: `${writer.engine.label}${writer.model ? ` (${writer.model})` : ''}` };
    return this.view(
      this.patch(
        agent.id,
        summaryPatch(cur, 'humanai', { ...doc, markdown: humanAiMarkdown(doc), at: now(), briefUpdatedAt: cur.brief?.updatedAt ?? null, pending: false, error: null }),
      ),
    );
  }

  /** Keep the person's answers to the Human vs AI questions; with `send`, also tell the agent. */
  humanAiAnswers(ref, answers, { send = false } = {}) {
    const agent = this.mustGet(ref);
    const doc = agent.docs?.humanai;
    if (!doc?.data) throw Object.assign(new Error('Write the Human vs AI review first'), { status: 409 });
    const clean = {};
    for (const [i, v] of Object.entries(answers ?? {})) if (doc.data.human[Number(i)] && typeof v === 'string') clean[i] = v.slice(0, 4000);
    const next = { ...doc, answers: clean };
    next.markdown = humanAiMarkdown(next);
    this.patch(agent.id, summaryPatch(agent, 'humanai', next));
    if (send) {
      if (!Object.values(clean).some((v) => v.trim())) throw Object.assign(new Error('Answer at least one question first'), { status: 400 });
      return this.tell(agent.id, humanAiMessage(next));
    }
    return this.view(this.store.get(agent.id));
  }

  briefFile(ref) {
    const agent = this.mustGet(ref);
    const file = briefPath(agent.id);
    return { path: file, markdown: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null };
  }

  async refresh(ref, { withPrs = false } = {}) {
    const id = this.mustGet(ref).id;
    const running = this.refreshing.get(id);
    if (running) {
      if (!withPrs) return running.promise.then(() => this.store.get(id) && this.view(this.store.get(id)));
      // A pull request check runs again after the one in progress, which may have read PRs from
      // before this request; callers arriving meanwhile share that next run.
      running.next ??= running.promise.catch(() => {}).then(() => this.refresh(id, { withPrs }));
      return running.next;
    }
    // Cleared before anyone waiting on it continues, so the next run starts afresh.
    const entry = { withPrs };
    entry.promise = this.doRefresh(id, { withPrs }).finally(() => {
      if (this.refreshing.get(id) === entry) this.refreshing.delete(id);
    });
    this.refreshing.set(id, entry);
    return entry.promise;
  }

  async doRefresh(id, { withPrs }) {
    this.reloadBrief(id);
    const agent = this.store.get(id);
    // Before handoff, a planning session's transcript lives in the planning folder.
    const planningOnly = agent?.planning && !agent.planning.handedOffAt && !agent.workdir;
    const sessionDir = planningOnly ? agent.planning.dir : agent?.workdir;
    if (!sessionDir) return agent && this.view(agent);
    let changed = agent.workdir ? this.adoptSessions(agent) : false;

    const info = agent.workdir ? await git.gitInfo(agent.workdir) : agent.git;
    if (!this.store.get(id)) return null;
    if (info !== undefined && JSON.stringify({ ...info, updatedAt: 0 }) !== JSON.stringify({ ...agent.git, updatedAt: 0 })) {
      agent.git = info;
      changed = true;
    }

    const engine = engineOf(agent);
    for (const session of agent.sessions) {
      const file = engine.sessionFile(sessionDir, session.id);
      const key = `${session.id}:${file}`; // the transcript moves at handoff; rescan the new copy
      const cursor = this.cursors.get(key) ?? { offset: 0 };
      this.cursors.set(key, cursor);
      const res = engine.scan(file, cursor, this.config.bugPatterns);
      const subMaps = engine.subagentFiles(sessionDir, session.id).map((sub) => {
        const c = this.cursors.get(sub) ?? { offset: 0 };
        this.cursors.set(sub, c);
        engine.scan(sub, c);
        return c.usage;
      });
      const usage = sumUsage(cursor.usage, ...subMaps);
      if (usage.requests && JSON.stringify(session.usage) !== JSON.stringify(usage)) {
        session.usage = usage;
        changed = true;
      }
      for (const key of ['title', 'lastPrompt', 'cost', 'lastActivity', 'lastMessageAt']) {
        if (res[key] != null && JSON.stringify(session[key]) !== JSON.stringify(res[key])) {
          session[key] = res[key];
          changed = true;
        }
      }
      const prs = res.prs.map((p) => ({ ...p, sessionId: session.id }));
      changed = this.mergeLinks(agent, agent.prs, prs, (p) => p.url) || changed;
      changed = this.mergeLinks(agent, agent.bugs, res.bugs, (b) => b.key) || changed;
    }

    if (withPrs) {
      this.lastPrCheck.set(id, Date.now());
      // A shared worktree's pull requests belong to the agent that owns it.
      const branchPrs = agent.sharedWith ? [] : await prsForBranch(agent.workdir, info?.branch);
      changed = this.mergeLinks(agent, agent.prs, branchPrs, (p) => p.url) || changed;
      // Fill in title/state for PRs we only know by URL, and keep open ones current.
      const stale = Object.values(agent.prs).filter(
        (p) => p.source !== 'branch' && (!p.state || p.state === 'OPEN'),
      );
      for (const pr of stale.slice(0, 10)) {
        const d = await prDetails(pr.url);
        if (d) changed = this.mergeLinks(agent, agent.prs, [{ ...d, source: pr.source }], (p) => p.url) || changed;
      }
      // Landing reacts to failing checks and requested changes.
      this.emit('prs', agent);
    }

    await this.updateChanges(agent);
    this.updateStuck(agent, sessionDir);

    if (changed && this.store.get(id)) {
      agent.updatedAt = now();
      this.store.save();
      this.changed(agent);
    }
    return this.view(agent);
  }

  // ------------------------------------------------------ telling an agent

  /**
   * Type a message into an agent's session as if the user sent it: queued until the agent
   * is idle (not mid-turn, no prompt open), resuming a closed agent first.
   */
  /** The fields of an agent that policies and audit listeners see. */
  auditView(agent) {
    return {
      id: agent.id,
      name: agent.name,
      kind: agent.kind,
      engine: agent.engine ?? DEFAULT_ENGINE,
      intent: agent.intent,
      repo: agent.repo ?? null,
      workdir: agent.workdir ?? null,
      branch: agent.git?.branch ?? null,
      permissionMode: agent.permissionMode ?? null,
      model: agent.model ?? null,
      project: agent.projectInfo?.name ?? null,
      status: agent.status,
    };
  }

  tell(ref, text, { source = 'user' } = {}) {
    const agent = this.mustGet(ref);
    text = String(text ?? '').trim();
    if (!text) throw Object.assign(new Error('Message is empty'), { status: 400 });
    this.plugins.check('agent.message', { agent: this.auditView(agent), text, source });
    this.plugins.emit('agent.message', { agent: this.auditView(agent), text, source });
    if (!this.outbox.has(agent.id)) this.outbox.set(agent.id, []);
    this.outbox.get(agent.id).push({ text, source, at: now() });
    if (!this.runtimes.get(agent.id)?.pty && agent.workdir && agent.status !== 'preparing') this.start(agent.id);
    this.changed(agent);
    return this.view(this.store.get(agent.id));
  }

  deliverOutbox(t = Date.now()) {
    for (const [id, queue] of this.outbox) {
      const rt = this.runtimes.get(id);
      if (!queue.length) {
        this.outbox.delete(id);
        continue;
      }
      // Idle, no prompt open, and not right after our last message (give it time to react).
      if (!rt?.pty || rt.busy || rt.attention || rt.planning || t - (rt.startedAt ?? 0) < 2500 || t - (rt.toldAt ?? 0) < 8000) continue;
      const { text } = queue.shift();
      rt.toldAt = t;
      // Bracketed paste keeps a multi-line message as one message instead of submitting each line.
      rt.pty.write(text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
      setTimeout(() => rt.pty?.write('\r'), 250);
      const a = this.store.get(id);
      if (a) this.changed(a);
    }
  }

  // ------------------------------------------------------- conflict radar

  /** Recompute what an agent's branch changed since it branched (needs a base commit). */
  async updateChanges(agent) {
    const baseSha = agent.baseRef?.split(' @ ')[1];
    if (!agent.workdir || !baseSha || NO_REPO.has(agent.kind) || !fs.existsSync(agent.workdir)) return;
    // A full diff against the base is heavier than git status; once a minute is enough for overlaps.
    const prev0 = this.changeSets.get(agent.id);
    if (prev0 && Date.now() - Date.parse(prev0.at) < (this.config.conflictRefreshSec ?? 60) * 1000) return;
    const res = await git.changes(agent.workdir, baseSha).catch(() => null);
    if (!res || !this.store.get(agent.id)) return;
    const prev = this.changeSets.get(agent.id);
    this.changeSets.set(agent.id, { ...res, baseSha, at: now() });
    if (JSON.stringify(prev?.files) !== JSON.stringify(res.files)) this.recomputeConflicts();
  }

  recomputeConflicts() {
    const entries = [...this.changeSets.entries()]
      .map(([id, c]) => ({ agent: this.store.get(id), changes: c, baseSha: c.baseSha }))
      .filter((e) => e.agent);
    const next = findConflicts(entries);
    this.judgeClashes(entries, next);
    const ids = new Set([...this.conflicts.keys(), ...next.keys()]);
    const before = this.conflicts;
    this.conflicts = next;
    for (const id of ids) {
      if (JSON.stringify(before.get(id) ?? []) === JSON.stringify(next.get(id) ?? [])) continue;
      const a = this.store.get(id);
      if (a) this.changed(a);
    }
  }

  /**
   * Ask the judge about pairs of agents in one repo that share a file (the rule's overlaps) or a
   * folder (candidates the rule can't see: the same module changed from different files).
   * Once per pair until their changes move, and at most every 30 minutes.
   */
  judgeClashes(entries, overlaps) {
    if (!this.judge.enabled) return;
    const dirs = (e) => new Set(Object.keys(e.changes.files).map((f) => path.dirname(f)).filter((d) => d !== '.'));
    const byRepo = new Map();
    for (const e of entries) {
      const k = repoKey(e.agent);
      if (k && !NO_REPO.has(e.agent.kind)) (byRepo.get(k) ?? byRepo.set(k, []).get(k)).push(e);
    }
    for (const group of byRepo.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const [x, y] = [group[i], group[j]].sort((p, q) => p.agent.id.localeCompare(q.agent.id));
          if (related(x.agent, y.agent)) continue;
          const shareFile = (overlaps.get(x.agent.id) ?? []).some((c) => c.with.id === y.agent.id);
          const dy = dirs(y);
          if (!shareFile && ![...dirs(x)].some((d) => dy.has(d))) continue;
          const key = `${x.agent.id}|${y.agent.id}`;
          const h = hash(JSON.stringify([Object.keys(x.changes.files), Object.keys(y.changes.files)]));
          const prev = this.clashVerdicts.get(key);
          if (prev && (prev.hash === h || prev.pending || Date.now() - prev.at < 30 * 60_000)) continue;
          this.clashVerdicts.set(key, { ...prev, at: Date.now(), hash: h, a: x.agent.id, b: y.agent.id, pending: true });
          const side = (e) => ({ name: e.agent.name, intent: e.agent.intent, changes: e.changes, brief: fs.existsSync(briefPath(e.agent.id)) ? fs.readFileSync(briefPath(e.agent.id), 'utf8') : '' });
          this.judge
            .ask(`clash:${key}:${h}`, x.agent, clashPrompt(side(x), side(y), this.judge.examples('clash')), (d) => typeof d.conflict === 'boolean')
            .then((data) => {
              const cur = this.clashVerdicts.get(key);
              this.clashVerdicts.set(key, { ...cur, data: data ?? cur?.data ?? null, pending: false });
              for (const id of [x.agent.id, y.agent.id]) {
                const a = this.store.get(id);
                if (a) this.changed(a);
              }
            });
        }
      }
    }
  }

  /**
   * Overlaps as the person sees them: the rule's file overlaps, with the judge's reason, advice
   * and merge order; an overlap only in different places is dropped when the judge says the work
   * doesn't collide; a collision the rule can't see (same folder, different files) is added.
   */
  conflictGroups(agent) {
    const groups = summarizeConflicts(this.conflicts.get(agent.id));
    if (!this.judge.enabled) return groups;
    const verdictWith = (otherId) => this.clashVerdicts.get([agent.id, otherId].sort().join('|'));
    const ai = (v) => {
      const d = v.data;
      const self = v.a === agent.id ? 'A' : 'B';
      const first = d.mergeFirst === 'A' ? v.a : d.mergeFirst === 'B' ? v.b : null;
      return { first, info: { conflict: d.conflict, confidence: d.confidence, reason: d.reason, orderReason: d.orderReason, advice: self === 'A' ? d.adviceA : d.adviceB } };
    };
    const out = [];
    for (const g of groups) {
      const v = verdictWith(g.agent.id);
      if (!v?.data) {
        out.push(v?.pending ? { ...g, ai: { checking: true } } : g);
        continue;
      }
      const { first, info } = ai(v);
      if (!info.conflict && info.confidence >= 0.6 && !g.lines) continue;
      out.push({ ...g, mergeFirst: first ?? g.mergeFirst, ai: info });
    }
    for (const v of this.clashVerdicts.values()) {
      if (!v.data?.conflict || v.data.confidence < 0.6 || (v.a !== agent.id && v.b !== agent.id)) continue;
      const otherId = v.a === agent.id ? v.b : v.a;
      const other = this.store.get(otherId);
      if (!other || out.some((g) => g.agent.id === otherId)) continue;
      const { first, info } = ai(v);
      out.push({ agent: { id: other.id, name: other.name }, files: [], lines: 0, mergeFirst: first ?? agent.id, ai: info });
    }
    return out;
  }

  clashFeedback(agent, group, outcome) {
    const what = group.files.length ? group.files.map((f) => f.file).slice(0, 4).join(', ') : group.ai?.reason ?? 'related code';
    this.judge.feedback('clash', { summary: `${agent.name} and ${group.agent.name}: ${what}`, verdict: group.ai?.reason ? `${group.ai.conflict ? 'collide' : 'no collision'} (${group.ai.confidence})` : 'not asked', outcome });
  }

  /** The person says these two don't collide: hide the pair until their changes move. */
  dismissConflict(ref, otherId) {
    const agent = this.mustGet(ref);
    const group = this.conflictGroups(agent).find((g) => g.agent.id === otherId);
    if (!group) throw Object.assign(new Error('No overlap with that agent right now'), { status: 404 });
    this.clashFeedback(agent, group, 'said they do not collide');
    const key = [agent.id, otherId].sort().join('|');
    const [a, b] = key.split('|');
    const cur = this.clashVerdicts.get(key);
    this.clashVerdicts.set(key, { at: Date.now(), hash: cur?.hash ?? null, a, b, pending: false, data: { conflict: false, confidence: 1, reason: 'You said these do not collide', byPerson: true } });
    for (const id of [agent.id, otherId]) {
      const x = this.store.get(id);
      if (x) this.changed(x);
    }
    return this.view(this.store.get(agent.id));
  }

  /** Tell an agent (or both) about an overlap with another agent. */
  warnConflict(ref, otherId) {
    const agent = this.mustGet(ref);
    const group = this.conflictGroups(agent).find((g) => g.agent.id === otherId);
    if (!group) throw Object.assign(new Error('No overlap with that agent right now'), { status: 404 });
    this.clashFeedback(agent, group, 'told the agent about it');
    return this.tell(agent.id, conflictMessage(agent, group), { source: 'conflict' });
  }

  // ------------------------------------------------------- stuck detection

  updateStuck(agent, sessionDir) {
    if (!sessionDir) return;
    const key = `${agent.sessionId}:${sessionDir}`;
    const state = this.activity.get(key) ?? {};
    const engine = engineOf(agent);
    this.activity.set(key, engine.activity(engine.sessionFile(sessionDir, agent.sessionId), state));
    const running = Boolean(this.runtimes.get(agent.id)?.pty);
    const opts = { ...STUCK_DEFAULTS, ...this.config.stuck };
    const strict = running ? detectStuck(state.events, { opts }) : [];
    // With the judge on, looser thresholds only pick candidates; the model decides which are real.
    const loose = running && this.judge.enabled ? detectStuck(state.events, { opts: loosen(opts) }) : [];
    const found = [...strict.map((f) => ({ ...f, rule: true })), ...loose.filter((f) => !strict.some((x) => x.key === f.key))];
    const before = JSON.stringify(this.stuck.get(agent.id) ?? []);
    this.stuck.set(agent.id, found);
    for (const f of found) this.judgeStuck(agent, f, state.events);
    if (before !== JSON.stringify(found)) this.changed(agent);
  }

  /** Ask the judge about a finding, at most once per finding every 15 minutes. */
  judgeStuck(agent, f, events) {
    if (!this.judge.enabled) return;
    const seen = this.stuckVerdicts.get(agent.id) ?? new Map();
    this.stuckVerdicts.set(agent.id, seen);
    const prev = seen.get(f.key);
    if (prev && (prev.since === f.since || Date.now() - prev.at < 15 * 60_000)) return;
    seen.set(f.key, { at: Date.now(), since: f.since, data: prev?.data ?? null, pending: true });
    this.explainContext(agent)
      .then((ctx) => this.judge.ask(`stuck:${agent.id}:${f.key}:${f.since}`, agent, stuckPrompt(ctx, f, events, this.judge.examples('stuck')), (d) => typeof d.stuck === 'boolean'))
      .then((data) => {
        seen.set(f.key, { at: Date.now(), since: f.since, data: data ?? prev?.data ?? null, pending: false });
        const a = this.store.get(agent.id);
        if (a) this.changed(a);
      })
      .catch(() => seen.set(f.key, { ...seen.get(f.key), pending: false }));
  }

  /**
   * Findings as the person sees them: a rule's finding shows until the judge clears it, and the
   * judge's diagnosis and nudge replace the canned ones; a looser candidate shows only when the
   * judge confirms it.
   */
  resolvedStuck(agent) {
    const verdicts = this.stuckVerdicts.get(agent.id);
    const out = [];
    for (const f of this.stuck.get(agent.id) ?? []) {
      const { rule, ...finding } = f;
      const v = verdicts?.get(f.key);
      const d = v?.data;
      if (d && !d.stuck && d.confidence >= 0.5) continue;
      if (d?.stuck) {
        out.push({
          ...finding,
          title: d.title || f.title,
          detail: d.diagnosis || f.detail,
          nudge: d.nudge || f.nudge,
          ai: { verdict: 'stuck', confidence: d.confidence, rule: f.title },
        });
      } else if (rule) out.push(v?.pending ? { ...finding, ai: { verdict: 'checking' } } : finding);
    }
    return out;
  }

  /** Findings the user hasn't dismissed. A dismissal holds until that finding clears. */
  activeStuck(agent) {
    const dismissed = agent.stuckDismissed ?? {};
    return this.resolvedStuck(agent).filter((f) => dismissed[f.key] !== f.since);
  }

  dismissStuck(ref, key, { feedback = 'dismissed it' } = {}) {
    const agent = this.mustGet(ref);
    const f = this.resolvedStuck(agent).find((x) => x.key === key);
    if (!f) return this.view(agent);
    if (feedback) this.judge.feedback('stuck', { summary: `${f.ai?.rule ?? f.title}: ${f.detail}`, verdict: f.ai?.verdict === 'stuck' ? `stuck (${f.ai.confidence})` : 'not asked', outcome: feedback });
    return this.view(this.patch(agent.id, { stuckDismissed: { ...agent.stuckDismissed, [key]: f.since } }));
  }

  nudge(ref, key, text) {
    const agent = this.mustGet(ref);
    const f = this.resolvedStuck(agent).find((x) => x.key === key);
    const message = text?.trim() || f?.nudge;
    if (!message) throw Object.assign(new Error('Nothing to send'), { status: 400 });
    this.tell(agent.id, message, { source: 'nudge' });
    return f ? this.dismissStuck(agent.id, key, { feedback: message === f.nudge ? 'sent the nudge as written' : 'sent an edited nudge' }) : this.view(agent);
  }

  // ------------------------------------------------------------- the AI judge

  /** Engine and model for judge calls: config `judge.engine`/`judge.model`, else Claude's fast model, else the summary writer. */
  judgeModel(agent) {
    const s = this.judge.settings;
    const usable = (e) => e?.supports.oneShot && installed(e, this.config);
    if (s.engine && usable(ENGINES[s.engine])) return { engine: ENGINES[s.engine], model: s.model ?? undefined };
    if (usable(ENGINES[DEFAULT_ENGINE])) return { engine: ENGINES[DEFAULT_ENGINE], model: s.model ?? 'haiku' };
    return this.writerFor(agent);
  }

  /** The end of the terminal screen as text: cursor moves become spaces or line breaks. */
  screenText(rt) {
    return rt.tail
      .replace(/\x1b\[\d*(;\d*)?[Hf]/g, '\n')
      .replace(/\x1b\[\d*[CG]/g, ' ')
      .replace(ANSI, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .slice(-2500)
      .trim();
  }

  /**
   * An idle agent whose screen matched no known prompt: ask the judge whether it is asking
   * something, finished, or broken. Once per screen.
   */
  async judgeScreen(id, rt) {
    const agent = this.store.get(id);
    if (!agent) return;
    const screen = stripChrome(this.screenText(rt), engineOf(agent).screenChrome);
    if (!screen) return;
    const h = hash(screen);
    if (rt.screenVerdict?.hash === h) return this.applyScreen(id, rt, rt.screenVerdict.data);
    const ctx = await this.explainContext(agent);
    const recent = ctx.digest ? `${screen}\n\n(last part of the conversation:)\n${ctx.digest.slice(-1500)}` : screen;
    const data = await this.judge.ask(`screen:${id}:${h}`, agent, screenPrompt(ctx, recent, this.judge.examples('screen')), (d) => ['question', 'done', 'error', 'idle'].includes(d.state));
    if (!data || !this.runtimes.has(id)) return;
    rt.screenVerdict = { hash: h, data };
    this.applyScreen(id, rt, data);
  }

  applyScreen(id, rt, data) {
    if (!data || rt.busy || !rt.pty) return;
    const sure = data.confidence >= 0.6;
    rt.waiting = sure && (data.state === 'question' || data.state === 'error') ? { ...data, at: now() } : null;
    const a = this.store.get(id);
    if (!a) return;
    this.changed(a);
    if (sure && data.state === 'done' && !NO_REPO.has(a.kind)) this.requestReview(id, { trigger: 'screen' }).catch(() => {});
  }

  /** The person says the agent is not actually waiting on them. */
  dismissWaiting(ref) {
    const agent = this.mustGet(ref);
    const rt = this.runtimes.get(agent.id);
    if (rt?.waiting) {
      this.judge.feedback('screen', { summary: rt.waiting.summary, verdict: `${rt.waiting.state} (${rt.waiting.confidence})`, outcome: 'said it was not waiting on them' });
      rt.waiting = null;
      this.changed(agent);
    }
    return this.view(agent);
  }

  /** Answer what the judge saw the agent ask: typed into the session like any message. */
  answerWaiting(ref, text) {
    const agent = this.mustGet(ref);
    const rt = this.runtimes.get(agent.id);
    if (rt?.waiting) {
      this.judge.feedback('screen', { summary: rt.waiting.summary, verdict: `${rt.waiting.state} (${rt.waiting.confidence})`, outcome: 'answered it' });
      rt.waiting = null;
    }
    return this.tell(agent.id, text, { source: 'answer' });
  }

  /**
   * Review the work against the intent and brief. Triggered when the brief says done or the
   * screen judge sees the agent say it finished; also on request. Skipped when nothing changed
   * since the last review.
   */
  async requestReview(ref, { trigger = 'manual', force = false } = {}) {
    const agent = this.mustGet(ref);
    if (!this.judge.enabled) throw Object.assign(new Error('The AI judge is off (config.json "judge": { "enabled": false })'), { status: 409 });
    const ctx = await this.explainContext(agent);
    const h = hash(`${ctx.repo}\n${ctx.briefMarkdown}\n${ctx.digest.slice(-2000)}`);
    if (!force && agent.aiReview?.hash === h) return this.view(agent);
    this.patch(agent.id, { aiReview: { ...agent.aiReview, pending: true } });
    const data = await this.judge.ask(`review:${agent.id}:${h}`, agent, reviewPrompt(ctx, this.judge.examples('review')), (d) => ['complete', 'partial', 'not_done'].includes(d.verdict));
    const cur = this.store.get(agent.id);
    if (!cur) return null;
    if (!data) return this.view(this.patch(agent.id, { aiReview: cur.aiReview?.verdict ? { ...cur.aiReview, pending: false } : null }));
    const list = (x) => (Array.isArray(x) ? x.map(String).slice(0, 8) : []);
    const m = this.judgeModel(agent);
    const review = {
      verdict: data.verdict,
      confidence: data.confidence,
      summary: String(data.summary ?? ''),
      met: list(data.met),
      missing: list(data.missing),
      risks: list(data.risks),
      trigger,
      hash: h,
      by: `${m.engine.label}${m.model ? ` (${m.model})` : ''}`,
      at: now(),
      seen: false,
      pending: false,
    };
    return this.view(this.patch(agent.id, { aiReview: review }));
  }

  /** "finish": send the agent back with what is missing; "accept": the person is satisfied. */
  ackReview(ref, action) {
    const agent = this.mustGet(ref);
    const r = agent.aiReview;
    if (!r?.verdict) throw Object.assign(new Error('There is no AI review for this agent'), { status: 404 });
    if (action === 'finish') {
      if (!r.missing.length) throw Object.assign(new Error('The review found nothing missing'), { status: 400 });
      this.tell(agent.id, finishMessage(r), { source: 'review' });
    } else if (action !== 'accept') throw Object.assign(new Error('action must be "finish" or "accept"'), { status: 400 });
    this.judge.feedback('review', {
      summary: `${agent.intent?.slice(0, 120) ?? agent.name}: ${r.summary.slice(0, 80)}`,
      verdict: `${r.verdict} (${r.confidence})`,
      outcome: action === 'finish' ? 'sent it back to finish the missing items' : 'accepted the work',
    });
    return this.view(this.patch(agent.id, { aiReview: { ...r, seen: true, outcome: action } }));
  }

  // ------------------------------------------------------- decision inbox

  questionsView(agent) {
    if (NO_REPO.has(agent.kind)) return [];
    const answers = agent.answers ?? {};
    return loadQuestions(agent.id).map((q) => ({ ...q, answer: answers[q.id] ?? null }));
  }

  answerQuestion(ref, qid, text) {
    const agent = this.mustGet(ref);
    const q = loadQuestions(agent.id).find((x) => x.id === qid);
    if (!q) throw Object.assign(new Error('No such question'), { status: 404 });
    text = String(text ?? '').trim();
    if (!text) throw Object.assign(new Error('Answer is empty'), { status: 400 });
    this.patch(agent.id, { answers: { ...agent.answers, [qid]: { text, at: now() } } });
    return this.tell(agent.id, answerMessage(q, text), { source: 'answer' });
  }

  /** Everything waiting on the user, across agents: prompts, questions, stuck agents, overlaps. */
  inbox() {
    const items = [];
    for (const agent of this.store.list()) {
      const v = this.view(agent);
      const base = { agentId: agent.id, agentName: agent.name, project: v.projectInfo?.name ?? null, priority: v.priority };
      if (v.runtime.attention) {
        items.push({ ...base, kind: 'prompt', key: `prompt:${agent.id}`, title: v.runtime.attention, prompt: v.runtime.prompt, at: v.runtime.lastOutputAt });
      }
      if (v.runtime.waiting) {
        items.push({ ...base, kind: 'waiting', key: `waiting:${agent.id}`, title: v.runtime.waiting.question || v.runtime.waiting.summary, waiting: v.runtime.waiting, at: v.runtime.waiting.at });
      }
      for (const q of v.questions) if (!q.answer) items.push({ ...base, kind: 'question', key: `q:${agent.id}:${q.id}`, title: q.question, question: q });
      if (agent.aiReview?.verdict && !agent.aiReview.seen) {
        items.push({ ...base, kind: 'review', key: `review:${agent.id}`, title: agent.aiReview.summary, review: agent.aiReview, at: agent.aiReview.at });
      }
      for (const f of v.stuck) items.push({ ...base, kind: 'stuck', key: `stuck:${agent.id}:${f.key}`, title: f.title, finding: f, at: f.since });
      for (const g of v.conflicts) {
        // One entry per pair, on the agent that should rebase.
        if (g.mergeFirst === agent.id) continue;
        items.push({ ...base, kind: 'conflict', key: `conflict:${agent.id}:${g.agent.id}`, title: `Overlaps with ${g.agent.name}`, conflict: g });
      }
    }
    const order = { prompt: 0, waiting: 1, question: 1, review: 2, stuck: 3, conflict: 4 };
    return items.sort((a, b) => order[a.kind] - order[b.kind] || a.priority - b.priority);
  }

  /** Send keys to a live prompt (e.g. "1" to pick the first option). */
  answerPrompt(ref, key) {
    const agent = this.mustGet(ref);
    const keys = { esc: '\x1b', enter: '\r', up: '\x1b[A', down: '\x1b[B' };
    const data = keys[key] ?? (/^\d$/.test(key) ? key : null);
    if (!data) throw Object.assign(new Error('Unsupported key'), { status: 400 });
    this.write(agent.id, data);
    return { ok: true };
  }

  // ------------------------------------------------------- checkpoints and forks

  /**
   * At the end of a turn, snapshot the working tree (as a commit under refs/agentmgr/<id>/)
   * together with how far the transcript had got, so the agent can be forked from here later.
   */
  async checkpoint(id) {
    const agent = this.store.get(id);
    if (!agent?.workdir || NO_REPO.has(agent.kind) || !agent.branch || this.checkpointing?.has(id)) return null;
    // Output pauses mid-turn too (a slow command); one snapshot per half minute is plenty.
    this.lastCheckpointTry ??= new Map();
    if (Date.now() - (this.lastCheckpointTry.get(id) ?? 0) < 30_000) return null;
    this.lastCheckpointTry.set(id, Date.now());
    (this.checkpointing ??= new Set()).add(id);
    try {
      const snap = await git.snapshot(agent.workdir).catch(() => null);
      const cur = this.store.get(id);
      if (!snap || !cur) return null;
      const list = cur.checkpoints ?? [];
      let bytes = 0;
      try {
        bytes = fs.statSync(engineOf(cur).sessionFile(cur.workdir, cur.sessionId)).size;
      } catch {}
      const last = list.at(-1);
      if (last && last.tree === snap.tree && last.sessionId === cur.sessionId && last.bytes === bytes) return null;
      const n = (last?.n ?? 0) + 1;
      await git.setRef(cur.workdir, `refs/agentmgr/${id}/${n}`, snap.sha);
      const session = cur.sessions.find((s) => s.id === cur.sessionId);
      list.push({ n, at: now(), sha: snap.sha, tree: snap.tree, head: snap.head, sessionId: cur.sessionId, bytes, prompt: session?.lastPrompt?.slice(0, 200) ?? null });
      const max = this.config.maxCheckpoints ?? 40;
      while (list.length > max) {
        const old = list.shift();
        await git.run('git', ['update-ref', '-d', `refs/agentmgr/${id}/${old.n}`], { cwd: cur.workdir }).catch(() => {});
      }
      this.patch(id, { checkpoints: list });
      return list.at(-1);
    } finally {
      this.checkpointing.delete(id);
    }
  }

  /**
   * A new agent that starts where this one is now (or at checkpoint `n`): its own worktree
   * holding the same code (commits and uncommitted work), and a copy of the conversation
   * under a new session ID. The original keeps running untouched.
   */
  async fork(ref, { checkpoint: n, name, instructions } = {}) {
    const src = this.mustGet(ref);
    if (!engineOf(src).supports.fork) throw Object.assign(new Error(`Forking isn't available for ${engineOf(src).label} agents yet`), { status: 409 });
    if (!src.workdir || !src.branch || !(await git.isGitRepo(src.workdir))) {
      throw Object.assign(new Error('Only agents with their own git worktree can be forked'), { status: 409 });
    }
    let point;
    if (n) {
      point = (src.checkpoints ?? []).find((c) => c.n === Number(n));
      if (!point) throw Object.assign(new Error(`No checkpoint ${n}`), { status: 404 });
    } else {
      const snap = await git.snapshot(src.workdir, 'agentmgr fork');
      if (!snap) throw Object.assign(new Error('Nothing to fork yet (no commits)'), { status: 409 });
      let bytes = 0;
      try {
        bytes = fs.statSync(engineOf(src).sessionFile(src.workdir, src.sessionId)).size;
      } catch {}
      point = { sha: snap.sha, head: snap.head, sessionId: src.sessionId, bytes };
    }
    const forks = this.store.list().filter((a) => a.forkOf?.agentId === src.id).length;
    const agent = this.create({
      intent: src.intent,
      name: name || `${src.name}-fork${forks + 1}`,
      repo: src.repo ?? undefined,
      permissionMode: src.permissionMode,
      model: src.model ?? undefined,
      project: src.project ?? undefined,
      priority: src.priority,
      start: true,
      workspace: (a, opts) => this.forkWorkspace(a, src, point, opts),
    });
    this.patch(agent.id, { forkOf: { agentId: src.id, name: src.name, checkpoint: n ? Number(n) : null, at: now() }, baseRef: src.baseRef });
    if (instructions?.trim()) this.tell(agent.id, instructions.trim(), { source: 'fork' });
    return this.view(this.store.get(agent.id));
  }

  async forkWorkspace(agent, src, point, { signal, progress }) {
    const root = src.sourceDir || (await git.run('git', ['rev-parse', '--show-toplevel'], { cwd: src.workdir }));
    const workdir = path.join(paths.workspaces, `${path.basename(src.workdir).replace(/-[0-9a-f]{6}$/, '')}-fork-${agent.id}`);
    const branch = `agent/${agent.slug}-${agent.id}`;
    progress({ phase: 'Checking out' });
    await this.withLock(root, () => git.addWorktree(root, workdir, branch, point.head, { signal, onProgress: (p) => progress({ phase: 'Checking out', ...p }) }));
    // Same uncommitted work as the source had at that point.
    await git.restoreSnapshot(workdir, point.sha);
    // Same conversation, under the fork's own session ID.
    engineOf(src).copySession({ fromCwd: src.workdir, toCwd: workdir, fromId: point.sessionId, toId: agent.sessionId, bytes: point.bytes });
    return { workdir, sourceDir: root, branch, worktree: true, repo: src.repo, baseRef: src.baseRef };
  }

  tick() {
    this.tickCount++;
    const t = Date.now();
    for (const [id, rt] of this.runtimes) {
      if (rt.busy && t - rt.lastOutputAt > BUSY_IDLE_MS) {
        rt.busy = false;
        const screen = rt.tail.slice(-1500).replace(ANSI, '').replace(/\s+/g, '');
        const a0 = this.store.get(id);
        rt.attention = (a0 ? engineOf(a0).attention : []).find(([re]) => re.test(screen))?.[1] ?? null;
        const a = this.store.get(id);
        if (a) this.changed(a);
        // A turn just ended: remember the code and conversation at this point.
        if (a && !rt.planning && !rt.attention) this.checkpoint(id).catch(() => {});
      }
    }
    this.deliverOutbox(t);
    this.scanSignIns();
    if (this.judge.enabled) {
      const idleMs = this.judge.settings.idleSec * 1000;
      for (const [id, rt] of this.runtimes) {
        if (!rt.pty || rt.busy || rt.attention || rt.planning || rt.screenChecked || this.outbox.get(id)?.length) continue;
        // A team member that finished its step is meant to sit idle until its next turn.
        if (this.idleExpected?.(id)) continue;
        if (!rt.lastOutputAt || t - rt.lastOutputAt < idleMs) continue;
        // Output only right after launch (a resume repainting its screen) is not a turn worth reading.
        if (rt.lastOutputAt - rt.startedAt < this.judge.settings.warmupSec * 1000) continue;
        rt.screenChecked = true;
        this.judgeScreen(id, rt).catch(() => {});
      }
    }
    for (const [id, rt] of this.runtimes) {
      if (rt.pty) this.reloadBrief(id);
    }
    for (const [id, rt] of this.runtimes) {
      if (!rt.pty || !rt.planning) continue;
      const a = this.store.get(id);
      if (a?.workdir && a.status !== 'preparing') this.maybeHandoff(id).catch(() => {});
    }
    if (this.config.flushSec && this.tickCount % this.config.flushSec === 0) this.flush().catch(() => {});
    if (this.tickCount % this.config.gitRefreshSec !== 0) return;
    for (const [id, rt] of this.runtimes) {
      if (!rt.pty || !this.store.get(id)) continue;
      const withPrs = t - (this.lastPrCheck.get(id) ?? 0) > this.config.prRefreshSec * 1000;
      this.refresh(id, { withPrs }).catch(() => {});
    }
  }

  /** One-off refresh of every agent (on daemon start), staggered to avoid a burst of gh calls. */
  async refreshAll({ withPrs = true } = {}) {
    for (const agent of this.store.list()) {
      if (agent.workdir) await this.refresh(agent.id, { withPrs }).catch(() => {});
    }
  }
}
