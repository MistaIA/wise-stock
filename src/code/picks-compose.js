// US stock picks · step 3: build the Telegram message (HTML parse mode).
// Works with or without the AI paragraph: if the AI node failed, the numbers still go out.
const s = $('Screen & score').first().json;
let ai = '';
try {
  const out = $('AI explains the picks').first().json;
  ai = typeof out.text === 'string' && !out.error ? out.text.trim() : '';
} catch (e) {
  ai = '';
}

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (x, d = 1) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(d)}%`);
const signed = (x) => (x === null || x === undefined ? '' : ` (${x >= 0 ? '+' : ''}${Number(x).toFixed(2)}%)`);
const money = (x) =>
  x === null || x === undefined ? 'n/a' : `$${Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const medals = ['🥇', '🥈', '🥉', '4.', '5.'];

const lines = [];
lines.push(`🌙 <b>US stock picks</b> · ${esc(s.asOf)}`);
lines.push(
  `<i>Screen: debt &lt; ${pct(s.rules.maxDebtRatio, 0)} and cash &lt; ${pct(s.rules.maxCashRatio, 0)} of market cap, interest income &lt; ${pct(s.rules.maxInterestIncomeRatio, 0)} of revenue, no excluded business.</i>`,
);

const blocks = [lines.join('\n')];

if (!s.picks || s.picks.length === 0) {
  blocks.push('No ticker in the watchlist passed the screen today (or data was missing). See the list below.');
} else {
  s.picks.forEach((r, i) => {
    const m = r.metrics || {};
    const pe = m.earningsYield > 0 ? (1 / m.earningsYield).toFixed(1) : 'n/a';
    const b = [];
    b.push(`${medals[i]} <b>${esc(r.symbol)}</b> · ${esc(r.name)} · ${money(r.price)}${signed(r.changePct)}`);
    b.push(
      `Score <b>${r.score}/100</b> · ${m.rangePosition === null ? '52-week range n/a' : `at ${pct(m.rangePosition, 0)} of its 52-week range`}` +
        ` · revenue ${m.revenueGrowth === null ? 'n/a' : `${m.revenueGrowth >= 0 ? '+' : ''}${pct(m.revenueGrowth, 0)} YoY`}` +
        ` · net margin ${pct(m.netMargin, 0)} · P/E ${pe}`,
    );
    b.push(
      `🌙 Screen: debt ${pct(r.checks.debt.value)} ✅ · cash ${pct(r.checks.cash.value)} ✅ · interest income ${pct(r.checks.interestIncome.value)} ✅ (FY${esc(r.fiscalYear)})`,
    );
    if (r.notes && r.notes.length) b.push(`<i>Note: ${esc(r.notes.join('; '))}</i>`);
    blocks.push(b.join('\n'));
  });
}

const nPicks = (s.picks || []).length;
if (ai && nPicks) blocks.push(`🧠 <b>${nPicks === 1 ? 'Why this one' : `Why these ${nPicks}`}</b>\n${esc(ai)}`);

const tail = [];
tail.push(`Checked ${s.checked}: ${s.passedCount} passed, ${s.failed.length} failed, ${s.noData.length} without data.`);
if (s.failed.length) tail.push(`❌ ${s.failed.map((f) => `${esc(f.symbol)} (${esc(f.reason)})`).join('; ')}`);
if (s.noData.length) {
  // Group by reason, so a bad key or a plan limit is said once instead of once per ticker.
  const byReason = new Map();
  s.noData.forEach((f) => byReason.set(f.reason, [...(byReason.get(f.reason) || []), f.symbol]));
  tail.push(`⚪ ${[...byReason].map(([reason, syms]) => `${esc(syms.join(', '))}: ${esc(reason)}`).join('; ')}`);
}
blocks.push(tail.join('\n'));
blocks.push(
  '<i>🌙 passes the screen. Information only, not financial advice. Ratios use the latest annual statements and today\'s market cap.</i>',
);

// Telegram allows 4096 characters per message. Split on block boundaries, and inside a very long block on line
// boundaries, so every message keeps its HTML tags balanced (each line is built with balanced tags).
const MAX = 3900;
const fit = (line) =>
  line.length <= MAX ? line : line.replace(/<[^>]*>/g, '').slice(0, MAX - 1).replace(/&[#a-z0-9]*$/i, '') + '…';
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

return messages.map((text, i) => ({ json: { text, part: i + 1, parts: messages.length, data: i === 0 ? s : undefined } }));
