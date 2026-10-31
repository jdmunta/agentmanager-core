// Playbooks: saved requests you run again, by hand or on a schedule. One playbook is a request
// (with {{placeholders}} filled in at run time), the projects to run it in (one agent each), and
// optionally a model, permission mode and schedule: "upgrade dependency X in every repo",
// "every weekday at 9:00, triage the flaky tests".
import crypto from 'node:crypto';

const err = (status, message) => Object.assign(new Error(message), { status });
export const EVERY = ['hour', 'day', 'weekday', 'week'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "{{name}}" placeholders in a request, in order, once each. */
export function placeholders(text) {
  return [...new Set([...String(text ?? '').matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)].map((m) => m[1]))];
}

export function render(text, vars = {}) {
  return String(text).replace(/\{\{\s*([\w-]+)\s*\}\}/g, (m, k) => (vars[k] != null && String(vars[k]).trim() ? String(vars[k]).trim() : m));
}

/** A schedule, checked: { every: hour|day|weekday|week, at: "HH:MM", day: "mon".."sun" } or null. */
export function cleanSchedule(s) {
  if (!s || !s.every) return null;
  if (!EVERY.includes(s.every)) throw err(400, `schedule.every must be one of ${EVERY.join(', ')}`);
  const at = String(s.at ?? '09:00').trim();
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) throw err(400, 'schedule.at must be HH:MM');
  const day = s.every === 'week' ? String(s.day ?? 'mon').toLowerCase().slice(0, 3) : undefined;
  if (day !== undefined && !DAYS.includes(day)) throw err(400, 'schedule.day must be mon..sun');
  const [h, m] = at.split(':').map(Number);
  return { every: s.every, at: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, ...(day ? { day } : {}) };
}

/** The first time the schedule fires strictly after `after` (local time). */
export function nextRun(schedule, after = new Date()) {
  if (!schedule) return null;
  const [h, m] = schedule.at.split(':').map(Number);
  const t = new Date(after);
  if (schedule.every === 'hour') {
    t.setSeconds(0, 0);
    t.setMinutes(m);
    if (t <= after) t.setHours(t.getHours() + 1);
    return t;
  }
  t.setHours(h, m, 0, 0);
  for (let i = 0; i < 9; i += 1) {
    const ok =
      t > after &&
      (schedule.every === 'day' ||
        (schedule.every === 'weekday' && t.getDay() >= 1 && t.getDay() <= 5) ||
        (schedule.every === 'week' && DAYS[t.getDay()] === schedule.day));
    if (ok) return t;
    t.setDate(t.getDate() + 1);
  }
  return null;
}

export class Playbooks {
  constructor({ manager, store, log = (m) => console.log(`[agentmgr] ${m}`) }) {
    this.manager = manager;
    this.store = store;
    this.log = log;
    store.data.playbooks ??= {};
    this.timer = setInterval(() => this.tick().catch((e) => this.log(`playbooks: ${e.message}`)), 60_000);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
  }

  get all() {
    return this.store.data.playbooks;
  }

  view(p) {
    return { ...p, placeholders: placeholders(p.intent), nextRunAt: p.enabled && p.schedule ? nextRun(p.schedule, new Date(Math.max(Date.now(), Date.parse(p.lastRunAt ?? 0) || 0)))?.toISOString() ?? null : null };
  }

  list() {
    return Object.values(this.all)
      .map((p) => this.view(p))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id) {
    const p = this.all[id] ?? Object.values(this.all).find((x) => x.name.toLowerCase() === String(id).toLowerCase());
    if (!p) throw err(404, `No playbook "${id}"`);
    return p;
  }

  clean(input, prev = {}) {
    const name = String(input.name ?? prev.name ?? '').trim().slice(0, 80);
    if (!name) throw err(400, 'A name is required');
    const intent = String(input.intent ?? prev.intent ?? '').trim();
    if (!intent) throw err(400, 'The request is required');
    const projects = (Array.isArray(input.projects) ? input.projects : String(input.projects ?? '').split(/[\s,]+/)).map((x) => String(x).trim().replace(/^@/, '')).filter(Boolean);
    const list = input.projects === undefined ? prev.projects ?? [] : projects;
    for (const p of list) if (!this.manager.resolveProject(p)) throw err(400, `No project "${p}" (agentmgr project ls)`);
    if (!list.length) throw err(400, 'Pick at least one project to run it in');
    const schedule = input.schedule === undefined ? prev.schedule ?? null : cleanSchedule(input.schedule);
    if (schedule && placeholders(intent).some((k) => !(input.defaults ?? prev.defaults ?? {})[k])) {
      throw err(400, 'A scheduled playbook needs a default value for each {{placeholder}}');
    }
    return {
      name,
      intent,
      projects: list,
      model: (input.model ?? prev.model ?? '') || null,
      permissionMode: (input.permissionMode ?? prev.permissionMode ?? '') || null,
      priority: input.priority ?? prev.priority ?? 2,
      defaults: input.defaults ?? prev.defaults ?? {},
      schedule,
      enabled: input.enabled ?? prev.enabled ?? true,
    };
  }

  create(input = {}) {
    const p = { id: crypto.randomBytes(3).toString('hex'), ...this.clean(input), createdAt: new Date().toISOString(), runs: [] };
    if (Object.values(this.all).some((x) => x.name.toLowerCase() === p.name.toLowerCase())) throw err(409, `A playbook named "${p.name}" exists`);
    this.all[p.id] = p;
    this.store.save();
    return this.view(p);
  }

  update(id, input = {}) {
    const p = this.get(id);
    Object.assign(p, this.clean(input, p));
    this.store.save();
    return this.view(p);
  }

  remove(id) {
    const p = this.get(id);
    delete this.all[p.id];
    this.store.save();
    return { ok: true };
  }

  /** One agent per project, with the placeholders filled in. */
  run(id, { vars = {}, by = 'person' } = {}) {
    const p = this.get(id);
    const values = { ...p.defaults, ...vars };
    const intent = render(p.intent, values);
    const missing = placeholders(intent);
    if (missing.length) throw err(400, `Fill in ${missing.map((k) => `{{${k}}}`).join(', ')}`);
    const run = { at: new Date().toISOString(), by, agents: [], failed: [] };
    for (const project of p.projects) {
      try {
        const [a] = this.manager.createMany([intent], { project, model: p.model ?? undefined, permissionMode: p.permissionMode ?? undefined, priority: p.priority });
        this.manager.patch(a.id, { playbook: { id: p.id, name: p.name, at: run.at } });
        run.agents.push({ id: a.id, name: a.name, project });
      } catch (e) {
        run.failed.push({ project, reason: e.message });
      }
    }
    p.lastRunAt = run.at;
    p.runs = [...(p.runs ?? []), run].slice(-20);
    this.store.save();
    this.log(`playbooks: ran "${p.name}" (${by}): ${run.agents.length} agent(s)${run.failed.length ? `, ${run.failed.length} failed` : ''}`);
    return run;
  }

  /** Run what is due. A run missed while the daemon was down runs once when it is back. */
  async tick(now = new Date()) {
    for (const p of Object.values(this.all)) {
      if (!p.enabled || !p.schedule) continue;
      const since = new Date(Date.parse(p.lastRunAt ?? p.createdAt) || now.getTime());
      const due = nextRun(p.schedule, since);
      if (!due || due > now) continue;
      try {
        this.run(p.id, { by: 'schedule' });
      } catch (e) {
        p.lastRunAt = now.toISOString();
        p.runs = [...(p.runs ?? []), { at: p.lastRunAt, by: 'schedule', agents: [], failed: [{ project: '*', reason: e.message }] }].slice(-20);
        this.store.save();
      }
    }
  }
}
