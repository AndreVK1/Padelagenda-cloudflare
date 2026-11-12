'use strict';
/*
 * Padelagenda: kleine server zonder externe pakketten.
 * - serveert de app uit ./public
 * - bewaart de matchen in een JSON-bestand (DATA_DIR/matches.json)
 * - alleen wie de bewerkcode kent (EDIT_CODE) kan matchen toevoegen, wijzigen of verwijderen
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'matches.json');
const EDIT_CODE = (process.env.EDIT_CODE || '').trim();
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024;
const MAX_MATCHES = 5000;

function log() {
  console.log.apply(console, [new Date().toISOString()].concat([].slice.call(arguments)));
}

/* ---------- opslag ---------- */
let db = { rev: 0, matches: {} };

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && raw.matches && typeof raw.matches === 'object') {
      db = { rev: Number(raw.rev) || 0, matches: raw.matches };
    }
    log('Gegevens geladen:', Object.keys(db.matches).length, 'matchen uit', DATA_FILE);
  } catch (e) {
    if (e.code === 'ENOENT') log('Nog geen gegevensbestand, we starten leeg:', DATA_FILE);
    else log('FOUT bij lezen van', DATA_FILE, '-', e.message);
  }
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}

/* ---------- validatie ---------- */
const STATUSES = ['gepland', 'gespeeld', 'geannuleerd'];
const TEXT_FIELDS = { title: 200, team: 60, club: 120, court: 30, type: 60, players: 500, partner: 200, opponents: 300, notes: 2000 };

function cleanMatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const date = String(input.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(date + 'T00:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== date) return null;
  const time = String(input.time || '');
  if (time !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  let duration = parseInt(input.duration, 10);
  if (isNaN(duration)) duration = 90;
  duration = Math.min(480, Math.max(15, duration));
  const out = { date: date, time: time, duration: duration };
  for (const k of Object.keys(TEXT_FIELDS)) out[k] = String(input[k] == null ? '' : input[k]).trim().slice(0, TEXT_FIELDS[k]);
  out.status = STATUSES.indexOf(input.status) >= 0 ? input.status : 'gepland';
  return out;
}
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);

/* ---------- bewerkcode ---------- */
const failures = new Map(); // ip -> { n, since }
function clientIp(req) {
  // achter Render voegt de proxy het echte adres achteraan toe; het eerste adres kan de bezoeker zelf instellen
  const xf = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
  return xf || req.socket.remoteAddress || '?';
}
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function checkCode(req, urlCode) {
  if (!EDIT_CODE) return 'ok';
  const ip = clientIp(req), now = Date.now();
  const f = failures.get(ip);
  if (f && now - f.since > 10 * 60 * 1000) failures.delete(ip);
  const cur = failures.get(ip);
  if (cur && cur.n >= 10) return 'blocked';
  const given = urlCode != null ? urlCode : String(req.headers['x-edit-code'] || '');
  if (crypto.timingSafeEqual(sha(given), sha(EDIT_CODE))) { failures.delete(ip); return 'ok'; }
  failures.set(ip, { n: (cur ? cur.n : 0) + 1, since: cur ? cur.since : now });
  return 'wrong';
}

/* ---------- http ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

function send(res, status, body, headers) {
  const h = Object.assign({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': CSP
  }, headers || {});
  res.writeHead(status, h);
  res.end(body);
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject({ status: 413, error: 'te groot' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject({ status: 400, error: 'geen geldige JSON' }); }
    });
    req.on('error', () => reject({ status: 400, error: 'lezen mislukt' }));
  });
}
function listMatches() {
  return Object.keys(db.matches).map((id) => Object.assign({ id: id }, db.matches[id]));
}
function commit() { db.rev += 1; persist(); }

async function api(req, res, url) {
  const route = url.pathname;
  if (req.method === 'GET' && route === '/api/info') return json(res, 200, { editCode: !!EDIT_CODE, rev: db.rev });
  if (req.method === 'GET' && route === '/api/matches') {
    const since = url.searchParams.get('rev');
    if (since !== null && Number(since) === db.rev) return json(res, 200, { rev: db.rev, unchanged: true });
    return json(res, 200, { rev: db.rev, matches: listMatches() });
  }
  if (req.method === 'GET' && route === '/api/backup') {
    const c = checkCode(req, url.searchParams.get('code') || '');
    if (c !== 'ok') return json(res, c === 'blocked' ? 429 : 401, { error: c });
    const stamp = new Date().toISOString().slice(0, 10);
    return send(res, 200, JSON.stringify({ matches: listMatches().map((m) => { delete m.id; return m; }) }, null, 1), {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="padelagenda-backup-' + stamp + '.json"',
      'Cache-Control': 'no-store'
    });
  }
  const isWrite = req.method === 'PUT' || req.method === 'DELETE' || req.method === 'POST';
  if (!isWrite) return json(res, 404, { error: 'onbekend' });
  const code = checkCode(req);
  if (code === 'blocked') return json(res, 429, { error: 'te veel foute codes, probeer later opnieuw' });
  if (code !== 'ok') return json(res, 401, { error: 'code' });

  let m = /^\/api\/matches\/([^/]+)$/.exec(route);
  if (m && req.method === 'PUT') {
    const id = decodeURIComponent(m[1]);
    if (!validId(id)) return json(res, 400, { error: 'ongeldig id' });
    const clean = cleanMatch(await readBody(req));
    if (!clean) return json(res, 400, { error: 'ongeldige match' });
    if (!db.matches[id] && Object.keys(db.matches).length >= MAX_MATCHES) return json(res, 507, { error: 'vol' });
    db.matches[id] = clean; commit();
    return json(res, 200, { ok: true, rev: db.rev });
  }
  if (m && req.method === 'DELETE') {
    const id = decodeURIComponent(m[1]);
    if (!validId(id)) return json(res, 400, { error: 'ongeldig id' });
    delete db.matches[id]; commit();
    return json(res, 200, { ok: true, rev: db.rev });
  }
  if (route === '/api/batch' && req.method === 'POST') {
    const body = await readBody(req);
    const items = Array.isArray(body.matches) ? body.matches : null;
    if (!items || items.length > 500) return json(res, 400, { error: 'ongeldige lijst' });
    const prepared = [];
    for (const it of items) {
      const id = it && it.id, clean = it && cleanMatch(it.data);
      if (!validId(id) || !clean) return json(res, 400, { error: 'ongeldige match in lijst' });
      prepared.push([id, clean]);
    }
    const fresh = prepared.filter((p) => !db.matches[p[0]]).length;
    if (Object.keys(db.matches).length + fresh > MAX_MATCHES) return json(res, 507, { error: 'vol' });
    prepared.forEach((p) => { db.matches[p[0]] = p[1]; });
    commit();
    return json(res, 200, { ok: true, count: prepared.length, rev: db.rev });
  }
  return json(res, 404, { error: 'onbekend' });
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Niet toegestaan', { Allow: 'GET, HEAD' });
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, 'Ongeldig adres'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Verboden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Niet gevonden', { 'Content-Type': 'text/plain; charset=utf-8' });
    const ext = path.extname(file).toLowerCase();
    const cache = ext === '.png' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache';
    send(res, 200, req.method === 'HEAD' ? '' : data, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const started = Date.now();
  res.on('finish', () => {
    if (url.pathname.startsWith('/api/') && req.method !== 'GET') log(req.method, url.pathname, res.statusCode, (Date.now() - started) + 'ms', clientIp(req));
    else if (res.statusCode >= 500) log(req.method, url.pathname, res.statusCode);
  });
  if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch((e) => {
      if (e && e.status) return json(res, e.status, { error: e.error });
      log('FOUT', req.method, url.pathname, e && e.stack || e);
      json(res, 500, { error: 'serverfout' });
    });
    return;
  }
  serveStatic(req, res, url);
});

load();
server.listen(PORT, () => {
  log('Padelagenda draait op poort', PORT);
  log('Gegevens worden bewaard in', DATA_FILE);
  log(EDIT_CODE ? 'Bewerkcode: ingesteld' : 'WAARSCHUWING: geen EDIT_CODE ingesteld, iedereen met de link kan matchen wijzigen');
});
function stop() { log('Server stopt'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
