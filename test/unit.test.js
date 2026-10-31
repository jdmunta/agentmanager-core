import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { repoNameFromUrl, isRemoteUrl } from '../src/git.js';
import { AgentManager, slugify } from '../src/manager.js';
import { STATE_VERSION, Store } from '../src/store.js';
import { checkSummary, claudeProjectDir, compactPr, extractRefs, landState, leadingJiraKey, scanTranscript } from '../src/tracker.js';
import { checksMessage, landingSettings, reviewMessage } from '../src/landing.js';
import { issueIntent, prCommand, tokenMatches, triggerSettings } from '../src/triggers.js';
import { budgetSettings, costOf, dayKey } from '../src/budgets.js';
import { sourceOf, stats } from '../src/stats.js';
import { cleanSchedule, nextRun, placeholders, render } from '../src/playbooks.js';
import { cleanLearning, memoryKey, memoryPrompt } from '../src/memory.js';
import { passEnv, plist, unit } from '../src/service.js';
import { stripChrome } from '../src/judge.js';
import claude from '../src/engines/claude.js';
import { notInstalled } from '../src/engines/index.js';
import { Cleanup, cleanupSettings } from '../src/cleanup.js';
import { checkUpdate, gitBlocker, installUpdate, newestTag } from '../src/update.js';
import { claudeAccount } from '../src/identity.js';
import { isText, languageOf, resolveInside } from '../src/studio.js';
import { commentsMessage, parseBaseRef, prBase } from '../src/review.js';
import { parseDiff } from '../public/review.js';
import { VERDICTS, gapsOf, leadPrompt, readCoverage, readVerdict, subagents, summarize, teamPrompt } from '../src/teams.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentmgr-unit-'));

test('slugify', () => {
  assert.equal(slugify('Fix the flaky Login test!!'), 'fix-the-flaky-login-test');
  assert.equal(slugify('***'), 'agent');
  assert.ok(slugify('a'.repeat(100)).length <= 30);
});

test('repo helpers', () => {
  assert.equal(repoNameFromUrl('https://github.com/org/my-repo.git'), 'my-repo');
  assert.equal(repoNameFromUrl('git@github.com:org/other.git'), 'other');
  assert.ok(isRemoteUrl('git@github.com:org/other.git'));
  assert.ok(isRemoteUrl('https://github.com/org/x'));
  assert.ok(!isRemoteUrl('~/projects/x'));
  assert.ok(!isRemoteUrl('/abs/path'));
});

test('claudeProjectDir encodes the cwd the way Claude Code does', () => {
  const d = tmp();
  const real = fs.realpathSync(d);
  assert.ok(claudeProjectDir(d).endsWith(real.replace(/[^a-zA-Z0-9]/g, '-')));
});

test('extractRefs finds PR, Jira, GitHub issue and custom bug refs', () => {
  const text = `Opened https://github.com/acme/api/pull/12 for https://acme.atlassian.net/browse/PROJ-9,
    see https://github.com/acme/api/issues/5 and ABC-777. UTF-8 is not a bug.`;
  const { prs, bugs } = extractRefs(text, ['\\bABC-\\d+\\b']);
  assert.deepEqual(prs.map((p) => [p.repo, p.number]), [['acme/api', 12]]);
  assert.deepEqual(bugs.map((b) => b.key).sort(), ['ABC-777', 'PROJ-9', 'acme/api#5']);
});

test('leadingJiraKey names an agent after a Jira link at the start of its request', () => {
  assert.equal(leadingJiraKey('https://acme.atlassian.net/browse/OPS-3 fix the login timeout'), 'OPS-3');
  assert.equal(leadingJiraKey('  https://acme.atlassian.net/jira/software/projects/PROJ/issues/PROJ-12\nSee the comments'), 'PROJ-12');
  assert.equal(leadingJiraKey('https://jira.example.com/jira/polaris/projects/IDEA/ideas/view/1?selectedIssue=IDEA-872'), 'IDEA-872');
  assert.equal(leadingJiraKey('Fix the login timeout: https://acme.atlassian.net/browse/OPS-3'), null);
  assert.equal(leadingJiraKey('https://github.com/acme/app/issues/4 fix it'), null);
  assert.equal(leadingJiraKey(''), null);
});

test('extractRefs finds Jira keys in board, Polaris and issue links', () => {
  const polaris =
    'https://jira.example.com/jira/polaris/projects/IDEA/ideas/view/d2229b85-2dc4-49b3-b232-65879a8b360e?selectedIssue=IDEA-872';
  const text = `Study this request and propose the fix: ${polaris}. Also https://acme.atlassian.net/jira/software/projects/PROJ/issues/PROJ-12, see (https://acme.atlassian.net/browse/OPS-3).`;
  const { bugs } = extractRefs(text);
  assert.deepEqual(
    bugs.map((b) => [b.key, b.url]),
    [
      ['IDEA-872', polaris],
      ['PROJ-12', 'https://acme.atlassian.net/jira/software/projects/PROJ/issues/PROJ-12'],
      ['OPS-3', 'https://acme.atlassian.net/browse/OPS-3'],
    ],
  );
  // A custom pattern does not duplicate a key already found in a link.
  assert.equal(extractRefs(`${polaris} IDEA-872`, ['\\bIDEA-\\d+\\b']).bugs.length, 1);
});

test('parseProgress reads git progress lines', async () => {
  const { parseProgress } = await import('../src/git.js');
  assert.deepEqual(parseProgress('Receiving objects:  45% (10/22), 2.10 GiB | 2.40 MiB/s'), {
    step: 'Receiving objects',
    percent: 45,
    size: '2.10 GiB',
    rate: '2.40 MiB/s',
  });
  assert.equal(parseProgress('remote: Counting objects:  12% (1/8)').percent, 12);
  assert.equal(parseProgress('Cloning into x...'), null);
});

test('scanTranscript reads incrementally and ignores partial lines', () => {
  const file = path.join(tmp(), 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'ai-title', aiTitle: 'T1' }) + '\n{"type":"pr-li');
  const cursor = { offset: 0 };
  let r = scanTranscript(file, cursor);
  assert.equal(r.title, 'T1');
  assert.equal(r.prs.length, 0);
  fs.appendFileSync(file, 'nk","prNumber":3,"prUrl":"https://github.com/a/b/pull/3"}\n');
  r = scanTranscript(file, cursor);
  assert.equal(r.title, null);
  assert.deepEqual(r.prs.map((p) => [p.number, p.source]), [[3, 'session']]);
  assert.equal(scanTranscript(file, cursor).prs.length, 0);
});

test('scanTranscript: last message time ignores lines a resume appends', () => {
  const file = path.join(tmp(), 's.jsonl');
  const lines = [
    { type: 'user', timestamp: '2026-10-20T10:00:00.000Z', message: { content: 'go' } },
    { type: 'assistant', timestamp: '2026-10-20T10:05:00.000Z', message: { content: [{ type: 'text', text: 'done' }] } },
    { type: 'user', isMeta: true, timestamp: '2026-10-27T09:00:00.000Z', message: { content: 'meta' } },
    { type: 'last-prompt', lastPrompt: 'go' },
    { type: 'cost-state', totalCostUSD: 0.1 },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(scanTranscript(file, { offset: 0 }).lastMessageAt, '2026-10-20T10:05:00.000Z');
});

test('Store persists and resolves by id, prefix and name', () => {
  const file = path.join(tmp(), 'state.json');
  const s = new Store(file);
  s.put({ id: 'abc123', name: 'alpha', createdAt: '2026-01-01' });
  s.put({ id: 'abd456', name: 'beta', createdAt: '2026-01-02' });
  const s2 = new Store(file);
  assert.equal(s2.resolve('abc123').name, 'alpha');
  assert.equal(s2.resolve('abd').name, 'beta');
  assert.equal(s2.resolve('ab'), undefined); // ambiguous prefix
  assert.equal(s2.resolve('beta').id, 'abd456');
});

test('Store refuses state from a newer version and keeps a startup backup', () => {
  const file = path.join(tmp(), 'state.json');
  const s = new Store(file);
  s.put({ id: 'abc123', name: 'alpha', createdAt: '2026-01-01' });
  new Store(file);
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).agents.abc123.name, 'alpha', 'copy as it was at startup');
  fs.writeFileSync(file, JSON.stringify({ version: STATE_VERSION + 1, agents: {} }));
  assert.throws(() => new Store(file), /newer AI Agent Manager/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, STATE_VERSION + 1, 'left untouched');
  fs.writeFileSync(file, '{ broken');
  assert.throws(() => new Store(file), /state\.json\.bak/);
});

test('trustFolder pre-accepts the trust prompt without touching other settings', async () => {
  const cfg = tmp();
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    const { trustFolder } = await import('../src/trust.js');
    const file = path.join(cfg, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', projects: { '/x': { allowedTools: ['Read'] } } }));
    const dir = tmp();
    assert.equal(trustFolder(dir), true);
    assert.equal(trustFolder(dir), false, 'second call is a no-op');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data.theme, 'dark');
    assert.deepEqual(data.projects['/x'], { allowedTools: ['Read'] });
    assert.equal(data.projects[fs.realpathSync(dir)].hasTrustDialogAccepted, true);
    assert.ok(fs.existsSync(`${file}.agentmgr-backup`));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('token usage counts each API response once and includes subagents', async () => {
  const { sumUsage } = await import('../src/tracker.js');
  const file = path.join(tmp(), 'u.jsonl');
  const line = (id, out) =>
    JSON.stringify({
      type: 'assistant',
      message: { id, usage: { input_tokens: 10, output_tokens: out, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 } },
    }) + '\n';
  // msg_1 is split over two lines (two content blocks); the last line has the final output count.
  fs.writeFileSync(file, line('msg_1', 5) + line('msg_1', 7) + line('msg_2', 3));
  const cursor = { offset: 0 };
  scanTranscript(file, cursor);
  const sub = path.join(tmp(), 'sub.jsonl');
  fs.writeFileSync(sub, line('msg_s', 1));
  const subCursor = { offset: 0 };
  scanTranscript(sub, subCursor);
  assert.deepEqual(sumUsage(cursor.usage, subCursor.usage), {
    input: 30,
    output: 11,
    cacheCreation: 300,
    cacheRead: 3000,
    requests: 3,
    io: 41,
    total: 3341,
  });
});

test('parseBrief reads the four sections, check states and the mermaid block', async () => {
  const { parseBrief } = await import('../src/brief.js');
  const b = parseBrief(`# Brief
## Problem Statement
Users can't log in.

## Approach
Refresh tokens **before** expiry.

## Design / Flow / Architecture
\`\`\`mermaid
sequenceDiagram
  A->>B: refresh
\`\`\`
Notes under the diagram.

## Verification
- [x] unit tests
- [!] e2e
- [~] lint
- [ ] manual check
- not a check line

## Something else
ignored
`);
  assert.equal(b.problem, "Users can't log in.");
  assert.equal(b.solution, 'Refresh tokens **before** expiry.');
  assert.equal(b.diagram, 'sequenceDiagram\n  A->>B: refresh');
  assert.equal(b.diagramNotes, 'Notes under the diagram.');
  assert.deepEqual(b.checks.map((c) => c.state), ['passed', 'failed', 'running', 'pending']);
  assert.deepEqual(b.summary, { passed: 1, failed: 1, running: 1, pending: 1, total: 4 });
  assert.equal(parseBrief('## Diagram\nno code block here').diagram, null);
});

test('parseBrief reads PRD / Tech Spec references from the linked Jira issue', async () => {
  const { parseBrief } = await import('../src/brief.js');
  const b = parseBrief(`## Problem
x
## References
- **PRD**: [Fusion rebalance PRD](https://confluence.example.com/prd/123) — must finish within 30 minutes
- **Tech Spec**: none on IDEA-872
- **Design doc**: https://docs.example.com/d/9 - sequence of the accelerator handoff
- Related: [ABC-1](https://jira.example.com/browse/ABC-1)
`);
  assert.deepEqual(
    b.references.map((r) => [r.label, r.title, r.url, r.highlight, r.key, r.missing]),
    [
      ['PRD', 'Fusion rebalance PRD', 'https://confluence.example.com/prd/123', 'must finish within 30 minutes', true, false],
      ['Tech Spec', null, null, 'none on IDEA-872', true, true],
      ['Design doc', null, 'https://docs.example.com/d/9', 'sequence of the accelerator handoff', true, false],
      ['Related', 'ABC-1', 'https://jira.example.com/browse/ABC-1', '', false, false],
    ],
  );
});

test('sessionDigest keeps the ask, the agent\'s words and one line per action', async () => {
  const { sessionDigest } = await import('../src/tracker.js');
  const file = path.join(tmp(), 'd.jsonl');
  const rec = (type, content, extra = {}) => JSON.stringify({ type, message: { content }, ...extra }) + '\n';
  fs.writeFileSync(
    file,
    rec('user', 'Fix the login bug <system-reminder>noise</system-reminder>') +
      rec('assistant', [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'Plan: 1) reproduce 2) fix' }]) +
      rec('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'go test ./auth', description: 'Run auth tests' } }]) +
      rec('user', [{ type: 'tool_result', content: 'huge output' }]) +
      rec('assistant', [{ type: 'tool_use', name: 'Edit', input: { file_path: '/r/auth/session.go' } }]) +
      rec('assistant', [{ type: 'tool_use', name: 'Read', input: { file_path: '/r/x.go' } }]) +
      rec('assistant', [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Keep the old API?' }] } }]) +
      rec('user', 'meta', { isMeta: true }),
  );
  const d = sessionDigest(file);
  assert.deepEqual(d.digest.split('\n'), [
    '[user] Fix the login bug',
    '[agent] Plan: 1) reproduce 2) fix',
    '[action] ran: Run auth tests',
    '[action] edited /r/auth/session.go',
    '[action] asked the user: Keep the old API?',
  ]);
  assert.deepEqual(d.edited, ['/r/auth/session.go']);
  // Over budget: the first request stays, the oldest of the rest are dropped.
  const small = sessionDigest(file, { maxChars: 90 }).digest.split('\n');
  assert.equal(small[0], '[user] Fix the login bug');
  assert.match(small[1], /earlier events omitted/);
  assert.equal(small.at(-1), '[action] asked the user: Keep the old API?');
});

test('projectOf groups by repo across URL forms, then folder, general and other', async () => {
  const { projectOf } = await import('../src/manager.js');
  const https = projectOf({ repo: 'https://github.com/acme/cloud-console.git' });
  const ssh = projectOf({ git: { remote: 'git@github.com:acme/cloud-console.git' } });
  assert.equal(https.key, ssh.key, 'URL and a clone of the same repo group together');
  assert.equal(https.name, 'cloud-console');
  assert.equal(https.full, 'acme/cloud-console');
  assert.equal(projectOf({ kind: 'general' }).name, 'General');
  assert.equal(projectOf({ sourceDir: '/Users/me/src/tools', workdir: '/x' }).name, 'tools');
  assert.equal(projectOf({ workdir: '/Users/me/notes' }).name, 'notes');
  assert.equal(projectOf({}).name, 'Other');
  assert.deepEqual(projectOf({ project: 'Fusion', repo: 'https://github.com/a/b' }), { key: 'custom:fusion', name: 'Fusion', source: 'custom' });
});

test('parseBrief reads the status line', async () => {
  const { parseBrief } = await import('../src/brief.js');
  assert.equal(parseBrief('# Brief\nStatus: done\n## Problem\nx').status, 'done');
  assert.equal(parseBrief('**Status:** Blocked\n## Problem\nx').status, 'blocked');
  assert.equal(parseBrief('## Problem\nStatus: done is not the status line').status, null);
});

test('suggestShortcut makes short, unique project shortcuts', async () => {
  const { suggestShortcut } = await import('../src/manager.js');
  const taken = new Set();
  const take = (n) => {
    const s = suggestShortcut(n, taken);
    taken.add(s);
    return s;
  };
  assert.equal(take('cloud-console'), 'cc');
  assert.equal(take('ai-gateway'), 'ag');
  assert.equal(take('agentmanager'), 'age');
  assert.equal(take('code-coverage'), 'cc2', 'collisions get a number');
});

test('parseBrief reads Results: outcome, delivered, blocked by', async () => {
  const { parseBrief } = await import('../src/brief.js');
  const r = parseBrief(`## Problem
x
## Results
**Outcome:** Partial
- Delivered: PR https://github.com/a/b/pull/9
- Delivered: design doc
- **Blocked by:** QA environment (needs: QE)
Some notes.
`).results;
  assert.deepEqual(r, {
    outcome: 'partial',
    delivered: ['PR https://github.com/a/b/pull/9', 'design doc'],
    blockers: ['QA environment (needs: QE)'],
    notes: 'Some notes.',
  });
});

// ------------------------------------------------------------------ v0.2: conflicts, stuck, inbox

test('conflict radar: same lines vs same file, merge order, and related agents skipped', async () => {
  const { findConflicts, summarize } = await import('../src/conflicts.js');
  const e = (id, files, extra = {}) => ({ agent: { id, name: id, sourceDir: '/clone', prs: {}, ...extra }, baseSha: 'b1', changes: { files } });
  const f = (ranges, added = 1, removed = 1) => ({ ranges, added, removed });
  const out = findConflicts([
    e('a', { 'x.js': f([[10, 12]], 3, 1), 'y.js': f([[1, 1]]) }),
    e('b', { 'x.js': f([[14, 20]], 20, 5), 'y.js': f([[90, 95]]) }),
    e('c', { 'z.js': f([[1, 1]]) }),
    e('race1', { 'x.js': f([[10, 10]]) }, { raceId: 'r' }),
    e('race2', { 'x.js': f([[10, 10]]) }, { raceId: 'r' }),
    e('other-repo', { 'x.js': f([[10, 10]]) }, { sourceDir: '/elsewhere' }),
  ]);
  const ab = summarize(out.get('a')).find((g) => g.agent.id === 'b');
  assert.deepEqual(ab.files, [{ file: 'x.js', severity: 'lines' }, { file: 'y.js', severity: 'file' }]);
  assert.equal(ab.mergeFirst, 'a', 'smaller change lands first');
  assert.ok(!out.has('c'));
  assert.ok(!summarize(out.get('race1')).some((g) => g.agent.id === 'race2'), 'race attempts are not conflicts of each other');
  assert.ok(!out.has('other-repo'));
  // A merged PR goes first regardless of size; different bases can't compare lines.
  const merged = findConflicts([e('a', { 'x.js': f([[1, 1]]) }), { ...e('b', { 'x.js': f([[1, 1]], 99, 99) }, { prs: { u: { state: 'MERGED' } } }), baseSha: 'b2' }]);
  assert.equal(merged.get('a')[0].mergeFirst, 'b');
  assert.equal(merged.get('a')[0].severity, 'file');
});

test('stuck detection: repeat, thrash and drift, and not when things change', async () => {
  const { detectStuck } = await import('../src/stuck.js');
  const t = Date.now();
  const cmd = (i, result, failed = true) => ({ t: t - 60_000 + i, kind: 'cmd', cmd: 'go test', failed, result });
  assert.equal(detectStuck([cmd(1, 'FAIL a'), cmd(2, 'FAIL a'), cmd(3, 'FAIL a')])[0]?.kind, 'repeat');
  assert.equal(detectStuck([cmd(1, 'FAIL a'), cmd(2, 'FAIL b'), cmd(3, 'FAIL a')]).length, 0, 'different failures = progress');
  assert.equal(detectStuck([cmd(1, 'FAIL a'), cmd(2, 'FAIL a'), cmd(3, 'ok', false)]).length, 0, 'it passed in the end');
  const ed = (i, o, n) => ({ t: t - 50_000 + i, kind: 'edit', file: '/r/a.go', edits: [[o, n]] });
  assert.equal(detectStuck([ed(1, 'x', 'y'), ed(2, 'y', 'x'), ed(3, 'x', 'y')])[0]?.kind, 'thrash');
  const reads = Array.from({ length: 30 }, (_, i) => ({ t: t - 25 * 60_000 + i * 50_000, kind: 'other', name: 'Read' }));
  assert.equal(detectStuck(reads)[0]?.kind, 'drift');
  assert.equal(detectStuck(reads, { now: t + 3 * 3600_000 }).length, 0, 'idle for hours is not drifting');
});

test('inbox: QUESTIONS.md parsing and menu choices from terminal output', async () => {
  const { parseQuestions, promptChoices } = await import('../src/inbox.js');
  const qs = parseQuestions('## Which DB?\nOptions: A | B\nDefault: A\nwhy\n## Which DB?\n### Q2: Port?\nAssuming: 8080\n');
  assert.equal(qs.length, 2, 'duplicates collapse');
  assert.deepEqual([qs[0].options, qs[0].default, qs[0].context], [['A', 'B'], 'A', 'why']);
  assert.equal(qs[1].question, 'Port?');
  assert.equal(qs[1].default, '8080');
  // Claude's TUI positions words with cursor moves, not spaces.
  const p = promptChoices('Do\x1b[1Cyou\x1b[1Cwant\x1b[1Cto\x1b[1Cmake\x1b[1Cthis\x1b[1Cedit?\r\n\x1b[2m❯ 1. Yes\x1b[0m\r\n  2. Yes, allow all edits\r\n  3. No\r\n');
  assert.equal(p.question, 'Do you want to make this edit?');
  assert.deepEqual(p.choices.map((c) => c.key), ['1', '2', '3']);
  assert.equal(p.choices[1].label, 'Yes, allow all edits');
});

test('fleet views carry only whitelisted fields, trimmed, and honor the project filter', async () => {
  const { fleetAgent, fleetState, fleetInboxItem, fleetUrls } = await import('../src/fleet.js');
  const view = {
    id: 'abc123', name: 'fix-login', status: 'running', intent: 'x'.repeat(5000), workdir: '/Users/me/secret', sessionId: 's-1',
    sourceDir: '/Users/me/repo', repo: '/Users/me/repo', projectInfo: { name: 'cc' }, git: { branch: 'agent/fix' },
    runtime: { busy: true, lastOutputAt: '2026-10-18T10:15:42.123Z' }, prs: [{ url: 'javascript:alert(1)' }, { url: 'https://github.com/o/r/pull/7', number: 7, state: 'OPEN' }],
    questions: [{ id: 'q1' }, { id: 'q2', answer: 'yes' }], stuck: [], conflicts: [{}], brief: { results: 'secret notes' },
  };
  const a = fleetAgent(view);
  for (const k of ['workdir', 'sessionId', 'sourceDir', 'brief', 'sessions']) assert.ok(!(k in a), `${k} must not be sent`);
  assert.equal(a.repo, null, 'local paths are not sent as the repo');
  assert.equal(a.intent.length, 600);
  assert.equal(a.project, 'cc');
  assert.equal(a.working, true);
  assert.equal(a.lastOutputAt, '2026-10-18T10:15:00.000Z', 'rounded to the minute');
  assert.deepEqual(a.prs.map((p) => p.number), [7], 'non-http links dropped');
  assert.deepEqual([a.questions, a.stuck, a.conflicts], [1, 0, 1]);
  assert.deepEqual(fleetAgent(a), a, 'idempotent, so the hub can run it again');

  const other = { ...view, id: 'def456', projectInfo: { name: 'web' } };
  const inbox = [{ kind: 'question', key: 'q', agentId: 'abc123', project: 'cc', title: 'Which DB?', question: { id: 'q1', options: ['pg', 'sqlite'], context: 'long' } }, { kind: 'bogus', agentId: 'abc123' }];
  const all = fleetState({ agents: [view, other], inbox });
  assert.equal(all.agents.length, 2);
  assert.equal(all.inbox.length, 1, 'unknown inbox kinds dropped');
  assert.deepEqual(all.inbox[0].question, { id: 'q1', options: ['pg', 'sqlite'], context: 'long', default: null });
  const onlyCc = fleetState({ agents: [view, other], inbox }, { projects: ['cc'] });
  assert.deepEqual(onlyCc.agents.map((x) => x.id), ['abc123']);
  assert.deepEqual(fleetState({ agents: [{ ...other, projectInfo: { name: 'web-app', shortcut: 'web' } }] }, { projects: ['web'] }).agents.length, 1, 'shortcuts work too');
  assert.equal(fleetState({ agents: [view], inbox: [{ ...inbox[0], agentId: 'zzz' }] }).inbox.length, 0, 'inbox items of unshared agents are dropped');
  assert.equal(fleetAgent({ id: 'x', projectInfo: { key: 'other', name: 'Other' } }).project, null);
  assert.equal(fleetInboxItem({ kind: 'prompt', agentId: 'a', prompt: { choices: [{ key: '1', label: 'Yes' }] } }).choices[0].label, 'Yes');
  assert.deepEqual(fleetUrls([{ url: 'https://100.101.1.2:4718/', tailscale: true }, { url: 'file:///etc/passwd' }]).map((u) => u.url), ['https://100.101.1.2:4718/']);
});

test('hub URLs: https anywhere, plain http only for localhost or Tailscale', async () => {
  const { checkHubUrl, isTailscaleHost } = await import('../src/fleet.js');
  assert.equal(checkHubUrl('https://my-hub.up.railway.app/'), 'https://my-hub.up.railway.app');
  assert.equal(checkHubUrl('http://127.0.0.1:4720'), 'http://127.0.0.1:4720');
  assert.equal(checkHubUrl('http://100.88.1.2:4720'), 'http://100.88.1.2:4720');
  assert.equal(checkHubUrl('http://mini.tail1234.ts.net:4720'), 'http://mini.tail1234.ts.net:4720');
  assert.throws(() => checkHubUrl('http://10.0.0.54:4720'), /https/);
  assert.throws(() => checkHubUrl('http://hub.example.com'), /https/);
  assert.throws(() => checkHubUrl('not a url'), /Hub URL/);
  assert.ok(isTailscaleHost('100.64.0.1') && isTailscaleHost('100.127.255.1'));
  assert.ok(!isTailscaleHost('100.63.0.1') && !isTailscaleHost('100.128.0.1') && !isTailscaleHost('10.0.0.1'));
});

test('hub actions: permission per action, exact IDs, shared projects, no skipped permission prompts', async () => {
  const { runAction, terminalPermission } = await import('../src/hubactions.js');
  const calls = [];
  const agents = { a1: { id: 'a1', name: 'one', project: 'web' }, a2: { id: 'a2', name: 'two', project: 'api' } };
  const manager = {
    store: { get: (id) => agents[id] },
    projectInfo: (a) => ({ key: `custom:${a.project}`, name: a.project, shortcut: a.project }),
    resolveProject: (ref) => (['web', 'api'].includes(ref) ? { shortcut: ref, name: ref } : null),
    tell: (id, text) => (calls.push(['tell', id, text]), { id, name: agents[id].name }),
    createMany: (intents, opts) => (calls.push(['create', intents, opts]), [{ id: 'n1', name: 'new' }]),
  };
  const policy = (allow, projects = ['*']) => ({ allow, projects });
  await assert.rejects(runAction(manager, policy(['view']), 'tell', { agent: 'a1', text: 'hi' }), /doesn't allow "control"/);
  await assert.rejects(runAction(manager, policy(['control']), 'tell', { agent: 'a', text: 'hi' }), /No such agent/);
  await assert.rejects(runAction(manager, policy(['control'], ['web']), 'tell', { agent: 'a2', text: 'hi' }), /does not share that project/);
  await assert.rejects(runAction(manager, policy(['control']), 'constructor', {}), /Unknown action/);
  await assert.rejects(runAction(manager, policy(['control']), 'tell', { agent: 'a1', text: '  ' }), /Text is required/);
  assert.deepEqual(await runAction(manager, policy(['control']), 'tell', { agent: 'a1', text: 'hi' }), { ok: true, agent: { id: 'a1', name: 'one', status: undefined } });
  await assert.rejects(runAction(manager, policy(['create']), 'create', { project: 'web', intent: 'x', permissionMode: 'bypassPermissions' }), /Permission mode/);
  await assert.rejects(runAction(manager, policy(['create'], ['api']), 'create', { project: 'web', intent: 'x' }), /does not share/);
  await assert.rejects(runAction(manager, policy(['create']), 'create', { project: '/etc', intent: 'x' }), /Pick one of the projects/);
  assert.equal((await runAction(manager, policy(['create']), 'create', { project: 'web', intent: 'Do it', permissionMode: 'plan' })).agents[0].id, 'n1');
  assert.deepEqual(calls.at(-1)[2], { project: 'web', priority: undefined, model: undefined, permissionMode: 'plan', engine: undefined });
  // An engine the machine doesn't have is refused before anything starts.
  manager.config = { engines: { codex: { bin: '/nonexistent/codex' } } };
  await assert.rejects(runAction(manager, policy(['create']), 'create', { project: 'web', intent: 'x', engine: 'codex' }), /Codex isn't installed/);
  await assert.rejects(runAction(manager, policy(['create']), 'create', { project: 'web', intent: 'x', engine: 'nope' }), /Unknown engine/);
  assert.deepEqual(terminalPermission('claude'), { kind: 'claude', perm: 'terminal' });
  assert.deepEqual(terminalPermission('shell:2'), { kind: 'shell:2', perm: 'shell' });
  assert.throws(() => terminalPermission('shell:0'), /Unknown terminal/);
  assert.throws(() => terminalPermission('bash'), /Unknown terminal/);
});

test('hub backlog placement: constraints, capacity, warm start, then spread', async () => {
  const { pickRunner } = await import('../src/hubbacklog.js');
  const { projectRef } = await import('../src/fleet.js');
  assert.equal(projectRef({ key: 'repo:github.com/acme/app', name: 'app' }), 'repo:github.com/acme/app');
  assert.equal(projectRef({ key: 'repo:/Users/me/x', name: 'x' }), 'name:x', 'local paths never leave the machine');
  assert.equal(projectRef({ key: 'dir:/Users/me/site', name: 'Site' }), 'name:site');
  const ref = 'repo:github.com/acme/app';
  const runner = (name, { allow = ['view', 'create'], warm = true, max = 2, busy = 0, running = 0, labels = ['os:mac'], online = true } = {}) => ({
    id: name,
    name,
    online,
    policy: { allow },
    state: {
      projects: [{ shortcut: name.slice(0, 2), name: 'app', ref, warm }],
      capacity: { max, perProject: 2, busy, busyBy: {} },
      labels,
      agents: Array.from({ length: running }, (_, i) => ({ id: `${i}`, status: 'running' })),
    },
  });
  const item = (extra = {}) => ({ id: 'i1', project: ref, labels: [], avoid: [], ...extra });

  // Warm start beats load: a clone can take minutes.
  let p = pickRunner(item(), [runner('cold', { warm: false }), runner('warm', { running: 5 })], []);
  assert.equal(p.runner.name, 'warm');
  assert.equal(p.shortcut, 'wa');
  // Otherwise the least loaded.
  p = pickRunner(item(), [runner('busy', { running: 6 }), runner('idle', { running: 1 })], []);
  assert.equal(p.runner.name, 'idle');
  // Items the hub already put there count, and full machines are skipped.
  const holding = [{ runnerId: 'a', status: 'active', project: ref }, { runnerId: 'a', status: 'active', project: ref }];
  p = pickRunner(item(), [runner('a'), runner('b', { warm: false })], holding);
  assert.equal(p.runner.name, 'b');
  p = pickRunner(item(), [runner('a')], holding);
  assert.equal(p.runner, null);
  assert.match(p.why, /a is full/);
  assert.equal(pickRunner(item(), [runner('a')], holding, { ignoreCapacity: true }).runner.name, 'a');
  // Hard constraints: labels (machine:<name> is implied), "create", online, avoid.
  assert.match(pickRunner(item({ labels: ['gpu'] }), [runner('a')], []).why, /a lacks gpu/);
  assert.equal(pickRunner(item({ labels: ['machine:b'] }), [runner('a'), runner('b')], []).runner.name, 'b');
  assert.match(pickRunner(item(), [runner('a', { allow: ['view'] })], []).why, /doesn't allow "create"/);
  assert.equal(pickRunner(item(), [runner('a', { online: false })], []).runner, null);
  assert.equal(pickRunner(item({ avoid: ['a'] }), [runner('a'), runner('b')], []).runner.name, 'b');
  // Busy outside the hub (the machine's own backlog) counts against its limit.
  assert.equal(pickRunner(item(), [runner('a', { busy: 2 })], []).runner, null);
});

test('engines: Claude Code behind the adapter builds the same arguments as before', async () => {
  const { engineOf, ENGINES } = await import('../src/engines/index.js');
  const claude = engineOf('claude');
  assert.equal(engineOf({}).id, 'claude', 'agents from before engines are Claude agents');
  assert.equal(engineOf({ engine: 'claude' }), ENGINES.claude);
  assert.throws(() => engineOf('nope'), /Unknown engine "nope"/);
  assert.throws(() => engineOf('__proto__'), /Unknown engine/);
  assert.deepEqual(claude.sessionArgs({ sessionId: 's1', resume: false, name: 'fix-it', prompt: 'Fix it' }), ['--session-id', 's1', '--name', 'fix-it', '--', 'Fix it']);
  assert.deepEqual(claude.sessionArgs({ sessionId: 's1', resume: true }), ['--resume', 's1']);
  assert.deepEqual(claude.optionArgs({ permissionMode: 'default' }), []);
  assert.deepEqual(claude.optionArgs({ permissionMode: 'plan', model: 'opus', writableDir: '/b', instructions: 'X' }), [
    '--permission-mode', 'plan', '--model', 'opus', '--add-dir', '/b', '--allowedTools', 'Write(//b/**)', 'Edit(//b/**)', '--append-system-prompt', 'X',
  ]);
  assert.equal(claude.bin({ claudeBin: '/x/claude' }), '/x/claude');
  assert.equal(claude.bin({ claudeBin: '/x/claude', engines: { claude: { bin: '/y/claude' } } }), '/y/claude');
  assert.deepEqual(claude.extraArgs({ claudeArgs: ['a'] }), ['a']);
  assert.equal(claude.attention.find(([re]) => re.test('Doyouwanttoproceed?'))[1], 'Permission prompt');
});

test('engines: Codex adapter reads real codex-cli 0.163 output (fixtures)', async () => {
  const codex = (await import('../src/engines/codex.js')).default;
  const fx = (f) => path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'codex', f);
  // Usage: one entry per response; cached input counted apart, as for Claude.
  const cursor = { offset: 0 };
  const res = codex.scan(fx('session-0.163.0.jsonl'), cursor);
  const usage = [...cursor.usage.values()];
  assert.equal(usage.length, 2);
  assert.deepEqual(usage[0], { input: 19415 - 13184, output: 35, cacheCreation: 0, cacheRead: 13184 });
  assert.match(res.lastPrompt, /Read README\.md/);
  assert.equal(codex.scan(fx('session-0.163.0.jsonl'), cursor).prs.length, 0, 'incremental: nothing new on a second scan');
  // Stuck detection events and the digest.
  const st = codex.activity(fx('session-0.163.0.jsonl'), {});
  assert.deepEqual(st.events.map((e) => [e.kind, e.cmd ?? e.file, e.failed]), [['cmd', 'cat README.md', false], ['edit', '/tmp/codex-probe/README.md', undefined]]);
  assert.deepEqual(st.events[1].edits, [['', 'bye']]);
  const { digest } = codex.digest(fx('session-0.163.0.jsonl'));
  assert.match(digest, /^\[user\] Read README\.md[\s\S]*\[action\] ran `cat README\.md`[\s\S]*\[agent\] hello\n\[action\] edited \/tmp\/codex-probe\/README\.md$/);
  // The real approval menu and trust prompt, as drawn on a terminal.
  const screen = fs.readFileSync(fx('approval-screen-0.163.0.txt'), 'utf8');
  const p = codex.promptChoices(screen);
  assert.equal(p.question, 'Would you like to run the following command?');
  assert.deepEqual(p.choices.map((c) => c.key), ['1', '2', '3']);
  assert.equal(p.choices[0].label, 'Yes, proceed');
  assert.match(p.choices[2].label, /^No, and tell Codex what to do differently$/);
  const flat = (s) => s.replace(/\x1b(\[[0-9;?<>=]*[ -\/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[()][0-9A-B]|[=>78c])/g, '').replace(/\s+/g, '');
  assert.equal(codex.attention.find(([re]) => re.test(flat(screen.slice(-1500))))?.[1], 'Permission prompt');
  const trust = fs.readFileSync(fx('trust-screen-0.163.0.txt'), 'utf8');
  assert.equal(codex.attention.find(([re]) => re.test(flat(trust.slice(-1500))))?.[1], 'Folder trust prompt');
  assert.equal(codex.promptChoices(trust).choices[0].label, 'Trust and continue');
  // Launch arguments: options after "resume", instructions only in a new session's first message.
  assert.deepEqual(codex.launchArgs({ permissionMode: 'plan', resume: true, sessionId: 'S', prompt: 'go on' }), ['resume', '--no-alt-screen', '--sandbox', 'read-only', '--ask-for-approval', 'on-request', 'S', 'go on']);
  assert.match(codex.launchArgs({ instructions: 'Keep a brief.', prompt: 'Fix it' }).at(-1), /^Keep a brief\.\n\n---\n\nYour task:\nFix it$/);
  // The help text still lists every flag the adapter uses.
  const help = fs.readFileSync(fx('help-0.163.0.txt'), 'utf8');
  for (const f of ['--no-alt-screen', '--sandbox', '--ask-for-approval', '--add-dir', '--model', '--dangerously-bypass-approvals-and-sandbox']) assert.ok(help.includes(f), f);
});

test('engines: Antigravity adapter reads real agy 1.4.3 output (fixtures)', async () => {
  const agy = (await import('../src/engines/antigravity.js')).default;
  const fx = (f) => path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'antigravity', f);
  // Usage: one entry per model step; the user's words without agy's wrapper.
  const cursor = { offset: 0 };
  const res = agy.scan(fx('transcript-1.4.3.jsonl'), cursor);
  const usage = [...cursor.usage.values()];
  assert.equal(usage.length, 6);
  assert.deepEqual(usage[0], { input: 6657, output: 435, cacheCreation: 0, cacheRead: 0 });
  assert.equal(res.lastPrompt, "Append a line 'there' to hello.txt, then run: cat hello.txt");
  assert.equal(agy.scan(fx('transcript-1.4.3.jsonl'), cursor).prs.length, 0, 'incremental');
  // Stuck detection events: each command paired with its result step; file writes.
  const st = agy.activity(fx('transcript-1.4.3.jsonl'), {});
  assert.deepEqual(st.events.map((e) => [e.kind, e.cmd ?? e.file, e.failed]), [
    ['edit', '/tmp/agy-probe/hello.txt', undefined],
    ['cmd', 'ls -la', false],
    ['edit', '/tmp/agy-probe/hello.txt', undefined],
    ['cmd', 'cat hello.txt', false],
  ]);
  assert.deepEqual(st.events[2].edits, [['', 'there']]);
  assert.match(st.events[3].result, /hi there/);
  const { digest, edited } = agy.digest(fx('transcript-1.4.3.jsonl'));
  assert.match(digest, /^\[user\] Create a file hello\.txt[\s\S]*\[action\] ran `ls -la`[\s\S]*\[user\] Append[\s\S]*\[agent\] Appended/);
  assert.deepEqual(edited, ['/tmp/agy-probe/hello.txt']);
  // The real menus and trust prompt, as drawn on a terminal.
  const flat = (s) => s.replace(/\x1b(\[[0-9;?<>=]*[ -\/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[()][0-9A-B]|[=>78c])/g, '').replace(/\s+/g, '');
  const cmd = fs.readFileSync(fx('command-screen-1.4.3.txt'), 'utf8');
  const p = agy.promptChoices(cmd);
  assert.equal(p.question, 'Run this command? cat hello.txt');
  assert.deepEqual(p.choices.map((c) => c.key), ['1', '2', '3', '4']);
  assert.equal(p.choices[0].label, 'Yes, run command');
  assert.equal(p.choices[3].label, 'No, cancel');
  assert.equal(agy.attention.find(([re]) => re.test(flat(cmd.slice(-1500))))?.[1], 'Permission prompt');
  const edit = fs.readFileSync(fx('edit-screen-1.4.3.txt'), 'utf8');
  assert.deepEqual(agy.promptChoices(edit), { question: 'Allow creation of this file?', choices: [{ key: '1', label: 'Yes, allow creation' }, { key: '2', label: 'No, deny creation' }] });
  assert.equal(agy.attention.find(([re]) => re.test(flat(edit.slice(-1500))))?.[1], 'Permission prompt');
  const access = fs.readFileSync(fx('access-screen-1.4.3.txt'), 'utf8');
  assert.deepEqual(agy.promptChoices(access), { question: 'Allow access to this file?', choices: [{ key: '1', label: 'Yes, allow access' }, { key: '2', label: 'Yes, and always allow non-workspace access' }, { key: '3', label: 'No, deny access' }] });
  assert.equal(agy.attention.find(([re]) => re.test(flat(access.slice(-1500))))?.[1], 'Permission prompt');
  const trust = fs.readFileSync(fx('trust-screen-1.4.3.txt'), 'utf8');
  assert.equal(agy.attention.find(([re]) => re.test(flat(trust.slice(-1500))))?.[1], 'Folder trust prompt');
  // Launch arguments: --conversation to resume, instructions only in a new conversation's first message.
  assert.deepEqual(agy.launchArgs({ permissionMode: 'plan', resume: true, sessionId: 'S', prompt: 'go on' }), ['--conversation', 'S', '--mode', 'plan', '--prompt-interactive=go on']);
  assert.match(agy.launchArgs({ instructions: 'Keep a brief.', prompt: 'Fix it' }).at(-1), /^--prompt-interactive=Keep a brief\.\n\n---\n\nYour task:\nFix it$/);
  assert.deepEqual(agy.launchArgs({ permissionMode: 'default' }), []);
  // The help text still lists every flag the adapter uses.
  const help = fs.readFileSync(fx('help-1.4.3.txt'), 'utf8');
  for (const f of ['--conversation', '--mode', '--model', '--add-dir', '--prompt-interactive', '--print', '--print-timeout', '--dangerously-skip-permissions']) assert.ok(help.includes(f), f);
  assert.match(help, /accept-edits, auto, plan/);
});


test('login service carries the home, port and plugin settings', () => {
  assert.deepEqual(passEnv({ AGENTMGR_PLUGINS: '/opt/ent/daemon.js', AGENTMGR_PORT: '4800', OTHER: 'x' }), { AGENTMGR_PORT: '4800', AGENTMGR_PLUGINS: '/opt/ent/daemon.js' });
  const saved = process.env.AGENTMGR_PLUGINS;
  process.env.AGENTMGR_PLUGINS = '/opt/ent/daemon.js';
  try {
    assert.match(plist(), /<key>AGENTMGR_PLUGINS<\/key><string>\/opt\/ent\/daemon\.js<\/string>/);
    assert.match(unit(), /^Environment=AGENTMGR_PLUGINS=\/opt\/ent\/daemon\.js$/m);
  } finally {
    if (saved === undefined) delete process.env.AGENTMGR_PLUGINS;
    else process.env.AGENTMGR_PLUGINS = saved;
  }
});

test('about: release date from the changelog, version comparison', async () => {
  const { releaseDate, newerThan } = await import('../src/about.js');
  const log = '# Changelog\n\n## 1.1.0 (unreleased)\n\n## 1.0.1 (2026-11-02)\n\n## 1.0.0 (2026-10-25)\n';
  assert.equal(releaseDate(log, '1.0.0'), '2026-10-25');
  assert.equal(releaseDate(log, '1.0.1'), '2026-11-02');
  assert.equal(releaseDate(log, '1.1.0'), null);
  assert.equal(releaseDate(log, '1.0.10'), null);
  assert.ok(newerThan('1.0.1', '1.0.0') && newerThan('1.10.0', '1.9.9') && newerThan('2.0.0', '1.99.99'));
  assert.ok(!newerThan('1.0.0', '1.0.0') && !newerThan('1.0.0', '1.0.1'));
  assert.ok(newerThan('1.0.0', '1.0.0-rc.1') && !newerThan('1.0.0-rc.1', '1.0.0'));
});

test("stripChrome drops Claude Code's frame but keeps the agent's words", () => {
  const screen = [
    '● I added the helper. Want me to commit it?',
    '* Cooked for 29s · done Monday 12:34 AM',
    '──────────────────────────── add-a-capitalize-helper ─',
    '❯',
    '──────────────────────────────────────────────',
    '⏵⏵ accept edits on (shift+tab to cycle) · ← for agents',
    'Update available! Run: brew upgrade claude-code',
    '/rc',
  ].join('\n');
  assert.equal(stripChrome(screen, claude.screenChrome), '● I added the helper. Want me to commit it?\n* Cooked for 29s · done Monday 12:34 AM');
  assert.equal(stripChrome(screen, []), screen);
});

test('notInstalled says what is missing and how to fix it', () => {
  const msg = notInstalled(claude, { claudeBin: 'claude' });
  assert.match(msg, /`claude` isn't on the daemon's PATH/);
  assert.match(msg, /AGENTMGR_CLAUDE_BIN/);
  assert.match(notInstalled(claude, { claudeBin: '/opt/x/claude' }), /\/opt\/x\/claude doesn't exist/);
});

test('team handoffs: the verdict line, in the forms models write it', () => {
  assert.equal(readVerdict('# Review\nAll good.\n\nverdict: approve\n', VERDICTS.review), 'approve');
  assert.equal(readVerdict('**Verdict:** Changes requested', VERDICTS.review), 'changes');
  assert.equal(readVerdict('- verdict: `PASSED`', VERDICTS.test), 'pass');
  assert.equal(readVerdict('verdict: agree\n...\nverdict: questions', VERDICTS.critique), 'questions', 'the last one wins');
  assert.equal(readVerdict('Verdict: LGTM', VERDICTS.review), 'approve');
  assert.equal(readVerdict('verdict: disagree', VERDICTS.critique), 'changes');
  assert.equal(readVerdict('verdict: maybe', VERDICTS.review), null, 'not an allowed word');
  assert.equal(readVerdict('No verdict here, the verdict is pending', VERDICTS.review), null);
  assert.equal(readVerdict('verdict: done', VERDICTS.test), null, "another kind's word");
});

test('team reviews: coverage and the gaps section', () => {
  assert.equal(readCoverage('## Gaps\nNone\n\ncoverage: complete\nverdict: approve'), 'complete');
  assert.equal(readCoverage('**Coverage:** `Partial`'), 'partial');
  assert.equal(readCoverage('coverage: incomplete'), 'partial');
  assert.equal(readCoverage('Test coverage is good'), null);
  assert.equal(readCoverage('coverage: maybe'), null);
  const review = '# Review\nGood.\n\n## Gaps\n- Payroll\n- Reports\n\n### Detail\nmore\n\n## What is good\nTests.\n\ncoverage: partial\nverdict: approve\n';
  assert.equal(gapsOf(review), '- Payroll\n- Reports\n\n### Detail\nmore');
  assert.equal(gapsOf('## Gaps\n- Payroll\ncoverage: partial\nverdict: approve'), '- Payroll');
  assert.equal(gapsOf('No section'), '');
  assert.match(subagents({ settings: { critics: 0 } }, '/t').reviewer.prompt, /## Gaps[\s\S]*coverage: complete[\s\S]*Missing parts alone are no reason/);
});

test('team handoffs: a summary line and role instructions', () => {
  assert.equal(summarize('# Analysis\n\n## Problem\nTokens are dropped.\n- on rotation\n\nverdict: ready'), 'Tokens are dropped. - on rotation');
  assert.ok(summarize('x '.repeat(400)).length <= 240);
  const p = teamPrompt('tester', '/t/abc');
  assert.match(p, /You are the tester on a team/);
  assert.match(p, /do not fix product code/);
  assert.match(p, /\/t\/abc/);
  assert.match(p, /verdict: <word>/);
});

test('claude: several writable folders, each with write and edit allowed', () => {
  const args = claude.optionArgs({ writableDir: ['/b', '/t'] });
  assert.deepEqual(args, ['--add-dir', '/b', '/t', '--allowedTools', 'Write(//b/**)', 'Edit(//b/**)', 'Write(//t/**)', 'Edit(//t/**)']);
  assert.deepEqual(claude.optionArgs({ writableDir: '/b' }), ['--add-dir', '/b', '--allowedTools', 'Write(//b/**)', 'Edit(//b/**)']);
});

test('team lead: sub-agents per role, and the steps it runs', () => {
  const team = { settings: { critics: 0, maxRounds: 3, maxLoops: 2, testCommand: null, models: { analyst: 'opus' } } };
  const subs = subagents(team, '/t/x');
  assert.deepEqual(Object.keys(subs), ['analyst', 'implementer', 'tester', 'reviewer'], 'no critic on a team without critics');
  assert.equal(subs.analyst.model, 'opus');
  assert.equal(subs.tester.model, undefined, "the lead's model");
  assert.match(subs.reviewer.description, /reviewer/);
  const p = leadPrompt(team, '/t/x', 'main @ abc123def');
  assert.match(p, /no critics on this team/);
  assert.match(p, /At most 2 implementation rounds/);
  assert.match(p, /git diff abc123def\.\.\.HEAD/);
  assert.match(p, /save what the sub-agent returned/);
  assert.match(p, /Stop only when the reviewer approves/);
  assert.match(p, /quest-1/);
  assert.match(p, /A question about the team's work isn't a quest/);
  assert.match(p, /# Gap round <k>[\s\S]*Ask the person before each gap round/);
  const gp = leadPrompt({ settings: { ...team.settings, gapRounds: 2 } }, '/t/x', null);
  assert.match(gp, /fewer than 2 gap rounds have run for this request, start the next one yourself, without asking/);
  assert.doesNotMatch(gp, /Ask the person before each gap round/);
  assert.deepEqual(claude.optionArgs({ agents: { a: { description: 'd', prompt: 'p' } } }), ['--agents', '{"a":{"description":"d","prompt":"p"}}']);
});

test('clean up settings: defaults and bounds', () => {
  assert.deepEqual(cleanupSettings({}), { strategy: 'close', closeAfterDays: 14, deleteAfterDays: 14, maxRunning: null });
  assert.deepEqual(cleanupSettings({ cleanup: { strategy: 'close-delete', closeAfterDays: '7' } }), { strategy: 'close-delete', closeAfterDays: 7, deleteAfterDays: 14, maxRunning: null });
  assert.deepEqual(cleanupSettings({ cleanup: { strategy: 'nuke', closeAfterDays: 0, deleteAfterDays: -3 } }), { strategy: 'close', closeAfterDays: 14, deleteAfterDays: 14, maxRunning: null });
});

test('assistantSettings: defaults, bounds and known sources only', async () => {
  const { assistantSettings, ASSISTANT_DEFAULTS } = await import('../src/assistant.js');
  assert.deepEqual(assistantSettings({}).sources, ASSISTANT_DEFAULTS.sources);
  const s = assistantSettings({ assistant: { everyMin: 0, maxPerDay: -1, sources: ['jira', 'fax'], notes: 7 } });
  assert.equal(s.everyMin, 15);
  assert.equal(s.maxPerDay, 10);
  assert.deepEqual(s.sources, ['jira']);
  assert.equal(s.notes, '');
  assert.equal(assistantSettings({ assistant: { everyMin: 99999 } }).everyMin, 1440);
});

test('assistantPrompt: one section per watched source, limits, memory and the never list', async () => {
  const { assistantPrompt, assistantSettings } = await import('../src/assistant.js');
  const p = assistantPrompt(assistantSettings({ assistant: { sources: ['jira', 'reviews'], maxPerDay: 3, notes: 'OPS goes to @cc' } }), '/tmp/a', 'agentmgr');
  assert.match(p, /Jira, new assignments/);
  assert.match(p, /agentmgr add @<project> "<the issue link>/);
  assert.match(p, /gh search prs --review-requested=@me/);
  assert.doesNotMatch(p, /Failing checks|Slack:/);
  assert.match(p, /at most 3 new agents a day/);
  assert.match(p, /\/tmp\/a\/handled\.json/);
  assert.match(p, /\/tmp\/a\/activity\.md/);
  assert.match(p, /Never merge, approve/);
  assert.match(p, /OPS goes to @cc/);
});

test('review: base ref, PR target, comments message, diff parsing', () => {
  assert.deepEqual(parseBaseRef('origin/main @ 1a2b3c4d5'), { ref: 'origin/main', sha: '1a2b3c4d5' });
  assert.equal(parseBaseRef(null), null);
  assert.equal(prBase('origin/release/2.0'), 'release/2.0');
  assert.equal(prBase('HEAD'), null);
  assert.equal(prBase('1a2b3c4d5'), null);
  const m = commentsMessage([{ file: 'src/a.js', line: 3, side: 'new', code: '  let x = 1;', text: 'Use const' }, { file: 'b.md', line: 9, side: 'old', text: 'Keep this\nline' }], 'Thanks');
  assert.match(m, /1\. src\/a\.js:3\n   > let x = 1;\n   Use const/);
  assert.match(m, /2\. b\.md:9 \(removed line\)\n   Keep this\n   line/);
  assert.match(m, /\n\nThanks$/);
  const files = parseDiff(['diff --git a/a.txt b/a.txt', 'index 1..2 100644', '--- a/a.txt', '+++ b/a.txt', '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three',
    'diff --git a/new.txt b/new.txt', 'new file mode 100644', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+hi', '\\ No newline at end of file',
    'diff --git a/img.png b/img.png', 'Binary files a/img.png and b/img.png differ'].join('\n'));
  assert.deepEqual(files.map((f) => [f.path, f.status, f.binary]), [['a.txt', 'modified', false], ['new.txt', 'added', false], ['img.png', 'modified', true]]);
  assert.deepEqual(files[0].hunks[0].lines.map((l) => [l.t, l.old, l.new]), [['ctx', 1, 1], ['del', 2, null], ['add', null, 2], ['ctx', 3, 3]]);
  assert.deepEqual(files[1].hunks[0].lines, [{ t: 'add', old: null, new: 1, text: 'hi' }]);
});

test('landing: check summary, where a PR stands, settings and messages', () => {
  assert.deepEqual(checkSummary([]), { state: 'none', failed: [], running: 0, total: 0 });
  assert.deepEqual(checkSummary([{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }, { context: 'ci/b', state: 'PENDING' }]), { state: 'running', failed: [], running: 1, total: 2 });
  assert.equal(checkSummary([{ name: 'a', status: 'QUEUED' }, { name: 'x', status: 'COMPLETED', conclusion: 'TIMED_OUT' }]).state, 'failed');
  const pr = compactPr({ url: 'u', state: 'OPEN', isDraft: false, headRefOid: 'abc', reviewDecision: '', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [] });
  assert.deepEqual(pr, { url: 'u', state: 'OPEN', isDraft: false, checks: { state: 'none', failed: [], running: 0, total: 0 }, review: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', head: 'abc' });
  assert.equal(landState(pr), 'ready');
  assert.equal(landState({ ...pr, isDraft: true }), 'draft');
  assert.equal(landState({ ...pr, state: 'MERGED' }), 'merged');
  assert.equal(landState({ ...pr, checks: { state: 'failed' } }), 'fix');
  assert.equal(landState({ ...pr, review: 'CHANGES_REQUESTED' }), 'fix');
  assert.equal(landState({ ...pr, mergeable: 'CONFLICTING', mergeState: 'DIRTY' }), 'fix');
  assert.equal(landState({ ...pr, mergeState: 'BEHIND' }), 'behind');
  assert.equal(landState({ ...pr, mergeState: 'BLOCKED', checks: { state: 'running' } }), 'waiting');
  assert.equal(landState({ ...pr, mergeState: 'BLOCKED', review: 'REVIEW_REQUIRED' }), 'waiting');
  assert.equal(landState({ url: 'u' }), null);
  assert.deepEqual(landingSettings({}), { fixChecks: true, fixReviews: true, maxFixes: 3, mergeMethod: 'squash', deleteBranch: true });
  assert.deepEqual(landingSettings({ landing: { fixChecks: false, maxFixes: 99, mergeMethod: 'octopus' } }), { fixChecks: false, fixReviews: true, maxFixes: 20, mergeMethod: 'squash', deleteBranch: true });
  assert.match(checksMessage({ url: 'https://x/pull/4', number: 4, checks: { failed: ['unit', 'lint'] } }), /failing on your pull request https:\/\/x\/pull\/4 \(unit, lint\)[\s\S]*gh pr checks 4/);
  assert.match(reviewMessage({ url: 'https://x/pull/4', number: 4 }), /requested changes[\s\S]*gh pr view 4 --comments/);
});

test('Linear links: issue key, agent name, bug ref', () => {
  assert.equal(leadingJiraKey('https://linear.app/acme/issue/ENG-42/fix-the-login fix it'), 'ENG-42');
  const refs = extractRefs('see https://linear.app/acme/issue/ENG-42/fix-the-login');
  assert.deepEqual(refs.bugs.map((b) => b.key), ['ENG-42']);
});

test('triggers: settings, issue request, PR commands, token check', () => {
  const d = triggerSettings({});
  assert.deepEqual(d.github, { enabled: false, label: 'agentmgr', repos: [], owners: [], everyMin: 5, comment: false });
  assert.equal(d.webhook.enabled, false, 'no token, no webhook');
  const s = triggerSettings({ triggers: { github: { enabled: true, repos: 'acme/web, bad repo,acme/api', owners: ['acme', 'no/slash'] }, webhook: { enabled: true, token: 't' }, maxPerDay: 9999 } });
  assert.deepEqual([s.github.repos, s.github.owners, s.webhook.enabled, s.maxPerDay], [['acme/web', 'acme/api'], ['acme'], true, 500]);
  assert.match(issueIntent({ url: 'https://github.com/a/b/issues/3', number: 3, title: 'T', body: '' }), /^https:\/\/github\.com\/a\/b\/issues\/3\n\nT\n\nWhen you are done[\s\S]*Fixes #3/);
  assert.equal(prCommand({ body: '/agent add tests', authorAssociation: 'MEMBER' }), 'add tests');
  assert.equal(prCommand({ body: '/AGENT  add tests', authorAssociation: 'OWNER' }), 'add tests');
  assert.equal(prCommand({ body: '/agent add tests', authorAssociation: 'NONE' }), null);
  assert.equal(prCommand({ body: '/agent', authorAssociation: 'OWNER' }), null);
  assert.equal(prCommand({ body: 'lgtm', authorAssociation: 'OWNER' }), null);
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abd', 'abc'), false);
  assert.equal(tokenMatches('abc', null), false);
  assert.equal(tokenMatches('ab', 'abc'), false);
});

test('budgets: settings and cost', () => {
  assert.deepEqual(budgetSettings({}), { perAgentUsd: null, perDayUsd: null, warnAt: 0.8 });
  assert.deepEqual(budgetSettings({ budgets: { perAgentUsd: '5.555', perDayUsd: -3, warnAt: 2 } }), { perAgentUsd: 5.56, perDayUsd: null, warnAt: 0.8 });
  assert.equal(costOf({ sessions: [{ cost: { usd: 1.25 } }, {}, { cost: { usd: 0.5 } }] }), 1.75);
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('stats: merge rate, time to PR and merge, cost per merged PR, by engine and source', () => {
  const t0 = Date.parse('2026-10-01T00:00:00Z');
  const h = (n) => new Date(t0 + n * 3_600_000).toISOString();
  const agents = [
    { id: 'a', createdAt: h(0), engine: 'claude', model: 'opus', sessions: [{ cost: { usd: 3 } }], prs: { u1: { url: 'u1', state: 'MERGED', openedAt: h(2), mergedAt: h(10), source: 'branch' } } },
    { id: 'b', createdAt: h(1), engine: 'claude', startedBy: 'x', sessions: [{ cost: { usd: 1 } }], prs: { u2: { url: 'u2', state: 'CLOSED', openedAt: h(5), source: 'branch' }, m: { url: 'm', state: 'MERGED', source: 'mentioned' } } },
    { id: 'c', createdAt: h(2), engine: 'codex', trigger: { source: 'github' }, sessions: [], prs: {} },
    { id: 'g', createdAt: h(2), kind: 'general', sessions: [{ cost: { usd: 9 } }], prs: {} },
    { id: 'old', createdAt: '2020-01-01T00:00:00Z', sessions: [], prs: {} },
  ];
  const s = stats(agents, { days: 30, now: t0 + 24 * 3_600_000 });
  assert.deepEqual(s.total, { agents: 3, withPr: 2, merged: 1, closed: 1, open: 0, mergeRate: 0.5, cost: 4, costPerMerged: 4, medianHoursToPr: 3, medianHoursToMerge: 10, fixesSent: 0 });
  const engine = Object.fromEntries(s.byEngine.map((r) => [r.key, [r.agents, r.merged, r.closed, r.mergeRate]]));
  assert.deepEqual(engine, { 'claude · opus': [1, 1, 0, 1], claude: [1, 0, 1, 0], codex: [1, 0, 0, null] });
  assert.deepEqual(new Set(s.bySource.map((r) => r.key)), new Set(['you', 'assistant', 'GitHub label']));
  assert.equal(stats(agents, { days: 0, now: t0 }).total.agents, 4, 'all time');
  assert.equal(sourceOf({ backlogItem: 'x' }), 'backlog');
});

test('playbooks: placeholders, schedules and the next run', () => {
  assert.deepEqual(placeholders('Upgrade {{package}} to {{ version }}, then {{package}} docs'), ['package', 'version']);
  assert.equal(render('Upgrade {{package}} to {{version}}', { package: 'react' }), 'Upgrade react to {{version}}');
  assert.deepEqual(cleanSchedule({ every: 'week', at: '9:05', day: 'Friday' }), { every: 'week', at: '09:05', day: 'fri' });
  assert.equal(cleanSchedule(null), null);
  assert.throws(() => cleanSchedule({ every: 'month' }), /schedule.every/);
  assert.throws(() => cleanSchedule({ every: 'day', at: '25:00' }), /HH:MM/);
  const fri = new Date(2026, 9, 30, 10, 0); // a Friday, 10:00
  assert.equal(nextRun({ every: 'day', at: '09:00' }, fri).getTime(), new Date(2026, 9, 31, 9, 0).getTime());
  assert.equal(nextRun({ every: 'day', at: '11:30' }, fri).getTime(), new Date(2026, 9, 30, 11, 30).getTime());
  assert.equal(nextRun({ every: 'weekday', at: '09:00' }, fri).getTime(), new Date(2026, 10, 2, 9, 0).getTime(), 'Monday');
  assert.equal(nextRun({ every: 'week', at: '08:00', day: 'wed' }, fri).getTime(), new Date(2026, 10, 4, 8, 0).getTime());
  assert.equal(nextRun({ every: 'hour', at: '00:15' }, fri).getTime(), new Date(2026, 9, 30, 10, 15).getTime());
  assert.equal(nextRun({ every: 'hour', at: '00:15' }, new Date(2026, 9, 30, 10, 20)).getTime(), new Date(2026, 9, 30, 11, 15).getTime());
});

test('repo memory: key by repo, one-line learnings, the prompt', () => {
  assert.equal(memoryKey({ repo: 'git@github.com:acme/web.git', project: 'Custom', projectMove: { key: 'x', name: 'X' } }), memoryKey({ repo: 'https://github.com/acme/web' }));
  assert.equal(cleanLearning('  - npm test   needs\n Postgres '), 'npm test needs Postgres');
  assert.throws(() => cleanLearning('  '), /Nothing to learn/);
  assert.throws(() => cleanLearning('x'.repeat(401)), /one short line/);
  assert.match(memoryPrompt('- a thing (agent, 2026-10-31)', 'agentmgr'), /learned working in this repository[\s\S]*- a thing[\s\S]*agentmgr learn "<the learning>"/);
  assert.match(memoryPrompt('', 'agentmgr'), /empty so far/);
});

test('the web UI scripts parse', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) execFileSync(process.execPath, ['--check', path.join(dir, f)]);
});

test('a pull request check asked for during one in progress runs again, once for all waiting', async () => {
  const runs = [];
  let release;
  const fake = {
    refreshing: new Map(),
    mustGet: (id) => ({ id }),
    store: { get: (id) => ({ id }) },
    view: (a) => a,
    refresh: AgentManager.prototype.refresh,
    doRefresh(id, { withPrs }) {
      const n = runs.push({ withPrs });
      return n === 1 ? new Promise((r) => (release = () => r(n))) : Promise.resolve(n);
    },
  };
  const refresh = (o) => AgentManager.prototype.refresh.call(fake, 'a', o);
  const first = refresh({ withPrs: true });
  const plain = refresh();
  const later = [refresh({ withPrs: true }), refresh({ withPrs: true })];
  release();
  assert.equal(await first, 1);
  assert.deepEqual(await plain, { id: 'a' }, 'a plain refresh shares the one in progress');
  assert.deepEqual(await Promise.all(later), [2, 2], 'both get the run that started after them');
  assert.equal(runs.length, 2);
  assert.equal(fake.refreshing.size, 0);
  assert.equal(await refresh({ withPrs: true }), 3, 'and the next one starts afresh');
});

test('open-agent cap: idle longest closed first, protected and recent ones skipped', () => {
  const min = 60_000;
  const now = Date.parse('2026-10-31T12:00:00Z');
  const at = (m) => new Date(now - m * min).toISOString();
  const agents = [
    { id: 'a', name: 'old', createdAt: at(300), last: at(120) },
    { id: 'b', name: 'older', createdAt: at(300), last: at(200) },
    { id: 'c', name: 'kept', createdAt: at(300), last: at(500), keep: true },
    { id: 'd', name: 'asking', createdAt: at(300), last: at(400) },
    { id: 'e', name: 'fresh', createdAt: at(300), last: at(2) },
    { id: 'f', name: 'closed', createdAt: at(300), last: at(900) },
    { id: 'g', name: 'assistant', kind: 'assistant', createdAt: at(300), last: at(999) },
  ];
  const runtimes = new Map(agents.filter((a) => a.id !== 'f').map((a) => [a.id, { pty: {}, attention: a.id === 'd' ? 'Permission' : null }]));
  const manager = { runtimes, activeAt: (a) => a.last };
  const store = { data: {}, list: () => agents };
  const c = new Cleanup({ manager, store, config: { cleanup: { maxRunning: 3 } } });
  c.close();
  const plan = c.capPlan(now);
  assert.equal(plan.running, 5, 'the assistant and closed agents do not count');
  assert.deepEqual(plan.close.map((r) => r.name), ['older', 'old']);
  assert.equal(plan.close[0].idleMin, 200);
  c.config.cleanup.maxRunning = 4;
  assert.deepEqual(c.capPlan(now).close.map((r) => r.name), ['older']);
  c.config.cleanup.maxRunning = null;
  assert.deepEqual(c.capPlan(now).close, []);
  assert.equal(cleanupSettings({ cleanup: { maxRunning: '8' } }).maxRunning, 8);
  assert.equal(cleanupSettings({ cleanup: { maxRunning: 0 } }).maxRunning, null);
  assert.throws(() => c.update({ maxRunning: -2 }), /maxRunning/);
  assert.equal(c.update({ maxRunning: '' }).maxRunning, null);
});

test('self update: newest release tag, blockers, and moving a checkout to it', async () => {
  assert.equal(newestTag(['v1.2.0', 'v1.10.0', 'v1.9.3', 'v2.0.0-rc.1', 'latest', '']), 'v1.10.0');
  assert.equal(newestTag(['nope']), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-update-'));
  const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd }).toString().trim();
  const origin = path.join(dir, 'origin');
  fs.mkdirSync(origin);
  g(origin, 'init', '-q', '-b', 'main');
  for (const v of ['1.0.0', '1.1.0']) {
    fs.writeFileSync(path.join(origin, 'package.json'), JSON.stringify({ name: 'x', version: v }));
    g(origin, 'add', '.');
    g(origin, 'commit', '-q', '-m', v);
    g(origin, 'tag', `v${v}`);
  }
  const copy = path.join(dir, 'copy');
  g(dir, 'clone', '-q', origin, copy);
  fs.mkdirSync(path.join(copy, 'node_modules'));
  assert.match(await gitBlocker(copy), /branch "main"/);
  g(copy, 'checkout', '-q', '--detach', 'v1.0.0');
  assert.equal(await gitBlocker(copy), null);
  const info = await checkUpdate({ dir: copy });
  assert.deepEqual([info.kind, info.current, info.latest, info.newer, info.blocker], ['git', '1.0.0', '1.1.0', true, null]);
  fs.writeFileSync(path.join(copy, 'package.json'), '{"name":"x","version":"1.0.0","dirty":true}');
  await assert.rejects(installUpdate({ dir: copy }), /uncommitted changes/);
  g(copy, 'checkout', '-q', '--', 'package.json');
  const r = await installUpdate({ dir: copy });
  assert.deepEqual([r.from, r.to], ['1.0.0', '1.1.0']);
  assert.equal(g(copy, 'describe', '--tags'), 'v1.1.0');
  assert.deepEqual(await installUpdate({ dir: copy }), { upToDate: true, current: '1.1.0' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('identity: the Claude account from its settings file, nothing else', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'am-id-')), 'claude.json');
  fs.writeFileSync(f, JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c', displayName: 'Ann', organizationName: 'Org', accountUuid: 'secret-ish' } }));
  assert.deepEqual(claudeAccount(f), { email: 'a@b.c', name: 'Ann', organization: 'Org' });
  fs.writeFileSync(f, '{}');
  assert.equal(claudeAccount(f), null);
  assert.equal(claudeAccount(`${f}.missing`), null);
});

test('studio: paths stay inside the folder; languages by file name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-studio-'));
  fs.mkdirSync(path.join(root, 'a'));
  const real = fs.realpathSync(root);
  assert.equal(resolveInside(root, 'a/b.txt'), path.join(real, 'a', 'b.txt'));
  assert.equal(resolveInside(root, '/a'), path.join(real, 'a'));
  assert.throws(() => resolveInside(root, 'a/../../x'), /\.\./);
  fs.symlinkSync(os.tmpdir(), path.join(root, 'out'));
  assert.throws(() => resolveInside(root, 'out/x'), /outside/);
  fs.symlinkSync(path.join(root, 'a'), path.join(root, 'in'));
  assert.ok(resolveInside(root, 'in/x').endsWith(path.join('in', 'x')), 'a link inside the folder is fine');
  assert.deepEqual(['x.ts', 'Dockerfile', 'a.py', 'b.unknown', 'c.YML'].map(languageOf), ['typescript', 'dockerfile', 'python', 'plaintext', 'yaml']);
  assert.equal(isText(Buffer.from('hello')), true);
  assert.equal(isText(Buffer.from([104, 0, 105])), false);
});
