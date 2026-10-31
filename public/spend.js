// Spend dialog: today's cost, the last two weeks, the costliest agents, and the limits.

export function initSpend({ api, esc, toast, $ }) {
  const dlg = $('#spend-dialog');
  const f = $('#spend-form');
  const money = (n) => `$${Number(n ?? 0).toFixed(2)}`;

  function fill(b) {
    $('#spend-today').textContent = b.today.total ? money(b.today.total) : '';
    if (!dlg.open) return;
    f.perAgentUsd.value = b.perAgentUsd ?? '';
    f.perDayUsd.value = b.perDayUsd ?? '';
    const max = Math.max(...b.days.map((d) => d.total), 0.01);
    $('#spend-summary').innerHTML = `
      <p class="spend-big">${money(b.today.total)} <span class="hint">today${b.perDayUsd ? ` of ${money(b.perDayUsd)}` : ''}</span></p>
      ${b.days.length > 1 ? `<div class="spend-bars" title="The last two weeks">${[...b.days].reverse().map((d) => `<span style="height:${Math.max(2, Math.round((d.total / max) * 40))}px" title="${esc(d.day)}: ${money(d.total)}"></span>`).join('')}</div>` : ''}`;
    $('#spend-agents').innerHTML = b.agents.length
      ? `<table class="spend-table"><tr><th>Agent</th><th>Spent</th><th>Today</th><th>Budget</th></tr>${b.agents.map((a) => `<tr class="${a.hit ? 'over' : ''}">
          <td><a href="#${a.id}">${esc(a.name)}</a></td><td>${money(a.cost)}</td><td>${a.today ? money(a.today) : ''}</td>
          <td>${a.limit ? `${money(a.limit)}${a.own ? '' : ' <span class="hint">default</span>'}${a.hit ? ' <span class="tag fail">reached</span>' : ''}` : '—'}</td></tr>`).join('')}</table>`
      : '<p class="hint">No costs recorded yet.</p>';
    $('#spend-note').textContent = b.note;
  }

  const hours = (h) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`);
  const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);

  function table(title, rows) {
    if (!rows.length) return '';
    return `<details class="stats-table" ${title === 'By engine and model' ? 'open' : ''}><summary>${title}</summary><table class="spend-table">
      <tr><th></th><th>Agents</th><th>Merged</th><th>Merge rate</th><th>To PR</th><th>Cost / merged</th></tr>
      ${rows.map((r) => `<tr><td>${esc(r.key)}</td><td>${r.agents}</td><td>${r.merged}</td><td>${pct(r.mergeRate)}</td><td>${hours(r.medianHoursToPr)}</td><td>${r.costPerMerged == null ? '—' : money(r.costPerMerged)}</td></tr>`).join('')}
    </table></details>`;
  }

  function fillStats(st) {
    const t = st.total;
    const kpi = (label, value, hint = '') => `<div class="kpi"><div class="kpi-v">${value}</div><div class="kpi-l">${label}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
    $('#stats-body').innerHTML = t.agents
      ? `<div class="kpis">
          ${kpi('agents', t.agents, `${t.withPr} opened a PR`)}
          ${kpi('PRs merged', t.merged, `${t.open} open, ${t.closed} closed`)}
          ${kpi('merge rate', pct(t.mergeRate), 'of PRs merged or closed')}
          ${kpi('to first PR', hours(t.medianHoursToPr), 'median')}
          ${kpi('to merge', hours(t.medianHoursToMerge), 'median')}
          ${kpi('per merged PR', t.costPerMerged == null ? '—' : money(t.costPerMerged), `${money(t.cost)} in all`)}
        </div>
        ${table('By engine and model', st.byEngine)}${table('By where they came from', st.bySource)}${table('By project', st.byProject)}`
      : '<p class="hint">No agents in this period.</p>';
  }

  async function refresh() {
    try {
      fill(await api('GET', '/budgets'));
      if (dlg.open) fillStats(await api('GET', `/stats?days=${$('#stats-days').value}`));
    } catch {}
  }
  $('#stats-days').onchange = () => refresh();

  $('#spend-btn').onclick = async () => {
    $('#spend-error').hidden = true;
    dlg.showModal();
    await refresh();
  };
  $('#spend-close').onclick = () => dlg.close();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      fill(await api('PUT', '/budgets', { perAgentUsd: f.perAgentUsd.value || null, perDayUsd: f.perDayUsd.value || null }));
      toast('Limits saved');
    } catch (err) {
      $('#spend-error').hidden = false;
      $('#spend-error').textContent = err.message;
    }
  });
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('a[href^="#"]')) dlg.close();
  });
  refresh();
  setInterval(refresh, 120_000);
  return { refresh };
}
