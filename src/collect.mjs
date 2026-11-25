// Runs collectors and returns their raw results, keyed by collector id. One failing collector never stops the others.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT } from './meta.mjs';
import { NotConfigured } from '../collectors/lib.mjs';

const TIMEOUT_MS = 120000;

function withTimeout(promise, id) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${id} took longer than ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export async function listCollectors() {
  const dir = join(APP_ROOT, 'collectors', 'providers');
  const mods = [];
  for (const f of readdirSync(dir).filter(n => n.endsWith('.mjs')).sort()) mods.push(await import(pathToFileURL(join(dir, f)).href));
  return mods;
}

/** onStart(ids) fires once before collecting; onDone(entry, ms) as each collector finishes. */
export async function runCollectors({ only = [], skip = [], onStart, onDone } = {}) {
  const mods = (await listCollectors()).filter(m => (!only.length || only.includes(m.id)) && !skip.includes(m.id));
  const results = {};
  if (onStart) onStart(mods.map(m => m.id));
  await Promise.all(mods.map(async mod => {
    const t0 = Date.now();
    const entry = { collector: mod.id, source: mod.source, collectedAt: new Date().toISOString() };
    try {
      Object.assign(entry, { status: 'ok' }, await withTimeout(mod.collect(), mod.id));
    } catch (e) {
      if (e instanceof NotConfigured) Object.assign(entry, { status: 'not-configured', error: e.message, hint: e.hint });
      else Object.assign(entry, { status: 'error', error: String(e && e.message || e).slice(0, 300) });
    }
    results[mod.id] = entry;
    if (onDone) onDone(entry, Date.now() - t0);
  }));
  return results;
}
