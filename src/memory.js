// Shared memory per repository: what agents learned working in it (how to build and test,
// gotchas, where things are), so the next agent there starts with it instead of finding it out
// again. One Markdown file per repo under ~/.agentmanager/memory, read by every agent in that
// repo, added to with `agentmgr learn "<one line>"`, and editable by people in the UI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './config.js';
import { NO_REPO, projectOf } from './manager.js';

export const memoryText = (key) => {
  try {
    return fs.readFileSync(memoryFile(key), 'utf8');
  } catch {
    return '';
  }
};

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agentmgr.js');
export const MAX_BYTES = 16_000;
const err = (status, message) => Object.assign(new Error(message), { status });

/** The repo an agent works in, ignoring where it is listed (moved or custom project). */
export const memoryKey = (agent) => {
  const key = projectOf({ ...agent, projectMove: null, project: null }).key;
  if (!key.startsWith('dir:')) return key;
  // The same folder by any path (macOS /var is /private/var) is one repo.
  try {
    return `dir:${fs.realpathSync(key.slice(4))}`;
  } catch {
    return key;
  }
};
export const memoryFile = (key) => path.join(paths.home, 'memory', `${String(key).replace(/[^\w.-]+/g, '_').slice(0, 120)}.md`);

export const learnCommand = (bin = `node ${BIN}`) => `${bin} learn`;

/** What earlier agents learned here (inlined, so no file access is needed), and how to add to it. */
export function memoryPrompt(text, bin = `node ${BIN}`) {
  const known = String(text ?? '').trim();
  return [
    known
      ? `What earlier agents learned working in this repository (shared memory; trust it, but check anything that looks out of date):\n${known}`
      : 'There is a shared memory for this repository, empty so far.',
    `When you learn something non-obvious that would save the next agent in this repo real time (how to build or run the tests, a gotcha, where something lives, a convention that isn't written down), and it isn't already above or in CLAUDE.md or the README, record it as one short line: ${learnCommand(bin)} "<the learning>". ` +
      'Record facts about the repo, not about your task; never secrets, tokens or personal data.',
  ].join('\n\n');
}

/** One line, trimmed, without Markdown that could break the list. */
export function cleanLearning(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').replace(/^[-*#>\s]+/, '').trim();
  if (!t) throw err(400, 'Nothing to learn: give one line of text');
  if (t.length > 400) throw err(400, 'Keep a learning to one short line (400 characters at most)');
  return t;
}

export class Memory {
  constructor({ manager, config = {} }) {
    this.manager = manager;
    this.config = config;
  }

  get enabled() {
    return this.config.memory !== false;
  }

  agentKey(ref) {
    const agent = this.manager.mustGet(ref);
    if (NO_REPO.has(agent.kind)) throw err(400, 'This agent has no repository');
    return { agent, key: memoryKey(agent) };
  }

  read(ref) {
    const { key } = this.agentKey(ref);
    const file = memoryFile(key);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    return { key, file, text, entries: text.split('\n').filter((l) => l.startsWith('- ')).length, bytes: Buffer.byteLength(text), max: MAX_BYTES };
  }

  write(ref, text) {
    const { key } = this.agentKey(ref);
    text = String(text ?? '');
    if (Buffer.byteLength(text) > MAX_BYTES) throw err(413, `Keep the memory under ${MAX_BYTES / 1000} KB; it is read by every agent in the repo`);
    const file = memoryFile(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!text.trim()) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
    return this.read(ref);
  }

  /** Append one learning from an agent (or a person), skipping one already there. */
  learn(ref, text, { by } = {}) {
    const { agent, key } = this.agentKey(ref);
    const line = cleanLearning(text);
    const file = memoryFile(key);
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `# What agents learned in ${projectOf(agent).full ?? projectOf(agent).name}\n\n`;
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (cur.split('\n').some((l) => l.startsWith('- ') && norm(l.replace(/ \([^)]*\)$/, '')).includes(norm(line)))) return { ...this.read(ref), added: false };
    const entry = `- ${line} (${by ?? agent.name}, ${new Date().toISOString().slice(0, 10)})\n`;
    if (Buffer.byteLength(cur + entry) > MAX_BYTES) throw err(413, 'The repo memory is full; ask the person to tidy it (Memory on the agent)');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cur.endsWith('\n') ? cur + entry : `${cur}\n${entry}`);
    return { ...this.read(ref), added: true };
  }
}
