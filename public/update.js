// Updating from the app: a button in the top bar when a newer release is out, and "Update and
// restart" in About. The daemon installs it (git checkout of the release tag, or npm install -g)
// and restarts onto it; this page then waits for it to come back and reloads.

export function initUpdate({ api, esc, toast, $ }) {
  const remote = () => document.body.classList.contains('remote');
  let state = null;

  function show(s) {
    state = s;
    const btn = $('#update-btn');
    const ready = s?.newer && !s.blocker && !s.updating;
    btn.hidden = !ready;
    if (ready) {
      btn.textContent = `Update to ${s.latest}`;
      btn.title = `Version ${s.latest} is out (you have ${s.current}). Installs it and restarts; running agents resume.`;
    }
    $('#about-auto').checked = s?.check !== false;
    $('#about-install').hidden = !ready;
  }

  async function load() {
    if (remote()) return;
    try {
      show(await api('GET', '/update'));
    } catch {
      // An older daemon has no /update.
    }
  }

  async function waitForRestart(from) {
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const a = await api('GET', '/about');
        if (a.daemon.pid !== from) return location.reload();
      } catch {
        // Down while it restarts.
      }
    }
    toast('The daemon has not come back yet; check ~/.agentmanager/daemon.log', 8000);
  }

  async function install() {
    if (!state?.newer) return;
    if (!confirm(`Update to ${state.latest} and restart?\n\nRunning agents are closed and resume on the new version. This takes a minute or two with many agents.`)) return;
    const before = (await api('GET', '/about')).daemon.pid;
    $('#update-btn').disabled = $('#about-install').disabled = true;
    toast(`Installing ${state.latest}…`, 60_000);
    try {
      const r = await api('POST', '/update');
      if (r.upToDate) {
        toast(`${r.current} is the newest release`);
        return load();
      }
      toast(`Installed ${r.to}; restarting… (agents resume)`, 600_000);
      await waitForRestart(before);
    } catch (err) {
      toast(`Update failed: ${err.message}`, 10_000);
    } finally {
      $('#update-btn').disabled = $('#about-install').disabled = false;
    }
  }

  /** "Check for updates" in About: the daemon's check where it can update itself. */
  async function check() {
    if (remote()) return null;
    const s = await api('POST', '/update/check');
    show(s);
    if (!s.newer) return `You have the newest release (${esc(s.current)}).`;
    if (s.blocker) return `Version ${esc(s.latest)} is out. ${esc(s.blocker)}.`;
    return `Version ${esc(s.latest)} is out (you have ${esc(s.current)}). <b>Update and restart</b> installs it; running agents resume.`;
  }

  $('#update-btn').onclick = install;
  $('#about-install').onclick = install;
  $('#about-auto').onchange = async (e) => {
    try {
      show(await api('PUT', '/update', { check: e.target.checked }));
    } catch (err) {
      toast(`Error: ${err.message}`, 5000);
    }
  };
  load();
  // The daemon checks twice a day; look at what it found now and then.
  setInterval(load, 30 * 60_000);
  return { load, check };
}
