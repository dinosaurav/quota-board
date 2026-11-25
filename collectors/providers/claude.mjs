// Claude subscription usage.
// 1. Direct: GET https://api.anthropic.com/api/oauth/usage with Claude Code's saved login (undocumented; it's what
//    Claude Code's /usage screen calls). Fast and structured.
// 2. Fallback, when there's no saved login, it has expired, or the request fails: ask Claude Code itself.
//    `claude -p /usage` prints the same numbers without sending a prompt (num_turns 0), and
//    `claude auth status --json` reports the plan tier. Claude Code refreshes its own login, so this also covers
//    the common case of a login that expired because Claude Code hasn't been opened for a few hours.
import { join } from 'node:path';
import { platform } from 'node:os';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { HOME, readJson, getJson, runTool, pct, iso, NotConfigured } from '../lib.mjs';
import { DATA_DIR, writePrivate } from '../../src/meta.mjs';

export const id = 'claude';
export const source = 'Claude usage API (undocumented), falling back to `claude -p /usage`';

// If Claude Code ever stops handling /usage in print mode, it would send it to the model as a prompt and spend
// quota. When that's detected once, this file stops the fallback until the user deletes it.
const CLI_BLOCK = join(DATA_DIR, 'claude-cli-fallback-off');

function readLogin() {
  if (process.env.CLAUDE_OAUTH_TOKEN) return { accessToken: process.env.CLAUDE_OAUTH_TOKEN };
  const dir = process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude');
  const creds = readJson(join(dir, '.credentials.json'));
  if (creds && creds.claudeAiOauth) return creds.claudeAiOauth;
  if (platform() === 'darwin') {
    // Claude Code on macOS keeps the login in Keychain. Read-only lookup.
    try {
      const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const j = JSON.parse(raw);
      if (j.claudeAiOauth) return j.claudeAiOauth;
    } catch { /* not found */ }
  }
  return null;
}

async function direct(o) {
  if (!o || !o.accessToken) throw new NotConfigured('No Claude Code login found', 'Install Claude Code, run `claude`, and sign in with your Claude account.');
  if (o.expiresAt && o.expiresAt < Date.now()) throw new NotConfigured('Claude Code login has expired', 'Open Claude Code once so it refreshes the login, then run again.');
  const j = await getJson('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${o.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
    authHint: 'Open Claude Code once so it refreshes the login, then run again.'
  });
  return { ...parse(j), detectedTier: o.rateLimitTier || o.subscriptionType || null, via: 'api' };
}

async function viaCli(fallbackTier) {
  if (existsSync(CLI_BLOCK)) throw new Error(`the Claude Code fallback is off (delete ${CLI_BLOCK} to turn it back on)`);
  const out = await runTool('claude', ['-p', '/usage', '--output-format', 'json'], { timeout: 90000 });
  let j;
  try { j = JSON.parse(out); } catch { throw new Error('`claude -p /usage` returned something other than JSON'); }
  if (j.num_turns > 0 || j.total_cost_usd > 0) {
    writePrivate(CLI_BLOCK, `Claude Code sent /usage to the model on ${new Date().toISOString()}. Delete this file to try again.\n`);
    throw new Error('Claude Code sent /usage to the model instead of running it, which used one turn. The fallback is now off.');
  }
  const r = parseUsageText(String(j.result || ''));
  if (!Object.keys(r.meters).length) throw new Error('`claude -p /usage` printed no usage lines quota-board recognises');
  let tier = fallbackTier;
  try { tier = JSON.parse(await runTool('claude', ['auth', 'status', '--json'], { timeout: 30000 })).planTier || tier; } catch { /* tier stays unknown */ }
  return { ...r, detectedTier: tier, via: 'cli' };
}

export async function collect() {
  // QUOTA_BOARD_DIRECT=0: never open Claude Code's login file; only ask Claude Code itself.
  const off = process.env.QUOTA_BOARD_DIRECT === '0';
  const login = off ? null : readLogin();
  try {
    if (off) throw new NotConfigured('direct checks are off (QUOTA_BOARD_DIRECT=0)', 'Install Claude Code and sign in.');
    return await direct(login);
  } catch (first) {
    try {
      const r = await viaCli(login && (login.rateLimitTier || login.subscriptionType));
      return { ...r, note: `Read with Claude Code (${first.message})` };
    } catch (second) {
      if (second.code === 'ENOENT') throw first;       // Claude Code isn't installed: report the original problem
      first.message += `; Claude Code fallback: ${second.message}`;
      throw first;
    }
  }
}

/** Pure: API response -> collector result (minus tier). Tested against test/fixtures/claude-usage.json. */
export function parse(j) {
  const meters = {}, unmapped = [];
  if (j.five_hour) meters['claude-5h'] = { used: pct(j.five_hour.utilization), resetAt: iso(j.five_hour.resets_at), windowSeconds: 18000 };
  if (j.seven_day) {
    meters['claude-week'] = { used: pct(j.seven_day.utilization), resetAt: iso(j.seven_day.resets_at), windowSeconds: 604800 };
    const rows = j.seven_day_breakdown && j.seven_day_breakdown.rows;
    if (Array.isArray(rows)) meters['claude-week'].breakdown = rows.filter(r => r.percent > 0).map(r => ({ label: r.display_name, share: pct(r.percent) }));
  }
  (j.limits || []).forEach((l, idx) => {
    const model = l.scope && l.scope.model && l.scope.model.display_name;
    if (l.kind === 'weekly_scoped' && model) {
      const key = modelMeter(model);
      meters[key] = { used: pct(l.percent), resetAt: iso(l.resets_at), windowSeconds: 604800 };
      const share = (j.weekly_scoped_shares || []).find(s => s.limit_index === idx);
      if (share) meters[key].note = `${share.used_percent_of_weekly}% of weekly used on ${model}, of ${share.allowance_percent_of_weekly}% allowed`;
    } else if (!['session', 'weekly_all'].includes(l.kind)) {
      unmapped.push({ key: `${l.kind}${model ? ':' + model : ''}`, used: pct(l.percent), resetAt: iso(l.resets_at) });
    }
  });
  for (const [k, v] of Object.entries(j)) {
    if (v && typeof v === 'object' && 'utilization' in v && !['five_hour', 'seven_day', 'extra_usage'].includes(k)) unmapped.push({ key: k, used: pct(v.utilization), resetAt: iso(v.resets_at) });
  }
  const x = j.extra_usage || {};
  return {
    meters, unmapped, resets: {},
    extras: { usageCredits: x.is_enabled == null ? null : (x.is_enabled ? 'On' : 'Off') }
  };
}

const modelMeter = model => `claude-${model.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;   // "Fable" -> claude-fable

/**
 * Pure: the text `claude -p /usage` prints -> collector result (minus tier). Lines look like:
 *   Current session: 26% used · resets Nov 24, 9:29pm (America/New_York)
 *   Current week (all models): 10% used · resets Nov 29, 5:59pm (America/New_York)
 *   Current week (Fable): 6% used · resets Nov 29, 5:59pm (America/New_York)
 * Tested against test/fixtures/claude-usage-cli.txt.
 */
export function parseUsageText(text, now = Date.now()) {
  const meters = {}, unmapped = [];
  const re = /^\s*Current (session|week \(([^)]+)\)):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*\S\s*resets\s+(.+?))?\s*$/gim;
  for (const m of text.matchAll(re)) {
    const [, kind, scope, used, when] = m;
    const resetAt = when ? parseResetText(when, now) : null;
    if (/^session$/i.test(kind)) meters['claude-5h'] = { used: pct(used), resetAt, windowSeconds: 18000 };
    else if (/^all models$/i.test(scope)) meters['claude-week'] = { used: pct(used), resetAt, windowSeconds: 604800 };
    else meters[modelMeter(scope)] = { used: pct(used), resetAt, windowSeconds: 604800 };
  }
  return { meters, unmapped, resets: {}, extras: {} };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Nov 24, 9:29pm (America/New_York)" or "9:29pm (America/New_York)" -> ISO string, or null. No year: picks the next one. */
export function parseResetText(s, now = Date.now()) {
  const m = s.match(/(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i);
  if (!m) return null;
  const [, mon, day, hh, mm = '0', ap, tz] = m;
  let hour = Number(hh) % 12 + (ap && ap.toLowerCase() === 'pm' ? 12 : 0);
  if (!ap) hour = Number(hh);
  const zone = tz && isZone(tz) ? tz : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nowParts = wall(now, zone);
  let month = mon ? MONTHS.indexOf(mon.toLowerCase()) : nowParts.month;
  if (month < 0) return null;
  const d = day ? Number(day) : nowParts.day;
  let year = nowParts.year;
  let t = zonedToUtc(year, month, d, hour, Number(mm), zone);
  if (t < now - 2 * 864e5) t = zonedToUtc(++year, month, d, hour, Number(mm), zone);   // "Jan 2" seen in late December
  return new Date(t).toISOString();
}

const isZone = z => { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; } };
function wall(t, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(t)).map(x => [x.type, Number(x.value)]));
  return { year: p.year, month: p.month - 1, day: p.day, hour: p.hour, minute: p.minute };
}
/** Wall-clock time in an IANA zone -> UTC milliseconds (two passes handle DST edges). */
function zonedToUtc(y, mo, d, h, mi, zone) {
  const target = Date.UTC(y, mo, d, h, mi);
  let t = target;
  for (let i = 0; i < 2; i++) { const w = wall(t, zone); t += target - Date.UTC(w.year, w.month, w.day, w.hour, w.minute); }
  return t;
}
