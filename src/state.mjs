// Turns plans + collector results + config into the board the renderers show.
import { tierMatches } from './plans.mjs';

/**
 * Picks which plans this user has.
 * Configured plans always show. Detected plans are added when a collector's tier matches a plan's detect rule.
 * Returns { selected: [{ plan, reason }], unknown: [{ collector, tier }] }.
 */
export function selectPlans(plans, results, cfg) {
  const byId = Object.fromEntries(plans.map(p => [p.id, p]));
  const chosen = new Map();
  for (const id of cfg.plans || []) if (byId[id]) chosen.set(id, 'configured');
  const unknown = [];
  if (cfg.autoDetect !== false) {
    for (const r of Object.values(results)) {
      if (r.status !== 'ok') continue;
      // If the user already picked a plan for this collector, trust that over detection.
      if ([...chosen.keys()].some(id => byId[id].detect && byId[id].detect.collector === r.collector)) continue;
      const match = plans.find(p => p.status !== 'discontinued' && tierMatches(p, r.collector, r.detectedTier))
        || plans.find(p => tierMatches(p, r.collector, r.detectedTier));
      if (match) chosen.set(match.id, r.tierConfidence === 'low' ? 'detected (unconfirmed)' : 'detected');
      else unknown.push({ collector: r.collector, tier: r.detectedTier ?? null });
    }
  }
  for (const id of cfg.hide || []) chosen.delete(id);
  return { selected: [...chosen].map(([id, reason]) => ({ plan: byId[id], reason })), unknown };
}

/** Usage entry per selected plan, in the shape the dashboard reads: usage.plans[planId]. */
export function usageFor(selected, results, collectedAt) {
  const plans = {};
  for (const { plan, reason } of selected) {
    const r = plan.detect && results[plan.detect.collector];
    if (!r) { plans[plan.id] = { status: 'manual', reason }; continue; }
    const known = new Set(plan.meters.map(m => m.id));
    const meters = {}, unmapped = [...(r.unmapped || [])];
    for (const [k, v] of Object.entries(r.meters || {})) {
      if (known.has(k)) meters[k] = v;
      else unmapped.push({ key: k, ...v });
    }
    const tierOk = r.status !== 'ok' || r.detectedTier == null || tierMatches(plan, r.collector, r.detectedTier);
    plans[plan.id] = {
      reason,
      collector: r.collector, source: r.source, status: r.status, collectedAt: r.collectedAt,
      error: r.error, hint: r.hint, freshness: r.freshness, detectedTier: r.detectedTier,
      tierMismatch: tierOk ? undefined : `This plan is set, but ${r.collector} reports "${r.detectedTier}"`,
      tierNote: r.tierNote,
      note: r.note,   // collector-level, e.g. "used the cache because the API failed"
      meters, resets: r.resets || {}, extras: r.extras || {}, unmapped
    };
  }
  return { collectedAt, plans };
}

/** Plan data for the dashboard: selected plans with any price override from config. */
export function boardFor(selected, cfg) {
  return {
    generatedAt: new Date().toISOString(),
    plans: selected.map(({ plan }) => {
      const o = cfg.prices && cfg.prices[plan.id];
      if (!o) return plan;
      return { ...plan, price: { ...plan.price, listAmount: plan.price.amount, amount: o.amount ?? plan.price.amount, note: o.note || plan.price.note } };
    })
  };
}

/** Everything a renderer needs. */
export function buildState({ plans }, results, cfg) {
  const collectedAt = new Date().toISOString();
  const { selected, unknown } = selectPlans(plans, results, cfg);
  return {
    board: boardFor(selected, cfg),
    usage: usageFor(selected, results, collectedAt),
    manual: cfg.manual || {},
    unknown,
    results
  };
}
