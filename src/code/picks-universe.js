// US stock picks · step 1
// Turns the comma-separated watchlist from the Config node into one item per ticker,
// so the FMP HTTP nodes below run once per ticker (index-aligned with this node).
const cfg = $('Config').first().json;

const symbols = String(cfg.universe || '')
  .split(/[\s,;]+/)
  .map((s) => s.trim().toUpperCase())
  .filter((s) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s));

const unique = [...new Set(symbols)];
if (unique.length === 0) {
  throw new Error('Config → universe is empty. List US tickers, for example "AAPL,MSFT,NVDA".');
}

return unique.map((symbol) => ({ json: { symbol } }));
