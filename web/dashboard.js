// Dashboard page logic. src/render/html.mjs wraps this file and src/meter.mjs in one function scope,
// so evaluate(), fmtDur(), clampPct() and STATUS_LABEL come from src/meter.mjs.
// Everything shown is built with textContent / setAttribute, never innerHTML.

const DAY = 864e5;
const MANUAL_KEY = 'quota-board-manual-v1';   // static mode: manual readings live in this browser only
const MODE = (() => { try { return JSON.parse(document.getElementById('qb-mode').textContent).mode; } catch { return 'static'; } })();

let DATA = null;            // board: { plans }
let USAGE = { plans: {} };  // usage.plans[planId]
let METER = {};             // "planId/meterId" -> meter with .plan
let manual = {};            // meterId -> { used, resetAt, updatedAt }
const saveTimers = {};

// ---------- helpers ----------
const $ = id => document.getElementById(id);
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  kids.flat().forEach(c => { if (c != null && c !== false) e.append(c); });
  return e;
}
const safeUrl = u => (typeof u === 'string' && u.startsWith('https://') ? u : null);
const ago = t => (Date.now() - t < 60000 ? 'just now' : `${fmtDur(Date.now() - t)} ago`);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const money = p => `$${p.amount % 1 ? p.amount.toFixed(2) : p.amount}/${p.period === 'year' ? 'yr' : 'mo'}`;
const fmtDate = t => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
const key = (planId, meterId) => `${planId}/${meterId}`;
const rowId = (m, prefix) => `${prefix}-${m.plan}--${m.id}`;
const planUsage = planId => (USAGE.plans && USAGE.plans[planId]) || null;
const evalMeter = m => evaluate(m, planUsage(m.plan), manual);
function toLocalInput(t) {
  if (!t) return '';
  const d = new Date(t), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- meters ----------
function buildPlans() {
  const root = $('plans');
  root.textContent = '';
  if (!DATA.plans.length) {
    root.append(el('div', { class: 'plan-row' }, el('p', { class: 'small muted', text: 'No plans on your board yet. Sign in to Claude Code, Codex, Cursor or the Antigravity CLI and refresh, or run "quota-board plans" and then "quota-board use <plan-id>".' })));
    return;
  }
  for (const p of DATA.plans) {
    const listPrice = p.price.listAmount != null ? ` (list ${money({ ...p.price, amount: p.price.listAmount })})` : '';
    const head = el('div', { class: 'plan-id' },
      el('span', { class: 'name', text: p.name }),
      el('span', { class: 'small muted', text: `${p.vendor} · ${money(p.price)}${listPrice}` }));
    if (p.status !== 'active') head.append(el('span', { class: 'tag', text: p.status }));
    head.append(el('span', { class: 'warn', id: 'tw-' + p.id, hidden: true }), el('span', { class: 'cstat', id: 'cs-' + p.id }));

    const meters = el('div', { class: 'meters' });
    for (const pm of p.meters) {
      const m = METER[key(p.id, pm.id)];
      const used = el('input', { type: 'number', min: '0', max: '100', step: '1', id: rowId(m, 'u'), 'aria-label': `${m.label} percent used`, placeholder: '—' });
      const reset = el('input', { type: 'datetime-local', id: rowId(m, 'r'), 'aria-label': `${m.label} resets at` });
      used.addEventListener('input', () => onEdit(m));
      reset.addEventListener('change', () => onEdit(m));
      meters.append(el('div', { class: 'meter', id: rowId(m, 'm') },
        el('div', { class: 'mlabel' }, m.label, m.hint ? el('small', { text: m.hint }) : null),
        el('div', { class: 'bar', role: 'img' }, el('div', { class: 'fill' }), el('div', { class: 'pace', hidden: true })),
        el('div', { class: 'mctrl' }, el('label', null, used, '% used'), el('label', null, 'resets', reset)),
        el('div', { class: 'mfoot' }, el('span', { class: 'chip' }), el('span', { class: 'src', hidden: true }), el('span', { class: 'mnote' })),
        el('div', { class: 'mrule', text: 'Reset rule: ' + m.reset.rule }),
        el('div', { class: 'bd', hidden: true })));
    }
    root.append(el('div', { class: 'plan-row' }, head, meters));
  }
}

function fillInputs() {
  for (const m of Object.values(METER)) {
    const ev = evalMeter(m), u = $(rowId(m, 'u')), rs = $(rowId(m, 'r'));
    if (!u) continue;
    if (document.activeElement !== u) u.value = ev.used == null ? '' : Math.round(ev.used * 10) / 10;
    // Show computed resets (auto Monday, calendar month) but not a guessed one.
    const knownReset = ev.reset && (ev.resetAt || m.auto || m.reset.type === 'calendar-month');
    if (document.activeElement !== rs) rs.value = knownReset ? toLocalInput(ev.reset) : '';
  }
}

function meterNote(m, ev) {
  let note = '';
  if (ev.expired) note = 'Window has probably reset since this reading. ';
  else if (ev.rolled) note = 'Reset since this reading, so it counts as 0%. ';
  if (ev.remaining != null) note += `Resets in ${fmtDur(ev.remaining)}. `;
  else if (!ev.expired && ev.source !== 'live') note += m.period === '5h' ? 'Set the reset time once a window starts. ' : 'Set the reset time once; it repeats. ';
  if (ev.note) note += ev.note;
  return note.trim();
}

function paintBreakdown(box, breakdown) {
  box.textContent = '';
  box.hidden = !(breakdown && breakdown.length);
  for (const b of (breakdown || []).slice(0, 12)) {
    const val = b.share != null ? `${clampPct(b.share)}% of use` : b.used != null ? `${clampPct(b.used)}% used` : '';
    const resetIn = b.resetAt && Date.parse(b.resetAt) > Date.now() ? ' · ' + fmtDur(Date.parse(b.resetAt) - Date.now()) : null;
    box.append(el('span', null, String(b.label || '') + ' ', el('b', { text: val }), resetIn));
  }
}

function collectorStatus(c) {
  if (!c || c.status === 'manual') return 'Manual entry';
  if (c.status === 'ok') {
    const extra = c.unmapped && c.unmapped.length ? ` · ${c.unmapped.length} limit(s) not on this board` : '';
    return (c.freshness === 'cached' ? 'Cached data' : 'Live') + extra + (c.note ? ' · ' + c.note : '');
  }
  if (c.status === 'not-configured') return c.hint || c.error || 'Not set up';
  return 'Collector failed: ' + (c.error || 'unknown');
}

function paintMeters() {
  let soonest = null;
  for (const m of Object.values(METER)) {
    const ev = evalMeter(m), row = $(rowId(m, 'm'));
    if (!row) continue;
    row.dataset.st = ev.status;
    row.querySelector('.fill').style.width = (ev.used == null ? 0 : ev.used) + '%';
    const pace = row.querySelector('.pace');
    pace.hidden = ev.elapsed == null || ev.used == null;
    if (!pace.hidden) pace.style.left = `calc(${(ev.elapsed * 100).toFixed(1)}% - 1px)`;
    row.querySelector('.bar').setAttribute('aria-label', ev.used == null ? 'no reading' : ev.used + '% used');
    const chip = row.querySelector('.chip');
    chip.className = 'chip st-' + ev.status;
    chip.textContent = cap(STATUS_LABEL[ev.status]);
    const src = row.querySelector('.src');
    src.hidden = !ev.source;
    if (ev.source) {
      src.className = 'src' + (ev.source === 'live' ? ' live' : '');
      src.textContent = `${cap(ev.source)} · ${ago(ev.updatedAt)}`;
    }
    row.querySelector('.mnote').textContent = meterNote(m, ev);
    paintBreakdown(row.querySelector('.bd'), ev.breakdown);
    if (ev.remaining != null && (!soonest || ev.remaining < soonest.ms)) soonest = { ms: ev.remaining, label: m.label };
  }
  $('next-reset').textContent = soonest ? fmtDur(soonest.ms) : '—';
  $('next-reset').title = soonest ? soonest.label : '';
  for (const p of DATA.plans) {
    const c = planUsage(p.id), tw = $('tw-' + p.id);
    const unconfirmed = c && c.reason && c.reason.includes('unconfirmed') ? (c.tierNote || 'Tier unconfirmed.') : '';
    const warn = c && (c.tierMismatch || unconfirmed);
    tw.hidden = !warn;
    tw.textContent = warn || '';
    $('cs-' + p.id).textContent = collectorStatus(c);
  }
  $('collected-at').textContent = USAGE.collectedAt ? ago(Date.parse(USAGE.collectedAt)) : 'never';
}

function onEdit(m) {
  const u = $(rowId(m, 'u')).value, rs = $(rowId(m, 'r')).value;
  if (u === '') delete manual[m.id];
  else manual[m.id] = { used: Number(u), resetAt: rs ? new Date(rs).toISOString() : null, updatedAt: new Date().toISOString() };
  paint();
  clearTimeout(saveTimers[m.id]);
  saveTimers[m.id] = setTimeout(() => saveManual(m.id), 700);
}

function saveManual(id) {
  const v = manual[id] || { used: null, resetAt: null };
  if (MODE === 'served') {
    fetch('/api/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Quota-Board': '1' },
      body: JSON.stringify({ meterId: id, used: v.used, resetAt: v.resetAt })
    })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); setSync('Saved to your quota-board config'); })
      .catch(() => setSync('Couldn\'t save. Is quota-board serve still running?'));
    return;
  }
  try {
    const all = JSON.parse(localStorage.getItem(MANUAL_KEY) || '{}');
    if (manual[id]) all[id] = manual[id]; else delete all[id];
    localStorage.setItem(MANUAL_KEY, JSON.stringify(all));
    setSync('Saved in this browser only. Use "quota-board serve" or "quota-board set" to keep readings in your config.');
  } catch {
    setSync('Couldn\'t save in this browser');
  }
}
const setSync = t => { $('sync').textContent = t; };

// ---------- notes ----------
function paintNotes(state) {
  const items = (state.unknown || []).map(x => `${x.collector} reports tier "${x.tier}", which no plan file matches. Run "quota-board use <plan-id>" to pick yours and "quota-board report" so it gets added.`);
  const box = $('notes');
  box.textContent = '';
  box.hidden = !items.length;
  if (!items.length) return;
  box.className = 'banner note';
  box.append(el('strong', { text: 'Needs attention' }), el('ul', null, items.map(t => el('li', { text: t }))));
}

// ---------- spendable resets ----------
function paintResets() {
  const root = $('resets');
  root.textContent = '';
  const items = DATA.plans.flatMap(p => (p.resets || []).map(r => ({ p, r })));
  if (!items.length) { root.append(el('p', { class: 'small muted', text: 'None of your plans has a spendable reset right now.' })); return; }
  for (const { p, r } of items) {
    const c = planUsage(p.id), live = c && c.resets && c.resets[r.id];
    let count = '?', sub = (r.count && r.count.rule) || null;
    let exp = r.expires ? Date.parse(r.expires) : null;
    if (live && live.available != null) {
      count = `${live.available} held`;
      sub = live.usableNow != null ? `${live.usableNow} usable right now` : null;
      if (live.nextExpiry) exp = Date.parse(live.nextExpiry);   // the provider reports when the next one expires
    } else if (r.count && r.count.min != null) {
      count = r.count.min === r.count.max ? String(r.count.min) : `${r.count.min}–${r.count.max}`;
    }
    const expText = !exp ? 'No expiry date published' : exp > Date.now() ? `${live && live.nextExpiry ? 'Next one expires' : 'Expires'} in ${fmtDur(exp - Date.now())} (${fmtDate(exp)})` : 'Expired';
    root.append(el('div', { class: 'rcard' },
      el('div', { class: 'eyebrow', text: p.name }),
      el('h3', { text: r.label }),
      el('div', { class: 'count', text: count }),
      sub ? el('div', { class: 'small muted', text: sub }) : null,
      el('div', { class: 'small', text: expText }),
      el('div', { class: 'small', text: 'How: ' + r.howTo }),
      el('ul', null, (r.stipulations || []).map(s => el('li', { text: s })))));
  }
}

// ---------- timeline ----------
function buildTimeline() {
  const root = $('timeline');
  root.textContent = '';
  const now = Date.now();
  const when = e => (e.date ? Date.parse(e.date) : now);
  const evs = DATA.plans.flatMap(p => (p.events || []).map(e => ({ ...e, who: p.vendor }))).sort((a, b) => when(a) - when(b));
  if (!evs.length) { root.append(el('p', { class: 'small muted', style: 'padding-left:16px', text: 'Nothing dated for your plans.' })); return; }
  for (const e of evs) {
    const t = e.date ? new Date(e.date + 'T23:59:00') : null;
    const past = t && t < now, days = t ? Math.ceil((t - now) / DAY) : null, src = safeUrl(e.source);
    const rel = !t ? 'no end date given' : past ? 'ended' : days <= 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`;
    root.append(el('div', { class: 'ev' + (past ? ' past' : '') + (e.unverified ? ' unv' : '') },
      el('div', { class: 'when' }, el('b', { text: t ? fmtDate(t) : 'Now' }), rel),
      el('div', { class: 'what' },
        el('div', { class: 'who', text: e.who + (e.unverified ? ' · unconfirmed' : '') }),
        el('div', null, e.what, src ? ' ' : null, src ? el('a', { href: src, target: '_blank', rel: 'noopener', text: 'Source' }) : null))));
  }
}

// ---------- plan cards and model tables ----------
const list = (title, items) => (items && items.length
  ? el('div', null, el('h4', { text: title }), el('ul', null, items.map(x => (typeof x === 'string' ? el('li', { text: x }) : x))))
  : null);

function planCard(p) {
  const c = p.card || {}, age = (Date.now() - Date.parse(p.lastVerified)) / DAY, check = safeUrl(p.check.url);
  const resetItems = p.meters.map(m => el('li', null, el('b', { text: m.label + ': ' }), m.reset.rule,
    m.reset.stipulations && m.reset.stipulations.length ? el('ul', null, m.reset.stipulations.map(s => el('li', { text: s }))) : null));
  return el('article', { class: 'card' },
    el('div', { class: 'head' }, el('h3', { text: p.name }), el('span', { class: 'price', text: money(p.price) })),
    p.status !== 'active' ? el('span', { class: 'tag', text: p.status }) : null,
    c.alert ? el('div', { class: 'alert', text: c.alert }) : null,
    p.price.note ? el('p', { class: 'small muted', text: p.price.note }) : null,
    list('How the limits work', c.how),
    list('Resets', resetItems),
    list('Outside models and tools', c.ext),
    list('Quirks', c.quirks),
    p.overage ? el('div', null, el('h4', { text: 'When you hit the limit' }), el('p', { class: 'small', text: p.overage })) : null,
    el('div', { class: 'foot' },
      el('div', null, 'Check usage: ', check ? el('a', { href: check, target: '_blank', rel: 'noopener', text: p.check.label }) : p.check.label),
      el('div', { class: 'muted' }, 'Verified ' + fmtDate(p.lastVerified + 'T12:00:00'),
        age > 45 ? el('span', { class: 'chip st-tight', style: 'margin-left:8px', text: 'Needs re-check' }) : null),
      el('div', { class: 'srcs' }, (p.sources || []).map(s => (safeUrl(s.url)
        ? el('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.label + (s.official ? '' : ' (3rd party)') })
        : null)))));
}

function modelTable(p) {
  const t = p.modelTable, cols = t.columns || [];
  const cell = (v, i) => {
    if (!i || typeof v !== 'number') return String(v);
    return cols[i] && /cap|\$/i.test(cols[i]) ? '$' + v : v.toLocaleString();
  };
  return el('details', null, el('summary', { text: t.title || p.name + ' models' }), el('div', { class: 'tbl-wrap' },
    t.note ? el('p', { class: 'small muted', style: 'margin-bottom:10px', text: t.note }) : null,
    el('table', null,
      el('thead', null, el('tr', null, cols.map((h, i) => el('th', { class: i ? 'num' : null, text: h })))),
      el('tbody', null,
        t.rows.map(r => el('tr', null, r.map((v, i) => el('td', { class: i ? 'num' : null, text: cell(v, i) })))),
        t.footer ? el('tr', null, el('td', { class: 'muted', colspan: String(cols.length), text: t.footer })) : null))));
}

function buildCards() {
  const cards = $('cards'), tables = $('tables');
  cards.textContent = '';
  tables.textContent = '';
  for (const p of DATA.plans) {
    cards.append(planCard(p));
    if (p.modelTable && Array.isArray(p.modelTable.rows)) tables.append(modelTable(p));
  }
}

// ---------- boot ----------
function paint() { paintMeters(); paintResets(); }

function apply(state, full) {
  DATA = state.board;
  USAGE = state.usage || { plans: {} };
  // Static mode: merge readings typed into this browser; the newer of each wins.
  let local = {};
  if (MODE === 'static') { try { local = JSON.parse(localStorage.getItem(MANUAL_KEY) || '{}'); } catch { /* storage blocked */ } }
  manual = { ...(state.manual || {}) };
  for (const [k, v] of Object.entries(local)) if (!manual[k] || Date.parse(v.updatedAt) > Date.parse(manual[k].updatedAt)) manual[k] = v;
  METER = {};
  for (const p of DATA.plans) for (const m of p.meters) METER[key(p.id, m.id)] = { ...m, plan: p.id };

  const total = DATA.plans.reduce((s, p) => s + (p.price.period === 'year' ? p.price.amount / 12 : p.price.amount), 0);
  $('spend').textContent = '$' + Math.round(total);
  const oldest = DATA.plans.map(p => p.lastVerified).sort()[0];
  $('verified').textContent = oldest
    ? 'Plan facts checked ' + fmtDate(oldest + 'T12:00:00') + (DATA.plans.some(p => p.lastVerified !== oldest) ? ' or later' : '')
    : 'No plans yet';
  if (state.version) $('ver').textContent = ' v' + state.version;
  if (full) { buildPlans(); buildTimeline(); buildCards(); }
  paintNotes(state);
  fillInputs();
  paint();
}

async function fetchState() {
  const r = await fetch('/api/state', { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function boot() {
  try {
    apply(MODE === 'served' ? await fetchState() : JSON.parse($('qb-state').textContent), true);
  } catch {
    const b = $('load-error');
    b.hidden = false;
    b.textContent = 'Couldn\'t load your board. Run "quota-board" or "quota-board serve" again.';
    setSync('');
    return;
  }
  if (MODE === 'served') {
    setSync('Live from quota-board serve');
    const btn = $('refresh-btn');
    btn.hidden = false;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      setSync('Collecting…');
      try {
        const r = await fetch('/api/refresh', { method: 'POST', headers: { 'X-Quota-Board': '1' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        apply(await r.json(), true);
        setSync('Refreshed');
      } catch { setSync('Refresh failed'); }
      btn.disabled = false;
    });
    setInterval(async () => {
      try {
        const s = await fetchState();
        const plansChanged = s.board.plans.map(p => p.id).join() !== DATA.plans.map(p => p.id).join();
        apply(s, plansChanged);
      } catch { setSync('Lost connection to quota-board serve'); }
    }, 60000);
  } else {
    const at = USAGE.collectedAt ? new Date(USAGE.collectedAt).toLocaleString() : 'an unknown time';
    setSync(`Snapshot from ${at}. Run "quota-board" again to update it, or "quota-board serve" for live updates.`);
  }
  setInterval(paint, 60000);
}

boot();
