// Triggers dialog: GitHub label, /agent PR comments and the webhook (see src/triggers.js).

export function initTriggers({ api, esc, toast, $ }) {
  const dlg = $('#triggers-dialog');
  const f = $('#triggers-form');
  let state = null;

  const ago = (iso) => {
    if (!iso) return 'never';
    const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  };

  function fill(t, token) {
    state = t;
    f.gh_enabled.checked = t.github.enabled;
    f.gh_label.value = t.github.label;
    f.gh_everyMin.value = t.github.everyMin;
    f.gh_comment.checked = t.github.comment;
    f.gh_repos.value = t.github.repos.join(' ');
    f.gh_owners.value = t.github.owners.join(' ');
    f.pc_enabled.checked = t.prCommands.enabled;
    f.pc_prefix.value = t.prCommands.prefix;
    f.wh_enabled.checked = t.webhook.enabled;
    f.wh_repos.value = t.webhook.repos.join(' ');
    f.maxPerDay.value = t.maxPerDay;
    const url = `${location.origin}/api/hooks/agents`;
    $('#triggers-token').innerHTML = token
      ? `New token, shown only now. Copy it: <code>${esc(token)}</code><br>Example: <code>curl -X POST ${esc(url)} -H "Authorization: Bearer &lt;token&gt;" -H "content-type: application/json" -d '{"intent":"…","project":"&lt;shortcut&gt;"}'</code>`
      : t.webhook.hasToken
        ? 'A token is set (it is shown only when made). Other machines reach this only through remote access.'
        : 'No token yet: make one to turn the webhook on.';
    $('#triggers-status').innerHTML = `Last check ${ago(t.lastPoll?.at)}${t.lastPoll ? ` (${t.lastPoll.issues} started, ${t.lastPoll.commands} comments passed on)` : ''} · ${t.startedToday} started in the last day${t.lastError ? `<br><span class="error">${esc(t.lastError.message)}</span>` : ''}
      ${t.recent.length ? `<ul class="trig-recent">${t.recent.slice(0, 6).map((r) => `<li>${ago(r.at)}: <a href="#${r.agent}">${esc(r.name)}</a> from ${esc(r.source)}${r.url ? ` <span class="hint">${esc(r.url)}</span>` : ''}</li>`).join('')}</ul>` : ''}`;
  }

  const patch = () => ({
    github: { enabled: f.gh_enabled.checked, label: f.gh_label.value.trim(), everyMin: Number(f.gh_everyMin.value) || 5, comment: f.gh_comment.checked, repos: f.gh_repos.value, owners: f.gh_owners.value },
    prCommands: { enabled: f.pc_enabled.checked, prefix: f.pc_prefix.value.trim() || '/agent' },
    webhook: { enabled: f.wh_enabled.checked, repos: f.wh_repos.value },
    maxPerDay: Number(f.maxPerDay.value),
  });

  const error = (msg) => {
    $('#triggers-error').hidden = !msg;
    $('#triggers-error').textContent = msg ?? '';
  };

  async function open() {
    error(null);
    fill(await api('GET', '/triggers'));
    if (!dlg.open) dlg.showModal();
  }

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      fill(await api('PUT', '/triggers', patch()));
      error(null);
      toast('Triggers saved');
    } catch (err) {
      error(err.message);
    }
  });
  $('#triggers-newtoken').onclick = async () => {
    if (state?.webhook.hasToken && !confirm('Make a new token? The old one stops working.')) return;
    try {
      const r = await api('PUT', '/triggers', { ...patch(), webhook: { ...patch().webhook, enabled: true, newToken: true } });
      fill(r, r.token);
    } catch (err) {
      error(err.message);
    }
  };
  $('#triggers-poll').onclick = async () => {
    try {
      const r = await api('POST', '/triggers/poll');
      fill(r);
      toast(`${r.issues} started, ${r.commands} comments passed on`);
    } catch (err) {
      error(err.message);
    }
  };
  $('#triggers-close').onclick = () => dlg.close();
  return { open };
}
