// Parser tests against saved provider responses. When a provider changes its response, add a new fixture here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as claude from '../collectors/providers/claude.mjs';
import * as codex from '../collectors/providers/codex.mjs';
import * as cursor from '../collectors/providers/cursor.mjs';
import * as opencode from '../collectors/providers/opencode.mjs';
import * as antigravity from '../collectors/providers/antigravity.mjs';

const fx = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('claude: 5h, weekly, per-model weekly and breakdown', () => {
  const r = claude.parse(fx('claude-usage.json'));
  assert.equal(r.meters['claude-5h'].used, 2);
  assert.equal(r.meters['claude-week'].used, 6);
  assert.equal(r.meters['claude-fable'].used, 6);
  assert.match(r.meters['claude-fable'].note, /3% of weekly/);
  assert.deepEqual(r.meters['claude-week'].breakdown.map(b => b.label), ['Claude Code', 'Chats']);
  assert.equal(r.unmapped.length, 0);
});

test('codex: weekly window, tier and reset credits', () => {
  const r = codex.parse(fx('codex-usage.json'));
  assert.equal(r.detectedTier, 'prolite');
  assert.equal(r.meters['chatgpt-week'].used, 13);
  assert.equal(r.meters['chatgpt-week'].resetAt, new Date(1795797605 * 1000).toISOString());
  assert.equal(r.meters['chatgpt-5h'], undefined);
  assert.deepEqual(r.resets['chatgpt-limit-reset'], { available: 3, usableNow: 0 });
});

test('cursor: both pools and billing cycle', () => {
  const r = cursor.parse(fx('cursor-usage-summary.json'));
  assert.equal(r.detectedTier, 'pro');
  assert.equal(r.meters['cursor-own'].used, 0);
  assert.equal(r.meters['cursor-other'].used, 49.4);
  assert.equal(r.meters['cursor-other'].resetAt, '2026-12-22T20:14:00.000Z');
  assert.equal(r.extras.onDemand, 'On, limit 100');
});

test('opencode: rolling, weekly, monthly', () => {
  const r = opencode.parse(fx('opencode-usage.json'));
  assert.equal(r.meters['oc-5h'].used, 30);
  assert.equal(r.meters['oc-week'].used, 12);
  assert.equal(r.meters['oc-month'].used, 100);
  assert.match(r.meters['oc-month'].note, /rate-limited/);
});

test('antigravity: groups map to meters; unused windows have no reset', () => {
  const r = antigravity.parse(fx('antigravity-usage.json'));
  assert.equal(Math.round(r.meters['ag-gemini-week'].used), 47);
  assert.equal(Math.round(r.meters['ag-gemini-5h'].used), 1);
  assert.equal(r.meters['ag-3p-week'].used, 0);
  assert.equal(r.meters['ag-3p-week'].resetAt, null);
  assert.throws(() => antigravity.parse({ response: 'model answered instead' }), /did not run \/usage/);
});

test('claude CLI fallback: reads the /usage text, with resets in the named time zone', () => {
  const text = readFileSync(new URL('./fixtures/claude-usage-cli.txt', import.meta.url), 'utf8');
  const now = Date.parse('2026-11-24T23:00:00Z');
  const r = claude.parseUsageText(text, now);
  assert.equal(r.meters['claude-5h'].used, 26);
  assert.equal(r.meters['claude-5h'].resetAt, '2026-11-25T02:29:00.000Z');   // 9:29pm New York (EST, UTC-5)
  assert.equal(r.meters['claude-week'].used, 10);
  assert.equal(r.meters['claude-week'].resetAt, '2026-11-29T22:59:00.000Z');
  assert.equal(r.meters['claude-fable'].used, 6);
  assert.equal(Object.keys(r.meters).length, 3);   // the tips section below the usage lines is ignored
});

test('claude CLI fallback: reset dates without a year roll into next year, and DST is respected', () => {
  assert.equal(claude.parseResetText('Jan 2, 9:00am (America/New_York)', Date.parse('2026-12-30T12:00:00Z')), '2027-01-02T14:00:00.000Z');
  assert.equal(claude.parseResetText('Jul 4, 12:00pm (America/New_York)', Date.parse('2026-07-01T12:00:00Z')), '2026-07-04T16:00:00.000Z');   // EDT, UTC-4
  assert.equal(claude.parseResetText('Nov 29, 5:59pm (UTC)', Date.parse('2026-11-24T12:00:00Z')), '2026-11-29T17:59:00.000Z');
  assert.equal(claude.parseResetText('soon', Date.now()), null);
});

test('codex app-server fallback: weekly window, tier, extra limits and reset-credit expiry', () => {
  const r = codex.parseAppServer(fx('codex-app-server.json'));
  assert.equal(r.detectedTier, 'prolite');
  assert.equal(r.meters['chatgpt-week'].used, 14);
  assert.equal(r.meters['chatgpt-week'].resetAt, new Date(1795797605 * 1000).toISOString());
  assert.deepEqual(r.unmapped.map(u => u.key), ['Example extra limit:604800s']);
  assert.deepEqual(r.resets['chatgpt-limit-reset'], { available: 3, usableNow: null, nextExpiry: new Date(1796068147 * 1000).toISOString() });   // the used credit is ignored
});
