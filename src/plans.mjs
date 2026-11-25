// Loads and validates plans/*.json. Used by the CLI and by tools/check.mjs (CI).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT } from './meta.mjs';

export const PERIODS = ['5h', 'day', 'week', 'month'];
export const RESET_TYPES = ['rolling-from-first-use', 'rolling-weekly', 'rolling-5h-until-weekly', 'fixed-weekly-account', 'fixed-weekly-utc', 'billing-cycle', 'paid-period', 'calendar-month', 'fixed-30d', 'daily', 'unknown'];
export const STATUSES = ['active', 'legacy', 'discontinued'];
const TOP_KEYS = ['$schema', 'id', 'name', 'vendor', 'status', 'price', 'lastVerified', 'detect', 'check', 'meters', 'resets', 'overage', 'card', 'modelTable', 'events', 'sources'];
export const STALE_DAYS = 45;

const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const isStr = s => typeof s === 'string' && s.trim().length > 0;
const isHttps = s => typeof s === 'string' && s.startsWith('https://');

export function loadAll(root = APP_ROOT) {
  const errors = [], warnings = [];
  const err = (f, m) => errors.push(`${f}: ${m}`);
  const warn = (f, m) => warnings.push(`${f}: ${m}`);
  const load = path => { try { return JSON.parse(readFileSync(join(root, path), 'utf8')); } catch (e) { err(path, `invalid JSON: ${e.message}`); return null; } };

  const provDir = join(root, 'collectors', 'providers');
  const collectors = new Set(existsSync(provDir) ? readdirSync(provDir).filter(f => f.endsWith('.mjs')).map(f => f.replace(/\.mjs$/, '')) : []);

  const plans = [];
  for (const file of readdirSync(join(root, 'plans')).filter(f => f.endsWith('.json')).sort()) {
    const f = `plans/${file}`;
    const p = load(f);
    if (!p) continue;
    for (const k of Object.keys(p)) if (!TOP_KEYS.includes(k)) err(f, `unknown key "${k}"`);
    if (p.id !== file.replace(/\.json$/, '')) err(f, `id "${p.id}" must match the file name`);
    for (const k of ['name', 'vendor']) if (!isStr(p[k])) err(f, `${k} is required`);
    if (!STATUSES.includes(p.status)) err(f, `status must be one of ${STATUSES.join(', ')}`);
    if (!p.price || typeof p.price.amount !== 'number' || !isStr(p.price.currency) || !['month', 'year'].includes(p.price.period)) err(f, 'price needs amount, currency, period');
    if (!isDate(p.lastVerified)) err(f, 'lastVerified must be YYYY-MM-DD');
    else {
      const age = (Date.now() - Date.parse(p.lastVerified)) / 864e5;
      if (age > STALE_DAYS) warn(f, `lastVerified is ${Math.floor(age)} days old. Re-check the sources.`);
    }
    if (p.detect) {
      if (!collectors.has(p.detect.collector)) err(f, `detect.collector "${p.detect.collector}" has no collectors/providers/${p.detect.collector}.mjs`);
      if (p.detect.tiers && !Array.isArray(p.detect.tiers)) err(f, 'detect.tiers must be an array of strings');
      if (p.detect.tierPattern) { try { new RegExp(p.detect.tierPattern, 'i'); } catch { err(f, 'detect.tierPattern is not a valid regex'); } }
      if (!(p.detect.tiers && p.detect.tiers.length) && !p.detect.tierPattern) warn(f, 'detect has no tiers or tierPattern, so it will never be auto-detected');
    }
    if (!p.check || !isStr(p.check.label) || !isHttps(p.check.url)) err(f, 'check needs label and an https url');
    const meterIds = new Set();
    if (!Array.isArray(p.meters)) err(f, 'meters must be an array');
    (p.meters || []).forEach((m, i) => {
      const at = `meters[${i}]`;
      if (!/^[a-z0-9-]+$/.test(m.id || '')) err(f, `${at}.id must be kebab-case`);
      else if (meterIds.has(m.id)) err(f, `${at}.id "${m.id}" is repeated`);
      else meterIds.add(m.id);
      if (!isStr(m.label)) err(f, `${at}.label is required`);
      if (!PERIODS.includes(m.period)) err(f, `${at}.period must be one of ${PERIODS.join(', ')}`);
      if (!m.reset || !RESET_TYPES.includes(m.reset.type)) err(f, `${at}.reset.type must be one of ${RESET_TYPES.join(', ')}`);
      if (!m.reset || !isStr(m.reset.rule)) err(f, `${at}.reset.rule is required`);
      if (m.reset && m.reset.stipulations && !Array.isArray(m.reset.stipulations)) err(f, `${at}.reset.stipulations must be an array`);
    });
    (p.resets || []).forEach((r, i) => {
      if (!isStr(r.id) || !isStr(r.label) || !isStr(r.howTo)) err(f, `resets[${i}] needs id, label, howTo`);
      if (r.expires && isNaN(Date.parse(r.expires))) err(f, `resets[${i}].expires is not a date`);
      if (r.expires && Date.parse(r.expires) < Date.now()) warn(f, `resets[${i}] "${r.label}" has expired. Remove it.`);
    });
    if (!p.card || !Array.isArray(p.card.how) || !Array.isArray(p.card.ext) || !Array.isArray(p.card.quirks)) err(f, 'card needs how, ext, quirks arrays');
    (p.events || []).forEach((e, i) => {
      if (e.date !== null && !isDate(e.date)) err(f, `events[${i}].date must be YYYY-MM-DD or null`);
      if (!isStr(e.what)) err(f, `events[${i}].what is required`);
      if (e.unverified && !isHttps(e.source)) warn(f, `events[${i}] is unverified but has no source url`);
      if (e.date && Date.now() - Date.parse(e.date) > 30 * 864e5) warn(f, `events[${i}] ended over 30 days ago. Remove it.`);
    });
    if (!Array.isArray(p.sources) || !p.sources.length) err(f, 'sources needs at least one entry');
    (p.sources || []).forEach((s, i) => { if (!isStr(s.label) || !isHttps(s.url) || typeof s.official !== 'boolean') err(f, `sources[${i}] needs label, https url, official`); });
    plans.push(p);
  }
  return { plans, collectors: [...collectors], errors, warnings };
}

/** Does a plan's detect rule match a tier string a collector reported? */
export function tierMatches(plan, collectorId, tier) {
  const d = plan.detect;
  if (!d || d.collector !== collectorId || tier == null) return false;
  const t = String(tier).toLowerCase();
  if ((d.tiers || []).some(x => String(x).toLowerCase() === t)) return true;
  if (d.tierPattern && new RegExp(d.tierPattern, 'i').test(String(tier))) return true;
  return false;
}
