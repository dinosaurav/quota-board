// ChatGPT / Codex plan usage.
// 1. Direct: GET https://chatgpt.com/backend-api/wham/usage with Codex's saved ChatGPT login (undocumented; what
//    Codex /status uses). Fast, and needs only the login file.
// 2. Fallback: ask Codex itself through `codex app-server`, Codex's documented JSON-RPC protocol (the one its IDE
//    extension and desktop app use). Codex makes the request and refreshes its own login. It also reports when each
//    reset credit expires.
// 3. Last resort: the newest rate_limits event in ~/.codex/sessions logs, marked as cached.
import { join } from 'node:path';
import { platform, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { HOME, readJson, getJson, pct, iso, NotConfigured } from '../lib.mjs';
import { VERSION } from '../../src/meta.mjs';

export const id = 'codex';
export const source = 'Codex usage API (undocumented), falling back to `codex app-server`';

const WINDOW_TO_METER = { 18000: 'chatgpt-5h', 604800: 'chatgpt-week' };

function mapWindow(w, meters, unmapped, prefix, now = Date.now()) {
  if (!w) return;
  const secs = w.limit_window_seconds || (w.window_minutes ? w.window_minutes * 60 : null);
  const reading = { used: pct(w.used_percent), resetAt: iso(w.reset_at || w.resets_at || (w.reset_after_seconds != null ? now + w.reset_after_seconds * 1000 : null)), windowSeconds: secs };
  const meter = prefix ? null : (WINDOW_TO_METER[secs] || (secs >= 28 * 86400 ? 'chatgpt-month' : null));
  if (meter) meters[meter] = reading; else unmapped.push({ key: `${prefix || 'window'}:${secs}s`, ...reading });
}

async function direct(home) {
  const auth = readJson(join(home, 'auth.json'));
  const t = auth && auth.tokens;
  if (!t || !t.access_token) throw new NotConfigured('No Codex ChatGPT login found', 'Install Codex, run `codex login`, and choose "Sign in with ChatGPT".');
  const j = await getJson('https://chatgpt.com/backend-api/wham/usage', {
    headers: { Authorization: `Bearer ${t.access_token}`, 'ChatGPT-Account-Id': t.account_id || '', originator: 'codex_cli_rs' },
    authHint: 'Run any Codex command so it refreshes the login, then run again.'
  });
  return parse(j);
}

export async function collect() {
  const home = process.env.CODEX_HOME || join(HOME, '.codex');
  // QUOTA_BOARD_DIRECT=0: never open Codex's login file or session logs; only ask Codex itself.
  const off = process.env.QUOTA_BOARD_DIRECT === '0';
  let first;
  try {
    if (off) throw new NotConfigured('direct checks are off (QUOTA_BOARD_DIRECT=0)', 'Install Codex and sign in with ChatGPT.');
    return await direct(home);
  } catch (e) { first = e; }
  let second;
  try {
    const r = parseAppServer(await appServerRateLimits());
    return { ...r, note: `Read with codex app-server (${first.message})` };
  } catch (e) { second = e; }
  const rl = off ? null : latestSessionLimits(join(home, 'sessions'));
  if (rl) {
    const meters = {}, unmapped = [];
    mapWindow(rl.primary, meters, unmapped); mapWindow(rl.secondary, meters, unmapped);
    return { detectedTier: rl.plan_type || null, meters, unmapped, resets: {}, extras: {}, freshness: 'cached', note: `Usage API failed (${first.message}); used the newest Codex session log` };
  }
  if (second.code !== 'ENOENT') first.message += `; codex app-server: ${second.message}`;
  throw first;
}

/** Where the codex binary is: CODEX_PATH, the desktop app's bundled copy, or plain `codex` on PATH. */
export function findCodex() {
  if (process.env.CODEX_PATH) return process.env.CODEX_PATH;
  const p = platform();
  const bundled = [];
  if (p === 'win32' && process.env.LOCALAPPDATA) {
    const dir = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    if (existsSync(dir)) for (const n of readdirSync(dir)) bundled.push(join(dir, n, 'codex.exe'));
  }
  if (p === 'darwin') bundled.push('/Applications/Codex.app/Contents/Resources/codex', join(HOME, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'));
  const found = bundled.filter(f => existsSync(f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0] || 'codex';
}

/**
 * Talk JSON-RPC to `codex app-server` over stdio: initialize, then account/rateLimits/read. Only the rate-limit
 * result is used. Rejects with code 'ENOENT' when Codex isn't installed.
 */
export function appServerRateLimits({ timeout = 30000 } = {}) {
  const cmd = findCodex();
  const bare = !/[\\/]/.test(cmd);
  const winShell = bare && platform() === 'win32';   // a bare name on Windows may be an npm .cmd shim
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, cwd: tmpdir(), shell: winShell });
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); fn(v); };
    const timer = setTimeout(() => done(reject, new Error(`no answer within ${timeout / 1000}s`)), timeout);
    const send = o => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* exited */ } };
    child.on('error', e => done(reject, e));
    child.on('exit', code => {
      const e = new Error(winShell && code ? 'codex not found' : `codex app-server exited (${code})`);
      if (winShell && code) e.code = 'ENOENT';
      done(reject, e);
    });
    let buf = '';
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 0) { send({ method: 'initialized' }); send({ method: 'account/rateLimits/read', id: 1 }); }
        else if (msg.id === 1) msg.error ? done(reject, new Error(msg.error.message || 'rateLimits/read failed')) : done(resolve, msg.result);
      }
    });
    send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'quota-board', title: 'quota-board', version: VERSION } } });
  });
}

/** Pure: `account/rateLimits/read` result -> collector result. Tested against test/fixtures/codex-app-server.json. */
export function parseAppServer(r) {
  const meters = {}, unmapped = [];
  const byId = r.rateLimitsByLimitId || (r.rateLimits ? { [r.rateLimits.limitId || 'codex']: r.rateLimits } : {});
  let tier = null;
  for (const [limitId, l] of Object.entries(byId)) {
    tier = tier || l.planType || null;
    const main = limitId === 'codex';
    for (const w of [l.primary, l.secondary]) {
      if (w) mapWindow({ used_percent: w.usedPercent, window_minutes: w.windowDurationMins, reset_at: w.resetsAt }, meters, unmapped, main ? null : (l.limitName || limitId));
    }
    if (main && l.rateLimitReachedType) for (const m of Object.values(meters)) m.note = 'Limit reached';
  }
  const rc = r.rateLimitResetCredits;
  const avail = rc && (rc.credits || []).filter(c => c.status === 'available');
  const next = avail && avail.map(c => c.expiresAt).filter(Boolean).sort((a, b) => a - b)[0];
  const c = (r.rateLimits && r.rateLimits.credits) || {};
  return {
    detectedTier: tier,
    meters, unmapped,
    resets: rc ? { 'chatgpt-limit-reset': { available: rc.availableCount ?? (avail ? avail.length : null), usableNow: null, nextExpiry: iso(next) } } : {},
    extras: { credits: c.unlimited ? 'Unlimited' : (c.balance != null ? `Balance ${c.balance}` : null) }
  };
}

/** Pure: API response -> collector result. Tested against test/fixtures/codex-usage.json. */
export function parse(j, now = Date.now()) {
  const meters = {}, unmapped = [];
  const rl = j.rate_limit || {};
  mapWindow(rl.primary_window, meters, unmapped, null, now);
  mapWindow(rl.secondary_window, meters, unmapped, null, now);
  if (j.code_review_rate_limit) {
    mapWindow(j.code_review_rate_limit.primary_window, meters, unmapped, 'code-review', now);
    mapWindow(j.code_review_rate_limit.secondary_window, meters, unmapped, 'code-review', now);
  }
  for (const a of j.additional_rate_limits || []) mapWindow(a.primary_window || a, meters, unmapped, a.limit_name || a.limit_id || 'additional', now);
  if (rl.limit_reached) for (const m of Object.values(meters)) m.note = 'Limit reached';
  const rc = j.rate_limit_reset_credits, c = j.credits || {};
  return {
    detectedTier: j.plan_type || null,
    meters, unmapped,
    resets: rc ? { 'chatgpt-limit-reset': { available: rc.available_count ?? null, usableNow: rc.applicable_available_count ?? null } } : {},
    extras: { credits: c.unlimited ? 'Unlimited' : (c.balance != null ? `Balance ${c.balance}` : null) }
  };
}

function latestSessionLimits(dir) {
  if (!existsSync(dir)) return null;
  const files = [];
  const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p); if (s.isDirectory()) walk(p); else if (n.endsWith('.jsonl')) files.push([s.mtimeMs, p]); } };
  walk(dir);
  const find = o => { if (!o || typeof o !== 'object') return null; if (o.rate_limits) return o.rate_limits; for (const v of Object.values(o)) { const r = find(v); if (r) return r; } return null; };
  for (const [, p] of files.sort((a, b) => b[0] - a[0]).slice(0, 20)) {
    for (const line of readFileSync(p, 'utf8').split('\n').reverse()) {
      if (!line.includes('"rate_limits"')) continue;
      try { const rl = find(JSON.parse(line)); if (rl && (rl.primary || rl.secondary)) return rl; } catch { /* partial line */ }
    }
  }
  return null;
}
