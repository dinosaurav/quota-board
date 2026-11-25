// Local dashboard server for `quota-board serve`. Binds to 127.0.0.1 only.
// Protections:
//   - The Host header must be a loopback name, which blocks DNS-rebinding attacks.
//   - State-changing requests need the X-Quota-Board header. A cross-site page can't send a custom header
//     without a CORS preflight, and this server never answers one.
import { createServer } from 'node:http';
import { renderHtml, publicState } from './render/html.mjs';

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "connect-src 'self'"
].join('; ');
const MAX_BODY = 10000;

class BadRequest extends Error {}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new BadRequest('request body too large');
  }
  try { return JSON.parse(body || '{}'); } catch { throw new BadRequest('request body is not JSON'); }
}

/**
 * getState() -> current state; refresh() re-collects; setManual(meterId, used, resetAt) saves a reading
 * (throws on bad input). onListen(port) and onError(err) are optional.
 */
export function startServer({ port, getState, refresh, setManual, onListen, onError }) {
  let refreshing = null;
  const doRefresh = () => (refreshing ||= refresh().finally(() => { refreshing = null; }));

  const server = createServer(async (req, res) => {
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) { res.writeHead(421).end('Wrong host'); return; }
    const url = new URL(req.url, `http://${host}`);
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route.startsWith('POST ') && req.headers['x-quota-board'] !== '1') return json(403, { error: 'missing X-Quota-Board header' });
      switch (route) {
        case 'GET /':
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP });
          return res.end(renderHtml(getState(), 'served'));
        case 'GET /api/state':
          return json(200, publicState(getState()));
        case 'POST /api/refresh':
          await doRefresh();
          return json(200, publicState(getState()));
        case 'POST /api/manual': {
          const { meterId, used, resetAt } = await readJsonBody(req);
          if (typeof meterId !== 'string' || !/^[a-z0-9-]+$/.test(meterId)) throw new BadRequest('bad meterId');
          try { setManual(meterId, used, resetAt); } catch (e) { throw new BadRequest(e.message); }
          return json(200, publicState(getState()));
        }
        default:
          res.writeHead(404).end('Not found');
      }
    } catch (e) {
      json(e instanceof BadRequest ? 400 : 500, { error: String(e.message || e) });
    }
  });
  server.on('error', e => { if (onError) onError(e); else throw e; });
  server.listen(port, '127.0.0.1', () => onListen && onListen(server.address().port));
  return { server, refresh: doRefresh };
}
