// ---- Shared Telegram helpers (src/code/lib-compose.js, pasted in by the build; also in SM-03 "Compose message") ----
const TG = (() => {
  const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const attr = (t) => esc(t).replace(/"/g, '&quot;');
  // A link only for a real web address: Telegram refuses a whole message with a broken href.
  const link = (url, text) => (/^https?:\/\/\S+$/i.test(String(url || '')) ? `<a href="${attr(url)}">${text}</a>` : text);

  // The AI is asked for JSON; models sometimes wrap it in ``` fences or add a sentence around it.
  function aiJson(text) {
    const t = String(text || '');
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
      const j = JSON.parse(t.slice(a, b + 1));
      return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
    } catch (e) {
      return null;
    }
  }
  // An answer that was meant to be JSON but could not be read is not shown as text.
  const looksLikeJson = (text) => /^\s*(```|\{)/.test(String(text || ''));
  // The answer of the AI step (a Basic LLM Chain): { json, text }. With OpenAI's JSON mode the chain (v1.6+) parses the
  // answer itself and the item IS the object; otherwise the answer is text in "text" (JSON, maybe in a ``` fence, or
  // plain words). A failed step (no key, quota) or one that did not run gives neither.
  function aiAnswer(nodeName) {
    let out;
    try {
      out = $(nodeName).first().json;
    } catch (e) {
      return { json: null, text: '' };
    }
    if (!out || typeof out !== 'object' || out.error) return { json: null, text: '' };
    if (typeof out.text === 'string') return { json: aiJson(out.text), text: out.text.trim() };
    return { json: !Array.isArray(out) && Object.keys(out).length ? out : null, text: '' };
  }
  const rating = (v) => {
    if (typeof v === 'number') return v > 0 ? 1 : v < 0 ? -1 : 0;
    const s = String(v ?? '').trim().toLowerCase();
    if (/^(\+?1\b|pos|good|bull)/.test(s)) return 1;
    if (/^(-1\b|neg|bad|bear)/.test(s)) return -1;
    return 0;
  };
  const dot = (s) => (s > 0 ? '🟢' : s < 0 ? '🔴' : '⚪');
  // The mood of rated items (1 good, -1 bad, 0 neutral): share of good news minus share of bad news.
  function mood(ratings) {
    const n = ratings.length;
    if (!n) return null;
    const good = ratings.filter((s) => s > 0).length;
    const bad = ratings.filter((s) => s < 0).length;
    const score = (good - bad) / n;
    const label = score >= 0.25 ? '🟢 positive' : score <= -0.25 ? '🔴 negative' : good + bad === 0 ? '⚪ neutral' : '🟡 mixed';
    return { label, good, bad, neutral: n - good - bad, n };
  }
  const ago = (ts, now) => {
    const h = (now - ts) / 3600000;
    const min = Math.round(h * 60);
    return min < 60 ? `${Math.max(1, min)} min ago` : h < 47.5 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
  };
  const short = (t, n) => (String(t).length > n ? `${String(t).slice(0, n - 1).trimEnd()}…` : String(t));

  // Telegram allows 4096 characters per message. Split on block boundaries, and inside a very long block on line
  // boundaries, so every message keeps its HTML tags balanced (each line is built with balanced tags).
  function split(blocks, MAX = 3900) {
    const fit = (line) => (line.length <= MAX ? line : line.replace(/<[^>]*>/g, '').slice(0, MAX - 1).replace(/&[#a-z0-9]*$/i, '') + '…');
    const messages = [];
    let current = '';
    const push = (piece, sep) => {
      if (current && current.length + sep.length + piece.length > MAX) {
        messages.push(current);
        current = piece;
      } else {
        current = current ? current + sep + piece : piece;
      }
    };
    for (const block of blocks) {
      if (block.length <= MAX) push(block, '\n\n');
      else block.split('\n').map(fit).forEach((line, i) => push(line, i === 0 ? '\n\n' : '\n'));
    }
    if (current) messages.push(current);
    return messages;
  }
  return { esc, attr, link, aiJson, looksLikeJson, aiAnswer, rating, dot, mood, ago, short, split };
})();
// ---- end of the shared Telegram helpers ----
