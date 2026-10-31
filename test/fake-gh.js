#!/usr/bin/env node
// Stand-in for the gh CLI: pull requests live in $FAKE_GH_STATE (JSON { prs: [...] }, each with
// gh's own field names plus headRefName), and every call is logged to $FAKE_GH_LOG.
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = process.env.FAKE_GH_STATE;
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { prs: [] };
fs.appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(args)}\n`);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const pick = (pr) => {
  const fields = (opt('--json') ?? '').split(',').filter(Boolean);
  return fields.length ? Object.fromEntries(fields.map((f) => [f, pr[f] ?? null])) : pr;
};
const save = () => fs.writeFileSync(file, JSON.stringify(state));

const [group, cmd] = args;
if (group === 'pr' && cmd === 'list') {
  console.log(JSON.stringify(state.prs.filter((p) => p.headRefName === opt('--head')).map(pick)));
} else if (group === 'pr' && cmd === 'view') {
  const pr = state.prs.find((p) => p.url === args[2]);
  if (!pr) {
    console.error('no pull requests found');
    process.exit(1);
  }
  console.log(JSON.stringify(pick(pr)));
} else if (group === 'pr' && cmd === 'merge') {
  const pr = state.prs.find((p) => p.url === args[2]);
  if (!pr || pr.state !== 'OPEN') {
    console.error('Pull request is not open');
    process.exit(1);
  }
  if (!args.includes('--auto')) pr.state = 'MERGED';
  else pr.autoMerge = true;
  save();
} else if (group === 'search' && cmd === 'issues') {
  const repo = opt('--repo');
  const owner = opt('--owner');
  const label = opt('--label');
  const hits = (state.issues ?? []).filter((i) => i.state === 'OPEN' && i.labels.includes(label) && (!repo || i.repository.nameWithOwner === repo) && (!owner || i.repository.nameWithOwner.startsWith(`${owner}/`)));
  console.log(JSON.stringify(hits.map(pick)));
} else if (group === 'issue' && cmd === 'comment') {
  const issue = (state.issues ?? []).find((i) => i.url === args[2]);
  issue.comments = [...(issue.comments ?? []), opt('--body')];
  save();
} else if (group === 'pr' && cmd === 'create') {
  const number = state.prs.length + 1;
  const pr = { number, url: `https://github.com/acme/demo/pull/${number}`, title: opt('--title') ?? 'From commits', state: 'OPEN', isDraft: args.includes('--draft'), headRefName: opt('--head'), baseRefName: opt('--base') };
  state.prs.push(pr);
  save();
  console.log(pr.url);
} else {
  console.error(`fake gh: unsupported ${args.join(' ')}`);
  process.exit(1);
}
