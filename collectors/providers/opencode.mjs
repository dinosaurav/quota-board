// OpenCode Go usage via the documented endpoint GET https://opencode.ai/inference/go/v1/usage.
// Key: OPENCODE_GO_API_KEY, OPENCODE_API_KEY, or the key `opencode auth login` stores.
import { join } from 'node:path';
import { HOME, readJson, getJson, pct, iso, NotConfigured } from '../lib.mjs';

export const id = 'opencode';
export const source = 'OpenCode Go usage API (documented)';

function findKey() {
  if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY;
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  const dataHome = process.env.XDG_DATA_HOME || join(HOME, '.local', 'share');
  const auth = readJson(join(dataHome, 'opencode', 'auth.json'));
  if (!auth) return null;
  const entry = auth.opencode || auth['opencode-go'];
  return entry && (entry.key || entry.apiKey) || null;
}

export async function collect() {
  const key = findKey();
  if (!key) throw new NotConfigured('No OpenCode API key found', 'Run `opencode auth login` and pick OpenCode, or set OPENCODE_GO_API_KEY.');
  const j = await getJson('https://opencode.ai/inference/go/v1/usage', {
    headers: { Authorization: `Bearer ${key}`, 'x-opencode-session': 'quota-board-usage-check' },
    authHint: 'A 403 means this key has no Go subscription.'
  });
  return parse(j);
}

/** Pure: API response -> collector result. Tested against test/fixtures/opencode-usage.json. */
export function parse(j) {
  const map = { rolling: ['oc-5h', 18000], weekly: ['oc-week', 604800], monthly: ['oc-month', undefined] };
  const meters = {}, unmapped = [];
  for (const [k, v] of Object.entries(j.meters || j)) {
    if (!v || typeof v !== 'object' || !('percent' in v)) continue;
    const reading = { used: pct(v.percent), resetAt: iso(v.resetsAt) };
    if (v.status && v.status !== 'ok') reading.note = `Status: ${v.status}`;
    if (map[k]) meters[map[k][0]] = { ...reading, windowSeconds: map[k][1] };
    else unmapped.push({ key: k, ...reading });
  }
  return { detectedTier: 'go', meters, unmapped, resets: {}, extras: {} };
}
