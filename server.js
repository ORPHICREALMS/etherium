// Age of Etherion — multiplayer server.  One small Node process:
//   GET /          the game page (public/index.html)
//   GET /health    "ok" (for Render's health check)
//   WS  /ws        the relay (mpcore.js).  The server does not run the game; it only orders commands, keeps a snapshot, and lets players rejoin.
const http = require('http'), fs = require('fs'), path = require('path'), vm = require('vm');
const { WebSocketServer } = require('ws');
let code = fs.readFileSync(path.join(__dirname, 'mpcore.js'), 'utf8');
if (process.env.SNAP_EVERY) code = code.replace(/MP_SNAP_EVERY = \d+/, 'MP_SNAP_EVERY = ' + (+process.env.SNAP_EVERY));   // testing only
const { MPHub } = vm.runInNewContext(code + '\n({ MPHub })', { Math, Date, String, Array, Object, Map, JSON, isFinite, Number });
const PORT = +process.env.PORT || 8080;
// find the game page wherever it ended up (public/index.html is the normal place; also accept index.html or the game file next to this one)
const pageFile = () => {
  const tries = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')];
  try { for (const f of fs.readdirSync(__dirname)) if (/^age-of-etherion.*\.html$/i.test(f)) tries.push(path.join(__dirname, f)); } catch (e) { }
  try { for (const f of fs.readdirSync(path.join(__dirname, 'public'))) if (/\.html$/i.test(f)) tries.push(path.join(__dirname, 'public', f)); } catch (e) { }
  return tries.find(f => fs.existsSync(f));
};
const page = () => { const f = pageFile(); if (!f) throw new Error('no page'); return fs.readFileSync(f); };
const listing = () => { try { return fs.readdirSync(__dirname).join(', '); } catch (e) { return '?'; } };
const server = http.createServer((req, res) => {
  const u = (req.url || '/').split('?')[0];
  if (u === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (u === '/' || u === '/index.html') { let b; try { b = page(); } catch (e) { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('game page missing. The server could not find public/index.html. Files next to server.js: ' + listing()); } res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(b); }
  if (u === '/favicon.ico') { res.writeHead(204); return res.end(); }
  res.writeHead(404); res.end('not found');
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 * 1024 });
const socks = new Map(); let nextId = 1;
const hub = new MPHub({
  send: (cid, m) => { const ws = socks.get(cid); if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); },
  now: () => Date.now(), setTimer: (f, ms) => setTimeout(f, ms), clearTimer: id => clearTimeout(id), rand: Math.random,
});
wss.on('connection', ws => {
  const cid = nextId++; socks.set(cid, ws); ws.alive = true; hub.connect(cid);
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', d => { let m; try { m = JSON.parse(d.toString()); } catch (e) { return; } try { hub.message(cid, m); } catch (e) { console.error('message error', e); } });
  const gone = () => { if (socks.get(cid) === ws) { socks.delete(cid); try { hub.disconnect(cid); } catch (e) { console.error(e); } } };
  ws.on('close', gone); ws.on('error', gone);
});
// keep connections alive through proxies, and drop dead ones so their seat shows "offline" quickly
setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (e) { } } }, 20000);
setInterval(() => { try { hub.sweep(); } catch (e) { console.error(e); } }, 60000);
server.listen(PORT, () => console.log('Etherion server listening on', PORT));
