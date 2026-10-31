import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { ensureHome, HOST, loadConfig, paths, PORT, saveConfig } from './config.js';
import { AgentManager, MACHINE, shellNumber } from './manager.js';
import { Backlog } from './backlog.js';
import { Races } from './races.js';
import { Review } from './review.js';
import { Teams } from './teams.js';
import { Assistant } from './assistant.js';
import { Cleanup } from './cleanup.js';
import { Landing } from './landing.js';
import { Budgets } from './budgets.js';
import { stats } from './stats.js';
import { Playbooks } from './playbooks.js';
import { Updates } from './update.js';
import { identity } from './identity.js';
import { Studio } from './studio.js';
import { Memory } from './memory.js';
import { doctor } from './doctor.js';
import { Triggers, tokenMatches } from './triggers.js';
import { listEngines, registerEngine } from './engines/index.js';
import { Plugins, pluginSpecs } from './plugins.js';
import { HubLink, linkUrls } from './hublink.js';
import { Notifier, isWorkflowUrl, loadNotify, publicNotify, saveNotify, sendSlack } from './notify.js';
import { Previews, parseUrl } from './preview.js';
import { LiveBrowser } from './livebrowser.js';
import * as remote from './remote.js';
import { Store } from './store.js';
import { about, latestRelease } from './about.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const CLIENT_HEADER = 'x-agentmgr';

/**
 * The API drives real terminals, so callers are restricted.
 *
 * Local listener (127.0.0.1): Host must be loopback (blocks DNS rebinding), a
 * browser Origin must be this server (blocks cross-site WebSockets), and writes
 * need a custom header (browsers cannot send one cross-origin without a CORS
 * preflight we never grant).
 *
 * Remote listener (opt-in HTTPS on the LAN): the same, with this machine's own
 * addresses as the only valid Host, and a signed-in device session on every API
 * call except login. Managing remote access and shutting down stay local-only.
 */
function isLocalHost(host, port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host);
}
function isAllowedOrigin(origin, port) {
  return !origin || [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin);
}

const PUBLIC_REMOTE_API = new Set(['POST /api/login', 'GET /api/session']);
const LOCAL_ONLY_API = /^\/api\/(remote(\/|$)|notify(\/|$)|hub(\/|$)|triggers(\/|$)|update(\/|$)|editors$|agents\/[\w-]+\/open-in$|shutdown$)/;
const HOOK_PATH = '/api/hooks/agents';
const NO_REPO_KINDS = new Set(['general', 'assistant']);

export async function startServer({ port = PORT, host = HOST } = {}) {
  ensureHome();
  const config = loadConfig();
  const store = new Store(paths.state);
  const plugins = await new Plugins({ log: (m) => console.log(`[agentmgr] ${m}`) }).load(pluginSpecs(config), { config, base: paths.home });
  for (const { def } of plugins.engines) registerEngine(def);
  const manager = new AgentManager({ store, config, plugins });
  const backlog = new Backlog({ manager, store, config });
  const races = new Races({ manager, store });
  const review = new Review({ manager });
  const studio = new Studio({ manager, review });
  const teams = new Teams({ manager, store, config });
  const cleanup = new Cleanup({ manager, store, config, teams });
  const landing = new Landing({ manager, store, config });
  const assistant = new Assistant({ manager, store, config });
  // Alerts link to the phone address when remote access is on, else the local UI.
  const notifier = new Notifier({
    manager,
    teams,
    backlog,
    linkFor: (id) => {
      const phone = remoteServer ? remote.remoteUrls(remotePort).find((u) => !u.vpn) : null;
      return `${phone ? phone.url : `http://127.0.0.1:${port}/`}#${id}/term`;
    },
  });
  const triggers = new Triggers({ manager, store, config, notifier });
  const budgets = new Budgets({ manager, store, config, notifier });
  const playbooks = new Playbooks({ manager, store });
  const memory = new Memory({ manager, config });
  const updates = new Updates({ config });
  let remoteServer = null;
  let remotePort = null;
  // Live browser tabs: what a page does is saved on the agent's tab; popups become new tabs.
  const live = new LiveBrowser({
    config,
    onNavigate: (id, n, url) => {
      try {
        manager.setBrowser(id, n, url, { raw: true });
      } catch {}
    },
    onPopup: (id, url) => {
      try {
        return manager.addBrowser(id, url, { mode: 'live', raw: true }).n;
      } catch {
        return null;
      }
    },
    onClosed: (id, n) => {
      try {
        manager.dropBrowser(id, n);
      } catch {}
    },
  });
  const previews = new Previews({
    tls: () => {
      const { key, cert } = remote.certificatePaths();
      return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
    },
    allowedHosts: (p) => remote.allowedRemoteHosts(p),
    signedIn: (cookies) => Boolean(remote.checkSession(remote.parseCookies(cookies)[remote.SESSION_COOKIE])),
    cookieName: remote.SESSION_COOKIE,
    reserved: () => [port, remotePort].filter(Boolean),
    savedPorts: () => remote.loadSettings().relayPorts,
    savePorts: (relayPorts) => remote.saveSettings({ relayPorts }),
    ownHosts: () => new Set([...remote.lanAddresses().map((a) => a.address), remote.localHostname(), ...remote.loadSettings().extraHosts].map((h) => h.toLowerCase())),
  });
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  // "Open on this machine" links from the hub point at remote access, when it's on.
  const hubLink = new HubLink({ manager, config, backlog, version: pkgVersion, urls: () => (remoteServer ? linkUrls(remote.remoteUrls(remotePort)) : []) });

  /** Returns an error string if the request may not proceed, else null. Sets req.device for remote sessions. */
  function denied(req) {
    const host = (req.headers.host ?? '').toLowerCase();
    const origin = req.headers.origin;
    if (!req.remote) {
      if (!isLocalHost(host, port) || !isAllowedOrigin(origin, port)) return 'Forbidden';
      return null;
    }
    if (!remote.allowedRemoteHosts(remotePort).has(host)) return 'Unknown host';
    if (origin && origin !== `https://${host}`) return 'Forbidden origin';
    const pathname = req.url.split('?')[0];
    const isApi = pathname.startsWith('/api/') || pathname.startsWith('/ws/');
    if (!isApi) return null; // page, scripts and styles: no secrets
    if (LOCAL_ONLY_API.test(pathname)) return 'Only available on this computer';
    if (PUBLIC_REMOTE_API.has(`${req.method} ${pathname}`)) return null;
    const cookie = remote.parseCookies(req.headers.cookie)[remote.SESSION_COOKIE];
    req.device = remote.checkSession(cookie);
    return req.device ? null : 'Sign in required';
  }

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The webhook signs in with its token instead of a device session or the client header.
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const hook = req.method === 'POST' && req.url.split('?')[0] === HOOK_PATH && tokenMatches(req.headers['x-agentmgr-token'] ?? bearer, config.triggers?.webhook?.enabled ? config.triggers.webhook.token : null);
    const why = denied(req);
    if (why && !(hook && why === 'Sign in required')) return res.status(why === 'Sign in required' ? 401 : 403).json({ error: why });
    if (req.url.split('?')[0] === HOOK_PATH && !hook) return res.status(401).json({ error: 'Bad or missing token' });
    if (!hook && !['GET', 'HEAD'].includes(req.method) && req.headers[CLIENT_HEADER] !== '1') {
      return res.status(403).json({ error: `Missing ${CLIENT_HEADER} header` });
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  // Package root, found from its entry point (not every package exports package.json).
  const pkgDir = (name) => {
    let dir = path.dirname(require.resolve(name));
    while (!fs.existsSync(path.join(dir, 'package.json')) || JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name !== name) {
      const up = path.dirname(dir);
      if (up === dir) throw new Error(`Cannot find package root for ${name}`);
      dir = up;
    }
    return dir;
  };
  app.use('/vendor/xterm', express.static(pkgDir('@xterm/xterm')));
  app.use('/vendor/xterm-addon-fit', express.static(pkgDir('@xterm/addon-fit')));
  app.use('/vendor/marked', express.static(path.join(pkgDir('marked'), 'lib')));
  app.use('/vendor/dompurify', express.static(path.join(pkgDir('dompurify'), 'dist')));
  app.use('/vendor/mermaid', express.static(path.join(pkgDir('mermaid'), 'dist')));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const api = express.Router();
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  };
  const fail = (status, message) => Object.assign(new Error(message), { status });

  // `closing` while shutting down: it still answers until every agent is closed, then exits.
  api.get('/health', wrap(() => ({ ok: true, pid: process.pid, home: paths.home, claudeBin: config.claudeBin, closing })));
  api.get('/agents', wrap(() => manager.list()));
  api.get('/engines', wrap(() => listEngines(config)));
  api.post(
    '/agents',
    wrap((req) => {
      const { intents, intent, startedBy, ...opts } = req.body ?? {};
      if (opts.kind === 'assistant') throw fail(400, 'Start the assistant with POST /assistant/start');
      const list = (Array.isArray(intents) ? intents : [intent]).map((i) => String(i ?? '').trim()).filter(Boolean);
      // Agents the assistant's own session starts: its limits apply, and they are marked as its.
      const extra = assistant.admit(req.headers['x-agentmgr-agent'], list, opts);
      const created = manager.createMany(list, { ...opts, ...extra });
      if (extra.startedBy) {
        for (const a of created) notifier.send('assistant', a, `was started by the assistant: ${a.intent.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      return created;
    }),
  );
  api.post('/general', wrap((req) => manager.createGeneral(req.body ?? {})));
  api.get('/agents/:id/brief', wrap((req) => manager.briefFile(req.params.id)));
  // ?background=1 starts the work and returns at once (watch the agent's events for the result).
  const bg = (req) => req.query.background === '1' || req.body?.background === true;
  api.post('/agents/:id/explain', wrap((req) => (bg(req) ? manager.summarizeInBackground(req.params.id, ['explain']) : manager.explain(req.params.id))));
  api.post('/agents/:id/insights', wrap((req) => (bg(req) ? manager.summarizeInBackground(req.params.id, ['insights']) : manager.insights(req.params.id))));
  const DOC_LIST = ['analysis', 'design', 'flow', 'proposal', 'humanai'];
  api.post('/agents/:id/humanai/answers', wrap((req) => manager.humanAiAnswers(req.params.id, req.body?.answers, { send: req.body?.send === true })));
  api.post(
    '/agents/:id/docs/:kind',
    wrap((req) => {
      const kinds = req.params.kind === 'all' ? DOC_LIST : [req.params.kind];
      if (bg(req) || kinds.length > 1) return manager.summarizeInBackground(req.params.id, kinds);
      return manager.document(req.params.id, req.params.kind);
    }),
  );
  api.post('/agents/:id/plan', wrap((req) => manager.startPlanning(req.params.id)));
  api.post('/agents/:id/plan/approve', wrap((req) => manager.approvePlan(req.params.id, req.body?.note)));
  api.post('/agents/:id/plan/changes', wrap((req) => manager.requestPlanChanges(req.params.id, req.body?.note)));
  api.post('/agents/:id/plan/review', wrap((req) => manager.setPlanReview(req.params.id, req.body?.on === true)));
  api.post('/agents/:id/handoff', wrap((req) => manager.maybeHandoff(manager.mustGet(req.params.id).id, { force: true })));
  // ---------------------------------------------------------- studio: files and editor
  api.get('/agents/:id/files', wrap((req) => studio.list(req.params.id, req.query.dir ?? '')));
  api.post('/agents/:id/files', wrap((req) => studio.create(req.params.id, req.body?.path, req.body?.type)));
  api.post('/agents/:id/files/rename', wrap((req) => studio.rename(req.params.id, req.body?.from, req.body?.to)));
  api.get('/agents/:id/file', wrap((req) => studio.read(req.params.id, req.query.path)));
  api.put('/agents/:id/file', wrap((req) => studio.write(req.params.id, req.body?.path, req.body?.content, { mtimeMs: req.body?.mtimeMs ?? null, force: Boolean(req.body?.force) })));
  api.delete('/agents/:id/file', wrap((req) => studio.remove(req.params.id, req.query.path)));
  api.get('/agents/:id/file/original', wrap((req) => studio.original(req.params.id, req.query.path)));
  api.get('/agents/:id/search', wrap((req) => studio.search(req.params.id, req.query.q)));
  // Opening VS Code or Cursor happens on this computer, so only from it.
  api.get('/editors', wrap(() => studio.editors()));
  api.post('/agents/:id/open-in', wrap((req) => studio.openIn(req.params.id, req.body?.editor, req.body?.path ?? null)));
  // The machine terminal: shells in the home folder, not tied to an agent (Open Terminal).
  api.get('/machine/shells', wrap(() => ({ shells: manager.shellNumbers(MACHINE), home: os.homedir() })));
  api.post('/machine/shell/new', wrap(() => ({ n: manager.nextShellNumber(MACHINE) })));
  api.post('/machine/shell/close', wrap((req) => manager.closeShell(MACHINE, req.body?.n ? Number(req.body.n) : undefined)));
  api.post('/machine/shell/drop', wrap((req) => manager.dropShell(MACHINE, Number(req.body?.n) || 1)));
  api.post('/agents/:id/shell/close', wrap((req) => manager.closeShell(req.params.id, req.body?.n ? Number(req.body.n) : undefined)));
  api.post('/agents/:id/shell/new', wrap((req) => ({ n: manager.nextShellNumber(manager.mustGet(req.params.id).id) })));
  api.post('/agents/:id/shell/drop', wrap((req) => manager.dropShell(req.params.id, Number(req.body?.n) || 1)));
  // Raw file body; the name comes in the query. Returns the saved path to paste into a terminal.
  api.post(
    '/agents/:id/upload',
    express.raw({ type: () => true, limit: '50mb' }),
    wrap((req) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw fail(400, 'Empty file');
      return manager.saveUpload(req.params.id, req.query.name, req.body);
    }),
  );
  api.get(
    '/agents/:id',
    wrap((req) => {
      const agent = manager.get(req.params.id);
      if (!agent) throw fail(404, `No agent matches "${req.params.id}"`);
      return agent;
    }),
  );
  api.patch('/agents/:id', wrap((req) => manager.update(req.params.id, req.body ?? {})));
  api.post('/agents/:id/browsers', wrap((req) => manager.addBrowser(req.params.id, req.body?.url, { mode: req.body?.mode })));
  api.patch(
    '/agents/:id/browsers/:n',
    wrap(async (req) => {
      const n = Number(req.params.n);
      const tab = manager.setBrowser(req.params.id, n, req.body?.url, { mode: req.body?.mode });
      // A live tab that is open goes there now; one that isn't opens there next time.
      if (req.body?.url !== undefined && live.tabs.has(live.key(req.params.id, n))) await live.navigate(req.params.id, n, tab.url).catch(() => {});
      return tab;
    }),
  );
  api.delete(
    '/agents/:id/browsers/:n',
    wrap(async (req) => {
      await live.close(req.params.id, Number(req.params.n));
      return manager.dropBrowser(req.params.id, Number(req.params.n));
    }),
  );

  // Live browser tabs: a real browser on this machine, streamed (see livebrowser.js).
  api.get('/browser', wrap(() => live.status()));
  const liveArgs = (req) => {
    const agent = manager.mustGet(req.params.id);
    const n = Number(req.params.n);
    if (!(agent.browsers ?? []).some((t) => t.n === n)) throw fail(404, `No browser tab ${n}`);
    return [agent.id, n];
  };
  api.post('/agents/:id/browsers/:n/live/input', wrap(async (req) => ({ ok: true, ...(await live.input(...liveArgs(req), req.body?.events)) })));
  api.post('/agents/:id/browsers/:n/live/resize', wrap(async (req) => (await live.resize(...liveArgs(req), req.body ?? {}), { ok: true })));
  api.post('/agents/:id/browsers/:n/live/go', wrap(async (req) => (await live.go(...liveArgs(req), String(req.body?.where ?? '')), { ok: true })));
  api.get('/agents/:id/browsers/:n/live/selection', wrap((req) => live.selection(...liveArgs(req))));
  api.get('/agents/:id/browsers/:n/live/stream', async (req, res) => {
    let args;
    try {
      args = liveArgs(req);
    } catch (err) {
      return res.status(err.status ?? 400).json({ error: err.message });
    }
    const tab = manager.mustGet(args[0]).browsers.find((t) => t.n === args[1]);
    const write = sse(req, res);
    // Frames are big: while the connection is backed up, keep only the newest and send it after.
    let held = null;
    res.on('drain', () => {
      if (held) write(held);
      held = null;
    });
    const client = {
      audio: req.query.audio === '1', // this viewer wants the page's sound
      send: (msg) => {
        if (msg.t === 'frame' && res.writableNeedDrain) held = msg;
        else write(msg);
      },
    };
    let detach = null;
    req.on('close', () => detach?.());
    try {
      const q = req.query;
      detach = await live.view(args[0], args[1], tab.url, client, q.width ? { width: q.width, height: q.height, mobile: q.mobile, scale: q.scale } : undefined);
      if (req.destroyed) detach();
    } catch (err) {
      write({ t: 'error', error: err.message });
      res.end();
    }
  });
  // Claude Code sessions started in a terminal, continued here.
  api.get('/sessions/scan', wrap((req) => manager.scanSessions({ days: req.query.days })));
  api.post('/sessions/import', wrap((req) => manager.importSessions(req.body?.sessions, { start: req.body?.start !== false, copy: Boolean(req.body?.copy) })));
  api.get('/agents/:id/local-urls', wrap((req) => manager.localUrls(req.params.id)));
  // A CLI's sign-in link: opened in a real browser window; its callback finished on this machine.
  api.post('/agents/:id/signin', wrap((req) => manager.addSignIn(req.params.id, req.body?.url)));
  api.post('/agents/:id/signin/finish', wrap((req) => manager.finishSignIn(req.params.id, req.body?.url)));
  api.post('/agents/:id/signin/dismiss', wrap((req) => manager.dismissSignIn(req.params.id)));
  // Where a browser tab loads an address: directly on this computer, through a relay from another device.
  api.post(
    '/preview',
    wrap(async (req) => {
      if (!req.remote) return { src: parseUrl(req.body?.url).href };
      return { src: await previews.frameUrl(req.body?.url, req.headers.host) };
    }),
  );

  api.delete(
    '/agents/:id',
    wrap((req) => manager.remove(req.params.id, { deleteWorkspace: req.query.deleteWorkspace === '1' })),
  );
  api.post('/agents/:id/start', wrap((req) => manager.start(req.params.id, req.body ?? {})));
  api.post('/agents/:id/stop', wrap((req) => manager.stop(req.params.id)));
  api.post('/agents/:id/refresh', wrap((req) => manager.refresh(req.params.id, { withPrs: true })));
  api.post('/agents/:id/links', wrap((req) => manager.addLink(req.params.id, req.body ?? {})));
  api.delete('/agents/:id/links', wrap((req) => manager.removeLink(req.params.id, req.query)));
  api.post('/flush', wrap(() => manager.flush()));

  // ---------------------------------------------------------- Slack alerts (local only)
  const okUrl = (u) => /^https:\/\/[\w.-]+\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u);
  api.get('/notify', wrap(() => ({ ...publicNotify(), workflow: isWorkflowUrl(loadNotify().slack.webhookUrl), recent: notifier.log, judge: judgeAlerts() })));
  const judgeAlerts = () => (manager.judge.enabled ? { digestMin: manager.judge.settings.digestMin, pending: notifier.digest.length } : null);
  api.post(
    '/notify',
    wrap((req) => {
      const b = req.body ?? {};
      const slack = {};
      if (b.webhookUrl !== undefined) {
        if (b.webhookUrl && !okUrl(b.webhookUrl)) throw fail(400, 'The webhook URL must be https://…');
        slack.webhookUrl = b.webhookUrl || null;
      }
      if (b.botToken !== undefined) slack.botToken = b.botToken || null;
      if (b.channel !== undefined) slack.channel = b.channel || null;
      const patch = { slack };
      for (const k of ['enabled', 'skipWhenWatching', 'includeIntent']) if (typeof b[k] === 'boolean') patch[k] = b[k];
      for (const k of ['needsInputDelaySec', 'waitingDelaySec']) if (Number(b[k]) >= 0) patch[k] = Number(b[k]);
      if (b.events && typeof b.events === 'object') patch.events = b.events;
      const next = saveNotify(patch);
      // Configuring Slack for the first time turns alerts on.
      if (b.enabled === undefined && (slack.webhookUrl || (slack.botToken && (b.channel ?? next.slack.channel)))) saveNotify({ enabled: true });
      return { ...publicNotify(), recent: notifier.log };
    }),
  );
  api.post(
    '/notify/test',
    wrap(async () => {
      await sendSlack(':wave: Test from AI Agent Manager: alerts will arrive here when an agent needs you.', loadNotify());
      return { ok: true };
    }),
  );

  // ---------------------------------------------------------- project shortcuts
  api.get('/projects', wrap(() => manager.listProjects()));
  api.post('/projects', wrap((req) => manager.addProject(req.body ?? {})));
  api.patch('/projects/:ref', wrap((req) => manager.updateProject(req.params.ref, req.body ?? {})));
  api.delete('/projects/:ref', wrap((req) => manager.removeProject(req.params.ref)));

  // ---------------------------------------------------------- backlog
  api.get('/backlog', wrap(() => backlog.view()));
  api.post(
    '/backlog',
    wrap((req) => {
      const { items, item, ...opts } = req.body ?? {};
      return backlog.add(Array.isArray(items) ? items : [item], opts);
    }),
  );
  // Everything waiting on the user: live prompts, agents' questions, stuck agents, overlaps.
  api.get('/inbox', wrap(() => manager.inbox()));
  api.post('/agents/:id/tell', wrap((req) => manager.tell(req.params.id, req.body?.text)));
  api.post('/agents/:id/answer', wrap((req) => manager.answerQuestion(req.params.id, req.body?.question, req.body?.text)));
  api.post('/agents/:id/prompt-key', wrap((req) => manager.answerPrompt(req.params.id, String(req.body?.key ?? ''))));
  api.post('/agents/:id/stuck/dismiss', wrap((req) => manager.dismissStuck(req.params.id, req.body?.key)));
  api.post('/agents/:id/stuck/nudge', wrap((req) => manager.nudge(req.params.id, req.body?.key, req.body?.text)));
  // The AI judge: what it read on an idle screen, and its review of finished work.
  api.post('/agents/:id/conflicts/dismiss', wrap((req) => manager.dismissConflict(req.params.id, req.body?.with)));
  api.post('/agents/:id/waiting/answer', wrap((req) => manager.answerWaiting(req.params.id, req.body?.text)));
  api.post('/agents/:id/waiting/dismiss', wrap((req) => manager.dismissWaiting(req.params.id)));
  api.post('/agents/:id/review', wrap((req) => manager.requestReview(req.params.id, { force: true })));
  api.post('/agents/:id/review/ack', wrap((req) => manager.ackReview(req.params.id, req.body?.action)));
  api.get('/about', wrap(() => about({ port, config: { home: paths.home, claudeBin: config.claudeBin } })));
  api.get('/about/latest', wrap(() => latestRelease()));
  api.get('/me', wrap(async (req) => ({ ...(await identity()), remote: Boolean(req.remote) })));
  // Updating runs npm or git here and restarts the daemon, so only from this computer.
  api.get('/update', wrap(() => updates.status()));
  api.post('/update/check', wrap(async () => (await updates.refresh(), updates.status())));
  api.post('/update', wrap(() => updates.apply()));
  api.put(
    '/update',
    wrap((req) => {
      saveConfig({ updates: updates.setCheck(req.body?.check !== false) });
      return updates.status();
    }),
  );
  api.get('/judge', wrap(() => manager.judge.status()));
  // On or off for this daemon, kept in config.json. The judge spends calls on your own engine plan.
  api.put('/judge', wrap((req) => {
    const enabled = Boolean(req.body?.enabled);
    manager.config.judge = { ...manager.config.judge, enabled };
    saveConfig({ judge: { enabled } });
    return manager.judge.status();
  }));
  api.post('/agents/:id/conflicts/warn', wrap((req) => manager.warnConflict(req.params.id, req.body?.with)));
  api.post('/agents/:id/checkpoint', wrap(async (req) => {
    const id = manager.mustGet(req.params.id).id;
    manager.lastCheckpointTry?.delete(id); // on demand: skip the throttle
    await manager.checkpoint(id);
    return manager.get(id);
  }));
  api.get('/agents/:id/changes', wrap((req) => review.get(req.params.id)));
  api.post('/agents/:id/changes/comments', wrap((req) => review.comment(req.params.id, req.body ?? {})));
  api.post('/agents/:id/changes/commit', wrap((req) => review.commit(req.params.id, req.body ?? {})));
  api.post('/agents/:id/changes/pr', wrap((req) => review.pr(req.params.id, req.body ?? {})));
  api.post('/agents/:id/fork', wrap((req) => manager.fork(req.params.id, req.body ?? {})));

  api.get('/races', wrap(() => races.list()));
  api.post('/races', wrap((req) => races.create(req.body ?? {})));
  api.get('/races/:id', wrap((req) => races.view(req.params.id)));
  api.post('/races/:id/tests', wrap((req) => races.runTests(req.params.id, req.body ?? {})));
  api.get('/races/:id/diff/:agent', wrap((req) => races.diff(req.params.id, req.params.agent)));
  api.post('/races/:id/pick', wrap((req) => races.pick(req.params.id, req.body?.agent, { cleanup: Boolean(req.body?.cleanup) })));
  api.delete('/races/:id', wrap((req) => races.remove(req.params.id)));

  // Clean up old agents: the strategy and days (kept in config.json), what a run would do, run now.
  api.get('/assistant', wrap(() => assistant.status()));
  api.put('/assistant', wrap((req) => {
    const next = assistant.update(req.body ?? {});
    saveConfig({ assistant: next });
    return assistant.status();
  }));
  api.post('/assistant/start', wrap(() => assistant.start()));
  api.post('/assistant/pause', wrap(() => assistant.pause()));
  api.post('/assistant/check', wrap(() => assistant.check()));
  api.get('/triggers', wrap(() => triggers.view()));
  api.put('/triggers', wrap((req) => {
    const { saved, token } = triggers.update(req.body ?? {});
    saveConfig({ triggers: saved });
    return { ...triggers.view(), ...(token ? { token } : {}) };
  }));
  api.post('/triggers/poll', wrap(async () => ({ ...(await triggers.poll()), ...triggers.view() })));
  api.post('/hooks/agents', wrap((req) => triggers.hook(req.body ?? {})));
  api.get('/agents/:id/memory', wrap((req) => memory.read(req.params.id)));
  api.put('/agents/:id/memory', wrap((req) => memory.write(req.params.id, req.body?.text)));
  api.post('/agents/:id/learn', wrap((req) => memory.learn(req.params.id, req.body?.text, { by: req.headers['x-agentmgr-agent'] ? undefined : 'you' })));
  // The first-run checklist: what is set up, and what this machine is missing.
  api.get('/setup', wrap(async () => {
    const checks = (await doctor().catch(() => [])).filter((c) => c.status === 'fail' || c.status === 'warn').filter((c) => c.name !== 'Daemon');
    const agentsNow = store.list();
    return {
      checks,
      steps: {
        agent: agentsNow.some((a) => !NO_REPO_KINDS.has(a.kind)),
        alerts: Boolean(loadNotify().enabled),
        assistant: agentsNow.some((a) => a.kind === 'assistant') || Boolean(config.triggers?.github?.enabled || config.triggers?.webhook?.enabled),
        remote: Boolean(remote.loadSettings().enabled),
        budget: Boolean(config.budgets?.perAgentUsd || config.budgets?.perDayUsd),
      },
    };
  }));
  api.get('/playbooks', wrap(() => playbooks.list()));
  api.post('/playbooks', wrap((req) => playbooks.create(req.body ?? {})));
  api.put('/playbooks/:id', wrap((req) => playbooks.update(req.params.id, req.body ?? {})));
  api.delete('/playbooks/:id', wrap((req) => playbooks.remove(req.params.id)));
  api.post('/playbooks/:id/run', wrap((req) => playbooks.run(req.params.id, { vars: req.body?.vars ?? {} })));
  api.get('/stats', wrap((req) => {
    const days = req.query.days === undefined ? 30 : Math.max(0, Math.min(3650, Math.floor(Number(req.query.days)) || 0));
    return stats(store.list(), { days, projectOf: (a) => manager.projectInfo(a)?.name ?? null });
  }));
  api.get('/budgets', wrap(() => budgets.status()));
  api.put('/budgets', wrap((req) => {
    const next = budgets.update(req.body ?? {});
    saveConfig({ budgets: next });
    return budgets.status();
  }));
  api.get('/landing', wrap(() => landing.list()));
  api.put('/landing', wrap((req) => {
    const next = landing.update(req.body ?? {});
    saveConfig({ landing: next });
    return landing.list();
  }));
  api.post('/agents/:id/land/update', wrap((req) => landing.updateBranch(req.params.id, req.body ?? {})));
  api.post('/agents/:id/land/fix', wrap((req) => landing.fix(req.params.id, req.body ?? {})));
  api.post('/agents/:id/land/merge', wrap((req) => landing.merge(req.params.id, req.body ?? {})));
  api.get('/cleanup', wrap(() => cleanup.status()));
  api.put('/cleanup', wrap(async (req) => {
    const next = cleanup.update(req.body ?? {});
    saveConfig({ cleanup: next });
    return cleanup.status();
  }));
  api.post('/cleanup/run', wrap(async (req) => {
    const b = req.body ?? {};
    return cleanup.run({ close: b.close !== false, delete: b.delete !== false, ids: Array.isArray(b.ids) ? b.ids : null });
  }));
  api.get('/teams', wrap(() => teams.list()));
  api.post('/teams', wrap((req) => teams.create(req.body ?? {})));
  api.get('/teams/:id', wrap((req) => teams.view(req.params.id)));
  api.get('/teams/:id/files/:name', wrap((req) => teams.file(req.params.id, req.params.name)));
  api.post('/teams/:id/resume', wrap((req) => teams.resume(req.params.id, req.body ?? {})));
  api.post('/teams/:id/send-back', wrap((req) => teams.sendBack(req.params.id, req.body?.note)));
  api.post('/teams/:id/fix-gaps', wrap((req) => teams.fixGaps(req.params.id, req.body?.note)));
  api.post('/teams/:id/finalize', wrap((req) => teams.finalize(req.params.id, { mode: req.body?.mode, pr: req.body?.pr })));
  api.post('/teams/:id/stop', wrap((req) => teams.stop(req.params.id)));
  api.post('/teams/:id/ask', wrap((req) => teams.ask(req.params.id, req.body?.text)));
  api.delete('/teams/:id', wrap((req) => teams.remove(req.params.id, { agents: req.query.agents === '1' })));

  api.post('/backlog/settings', wrap((req) => backlog.settings(req.body ?? {})));
  api.patch('/backlog/:id', wrap((req) => backlog.update(req.params.id, req.body ?? {})));
  api.delete('/backlog/:id', wrap((req) => backlog.remove(req.params.id)));
  api.post('/backlog/:id/start', wrap((req) => backlog.start(req.params.id)));
  api.post('/backlog/:id/accept', wrap((req) => backlog.accept(req.params.id)));
  api.post('/backlog/:id/reopen', wrap((req) => backlog.reopen(req.params.id, req.body ?? {})));
  api.post('/backlog/:id/cancel', wrap((req) => backlog.cancel(req.params.id)));
  api.post('/backlog/:id/move', wrap((req) => backlog.move(req.params.id, req.body?.where)));
  api.post('/backlog/:id/split', wrap((req) => backlog.split(req.params.id, req.body?.parts)));
  api.post('/backlog/:id/keep-whole', wrap((req) => backlog.keepWhole(req.params.id)));
  api.post(
    '/shutdown',
    wrap(() => {
      setTimeout(() => shutdown('api'), 50);
      return { ok: true };
    }),
  );

  // ---------------------------------------------------------- hub link (local only)
  api.get('/hub', wrap(() => hubLink.status()));
  api.post('/hub/join', wrap((req) => hubLink.join(req.body?.url, req.body?.code, req.body?.name)));
  api.post('/hub/leave', wrap(() => hubLink.leave()));

  // ---------------------------------------------------------- sessions (remote sign-in)

  api.get('/session', wrap((req) => ({ remote: Boolean(req.remote), authenticated: !req.remote || Boolean(
    remote.checkSession(remote.parseCookies(req.headers.cookie)[remote.SESSION_COOKIE]),
  ) })));
  api.post(
    '/login',
    wrap((req, res) => {
      if (!req.remote) return { ok: true };
      const ip = req.socket.remoteAddress;
      if (!remote.loginAllowed(ip)) throw fail(429, 'Too many attempts; try again in 15 minutes');
      const ticket = req.body?.ticket !== undefined;
      if (ticket ? !remote.useTicket(req.body.ticket) : !remote.checkToken(req.body?.token)) {
        remote.loginFailed(ip);
        throw fail(401, ticket ? 'That sign-in link was used or has expired; open it from the hub again' : 'Wrong or expired access token');
      }
      const { secret, maxAgeSec } = remote.createSession({ ua: req.headers['user-agent'], ip, via: ticket ? 'hub' : undefined });
      res.setHeader(
        'Set-Cookie',
        `${remote.SESSION_COOKIE}=${secret}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Strict`,
      );
      return { ok: true };
    }),
  );
  api.post(
    '/logout',
    wrap((req, res) => {
      remote.endSession(remote.parseCookies(req.headers.cookie)[remote.SESSION_COOKIE]);
      res.setHeader('Set-Cookie', `${remote.SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
      return { ok: true };
    }),
  );

  // ---------------------------------------------------------- remote access management (local only)

  const remoteStatus = async () => {
    const settings = remote.loadSettings();
    const urls = remote.remoteUrls(settings.port);
    return {
      ...settings,
      running: Boolean(remoteServer),
      fingerprint: remote.certificateFingerprint(),
      hostname: remote.localHostname(),
      urls: await Promise.all(
        urls.map(async (u) => ({ ...u, loginUrl: remote.loginLink(u.url), qr: await remote.qrSvg(remote.loginLink(u.url)) })),
      ),
      devices: remote.listSessions(),
    };
  };
  api.get('/remote', wrap(remoteStatus));
  api.post(
    '/remote/enable',
    wrap(async (req) => {
      const p = Number(req.body?.port) || remote.loadSettings().port;
      remote.saveSettings({ enabled: true, port: p });
      await startRemote();
      return remoteStatus();
    }),
  );
  api.post(
    '/remote/disable',
    wrap(async () => {
      remote.saveSettings({ enabled: false });
      await stopRemote();
      return remoteStatus();
    }),
  );
  api.post(
    '/remote/rotate',
    wrap(() => {
      remote.rotateToken();
      return remoteStatus();
    }),
  );
  api.delete(
    '/remote/devices/:id',
    wrap((req) => {
      remote.revokeSession(req.params.id);
      return remoteStatus();
    }),
  );

  // ---------------------------------------------------------- streaming over plain HTTP (SSE)
  // iOS Safari applies an accepted self-signed certificate to pages and fetches but not to
  // WebSockets, so the phone UI streams with Server-Sent Events and sends input with POSTs.

  const sse = (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => clearInterval(ping));
    return (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
  };

  const eventSinks = new Set();
  api.get('/events/stream', (req, res) => {
    const send = sse(req, res);
    send({ t: 'snapshot', agents: manager.list(), backlog: backlog.view(), projects: manager.listProjects(), races: races.list(), teams: teams.list() });
    eventSinks.add(send);
    req.on('close', () => eventSinks.delete(send));
  });

  const termKind = (q) => (shellNumber(q) ? `shell:${shellNumber(q)}` : 'claude');
  // The machine terminal (Open Terminal) has no agent: its shells live under MACHINE.
  const termAgent = (id) => (id === MACHINE ? { id: MACHINE } : manager.mustGet(id));
  const attachTerm = (id, kind, client) =>
    shellNumber(kind) ? manager.attachShell(id, client, shellNumber(kind)) : manager.attach(id, client);
  api.get('/agents/:id/term/stream', (req, res) => {
    let agent;
    const kind = termKind(req.query.kind);
    try {
      agent = termAgent(req.params.id);
      if (agent.id === MACHINE) manager.plugins.check('terminal.open', { agent: null, kind: 'machine' });
      else manager.plugins.check('terminal.open', { agent: manager.auditView(agent), kind });
    } catch (err) {
      return res.status(err.status || 404).json({ error: err.message });
    }
    const send = sse(req, res);
    // Batch output so a busy terminal is a few events per second, not one per chunk.
    let pending = '';
    let timer = null;
    const flush = () => {
      timer = null;
      if (pending) send({ t: 'o', d: pending });
      pending = '';
    };
    const client = {
      send: (msg) => {
        if (msg.t === 'o') {
          pending += msg.d;
          timer ??= setTimeout(flush, 30);
        } else {
          flush();
          send(msg);
        }
      },
      close: () => res.end(),
    };
    let session;
    try {
      session = attachTerm(agent.id, kind, client);
    } catch (err) {
      send({ t: 'error', error: err.message });
      return res.end();
    }
    send({ t: 'hello', id: agent.id, kind, running: session.running, backlog: session.backlog });
    req.on('close', () => {
      clearTimeout(timer);
      session.detach();
    });
  });
  api.post(
    '/agents/:id/term/input',
    wrap((req) => {
      const agent = termAgent(req.params.id);
      if (typeof req.body?.d !== 'string') throw fail(400, 'd (string) is required');
      manager.write(agent.id, req.body.d, termKind(req.body.kind));
      return { ok: true };
    }),
  );
  api.post(
    '/agents/:id/term/resize',
    wrap((req) => {
      const agent = termAgent(req.params.id);
      manager.resize(agent.id, req.body?.cols | 0, req.body?.rows | 0, termKind(req.body?.kind));
      return { ok: true };
    }),
  );
  plugins.mount(api, express); // /api/ext/<plugin>, behind the same checks
  app.use('/api', api);

  // ---------------------------------------------------------- WebSockets (local UI and CLI)

  const wss = new WebSocketServer({ noServer: true });
  const onUpgrade = (isRemote) => (req, socket, head) => {
    req.remote = isRemote;
    if (denied(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };

  const eventClients = new Set();
  const broadcast = (msg) => {
    const raw = JSON.stringify(msg);
    for (const ws of eventClients) ws.send(raw);
    for (const send of eventSinks) send(msg);
  };
  manager.on('change', (agent) => broadcast({ t: 'agent', agent }));
  manager.on('removed', (id) => {
    broadcast({ t: 'removed', id });
    live.closeAgent(id).catch(() => {});
  });
  backlog.on('change', (view) => broadcast({ t: 'backlog', backlog: view }));
  const raceTimers = new Map();
  races.on('change', (id) => {
    if (raceTimers.has(id)) return;
    raceTimers.set(id, setTimeout(() => {
      raceTimers.delete(id);
      try {
        broadcast({ t: 'race', race: races.view(id) });
      } catch {}
    }, 300));
  });
  races.on('removed', (id) => broadcast({ t: 'race-removed', id }));
  const teamTimers = new Map();
  teams.on('change', (id) => {
    if (teamTimers.has(id)) return;
    teamTimers.set(id, setTimeout(() => {
      teamTimers.delete(id);
      try {
        broadcast({ t: 'team', team: teams.view(id) });
      } catch {}
    }, 300));
  });
  teams.on('removed', (id) => broadcast({ t: 'team-removed', id }));
  manager.on('projects', (projects) => {
    broadcast({ t: 'projects', projects });
    broadcast({ t: 'backlog', backlog: backlog.view() });
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/ws/events') {
      eventClients.add(ws);
      ws.send(JSON.stringify({ t: 'snapshot', agents: manager.list(), backlog: backlog.view(), projects: manager.listProjects(), races: races.list(), teams: teams.list() }));
      ws.on('close', () => eventClients.delete(ws));
      return;
    }

    const m = url.pathname.match(/^\/ws\/term\/([\w-]+)$/);
    if (!m) return ws.close(1008, 'unknown endpoint');
    let session;
    try {
      // The machine terminal has no agent; its shells live under MACHINE.
      const agent = m[1] === MACHINE ? { id: MACHINE } : manager.mustGet(m[1]);
      const client = {
        send: (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)),
        close: () => ws.close(1000, 'agent removed'),
      };
      const kind = agent.id === MACHINE ? `shell:${shellNumber(url.searchParams.get('kind')) || 1}` : termKind(url.searchParams.get('kind'));
      session = attachTerm(agent.id, kind, client);
      client.send({ t: 'hello', id: agent.id, kind, running: session.running, backlog: session.backlog });
      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.t === 'i' && typeof msg.d === 'string') manager.write(agent.id, msg.d, kind);
        else if (msg.t === 'r') manager.resize(agent.id, msg.cols | 0, msg.rows | 0, kind);
      });
      ws.on('close', () => session.detach());
    } catch (err) {
      ws.close(1008, err.message.slice(0, 120));
    }
  });

  // ---------------------------------------------------------- listeners

  const server = http.createServer(app);
  // Outlive clients' idle keep-alive sockets (Node fetch keeps them ~4s+): with the 5s
  // default, a request sent on a socket just as the server closes it fails with ECONNRESET.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.on('upgrade', onUpgrade(false));

  async function startRemote() {
    const settings = remote.loadSettings();
    if (remoteServer && remotePort === settings.port) return;
    await stopRemote();
    const { key, cert } = await remote.ensureCertificate();
    remote.accessToken(); // make sure one exists
    const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
      req.remote = true;
      app(req, res);
    });
    srv.keepAliveTimeout = 65_000;
    srv.headersTimeout = 66_000;
    srv.on('upgrade', onUpgrade(true));
    await new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(settings.port, '0.0.0.0', resolve);
    });
    remoteServer = srv;
    remotePort = settings.port;
    console.log(`[agentmgr] remote access on ${remote.remoteUrls(settings.port).map((u) => u.url).join(', ')}`);
  }

  async function stopRemote() {
    if (!remoteServer) return;
    const srv = remoteServer;
    remoteServer = null;
    remotePort = null;
    await previews.stopAll();
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(() => r()));
  }

  let closing = false;
  async function shutdown(reason) {
    if (closing) return;
    closing = true;
    cleanup.close();
    landing.close();
    triggers.close();
    budgets.close();
    playbooks.close();
    updates.close();
    assistant.close();
    console.log(`[agentmgr] shutting down (${reason}); closing agents so their sessions are saved`);
    await manager.stopAll({ final: true });
    await manager.flush().catch((err) => console.error(`[agentmgr] final flush failed: ${err.message}`));
    try {
      if (fs.readFileSync(paths.pid, 'utf8').trim() === String(process.pid)) fs.unlinkSync(paths.pid);
    } catch {}
    await stopRemote();
    live.stop();
    hubLink.stop();
    server.close();
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  fs.writeFileSync(paths.pid, String(process.pid));
  if (remote.loadSettings().enabled) {
    await startRemote().catch((err) => console.error(`[agentmgr] remote access not started: ${err.message}`));
  }
  if (config.autoResume) {
    manager.resumeAll().then((ids) => {
      if (ids.length) console.log(`[agentmgr] resumed ${ids.length} agent(s) from before the restart: ${ids.join(', ')}`);
    });
  }
  manager.refreshAll().catch(() => {});
  hubLink.start();
  return {
    hubLink,
    server,
    manager,
    teams,
    cleanup,
    landing,
    triggers,
    budgets,
    playbooks,
    assistant,
    backlog,
    live,
    url: `http://${host}:${port}`,
    startRemote,
    stopRemote,
    get remoteServer() {
      return remoteServer;
    },
  };
}
