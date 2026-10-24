// Live browser tabs: a real Chrome on this machine, streamed into the Browser tab.
//   Chrome runs headless with its own profile (~/.agentmanager/browser-profile), so sign-ins are
//   remembered. Each browser tab is one Chrome page; its screen is streamed as JPEG frames
//   (Page.startScreencast) to the people viewing it, and their mouse, keys and text are replayed
//   into it. Because the page runs here, `localhost` means this machine and a CLI's sign-in
//   callback (http://127.0.0.1:PORT/...) reaches the CLI waiting here, from any device.
//   Popups (window.open, target=_blank) open as new tabs of the same agent.
//   Chrome starts on the first view and stops after a while with nobody watching.
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { paths } from './config.js';

const IDLE_MS = 15 * 60_000;
const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
};

/** The Chrome-family browser to run: config `browserBin`, else the first one installed. */
export function findBrowser(config = {}) {
  if (config.browserBin) return fs.existsSync(config.browserBin) ? config.browserBin : null;
  return (CANDIDATES[process.platform] ?? []).find((p) => fs.existsSync(p)) ?? null;
}

/** Minimal Chrome DevTools Protocol client over one WebSocket (flattened sessions). */
class Cdp extends EventEmitter {
  constructor(url) {
    super();
    this.ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      } else this.emit('event', msg);
    });
    this.ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('browser closed'));
      this.pending.clear();
      this.emit('close');
    });
  }

  send(method, params = {}, sessionId) {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('browser closed'));
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    this.ws.close();
  }
}

// Sound: in each page and frame (in a world of our own the page can't see), the sound of
// any <video> or <audio> that plays is routed into a silent graph and sent here as 16-bit PCM,
// 24 kHz stereo, about 170 ms at a time. Chrome itself stays muted. Media loaded from another
// site without CORS can't be read this way and stays silent.
export const AUDIO_RATE = 24000;
const AUDIO_WORLD = 'agentmgr-audio';
const AUDIO_BINDING = '__agentmgrAudio';
const AUDIO_SCRIPT = `(() => {
  if (globalThis.__agentmgrHooked) return;
  globalThis.__agentmgrHooked = true;
  let ctx, node;
  const ensure = () => {
    if (ctx) return true;
    try {
      ctx = new AudioContext({ sampleRate: ${AUDIO_RATE} });
      node = ctx.createScriptProcessor(4096, 2, 2);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      node.connect(sink);
      sink.connect(ctx.destination);
      node.onaudioprocess = (e) => {
        const l = e.inputBuffer.getChannelData(0);
        const r = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : l;
        let sound = false;
        for (let i = 0; i < l.length; i += 32) if (l[i] || r[i]) { sound = true; break; }
        if (!sound) return;
        const pcm = new Int16Array(l.length * 2);
        for (let i = 0; i < l.length; i++) {
          pcm[2 * i] = Math.max(-1, Math.min(1, l[i])) * 32767;
          pcm[2 * i + 1] = Math.max(-1, Math.min(1, r[i])) * 32767;
        }
        const b = new Uint8Array(pcm.buffer);
        let s = '';
        for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
        globalThis.${AUDIO_BINDING}(btoa(s));
      };
      return true;
    } catch { return false; }
  };
  const hook = (el) => {
    if (!(el instanceof HTMLMediaElement) || el.__agentmgrHooked || !ensure()) return;
    try {
      ctx.createMediaElementSource(el).connect(node);
      el.__agentmgrHooked = true;
    } catch {}
    ctx.resume();
  };
  document.addEventListener('play', (e) => hook(e.target), true);
  for (const el of document.querySelectorAll('video, audio')) if (!el.paused) hook(el);
})();`;

// Keys that aren't text: what Chrome needs to act on them.
const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
};

export class LiveBrowser extends EventEmitter {
  /**
   * onNavigate(agentId, n, url): a tab went somewhere (saved as the tab's address).
   * onPopup(agentId, url) => n: a page opened a new window; returns the new tab's number.
   * onClosed(agentId, n): a page closed itself (e.g. a sign-in popup when it is done).
   */
  constructor({ config, onNavigate, onPopup, onClosed }) {
    super();
    this.config = config;
    this.onNavigate = onNavigate;
    this.onPopup = onPopup;
    this.onClosed = onClosed;
    this.tabs = new Map(); // `${agentId}:${n}` -> tab
    this.byTarget = new Map(); // targetId -> tab
    this.bySession = new Map(); // sessionId -> tab
    this.frameSessions = new Map(); // sessionId of a cross-site frame inside a tab -> tab (for its sound)
    this.starting = null;
    this.idleTimer = setInterval(() => this.reapIdle(), 60_000);
    this.idleTimer.unref();
  }

  available() {
    return Boolean(findBrowser(this.config));
  }

  status() {
    return { available: this.available(), running: Boolean(this.cdp), tabs: this.tabs.size };
  }

  // ------------------------------------------------------------ Chrome itself

  /** A Chrome left from a daemon that crashed still holds the profile: stop it (only that one). */
  clearStale(profile) {
    try {
      const pid = Number(fs.readlinkSync(path.join(profile, 'SingletonLock')).split('-').pop());
      if (!pid) return;
      const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
      if (cmd.includes(`--user-data-dir=${profile}`)) process.kill(pid);
    } catch {}
  }

  start() {
    if (this.cdp) return Promise.resolve(this.cdp);
    if (this.starting) return this.starting;
    const bin = findBrowser(this.config);
    if (!bin) return Promise.reject(Object.assign(new Error('No Chrome, Chromium, Brave or Edge found on this machine (set "browserBin" in config.json)'), { status: 501 }));
    this.starting = new Promise((resolve, reject) => {
      const profile = path.join(paths.home, 'browser-profile');
      fs.mkdirSync(profile, { recursive: true });
      this.clearStale(profile);
      const proc = spawn(
        bin,
        [
          ...(this.config.browserHeadless === false ? ['--window-position=0,0'] : ['--headless=new']),
          '--remote-debugging-port=0',
          '--remote-debugging-address=127.0.0.1',
          `--user-data-dir=${profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-features=Translate,MediaRouter',
          // Without this, navigator.webdriver is true and sites treat every page as a bot.
          '--disable-blink-features=AutomationControlled',
          '--mute-audio',
          // Videos may start without a click; the sound is captured from the page, not played here.
          '--autoplay-policy=no-user-gesture-required',
          '--hide-scrollbars',
          '--window-size=1280,800',
          // Only when asked: in containers and on Linux that blocks user namespaces, Chrome's
          // sandbox can't start. Without it, a page that exploits Chrome runs as you.
          ...(this.config.browserNoSandbox ? ['--no-sandbox'] : []),
          'about:blank',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let err = '';
      let connecting = false;
      const fail = (e) => {
        this.starting = null;
        reject(e);
      };
      const timer = setTimeout(() => {
        proc.kill();
        fail(new Error(`Chrome did not start: ${err.slice(-300)}`));
      }, 20_000);
      proc.stderr.on('data', async (d) => {
        err += d;
        const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
        if (!m || connecting) return;
        connecting = true; // stderr keeps coming; connect once
        clearTimeout(timer);
        try {
          const cdp = new Cdp(m[1]);
          await cdp.ready;
          this.proc = proc;
          this.cdp = cdp;
          cdp.on('event', (msg) => this.onEvent(msg));
          cdp.on('close', () => this.stopped());
          const { userAgent, product } = await cdp.send('Browser.getVersion');
          // Headless Chrome says so in its user agent and its client hints (Sec-CH-UA); sites
          // like Google then treat it as a bot. Present it as the regular browser it is.
          this.userAgent = userAgent.replace('HeadlessChrome', 'Chrome');
          const full = (product.split('/')[1] ?? '0').trim();
          const major = full.split('.')[0];
          const brand = /Brave/.test(bin) ? 'Brave' : /Edge/.test(bin) ? 'Microsoft Edge' : /Chromium/.test(bin) ? 'Chromium' : 'Google Chrome';
          const brands = [{ brand: 'Not)A;Brand', version: '8' }, { brand: 'Chromium', version: major }, ...(brand === 'Chromium' ? [] : [{ brand, version: major }])];
          this.userAgentMetadata = {
            brands,
            fullVersionList: brands.map((b) => ({ ...b, version: b.brand.startsWith('Not') ? '8.0.0.0' : full })),
            fullVersion: full,
            platform: { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] ?? 'Unknown',
            platformVersion: process.platform === 'darwin' ? '15.0.0' : '',
            architecture: process.arch === 'arm64' ? 'arm' : 'x86',
            bitness: '64',
            model: '',
            mobile: false,
          };
          this.downloads = path.join(os.homedir(), 'Downloads', 'agentmanager');
          fs.mkdirSync(this.downloads, { recursive: true });
          await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: this.downloads, eventsEnabled: true }).catch(() => {});
          await cdp.send('Target.setDiscoverTargets', { discover: true });
          this.starting = null;
          resolve(cdp);
        } catch (e) {
          proc.kill();
          fail(e);
        }
      });
      proc.on('exit', () => {
        clearTimeout(timer);
        if (this.cdp) return;
        if (/No usable sandbox/i.test(err)) {
          return fail(
            Object.assign(
              new Error(
                'Chrome cannot start its sandbox on this machine (common in containers and on Ubuntu 23.10+, which restricts user namespaces). Fix the system (see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md), or set "browserNoSandbox": true in config.json if you accept that a malicious page could then run as you.',
              ),
              { status: 501 },
            ),
          );
        }
        fail(new Error(`Chrome exited: ${err.slice(-300)}`));
      });
    });
    return this.starting;
  }

  stopped() {
    this.cdp = null;
    this.proc = null;
    for (const tab of this.tabs.values()) {
      tab.sessionId = null;
      tab.targetId = null;
      this.push(tab, { t: 'closed' });
    }
    this.byTarget.clear();
    this.bySession.clear();
  }

  stop() {
    this.cdp?.close();
    this.proc?.kill();
    this.stopped();
  }

  /** Nobody watching any tab for a while: let Chrome go (tabs reopen at their address). */
  reapIdle() {
    if (!this.cdp) return;
    const watched = [...this.tabs.values()].some((t) => t.clients.size || Date.now() - t.lastSeen < IDLE_MS);
    if (!watched) {
      this.stop();
      this.tabs.clear();
    }
  }

  // ------------------------------------------------------------------- tabs

  key(agentId, n) {
    return `${agentId}:${n}`;
  }

  /** The tab's Chrome page, created (at `url`) if it isn't open yet. */
  async ensure(agentId, n, url, viewport) {
    const cdp = await this.start();
    const k = this.key(agentId, n);
    let tab = this.tabs.get(k);
    if (tab?.sessionId) return tab;
    tab ??= { agentId, n, url, title: '', clients: new Set(), lastSeen: Date.now(), viewport: this.fit(viewport), frame: null, casting: false };
    this.tabs.set(k, tab);
    if (!tab.targetId) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      tab.targetId = targetId;
    }
    this.byTarget.set(tab.targetId, tab);
    await this.attach(tab);
    if (url && url !== 'about:blank') await cdp.send('Page.navigate', { url }, tab.sessionId).catch(() => {});
    return tab;
  }

  async attach(tab) {
    const cdp = this.cdp;
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
    tab.sessionId = sessionId;
    this.bySession.set(sessionId, tab);
    await Promise.all([
      cdp.send('Page.enable', {}, sessionId),
      cdp.send('Runtime.enable', {}, sessionId),
      cdp.send('Network.setUserAgentOverride', { userAgent: this.userAgent, userAgentMetadata: this.userAgentMetadata }, sessionId),
      this.applyViewport(tab),
      this.hookAudio(sessionId),
      // Frames from other sites run as targets of their own; attach to them for their sound.
      cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId),
    ]).catch(() => {});
    if (tab.clients.size) await this.cast(tab, true);
    await this.refresh(tab);
  }

  /** Current address and title from Chrome (a popup may have moved on before we attached). */
  async refresh(tab) {
    const info = await this.cdp?.send('Target.getTargetInfo', { targetId: tab.targetId }).catch(() => null);
    if (!info) return;
    const { url, title } = info.targetInfo;
    if (title && title !== tab.title) {
      tab.title = title;
      this.push(tab, { t: 'state', url: tab.url, title });
    }
    this.navigated(tab, url);
  }

  async hookAudio(sessionId) {
    await this.cdp.send('Runtime.addBinding', { name: AUDIO_BINDING, executionContextName: AUDIO_WORLD }, sessionId);
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: AUDIO_SCRIPT, worldName: AUDIO_WORLD, runImmediately: true }, sessionId);
  }

  async applyViewport(tab) {
    const { width, height, mobile, scale = 1 } = tab.viewport;
    await this.cdp?.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile }, tab.sessionId);
    if (tab.casting) await this.cast(tab, true);
  }

  async cast(tab, on) {
    if (!this.cdp || !tab.sessionId) return;
    if (tab.casting) await this.cdp.send('Page.stopScreencast', {}, tab.sessionId).catch(() => {});
    tab.casting = false;
    clearTimeout(tab.castRetry);
    if (!on) return;
    const scale = tab.viewport.scale ?? 1;
    try {
      await this.cdp.send(
        'Page.startScreencast',
        { format: 'jpeg', quality: 65, maxWidth: Math.round(tab.viewport.width * scale), maxHeight: Math.round(tab.viewport.height * scale), everyNthFrame: 1 },
        tab.sessionId,
      );
      tab.casting = true;
    } catch {
      // Mid-navigation (Chrome swapping the page's process): try again shortly.
      tab.castRetry = setTimeout(() => tab.clients.size && this.cast(tab, true).catch(() => {}), 300);
    }
  }

  /** Someone opened the tab: stream it to them. Returns detach(). */
  async view(agentId, n, url, client, viewport) {
    const tab = await this.ensure(agentId, n, url, viewport);
    if (viewport) await this.resize(agentId, n, viewport).catch(() => {});
    tab.clients.add(client);
    tab.lastSeen = Date.now();
    client.send({ t: 'state', url: tab.url, title: tab.title, viewport: tab.viewport });
    if (tab.frame) client.send(tab.frame);
    // Restart the stream so the newcomer gets a fresh frame (Chrome only sends on changes).
    await this.cast(tab, true).catch(() => {});
    return () => {
      tab.clients.delete(client);
      tab.lastSeen = Date.now();
      if (!tab.clients.size) this.cast(tab, false).catch(() => {});
    };
  }

  push(tab, msg) {
    for (const c of tab.clients) c.send(msg);
  }

  async close(agentId, n) {
    const tab = this.tabs.get(this.key(agentId, n));
    if (!tab) return;
    this.tabs.delete(this.key(agentId, n));
    this.push(tab, { t: 'closed' });
    if (tab.targetId) {
      this.byTarget.delete(tab.targetId);
      this.bySession.delete(tab.sessionId);
      await this.cdp?.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
    }
  }

  async closeAgent(agentId) {
    for (const tab of [...this.tabs.values()]) if (tab.agentId === agentId) await this.close(agentId, tab.n);
  }

  // ---------------------------------------------------------------- control

  tab(agentId, n) {
    const tab = this.tabs.get(this.key(agentId, n));
    if (!tab?.sessionId) throw Object.assign(new Error('That browser tab is not open'), { status: 409 });
    tab.lastSeen = Date.now();
    return tab;
  }

  async navigate(agentId, n, url) {
    const tab = await this.ensure(agentId, n, url);
    await this.cdp.send('Page.navigate', { url }, tab.sessionId);
  }

  async go(agentId, n, where) {
    const tab = this.tab(agentId, n);
    const s = tab.sessionId;
    if (where === 'reload') return this.cdp.send('Page.reload', {}, s);
    const { currentIndex, entries } = await this.cdp.send('Page.getNavigationHistory', {}, s);
    const entry = entries[currentIndex + (where === 'back' ? -1 : 1)];
    if (entry) await this.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, s);
  }

  /** A viewer's size, within sane bounds. */
  fit({ width, height, mobile, scale } = {}) {
    const w = Math.max(240, Math.min(2560, Math.round(Number(width) || 1280)));
    const h = Math.max(200, Math.min(2000, Math.round(Number(height) || 800)));
    return {
      width: w,
      height: h,
      mobile: mobile === true || mobile === '1' || mobile === 'true',
      // Render at the viewer's pixel density (a phone is 3x) for sharp text, within a budget of
      // about 2.4 million pixels per frame so a big desktop window stays light.
      scale: Math.round(10 * Math.max(1, Math.min(Number(scale) || 1, 3, Math.sqrt(2_400_000 / (w * h))))) / 10,
    };
  }

  async resize(agentId, n, size) {
    const tab = this.tab(agentId, n);
    const next = this.fit(size);
    if (JSON.stringify(next) === JSON.stringify(tab.viewport)) return;
    tab.viewport = next;
    tab.frame = null; // the old size; a fresh frame follows
    await this.applyViewport(tab);
  }

  /**
   * Replay what the person did, in order. Events (in page CSS pixels):
   *   { type: 'mouse', action: 'down'|'up'|'move', x, y, button, clicks, modifiers }
   *   { type: 'wheel', x, y, dx, dy }
   *   { type: 'key', key, modifiers }      a non-text key (Enter, Backspace, arrows...) or a shortcut
   *   { type: 'text', text }               typed or pasted text
   */
  async input(agentId, n, events) {
    await this.replay(agentId, n, events);
    // After a click, say whether it landed in a text field (a phone then shows its keyboard).
    const last = Array.isArray(events) ? events.at(-1) : null;
    if (last?.type !== 'mouse' || last.action !== 'up') return {};
    const tab = this.tab(agentId, n);
    const r = await this.cdp
      .send('Runtime.evaluate', { expression: "(() => { const a = document.activeElement; return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); })()", returnByValue: true }, tab.sessionId)
      .catch(() => null);
    return { editable: Boolean(r?.result?.value) };
  }

  async replay(agentId, n, events) {
    const tab = this.tab(agentId, n);
    const s = tab.sessionId;
    const send = (m, p) => this.cdp.send(m, p, s);
    for (const e of (Array.isArray(events) ? events : []).slice(0, 200)) {
      const modifiers = Number(e.modifiers) || 0;
      if (e.type === 'mouse') {
        const type = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' }[e.action];
        if (!type) continue;
        await send('Input.dispatchMouseEvent', { type, x: Number(e.x) || 0, y: Number(e.y) || 0, button: e.action === 'move' ? (e.button ?? 'none') : (e.button ?? 'left'), buttons: e.buttons ?? 0, clickCount: Number(e.clicks) || (e.action === 'move' ? 0 : 1), modifiers });
      } else if (e.type === 'wheel') {
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Number(e.x) || 0, y: Number(e.y) || 0, deltaX: Number(e.dx) || 0, deltaY: Number(e.dy) || 0, modifiers });
      } else if (e.type === 'char') {
        // One typed character as a real key press (keydown, keypress, input), which sites
        // listening for keys need; insertText alone only fires input.
        const text = String(e.text ?? '').slice(0, 2);
        if (!text) continue;
        const code = /^[a-z]$/i.test(text) ? `Key${text.toUpperCase()}` : /^\d$/.test(text) ? `Digit${text}` : text === ' ' ? 'Space' : '';
        const keyCode = /^[a-z\d ]$/i.test(text) ? text.toUpperCase().charCodeAt(0) : 0;
        const base = { key: text, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
        await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text, unmodifiedText: text });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      } else if (e.type === 'text') {
        const text = String(e.text ?? '').slice(0, 20_000);
        if (text) await send('Input.insertText', { text });
      } else if (e.type === 'key') {
        const key = String(e.key ?? '');
        const k = KEYS[key];
        const single = key.length === 1;
        const code = k?.code ?? (single ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : '') : '');
        const keyCode = k?.keyCode ?? (single ? key.toUpperCase().charCodeAt(0) : 0);
        // A shortcut (Ctrl/Cmd+A, C, V, X, Z) is passed to Chrome as an editing command too.
        const commands = modifiers & (2 | 4) && single ? { a: ['selectAll'], c: ['copy'], x: ['cut'], v: ['paste'], z: [modifiers & 8 ? 'redo' : 'undo'] }[key.toLowerCase()] : undefined;
        const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
        await send('Input.dispatchKeyEvent', { type: k?.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k?.text ? { text: k.text } : {}), ...(commands ? { commands } : {}) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      }
    }
  }

  /** What is selected in the page, for copying to the person's clipboard. */
  async selection(agentId, n) {
    const tab = this.tab(agentId, n);
    const r = await this.cdp.send('Runtime.evaluate', { expression: 'String(getSelection())', returnByValue: true }, tab.sessionId);
    return { text: String(r.result?.value ?? '').slice(0, 100_000) };
  }

  // ----------------------------------------------------------------- events

  onEvent({ method, params, sessionId }) {
    const tab = sessionId ? this.bySession.get(sessionId) : null;
    if (method === 'Page.screencastFrame' && tab) {
      this.cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {});
      // Taking the sharp screenshot makes Chrome repaint once; that frame shows nothing new.
      if (Date.now() - (tab.sharpenedAt ?? 0) < 400) return;
      const m = params.metadata;
      tab.frame = { t: 'frame', d: params.data, w: m.deviceWidth, h: m.deviceHeight };
      this.push(tab, tab.frame);
      // Moving frames are compressed for speed; once the page holds still, send a sharp one.
      clearTimeout(tab.sharpen);
      tab.sharpen = setTimeout(() => this.sharpen(tab).catch(() => {}), 500);
    } else if (method === 'Runtime.bindingCalled' && params.name === AUDIO_BINDING) {
      const t = tab ?? this.frameSessions.get(sessionId);
      if (t) for (const c of t.clients) if (c.audio) c.send({ t: 'audio', d: params.payload, rate: AUDIO_RATE });
    } else if (method === 'Target.attachedToTarget' && sessionId && params.targetInfo.type === 'iframe') {
      const t = tab ?? this.frameSessions.get(sessionId);
      if (!t) return;
      const child = params.sessionId;
      this.frameSessions.set(child, t);
      Promise.all([
        this.cdp.send('Page.enable', {}, child),
        this.hookAudio(child),
        this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, child),
      ]).catch(() => {});
    } else if (method === 'Target.detachedFromTarget' && this.frameSessions.has(params.sessionId)) {
      this.frameSessions.delete(params.sessionId);
    } else if (method === 'Page.frameNavigated' && tab && !params.frame.parentId) {
      this.navigated(tab, params.frame.url);
      if (tab.clients.size && !tab.casting) this.cast(tab, true).catch(() => {});
    } else if ((method === 'Page.loadEventFired' || method === 'Page.domContentEventFired') && tab) {
      this.refresh(tab).catch(() => {});
    } else if (method === 'Page.navigatedWithinDocument' && tab) {
      this.navigated(tab, params.url);
    } else if (method === 'Target.targetInfoChanged') {
      const t = this.byTarget.get(params.targetInfo.targetId);
      if (t && params.targetInfo.title !== t.title) {
        t.title = params.targetInfo.title;
        this.push(t, { t: 'state', url: t.url, title: t.title });
      }
    } else if (method === 'Target.targetCreated') {
      this.popup(params.targetInfo).catch(() => {});
    } else if (method === 'Target.targetDestroyed') {
      const t = this.byTarget.get(params.targetId);
      if (t && this.tabs.get(this.key(t.agentId, t.n)) === t) {
        this.tabs.delete(this.key(t.agentId, t.n));
        this.byTarget.delete(params.targetId);
        this.push(t, { t: 'closed' });
        this.onClosed?.(t.agentId, t.n);
      }
    } else if (method === 'Browser.downloadWillBegin') {
      const t = this.byTarget.get(params.frameId) ?? [...this.tabs.values()].find((x) => x.clients.size);
      if (t) this.push(t, { t: 'download', name: params.suggestedFilename, dir: this.downloads });
    }
  }

  async sharpen(tab) {
    if (!tab.clients.size || !tab.sessionId || !this.cdp) return;
    tab.sharpenedAt = Date.now();
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 }, tab.sessionId);
    tab.sharpenedAt = Date.now();
    tab.frame = { t: 'frame', d: data, w: tab.viewport.width, h: tab.viewport.height, sharp: true };
    this.push(tab, tab.frame);
  }

  navigated(tab, url) {
    if (!url || url === tab.url || url.startsWith('about:') || url.startsWith('chrome-error:')) return;
    tab.url = url;
    this.push(tab, { t: 'state', url, title: tab.title });
    this.onNavigate?.(tab.agentId, tab.n, url);
  }

  /** A page of ours opened a new window: it becomes a new tab of the same agent. */
  async popup(info) {
    if (info.type !== 'page' || !info.openerId || this.byTarget.has(info.targetId)) return;
    const opener = this.byTarget.get(info.openerId);
    if (!opener) return;
    const n = await this.onPopup?.(opener.agentId, info.url || 'about:blank');
    if (!n) return;
    const tab = { agentId: opener.agentId, n, url: info.url, title: info.title, clients: new Set(), lastSeen: Date.now(), viewport: { ...opener.viewport }, frame: null, casting: false, targetId: info.targetId };
    this.tabs.set(this.key(opener.agentId, n), tab);
    this.byTarget.set(info.targetId, tab);
    await this.attach(tab);
    this.push(opener, { t: 'popup', n });
  }
}
