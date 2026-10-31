// Code: an agent's files in the app. A file tree, tabs, and Monaco (the editor in VS Code) loaded
// from a CDN the first time; a plain text editor when that can't load. Save with Ctrl/Cmd+S
// (refused if the agent changed the file meanwhile, unless you overwrite), search the folder,
// compare a file with where the agent started, and open the folder in VS Code or Cursor.

const MONACO = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min';

let monacoReady = null;
function loadMonaco() {
  monacoReady ??= new Promise((resolve, reject) => {
    window.MonacoEnvironment = {
      // Workers from another origin start through a same-origin data: URL.
      getWorkerUrl: () =>
        `data:text/javascript;charset=utf-8,${encodeURIComponent(`self.MonacoEnvironment={baseUrl:'${MONACO}/'};importScripts('${MONACO}/vs/base/worker/workerMain.js');`)}`,
    };
    const s = document.createElement('script');
    s.src = `${MONACO}/vs/loader.js`;
    s.onload = () => {
      window.require.config({ paths: { vs: `${MONACO}/vs` } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    };
    s.onerror = () => reject(new Error('Monaco could not load'));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error('Monaco took too long to load')), 20_000);
  });
  return monacoReady;
}

const icon = (e) => (e.type === 'dir' ? '▸' : '·');
const q = (s) => encodeURIComponent(s);

export function initCode({ api, esc, toast, $, agents, isOpen }) {
  const root = $('#code');
  root.innerHTML = `
    <aside class="code-side">
      <div class="code-side-bar">
        <button class="code-mode active" data-mode="files" title="Files">Files</button>
        <button class="code-mode" data-mode="search" title="Search in the folder">Search</button>
        <span class="spacer"></span>
        <button class="code-icon" data-act="new-file" title="New file (in the selected folder)">＋</button>
        <button class="code-icon" data-act="new-dir" title="New folder">▣</button>
        <button class="code-icon" data-act="rename" title="Rename the selected item">✎</button>
        <button class="code-icon" data-act="delete" title="Delete the selected item">🗑</button>
        <button class="code-icon" data-act="refresh" title="Reload the tree">⟳</button>
      </div>
      <div class="code-tree" role="tree"></div>
      <form class="code-search" hidden>
        <input name="q" placeholder="Search text in files" autocomplete="off" spellcheck="false" />
        <div class="code-hits"></div>
      </form>
    </aside>
    <section class="code-main">
      <div class="code-tabs-bar">
        <button class="code-icon code-toggle-side" title="Show or hide the files">☰</button>
        <div class="code-tabs" role="tablist"></div>
        <span class="spacer"></span>
        <button class="code-btn" data-act="diff" title="Compare with where the agent started">Diff</button>
        <button class="code-btn" data-act="save" title="Save (Ctrl/Cmd+S)">Save</button>
        <button class="code-btn local-only" data-act="vscode" title="Open the agent's folder in VS Code on this computer">VS Code</button>
        <button class="code-btn local-only" data-act="cursor" title="Open the agent's folder in Cursor on this computer" hidden>Cursor</button>
      </div>
      <div class="code-editor"></div>
      <div class="code-empty">Pick a file on the left. Edits are saved into the agent's folder; tell the agent if it should know.</div>
      <div class="code-status"></div>
    </section>`;
  const tree = root.querySelector('.code-tree');
  const tabsEl = root.querySelector('.code-tabs');
  const host = root.querySelector('.code-editor');
  const empty = root.querySelector('.code-empty');
  const status = root.querySelector('.code-status');
  const searchForm = root.querySelector('.code-search');

  // Per agent: open files, the active one, expanded folders, the selected tree item.
  const states = new Map();
  let agentId = null;
  let monaco = null;
  let editor = null;
  let diffEditor = null;
  let plain = null; // fallback <textarea>
  let editorsChecked = false;

  const st = () => {
    if (!states.has(agentId)) states.set(agentId, { files: new Map(), active: null, expanded: new Set(['']), dirs: new Map(), selected: '', diff: false });
    return states.get(agentId);
  };
  const say = (text) => (status.textContent = text);

  // ------------------------------------------------------------- editor
  async function ensureEditor() {
    if (editor || plain) return;
    try {
      monaco = await loadMonaco();
      editor = monaco.editor.create(host, { theme: 'vs-dark', automaticLayout: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, tabSize: 2 });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
      editor.onDidChangeCursorPosition((e) => {
        const f = activeFile();
        if (f) say(`${f.path} · Ln ${e.position.lineNumber}, Col ${e.position.column}${f.language ? ` · ${f.language}` : ''}`);
      });
    } catch (err) {
      plain = document.createElement('textarea');
      plain.className = 'code-plain';
      plain.spellcheck = false;
      host.appendChild(plain);
      plain.addEventListener('input', () => {
        const f = activeFile();
        if (f) {
          f.text = plain.value;
          markDirty(f);
        }
      });
      plain.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault();
          save();
        }
      });
      toast(`${err.message}; using a plain editor`, 4000);
    }
  }

  const activeFile = () => {
    const s = agentId && st();
    return s?.active ? s.files.get(s.active) : null;
  };
  const isDirty = (f) => (f.model ? f.model.getAlternativeVersionId() !== f.savedVersion : f.text !== f.saved);
  function markDirty() {
    renderTabs();
  }

  async function openFile(path, { line } = {}) {
    const s = st();
    await ensureEditor();
    let f = s.files.get(path);
    if (!f) {
      const r = await api('GET', `/agents/${agentId}/file?path=${q(path)}`);
      if (r.binary || r.tooLarge) {
        toast(r.binary ? `${path} is a binary file` : `${path} is too large to edit here (${Math.round(r.size / 1e6)} MB)`, 4000);
        return;
      }
      f = { path, language: r.language, mtimeMs: r.mtimeMs, saved: r.content, text: r.content };
      if (monaco) {
        f.model = monaco.editor.createModel(r.content, r.language, monaco.Uri.parse(`file:///${agentId}/${path}`));
        f.savedVersion = f.model.getAlternativeVersionId();
        f.model.onDidChangeContent(() => markDirty(f));
      }
      s.files.set(path, f);
    }
    s.active = path;
    s.selected = path;
    show(f);
    if (line && editor) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
    }
    renderTabs();
    renderTree();
  }

  function show(f) {
    const s = st();
    empty.hidden = Boolean(f);
    host.hidden = !f;
    if (!f) return;
    if (s.diff && monaco) return showDiff(f);
    if (diffEditor) {
      diffEditor.dispose();
      diffEditor = null;
      host.querySelector('.code-diff')?.remove();
    }
    if (editor) {
      editor.getDomNode().style.display = '';
      editor.setModel(f.model);
      editor.focus();
    } else if (plain) {
      plain.value = f.text;
      plain.focus();
    }
    say(`${f.path}${f.language ? ` · ${f.language}` : ''}`);
  }

  async function showDiff(f) {
    const r = await api('GET', `/agents/${agentId}/file/original?path=${q(f.path)}`);
    if (editor) editor.getDomNode().style.display = 'none';
    diffEditor?.dispose();
    host.querySelector('.code-diff')?.remove();
    const box = document.createElement('div');
    box.className = 'code-diff';
    host.appendChild(box);
    diffEditor = monaco.editor.createDiffEditor(box, { theme: 'vs-dark', automaticLayout: true, renderSideBySide: host.clientWidth > 700, originalEditable: false });
    const original = monaco.editor.createModel(r.content ?? '', f.language);
    diffEditor.setModel({ original, modified: f.model });
    say(r.new ? `${f.path} is new since ${r.base}` : `${f.path}: ${r.base} (left) and now (right); edit on the right`);
  }

  async function save({ force = false } = {}) {
    const f = activeFile();
    if (!f) return;
    const content = f.model ? f.model.getValue() : f.text;
    try {
      const r = await api('PUT', `/agents/${agentId}/file`, { path: f.path, content, mtimeMs: f.mtimeMs, force });
      f.mtimeMs = r.mtimeMs;
      f.saved = content;
      if (f.model) f.savedVersion = f.model.getAlternativeVersionId();
      renderTabs();
      say(`Saved ${f.path}`);
    } catch (err) {
      if (/changed on disk/.test(err.message)) {
        if (confirm(`${f.path} changed on disk since you opened it (the agent may have edited it).\n\nOK: overwrite it with your version.\nCancel: keep the file as it is (reload it to see the change).`)) return save({ force: true });
        return;
      }
      toast(`Couldn't save: ${err.message}`, 6000);
    }
  }

  /** Pick up the agent's edits to open files you haven't changed. */
  async function syncFromDisk() {
    if (!agentId || !isOpen()) return;
    for (const f of st().files.values()) {
      if (isDirty(f)) continue;
      const r = await api('GET', `/agents/${agentId}/file?path=${q(f.path)}`).catch(() => null);
      if (!r || r.content == null || r.mtimeMs === f.mtimeMs) continue;
      f.mtimeMs = r.mtimeMs;
      f.saved = r.content;
      if (f.model) {
        f.model.setValue(r.content);
        f.savedVersion = f.model.getAlternativeVersionId();
      } else f.text = r.content;
      if (f === activeFile() && plain) plain.value = r.content;
    }
    renderTabs();
  }

  function closeFile(path) {
    const s = st();
    const f = s.files.get(path);
    if (f && isDirty(f) && !confirm(`Close ${path} without saving your changes?`)) return;
    f?.model?.dispose();
    s.files.delete(path);
    if (s.active === path) s.active = [...s.files.keys()].pop() ?? null;
    show(activeFile());
    renderTabs();
  }

  function renderTabs() {
    const s = st();
    tabsEl.innerHTML = [...s.files.values()]
      .map(
        (f) => `<button class="code-tab ${f.path === s.active ? 'active' : ''}" data-path="${esc(f.path)}" title="${esc(f.path)}">${isDirty(f) ? '● ' : ''}${esc(f.path.split('/').pop())}<span class="x" data-close="${esc(f.path)}">×</span></button>`,
      )
      .join('');
    root.querySelector('[data-act="diff"]').classList.toggle('active', s.diff);
  }

  // ------------------------------------------------------------- tree
  async function loadDir(dir) {
    const r = await api('GET', `/agents/${agentId}/files?dir=${q(dir)}`);
    st().dirs.set(dir, r.entries);
    return r;
  }

  function renderTree() {
    const s = st();
    const rows = [];
    const walk = (dir, depth) => {
      for (const e of s.dirs.get(dir) ?? []) {
        const open = e.type === 'dir' && s.expanded.has(e.path);
        rows.push(
          `<div class="code-node ${e.hidden ? 'dim' : ''} ${s.selected === e.path ? 'selected' : ''} ${e.path === s.active ? 'active' : ''}" role="treeitem" data-path="${esc(e.path)}" data-type="${e.type}" style="padding-left:${8 + depth * 14}px">` +
            `<span class="caret">${e.type === 'dir' ? (open ? '▾' : '▸') : ''}</span>${esc(e.name)}</div>`,
        );
        if (open) walk(e.path, depth + 1);
      }
    };
    walk('', 0);
    tree.innerHTML = rows.join('') || '<p class="hint" style="padding:8px">Empty folder</p>';
  }

  async function toggleDir(path) {
    const s = st();
    if (s.expanded.has(path)) s.expanded.delete(path);
    else {
      s.expanded.add(path);
      if (!s.dirs.has(path)) await loadDir(path);
    }
    renderTree();
  }

  async function refreshTree() {
    const s = st();
    s.dirs.clear();
    for (const dir of [...s.expanded]) await loadDir(dir).catch(() => s.expanded.delete(dir));
    renderTree();
  }

  /** The folder new items go in: the selected folder, or the selected file's folder. */
  const targetDir = () => {
    const s = st();
    const sel = s.selected;
    if (!sel) return '';
    const isDir = [...s.dirs.values()].flat().find((e) => e.path === sel)?.type === 'dir';
    return isDir ? sel : sel.split('/').slice(0, -1).join('/');
  };

  async function act(what) {
    const s = st();
    try {
      if (what === 'refresh') return refreshTree();
      if (what === 'new-file' || what === 'new-dir') {
        const dir = targetDir();
        const name = prompt(`New ${what === 'new-dir' ? 'folder' : 'file'} in ${dir || 'the agent folder'}:`, '');
        if (!name?.trim()) return;
        const path = [dir, name.trim()].filter(Boolean).join('/');
        await api('POST', `/agents/${agentId}/files`, { path, type: what === 'new-dir' ? 'dir' : 'file' });
        if (dir) s.expanded.add(dir);
        await refreshTree();
        if (what === 'new-file') await openFile(path);
        return;
      }
      if (!s.selected) return toast('Select a file or folder first');
      if (what === 'rename') {
        const to = prompt('Rename to (path in the agent folder):', s.selected);
        if (!to?.trim() || to.trim() === s.selected) return;
        await api('POST', `/agents/${agentId}/files/rename`, { from: s.selected, to: to.trim() });
        const f = s.files.get(s.selected);
        if (f) closeFile(s.selected);
        s.selected = to.trim();
        await refreshTree();
        if (f) await openFile(to.trim());
        return;
      }
      if (what === 'delete') {
        if (!confirm(`Delete ${s.selected}? It is removed from the agent's folder (git still has committed versions).`)) return;
        await api('DELETE', `/agents/${agentId}/file?path=${q(s.selected)}`);
        for (const p of [...s.files.keys()]) if (p === s.selected || p.startsWith(`${s.selected}/`)) {
          s.files.get(p)?.model?.dispose();
          s.files.delete(p);
        }
        if (s.active && !s.files.has(s.active)) s.active = [...s.files.keys()].pop() ?? null;
        s.selected = '';
        show(activeFile());
        renderTabs();
        return refreshTree();
      }
      if (what === 'save') return save();
      if (what === 'diff') {
        if (!monaco) return toast('Diff needs the full editor (Monaco), which could not load');
        s.diff = !s.diff;
        renderTabs();
        return show(activeFile());
      }
      if (what === 'vscode' || what === 'cursor') {
        const r = await api('POST', `/agents/${agentId}/open-in`, { editor: what, path: s.active ?? null });
        return toast(`Opened in ${r.editor}`);
      }
    } catch (err) {
      toast(`Error: ${err.message}`, 5000);
    }
  }

  // ------------------------------------------------------------- search
  async function search(text) {
    const hits = root.querySelector('.code-hits');
    if (text.trim().length < 2) return void (hits.innerHTML = '');
    hits.innerHTML = '<p class="hint">Searching…</p>';
    try {
      const r = await api('GET', `/agents/${agentId}/search?q=${q(text)}`);
      hits.innerHTML =
        r.hits
          .map((h) => `<div class="code-hit" data-path="${esc(h.path)}" data-line="${h.line}"><b>${esc(h.path)}</b>:${h.line}<div>${esc(h.text.trim())}</div></div>`)
          .join('') + (r.truncated ? '<p class="hint">More matches not shown; search for something longer.</p>' : r.hits.length ? '' : '<p class="hint">No matches.</p>');
    } catch (err) {
      hits.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
    }
  }

  // ------------------------------------------------------------- events
  root.addEventListener('click', (e) => {
    const mode = e.target.closest('.code-mode');
    if (mode) {
      for (const b of root.querySelectorAll('.code-mode')) b.classList.toggle('active', b === mode);
      tree.hidden = mode.dataset.mode !== 'files';
      searchForm.hidden = mode.dataset.mode !== 'search';
      if (!searchForm.hidden) searchForm.q.focus();
      return;
    }
    if (e.target.closest('.code-toggle-side')) return root.classList.toggle('no-side');
    const x = e.target.closest('[data-close]');
    if (x) {
      e.stopPropagation();
      return closeFile(x.dataset.close);
    }
    const tab = e.target.closest('.code-tab');
    if (tab) return openFile(tab.dataset.path);
    const hit = e.target.closest('.code-hit');
    if (hit) return openFile(hit.dataset.path, { line: Number(hit.dataset.line) });
    const node = e.target.closest('.code-node');
    if (node) {
      st().selected = node.dataset.path;
      if (node.dataset.type === 'dir') return toggleDir(node.dataset.path);
      if (window.innerWidth < 720) root.classList.add('no-side');
      return openFile(node.dataset.path).catch((err) => toast(`Error: ${err.message}`, 5000));
    }
    const b = e.target.closest('[data-act]');
    if (b) return act(b.dataset.act);
  });
  let searchTimer = null;
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    search(searchForm.q.value);
  });
  searchForm.q.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search(searchForm.q.value), 350);
  });
  window.addEventListener('focus', () => syncFromDisk().catch(() => {}));
  setInterval(() => document.visibilityState === 'visible' && syncFromDisk().catch(() => {}), 5000);
  window.addEventListener('beforeunload', (e) => {
    for (const s of states.values()) for (const f of s.files.values()) if (isDirty(f)) return void e.preventDefault();
  });

  async function open(id) {
    agentId = id;
    const s = st();
    if (!editorsChecked && !document.body.classList.contains('remote')) {
      editorsChecked = true;
      api('GET', '/editors')
        .then((list) => {
          root.querySelector('[data-act="vscode"]').hidden = !list.some((x) => x.id === 'vscode');
          root.querySelector('[data-act="cursor"]').hidden = !list.some((x) => x.id === 'cursor');
        })
        .catch(() => {});
    }
    try {
      if (!s.dirs.has('')) await loadDir('');
      renderTree();
      renderTabs();
      show(activeFile());
      if (!activeFile()) {
        empty.hidden = false;
        host.hidden = true;
      }
      say(agents.get(id)?.workdir ?? '');
    } catch (err) {
      tree.innerHTML = `<p class="hint" style="padding:8px">${esc(err.message)}</p>`;
    }
  }

  return { open, save };
}
