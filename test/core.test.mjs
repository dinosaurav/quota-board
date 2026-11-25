// Core tests: plan validation, detection, meter rules, the dashboard page, the CLI and the local server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { APP_ROOT as ROOT, writePrivate } from '../src/meta.mjs';
import { loadAll, tierMatches } from '../src/plans.mjs';
import { selectPlans, usageFor } from '../src/state.mjs';
import { evaluate } from '../src/meter.mjs';
import { renderHtml, dashboardScript } from '../src/render/html.mjs';
import { startServer } from '../src/serve.mjs';

const catalog = loadAll();

test('every plan file is valid', () => {
  assert.deepEqual(catalog.errors, []);
  assert.ok(catalog.plans.length >= 5);
});

test('no two plans claim the same tier from the same collector', () => {
  const seen = new Map();
  for (const p of catalog.plans) for (const t of (p.detect && p.detect.tiers) || []) {
    const k = `${p.detect.collector}:${t.toLowerCase()}`;
    assert.ok(!seen.has(k), `${p.id} and ${seen.get(k)} both claim ${k}`);
    seen.set(k, p.id);
  }
});

test('detect: tier match picks the plan; unknown tiers are reported', () => {
  const results = {
    claude: { collector: 'claude', status: 'ok', detectedTier: 'default_claude_max_5x', meters: {} },
    codex: { collector: 'codex', status: 'ok', detectedTier: 'something_new', meters: {} }
  };
  const { selected, unknown } = selectPlans(catalog.plans, results, { plans: [], hide: [], autoDetect: true });
  assert.ok(selected.some(s => s.plan.id === 'claude-max-5x'));
  assert.deepEqual(unknown, [{ collector: 'codex', tier: 'something_new' }]);
  const max = catalog.plans.find(p => p.id === 'claude-max-5x');
  assert.ok(tierMatches(max, 'claude', 'DEFAULT_CLAUDE_MAX_5X'));
});

test('configured plan overrides detection for that collector', () => {
  const results = { claude: { collector: 'claude', status: 'ok', detectedTier: 'default_claude_max_5x', meters: {} } };
  const other = catalog.plans.find(p => p.detect && p.detect.collector === 'claude' && p.id !== 'claude-max-5x');
  if (!other) return;
  const { selected } = selectPlans(catalog.plans, results, { plans: [other.id], hide: [], autoDetect: true });
  assert.deepEqual(selected.map(s => s.plan.id), [other.id]);
});

test('meter status: pace, lock, rollover', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  const meter = { id: 'x-week', period: 'week', reset: { type: 'rolling-weekly', rule: '' } };
  const usage = (used, resetAt) => ({ status: 'ok', collectedAt: '2026-11-24T11:59:00Z', meters: { 'x-week': { used, resetAt, windowSeconds: 604800 } } });
  assert.equal(evaluate(meter, usage(100, '2026-11-27T00:00:00Z'), {}, now).status, 'locked');
  assert.equal(evaluate(meter, usage(80, '2026-11-30T00:00:00Z'), {}, now).status, 'tight');
  assert.equal(evaluate(meter, usage(10, '2026-11-25T00:00:00Z'), {}, now).status, 'spend');
  // A reading from before the current window started counts as 0.
  const stale = { status: 'ok', collectedAt: '2026-11-10T00:00:00Z', meters: { 'x-week': { used: 90, resetAt: '2026-11-12T00:00:00Z', windowSeconds: 604800 } } };
  assert.equal(evaluate(meter, stale, {}, now).used, 0);
});

test('usage keeps only meters the plan defines; the rest are unmapped', () => {
  const plan = catalog.plans.find(p => p.id === 'claude-max-5x');
  const results = { claude: { collector: 'claude', status: 'ok', detectedTier: 'default_claude_max_5x', collectedAt: 'x', meters: { 'claude-5h': { used: 1 }, 'claude-new-thing': { used: 5 } }, unmapped: [] } };
  const u = usageFor([{ plan, reason: 'detected' }], results, 'x');
  assert.ok(u.plans['claude-max-5x'].meters['claude-5h']);
  assert.equal(u.plans['claude-max-5x'].unmapped[0].key, 'claude-new-thing');
});

test('dashboard html escapes embedded data', () => {
  const evil = { board: { plans: [] }, usage: { plans: {} }, manual: { a: { note: '</script><script>alert(1)</script>' } }, unknown: [] };
  const html = renderHtml(evil, 'static');
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.ok(html.includes('qb-state'));
});

test('dashboard: a "</script>" inside plan text cannot end the script tag', () => {
  const plan = { ...catalog.plans.find(p => p.id === 'claude-max-5x'), name: 'Evil </script><img src=x onerror=alert(1)>' };
  const html = renderHtml({ board: { plans: [plan] }, usage: { plans: {} }, manual: {}, unknown: [] }, 'static');
  // Exactly the three tags we write: qb-mode, qb-state, the page script.
  assert.equal(html.split('</script>').length - 1, 3);
  const state = JSON.parse(html.match(/<script id="qb-state" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(state.board.plans[0].name, plan.name);
});

test('dashboard: page script is valid JS and uses the shared meter rules', () => {
  const js = dashboardScript();
  assert.doesNotThrow(() => new Function(js));
  // src/meter.mjs is inlined once, so the page can't drift from the terminal.
  assert.equal(js.match(/function evaluate\(/g).length, 1);
  assert.ok(!/^export /m.test(js));
});

test('writePrivate: files are readable only by the owner', { skip: process.platform === 'win32' && 'POSIX modes only' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'qb-test-'));
  const f = join(dir, 'sub', 'x.json');
  writePrivate(f, '{}');
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'sub')).mode & 0o777, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

test('cli: progress goes to stderr, the board and dashboard link to stdout', () => {
  const home = mkdtempSync(join(tmpdir(), 'qb-cli-'));
  const env = { ...process.env, QUOTA_BOARD_HOME: home, XDG_DATA_HOME: home, NO_COLOR: '1' };
  delete env.OPENCODE_GO_API_KEY; delete env.OPENCODE_API_KEY;
  const run = (...a) => spawnSync(process.execPath, ['--no-warnings', join(ROOT, 'bin', 'quota-board.mjs'), '--only', 'opencode', ...a], { env, encoding: 'utf8', timeout: 60000 });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /› Loaded \d+ plan files/);
  assert.match(r.stderr, /› Checking usage: opencode/);
  assert.match(r.stderr, /opencode\s+not set up/);
  assert.ok(!r.stdout.includes('›'), 'no progress lines on stdout');
  assert.match(r.stdout, /Quota Board/);
  assert.match(r.stdout, /Dashboard\s+file:\/\//);
  assert.ok(existsSync(join(home, 'dashboard.html')));
  const q = run('-q', '--no-html', '--cached');
  assert.equal(q.stderr, '');
  assert.ok(!q.stdout.includes('Dashboard'));
  rmSync(home, { recursive: true, force: true });
});

test('serve: wrong Host, missing header and bad readings are refused', async () => {
  const state = { board: { plans: [] }, usage: { plans: {} }, manual: {}, unknown: [] };
  const saved = [];
  const { server } = startServer({
    port: 0, getState: () => state, refresh: async () => {},
    setManual: (id, used) => { if (used != null && isNaN(Number(used))) throw new Error('percent must be a number'); saved.push(id); }
  });
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  const req = (method, path, headers = {}, body) => new Promise((resolve, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject);
    r.end(body);
  });
  try {
    assert.equal(await req('GET', '/', { Host: 'evil.example:80' }), 421);
    assert.equal(await req('GET', '/'), 200);
    assert.equal(await req('POST', '/api/manual', {}, '{"meterId":"x-week","used":5}'), 403);
    assert.equal(await req('POST', '/api/manual', { 'X-Quota-Board': '1' }, '{"meterId":"../etc","used":5}'), 400);
    assert.equal(await req('POST', '/api/manual', { 'X-Quota-Board': '1' }, '{"meterId":"x-week","used":"lots"}'), 400);
    assert.equal(await req('POST', '/api/manual', { 'X-Quota-Board': '1' }, 'not json'), 400);
    assert.equal(await req('POST', '/api/manual', { 'X-Quota-Board': '1' }, '{"meterId":"x-week","used":5}'), 200);
    assert.deepEqual(saved, ['x-week']);
  } finally { server.close(); }
});

test('meter: a full window is locked until its reset', () => {
  const meter = { id: 'a-week', period: 'week', reset: { type: 'rolling-weekly', rule: '' } };
  const at = '2026-11-24T11:00:00Z', resetAt = '2026-11-27T00:00:00Z';
  const ev = evaluate(meter, { status: 'ok', collectedAt: at, meters: { 'a-week': { used: 100, resetAt } } }, {}, Date.parse('2026-11-24T12:00:00Z'));
  assert.equal(ev.status, 'locked');
  assert.equal(ev.remaining, Date.parse(resetAt) - Date.parse('2026-11-24T12:00:00Z'));
});
