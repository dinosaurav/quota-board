// Dashboard page logic. src/render/html.mjs wraps this file and src/meter.mjs in one function scope,
// so evaluate(), fmtDur(), clampPct() and STATUS_LABEL come from src/meter.mjs.
// Everything shown is built with textContent / setAttribute, never innerHTML.
//
// Layout is progressive: each provider is a row you can open, each meter inside it opens to show its
// reset rule, breakdown and manual-entry fields. Providers with no usage found sort to the bottom, closed.

const DAY = 864e5;
const MANUAL_KEY = 'quota-board-manual-v1';   // static mode: manual readings live in this browser only
const OPEN_KEY = 'quota-board-open-v1';       // which rows and sections this browser has opened or closed
const MODE = (() => { try { return JSON.parse(document.getElementById('qb-mode').textContent).mode; } catch { return 'static'; } })();
const RANK = { locked: 4, tight: 3, spend: 2, ok: 1, unset: 0 };

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
const caret = () => el('span', { class: 'caret', 'aria-hidden': 'true' });
function toLocalInput(t) {
  if (!t) return '';
  const d = new Date(t), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Open/closed state: the default comes from the data; a click in this browser overrides it.
let openPrefs = {};
try { openPrefs = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}'); } catch { /* storage blocked */ }
function remember(d, id, byDefault) {
  d.open = id in openPrefs ? openPrefs[id] : byDefault;
  d.firstElementChild.addEventListener('click', () => {
    openPrefs[id] = !d.open;   // the click hasn't toggled it yet
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(openPrefs)); } catch { /* storage blocked */ }
  });
  return d;
}
function fold(id, cls, byDefault, summaryKids, bodyKids) {
  return remember(el('details', { class: cls }, el('summary', null, caret(), summaryKids), bodyKids), id, byDefault);
}

// ---------- providers and meters ----------
/** A provider "has usage" when its collector answered or the user typed in a reading. */
function hasUsage(p) {
  const c = planUsage(p.id);
  return (c && c.status === 'ok') || p.meters.some(m => manual[m.id]);
}

function missingReason(c) {
  if (!c || c.status === 'manual') return { tag: 'No reading', text: 'Nothing reads this plan automatically. Open a meter to type in a reading from the provider\'s usage page.' };
  if (c.status === 'not-configured') return { tag: 'Not set up', text: c.hint || c.error || 'Not set up.' };
  return { tag: 'Failed', text: 'Couldn\'t read usage: ' + (c.error || 'unknown error') };
}

function meterRow(m) {
  const used = el('input', { type: 'number', min: '0', max: '100', step: '1', id: rowId(m, 'u'), 'aria-label': `${m.label} percent used`, placeholder: '—' });
  const reset = el('input', { type: 'datetime-local', id: rowId(m, 'r'), 'aria-label': `${m.label} resets at` });
  used.addEventListener('input', () => onEdit(m));
  reset.addEventListener('change', () => onEdit(m));
  const d = fold('m:' + key(m.plan, m.id), 'meter', false,
    [el('span', { class: 'mlabel' }, el('span', { text: m.label })),
      el('div', { class: 'bar', role: 'img' }, el('div', { class: 'fill' }), el('div', { class: 'pace', hidden: true })),
      el('span', { class: 'pct' }),
      el('span', { class: 'rin' }),
      el('span', { class: 'chip' })],
    el('div', { class: 'mbody' },
      m.hint ? el('p', { text: m.hint }) : null,
      el('p', { class: 'mnote' }),
      el('div', { class: 'bd', hidden: true }),
      el('p', { text: 'Reset rule: ' + m.reset.rule }),
      el('div', { class: 'mctrl' }, el('label', null, 'Enter a reading:', used, '% used'), el('label', null, 'resets', reset)),
      el('p', { class: 'msrc' })));
  d.id = rowId(m, 'm');
  // The summary is a grid, so the caret sits inside the label cell.
  const s = d.firstElementChild;
  s.querySelector('.mlabel').prepend(s.firstElementChild);
  return d;
}

function providerRow(p, found) {
  const c = planUsage(p.id);
  const listPrice = p.price.listAmount != null ? ` (list ${money({ ...p.price, amount: p.price.listAmount })})` : '';
  const sub = `${p.vendor} · ${money(p.price)}${listPrice}`;
  const glance = el('span', { class: 'glance' });
  if (p.status !== 'active') glance.append(el('span', { class: 'tag', text: p.status }));
  let body;
  if (found) {
    glance.append(el('span', { class: 'src', id: 'ps-' + p.id }), el('span', { class: 'chip', id: 'pw-' + p.id }));
    body = el('div', { class: 'prov-body' },
      el('div', { class: 'pwarn', id: 'tw-' + p.id, hidden: true }),
      c && c.note ? el('div', { class: 'phint', text: c.note }) : null,
      c && c.unmapped && c.unmapped.length ? el('div', { class: 'phint', text: `${c.unmapped.length} limit(s) the provider reports aren't on this board yet.` }) : null,
      el('div', null, p.meters.map(pm => meterRow(METER[key(p.id, pm.id)]))));
  } else {
    const why = missingReason(c);
    glance.append(el('span', { class: 'chip st-unset', text: why.tag }));
    body = el('div', { class: 'prov-body' },
      el('div', { class: 'phint', text: why.text }),
      el('div', null, p.meters.map(pm => meterRow(METER[key(p.id, pm.id)]))));
  }
  return fold('p:' + p.id, 'prov' + (found ? '' : ' missing'), found,
    [el('span', { class: 'pname' }, el('b', { text: p.name }), el('span', { text: sub })), glance], body);
}

function buildPlans() {
  const root = $('plans'), missing = $('missing');
  root.textContent = '';
  missing.textContent = '';
  if (!DATA.plans.length) {
    root.append(el('div', { class: 'phint', style: 'padding:16px' , text: 'No plans on your board yet. Sign in to Claude Code, Codex, Cursor or the Antigravity CLI and run quota-board again, or run "quota-board plans" and then "quota-board use <plan-id>".' }));
    $('missing-label').hidden = true;
    return;
  }
  const withUsage = DATA.plans.filter(hasUsage), without = DATA.plans.filter(p => !hasUsage(p));
  for (const p of withUsage) root.append(providerRow(p, true));
  for (const p of without) missing.append(providerRow(p, false));
  $('missing-label').hidden = !without.length || !withUsage.length;
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
  if (ev.expired) note = 'The window has probably reset since this reading. ';
  else if (ev.rolled) note = 'Reset since this reading, so it counts as 0%. ';
  else if (ev.remaining == null && ev.source !== 'live') note += m.period === '5h' ? 'Set the reset time once a window starts. ' : 'Set the reset time once; it repeats. ';
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

function paintMeters() {
  let soonest = null;
  const worst = {};
  for (const m of Object.values(METER)) {
    const ev = evalMeter(m), row = $(rowId(m, 'm'));
    if (!row) continue;
    row.dataset.st = ev.status;
    row.querySelector('.fill').style.width = (ev.used == null ? 0 : ev.used) + '%';
    const pace = row.querySelector('.pace');
    pace.hidden = ev.elapsed == null || ev.used == null;
    if (!pace.hidden) pace.style.left = `calc(${(ev.elapsed * 100).toFixed(1)}% - 1px)`;
    row.querySelector('.bar').setAttribute('aria-label', ev.used == null ? 'no reading' : ev.used + '% used');
    row.querySelector('.pct').textContent = ev.used == null ? '—' : Math.round(ev.used) + '%';
    row.querySelector('.rin').textContent = ev.remaining != null ? 'resets ' + fmtDur(ev.remaining) : ev.expired ? 'reset since' : '';
    const chip = row.querySelector('.chip');
    chip.className = 'chip st-' + ev.status;
    chip.textContent = STATUS_LABEL[ev.status];
    row.querySelector('.mnote').textContent = meterNote(m, ev);
    row.querySelector('.msrc').textContent = ev.source ? `${cap(ev.source)} reading, ${ago(ev.updatedAt)}.` : '';
    paintBreakdown(row.querySelector('.bd'), ev.breakdown);
    if (ev.remaining != null && (!soonest || ev.remaining < soonest.ms)) soonest = { ms: ev.remaining, label: m.label };
    if (!worst[m.plan] || RANK[ev.status] > RANK[worst[m.plan].status]) worst[m.plan] = { status: ev.status, label: m.label };
  }
  $('next-reset').textContent = soonest ? fmtDur(soonest.ms) : '—';
  $('next-reset').title = soonest ? soonest.label : '';
  for (const p of DATA.plans) {
    const c = planUsage(p.id), tw = $('tw-' + p.id), pw = $('pw-' + p.id), ps = $('ps-' + p.id);
    if (pw && worst[p.id]) {
      const w = worst[p.id];
      pw.className = 'chip st-' + w.status;
      pw.textContent = STATUS_LABEL[w.status];
      pw.title = w.status === 'ok' ? 'Every limit is on pace' : `${w.label}: ${STATUS_LABEL[w.status]}`;
    }
    if (ps) ps.textContent = c && c.status === 'ok' ? `${c.freshness === 'cached' ? 'Cached' : 'Live'} · ${ago(Date.parse(c.collectedAt || USAGE.collectedAt))}` : 'Manual';
    if (tw) {
      const unconfirmed = c && c.reason && c.reason.includes('unconfirmed') ? (c.tierNote || 'Tier unconfirmed.') : '';
      const warn = c && (c.tierMismatch || unconfirmed);
      tw.hidden = !warn;
      tw.textContent = warn || '';
    }
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
    setSync('Saved in this browser only. Use "quota-board set" to keep it in your config.');
  } catch {
    setSync('Couldn\'t save in this browser');
  }
}
const setSync = (t, title) => { $('sync').textContent = t; $('sync').title = title || ''; };

// ---------- notes ----------
function paintNotes(state) {
  const items = (state.unknown || []).map(x => `${x.collector} reports tier "${x.tier}", which no plan file matches. Run "quota-board use <plan-id>" to pick yours and "quota-board report" so it gets added.`);
  const box = $('notes');
  box.textContent = '';
  box.hidden = !items.length;
  if (!items.length) return;
  box.append(el('strong', { text: 'Needs attention' }), el('ul', null, items.map(t => el('li', { text: t }))));
}

// ---------- spendable resets ----------
function paintResets() {
  const root = $('resets');
  root.textContent = '';
  const items = DATA.plans.flatMap(p => (p.resets || []).map(r => ({ p, r })));
  let held = 0;
  if (!items.length) root.append(el('p', { class: 'small muted', text: 'None of your plans has a spendable reset right now.' }));
  for (const { p, r } of items) {
    const c = planUsage(p.id), live = c && c.resets && c.resets[r.id];
    let count = '?', sub = (r.count && r.count.rule) || null;
    let exp = r.expires ? Date.parse(r.expires) : null;
    if (live && live.available != null) {
      count = `${live.available} held`;
      held += live.available;
      sub = live.usableNow != null ? `${live.usableNow} usable right now` : null;
      if (live.nextExpiry) exp = Date.parse(live.nextExpiry);   // the provider reports when the next one expires
    } else if (r.count && r.count.min != null) {
      count = r.count.min === r.count.max ? String(r.count.min) : `${r.count.min}–${r.count.max}`;
    }
    const short = !exp ? 'no expiry given' : exp > Date.now() ? `${live && live.nextExpiry ? 'next expires' : 'expires'} in ${fmtDur(exp - Date.now())}` : 'expired';
    const full = !exp ? 'No expiry date published.' : exp > Date.now() ? `${live && live.nextExpiry ? 'The next one expires' : 'Expires'} ${fmtDate(exp)}.` : 'Expired.';
    root.append(fold('r:' + p.id + '/' + r.id, 'rcard', false,
      [el('span', { class: 'rtitle' }, el('b', { text: r.label }), el('span', { text: p.name })),
        el('span', { class: 'count' }, count, el('small', { text: short }))],
      el('div', { class: 'rbody' },
        sub ? el('p', { class: 'muted', text: sub }) : null,
        el('p', { text: full }),
        el('p', { text: 'How: ' + r.howTo }),
        el('ul', null, (r.stipulations || []).map(s => el('li', { text: s }))))));
  }
  $('resets-count').textContent = !items.length ? 'none' : held ? `${held} held` : `${items.length} on your plans`;
}

// ---------- timeline ----------
const SHOW_EVENTS = 4;
function eventRow(e, now) {
  const t = e.date ? new Date(e.date + 'T23:59:00') : null;
  const past = t && t < now, days = t ? Math.ceil((t - now) / DAY) : null, src = safeUrl(e.source);
  const rel = !t ? 'no end date given' : past ? 'ended' : days <= 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`;
  return el('div', { class: 'ev' + (past ? ' past' : '') + (e.unverified ? ' unv' : '') },
    el('div', { class: 'when' }, el('b', { text: t ? fmtDate(t) : 'Now' }), rel),
    el('div', { class: 'what' },
      el('div', { class: 'who', text: e.who + (e.unverified ? ' · unconfirmed (third-party report)' : '') }),
      el('div', null, e.what, src ? ' ' : null, src ? el('a', { href: src, target: '_blank', rel: 'noopener', text: 'Source' }) : null)));
}

function buildTimeline() {
  const root = $('timeline');
  root.textContent = '';
  const now = Date.now();
  const when = e => (e.date ? Date.parse(e.date) : now);
  const evs = DATA.plans.flatMap(p => (p.events || []).map(e => ({ ...e, who: p.vendor }))).sort((a, b) => when(a) - when(b));
  const isPast = e => e.date && new Date(e.date + 'T23:59:00') < now;
  const upcoming = evs.filter(e => !isPast(e)), past = evs.filter(isPast);
  $('dates-count').textContent = upcoming.length ? `${upcoming.length} coming up` : 'nothing coming up';
  if (!evs.length) { root.append(el('p', { class: 'small muted', text: 'Nothing dated for your plans.' })); return; }
  root.append(el('div', { class: 'list' }, upcoming.slice(0, SHOW_EVENTS).map(e => eventRow(e, now))));
  const later = upcoming.slice(SHOW_EVENTS);
  if (later.length) root.append(fold('d:later', 'more', false, `${later.length} more coming up`, el('div', { class: 'list' }, later.map(e => eventRow(e, now)))));
  if (past.length) root.append(fold('d:past', 'more', false, `${past.length} ended`, el('div', { class: 'list' }, past.reverse().map(e => eventRow(e, now)))));
}

// ---------- plan reference ----------
const list = (title, items) => (items && items.length
  ? el('div', null, el('h4', { text: title }), el('ul', null, items.map(x => (typeof x === 'string' ? el('li', { text: x }) : x))))
  : null);

function modelTable(p) {
  const t = p.modelTable, cols = t.columns || [];
  const cell = (v, i) => {
    if (!i || typeof v !== 'number') return String(v);
    return cols[i] && /cap|\$/i.test(cols[i]) ? '$' + v : v.toLocaleString();
  };
  return fold('t:' + p.id, 'tbl wide', false, t.title || p.name + ' models', el('div', { class: 'tbl-wrap' },
    t.note ? el('p', { class: 'small muted', style: 'margin-bottom:10px', text: t.note }) : null,
    el('table', null,
      el('thead', null, el('tr', null, cols.map((h, i) => el('th', { class: i ? 'num' : null, text: h })))),
      el('tbody', null,
        t.rows.map(r => el('tr', null, r.map((v, i) => el('td', { class: i ? 'num' : null, text: cell(v, i) })))),
        t.footer ? el('tr', null, el('td', { class: 'muted', colspan: String(cols.length), text: t.footer })) : null))));
}

function planCard(p) {
  const c = p.card || {}, age = (Date.now() - Date.parse(p.lastVerified)) / DAY, check = safeUrl(p.check.url);
  const resetItems = p.meters.map(m => el('li', null, el('b', { text: m.label + ': ' }), m.reset.rule,
    m.reset.stipulations && m.reset.stipulations.length ? el('ul', null, m.reset.stipulations.map(s => el('li', { text: s }))) : null));
  const stale = age > 45;
  return fold('c:' + p.id, 'pcard', false,
    [el('span', { class: 'pname' }, el('b', { text: p.name }), el('span', { text: c.alert || p.vendor })),
      stale ? el('span', { class: 'chip st-tight', text: 'Needs re-check' }) : null,
      p.status !== 'active' ? el('span', { class: 'tag', text: p.status }) : null,
      el('span', { class: 'price', text: money(p.price) })],
    el('div', { class: 'pcard-body' },
      c.alert ? el('div', { class: 'alert wide', text: c.alert }) : null,
      p.price.note ? el('p', { class: 'small muted wide', text: p.price.note }) : null,
      list('How the limits work', c.how),
      list('Resets', resetItems),
      list('Outside models and tools', c.ext),
      list('Quirks', c.quirks),
      p.overage ? el('div', null, el('h4', { text: 'When you hit the limit' }), el('p', { class: 'small', text: p.overage })) : null,
      p.modelTable && Array.isArray(p.modelTable.rows) ? modelTable(p) : null,
      el('div', { class: 'foot wide' },
        el('div', null, 'Check usage: ', check ? el('a', { href: check, target: '_blank', rel: 'noopener', text: p.check.label }) : p.check.label),
        el('div', null, 'Verified ' + fmtDate(p.lastVerified + 'T12:00:00')),
        el('div', { class: 'srcs' }, (p.sources || []).map(s => (safeUrl(s.url)
          ? el('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.label + (s.official ? '' : ' (3rd party)') })
          : null))))));
}

function buildCards() {
  const cards = $('cards');
  cards.textContent = '';
  for (const p of DATA.plans) cards.append(planCard(p));
  $('plans-count').textContent = `${DATA.plans.length} plan${DATA.plans.length === 1 ? '' : 's'}`;
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
  for (const id of ['sec-resets', 'sec-dates', 'sec-plans']) remember($(id), 's:' + id, false);
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
    const at = USAGE.collectedAt ? new Date(USAGE.collectedAt) : null;
    setSync(at ? `Snapshot from ${at.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Snapshot',
      'Run "quota-board" again to update it, or "quota-board serve" for live updates.');
  }
  setInterval(paint, 60000);
}

boot();
