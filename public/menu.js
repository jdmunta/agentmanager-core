// The menu at the right of the top bar: who this runs as (Claude account, git identity, computer)
// and the settings and preferences: Settings…, Clean up, Alerts, Remote access, About.

export function initMenu({ api, esc, toast, $ }) {
  const btn = $('#menu-btn');
  const menu = $('#menu');
  const remote = () => document.body.classList.contains('remote');

  const open = (on) => {
    menu.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    open(menu.hidden);
  };
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) open(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) open(false);
  });
  // Any item closes the menu; its own handler does the rest.
  menu.addEventListener('click', (e) => {
    if (e.target.closest('button')) open(false);
  });
  $('#menu-about').onclick = () => $('#about-btn').click();

  async function loadMe() {
    try {
      const me = await api('GET', '/me');
      const initials = me.display
        .split(/[\s@._-]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0].toUpperCase())
        .join('');
      $('#me-avatar').textContent = initials || '·';
      $('#me-name').textContent = me.display;
      $('#me-display').textContent = me.display;
      $('#me-email').textContent = me.email ?? '';
      $('#me-email').hidden = !me.email;
      const where = [me.claude ? `Claude account${me.claude.organization && !me.claude.organization.includes(me.claude.email) ? ` · ${me.claude.organization}` : ''}` : null, me.user && me.host ? `${me.user} on ${me.host}` : null, me.remote ? 'signed in from this device' : null].filter(Boolean);
      $('#me-where').innerHTML = where.map(esc).join('<br>');
      btn.title = `${me.display}${me.email ? ` (${me.email})` : ''}: settings and preferences`;
    } catch {
      // An older daemon has no /me: the menu still works.
      $('#me-display').textContent = 'Settings';
    }
  }

  // ------------------------------------------------------------ Settings dialog
  const dialog = $('#settings-dialog');
  const form = $('#settings-form');
  $('#settings-btn').onclick = async () => {
    $('#settings-error').hidden = true;
    try {
      const c = await api('GET', '/cleanup');
      form.maxRunning.value = c.maxRunning ?? '';
      $('#settings-running').textContent = `Open now: ${c.running}.`;
      if (!remote()) {
        const u = await api('GET', '/update').catch(() => null);
        form.updateCheck.checked = u?.check !== false;
      }
      dialog.showModal();
    } catch (err) {
      toast(`Error: ${err.message}`, 5000);
    }
  };
  $('#settings-cancel').onclick = () => dialog.close();
  dialog.addEventListener('click', (e) => {
    const go = e.target.closest('[data-open]');
    if (!go) return;
    dialog.close();
    $(`#${go.dataset.open}`).click();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const c = await api('PUT', '/cleanup', { maxRunning: form.maxRunning.value.trim() || null });
      if (!remote()) await api('PUT', '/update', { check: form.updateCheck.checked }).catch(() => {});
      dialog.close();
      toast(c.maxRunning ? `At most ${c.maxRunning} agents open; the ones idle longest close above that` : 'No limit on open agents');
    } catch (err) {
      $('#settings-error').textContent = err.message;
      $('#settings-error').hidden = false;
    }
  });

  loadMe();
  return { loadMe };
}
