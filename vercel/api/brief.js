// GET /api/brief: the two briefs from n8n ("SM-04 · Market brief API"), cached by Vercel's CDN.
// Environment (Vercel → Settings → Environment Variables):
//   N8N_BASE_URL   https://<your n8n>/ : the briefs come from <N8N_BASE_URL>/webhook/market-brief
//   BRIEF_SECRET   the same value as the n8n credential "Market brief secret" (BRIEF_SECRET on the n8n side)
//   N8N_BRIEF_URL  optional: the full webhook URL, only when it is not <N8N_BASE_URL>/webhook/market-brief
// Each n8n run costs about 30 FMP calls (the free plan has 250 a day), so a brief is served from the CDN for 6 hours,
// then served stale for up to a day while one request refreshes it. Errors are never cached.
// One n8n run (SM-02 then SM-01, live sources and AI) can take a minute or more, so vercel.json gives this function
// 300 s (Fluid compute, the Hobby maximum) and n8n gets 280 s of it.
export const CACHE = 'public, s-maxage=21600, stale-while-revalidate=86400';
const TIMEOUT_MS = 280_000;

// The SM-04 webhook URL from the environment, or '' when it is not set (or not an http(s) URL).
export function briefUrl(env) {
  const explicit = String(env.N8N_BRIEF_URL || '').trim();
  if (explicit) return /^https?:\/\//.test(explicit) ? explicit : '';
  const base = String(env.N8N_BASE_URL || '').trim();
  if (!/^https?:\/\//.test(base)) return '';
  try {
    return new URL('webhook/market-brief', base.endsWith('/') ? base : `${base}/`).toString();
  } catch {
    return '';
  }
}

const json = (data, status, cache) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache } });

export async function GET(request) {
  const url = new URL(request.url);
  // One cache entry only: /api/brief?anything would be a new cache key and a new n8n run each time.
  if (url.search) return Response.redirect(new URL('/api/brief', url), 308);

  const target = briefUrl(process.env);
  const secret = (process.env.BRIEF_SECRET || '').trim();
  if (!target || !secret) {
    return json({ error: 'Set N8N_BASE_URL (n8n\'s https address) and BRIEF_SECRET in Vercel → Settings → Environment Variables, then redeploy.' }, 500, 'no-store');
  }
  let r;
  try {
    r = await fetch(target, { headers: { 'X-Brief-Secret': secret, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const why = e && e.name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS / 1000} s` : String((e && e.cause && e.cause.code) || (e && e.message) || e);
    return json({ error: `n8n did not answer (${why}). Is it running?` }, 502, 'no-store');
  }
  if (!r.ok) {
    const hint =
      r.status === 401 || r.status === 403
        ? ': BRIEF_SECRET here differs from the n8n credential "Market brief secret"'
        : r.status === 404
          ? ': SM-04 is not published in n8n, or N8N_BASE_URL is wrong'
          : '';
    return json({ error: `n8n answered HTTP ${r.status}${hint}` }, 502, 'no-store');
  }
  let body;
  try {
    body = await r.json();
  } catch {
    return json({ error: 'n8n answered, but not with JSON' }, 502, 'no-store');
  }
  if (!body || typeof body !== 'object' || !('picks' in body || 'africa' in body)) return json({ error: 'n8n answered JSON without the briefs' }, 502, 'no-store');
  return json(body, 200, CACHE);
}
