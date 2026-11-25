// Plain-terminal rendering. Colors only when stdout is a TTY and NO_COLOR is unset.
import { evaluate, fmtDur, STATUS_LABEL } from '../meter.mjs';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
export const dim = s => c('2', s), bold = s => c('1', s), red = s => c('31', s), green = s => c('32', s), yellow = s => c('33', s), magenta = s => c('35', s), cyan = s => c('36', s);
const STATUS_COLOR = { ok: green, tight: yellow, locked: red, spend: magenta, unset: dim };
const width = () => Math.max(60, Math.min(process.stdout.columns || 100, 120));
const pad = (s, n) => { s = String(s); const vis = s.replace(/\x1b\[[0-9;]*m/g, ''); return vis.length >= n ? s : s + ' '.repeat(n - vis.length); };
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function bar(used, status, n = 16) {
  if (used == null) return dim('·'.repeat(n));
  const filled = Math.round((used / 100) * n);
  return (STATUS_COLOR[status] || (x => x))('█'.repeat(filled)) + dim('░'.repeat(n - filled));
}
const money = p => `$${p.amount % 1 ? p.amount.toFixed(2) : p.amount}/${p.period === 'year' ? 'yr' : 'mo'}`;
const monthly = p => (p.price.period === 'year' ? p.price.amount / 12 : p.price.amount);

function sourceTag(u) {
  if (u.status === 'ok') return u.freshness === 'cached' ? yellow('cached') : green('live');
  if (u.status === 'not-configured') return yellow('not set up');
  if (u.status === 'error') return red('collector failed');
  return dim('manual');
}

function resetCount(r, live) {
  if (live && live.available != null) return `${live.available} held${live.usableNow != null ? `, ${live.usableNow} usable now` : ''}${live.nextExpiry ? `, next expires in ${fmtDur(Date.parse(live.nextExpiry) - Date.now())}` : ''}`;
  if (r.count && r.count.min != null) return r.count.min === r.count.max ? `${r.count.min}` : `${r.count.min}–${r.count.max}`;
  return '?';
}

export function renderStatus(state, { verbose = false } = {}) {
  const { board, usage, manual, unknown, results } = state;
  const out = [];
  const W = width();
  const labelW = Math.min(34, Math.max(18, ...board.plans.flatMap(p => p.meters.map(m => m.label.length))));
  const total = board.plans.reduce((s, p) => s + monthly(p), 0);
  out.push(`${bold('Quota Board')}  ${dim(`${board.plans.length} plan${board.plans.length === 1 ? '' : 's'} · $${Math.round(total)}/mo · ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`)}`);
  if (!board.plans.length) {
    out.push('', 'No plans found yet. Sign in to Claude Code, Codex, Cursor or the Antigravity CLI, or add a plan by hand:', `  ${cyan('quota-board plans')}        list every plan quota-board knows`, `  ${cyan('quota-board use <plan-id>')} add one to your board`);
  }

  for (const p of board.plans) {
    const u = usage.plans[p.id] || {};
    const listPrice = p.price.listAmount != null ? ` (list ${money({ ...p.price, amount: p.price.listAmount })})` : '';
    const statusTag = p.status !== 'active' ? '  ' + dim(`${p.status} plan`) : '';
    out.push('', `${bold(p.name)}  ${dim(`${p.vendor} · ${money(p.price)}${listPrice}`)}  ${sourceTag(u)}${statusTag}`);
    if (u.reason && u.reason.includes('unconfirmed')) out.push(`  ${yellow('!')} ${u.tierNote || 'Tier unconfirmed.'} Change it with ${cyan('quota-board use <plan-id>')}.`);
    if (u.tierMismatch) out.push(`  ${yellow('!')} ${u.tierMismatch}`);
    if (u.status === 'not-configured' && u.hint) out.push(`  ${dim(u.hint)}`);
    if (u.status === 'error') out.push(`  ${red(u.error || 'unknown error')}`);
    if (u.note) out.push(`  ${dim(u.note)}`);
    for (const m of p.meters) {
      const ev = evaluate(m, u, manual);
      const pctStr = ev.used == null ? dim('   —') : `${String(Math.round(ev.used)).padStart(3)}%`;
      const reset = ev.remaining != null ? `resets in ${fmtDur(ev.remaining)}` : ev.expired ? 'window reset' : '';
      const status = STATUS_COLOR[ev.status](STATUS_LABEL[ev.status]) + (ev.source === 'manual' ? dim(' (manual)') : '');
      out.push(`  ${pad(trunc(m.label, labelW), labelW)}  ${bar(ev.used, ev.status)} ${pctStr}  ${pad(dim(reset), 20)} ${status}`);
      if (verbose) {
        out.push(dim(`  ${' '.repeat(labelW)}  ${trunc(m.reset.rule, W - labelW - 6)}`));
        if (ev.note) out.push(dim(`  ${' '.repeat(labelW)}  ${trunc(ev.note, W - labelW - 6)}`));
        for (const b of (ev.breakdown || []).slice(0, 6)) out.push(dim(`  ${' '.repeat(labelW)}  · ${b.label}: ${b.share != null ? b.share + '% of use' : b.used + '% used'}`));
      }
    }
    for (const r of p.resets || []) {
      const exp = r.expires ? ` · expires in ${fmtDur(Date.parse(r.expires) - Date.now())}` : '';
      out.push(`  ${magenta('↺')} ${r.label}: ${resetCount(r, u.resets && u.resets[r.id])}${dim(exp)}`);
    }
    for (const [k, v] of Object.entries(u.extras || {})) if (v && verbose) out.push(dim(`  ${k}: ${v}`));
    if (u.unmapped && u.unmapped.length) out.push(`  ${yellow('+')} ${u.unmapped.length} limit(s) not in this plan file: ${dim(u.unmapped.map(x => x.key).join(', '))}. Run ${cyan('quota-board report')}.`);
  }

  // Upcoming dated events, next 21 days.
  const soon = board.plans.flatMap(p => (p.events || []).filter(e => e.date).map(e => ({ ...e, p, t: Date.parse(e.date + 'T23:59:00') })))
    .filter(e => e.t > Date.now() && e.t - Date.now() < 21 * 864e5).sort((a, b) => a.t - b.t);
  if (soon.length) {
    out.push('', bold('Coming up'));
    for (const e of soon) out.push(`  ${pad(new Date(e.t).toLocaleDateString([], { month: 'short', day: 'numeric' }), 7)} ${dim(e.p.vendor + ':')} ${trunc(e.what, W - 20)}${e.unverified ? dim(' (unconfirmed)') : ''}`);
  }

  const notes = [];
  for (const x of unknown) notes.push(`${x.collector} reports tier "${x.tier}", which no plan file matches. Pick yours with ${cyan('quota-board use')} and run ${cyan('quota-board report')} so it gets added.`);
  for (const r of Object.values(results || {})) if (r.status === 'not-configured' && verbose) notes.push(`${r.collector}: ${r.error}. ${dim(r.hint || '')}`);
  if (notes.length) { out.push('', bold('Notes')); notes.forEach(n => out.push(`  ${n}`)); }
  out.push('', dim(`More: quota-board -v · quota-board serve · quota-board help`));
  return out.join('\n');
}

export function renderPlans(all, selectedIds, query) {
  const q = (query || '').toLowerCase();
  const rows = all.filter(p => !q || `${p.id} ${p.name} ${p.vendor}`.toLowerCase().includes(q));
  const byVendor = {};
  rows.forEach(p => (byVendor[p.vendor] = byVendor[p.vendor] || []).push(p));
  const lines = [];
  for (const [v, ps] of Object.entries(byVendor).sort()) {
    lines.push(bold(v));
    for (const p of ps) lines.push(`  ${selectedIds.has(p.id) ? green('●') : dim('○')} ${pad(p.id, 28)} ${pad(p.name, 26)} ${dim(money(p.price) + (p.status !== 'active' ? ' · ' + p.status : '') + (p.detect ? ' · auto-detect' : ''))}`);
  }
  lines.push('', dim(`${rows.length} plan(s). ● on your board. Add with: quota-board use <plan-id>`));
  return lines.join('\n');
}
