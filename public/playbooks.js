// Playbooks dialog: list, edit, run now (asking for {{placeholders}}), schedule.

const placeholders = (text) => [...new Set([...String(text ?? '').matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)].map((m) => m[1]))];
const EVERY = { hour: 'every hour', day: 'every day', weekday: 'every weekday', week: 'every week' };

export function initPlaybooks({ api, esc, toast, $, select }) {
  const dlg = $('#playbooks-dialog');
  const f = $('#pb-form');
  let list = [];

  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }) : '');

  function renderList() {
    $('#pb-list').innerHTML = list.length
      ? `<table class="spend-table pb-table"><tr><th>Playbook</th><th>Projects</th><th>Schedule</th><th>Last run</th><th></th></tr>${list
          .map(
            (p) => `<tr data-pb="${p.id}"><td><b>${esc(p.name)}</b><div class="hint pb-intent">${esc(p.intent.slice(0, 140))}</div></td>
            <td>${p.projects.map((x) => `<code>${esc(x)}</code>`).join(' ')}</td>
            <td>${p.schedule ? `${EVERY[p.schedule.every]}${p.schedule.every === 'hour' ? ` at :${p.schedule.at.slice(3)}` : ` at ${p.schedule.at}`}${p.schedule.day ? ` (${p.schedule.day})` : ''}${p.enabled ? `<div class="hint">next ${when(p.nextRunAt)}</div>` : ' <span class="tag">off</span>'}` : '<span class="hint">by hand</span>'}</td>
            <td>${p.lastRunAt ? `${when(p.lastRunAt)}<div class="hint">${(p.runs?.at(-1)?.agents ?? []).map((a) => `<a href="#${a.id}" data-pb-goto="${a.id}">${esc(a.name)}</a>`).join(', ')}${p.runs?.at(-1)?.failed?.length ? ` <span class="error">${p.runs.at(-1).failed.length} failed</span>` : ''}</div>` : '—'}</td>
            <td class="pb-actions"><button type="button" class="small primary" data-pb-run>Run now</button> <button type="button" class="small" data-pb-edit>Edit</button></td></tr>`,
          )
          .join('')}</table>`
      : '<p class="hint">No playbooks yet. <b>+ New playbook</b>, or <b>Save as playbook</b> in New agents.</p>';
  }

  async function load() {
    list = await api('GET', '/playbooks');
    renderList();
  }

  function fillDefaults(values = {}) {
    const keys = placeholders(f.intent.value);
    $('#pb-defaults').innerHTML = keys.length
      ? `<div class="row">${keys.map((k) => `<label>Default for <code>{{${esc(k)}}}</code> <span class="hint">needed for a schedule</span><input data-default="${esc(k)}" value="${esc(values[k] ?? '')}" /></label>`).join('')}</div>`
      : '';
  }

  function edit(p = {}) {
    f.hidden = false;
    $('#pb-error').hidden = true;
    f.id.value = p.id ?? '';
    f.name.value = p.name ?? '';
    f.intent.value = p.intent ?? '';
    f.projects.value = (p.projects ?? []).join(' ');
    f.model.value = p.model ?? '';
    f.permissionMode.value = p.permissionMode ?? '';
    f.priority.value = String(p.priority ?? 2);
    f.every.value = p.schedule?.every ?? '';
    f.at.value = p.schedule?.at ?? '09:00';
    f.day.value = p.schedule?.day ?? 'mon';
    f.enabled.checked = p.enabled ?? true;
    $('#pb-delete').hidden = !p.id;
    fillDefaults(p.defaults);
    f.name.focus();
  }

  f.intent.addEventListener('input', () => {
    const cur = Object.fromEntries([...f.querySelectorAll('[data-default]')].map((el) => [el.dataset.default, el.value]));
    fillDefaults(cur);
  });

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: f.name.value,
      intent: f.intent.value,
      projects: f.projects.value,
      model: f.model.value.trim(),
      permissionMode: f.permissionMode.value,
      priority: Number(f.priority.value),
      defaults: Object.fromEntries([...f.querySelectorAll('[data-default]')].map((el) => [el.dataset.default, el.value.trim()]).filter(([, v]) => v)),
      schedule: f.every.value ? { every: f.every.value, at: f.at.value, day: f.day.value } : null,
      enabled: f.enabled.checked,
    };
    try {
      await api(f.id.value ? 'PUT' : 'POST', f.id.value ? `/playbooks/${f.id.value}` : '/playbooks', body);
      f.hidden = true;
      toast('Playbook saved');
      await load();
    } catch (err) {
      $('#pb-error').hidden = false;
      $('#pb-error').textContent = err.message;
    }
  });

  $('#pb-list').addEventListener('click', async (e) => {
    const go = e.target.closest('[data-pb-goto]');
    if (go) {
      e.preventDefault();
      dlg.close();
      return select(go.dataset.pbGoto);
    }
    const row = e.target.closest('[data-pb]');
    const p = row && list.find((x) => x.id === row.dataset.pb);
    if (!p) return;
    if (e.target.closest('[data-pb-edit]')) return edit(p);
    if (e.target.closest('[data-pb-run]')) {
      const vars = {};
      for (const k of p.placeholders) {
        const v = prompt(`${p.name}: value for {{${k}}}`, p.defaults?.[k] ?? '');
        if (v === null) return;
        vars[k] = v;
      }
      try {
        const r = await api('POST', `/playbooks/${p.id}/run`, { vars });
        toast(`Started ${r.agents.length} agent${r.agents.length === 1 ? '' : 's'}${r.failed.length ? `; ${r.failed.length} failed: ${r.failed[0].reason}` : ''}`, 5000);
        await load();
      } catch (err) {
        toast(`Error: ${err.message}`, 5000);
      }
    }
  });

  $('#pb-new').onclick = () => edit();
  $('#pb-cancel').onclick = () => (f.hidden = true);
  $('#pb-delete').onclick = async () => {
    if (!confirm(`Delete the playbook "${f.name.value}"? Agents it started stay.`)) return;
    await api('DELETE', `/playbooks/${f.id.value}`).catch((err) => toast(`Error: ${err.message}`));
    f.hidden = true;
    await load();
  };
  $('#pb-close').onclick = () => dlg.close();

  async function open(prefill) {
    f.hidden = true;
    if (!dlg.open) dlg.showModal();
    await load();
    if (prefill) edit(prefill);
  }
  return { open };
}
