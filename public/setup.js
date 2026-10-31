// Getting started: shown where an agent's details go while none is selected, until every step
// is done or it is hidden. Steps open the dialog that does them.

const STEPS = [
  ['agent', 'Start your first agent', 'Give it a request and a repo or folder; it works in its own branch.', '#new-btn', 'New agents'],
  ['alerts', 'Get Slack alerts', 'Hear when an agent needs you, is stuck or finished.', '#alerts-btn', 'Alerts'],
  ['assistant', 'Let work come to you', 'The assistant, or triggers (a GitHub label, a webhook), start agents for new work.', '#assistant-btn', 'Assistant'],
  ['remote', 'Use it from your phone', 'Answer agents from anywhere on your network.', '#remote-btn', 'Remote access'],
  ['budget', 'Set a budget', 'An alert at 80% of an agent budget, and a daily limit.', '#spend-btn', 'Results'],
];

export function initSetup({ api, esc, $ }) {
  const el = $('#placeholder');
  const plain = el.innerHTML;
  let data = null;
  const hidden = () => {
    try {
      return localStorage.getItem('agentmgr.setupHidden') === '1';
    } catch {
      return false;
    }
  };

  function render() {
    if (!data || hidden()) {
      el.innerHTML = plain;
      return;
    }
    const done = STEPS.filter(([k]) => data.steps[k]).length;
    if (done === STEPS.length && !data.checks.length) {
      el.innerHTML = plain;
      return;
    }
    el.innerHTML = `<div class="setup">
      <div class="setup-head"><h3>Getting started</h3><span class="hint">${done} of ${STEPS.length} done</span><span class="spacer"></span><button class="link" data-setup-hide>Hide</button></div>
      ${data.checks.length ? `<div class="setup-checks">${data.checks.map((c) => `<div class="setup-check ${c.status}"><b>${esc(c.name)}</b>: ${esc(c.detail)}${c.fix ? `<div class="hint">${esc(c.fix)}</div>` : ''}</div>`).join('')}</div>` : ''}
      <ol class="setup-steps">${STEPS.map(([k, title, why, btn, label]) => `<li class="${data.steps[k] ? 'done' : ''}">
        <span class="setup-mark">${data.steps[k] ? '✓' : ''}</span>
        <div><b>${title}</b><div class="hint">${why}</div></div>
        ${data.steps[k] ? '' : `<button class="small" data-setup-open="${btn}">${label}</button>`}</li>`).join('')}</ol>
      <p class="hint">${plain}</p>
    </div>`;
  }

  el.addEventListener('click', (e) => {
    const open = e.target.closest('[data-setup-open]');
    if (open) return document.querySelector(open.dataset.setupOpen)?.click();
    if (e.target.closest('[data-setup-hide]')) {
      try {
        localStorage.setItem('agentmgr.setupHidden', '1');
      } catch {}
      render();
    }
  });

  async function load() {
    try {
      data = await api('GET', '/setup');
    } catch {
      data = null;
    }
    render();
  }
  load();
  window.addEventListener('focus', () => !hidden() && load());
  return { load };
}
