// Review screen: an agent's changes file by file, line comments sent back to the agent as one
// message, and Commit / Push & open PR. Comments not sent yet are kept per agent in this browser.

/** Unified diff -> [{ path, status, binary, hunks: [{ head, lines: [{ t, old, new, text }] }] }] */
export function parseDiff(text) {
  const files = [];
  let f = null;
  let h = null;
  let o = 0;
  let n = 0;
  let left = 0; // lines the hunk header still promises (old side + new side)
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.*)$/.exec(line);
      f = { path: m ? m[1] : line.slice(11), status: 'modified', binary: false, hunks: [] };
      files.push(f);
      h = null;
      continue;
    }
    if (!f) continue;
    if (!h) {
      if (line.startsWith('new file')) f.status = 'added';
      else if (line.startsWith('deleted file')) f.status = 'deleted';
      else if (line.startsWith('rename to ')) {
        f.status = 'renamed';
        f.path = line.slice(10);
      } else if (line.startsWith('Binary files')) f.binary = true;
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') f.path = line.slice(6);
    }
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (hm) {
      o = Number(hm[1]);
      n = Number(hm[3]);
      left = Number(hm[2] ?? 1) + Number(hm[4] ?? 1);
      h = { head: line, lines: [] };
      f.hunks.push(h);
      continue;
    }
    if (!h || left <= 0 || line.startsWith('\\')) continue;
    if (line.startsWith('+')) {
      h.lines.push({ t: 'add', old: null, new: n++, text: line.slice(1) });
      left -= 1;
    } else if (line.startsWith('-')) {
      h.lines.push({ t: 'del', old: o++, new: null, text: line.slice(1) });
      left -= 1;
    } else if (line.startsWith(' ') || line === '') {
      h.lines.push({ t: 'ctx', old: o++, new: n++, text: line.slice(1) });
      left -= 2;
    }
  }
  return files;
}

const BIG = 600; // files with more changed lines start collapsed

export function initReview({ api, esc, toast, agents, $ }) {
  const dlg = $('#review-dialog');
  const body = $('#review-body');
  const st = { id: null, data: null, files: [], comments: [], collapsed: new Set(), editing: null, loading: false };

  const key = (id) => `agentmgr.review.${id}`;
  const loadDrafts = (id) => {
    try {
      return JSON.parse(localStorage.getItem(key(id)) || '[]');
    } catch {
      return [];
    }
  };
  const saveDrafts = () => {
    try {
      if (st.comments.length) localStorage.setItem(key(st.id), JSON.stringify(st.comments));
      else localStorage.removeItem(key(st.id));
    } catch {}
  };
  const lineKey = (file, side, line) => `${file}\t${side}\t${line}`;

  async function open(id) {
    st.id = id;
    st.comments = loadDrafts(id);
    st.collapsed = new Set();
    st.editing = null;
    st.data = null;
    $('#review-title').textContent = `Review: ${agents.get(id)?.name ?? ''}`;
    body.innerHTML = '<p class="hint">Loading changes…</p>';
    if (!dlg.open) dlg.showModal();
    await reload();
  }

  async function reload() {
    st.loading = true;
    try {
      st.data = await api('GET', `/agents/${st.id}/changes`);
      st.files = parseDiff(st.data.diff);
      for (const f of st.files) {
        const size = f.hunks.reduce((s, h) => s + h.lines.length, 0);
        if (size > BIG) st.collapsed.add(f.path);
      }
    } catch (e) {
      body.innerHTML = `<p class="error">${esc(e.message)}</p>`;
      st.loading = false;
      return;
    }
    st.loading = false;
    render();
  }

  function commentHtml(c, i) {
    return `<div class="rv-comment" data-ci="${i}"><div class="rv-comment-text">${esc(c.text)}</div>
      <span class="spacer"></span><button type="button" class="link" data-rv-edit="${i}">Edit</button> <button type="button" class="link" data-rv-del="${i}">Remove</button></div>`;
  }

  function formHtml(value = '') {
    return `<div class="rv-form"><textarea rows="3" placeholder="What should the agent change here?">${esc(value)}</textarea>
      <div class="rv-form-actions"><span class="hint">⌘/Ctrl+Enter to add</span><span class="spacer"></span><button type="button" class="small ghost" data-rv-cancel>Cancel</button><button type="button" class="small primary" data-rv-save>Add comment</button></div></div>`;
  }

  function fileHtml(f) {
    const meta = st.data.files.find((x) => x.path === f.path);
    const collapsed = st.collapsed.has(f.path);
    const count = st.comments.filter((c) => c.file === f.path).length;
    const head = `<div class="rv-file-head" data-rv-toggle="${esc(f.path)}">
        <span class="rv-caret">${collapsed ? '▸' : '▾'}</span>
        <code>${esc(f.path)}</code> <span class="tag rv-${f.status}">${f.status}</span>
        ${meta?.untracked ? '<span class="tag">not committed</span>' : ''}
        ${count ? `<span class="tag open">💬 ${count}</span>` : ''}
        <span class="spacer"></span>
        ${meta?.added != null ? `<span class="rv-add">+${meta.added}</span> <span class="rv-del">−${meta.removed}</span>` : ''}
      </div>`;
    if (collapsed) return `<div class="rv-file" id="rv-${encodeURIComponent(f.path)}">${head}</div>`;
    if (f.binary) return `<div class="rv-file" id="rv-${encodeURIComponent(f.path)}">${head}<p class="hint rv-pad">Binary file</p></div>`;
    const rows = [];
    for (const h of f.hunks) {
      rows.push(`<tr class="rv-hunk"><td colspan="3">${esc(h.head)}</td></tr>`);
      for (const l of h.lines) {
        const side = l.t === 'del' ? 'old' : 'new';
        const line = side === 'old' ? l.old : l.new;
        const k = lineKey(f.path, side, line);
        rows.push(`<tr class="rv-${l.t}" data-rv-line="${esc(k)}">
          <td class="rv-no">${l.old ?? ''}</td><td class="rv-no">${l.new ?? ''}<button type="button" class="rv-plus" title="Comment on this line">+</button></td>
          <td class="rv-code"><span class="rv-sign">${l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' '}</span>${esc(l.text)}</td></tr>`);
        st.comments.forEach((c, i) => {
          if (c.file === f.path && c.side === side && c.line === line) {
            rows.push(`<tr class="rv-note"><td colspan="3">${st.editing?.index === i ? formHtml(c.text) : commentHtml(c, i)}</td></tr>`);
          }
        });
        if (st.editing && st.editing.index == null && st.editing.key === k) rows.push(`<tr class="rv-note"><td colspan="3">${formHtml()}</td></tr>`);
      }
    }
    return `<div class="rv-file" id="rv-${encodeURIComponent(f.path)}">${head}<table class="rv-table">${rows.join('')}</table></div>`;
  }

  function render() {
    const d = st.data;
    if (!d) return;
    const a = agents.get(st.id);
    const adds = d.files.reduce((s, f) => s + (f.added ?? 0), 0);
    const dels = d.files.reduce((s, f) => s + (f.removed ?? 0), 0);
    const openPr = d.prs.find((p) => p.state === 'OPEN');
    const general = st.comments.filter((c) => !c.file);
    const n = st.comments.length;
    const scroll = body.querySelector('.rv-diffs')?.scrollTop ?? 0;
    body.innerHTML = `
      <div class="rv-summary">
        <span><code>${esc(d.branch)}</code>${d.base ? ` ← <code>${esc(d.base.ref)}</code>` : ''}</span>
        <span>${d.files.length} file${d.files.length === 1 ? '' : 's'} <span class="rv-add">+${adds}</span> <span class="rv-del">−${dels}</span></span>
        <span>${d.commits.length} commit${d.commits.length === 1 ? '' : 's'}</span>
        ${d.uncommitted ? `<span class="tag">${d.uncommitted} uncommitted</span>` : ''}
        ${d.unpushed ? `<span class="tag">${d.unpushed} not pushed</span>` : ''}
        ${openPr ? `<a href="${esc(openPr.url)}" target="_blank" rel="noopener">PR #${esc(openPr.number ?? '')}</a>` : ''}
        <span class="spacer"></span>
        <button type="button" class="small ghost" data-rv-reload>${st.loading ? 'Loading…' : 'Reload'}</button>
      </div>
      ${d.busy ? '<p class="hint rv-warn">The agent is working, so the changes may still move. Reload when it is idle.</p>' : ''}
      ${d.truncated ? '<p class="hint rv-warn">The diff is large and was cut short; open a shell for the rest.</p>' : ''}
      <div class="rv-main">
        <nav class="rv-files">
          ${d.files.length ? d.files.map((f) => `<a href="#" data-rv-goto="${esc(f.path)}" title="${esc(f.path)}"><span class="rv-fname">${esc(f.path.split('/').pop())}</span><span class="rv-fdir">${esc(f.path.split('/').slice(0, -1).join('/'))}</span>
            <span class="rv-fstat">${f.added != null ? `<span class="rv-add">+${f.added}</span> <span class="rv-del">−${f.removed}</span>` : ''}</span></a>`).join('') : '<p class="hint">No changes yet.</p>'}
          ${d.commits.length ? `<details class="rv-commits"><summary>Commits</summary>${d.commits.map((c) => `<div><code>${esc(c.sha)}</code> ${esc(c.subject)}</div>`).join('')}</details>` : ''}
        </nav>
        <div class="rv-diffs">${st.files.map(fileHtml).join('') || '<p class="hint rv-pad">Nothing changed since the branch started.</p>'}</div>
      </div>
      <div class="rv-actions">
        <div class="rv-send">
          ${general.length ? `<div class="rv-general">${general.map((c) => commentHtml(c, st.comments.indexOf(c))).join('')}</div>` : ''}
          <textarea id="rv-note" rows="2" placeholder="Overall comment for the agent (optional)">${esc(st.note ?? '')}</textarea>
          <div class="rv-row">
            <span class="hint">${n ? `${n} comment${n === 1 ? '' : 's'} not sent` : 'Click + next to a line to comment on it'}</span>
            <span class="spacer"></span>
            ${n ? '<button type="button" class="small ghost" data-rv-clear>Discard comments</button>' : ''}
            <button type="button" class="small primary" data-rv-send ${a && !a.workdir ? 'disabled' : ''}>Send to agent</button>
          </div>
        </div>
        <div class="rv-land">
          <div class="rv-row">
            <input id="rv-msg" placeholder="Commit message" value="${esc(st.msg ?? '')}" ${d.uncommitted ? '' : 'disabled'} />
            <button type="button" class="small" data-rv-commit ${d.uncommitted ? '' : 'disabled'} title="git add -A and commit, as you">Commit all</button>
          </div>
          <div class="rv-row">
            <input id="rv-prtitle" placeholder="${openPr ? 'Pull request already open' : 'PR title (empty: from the commits)'}" value="${esc(st.prTitle ?? '')}" ${openPr ? 'disabled' : ''} />
            <label class="check"><input type="checkbox" id="rv-draft" ${openPr ? 'disabled' : ''} /> Draft</label>
            <button type="button" class="small primary" data-rv-pr ${!d.hasRemote || d.uncommitted || !d.commits.length ? 'disabled' : ''}
              title="${!d.hasRemote ? 'No origin remote' : d.uncommitted ? 'Commit first' : !d.commits.length ? 'No commits on this branch yet' : openPr ? 'Push the branch to the open pull request' : 'Push the branch and open a pull request on GitHub'}">${openPr ? 'Push' : 'Push & open PR'}</button>
          </div>
        </div>
      </div>`;
    const diffs = body.querySelector('.rv-diffs');
    if (diffs) diffs.scrollTop = scroll;
    body.querySelector('.rv-form textarea')?.focus();
  }

  const keepInputs = () => {
    st.note = $('#rv-note')?.value ?? st.note;
    st.msg = $('#rv-msg')?.value ?? st.msg;
    st.prTitle = $('#rv-prtitle')?.value ?? st.prTitle;
  };

  function saveForm(form) {
    const text = form.querySelector('textarea').value.trim();
    if (st.editing?.index != null) {
      if (text) st.comments[st.editing.index].text = text;
      else st.comments.splice(st.editing.index, 1);
    } else if (text && st.editing) {
      const [file, side, line] = st.editing.key.split('\t');
      const row = body.querySelector(`[data-rv-line="${CSS.escape(st.editing.key)}"] .rv-code`);
      const code = row ? row.textContent.slice(1) : '';
      st.comments.push({ file, side, line: Number(line), code, text });
    }
    st.editing = null;
    saveDrafts();
    keepInputs();
    render();
  }

  body.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-rv-reload]')) return keepInputs(), reload();
    const go = t.closest('[data-rv-goto]');
    if (go) {
      e.preventDefault();
      st.collapsed.delete(go.dataset.rvGoto);
      keepInputs();
      render();
      document.getElementById(`rv-${encodeURIComponent(go.dataset.rvGoto)}`)?.scrollIntoView({ block: 'start' });
      return;
    }
    const tog = t.closest('[data-rv-toggle]');
    if (tog) {
      const p = tog.dataset.rvToggle;
      st.collapsed.has(p) ? st.collapsed.delete(p) : st.collapsed.add(p);
      keepInputs();
      return render();
    }
    if (t.closest('.rv-plus') || (t.closest('.rv-no') && t.closest('[data-rv-line]'))) {
      st.editing = { key: t.closest('[data-rv-line]').dataset.rvLine, index: null };
      keepInputs();
      return render();
    }
    if (t.closest('[data-rv-cancel]')) {
      st.editing = null;
      keepInputs();
      return render();
    }
    if (t.closest('[data-rv-save]')) return saveForm(t.closest('.rv-form'));
    const ed = t.closest('[data-rv-edit]');
    if (ed) {
      const i = Number(ed.dataset.rvEdit);
      if (!st.comments[i].file) {
        // A general comment: move it back into the note box.
        st.note = [st.comments[i].text, $('#rv-note').value].filter(Boolean).join('\n');
        st.comments.splice(i, 1);
        saveDrafts();
        return render();
      }
      st.editing = { index: i };
      keepInputs();
      return render();
    }
    const del = t.closest('[data-rv-del]');
    if (del) {
      st.comments.splice(Number(del.dataset.rvDel), 1);
      saveDrafts();
      keepInputs();
      return render();
    }
    if (t.closest('[data-rv-clear]')) {
      if (!confirm('Discard every comment not sent yet?')) return;
      st.comments = [];
      saveDrafts();
      keepInputs();
      return render();
    }
    if (t.closest('[data-rv-send]')) {
      keepInputs();
      if (!st.comments.length && !st.note?.trim()) return toast('Add a comment first');
      t.disabled = true;
      try {
        const r = await api('POST', `/agents/${st.id}/changes/comments`, { comments: st.comments, note: st.note ?? '' });
        st.comments = [];
        st.note = '';
        saveDrafts();
        toast(r.sent ? `Sent ${r.sent} comment${r.sent === 1 ? '' : 's'} to the agent` : 'Sent to the agent');
        render();
      } catch (err) {
        toast(`Error: ${err.message}`, 5000);
        t.disabled = false;
      }
      return;
    }
    if (t.closest('[data-rv-commit]')) {
      keepInputs();
      if (!st.msg?.trim()) return $('#rv-msg').focus();
      t.disabled = true;
      try {
        const r = await api('POST', `/agents/${st.id}/changes/commit`, { message: st.msg });
        st.msg = '';
        toast(`Committed ${r.sha}`);
        await reload();
      } catch (err) {
        toast(`Error: ${err.message}`, 5000);
        t.disabled = false;
      }
      return;
    }
    if (t.closest('[data-rv-pr]')) {
      keepInputs();
      t.disabled = true;
      t.textContent = 'Pushing…';
      try {
        const r = await api('POST', `/agents/${st.id}/changes/pr`, { title: st.prTitle ?? '', draft: $('#rv-draft')?.checked });
        st.prTitle = '';
        toast(r.existing ? 'Pushed to the open pull request' : r.url ? 'Pull request opened' : 'Pushed', 4000, r.url ? { label: 'Open', run: () => window.open(r.url, '_blank', 'noopener') } : undefined);
        await reload();
      } catch (err) {
        toast(`Error: ${err.message}`, 6000);
        t.disabled = false;
        t.textContent = 'Push & open PR';
      }
    }
  });

  body.addEventListener('keydown', (e) => {
    const form = e.target.closest?.('.rv-form');
    if (form && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      saveForm(form);
    } else if (form && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      st.editing = null;
      keepInputs();
      render();
    }
  });

  // Typing in the note or the inputs must survive re-renders; keep it on every keystroke.
  body.addEventListener('input', (e) => {
    if (['rv-note', 'rv-msg', 'rv-prtitle'].includes(e.target.id)) keepInputs();
  });

  $('#review-close').onclick = () => dlg.close();
  dlg.addEventListener('close', () => {
    st.id = null;
    st.note = st.msg = st.prTitle = '';
  });

  return { open, get openId() { return dlg.open ? st.id : null; } };
}
