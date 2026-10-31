// Spending limits, from the cost Claude Code records for each session (Codex and Antigravity
// record none). Per agent: at 80% you get an alert; at the limit the agent's session is closed
// and it won't start again until its budget is raised. Per day: once today's spend reaches the
// limit, no new agents start (or resume) until tomorrow or a higher limit; running ones go on.
// A built-in policy enforces both, so every way of starting an agent is covered.

export const BUDGET_DEFAULTS = { perAgentUsd: null, perDayUsd: null, warnAt: 0.8 };
const err = (status, message) => Object.assign(new Error(message), { status });
const usd = (n) => `$${Number(n).toFixed(2)}`;

/** Settings from config.json's "budgets": dollar limits (null = none) and the alert fraction. */
export function budgetSettings(config = {}) {
  const c = { ...BUDGET_DEFAULTS, ...config.budgets };
  const money = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v) * 100) / 100 : null);
  const w = Number(c.warnAt);
  return { perAgentUsd: money(c.perAgentUsd), perDayUsd: money(c.perDayUsd), warnAt: Number.isFinite(w) && w > 0 && w < 1 ? w : BUDGET_DEFAULTS.warnAt };
}

/** What an agent's sessions cost so far, as Claude Code recorded it. */
export function costOf(agent) {
  return (agent.sessions ?? []).reduce((sum, s) => sum + (Number(s.cost?.usd) || 0), 0);
}

export const dayKey = (t = new Date()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export class Budgets {
  constructor({ manager, store, config = {}, notifier = null, log = (m) => console.log(`[agentmgr] ${m}`) }) {
    this.manager = manager;
    this.store = store;
    this.config = config;
    this.notifier = notifier;
    this.log = log;
    store.data.spend ??= { days: {}, seen: {} };
    this.startedAt = Date.now();
    // Today's spend counts from now: what agents cost before limits existed isn't today's.
    this.seed();
    manager.plugins.api('budgets', config).policy((action, details) => this.policy(action, details));
    this.timer = setInterval(() => this.tick(), (config.budgetCheckSec ?? 60) * 1000);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
  }

  get settings() {
    return budgetSettings(this.config);
  }

  get ledger() {
    return this.store.data.spend;
  }

  seed() {
    for (const a of this.store.list()) if (this.ledger.seen[a.id] === undefined) this.ledger.seen[a.id] = costOf(a);
  }

  limitOf(agent) {
    return agent.budgetUsd ?? this.settings.perAgentUsd;
  }

  today() {
    return this.ledger.days[dayKey()] ?? { total: 0, byAgent: {} };
  }

  policy(action, details) {
    if (action !== 'agent.start' && action !== 'agent.create') return undefined;
    const s = this.settings;
    if (s.perDayUsd && this.today().total >= s.perDayUsd) {
      return { allow: false, reason: `Today's spend (${usd(this.today().total)}) reached the daily limit of ${usd(s.perDayUsd)}; raise it in Budgets or wait until tomorrow` };
    }
    if (action === 'agent.start') {
      const agent = this.store.get(details.agent?.id);
      const limit = agent && this.limitOf(agent);
      if (limit && costOf(agent) >= limit) {
        return { allow: false, reason: `${agent.name} has spent ${usd(costOf(agent))} of its ${usd(limit)} budget; raise its budget (Edit) to continue` };
      }
    }
    return undefined;
  }

  /** Count new spend into today, warn near a limit, close agents that reached theirs. */
  tick() {
    const s = this.settings;
    const key = dayKey();
    const day = (this.ledger.days[key] ??= { total: 0, byAgent: {} });
    let changed = false;
    for (const agent of this.store.list()) {
      const cost = costOf(agent);
      // An agent new since start counts from zero; one from before limits existed, from now.
      const before = this.ledger.seen[agent.id] ?? (Date.parse(agent.createdAt) >= this.startedAt ? 0 : cost);
      if (cost > before) {
        const d = cost - before;
        day.total = Math.round((day.total + d) * 10_000) / 10_000;
        day.byAgent[agent.id] = Math.round(((day.byAgent[agent.id] ?? 0) + d) * 10_000) / 10_000;
        changed = true;
      }
      if (this.ledger.seen[agent.id] !== cost) {
        this.ledger.seen[agent.id] = cost;
        changed = true;
      }
      const limit = this.limitOf(agent);
      if (!limit) continue;
      if (cost >= limit && !agent.budgetHit) {
        this.manager.patch(agent.id, { budgetHit: new Date().toISOString() });
        if (this.manager.runtimes.get(agent.id)?.pty) this.manager.stop(agent.id).catch(() => {});
        this.notifier?.send?.('budget', agent, `reached its ${usd(limit)} budget (${usd(cost)} spent) and was closed. Raise its budget to continue.`);
        this.log(`budgets: ${agent.name} reached its ${usd(limit)} budget; closed`);
      } else if (cost >= limit * s.warnAt && cost < limit && agent.budgetWarned !== limit) {
        this.manager.patch(agent.id, { budgetWarned: limit });
        this.notifier?.send?.('budget', agent, `has spent ${usd(cost)} of its ${usd(limit)} budget.`);
      }
    }
    if (s.perDayUsd && day.total >= s.perDayUsd && !day.alerted) {
      day.alerted = true;
      changed = true;
      this.log(`budgets: today's spend ${usd(day.total)} reached the daily limit ${usd(s.perDayUsd)}`);
      this.notifier?.send?.('budget', { id: '', name: 'Daily limit' }, `reached: today's agent spend is ${usd(day.total)} of ${usd(s.perDayUsd)}. No new agents start until tomorrow or a higher limit.`);
    }
    // Keep 90 days of history.
    for (const k of Object.keys(this.ledger.days).sort().slice(0, -90)) delete this.ledger.days[k];
    if (changed) this.store.save();
  }

  update(patch = {}) {
    for (const k of ['perAgentUsd', 'perDayUsd']) {
      const v = patch[k];
      if (v !== undefined && v !== null && v !== '' && !(Number(v) > 0)) throw err(400, `${k} must be a positive number of dollars, or empty for no limit`);
    }
    const next = budgetSettings({ budgets: { ...this.config.budgets, ...patch } });
    this.config.budgets = next;
    // A higher limit lifts the stop on agents now under it.
    for (const a of this.store.list()) {
      const limit = this.limitOf(a);
      if (a.budgetHit && (!limit || costOf(a) < limit)) this.manager.patch(a.id, { budgetHit: null });
    }
    return next;
  }

  status() {
    this.tick();
    const s = this.settings;
    const today = this.today();
    const names = Object.fromEntries(this.store.list().map((a) => [a.id, a.name]));
    const days = Object.entries(this.ledger.days)
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .slice(0, 14)
      .map(([day, d]) => ({ day, total: d.total }));
    const agents = this.store
      .list()
      .map((a) => ({ id: a.id, name: a.name, cost: Math.round(costOf(a) * 100) / 100, limit: this.limitOf(a), own: a.budgetUsd ?? null, hit: a.budgetHit ?? null, today: today.byAgent[a.id] ?? 0 }))
      .filter((a) => a.cost > 0 || a.own)
      .sort((x, y) => y.cost - x.cost)
      .slice(0, 50);
    return {
      ...s,
      today: { total: Math.round(today.total * 100) / 100, top: Object.entries(today.byAgent).sort(([, a], [, b]) => b - a).slice(0, 5).map(([id, c]) => ({ id, name: names[id] ?? id, cost: Math.round(c * 100) / 100 })) },
      days,
      agents,
      note: 'Costs are what Claude Code records for each session (the API price, even on a subscription plan). Codex and Antigravity record none.',
    };
  }
}
