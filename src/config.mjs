// User config at ~/.quota-board/config.json. Holds choices and manual readings only, never credentials.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, writePrivate } from './meta.mjs';

export const CONFIG_PATH = join(DATA_DIR, 'config.json');

const DEFAULTS = {
  // Plans to always show, by id. Detected plans are added unless autoDetect is false.
  plans: [],
  // Plans to never show, even when detected.
  hide: [],
  autoDetect: true,
  // Collectors to skip, by id (e.g. "antigravity").
  disabledCollectors: [],
  // What you actually pay, when it differs from list price: { "<plan-id>": { "amount": 100, "note": "Family plan" } }
  prices: {},
  // Manual readings: { "<meter-id>": { "used": 40, "resetAt": "ISO", "updatedAt": "ISO" } }
  manual: {}
};

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return structuredClone(DEFAULTS);
  let saved;
  try { saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { throw new Error(`Can't read ${CONFIG_PATH}: ${e.message}. Fix or delete the file.`); }
  const cfg = { ...structuredClone(DEFAULTS), ...saved };
  // A hand-edited file may hold null or the wrong type; fall back to the default for that key.
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (cfg[k] === null || typeof cfg[k] !== typeof v || Array.isArray(cfg[k]) !== Array.isArray(v)) cfg[k] = structuredClone(v);
  }
  return cfg;
}

export function saveConfig(cfg) {
  writePrivate(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}
