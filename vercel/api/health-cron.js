// Daily check that n8n is up (vercel.json → crons; the Hobby plan allows one run a day). When n8n does not answer,
// a Telegram message says so, because then no brief is sent either.
// Environment (Vercel → Settings → Environment Variables):
//   N8N_BASE_URL        https://<your n8n>/
//   CRON_SECRET         any long random text; Vercel sends it as "Authorization: Bearer <CRON_SECRET>" to cron runs
//   TELEGRAM_BOT_TOKEN  optional, with TELEGRAM_CHAT_ID: where the alert goes (same bot and chat as n8n)
const ATTEMPTS = 3; // n8n may be restarting; 3 × 15 s + 2 × 5 s stays within the 60 s vercel.json allows
const TIMEOUT_MS = 15_000;
const PAUSE_MS = 5_000;
export const timing = { pause: (ms) => new Promise((r) => setTimeout(r, ms)) };

export async function GET(request) {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) return new Response('unauthorized', { status: 401 });
  const base = (process.env.N8N_BASE_URL || '').trim();
  if (!/^https?:\/\//.test(base)) return Response.json({ ok: false, error: 'N8N_BASE_URL is not set' }, { status: 500 });
  const health = new URL('healthz', base.endsWith('/') ? base : `${base}/`).toString();

  let ok = false;
  let detail = '';
  for (let attempt = 1; attempt <= ATTEMPTS && !ok; attempt++) {
    try {
      const r = await fetch(health, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      ok = r.ok;
      detail = `HTTP ${r.status}`;
    } catch (e) {
      detail = e && e.name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS / 1000} s` : String((e && e.cause && e.cause.code) || (e && e.message) || e);
    }
    if (!ok && attempt < ATTEMPTS) await timing.pause(PAUSE_MS);
  }

  let alerted = false;
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chat = (process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!ok && token && chat) {
    const text = `⚠️ n8n is not answering (${health}: ${detail}, ${ATTEMPTS} tries). The market briefs are not sent until it is back.`;
    try {
      const t = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      alerted = t.ok;
    } catch {}
  }
  return Response.json({ ok, checked: health, detail, alerted }, { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
