// =========================================
// JÁ VI — shared "movies I've watched" lists
//
// KV layout (binding FILMES):
//   g:<CODE>        group index
//                   { name, created, members: { <id>: { n, c, u } } }
//                   n = name, c = movie count, u = last update (ms)
//   m:<CODE>:<ID>   one member
//                   { n, h (token hash), movies: [{ k, t, y, p, a }] }
//
// Each member writes only their own key, so lists never overwrite each
// other. The index is small and self-heals: every save re-writes the
// member's own entry in it.
//
// Low usage by design:
//   - static files never run the Worker (see wrangler.jsonc)
//   - the client batches edits into a single save
//   - no polling; the client refreshes only when it becomes visible again
// =========================================

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-Z2-9]{6,10}$/;
const ID_RE = /^[a-z0-9]{8,16}$/;

const MAX_MEMBERS = 60;
const MAX_MOVIES = 3000;
const MAX_BODY = 400_000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });

const fail = (error, status = 400) => json({ ok: false, error }, status);

function randomString(alphabet, length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function cleanMovies(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  const out = [];
  for (const m of list.slice(0, MAX_MOVIES)) {
    if (!m || typeof m !== 'object') continue;
    const k = cleanText(m.k, 80);
    const t = cleanText(m.t, 150);
    if (!k || !t || seen.has(k)) continue;
    seen.add(k);
    const movie = { k, t };
    const y = Number(m.y);
    if (Number.isInteger(y) && y > 1870 && y < 2200) movie.y = y;
    const p = cleanText(m.p, 300);
    if (p.startsWith('https://')) movie.p = p;
    const a = Number(m.a);
    movie.a = Number.isFinite(a) && a > 0 ? Math.floor(a) : Date.now();
    out.push(movie);
  }
  return out;
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    return JSON.parse(text || '{}');
  } catch {
    return null;
  }
}

const getIndex = (env, code) => env.FILMES.get('g:' + code, 'json');
const putIndex = (env, code, index) => env.FILMES.put('g:' + code, JSON.stringify(index));
const memberKey = (code, id) => `m:${code}:${id}`;

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

// ---------- handlers ----------

async function createGroup(request, env) {
  const body = (await readBody(request)) || {};
  const name = cleanText(body.name, 40) || 'Nosso grupo';

  for (let i = 0; i < 5; i++) {
    const code = randomString(CODE_ALPHABET, 7);
    if (await getIndex(env, code)) continue;
    await putIndex(env, code, { name, created: Date.now(), members: {} });
    return json({ ok: true, code, name });
  }
  return fail('try_again', 503);
}

async function joinGroup(request, env, code, index) {
  const body = await readBody(request);
  const name = cleanText(body && body.name, 30);
  if (!name) return fail('name_required');
  if (Object.keys(index.members).length >= MAX_MEMBERS) return fail('group_full', 409);

  const id = randomString('abcdefghijklmnopqrstuvwxyz0123456789', 10);
  const token = randomString('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 32);

  await env.FILMES.put(memberKey(code, id), JSON.stringify({
    n: name,
    h: await sha256(token),
    movies: []
  }));

  index.members[id] = { n: name, c: 0, u: Date.now() };
  await putIndex(env, code, index);

  return json({ ok: true, id, token, name });
}

async function getMember(env, code, id) {
  const member = await env.FILMES.get(memberKey(code, id), 'json');
  if (!member) return fail('member_not_found', 404);
  return json({ ok: true, id, name: member.n, movies: member.movies || [] });
}

async function saveMember(request, env, code, id, index) {
  const token = bearer(request);
  if (!token) return fail('unauthorized', 401);

  const member = await env.FILMES.get(memberKey(code, id), 'json');
  if (!member) return fail('member_not_found', 404);
  if (member.h !== (await sha256(token))) return fail('unauthorized', 401);

  const body = await readBody(request);
  if (!body) return fail('bad_body');

  const movies = body.movies === undefined ? member.movies || [] : cleanMovies(body.movies);
  if (!movies) return fail('bad_movies');
  const name = cleanText(body.name, 30) || member.n;

  await env.FILMES.put(memberKey(code, id), JSON.stringify({ n: name, h: member.h, movies }));

  const entry = index.members[id];
  if (!entry || entry.n !== name || entry.c !== movies.length) {
    index.members[id] = { n: name, c: movies.length, u: Date.now() };
    await putIndex(env, code, index);
  }

  return json({ ok: true, name, count: movies.length });
}

async function leaveGroup(request, env, code, id, index) {
  const token = bearer(request);
  const member = await env.FILMES.get(memberKey(code, id), 'json');
  if (!member) return fail('member_not_found', 404);
  if (!token || member.h !== (await sha256(token))) return fail('unauthorized', 401);

  await env.FILMES.delete(memberKey(code, id));
  delete index.members[id];
  await putIndex(env, code, index);
  return json({ ok: true });
}

// ---------- IMDb search (fallback proxy) ----------
// The browser calls IMDb's suggestion endpoint directly. This proxy is only
// used if that is blocked, and answers are cached at the edge for a day.

export function imdbUrl(q) {
  const clean = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const first = /[a-z0-9]/.test(clean[0]) ? clean[0] : 'x';
  return `https://v2.sg.media-imdb.com/suggestion/${first}/${encodeURIComponent(clean)}.json`;
}

async function imdbSearch(request, url) {
  const q = cleanText(url.searchParams.get('q'), 80);
  if (q.length < 2) return json({ ok: true, d: [] });

  const cacheKey = new Request(`https://imdb-cache.local/${encodeURIComponent(q.toLowerCase())}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const res = await fetch(imdbUrl(q), { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' } });
  if (!res.ok) return fail('imdb_unavailable', 502);
  const data = await res.json();

  const response = new Response(JSON.stringify({ ok: true, d: data.d || [] }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=86400'
    }
  });
  await cache.put(cacheKey, response.clone());
  return response;
}

// ---------- router ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'g', CODE, 'm', ID]
    const method = request.method;

    if (parts[0] !== 'api') return env.ASSETS.fetch(request);

    try {
      if (parts.length === 2 && parts[1] === 'imdb' && method === 'GET') {
        return await imdbSearch(request, url);
      }

      if (parts.length === 2 && parts[1] === 'g' && method === 'POST') {
        return await createGroup(request, env);
      }

      if (parts[1] !== 'g' || !parts[2]) return fail('not_found', 404);

      const code = parts[2].toUpperCase();
      if (!CODE_RE.test(code)) return fail('group_not_found', 404);

      const index = await getIndex(env, code);
      if (!index) return fail('group_not_found', 404);

      // GET /api/g/CODE -> group name + members (with counts)
      if (parts.length === 3 && method === 'GET') {
        return json({ ok: true, code, name: index.name, members: index.members });
      }

      // POST /api/g/CODE/join -> new member
      if (parts.length === 4 && parts[3] === 'join' && method === 'POST') {
        return await joinGroup(request, env, code, index);
      }

      if (parts.length === 5 && parts[3] === 'm' && ID_RE.test(parts[4])) {
        const id = parts[4];
        if (method === 'GET') return await getMember(env, code, id);
        if (method === 'PUT') return await saveMember(request, env, code, id, index);
        if (method === 'DELETE') return await leaveGroup(request, env, code, id, index);
      }

      return fail('not_found', 404);
    } catch (err) {
      return fail('server_error', 500);
    }
  }
};
