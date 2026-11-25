// Builds the dashboard page from web/dashboard.html, web/dashboard.js and src/meter.mjs. Two modes:
//   static: state embedded in the page (written by `quota-board` to ~/.quota-board/dashboard.html)
//   served: the page fetches /api/state from the local server (`quota-board serve`)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT, VERSION } from '../meta.mjs';

const TEMPLATE = join(APP_ROOT, 'web', 'dashboard.html');
const SCRIPT = join(APP_ROOT, 'web', 'dashboard.js');
const METER = join(APP_ROOT, 'src', 'meter.mjs');
const LINE_SEP = String.fromCharCode(0x2028), PARA_SEP = String.fromCharCode(0x2029);

/** JSON that is safe inside <script type="application/json">: no "<" (so no </script>), no raw U+2028/9. */
export const embedJson = obj => JSON.stringify(obj)
  .split('<').join('\\u003c')
  .split(LINE_SEP).join('\\u2028')
  .split(PARA_SEP).join('\\u2029');

/** src/meter.mjs as a browser script: the same rules the terminal uses, with `export` removed. */
function meterScript() {
  const src = readFileSync(METER, 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error('src/meter.mjs must not import anything, because it is inlined into the dashboard page');
  return src.replace(/^export\s+/gm, '');
}

/** The page's whole script: meter rules + dashboard code in one scope. */
export function dashboardScript() {
  const js = `(function () {\n'use strict';\n${meterScript()}\n${readFileSync(SCRIPT, 'utf8')}\n})();`;
  // Neither file should contain these, but a "</script" in a string would end the tag early.
  return js.split('</script').join('<\\/script').split('<!--').join('<\\!--');
}

/** Only what the page needs. Raw collector results are dropped. */
export function publicState(state) {
  return { board: state.board, usage: state.usage, manual: state.manual, unknown: state.unknown, version: VERSION };
}

export function renderHtml(state, mode = 'static') {
  const tpl = readFileSync(TEMPLATE, 'utf8');
  const tags = [`<script id="qb-mode" type="application/json">${embedJson({ mode })}</script>`];
  if (mode === 'static') tags.push(`<script id="qb-state" type="application/json">${embedJson(publicState(state))}</script>`);
  return tpl
    .replace('<!--QB_BOOT-->', () => tags.join('\n'))
    .replace('<!--QB_SCRIPT-->', () => `<script>\n${dashboardScript()}\n</script>`);
}
