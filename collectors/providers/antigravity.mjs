// Google Antigravity quota.
// Primary: `agy -p /usage --output-format json`, the Antigravity CLI's own usage command. It runs locally and
// sends no prompt to a model (the result reports num_turns 0).
// Fallback: the last status the Antigravity app cached in its state.vscdb (protobuf), marked as cached.
// Tier: Antigravity's usage output has no tier, so the tier comes from that cache and is low-confidence.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { execFile } from 'node:child_process';
import { HOME, readStateDb, vscodeStateDb, pct, iso, pbDecode, pbString, NotConfigured } from '../lib.mjs';

export const id = 'antigravity';
export const source = 'Antigravity CLI /usage';

function findAgy() {
  if (process.env.AGY_PATH) return process.env.AGY_PATH;
  const local = platform() === 'win32' ? join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe') : join(HOME, '.local', 'bin', 'agy');
  return existsSync(local) ? local : 'agy';
}

function runAgy() {
  return new Promise((resolve, reject) => {
    execFile(findAgy(), ['-p', '/usage', '--output-format', 'json', '--print-timeout', '60s'],
      { cwd: tmpdir(), timeout: 90000, windowsHide: true, maxBuffer: 4 << 20, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
      (err, stdout) => {
        if (err && err.code === 'ENOENT') return reject(new NotConfigured('Antigravity CLI (agy) not found', 'Install the Antigravity CLI and sign in, or set AGY_PATH.'));
        if (err) return reject(new Error(`agy failed: ${err.message.split('\n')[0]}`));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('agy returned non-JSON')); }
      });
  });
}

export async function collect() {
  // QUOTA_BOARD_DIRECT=0: don't open the app's cached status; only ask agy (which doesn't report a tier).
  const off = process.env.QUOTA_BOARD_DIRECT === '0';
  const tier = off ? null : await cachedTier().catch(() => null);
  try {
    const j = await runAgy();
    const r = parse(j);
    return { ...r, detectedTier: tier, tierConfidence: 'low', tierNote: tier ? `Tier "${tier}" comes from the Antigravity app's cache and may be out of date.` : 'Antigravity doesn\'t report your tier. Pick your plan with `quota-board use`.' };
  } catch (e) {
    // agy missing or failing: fall back to the app's cached status, noting why.
    const cached = off ? null : await fromCache().catch(() => null);
    if (!cached) throw e;
    const why = e instanceof NotConfigured ? null : `agy failed (${e.message}), so this is the app's cached status`;
    return { ...cached, detectedTier: tier, tierConfidence: 'low', ...(why ? { note: why } : {}) };
  }
}

const GROUPS = [[/gemini/i, 'ag-gemini'], [/claude|gpt|third|partner/i, 'ag-3p']];
const WINDOWS = { '5h': ['-5h', 18000], weekly: ['-week', 604800] };

/** Pure: `agy /usage` JSON -> collector result. Tested against test/fixtures/antigravity-usage.json. */
export function parse(j) {
  const data = j && j.command && j.command.name === 'usage' && j.command.data;
  if (!data) throw new Error('agy did not run /usage as a command (format changed?)');
  const meters = {}, unmapped = [];
  for (const g of data.groups || []) {
    const prefix = (GROUPS.find(([re]) => re.test(g.name || '')) || [])[1];
    const models = String(g.description || '').replace(/^Models within this group:\s*/i, '');
    for (const b of g.buckets || []) {
      const [suffix, secs] = WINDOWS[b.window] || [];
      const reset = b.reset_time && !String(b.reset_time).startsWith('1970') ? iso(b.reset_time) : null;
      const reading = { used: pct((1 - Number(b.remaining_fraction ?? 1)) * 100), resetAt: reset, windowSeconds: secs, note: models ? `Models: ${models}` : undefined };
      if (prefix && suffix) meters[prefix + suffix] = reading;
      else unmapped.push({ key: `${g.name}:${b.id || b.window}`, ...reading });
    }
  }
  return { meters, unmapped, resets: {}, extras: {}, freshness: 'live' };
}

async function readUserStatusB64() {
  const s = await readStateDb(vscodeStateDb('Antigravity'), ['antigravityUnifiedStateSync.userStatus', 'antigravityAuthStatus']);
  if (!s) return null;
  const raw = s['antigravityUnifiedStateSync.userStatus'];
  if (raw) {
    const m = Buffer.from(raw.trim(), 'base64').toString('latin1').match(/[A-Za-z0-9+/]{200,}={0,2}/);
    if (m) return m[0];
  }
  try { return JSON.parse(s.antigravityAuthStatus).userStatusProtoBinaryBase64 || null; } catch { return null; }
}

async function cachedTier() {
  const b64 = await readUserStatusB64();
  return b64 ? parseStatusProto(Buffer.from(b64, 'base64')).tier : null;
}

async function fromCache() {
  const b64 = await readUserStatusB64();
  if (!b64) return null;
  const { models } = parseStatusProto(Buffer.from(b64, 'base64'));
  if (!models.length) return null;
  const now = Date.now(), meters = {};
  for (const [re, prefix] of GROUPS) {
    const rows = models.filter(m => re.test(m.name)).map(m => {
      const refreshed = m.resetAt && Date.parse(m.resetAt) < now;
      return { label: m.name, used: refreshed ? 0 : pct((1 - m.remaining) * 100), resetAt: refreshed ? null : m.resetAt };
    });
    if (!rows.length) continue;
    const top = rows.reduce((a, b) => (b.used > a.used ? b : a));
    meters[prefix + '-5h'] = { used: top.used, resetAt: top.resetAt, windowSeconds: 18000, breakdown: rows, note: 'From the Antigravity app\'s cache. Install the Antigravity CLI for live numbers.' };
  }
  return { meters, unmapped: [], resets: {}, extras: {}, freshness: 'cached' };
}

// Model entries look like {1: name, ..., 15: {1: fixed32 remainingFraction, 2: {1: varint seconds}}}.
export function parseStatusProto(buf) {
  const models = []; let tier = null; const seen = new Set();
  const visit = (b, depth) => {
    if (depth > 8) return;
    const fields = pbDecode(b);
    if (!fields) return;
    const name = fields.find(f => f.field === 1 && f.wire === 2);
    const quota = fields.find(f => f.field === 15 && f.wire === 2);
    const nameStr = name && pbString(name.value);
    if (nameStr && quota) {
      const q = pbDecode(quota.value);
      const frac = q && q.find(f => f.field === 1 && f.wire === 5);
      const ts = q && q.find(f => f.field === 2 && f.wire === 2);
      const secs = ts && (pbDecode(ts.value) || []).find(f => f.field === 1 && f.wire === 0);
      if (frac && !seen.has(nameStr)) {
        seen.add(nameStr);
        models.push({ name: nameStr, remaining: frac.value.readFloatLE(0), resetAt: secs ? new Date(Number(secs.value) * 1000).toISOString() : null });
        return;
      }
    }
    for (const f of fields) {
      if (f.wire !== 2) continue;
      const s = pbString(f.value);
      if (s) { if (!tier && /^Google AI (Ultra.*|Pro|Plus)$/.test(s)) tier = s; continue; }
      visit(f.value, depth + 1);
    }
  };
  visit(buf, 0);
  return { models, tier };
}
