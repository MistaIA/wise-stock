// Dangote watch · Telegram message (HTML parse mode), with or without the AI part.
// #include lib-compose
const f = $('Find what is new').first().json;
const cfg = $('Config').first().json;
const { json: ai, text: aiText } = TG.aiAnswer('AI summary');
const rated = ai && ai.sentiment && typeof ai.sentiment === 'object' && !Array.isArray(ai.sentiment) ? ai.sentiment : {};
const byAi = Object.keys(rated).length > 0;
const summary = ai ? (typeof ai.summary === 'string' ? ai.summary.trim() : '') : TG.looksLikeJson(aiText) ? '' : aiText;

const { esc, link } = TG;
const now = $now.toMillis();
const ch = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '' : ` (${x > 0 ? '+' : ''}${x.toFixed(2)}%)`);
const naira = (x) => (Number.isFinite(x) ? `₦${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'n/a');
const rate = (item) => (item.id in rated ? TG.rating(rated[item.id]) : item.kw || 0);
const articles = f.articles || [];
const posts = f.x && f.x.state === 'ok' ? f.posts || [] : [];

const blocks = [`🛢️ <b>Dangote watch</b> · ${esc($now.setZone('Africa/Lagos').toFormat('ccc d LLL yyyy, HH:mm'))} WAT`];

if (f.newListings.length) {
  blocks.push(
    `🚨 <b>New Dangote listing on NGX</b>\n${f.newListings.map((s) => `${esc(s.symbol)} · ${esc(s.name)} · ${naira(s.close)}${ch(s.changePct)}`).join('\n')}\n<i>Add the ticker to the Africa brief watchlist (Config → ngxWatchlist).</i>`,
  );
}

if (summary) blocks.push(`🧠 <b>What it means</b>\n${esc(summary)}`);

const mood = TG.mood([...articles, ...posts].map(rate));
if (mood) blocks.push(`🧭 <b>Mood:</b> ${mood.label} · ${mood.good} good, ${mood.bad} bad, ${mood.neutral} neutral (headlines and X posts)`);

if (articles.length) {
  blocks.push(
    `📰 <b>Headlines (last ${f.lookbackHours} h)</b>\n` +
      articles.map((a) => `${TG.dot(rate(a))} ${link(a.link, esc(a.title))}${a.source ? ` · ${esc(a.source)}` : ''} · ${TG.ago(a.ts, now)}`).join('\n'),
  );
} else {
  blocks.push(`📰 No new headlines in the last ${f.lookbackHours} h.`);
}

if (f.x && f.x.state === 'ok') {
  if (posts.length) {
    blocks.push(
      `𝕏 <b>On X (last ${f.lookbackHours} h)</b>: ${posts.length} post${posts.length === 1 ? '' : 's'}, latest:\n` +
        posts
          .slice(0, 3)
          .map((p) => `${TG.dot(rate(p))} ${link(p.link, `@${esc(p.user)}`)}: ${esc(TG.short(p.text, 200))} · ${TG.ago(p.ts, now)}`)
          .join('\n'),
    );
  } else blocks.push(`𝕏 No posts on X in the last ${f.lookbackHours} h.`);
}

if (f.shares.length) {
  blocks.push(`📈 <b>Dangote shares on NGX</b>${f.session ? ` · ${esc(f.session)}` : ''}\n${f.shares.map((s) => `${esc(s.symbol)} ${naira(s.close)}${ch(s.changePct)}`).join(' · ')}`);
}
if (cfg.ipoNote) blocks.push(`ℹ️ <i>${esc(cfg.ipoNote)}</i>`);
const problems = [
  f.newsError && `News: ${f.newsError}`,
  f.ngxError && `NGX: ${f.ngxError}`,
  f.x && f.x.state === 'failed' && `X posts: no answer from ${f.x.mirror} (${f.x.error})${f.x.next ? `; the next run tries ${f.x.next}` : ''}`,
].filter(Boolean);
if (problems.length) blocks.push(`⚠️ ${esc(problems.join(' · '))}`);
blocks.push(`<i>${mood ? `Mood and dots: rated ${byAi ? 'by the AI' : 'by keywords (no AI rating today)'}. ` : ''}Information only, not financial advice.</i>`);

const messages = TG.split(blocks);
const data = { ...f, ipoNote: cfg.ipoNote || null, ai: ai ? { summary, sentiment: rated } : null };
return messages.map((text, i) => ({ json: { text, part: i + 1, parts: messages.length, data: i === 0 ? data : undefined } }));
