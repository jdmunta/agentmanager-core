#!/usr/bin/env node
// Stand-in for the claude CLI: records its argv, writes a transcript where
// Claude Code would, echoes input, and exits on "exit" or SIGHUP.
import fs from 'node:fs';
import path from 'node:path';
import { transcriptPath } from '../src/tracker.js';

const args = process.argv.slice(2);
if (args.includes('-p')) {
  // Explain: a one-shot call that must have no tools and no MCP servers.
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    const ok = args[args.indexOf('--tools') + 1] === '' && args.includes('--strict-mcp-config');
    const section = (tag) => input.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1] ?? '';
    const conv = section('conversation');
    // The AI judge: JSON verdicts (see src/judge.js).
    const json = (o) => process.stdout.write(JSON.stringify(o), () => process.exit(0));
    if (input.startsWith('You supervise an AI coding agent for a person.')) {
      if (section('intent').includes('#fine')) return json({ stuck: false, confidence: 0.9, title: 'Converging', diagnosis: 'Each run fails differently', nudge: '' });
      return json({
        stuck: true,
        confidence: 0.9,
        title: 'Stuck on the 401 in auth tests',
        diagnosis: `Retrying npm test without changing the token setup${input.includes('<recent_decisions_by_this_person>') ? ' (calibrated)' : ''}`,
        nudge: 'The 401 means the test client sends no token. Check the auth fixture before rerunning npm test.',
      });
    }
    if (input.startsWith('You supervise an AI coding agent running in a terminal.')) {
      const screen = section('terminal_screen');
      if (screen.includes('Which database')) return json({ state: 'question', confidence: 0.85, summary: 'Asks which database to use', question: 'Which database should I use?', choices: ['Postgres', 'SQLite'] });
      if (screen.includes('All done')) return json({ state: 'done', confidence: 0.9, summary: 'Says the fix is finished', question: '', choices: [] });
      return json({ state: 'idle', confidence: 0.7, summary: 'Waiting for the next instruction', question: '', choices: [] });
    }
    if (input.startsWith('Two AI coding agents work on separate branches')) {
      const both = ['A', 'B'].every((t) => /intent: .*#clash/.test(section(`agent_${t}`)));
      return json(
        both
          ? { conflict: true, confidence: 0.85, reason: 'Both change how session tokens are encoded', mergeFirst: 'A', orderReason: 'A defines the new format', adviceA: 'Land first.', adviceB: 'Build on the new format.' }
          : { conflict: false, confidence: 0.9, reason: 'Unrelated changes', mergeFirst: '', orderReason: '', adviceA: '', adviceB: '' },
      );
    }
    if (input.startsWith('You schedule a backlog')) {
      const items = [...section('queued').matchAll(/^- (\S+) \[P\d\] \([^)]*\) (.+)$/gm)].map((m) => ({ id: m[1], title: m[2] }));
      const build = items.find((i) => i.title.startsWith('Build'));
      const active = section('in_progress');
      const buildId = build?.id ?? active.match(/^- (\S+) .*Build/m)?.[1];
      return json({
        order: [...items.filter((i) => i === build), ...items.filter((i) => i !== build)].map((i) => i.id),
        hold: items.filter((i) => i.title.includes('#needs-api') && buildId).map((i) => ({ id: i.id, after: buildId, reason: 'Needs the API first' })),
        split: items.filter((i) => i.title.includes('#bundle')).map((i) => ({ id: i.id, reason: 'Three independent tasks', parts: ['Write the docs', 'Add the tests', 'Set up CI'] })),
      });
    }
    if (input.startsWith('You triage alerts')) {
      const kind = input.match(/<alert kind="(\w+)">/)?.[1];
      return json(kind === 'stuck' ? { urgency: 'digest', confidence: 0.8, line: 'Retrying npm test; can wait' } : { urgency: 'now', confidence: 0.8, line: '' });
    }
    if (input.startsWith("You review an AI coding agent's work")) {
      return json({ verdict: 'partial', confidence: 0.8, summary: `Root cause fixed for: ${section('intent')}`, met: ['Root cause found'], missing: ['Manual SSO login not verified'], risks: ['No e2e run'] });
    }
    if (input.startsWith('You help a person supervise')) {
      // Human vs AI, first pass: JSON (wrapped in a fence, as models sometimes do).
      const reply = {
        title: section('intent'),
        human: [1, 2, 3, 4, 5, 6].map((i) => ({ question: `Human question ${i}?`, why_human: 'Needs intent', stakes: 'Wrong product', options: ['A', 'B'], lean: i === 1 ? 'A' : null })),
        ai: [{ question: 'Do the tests pass?', answer: ok ? 'Safe call: yes.' : 'UNSAFE', confidence: 'high', evidence: ['npm test'], check: 'Run npm test' }],
      };
      process.stdout.write('```json\n' + JSON.stringify(reply) + '\n```\n', () => process.exit(0));
      return;
    }
    const doc = input.match(/^Write a (\w+) document/)?.[1];
    if (doc) {
      process.stdout.write(
        `# ${doc}: ${section('intent')}\n## Summary\n${ok ? 'Safe call.' : 'UNSAFE call.'}\n## Architecture\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n`,
        () => process.exit(0),
      );
      return;
    }
    if (/Why[\s\S]*What[\s\S]*How[\s\S]*Now/.test(input.split('<agent_status>')[0])) {
      process.stdout.write(
        `### Why\n- ${ok ? 'Safe call' : 'UNSAFE'}: ${section('intent')}\n### What\n- One\n### How\n- Two\n### Now\n- saw agent text: ${conv.includes('[agent] Looking at')}\n`,
        () => process.exit(0),
      );
      return;
    }
    process.stdout.write(
      `### The ask\n${ok ? 'Safe call.' : 'UNSAFE call.'} Intent: ${section('intent')}\n` +
        `### Where it stands\n${section('agent_status').split('\n')[0]}\n` +
        `### Conclusions so far\nsaw agent text: ${conv.includes('[agent] Looking at')}; repo: ${section('repository').split('\n')[0]}\n`,
      () => process.exit(0),
    );
  });
  await new Promise(() => {});
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sid = flag('--session-id') ?? flag('--resume');
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ cwd: process.cwd(), args }) + '\n');

const file = transcriptPath(process.cwd(), sid);
fs.mkdirSync(path.dirname(file), { recursive: true });
const write = (rec) => fs.appendFileSync(file, JSON.stringify({ sessionId: sid, ...rec }) + '\n');
write({ type: 'ai-title', aiTitle: 'Fake session title' });
write({
  type: 'assistant',
  message: {
    id: `msg_${Date.now()}`,
    usage: { input_tokens: 12, output_tokens: 34, cache_creation_input_tokens: 56, cache_read_input_tokens: 78 },
    content: [{ type: 'text', text: 'Looking at https://jira.example.com/browse/ABC-4242 now' }],
  },
});
write({ type: 'pr-link', prNumber: 7, prUrl: 'https://github.com/example/repo/pull/7' });

const briefDir = flag('--add-dir');
if (briefDir) {
  fs.writeFileSync(
    path.join(briefDir, 'BRIEF.md'),
    [
      '# Brief',
      // "#done" in the intent: act as if the task is finished.
      (args.includes('--') && args[args.indexOf('--') + 1]?.includes('#done')) || process.env.FAKE_DONE ? 'Status: done' : 'Status: working',
      '## Problem',
      'Login fails for **SSO** users.',
      '## Solution',
      'Fix the token refresh in `auth/session.go`.',
      '## Diagram',
      '```mermaid',
      'flowchart LR',
      '  A[Browser] --> B[Auth service]',
      '```',
      'Token flow after the fix.',
      '## Results',
      'Outcome: blocked',
      '- Delivered: Root cause found in `auth/session.go`',
      '- Blocked by: staging credentials (needs: platform team)',
      '## References',
      '- **PRD**: [SSO login PRD](https://confluence.example.com/prd/42) — sessions must survive token rotation',
      '- **Tech Spec**: none on ABC-4242',
      '## Checks',
      '- [x] go test ./auth/...',
      '- [!] e2e login suite',
      '- [~] lint',
      '- [ ] manual SSO login',
      '',
    ].join('\n'),
  );
}
const prompt = args.includes('--') ? args[args.indexOf('--') + 1] ?? '' : '';
// "#stuck": the same command failing the same way three times.
if (prompt.includes('#stuck')) {
  for (let i = 0; i < 3; i++) {
    const id = `toolu_${sid.slice(0, 8)}_${i}`;
    const timestamp = new Date().toISOString();
    write({ type: 'assistant', timestamp, message: { id: `msg_stuck_${i}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] } });
    write({ type: 'user', timestamp, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'Exit code 1\nFAIL auth.test.js: expected 200, got 401' }] } });
  }
}
// "#question": a question for the decision inbox, next to the brief.
if (prompt.includes('#question') && briefDir) {
  fs.writeFileSync(
    path.join(briefDir, 'QUESTIONS.md'),
    '## Postgres or SQLite for the cache?\nOptions: Postgres | SQLite\nDefault: SQLite\nThe data set is small.\n',
  );
}
// "#signin": like `railway login`, print a sign-in link whose callback is a port on this machine.
if (prompt.includes('#signin')) {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    const code = new URL(req.url, 'http://x').searchParams.get('code');
    res.end(`<h1>Logged in</h1><p>code ${code}</p>`);
    process.stdout.write(`\r\nLogged in with code ${code}\r\n`);
  });
  srv.listen(0, '127.0.0.1', () => {
    const cb = encodeURIComponent(`http://127.0.0.1:${srv.address().port}/callback`);
    process.stdout.write(`\r\nOpen this link to sign in:\r\nhttps://backboard.example.com/oauth/auth?response_type=code&client_id=c1&redirect_uri=${cb}&state=s1\r\n`);
  });
}
// "#waiting" / "#finish": plain words a rule can't recognize; the AI judge reads them.
if (prompt.includes('#waiting')) setTimeout(() => process.stdout.write('\r\nWhich database should I use for the cache, Postgres or SQLite?\r\n'), 200);
if (prompt.includes('#finish')) setTimeout(() => process.stdout.write('\r\nAll done: the token refresh fix is in.\r\n'), 200);
if (args.includes('--') && args[args.indexOf('--') + 1]?.includes('#ask')) {
  setTimeout(() => process.stdout.write('\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n'), 200);
}
process.stdout.write(`fake-claude ready ${args.includes('--resume') ? 'resumed' : 'new'} ${sid}\r\n`);
process.stdin.setRawMode?.(true);
process.stdin.on('data', (d) => {
  const s = d.toString();
  if (s.includes('exit')) process.exit(3);
  process.stdout.write(`echo:${s}`);
});
// FAKE_CLAUDE_HUP_DELAY_MS: take that long to close, like a busy session.
process.on('SIGHUP', () => setTimeout(() => process.exit(0), Number(process.env.FAKE_CLAUDE_HUP_DELAY_MS) || 0));
