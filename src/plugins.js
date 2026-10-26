// Plugins: how a separate package extends AI Agent Manager without changing it. A plugin is an
// ES module listed in config.json "plugins" (the daemon) or AGENTMGR_HUB_PLUGINS (the hub),
// whose default export (or `register`) receives the API below:
//
//   export default function register(api) {
//     api.policy((action, details) => details.input?.permissionMode === 'bypassPermissions'
//       ? { allow: false, reason: 'Not allowed here' } : undefined);
//     api.on((event, payload) => appendAuditLog(event, payload));
//     api.routes((router) => router.get('/status', (req, res) => res.json({ ok: true })));
//   }
//
// Policies run before an action and may refuse it; listeners hear what happened; routes are
// served under /api/ext/<plugin name> behind the same sign-in and request checks as the rest
// of the API. A plugin that fails to load stops startup: a policy that silently isn't there
// is worse than no start.
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const err = (status, message) => Object.assign(new Error(message), { status });

export class Plugins {
  constructor({ log = (m) => console.log(m) } = {}) {
    this.log = log;
    this.loaded = []; // { name, spec }
    this.policies = []; // { name, fn }
    this.listeners = []; // { name, fn }
    this.routers = []; // { name, fn }
    this.authenticators = []; // { name, fn }
    this.engines = []; // { name, def }
  }

  /** Imports each plugin and lets it register. `base` resolves relative paths. */
  async load(specs = [], { config = {}, base = process.cwd() } = {}) {
    for (const spec of specs.filter(Boolean)) {
      const target = /^(\.|\/|~)/.test(spec) ? pathToFileURL(path.resolve(base, spec.replace(/^~(?=\/|$)/, os.homedir()))).href : spec;
      let mod;
      try {
        mod = await import(target);
      } catch (e) {
        throw new Error(`Plugin "${spec}" could not be loaded: ${e.message}`);
      }
      const register = typeof mod.default === 'function' ? mod.default : mod.register;
      if (typeof register !== 'function') throw new Error(`Plugin "${spec}" has no default export or register() function`);
      const name = String(mod.name ?? path.basename(spec).replace(/\.m?js$/, '')).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'plugin';
      await register(this.api(name, config));
      this.loaded.push({ name, spec });
      this.log(`plugin ${name} loaded`);
    }
    return this;
  }

  api(name, config) {
    return {
      name,
      config,
      log: (m) => this.log(`[${name}] ${m}`),
      /** fn(action, details) -> { allow: false, reason } to refuse; anything else allows. */
      policy: (fn) => this.policies.push({ name, fn }),
      /** fn(event, payload); errors are logged, never thrown into the caller. */
      on: (fn) => this.listeners.push({ name, fn }),
      /** fn(expressRouter): mounted at /api/ext/<name>. */
      routes: (fn) => this.routers.push({ name, fn }),
      /** Hub only. fn(req) -> { user, email?, roles? } for a request this plugin signs in, else null. */
      authenticate: (fn) => this.authenticators.push({ name, fn }),
      /** Daemon only. An agent engine adapter (see src/engines/). */
      engine: (def) => this.engines.push({ name, def }),
    };
  }

  /** Throws a 403 when a policy refuses `action`. Policies are synchronous so every caller can use them. */
  check(action, details = {}) {
    for (const { name, fn } of this.policies) {
      let verdict;
      try {
        verdict = fn(action, details);
      } catch (e) {
        throw err(403, `Refused by ${name}: its policy failed (${e.message})`);
      }
      if (verdict && verdict.allow === false) throw err(403, verdict.reason ? `${verdict.reason} (${name})` : `Refused by ${name}`);
    }
  }

  /** Tells listeners what happened; never throws and never waits. */
  emit(event, payload = {}) {
    for (const { name, fn } of this.listeners) {
      Promise.resolve()
        .then(() => fn(event, { ...payload, at: new Date().toISOString() }))
        .catch((e) => this.log(`[${name}] listener failed on ${event}: ${e.message}`));
    }
  }

  /** Mounts each plugin's routes on `router` under /ext/<name>. */
  mount(router, express) {
    for (const { name, fn } of this.routers) {
      const r = express.Router();
      fn(r);
      router.use(`/ext/${name}`, r);
    }
  }

  /** The first plugin sign-in that accepts the request, as { plugin, ...identity }, or null. */
  authenticate(req) {
    for (const { name, fn } of this.authenticators) {
      try {
        const who = fn(req);
        if (who) return { plugin: name, ...who };
      } catch (e) {
        this.log(`[${name}] authenticate failed: ${e.message}`);
      }
    }
    return null;
  }
}

/** Plugins named in config.json "plugins" plus $AGENTMGR_PLUGINS (comma separated). */
export function pluginSpecs(config = {}, env = process.env.AGENTMGR_PLUGINS) {
  return [...(Array.isArray(config.plugins) ? config.plugins : []), ...String(env ?? '').split(',').map((s) => s.trim())].filter(Boolean);
}
