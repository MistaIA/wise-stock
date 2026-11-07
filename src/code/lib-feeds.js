// ---- Shared feed helpers (src/code/lib-feeds.js, pasted in by the build; also in SM-03 "Find what is new") ----
// Reads RSS feeds: Google News headlines, and X (Twitter) posts through a Nitter mirror. Rates each headline or post
// with a few keywords; the AI's own rating replaces it when an AI key is set.
const FEEDS = (() => {
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  const decode = (s) =>
    String(s ?? '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      });
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? decode(m[1]).replace(/\s+/g, ' ').trim() : '';
  };

  // The items of an RSS 2.0 feed, or null when the answer is not a feed (an error page, or a mirror's bot check).
  function parse(text) {
    const xml = String(text || '');
    if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml)) return null;
    return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((m) => ({
      title: tag(m[1], 'title'),
      link: tag(m[1], 'link'),
      source: tag(m[1], 'source'),
      creator: tag(m[1], 'dc:creator'),
      ts: Date.parse(tag(m[1], 'pubDate')),
    }));
  }

  // Google News titles end with " - Source"; some sites add their own separator before it ("... IPO | - Site").
  function splitTitle(raw, sourceTag) {
    let title = String(raw || '').replace(/\s+/g, ' ').trim();
    let source = String(sourceTag || '').replace(/\s+/g, ' ').trim();
    if (source) {
      if (title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    } else {
      const i = title.lastIndexOf(' - ');
      if (i > 0) {
        source = title.slice(i + 3);
        title = title.slice(0, i);
      }
    }
    return { title: title.replace(/[\s|\-–—:·•]+$/, '') || title, source: source.replace(/^[\s|\-–—:·•]+/, '') };
  }

  // Keyword rating, English and French: 1 good news, -1 bad news, 0 neither or both.
  const GOOD = /\b(gain|rise|rising|rose|rall|surg|jump|soar|climb|profit|growth|grow|upgrad|beat|boost|bullish|dividend|expan|approv|outperform|hausse|progress|bondi|grimp|b[ée]n[ée]fice|croissance|envol|rebond|reprise)/gi;
  const BAD = /\b(fall|fell|drop|declin|slump|plung|tumbl|slid|loss|lose|losing|downgrad|weak|bearish|crash|default|fraud|probe|suspen|halt|sanction|warn|crisis|underperform|baisse|recul|chute|perte|plong|d[ée]gringol|effondr|d[ée]faut|repli)/gi;
  const rate = (text) => {
    const t = String(text || '');
    const score = (t.match(GOOD) || []).length - (t.match(BAD) || []).length;
    return score > 0 ? 1 : score < 0 ? -1 : 0;
  };

  const key = (t) =>
    String(t)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const recent = (ts, now, hours) => Number.isFinite(ts) && ts >= now - hours * 3600e3 && ts <= now + 3600e3;

  // Newest first, de-duplicated (the same story from several sites), within the last `hours`.
  function headlines(items, { now, hours, max }) {
    const seen = new Set();
    const out = [];
    for (const it of items || []) {
      if (!it || !it.title || !recent(it.ts, now, hours)) continue;
      const { title, source } = splitTitle(it.title, it.source);
      const k = key(title);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push({ title, source, link: it.link || '', ts: it.ts, kw: rate(title) });
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, max);
  }

  // Nitter search feed: the title is the post's text, dc:creator its author.
  function posts(items, { now, hours, max }) {
    const seen = new Set();
    const out = [];
    for (const it of items || []) {
      if (!it || !recent(it.ts, now, hours)) continue;
      const text = String(it.title || '')
        .replace(/^(RT by|R to) @\w+:\s*/i, '')
        .trim();
      const k = key(text).slice(0, 80);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push({
        text: text.length > 280 ? `${text.slice(0, 279)}…` : text,
        user: String(it.creator || '').replace(/^@/, '') || 'unknown',
        link: String(it.link || '').replace(/#m$/, ''),
        ts: it.ts,
        kw: rate(text),
      });
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, max);
  }

  const errorText = (e) =>
    String(typeof e === 'string' ? e : (e && (e.message || e.description)) || 'request failed')
      .replace(/\s+/g, ' ')
      .slice(0, 160);
  const host = (u) => String(u || '').replace(/^https?:\/\//i, '');
  const staticData = () => {
    try {
      return typeof $getWorkflowStaticData === 'function' ? $getWorkflowStaticData('global') : null;
    } catch (e) {
      return null;
    }
  };

  // The X searches of "X feed list", fetched by "Fetch X posts" (same order). The mirror that answered stays first
  // for the next run; one that did not answer hands over to the next mirror in Config → xMirrors.
  function readX({ now, hours, max }) {
    let asked;
    try {
      asked = $('X feed list').all().map((i) => i.json);
    } catch (e) {
      return { state: 'off', why: 'the X step did not run', markets: {} };
    }
    const head = asked[0] || {};
    if (head.off || !head.url) return { state: 'off', why: head.why || 'X posts are off', markets: {} };
    let got = [];
    try {
      got = $('Fetch X posts').all().map((i) => i.json);
    } catch (e) {
      got = [];
    }
    const markets = {};
    let answered = 0;
    let problem = '';
    asked.forEach((q, i) => {
      const r = got[i] || { error: 'no answer' };
      const items = r.error ? null : parse(r.xRaw);
      if (!items) {
        problem = r.error ? errorText(r.error) : 'it sent a web page instead of a feed (busy, or a bot check)';
        markets[q.market] = { query: q.query, posts: [], error: problem };
        return;
      }
      answered++;
      markets[q.market] = { query: q.query, posts: posts(items, { now, hours, max }) };
    });
    const ok = answered > 0;
    const sd = staticData();
    if (sd) sd.xMirror = ok ? head.mirror : head.next;
    return { state: ok ? 'ok' : 'failed', mirror: host(head.mirror), next: ok || head.next === head.mirror ? null : host(head.next), error: ok ? null : problem, markets };
  }

  return { parse, splitTitle, rate, headlines, posts, readX, errorText, staticData };
})();
// ---- end of the shared feed helpers ----
