#!/usr/bin/env node
// quota-board CLI: see every AI subscription's limits, resets and live usage in one place.
process.removeAllListeners('warning'); // hide node:sqlite's ExperimentalWarning
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { platform } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { APP_ROOT, DATA_DIR, VERSION, REPO, writePrivate } from '../src/meta.mjs';
import { loadAll, tierMatches } from '../src/plans.mjs';
import { loadConfig, saveConfig, CONFIG_PATH } from '../src/config.mjs';
import { runCollectors, listCollectors } from '../src/collect.mjs';
import { buildState, selectPlans } from '../src/state.mjs';
import { renderStatus, renderPlans, bold, dim, cyan, green, red, yellow } from '../src/render/terminal.mjs';
import { renderHtml, publicState } from '../src/render/html.mjs';
import { startServer } from '../src/serve.mjs';
import { fmtDur, clampPct } from '../src/meter.mjs';

const HELP = `${bold('quota-board')} ${dim('v' + VERSION)}  See every AI plan's limits, resets and live usage.

${bold('Usage')}
  quota-board                 collect live usage, show your board, and write a dashboard page
  quota-board -v              same, with reset rules, breakdowns and extras
  quota-board open            same as quota-board, then open the dashboard page in your browser
  quota-board serve           live dashboard at http://127.0.0.1:4477 (auto-refreshes)
  quota-board json            print the board as JSON

${bold('Your plans')}
  quota-board plans [search]  list every plan quota-board knows (● = on your board)
  quota-board use <id...>     add plans to your board (overrides auto-detect for that provider)
  quota-board drop <id...>    remove plans from your board
  quota-board price <id> <amount> [note]   record what you actually pay
  quota-board set <meter-id> <percent|clear> [--reset 3h|2d|ISO]   enter a reading by hand

${bold('Maintenance')}
  quota-board doctor          show what each collector found on this machine
  quota-board report          print a prefilled GitHub issue for a missing plan or limit (--open to open it)
  quota-board update          git pull, if you run quota-board from a clone

${bold('Options')}
  --cached         reuse the last collection instead of collecting again
  --only a,b       run only these collectors (claude, codex, cursor, antigravity, opencode)
  --port N         port for serve (default 4477)
  --interval N     minutes between refreshes for serve (default 5)
  --no-open        serve without opening a browser
  --no-html        don't write the dashboard page
  -q, --quiet      don't print progress steps

Data: ${DATA_DIR}  ·  Privacy: logins are read locally and sent only to each provider's own API.`;

// ---------- args ----------
const argv = process.argv.slice(2);
const OPT_WITH_VALUE = ['--only', '--port', '--reset', '--interval'];
const flags = new Set(argv.filter(a => a.startsWith('-') && !a.includes('=')));
/** Value of `--name value` or `--name=value`, or null. */
function opt(name) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find(a => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : null;
}
const positional = argv.filter((a, i) => !a.startsWith('-') && !OPT_WITH_VALUE.includes(argv[i - 1]));
const cmd = positional[0] || 'status';
const args = positional.slice(1);

const LAST = join(DATA_DIR, 'last.json');
const DASHBOARD = join(DATA_DIR, 'dashboard.html');
const fail = msg => { console.error(red('error ') + msg); process.exit(1); };

// Progress steps go to stderr, so stdout stays clean for pipes (quota-board > board.txt).
const quiet = flags.has('-q') || flags.has('--quiet');
const step = msg => { if (!quiet) process.stderr.write(`${dim('›')} ${msg}\n`); };
const RESULT_LABEL = {
  ok: r => (r.freshness === 'cached' ? yellow('cached') : green('live')),
  'not-configured': () => yellow('not set up'),
  error: () => red('failed')
};

function loadCatalog({ steps = false } = {}) {
  const cat = loadAll();
  if (cat.errors.length) fail(`plan files are invalid:\n  ${cat.errors.join('\n  ')}`);
  if (steps) step(`Loaded ${cat.plans.length} plan files`);
  return cat;
}

/** Results of the last collection, or {} if there isn't one (or it's unreadable). */
function readLast() {
  try { return JSON.parse(readFileSync(LAST, 'utf8')).results || {}; } catch { return {}; }
}
const saveLast = results => writePrivate(LAST, JSON.stringify({ at: new Date().toISOString(), results }));

async function collect(cfg, { steps = false } = {}) {
  if (flags.has('--cached') && existsSync(LAST)) {
    if (steps) step(`Using usage collected ${fmtDur(Date.now() - statSync(LAST).mtimeMs)} ago (--cached)`);
    return readLast();
  }
  const only = (opt('--only') || '').split(',').filter(Boolean);
  const results = await runCollectors({
    only, skip: cfg.disabledCollectors || [],
    onStart: ids => { if (steps) step(`Checking usage: ${ids.join(', ')}`); },
    onDone: (r, ms) => {
      if (!steps) return;
      const why = r.status === 'ok' ? '' : ` · ${r.error}`;
      step(`  ${r.collector.padEnd(12)} ${(RESULT_LABEL[r.status] || (() => r.status))(r)} ${dim(`${(ms / 1000).toFixed(1)}s${why}`)}`);
    }
  });
  // With --only, keep the other collectors' last results so the board stays complete.
  const merged = { ...(only.length ? readLast() : {}), ...results };
  saveLast(merged);
  return merged;
}

/** The default command: collect, print the board, write the dashboard page, print a clickable link to it. */
async function board({ openPage = false } = {}) {
  const cat = loadCatalog({ steps: true }), cfg = loadConfig();
  const state = buildState(cat, await collect(cfg, { steps: true }), cfg);
  const html = !flags.has('--no-html');
  if (html) { step('Writing dashboard page'); writePrivate(DASHBOARD, renderHtml(state, 'static')); }
  if (!quiet) process.stderr.write('\n');
  console.log(renderStatus(state, { verbose: flags.has('-v') || flags.has('--verbose') }));
  if (!existsSync(CONFIG_PATH)) { saveConfig(cfg); console.log(dim(`First run: settings saved to ${CONFIG_PATH}`)); }
  if (html) {
    console.log(`\n${bold('Dashboard')}  ${cyan(pathToFileURL(DASHBOARD).href)}`);
    console.log(dim(`           ${DASHBOARD}  (a snapshot; run quota-board again to update it)`));
    if (openPage) openInBrowser(DASHBOARD);
  }
}

function openInBrowser(target) {
  const p = platform();
  const bin = p === 'win32' ? 'explorer.exe' : p === 'darwin' ? 'open' : 'xdg-open';
  const tell = () => console.log(`Open ${target} in your browser.`);
  try {
    // A missing opener (e.g. no xdg-open on a server) is reported as an 'error' event, not a throw.
    spawn(bin, [target], { detached: true, stdio: 'ignore' }).on('error', tell).unref();
  } catch { tell(); }
}

/** "3h", "2d4h", "in 45m" or an ISO date -> ISO string. */
function parseReset(s) {
  if (!s) return null;
  const rel = s.replace(/^in\s+/, '').match(/^(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?$/);
  if (rel && (rel[1] || rel[2] || rel[3])) {
    const minutes = (+rel[1] || 0) * 1440 + (+rel[2] || 0) * 60 + (+rel[3] || 0);
    return new Date(Date.now() + minutes * 60000).toISOString();
  }
  const t = Date.parse(s);
  if (isNaN(t)) fail(`can't read reset time "${s}". Use 3h, 2d4h, or an ISO date like 2026-12-01T09:00`);
  return new Date(t).toISOString();
}

/** A manual reading as stored in config, or null to clear it. Throws on bad input. */
function manualReading(used, resetAt) {
  if (used === null || used === '' || used === 'clear') return null;
  const n = clampPct(String(used).replace('%', ''));
  if (n == null) throw new Error('percent must be a number from 0 to 100');
  if (resetAt != null && resetAt !== '' && isNaN(Date.parse(resetAt))) throw new Error('reset time is not a date');
  return { used: n, resetAt: resetAt ? new Date(resetAt).toISOString() : null, updatedAt: new Date().toISOString() };
}

// ---------- commands ----------
const commands = {
  async status() { await board(); },

  async open() { await board({ openPage: !flags.has('--no-open') }); },

  async json() {
    const cat = loadCatalog(), cfg = loadConfig();
    console.log(JSON.stringify(publicState(buildState(cat, await collect(cfg), cfg)), null, 2));
  },

  async serve() {
    const cat = loadCatalog({ steps: true });
    let cfg = loadConfig();
    let state = buildState(cat, await collect(cfg, { steps: true }), cfg);
    const minutes = Number(opt('--interval') || 5);
    if (!(minutes > 0)) fail('--interval must be a number of minutes');
    const refresh = async () => {
      cfg = loadConfig();
      const results = await runCollectors({ skip: cfg.disabledCollectors || [] });
      saveLast(results);
      state = buildState(cat, results, cfg);
    };
    const setManual = (meterId, used, resetAt) => {
      const reading = manualReading(used, resetAt);
      cfg = loadConfig();
      if (reading) cfg.manual[meterId] = reading; else delete cfg.manual[meterId];
      saveConfig(cfg);
      state = { ...state, manual: cfg.manual };
    };
    const port = Number(opt('--port') || process.env.QUOTA_BOARD_PORT || 4477);
    const { refresh: tick } = startServer({
      port, getState: () => state, refresh, setManual,
      onListen: p => {
        const url = `http://127.0.0.1:${p}`;
        console.log(`${green('Serving')} ${url}  ${dim(`refreshes every ${minutes} min · Ctrl+C to stop`)}`);
        if (!flags.has('--no-open')) openInBrowser(url);
      },
      onError: e => fail(e.code === 'EADDRINUSE' ? `port ${port} is already in use. Try --port ${port + 1}.` : e.message)
    });
    setInterval(() => tick().catch(e => console.error(red('refresh failed ') + e.message)), minutes * 60000);
  },

  async plans() {
    const cat = loadCatalog(), cfg = loadConfig();
    const onBoard = new Set(selectPlans(cat.plans, readLast(), cfg).selected.map(s => s.plan.id));
    console.log(renderPlans(cat.plans, onBoard, args.join(' ')));
  },

  async use() {
    if (!args.length) fail('name at least one plan id. See: quota-board plans');
    const cat = loadCatalog(), cfg = loadConfig();
    for (const id of args) {
      const p = cat.plans.find(x => x.id === id);
      if (!p) fail(`no plan "${id}". See: quota-board plans ${id.split('-')[0]}`);
      // One plan per collector: replace another configured plan from the same provider.
      if (p.detect) {
        cfg.plans = cfg.plans.filter(x => {
          const o = cat.plans.find(y => y.id === x);
          return !(o && o.detect && o.detect.collector === p.detect.collector && o.id !== id);
        });
      }
      if (!cfg.plans.includes(id)) cfg.plans.push(id);
      cfg.hide = (cfg.hide || []).filter(x => x !== id);
      console.log(`${green('added')} ${p.name}`);
    }
    saveConfig(cfg);
  },

  async drop() {
    if (!args.length) fail('name at least one plan id to remove');
    const cfg = loadConfig();
    for (const id of args) {
      cfg.plans = cfg.plans.filter(x => x !== id);
      if (!cfg.hide.includes(id)) cfg.hide.push(id);
      console.log(`${yellow('removed')} ${id}`);
    }
    saveConfig(cfg);
  },

  async price() {
    const [id, amount, ...note] = args;
    if (!id || amount == null || isNaN(Number(amount))) fail('usage: quota-board price <plan-id> <amount> [note]');
    if (!loadCatalog().plans.some(p => p.id === id)) fail(`no plan "${id}". See: quota-board plans`);
    const cfg = loadConfig();
    cfg.prices[id] = { amount: Number(amount), ...(note.length ? { note: note.join(' ') } : {}) };
    saveConfig(cfg);
    console.log(`${green('saved')} ${id}: $${amount}${note.length ? ` (${note.join(' ')})` : ''}`);
  },

  async set() {
    const [meterId, value] = args;
    if (!meterId || value == null) fail('usage: quota-board set <meter-id> <percent|clear> [--reset 3h]');
    if (!loadCatalog().plans.some(p => p.meters.some(m => m.id === meterId))) fail(`no meter "${meterId}". Meter ids are listed in each plan file under "meters".`);
    let reading;
    try { reading = manualReading(value, parseReset(opt('--reset'))); } catch (e) { fail(e.message); }
    const cfg = loadConfig();
    if (reading) cfg.manual[meterId] = reading; else delete cfg.manual[meterId];
    saveConfig(cfg);
    console.log(`${green(reading ? 'saved' : 'cleared')} ${meterId}`);
  },

  async doctor() {
    const cat = loadCatalog(), cfg = loadConfig();
    console.log(`${bold('quota-board')} v${VERSION}  node ${process.versions.node}  ${platform()}`);
    console.log(dim(`app ${APP_ROOT}\ndata ${DATA_DIR}\nplans ${cat.plans.length} · warnings ${cat.warnings.length}`));
    const results = await runCollectors({ skip: cfg.disabledCollectors || [] });
    console.log('');
    for (const m of await listCollectors()) {
      const r = results[m.id];
      if (!r) { console.log(`${dim('off ')}  ${m.id.padEnd(12)} disabled in config`); continue; }
      const tag = r.status === 'ok' ? green('ok  ') : r.status === 'not-configured' ? yellow('skip') : red('fail');
      let detail;
      if (r.status === 'ok') {
        const match = cat.plans.filter(p => tierMatches(p, m.id, r.detectedTier)).map(p => p.id).join(', ');
        detail = `tier ${JSON.stringify(r.detectedTier)} -> ${match || yellow('no plan file')}; ${Object.keys(r.meters || {}).length} meters${r.freshness === 'cached' ? ', cached' : ''}`;
      } else {
        detail = `${r.error}${r.hint ? dim(' · ' + r.hint) : ''}`;
      }
      console.log(`${tag}  ${m.id.padEnd(12)} ${detail}`);
      console.log(dim(`      ${m.source}`));
    }
  },

  async report() {
    const cat = loadCatalog(), cfg = loadConfig();
    const results = existsSync(LAST) && !flags.has('--fresh') ? readLast() : await collect(cfg);
    const state = buildState(cat, results, cfg);
    const lines = [`quota-board v${VERSION}, ${platform()}`, ''];
    for (const r of Object.values(results)) {
      lines.push(`- **${r.collector}**: ${r.status}${r.detectedTier ? `, tier \`${r.detectedTier}\`` : ''}${r.status === 'error' ? `, error: ${r.error}` : ''}`);
      for (const u of r.unmapped || []) lines.push(`  - unmapped limit \`${u.key}\`: ${u.used ?? '?'}% used${u.windowSeconds ? `, window ${u.windowSeconds}s` : ''}`);
    }
    for (const x of state.unknown) lines.push(`- tier \`${x.tier}\` from ${x.collector} matches no plan file`);
    lines.push('', 'Plan I actually have (name, price, link to its pricing page):', '', 'What is wrong or missing:', '');
    const body = lines.join('\n');
    console.log(body);
    if (!REPO || REPO.startsWith('OWNER/')) { console.log(dim('\n(This copy has no GitHub repository configured, so paste the text above into an issue.)')); return; }
    const title = 'Plan update: ' + (state.unknown[0] ? state.unknown[0].tier : 'missing plan or limit');
    const url = `https://github.com/${REPO}/issues/new?labels=plan-update&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    console.log(`\n${bold('Open this to file it')} ${dim('(nothing above identifies you, but read it first)')}:\n${url}`);
    if (flags.has('--open')) openInBrowser(url);
  },

  async update() {
    if (existsSync(join(APP_ROOT, '.git'))) {
      console.log(dim(`git pull in ${APP_ROOT}`));
      execFile('git', ['-C', APP_ROOT, 'pull', '--ff-only'], (e, out, err) => { console.log(out || err); if (e) process.exit(1); });
      return;
    }
    console.log('Nothing to update. The one-line command downloads the newest version every time it runs.');
  },

  help() { console.log(HELP); },
  version() { console.log(VERSION); }
};

if (flags.has('--help') || flags.has('-h')) commands.help();
else if (flags.has('--version')) commands.version();
else if (!commands[cmd]) { console.error(`Unknown command "${cmd}".\n`); commands.help(); process.exit(1); }
else await commands[cmd]();
