// The AI judge: cheap rules decide *when* to look, a model decides *what is going on*.
//   stuck   - a rule saw a pattern (repeated failure, thrashing, drift); is the agent really stuck,
//             and what specific nudge would help?
//   screen  - an agent went idle and no known prompt matched; is it asking something, finished,
//             or broken?
//   review  - an agent says (or looks) done; does the work meet the intent and brief?
//   clash   - two agents in one repo touch the same files or folders; will their work collide,
//             and which should land first?
//   dispatch- the backlog has free slots; which queued item next, which must wait for another,
//             which is too big and should be split?
//   alert   - a Slack alert is about to go out; now, in the next digest, or not at all?
// Every call is one tool-less one-shot request returning JSON. When the judge is off, over its
// daily budget, or the call fails, callers keep the rule-based result. The person's reactions
// (dismissed, nudged, sent back, accepted) are kept and shown to the judge as recent examples,
// so it calibrates to how this person works.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { contextBlock, parseJsonReply } from './brief.js';
import { paths } from './config.js';

export const JUDGE_DEFAULTS = { enabled: true, engine: null, model: null, dailyCalls: 300, concurrency: 2, timeoutSec: 120, idleSec: 20, warmupSec: 15, digestMin: 60 };
const FEEDBACK_KEEP = 60;
const file = () => path.join(paths.home, 'judge.json');
const today = () => new Date().toISOString().slice(0, 10);
export const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

export function loadJudgeState() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

const RULES = [
  'Reply with one JSON object only, no prose around it.',
  'Judge from the evidence below; do not invent facts. When the evidence is thin, say so with a low confidence.',
  'confidence is a number from 0 to 1.',
].join('\n');

const examples = (list) =>
  list.length
    ? ['<recent_decisions_by_this_person>', ...list.map((f) => `- ${f.summary} → AI said: ${f.verdict}; the person ${f.outcome}`), '</recent_decisions_by_this_person>', 'Calibrate to these: if the person keeps dismissing a kind of call, be more conservative about it.']
    : [];

/** Recent tool calls, one line each, oldest first. */
export function activityLines(events = [], n = 40) {
  return events
    .slice(-n)
    .map((e) => {
      const at = new Date(e.t).toISOString().slice(11, 19);
      if (e.kind === 'cmd') return `${at} run \`${e.cmd?.slice(0, 160)}\`${e.result === undefined ? '' : e.failed ? ` → FAILED: ${e.shown ?? ''}` : ' → ok'}`;
      if (e.kind === 'edit') return `${at} edit ${e.file}${e.edits?.length ? ` (${e.edits.length} change${e.edits.length > 1 ? 's' : ''})` : ''}`;
      return `${at} ${e.name ?? 'tool'}`;
    })
    .join('\n');
}

export function stuckPrompt(ctx, finding, events, past = []) {
  return [
    'You supervise an AI coding agent for a person. A cheap heuristic flagged that the agent may be stuck.',
    'Decide whether it really is stuck (going in circles, not converging) or making reasonable progress',
    '(for example: reading a large codebase, a long but converging debug loop, an expected failing test it is fixing).',
    'If it is stuck, write a short, specific nudge the person can send: name the likely root cause or the different',
    'approach to try, based on the activity. Speak to the agent directly, two to four sentences.',
    RULES,
    'Shape: {"stuck": true|false, "confidence": 0.0, "title": "short headline", "diagnosis": "one or two sentences", "nudge": "message to the agent, or empty"}',
    '',
    '<heuristic_finding>',
    `${finding.title}. ${finding.detail}`,
    '</heuristic_finding>',
    '<recent_tool_calls>',
    activityLines(events) || '(none recorded)',
    '</recent_tool_calls>',
    ...contextBlock(ctx),
    ...examples(past),
  ].join('\n');
}

/** The screen without the engine's own frame (input box, mode indicators, status bar). */
export function stripChrome(screen, patterns = []) {
  if (!patterns.length) return screen;
  return screen
    .split('\n')
    .filter((line) => !patterns.some((re) => re.test(line.trim())))
    .join('\n')
    .trim();
}

export function screenPrompt(ctx, screen, past = []) {
  return [
    'You supervise an AI coding agent running in a terminal. It has stopped producing output.',
    'Read the end of its terminal screen and decide what state it is in:',
    '- "question": it asked the person something and is waiting for an answer (a choice, approval, missing info)',
    '- "done": it says it finished the task it was given',
    '- "error": it crashed, hit an error it cannot recover from, or a limit (rate limit, auth, quota)',
    '- "idle": finished a step and is simply waiting for the next instruction, nothing specific to answer',
    'For "question", copy the question in plain words and list the choices it offered, if any.',
    'The tool\'s own input box, mode indicators and status bar (for example "accept edits on", "plan mode on",',
    '"shift+tab to cycle", "? for shortcuts", "update available") are not questions: only the agent\'s own words count.',
    RULES,
    'Shape: {"state": "question|done|error|idle", "confidence": 0.0, "summary": "one line for an inbox", "question": "or empty", "choices": ["..."]}',
    '',
    '<terminal_screen>',
    screen,
    '</terminal_screen>',
    '<intent>',
    ctx.intent || '(none)',
    '</intent>',
    ...examples(past),
  ].join('\n');
}

export function reviewPrompt(ctx, past = []) {
  return [
    'You review an AI coding agent\'s work before a person looks at it. Compare what was asked (intent, brief)',
    'with what was done (conversation, repository changes, checks). Be concrete and skeptical: unverified claims',
    'are not met. Only list missing items that matter for the stated intent.',
    '- "complete": the intent is met and verified well enough to hand to the person',
    '- "partial": real progress, but named items are missing or unverified',
    '- "not_done": the main ask is not done',
    RULES,
    'Shape: {"verdict": "complete|partial|not_done", "confidence": 0.0, "summary": "two sentences", "met": ["..."], "missing": ["..."], "risks": ["..."]}',
    '',
    ...contextBlock(ctx),
    ...examples(past),
  ].join('\n');
}

const files = (c) =>
  Object.entries(c?.files ?? {})
    .slice(0, 40)
    .map(([f, x]) => `${f} (+${x.added ?? 0} -${x.removed ?? 0})`)
    .join('\n') || '(none)';

/** a/b: { name, intent, brief, changes: { files } } */
export function clashPrompt(a, b, past = []) {
  const side = (tag, x) => [`<agent_${tag}>`, `name: ${x.name}`, `intent: ${x.intent || '(none)'}`, 'changed files:', files(x.changes), x.brief ? `brief:\n${x.brief.slice(0, 1200)}` : '', `</agent_${tag}>`];
  return [
    'Two AI coding agents work on separate branches of the same repository and will both merge into it.',
    'Decide whether their work will collide: a textual merge conflict, or a semantic one (changing the same',
    'function, API, schema, config or behavior in incompatible ways, even from different files).',
    'Touching the same file in unrelated places is not a real collision. If they collide, say which should land',
    'first (usually the one others build on, or the smaller, more finished one) and give each agent one sentence of advice.',
    RULES,
    'Shape: {"conflict": true|false, "confidence": 0.0, "reason": "one or two sentences", "mergeFirst": "A|B|", "orderReason": "", "adviceA": "", "adviceB": ""}',
    '',
    ...side('A', a),
    ...side('B', b),
    ...examples(past),
  ].join('\n');
}

/** queued: [{ id, title, priority, project }], active: [{ id, title, project, changes }] */
export function dispatchPrompt(queued, active, past = []) {
  return [
    'You schedule a backlog of coding tasks that AI agents pick up in parallel, each on its own branch.',
    'Priority (P0 highest) always wins; within a priority, put first what others depend on. Hold an item back',
    'when it depends on another open item or would collide with one being worked on now (same code, same files).',
    'Suggest splitting an item only when it clearly bundles several independent tasks.',
    'Use the ids exactly as given.',
    RULES,
    'Shape: {"order": ["id", ...], "hold": [{"id": "", "after": "id of the item it waits for", "reason": ""}], "split": [{"id": "", "reason": "", "parts": ["task title", ...]}]}',
    '',
    '<queued>',
    ...queued.map((q) => `- ${q.id} [P${q.priority}] (${q.project}) ${q.title}`),
    '</queued>',
    '<in_progress>',
    ...(active.length ? active.map((x) => `- ${x.id} (${x.project}) ${x.title}\n  changed: ${files(x.changes).split('\n').slice(0, 12).join(', ')}`) : ['(nothing)']),
    '</in_progress>',
    ...examples(past),
  ].join('\n');
}

/** What should happen to one Slack alert. */
export function alertPrompt({ kind, what, agent, recent }, past = []) {
  return [
    'You triage alerts about AI coding agents for a busy person, who should be interrupted only when it matters.',
    '- "now": they should act soon (the agent is blocked on them, burning time, about to cause damage, or high priority work)',
    '- "digest": worth knowing, can wait for a periodic summary',
    '- "skip": noise (duplicates a recent alert, or nothing to do)',
    RULES,
    'Shape: {"urgency": "now|digest|skip", "confidence": 0.0, "line": "the alert rewritten as one short line"}',
    '',
    `<alert kind="${kind}">${what}</alert>`,
    `<agent>name: ${agent.name}; priority: P${agent.priority ?? 2}; status: ${agent.status}; intent: ${String(agent.intent ?? '').slice(0, 300)}</agent>`,
    '<recent_alerts>',
    ...(recent.length ? recent.map((r) => `- ${r.at} ${r.kind} ${r.agent}${r.urgency ? ` (${r.urgency})` : ''}`) : ['(none)']),
    '</recent_alerts>',
    ...examples(past),
  ].join('\n');
}

/** The message that sends an agent back to finish what the review found missing. */
export function finishMessage(review) {
  const items = (review.missing ?? []).map((m) => `- ${m}`).join('\n');
  return `A review of your work against the task found these items still missing or unverified:\n${items}\nPlease finish them, verify each one, and update the brief when done.`;
}

export class Judge {
  /** call(agent, prompt, { timeoutMs }) runs one one-shot request and resolves to its text. */
  constructor({ config, call }) {
    this.config = config;
    this.call = call;
    this.state = loadJudgeState();
    this.running = 0;
    this.queue = [];
    this.inflight = new Map(); // cache key -> promise
  }

  get settings() {
    return { ...JUDGE_DEFAULTS, ...this.config.judge };
  }

  get enabled() {
    return Boolean(this.settings.enabled);
  }

  save() {
    try {
      fs.writeFileSync(file(), JSON.stringify(this.state, null, 2));
    } catch {}
  }

  usage() {
    if (this.state.day !== today()) Object.assign(this.state, { day: today(), calls: 0, failures: 0 });
    return { day: this.state.day, calls: this.state.calls, failures: this.state.failures ?? 0, cap: this.settings.dailyCalls };
  }

  status() {
    return { enabled: this.enabled, ...this.usage(), running: this.running, queued: this.queue.length, feedback: (this.state.feedback ?? []).length };
  }

  slot() {
    if (this.running < this.settings.concurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.running--;
  }

  /**
   * Ask once per cache key at a time; resolves to the parsed JSON, or null when the judge is off,
   * over budget, or the reply was unusable (the caller then keeps its rule-based answer).
   */
  ask(key, agent, prompt, validate = () => true) {
    if (!this.enabled) return Promise.resolve(null);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const run = (async () => {
      await this.slot();
      try {
        const u = this.usage();
        if (u.calls >= u.cap) return null;
        this.state.calls++;
        const data = parseJsonReply(await this.call(agent, prompt, { timeoutMs: this.settings.timeoutSec * 1000 }));
        if (!validate(data)) throw new Error('reply did not have the expected shape');
        data.confidence = Math.max(0, Math.min(1, Number(data.confidence) || 0));
        return data;
      } catch (err) {
        this.state.failures = (this.state.failures ?? 0) + 1;
        this.state.lastError = { at: new Date().toISOString(), key: key.split(':')[0], message: String(err.message).slice(0, 300) };
        return null;
      } finally {
        this.save();
        this.release();
      }
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  /** Remember how the person reacted to a judgment, for future calibration. */
  feedback(kind, { summary, verdict, outcome }) {
    const list = (this.state.feedback ??= []);
    list.push({ kind, summary: String(summary).slice(0, 200), verdict: String(verdict).slice(0, 80), outcome, at: new Date().toISOString() });
    if (list.length > FEEDBACK_KEEP) list.splice(0, list.length - FEEDBACK_KEEP);
    this.save();
  }

  examples(kind, n = 6) {
    return (this.state.feedback ?? []).filter((f) => f.kind === kind).slice(-n);
  }
}
