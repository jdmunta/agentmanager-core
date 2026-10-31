// Land tab: every agent's open pull request, grouped by what it needs to get merged, with
// Review, Update, Ask to fix and Merge. Settings for sending failures back to agents at the bottom.

const SHORT = { ready: 'ready', fix: 'to fix', behind: 'behind', waiting: 'waiting', draft: 'draft' };
const GROUPS = [
  ['ready', 'Ready to merge'],
  ['fix', 'Needs fixes'],
  ['behind', 'Behind its base'],
  ['waiting', 'Waiting for checks or review'],
  ['draft', 'Drafts'],
];

/** Checks, review and merge state of an open pull request, as small tags. */
export function prChips(pr, esc) {
  const c = pr.checks;
  const out = [];
  if (c?.state === 'failed') out.push(`<span class="tag fail" title="${esc(c.failed.join(', '))}">✗ ${c.failed.length} failing</span>`);
  else if (c?.state === 'running') out.push(`<span class="tag">◔ ${c.running} running</span>`);
  else if (c?.state === 'passed') out.push('<span class="tag open">✓ checks</span>');
  if (pr.review === 'APPROVED') out.push('<span class="tag open">Approved</span>');
  else if (pr.review === 'CHANGES_REQUESTED') out.push('<span class="tag fail">Changes requested</span>');
  else if (pr.review === 'REVIEW_REQUIRED') out.push('<span class="tag">Review required</span>');
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') out.push('<span class="tag fail">Conflicts</span>');
  else if (pr.mergeState === 'BEHIND') out.push('<span class="tag">Behind</span>');
  return out.join(' ');
}

export function initLand({ api, esc, toast, agents, $, select, openReview, isOpen }) {
  const view = $('#land-view');
  let settings = null;

  const rows = () => {
    const out = [];
    for (const a of agents.values()) {
      for (const pr of a.prs ?? []) {
        if (pr.state !== 'OPEN' || pr.source === 'mentioned') continue;
        out.push({ a, pr, land: pr.land ?? 'waiting' });
      }
    }
    return out.sort((x, y) => (x.a.priority ?? 2) - (y.a.priority ?? 2));
  };

  function rowHtml({ a, pr, land }) {
    const canFix = land === 'fix' || land === 'behind';
    return `<li class="agent land-row" data-agent="${a.id}" data-url="${esc(pr.url)}">
      <div class="line1"><span class="prio p${a.priority ?? 2}">P${a.priority ?? 2}</span>
        <a class="name" href="${esc(pr.url)}" target="_blank" rel="noopener" title="${esc(pr.title ?? pr.url)}">#${esc(pr.number ?? '')} ${esc(pr.title ?? pr.url)}</a></div>
      <div class="line2"><button class="link" data-land="goto">${esc(a.name)}</button>${a.runtime?.busy ? ' <span class="hint">working</span>' : ''}</div>
      <div class="land-chips">${prChips(pr, esc)}</div>
      <div class="bl-actions">
        <button class="small" data-land="review" title="Its diff, line comments for the agent, commit and push">Review</button>
        ${land === 'behind' || pr.mergeable === 'CONFLICTING' ? '<button class="small" data-land="update" title="Merge the base branch in here (when the agent is idle and its work is committed) and push; otherwise, or on conflicts, ask the agent">Update</button>' : ''}
        ${canFix ? '<button class="small" data-land="fix" title="Send the failures, requested changes or conflicts to the agent">Ask to fix</button>' : ''}
        ${land === 'ready' ? '<button class="small primary" data-land="merge">Merge</button>' : ''}
        ${land === 'waiting' || land === 'behind' ? '<button class="small" data-land="auto" title="GitHub merges it once checks and reviews allow">Auto-merge</button>' : ''}
      </div>
    </li>`;
  }

  function render() {
    const list = rows();
    const need = list.filter((r) => r.land === 'ready' || r.land === 'fix').length;
    $('#land-count').textContent = list.length ? String(list.length) : '';
    $('#land-count').className = `badge ${list.some((r) => r.land === 'ready') ? 'ready' : ''}`;
    $('#land-count').title = need ? `${need} ready or needing fixes` : '';
    if (!isOpen()) return;
    const s = settings;
    view.innerHTML = `
      <div class="counts">${GROUPS.map(([k, label]) => {
        const n = list.filter((r) => r.land === k).length;
        return n ? `<span class="${k === 'fix' ? 'fail' : ''}">${n} ${SHORT[k]}</span>` : '';
      }).join('')}<span class="spacer"></span><button class="link" data-land="refresh" title="Ask GitHub again for every open pull request">↻ Refresh</button></div>
      ${list.length
        ? `<ul class="agent-list">${GROUPS.map(([k, label]) => {
            const g = list.filter((r) => r.land === k);
            return g.length ? `<li class="project open"><div class="project-head bl-head"><span class="pname">${label}</span><span class="pcount">${g.length}</span></div><ul>${g.map(rowHtml).join('')}</ul></li>` : '';
          }).join('')}</ul>`
        : '<p class="hint land-empty">No open pull requests from agents. Open one from <b>Review changes</b> on an agent, or let the agent open it.</p>'}
      ${s ? `<details class="land-settings"><summary>When checks fail or changes are requested</summary>
        <label class="check"><input type="checkbox" data-set="fixChecks" ${s.fixChecks ? 'checked' : ''}> Send failing checks to the agent</label>
        <label class="check"><input type="checkbox" data-set="fixReviews" ${s.fixReviews ? 'checked' : ''}> Send requested changes to the agent</label>
        <label>At most <input type="number" min="0" max="20" data-set="maxFixes" value="${s.maxFixes}"> times per pull request</label>
        <label>Merge with <select data-set="mergeMethod">${['squash', 'merge', 'rebase'].map((m) => `<option ${m === s.mergeMethod ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" data-set="deleteBranch" ${s.deleteBranch ? 'checked' : ''}> Delete the branch on GitHub after merging</label>
      </details>` : ''}`;
  }

  async function load() {
    try {
      settings = (await api('GET', '/landing')).settings;
    } catch {}
    render();
  }

  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-land]');
    if (!b) return;
    const row = b.closest('[data-agent]');
    const id = row?.dataset.agent;
    const url = row?.dataset.url;
    const run = async (fn, ok) => {
      b.disabled = true;
      try {
        const r = await fn();
        const msg = typeof ok === 'function' ? ok(r) : ok;
        if (msg) toast(msg, 4000);
      } catch (err) {
        toast(`Error: ${err.message}`, 6000);
      } finally {
        b.disabled = false;
      }
    };
    switch (b.dataset.land) {
      case 'goto':
        return select(id);
      case 'review':
        return openReview(id);
      case 'refresh':
        return run(async () => {
          const ids = [...new Set(rows().map((r) => r.a.id))];
          await Promise.all(ids.map((x) => api('POST', `/agents/${x}/refresh`).catch(() => null)));
        }, 'Asked GitHub again');
      case 'update':
        return run(() => api('POST', `/agents/${id}/land/update`, {}), (r) =>
          r.upToDate ? `Already up to date with ${r.target}` : r.merged ? `Merged ${r.merged} commit${r.merged === 1 ? '' : 's'} from ${r.target}${r.pushed ? ' and pushed' : ''}` : `Asked the agent to update (${r.why})`);
      case 'fix':
        return run(() => api('POST', `/agents/${id}/land/fix`, { url }), 'Sent to the agent');
      case 'merge':
        if (!confirm(`Merge this pull request with ${settings?.mergeMethod ?? 'squash'}?`)) return;
        return run(() => api('POST', `/agents/${id}/land/merge`, { url }), 'Merged');
      case 'auto':
        return run(() => api('POST', `/agents/${id}/land/merge`, { url, auto: true }), 'Auto-merge is on: GitHub merges it once it may');
    }
  });

  view.addEventListener('change', async (e) => {
    const k = e.target.dataset.set;
    if (!k) return;
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value;
    try {
      settings = (await api('PUT', '/landing', { [k]: v })).settings;
      toast('Saved');
    } catch (err) {
      toast(`Error: ${err.message}`, 5000);
    }
  });

  return { render, load };
}
