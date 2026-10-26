// What the About box and "agentmgr about" show: the release, who makes it, where to get help,
// and how this daemon runs. Nothing here leaves the machine; the update check is a separate,
// user-triggered request to the npm registry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => {
  try {
    return fs.readFileSync(path.join(root, f), 'utf8');
  } catch {
    return '';
  }
};
const pkg = JSON.parse(read('package.json'));
const startedAt = new Date().toISOString();

/** The date in a changelog heading like "## 1.0.0 (2026-10-25)", or null. */
export function releaseDate(changelog, version) {
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return changelog.match(new RegExp(`^##\\s+v?${esc}\\s+\\((\\d{4}-\\d{2}-\\d{2})\\)`, 'm'))?.[1] ?? null;
}

const authorName = (a) => (typeof a === 'string' ? a.replace(/\s*[<(].*$/, '') : a?.name) || null;
const repoUrl = (r) => String((typeof r === 'string' ? r : r?.url) ?? '').replace(/^git\+/, '').replace(/\.git$/, '') || null;

export function about({ port, config = {} } = {}) {
  return {
    product: 'AI Agent Manager',
    package: pkg.name,
    command: Object.keys(pkg.bin ?? {})[0] ?? null,
    version: pkg.version,
    releaseDate: releaseDate(read('CHANGELOG.md'), pkg.version),
    author: authorName(pkg.author),
    license: pkg.license,
    links: {
      repository: repoUrl(pkg.repository),
      issues: pkg.bugs?.url ?? null,
      releases: repoUrl(pkg.repository) ? `${repoUrl(pkg.repository)}/releases` : null,
      npm: `https://www.npmjs.com/package/${pkg.name}`,
    },
    daemon: {
      pid: process.pid,
      port: port ?? null,
      home: config.home ?? null,
      startedAt,
      node: process.version,
      platform: `${os.type()} ${os.release()} (${process.arch})`,
      claudeBin: config.claudeBin ?? null,
    },
  };
}

/** The newest version on npm. Only called when someone clicks "Check for updates". */
export async function latestRelease({ fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const res = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw Object.assign(new Error(`npm answered ${res.status}`), { status: 502 });
  const { version } = await res.json();
  return { current: pkg.version, latest: version, newer: newerThan(version, pkg.version) };
}

/** True when semver `a` is newer than `b` (pre-releases count as older than the release). */
export function newerThan(a, b) {
  const parse = (v) => String(v).split('-')[0].split('.').map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return String(b).includes('-') && !String(a).includes('-');
}
