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

// Streaming platforms (TMDB provider ids, data from JustWatch).
// Some platforms have more than one id (e.g. plans with ads).
const PLATFORMS = {
  netflix: [8, 1796],
  disney: [337],
  prime: [119, 9, 2100],
  globoplay: [307],
  appletv: [350]
};
const PLATFORM_IDS = Object.keys(PLATFORMS);
const PROVIDER_TO_PLATFORM = Object.fromEntries(
  Object.entries(PLATFORMS).flatMap(([name, ids]) => ids.map(id => [id, name]))
);
const ALL_PROVIDERS = Object.keys(PROVIDER_TO_PLATFORM).join('|');
// Saved as "<platform>-<country>", e.g. "netflix-BR". Old entries have no country (= BR).
const PL_RE = new RegExp(`^(${Object.keys(PLATFORMS).join('|')})(-[A-Z]{2})?$`);

function regionsOf(env) {
  const list = String(env.REGIONS || 'BR,IE').split(',').map(r => r.trim().toUpperCase()).filter(r => /^[A-Z]{2}$/.test(r));
  return list.length ? list : ['BR'];
}

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
    if (Array.isArray(m.pl)) {
      const pl = [...new Set(m.pl.filter(x => typeof x === 'string' && PL_RE.test(x)))].slice(0, 20);
      if (pl.length) movie.pl = pl;
    }
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

// ---------- movie catalog (TMDB + JustWatch) ----------
// Search and platform catalogs come from TMDB. Availability ("where to
// watch") is TMDB's JustWatch data for the countries in env.REGIONS (BR,IE).
// Every answer is cached at the edge for 12h, so repeated searches and
// catalog pages don't call TMDB (or count much) again.

const TMDB = 'https://api.themoviedb.org/3';
const CACHE_SECONDS = 12 * 60 * 60;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// TMDB call with retry: TMDB answers 429 when too many requests come from the
// same (shared) Cloudflare IP, and occasionally 5xx.
async function tmdb(env, path, params = {}) {
  const url = new URL((env.TMDB_API || TMDB) + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    // Budget per incoming request: the free plan allows 50 subrequests.
    if (env.budget && env.budget.left-- <= 0) throw new Error('tmdb_budget');
    const res = await fetch(url, {
      headers: { authorization: 'Bearer ' + env.TMDB_TOKEN, accept: 'application/json' }
    });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    const canRetry = !env.budget || env.budget.left > 8;
    if (!retryable || attempt >= 2 || !canRetry) throw new Error('tmdb_' + res.status);
    const wait = Math.min(Number(res.headers.get('retry-after')) * 1000 || 400 * (attempt + 1), 2000);
    await sleep(wait);
  }
}

// Run fn over items with at most `limit` running at the same time.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// Platforms where the movie is included in the subscription, per country.
// One TMDB call returns every country, so more regions cost nothing extra.
// Result: ["netflix-BR", "netflix-IE", "prime-IE", ...]
async function platformsOf(env, id, regions) {
  try {
    const data = await tmdb(env, `/movie/${id}/watch/providers`);
    const out = [];
    for (const name of PLATFORM_IDS) {
      for (const region of regions) {
        const r = (data.results || {})[region] || {};
        const offers = [...(r.flatrate || []), ...(r.ads || [])];
        if (offers.some(o => PROVIDER_TO_PLATFORM[o.provider_id] === name)) out.push(`${name}-${region}`);
      }
    }
    return out;
  } catch {
    return null; // unknown (TMDB failed) - not the same as "on no platform"
  }
}

// Platforms for many movies, a few at a time. `failed` = lookups that errored.
async function platformsOfAll(env, movies, regions) {
  const pls = await mapLimit(movies, 4, m => platformsOf(env, m.id, regions));
  return { pls: pls.map(p => p || []), failed: pls.filter(p => p === null).length };
}

function toMovie(r) {
  const year = Number((r.release_date || '').slice(0, 4));
  const movie = { k: 'tmdb:' + r.id, id: r.id, t: r.title || r.original_title };
  if (year) movie.y = year;
  if (r.poster_path) movie.p = 'https://image.tmdb.org/t/p/w185' + r.poster_path;
  if (r.original_title && r.original_title !== movie.t) movie.o = r.original_title;
  return movie;
}

async function cached(request, compute) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const data = await compute();
  // If some platform lookups failed, the answer is incomplete: don't cache it.
  const complete = !data.failed;
  const response = new Response(JSON.stringify({ ok: true, ...data }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': complete ? `public, max-age=${CACHE_SECONDS}` : 'no-store'
    }
  });
  if (complete) await cache.put(key, response.clone());
  return response;
}

// GET /api/search?q=matrix
//   results: on Netflix / Disney+ / Prime in any region (with "pl")
//   others:  found, but not on those platforms right now
async function searchMovies(request, env, url) {
  if (!env.TMDB_TOKEN) return fail('tmdb_not_configured', 503);
  const q = cleanText(url.searchParams.get('q'), 80);
  if (q.length < 2) return json({ ok: true, results: [], others: [] });
  const regions = regionsOf(env);

  return cached(request, async () => {
    const data = await tmdb(env, '/search/movie', {
      query: q, language: 'pt-BR', include_adult: 'false', page: '1'
    });
    const top = (data.results || []).slice(0, 12).map(toMovie);
    const { pls, failed } = await platformsOfAll(env, top, regions);
    const results = [], others = [];
    top.forEach((m, i) => (pls[i].length ? results.push({ ...m, pl: pls[i] }) : others.push(m)));
    return { results, others, failed };
  });
}

// GET /api/catalog?platform=netflix&region=IE&page=1 -> popular movies there.
// region=all mixes every region (up to 12 movies of each per page).
async function catalog(request, env, url) {
  if (!env.TMDB_TOKEN) return fail('tmdb_not_configured', 503);
  const regions = regionsOf(env);
  const platform = url.searchParams.get('platform') || 'all';
  if (platform !== 'all' && !PLATFORMS[platform]) return fail('bad_platform');
  const region = (url.searchParams.get('region') || 'all').toUpperCase();
  if (region !== 'ALL' && !regions.includes(region)) return fail('bad_region');
  const page = Math.min(Math.max(parseInt(url.searchParams.get('page'), 10) || 1, 1), 50);
  const targets = region === 'ALL' ? regions : [region];
  // Stay well under the 50 subrequests per request limit of the free plan.
  const perRegion = Math.floor(20 / targets.length);

  return cached(request, async () => {
    const pages = await Promise.all(targets.map(r => tmdb(env, '/discover/movie', {
      language: 'pt-BR',
      watch_region: r,
      with_watch_providers: platform === 'all' ? ALL_PROVIDERS : PLATFORMS[platform].join('|'),
      with_watch_monetization_types: 'flatrate|ads',
      sort_by: 'popularity.desc',
      include_adult: 'false',
      page: String(page)
    }).catch(() => ({ results: [], total_pages: 0 }))));

    const seen = new Set();
    const movies = [];
    // Interleave regions so a mixed page shows both.
    for (let i = 0; i < perRegion; i++) {
      for (const p of pages) {
        const r = (p.results || [])[i];
        if (r && !seen.has(r.id)) { seen.add(r.id); movies.push(toMovie(r)); }
      }
    }

    const { pls, failed } = await platformsOfAll(env, movies, regions);
    const results = movies
      .map((m, i) => ({ ...m, pl: pls[i] }))
      .filter(m => m.pl.some(x => (platform === 'all' || x.startsWith(platform + '-')) &&
                                  (region === 'ALL' || x.endsWith('-' + region))));
    const more = pages.some(p => page < Math.min(p.total_pages || 0, 50));
    return { results, page, more, failed };
  });
}

// ---------- router ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'g', CODE, 'm', ID]
    const method = request.method;

    if (parts[0] !== 'api') return env.ASSETS.fetch(request);

    try {
      if (parts.length === 2 && method === 'GET') {
        env = { ...env, budget: { left: 45 } };
        if (parts[1] === 'search') return await searchMovies(request, env, url);
        if (parts[1] === 'catalog') return await catalog(request, env, url);
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
