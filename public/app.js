import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/xterm-addon-fit/lib/addon-fit.mjs';
import { marked } from '/vendor/marked/marked.esm.js';
import DOMPurify from '/vendor/dompurify/purify.es.mjs';
import { touchScroll } from '/touchscroll.js';
import { openStream, post, REMOTE } from '/transport.js';
import { initReview } from '/review.js';
import { initLand, prChips } from '/land.js';
import { initTriggers } from '/triggers.js';
import { initSpend } from '/spend.js';
import { initPlaybooks } from '/playbooks.js';
import { initSetup } from '/setup.js';
import { initUpdate } from '/update.js';
import { initMenu } from '/menu.js';
import { initCode } from '/code.js';
import { initMachine } from '/machine.js';

const $ = (sel) => document.querySelector(sel);
const agents = new Map();
let backlogState = { items: [], projects: [], autoRun: true, defaultLimit: 2 };
let projectsState = [];
let sideTab = 'agents';
let showCompleted = false;
const races = new Map(); // race id -> scoreboard
let openRaceId = null;
let raceDiff = null; // { agentId, text }
const teams = new Map(); // team id -> team view
let openTeamId = null;
let teamFile = null; // { name, markdown } shown in the team view
// #<id> selects an agent; #<id>/term also opens its terminal.
const loginHash = location.hash.match(/(?:^#|&)login=([\w-]+)/)?.[1] ?? null;
// From the hub: #ticket=<one-time ticket>&go=<agent>/term
const ticketHash = location.hash.match(/(?:^#|&)ticket=([\w-]+)/)?.[1] ?? null;
const goHash = ticketHash ? decodeURIComponent(location.hash.match(/(?:^#|&)go=([^&]*)/)?.[1] ?? '') : '';
const [hashId, hashView] = loginHash ? [null, null] : (ticketHash ? goHash : location.hash.slice(1)).split('/');
let selectedId = hashId || null;
let openTermOnLoad = hashView === 'term' || hashView === 'code' || isShell(hashView) || isBrowser(hashView);
let filterText = '';
// "Only agents created in the last N days": remembered in this browser.
const recent = (() => {
  try {
    return { on: localStorage.getItem('agentmgr.recentOn') === '1', days: Number(localStorage.getItem('agentmgr.recentDays')) || 7 };
  } catch {
    return { on: false, days: 7 };
  }
})();
const saveRecent = () => {
  try {
    localStorage.setItem('agentmgr.recentOn', recent.on ? '1' : '0');
    localStorage.setItem('agentmgr.recentDays', String(recent.days));
  } catch {}
};

// ------------------------------------------------------------------ helpers

// Terminal kinds: 'claude' (the agent's session) or 'shell:N' (shell N in its folder).
function isShell(kind) {
  return /^shell(:\d+)?$/.test(kind ?? '');
}
const shellNum = (kind) => Number((kind ?? '').split(':')[1] || 1);
// 'browser:N' is browser tab N (a page this machine serves); 'browser:new' is the address prompt.
function isBrowser(kind) {
  return /^browser:(\d+|new)$/.test(kind ?? '');
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

async function api(method, route, body) {
  const res = await fetch(`/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-agentmgr': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, ms = 2600, action) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  if (action) {
    const b = Object.assign(document.createElement('button'), { className: 'small primary', textContent: action.label });
    b.onclick = () => {
      el.remove();
      action.run();
    };
    el.append(' ', b);
  }
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

async function act(fn, okMsg) {
  try {
    const res = await fn();
    if (okMsg) toast(okMsg);
    return res;
  } catch (err) {
    toast(`Error: ${err.message}`, 5000);
  }
}

const reviewUi = initReview({ api, esc, toast, agents, $ });
const triggersUi = initTriggers({ api, esc, toast, $ });
initSpend({ api, esc, toast, $ });
initSetup({ api, esc, $ });
const updateUi = initUpdate({ api, esc, toast, $ });
initMenu({ api, esc, toast, $ });
initMachine({ api, esc, toast, $, Terminal, FitAddon });
const codeUi = initCode({ api, esc, toast, $, agents, isOpen: () => term.kind === 'code' });
const playbooksUi = initPlaybooks({ api, esc, toast, $, select: (id) => (showTab('agents'), select(id)) });
$('#new-playbook').onclick = () => {
  const f = $('#new-form');
  $('#new-dialog').close();
  playbooksUi.open({ intent: f.intents.value.trim(), projects: f.project.value.trim() ? [f.project.value.trim()] : [], model: f.model.value.trim(), permissionMode: f.permissionMode.value });
};
$('#triggers-open').onclick = () => triggersUi.open();
const landUi = initLand({ api, esc, toast, agents, $, select: (id) => (showTab('agents'), select(id)), openReview: (id) => reviewUi.open(id), isOpen: () => sideTab === 'land' });

function statusOf(a) {
  if (a.runtime.planning) return a.runtime.attention ? 'attention' : 'planning';
  if (a.status === 'running') {
    if (a.runtime.attention) return 'attention';
    return a.runtime.busy ? 'working' : 'waiting';
  }
  return a.status;
}

/** 1234 -> "1.2k", 3456789 -> "3.5M" */
function fmtTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
}

const ioOf = (u) => (u ? (u.io ?? u.input + u.output) : 0);

function usageTitle(u) {
  return `I/O ${ioOf(u).toLocaleString()} (input ${u.input.toLocaleString()} + output ${u.output.toLocaleString()}) · cache write ${u.cacheCreation.toLocaleString()} · cache read ${u.cacheRead.toLocaleString()} · total incl. cache ${u.total.toLocaleString()} · ${u.requests} API requests`;
}

const tokensOpen = new Set(); // agents whose token breakdown is expanded

// ------------------------------------------------------------------ brief

// Agent-written Markdown: render, then sanitize (this page also drives terminals).
const md = (text) => DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: false }));

const CHECK_ICON = { passed: '✓', failed: '✗', running: '◔', pending: '○' };

function checksSummary(b) {
  if (!b?.summary?.total) return '';
  const { passed, failed, running, pending } = b.summary;
  return [passed && `${passed} passed`, failed && `${failed} failed`, running && `${running} running`, pending && `${pending} pending`]
    .filter(Boolean)
    .join(' · ');
}

const diagrams = new Map(); // mermaid source -> rendered SVG (or an error)
const expanded = new Set(); // "<agent id>:<section>" the user opened with Show more

/** Long sections are clamped; Show more toggles them. */
const clamp = (a, key, html) =>
  `<div class="clamp ${expanded.has(`${a.id}:${key}`) ? 'open' : ''}" data-clamp="${a.id}:${key}"><div class="md">${html}</div>` +
  `<button class="link more" data-more="${a.id}:${key}"></button></div>`;

function markOverflow(root) {
  for (const el of root.querySelectorAll('.clamp')) {
    const inner = el.querySelector('.md');
    el.classList.toggle('overflowing', el.classList.contains('open') || inner.scrollHeight > inner.clientHeight + 4);
    el.querySelector('.more').textContent = el.classList.contains('open') ? 'Show less' : 'Show more';
  }
}
let mermaidLib = null;

async function renderDiagrams(root) {
  const slots = [...root.querySelectorAll('[data-mermaid]')];
  if (!slots.length) return;
  for (const slot of slots) {
    const src = slot.dataset.mermaid;
    if (!diagrams.has(src)) {
      try {
        if (!mermaidLib) {
          mermaidLib = (await import('/vendor/mermaid/mermaid.esm.min.mjs')).default;
          const dark = matchMedia('(prefers-color-scheme: dark)').matches;
          mermaidLib.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
        }
        const { svg } = await mermaidLib.render(`mmd-${diagrams.size}-${Date.now()}`, src);
        diagrams.set(src, { svg });
      } catch (err) {
        diagrams.set(src, { error: String(err?.message || err).split('\n')[0] });
      }
    }
    const out = diagrams.get(src);
    // The detail pane may have re-rendered while we were drawing; fill whichever slot is current.
    for (const el of document.querySelectorAll('[data-mermaid]')) {
      if (el.dataset.mermaid !== src || el.dataset.filled) continue;
      el.dataset.filled = '1';
      if (out.svg) el.innerHTML = out.svg;
      else el.innerHTML = `<div class="hint">Diagram could not be drawn (${esc(out.error)}). Source:</div><pre>${esc(src)}</pre>`;
    }
  }
}

function explainBox(a) {
  const ex = a.explanation;
  const label = ex?.pending ? 'Explaining…' : ex?.markdown ? 'Explain again' : 'Explain';
  const button = `<button class="small ${ex?.markdown ? '' : 'primary'}" data-act="explain" ${ex?.pending ? 'disabled' : ''}
    title="What this agent is doing: the ask, where it stands, planned work, solution, conclusions and what it needs from you. Built from its live session by a separate one-off Claude call (does not interrupt the agent)">${label}</button>`;
  if (!ex?.markdown && !ex?.error) return { button, box: '' };
  const stale = ex.markdown && a.brief?.updatedAt && ex.briefUpdatedAt !== a.brief.updatedAt;
  const box = `<div class="explain">
      ${ex.error ? `<p class="error">Couldn't explain: ${esc(ex.error)}</p>` : ''}
      ${ex.markdown
        ? `${stale ? '<p class="hint">The brief has changed since this explanation; use <b>Explain again</b> to refresh it.</p>' : ''}
           ${clamp(a, 'explain', md(ex.markdown))}
           <p class="hint">Explained ${ago(ex.at)}.</p>`
        : ''}
    </div>`;
  return { button, box };
}

const REVIEW_VERDICT = { complete: '✓ Complete', partial: '≈ Partly done', not_done: '✗ Not done' };
/** The AI judge's review of the work against the intent and brief: button, and the last result once handled. */
function reviewBox(a) {
  if (noRepo(a)) return { button: '', box: '' };
  const r = a.aiReview;
  const button = `<button class="small" data-act="review" ${r?.pending ? 'disabled' : ''}
    title="Check the work against the intent and brief: what is met, missing or risky. A separate one-off model call; runs by itself when the agent says it is done">${r?.pending ? 'Reviewing…' : 'Review with AI'}</button>`;
  // An unhandled review shows as a card above the brief; a handled one stays here, compact.
  if (!r?.verdict || !r.seen) return { button, box: '' };
  return {
    button,
    box: `<div class="explain ai-review"><p><span class="verdict ${esc(r.verdict)}">${REVIEW_VERDICT[r.verdict] ?? esc(r.verdict)}</span> ${esc(r.summary)}</p>
      ${r.missing.length ? `<p class="hint">Missing: ${r.missing.map(esc).join('; ')}</p>` : ''}
      <p class="hint">AI review by ${esc(r.by)} ${ago(r.at)}${r.outcome === 'finish' ? '; sent back to finish' : r.outcome === 'accept' ? '; you accepted it' : ''}.</p></div>`,
  };
}

const INSIGHT_ICONS = { why: '🎯', what: '📦', how: '🛠', now: '📍' };

// ------------------------------------------------------------------ stakeholder documents

const DOCS = { analysis: 'Analysis', design: 'Design', flow: 'Flow', proposal: 'Proposal', humanai: 'Human vs AI' };
const DOC_TITLES = { ...DOCS, plan: 'Implementation plan' };
/** What the document dialog shows: a stakeholder document, or the agent's plan under review. */
const docOf = (a, kind) => (kind === 'plan' ? a?.planReview && { markdown: a.planReview.markdown, at: a.planReview.updatedAt } : a?.docs?.[kind]);

const VERDICT = { agree: '✓ Agrees', partly: '≈ Partly agrees', disagree: '✗ Disagrees', keep: '✓ Keep', ai: '🤖 AI could answer', reword: '✎ Reword' };
const CONFIDENCE = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };

/** Human vs AI: your questions with answer boxes, the AI's answers, and the second model's checks. */
function humanAiHtml(d) {
  const c = d.critique?.data;
  const second = (v) =>
    v ? `<p class="second ${esc(v.verdict)}"><span class="verdict">${VERDICT[v.verdict] ?? esc(v.verdict)}</span> <span class="hint">${esc(d.critique.label)}:</span> ${esc(v.note)}</p>` : '';
  const evidence = (e) => (Array.isArray(e) ? e.join('; ') : e ?? '');
  const human = (d.data.human ?? [])
    .map(
      (q, i) => `<section class="ha-card human">
      <h4>${i + 1}. ${esc(q.question)}</h4>
      ${q.why_human ? `<p><b>Why you:</b> ${esc(q.why_human)}</p>` : ''}
      ${q.stakes ? `<p><b>Stakes:</b> ${esc(q.stakes)}</p>` : ''}
      ${q.options?.length ? `<p class="ha-options">${q.options.map((o) => `<button type="button" class="small" data-ha-pick="${i}" data-text="${esc(o)}">${esc(o)}</button>`).join(' ')}</p>` : ''}
      ${q.lean ? `<p class="hint">The work so far suggests: ${esc(q.lean)}</p>` : ''}
      ${second(c?.human?.[i])}
      <textarea data-ha="${i}" rows="2" placeholder="Your answer…">${esc(d.answers?.[i] ?? '')}</textarea>
    </section>`,
    )
    .join('');
  const ai = (d.data.ai ?? [])
    .map(
      (q, i) => `<section class="ha-card ai">
      <h4>${i + 1}. ${esc(q.question)} <span class="tag conf-${esc(q.confidence)}">${CONFIDENCE[q.confidence] ?? esc(q.confidence)}</span></h4>
      <div class="md">${md(q.answer ?? '')}</div>
      ${q.evidence ? `<p class="hint"><b>Evidence:</b> ${esc(evidence(q.evidence))}</p>` : ''}
      ${q.check ? `<p class="hint"><b>How to check:</b> ${esc(q.check)}</p>` : ''}
      ${second(c?.ai?.[i])}
    </section>`,
    )
    .join('');
  const missing = c?.missing?.length
    ? `<ul>${c.missing.map((m) => `<li><b>${m.for === 'human' ? 'For you' : 'For AI'}:</b> ${esc(m.question)} <span class="hint">${esc(m.why)}</span></li>`).join('')}</ul>`
    : '';
  const review = c
    ? `<section class="ha-second"><h3>Second opinion · ${esc(d.critique.label)}</h3><p>${esc(c.summary ?? '')}</p>${missing ? `<p class="hint">Questions both lists missed:</p>${missing}` : ''}</section>`
    : d.critique?.error
      ? `<p class="error">Second opinion not available (${esc(d.critique.label)}): ${esc(d.critique.error)}</p>`
      : '';
  return `<h1>Human vs AI: ${esc(d.data.title ?? '')}</h1>
    <h2>🧑 For you to decide</h2><p class="hint">Judgment calls the agent shouldn't make for you. Answer what you can and send them to the agent.</p>${human}
    <h2>🤖 Answered by AI</h2><p class="hint">Reasoning and evaluation from the agent's session and changes, each checked by a second model.</p>${ai}
    ${review}`;
}

/** Markdown with ```mermaid blocks drawn as diagrams (everything else sanitized). */
function docHtml(markdown) {
  const blocks = [];
  const text = (markdown ?? '').replace(/```mermaid\s*\n([\s\S]*?)```/g, (_, src) => {
    blocks.push(src.trim());
    return `\n\nMERMAIDBLOCK${blocks.length - 1}\n\n`;
  });
  return md(text).replace(/<p>MERMAIDBLOCK(\d+)<\/p>/g, (_, i) => `<div class="diagram" data-mermaid="${esc(blocks[Number(i)])}"></div>`);
}

function docButtons(a) {
  const missing = Object.keys(DOCS).filter((k) => !a.docs?.[k]?.markdown && !a.docs?.[k]?.pending);
  const all = missing.length
    ? `<button class="small ghost" data-doc-all title="Write ${missing.map((k) => DOCS[k]).join(', ')} in the background; you'll be told when each is ready">Write all in background</button>`
    : '';
  return `<span class="doc-buttons" title="Documents to share with stakeholders">${all}${Object.entries(DOCS)
    .map(([k, label]) => {
      const d = a.docs?.[k];
      const stale = d?.markdown && a.brief?.updatedAt && d.briefUpdatedAt !== a.brief.updatedAt;
      return `<button class="small doc-btn ${d?.markdown ? 'has' : ''}" data-doc="${k}" ${d?.pending ? 'disabled' : ''}
        title="${d?.markdown ? `Open the ${label.toLowerCase()} document${stale ? ' (the brief changed since)' : ''}` : `Write a ${label.toLowerCase()} document for stakeholders`}">${d?.pending ? `${label}…` : label}${d?.markdown ? (stale ? ' •' : ' ✓') : ''}</button>`;
    })
    .join('')}</span>`;
}

let docView = null; // { agentId, kind }

function renderDocDialog() {
  if (!docView) return;
  const a = agents.get(docView.agentId);
  const d = docOf(a, docView.kind);
  const label = DOC_TITLES[docView.kind];
  const plan = docView.kind === 'plan';
  $('#doc-title').textContent = `${label} · ${a?.name ?? ''}`;
  const body = $('#doc-body');
  if (d?.pending) {
    body.innerHTML = `<p class="hint">${docView.kind === 'humanai' ? 'Splitting the open questions and answering the AI ones, then asking a second model to check…' : `Writing the ${label.toLowerCase()} document from the agent's work so far…`}</p>`;
    body.dataset.rendered = '';
  } else if (d?.error) body.innerHTML = `<p class="error">Couldn't write it: ${esc(d.error)}</p>`;
  else if (plan && !d?.markdown) body.innerHTML = '<p class="hint">The agent is investigating and hasn\'t written its plan yet. You\'ll see it here (and in the inbox) when it has.</p>';
  else if (d?.markdown) {
    if (body.dataset.rendered !== d.at) {
      body.innerHTML = d.data ? humanAiHtml(d) : docHtml(d.markdown);
      body.dataset.rendered = d.at;
      renderDiagrams(body);
    }
  }
  const stale = !plan && d?.markdown && a.brief?.updatedAt && d.briefUpdatedAt !== a.brief.updatedAt;
  const by = d?.writer ? ` by ${d.writer}${d.critique ? `, checked by ${d.critique.label}` : ''}` : '';
  $('#doc-meta').textContent = d?.markdown ? `${plan ? `Plan · ${PLAN_LABEL[a.planReview.status]} · updated` : 'Written'} ${ago(d.at)}${by}${stale ? ' · the brief has changed since; Regenerate for the latest' : ''}` : '';
  for (const id of ['doc-copy', 'doc-download', 'doc-print']) $(`#${id}`).disabled = !d?.markdown;
  $('#doc-print').hidden = plan;
  $('#doc-regen').hidden = plan;
  $('#doc-regen').disabled = Boolean(d?.pending);
  $('#doc-bg').hidden = !d?.pending;
  // Footer: send your answers (Human vs AI), or approve / send back the plan.
  const foot = $('#doc-foot');
  const reviewing = plan && ['review', 'changes'].includes(a?.planReview?.status) && d?.markdown;
  foot.hidden = !(reviewing || (docView.kind === 'humanai' && d?.data));
  if (foot.dataset.mode !== (plan ? 'plan' : 'humanai')) {
    foot.dataset.mode = plan ? 'plan' : 'humanai';
    foot.innerHTML = plan
      ? `<textarea id="plan-note" rows="2" placeholder="Notes for the agent (required to request changes, optional when approving)"></textarea>
         <div class="doc-foot-actions"><button type="button" class="small" data-plan="changes">Request changes</button><button type="button" class="small primary" data-plan="approve">Approve and implement</button></div>`
      : `<span class="hint">Your answers are kept with the agent.</span><div class="doc-foot-actions"><button type="button" class="small" data-ha-act="save">Save</button><button type="button" class="small primary" data-ha-act="send">Send my answers to the agent</button></div>`;
  }
}

function openDoc(agentId, kind) {
  docView = { agentId, kind };
  $('#doc-body').dataset.rendered = '';
  $('#doc-dialog').showModal();
  const a = agents.get(agentId);
  if (kind !== 'plan' && !a.docs?.[kind]?.markdown && !a.docs?.[kind]?.pending) generateDoc();
  renderDocDialog();
}

function generateDoc() {
  const { agentId, kind } = docView;
  act(async () => upsert(await api('POST', `/agents/${agentId}/docs/${kind}`)));
}

$('#doc-close').onclick = () => {
  docView = null;
  $('#doc-dialog').close();
};
$('#doc-bg').onclick = () => {
  toast(`Writing ${DOCS[docView.kind].toLowerCase()} in the background; you'll be told when it's ready`, 3500);
  docView = null;
  $('#doc-dialog').close();
};

// Tell the user when a document finishes while they're not looking at it.
const docsSeen = new Map(); // "<agent>:<kind>" -> pending?
function watchDocs(a) {
  for (const k of Object.keys(DOCS)) {
    const key = `${a.id}:${k}`;
    const d = a.docs?.[k];
    const was = docsSeen.get(key);
    docsSeen.set(key, Boolean(d?.pending));
    if (!was || d?.pending) continue;
    const viewing = docView && docView.agentId === a.id && docView.kind === k;
    if (viewing) continue;
    if (d?.markdown && !d.error) toast(`${DOCS[k]} for ${a.name} is ready`, 10000, { label: 'Open', run: () => openDoc(a.id, k) });
    else if (d?.error) toast(`${DOCS[k]} for ${a.name} failed: ${d.error}`, 8000);
  }
}
$('#doc-regen').onclick = () => generateDoc();
$('#doc-copy').onclick = async () => {
  const d = docOf(agents.get(docView.agentId), docView.kind);
  await navigator.clipboard.writeText(d.markdown).then(
    () => toast('Markdown copied; paste into Confluence, Google Docs, Slack or a PR'),
    () => toast('Copy failed: your browser blocked clipboard access'),
  );
};
$('#doc-download').onclick = () => {
  const a = agents.get(docView.agentId);
  const blob = new Blob([docOf(a, docView.kind).markdown], { type: 'text/markdown' });
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${a.slug}-${docView.kind}.md` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};
const haAnswers = () => Object.fromEntries([...document.querySelectorAll('#doc-body [data-ha]')].map((t) => [t.dataset.ha, t.value]));
$('#doc-body').addEventListener('click', (e) => {
  const pick = e.target.closest('[data-ha-pick]');
  if (!pick) return;
  const box = $(`#doc-body [data-ha="${pick.dataset.haPick}"]`);
  box.value = box.value.trim() ? `${box.value.trim()} ${pick.dataset.text}` : pick.dataset.text;
  box.focus();
});
$('#doc-body').addEventListener('change', (e) => {
  if (e.target.dataset.ha === undefined || !docView) return;
  api('POST', `/agents/${docView.agentId}/humanai/answers`, { answers: haAnswers() }).then(upsert).catch(() => {});
});
$('#doc-foot').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ha-act], [data-plan]');
  if (!b || !docView) return;
  const id = docView.agentId;
  if (b.dataset.haAct) {
    const send = b.dataset.haAct === 'send';
    return act(async () => upsert(await api('POST', `/agents/${id}/humanai/answers`, { answers: haAnswers(), send })), send ? 'Sent to the agent' : 'Saved');
  }
  const note = $('#plan-note').value;
  act(async () => {
    upsert(await api('POST', `/agents/${id}/plan/${b.dataset.plan}`, { note }));
    $('#plan-note').value = '';
    if (b.dataset.plan === 'approve') $('#doc-close').click();
  }, b.dataset.plan === 'approve' ? 'Approved; the agent is implementing it' : 'Sent back to the agent');
});
function openPlan(agentId) {
  docView = { agentId, kind: 'plan' };
  $('#doc-body').dataset.rendered = '';
  $('#doc-dialog').showModal();
  renderDocDialog();
}

const PLAN_LABEL = { writing: 'being written', review: 'waiting for your review', changes: 'changes requested', approved: 'approved' };
/** The plan-review row in the brief card: status, open, approve; or the switch to turn review on. */
function planRow(a) {
  if (noRepo(a)) return '';
  const p = a.planReview;
  if (!p) {
    return a.status === 'done' ? '' : `<div class="plan-row"><button class="small ghost" data-act="plan-on" title="The agent writes an implementation plan and waits for your approval before changing anything">Review its plan first</button></div>`;
  }
  return `<div class="plan-row ${p.status}"><b>Plan</b> <span class="tag plan-${p.status}">${PLAN_LABEL[p.status]}</span>
    <button class="small ${p.status === 'review' ? 'primary' : ''}" data-act="plan-open" ${p.markdown ? '' : 'disabled'}>${p.status === 'review' ? 'Review plan' : 'Open plan'}</button>
    ${p.status !== 'approved' ? '<button class="small ghost" data-act="plan-skip" title="Stop waiting for review; the agent goes ahead">Skip review</button>' : ''}</div>`;
}
$('#doc-print').onclick = () => window.open(`/share.html#${docView.agentId}/${docView.kind}`, '_blank', 'noopener');

/** Why / What / How / Now as four cards. */
function insightsBox(a) {
  const ins = a.insights;
  const button = `<button class="small ${ins?.markdown ? '' : 'primary'}" data-act="insights" ${ins?.pending ? 'disabled' : ''}
    title="Why, What, How and Now in three memorable points each, from the agent's ask and live session (a separate one-off Claude call)">${ins?.pending ? 'Thinking…' : ins?.markdown ? 'Refresh insights' : 'Insights'}</button>`;
  if (!ins?.markdown && !ins?.error) return { button, box: '' };
  const sections = {};
  for (const part of (ins.markdown ?? '').split(/^###\s+/m).slice(1)) {
    const [head, ...rest] = part.split('\n');
    const key = head.trim().toLowerCase().replace(/[^a-z]/g, '');
    if (INSIGHT_ICONS[key]) sections[key] = rest.join('\n').trim();
  }
  const stale = ins.markdown && a.brief?.updatedAt && ins.briefUpdatedAt !== a.brief.updatedAt;
  const box = `<div class="insights">
      ${ins.error ? `<p class="error">Couldn't get insights: ${esc(ins.error)}</p>` : ''}
      ${ins.markdown
        ? Object.keys(sections).length
          ? `<div class="insight-grid">${Object.keys(INSIGHT_ICONS)
              .map((k) => `<section class="insight ${k}"><h4>${INSIGHT_ICONS[k]} ${k[0].toUpperCase()}${k.slice(1)}</h4><div class="md">${md(sections[k] || 'Unclear yet')}</div></section>`)
              .join('')}</div>`
          : `<div class="md">${md(ins.markdown)}</div>`
        : ''}
      ${ins.markdown ? `<p class="hint">${stale ? 'The brief has changed since; refresh for the latest. · ' : ''}From ${ago(ins.at)}.</p>` : ''}
    </div>`;
  return { button, box };
}

const OUTCOME = {
  done: ['✅', 'Done'],
  partial: ['🟡', 'Partial'],
  blocked: ['⛔', 'Blocked'],
  'in progress': ['🔄', 'In progress'],
};

/** End result, status and blockers: first thing a reviewer reads. */
function resultsCard(a) {
  const r = a.results;
  if (!r) return '';
  const [icon, label] = OUTCOME[r.outcome] ?? ['🔄', r.outcome];
  const item = (x, cls) => `<li class="${cls}">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${md(x.text).replace(/^<p>|<\/p>\s*$/g, '')}</a>` : md(x.text).replace(/^<p>|<\/p>\s*$/g, '')}</li>`;
  return `<div class="results ${r.outcome.replace(' ', '-')}">
    <h4>Results <span class="outcome">${icon} ${label}</span>${r.fromAgent ? '' : ' <span class="hint">(from what AI Agent Manager can see; the agent adds its own when it next updates its brief)</span>'}</h4>
    ${r.blockers.length ? `<ul class="blockers">${r.blockers.map((x) => item(x, 'blocker')).join('')}</ul>` : ''}
    ${r.delivered.length ? `<ul class="delivered">${r.delivered.map((x) => item(x, 'delivered')).join('')}</ul>` : '<p class="hint">Nothing delivered yet.</p>'}
    ${r.notes ? `<div class="md">${md(r.notes)}</div>` : ''}
  </div>`;
}

function briefPanel(a) {
  if (noRepo(a)) return '';
  const b = a.brief;
  const ex = explainBox(a);
  const rv = reviewBox(a);
  const ins = insightsBox(a);
  if (!b) {
    return `<div class="card brief">
      <h3>Brief <span class="brief-actions">${ins.button} ${ex.button} ${rv.button}</span></h3>
      ${planRow(a)}
      <div class="share-row"><span class="hint">Share for review:</span> ${docButtons(a)}</div>
      ${resultsCard(a)}
      ${ins.box}
      ${ex.box}
      ${rv.box}
      <p class="hint">Problem, solution, diagram and checks appear here once the agent writes its brief.
      ${a.lastStartedAt && !a.runtime.running ? ' Agents started before this feature write one after their next resume.' : ''}</p>
    </div>`;
  }
  const checks = b.checks.length
    ? `<ul class="checks">${b.checks
        .map((c) => `<li class="${c.state}"><span class="icon" title="${c.state}">${CHECK_ICON[c.state]}</span><span>${md(c.text).replace(/^<p>|<\/p>\s*$/g, '')}</span></li>`)
        .join('')}</ul>`
    : '<p class="hint">No checks yet.</p>';
  return `<div class="card brief">
    <h3>Brief <span class="brief-actions"><span title="${esc(b.updatedAt)}">updated ${ago(b.updatedAt)}</span> ${ins.button} ${ex.button} ${rv.button}</span></h3>
    ${planRow(a)}
    <div class="share-row"><span class="hint">Share for review:</span> ${docButtons(a)}</div>
    ${resultsCard(a)}
    ${ins.box}
    ${ex.box}
    ${rv.box}
    <div class="brief-grid">
      <section><h4>Problem</h4>${b.problem ? clamp(a, 'problem', md(b.problem)) : '<p class="hint">—</p>'}</section>
      <section><h4>Solution</h4>${b.solution ? clamp(a, 'solution', md(b.solution)) : '<p class="hint">—</p>'}</section>
      ${b.references?.length
        ? `<section class="wide"><h4>References <span class="hint">from the linked issue</span></h4>
            <ul class="refs">${b.references
              .map(
                (r) => `<li class="${r.key ? 'key' : ''} ${r.missing ? 'missing' : ''}">
                  <span class="ref-label">${esc(r.label)}</span>
                  ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title || r.url)}</a>` : ''}
                  ${r.highlight ? `<span class="ref-hl">${md(r.highlight).replace(/^<p>|<\/p>\s*$/g, '')}</span>` : ''}
                </li>`,
              )
              .join('')}</ul>
          </section>`
        : ''}
      <section class="wide"><h4>Design / flow</h4>
        ${b.diagram ? `<div class="diagram" data-mermaid="${esc(b.diagram)}"></div>` : '<p class="hint">No diagram yet.</p>'}
        ${b.diagramNotes ? `<div class="md">${md(b.diagramNotes)}</div>` : ''}
      </section>
      <section class="wide"><h4>Checks <span class="hint">${esc(checksSummary(b))}</span></h4>${checks}</section>
    </div>
  </div>`;
}

const pillText = (st) => (st === 'attention' ? 'needs input' : st);

/** "Cloning · Receiving objects 45% · 2.10 GiB · 2.40 MiB/s" */
function progressText(p) {
  if (!p) return '';
  const parts = [p.phase];
  if (p.step) parts.push(`${p.step} ${p.percent}%`);
  if (p.size) parts.push(p.size);
  if (p.rate) parts.push(p.rate);
  return parts.join(' · ');
}

function ago(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const copyBtn = (value) => `<button class="link" data-copy="${esc(value)}" title="Copy">⧉</button>`;

// ------------------------------------------------------------------ list

/** Agents waiting on you first, then running ones, then the rest. */
const rank = (a) => (a.runtime.attention ? 0 : a.runtime.running ? 1 : 2);

// Agents with no work and no input from you for a day sink below the active ones.
const ACTIVE_MS = 24 * 3600 * 1000;
const isActive = (a) =>
  Boolean(a.runtime.attention || a.runtime.busy || a.status === 'preparing' || (a.activeAt && Date.now() - Date.parse(a.activeAt) < ACTIVE_MS));

// Projects the user collapsed in the tree (kept per browser).
const collapsed = new Set(
  (() => {
    try {
      return JSON.parse(localStorage.getItem('agentmgr.collapsed') || '[]');
    } catch {
      return [];
    }
  })(),
);
function saveCollapsed() {
  try {
    localStorage.setItem('agentmgr.collapsed', JSON.stringify([...collapsed]));
  } catch {}
}

/** P0 solid red, P1 red outline, P3 muted; P2 (the default) only shown where asked. */
const prioChip = (p, { always = false } = {}) =>
  p === 2 && !always ? '' : `<span class="prio p${p}" title="Priority P${p}">P${p}</span>`;

const noRepo = (a) => a.kind === 'general' || a.kind === 'assistant';

function agentItem(a) {
  const st = statusOf(a);
  const idle = !isActive(a);
  return `<li data-id="${a.id}" ${a.kind === 'general' || a.kind === 'assistant' ? '' : 'draggable="true" '}class="agent pr${a.priority ?? 2} ${a.id === selectedId ? 'selected' : ''} ${idle ? 'idle' : ''}">
    <div class="line1">${prioChip(a.priority ?? 2)}${a.results?.outcome === 'blocked' ? '<span class="outcome-mark" title="Blocked">⛔</span>' : a.results?.outcome === 'done' ? '<span class="outcome-mark" title="Done">✅</span>' : ''}<span class="name">${esc(a.name)}</span>${flags(a)}<span class="pill ${st}">${pillText(st)}</span></div>
    <div class="intent">${a.kind === 'general' ? '<span class="tag">general</span> ' : a.kind === 'assistant' ? '<span class="tag assistant">assistant</span> ' : a.startedBy ? '<span class="tag assistant" title="Started by the assistant">🤖 by assistant</span> ' : a.trigger ? `<span class="tag assistant" title="Started from ${a.trigger.source === 'github' ? 'a labeled GitHub issue' : 'the webhook'}${a.trigger.url ? `: ${esc(a.trigger.url)}` : ''}">⚡ ${a.trigger.source === 'github' ? 'GitHub' : 'webhook'}</span> ` : a.playbook ? `<span class="tag assistant" title="Started by the playbook ${esc(a.playbook.name)}">▶ ${esc(a.playbook.name)}</span> ` : ''}${a.engine && a.engine !== 'claude' ? `<span class="tag engine">${esc(ENGINE_LABEL[a.engine] ?? a.engine)}</span> ` : ''}${esc(a.intent || (a.kind === 'assistant' ? 'Finds new work and starts agents for it' : 'General session'))}</div>
    ${a.status === 'preparing' && a.progress ? `<div class="progress-line">${esc(progressText(a.progress))}</div>` : ''}
    <div class="meta">
      <span class="mono">${a.id}</span>
      ${idle && a.activeAt ? `<span title="Idle: no work and no input from you for over a day">💤 ${ago(a.activeAt)}</span>` : ''}
      ${a.git?.branch ? `<span class="branch" title="${esc(a.git.branch)}">⎇ ${esc(a.git.branch)}</span>` : ''}
      ${a.prs.length ? `<span>${a.prs.length} PR</span>` : ''}
      ${a.bugs.length ? `<span>${a.bugs.length} bug</span>` : ''}
      ${a.usage?.total ? `<span title="${esc(usageTitle(a.usage))}">${fmtTokens(ioOf(a.usage))} tok</span>` : ''}
      ${(a.brief?.references ?? []).filter((r) => r.key && r.url).map((r) => `<span class="tag key-ref" title="${esc(r.title || r.url)}">${esc(r.label)}</span>`).join('')}
      ${a.brief?.summary?.total
        ? `<span class="${a.brief.summary.failed ? 'fail' : ''}" title="${esc(checksSummary(a.brief))}">✓${a.brief.summary.passed}/${a.brief.summary.total}${a.brief.summary.failed ? ` ✗${a.brief.summary.failed}` : ''}</span>`
        : ''}
      ${a.runtime.clients ? `<span title="terminals attached">◉ ${a.runtime.clients}</span>` : ''}
    </div>
  </li>`;
}

/** Agents grouped into projects, busiest and most urgent first. */
// Dragging an agent onto another project moves it there (as Edit → Project does). The list
// doesn't redraw mid-drag (updates arrive every few seconds), so the drag isn't lost.
let dragging = null;
let listStale = false;
/** What a drop on this project sends as the agent's project: its shortcut, else its name. */
const dropRef = (g) => (['assistant', 'general', 'other'].includes(g.key) ? '' : g.shortcut || g.name || '');

function projectGroups(list) {
  const groups = new Map();
  for (const a of list) {
    const p = a.projectInfo ?? { key: 'other', name: 'Other' };
    if (!groups.has(p.key)) groups.set(p.key, { ...p, agents: [] });
    if (p.shortcut) groups.get(p.key).shortcut = p.shortcut;
    groups.get(p.key).agents.push(a);
  }
  const out = [...groups.values()];
  for (const g of out) {
    // Active in the last day first; then highest priority, agents needing you, running ones, most recent.
    g.agents.sort(
      (a, b) =>
        isActive(b) - isActive(a) ||
        (a.priority ?? 2) - (b.priority ?? 2) ||
        rank(a) - rank(b) ||
        (b.activeAt ?? b.createdAt).localeCompare(a.activeAt ?? a.createdAt),
    );
    g.active = g.agents.filter(isActive).length;
    g.top = Math.min(...g.agents.map((a) => a.priority ?? 2));
    g.running = g.agents.filter((a) => a.runtime.running).length;
    g.waiting = g.agents.filter((a) => a.runtime.attention).length;
    g.tokens = g.agents.reduce((n, a) => n + (a.usage?.total ?? 0), 0);
  }
  // Two different repos with the same name: show org/name to tell them apart.
  const byName = Map.groupBy ? Map.groupBy(out, (g) => g.name) : null;
  for (const g of out) {
    const same = byName ? byName.get(g.name).length : out.filter((x) => x.name === g.name).length;
    g.label = same > 1 && g.full ? g.full : g.name;
  }
  const special = (g) => (g.key === 'assistant' ? -1 : g.key === 'general' ? 1 : g.key === 'other' ? 2 : 0);
  return out.sort(
    (a, b) =>
      special(a) - special(b) ||
      (b.active > 0) - (a.active > 0) ||
      a.top - b.top ||
      b.waiting - a.waiting ||
      b.running - a.running ||
      a.label.localeCompare(b.label),
  );
}

function renderList() {
  if (dragging) return void (listStale = true);
  const waiting = [...agents.values()].filter((a) => a.runtime.attention).length;
  document.title = waiting ? `(${waiting}) AI Agent Manager` : 'AI Agent Manager';
  // "@cc" shows one project; any other text also matches shortcuts.
  const at = filterText.startsWith('@') ? filterText.slice(1) : null;
  const list = [...agents.values()].filter((a) =>
    !filterText
      ? true
      : at !== null
        ? (a.projectInfo?.shortcut ?? '') === at || (at && (a.projectInfo?.shortcut ?? '').startsWith(at))
        : `${a.name} ${a.intent} ${a.repo ?? ''} ${a.workdir ?? ''} ${a.id} ${a.projectInfo?.name ?? ''} ${a.projectInfo?.shortcut ?? ''}`
            .toLowerCase()
            .includes(filterText),
  );
  // The open agent stays in the list even when it's older.
  const since = recent.on ? Date.now() - recent.days * 86_400_000 : 0;
  const shown = since ? list.filter((a) => a.id === selectedId || (Date.parse(a.createdAt) || 0) >= since) : list;
  const hidden = list.length - shown.length;
  $('#recent-bar').hidden = agents.size === 0;
  $('#recent-on').checked = recent.on;
  $('#recent-hidden').innerHTML = hidden ? `${hidden} older ${hidden === 1 ? 'agent' : 'agents'} hidden · <button class="link" id="recent-off">Show all</button>` : '';
  $('#empty').hidden = agents.size > 0;

  const all = [...agents.values()];
  const projects = new Set(all.map((a) => a.projectInfo?.key ?? 'other')).size;
  const running = all.filter((a) => a.runtime.running).length;
  $('#counts').innerHTML = agents.size
    ? `<span title="Projects">${projects} project${projects === 1 ? '' : 's'}</span><span>${agents.size} agents</span><span>${running} running</span>
       ${waiting ? `<span class="fail">${waiting} need${waiting === 1 ? 's' : ''} input</span>` : ''}
       <span class="spacer"></span><button class="link" id="import-btn" title="Continue Claude sessions you started in a terminal on this machine">Import</button><button class="link" id="flush-btn" title="Save session IDs, terminal scrollback and state to disk now (also automatic every 30s)">Save now</button>`
    : '';

  // Every agent a project has, also the ones a filter hides.
  const totals = new Map();
  for (const a of all) totals.set(a.projectInfo?.key ?? 'other', (totals.get(a.projectInfo?.key ?? 'other') ?? 0) + 1);

  $('#agent-list').innerHTML = projectGroups(shown)
    .map((g) => {
      const total = totals.get(g.key) ?? g.agents.length;
      const n = g.agents.length;
      // While filtering, show every match; otherwise respect collapsed projects.
      const open = filterText || !collapsed.has(g.key) || g.agents.some((a) => a.id === selectedId);
      return `<li class="project ${open ? 'open' : ''}" data-key="${esc(g.key)}" data-move="${esc(dropRef(g))}">
        <button class="project-head" data-toggle="${esc(g.key)}" aria-expanded="${open}" title="${esc(g.full || g.name)}">
          <span class="caret">${open ? '▾' : '▸'}</span>
          ${g.shortcut ? `<span class="shortcut" data-rename="${esc(g.shortcut)}" title="Shortcut: type @${esc(g.shortcut)} to filter, or use it as the project when adding agents (click to rename)">${esc(g.shortcut)}</span>` : ''}
          <span class="pname">${esc(g.label)}</span>
          <span class="pcounts">
            ${g.top <= 1 ? prioChip(g.top) : ''}
            ${g.waiting ? `<span class="pill attention" title="needs input">${g.waiting}</span>` : ''}
            ${g.running ? `<span class="prun" title="${g.running} running">● ${g.running}</span>` : ''}
            <span class="pcount" title="${total} agent${total === 1 ? '' : 's'} in this project${n < total ? `, ${n} shown` : ''}">${n < total ? `${n} of ${total}` : total} agent${total === 1 ? '' : 's'}</span>
          </span>
        </button>
        ${open ? `<ul class="project-agents">${g.agents.map(agentItem).join('')}</ul>` : ''}
      </li>`;
    })
    .join('');
}

// ------------------------------------------------------------------ backlog

const ITEM_ACTIONS = {
  queued: [['up', '▲', 'Move up'], ['down', '▼', 'Move down'], ['start', 'Start now', 'Start now, even if the project is at its limit'], ['cancel', 'Cancel', '']],
  active: [['open', 'Open', 'Open its agent'], ['accept', 'Done', 'Mark done now'], ['cancel', 'Cancel', '']],
  review: [['accept', 'Accept', 'Accept the work: done'], ['reopen', 'Reopen', 'Send it back to the same agent with a note'], ['open', 'Open', 'Open its agent']],
  blocked: [['start', 'Retry', 'Retry the agent'], ['open', 'Open', 'Open its agent'], ['cancel', 'Cancel', '']],
  done: [['reopen', 'Reopen', ''], ['open', 'Open', ''], ['remove', '✕', 'Remove from the list']],
  cancelled: [['remove', '✕', 'Remove from the list']],
};

function renderBacklog() {
  const open = backlogState.items.filter((i) => ['queued', 'active', 'review', 'blocked'].includes(i.status));
  const review = backlogState.items.filter((i) => i.status === 'review').length;
  $('#backlog-count').textContent = open.length ? String(open.length) : '';
  $('#backlog-count').className = `badge ${review ? 'attention' : ''}`;
  if (sideTab !== 'backlog') return;

  const items = backlogState.items.filter((i) => showCompleted || !['done', 'cancelled'].includes(i.status));
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.projectKey)) groups.set(it.projectKey, { key: it.projectKey, name: it.projectName, items: [] });
    groups.get(it.projectKey).items.push(it);
  }
  const proj = Object.fromEntries(backlogState.projects.map((p) => [p.key, p]));
  const count = (s) => backlogState.items.filter((i) => i.status === s).length;
  $('#backlog-view').innerHTML = `
    <div class="counts">
      <span>${count('queued')} queued</span><span>${count('active')} active</span>
      ${count('review') ? `<span class="fail">${count('review')} to review</span>` : '<span>0 to review</span>'}
      <span class="spacer"></span>
      <button class="link" data-bl="toggle-run" title="${backlogState.autoRun ? 'Stop starting new items (running ones continue)' : 'Start picking up queued items again'}">${backlogState.autoRun ? '⏸ Pause' : '▶ Resume'}</button>
      <button class="link" data-bl="add">+ Add</button>
      <button class="link" data-bl="playbooks" title="Saved requests you run again, by hand or on a schedule">Playbooks</button>
    </div>
    ${!backlogState.autoRun ? '<p class="hint bl-paused">Paused: queued items wait until you resume.</p>' : ''}
    ${items.length
      ? `<ul class="agent-list">${[...groups.values()]
          .map((g) => {
            const p = proj[g.key] ?? { limit: backlogState.defaultLimit };
            return `<li class="project open">
              <div class="project-head bl-head">
                ${p.shortcut ? `<span class="shortcut">${esc(p.shortcut)}</span>` : ''}
                <span class="pname">${esc(g.name)}</span>
                <button class="link" data-bl="limit" data-project="${esc(g.key)}" data-name="${esc(g.name)}" title="How many items of this project agents work on at once">${p.limit} at a time ✎</button>
              </div>
              <ul class="project-agents">${g.items.map(itemRow).join('')}</ul>
            </li>`;
          })
          .join('')}</ul>`
      : `<div class="empty"><p>The backlog is empty.</p><p>Add asks with <b>+ Add</b> (or <b>+ New agents</b> → Queue in backlog). Agents pick them up one by one, ${backlogState.defaultLimit} at a time per project, until each is done.</p></div>`}
    <p class="hint bl-foot"><label><input type="checkbox" data-bl="completed" ${showCompleted ? 'checked' : ''}/> Show done and cancelled</label></p>`;
}

function itemRow(it) {
  const a = it.agent;
  const st = it.status === 'active' && a?.attention ? 'attention' : it.status;
  return `<li class="agent bl-item ${it.status}" data-item="${it.id}">
    <div class="line1">
      <button class="prio p${it.priority}" data-bl="prio" title="Priority (click to change)">P${it.priority}</button>
      <span class="name">${esc(it.title)}</span>
      <span class="pill ${st === 'review' ? 'waiting' : st === 'active' ? 'working' : st}">${st === 'attention' ? 'needs input' : st}</span>
    </div>
    <div class="meta">
      <span class="mono">${it.id}</span>
      ${a ? `<span>agent <a href="#${a.id}" data-bl="open">${esc(a.name)}</a>${a.briefStatus ? ` · brief: ${esc(a.briefStatus)}` : ''}</span>` : ''}
      ${it.base ? `<span>⎇ from ${esc(it.base)}</span>` : ''}
      ${it.doneAt ? `<span>done ${ago(it.doneAt)}</span>` : it.reviewAt ? `<span>ready ${ago(it.reviewAt)}</span>` : it.startedAt ? `<span>started ${ago(it.startedAt)}</span>` : `<span>added ${ago(it.createdAt)}</span>`}
    </div>
    ${it.status === 'queued' && it.aiHold ? `<p class="hint bl-ai">🤖 Waits for <b>${esc(it.aiHold.afterTitle)}</b>${it.aiHold.reason ? `: ${esc(it.aiHold.reason)}` : ''}</p>` : ''}
    ${it.status === 'queued' && it.aiSplit ? `<div class="hint bl-ai">🤖 Could be split${it.aiSplit.reason ? ` (${esc(it.aiSplit.reason)})` : ''}:<ul>${it.aiSplit.parts.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      <button class="small" data-bl="split">Split into ${it.aiSplit.parts.length}</button> <button class="small ghost" data-bl="keep-whole">Keep whole</button></div>` : ''}
    <div class="bl-actions">${(ITEM_ACTIONS[it.status] ?? []).map(([act, label, title]) => `<button class="small" data-bl="${act}" title="${esc(title)}">${label}</button>`).join('')}</div>
  </li>`;
}

function showTab(tab) {
  sideTab = tab;
  for (const b of document.querySelectorAll('.side-tab')) b.classList.toggle('active', b.dataset.tab === tab);
  $('#agents-view').hidden = tab !== 'agents';
  $('#backlog-view').hidden = tab !== 'backlog';
  $('#inbox-view').hidden = tab !== 'inbox';
  $('#land-view').hidden = tab !== 'land';
  if (tab === 'inbox') loadJudge();
  if (tab === 'land') landUi.load();
  renderBacklog();
  renderInbox();
}
for (const b of document.querySelectorAll('.side-tab')) b.onclick = () => showTab(b.dataset.tab);

$('#backlog-view').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-bl]');
  if (!el) return;
  const what = el.dataset.bl;
  const id = el.closest('[data-item]')?.dataset.item;
  const it = backlogState.items.find((x) => x.id === id);
  if (what === 'completed') {
    showCompleted = el.checked;
    return renderBacklog();
  }
  e.preventDefault();
  const blApi = (method, route, body) => act(() => api(method, route, body));
  switch (what) {
    case 'toggle-run':
      return blApi('POST', '/backlog/settings', { autoRun: !backlogState.autoRun });
    case 'add':
      return openNewDialog('backlog');
    case 'playbooks':
      return playbooksUi.open();
    case 'limit': {
      const n = prompt(`How many "${el.dataset.name}" items should agents work on at once?`, el.textContent.split(' ')[0]);
      if (n === null) return;
      return blApi('POST', '/backlog/settings', { project: el.dataset.project, limit: Number(n) });
    }
    case 'prio':
      return blApi('PATCH', `/backlog/${id}`, { priority: (it.priority + 1) % 4 });
    case 'up':
    case 'down':
      return blApi('POST', `/backlog/${id}/move`, { where: what });
    case 'start':
      return blApi('POST', `/backlog/${id}/start`);
    case 'accept':
      return blApi('POST', `/backlog/${id}/accept`);
    case 'reopen': {
      const note = prompt('What still needs doing? (sent to the same agent)', '');
      if (note === null) return;
      return blApi('POST', `/backlog/${id}/reopen`, { note });
    }
    case 'cancel':
      if (!confirm('Cancel this item? Its agent (if any) keeps its session; close or delete it separately.')) return;
      return blApi('POST', `/backlog/${id}/cancel`);
    case 'remove':
      return blApi('DELETE', `/backlog/${id}`);
    case 'split':
      return blApi('POST', `/backlog/${id}/split`, { parts: it.aiSplit.parts });
    case 'keep-whole':
      return blApi('POST', `/backlog/${id}/keep-whole`);
    case 'open': {
      const agentId = it?.agent?.id;
      if (!agentId) return;
      showTab('agents');
      return select(agentId);
    }
  }
});

// ------------------------------------------------------------------ needs you (inbox)

/** Small markers in the agent list: stuck, overlapping, asking, racing, forked. */
function flags(a) {
  const q = (a.questions ?? []).filter((x) => !x.answer).length;
  return [
    a.stuck?.length ? `<span class="flag warn" title="May be stuck: ${esc(a.stuck[0].title)}">↻</span>` : '',
    a.conflicts?.length ? `<span class="flag warn" title="Changes the same files as ${esc(a.conflicts.map((c) => c.agent.name).join(', '))}">⚔</span>` : '',
    q ? `<span class="flag ask" title="${q} open question${q > 1 ? 's' : ''}">?${q > 1 ? q : ''}</span>` : '',
    a.raceId ? `<span class="flag" title="Race attempt${a.variant?.label ? `: ${esc(a.variant.label)}` : ''}">🏁</span>` : '',
    a.team ? `<span class="flag role" title="Team ${esc(teams.get(a.team.id)?.name ?? '')}: ${esc(a.team.role)}">👥 ${esc(a.team.role)}${a.team.n && teams.get(a.team.id)?.settings.critics > 1 ? ` ${a.team.n}` : ''}</span>` : '',
    a.forkOf ? `<span class="flag" title="Fork of ${esc(a.forkOf.name)}">⑂</span>` : '',
  ].join('');
}

const TRIAGED = { now: 'sent (AI: urgent)', digest: 'held for the digest', skip: 'dropped by the AI judge' };
const NEED_ORDER = { prompt: 0, waiting: 1, plan: 1, question: 1, team: 1, review: 2, stuck: 3, conflict: 4 };
/** What an agent needs from the user. `both`: overlaps on both agents (detail), else only the one that should rebase (inbox). */
function needsFor(a, { both = false } = {}) {
  const items = [];
  if (a.runtime.attention) items.push({ a, kind: 'prompt', key: `prompt:${a.id}` });
  if (a.runtime.waiting) items.push({ a, kind: 'waiting', key: `waiting:${a.id}` });
  if (a.planReview?.status === 'review') items.push({ a, kind: 'plan', key: `plan:${a.id}` });
  if (a.aiReview?.verdict && !a.aiReview.seen) items.push({ a, kind: 'review', key: `review:${a.id}` });
  for (const q of a.questions ?? []) if (!q.answer) items.push({ a, kind: 'question', key: `q:${a.id}:${q.id}`, q });
  for (const f of a.stuck ?? []) items.push({ a, kind: 'stuck', key: `stuck:${a.id}:${f.key}`, f });
  for (const g of a.conflicts ?? []) if (both || g.mergeFirst !== a.id) items.push({ a, kind: 'conflict', key: `conflict:${a.id}:${g.agent.id}`, g });
  return items;
}
/** Teams waiting on you (approved, or stuck on a disagreement), shown on the lead or the implementer. */
const teamOwner = (t) => t.members.find((m) => m.role === 'lead' || m.role === 'implementer')?.id;
function teamNeeds() {
  return [...teams.values()]
    .filter((t) => ['ready', 'blocked'].includes(t.stage) && agents.has(teamOwner(t)))
    .map((t) => ({ a: agents.get(teamOwner(t)), kind: 'team', key: `team:${t.id}`, t }));
}
function inboxItems() {
  return [...[...agents.values()].flatMap((a) => needsFor(a)), ...teamNeeds()]
    .sort((x, y) => NEED_ORDER[x.kind] - NEED_ORDER[y.kind] || (x.a.priority ?? 2) - (y.a.priority ?? 2));
}

const NEED_LABEL = { team: 'Team', prompt: 'Needs input', waiting: 'Waiting on you', plan: 'Plan review', question: 'Question', review: 'AI review', stuck: 'Stuck?', conflict: 'Overlap' };
/** Why the AI judge thinks so, as a small tag. */
const aiTag = (confidence, what = 'AI') => `<span class="tag ai" title="Judged by a model from the agent's activity; your reactions tune later calls">🤖 ${what}${confidence != null ? ` ${Math.round(confidence * 100)}%` : ''}</span>`;
function needCard(it, { inDetail = false } = {}) {
  const { a } = it;
  const who = inDetail
    ? ''
    : `<a href="#${a.id}" class="need-agent" data-goto="${a.id}">${prioChip(a.priority ?? 2)}${esc(a.name)}</a>${a.projectInfo?.name ? ` <span class="hint">${esc(a.projectInfo.name)}</span>` : ''}`;
  const head = `<div class="need-head"><span class="need-kind ${it.kind}">${NEED_LABEL[it.kind]}</span>${who}</div>`;
  const draft = (k, fallback = '') => esc(needDrafts.get(`${it.key}:${k}`) ?? fallback);
  let body = '';
  if (it.kind === 'prompt') {
    const p = a.runtime.prompt;
    body = `<p class="need-title">${esc(p?.question || a.runtime.attention)}</p>
      <div class="need-actions">
        ${(p?.choices ?? []).map((c) => `<button class="small ${c.key === '1' ? 'primary' : ''}" data-ib="key" data-key="${c.key}">${c.key}. ${esc(c.label)}</button>`).join('')}
        <button class="small" data-ib="key" data-key="esc" title="Escape">Esc</button>
        <button class="small ghost" data-ib="terminal">Open terminal</button>
      </div>`;
  } else if (it.kind === 'waiting') {
    const w = a.runtime.waiting;
    body = `<p class="need-title">${esc(w.question || w.summary)} ${aiTag(w.confidence, w.state === 'error' ? 'looks like an error' : 'read from its screen')}</p>
      ${w.question && w.summary !== w.question ? `<p class="hint">${esc(w.summary)}</p>` : ''}
      ${w.choices?.length ? `<div class="need-actions">${w.choices.slice(0, 6).map((c) => `<button class="small" data-ib="waiting-choice" data-text="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}
      <form class="need-reply" data-ib-form="waiting">
        <input data-draft="${esc(it.key)}:text" placeholder="${w.state === 'error' ? 'Tell it what to do…' : 'Type an answer…'}" value="${draft('text')}" />
        <button class="small primary">Send</button>
      </form>
      <div class="need-actions"><button class="small ghost" data-ib="terminal">Open terminal</button><button class="small ghost" data-ib="waiting-dismiss" title="It isn't waiting on you; the judge learns from this">Not waiting</button></div>`;
  } else if (it.kind === 'review') {
    const r = a.aiReview;
    body = `<p class="need-title"><span class="verdict ${esc(r.verdict)}">${REVIEW_VERDICT[r.verdict] ?? esc(r.verdict)}</span> ${esc(r.summary)} ${aiTag(r.confidence, 'review')}</p>
      ${r.met.length ? `<p class="hint">Met: ${r.met.map(esc).join('; ')}</p>` : ''}
      ${r.missing.length ? `<ul class="need-files">${r.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
      ${r.risks.length ? `<p class="hint">Risks: ${r.risks.map(esc).join('; ')}</p>` : ''}
      <div class="need-actions">
        ${r.missing.length ? '<button class="small primary" data-ib="review-finish" title="Send the missing items to the agent">Send back to finish</button>' : ''}
        <button class="small ${r.missing.length ? '' : 'primary'}" data-ib="review-accept">Looks good</button>
      </div>`;
  } else if (it.kind === 'team') {
    const t = it.t;
    body = `<p class="need-title">${t.stage === 'ready' ? `✓ The reviewer approved <b>${esc(t.name)}</b>${t.gaps ? ', with parts still missing: run a gap round?' : ''}` : `<b>${esc(t.name)}</b> needs a decision: ${esc(t.blocked?.reason ?? '')}`}</p>
      <p class="hint">${esc(t.intent.split('\n')[0].slice(0, 140))}</p>
      <div class="need-actions"><button class="small primary" data-ib="team-open" data-team="${t.id}">${t.stage !== 'ready' ? 'Decide' : t.gaps ? 'See the gaps' : 'Review and finalize'}</button></div>`;
  } else if (it.kind === 'plan') {
    const title = a.planReview.markdown?.match(/^#\s+(.+)$/m)?.[1] ?? 'Implementation plan';
    body = `<p class="need-title">${esc(title)}</p>
      <p class="hint">Written ${ago(a.planReview.updatedAt)}. The agent waits for your approval before changing anything.</p>
      <div class="need-actions"><button class="small primary" data-ib="plan-open">Review plan</button><button class="small" data-ib="plan-approve">Approve as is</button></div>`;
  } else if (it.kind === 'question') {
    const q = it.q;
    body = `<p class="need-title">${esc(q.question)}</p>
      ${q.context ? `<p class="hint">${esc(q.context)}</p>` : ''}
      ${q.default ? `<p class="hint">Proceeding with <b>${esc(q.default)}</b> until you answer.</p>` : ''}
      <div class="need-actions">${q.options.map((o) => `<button class="small" data-ib="answer" data-text="${esc(o)}">${esc(o)}</button>`).join('')}</div>
      <form class="need-reply" data-ib-form="answer" data-q="${q.id}">
        <input data-draft="${esc(it.key)}:text" placeholder="Or type an answer…" value="${draft('text')}" />
        <button class="small primary">Send</button>
      </form>`;
  } else if (it.kind === 'stuck') {
    const f = it.f;
    const judged = f.ai?.verdict === 'stuck' ? aiTag(f.ai.confidence, 'confirmed') : f.ai?.verdict === 'checking' ? '<span class="tag ai">🤖 checking…</span>' : '';
    body = `<p class="need-title">${esc(f.title)} <span class="hint">since ${ago(f.since)}</span> ${judged}</p>
      <p class="hint">${esc(f.detail)}</p>
      ${f.ai?.rule && f.ai.rule !== f.title ? `<p class="hint">Flagged by: ${esc(f.ai.rule)}</p>` : ''}
      <form class="need-reply col" data-ib-form="nudge" data-k="${esc(f.key)}">
        <textarea rows="3" data-draft="${esc(it.key)}:text">${draft('text', f.nudge)}</textarea>
        <div class="need-actions"><button class="small primary">Send nudge</button><button type="button" class="small ghost" data-ib="dismiss">Dismiss</button></div>
      </form>`;
  } else {
    const g = it.g;
    const lines = g.files.filter((f) => f.severity === 'lines').length;
    const first = g.mergeFirst === a.id ? `${esc(a.name)} lands first; ${esc(g.agent.name)} rebases onto it` : `${esc(g.agent.name)} lands first; ${esc(a.name)} rebases onto it`;
    const other = `<a href="#${g.agent.id}" data-goto="${g.agent.id}">${esc(g.agent.name)}</a>`;
    const tag = g.ai?.checking ? '<span class="tag ai">🤖 checking…</span>' : g.ai?.reason ? aiTag(g.ai.confidence, g.ai.conflict ? 'collision' : 'no collision') : '';
    body = `<p class="need-title">${g.files.length ? `Changes the same ${g.files.length === 1 ? 'file' : 'files'} as ${other}` : `May collide with ${other}`}${lines ? ` <span class="tag fail">${lines} on the same lines</span>` : ''} ${tag}</p>
      ${g.ai?.reason ? `<p class="hint">${esc(g.ai.reason)}</p>` : ''}
      ${g.files.length ? `<ul class="need-files">${g.files.slice(0, 8).map((f) => `<li><code>${esc(f.file)}</code>${f.severity === 'lines' ? ' <span class="hint">same lines</span>' : ''}</li>`).join('')}${g.files.length > 8 ? `<li class="hint">…and ${g.files.length - 8} more</li>` : ''}</ul>` : ''}
      <p class="hint">Suggested order: ${first}.${g.ai?.orderReason ? ` ${esc(g.ai.orderReason)}` : ''}</p>
      <div class="need-actions">
        <button class="small" data-ib="warn" data-with="${g.agent.id}" title="Tell ${esc(a.name)} about the overlap">Tell ${esc(a.name)}</button>
        <button class="small" data-ib="warn-both" data-with="${g.agent.id}" title="Tell both agents">Tell both</button>
        ${g.ai && !g.ai.checking ? `<button class="small ghost" data-ib="clash-dismiss" data-with="${g.agent.id}" title="They don't collide; the judge learns from this">Not a clash</button>` : ''}
      </div>`;
  }
  return `<div class="need ${it.kind}" data-need="${esc(it.key)}" data-agent="${a.id}">${head}${body}</div>`;
}

const needDrafts = new Map(); // typed text survives live re-renders
document.addEventListener('input', (e) => {
  if (e.target.dataset?.draft) needDrafts.set(e.target.dataset.draft, e.target.value);
});

/** The AI judge's state for the line under the inbox: it spends calls on the user's own plan. */
let judgeStatus = null;
async function loadJudge() {
  try {
    judgeStatus = await api('GET', '/judge');
  } catch {
    judgeStatus = null;
  }
  renderInbox();
}

function judgeLine() {
  const j = judgeStatus;
  if (!j) return '';
  const text = j.enabled
    ? `🤖 AI judge on: ${j.calls} of ${j.cap} calls today, on your own Claude or Codex plan. It checks stuck agents, idle screens, finished work, overlaps, backlog order and alerts.`
    : '🤖 AI judge off: stuck agents, idle screens and alerts use fixed rules only.';
  return `<p class="judge-line hint">${esc(text)} <button class="small ghost" data-judge="${j.enabled ? 'off' : 'on'}">${j.enabled ? 'Turn off' : 'Turn on'}</button></p>`;
}

function renderInbox() {
  const items = inboxItems();
  const urgent = items.filter((i) => i.kind === 'prompt' || i.kind === 'question' || i.kind === 'waiting').length;
  $('#inbox-count').textContent = items.length ? String(items.length) : '';
  $('#inbox-count').className = `badge ${urgent ? 'attention' : ''}`;
  if (sideTab !== 'inbox') return;
  const view = $('#inbox-view');
  if (view.contains(document.activeElement) && document.activeElement.dataset.draft) return; // don't yank the field being typed in
  view.innerHTML = items.length
    ? `<div class="counts"><span>${items.length} waiting on you</span></div><div class="needs inbox">${items.map((it) => needCard(it)).join('')}</div>`
    : `<div class="empty"><p>Nothing needs you right now.</p><p>Prompts waiting for an answer, questions agents ask, agents that seem stuck and agents editing the same files show up here.</p></div>`;
  view.insertAdjacentHTML('beforeend', judgeLine());
}

async function onNeed(e) {
  const judge = e.target.closest('[data-judge]');
  if (judge) {
    e.preventDefault();
    return act(async () => {
      judgeStatus = await api('PUT', '/judge', { enabled: judge.dataset.judge === 'on' });
      renderInbox();
    }, judge.dataset.judge === 'on' ? 'AI judge on' : 'AI judge off');
  }
  const goto = e.target.closest('[data-goto]');
  if (goto) {
    e.preventDefault();
    showTab('agents');
    return select(goto.dataset.goto);
  }
  const el = e.target.closest('[data-ib]');
  if (!el) return;
  e.preventDefault();
  const card = el.closest('[data-need]');
  const id = card.dataset.agent;
  const key = card.dataset.need;
  switch (el.dataset.ib) {
    case 'key':
      return act(() => api('POST', `/agents/${id}/prompt-key`, { key: el.dataset.key }), 'Sent');
    case 'terminal':
      showTab('agents');
      select(id);
      return term.open(id);
    case 'answer': {
      const q = key.split(':')[2];
      return act(async () => upsert(await api('POST', `/agents/${id}/answer`, { question: q, text: el.dataset.text })), 'Answer sent');
    }
    case 'team-open':
      return openTeam(el.dataset.team);
    case 'plan-open':
      return openPlan(id);
    case 'plan-approve':
      return act(async () => upsert(await api('POST', `/agents/${id}/plan/approve`, {})), 'Approved; the agent is implementing it');
    case 'clash-dismiss':
      return act(async () => upsert(await api('POST', `/agents/${id}/conflicts/dismiss`, { with: el.dataset.with })));
    case 'waiting-choice':
      return act(async () => upsert(await api('POST', `/agents/${id}/waiting/answer`, { text: el.dataset.text })), 'Answer queued');
    case 'waiting-dismiss':
      return act(async () => upsert(await api('POST', `/agents/${id}/waiting/dismiss`)));
    case 'review-finish':
      return act(async () => upsert(await api('POST', `/agents/${id}/review/ack`, { action: 'finish' })), 'Sent back with the missing items');
    case 'review-accept':
      return act(async () => upsert(await api('POST', `/agents/${id}/review/ack`, { action: 'accept' })));
    case 'dismiss':
      return act(async () => upsert(await api('POST', `/agents/${id}/stuck/dismiss`, { key: card.querySelector('[data-k]').dataset.k })));
    case 'warn':
      return act(async () => upsert(await api('POST', `/agents/${id}/conflicts/warn`, { with: el.dataset.with })), 'Queued for the agent');
    case 'warn-both':
      return act(async () => {
        upsert(await api('POST', `/agents/${id}/conflicts/warn`, { with: el.dataset.with }));
        upsert(await api('POST', `/agents/${el.dataset.with}/conflicts/warn`, { with: id }));
      }, 'Queued for both agents');
  }
}
async function onNeedSubmit(e) {
  const form = e.target.closest('[data-ib-form]');
  if (!form) return;
  e.preventDefault();
  const card = form.closest('[data-need]');
  const id = card.dataset.agent;
  const field = form.querySelector('[data-draft]');
  const text = field.value.trim();
  if (!text) return;
  const done = () => needDrafts.delete(field.dataset.draft);
  if (form.dataset.ibForm === 'waiting') {
    await act(async () => upsert(await api('POST', `/agents/${id}/waiting/answer`, { text })), 'Answer queued');
  } else if (form.dataset.ibForm === 'answer') {
    await act(async () => upsert(await api('POST', `/agents/${id}/answer`, { question: form.dataset.q, text })), 'Answer sent');
  } else {
    await act(async () => upsert(await api('POST', `/agents/${id}/stuck/nudge`, { key: form.dataset.k, text })), 'Nudge queued');
  }
  done();
}
for (const root of [$('#inbox-view'), $('#detail-body')]) {
  root.addEventListener('click', onNeed);
  root.addEventListener('submit', onNeedSubmit);
}

// ------------------------------------------------------------------ checkpoints and forks

function checkpointsCard(a) {
  if (noRepo(a) || !a.git?.branch) return '';
  const cps = [...(a.checkpoints ?? [])].reverse();
  const forks = [...agents.values()].filter((x) => x.forkOf?.agentId === a.id);
  return `<div class="card">
    <h3>Checkpoints <span>${cps.length || ''}</span> <span class="spacer"></span><button class="small" data-act="checkpoint" title="Save the code and conversation as they are now">Save now</button></h3>
    <p class="hint">Saved at the end of each turn: the code (including uncommitted work) and the conversation up to that point. Fork from one to try a different direction from there.</p>
    ${cps.length
      ? `<ul class="links checkpoints">${cps
          .slice(0, 12)
          .map((c) => `<li><span class="mono">#${c.n}</span><span class="grow" title="${esc(c.prompt ?? '')}">${esc(c.prompt ?? 'checkpoint')}</span><span class="hint">${ago(c.at)}</span><button class="small" data-fork-cp="${c.n}">Fork from here</button></li>`)
          .join('')}</ul>`
      : '<p class="none">None yet: the first one is saved when the agent finishes a turn.</p>'}
    ${forks.length ? `<p class="hint">Forks: ${forks.map((f) => `<a href="#${f.id}" data-goto="${f.id}">${esc(f.name)}</a>`).join(', ')}</p>` : ''}
  </div>`;
}

$('#detail-body').addEventListener('click', (e) => {
  const cp = e.target.closest('[data-fork-cp]');
  if (cp) forkAgent(selectedId, Number(cp.dataset.forkCp));
  const race = e.target.closest('[data-race-open]');
  if (race) openRace(race.dataset.raceOpen);
  const team = e.target.closest('[data-team-open]');
  if (team) openTeam(team.dataset.teamOpen);
});

function forkAgent(id, checkpoint) {
  const how = prompt(
    `Fork ${agents.get(id)?.name}${checkpoint ? ` from checkpoint ${checkpoint}` : ''}: a new agent with the same code and conversation.\n\nWhat should the fork do differently? (optional, sent as its first message)`,
    '',
  );
  if (how === null) return;
  act(async () => {
    const fork = await api('POST', `/agents/${id}/fork`, { checkpoint, instructions: how || undefined });
    upsert(fork);
    select(fork.id);
  }, 'Fork created');
}

// ------------------------------------------------------------------ teams

const TEAM_STEPS = [['analyze', 'Analyze'], ['discuss', 'Discuss'], ['implement', 'Implement'], ['test', 'Test'], ['review', 'Review'], ['ready', 'Your call'], ['done', 'Done']];
const STAGE_TEXT = { analyze: 'analyzing', discuss: 'discussing the analysis', implement: 'implementing', test: 'testing', review: 'reviewing', ready: 'approved, waiting for you', gaps: 'starting a round for the gaps', finalizing: 'opening the PR', done: 'done; ready for the next request', blocked: 'waiting for your decision', stopped: 'stopped' };
const GOOD = new Set(['ready', 'agree', 'done', 'pass', 'approve']);
const ROLE_NAME = (m) => `${m.role[0].toUpperCase()}${m.role.slice(1)}${m.n && teams.get(openTeamId)?.settings.critics > 1 ? ` ${m.n}` : ''}`;

function teamBanner(a) {
  if (!a.team) return '';
  const t = teams.get(a.team.id);
  const turn = t?.waiting?.some((w) => w.member === a.id && !w.verdict);
  return `<div class="bl-banner team">👥 <b>${esc(a.team.role)}</b> on team <b>${esc(t?.name ?? a.team.id)}</b>${t?.mode === 'lead' ? ` · quest ${t.quest ?? 1}` : ''}${t ? ` · ${esc(STAGE_TEXT[t.stage] ?? t.stage)}${t.loop > 1 ? ` · round ${t.loop}` : ''}` : ''}${turn ? ' · <b>its turn</b>' : ''}
    <span class="spacer"></span><button class="small primary" data-team-open="${a.team.id}">Open team</button></div>`;
}

function openTeam(id) {
  openTeamId = id;
  teamFile = null;
  renderTeam();
  if (!$('#team-dialog').open) $('#team-dialog').showModal();
  act(async () => teams.set(id, await api('GET', `/teams/${id}`)));
}

function teamSteps(t) {
  const at = ['finalizing', 'gaps'].includes(t.stage) ? 'ready' : t.stage;
  const idx = TEAM_STEPS.findIndex(([k]) => k === at);
  const stopped = ['blocked', 'stopped'].includes(t.stage);
  // Where a blocked or stopped team got to: the last step anyone finished.
  const reached = stopped ? Math.max(0, ...t.history.map((h) => TEAM_STEPS.findIndex(([k]) => k === h.stage))) : idx;
  return TEAM_STEPS.filter(([k]) => k !== 'discuss' || t.settings.critics)
    .map(([k, label]) => {
      const i = TEAM_STEPS.findIndex(([x]) => x === k);
      const cls = stopped ? (i < reached ? 'done' : i === reached ? 'stop' : '') : i < idx || t.stage === 'done' ? 'done' : i === idx ? 'now' : '';
      return `<span class="team-step ${cls}">${label}</span>`;
    })
    .join('<span class="team-arrow">→</span>');
}

function renderTeam() {
  const dlg = $('#team-dialog');
  if (!dlg.open && !openTeamId) return;
  const t = teams.get(openTeamId);
  if (!t) {
    $('#team-body').innerHTML = '<p class="hint">Loading…</p>';
    return;
  }
  if ($('#team-body').contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') return;
  const openQuests = new Set([...$('#team-body').querySelectorAll('details.team-quest[open] summary b')].map((b) => b.textContent));
  $('#team-title').textContent = `Team: ${t.name}`;
  $('#team-stop').hidden = ['done', 'stopped'].includes(t.stage);
  const memberOf = (id) => t.members.find((m) => m.id === id);
  const gate =
    t.stage === 'ready'
      ? `<div class="team-gate">${t.gaps
          ? `<b>✓ The reviewer approved the work so far, but parts of the request aren't built yet:</b>
             ${t.gapList ? `<article class="md team-gaps">${md(t.gapList)}</article>` : ''}
             <div class="need-actions"><button class="small primary" data-team-act="fix-gaps" title="Another round, from analysis to review, for what is missing (and your note below)">Run a gap round</button></div>
             <p class="hint">Or take the work as it is:</p>`
          : '<b>✓ The reviewer approved it.</b> Look at the review and the changes, then:'}
          <div class="need-actions">${t.remote
            ? `<button class="small${t.gaps ? '' : ' primary'}" data-team-act="pr">Open a pull request</button>`
            : `<button class="small${t.gaps ? '' : ' primary'}" data-team-act="merge" title="Fast-forward ${esc(t.folder ?? '')} to the team's branch">Merge into main</button>
               <button class="small" data-team-act="publish" title="The implementer creates a private GitHub repository, pushes and opens a pull request">Publish to GitHub</button>`}
            <button class="small" data-team-act="keep">Keep the branch${t.remote ? ', no PR' : ''}</button></div>
          <textarea id="team-note" rows="2" placeholder="${t.gaps ? 'A note for the gap round, or' : 'Or say'} what should change; the implementer fixes it and it goes through test and review again"></textarea>
          <div class="need-actions"><button class="small" data-team-act="send-back">Send back</button></div></div>`
      : t.stage === 'blocked'
        ? `<div class="team-gate blocked"><b>${esc(t.blocked.reason)}</b>
            <textarea id="team-note" rows="2" placeholder="Optional note for the next round"></textarea>
            <div class="need-actions">
              ${t.blocked.at !== 'member' ? `<button class="small primary" data-team-act="continue">${t.blocked.at === 'discuss' ? 'One more round' : 'One more fix round'}</button>` : ''}
              ${t.blocked.at === 'discuss' ? '<button class="small" data-team-act="skip" title="Implement the latest analysis as it is">Implement the latest analysis</button>' : ''}
              ${t.blocked.at === 'loops' ? '<button class="small" data-team-act="skip" title="Move to your final review without another round">Accept as is</button>' : ''}
            </div></div>`
        : t.stage === 'done' && t.gaps
          ? `<div class="team-gate"><b>The last review lists parts of the request that aren't built yet:</b>
              ${t.gapList ? `<article class="md team-gaps">${md(t.gapList)}</article>` : ''}
              <textarea id="team-note" rows="2" placeholder="Optional note for the gap round"></textarea>
              <div class="need-actions"><button class="small primary" data-team-act="fix-gaps">Run a gap round</button></div></div>`
          : '';
  const quest = t.mode === 'lead' || t.quest > 1 ? `<p class="hint">Quest ${t.quest ?? 1}${t.gapRound ? ` · gap round ${t.gapRound}` : ''}${t.quests?.length ? ` · ${t.quests.length} earlier` : ''}</p>` : '';
  const handoffs = (list) =>
    `<ul class="team-timeline">${list.slice().reverse().map((h) => {
      const m = memberOf(h.member);
      const who = t.mode === 'lead' ? `${h.role[0].toUpperCase()}${h.role.slice(1)}${h.n && t.settings.critics > 1 ? ` ${h.n}` : ''}` : m ? ROLE_NAME(m) : esc(h.role);
      return `<li><span><b>${who}</b> <span class="hint">${ago(h.at)}${h.loop > 1 && ['implement', 'test', 'review'].includes(h.stage) ? ` · r${h.loop}` : ''}</span></span>
        <span><span class="verdict-word ${GOOD.has(h.verdict) ? 'good' : 'bad'}">${esc(h.verdict)}</span></span>
        <span><a href="#" data-team-file="${esc(h.file)}">${esc(h.file.split('/').pop())}</a> <span class="summary">${esc(h.summary)}</span></span></li>`;
    }).join('')}</ul>`;
  const asking = t.mode === 'lead' && t.stage !== 'stopped'
    ? `<form class="team-ask" id="team-ask"><b>New request</b> <span class="hint">The lead runs it through the team as the next quest. You can also just type it in the lead's terminal.</span>
        <textarea id="team-ask-text" rows="2" placeholder="Now add a --json flag to the output"></textarea>
        <div class="need-actions"><button class="small${['ready', 'done'].includes(t.stage) ? ' primary' : ''}">Give to the team</button></div></form>`
    : '';
  $('#team-body').innerHTML = `
    ${quest}
    <p>${esc(t.request ?? t.intent)}</p>
    <div class="team-steps">${teamSteps(t)}</div>
    <p class="hint">${esc(STAGE_TEXT[t.stage] ?? t.stage)}${t.settings.critics ? ` · analysis round ${t.round}` : ''} · build round ${t.loop}${t.newProject ? ` · new project in <code>${esc(t.newProject)}</code>` : ''}${t.branch ? ` · branch <code>${esc(t.branch)}</code>` : ''}${t.outcome === 'merged' ? ' · merged into main' : ''}${t.costUsd ? ` · ${fmtCost(t.costUsd)}` : ''}
      ${t.prs.map((p) => ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">PR #${p.number ?? ''}</a>`).join('')}</p>
    ${gate}
    <div class="race-table-wrap"><table class="race-table">
      <tr><th>Role</th><th>Agent</th><th>Status</th><th>Model</th><th>Cost</th></tr>
      ${t.members.map((m) => {
        const a = agents.get(m.id);
        const st = a ? statusOf(a) : m.status;
        return `<tr class="${m.turn ? 'diffing' : ''}"><td><b>${ROLE_NAME(m)}</b>${m.turn ? ' <span class="tag open">its turn</span>' : ''}</td>
          <td>${a ? `<a href="#${m.id}" data-team-goto="${m.id}">${esc(m.name)}</a>` : '<span class="hint">deleted</span>'}</td>
          <td><span class="pill ${st}">${pillText(st)}</span></td><td>${m.model ? esc(m.model) : '<span class="hint">default</span>'}</td><td>${fmtCost(m.costUsd)}${t.mode === 'lead' ? ' <span class="hint">with sub-agents</span>' : ''}</td></tr>`;
      }).join('')}
      ${t.subagents.map((r) => {
        const last = t.history.findLast((h) => h.role === r.role);
        return `<tr><td>${r.role[0].toUpperCase()}${r.role.slice(1)}</td><td><span class="hint">sub-agent of the lead</span></td>
          <td>${last ? `<span class="verdict-word ${GOOD.has(last.verdict) ? 'good' : 'bad'}">${esc(last.verdict)}</span> <span class="hint">${ago(last.at)}</span>` : '<span class="hint">—</span>'}</td>
          <td>${r.model ? esc(r.model) : '<span class="hint">lead\'s</span>'}</td><td></td></tr>`;
      }).join('')}
    </table></div>
    <h3>Handoffs</h3>
    ${t.history.length ? handoffs(t.history) : '<p class="hint">Nothing handed off yet. The analyst is reading the code.</p>'}
    ${asking}
    ${t.quests?.length
      ? `<h3>Earlier requests</h3>${t.quests.slice().reverse().map((q) => `<details class="team-quest"><summary><b>Quest ${q.n}</b> ${esc(q.request.split('\n')[0].slice(0, 100))} <span class="hint">· ${esc(q.outcome)}</span></summary>${q.history.length ? handoffs(q.history) : '<p class="hint">No handoffs.</p>'}</details>`).join('')}`
      : ''}
    ${teamFile ? `<div class="need-head"><b>${esc(teamFile.name.split('/').pop())}</b><span class="spacer"></span><button class="small ghost" data-team-file-close>Close</button></div><article class="md team-file">${md(teamFile.markdown)}</article>` : ''}`;
  for (const d of $('#team-body').querySelectorAll('details.team-quest')) if (openQuests.has(d.querySelector('summary b').textContent)) d.open = true;
}

$('#team-body').addEventListener('submit', (e) => {
  if (e.target.id !== 'team-ask') return;
  e.preventDefault();
  const text = $('#team-ask-text').value.trim();
  if (!text) return;
  const id = openTeamId;
  act(async () => {
    teams.set(id, await api('POST', `/teams/${id}/ask`, { text }));
    $('#team-ask-text').value = '';
    renderTeam();
  }, 'Given to the lead');
});

$('#team-close').onclick = () => {
  openTeamId = null;
  $('#team-dialog').close();
};
$('#team-stop').onclick = () => {
  if (!confirm("Stop the team? Its agents close (you can resume them); nothing is deleted.")) return;
  act(async () => teams.set(openTeamId, await api('POST', `/teams/${openTeamId}/stop`)), 'Team stopped');
};
$('#team-delete').onclick = () => {
  const id = openTeamId;
  const all = confirm('Also delete the team\'s agents and its worktree?\n\nOK: delete them too. Cancel: keep the agents, forget only the team.');
  act(async () => {
    await api('DELETE', `/teams/${id}${all ? '?agents=1' : ''}`);
    teams.delete(id);
    openTeamId = null;
    $('#team-dialog').close();
    render();
  });
};
$('#team-body').addEventListener('click', (e) => {
  const t = e.target;
  const go = t.closest('[data-team-goto]');
  if (go) {
    e.preventDefault();
    openTeamId = null;
    $('#team-dialog').close();
    showTab('agents');
    return select(go.dataset.teamGoto);
  }
  const file = t.closest('[data-team-file]');
  if (file) {
    e.preventDefault();
    return act(async () => {
      teamFile = await api('GET', `/teams/${openTeamId}/files/${encodeURIComponent(file.dataset.teamFile)}`);
      renderTeam();
      $('#team-body .team-file')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }
  if (t.closest('[data-team-file-close]')) {
    teamFile = null;
    return renderTeam();
  }
  const b = t.closest('[data-team-act]');
  if (!b) return;
  const note = $('#team-note')?.value.trim() || undefined;
  const id = openTeamId;
  const calls = {
    pr: () => api('POST', `/teams/${id}/finalize`, { mode: 'pr' }),
    publish: () => api('POST', `/teams/${id}/finalize`, { mode: 'publish' }),
    merge: () => api('POST', `/teams/${id}/finalize`, { mode: 'merge' }),
    keep: () => api('POST', `/teams/${id}/finalize`, { mode: 'keep' }),
    'send-back': () => api('POST', `/teams/${id}/send-back`, { note }),
    'fix-gaps': () => api('POST', `/teams/${id}/fix-gaps`, { note }),
    continue: () => api('POST', `/teams/${id}/resume`, { action: 'continue', note }),
    skip: () => api('POST', `/teams/${id}/resume`, { action: 'skip', note }),
  };
  const done = { pr: 'The implementer is opening the PR', publish: 'The implementer is publishing it to GitHub', merge: 'Merged into main', keep: 'Done; the branch is kept', 'send-back': 'Sent back to the implementer', 'fix-gaps': 'A gap round started', continue: 'Another round started', skip: 'Moving on' };
  act(async () => {
    teams.set(id, await calls[b.dataset.teamAct]());
    renderTeam();
  }, done[b.dataset.teamAct]);
});

// ------------------------------------------------------------------ races

function raceBanner(a) {
  if (!a.raceId) return '';
  const r = races.get(a.raceId);
  const n = r?.rows.length ?? 0;
  return `<div class="bl-banner race">🏁 Race attempt${a.variant?.label ? ` <b>${esc(a.variant.label)}</b>` : ''}${n ? ` · ${n} attempts` : ''}${r?.winner === a.id ? ' · <b>winner</b>' : ''}
    <span class="spacer"></span><button class="small primary" data-race-open="${a.raceId}">Compare</button></div>`;
}

function openRace(id) {
  openRaceId = id;
  raceDiff = null;
  renderRace();
  renderTeam();
  if (!$('#race-dialog').open) $('#race-dialog').showModal();
  act(async () => races.set(id, await api('GET', `/races/${id}`)));
}

const fmtCost = (c) => (c ? `$${c.toFixed(2)}` : '—');
const testCell = (t) =>
  !t ? '<span class="hint">—</span>' : `<span class="test ${t.status}" title="${esc(t.output ?? '')}">${{ passed: '✓ passed', failed: '✗ failed', running: '… running', queued: 'queued', error: '⚠ error' }[t.status] ?? t.status}${t.seconds != null ? ` <span class="hint">${t.seconds}s</span>` : ''}</span>`;

function renderRace() {
  const dlg = $('#race-dialog');
  if (!dlg.open && !openRaceId) return;
  const r = races.get(openRaceId);
  if (!r) {
    $('#race-body').innerHTML = '<p class="hint">Loading…</p>';
    return;
  }
  if ($('#race-body').contains(document.activeElement) && document.activeElement.name === 'testCommand') return;
  $('#race-title').textContent = `Race: ${r.intent.split('\n')[0].slice(0, 80)}`;
  // Tag a row only when it is strictly the best of several.
  const uniqueMin = (vals) => {
    const v = vals.filter((x) => x != null && x > 0);
    const m = Math.min(...v);
    return v.length > 1 && v.filter((x) => x === m).length === 1 ? m : null;
  };
  const cheapest = uniqueMin(r.rows.map((x) => x.costUsd));
  const smallest = uniqueMin(r.rows.map((x) => x.added + x.removed));
  $('#race-body').innerHTML = `
    <form class="race-tests" id="race-tests">
      <label>Test command <input name="testCommand" value="${esc(r.testCommand ?? '')}" placeholder="npm test" /></label>
      <button class="small primary">Run in every attempt</button>
    </form>
    <div class="race-table-wrap"><table class="race-table">
      <tr><th>Attempt</th><th>Status</th><th>Outcome</th><th>Checks</th><th>Change</th><th>Tests</th><th>Cost</th><th>Time</th><th></th></tr>
      ${r.rows
        .map((x) => {
          const a = agents.get(x.id);
          const st = a ? statusOf(a) : x.status;
          return `<tr class="${r.winner === x.id ? 'winner' : ''} ${raceDiff?.agentId === x.id ? 'diffing' : ''}">
            <td><a href="#${x.id}" data-race-goto="${x.id}"><b>${esc(x.variant?.label ?? x.name)}</b></a>${x.variant?.model ? ` <span class="tag">${esc(x.variant.model)}</span>` : ''}${x.variant?.instructions ? `<div class="hint">${esc(x.variant.instructions)}</div>` : ''}</td>
            <td><span class="pill ${st}">${pillText(st)}</span></td>
            <td>${x.outcome ? esc(x.outcome) : '<span class="hint">—</span>'}</td>
            <td>${x.checks.total ? `✓${x.checks.passed}/${x.checks.total}${x.checks.failed ? ` <span class="fail">✗${x.checks.failed}</span>` : ''}` : '<span class="hint">—</span>'}</td>
            <td>${x.files ? `${x.files} file${x.files > 1 ? 's' : ''} <span class="add">+${x.added}</span> <span class="del">−${x.removed}</span>${x.added + x.removed === smallest ? ' <span class="tag">smallest</span>' : ''}` : '<span class="hint">no changes</span>'}</td>
            <td>${testCell(x.tests)}</td>
            <td>${fmtCost(x.costUsd)}${x.costUsd === cheapest ? ' <span class="tag">cheapest</span>' : ''}</td>
            <td>${x.minutes != null ? `${x.minutes} min` : '—'}</td>
            <td class="race-acts">
              <button class="small" data-race-diff="${x.id}">Diff</button>
              ${r.winner === x.id ? '<span class="tag open">winner</span>' : `<button class="small" data-race-pick="${x.id}">Pick</button>`}
            </td>
          </tr>`;
        })
        .join('')}
    </table></div>
    ${raceDiff
      ? `<div class="race-diff"><div class="need-head"><b>Changes in ${esc(r.rows.find((x) => x.id === raceDiff.agentId)?.variant?.label ?? '')}</b><span class="spacer"></span><button class="small ghost" data-race-diff-close>Close diff</button></div>
         <pre class="diff">${raceDiff.text ? diffHtml(raceDiff.text) : '<span class="hint">No changes yet.</span>'}</pre></div>`
      : '<p class="hint">Pick a winner when you have seen enough. You can delete the other attempts and their worktrees at the same time.</p>'}`;
}

function diffHtml(text) {
  return text
    .split('\n')
    .map((l) => {
      const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') ? 'meta' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
      return `<span class="${cls}">${esc(l)}</span>`;
    })
    .join('\n');
}

$('#race-close').onclick = () => {
  openRaceId = null;
  $('#race-dialog').close();
};
$('#race-delete').onclick = () => {
  if (!confirm('Forget this race? Its agents stay; only the comparison is removed.')) return;
  const id = openRaceId;
  act(async () => {
    await api('DELETE', `/races/${id}`);
    races.delete(id);
    openRaceId = null;
    $('#race-dialog').close();
    render();
  });
};
$('#race-body').addEventListener('submit', (e) => {
  e.preventDefault();
  const command = new FormData(e.target).get('testCommand');
  act(async () => races.set(openRaceId, await api('POST', `/races/${openRaceId}/tests`, { command })), 'Running tests');
});
$('#race-body').addEventListener('click', (e) => {
  const t = e.target;
  const go = t.closest('[data-race-goto]');
  if (go) {
    e.preventDefault();
    openRaceId = null;
    $('#race-dialog').close();
    showTab('agents');
    return select(go.dataset.raceGoto);
  }
  if (t.closest('[data-race-diff-close]')) {
    raceDiff = null;
    return renderRace();
  }
  const d = t.closest('[data-race-diff]');
  if (d) {
    return act(async () => {
      raceDiff = { agentId: d.dataset.raceDiff, text: (await api('GET', `/races/${openRaceId}/diff/${d.dataset.raceDiff}`)).diff };
      renderRace();
    });
  }
  const p = t.closest('[data-race-pick]');
  if (p) {
    const r = races.get(openRaceId);
    const label = r.rows.find((x) => x.id === p.dataset.racePick)?.variant?.label;
    if (!confirm(`Pick "${label}" as the winner?`)) return;
    const cleanup = r.rows.length > 1 && confirm('Also close and delete the other attempts, including their worktrees? (Cancel keeps them.)');
    return act(async () => races.set(openRaceId, await api('POST', `/races/${openRaceId}/pick`, { agent: p.dataset.racePick, cleanup })), 'Winner picked');
  }
});

// ------------------------------------------------------------------ detail

function prRow(a, p) {
  const state = p.isDraft ? 'draft' : (p.state ?? '').toLowerCase();
  const label = p.number ? `#${p.number}` : 'PR';
  return `<li>
    ${state ? `<span class="tag ${state}">${state}</span>` : ''}
    <a class="grow" href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.url)}">${label} ${esc(p.title ?? p.repo ?? p.url)}</a>
    <span class="tag" title="How this was found">${esc(p.source)}</span>
    <button class="link" data-unlink="pr" data-key="${esc(p.url)}" title="Remove">✕</button>
    ${p.state === 'OPEN' && (p.checks || p.review || p.mergeState) ? `<div class="pr-chips">${prChips(p, esc)}</div>` : ''}
  </li>`;
}

function bugRow(a, b) {
  const inner = b.url ? `<a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.key)}</a>` : esc(b.key);
  return `<li>
    <span class="grow">${inner}${b.title ? ` <span class="hint">${esc(b.title)}</span>` : ''}</span>
    <span class="tag">${esc(b.source)}</span>
    <button class="link" data-unlink="bug" data-key="${esc(b.key)}" title="Remove">✕</button>
  </li>`;
}

function renderDetail() {
  const a = agents.get(selectedId);
  $('#placeholder').hidden = Boolean(a);
  const body = $('#detail-body');
  body.hidden = !a;
  if (!a) return;

  // Keep whatever the user is typing across live re-renders.
  const active = document.activeElement;
  const keepAttr = active?.dataset?.field ? 'field' : active?.dataset?.draft ? 'draft' : null;
  const keep = body.contains(active) && keepAttr ? { attr: keepAttr, field: active.dataset[keepAttr], value: active.value, pos: active.selectionStart } : null;
  const drafts = Object.fromEntries([...body.querySelectorAll('[data-field]')].map((el) => [el.dataset.field, el.value]));

  const st = statusOf(a);
  const running = a.runtime.running;
  const totalCost = a.costUsd ?? 0;
  const u = a.usage ?? { total: 0 };
  const current = a.sessions.find((s) => s.id === a.sessionId);

  body.innerHTML = `
    <div class="d-head">
      <div class="d-title">
        <h2>
          <select class="prio-select p${a.priority ?? 2}" data-priority="${a.id}" title="Priority: P0 most urgent … P3 lowest">
            ${[0, 1, 2, 3].map((p) => `<option value="${p}" ${p === (a.priority ?? 2) ? 'selected' : ''}>P${p}</option>`).join('')}
          </select>
          <span class="d-name">${esc(a.name)}</span> <span class="pill ${st}">${pillText(st)}</span>${a.kind === 'general' ? ' <span class="tag">general</span>' : ''}</h2>
        <p class="intent">${esc(a.intent || (a.kind === 'general' ? 'General session: ask Claude anything in the terminal.' : a.kind === 'assistant' ? 'Your assistant: it checks for new work every few minutes and starts agents for it. Settings and activity: Assistant in the top bar.' : ''))}</p>
      </div>
      <div class="d-actions">
        ${a.status === 'error' && !a.workdir
          ? `<button class="primary" data-act="start" title="Run the clone / worktree setup again">Retry setup</button>
             ${running ? '<button data-act="terminal">Open terminal</button>' : ''}`
          : a.status === 'preparing' && !running
            ? `<button class="primary" data-act="plan" title="Talk the task through with Claude while the workspace is prepared">Plan while it clones</button>`
            : `<button class="primary" data-act="terminal">${running ? 'Open terminal' : 'Resume & open terminal'}</button>`}
        ${running
          ? `<button data-act="stop" title="Close the claude process; the session ID is kept">Close session</button>`
          : a.status === 'error' && !a.workdir
            ? ''
            : `<button data-act="start" ${a.status === 'preparing' ? 'disabled' : ''}>Resume in background</button>`}
        <button data-act="fresh" ${running || a.status === 'preparing' ? 'disabled' : ''} title="Start over with a new session ID (old ones are kept)">New session</button>
        <button data-act="shell" ${a.workdir && a.status !== 'preparing' ? '' : 'disabled'} title="A separate terminal in this agent's folder for running commands by hand">Open shell</button>
        ${noRepo(a) ? '' : `<button data-act="changes" ${a.workdir && a.status !== 'preparing' ? '' : 'disabled'} title="Read its changes, comment on lines for the agent, commit and open a pull request">Review changes${a.git?.dirtyFiles ? ` <span class="count">${a.git.dirtyFiles}</span>` : ''}</button>`}
        <button data-act="fork" ${a.workdir && a.git?.branch ? '' : 'disabled'} title="A new agent with this one's code and conversation, in its own worktree, to try another approach">Fork</button>
        <button data-act="edit" title="Change its name, request, project, priority, permission mode or model">Edit</button>
        <button data-act="refresh" title="Re-scan git, PRs and transcripts">Refresh</button>
        <button data-act="keep" class="${a.keep ? 'on' : ''}" title="${a.keep ? 'Kept: clean up never closes or deletes it. Click to let clean up handle it again' : 'Clean up never closes or deletes an agent marked Keep'}">${a.keep ? '📌 Kept' : 'Keep'}</button>
        <button class="danger" data-act="delete">Delete</button>
      </div>
    </div>
    ${(() => {
      const it = a.backlogItem && backlogState.items.find((x) => x.id === a.backlogItem);
      if (!it) return '';
      return `<div class="bl-banner ${it.status}">Backlog item <code>${it.id}</code>: <b>${esc(it.status)}</b>
        ${it.status === 'review' ? `<span class="spacer"></span><button class="small primary" data-backlog-accept="${it.id}">Accept</button> <button class="small" data-backlog-reopen="${it.id}">Reopen</button>` : ''}</div>`;
    })()}
    ${a.error ? `<div class="error-box">${esc(a.error)}</div>` : ''}
    ${!running && a.closedBy === 'cap' ? `<p class="hint">Closed ${ago(a.closedAt)} to stay under the limit on open agents (Settings), as the one idle longest. Resume it any time${a.keep ? '' : ', or mark it Keep'}.</p>` : ''}
    ${!running && a.closedBy === 'cleanup' ? `<p class="hint">Closed by clean up ${ago(a.closedAt)}, after a while with no activity. Resume it any time${a.keep ? '' : ', or mark it Keep'}.</p>` : ''}
    ${a.status === 'preparing'
      ? `<div class="progress-box">
          <div>${esc(progressText(a.progress) || 'Preparing workspace…')}</div>
          ${a.progress?.step ? `<div class="bar"><span style="width:${a.progress.percent}%"></span></div>` : ''}
          <div class="hint">${a.runtime.planning
            ? 'A planning session is running in the terminal. It moves into the repo, with the whole conversation, once the workspace is ready.'
            : 'Claude starts as soon as the workspace is ready. Use <b>Plan while it clones</b> to clarify the task with Claude meanwhile. Deleting the agent cancels setup.'}</div>
        </div>`
      : ''}
    ${a.runtime.planning && a.workdir && a.status !== 'preparing'
      ? `<div class="ready-box">
          <span>The workspace is ready. The planning session moves into the repo when you leave the terminal, or now:</span>
          <button class="primary small" data-act="handoff">Continue in repo</button>
        </div>`
      : ''}
    ${a.runtime.attention ? `<div class="error-box">${esc(a.runtime.attention)}: the agent is waiting for an answer. Open its terminal to respond.</div>` : ''}
    ${raceBanner(a)}
    ${teamBanner(a)}
    ${a.forkOf ? `<div class="bl-banner">⑂ Forked from <a href="#${a.forkOf.agentId}" data-goto="${a.forkOf.agentId}">${esc(a.forkOf.name)}</a>${a.forkOf.checkpoint ? ` at checkpoint ${a.forkOf.checkpoint}` : ''} ${ago(a.forkOf.at)}</div>` : ''}
    ${(() => {
      const items = needsFor(a, { both: true });
      return items.length ? `<div class="needs">${items.map((it) => needCard(it, { inDetail: true })).join('')}</div>` : '';
    })()}
    ${a.outbox ? `<div class="hint outbox-note">✉ ${a.outbox} message${a.outbox > 1 ? 's' : ''} waiting to be typed into the session when the agent is idle</div>` : ''}

    ${briefPanel(a)}

    <div class="grid">
      <div class="card">
        <h3>Session</h3>
        <dl class="kv">
          <dt>Session ID</dt><dd><code>${esc(a.sessionId)}</code>${copyBtn(a.sessionId)}</dd>
          <dt>Title</dt><dd>${esc(current?.title ?? '—')}</dd>
          <dt>Agent ID</dt><dd><code>${a.id}</code></dd>
          <dt>Last output</dt><dd>${a.runtime.lastOutputAt ? ago(a.runtime.lastOutputAt) : current?.lastActivity ? ago(current.lastActivity) : '—'}</dd>
          <dt>Tokens</dt><dd class="tokens">${u.total
            ? `<button class="link tok-toggle" data-tokens="${a.id}" title="Input + output tokens. Click for the full breakdown.">${fmtTokens(ioOf(u))} I/O ${tokensOpen.has(a.id) ? '▾' : '▸'}</button>
               ${tokensOpen.has(a.id)
                 ? `<div class="tok-detail">${fmtTokens(u.input)} in · ${fmtTokens(u.output)} out · ${fmtTokens(u.cacheRead)} cache read · ${fmtTokens(u.cacheCreation)} cache write
                    <br>${fmtTokens(u.total)} total incl. cache · ${u.requests} requests</div>`
                 : ''}`
            : '—'}</dd>
          <dt>Cost</dt><dd>${totalCost ? `$${totalCost.toFixed(2)}${a.budgetUsd ? ` of its $${a.budgetUsd.toFixed(2)} budget` : ''} <span class="hint">(reported by Claude Code)</span>` : a.budgetUsd ? `— <span class="hint">budget $${a.budgetUsd.toFixed(2)}</span>` : '—'}${a.budgetHit ? ' <span class="tag fail" title="Its session was closed at its budget; raise it in Edit to continue">budget reached</span>' : ''}</dd>
          <dt>Mode</dt><dd>${esc(a.permissionMode)}${a.model ? ` · ${esc(a.model)}` : ''}</dd>
        </dl>
      </div>

      <div class="card">
        <h3>Workspace</h3>
        <dl class="kv">
          <dt>Folder</dt><dd><code>${esc(a.workdir ?? (a.status === 'preparing' ? 'preparing…' : '—'))}</code>${a.workdir ? copyBtn(a.workdir) : ''}</dd>
          <dt>Project</dt><dd>${esc(a.projectInfo?.full || a.projectInfo?.name || '—')} ${noRepo(a) ? '' : '<button class="link" data-act="project" title="Move this agent under another project">✎ Move</button>'}</dd>
          <dt>Repo</dt><dd>${a.repo ? `<code>${esc(a.repo)}</code>` : '—'}</dd>
          <dt>Branch</dt><dd>${a.git?.branch ? `<code>${esc(a.git.branch)}</code>` : '—'}${a.git?.dirtyFiles ? ` <span class="tag">${a.git.dirtyFiles} changed</span>` : ''}</dd>
          <dt>Head</dt><dd>${a.git?.head ? `<code>${esc(a.git.head.sha)}</code> ${esc(a.git.head.subject)}` : '—'}</dd>
          ${a.baseRef ? `<dt>Branched from</dt><dd><code>${esc(a.baseRef)}</code></dd>` : ''}
          ${a.worktree ? `<dt>Worktree of</dt><dd><code>${esc(a.sourceDir)}</code></dd>` : ''}
          ${noRepo(a) ? '' : `<dt>Repo memory</dt><dd><button class="link" data-act="memory" title="What agents learned working in this repo; every agent here gets it">View and edit</button></dd>`}
        </dl>
      </div>

      <div class="card">
        <h3>Pull requests <span>${a.prs.length || ''}</span></h3>
        <ul class="links">${a.prs.length ? a.prs.map((p) => prRow(a, p)).join('') : '<li class="none">None detected yet</li>'}</ul>
        <form class="add-link" data-link="pr">
          <input data-field="pr" placeholder="Link a PR URL" value="${esc(drafts.pr ?? '')}" />
          <button class="small">Add</button>
        </form>
      </div>

      <div class="card">
        <h3>Bugs <span>${a.bugs.length || ''}</span></h3>
        <ul class="links">${a.bugs.length ? a.bugs.map((b) => bugRow(a, b)).join('') : '<li class="none">None detected yet</li>'}</ul>
        <form class="add-link" data-link="bug">
          <input data-field="bug" placeholder="Bug key or URL, e.g. PROJ-123" value="${esc(drafts.bug ?? '')}" />
          <button class="small">Add</button>
        </form>
      </div>

      <div class="card">
        <h3>Session history <span>${a.sessions.length}</span></h3>
        <table class="sessions">
          <tr><th>ID</th><th>Title</th><th title="Input + output tokens">I/O tokens</th><th>Active</th><th></th></tr>
          ${[...a.sessions]
            .reverse()
            .map(
              (s) => `<tr class="${s.id === a.sessionId ? 'current' : ''}">
              <td><code title="${esc(s.id)}">${s.id.slice(0, 8)}</code>${copyBtn(s.id)}</td>
              <td>${esc(s.title ?? '')}</td>
              <td title="${s.usage ? esc(usageTitle(s.usage)) : ''}">${s.usage ? fmtTokens(ioOf(s.usage)) : ''}</td>
              <td>${ago(s.lastActivity ?? s.lastStartedAt)}</td>
              <td>${s.id === a.sessionId ? 'current' : running ? '' : `<button class="small" data-resume-session="${s.id}">Resume</button>`}</td>
            </tr>`,
            )
            .join('')}
        </table>
      </div>

      ${checkpointsCard(a)}

      <div class="card">
        <h3>Notes</h3>
        <textarea class="notes" data-field="notes" placeholder="Anything worth remembering about this agent">${esc(drafts.notes ?? a.notes ?? '')}</textarea>
      </div>
    </div>`;

  renderDiagrams(body);
  markOverflow(body);

  if (keep) {
    const el = body.querySelector(`[data-${keep.attr}="${CSS.escape(keep.field)}"]`);
    if (el) {
      el.value = keep.value;
      el.focus();
      el.setSelectionRange?.(keep.pos, keep.pos);
    }
  }
}

function render() {
  renderList();
  renderBacklog();
  landUi.render();
  renderInbox();
  renderRace();
  renderTeam();
  renderDocDialog();
  renderDetail();
  term.syncOverlay();
}

function select(id) {
  selectedId = id;
  history.replaceState(null, '', id ? `#${id}` : '#');
  if (term.agentId && term.agentId !== id) term.close();
  render();
}

// ------------------------------------------------------------------ terminal


const term = {
  agentId: null,
  ws: null,
  xterm: null,
  fit: null,

  ensure() {
    if (this.xterm) return;
    this.xterm = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      scrollback: 10000,
      theme: { background: '#0f1117' },
      allowProposedApi: true,
    });
    this.fit = new FitAddon();
    this.xterm.loadAddon(this.fit);
    this.xterm.open($('#terminal'));
    this.xterm.onData((d) => {
      lastTyped = Date.now();
      this.send({ t: 'i', d });
    });
    this.xterm.onResize(({ cols, rows }) => this.send({ t: 'r', cols, rows }));
    new ResizeObserver(() => this.refit()).observe($('#terminal'));
    touchScroll($('#terminal'), this.xterm);
  },

  send(msg) {
    this.conn?.send(msg);
  },

  refit() {
    if (!this.agentId) return;
    try {
      this.fit.fit();
    } catch {}
  },

  kind: 'claude', // 'claude' = the agent's session, 'shell:N' = shell N in its folder
  shellExited: false,

  open(id, kind = 'claude') {
    if (kind === 'code') return this.openCode(id);
    $('#term-wrap').classList.remove('coding');
    if (isBrowser(kind)) return this.openBrowser(id, kind);
    liveView.close();
    $('#term-wrap').classList.remove('browsing');
    if (isShell(kind)) kind = `shell:${shellNum(kind)}`;
    history.replaceState(null, '', `#${id}/${isShell(kind) ? kind : 'term'}`);
    $('#term-wrap').hidden = false;
    $('#detail').classList.add('with-term');
    this.ensure();
    if (this.agentId === id && this.kind === kind && this.conn) {
      this.xterm.focus();
      return;
    }
    this.disconnect();
    this.agentId = id;
    this.kind = kind;
    this.shellExited = false;
    this.xterm.reset();
    this.syncOverlay();
    requestAnimationFrame(() => this.refit());

    const conn = openStream(
      { agentId: id, kind },
      {
        onOpen: () => {
          this.refit();
          this.send({ t: 'r', cols: this.xterm.cols, rows: this.xterm.rows });
        },
        onMessage: (msg) => this.conn === conn && this.onMessage(msg),
        onClose: (ev) => {
          if (this.conn !== conn) return;
          this.conn = null;
          if (ev.code === 1008) toast(`Terminal unavailable: ${ev.reason}`, 5000);
        },
      },
    );
    this.conn = conn;
  },

  onMessage(msg) {
    {
      if (msg.t === 'hello') {
        // Also sent again after a reconnect: start from a clean screen and replay.
        this.xterm.reset();
        this.xterm.write(msg.backlog);
        if (!matchMedia('(pointer: coarse)').matches) this.xterm.focus();
      } else if (msg.t === 'error') {
        toast(`Terminal unavailable: ${msg.error}`, 5000);
      } else if (msg.t === 'o') {
        this.xterm.write(msg.d);
      } else if (msg.t === 'exit') {
        if (isShell(this.kind)) this.shellExited = true;
        else this.xterm.write(`\r\n\x1b[2m[claude exited with code ${msg.code}; session kept]\x1b[0m\r\n`);
      }
      this.syncOverlay();
    }
  },

  syncOverlay() {
    if (isBrowser(this.kind)) return this.renderTabs();
    if (this.kind === 'code') {
      $('#term-overlay').hidden = true;
      return this.renderTabs();
    }
    const a = this.agentId && agents.get(this.agentId);
    const shell = isShell(this.kind);
    const closed = shell ? this.shellExited : a && !a.runtime.running && a.status !== 'preparing';
    $('#term-overlay').hidden = !a || !closed;
    $('#term-overlay-msg').textContent = shell ? 'The shell has exited.' : "This agent's session is closed.";
    $('#term-resume').textContent = shell ? 'Start a new shell' : 'Resume session';
    this.renderTabs();
    if (a) {
      $('#term-title').textContent = shell ? `shell ${shellNum(this.kind)} · ${a.workdir}` : `${a.name} · session ${a.sessionId}`;
    }
  },

  /** One tab per running shell, plus the one being viewed even if it has exited. */
  renderTabs() {
    renderSignIn();
    const a = this.agentId && agents.get(this.agentId);
    const nums = new Set(a?.runtime.shells ?? []);
    if (isShell(this.kind)) nums.add(shellNum(this.kind));
    $('#shell-tabs').innerHTML = [...nums]
      .sort((x, y) => x - y)
      .map((n) => `<button class="term-tab" data-kind="shell:${n}" role="tab" title="Shell ${n} in the agent's folder">Shell ${n}<span class="x" data-close="${n}" title="Close this shell">×</span></button>`)
      .join('');
    $('#browser-tabs').innerHTML = (a?.browsers ?? [])
      .map((t) => `<button class="term-tab" data-kind="browser:${t.n}" role="tab" title="${esc(t.url)}">🌐 ${esc(browserLabel(t.url))}<span class="x" data-drop-browser="${t.n}" title="Close this browser tab">×</span></button>`)
      .join('');
    for (const tab of document.querySelectorAll('.term-tab[data-kind]')) tab.classList.toggle('active', tab.dataset.kind === this.kind);
    $('#browser-new').classList.toggle('active', this.kind === 'browser:new');
    $('#shell-new').disabled = !a?.workdir || a.status === 'preparing';
    if (isBrowser(this.kind) && this.kind !== 'browser:new' && !a?.browsers?.some((t) => `browser:${t.n}` === this.kind)) {
      // Closed on another device, or a popup that closed itself: back to the page that opened it.
      const back = liveView.opener && a?.browsers?.find((t) => t.n === liveView.opener);
      liveView.opener = null;
      this.kind = null;
      this.open(this.agentId, back ? `browser:${back.n}` : 'claude');
    }
  },

  // Browser tabs: one iframe per tab, kept while the panel is open so switching back doesn't reload it.
  frames: new Map(), // "<agent>:<n>" -> iframe

  // Code: the agent's files in an editor, in place of the terminal (like a browser tab).
  openCode(id) {
    history.replaceState(null, '', `#${id}/code`);
    liveView.close();
    $('#term-wrap').hidden = false;
    $('#detail').classList.add('with-term');
    $('#term-wrap').classList.remove('browsing');
    $('#term-wrap').classList.add('coding');
    this.ensure();
    this.disconnect();
    this.agentId = id;
    this.kind = 'code';
    $('#term-overlay').hidden = true;
    this.renderTabs();
    $('#term-title').textContent = agents.get(id)?.workdir ?? '';
    codeUi.open(id);
  },

  openBrowser(id, kind) {
    history.replaceState(null, '', `#${id}/${kind}`);
    $('#term-wrap').hidden = false;
    $('#detail').classList.add('with-term');
    $('#term-wrap').classList.add('browsing');
    this.ensure();
    if (this.agentId !== id) this.dropFrames();
    this.disconnect();
    this.agentId = id;
    this.kind = kind;
    $('#term-overlay').hidden = true;
    this.renderTabs();
    const tab = agents.get(id)?.browsers?.find((t) => `browser:${t.n}` === kind);
    const mode = tab ? modeOf(tab) : null;
    $('#term-wrap').classList.toggle('live-mode', mode === 'live');
    Object.assign($('#browser-mode'), {
      hidden: !tab || !liveAvailable,
      textContent: mode === 'live' ? 'Live' : 'Lite',
      title: mode === 'live'
        ? "Live: a real browser on this machine, streamed here. Sign-ins and localhost work from any device. Click for Lite (the page loads in this browser, faster but some sites refuse)"
        : 'Lite: the page loads in this browser (relayed from other devices). Click for Live: a real browser on this machine, streamed here',
    });
    for (const [key, f] of this.frames) f.hidden = mode === 'live' || key !== `${id}:${tab?.n}`;
    $('#browser-start').hidden = Boolean(tab);
    if (mode === 'live') {
      $('#browser-cert').hidden = true;
      $('#browser-hint').hidden = true;
      $('#browser-pop').hidden = true;
      if (document.activeElement !== $('#browser-url')) $('#browser-url').value = tab.url;
      $('#term-title').textContent = tab.url;
      return liveView.open(id, tab);
    }
    liveView.close();
    $('#browser-cert').hidden = true;
    const open = tab && this.frames.get(`${id}:${tab.n}`);
    Object.assign($('#browser-pop'), { href: open?.dataset.src ?? '#', hidden: !open });
    // Here the tab loads the site itself, so its own "don't frame me" header applies; the relay
    // used from other devices drops that header.
    $('#browser-hint').hidden = REMOTE || !tab || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(tab.url);
    $('#browser-url').value = tab?.url ?? '';
    $('#term-title').textContent = tab ? tab.url : 'Open a page as this machine sees it';
    if (!tab) {
      $('#browser-pop').hidden = true;
      this.suggest(id);
      requestAnimationFrame(() => $('#browser-url').focus());
      return;
    }
    this.loadFrame(id, tab);
  },

  async loadFrame(id, tab, force = false) {
    const key = `${id}:${tab.n}`;
    let frame = this.frames.get(key);
    if (frame && frame.dataset.url === tab.url && !force) return;
    let src;
    try {
      ({ src } = await api('POST', '/preview', { url: tab.url }));
    } catch (err) {
      return toast(`Can't open ${tab.url}: ${err.message}`, 5000);
    }
    const viewing = () => this.kind === `browser:${tab.n}` && this.agentId === id && modeOf(tab) !== 'live';
    if (viewing()) Object.assign($('#browser-pop'), { href: src, hidden: false });
    // From another device the tab goes through its own relay port. A browser accepts a
    // self-signed certificate per port and can't ask inside a frame, so check first and
    // offer to accept it in a tab of its own instead of showing a blank page.
    if (REMOTE && !(await reachable(src))) {
      frame?.remove();
      this.frames.delete(key);
      if (viewing()) {
        $('#browser-cert-open').href = src;
        $('#browser-cert').hidden = false;
      }
      return;
    }
    if (viewing()) $('#browser-cert').hidden = true;
    if (!frame) {
      frame = Object.assign(document.createElement('iframe'), { className: 'browser-frame', title: tab.url });
      frame.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
      $('#browser-frames').append(frame);
      this.frames.set(key, frame);
    }
    frame.dataset.url = tab.url;
    frame.dataset.src = src;
    frame.hidden = !viewing();
    frame.src = src;
  },

  dropFrames(key) {
    for (const [k, f] of this.frames) {
      if (key && k !== key) continue;
      f.remove();
      this.frames.delete(k);
    }
  },

  async suggest(id) {
    const urls = await api('GET', `/agents/${id}/local-urls`).catch(() => []);
    if (this.agentId !== id || this.kind !== 'browser:new') return;
    $('#browser-suggest').innerHTML = urls.length
      ? `<span class="muted">Seen in this agent's terminals:</span> ${urls.map((u) => `<button type="button" class="small" data-url="${esc(u)}">${esc(u)}</button>`).join(' ')}`
      : '<span class="muted">Type a port (5173) or an address (localhost:3000/app, example.com). Local addresses the agent prints, like a dev server\'s, show up here.</span>';
  },

  /** Upload files to the daemon and paste their paths, the way a native terminal pastes a dropped file. */
  async attachFiles(files) {
    const id = this.agentId;
    if (!id || !files.length) return;
    const saved = [];
    for (const file of files) {
      const name = file.name || `pasted-${Date.now()}.${(file.type.split('/')[1] || 'bin').replace(/\W/g, '')}`;
      try {
        const res = await fetch(`/api/agents/${id}/upload?name=${encodeURIComponent(name)}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream', 'x-agentmgr': '1' },
          body: file,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        saved.push(data.path);
      } catch (err) {
        toast(`Could not attach ${name}: ${err.message}`, 5000);
      }
    }
    if (!saved.length || this.agentId !== id) return;
    // Backslash-escape like a terminal drop, so Claude Code (and shells) read each as one path.
    this.xterm.paste(saved.map((p) => p.replace(/([\s'"\\()&;|<>$`!*?[\]{}#~])/g, '\\$1')).join(' ') + ' ');
    this.xterm.focus();
    toast(saved.length === 1 ? 'Attached 1 file' : `Attached ${saved.length} files`);
  },

  disconnect() {
    this.conn?.close();
    this.conn = null;
  },

  close() {
    if (this.agentId) history.replaceState(null, '', `#${this.agentId}`);
    this.disconnect();
    liveView.close();
    this.dropFrames();
    this.agentId = null;
    $('#term-wrap').hidden = true;
    $('#detail').classList.remove('with-term');
    if (document.body.classList.contains('term-max')) setExpanded(false);
    if (document.fullscreenElement) document.exitFullscreen();
  },
};

$('#term-close').onclick = () => term.close();
$('#term-fit').onclick = () => term.refit();

// ------------------------------------------------------------------ resizing, expanding, full screen

const layoutPref = {
  get(key) {
    try {
      return localStorage.getItem(`agentmgr.${key}`);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      value == null ? localStorage.removeItem(`agentmgr.${key}`) : localStorage.setItem(`agentmgr.${key}`, value);
    } catch {}
  },
};

function applyLayout() {
  const side = layoutPref.get('sideWidth');
  const brief = layoutPref.get('briefHeight');
  document.documentElement.style.setProperty('--side-w', side ? `${side}px` : '340px');
  if (brief) document.documentElement.style.setProperty('--brief-h', `${brief}px`);
  else document.documentElement.style.removeProperty('--brief-h');
  $('#detail').classList.toggle('brief-sized', Boolean(brief));
}
applyLayout();

/** Drag a handle; `move` gets the pointer position and returns the value to keep. */
function dragHandle(el, axis, move, key) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    document.body.classList.add('resizing', axis);
    let value = null;
    const onMove = (ev) => {
      value = move(ev);
      applyLayout();
    };
    const onUp = () => {
      el.classList.remove('dragging');
      document.body.classList.remove('resizing', axis);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      if (value != null) layoutPref.set(key, Math.round(value));
      term.refit();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  });
  el.addEventListener('dblclick', () => {
    layoutPref.set(key, null);
    applyLayout();
    requestAnimationFrame(() => term.refit());
  });
}

dragHandle($('#split-side'), 'cols', (ev) => {
  const w = Math.min(Math.max(ev.clientX, 220), window.innerWidth * 0.6);
  layoutPref.set('sideWidth', Math.round(w));
  return w;
}, 'sideWidth');

dragHandle($('#split-term'), 'rows', (ev) => {
  const top = $('#detail').getBoundingClientRect().top;
  const h = Math.min(Math.max(ev.clientY - top, 60), $('#detail').clientHeight - 160);
  layoutPref.set('briefHeight', Math.round(h));
  return h;
}, 'briefHeight');

function setExpanded(on) {
  document.body.classList.toggle('term-max', on);
  $('#term-max').classList.toggle('on', on);
  $('#term-max').textContent = on ? '⤡ Restore' : '⤢ Expand';
  requestAnimationFrame(() => term.refit());
}
$('#term-max').onclick = () => setExpanded(!document.body.classList.contains('term-max'));
$('#term-full').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('#term-wrap').requestFullscreen?.().catch(() => setExpanded(true));
};
document.addEventListener('fullscreenchange', () => {
  const on = document.fullscreenElement === $('#term-wrap');
  $('#term-full').classList.toggle('on', on);
  $('#term-full').textContent = on ? '⛶ Exit full screen' : '⛶ Full screen';
  requestAnimationFrame(() => term.refit());
});
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyE' && !$('#term-wrap').hidden) {
    e.preventDefault();
    setExpanded(!document.body.classList.contains('term-max'));
  }
}, true);
$('#term-resume').onclick = () => {
  const id = term.agentId;
  if (isShell(term.kind)) {
    term.disconnect();
    return term.open(id, term.kind);
  }
  act(async () => {
    upsert(await api('POST', `/agents/${id}/start`, {}));
    term.xterm.focus();
  });
};
$('.term-tabs').addEventListener('click', async (e) => {
  const id = term.agentId;
  if (!id) return;
  const dropBrowser = e.target.closest('[data-drop-browser]');
  if (dropBrowser) {
    e.stopPropagation();
    const n = Number(dropBrowser.dataset.dropBrowser);
    return act(async () => {
      await api('DELETE', `/agents/${id}/browsers/${n}`);
      term.dropFrames(`${id}:${n}`);
      if (term.kind === `browser:${n}`) {
        term.kind = null;
        term.open(id, 'claude');
      }
    });
  }
  if (e.target.closest('#browser-new')) return term.open(id, 'browser:new');
  const close = e.target.closest('[data-close]');
  if (close) {
    e.stopPropagation();
    const n = Number(close.dataset.close);
    const viewing = term.kind === `shell:${n}`;
    await act(async () => {
      await api('POST', `/agents/${id}/shell/drop`, { n });
      if (viewing) {
        const rest = (agents.get(id)?.runtime.shells ?? []).filter((x) => x !== n);
        term.kind = null; // force a reconnect
        term.open(id, rest.length ? `shell:${rest[0]}` : 'claude');
      } else term.renderTabs();
    });
    return;
  }
  if (e.target.closest('#shell-new')) {
    return act(async () => term.open(id, `shell:${(await api('POST', `/agents/${id}/shell/new`)).n}`));
  }
  const tab = e.target.closest('.term-tab[data-kind]');
  if (!tab) return;
  const a = agents.get(id);
  if (tab.dataset.kind === 'claude' && a && !a.runtime.running) {
    await act(async () => upsert(await api('POST', `/agents/${id}/start`, {})));
  }
  term.open(id, tab.dataset.kind);
});

const browserLabel = (url) => {
  const u = new URL(url);
  return u.host + (u.pathname === '/' ? '' : u.pathname);
};
async function openAddress(url) {
  const id = term.agentId;
  if (!id || !url.trim()) return;
  // A CLI's sign-in link can't work inside a page: open it in a window and watch for its callback.
  if (SIGNIN_LINK.test(url) && !liveAvailable) {
    window.open(url.trim(), '_blank');
    return act(async () => upsert(await api('POST', `/agents/${id}/signin`, { url: url.trim() })), 'Sign-in opened in a new window');
  }
  // The callback address pasted here from another device: hand it to the CLI on this machine.
  const s = agents.get(id)?.signIn;
  if (REMOTE && s && url.trim().startsWith(s.callback)) return finishSignIn(id, url.trim());
  await act(async () => {
    if (term.kind === 'browser:new') {
      const tab = await api('POST', `/agents/${id}/browsers`, { url, mode: liveAvailable ? 'live' : 'lite' });
      upsertBrowsers(id, tab.n, tab.url, tab.mode);
      const n = tab.n;
      term.open(id, `browser:${n}`);
    } else {
      const n = Number(term.kind.split(':')[1]);
      const tab = await api('PATCH', `/agents/${id}/browsers/${n}`, { url });
      upsertBrowsers(id, n, tab.url);
      term.open(id, term.kind);
    }
  });
}
// ------------------------------------------------------------------ CLI sign-in links

const SIGNIN_LINK = /^https?:\/\/[^\s]+[?&][^=&]*(redirect|callback|return)[^=&]*=https?(%3A|:)(%2F|\/){2}(127\.0\.0\.1|localhost|%5B%3A%3A1%5D)/i;
let lastTyped = 0; // the person's last keystroke in a terminal: a link printed right after may open by itself
const autoOpened = new Set();
const signInHidden = new Set();

/** Above the terminal: the sign-in link a CLI printed, and (from another device) finishing its callback. */
function renderSignIn() {
  const bar = $('#signin-bar');
  const s = agents.get(term.agentId)?.signIn;
  const wasHidden = bar.hidden;
  // The terminal gives up or takes back the bar's height.
  const refit = () => wasHidden !== bar.hidden && term.xterm && requestAnimationFrame(() => term.refit());
  if (!s || signInHidden.has(s.at)) {
    bar.hidden = true;
    return refit();
  }
  if (!autoOpened.has(s.at) && !s.finished) {
    autoOpened.add(s.at);
    if (document.visibilityState === 'visible' && Date.now() - lastTyped < 15_000) {
      // Live: in a browser on that machine, where the callback reaches the CLI. Otherwise a window
      // here (browsers allow one shortly after a keystroke; else the button below does it).
      if (liveAvailable) return openSignInLive(term.agentId, s.url);
      window.open(s.url, '_blank');
    }
  }
  if (bar.contains(document.activeElement)) return; // keep what is being typed
  let host = '';
  try {
    host = new URL(s.url).host;
  } catch {}
  const f = s.finished;
  bar.hidden = false;
  const pasteForm = `<form class="signin-finish">After you approve, your browser goes to <code>${esc(s.callback)}…</code>, which can't load on this device. Paste that address here:
      <input name="url" placeholder="${esc(s.callback)}?code=…" autocomplete="off" />
      <button class="small primary">Finish sign-in</button></form>`;
  const here = `<a class="button small ${liveAvailable ? 'ghost' : 'primary'}" href="${esc(s.url)}" target="_blank" rel="noopener" title="Open it in a window on this device">${liveAvailable ? 'On this device ↗' : 'Open sign-in ↗'}</a>`;
  bar.innerHTML = `<div class="signin-head">🔑 <b>${esc(s.terminal)}</b> printed a sign-in link (${esc(host)})
      ${liveAvailable ? '<button class="small primary" data-signin="live" title="In a live browser tab on that machine: the sign-in finishes by itself">Open sign-in</button>' : ''}
      ${here}
      <button class="small ghost" data-signin="copy">Copy link</button>
      <button class="small ghost" data-signin="dismiss" title="Hide">✕</button></div>
    ${f?.ok
      ? `<p class="signin-ok">✓ Sent to the CLI on this machine${f.text ? `: ${esc(f.text)}` : ''}. Check the terminal.</p>`
      : `${liveAvailable ? '<p class="hint"><b>Open sign-in</b> uses a live browser tab on that machine, so the CLI gets the sign-in by itself. Sign in to the provider there once; it is remembered.</p>' : ''}
        ${REMOTE ? `${liveAvailable ? '<details class="signin-other"><summary>Signed in on this device instead?</summary>' : ''}${pasteForm}${liveAvailable ? '</details>' : ''}` : liveAvailable ? '' : '<p class="hint">After you approve, the browser returns to the CLI by itself.</p>'}
        ${f ? `<p class="error">${esc(f.text || `HTTP ${f.status}`)}</p>` : ''}`}`;
  refit();
}

/** Open a sign-in link in a live browser tab: its callback lands on the machine the CLI runs on. */
function openSignInLive(id, url) {
  const s = agents.get(id)?.signIn;
  if (s) signInHidden.add(s.at);
  return act(async () => {
    const tab = await api('POST', `/agents/${id}/browsers`, { url, mode: 'live' });
    upsertBrowsers(id, tab.n, tab.url, 'live');
    term.open(id, `browser:${tab.n}`);
    api('POST', `/agents/${id}/signin/dismiss`).catch(() => {});
  });
}

async function finishSignIn(id, url) {
  await act(async () => {
    const a = await api('POST', `/agents/${id}/signin/finish`, { url });
    upsert(a);
    if (!a.signIn?.finished?.ok) throw new Error(a.signIn?.finished?.text || 'The CLI did not accept it');
  }, 'Signed in: the CLI got the callback');
}

$('#signin-bar').addEventListener('click', (e) => {
  const el = e.target.closest('[data-signin]');
  if (!el) return;
  const s = agents.get(term.agentId)?.signIn;
  if (!s) return;
  if (el.dataset.signin === 'copy') return navigator.clipboard?.writeText(s.url).then(() => toast('Link copied'));
  if (el.dataset.signin === 'live') return openSignInLive(term.agentId, s.url);
  signInHidden.add(s.at);
  act(async () => upsert(await api('POST', `/agents/${term.agentId}/signin/dismiss`)));
});
$('#signin-bar').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = e.target.querySelector('input').value.trim();
  if (url) finishSignIn(term.agentId, url);
});

// Don't wait for the change event to show a tab that was just opened.
function upsertBrowsers(id, n, url, mode) {
  const a = agents.get(id);
  if (!a) return;
  const old = (a.browsers ?? []).find((t) => t.n === n);
  const tabs = (a.browsers ?? []).filter((t) => t.n !== n);
  a.browsers = [...tabs, { ...old, n, url, ...(mode ? { mode } : {}) }].sort((x, y) => x.n - y.n);
}
$('#browser-bar').addEventListener('submit', (e) => {
  e.preventDefault();
  openAddress($('#browser-url').value);
});
$('#browser-suggest').addEventListener('click', (e) => {
  const b = e.target.closest('[data-url]');
  if (b) openAddress(b.dataset.url);
});
/** Whether this device can load `src` at all (a no-cors probe fails on an untrusted certificate). */
async function reachable(src) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    await fetch(src, { mode: 'no-cors', credentials: 'include', cache: 'no-store', signal: ctl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
$('#browser-cert-retry').onclick = () => $('#browser-reload').click();
const currentTab = () => agents.get(term.agentId)?.browsers?.find((t) => `browser:${t.n}` === term.kind);
$('#browser-reload').onclick = () => {
  const tab = currentTab();
  if (!tab) return;
  if (modeOf(tab) === 'live') return liveView.go('reload');
  term.loadFrame(term.agentId, tab, true);
};
$('#browser-back').onclick = () => liveView.go('back');
$('#browser-fwd').onclick = () => liveView.go('forward');
$('#browser-mode').onclick = () => {
  const tab = currentTab();
  if (!tab) return;
  const mode = modeOf(tab) === 'live' ? 'lite' : 'live';
  act(async () => {
    const t = await api('PATCH', `/agents/${term.agentId}/browsers/${tab.n}`, { mode });
    upsertBrowsers(term.agentId, t.n, t.url, t.mode);
    term.dropFrames(`${term.agentId}:${t.n}`);
    term.open(term.agentId, `browser:${t.n}`);
  });
};

// ------------------------------------------------------------------ importing terminal sessions

let importSessions = [];
const importPicked = new Set();
async function openImport() {
  importPicked.clear();
  $('#import-filter').value = '';
  $('#import-dialog').showModal();
  await loadImport();
}
async function loadImport() {
  $('#import-list').innerHTML = '<p class="hint">Looking for sessions…</p>';
  try {
    importSessions = await api('GET', `/sessions/scan?days=${$('#import-days').value}`);
  } catch (err) {
    $('#import-list').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  renderImport();
}
function renderImport() {
  const q = $('#import-filter').value.trim().toLowerCase();
  const home = /^\/(Users|home)\/[^/]+/;
  const shown = importSessions.filter((s) => !q || `${s.cwd} ${s.title ?? ''} ${s.firstAsk} ${s.lastAsk ?? ''}`.toLowerCase().includes(q));
  const byDir = new Map();
  for (const s of shown) (byDir.get(s.cwd) ?? byDir.set(s.cwd, []).get(s.cwd)).push(s);
  $('#import-list').innerHTML = shown.length
    ? [...byDir]
        .map(
          ([dir, list]) => `<div class="import-dir"><h4><code>${esc(dir.replace(home, '~'))}</code>${list[0].exists ? '' : ' <span class="tag fail">folder gone</span>'}</h4>
          ${list
            .map(
              (s) => `<label class="import-row ${s.exists ? '' : 'off'}">
              <input type="checkbox" data-sid="${s.sessionId}" ${importPicked.has(s.sessionId) ? 'checked' : ''} ${s.exists ? '' : 'disabled'}>
              <span class="import-main"><b>${esc(s.title || s.firstAsk.slice(0, 80))}</b>
                ${s.inUse ? `<span class="tag warn" title="${s.inUse === 'open' ? 'A claude process in a terminal has this session open' : 'A claude process runs in this folder and the session was active minutes ago'}">${s.inUse === 'open' ? 'open in a terminal' : 'maybe open in a terminal'}</span>` : ''}
                <span class="hint">${s.title ? `${esc(s.firstAsk.slice(0, 120))}${s.lastAsk ? ` … last: ${esc(s.lastAsk.slice(0, 80))}` : ''}` : s.lastAsk ? `last: ${esc(s.lastAsk.slice(0, 100))}` : ''}</span>
                <span class="hint">${ago(s.lastActivity)}${s.branch ? ` · ⎇ ${esc(s.branch)}` : ''} · ${Math.max(1, Math.round(s.bytes / 1024))} KB · <code>${s.sessionId.slice(0, 8)}</code></span>
              </span></label>`,
            )
            .join('')}</div>`,
        )
        .join('')
    : `<p class="hint">${importSessions.length ? 'Nothing matches.' : 'No Claude sessions started in a terminal in this period (AI Agent Manager\'s own agents are left out).'}</p>`;
  const picked = importSessions.filter((s) => importPicked.has(s.sessionId));
  const open = picked.filter((s) => s.inUse).length;
  Object.assign($('#import-go'), {
    disabled: !picked.length,
    textContent: picked.length ? `Continue ${picked.length} session${picked.length > 1 ? 's' : ''}${open ? ` (${open} as a copy)` : ''}` : 'Continue',
    title: open ? 'Sessions still open in a terminal continue as a copy, so the terminal keeps the original' : '',
  });
}
$('#import-list').addEventListener('change', (e) => {
  const sid = e.target.dataset?.sid;
  if (!sid) return;
  if (e.target.checked) importPicked.add(sid);
  else importPicked.delete(sid);
  renderImport();
});
$('#import-filter').addEventListener('input', renderImport);
$('#import-days').addEventListener('change', loadImport);
$('#import-close').onclick = () => $('#import-dialog').close();
$('#import-go').onclick = async () => {
  const picked = importSessions.filter((s) => importPicked.has(s.sessionId));
  const plain = picked.filter((s) => !s.inUse).map((s) => s.sessionId);
  const copies = picked.filter((s) => s.inUse).map((s) => s.sessionId);
  await act(async () => {
    const start = $('#import-start').checked;
    const res = [
      ...(plain.length ? await api('POST', '/sessions/import', { sessions: plain, start }) : []),
      ...(copies.length ? await api('POST', '/sessions/import', { sessions: copies, start, copy: true }) : []),
    ];
    const ok = res.filter((r) => r.agentId);
    const bad = res.filter((r) => r.error);
    $('#import-dialog').close();
    if (ok.length) {
      showTab('agents');
      select(ok[0].agentId);
    }
    toast(`${ok.length} session${ok.length === 1 ? '' : 's'} continued here${bad.length ? `; ${bad.length} not: ${bad[0].error}` : ''}`, bad.length ? 7000 : 3000);
  });
};

// ------------------------------------------------------------------ live browser tabs

let liveAvailable = false;
api('GET', '/browser')
  .then((b) => {
    liveAvailable = b.available;
    // A browser tab opened before we knew: show it the way it should be.
    if (liveAvailable && term.agentId && isBrowser(term.kind)) {
      term.dropFrames();
      term.open(term.agentId, term.kind);
    }
  })
  .catch(() => {});
/** Live (a real browser on the daemon's machine, streamed) unless the tab was set to Lite or none is installed. */
const modeOf = (tab) => (liveAvailable ? tab.mode ?? 'live' : 'lite');
const MODS = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const SPECIAL_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/** The stream of one live tab, and the person's mouse, touch, keys and paste going back. */
/**
 * The page's sound: 16-bit stereo PCM chunks, scheduled back to back a little ahead (about
 * 0.3 s) so they play smoothly; if they fall behind by more than 1.5 s, skip ahead.
 */
const liveSound = {
  on: false,
  ctx: null,
  next: 0,

  toggle() {
    this.on = !this.on;
    if (this.on) {
      // Browsers (iPhones especially) start sound only from a tap: create and resume it here.
      this.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      this.ctx.resume();
      this.next = 0;
    } else this.ctx?.suspend();
    this.button();
    // Ask for the sound (or stop it) on the stream.
    if (liveView.id) {
      const tab = agents.get(liveView.id)?.browsers?.find((t) => t.n === liveView.n);
      liveView.close();
      if (tab) liveView.open(term.agentId, tab);
    }
  },

  button() {
    Object.assign($('#browser-sound'), {
      textContent: this.on ? '🔊' : '🔇',
      title: this.on ? 'Sound on: playing what this page plays on that machine. Click to mute' : 'Hear the page: sound from videos and audio playing on that machine',
    });
  },

  play(b64, rate) {
    if (!this.on || !this.ctx) return;
    const bin = atob(b64);
    const frames = bin.length >> 2;
    if (!frames) return;
    const buf = this.ctx.createBuffer(2, frames, rate);
    const l = buf.getChannelData(0);
    const r = buf.getChannelData(1);
    for (let i = 0, j = 0; i < frames; i++, j += 4) {
      const a = (bin.charCodeAt(j) | (bin.charCodeAt(j + 1) << 8)) << 16 >> 16;
      const b = (bin.charCodeAt(j + 2) | (bin.charCodeAt(j + 3) << 8)) << 16 >> 16;
      l[i] = a / 32768;
      r[i] = b / 32768;
    }
    const now = this.ctx.currentTime;
    if (this.next < now + 0.05 || this.next > now + 1.5) this.next = now + 0.3;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    src.start(this.next);
    this.next += buf.duration;
  },
};

const liveView = {
  es: null,
  key: null,
  frame: { w: 1280, h: 800 },
  queue: [],
  inflight: false,

  open(id, tab) {
    const key = `${id}:${tab.n}`;
    if (this.key === key && this.es) return void ($('#browser-live').hidden = false);
    this.close();
    $('#browser-live').hidden = false;
    this.key = key;
    this.id = id;
    this.n = tab.n;
    $('#browser-live-img').removeAttribute('src');
    this.message('Starting the browser on this machine…');
    const el = $('#browser-live');
    const size = new URLSearchParams({ width: el.clientWidth || 1280, height: el.clientHeight || 800, mobile: this.mobile(el) ? '1' : '', scale: devicePixelRatio || 1, audio: liveSound.on ? '1' : '' });
    const es = new EventSource(`/api/agents/${id}/browsers/${tab.n}/live/stream?${size}`);
    this.es = es;
    es.onmessage = (ev) => this.onMessage(JSON.parse(ev.data));
    es.onerror = () => es.readyState === EventSource.CLOSED && this.es === es && this.message('Disconnected from the browser. Reopen the tab to reconnect.');
    this.resize(true);
  },

  close() {
    this.es?.close();
    this.es = null;
    this.key = null;
    $('#browser-live').hidden = true;
  },

  img: () => $('#browser-live-img'),

  message(text) {
    const el = $('#browser-live-msg');
    el.hidden = !text;
    el.textContent = text ?? '';
  },

  onMessage(m) {
    if (m.t === 'frame') {
      // A frame of the old size is about to be replaced; showing it invites clicks in the wrong place.
      if (this.sized && Date.now() - this.sized.at < 1500 && Math.abs(m.w - this.sized.w) > 2 && this.img()?.src) return;
      this.frame = { w: m.w, h: m.h };
      $('#browser-live-img').src = `data:image/jpeg;base64,${m.d}`;
      this.message(null);
    } else if (m.t === 'state') {
      if (m.url && document.activeElement !== $('#browser-url')) $('#browser-url').value = m.url;
      $('#term-title').textContent = m.title && m.title !== m.url ? `${m.title} · ${m.url}` : m.url ?? '';
      if (m.url) upsertBrowsers(this.id, this.n, m.url);
    } else if (m.t === 'popup') {
      // A sign-in window and the like: follow it; it comes back here when it closes.
      this.opener = this.n;
      const id = this.id;
      setTimeout(() => term.open(id, `browser:${m.n}`), 150);
    } else if (m.t === 'closed') {
      const id = this.id;
      const back = this.opener;
      setTimeout(() => {
        const tabs = agents.get(id)?.browsers ?? [];
        if (term.agentId !== id || tabs.some((t) => `browser:${t.n}` === term.kind)) return;
        const to = tabs.find((t) => t.n === back) ?? tabs[0];
        term.open(id, to ? `browser:${to.n}` : 'browser:new');
      }, 400);
    } else if (m.t === 'audio') {
      liveSound.play(m.d, m.rate);
    } else if (m.t === 'download') {
      toast(`Downloaded ${m.name} to ${m.dir} on that machine`, 6000);
    } else if (m.t === 'error') {
      this.message(m.error);
    }
  },

  /** Page CSS pixels for a point on the shown image (it is letterboxed to keep its shape). */
  point(e) {
    const r = $('#browser-live-img').getBoundingClientRect();
    const k = Math.min(r.width / this.frame.w, r.height / this.frame.h) || 1;
    const ox = (r.width - this.frame.w * k) / 2;
    const oy = (r.height - this.frame.h * k) / 2;
    return { x: Math.round((e.clientX - r.left - ox) / k), y: Math.round((e.clientY - r.top - oy) / k) };
  },

  /** Events go out in order, a batch at a time; mouse moves and wheel turns are merged. */
  send(ev) {
    if (!this.es) return;
    const last = this.queue.at(-1);
    if (ev.type === 'mouse' && ev.action === 'move' && last?.type === 'mouse' && last.action === 'move') this.queue[this.queue.length - 1] = ev;
    else if (ev.type === 'wheel' && last?.type === 'wheel') Object.assign(last, { dx: last.dx + ev.dx, dy: last.dy + ev.dy, x: ev.x, y: ev.y });
    else this.queue.push(ev);
    setTimeout(() => this.pump(), 16);
  },

  async pump() {
    if (this.inflight || !this.queue.length || !this.id) return;
    this.inflight = true;
    const events = this.queue.splice(0);
    const touch = this.touchTap;
    this.touchTap = false;
    try {
      const r = await api('POST', `/agents/${this.id}/browsers/${this.n}/live/input`, { events });
      // The tap opened the keyboard already (phones only allow that during the tap itself);
      // put it away again if the tap wasn't on a text field.
      if (touch && !r.editable && !this.keyboardPinned) $('#browser-live-keys').blur();
    } catch {
    } finally {
      this.inflight = false;
      if (this.queue.length) this.pump();
    }
  },

  go(where) {
    if (this.id) act(() => api('POST', `/agents/${this.id}/browsers/${this.n}/live/go`, { where }));
  },

  mobile: (el) => matchMedia('(pointer: coarse)').matches && el.clientWidth < 700,

  resize(now) {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      const el = $('#browser-live');
      if (!this.id || el.hidden || !el.clientWidth) return;
      api('POST', `/agents/${this.id}/browsers/${this.n}/live/resize`, {
        width: el.clientWidth,
        height: el.clientHeight,
        mobile: this.mobile(el),
        scale: devicePixelRatio || 1,
      }).catch(() => {});
      this.sized = { w: el.clientWidth, h: el.clientHeight, at: Date.now() };
    }, now ? 0 : 200);
  },
};

{
  const el = $('#browser-live');
  const keys = $('#browser-live-keys');
  new ResizeObserver(() => liveView.resize()).observe(el);
  let touch = null; // { x, y, scrolled }
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => {
    if (e.target === keys) return;
    e.preventDefault();
    if (e.pointerType === 'touch') {
      touch = { x: e.clientX, y: e.clientY, scrolled: false };
      return;
    }
    keys.focus({ preventScroll: true });
    el.setPointerCapture(e.pointerId);
    liveView.send({ type: 'mouse', action: 'down', ...liveView.point(e), button: ['left', 'middle', 'right'][e.button] ?? 'left', clicks: e.detail || 1, modifiers: MODS(e) });
  });
  // Phones show the keyboard only for a focus during the tap's own touchend.
  el.addEventListener('touchend', () => {
    if (Date.now() - (liveView.tapAt ?? 0) < 400) keys.focus({ preventScroll: true });
  });
  $('#browser-sound').addEventListener('click', () => liveSound.toggle());
  $('#browser-keys').addEventListener('click', () => {
    liveView.keyboardPinned = document.activeElement !== keys;
    if (liveView.keyboardPinned) keys.focus({ preventScroll: true });
    else keys.blur();
  });
  keys.addEventListener('blur', () => (liveView.keyboardPinned = false));
  el.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') {
      if (!touch) return;
      const dx = touch.x - e.clientX;
      const dy = touch.y - e.clientY;
      if (!touch.scrolled && Math.hypot(dx, dy) < 8) return;
      touch.scrolled = true;
      const k = liveView.frame.w / el.clientWidth || 1;
      liveView.send({ type: 'wheel', ...liveView.point(e), dx: dx * k, dy: dy * k });
      Object.assign(touch, { x: e.clientX, y: e.clientY });
      return;
    }
    liveView.send({ type: 'mouse', action: 'move', ...liveView.point(e), button: e.buttons & 1 ? 'left' : 'none', buttons: e.buttons, modifiers: MODS(e) });
  });
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch') {
      if (touch && !touch.scrolled) {
        const p = liveView.point(e);
        liveView.touchTap = true;
        liveView.tapAt = Date.now();
        liveView.send({ type: 'mouse', action: 'down', ...p, button: 'left', clicks: 1 });
        liveView.send({ type: 'mouse', action: 'up', ...p, button: 'left', clicks: 1 });
      }
      touch = null;
      return;
    }
    liveView.send({ type: 'mouse', action: 'up', ...liveView.point(e), button: ['left', 'middle', 'right'][e.button] ?? 'left', clicks: e.detail || 1, modifiers: MODS(e) });
  });
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const line = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      liveView.send({ type: 'wheel', ...liveView.point(e), dx: e.deltaX * line, dy: e.deltaY * line, modifiers: MODS(e) });
    },
    { passive: false },
  );
  // Keys: special keys and shortcuts here; text comes through beforeinput (works with phone keyboards and IMEs).
  keys.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const mods = MODS(e);
    if (e.metaKey || e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (k === 'v') return; // the paste event brings the text
      if (k === 'c' || k === 'x') {
        e.preventDefault();
        api('GET', `/agents/${liveView.id}/browsers/${liveView.n}/live/selection`)
          .then((r) => r.text && navigator.clipboard?.writeText(r.text))
          .catch(() => {});
        if (k === 'x') liveView.send({ type: 'key', key: 'Delete' });
        return;
      }
      if (e.key.length === 1) {
        e.preventDefault();
        liveView.send({ type: 'key', key: e.key, modifiers: mods });
      }
      return;
    }
    if (SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      liveView.send({ type: 'key', key: e.key, modifiers: mods });
    }
  });
  keys.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText') {
      if (e.data) liveView.send({ type: [...e.data].length === 1 && e.inputType === 'insertText' ? 'char' : 'text', text: e.data });
    } else if (e.inputType === 'deleteContentBackward') liveView.send({ type: 'key', key: 'Backspace' });
    else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') liveView.send({ type: 'key', key: 'Enter' });
  });
  keys.addEventListener('compositionend', (e) => {
    if (e.data) liveView.send({ type: 'text', text: e.data });
    keys.value = '';
  });
  keys.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain');
    if (text) liveView.send({ type: 'text', text });
  });
}

// Attachments: the 📎 button, dropping files on the terminal, or pasting a file / screenshot.
$('#term-attach').onclick = () => $('#term-file').click();
$('#term-file').onchange = (e) => {
  term.attachFiles([...e.target.files]);
  e.target.value = '';
};
{
  const wrap = $('#term-wrap');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  wrap.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    $('#term-drop').hidden = false;
  });
  wrap.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  wrap.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      $('#term-drop').hidden = true;
    }
  });
  wrap.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $('#term-drop').hidden = true;
    term.attachFiles([...e.dataTransfer.files]);
  });
  // Capture phase, so it runs before xterm turns the paste into (empty) text.
  $('#terminal').addEventListener(
    'paste',
    (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      term.attachFiles(files);
    },
    true,
  );
}

// ------------------------------------------------------------------ events

function upsert(a) {
  agents.set(a.id, a);
  render();
  if (a.id === term.agentId) term.renderTabs();
}

$('#counts').addEventListener('click', (e) => {
  if (e.target.id === 'import-btn') return openImport();
  if (e.target.id !== 'flush-btn') return;
  act(async () => {
    const r = await api('POST', '/flush');
    toast(`Saved ${r.agents} agents · scrollback for ${r.scrollback}`);
  });
});

$('#agent-list').addEventListener('click', (e) => {
  const rename = e.target.closest('[data-rename]');
  if (rename) {
    e.stopPropagation();
    const old = rename.dataset.rename;
    const next = prompt(`New shortcut for this project (lowercase letters, digits, "-"):`, old);
    if (!next || next === old) return;
    return act(() => api('PATCH', `/projects/${encodeURIComponent(old)}`, { shortcut: next.trim().toLowerCase() }), `Shortcut is now ${next}`);
  }
  const head = e.target.closest('[data-toggle]');
  if (head) {
    const key = head.dataset.toggle;
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    saveCollapsed();
    return renderList();
  }
  const li = e.target.closest('li[data-id]');
  if (li) select(li.dataset.id);
});

const dropTarget = (e) => {
  const li = e.target.closest?.('li.project[data-move]');
  const a = dragging && agents.get(dragging);
  return li && li.dataset.move && a && (a.projectInfo?.key ?? 'other') !== li.dataset.key ? li : null;
};
const clearDrop = () => document.querySelectorAll('li.project.drop-target').forEach((x) => x.classList.remove('drop-target'));
$('#agent-list').addEventListener('dragstart', (e) => {
  const li = e.target.closest?.('li[data-id][draggable="true"]');
  if (!li) return;
  dragging = li.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', agents.get(dragging)?.name ?? dragging);
  li.classList.add('dragging');
  document.body.classList.add('dragging-agent');
});
$('#agent-list').addEventListener('dragover', (e) => {
  const li = dropTarget(e);
  if (!li) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!li.classList.contains('drop-target')) {
    clearDrop();
    li.classList.add('drop-target');
  }
});
$('#agent-list').addEventListener('dragleave', (e) => {
  const li = e.target.closest?.('li.project');
  if (li && !li.contains(e.relatedTarget)) li.classList.remove('drop-target');
});
$('#agent-list').addEventListener('drop', (e) => {
  const li = dropTarget(e);
  if (!li) return;
  e.preventDefault();
  const a = agents.get(dragging);
  const to = li.dataset.move;
  const label = li.querySelector('.pname')?.textContent ?? to;
  act(async () => upsert(await api('PATCH', `/agents/${a.id}`, { project: to })), `Moved ${a.name} to ${label}`);
});
document.addEventListener('dragend', () => {
  if (!dragging) return;
  dragging = null;
  clearDrop();
  document.body.classList.remove('dragging-agent');
  document.querySelector('li.agent.dragging')?.classList.remove('dragging');
  if (listStale) {
    listStale = false;
    renderList();
  }
});

// The title goes home: the Agents tab with no agent open.
$('#home-link').onclick = (e) => {
  e.preventDefault();
  showTab('agents');
  select(null);
};

$('#detail-body').addEventListener('click', async (e) => {
  const a = agents.get(selectedId);
  if (!a) return;
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.dataset.backlogAccept) return act(() => api('POST', `/backlog/${btn.dataset.backlogAccept}/accept`), 'Accepted: done');
  if (btn.dataset.backlogReopen) {
    const note = prompt('What still needs doing? (sent to this agent)', '');
    if (note === null) return;
    return act(() => api('POST', `/backlog/${btn.dataset.backlogReopen}/reopen`, { note }), 'Reopened');
  }
  if (btn.dataset.doc) return openDoc(a.id, btn.dataset.doc);
  if ('docAll' in btn.dataset) {
    return act(async () => {
      upsert(await api('POST', `/agents/${a.id}/docs/all?background=1`));
      toast(`Writing the documents for ${a.name} in the background (2 at a time); you'll be told as each is ready`, 4500);
    });
  }
  if (btn.dataset.tokens) {
    const id = btn.dataset.tokens;
    if (tokensOpen.has(id)) tokensOpen.delete(id);
    else tokensOpen.add(id);
    return renderDetail();
  }
  if (btn.dataset.more) {
    const key = btn.dataset.more;
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    return renderDetail();
  }
  if (btn.dataset.copy) {
    await navigator.clipboard.writeText(btn.dataset.copy).catch(() => {});
    return toast('Copied');
  }
  if (btn.dataset.unlink) {
    return act(async () =>
      upsert(await api('DELETE', `/agents/${a.id}/links?type=${btn.dataset.unlink}&key=${encodeURIComponent(btn.dataset.key)}`)),
    );
  }
  if (btn.dataset.resumeSession) {
    return act(async () => {
      upsert(await api('POST', `/agents/${a.id}/start`, { sessionId: btn.dataset.resumeSession }));
      term.open(a.id);
    });
  }

  switch (btn.dataset.act) {
    case 'terminal':
      if (!a.runtime.running) await act(async () => upsert(await api('POST', `/agents/${a.id}/start`, {})));
      term.open(a.id);
      break;
    case 'plan':
      act(async () => {
        upsert(await api('POST', `/agents/${a.id}/plan`));
        term.open(a.id);
      });
      break;
    case 'handoff':
      act(async () => {
        upsert(await api('POST', `/agents/${a.id}/handoff`));
        term.open(a.id);
      }, 'Moved into the repository');
      break;
    case 'project':
      return openEdit(a, 'project');
    case 'edit':
      return openEdit(a);
    case 'plan-open':
      return openPlan(a.id);
    case 'plan-on':
      return act(async () => upsert(await api('POST', `/agents/${a.id}/plan/review`, { on: true })), 'The agent will write a plan and wait for your review');
    case 'plan-skip':
      return act(async () => upsert(await api('POST', `/agents/${a.id}/plan/review`, { on: false })), 'Review skipped; the agent goes ahead');
    case 'insights':
      btn.disabled = true;
      btn.textContent = 'Thinking…';
      act(async () => upsert(await api('POST', `/agents/${a.id}/insights`)));
      break;
    case 'review':
      btn.disabled = true;
      btn.textContent = 'Reviewing…';
      act(async () => upsert(await api('POST', `/agents/${a.id}/review`)));
      break;
    case 'explain':
      btn.disabled = true;
      btn.textContent = 'Explaining…';
      act(async () => upsert(await api('POST', `/agents/${a.id}/explain`)));
      break;
    case 'shell':
      term.open(a.id, 'shell:1');
      break;
    case 'changes':
      return reviewUi.open(a.id);
    case 'memory':
      return openMemory(a);
    case 'fork':
      forkAgent(a.id);
      break;
    case 'checkpoint':
      act(async () => upsert(await api('POST', `/agents/${a.id}/checkpoint`)), 'Checkpoint saved');
      break;
    case 'start':
      act(
        async () => upsert(await api('POST', `/agents/${a.id}/start`, {})),
        a.workdir ? 'Resumed in the background' : 'Retrying setup',
      );
      break;
    case 'fresh':
      if (!confirm('Start a new claude session for this agent? Earlier session IDs are kept and can be resumed.')) return;
      act(async () => {
        upsert(await api('POST', `/agents/${a.id}/start`, { fresh: true }));
        term.open(a.id);
      });
      break;
    case 'stop':
      btn.disabled = true;
      act(async () => upsert(await api('POST', `/agents/${a.id}/stop`)), 'Session closed; the ID is kept for resuming');
      break;
    case 'refresh':
      act(async () => upsert(await api('POST', `/agents/${a.id}/refresh`)), 'Refreshed');
      break;
    case 'keep':
      act(async () => upsert(await api('PATCH', `/agents/${a.id}`, { keep: !a.keep })), a.keep ? 'Clean up may close or delete it again' : 'Kept: clean up leaves it alone');
      break;
    case 'delete': {
      const cancelNote = a.status === 'preparing' ? '\n\nThis also cancels the workspace setup (clone / checkout) in progress.' : '';
      if (!confirm(`Delete agent "${a.name}"? Its session IDs will be forgotten by AI Agent Manager.${cancelNote}`)) return;
      const del = a.worktree && confirm('Also remove the git worktree AI Agent Manager created for it?\n(Uncommitted changes there will be lost.)');
      act(async () => {
        const res = await api('DELETE', `/agents/${a.id}${del ? '?deleteWorkspace=1' : ''}`);
        if (res.warnings?.length) toast(res.warnings.join('; '), 6000);
      });
      break;
    }
  }
});

$('#detail-body').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target.closest('form[data-link]');
  const input = form.querySelector('input');
  const value = input.value.trim();
  if (!value) return;
  act(async () => {
    upsert(await api('POST', `/agents/${selectedId}/links`, { type: form.dataset.link, value }));
    form.querySelector('input').value = '';
    renderDetail();
  });
});

let notesTimer;
$('#detail-body').addEventListener('change', (e) => {
  const id = e.target.dataset.priority;
  if (!id) return;
  act(async () => upsert(await api('PATCH', `/agents/${id}`, { priority: Number(e.target.value) })), `Priority set to P${e.target.value}`);
});

$('#detail-body').addEventListener('input', (e) => {
  if (e.target.dataset.field !== 'notes') return;
  const id = selectedId;
  const notes = e.target.value;
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => act(() => api('PATCH', `/agents/${id}`, { notes })), 600);
});

$('#filter').addEventListener('input', (e) => {
  filterText = e.target.value.trim().toLowerCase();
  renderList();
});

$('#recent-days').value = recent.days;
$('#recent-on').addEventListener('change', (e) => {
  recent.on = e.target.checked;
  saveRecent();
  renderList();
});
$('#recent-days').addEventListener('input', (e) => {
  const n = Math.floor(Number(e.target.value));
  if (!(n >= 1)) return;
  recent.days = Math.min(3650, n);
  recent.on = true;
  saveRecent();
  renderList();
});
$('#recent-bar').addEventListener('click', (e) => {
  if (e.target.id !== 'recent-off') return;
  recent.on = false;
  saveRecent();
  renderList();
});

// ------------------------------------------------------------------ new agents dialog

const dialog = $('#new-dialog');
function renderProjectOptions() {
  $('#project-options').innerHTML = projectsState
    .map((p) => `<option value="${esc(p.shortcut)}">${esc(p.name)}${p.repo ? ` · ${esc(p.repo)}` : p.dir ? ` · ${esc(p.dir)}` : ''}</option>`)
    .join('');
}

function openNewDialog(mode = 'now') {
  renderProjectOptions();
  $('#new-error').hidden = true;
  dialog.querySelector(`input[name="when"][value="${mode}"]`).checked = true;
  syncWhen();
  dialog.showModal();
  dialog.querySelector('textarea').focus();
}
function syncWhen() {
  const when = dialog.querySelector('input[name="when"]:checked').value;
  dialog.querySelector('.now-only').hidden = when !== 'now';
  dialog.querySelector('.race-only').hidden = when !== 'race';
  dialog.querySelector('.team-only').hidden = when !== 'team';
  dialog.querySelector('button[type=submit]').textContent = { backlog: 'Add to backlog', race: 'Start race', team: 'Start team' }[when] ?? 'Create agents';
}
for (const r of dialog.querySelectorAll('input[name="when"]')) r.addEventListener('change', syncWhen);
$('#new-btn').onclick = () => openNewDialog('now');
$('#new-cancel').onclick = () => dialog.close();
$('#new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const intents = String(f.get('intents'))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (f.get('when') === 'team') {
    // "analyst=opus reviewer=opus"
    const models = Object.fromEntries(
      String(f.get('roleModels') || '')
        .split(/[\s,]+/)
        .map((p) => p.split('='))
        .filter(([k, v]) => k && v),
    );
    try {
      const team = await api('POST', '/teams', {
        intent: intents.join('\n'),
        critics: Number(f.get('critics')),
        mode: f.get('teamMode') || undefined,
        testCommand: f.get('teamTest') || undefined,
        // Empty: the defaults (3 rounds each; gap rounds 0, so it asks first).
        ...Object.fromEntries(['maxRounds', 'maxLoops', 'gapRounds'].filter((k) => String(f.get(k) ?? '') !== '').map((k) => [k, Number(f.get(k))])),
        models,
        repo: f.get('repo') || undefined,
        dir: f.get('dir') || undefined,
        base: f.get('base') || undefined,
        project: f.get('project') || undefined,
        permissionMode: f.get('permissionMode') || undefined,
        model: f.get('model') || undefined,
        engine: f.get('engine') || undefined,
        priority: Number(f.get('priority')),
      });
      teams.set(team.id, team);
      dialog.close();
      e.target.reset();
      syncWhen();
      openTeam(team.id);
      toast(team.mode === 'lead' ? 'Team started: one lead session with sub-agents' : `Team started: ${team.members.length} agents`);
    } catch (err) {
      $('#new-error').textContent = err.message;
      $('#new-error').hidden = false;
    }
    return;
  }
  if (f.get('when') === 'race') {
    // "model", "model | approach" or "| approach", one attempt per line.
    const variants = String(f.get('variants') || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [model, ...rest] = l.split('|');
        return { model: model.trim() || undefined, instructions: rest.join('|').trim() || undefined };
      });
    try {
      const race = await api('POST', '/races', {
        intent: intents.join('\n'),
        variants,
        testCommand: f.get('testCommand') || undefined,
        repo: f.get('repo') || undefined,
        dir: f.get('dir') || undefined,
        base: f.get('base') || undefined,
        project: f.get('project') || undefined,
        permissionMode: f.get('permissionMode') || undefined,
        model: f.get('model') || undefined,
        priority: Number(f.get('priority')),
      });
      races.set(race.id, race);
      dialog.close();
      e.target.reset();
      syncWhen();
      openRace(race.id);
      toast(`Race started: ${race.rows.length} attempts`);
    } catch (err) {
      $('#new-error').textContent = err.message;
      $('#new-error').hidden = false;
    }
    return;
  }
  if (f.get('when') === 'backlog') {
    try {
      const added = await api('POST', '/backlog', {
        items: intents,
        repo: f.get('repo') || undefined,
        dir: f.get('dir') || undefined,
        base: f.get('base') || undefined,
        project: f.get('project') || undefined,
        permissionMode: f.get('permissionMode') || undefined,
        model: f.get('model') || undefined,
        engine: f.get('engine') || undefined,
        worktree: f.get('worktree') ? true : undefined,
        plan: Boolean(f.get('plan')),
        planReview: Boolean(f.get('planReview')),
        priority: Number(f.get('priority')),
      });
      dialog.close();
      e.target.reset();
      showTab('backlog');
      toast(`Queued ${added.length} item${added.length > 1 ? 's' : ''}`);
    } catch (err) {
      $('#new-error').textContent = err.message;
      $('#new-error').hidden = false;
    }
    return;
  }
  try {
    const created = await api('POST', '/agents', {
      priority: Number(f.get('priority')),
      intents,
      repo: f.get('repo') || undefined,
      dir: f.get('dir') || undefined,
      permissionMode: f.get('permissionMode') || undefined,
      model: f.get('model') || undefined,
      engine: f.get('engine') || undefined,
      worktree: f.get('worktree') ? true : undefined,
      base: f.get('base') || undefined,
      project: f.get('project') || undefined,
      plan: Boolean(f.get('plan')),
      planReview: Boolean(f.get('planReview')),
      start: Boolean(f.get('start')),
    });
    created.forEach((a) => agents.set(a.id, a));
    dialog.close();
    e.target.reset();
    select(created[0].id);
    toast(`Created ${created.length} agent${created.length > 1 ? 's' : ''}`);
    if (created.length === 1 && created[0].runtime.planning) term.open(created[0].id);
  } catch (err) {
    $('#new-error').textContent = err.message;
    $('#new-error').hidden = false;
  }
});

// ------------------------------------------------------------------ ask (general session)

// ---------------------------------------------------------------- about
const aboutDialog = $('#about-dialog');
let aboutInfo = null;
async function loadAbout() {
  aboutInfo = await api('GET', '/about');
  $('#about-btn').textContent = `v${aboutInfo.version}`;
  return aboutInfo;
}
loadAbout().catch(() => {});
function renderAbout(a) {
  const link = (url, text = url.replace(/^https:\/\//, '')) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
  const when = (iso) => new Date(iso).toLocaleString();
  const rows = [
    ['Version', `${esc(a.version)}${a.releaseDate ? ` <span class="hint">released ${esc(a.releaseDate)}</span>` : ''}`],
    ['Author', esc(a.author ?? '—')],
    ['License', esc(a.license ?? '—')],
    ['Install', `<code>npm install -g ${esc(a.package)}</code>, then <code>${esc(a.command ?? 'agentmgr')}</code>`],
    ['Code', a.links.repository ? link(a.links.repository) : '—'],
    ['Releases', a.links.releases ? link(a.links.releases, 'Release notes') : '—'],
    ['Report a problem', a.links.issues ? link(a.links.issues, 'GitHub issues') : '—'],
    null,
    ['Daemon', `pid ${esc(a.daemon.pid)} · port ${esc(a.daemon.port ?? '—')} · running since ${esc(when(a.daemon.startedAt))}`],
    ['Data folder', `<code>${esc(a.daemon.home ?? '—')}</code>`],
    ['Node.js', esc(a.daemon.node)],
    ['System', esc(a.daemon.platform)],
    ['Claude Code', `<code>${esc(a.daemon.claudeBin ?? 'claude')}</code>`],
  ];
  $('#about-list').innerHTML = rows.map((r) => (r ? `<dt>${r[0]}</dt><dd>${r[1]}</dd>` : '<div class="sep"></div>')).join('');
}
$('#about-btn').onclick = async () => {
  $('#about-update').hidden = true;
  if (aboutInfo) renderAbout(aboutInfo);
  else $('#about-list').innerHTML = '<dt>Loading…</dt><dd></dd>';
  aboutDialog.showModal();
  try {
    renderAbout(await loadAbout()); // fresh daemon details (uptime, pid) each time it opens
  } catch (err) {
    $('#about-list').innerHTML = `<dt>Error</dt><dd>${esc(err.message)}</dd>`;
  }
};
$('#about-close').onclick = () => aboutDialog.close();
$('#about-check').onclick = async () => {
  const out = $('#about-update');
  out.hidden = false;
  out.textContent = 'Checking…';
  try {
    // On this computer the daemon can install it; from a phone, just say what is out.
    const local = await updateUi.check().catch(() => null);
    if (local) return void (out.innerHTML = local);
    const r = await api('GET', '/about/latest');
    out.innerHTML = r.newer
      ? `Version ${esc(r.latest)} is available. Update with <code>npm install -g ${esc(aboutInfo?.package ?? 'ai-agentmanager')}@latest</code>, then <code>agentmgr restart</code>.`
      : `You have the latest version (${esc(r.current)}).`;
  } catch (err) {
    out.textContent = `Couldn't check: ${err.message}`;
  }
};

const askDialog = $('#ask-dialog');
$('#ask-btn').onclick = () => {
  $('#ask-error').hidden = true;
  askDialog.showModal();
  askDialog.querySelector('textarea').focus();
};
$('#ask-cancel').onclick = () => askDialog.close();
$('#ask-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const a = await api('POST', '/general', {
      question: String(f.get('question') || '').trim() || undefined,
      name: String(f.get('name') || '').trim() || undefined,
    });
    agents.set(a.id, a);
    askDialog.close();
    e.target.reset();
    select(a.id);
    // The shared general folder is ready almost immediately; open the terminal once it runs.
    const t0 = Date.now();
    const wait = setInterval(() => {
      const cur = agents.get(a.id);
      if (cur?.runtime.running || Date.now() - t0 > 10000) {
        clearInterval(wait);
        if (cur?.runtime.running && selectedId === a.id) term.open(a.id);
      }
    }, 150);
  } catch (err) {
    $('#ask-error').textContent = err.message;
    $('#ask-error').hidden = false;
  }
});
$('#ask-form textarea').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#ask-form').requestSubmit();
});

// ------------------------------------------------------------------ live updates

function handleEvent(msg) {
  if (msg.t === 'snapshot') {
    agents.clear();
    msg.agents.forEach((a) => agents.set(a.id, a));
    if (msg.backlog) backlogState = msg.backlog;
    if (msg.projects) projectsState = msg.projects;
    races.clear();
    for (const r of msg.races ?? []) races.set(r.id, r);
    teams.clear();
    for (const t of msg.teams ?? []) teams.set(t.id, t);
    msg.agents.forEach(watchDocs);
    if (selectedId && !agents.has(selectedId)) selectedId = null;
    if (openTermOnLoad && selectedId) {
      if (isShell(hashView) || isBrowser(hashView) || hashView === 'code') term.open(selectedId, hashView);
      else if (agents.get(selectedId).runtime.running) term.open(selectedId);
    }
    openTermOnLoad = false;
  } else if (msg.t === 'agent') {
    agents.set(msg.agent.id, msg.agent);
    watchDocs(msg.agent);
    if (msg.agent.id === term.agentId) term.renderTabs();
  } else if (msg.t === 'removed') {
    agents.delete(msg.id);
    if (selectedId === msg.id) select(null);
  } else if (msg.t === 'race') {
    races.set(msg.race.id, msg.race);
  } else if (msg.t === 'race-removed') {
    races.delete(msg.id);
  } else if (msg.t === 'team') {
    teams.set(msg.team.id, msg.team);
  } else if (msg.t === 'team-removed') {
    teams.delete(msg.id);
  } else if (msg.t === 'backlog') {
    backlogState = msg.backlog;
  } else if (msg.t === 'projects') {
    projectsState = msg.projects;
    renderProjectOptions();
  }
  render();
}

function connectEvents() {
  openStream(
    { events: true },
    {
      onOpen: () => {
        $('#conn').textContent = REMOTE ? 'connected (remote)' : 'daemon connected';
        $('#conn').className = 'conn ok';
      },
      onMessage: handleEvent,
      onClose: async () => {
        $('#conn').textContent = 'daemon offline, retrying…';
        $('#conn').className = 'conn bad';
        if (REMOTE && !(await sessionOk())) return showLogin();
        setTimeout(connectEvents, 2000);
      },
    },
  );
}

// ------------------------------------------------------------------ phone keys and reply box

const KEYS = {
  esc: '\x1b', tab: '\t', stab: '\x1b[Z', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  enter: '\r', ctrlc: '\x03', 1: '1', 2: '2', 3: '3', 4: '4',
};
$('#keybar').addEventListener('click', (e) => {
  const key = e.target.closest('[data-key]')?.dataset.key;
  if (key) term.send({ t: 'i', d: KEYS[key] });
});
// Keep the on-screen keyboard from popping up when tapping keybar buttons.
$('#keybar').addEventListener('mousedown', (e) => e.preventDefault());

$('#compose').addEventListener('submit', (e) => {
  e.preventDefault();
  const box = $('#compose-text');
  const text = box.value;
  if (!text.trim()) return;
  term.send({ t: 'i', d: text });
  // Enter separately, so Claude reads the text as typed input and then submits it.
  setTimeout(() => term.send({ t: 'i', d: '\r' }), 150);
  box.value = '';
  box.style.height = '';
});
$('#compose-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#compose').requestSubmit();
  }
});
$('#compose-text').addEventListener('input', (e) => {
  e.target.style.height = '';
  e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
});

// ------------------------------------------------------------------ remote access (from this computer)

async function renderRemote() {
  const box = $('#remote-content');
  let st;
  try {
    st = await api('GET', '/remote');
  } catch (err) {
    box.textContent = err.message;
    return;
  }
  const phoneUrls = st.urls.filter((u) => !u.vpn);
  const vpnUrls = st.urls.filter((u) => u.vpn);
  box.innerHTML = `
    <p class="remote-state">
      ${st.enabled && st.running ? `<span class="pill working">on</span> HTTPS on port <b>${st.port}</b>` : '<span class="pill">off</span> Not reachable from other devices.'}
      <button id="remote-toggle" class="${st.enabled ? '' : 'primary'}">${st.enabled ? 'Turn off' : 'Turn on'}</button>
    </p>
    ${st.enabled && st.running
      ? `${phoneUrls.length
          ? phoneUrls
              .map(
                (u) => `<div class="remote-url">
                  <div class="qr">${u.qr}</div>
                  <div>
                    <div><b>Scan with your phone's camera</b> to open and sign in.</div>
                    <code>${esc(u.url)}</code> <span class="hint">(${esc(u.iface)})</span>
                    <div><button class="small" data-copy="${esc(u.loginUrl)}">Copy sign-in link</button></div>
                  </div>
                </div>`,
              )
              .join('')
          : '<p class="error">This computer has no network address a phone can reach. Join Wi-Fi or your phone\'s Personal Hotspot.</p>'}
        ${vpnUrls.length ? `<p class="hint">Over the VPN only (a phone usually can't reach these): ${vpnUrls.map((u) => `<code>${esc(u.url)}</code>`).join(' ')}</p>` : ''}
        <ul class="remote-notes hint">
          <li>The phone must be on the <b>same network</b> as this computer: the same Wi-Fi, or this computer joined to the phone's <b>Personal Hotspot</b>. Office Wi-Fi often blocks device-to-device traffic.</li>
          <li>The first visit warns about the certificate (it's self-signed). Check the fingerprint below, then choose <i>Show Details → visit this website</i> (Safari) or <i>Advanced → Proceed</i> (Chrome).</li>
          <li>If macOS asks whether <b>node</b> may accept incoming connections, choose Allow.</li>
        </ul>
        <p class="hint">Certificate SHA-256: <code class="fp">${esc(st.fingerprint ?? '')}</code></p>
        <h3>Signed-in devices</h3>
        ${st.devices.length
          ? `<table class="devices"><tr><th>Device</th><th>Address</th><th>Last seen</th><th></th></tr>${st.devices
              .map(
                (d) => `<tr><td title="${esc(d.ua)}">${esc(deviceName(d.ua))}</td><td>${esc(d.ip ?? '')}</td><td>${ago(d.lastSeen)}</td>
                  <td><button class="small danger" data-revoke="${esc(d.id)}">Sign out</button></td></tr>`,
              )
              .join('')}</table>`
          : '<p class="hint">None yet.</p>'}
        <p><button id="remote-rotate" class="danger">New access token</button> <span class="hint">Signs out every device; scan the new QR code to sign in again.</span></p>`
      : ''}`;
}

function deviceName(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Device';
  const browser = /CriOS|Chrome/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '';
  return [os, browser].filter(Boolean).join(' · ');
}

$('#remote-btn').onclick = () => {
  $('#remote-dialog').showModal();
  renderRemote();
};
$('#remote-close').onclick = () => $('#remote-dialog').close();
$('#remote-content').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.copy) {
    await navigator.clipboard.writeText(btn.dataset.copy).catch(() => {});
    return toast('Sign-in link copied. It contains the access token; share it only with your own devices.', 4000);
  }
  if (btn.id === 'remote-toggle') {
    const on = btn.textContent === 'Turn on';
    await act(() => api('POST', on ? '/remote/enable' : '/remote/disable'), on ? 'Remote access on' : 'Remote access off');
  } else if (btn.id === 'remote-rotate') {
    if (!confirm('Create a new access token? Every signed-in device is signed out.')) return;
    await act(() => api('POST', '/remote/rotate'), 'New token created; all devices signed out');
  } else if (btn.dataset.revoke) {
    await act(() => api('DELETE', `/remote/devices/${btn.dataset.revoke}`), 'Device signed out');
  }
  renderRemote();
});

// ------------------------------------------------------------------ clean up old agents

const CLEANUP_TEXT = {
  'close-delete': 'Checked every few hours: idle agents are closed, and closed ones deleted, on their own.',
  close: 'Checked every few hours: idle agents are closed on their own. Deleting waits for you.',
  manual: 'Nothing happens on its own. Use the buttons below when you want to clean up.',
  off: 'Nothing happens on its own.',
};

async function loadCleanup() {
  const c = await api('GET', '/cleanup');
  const f = $('#cleanup-form');
  f.strategy.value = c.strategy;
  f.closeAfterDays.value = c.closeAfterDays;
  f.deleteAfterDays.value = c.deleteAfterDays;
  const list = (rows, age) => `<ul>${rows.map((x) => `<li><a href="#${x.id}" data-cleanup-goto="${x.id}">${esc(x.name)}</a><span class="hint">${age(x)}${x.reason ? ` · ${esc(x.reason)}` : ''}</span></li>`).join('')}</ul>`;
  $('#cleanup-plan').innerHTML = `<p class="hint" id="cleanup-what">${CLEANUP_TEXT[c.strategy]}</p>
    ${c.close.length ? `<h4>Due to close (${c.close.length})</h4>${list(c.close, (x) => `idle ${x.idleDays} days`)}` : ''}
    ${c.delete.length ? `<h4>Due to delete (${c.delete.length})</h4>${list(c.delete, (x) => `closed ${x.closedDays} days`)}` : ''}
    ${c.kept.length ? `<h4>Old, but left alone (${c.kept.length})</h4>${list(c.kept, (x) => (x.closedDays != null ? `closed ${x.closedDays} days` : `idle ${x.idleDays} days`))}` : ''}
    ${!c.close.length && !c.delete.length && !c.kept.length ? '<p>Nothing is due.</p>' : ''}
    ${c.lastRun ? `<p class="hint">Last run ${ago(c.lastRun.at)} (${c.lastRun.by === 'schedule' ? 'on its own' : 'by you'}): closed ${c.lastRun.closed.length}, deleted ${c.lastRun.deleted.length}${c.lastRun.failed?.length ? `, ${c.lastRun.failed.length} failed` : ''}.</p>` : ''}`;
  $('#cleanup-run-close').disabled = !c.close.length;
  $('#cleanup-run').disabled = !c.close.length && !c.delete.length;
  $('#cleanup-error').hidden = true;
  return c;
}

$('#cleanup-btn').onclick = async () => {
  $('#cleanup-dialog').showModal();
  await loadCleanup().catch((err) => toast(err.message));
};
$('#cleanup-close').onclick = () => $('#cleanup-dialog').close();
$('#cleanup-form').strategy.addEventListener('change', (e) => {
  if ($('#cleanup-what')) $('#cleanup-what').textContent = `${CLEANUP_TEXT[e.target.value]} (Save to apply.)`;
});
$('#cleanup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('PUT', '/cleanup', { strategy: f.strategy.value, closeAfterDays: Number(f.closeAfterDays.value), deleteAfterDays: Number(f.deleteAfterDays.value) });
    toast('Clean up settings saved');
    await loadCleanup();
  } catch (err) {
    $('#cleanup-error').textContent = err.message;
    $('#cleanup-error').hidden = false;
  }
});
async function runCleanup(del) {
  const c = await loadCleanup();
  const n = c.close.length + (del ? c.delete.length : 0);
  if (!n) return;
  if (del && c.delete.length && !confirm(`Delete ${c.delete.length} agent${c.delete.length > 1 ? 's' : ''} and their worktrees${c.close.length ? `, and close ${c.close.length}` : ''}?\n\n${c.delete.map((x) => x.name).join('\n')}`)) return;
  const r = await api('POST', '/cleanup/run', { delete: del });
  toast(`Closed ${r.closed.length}, deleted ${r.deleted.length}${r.failed.length ? `; ${r.failed.length} failed: ${r.failed[0].reason}` : ''}`);
  await loadCleanup();
}
$('#cleanup-run-close').onclick = () => runCleanup(false).catch((err) => toast(err.message));
$('#cleanup-run').onclick = () => runCleanup(true).catch((err) => toast(err.message));
$('#cleanup-plan').addEventListener('click', (e) => {
  const go = e.target.closest('[data-cleanup-goto]');
  if (!go) return;
  e.preventDefault();
  $('#cleanup-dialog').close();
  select(go.dataset.cleanupGoto);
});

// ------------------------------------------------------------------ edit an agent

let editing = null;
let enginesCache = null;
// The project picked in the dialog: "" while it is listed under its own repo or folder.
const editProject = (a) => (a.projectMove || a.project ? (a.projectInfo?.shortcut ?? '') : '');

let memoryAgent = null;
async function openMemory(a) {
  memoryAgent = a.id;
  const f = $('#memory-form');
  $('#memory-error').hidden = true;
  try {
    const m = await api('GET', `/agents/${a.id}/memory`);
    $('#memory-repo').textContent = a.projectInfo?.full || a.projectInfo?.name || a.repo || 'this repo';
    f.text.value = m.text;
    $('#memory-meta').textContent = `${m.entries} learning${m.entries === 1 ? '' : 's'} · ${(m.bytes / 1000).toFixed(1)} of ${m.max / 1000} KB`;
    $('#memory-dialog').showModal();
  } catch (err) {
    toast(`Error: ${err.message}`, 5000);
  }
}
$('#memory-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('PUT', `/agents/${memoryAgent}/memory`, { text: $('#memory-form').text.value });
    $('#memory-dialog').close();
    toast('Saved; agents get it from their next start');
  } catch (err) {
    $('#memory-error').hidden = false;
    $('#memory-error').textContent = err.message;
  }
});
$('#memory-close').onclick = () => $('#memory-dialog').close();

async function openEdit(a, focus) {
  editing = a;
  const f = $('#edit-form');
  f.name.value = a.name;
  f.intent.value = a.intent ?? '';
  f.tell.checked = false;
  f.priority.value = String(a.priority ?? 2);
  f.model.value = a.model ?? '';
  f.budgetUsd.value = a.budgetUsd ?? '';
  $('#edit-project-row').hidden = noRepo(a);
  $('#edit-tell-row').hidden = !a.intent;
  // Its own repo or folder, every known project, or a new name.
  f.project.innerHTML = [
    '<option value="">Its own repo or folder</option>',
    ...projectsState.map((p) => `<option value="${esc(p.shortcut)}">${esc(p.name)} (@${esc(p.shortcut)})</option>`),
    '<option value="__new">New project name…</option>',
  ].join('');
  f.project.value = editProject(a);
  $('#edit-newproject-row').hidden = true;
  f.newProject.value = '';
  enginesCache ??= await api('GET', '/engines').catch(() => []);
  const modes = enginesCache.find((e) => e.id === (a.engine ?? 'claude'))?.permissionModes ?? [];
  f.permissionMode.innerHTML = ['<option value="">As configured</option>', ...modes.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`)].join('');
  f.permissionMode.value = a.permissionMode ?? '';
  $('#edit-error').hidden = true;
  $('#edit-dialog').showModal();
  (focus === 'project' ? f.project : f.name).focus();
}

$('#edit-form').project.addEventListener('change', (e) => {
  $('#edit-newproject-row').hidden = e.target.value !== '__new';
  if (e.target.value === '__new') $('#edit-form').newProject.focus();
});
$('#edit-close').onclick = () => $('#edit-dialog').close();
$('#edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const a = editing;
  const f = e.target;
  const patch = {};
  if (f.name.value.trim() !== a.name) patch.name = f.name.value.trim();
  if (f.intent.value.trim() !== (a.intent ?? '')) patch.intent = f.intent.value.trim();
  if (Number(f.priority.value) !== (a.priority ?? 2)) patch.priority = Number(f.priority.value);
  if ((f.permissionMode.value || null) !== (a.permissionMode ?? null)) patch.permissionMode = f.permissionMode.value || null;
  if ((f.model.value.trim() || null) !== (a.model ?? null)) patch.model = f.model.value.trim() || null;
  if ((f.budgetUsd.value === '' ? null : Number(f.budgetUsd.value)) !== (a.budgetUsd ?? null)) patch.budgetUsd = f.budgetUsd.value === '' ? null : Number(f.budgetUsd.value);
  if (!noRepo(a)) {
    const target = f.project.value === '__new' ? f.newProject.value.trim() : f.project.value;
    const was = editProject(a);
    if (f.project.value === '__new' && !target) {
      $('#edit-error').textContent = 'Give the new project a name';
      $('#edit-error').hidden = false;
      return;
    }
    if (target !== was) patch.project = target;
  }
  try {
    if (Object.keys(patch).length) upsert(await api('PATCH', `/agents/${a.id}`, patch));
    if (patch.intent && f.tell.checked) await api('POST', `/agents/${a.id}/tell`, { text: `The request changed. It is now:\n${patch.intent}` });
    $('#edit-dialog').close();
    const relaunch = 'permissionMode' in patch || 'model' in patch;
    toast(!Object.keys(patch).length ? 'Nothing changed' : `Saved${patch.project !== undefined ? '; moved' : ''}${relaunch ? '. Permission mode and model apply from its next launch' : ''}`);
  } catch (err) {
    $('#edit-error').textContent = err.message;
    $('#edit-error').hidden = false;
  }
});

// ------------------------------------------------------------------ assistant

const ASSISTANT_SOURCES = ['jira', 'comments', 'reviews', 'ci', 'slack', 'linear'];
let assistantState = null;

function renderAssistantDot() {
  const a = assistantState;
  const dot = $('#assistant-dot');
  dot.hidden = !a?.agentId;
  if (a) {
    dot.className = `assistant-dot ${a.on ? (a.busy ? 'busy' : 'on') : 'off'}`;
    dot.title = a.on ? (a.busy ? 'Checking now' : 'On') : 'Paused';
  }
}

async function loadAssistant({ fill = true } = {}) {
  const a = await api('GET', '/assistant');
  assistantState = a;
  renderAssistantDot();
  const f = $('#assistant-form');
  if (fill) {
    for (const k of ASSISTANT_SOURCES) f[`src_${k}`].checked = a.sources.includes(k);
    f.everyMin.value = a.everyMin;
    f.maxPerDay.value = a.maxPerDay;
    f.maxRunning.value = a.maxRunning;
    f.notes.value = a.notes ?? '';
  }
  const state = !a.agentId ? 'Not set up yet. Start it to create its session.' : a.on ? (a.busy ? 'On: checking now.' : 'On.') : 'Paused: not checking.';
  $('#assistant-status').innerHTML = `<p><b>${esc(state)}</b>
    ${a.lastCheckAt ? ` Last check ${ago(a.lastCheckAt)}.` : ''}${a.nextAt && a.on ? ` Next ${new Date(a.nextAt) <= new Date() ? 'when it is free' : `at ${new Date(a.nextAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}.` : ''}
    ${a.agentId ? ` Started ${a.startedToday} agent${a.startedToday === 1 ? '' : 's'} today, ${a.startedTotal} in all.` : ''}</p>
    ${a.started.length ? `<ul class="assistant-started">${a.started.slice(0, 8).map((x) => `<li><a href="#${x.id}" data-assistant-goto="${x.id}">${esc(x.name)}</a> <span class="hint">${ago(x.createdAt)} · ${esc(x.intent.slice(0, 90))}</span></li>`).join('')}</ul>` : ''}`;
  $('#assistant-activity').innerHTML = a.activity ? `<h4>Activity</h4><div class="md">${md(a.activity.split(/\n(?=## )/).reverse().slice(0, 10).join('\n').replace(/([^\n])\n(?=[^\n#\-*])/g, '$1  \n'))}</div>` : a.agentId ? '<p class="hint">No activity yet. Its first check writes here.</p>' : '';
  $('#assistant-start').hidden = Boolean(a.on);
  $('#assistant-start').textContent = a.agentId ? 'Turn on' : 'Start';
  $('#assistant-pause').hidden = !a.on;
  $('#assistant-check').hidden = !a.on;
  $('#assistant-open').hidden = !a.agentId;
  $('#assistant-error').hidden = true;
  return a;
}

const assistantPatch = (f) => ({
  sources: ASSISTANT_SOURCES.filter((k) => f[`src_${k}`].checked),
  everyMin: Number(f.everyMin.value),
  maxPerDay: Number(f.maxPerDay.value),
  maxRunning: Number(f.maxRunning.value),
  notes: f.notes.value,
});
const assistantError = (err) => {
  $('#assistant-error').textContent = err.message;
  $('#assistant-error').hidden = false;
};
$('#assistant-btn').onclick = async () => {
  $('#assistant-dialog').showModal();
  await loadAssistant().catch(assistantError);
};
$('#assistant-close').onclick = () => $('#assistant-dialog').close();
$('#assistant-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('PUT', '/assistant', assistantPatch(e.target));
    toast(assistantState?.running ? 'Saved. A running assistant uses the new watch list and notes after Pause and Turn on.' : 'Assistant settings saved');
    await loadAssistant();
  } catch (err) {
    assistantError(err);
  }
});
$('#assistant-start').onclick = async () => {
  try {
    if (!assistantState?.agentId) await api('PUT', '/assistant', assistantPatch($('#assistant-form')));
    await api('POST', '/assistant/start');
    toast('Assistant on: its first check starts in a moment');
    await loadAssistant({ fill: false });
  } catch (err) {
    assistantError(err);
  }
};
$('#assistant-pause').onclick = async () => {
  try {
    await api('POST', '/assistant/pause');
    await loadAssistant({ fill: false });
  } catch (err) {
    assistantError(err);
  }
};
$('#assistant-check').onclick = async () => {
  try {
    await api('POST', '/assistant/check');
    toast('Asked the assistant to check now');
    await loadAssistant({ fill: false });
  } catch (err) {
    assistantError(err);
  }
};
$('#assistant-open').onclick = () => {
  $('#assistant-dialog').close();
  if (assistantState?.agentId) select(assistantState.agentId);
};
$('#assistant-dialog').addEventListener('click', (e) => {
  const go = e.target.closest('[data-assistant-goto]');
  if (!go) return;
  e.preventDefault();
  $('#assistant-dialog').close();
  select(go.dataset.assistantGoto);
});
loadAssistant({ fill: false }).catch(() => {});
setInterval(() => loadAssistant({ fill: false }).catch(() => {}), 60_000);

// ------------------------------------------------------------------ Slack alerts (from this computer)

async function loadAlerts() {
  const n = await api('GET', '/notify');
  const f = $('#alerts-form');
  f.webhookUrl.value = '';
  f.botToken.value = '';
  f.channel.value = n.slack.channel ?? '';
  f.webhookUrl.placeholder = n.slack.webhookUrl ?? 'https://hooks.slack.com/services/…';
  f.botToken.placeholder = n.slack.botToken ?? 'xoxb-…';
  for (const k of Object.keys(n.events)) if (f[`ev_${k}`]) f[`ev_${k}`].checked = n.events[k];
  f.needsInputDelaySec.value = n.needsInputDelaySec;
  f.waitingDelaySec.value = n.waitingDelaySec;
  f.skipWhenWatching.checked = n.skipWhenWatching;
  f.includeIntent.checked = n.includeIntent;
  f.enabled.checked = n.enabled;
  $('#alerts-current').textContent = n.configured
    ? `Configured: ${n.slack.channel ? `bot token → ${n.slack.channel}` : `webhook ${n.slack.webhookUrl}`}. Leave the fields empty to keep it.`
    : 'Not configured yet.';
  $('#alerts-recent').innerHTML = n.recent.length
    ? `Recent: ${n.recent.slice(0, 5).map((r) => `${esc(r.kind)} · ${esc(r.agent)} · ${r.error ? `<span class="error">${esc(r.error)}</span>` : TRIAGED[r.urgency] ?? 'sent'} · ${ago(r.at)}`).join('<br>')}`
    : '';
  $('#alerts-recent').innerHTML += n.judge
    ? `<p>🤖 The AI judge decides which stuck, overlap, idle, blocked and review alerts go out now, wait for the digest (every ${n.judge.digestMin} min${n.judge.pending ? `; ${n.judge.pending} waiting` : ''}) or are dropped. Prompts, questions and errors always go out at once.</p>`
    : '';
  $('#alerts-error').hidden = true;
}

$('#alerts-btn').onclick = async () => {
  $('#alerts-dialog').showModal();
  await loadAlerts().catch((err) => toast(err.message));
};
$('#alerts-close').onclick = () => $('#alerts-dialog').close();
$('#alerts-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    events: Object.fromEntries([...f.querySelectorAll('input[name^="ev_"]')].map((el) => [el.name.slice(3), el.checked])),
    needsInputDelaySec: Number(f.needsInputDelaySec.value),
    waitingDelaySec: Number(f.waitingDelaySec.value),
    skipWhenWatching: f.skipWhenWatching.checked,
    includeIntent: f.includeIntent.checked,
    enabled: f.enabled.checked,
    channel: f.channel.value.trim() || undefined,
  };
  if (f.webhookUrl.value.trim()) body.webhookUrl = f.webhookUrl.value.trim();
  if (f.botToken.value.trim()) body.botToken = f.botToken.value.trim();
  try {
    await api('POST', '/notify', body);
    toast('Alert settings saved');
    await loadAlerts();
  } catch (err) {
    $('#alerts-error').textContent = err.message;
    $('#alerts-error').hidden = false;
  }
});
$('#alerts-test').onclick = async () => {
  try {
    await api('POST', '/notify/test');
    toast('Test message sent to Slack');
  } catch (err) {
    $('#alerts-error').textContent = err.message;
    $('#alerts-error').hidden = false;
  }
};

// ------------------------------------------------------------------ remote sign-in

async function sessionOk() {
  try {
    return (await (await fetch('/api/session', { credentials: 'same-origin' })).json()).authenticated;
  } catch {
    return true; // offline, not signed out: keep retrying
  }
}

async function login(token, kind = 'token') {
  const res = await post('/api/login', { [kind]: token });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
}

function showLogin(message) {
  const dlg = $('#login-dialog');
  $('#login-error').hidden = !message;
  $('#login-error').textContent = message ?? '';
  if (!dlg.open) dlg.showModal();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = new FormData(e.target).get('token').trim().replace(/^.*#login=/, '');
  try {
    await login(token);
    $('#login-dialog').close();
    connectEvents();
  } catch (err) {
    showLogin(err.message);
  }
});

// Engines this machine can run; the New agent form offers a choice once there's more than Claude.
const ENGINE_LABEL = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
async function loadEngines() {
  try {
    const list = (await api('GET', '/engines')).filter((e) => e.installed && e.id !== 'claude');
    const sel = document.querySelector('#engine-field select');
    for (const e of list) sel.append(Object.assign(document.createElement('option'), { value: e.id, textContent: e.label }));
    $('#engine-field').hidden = !list.length;
  } catch {}
}

async function boot() {
  if (REMOTE) {
    document.body.classList.add('remote');
    if (loginHash) {
      history.replaceState(null, '', location.pathname); // drop the token from the address bar
      try {
        await login(loginHash);
      } catch (err) {
        return showLogin(err.message);
      }
    }
    if (ticketHash) {
      history.replaceState(null, '', location.pathname + (goHash ? `#${goHash}` : '')); // the ticket is single-use anyway
      if (!(await sessionOk())) {
        try {
          await login(ticketHash, 'ticket');
        } catch (err) {
          return showLogin(err.message);
        }
      }
    }
    if (!(await sessionOk())) return showLogin();
  }
  connectEvents();
  loadEngines();
}

boot();
setInterval(renderDetail, 30_000); // keep "x ago" labels fresh
