// Clean up old agents: close sessions nobody has used for a while (they can be resumed), and
// delete agents that stayed closed long after that, with the worktrees agentmgr created.
// Strategies: "close-delete" (both, automatically), "close" (close automatically, delete by
// hand), "manual" (nothing automatic; run it from the Clean up dialog or `agentmgr cleanup`),
// and "off". Never touched: agents marked Keep, agents still setting up or working, members of a
// team that is still going, and, for deleting, agents with an open pull request or with work
// that exists only in their worktree (uncommitted changes or commits on no other branch).
import fs from 'node:fs';
import * as git from './git.js';

export const STRATEGIES = ['close-delete', 'close', 'manual', 'off'];
export const CLEANUP_DEFAULTS = { strategy: 'close', closeAfterDays: 14, deleteAfterDays: 14 };
const DAY = 86_400_000;
const TEAM_DONE = new Set(['done', 'stopped']);

const err = (status, message) => Object.assign(new Error(message), { status });
const days = (ms) => Math.floor(ms / DAY);

/** Settings from config.json's "cleanup", with defaults and sane bounds. */
export function cleanupSettings(config = {}) {
  const c = { ...CLEANUP_DEFAULTS, ...config.cleanup };
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 1 ? Math.min(3650, Math.floor(Number(v))) : d);
  return {
    strategy: STRATEGIES.includes(c.strategy) ? c.strategy : CLEANUP_DEFAULTS.strategy,
    closeAfterDays: n(c.closeAfterDays, CLEANUP_DEFAULTS.closeAfterDays),
    deleteAfterDays: n(c.deleteAfterDays, CLEANUP_DEFAULTS.deleteAfterDays),
  };
}

/** Work that would be lost with the worktree: uncommitted changes, or commits on no other branch or remote. */
export async function unsavedWork(agent) {
  const dir = agent.workdir;
  if (!dir || agent.sharedWith || !fs.existsSync(dir)) return null;
  try {
    const dirty = await git.run('git', ['status', '--porcelain'], { cwd: dir });
    if (dirty.trim()) return 'uncommitted changes';
    const branch = agent.branch ?? (await git.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).trim();
    const only = await git.run('git', ['rev-list', '--count', 'HEAD', '--not', '--remotes', `--exclude=${branch}`, '--branches'], { cwd: dir });
    const n = Number(only.trim());
    return n > 0 ? `${n} commit${n > 1 ? 's' : ''} not pushed or merged` : null;
  } catch (e) {
    return `couldn't check its worktree (${e.message.split('\n')[0]})`;
  }
}

export class Cleanup {
  constructor({ manager, store, config = {}, teams = null, log = (m) => console.log(`[agentmgr] ${m}`) }) {
    this.manager = manager;
    this.store = store;
    this.config = config;
    this.teams = teams;
    this.log = log;
    store.data.cleanup ??= {};
    // A first look a couple of minutes after start, then every few hours.
    this.firstTimer = setTimeout(() => this.sweep().catch((e) => this.log(`clean up: ${e.message}`)), config.cleanupFirstSec ? config.cleanupFirstSec * 1000 : 120_000);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => this.sweep().catch((e) => this.log(`clean up: ${e.message}`)), (config.cleanupEveryMin ?? 360) * 60_000);
    this.timer.unref?.();
  }

  close() {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
  }

  get settings() {
    return cleanupSettings(this.config);
  }

  /** Change the strategy or the days; kept in config.json by the caller. */
  update(patch = {}) {
    if (patch.strategy !== undefined && !STRATEGIES.includes(patch.strategy)) throw err(400, `strategy must be one of ${STRATEGIES.join(', ')}`);
    for (const k of ['closeAfterDays', 'deleteAfterDays']) {
      if (patch[k] !== undefined && !(Number(patch[k]) >= 1)) throw err(400, `${k} must be 1 or more`);
    }
    const next = cleanupSettings({ cleanup: { ...this.config.cleanup, ...patch } });
    this.config.cleanup = next;
    return next;
  }

  /** Why an agent is left alone whatever its age, or null. */
  protectedBy(agent) {
    if (agent.keep) return 'marked Keep';
    if (agent.kind === 'assistant') return 'the assistant';
    if (agent.status === 'preparing') return 'still setting up';
    const rt = this.manager.runtimes.get(agent.id);
    if (rt?.pty && rt.busy) return 'working';
    const team = agent.team && this.store.data.teams?.[agent.team.id];
    if (team && !TEAM_DONE.has(team.stage)) return 'its team is still going';
    return null;
  }

  /**
   * What a run would do now: agents to close (idle closeAfterDays), agents to delete (closed
   * deleteAfterDays), and agents left alone with the reason. Deleting checks the worktree.
   */
  async plan({ checkWork = true } = {}) {
    const s = this.settings;
    const now = Date.now();
    const close = [];
    const del = [];
    const kept = [];
    for (const agent of this.store.list()) {
      const rt = this.manager.runtimes.get(agent.id);
      const running = Boolean(rt?.pty);
      const activeAt = Date.parse(this.manager.activeAt(agent, rt) ?? agent.createdAt) || now;
      const idle = now - activeAt;
      const row = { id: agent.id, name: agent.name, idleDays: days(idle) };
      if (running) {
        if (idle < s.closeAfterDays * DAY) continue;
        const why = this.protectedBy(agent);
        if (why) kept.push({ ...row, action: 'close', reason: why });
        else close.push(row);
        continue;
      }
      // Closed since: when it was closed, or its last activity if that is later (or unknown).
      const closedAt = Math.max(Date.parse(agent.closedAt ?? '') || 0, activeAt);
      const closedFor = now - closedAt;
      if (!agent.closedAt || closedFor < s.deleteAfterDays * DAY) continue;
      const r = { ...row, closedDays: days(closedFor) };
      const why =
        this.protectedBy(agent) ??
        (Object.values(agent.prs ?? {}).some((p) => p.state === 'OPEN') ? 'has an open pull request' : null) ??
        (checkWork ? await unsavedWork(agent) : null);
      if (why) kept.push({ ...r, action: 'delete', reason: why });
      else del.push(r);
    }
    return { close, delete: del, kept };
  }

  /** Close and/or delete what the plan says; `ids` limits it to those agents. */
  async run({ close = true, delete: del = true, ids = null, by = 'person' } = {}) {
    const only = ids ? new Set(ids) : null;
    const plan = await this.plan();
    const done = { at: new Date().toISOString(), by, closed: [], deleted: [], kept: plan.kept, failed: [] };
    if (close) {
      for (const row of plan.close.filter((r) => !only || only.has(r.id))) {
        try {
          await this.manager.stop(row.id);
          this.manager.patch(row.id, { closedBy: 'cleanup' });
          done.closed.push(row);
        } catch (e) {
          done.failed.push({ ...row, reason: e.message });
        }
      }
    }
    if (del) {
      for (const row of plan.delete.filter((r) => !only || only.has(r.id))) {
        try {
          await this.manager.remove(row.id, { deleteWorkspace: true });
          done.deleted.push(row);
        } catch (e) {
          done.failed.push({ ...row, reason: e.message });
        }
      }
    }
    if (done.closed.length || done.deleted.length || done.failed.length) {
      this.log(`clean up (${by}): closed ${done.closed.length}, deleted ${done.deleted.length}${done.failed.length ? `, failed ${done.failed.length}` : ''}`);
    }
    this.store.data.cleanup.lastRun = done;
    this.store.save();
    return done;
  }

  /** The automatic pass, as the strategy says. */
  async sweep() {
    // Agents closed before clean up existed have no closing time: count from now, so nothing is
    // deleted the day it is turned on.
    let marked = false;
    for (const agent of this.store.list()) {
      if (!agent.closedAt && !this.manager.runtimes.get(agent.id)?.pty && agent.desired !== 'running') {
        agent.closedAt = new Date().toISOString();
        marked = true;
      }
    }
    if (marked) this.store.save();
    const { strategy } = this.settings;
    if (strategy === 'off' || strategy === 'manual') return null;
    return this.run({ close: true, delete: strategy === 'close-delete', by: 'schedule' });
  }

  async status() {
    const s = this.settings;
    return { ...s, ...(await this.plan()), lastRun: this.store.data.cleanup.lastRun ?? null };
  }
}
