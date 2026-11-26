// 모의거래 서버 저장 (KV 바인딩 TX). 키 = 코드의 SHA-256 해시(64자리 hex).
const OK = /^[0-9a-f]{64}$/;
const H = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });
const valid = (v) => v && typeof v === 'object' && v.pos && typeof v.pos === 'object' && Array.isArray(v.hist) && isFinite(v.realized);

export async function onRequest({ request, env }) {
  if (!env.TX) return J({ error: 'no kv' }, 500);
  const url = new URL(request.url);
  const h = url.searchParams.get('h') || '';
  if (!OK.test(h)) return J({ error: 'bad key' }, 400);
  const key = 's:' + h;
  if (request.method === 'GET') {
    const v = await env.TX.get(key);
    return v ? new Response(v, { headers: H }) : J({ error: 'none' }, 404);
  }
  if (request.method === 'PUT') {
    const body = await request.text();
    if (body.length > 100000) return J({ error: 'too big' }, 413);
    let o; try { o = JSON.parse(body); } catch (e) { return J({ error: 'bad json' }, 400); }
    if (!valid(o) || o.hist.length > 2000) return J({ error: 'bad state' }, 400);
    await env.TX.put(key, JSON.stringify({ realized: o.realized, pos: o.pos, hist: o.hist }));
    return J({ ok: true });
  }
  return J({ error: 'method' }, 405);
}
