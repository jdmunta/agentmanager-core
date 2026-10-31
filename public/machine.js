// Open Terminal: shells on this computer, in your home folder, not tied to any agent. Works from
// any signed-in device (over remote access it streams like an agent's shell). The shells keep
// running when the window is hidden; × ends one.
import { openStream } from '/transport.js';

const MACHINE = '__machine__';

export function initMachine({ api, esc, toast, $, Terminal, FitAddon }) {
  const dialog = $('#machine-dialog');
  let xterm = null;
  let fit = null;
  let conn = null;
  let current = null;
  let shells = [];

  function ensure() {
    if (xterm) return;
    xterm = new Terminal({ cursorBlink: true, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, scrollback: 10000, theme: { background: '#0f1117' } });
    fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open($('#machine-term'));
    xterm.onData((d) => conn?.send({ t: 'i', d }));
    xterm.onResize(({ cols, rows }) => conn?.send({ t: 'r', cols, rows }));
    new ResizeObserver(() => dialog.open && fit.fit()).observe($('#machine-term'));
  }

  function renderTabs() {
    const nums = [...new Set([...shells, current].filter(Boolean))].sort((a, b) => a - b);
    $('#machine-tabs').innerHTML = nums
      .map((n) => `<button class="term-tab ${n === current ? 'active' : ''}" data-n="${n}" role="tab">Terminal ${n}<span class="x" data-drop="${n}" title="End this terminal">×</span></button>`)
      .join('');
  }

  function connect(n) {
    conn?.close();
    current = n;
    xterm.reset();
    renderTabs();
    conn = openStream(
      { agentId: MACHINE, kind: `shell:${n}` },
      {
        onOpen: () => {
          fit.fit();
          conn.send({ t: 'r', cols: xterm.cols, rows: xterm.rows });
          xterm.focus();
        },
        onMessage: (msg) => {
          if (msg.t === 'hello' && msg.backlog) xterm.write(msg.backlog);
          else if (msg.t === 'o') xterm.write(msg.d);
          else if (msg.t === 'exit') xterm.write('\r\n\x1b[2m[terminal ended; reopen it with + Terminal]\x1b[0m\r\n');
          else if (msg.t === 'error') xterm.write(`\r\n\x1b[31m${msg.error}\x1b[0m\r\n`);
        },
        onClose: ({ reason }) => reason && xterm.write(`\r\n\x1b[2m[${reason}]\x1b[0m\r\n`),
      },
    );
    xterm.focus();
  }

  async function refresh() {
    const r = await api('GET', '/machine/shells');
    shells = r.shells;
    $('#machine-title').textContent = r.home;
    return r;
  }

  $('#machine-btn').onclick = async () => {
    try {
      dialog.showModal();
      ensure();
      await refresh();
      const n = current && shells.includes(current) ? current : shells[0] ?? (await api('POST', '/machine/shell/new')).n;
      requestAnimationFrame(() => connect(n));
    } catch (err) {
      dialog.close();
      toast(`Error: ${err.message}`, 5000);
    }
  };
  $('#machine-new').onclick = async () => {
    const { n } = await api('POST', '/machine/shell/new');
    shells = [...new Set([...shells, n])];
    connect(n);
  };
  $('#machine-close').onclick = () => {
    conn?.close();
    conn = null;
    dialog.close();
  };
  dialog.addEventListener('close', () => {
    conn?.close();
    conn = null;
  });
  $('#machine-tabs').addEventListener('click', async (e) => {
    const drop = e.target.closest('[data-drop]');
    if (drop) {
      e.stopPropagation();
      const n = Number(drop.dataset.drop);
      await api('POST', '/machine/shell/drop', { n });
      await refresh();
      shells = shells.filter((x) => x !== n);
      if (n === current) {
        if (shells.length) connect(shells[0]);
        else {
          current = null;
          conn?.close();
          dialog.close();
        }
      } else renderTabs();
      return;
    }
    const tab = e.target.closest('[data-n]');
    if (tab && Number(tab.dataset.n) !== current) connect(Number(tab.dataset.n));
  });
  return {};
}
