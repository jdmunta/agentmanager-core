import fs from 'node:fs';
import path from 'node:path';

/** The state file's format. Bump it with a migration below whenever saved fields change shape. */
export const STATE_VERSION = 1;

/** MIGRATIONS[n] turns version n data into version n + 1. */
const MIGRATIONS = {};

/**
 * JSON-file persistence for agent records. Writes are atomic (tmp + rename)
 * so a crash mid-write never loses the session IDs.
 *
 * Upgrades: older files are copied to `<file>.v<N>.bak` and migrated one version at a time.
 * A file from a newer Agent Manager is refused rather than overwritten (downgrades would lose
 * fields). The file as it was at startup is kept as `<file>.bak`.
 */
export class Store {
  constructor(file) {
    this.file = file;
    this.data = { version: STATE_VERSION, agents: {} };
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw new Error(`Cannot read ${this.file}: ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Cannot read ${this.file}: ${err.message}. The copy from the last start is ${this.file}.bak`);
    }
    const version = Number(parsed.version ?? 1);
    if (version > STATE_VERSION) {
      throw new Error(`${this.file} was written by a newer Agent Manager (state version ${version}; this one reads up to ${STATE_VERSION}). Upgrade Agent Manager, or restore a backup.`);
    }
    if (version < STATE_VERSION) {
      fs.copyFileSync(this.file, `${this.file}.v${version}.bak`);
      for (let v = version; v < STATE_VERSION; v++) parsed = { ...MIGRATIONS[v](parsed), version: v + 1 };
    }
    try {
      fs.writeFileSync(`${this.file}.bak`, raw);
    } catch {}
    this.data = { agents: {}, ...parsed, version: STATE_VERSION };
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    // fsync before the rename so a crash or power loss can't leave an empty or partial file.
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(this.data, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  list() {
    return Object.values(this.data.agents).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id) {
    return this.data.agents[id];
  }

  /** Find by exact id, then unique id prefix, then unique name. */
  resolve(ref) {
    if (this.data.agents[ref]) return this.data.agents[ref];
    const all = this.list();
    const byPrefix = all.filter((a) => a.id.startsWith(ref));
    if (byPrefix.length === 1) return byPrefix[0];
    const byName = all.filter((a) => a.name === ref);
    if (byName.length === 1) return byName[0];
    return undefined;
  }

  put(agent) {
    this.data.agents[agent.id] = agent;
    this.save();
    return agent;
  }

  patch(id, fields) {
    const agent = this.data.agents[id];
    if (!agent) return undefined;
    Object.assign(agent, fields, { updatedAt: new Date().toISOString() });
    this.save();
    return agent;
  }

  remove(id) {
    delete this.data.agents[id];
    this.save();
  }
}
