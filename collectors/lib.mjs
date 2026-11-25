// Shared helpers for collectors. No dependencies beyond Node 22+.
import { readFileSync, existsSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { VERSION } from '../src/meta.mjs';

export const HOME = homedir();
export const UA = `quota-board/${VERSION} (+local usage collector)`;

/** Throw for a missing login, key or app: reported as "not configured", not as a failure. */
export class NotConfigured extends Error {
  constructor(message, hint) { super(message); this.hint = hint; }
}

/** Parsed JSON file, or null if it doesn't exist. */
export function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Path to a VS Code-style app's global state database (Cursor, Antigravity). */
export function vscodeStateDb(appName) {
  const p = platform();
  const base = p === 'win32' ? process.env.APPDATA
    : p === 'darwin' ? join(HOME, 'Library', 'Application Support')
    : (process.env.XDG_CONFIG_HOME || join(HOME, '.config'));
  return join(base, appName, 'User', 'globalStorage', 'state.vscdb');
}

/** Read keys from a VS Code-style state.vscdb (read-only). */
export async function readStateDb(path, keys) {
  if (!existsSync(path)) return null;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const out = {};
    const q = db.prepare('select value from ItemTable where key = ?');
    for (const k of keys) { const r = q.get(k); out[k] = r ? String(r.value) : null; }
    return out;
  } finally { db.close(); }
}

/**
 * GET a JSON endpoint. 401/403 become NotConfigured (the login needs refreshing), other failures plain errors.
 * opts: { headers, timeout (ms, default 15000), authHint }.
 */
export async function getJson(url, opts = {}) {
  const host = new URL(url).host;
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || 15000)
  });
  const text = await r.text();
  if (r.status === 401 || r.status === 403) throw new NotConfigured(`${host} returned ${r.status}`, opts.authHint || 'Sign in again in the app, then re-run.');
  if (!r.ok) throw new Error(`${host} returned ${r.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error(`${host} returned something other than JSON`); }
}

/**
 * Run a provider's own command-line tool and return its stdout.
 * No shell, so arguments like "/usage" reach the tool untouched (Git Bash would otherwise rewrite them into paths).
 * The one exception: on Windows a bare command name may be an npm .cmd shim, which needs cmd.exe; the arguments
 * here are always fixed strings, never user input. Runs in the temp folder so the tool picks up no project.
 * Rejects with err.code 'ENOENT' when the tool isn't installed.
 */
export function runTool(cmd, args, { timeout = 60000, input = null } = {}) {
  const opts = { cwd: tmpdir(), timeout, windowsHide: true, maxBuffer: 8 << 20, env: { ...process.env, MSYS_NO_PATHCONV: '1', NO_COLOR: '1' } };
  const once = shell => new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { ...opts, shell }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(err); }
      resolve(String(stdout));
    });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
  return once(false).catch(e => {
    const bare = !/[\\/]/.test(cmd);
    if (e.code === 'ENOENT' && bare && platform() === 'win32') return once(true).catch(e2 => {
      if (/not recognized/i.test(e2.stderr || '')) e2.code = 'ENOENT';
      throw e2;
    });
    throw e;
  });
}

/** Number -> percentage rounded to 0.1 and clamped to 0-100, or null. */
export const pct = v => (v == null || isNaN(Number(v))) ? null : Math.round(Math.max(0, Math.min(100, Number(v))) * 10) / 10;
/** Seconds, milliseconds or a date string -> ISO string, or null. */
export const iso = v => {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  return isNaN(t) ? null : new Date(t).toISOString();
};
/** Decoded JWT payload, or null if the token isn't a JWT. Not verified: only used to read the user id the app already holds. */
export const jwtPayload = t => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')); } catch { return null; } };

/** Minimal protobuf wire-format decoder: returns [{field, wire, value}] or null if not a valid message. */
export function pbDecode(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let r = 0n, s = 0n, b;
    do {
      if (i >= buf.length) throw new RangeError('truncated varint');
      b = buf[i++];
      r |= BigInt(b & 0x7f) << s;
      s += 7n;
    } while (b & 0x80);
    return r;
  };
  try {
    while (i < buf.length) {
      const tag = varint(); const field = Number(tag >> 3n), wire = Number(tag & 7n);
      if (field === 0) return null;
      if (wire === 0) out.push({ field, wire, value: varint() });
      else if (wire === 1) { if (i + 8 > buf.length) return null; out.push({ field, wire, value: buf.subarray(i, i + 8) }); i += 8; }
      else if (wire === 2) { const len = Number(varint()); if (i + len > buf.length) return null; out.push({ field, wire, value: buf.subarray(i, i + len) }); i += len; }
      else if (wire === 5) { if (i + 4 > buf.length) return null; out.push({ field, wire, value: buf.subarray(i, i + 4) }); i += 4; }
      else return null;
    }
  } catch { return null; }
  return out;
}
/** A protobuf bytes field as text, if it looks like printable UTF-8. */
export const pbString = b => { const s = b.toString('utf8'); return /^[\x20-\x7e -￿]+$/.test(s) && !s.includes('�') ? s : null; };
