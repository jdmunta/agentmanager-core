// Agent teams: one problem, several agents in roles. The analyst writes an analysis; critics
// agree, ask for changes or raise questions until they align; the implementer builds it; the
// tester tests it; the reviewer approves it or sends it back to the implementer. Agents hand off
// through Markdown files in the team's folder, each ending with a "verdict:" line. The daemon
// reads the verdicts, tells the next agent what to read, and stops for the person when the
// reviewer approves, or when the agents can't agree within the round limits.
// All members share one worktree and branch (the implementer's); only the implementer and the
// tester change it, one at a time. Teams live in the state file next to the agents.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { expandHome, paths } from './config.js';
import { engineOf } from './engines/index.js';
import * as git from './git.js';

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();

export const ROLES = ['analyst', 'critic', 'implementer', 'tester', 'reviewer'];
const ROLE_LABEL = { analyst: 'Analyst', critic: 'Critic', implementer: 'Implementer', tester: 'Tester', reviewer: 'Reviewer' };

/** The words each kind of handoff file may end with. */
export const VERDICTS = {
  analysis: ['ready'],
  critique: ['agree', 'changes', 'questions'],
  implementation: ['done', 'blocked'],
  test: ['pass', 'fail'],
  review: ['approve', 'changes'],
  final: ['done'],
  blocked: ['blocked'],
};
/** Handoff file names a lead's sub-agents write: kind, role and which round. */
const FILES = [
  [/^analysis-(\d+)\.md$/, 'analysis', 'analyst'],
  [/^critique-(\d+)-(\d+)\.md$/, 'critique', 'critic'],
  [/^implementation-(\d+)\.md$/, 'implementation', 'implementer'],
  [/^test-(\d+)\.md$/, 'test', 'tester'],
  [/^review-(\d+)\.md$/, 'review', 'reviewer'],
  [/^blocked-(\d+)\.md$/, 'blocked', 'lead'],
  [/^final\.md$/, 'final', 'lead'],
];
const SYNONYMS = {
  agreed: 'agree', approved: 'approve', lgtm: 'approve', passed: 'pass', passes: 'pass', failed: 'fail', fails: 'fail',
  complete: 'done', completed: 'done', finished: 'done', question: 'questions', change: 'changes', request: 'changes',
  rejected: 'changes', reject: 'changes',
};
const ACTIVE = new Set(['analyze', 'discuss', 'implement', 'test', 'review', 'finalizing']);

export const teamDir = (id) => path.join(paths.teams, id);

/**
 * A new project's folder, made a git repository with an empty first commit on main, so the team
 * gets a worktree and a branch like any other. An existing folder must be empty or already a repo.
 */
export function startRepo(dir) {
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
  if (fs.existsSync(dir)) {
    try {
      if (g('rev-parse', '--is-inside-work-tree') === 'true') return { dir, created: false };
    } catch {}
    if (fs.readdirSync(dir).length) throw err(400, `${dir} has files but isn't a git repository: run "git init" there, or pick an empty or new folder`);
  }
  fs.mkdirSync(dir, { recursive: true });
  g('init', '-q', '-b', 'main');
  try {
    g('commit', '-q', '--allow-empty', '-m', 'Start the project');
  } catch {
    // No git identity configured on this machine: sign the empty first commit as AI Agent Manager.
    g('-c', 'user.name=AI Agent Manager', '-c', 'user.email=agentmgr@localhost', 'commit', '-q', '--allow-empty', '-m', 'Start the project');
  }
  return { dir, created: true };
}

/** The verdict a handoff file ends with ("verdict: approve"), normalized; null if none or not allowed. */
export function readVerdict(text, allowed) {
  const all = [...String(text ?? '').matchAll(/^[\s>*_#-]*verdict[\s*_`]*:[\s*_`]*([a-z][a-z-]*)/gim)];
  const word = all.at(-1)?.[1].toLowerCase();
  if (!word) return null;
  const v = SYNONYMS[word] ?? word;
  return allowed.includes(v) ? v : (allowed.find((a) => v.startsWith(a)) ?? null);
}

/** A line or two from a handoff file for the timeline: its first prose, without headings or the verdict. */
export function summarize(text, max = 240) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^#/.test(l) && !/^[>*_\s-]*verdict\b/i.test(l) && !/^(-{3,}|```)/.test(l));
  const s = lines.join(' ').replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const DUTIES = {
  analyst:
    'Your job: study the problem and the code, then write an analysis the team can build from. Do not change any project files. ' +
    'The analysis covers: the problem in your own words; what you found (root cause or current behavior, with file and line references); ' +
    'the proposed approach, step by step; the files to change; risks and edge cases; how to test it; open questions. ' +
    'When critics reply, address every point: change the analysis, or explain in it why you disagree.',
  critic:
    'Your job: challenge the analysis before anyone writes code. Is the problem understood? Is the approach right, and the smallest one that works? ' +
    'What is missing, risky or wrong? Check its claims against the code yourself. Do not change any project files. ' +
    'Number your points and mark each [must], [should] or [question]. Use "agree" only when no [must] point or open question is left.',
  implementer:
    'Your job: implement the analysis the team agreed on, in this working copy, and commit on the current branch with clear messages. ' +
    "Don't push or open a pull request until you are told to. Your implementation notes list what changed (files), " +
    'anything you did differently from the analysis and why, and how to test it. When the tester or the reviewer sends the work back, ' +
    'fix every [must] item and the [should] items that make sense.',
  tester:
    'Your job: test the implementation. Run the project\'s tests, linters and build; exercise the change the way a user would; try the edge cases ' +
    'from the analysis. You may add or improve tests (commit them separately), but do not fix product code: report failures for the implementer. ' +
    'Your test report lists the commands you ran with their results, what passed, and each failure with steps to reproduce. ' +
    'Use "fail" for anything that must be fixed before review.',
  reviewer:
    'Your job: review the change as a senior engineer would before it merges: correctness, edge cases, security, tests, readability, ' +
    "the project's conventions, and whether it does what the analysis agreed. Do not change any project files. " +
    'Your review has a short summary, findings marked [must], [should] or [nit], and what is good. Use "approve" only when no [must] finding is left.',
};

/** Instructions every launch of a team member gets (an appended system prompt). */
export function teamPrompt(role, dir) {
  return [
    `You are the ${ROLE_LABEL[role]?.toLowerCase() ?? role} on a team of AI agents solving one problem together: an analyst, critics, an implementer, a tester and a reviewer.`,
    DUTIES[role] ?? '',
    `How the team works: you hand off through Markdown files in the team folder ${dir}. Each message tells you which files to read and which file to write. ` +
      'Write that file only when you are finished, and end it with a line "verdict: <word>" using one of the words you are given; ' +
      'AI Agent Manager reads that line and passes the work on. Then stop and wait: a message comes when it is your turn again. ' +
      "Don't edit other members' files, and don't watch the folder or wait for the others yourself. " +
      'Questions for the other members go in your file; questions only the person can answer go in your questions file, as usual.',
  ].join('\n\n');
}

const SUB_ROLES = ['analyst', 'critic', 'implementer', 'tester', 'reviewer'];
const SUB_DESCRIPTION = {
  analyst: "The team's analyst: studies the problem and the code and writes the analysis file. Use it for the team's analysis step.",
  critic: "The team's critic: challenges the analysis and writes a critique file. Use it for the team's discussion step.",
  implementer: "The team's implementer: builds the agreed analysis, commits, and writes implementation notes. Use it for the team's implementation step.",
  tester: "The team's tester: tests the implementation and writes a test report. Use it for the team's test step.",
  reviewer: "The team's reviewer: reviews the change and writes a review. Use it for the team's review step.",
};
const KIND_OF = { analyst: 'analysis', critic: 'critique', implementer: 'implementation', tester: 'test', reviewer: 'review' };

/** The lead's sub-agents, for Claude Code's --agents: one per role, each writing its own handoff files. */
export function subagents(team, dir) {
  return Object.fromEntries(
    SUB_ROLES.filter((r) => r !== 'critic' || team.settings.critics).map((role) => [
      role,
      {
        description: SUB_DESCRIPTION[role],
        prompt: [
          DUTIES[role],
          `You work for the lead of a team of AI agents. The lead's message tells you which files to read and which file to write in the team folder ${dir}. ` +
            `Write that file, and end it with a line "verdict: <word>" using one of: ${VERDICTS[KIND_OF[role]].join(', ')}. ` +
            "Then reply to the lead in two or three lines: what you concluded, and your verdict. Don't write other roles' files.",
        ].join('\n\n'),
        ...(team.settings.models?.[role] ? { model: team.settings.models[role] } : {}),
      },
    ]),
  );
}

/**
 * Instructions for a team's lead: run the pipeline through sub-agents for each request (a quest),
 * stop for the person at the end of each, and stay for the next request.
 */
export function leadPrompt(team, dir, baseRef) {
  const s = team.settings;
  const f = (name) => path.join(dir, 'quest-<n>', name);
  const steps = [
    `1. Analysis: ask the analyst sub-agent to write ${f('analysis-1.md')}.`,
    s.critics
      ? `2. Discussion: ask ${s.critics === 2 ? 'two critic sub-agents (in parallel), critic 1 and critic 2,' : 'the critic sub-agent'} to review the latest analysis and write ${f('critique-<round>-<critic number>.md')}. ` +
        `If every critic's verdict is "agree", go on. Otherwise ask the analyst to address every point in ${f('analysis-<round + 1>.md')} (changing the analysis or saying why not), then ask the critics again. ` +
        `At most ${s.maxRounds} rounds: if they still don't agree, write ${f('blocked-1.md')} (the next free number) saying what they disagree on, end it with "verdict: blocked", and stop.`
      : '2. There are no critics on this team: go on with the analysis as it is.',
    `3. Copy the agreed (latest) analysis to ${f('analysis.md')}.`,
    `4. Implementation: ask the implementer sub-agent to implement ${f('analysis.md')} in this working copy, commit on the current branch (no push, no pull request), and write ${f('implementation-<round>.md')}, starting at round 1. If its verdict is "blocked", write a blocked file as above and stop.`,
    `5. Test: ask the tester sub-agent to test it and write ${f('test-<round>.md')}${s.testCommand ? ` (the project's test command is: ${s.testCommand})` : ''}. On "fail", start the next implementation round with the test report.`,
    `6. Review: ask the reviewer sub-agent to review the change${baseRef ? ` (git diff ${baseRef.split(' @ ')[1] ?? baseRef}...HEAD)` : ''} against the analysis and the test report, and write ${f('review-<round>.md')}. On "changes", start the next implementation round with the review.`,
    `At most ${s.maxLoops} implementation rounds: if the work is still sent back after that, write a blocked file saying what is left, and stop.`,
    '7. When the reviewer approves: stop. Tell the person in a few lines what the team built and what the reviewer said, and wait for their decision. Do not push, merge or open a pull request unless the person tells you to.',
  ];
  const quests =
    `Each request the team works on is a quest with its own folder: the first problem is quest 1, in ${path.join(dir, 'quest-1')}. ` +
    "You stay after a quest ends. When the person asks for new work in this conversation (a feature, a fix, a change), it is the next quest: " +
    `first write the request in its own words to ${path.join(dir, 'quest-<next n>', 'request.md')}, then run the same steps for it in that folder, starting again at analysis-1.md and implementation round 1, on the same branch. ` +
    "A question about the team's work isn't a quest: just answer it.";
  return [
    `You lead a team of AI agents solving one problem: ${SUB_ROLES.filter((r) => r !== 'critic' || s.critics).join(', ')}. They are your sub-agents (the Agent tool).`,
    "You coordinate; you don't do their work. Delegate each step to the sub-agent for that role, give it the problem and exactly the file paths to read and to write, " +
      'and read the verdict line at the end of the file it wrote. Every handoff goes through these files in the team folder; AI Agent Manager reads them to show the person how the team is doing. ' +
      'Never write an analysis, critique, implementation note, test report or review yourself. If a file has no verdict line, ask that sub-agent to add it.',
    quests,
    `The steps of a quest (<n> is its number):\n${steps.join('\n')}`,
    'Questions only the person can answer go in your questions file, as usual; keep the team going on a sensible default meanwhile.',
  ].join('\n\n');
}

export class Teams extends EventEmitter {
  constructor({ manager, store, config = {} }) {
    super();
    this.manager = manager;
    this.store = store;
    this.config = config;
    store.data.teams ??= {};
    manager.on('change', (a) => a.team && store.data.teams[a.team.id] && this.emit('change', a.team.id));
    manager.on('removed', (id) => {
      for (const team of Object.values(store.data.teams)) {
        const m = this.memberList(team).find((x) => x.id === id);
        if (!m) continue;
        if (team.mode === 'lead' ? ACTIVE.has(team.stage) : team.waiting.some((w) => w.member === id)) this.block(team, `The ${m.role} (${m.name}) was deleted`, 'member');
        else this.save(team);
      }
    });
    // The judge leaves members alone between turns: idle is how they wait.
    manager.idleExpected = (id) => {
      const a = store.get(id);
      const team = a?.team && store.data.teams[a.team.id];
      if (!team) return false;
      // A lead is meant to work until the team stops for the person.
      if (team.mode === 'lead') return !ACTIVE.has(team.stage);
      return !team.waiting.some((w) => w.member === id && !w.verdict);
    };
    // Messages still queued when the daemon stopped are gone; say them again (a first message
    // is kept on the agent and starts it on resume).
    this.resendTimer = setTimeout(() => {
      for (const team of Object.values(store.data.teams)) {
        if (!ACTIVE.has(team.stage)) continue;
        const lead = team.mode === 'lead' && this.manager.store.get(team.members.lead);
        if (lead?.lastStartedAt) this.manager.tell(lead.id, `AI Agent Manager restarted while the team was working, which may have cut a sub-agent off. Check the team folder ${team.dir} and continue from where the team stopped.`, { source: 'team' });
        for (const w of team.waiting) {
          const a = this.manager.store.get(w.member);
          if (w.verdict || !w.text || !a?.lastStartedAt || fs.existsSync(this.path(team, w.file))) continue;
          this.manager.tell(w.member, `(Repeated after a restart, in case it didn't reach you.) ${w.text}`, { source: 'team' });
        }
      }
    }, 5000);
    this.resendTimer.unref();
    this.timer = setInterval(() => this.poll(), 2000);
    this.timer.unref();
  }

  save(team) {
    if (team) team.updatedAt = now();
    this.store.save();
    if (team) this.emit('change', team.id);
  }

  get(id) {
    const team = this.store.data.teams[id];
    if (!team) throw err(404, `No team ${id}`);
    return team;
  }

  list() {
    return Object.values(this.store.data.teams).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((t) => this.view(t.id));
  }

  /** Members in pipeline order: { role, n, id, name }. */
  memberList(team) {
    const m = team.members;
    if (team.mode === 'lead') return [{ role: 'lead', id: m.lead, name: this.manager.store.get(m.lead)?.name ?? null }];
    return [
      { role: 'analyst', id: m.analyst },
      ...m.critics.map((id, i) => ({ role: 'critic', n: i + 1, id })),
      { role: 'implementer', id: m.implementer },
      { role: 'tester', id: m.tester },
      { role: 'reviewer', id: m.reviewer },
    ].map((x) => ({ ...x, name: this.manager.store.get(x.id)?.name ?? null }));
  }

  /**
   * One problem, a team of agents. Needs a repository URL, a git folder or a project (the team
   * works in one worktree). critics: 0-2. models / engines: per role, e.g. { reviewer: "opus" }.
   */
  create({ intent, name, critics, maxRounds, maxLoops, testCommand, models, engines, mode, ...opts } = {}) {
    intent = String(intent ?? '').trim();
    if (!intent) throw err(400, 'Describe the problem for the team');
    const defaults = this.config.teams ?? {};
    const n = Number(critics ?? defaults.critics ?? 1);
    if (!Number.isInteger(n) || n < 0 || n > 2) throw err(400, 'critics must be 0, 1 or 2');
    // "lead": one session whose sub-agents play the roles (needs an engine with sub-agents);
    // "agents": one agent per role, each on any engine.
    const asked = mode;
    mode ??= defaults.mode ?? 'lead';
    if (!['lead', 'agents'].includes(mode)) throw err(400, 'mode must be "lead" or "agents"');
    const roleEngines = { ...defaults.engines, ...engines };
    const leadEngine = engineOf(opts.engine || this.config.engine || 'claude');
    const noSubagents = !leadEngine.supports.subagents ? `${leadEngine.label} has no sub-agents` : Object.values(roleEngines).some(Boolean) ? 'Roles on other engines need agents of their own' : null;
    if (mode === 'lead' && noSubagents) {
      if (asked === 'lead') throw err(400, `${noSubagents}: use separate agents (mode "agents")`);
      mode = 'agents';
    }
    const limit = (v, d) => Math.min(10, Math.max(1, Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d));
    const id = `t${crypto.randomBytes(3).toString('hex')}`;
    const slug = (name || intent).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '') || 'team';
    // No repository yet: a new project in a folder of its own (or the new folder given).
    let newProject = null;
    if (!opts.repo && !opts.project) {
      let target = opts.dir?.trim() ? path.resolve(expandHome(opts.dir.trim())) : null;
      if (!target) {
        const root = path.resolve(expandHome(defaults.newProjectsDir ?? path.join(paths.home, 'projects')));
        // Whole words, up to 40 characters: the project's folder name.
        const full = (name || intent).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
        const folder = full.length <= 40 ? full : full.slice(0, 41).replace(/-[^-]*$/, '') || full.slice(0, 40);
        target = path.join(root, folder);
        for (let i = 2; fs.existsSync(target); i++) target = path.join(root, `${folder}-${i}`);
      }
      // A repository is used as it is; a new or empty folder becomes one.
      const repo = startRepo(target);
      if (repo.created) newProject = repo.dir;
      opts.dir = repo.dir;
    }
    const dir = teamDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const settings = {
      critics: n,
      maxRounds: limit(maxRounds, defaults.maxRounds ?? 3),
      maxLoops: limit(maxLoops, defaults.maxLoops ?? 3),
      testCommand: testCommand?.trim() || defaults.testCommand || null,
      models: { ...defaults.models, ...models },
      engines: roleEngines,
    };
    const team = { id, mode, name: name?.trim() || slug, intent, dir, newProject, createdAt: now(), updatedAt: now(), settings, stage: 'analyze', round: 1, loop: 1, extraRounds: 0, extraLoops: 0, waiting: [], history: [], blocked: null, outcome: null, members: { critics: [] } };
    this.store.data.teams[id] = team;

    const base = { ...opts, intent, start: false, planReview: false };
    if (mode === 'lead') {
      team.members = { lead: this.manager.create({ ...base, name: slug, worktree: true, model: settings.models.lead || opts.model, team: { id, role: 'lead' } }).id };
      Object.assign(team, { seen: {}, quest: 1, quests: [] });
      fs.mkdirSync(this.questPath(team, ''), { recursive: true });
      this.send(team, team.members.lead, `This is quest 1. Start the team: ask the analyst for the analysis (${this.questPath(team, 'analysis-1.md')}).`);
      this.save(team);
      return this.view(id);
    }
    const make = (role, extra = {}) =>
      this.manager.create({
        ...base,
        model: settings.models[role] || opts.model,
        engine: settings.engines[role] || opts.engine,
        team: { id, role, ...(extra.n ? { n: extra.n } : {}) },
        ...extra,
      }).id;
    // The implementer owns the worktree and branch; everyone else works in it.
    const owner = make('implementer', { name: slug, worktree: true });
    team.members.implementer = owner;
    const shared = async (agent, { progress }) => {
      progress({ phase: 'Waiting for the team workspace' });
      await this.manager.preparing.get(owner)?.done.catch(() => {});
      const o = this.manager.store.get(owner);
      if (!o?.workdir) throw new Error(`The team workspace could not be prepared${o?.error ? `: ${o.error}` : ''}`);
      return { workdir: o.workdir, repo: o.repo, worktree: false, sharedWith: owner };
    };
    team.members.analyst = make('analyst', { name: `${slug}-analyst`, workspace: shared });
    for (let i = 1; i <= n; i++) team.members.critics.push(make('critic', { name: `${slug}-critic${n > 1 ? i : ''}`, workspace: shared, n: i }));
    team.members.tester = make('tester', { name: `${slug}-tester`, workspace: shared });
    team.members.reviewer = make('reviewer', { name: `${slug}-reviewer`, workspace: shared });

    this.assign(team, [{ role: 'analyst', member: team.members.analyst, kind: 'analysis', file: 'analysis-1.md', text: `Study the problem and the code, then write your analysis to ${this.path(team, 'analysis-1.md')}. End it with "verdict: ready".` }]);
    this.save(team);
    return this.view(id);
  }

  path(team, file) {
    return path.join(team.dir, file);
  }

  /** Where a lead's current quest keeps its files (other teams use the team folder itself). */
  questPath(team, file) {
    return team.mode === 'lead' ? path.join(team.dir, `quest-${team.quest ?? 1}`, file) : this.path(team, file);
  }

  /** Give out the next step: each task names the member, the file it writes and the message it gets. */
  assign(team, tasks) {
    team.waiting = tasks.map(({ role, member, kind, file, n, text }) => ({ role, member, kind, file, ...(n ? { n } : {}), text, since: now() }));
    for (const t of tasks) this.send(team, t.member, t.text);
  }

  /** A member's first message starts its session (with the problem); later ones are typed into it. */
  send(team, member, text) {
    const a = this.manager.store.get(member);
    if (!a) throw err(409, 'A team member was deleted');
    if (!a.lastStartedAt && !this.manager.runtimes.get(member)?.pty) {
      this.manager.patch(member, { kickoff: `Problem to solve:\n${team.intent}\n\n${text}`, desired: 'running' });
      // Still preparing: the workspace setup starts it, since it is now wanted running.
      if (a.status !== 'preparing' && a.workdir) this.manager.start(member);
    } else {
      this.manager.tell(member, text, { source: 'team' });
    }
  }

  /** Read finished handoff files and move the team on. */
  poll() {
    for (const team of Object.values(this.store.data.teams)) {
      // A lead stays between quests: its team is followed until it is stopped.
      if (team.mode === 'lead' ? team.stage === 'stopped' : !ACTIVE.has(team.stage) || !team.waiting.length) continue;
      try {
        if (team.mode === 'lead') this.observe(team);
        else this.check(team);
      } catch (e) {
        console.error(`[agentmgr] team ${team.id}: ${e.message}`);
      }
    }
  }

  /**
   * A lead's team: read the handoff files its sub-agents write, in the order they were written,
   * and follow along. The lead runs the pipeline; this only records it and notices the stops.
   */
  observe(team) {
    let changed = false;
    // A new quest folder with its request: the lead took on new work.
    let top = team.quest ?? 1;
    try {
      for (const d of fs.readdirSync(team.dir)) {
        const n = Number(/^quest-(\d+)$/.exec(d)?.[1]);
        if (n > top && fs.existsSync(path.join(team.dir, d, 'request.md'))) top = n;
      }
    } catch {
      return;
    }
    if (top > (team.quest ?? 1)) {
      this.nextQuest(team, top);
      changed = true;
    }
    let files;
    try {
      files = fs.readdirSync(this.questPath(team, '')).map((name) => ({ name, mtime: fs.statSync(this.questPath(team, name)).mtimeMs }));
    } catch {
      if (changed) this.save(team);
      return;
    }
    // Oldest first; files written at the same moment in pipeline order.
    const rank = (name) => {
      const m = /^(analysis|critique|implementation|test|review)-(\d+)/.exec(name);
      if (!m) return 1e6;
      const step = { analysis: 0, critique: 1, implementation: 0, test: 1, review: 2 }[m[1]];
      return (['analysis', 'critique'].includes(m[1]) ? 0 : 1000) + Number(m[2]) * 10 + step;
    };
    for (const { name, mtime } of files.sort((a, b) => a.mtime - b.mtime || rank(a.name) - rank(b.name))) {
      const rel = `quest-${team.quest}/${name}`;
      if (team.seen[rel] === mtime || Date.now() - mtime < 1500) continue;
      const hit = FILES.map(([re, kind, role]) => [re.exec(name), kind, role]).find(([m]) => m);
      if (!hit) continue;
      const [m, kind, role] = hit;
      const text = fs.readFileSync(this.questPath(team, name), 'utf8');
      const verdict = readVerdict(text, VERDICTS[kind]);
      if (!verdict) continue; // still being written, or the lead asks for the verdict line
      team.seen[rel] = mtime;
      const num = Number(m[1] ?? 0);
      const entry = { at: now(), stage: team.stage, round: kind === 'analysis' || kind === 'critique' ? num : team.round, loop: ['implementation', 'test', 'review'].includes(kind) ? num : team.loop, role, ...(kind === 'critique' ? { n: Number(m[2]) } : {}), member: team.members.lead, file: rel, verdict, summary: summarize(text) };
      // A rewritten file replaces its entry.
      team.history = team.history.filter((h) => h.file !== rel).concat(entry);
      if (kind === 'analysis') team.round = Math.max(team.round, num);
      if (['implementation', 'test', 'review'].includes(kind)) team.loop = Math.max(team.loop, num);
      team.stage = this.leadStage(team, kind, verdict, num);
      if (kind === 'blocked') team.blocked = { reason: entry.summary || 'The team stopped', at: team.history.some((h) => h.role === 'implementer') ? 'loops' : 'discuss', since: now() };
      if (kind === 'final') Object.assign(team, { outcome: 'pr', finishedAt: now() });
      changed = true;
    }
    if (changed) this.save(team);
  }

  /** The lead started quest n: file the current one under earlier quests and follow the new one. */
  nextQuest(team, n) {
    team.quests ??= [];
    team.quests.push({
      n: team.quest ?? 1,
      request: team.request ?? team.intent,
      stage: team.stage,
      outcome: team.outcome ?? (team.stage === 'ready' ? 'approved, left as is' : team.stage === 'done' ? 'done' : `left at ${team.stage}`),
      history: team.history,
      finishedAt: now(),
    });
    let request = '';
    try {
      request = fs.readFileSync(path.join(team.dir, `quest-${n}`, 'request.md'), 'utf8').replace(/^#.*\n/, '').trim();
    } catch {}
    Object.assign(team, { quest: n, request: request || `Quest ${n}`, stage: 'analyze', round: 1, loop: 1, history: [], blocked: null, outcome: null, finishedAt: null });
  }

  /** Give the lead new work from the team view or the CLI: it becomes the next quest. */
  ask(id, text) {
    const team = this.get(id);
    if (team.mode !== 'lead') throw err(409, 'Only a team with a lead takes new requests; start a new team');
    if (team.stage === 'stopped') throw err(409, 'The team is stopped');
    text = String(text ?? '').trim();
    if (!text) throw err(400, 'Say what the team should do');
    this.manager.tell(team.members.lead, `New work from the person, for the next quest (${team.quest + 1}):\n${text}`, { source: 'team' });
    return this.view(id);
  }

  /** Where a lead's team stands after a handoff file. */
  leadStage(team, kind, verdict, num) {
    switch (kind) {
      case 'analysis':
        return team.settings.critics ? 'discuss' : 'implement';
      case 'critique': {
        const round = team.history.filter((h) => h.role === 'critic' && h.round === num);
        return round.length >= team.settings.critics && round.every((h) => h.verdict === 'agree') ? 'implement' : 'discuss';
      }
      case 'implementation':
        return verdict === 'done' ? 'test' : 'implement';
      case 'test':
        return verdict === 'pass' ? 'review' : 'implement';
      case 'review':
        return verdict === 'approve' ? 'ready' : 'implement';
      case 'blocked':
        return 'blocked';
      case 'final':
        return 'done';
      default:
        return team.stage;
    }
  }

  /** Tell a lead's team what the person decided; the lead carries it out. */
  toLead(team, text, stage) {
    team.stage = stage;
    team.blocked = null;
    this.manager.tell(team.members.lead, text, { source: 'team' });
    this.save(team);
    return this.view(team.id);
  }

  check(team) {
    let changed = false;
    for (const w of team.waiting) {
      if (w.verdict) continue;
      let st;
      try {
        st = fs.statSync(this.path(team, w.file));
      } catch {
        continue;
      }
      // Wait until the writer is done: the file has settled and the agent is idle.
      if (Date.now() - st.mtimeMs < 1500) continue;
      const rt = this.manager.runtimes.get(w.member);
      if (rt?.busy || this.manager.outbox.get(w.member)?.length) continue;
      const text = fs.readFileSync(this.path(team, w.file), 'utf8');
      const verdict = readVerdict(text, VERDICTS[w.kind]);
      if (!verdict) {
        if (!w.nagged && Date.now() - st.mtimeMs > 20_000) {
          w.nagged = true;
          changed = true;
          this.manager.tell(w.member, `${this.path(team, w.file)} has no verdict line I can read. End it with one of: ${VERDICTS[w.kind].map((v) => `"verdict: ${v}"`).join(', ')}.`, { source: 'team' });
        }
        continue;
      }
      Object.assign(w, { verdict, summary: summarize(text), at: now() });
      team.history.push({ at: w.at, stage: team.stage, round: team.round, loop: team.loop, role: w.role, n: w.n, member: w.member, file: w.file, verdict, summary: w.summary });
      changed = true;
    }
    if (team.waiting.every((w) => w.verdict)) this.advance(team);
    else if (changed) this.save(team);
  }

  advance(team) {
    const done = team.waiting;
    const f = (file) => this.path(team, file);
    const s = team.settings;
    switch (team.stage) {
      case 'analyze': {
        if (!s.critics) return this.toImplement(team);
        team.stage = 'discuss';
        const analysis = `analysis-${team.round}.md`;
        this.assign(
          team,
          team.members.critics.map((member, i) => {
            const file = `critique-${team.round}-${i + 1}.md`;
            const text =
              team.round === 1
                ? `The analyst's analysis is in ${f(analysis)}. Review it and write your critique to ${f(file)}.`
                : `The analyst revised the analysis after your critique ${f(`critique-${team.round - 1}-${i + 1}.md`)}: ${f(analysis)}. Check whether your points were addressed and write your critique to ${f(file)}.`;
            return { role: 'critic', n: i + 1, member, kind: 'critique', file, text: `${text} End it with "verdict: agree", "verdict: changes" or "verdict: questions".` };
          }),
        );
        break;
      }
      case 'discuss': {
        if (done.every((w) => w.verdict === 'agree')) return this.toImplement(team);
        if (team.round >= s.maxRounds + team.extraRounds) return this.block(team, `The analyst and the critics did not agree in ${team.round} round${team.round > 1 ? 's' : ''}`, 'discuss');
        this.reviseAnalysis(team);
        break;
      }
      case 'implement': {
        const w = done[0];
        if (w.verdict === 'blocked') return this.block(team, `The implementer is blocked: ${w.summary}`, 'implement');
        team.stage = 'test';
        const file = `test-${team.loop}.md`;
        this.assign(team, [{
          role: 'tester', member: team.members.tester, kind: 'test', file,
          text: `The implementer finished round ${team.loop}: notes in ${f(`implementation-${team.loop}.md`)}; the agreed analysis is ${f('analysis.md')}.${s.testCommand ? ` The project's test command is: ${s.testCommand}` : ''} Test it and write your test report to ${f(file)}. End it with "verdict: pass" or "verdict: fail".`,
        }]);
        break;
      }
      case 'test': {
        if (done[0].verdict === 'fail') return this.sendBackFrom(team, 'tester', done[0].file);
        team.stage = 'review';
        const file = `review-${team.loop}.md`;
        const sha = this.manager.store.get(team.members.implementer)?.baseRef?.split(' @ ')[1];
        this.assign(team, [{
          role: 'reviewer', member: team.members.reviewer, kind: 'review', file,
          text: `Review the change on this branch (${sha ? `git diff ${sha.slice(0, 12)}...HEAD` : 'against its base branch'}). Read the analysis ${f('analysis.md')}, the implementation notes ${f(`implementation-${team.loop}.md`)} and the test report ${f(`test-${team.loop}.md`)}. Write your review to ${f(file)}. End it with "verdict: approve" or "verdict: changes".`,
        }]);
        break;
      }
      case 'review': {
        if (done[0].verdict === 'changes') return this.sendBackFrom(team, 'reviewer', done[0].file);
        team.stage = 'ready';
        team.waiting = [];
        break;
      }
      case 'finalizing': {
        team.stage = 'done';
        team.outcome = 'pr';
        team.finishedAt = now();
        team.waiting = [];
        break;
      }
      default:
        return;
    }
    this.save(team);
  }

  reviseAnalysis(team, note) {
    const f = (file) => this.path(team, file);
    const prev = team.round;
    team.round++;
    team.stage = 'analyze';
    const critiques = team.members.critics.map((_, i) => {
      const file = `critique-${prev}-${i + 1}.md`;
      const v = team.history.findLast((h) => h.file === file)?.verdict;
      return `- ${f(file)}${v ? ` (${v})` : ''}`;
    });
    const file = `analysis-${team.round}.md`;
    this.assign(team, [{
      role: 'analyst', member: team.members.analyst, kind: 'analysis', file,
      text: `${critiques.length ? `The critics replied to ${f(`analysis-${prev}.md`)}:\n${critiques.join('\n')}\nRead them and address every point: change the analysis, or say in it why you disagree.` : 'Revise your analysis.'}${note ? `\n\nFrom the person:\n${note}` : ''}\n\nWrite the revised analysis to ${f(file)} and end it with "verdict: ready".`,
    }]);
  }

  toImplement(team) {
    const latest = this.path(team, `analysis-${team.round}.md`);
    if (fs.existsSync(latest)) fs.copyFileSync(latest, this.path(team, 'analysis.md'));
    team.stage = 'implement';
    const file = `implementation-${team.loop}.md`;
    this.assign(team, [{
      role: 'implementer', member: team.members.implementer, kind: 'implementation', file,
      text: `The team agreed on an analysis: ${this.path(team, 'analysis.md')}${team.settings.critics ? ' (the critiques are next to it)' : ''}. Implement it in this working copy and commit on the current branch. Don't push or open a pull request yet. Then write your implementation notes to ${this.path(team, file)} and end them with "verdict: done", or "verdict: blocked" with the reason.`,
    }]);
    this.save(team);
  }

  /** The tester or the reviewer sent the work back: another implementation round, within the limit. */
  sendBackFrom(team, role, file) {
    if (team.loop >= team.settings.maxLoops + team.extraLoops) return this.block(team, `The ${role} still sends the work back after ${team.loop} round${team.loop > 1 ? 's' : ''}`, 'loops');
    this.nextLoop(team, `The ${role} sent the work back: ${this.path(team, file)}.`);
    this.save(team);
  }

  nextLoop(team, why) {
    team.loop++;
    team.stage = 'implement';
    const file = `implementation-${team.loop}.md`;
    this.assign(team, [{
      role: 'implementer', member: team.members.implementer, kind: 'implementation', file,
      text: `${why}\n\nMake the changes, commit, and write your implementation notes for this round to ${this.path(team, file)}, ending with "verdict: done" (or "verdict: blocked" with the reason).`,
    }]);
  }

  block(team, reason, at) {
    team.stage = 'blocked';
    team.blocked = { reason, at, since: now() };
    team.waiting = [];
    this.save(team);
  }

  // ------------------------------------------------------------ the person's calls

  /**
   * After a block: "continue" gives the team one more round (with an optional note), "skip"
   * moves past the disagreement (implement the latest analysis, or accept the work as is).
   */
  resume(id, { action = 'continue', note } = {}) {
    const team = this.get(id);
    if (team.stage !== 'blocked') throw err(409, 'The team is not waiting on you');
    note = note?.trim() || null;
    const at = team.blocked.at;
    if (at === 'member') throw err(409, 'A member was deleted; stop the team instead');
    if (team.mode === 'lead') {
      const from = note ? `\n\nFrom the person:\n${note}` : '';
      if (action === 'skip') {
        if (at === 'discuss') return this.toLead(team, `The person read the disagreement and wants the latest analysis implemented as it is: copy it to ${this.questPath(team, 'analysis.md')} and go on with the implementer.${from}`, 'implement');
        return this.toLead(team, `The person accepted the work as it is. Wait for their decision; don't push or open a pull request yet.${from}`, 'ready');
      }
      if (action !== 'continue') throw err(400, 'action must be "continue" or "skip"');
      return this.toLead(team, `The person read why the team stopped and wants one more ${at === 'discuss' ? 'analysis round' : 'implementation round'}, beyond the limit.${from}\n\nContinue from where the team stopped.`, at === 'discuss' ? 'analyze' : 'implement');
    }
    team.blocked = null;
    if (action === 'skip') {
      if (at === 'discuss') {
        this.toImplement(team);
        return this.view(id);
      }
      if (at === 'loops') {
        team.stage = 'ready';
        this.save(team);
        return this.view(id);
      }
      throw err(400, 'Nothing to skip: the implementer is blocked; continue with a note');
    }
    if (action !== 'continue') throw err(400, 'action must be "continue" or "skip"');
    if (at === 'discuss') {
      team.extraRounds++;
      this.reviseAnalysis(team, note);
    } else {
      if (at === 'loops') team.extraLoops++;
      const last = team.history.findLast((h) => ['test', 'review', 'implement'].includes(h.stage));
      this.nextLoop(team, `${last ? `Latest: ${this.path(team, last.file)} (${last.verdict}).` : ''}${note ? `\n\nFrom the person:\n${note}` : ''}`.trim());
    }
    this.save(team);
    return this.view(id);
  }

  /** At the end: send the approved work back with what the person wants changed. */
  sendBack(id, note) {
    const team = this.get(id);
    if (team.stage !== 'ready') throw err(409, 'The team has nothing waiting for your review');
    note = note?.trim();
    if (!note) throw err(400, 'Say what should change');
    if (team.mode === 'lead') {
      return this.toLead(team, `The person reviewed the team's work and sent it back:\n${note}\n\nStart implementation round ${team.loop + 1} with this (beyond the limit if needed), then test and review again, and stop for the person when the reviewer approves.`, 'implement');
    }
    team.extraLoops++;
    this.nextLoop(team, `The person reviewed the team's work and sent it back:\n${note}`);
    this.save(team);
    return this.view(id);
  }

  /**
   * Accept the approved work. mode "pr": the implementer pushes and opens a pull request;
   * "publish" (no GitHub repository yet): it creates a private one first; "merge": the branch is
   * fast-forwarded into the local base branch; "keep": the branch stays as it is.
   */
  async finalize(id, { mode, pr } = {}) {
    const team = this.get(id);
    if (team.stage !== 'ready') throw err(409, 'The team has nothing waiting for your review');
    mode ??= pr === false ? 'keep' : 'pr';
    if (!['pr', 'publish', 'merge', 'keep'].includes(mode)) throw err(400, 'mode must be pr, publish, merge or keep');
    const owner = this.manager.store.get(team.members.implementer ?? team.members.lead);
    if (mode === 'keep' || mode === 'merge') {
      if (mode === 'merge') await this.merge(owner);
      Object.assign(team, { stage: 'done', outcome: mode === 'merge' ? 'merged' : 'kept', finishedAt: now() });
      this.save(team);
      return this.view(id);
    }
    const remote = owner?.workdir && (await git.hasRemote(owner.workdir));
    if (mode === 'pr' && !remote) throw err(409, 'This project has no remote to open a pull request on: publish it to GitHub, merge into main, or keep the branch');
    const files = `the files are in ${this.questPath(team, '')}`;
    const publish = !remote
      ? `This project has no GitHub repository yet. Create a private one named "${path.basename(owner?.sourceDir ?? team.name)}" with \`gh repo create <name> --private --source ${owner?.sourceDir ?? '.'} --remote origin\`, push the base branch and this branch to it, then open`
      : 'Push the branch and open';
    const finalText = `The person approved the team's work. ${publish} a pull request with a title from the problem and a body that summarizes the analysis, the changes, the test report and the review (${files}). Then write the pull request's link to ${this.questPath(team, 'final.md')} and end it with "verdict: done".`;
    if (team.mode === 'lead') return this.toLead(team, finalText, 'finalizing');
    team.stage = 'finalizing';
    this.assign(team, [{
      role: 'implementer', member: team.members.implementer, kind: 'final', file: 'final.md',
      text: `The team's work is approved. ${publish} a pull request with a title from the problem and a body that summarizes the analysis, the changes, the test report and the review (${files}). Then write the pull request's link to ${this.path(team, 'final.md')} and end it with "verdict: done".`,
    }]);
    this.save(team);
    return this.view(id);
  }

  /** Fast-forward the base branch, checked out in the main folder, to the team's branch. */
  async merge(owner) {
    if (!owner?.sourceDir || !owner.branch) throw err(409, "The team's branch isn't in a worktree of a local repository; merge it yourself");
    const top = owner.sourceDir;
    const current = await git.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: top });
    const dirty = await git.run('git', ['status', '--porcelain'], { cwd: top });
    if (dirty) throw err(409, `${top} has uncommitted changes; commit or stash them, then merge`);
    try {
      await git.run('git', ['merge', '--ff-only', owner.branch], { cwd: top });
    } catch {
      throw err(409, `${current} in ${top} has moved since the team branched; merge ${owner.branch} yourself, or send the work back`);
    }
  }

  /** Stop the team: its agents close (they can be resumed); nothing is deleted. */
  async stop(id) {
    const team = this.get(id);
    Object.assign(team, { stage: 'stopped', waiting: [], blocked: null, finishedAt: now() });
    this.save(team);
    for (const m of this.memberList(team)) if (this.manager.store.get(m.id)) await this.manager.stop(m.id).catch(() => {});
    return this.view(id);
  }

  /** Forget the team; with `agents`, delete its agents and the worktree too. */
  async remove(id, { agents = false } = {}) {
    const team = this.get(id);
    delete this.store.data.teams[id];
    this.save();
    this.emit('removed', id);
    if (agents) {
      // The owner last, so the shared worktree goes when nobody else is in it.
      const ownerId = team.members.implementer ?? team.members.lead;
      for (const m of this.memberList(team).filter((x) => x.id !== ownerId)) if (this.manager.store.get(m.id)) await this.manager.remove(m.id).catch(() => {});
      if (this.manager.store.get(ownerId)) await this.manager.remove(ownerId, { deleteWorkspace: true }).catch(() => {});
      fs.rmSync(team.dir, { recursive: true, force: true });
    }
    return { ok: true };
  }

  /** One handoff file's text. */
  file(id, name) {
    const team = this.get(id);
    if (!/^(quest-\d+\/)?[\w-][\w.-]*\.md$/.test(name)) throw err(400, 'Not a team file');
    try {
      return { name, markdown: fs.readFileSync(this.path(team, name), 'utf8') };
    } catch {
      throw err(404, `No file ${name} yet`);
    }
  }

  view(id) {
    const team = this.get(id);
    const members = this.memberList(team).map((m) => {
      const a = this.manager.store.get(m.id);
      const rt = this.manager.runtimes.get(m.id);
      const costs = (a?.sessions ?? []).map((s) => s.cost?.usd).filter((c) => c != null);
      return {
        ...m,
        status: a?.status ?? 'deleted',
        working: Boolean(rt?.pty && rt.busy),
        model: a?.model ?? null,
        engine: a?.engine ?? null,
        costUsd: costs.length ? costs.reduce((x, y) => x + y, 0) : null,
        turn: team.mode === 'lead' ? ACTIVE.has(team.stage) : team.waiting.some((w) => w.member === m.id && !w.verdict),
      };
    });
    let files = [];
    try {
      files = fs.readdirSync(this.questPath(team, '')).filter((f) => f.endsWith('.md')).sort();
    } catch {}
    const costs = members.map((m) => m.costUsd).filter((c) => c != null);
    const owner = this.manager.store.get(team.members.implementer ?? team.members.lead);
    return {
      ...team,
      mode: team.mode ?? 'agents',
      members,
      // A lead's roles, played by its sub-agents.
      subagents: team.mode === 'lead' ? SUB_ROLES.filter((r) => r !== 'critic' || team.settings.critics).map((role) => ({ role, model: team.settings.models?.[role] ?? null })) : [],
      files,
      branch: owner?.branch ?? null,
      folder: owner?.sourceDir ?? owner?.workdir ?? null,
      // No GitHub (or other) remote: publish, merge locally or keep, instead of a pull request.
      remote: Boolean(owner?.git?.remote),
      prs: Object.values(owner?.prs ?? {}).map((p) => ({ url: p.url, number: p.number, state: p.state })),
      costUsd: costs.length ? costs.reduce((x, y) => x + y, 0) : null,
    };
  }
}
