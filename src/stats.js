// Results across agents for a period: how many started and from where, pull requests opened and
// merged, the merge rate, time to a first PR and to merge, cost per merged PR, and the same by
// engine and model and by project. Everything comes from what agentmgr already records.
import { costOf } from './budgets.js';

const HOUR = 3_600_000;

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Where an agent came from. */
export function sourceOf(a) {
  if (a.kind === 'assistant') return 'assistant session';
  if (a.startedBy) return 'assistant';
  if (a.trigger) return a.trigger.source === 'github' ? 'GitHub label' : 'webhook';
  if (a.playbook) return 'playbook';
  if (a.backlogItem) return 'backlog';
  if (a.team) return 'team';
  if (a.race) return 'race';
  if (a.forkOf) return 'fork';
  if (a.imported) return 'imported';
  return 'you';
}

/** PRs an agent opened or that were found on its branch (not ones it only mentioned). */
const ownPrs = (a) => Object.values(a.prs ?? {}).filter((p) => p.source !== 'mentioned');

function bucket() {
  return { agents: 0, withPr: 0, merged: 0, closed: 0, open: 0, cost: 0, toPrH: [], toMergeH: [], fixes: 0 };
}

function add(b, a) {
  const prs = ownPrs(a);
  const created = Date.parse(a.createdAt);
  b.agents += 1;
  b.cost += costOf(a);
  if (prs.length) b.withPr += 1;
  b.merged += prs.filter((p) => p.state === 'MERGED').length;
  b.closed += prs.filter((p) => p.state === 'CLOSED').length;
  b.open += prs.filter((p) => p.state === 'OPEN').length;
  const opened = prs.map((p) => Date.parse(p.openedAt)).filter(Number.isFinite).sort((x, y) => x - y)[0];
  if (opened && created && opened >= created) b.toPrH.push((opened - created) / HOUR);
  for (const p of prs.filter((x) => x.state === 'MERGED' && x.mergedAt)) {
    const m = Date.parse(p.mergedAt);
    if (created && m >= created) b.toMergeH.push((m - created) / HOUR);
  }
  b.fixes += Object.keys(a.landing?.sent ?? {}).length;
}

function finish(b) {
  const decided = b.merged + b.closed;
  return {
    agents: b.agents,
    withPr: b.withPr,
    merged: b.merged,
    closed: b.closed,
    open: b.open,
    mergeRate: decided ? round(b.merged / decided, 3) : null,
    cost: round(b.cost),
    costPerMerged: b.merged ? round(b.cost / b.merged) : null,
    medianHoursToPr: round(median(b.toPrH), 1),
    medianHoursToMerge: round(median(b.toMergeH), 1),
    fixesSent: b.fixes,
  };
}

/** Results for agents created in the last `days` days (0: all of them). */
export function stats(agents, { days = 30, now = Date.now(), projectOf = () => null } = {}) {
  const since = days ? now - days * 24 * HOUR : 0;
  const list = agents.filter((a) => a.kind !== 'general' && a.kind !== 'assistant' && Date.parse(a.createdAt) >= since);
  const total = bucket();
  const by = { source: new Map(), engine: new Map(), project: new Map() };
  const put = (map, key, a) => {
    if (!map.has(key)) map.set(key, bucket());
    add(map.get(key), a);
  };
  for (const a of list) {
    add(total, a);
    put(by.source, sourceOf(a), a);
    put(by.engine, `${a.engine ?? 'claude'}${a.model ? ` · ${a.model}` : ''}`, a);
    put(by.project, projectOf(a) ?? 'none', a);
  }
  const rows = (map) =>
    [...map.entries()]
      .map(([key, b]) => ({ key, ...finish(b) }))
      .sort((x, y) => y.agents - x.agents)
      .slice(0, 20);
  // Agents per day, for a small chart.
  const perDay = {};
  for (const a of list) {
    const d = new Date(a.createdAt).toISOString().slice(0, 10);
    perDay[d] = (perDay[d] ?? 0) + 1;
  }
  return {
    days,
    total: finish(total),
    bySource: rows(by.source),
    byEngine: rows(by.engine),
    byProject: rows(by.project),
    perDay: Object.entries(perDay).sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, n]) => ({ day, agents: n })),
  };
}
