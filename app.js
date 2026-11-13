'use strict';
/*
  Check-in: a two-person relationship check-in app.
  The page is static. Shared data lives in one JSON file in a private GitHub repo,
  read and written through the GitHub contents API with a fine-grained token.
  Every item is a record with an id and an updated time, so two phones can edit
  at once: on each save the app fetches the file, merges record by record
  (newest edit wins), and writes it back.
*/
(() => {
  // ---------------------------------------------------------------- storage
  const LS = { doc: 'checkin.doc', cfg: 'checkin.cfg', dirty: 'checkin.dirty', last: 'checkin.last', ui: 'checkin.ui' };
  const DAY = 86400000;
  const load = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };

  // ---------------------------------------------------------------- helpers
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => Date.now();
  const uid = p => `${p}-${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const pad = n => String(n).padStart(2, '0');
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const isKey = k => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k);
  const dayNum = k => { const [y, m, d] = k.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / DAY); };
  const fromNum = n => { const d = new Date(n * DAY); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
  const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayKey = () => keyOf(new Date());
  const fmtDate = (k, opts) => parseKey(k).toLocaleDateString('en-AU', opts || { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtLong = k => fmtDate(k, { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtStamp = ms => ms ? new Date(ms).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const ago = ms => {
    const s = Math.round((now() - ms) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return fmtStamp(ms);
  };

  // ---------------------------------------------------------------- state
  const emptyDoc = () => ({ app: 'checkin', v: 1, recs: {} });
  let doc = load(LS.doc, null);
  if (!doc || typeof doc.recs !== 'object') doc = emptyDoc();
  let cfg = Object.assign({ owner: '', repo: '', path: 'data.json', token: '', me: '' }, load(LS.cfg, {}));
  let dirty = load(LS.dirty, false);
  let lastSync = load(LS.last, 0);
  const ui = Object.assign({ tab: 'home', ideaCat: 'date', theme: 'auto' }, load(LS.ui, {}));
  const compose = {};          // unsent text in add boxes, kept across re-renders
  let editSeq = 0;             // bumps on every local change

  const DEFAULT_SETTINGS = {
    id: 'settings', t: 'settings', names: { A: 'Person A', B: 'Person B' }, anchor: null, offsetB: 2, checkinDay: 10, deepEvery: 3,
    pattern: ['Day', 'Day', 'Afternoon', 'Afternoon', 'Night', 'Night', 'Off', 'Off', 'Off', 'Off'],
    fit: ['Backup, after 1500', 'Backup, after 1500', 'None', 'None', 'Morning only, before 1400', 'None', 'Tight', 'Tight', 'Good', 'Best']
  };
  const S = () => Object.assign({}, DEFAULT_SETTINGS, get('settings') || {});
  const nameOf = p => (p === 'both' ? 'Both' : (S().names || {})[p] || p);
  const other = p => (p === 'A' ? 'B' : 'A');

  function get(id) { const r = doc.recs[id]; return r && !r.del ? r : null; }
  function list(t, filter) {
    return Object.values(doc.recs)
      .filter(r => r.t === t && !r.del && (!filter || filter(r)))
      .sort((a, b) => (a.o ?? 0) - (b.o ?? 0) || (a.c ?? 0) - (b.c ?? 0) || (a.id < b.id ? -1 : 1));
  }
  function put(rec, quiet) {
    const prev = doc.recs[rec.id];
    rec.u = Math.max(now(), (prev && prev.u ? prev.u : 0) + 1);
    rec.by = cfg.me || '';
    doc.recs[rec.id] = rec;
    changed(quiet);
    return rec;
  }
  const upd = (id, patch) => { const r = get(id); if (r) put(Object.assign({}, r, patch)); };
  const remove = id => { const r = doc.recs[id]; if (r) put({ id, t: r.t, del: true }); };
  const nextO = t => list(t).reduce((m, r) => Math.max(m, r.o ?? 0), 0) + 1;

  // quiet: the screen already shows the change (typed text), so skip the redraw.
  // Redrawing on blur would swap out the button the person is tapping.
  function changed(quiet) {
    editSeq++;
    store(LS.doc, doc);
    dirty = true; store(LS.dirty, true);
    scheduleSync(1200);
    if (quiet) paintSync(); else renderSoon();
  }

  // ---------------------------------------------------------------- merge
  function pick(x, y) {
    if (!x) return y;
    if (!y) return x;
    if (x.u !== y.u) return x.u > y.u ? x : y;
    return JSON.stringify(x) >= JSON.stringify(y) ? x : y;
  }
  function merge(a, b) {
    if (!b || typeof b.recs !== 'object') return a;
    if (!a || typeof a.recs !== 'object') return b;
    const out = emptyDoc();
    for (const id of new Set([...Object.keys(a.recs), ...Object.keys(b.recs)])) out.recs[id] = pick(a.recs[id], b.recs[id]);
    const cut = now() - 120 * DAY;   // forget deletions after four months
    for (const [id, r] of Object.entries(out.recs)) if (r.del && r.u < cut) delete out.recs[id];
    return out;
  }
  const canon = d => { const ks = Object.keys(d.recs).sort(); return JSON.stringify(ks.map(k => d.recs[k])); };

  // ---------------------------------------------------------------- GitHub
  const API = 'https://api.github.com';
  const connected = () => !!(cfg.owner && cfg.repo && cfg.path && cfg.token);
  const fileUrl = () => `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${cfg.path.split('/').map(encodeURIComponent).join('/')}`;
  const headers = extra => Object.assign({ Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' }, extra || {});
  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  async function httpError(r) { let m = ''; try { m = (await r.json()).message || ''; } catch { /* no body */ } return new HttpError(r.status, m); }
  function b64enc(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64dec(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  async function ghGet() {
    const r = await fetch(fileUrl(), { headers: headers(), cache: 'no-store' });
    if (r.status === 404) {
      // Either the file doesn't exist yet or the token can't see the repo. Tell them apart.
      const rr = await fetch(`${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`, { headers: headers(), cache: 'no-store' });
      if (!rr.ok) throw await httpError(rr);
      return { sha: null, doc: null };
    }
    if (!r.ok) throw await httpError(r);
    const j = await r.json();
    let text;
    if (j.encoding === 'base64' && j.content) text = b64dec(j.content);
    else {
      const r2 = await fetch(fileUrl(), { headers: headers({ Accept: 'application/vnd.github.raw+json' }), cache: 'no-store' });
      if (!r2.ok) throw await httpError(r2);
      text = await r2.text();
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new HttpError(0, 'The data file on GitHub is not valid JSON.'); }
    if (!parsed || typeof parsed.recs !== 'object') throw new HttpError(0, 'The data file on GitHub is not a Check-in data file.');
    return { sha: j.sha, doc: parsed };
  }
  async function ghPut(d, sha) {
    const body = { message: `Update ${new Date().toISOString()}`, content: b64enc(JSON.stringify(d, null, 1)) };
    if (sha) body.sha = sha;
    const r = await fetch(fileUrl(), { method: 'PUT', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
    if (!r.ok) throw await httpError(r);
    return true;
  }
  function describe(e) {
    if (e instanceof HttpError) {
      if (e.status === 401) return 'GitHub rejected the token. It may have expired. Paste a new one in Setup.';
      if (e.status === 403 && /rate limit/i.test(e.message)) return 'GitHub rate limit reached. Sync will retry shortly.';
      if (e.status === 403) return 'The token can read but not write. Give it Contents: Read and write on the data repo.';
      if (e.status === 404) return 'GitHub can\'t find that repo, or the token doesn\'t include it. Check Setup.';
      if (e.status === 409 || e.status === 422) return 'Both phones saved at once. Tap to sync again.';
      return e.message || `GitHub returned an error (${e.status}).`;
    }
    return 'offline';
  }

  // ---------------------------------------------------------------- sync
  let syncing = false, again = false, syncTimer = null, syncErr = '';
  function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }
  async function sync() {
    if (!connected()) { paintSync(); return; }
    if (syncing) { again = true; return; }
    syncing = true; syncErr = ''; paintSync();
    try {
      let done = false, seq = editSeq;
      for (let i = 0; i < 4 && !done; i++) {
        const remote = await ghGet();
        const merged = merge(doc, remote.doc);
        seq = editSeq;
        const before = canon(doc);
        doc = merged; store(LS.doc, doc);
        if (canon(merged) !== before) renderSoon();
        if (remote.doc && canon(merged) === canon(remote.doc)) { done = true; break; }
        try { await ghPut(merged, remote.sha); done = true; }
        catch (e) { if (e.status === 409 || e.status === 422) continue; throw e; }
      }
      if (!done) throw new HttpError(409, '');
      if (editSeq === seq) { dirty = false; store(LS.dirty, false); }
      lastSync = now(); store(LS.last, lastSync);
    } catch (e) {
      syncErr = describe(e);
    } finally {
      syncing = false;
      paintSync();
      if (again) { again = false; sync(); }
    }
  }
  function paintSync() {
    const b = $('#sync'), t = $('#syncText');
    let state = 'idle', text = 'Not connected';
    if (connected()) {
      if (syncing) { state = 'busy'; text = 'Syncing'; }
      else if (syncErr === 'offline') { state = 'offline'; text = 'Offline, saved here'; }
      else if (syncErr) { state = 'error'; text = 'Sync problem'; }
      else if (dirty) { state = 'busy'; text = 'Saving'; }
      else if (lastSync) { state = 'ok'; text = `Synced ${ago(lastSync)}`; }
      else { text = 'Not synced yet'; }
    }
    b.dataset.state = state; t.textContent = text;
    b.title = syncErr && syncErr !== 'offline' ? syncErr : '';
  }

  // ---------------------------------------------------------------- roster
  function cycleDay(p, k) {
    const s = S();
    if (!isKey(s.anchor) || !isKey(k)) return null;
    const len = s.pattern.length;
    let d = dayNum(k) - dayNum(s.anchor);
    if (p === 'B') d -= Number(s.offsetB) || 0;
    return ((d % len) + len) % len + 1;
  }
  function shiftLabel(cd) {
    const p = S().pattern, len = p.length;
    if (!cd) return '';
    const name = p[cd - 1];
    if (name !== 'Off') return name === 'Day' ? 'Day shift' : name;
    let n = 0;
    for (let i = 0; i < len && p[((cd - 1 - i) % len + len) % len] === 'Off'; i++) n++;
    const prev = p[((cd - 1 - n) % len + len) % len];
    return n === 1 && prev === 'Night' ? 'Off (1st, after nights)' : `Off (${ordinal(n)})`;
  }
  function nextCheckin(fromK) {
    const s = S();
    if (!isKey(s.anchor)) return null;
    for (let i = 0; i <= s.pattern.length; i++) {
      const k = fromNum(dayNum(fromK) + i);
      if (cycleDay('A', k) === Number(s.checkinDay)) return k;
    }
    return null;
  }
  const logs = () => list('log').sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.c || 0) - (b.c || 0)));
  function nextFmt() {
    const every = Math.max(1, Number(S().deepEvery) || 3);
    let regularSince = 0;
    for (const l of logs()) regularSince = l.fmt === 'deep' ? 0 : regularSince + 1;
    return regularSince >= every - 1 ? 'deep' : 'regular';
  }
  const fmtName = f => (f === 'deep' ? 'Deeper review' : 'Regular check-in');

  // ---------------------------------------------------------------- the ring
  function ringSvg() {
    const s = S(), len = s.pattern.length, tk = todayKey();
    const cdA = cycleDay('A', tk);
    const start = dayNum(tk) - (cdA - 1);           // date of A's day 1 in this cycle
    const C = 180, gap = 1.8;
    const rings = [{ p: 'A', r: 137, w: 26 }, { p: 'B', r: 106, w: 26 }];
    const col = { Day: 'var(--shift-day)', Afternoon: 'var(--shift-aft)', Night: 'var(--shift-night)', Off: 'var(--sunk)' };
    const ink = { Day: '#2B2410', Afternoon: '#2B1606', Night: '#FFFFFF', Off: 'var(--muted)' };
    const letter = { Day: 'D', Afternoon: 'A', Night: 'N', Off: '' };
    const pt = (r, deg) => { const a = (deg - 90) * Math.PI / 180; return [C + r * Math.cos(a), C + r * Math.sin(a)]; };
    const arc = (r, a0, a1) => { const [x0, y0] = pt(r, a0), [x1, y1] = pt(r, a1); return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`; };
    let out = '';
    for (const ring of rings) {
      for (let i = 0; i < len; i++) {
        const k = fromNum(start + i);
        const cd = cycleDay(ring.p, k), name = s.pattern[cd - 1];
        const a0 = i * 360 / len + gap / 2, a1 = (i + 1) * 360 / len - gap / 2;
        out += `<path d="${arc(ring.r, a0, a1)}" stroke="${col[name]}" stroke-width="${ring.w}" fill="none"/>`;
        if (letter[name]) {
          const [x, y] = pt(ring.r, (a0 + a1) / 2);
          out += `<text x="${x.toFixed(1)}" y="${(y + 4.5).toFixed(1)}" text-anchor="middle" font-size="13" font-weight="700" style="fill:${ink[name]}">${letter[name]}</text>`;
        }
      }
    }
    for (let i = 0; i < len; i++) {
      const k = fromNum(start + i), mid = (i + 0.5) * 360 / len;
      const [x, y] = pt(166, mid);
      const isCheck = (i + 1) === Number(s.checkinDay), isToday = k === tk;
      if (isCheck) out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="12.5" style="fill:var(--go)"/>`;
      if (isToday) out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="13" fill="none" stroke-width="2.2" style="stroke:var(--ink)"/>`;
      out += `<text x="${x.toFixed(1)}" y="${(y + 4.5).toFixed(1)}" text-anchor="middle" font-size="13" font-weight="${isCheck || isToday ? 750 : 500}" style="fill:${isCheck ? 'var(--go-ink)' : 'var(--ink)'}">${parseKey(k).getDate()}</text>`;
    }
    const [tx, ty] = pt(87, (cdA - 0.5) * 360 / len);
    out += `<circle cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="4" style="fill:var(--ink)"/>`;
    out += `<text x="${C}" y="${C - 4}" text-anchor="middle" font-size="25" font-weight="700">${esc(fmtDate(tk, { weekday: 'short', day: 'numeric', month: 'short' }))}</text>`;
    out += `<text class="lab" x="${C}" y="${C + 20}" text-anchor="middle">${esc(nameOf('A'))} day ${cdA}, ${esc(nameOf('B'))} day ${cycleDay('B', tk)}</text>`;
    return `<svg class="ring" viewBox="0 0 360 360" role="img" aria-label="This cycle: outer ring ${esc(nameOf('A'))}, inner ring ${esc(nameOf('B'))}. Green date marks the check-in day, the circled date is today.">${out}</svg>`;
  }

  // ---------------------------------------------------------------- render plumbing
  const view = $('#view');
  let renderQueued = false, renderPending = false, forceRender = false;
  function typing() {
    const a = document.activeElement;
    return a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'file'].includes(a.type)) || a.tagName === 'SELECT') && (view.contains(a) || sheetEl.contains(a));
  }
  function renderSoon() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      const forced = forceRender; forceRender = false;
      if (!forced && typing()) { renderPending = true; return; }
      render();
    });
  }
  document.addEventListener('focusout', () => setTimeout(() => { if (renderPending && !typing()) { renderPending = false; render(); } }, 120));

  function render() {
    const y = window.scrollY;
    const tab = views[ui.tab] ? ui.tab : 'home';
    view.innerHTML = views[tab]();
    document.querySelectorAll('#tabs [data-tab]').forEach(b => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
    const sealed = list('jar', r => !r.openedIn).length, badge = $('#jarBadge');
    badge.hidden = !sealed; badge.textContent = sealed;
    paintSync();
    if (render.keepScroll) window.scrollTo(0, y);
    render.keepScroll = true;
  }
  function go(tab, opts) {
    ui.tab = tab; store(LS.ui, ui);
    render.keepScroll = false;
    render();
    window.scrollTo(0, 0);
    if (opts && opts.anchor) { const el = document.getElementById(opts.anchor); if (el) el.scrollIntoView(); }
  }

  const banner = (html, warn) => `<div class="banner${warn ? ' warn' : ''}">${html}</div>`;
  function setupBanners() {
    let h = '';
    if (!cfg.me) h += banner(`<p><strong>Who's using this phone?</strong></p><div class="row"><button class="btn" type="button" data-act="set-me" data-p="A">${esc(nameOf('A'))}</button><button class="btn" type="button" data-act="set-me" data-p="B">${esc(nameOf('B'))}</button></div>`);
    if (!connected()) h += banner(`<p>Edits are only on this phone until you connect GitHub.</p><button class="btn" type="button" data-act="tab" data-tab="setup">Open setup</button>`);
    else if (syncErr && syncErr !== 'offline') h += banner(`<p>${esc(syncErr)}</p><div class="row"><button class="btn" type="button" data-act="sync-now">Sync again</button><button class="btn quiet" type="button" data-act="tab" data-tab="setup">Setup</button></div>`, true);
    return h;
  }
  const personTag = p => `<span class="tag ${esc(p)}">${esc(nameOf(p))}</span>`;
  const textOf = id => (get(id) || {}).text || '';
  const textBlock = (key, fallback) => {
    const r = get(`text-${key}`);
    const body = r && r.text ? r.text : fallback || '';
    return `<div class="textblock prose">${body.split(/\n{2,}/).map(p => `<p>${esc(p)}</p>`).join('')}</div>`;
  };

  // ---------------------------------------------------------------- views
  const views = {};

  views.home = () => {
    const s = S(), tk = todayKey();
    let h = setupBanners();
    if (isKey(s.anchor)) {
      const nk = nextCheckin(tk), days = nk ? dayNum(nk) - dayNum(tk) : null, f = nextFmt();
      const when = days === 0 ? 'Check-in today' : fmtLong(nk);
      const sub = days === 0 ? fmtName(f) : `${fmtName(f)} in ${plural(days, 'day')}`;
      const cdA = cycleDay('A', tk), cdB = cycleDay('B', tk);
      h += `<section class="hero">${ringSvg()}
        <div class="legend"><span><i style="background:var(--shift-day)"></i>Day</span><span><i style="background:var(--shift-aft)"></i>Afternoon</span><span><i style="background:var(--shift-night)"></i>Night</span><span><i style="background:var(--sunk)"></i>Off</span></div>
        <p class="ringkey">Outer ring <span class="who A">${esc(nameOf('A'))}</span>, inner ring <span class="who B">${esc(nameOf('B'))}</span></p>
        <p class="hero-line"><strong>${esc(when)}</strong><span class="muted">${esc(sub)}</span></p>
        <div class="row" style="justify-content:center"><button class="btn primary" type="button" data-act="tab" data-tab="checkin">${get('draft') ? 'Continue check-in' : 'Start a check-in'}</button></div>
      </section>
      <dl class="today">
        <dt>${esc(nameOf('A'))}</dt><dd>${esc(shiftLabel(cdA))}</dd>
        <dt>${esc(nameOf('B'))}</dt><dd>${esc(shiftLabel(cdB))}</dd>
        <dt>Check-in fit</dt><dd>${esc((s.fit || [])[cdA - 1] || '')}</dd>
      </dl>`;
    } else {
      h += `<section class="block"><h1>Set your roster</h1><p>Add the date ${esc(nameOf('A'))} starts a first day shift, and the app works out each check-in day from your 10-day cycle.</p><button class="btn primary" type="button" data-act="tab" data-tab="setup">Set roster</button></section>`;
    }

    const sealed = list('jar', r => !r.openedIn);
    h += `<section class="block"><div class="spread"><h2>Appreciation jar</h2></div>
      <div class="jarline"><span class="count">${sealed.length}</span><div style="flex:1">${sealed.length ? `${sealed.length === 1 ? 'note is' : 'notes are'} sealed until you open the jar at your check-in.` : 'The jar is empty. Drop in something you noticed.'}</div>
      <button class="btn" type="button" data-act="tab" data-tab="jar">Add</button></div></section>`;

    const acts = list('action', r => !r.done && r.logId && r.logId !== 'draft');
    h += `<section class="block"><h2>Action points</h2>`;
    h += acts.length ? `<ul class="list">${acts.map(actionRow).join('')}</ul>` : `<p class="empty">No open action points. You'll agree some at the next check-in.</p>`;
    h += `</section>`;

    const ideas = list('idea', r => !r.done).sort((a, b) => (b.c || 0) - (a.c || 0)).slice(0, 3);
    h += `<section class="block"><div class="spread"><h2>Ideas</h2><button class="btn quiet" type="button" data-act="tab" data-tab="ideas">See all</button></div>`;
    h += ideas.length ? `<ul class="list">${ideas.map(ideaRow).join('')}</ul>` : `<p class="empty">No ideas yet. Add a date idea or something to try.</p>`;
    h += `</section>`;
    return h;
  };

  function actionRow(a) {
    const owner = a.owner || 'both';
    return `<li><input class="tick" type="checkbox" aria-label="Done" data-act="action-done" data-id="${esc(a.id)}" ${a.done ? 'checked' : ''}>
      <div class="grow"><div class="${a.done ? 'done-text' : ''}">${esc(a.text)}</div><div class="meta">${owner === 'both' ? '<span class="tag both">Both</span>' : personTag(owner)}${a.logId && get(a.logId) ? ` from ${esc(fmtDate(get(a.logId).date))}` : ''}</div></div>
      <button class="btn quiet" type="button" data-act="action-edit" data-id="${esc(a.id)}">Edit</button></li>`;
  }
  const IDEA_CATS = [['date', 'Date ideas'], ['try', 'Things to try'], ['advice', 'Advice']];
  function ideaRow(i) {
    return `<li><input class="tick" type="checkbox" aria-label="Done" data-act="idea-done" data-id="${esc(i.id)}" ${i.done ? 'checked' : ''}>
      <div class="grow"><button class="edit" type="button" data-act="idea-edit" data-id="${esc(i.id)}"><span class="${i.done ? 'done-text' : ''}" style="white-space:pre-wrap">${esc(i.text)}</span></button>
      <div class="meta">${i.from ? personTag(i.from) : ''} ${esc(fmtStamp(i.c))}</div></div></li>`;
  }

  // ---- check-in
  function flowSteps(fmt) {
    const steps = [{ id: 'questions', kind: 'questions', title: 'Pick your questions' }];
    for (const st of list('step', r => r.fmt === fmt)) steps.push(st);
    steps.push({ id: 'finish', kind: 'finish', title: 'Wrap up' });
    return steps;
  }
  const answerField = (key, p, ph, customLabel) => {
    const id = `dans-${key}-${p}`;
    const label = customLabel || (p === 'shared' ? 'Notes' : nameOf(p));
    return `<div class="field-${esc(p)}"><label class="f" for="${esc(id)}"><span class="${p === 'shared' ? '' : 'who ' + esc(p)}">${esc(label)}</span></label>
      <textarea id="${esc(id)}" data-bind="${esc(id)}" placeholder="${esc(ph || '')}">${esc(textOf(id))}</textarea></div>`;
  };
  const pairFields = (key, ph) => answerField(key, 'A', ph) + answerField(key, 'B', ph);
  function jarOpener() {
    const sealed = list('jar', r => !r.openedIn), opened = list('jar', r => r.openedIn === 'draft');
    let h = '';
    if (sealed.length) h += `<button class="btn block" type="button" data-act="jar-open-draft" style="margin:8px 0">Open the jar (${plural(sealed.length, 'note')})</button>`;
    if (opened.length) h += `<h3>From the jar</h3>` + opened.map(noteCard).join('');
    return h;
  }
  const noteCard = n => `<div class="note ${esc(n.from)}"><p>${esc(n.text)}</p><div class="meta">${esc(nameOf(n.from))}, ${esc(fmtStamp(n.c))}</div></div>`;
  function actionEditor() {
    const acts = list('action', r => r.logId === 'draft');
    const sel = compose.owner || 'both';
    return `<label class="f" for="actText">New action point</label>
      <input type="text" id="actText" data-compose="action" value="${esc(compose.action || '')}" placeholder="A small step to try before next time">
      <div class="row" style="margin-top:8px"><div class="seg" role="group" aria-label="Who">${['A', 'B', 'both'].map(p => `<button type="button" data-act="owner" data-p="${p}" aria-pressed="${sel === p}">${esc(nameOf(p))}</button>`).join('')}</div>
      <button class="btn" type="button" data-act="action-add">Add</button></div>
      ${acts.length ? `<ul class="list" style="margin-top:14px">${acts.map(a => `<li><div class="grow">${esc(a.text)}<div class="meta">${a.owner === 'both' || !a.owner ? '<span class="tag both">Both</span>' : personTag(a.owner)}</div></div><button class="btn danger" type="button" data-act="action-del" data-id="${esc(a.id)}">Remove</button></li>`).join('')}</ul>` : ''}`;
  }
  function renderStep(st, d) {
    let h = '';
    if (st.body) h += `<p class="stepbody">${esc(st.body)}</p>`;
    switch (st.kind) {
      case 'questions': {
        h += textBlock('questions');
        const chosen = (d.qs || []).map(get).filter(Boolean);
        h += chosen.length ? chosen.map(q => `<div class="qcard" role="button" tabindex="0" aria-pressed="true" data-act="q-toggle" data-id="${esc(q.id)}"><input class="tick" type="checkbox" checked tabindex="-1" aria-hidden="true"><div>${esc(q.text)}<small>${esc(q.cat)}</small></div></div>`).join('') : '<p class="empty">No questions picked. Draw some or pick from the bank.</p>';
        h += `<div class="row"><button class="btn" type="button" data-act="q-draw">Draw three at random</button></div>`;
        h += `<details style="margin-top:14px"><summary>Pick from the whole bank</summary>`;
        const cats = [...new Set(list('q').map(q => q.cat))];
        for (const c of cats) {
          h += `<h3>${esc(c)}</h3>`;
          h += list('q', q => q.cat === c).map(q => { const on = (d.qs || []).includes(q.id); return `<div class="qcard" role="button" tabindex="0" aria-pressed="${on}" data-act="q-toggle" data-id="${esc(q.id)}"><input class="tick" type="checkbox" ${on ? 'checked' : ''} tabindex="-1" aria-hidden="true"><div>${esc(q.text)}</div></div>`; }).join('');
        }
        h += `</details>`;
        break;
      }
      case 'appreciate': h += jarOpener() + pairFields(st.id, 'Five things, and what each says about them'); break;
      case 'concern': h += pairFields(st.id, 'I feel… about… I need…'); break;
      case 'reconnect': h += jarOpener() + pairFields(st.id); break;
      case 'review': {
        const prev = logs().slice(-1)[0];
        h += prev ? `<p class="muted">Last check-in: ${esc(fmtLong(prev.date))}, ${esc(fmtName(prev.fmt).toLowerCase())}.</p>` : '<p class="muted">This is your first logged check-in.</p>';
        const open = list('action', r => r.logId && r.logId !== 'draft' && (!r.done || r.doneIn === 'draft'));
        h += `<h3>Last time's action points</h3>` + (open.length ? `<ul class="list">${open.map(actionRow).join('')}</ul>` : '<p class="empty">No action points to review.</p>');
        h += answerField(st.id, 'shared', 'What happened since the last review, facts only');
        break;
      }
      case 'agenda': {
        const groups = [...new Set(list('topic').map(t => t.group || 'Topics'))];
        for (const g of groups) {
          h += `<h3>${esc(g)}</h3><div class="chips">${list('topic', t => (t.group || 'Topics') === g).map(t => `<button class="chip" type="button" data-act="topic-toggle" data-id="${esc(t.id)}" aria-pressed="${(d.topics || []).includes(t.id)}">${esc(t.text)}</button>`).join('')}</div>`;
        }
        h += `<div style="margin-top:14px">${textBlock('topics')}</div>`;
        break;
      }
      case 'discuss': {
        const ts = (d.topics || []).map(get).filter(Boolean);
        h += ts.length ? ts.map(t => answerField(`topic-${t.id}`, 'shared', '', t.text)).join('') : '<p class="empty">No topics on the agenda. Go back a step and pick some.</p>';
        break;
      }
      case 'actions': h += actionEditor(); break;
      case 'finish': {
        const hasActions = flowSteps(d.fmt).some(x => x.kind === 'actions');
        if (!hasActions) h += `<p class="stepbody">Agree on any small steps to try before next time. You'll review them at the next check-in.</p>` + actionEditor();
        h += `<label class="f" for="logDate">Date of this check-in</label><input type="date" id="logDate" data-act-change="draft-date" value="${esc(d.date || todayKey())}">`;
        h += `<p class="muted small" style="margin-top:14px">Saving moves your notes into the log and clears this check-in.</p>`;
        break;
      }
      default: h += pairFields(st.id);
    }
    return h;
  }
  views.checkin = () => {
    let h = setupBanners();
    const d = get('draft');
    if (!d) {
      const f = nextFmt(), s = S(), nk = nextCheckin(todayKey());
      h += `<h1>Check-in</h1>`;
      if (nk) h += `<p class="muted">Next scheduled: ${esc(fmtLong(nk))}. ${esc(fmtName(f))} is due.</p>`;
      h += `<div class="pick">
        <button class="choice${f === 'regular' ? ' suggested' : ''}" type="button" data-act="flow-start" data-fmt="regular"><strong>Regular check-in</strong><span class="muted">About 30 minutes: appreciations, what's going well, one concern and one request each.</span>${f === 'regular' ? '<br><span class="tag both">Due next</span>' : ''}</button>
        <button class="choice${f === 'deep' ? ' suggested' : ''}" type="button" data-act="flow-start" data-fmt="deep"><strong>Deeper review</strong><span class="muted">RADAR: review, agree the agenda, discuss, action points, reconnect. Every ${ordinal(Math.max(1, Number(s.deepEvery) || 3))} check-in.</span>${f === 'deep' ? '<br><span class="tag both">Due next</span>' : ''}</button>
      </div>`;
      const recent = logs().slice(-3).reverse();
      if (recent.length) h += `<h2>Recent</h2><ul class="list">${recent.map(logRow).join('')}</ul>`;
      return h;
    }
    const steps = flowSteps(d.fmt);
    const i = Math.min(Math.max(0, d.step || 0), steps.length - 1), st = steps[i];
    h += `<div class="spread"><span class="muted small">${esc(fmtName(d.fmt))}</span><button class="btn quiet" type="button" data-act="flow-cancel">Discard</button></div>`;
    h += `<div class="steps" aria-hidden="true">${steps.map((_, j) => `<span class="${j <= i ? 'on' : ''}"></span>`).join('')}</div>`;
    h += `<p class="stepno">Step ${i + 1} of ${steps.length}</p><h1>${esc(st.title)}</h1>`;
    h += renderStep(st, d);
    h += `<div class="flownav">${i > 0 ? '<button class="btn" type="button" data-act="flow-back">Back</button>' : ''}
      ${i < steps.length - 1 ? '<button class="btn primary" type="button" data-act="flow-next">Next</button>' : '<button class="btn primary" type="button" data-act="flow-save">Save to log</button>'}</div>`;
    return h;
  };
  const logRow = l => `<li><button class="logitem" type="button" data-act="log-open" data-id="${esc(l.id)}"><strong>${esc(fmtLong(l.date))}</strong><div class="meta">${esc(fmtName(l.fmt))}${(l.actions || []).length ? `, ${plural(l.actions.length, 'action point')}` : ''}</div></button></li>`;

  // ---- jar
  views.jar = () => {
    let h = setupBanners();
    const me = cfg.me, sealed = list('jar', r => !r.openedIn);
    h += `<h1>Appreciation jar</h1>`;
    if (me) {
      h += `<p class="muted">Write down something ${esc(nameOf(other(me)))} did that you appreciated. Notes stay sealed until you open the jar together at a check-in.</p>
        <label class="f sr" for="jarText">Note</label>
        <textarea id="jarText" data-compose="jar" placeholder="What they did, and what it says about them">${esc(compose.jar || '')}</textarea>
        <div class="row end" style="margin-top:8px"><button class="btn primary" type="button" data-act="jar-add">Add to the jar</button></div>`;
    } else h += `<p class="muted">Pick who's using this phone first, so the jar knows who each note is from.</p>`;
    h += `<h2>Sealed</h2>`;
    if (sealed.length) {
      const by = p => sealed.filter(n => n.from === p).length;
      h += `<div class="pebbles" aria-hidden="true">${sealed.map(n => `<i class="${esc(n.from)}"></i>`).join('')}</div>
        <p style="margin-top:8px">${esc(nameOf('A'))}: ${by('A')}. ${esc(nameOf('B'))}: ${by('B')}.</p>`;
      const mine = sealed.filter(n => n.from === me);
      if (mine.length) h += `<details><summary>Your sealed notes (${mine.length})</summary>${mine.map(n => `<div class="note ${esc(n.from)}"><p>${esc(n.text)}</p><div class="row end"><button class="btn danger" type="button" data-act="jar-del" data-id="${esc(n.id)}">Remove</button></div></div>`).join('')}</details>`;
      h += `<div class="row" style="margin-top:6px"><button class="btn quiet" type="button" data-act="jar-open-now">Open the jar without a check-in</button></div>`;
    } else h += `<p class="empty">Nothing sealed right now.</p>`;
    const opened = list('jar', r => r.openedIn && r.openedIn !== 'draft').sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
    if (opened.length) {
      h += `<h2>Opened</h2>`;
      let last = '';
      for (const n of opened) {
        const label = n.openedIn && get(n.openedIn) ? `Check-in, ${fmtLong(get(n.openedIn).date)}` : `Opened ${fmtStamp(n.openedAt)}`;
        if (label !== last) { h += `<h3>${esc(label)}</h3>`; last = label; }
        h += noteCard(n);
      }
    }
    return h;
  };

  // ---- ideas
  views.ideas = () => {
    let h = setupBanners();
    const cat = IDEA_CATS.some(c => c[0] === ui.ideaCat) ? ui.ideaCat : 'date';
    const ph = { date: 'Somewhere to go or something to do together', try: 'A habit, a ritual or a way of doing things', advice: `Advice or a suggestion for ${cfg.me ? nameOf(other(cfg.me)) : 'each other'}` }[cat];
    h += `<h1>Ideas</h1>
      <div class="seg" role="group" aria-label="Category" style="margin:12px 0">${IDEA_CATS.map(([k, label]) => `<button type="button" data-act="idea-cat" data-cat="${k}" aria-pressed="${k === cat}">${label}</button>`).join('')}</div>
      <label class="f sr" for="ideaText">New idea</label>
      <textarea id="ideaText" data-compose="idea-${cat}" style="min-height:70px" placeholder="${esc(ph)}">${esc(compose['idea-' + cat] || '')}</textarea>
      <div class="row end" style="margin-top:8px"><button class="btn primary" type="button" data-act="idea-add">Add</button></div>`;
    const items = list('idea', r => (r.cat || 'date') === cat);
    const open = items.filter(i => !i.done).sort((a, b) => (b.c || 0) - (a.c || 0)), done = items.filter(i => i.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    h += `<div style="margin-top:20px">` + (open.length ? `<ul class="list">${open.map(ideaRow).join('')}</ul>` : `<p class="empty">Nothing here yet.</p>`) + `</div>`;
    if (done.length) h += `<details style="margin-top:16px"><summary>Done (${done.length})</summary><ul class="list">${done.map(ideaRow).join('')}</ul></details>`;
    return h;
  };

  // ---- guide
  views.guide = () => {
    const s = S();
    let h = setupBanners();
    h += `<h1>Our guide</h1><nav class="toc" aria-label="Guide sections">${[['g-why', 'Why'], ['g-rules', 'Ground rules'], ['g-time', 'Timing'], ['g-fmt', 'Formats'], ['g-q', 'Questions'], ['g-agree', 'Agreements'], ['g-log', 'Log'], ['g-src', 'Sources']].map(([id, l]) => `<a href="#${id}" data-act="jump" data-to="${id}">${l}</a>`).join('')}</nav>`;
    const editBtn = (act, extra) => `<button class="btn quiet" type="button" data-act="${act}" ${extra || ''}>Edit</button>`;

    h += `<div class="editbar" id="g-why"><h2>Why we check in</h2>${editBtn('text-edit', 'data-key="why" data-title="Why we check in"')}</div>${textBlock('why')}`;

    h += `<div class="editbar" id="g-rules"><h3>Ground rules</h3><button class="btn quiet" type="button" data-act="rule-add">Add</button></div>
      <ul class="list">${list('rule').map(r => `<li><button class="edit" type="button" data-act="rule-edit" data-id="${esc(r.id)}">${esc(r.text)}</button></li>`).join('')}</ul>`;

    h += `<div class="editbar" id="g-time"><h2>When: fitting our rosters</h2>${editBtn('text-edit', 'data-key="timing" data-title="When: fitting our rosters"')}</div>${textBlock('timing')}`;
    if (isKey(s.anchor)) {
      const tk = todayKey(), cdA = cycleDay('A', tk), start = dayNum(tk) - (cdA - 1);
      h += `<table class="roster"><thead><tr><th>Date</th><th>${esc(nameOf('A'))}</th><th>${esc(nameOf('B'))}</th><th>Check-in fit</th></tr></thead><tbody>`;
      for (let i = 0; i < s.pattern.length; i++) {
        const k = fromNum(start + i);
        h += `<tr class="${i + 1 === Number(s.checkinDay) ? 'hi' : ''} ${k === tk ? 'now' : ''}"><td>${esc(fmtDate(k))}<div class="muted small">Day ${i + 1}</div></td><td>${esc(shiftLabel(cycleDay('A', k)))}</td><td>${esc(shiftLabel(cycleDay('B', k)))}</td><td>${esc((s.fit || [])[i] || '')}</td></tr>`;
      }
      h += `</tbody></table><p class="muted small">This cycle, from ${esc(nameOf('A'))}'s day 1. The highlighted row is check-in day.</p>`;
    } else h += `<p class="empty">Set the roster in Setup to see this cycle's dates.</p>`;

    h += `<h2 id="g-fmt">Check-in formats</h2>`;
    for (const [fmt, key, title] of [['regular', 'regular', 'Regular check-in (once per cycle)'], ['deep', 'deep', `Deeper review (every ${ordinal(Math.max(1, Number(s.deepEvery) || 3))} check-in)`]]) {
      h += `<div class="editbar"><h3>${esc(title)}</h3>${editBtn('text-edit', `data-key="${key}" data-title="${esc(title)}"`)}</div>${textBlock(key)}
        <ol class="fmt">${list('step', r => r.fmt === fmt).map((st, n) => `<li><span class="n" aria-hidden="true">${n + 1}.</span><button class="edit" type="button" data-act="step-edit" data-id="${esc(st.id)}"><strong>${esc(st.title)}.</strong> ${esc(st.body)}</button></li>`).join('')}</ol>`;
    }
    h += `<div class="editbar"><h3>Review topics</h3><button class="btn quiet" type="button" data-act="topic-add">Add</button></div>`;
    for (const g of [...new Set(list('topic').map(t => t.group || 'Topics'))]) {
      h += `<p style="margin:10px 0 6px"><strong>${esc(g)}</strong></p><div class="chips">${list('topic', t => (t.group || 'Topics') === g).map(t => `<button class="chip" type="button" data-act="topic-edit" data-id="${esc(t.id)}">${esc(t.text)}</button>`).join('')}</div>`;
    }
    h += `<div style="margin-top:12px">${textBlock('topics')}</div>`;

    h += `<div class="editbar" id="g-q"><h2>Question bank</h2><button class="btn quiet" type="button" data-act="q-add">Add</button></div>${textBlock('questions')}`;
    for (const c of [...new Set(list('q').map(q => q.cat))]) {
      h += `<h3>${esc(c)}</h3><ul class="list">${list('q', q => q.cat === c).map(q => `<li><button class="edit" type="button" data-act="q-edit" data-id="${esc(q.id)}">${esc(q.text)}</button></li>`).join('')}</ul>`;
    }

    h += `<div class="editbar" id="g-agree"><h2>Our agreements</h2><button class="btn quiet" type="button" data-act="agree-add">Add</button></div>${textBlock('agreements')}
      <ul class="list">${list('agree').map(a => `<li><input class="tick" type="checkbox" aria-label="Done" data-act="agree-done" data-id="${esc(a.id)}" ${a.done ? 'checked' : ''}><div class="grow"><button class="edit" type="button" data-act="agree-edit" data-id="${esc(a.id)}"><span class="${a.done ? 'done-text' : ''}">${esc(a.text)}</span></button></div></li>`).join('')}</ul>`;

    const all = logs().reverse();
    h += `<h2 id="g-log">Check-in log</h2>` + (all.length ? `<ul class="list">${all.map(logRow).join('')}</ul>` : `<p class="empty">Saved check-ins show up here.</p>`);

    h += `<div class="editbar" id="g-src"><h2>Sources</h2><button class="btn quiet" type="button" data-act="src-add">Add</button></div>
      <ul class="list">${list('source').map(r => `<li><div class="grow"><a href="${esc(/^https?:\/\//i.test(r.url) ? r.url : '#')}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a><div class="meta">${esc(r.publisher || '')}</div></div><button class="btn quiet" type="button" data-act="src-edit" data-id="${esc(r.id)}">Edit</button></li>`).join('')}</ul>`;
    return h;
  };

  // ---- setup
  views.setup = () => {
    const s = S();
    const code = connected() ? setupCode() : '';
    let h = `<h1>Setup</h1>`;
    h += `<h2>This phone</h2><p class="muted">Notes and ticks you make here are marked as from this person.</p>
      <div class="seg" role="group" aria-label="This phone belongs to">${['A', 'B'].map(p => `<button type="button" data-act="set-me" data-p="${p}" aria-pressed="${cfg.me === p}">${esc(nameOf(p))}</button>`).join('')}</div>`;

    h += `<h2>Names</h2><div class="row" style="align-items:flex-end">
      <div style="flex:1;min-width:140px"><label class="f" for="nameA">First person (roster anchor)</label><input type="text" id="nameA" value="${esc(s.names.A)}"></div>
      <div style="flex:1;min-width:140px"><label class="f" for="nameB">Second person</label><input type="text" id="nameB" value="${esc(s.names.B)}"></div></div>
      <div class="row end" style="margin-top:10px"><button class="btn" type="button" data-act="save-names">Save names</button></div>`;

    h += `<h2>Roster</h2>
      <label class="f" for="anchor">A date ${esc(s.names.A)} starts a first day shift</label>
      <p class="hint">Any past or future day 1 works. The app repeats the ${s.pattern.length}-day cycle from it.</p>
      <input type="date" id="anchor" value="${esc(s.anchor || '')}">
      <label class="f" for="offsetB">Days ${esc(s.names.B)} runs behind</label>
      <input type="number" id="offsetB" min="0" max="${s.pattern.length - 1}" value="${esc(s.offsetB)}">
      <label class="f" for="checkinDay">Check-in on ${esc(s.names.A)}'s cycle day</label>
      <select id="checkinDay">${s.pattern.map((p, i) => `<option value="${i + 1}" ${Number(s.checkinDay) === i + 1 ? 'selected' : ''}>Day ${i + 1}: ${esc(shiftLabel(i + 1))}</option>`).join('')}</select>
      <label class="f" for="deepEvery">Deeper review every</label>
      <select id="deepEvery">${[2, 3, 4, 5, 6].map(n => `<option value="${n}" ${Number(s.deepEvery) === n ? 'selected' : ''}>${ordinal(n)} check-in</option>`).join('')}</select>
      <div class="row end" style="margin-top:10px"><button class="btn" type="button" data-act="save-roster">Save roster</button></div>`;

    h += `<h2>GitHub sync</h2><p class="muted">Data saves to a JSON file in your private repo. Each phone needs the same details once.</p>
      <label class="f" for="ghOwner">GitHub username</label><input type="text" id="ghOwner" autocapitalize="off" autocomplete="off" spellcheck="false" value="${esc(cfg.owner)}">
      <label class="f" for="ghRepo">Private data repo</label><input type="text" id="ghRepo" autocapitalize="off" autocomplete="off" spellcheck="false" value="${esc(cfg.repo)}">
      <label class="f" for="ghPath">File</label><input type="text" id="ghPath" autocapitalize="off" autocomplete="off" spellcheck="false" value="${esc(cfg.path || 'data.json')}">
      <label class="f" for="ghToken">Access token</label><input type="password" id="ghToken" autocapitalize="off" autocomplete="off" spellcheck="false" value="${esc(cfg.token)}" placeholder="github_pat_…">
      <div class="row end" style="margin-top:10px"><button class="btn primary" type="button" data-act="save-conn">Save and sync</button></div>
      <p class="muted small" style="margin-top:8px">${connected() ? (syncErr && syncErr !== 'offline' ? esc(syncErr) : lastSync ? `Last synced ${esc(ago(lastSync))}.` : 'Not synced yet.') : 'Not connected.'}</p>`;

    h += `<h2>Set up the other phone</h2>`;
    if (code) {
      h += `<p>Send the setup code privately. It includes the access token, so delete the message once it's used.</p>
        <div class="row"><button class="btn" type="button" data-act="copy-code">Copy setup code</button><button class="btn" type="button" data-act="copy-link">Copy setup link</button></div>
        <p class="muted small" style="margin-top:8px">On an iPhone, add the app to the Home Screen first, open it from the icon, then paste the code below. The Home Screen app keeps its own storage, separate from Safari.</p>`;
    } else h += `<p class="muted">Connect GitHub above to make a setup code.</p>`;
    h += `<label class="f" for="pasteCode">Paste a setup code</label><input type="text" id="pasteCode" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="CHK1.…">
      <div class="row end" style="margin-top:10px"><button class="btn" type="button" data-act="apply-code">Use this code</button></div>`;

    h += `<h2>Appearance</h2><div class="seg" role="group" aria-label="Theme">${[['auto', 'Match phone'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button type="button" data-act="theme" data-theme="${k}" aria-pressed="${ui.theme === k}">${l}</button>`).join('')}</div>`;

    h += `<h2>Backup</h2><p class="muted">GitHub keeps every saved version in the repo's history. You can also keep a copy yourself.</p>
      <div class="row"><button class="btn" type="button" data-act="export">Download backup</button><label class="btn" for="importFile">Restore from backup</label><input type="file" id="importFile" accept="application/json,.json" class="sr"></div>`;

    h += `<hr><div class="row"><button class="btn" type="button" data-act="sync-now">Sync now</button><button class="btn danger" type="button" data-act="forget">Remove from this phone</button></div>`;
    return h;
  };

  // ---------------------------------------------------------------- sheet
  const sheetEl = $('#sheet'), scrim = $('#scrim');
  let sheet = null, lastFocus = null;
  function openSheet(st) {
    sheet = st; lastFocus = document.activeElement;
    sheetEl.innerHTML = `<div class="grab" aria-hidden="true"></div><h2 id="sheetTitle">${esc(st.title)}</h2>${st.body}
      <div class="row" style="margin-top:18px">${st.onDelete ? `<button class="btn danger" type="button" data-act="sheet-del">${esc(st.deleteLabel || 'Delete')}</button>` : ''}<span style="flex:1"></span>
      <button class="btn" type="button" data-act="sheet-close">${st.onSave ? 'Cancel' : 'Close'}</button>${st.onSave ? `<button class="btn primary" type="button" data-act="sheet-save">${esc(st.saveLabel || 'Save')}</button>` : ''}</div>`;
    scrim.classList.add('open'); sheetEl.classList.add('open');
    const first = sheetEl.querySelector('textarea, input, select');
    (first || sheetEl.querySelector('button')).focus({ preventScroll: true });
  }
  function closeSheet() {
    sheet = null; sheetEl.classList.remove('open'); scrim.classList.remove('open');
    if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
    if (renderPending) { renderPending = false; render(); }
  }
  const vals = () => { const v = {}; sheetEl.querySelectorAll('[name]').forEach(el => { v[el.name] = el.type === 'checkbox' ? el.checked : el.value; }); return v; };
  const fText = (name, label, value, rows) => `<label class="f" for="sf-${name}">${esc(label)}</label><textarea id="sf-${name}" name="${name}" style="min-height:${rows || 110}px">${esc(value || '')}</textarea>`;
  const fInput = (name, label, value, type) => `<label class="f" for="sf-${name}">${esc(label)}</label><input type="${type || 'text'}" id="sf-${name}" name="${name}" value="${esc(value || '')}">`;
  function fGroup(name, label, value, groups) {
    const opts = groups.map(g => `<option value="${esc(g)}" ${g === value ? 'selected' : ''}>${esc(g)}</option>`).join('');
    return `<label class="f" for="sf-${name}">${esc(label)}</label><select id="sf-${name}" name="${name}">${opts}<option value="__new">New group…</option></select>
      <input type="text" name="${name}New" placeholder="Name of the new group" style="margin-top:8px" aria-label="New group name">`;
  }
  const groupVal = v => (v.group === '__new' || v.cat === '__new' ? (v.groupNew || v.catNew || '').trim() : (v.group ?? v.cat));

  function editSimple(t, id, title, label) {
    const r = id ? get(id) : null;
    openSheet({
      title, body: fText('text', label, r ? r.text : ''),
      onSave: v => { const text = v.text.trim(); if (!text) return toast('Add some text first.'); r ? upd(id, { text }) : put({ id: uid(t), t, text, o: nextO(t), c: now() }); closeSheet(); },
      onDelete: r ? () => { if (confirm('Delete this?')) { remove(id); closeSheet(); } } : null
    });
  }

  // ---------------------------------------------------------------- toast & clipboard
  let toastTimer;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600); }
  async function copy(text, done) {
    try { await navigator.clipboard.writeText(text); toast(done); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove(); toast(ok ? done : 'Copy failed. Select the text and copy it yourself.');
    }
  }

  // ---------------------------------------------------------------- setup code
  const b64url = s => b64enc(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return b64dec(s); };
  const setupCode = () => 'CHK1.' + b64url(JSON.stringify({ o: cfg.owner, r: cfg.repo, p: cfg.path, t: cfg.token }));
  function readCode(code) {
    const m = String(code || '').trim().match(/CHK1\.([A-Za-z0-9_-]+)/);
    if (!m) return null;
    try { const j = JSON.parse(unb64url(m[1])); return j && j.o && j.r && j.t ? j : null; } catch { return null; }
  }
  function applyCode(j) {
    cfg = Object.assign({}, cfg, { owner: j.o, repo: j.r, path: j.p || 'data.json', token: j.t });
    store(LS.cfg, cfg); syncErr = ''; lastSync = 0;
    sync();
  }

  // ---------------------------------------------------------------- draft helpers
  function draftUpd(patch) { const d = get('draft'); if (d) put(Object.assign({}, d, patch)); }
  function drawQuestions() {
    const pool = list('q').map(q => q.id);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    return pool.slice(0, 3);
  }
  function openJar(target) {
    const sealed = list('jar', r => !r.openedIn);
    sealed.forEach(n => put(Object.assign({}, n, { openedIn: target, openedAt: now() })));
    return sealed.length;
  }
  function saveDraft() {
    const d = get('draft'); if (!d) return;
    const logId = uid('log');
    const steps = flowSteps(d.fmt);
    const answers = [];
    for (const st of steps) {
      if (['questions', 'finish', 'agenda', 'discuss', 'actions'].includes(st.kind)) continue;
      const a = { title: st.title, A: textOf(`dans-${st.id}-A`), B: textOf(`dans-${st.id}-B`), shared: textOf(`dans-${st.id}-shared`) };
      if (a.A || a.B || a.shared) answers.push(a);
    }
    const topics = (d.topics || []).map(id => ({ text: (get(id) || {}).text || '', notes: textOf(`dans-topic-${id}-shared`) })).filter(t => t.text);
    const questions = (d.qs || []).map(id => (get(id) || {}).text).filter(Boolean);
    const acts = list('action', r => r.logId === 'draft');
    acts.forEach(a => put(Object.assign({}, a, { logId })));
    list('action', r => r.doneIn === 'draft').forEach(a => put(Object.assign({}, a, { doneIn: logId })));
    const jar = list('jar', r => r.openedIn === 'draft');
    jar.forEach(n => put(Object.assign({}, n, { openedIn: logId })));
    put({ id: logId, t: 'log', date: isKey(d.date) ? d.date : todayKey(), fmt: d.fmt, answers, topics, questions, actions: acts.map(a => a.id), jar: jar.map(n => n.id), c: now() });
    list('dans').forEach(r => remove(r.id));
    remove('draft');
    toast('Check-in saved to the log.');
  }
  function discardDraft() {
    list('dans').forEach(r => remove(r.id));
    list('action', r => r.logId === 'draft').forEach(a => remove(a.id));
    list('jar', r => r.openedIn === 'draft').forEach(n => put(Object.assign({}, n, { openedIn: 'manual' })));
    list('action', r => r.doneIn === 'draft').forEach(a => put(Object.assign({}, a, { doneIn: null })));
    remove('draft');
  }
  function logSheet(id) {
    const l = get(id); if (!l) return;
    let b = `<p class="muted">${esc(fmtName(l.fmt))}</p>`;
    if ((l.questions || []).length) b += `<h3>Questions</h3><ul>${l.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul>`;
    for (const a of l.answers || []) {
      b += `<h3>${esc(a.title)}</h3>`;
      if (a.shared) b += `<div class="note"><p>${esc(a.shared)}</p></div>`;
      for (const p of ['A', 'B']) if (a[p]) b += `<div class="note ${p}"><p>${esc(a[p])}</p><div class="meta">${esc(nameOf(p))}</div></div>`;
    }
    if ((l.topics || []).length) { b += `<h3>Agenda</h3>`; for (const t of l.topics) b += `<div class="note"><p><strong>${esc(t.text)}</strong>${t.notes ? '\n' + esc(t.notes) : ''}</p></div>`; }
    const acts = (l.actions || []).map(get).filter(Boolean);
    if (acts.length) b += `<h3>Action points</h3><ul class="list">${acts.map(a => `<li><div class="grow ${a.done ? 'done-text' : ''}">${esc(a.text)}</div>${a.owner && a.owner !== 'both' ? personTag(a.owner) : '<span class="tag both">Both</span>'}</li>`).join('')}</ul>`;
    const jar = (l.jar || []).map(get).filter(Boolean);
    if (jar.length) b += `<h3>From the jar</h3>${jar.map(noteCard).join('')}`;
    if (!(l.answers || []).length && !acts.length && !jar.length && !(l.topics || []).length) b += `<p class="empty">No notes were written for this check-in.</p>`;
    openSheet({ title: fmtLong(l.date), body: b, onDelete: () => { if (confirm('Delete this check-in from the log?')) { remove(id); closeSheet(); } }, deleteLabel: 'Delete' });
  }

  // ---------------------------------------------------------------- actions
  const actions = {
    tab: el => go(el.dataset.tab),
    jump: (el, ev) => { ev.preventDefault(); const t = document.getElementById(el.dataset.to); if (t) t.scrollIntoView({ block: 'start' }); },
    'set-me': el => { cfg.me = el.dataset.p; store(LS.cfg, cfg); render(); toast(`This phone is set to ${nameOf(cfg.me)}.`); },
    'sync-now': () => { syncErr = ''; sync(); },

    'flow-start': el => {
      if (get('draft')) return go('checkin');
      put({ id: 'draft', t: 'draft', fmt: el.dataset.fmt === 'deep' ? 'deep' : 'regular', step: 0, qs: drawQuestions(), topics: [], date: todayKey(), c: now() });
      render.keepScroll = false;
    },
    'flow-next': () => { const d = get('draft'); if (d) { draftUpd({ step: (d.step || 0) + 1 }); render.keepScroll = false; window.scrollTo(0, 0); } },
    'flow-back': () => { const d = get('draft'); if (d) { draftUpd({ step: Math.max(0, (d.step || 0) - 1) }); render.keepScroll = false; window.scrollTo(0, 0); } },
    'flow-cancel': () => { if (confirm('Discard this check-in? Notes written so far will be lost. Opened jar notes stay opened.')) discardDraft(); },
    'flow-save': () => { flushBinds(); saveDraft(); render.keepScroll = false; window.scrollTo(0, 0); },
    'q-toggle': el => { const d = get('draft'); if (!d) return; const id = el.dataset.id, qs = d.qs || []; draftUpd({ qs: qs.includes(id) ? qs.filter(x => x !== id) : [...qs, id] }); },
    'q-draw': () => draftUpd({ qs: drawQuestions() }),
    'topic-toggle': el => { const d = get('draft'); if (!d) return; const id = el.dataset.id, ts = d.topics || []; draftUpd({ topics: ts.includes(id) ? ts.filter(x => x !== id) : [...ts, id] }); },
    'jar-open-draft': () => { const n = openJar('draft'); toast(`${plural(n, 'note')} out of the jar.`); },
    owner: el => { compose.owner = el.dataset.p; renderSoon(); },
    'action-add': () => {
      const text = (compose.action || '').trim();
      if (!text) return toast('Write the action point first.');
      put({ id: uid('act'), t: 'action', text, owner: compose.owner || 'both', done: false, logId: 'draft', c: now() });
      compose.action = '';
    },
    'action-del': el => remove(el.dataset.id),
    'action-edit': el => {
      const a = get(el.dataset.id); if (!a) return;
      openSheet({
        title: 'Action point',
        body: fText('text', 'Action point', a.text, 80) + `<label class="f" for="sf-owner">Who</label><select id="sf-owner" name="owner">${['A', 'B', 'both'].map(p => `<option value="${p}" ${(a.owner || 'both') === p ? 'selected' : ''}>${esc(nameOf(p))}</option>`).join('')}</select>`,
        onSave: v => { if (!v.text.trim()) return toast('Add some text first.'); upd(a.id, { text: v.text.trim(), owner: v.owner }); closeSheet(); },
        onDelete: () => { if (confirm('Delete this action point?')) { remove(a.id); closeSheet(); } }
      });
    },

    'jar-add': () => {
      const text = (compose.jar || '').trim();
      if (!cfg.me) return toast('Pick who is using this phone first.');
      if (!text) return toast('Write your note first.');
      put({ id: uid('jar'), t: 'jar', from: cfg.me, text, openedIn: null, c: now() });
      compose.jar = ''; toast('Sealed in the jar.');
    },
    'jar-del': el => { if (confirm('Remove this note from the jar?')) remove(el.dataset.id); },
    'jar-open-now': () => { if (confirm('Open the jar now? Every sealed note becomes readable to both of you.')) { const n = openJar('manual'); toast(`${plural(n, 'note')} opened.`); } },

    'idea-cat': el => { ui.ideaCat = el.dataset.cat; store(LS.ui, ui); render(); },
    'idea-add': () => {
      const cat = ui.ideaCat || 'date', key = 'idea-' + cat, text = (compose[key] || '').trim();
      if (!text) return toast('Write the idea first.');
      put({ id: uid('idea'), t: 'idea', cat, text, from: cfg.me || '', done: false, c: now() });
      compose[key] = '';
    },
    'idea-edit': el => {
      const i = get(el.dataset.id); if (!i) return;
      openSheet({
        title: 'Edit idea',
        body: fText('text', 'Idea', i.text) + `<label class="f" for="sf-cat">Category</label><select id="sf-cat" name="cat">${IDEA_CATS.map(([k, l]) => `<option value="${k}" ${(i.cat || 'date') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`,
        onSave: v => { if (!v.text.trim()) return toast('Add some text first.'); upd(i.id, { text: v.text.trim(), cat: v.cat }); closeSheet(); },
        onDelete: () => { if (confirm('Delete this idea?')) { remove(i.id); closeSheet(); } }
      });
    },

    'text-edit': el => {
      const key = el.dataset.key, id = `text-${key}`, r = get(id);
      openSheet({
        title: el.dataset.title || 'Edit', body: fText('text', 'Text', r ? r.text : '', 220) + '<p class="hint" style="margin-top:6px">Leave a blank line between paragraphs.</p>',
        onSave: v => { put({ id, t: 'text', key, text: v.text.replace(/\r/g, '').trim() }); closeSheet(); }
      });
    },
    'rule-add': () => editSimple('rule', null, 'New ground rule', 'Ground rule'),
    'rule-edit': el => editSimple('rule', el.dataset.id, 'Ground rule', 'Ground rule'),
    'agree-add': () => editSimple('agree', null, 'New agreement', 'Agreement or action'),
    'agree-edit': el => editSimple('agree', el.dataset.id, 'Agreement', 'Agreement or action'),
    'step-edit': el => {
      const st = get(el.dataset.id); if (!st) return;
      openSheet({
        title: 'Edit step', body: fInput('title', 'Step name', st.title) + fText('body', 'What we do', st.body),
        onSave: v => { if (!v.title.trim()) return toast('Give the step a name.'); upd(st.id, { title: v.title.trim(), body: v.body.trim() }); closeSheet(); }
      });
    },
    'topic-add': () => openTopic(null),
    'topic-edit': el => openTopic(el.dataset.id),
    'q-add': () => openQuestion(null),
    'q-edit': el => openQuestion(el.dataset.id),
    'src-add': () => openSource(null),
    'src-edit': el => openSource(el.dataset.id),
    'log-open': el => logSheet(el.dataset.id),

    'sheet-close': () => closeSheet(),
    'sheet-save': () => sheet && sheet.onSave && sheet.onSave(vals()),
    'sheet-del': () => sheet && sheet.onDelete && sheet.onDelete(),

    'save-names': () => {
      const A = $('#nameA').value.trim(), B = $('#nameB').value.trim();
      if (!A || !B) return toast('Both names need filling in.');
      put(Object.assign({}, S(), { names: { A, B } })); toast('Names saved.');
    },
    'save-roster': () => {
      const anchor = $('#anchor').value, len = S().pattern.length;
      const offsetB = Math.min(len - 1, Math.max(0, parseInt($('#offsetB').value, 10) || 0));
      if (anchor && !isKey(anchor)) return toast('Pick a valid date.');
      put(Object.assign({}, S(), { anchor: anchor || null, offsetB, checkinDay: Number($('#checkinDay').value) || 10, deepEvery: Number($('#deepEvery').value) || 3 }));
      toast('Roster saved.');
    },
    'save-conn': () => {
      cfg = Object.assign({}, cfg, { owner: $('#ghOwner').value.trim(), repo: $('#ghRepo').value.trim(), path: ($('#ghPath').value.trim() || 'data.json').replace(/^\/+/, ''), token: $('#ghToken').value.trim() });
      store(LS.cfg, cfg); syncErr = ''; lastSync = 0;
      if (!connected()) { render(); return toast('Fill in all four fields.'); }
      toast('Syncing…');
      sync().then(() => { render(); toast(syncErr ? (syncErr === 'offline' ? 'No connection. Saved on this phone.' : syncErr) : 'Connected and synced.'); });
    },
    'copy-code': () => copy(setupCode(), 'Setup code copied.'),
    'copy-link': () => copy(`${location.origin}${location.pathname}#setup=${setupCode()}`, 'Setup link copied.'),
    'apply-code': () => {
      const j = readCode($('#pasteCode').value);
      if (!j) return toast('That doesn\'t look like a setup code.');
      applyCode(j); render(); toast('Setup applied. Pick who is using this phone.');
    },
    theme: el => { ui.theme = el.dataset.theme; store(LS.ui, ui); applyTheme(); render(); },
    export: () => {
      const blob = new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `checkin-backup-${todayKey()}.json`;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    },
    forget: () => {
      if (!confirm('Remove the token and all data from this phone? Data already synced stays on GitHub.')) return;
      Object.values(LS).forEach(k => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
      location.reload();
    },
    'action-done': (el) => {
      const a = get(el.dataset.id); if (!a) return;
      const d = get('draft');
      upd(a.id, { done: el.checked, doneAt: el.checked ? now() : null, doneIn: el.checked && d ? 'draft' : (el.checked ? a.doneIn || null : null) });
    },
    'idea-done': el => upd(el.dataset.id, { done: el.checked, doneAt: el.checked ? now() : null }),
    'agree-done': el => upd(el.dataset.id, { done: el.checked })
  };

  function openTopic(id) {
    const t = id ? get(id) : null, groups = [...new Set(list('topic').map(x => x.group || 'Topics'))];
    if (!groups.length) groups.push('Topics');
    openSheet({
      title: t ? 'Edit topic' : 'New topic',
      body: fInput('text', 'Topic', t ? t.text : '') + fGroup('group', 'Group', t ? t.group : groups[groups.length - 1], groups),
      onSave: v => { const text = v.text.trim(), group = groupVal(v); if (!text || !group) return toast('Fill in the topic and its group.'); t ? upd(id, { text, group }) : put({ id: uid('topic'), t: 'topic', text, group, o: nextO('topic'), c: now() }); closeSheet(); },
      onDelete: t ? () => { if (confirm('Delete this topic?')) { remove(id); closeSheet(); } } : null
    });
  }
  function openQuestion(id) {
    const q = id ? get(id) : null, cats = [...new Set(list('q').map(x => x.cat))];
    if (!cats.length) cats.push('Questions');
    openSheet({
      title: q ? 'Edit question' : 'New question',
      body: fText('text', 'Question', q ? q.text : '', 90) + fGroup('cat', 'Section', q ? q.cat : cats[0], cats),
      onSave: v => { const text = v.text.trim(), cat = groupVal(v); if (!text || !cat) return toast('Fill in the question and its section.'); q ? upd(id, { text, cat }) : put({ id: uid('q'), t: 'q', text, cat, o: nextO('q'), c: now() }); closeSheet(); },
      onDelete: q ? () => { if (confirm('Delete this question?')) { remove(id); closeSheet(); } } : null
    });
  }
  function openSource(id) {
    const r = id ? get(id) : null;
    openSheet({
      title: r ? 'Edit source' : 'New source',
      body: fInput('title', 'Title', r ? r.title : '') + fInput('publisher', 'Publisher', r ? r.publisher : '') + fInput('url', 'Link', r ? r.url : '', 'url'),
      onSave: v => { const title = v.title.trim(), url = v.url.trim(); if (!title || !/^https?:\/\//i.test(url)) return toast('Add a title and a link starting with https://'); const rec = { title, url, publisher: v.publisher.trim() }; r ? upd(id, rec) : put(Object.assign({ id: uid('source'), t: 'source', o: nextO('source'), c: now() }, rec)); closeSheet(); },
      onDelete: r ? () => { if (confirm('Delete this source?')) { remove(id); closeSheet(); } } : null
    });
  }

  // ---------------------------------------------------------------- events
  document.addEventListener('click', ev => {
    const el = ev.target.closest('[data-act]');
    if (!el || el.tagName === 'INPUT' || el.disabled) return;
    const fn = actions[el.dataset.act];
    if (fn) { forceRender = true; fn(el, ev); queueMicrotask(() => { forceRender = false; }); }
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && sheet) closeSheet();
    const el = ev.target.closest && ev.target.closest('[role="button"][data-act]');
    if (el && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); actions[el.dataset.act](el, ev); }
  });
  document.addEventListener('change', ev => {
    const el = ev.target;
    if (el.matches('input[type=checkbox][data-act]')) { actions[el.dataset.act](el, ev); return; }
    if (el.dataset.actChange === 'draft-date' && isKey(el.value)) draftUpd({ date: el.value });
    if (el.id === 'importFile' && el.files && el.files[0]) {
      const f = el.files[0], rd = new FileReader();
      rd.onload = () => {
        try {
          const j = JSON.parse(rd.result);
          if (!j || typeof j.recs !== 'object') throw new Error('bad');
          if (!confirm('Merge this backup into your data? Newer edits win where both have the same item.')) return;
          doc = merge(doc, j); changed(); toast('Backup merged.');
        } catch { toast('That file isn\'t a Check-in backup.'); }
      };
      rd.readAsText(f); el.value = '';
    }
  });
  scrim.addEventListener('click', closeSheet);

  // Text fields bound to records save as you type.
  const bindTimers = {};
  function saveBind(el) {
    const id = el.dataset.bind, text = el.value, r = get(id);
    if ((r ? r.text : '') !== text) put({ id, t: 'dans', text }, true);
  }
  function flushBinds() {
    for (const k of Object.keys(bindTimers)) { clearTimeout(bindTimers[k]); delete bindTimers[k]; }
    view.querySelectorAll('[data-bind]').forEach(saveBind);
  }
  document.addEventListener('input', ev => {
    const el = ev.target;
    if (el.dataset.bind) { clearTimeout(bindTimers[el.dataset.bind]); bindTimers[el.dataset.bind] = setTimeout(() => { delete bindTimers[el.dataset.bind]; saveBind(el); }, 700); }
    if (el.dataset.compose) compose[el.dataset.compose] = el.value;
  });
  document.addEventListener('focusout', ev => { const el = ev.target; if (el.dataset && el.dataset.bind) { clearTimeout(bindTimers[el.dataset.bind]); delete bindTimers[el.dataset.bind]; saveBind(el); } });

  $('#gear').addEventListener('click', () => go('setup'));
  $('#sync').addEventListener('click', () => { if (connected()) { syncErr = ''; sync(); toast('Syncing…'); } else go('setup'); });
  document.querySelectorAll('#tabs [data-tab]').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));
  window.addEventListener('scroll', () => $('#top').classList.toggle('scrolled', window.scrollY > 4), { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { sync(); render(); } else flushBinds(); });
  window.addEventListener('online', () => sync());
  window.addEventListener('pagehide', flushBinds);
  setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 45000);
  setInterval(() => paintSync(), 30000);

  function applyTheme() {
    if (ui.theme === 'light' || ui.theme === 'dark') document.documentElement.dataset.theme = ui.theme;
    else delete document.documentElement.dataset.theme;
  }

  // ---------------------------------------------------------------- start
  applyTheme();
  if (location.hash.startsWith('#setup=')) {
    const j = readCode(decodeURIComponent(location.hash.slice(7)));
    history.replaceState(null, '', location.pathname + location.search);
    if (j) { applyCode(j); ui.tab = 'setup'; setTimeout(() => toast('Setup applied. Pick who is using this phone.'), 300); }
  }
  render.keepScroll = false;
  render();
  sync();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });

  // Exposed for testing only.
  window.__checkin = { merge, canon, get doc() { return doc; }, sync, cycleDay };
})();
