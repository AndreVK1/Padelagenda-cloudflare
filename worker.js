/*
 * Padelagenda API voor een Cloudflare Worker (met statische bestanden) + D1.
 * Bindings:
 *   DB        = D1-database (staat in wrangler.jsonc)
 *   EDIT_CODE = geheime bewerkingscode (secret in het dashboard)
 * Dezelfde routes als de Node-versie: /api/info, /api/matches, /api/backup, /api/batch
 */
const MAX_BODY = 1024 * 1024;
const MAX_MATCHES = 5000;
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

function json(status, obj, extra) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }, extra || {})
  });
}

/* ---------- opslag ---------- */
let ready = null;
function init(db) {
  if (!ready) {
    ready = db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS matches (id TEXT PRIMARY KEY, data TEXT NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS fails (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, since INTEGER NOT NULL)'),
      db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('rev', 0)")
    ]).catch((e) => { ready = null; throw e; });
  }
  return ready;
}
const REV_SQL = "SELECT v FROM meta WHERE k = 'rev'";
const BUMP_SQL = "UPDATE meta SET v = v + 1 WHERE k = 'rev'";
async function getRev(db) { const r = await db.prepare(REV_SQL).first(); return r ? Number(r.v) : 0; }
async function listMatches(db) {
  const r = await db.prepare('SELECT id, data FROM matches').all();
  return r.results.map((row) => Object.assign({ id: row.id }, JSON.parse(row.data)));
}
// schrijf + verhoog rev in een transactie, geef de nieuwe rev terug
async function commit(db, statements) {
  const res = await db.batch(statements.concat([db.prepare(BUMP_SQL), db.prepare(REV_SQL)]));
  const last = res[res.length - 1].results[0];
  return Number(last.v);
}

/* ---------- bewerkcode ---------- */
async function sha(s) { return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)))); }
async function codeMatches(given, expected) {
  const a = await sha(given), b = await sha(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function checkCode(db, request, env, urlCode) {
  const expected = String(env.EDIT_CODE || '').trim();
  if (!expected) return 'ok';
  const ip = request.headers.get('CF-Connecting-IP') || '?';
  const now = Date.now();
  let row = await db.prepare('SELECT n, since FROM fails WHERE ip = ?').bind(ip).first();
  if (row && now - Number(row.since) > 10 * 60 * 1000) {
    await db.prepare('DELETE FROM fails WHERE ip = ?').bind(ip).run();
    row = null;
  }
  if (row && Number(row.n) >= 10) return 'blocked';
  const given = urlCode != null ? urlCode : String(request.headers.get('x-edit-code') || '');
  if (await codeMatches(given, expected)) {
    if (row) await db.prepare('DELETE FROM fails WHERE ip = ?').bind(ip).run();
    return 'ok';
  }
  await db.prepare('INSERT INTO fails (ip, n, since) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET n = n + 1')
    .bind(ip, now).run();
  return 'wrong';
}

async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) throw { status: 413, error: 'te groot' };
  const text = await request.text();
  if (text.length > MAX_BODY) throw { status: 413, error: 'te groot' };
  try { return text ? JSON.parse(text) : {}; } catch (e) { throw { status: 400, error: 'geen geldige JSON' }; }
}

async function handle(request, env) {
  const db = env.DB;
  if (!db) return json(500, { error: 'D1-database "DB" is niet gekoppeld' });
  await init(db);
  const url = new URL(request.url);
  const route = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if (method === 'GET' && route === '/api/info') {
    return json(200, { editCode: !!String(env.EDIT_CODE || '').trim(), rev: await getRev(db) });
  }
  if (method === 'GET' && route === '/api/matches') {
    const rev = await getRev(db);
    const since = url.searchParams.get('rev');
    if (since !== null && Number(since) === rev) return json(200, { rev: rev, unchanged: true });
    const matches = await listMatches(db);
    return json(200, { rev: await getRev(db), matches: matches });
  }
  if (method === 'GET' && route === '/api/backup') {
    const c = await checkCode(db, request, env, url.searchParams.get('code') || '');
    if (c !== 'ok') return json(c === 'blocked' ? 429 : 401, { error: c });
    const stamp = new Date().toISOString().slice(0, 10);
    const list = (await listMatches(db)).map((m) => { delete m.id; return m; });
    return new Response(JSON.stringify({ matches: list }, null, 1), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="padelagenda-backup-' + stamp + '.json"',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  }
  if (method !== 'PUT' && method !== 'DELETE' && method !== 'POST') return json(404, { error: 'onbekend' });

  const code = await checkCode(db, request, env, null);
  if (code === 'blocked') return json(429, { error: 'te veel foute codes, probeer later opnieuw' });
  if (code !== 'ok') return json(401, { error: 'code' });

  const m = /^\/api\/matches\/([^/]+)$/.exec(route);
  if (m && method === 'PUT') {
    let id; try { id = decodeURIComponent(m[1]); } catch (e) { return json(400, { error: 'ongeldig id' }); }
    if (!validId(id)) return json(400, { error: 'ongeldig id' });
    const clean = cleanMatch(await readJson(request));
    if (!clean) return json(400, { error: 'ongeldige match' });
    const st = await db.prepare('SELECT (SELECT COUNT(*) FROM matches) AS c, (SELECT COUNT(*) FROM matches WHERE id = ?) AS e').bind(id).first();
    if (!Number(st.e) && Number(st.c) >= MAX_MATCHES) return json(507, { error: 'vol' });
    const rev = await commit(db, [
      db.prepare('INSERT INTO matches (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').bind(id, JSON.stringify(clean))
    ]);
    return json(200, { ok: true, rev: rev });
  }
  if (m && method === 'DELETE') {
    let id; try { id = decodeURIComponent(m[1]); } catch (e) { return json(400, { error: 'ongeldig id' }); }
    if (!validId(id)) return json(400, { error: 'ongeldig id' });
    const rev = await commit(db, [db.prepare('DELETE FROM matches WHERE id = ?').bind(id)]);
    return json(200, { ok: true, rev: rev });
  }
  if (route === '/api/batch' && method === 'POST') {
    const body = await readJson(request);
    const items = Array.isArray(body.matches) ? body.matches : null;
    if (!items || items.length > 500) return json(400, { error: 'ongeldige lijst' });
    const prepared = [];
    for (const it of items) {
      const id = it && it.id, clean = it && cleanMatch(it.data);
      if (!validId(id) || !clean) return json(400, { error: 'ongeldige match in lijst' });
      prepared.push({ id: id, data: clean });
    }
    const payload = JSON.stringify(prepared);
    const st = await db.prepare(
      'SELECT (SELECT COUNT(*) FROM matches) AS c, (SELECT COUNT(*) FROM matches WHERE id IN (SELECT json_extract(value, \'$.id\') FROM json_each(?))) AS e'
    ).bind(payload).first();
    const uniqueIds = new Set(prepared.map((p) => p.id)).size;
    if (Number(st.c) + (uniqueIds - Number(st.e)) > MAX_MATCHES) return json(507, { error: 'vol' });
    // een enkele query (D1 gratis: max 50 queries per aanvraag)
    const rev = await commit(db, [
      db.prepare('INSERT INTO matches (id, data) SELECT json_extract(value, \'$.id\'), json_extract(value, \'$.data\') FROM json_each(?) WHERE true ON CONFLICT(id) DO UPDATE SET data = excluded.data').bind(payload)
    ]);
    return json(200, { ok: true, count: prepared.length, rev: rev });
  }
  return json(404, { error: 'onbekend' });
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      if (e && e.status) return json(e.status, { error: e.error });
      console.log('FOUT', e && e.stack || e);
      return json(500, { error: 'serverfout' });
    }
  }
};
