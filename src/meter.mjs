// Meter evaluation: status, pace and reset roll-forward.
// This file is also inlined into the dashboard page (see src/render/html.mjs), so it must stay plain
// JavaScript with no imports and no Node APIs. `export` keywords are stripped for the browser.

const H = 3600e3, D = 24 * H;
export const PERIOD_MS = { '5h': 5 * H, day: D, week: 7 * D, month: 30.44 * D };
export const STATUS_LABEL = { ok: 'on pace', tight: 'ahead of pace', locked: 'out until reset', spend: 'use it or lose it', unset: 'no reading' };

/** A percentage clamped to 0-100, or null when there's no number. */
export const clampPct = v => {
  const n = Number(v);
  return v == null || v === '' || isNaN(n) ? null : Math.max(0, Math.min(100, n));
};

function nextMondayUTC(from) {
  const d = new Date(from);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return d.getTime();
}

/** Same day next month, clamped to the month's last day (Jan 31 -> Feb 28). */
function addMonth(t) {
  const d = new Date(t);
  const day = d.getDate();
  d.setMonth(d.getMonth() + 1);
  if (d.getDate() !== day) d.setDate(0);
  return d.getTime();
}

/** Newest of the live (collected) and manual reading for a meter. */
export function readingFor(meter, planUsage, manual) {
  const man = manual && manual[meter.id];
  const live = planUsage && planUsage.status === 'ok' && planUsage.meters && planUsage.meters[meter.id];
  const manAt = man && man.updatedAt ? Date.parse(man.updatedAt) : 0;
  const liveAt = live ? Date.parse(planUsage.collectedAt) || 0 : 0;
  if (live && liveAt >= manAt) {
    return {
      used: clampPct(live.used),
      resetAt: live.resetAt || null,
      updatedAt: liveAt,
      source: planUsage.freshness === 'cached' ? 'cached' : 'live',
      breakdown: Array.isArray(live.breakdown) ? live.breakdown : null,
      note: typeof live.note === 'string' ? live.note : null,
      windowSeconds: Number(live.windowSeconds) || null
    };
  }
  if (man) return { used: clampPct(man.used), resetAt: man.resetAt || null, updatedAt: manAt, source: 'manual' };
  return { used: null, resetAt: null, updatedAt: 0, source: null };
}

/**
 * Where a meter stands now. Weekly, monthly and daily resets roll forward on their own; a 5-hour window
 * whose reset has passed is marked expired. A reading taken before the current window started counts as 0.
 */
export function evaluate(meter, planUsage, manual, now = Date.now()) {
  const r = readingFor(meter, planUsage, manual);
  let used = r.used, reset = r.resetAt ? Date.parse(r.resetAt) : null, expired = false;
  if (!reset && meter.auto === 'monday-utc') reset = nextMondayUTC(now);
  if (!reset && meter.reset && meter.reset.type === 'calendar-month') {
    const d = new Date(now);
    reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  if (reset && reset <= now) {
    if (meter.period === 'week') while (reset <= now) reset += 7 * D;
    else if (meter.period === 'month') while (reset <= now) reset = addMonth(reset);
    else if (meter.period === 'day') while (reset <= now) reset += D;
    else expired = true;
  }
  const len = r.windowSeconds ? r.windowSeconds * 1000 : PERIOD_MS[meter.period];
  const rolled = !!(reset && !expired && r.updatedAt && r.updatedAt < reset - len);
  if ((rolled || expired) && used != null) used = 0;
  const remaining = reset && !expired ? reset - now : null;
  const elapsed = remaining != null ? Math.max(0, Math.min(1, 1 - remaining / len)) : null;

  let status = 'ok';
  if (used == null) status = 'unset';
  else if (used >= 100) status = 'locked';
  else if (elapsed != null && elapsed > 0.05 && used >= 40 && used / (elapsed * 100) > 1.2) status = 'tight';
  else if (meter.period !== '5h' && elapsed != null && elapsed > 0.65 && used < 50) status = 'spend';
  return { ...r, used, reset: expired ? null : reset, remaining, elapsed, status, rolled, expired };
}

/** 3d 4h / 2h 5m / 12m. Empty for null. */
export function fmtDur(ms) {
  if (ms == null) return '';
  ms = Math.max(0, ms);
  const d = Math.floor(ms / D), h = Math.floor(ms % D / H), m = Math.floor(ms % H / 60000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
