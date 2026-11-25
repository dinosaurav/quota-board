// Cursor plan usage, read with the Cursor app's stored login.
// Endpoint: GET https://cursor.com/api/usage-summary (undocumented; what the dashboard uses).
import { readStateDb, vscodeStateDb, getJson, pct, iso, jwtPayload, NotConfigured } from '../lib.mjs';

export const id = 'cursor';
export const source = 'Cursor dashboard API (undocumented)';

export async function collect() {
  // Cursor has no command-line usage check to fall back to, so QUOTA_BOARD_DIRECT=0 skips it entirely.
  if (process.env.QUOTA_BOARD_DIRECT === '0') throw new NotConfigured('skipped: Cursor can only be read with its saved login (QUOTA_BOARD_DIRECT=0)', 'Enter Cursor readings by hand: quota-board set cursor-own 40 --reset 12d');
  let token = process.env.CURSOR_ACCESS_TOKEN, membership = null;
  if (!token) {
    const s = await readStateDb(vscodeStateDb('Cursor'), ['cursorAuth/accessToken', 'cursorAuth/stripeMembershipType']);
    if (!s || !s['cursorAuth/accessToken']) throw new NotConfigured('No Cursor login found', 'Install Cursor and sign in.');
    token = s['cursorAuth/accessToken'];
    membership = s['cursorAuth/stripeMembershipType'];
  }
  const claims = jwtPayload(token);
  if (!claims || !claims.sub) throw new NotConfigured('Cursor login token is not in the expected format', 'Sign out of Cursor and back in, then run again.');
  const userId = String(claims.sub).split('|').pop();
  const j = await getJson('https://cursor.com/api/usage-summary', {
    headers: { Cookie: `WorkosCursorSessionToken=${userId}%3A%3A${token}` },
    authHint: 'Open Cursor so it refreshes the login, then run again.'
  });
  const r = parse(j);
  if (!r.detectedTier) r.detectedTier = membership;
  return r;
}

/** Pure: API response -> collector result. Tested against test/fixtures/cursor-usage-summary.json. */
export function parse(j) {
  const plan = (j.individualUsage && j.individualUsage.plan) || {};
  const od = (j.individualUsage && j.individualUsage.onDemand) || {};
  const resetAt = iso(j.billingCycleEnd);
  const windowSeconds = j.billingCycleStart && j.billingCycleEnd ? Math.round((Date.parse(j.billingCycleEnd) - Date.parse(j.billingCycleStart)) / 1000) : null;
  const meters = {
    'cursor-own': { used: pct(plan.autoPercentUsed), resetAt, windowSeconds },
    'cursor-other': { used: pct(plan.apiPercentUsed), resetAt, windowSeconds }
  };
  if (plan.breakdown && plan.breakdown.bonus) meters['cursor-other'].note = 'Includes bonus usage from Cursor';
  return {
    detectedTier: j.membershipType || null,
    meters, unmapped: [], resets: {},
    extras: {
      totalIncludedUsed: plan.totalPercentUsed != null ? `${pct(plan.totalPercentUsed)}%` : null,
      onDemand: od.enabled == null ? null : (od.enabled ? `On, limit ${od.limit}` : 'Off')
    }
  };
}
