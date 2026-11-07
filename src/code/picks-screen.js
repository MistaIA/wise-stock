// US stock picks · step 2: the screen + a transparent "potential" score.
// Deterministic on purpose: the AI only explains these numbers afterwards, it never decides who passes.
// Inputs are index-aligned (one item per ticker): Universe, FMP profile, FMP balance sheet, FMP income statement.
const cfg = $('Config').first().json;
const universe = $('Universe').all().map((i) => i.json.symbol);
const profiles = $('FMP profile').all();
const balances = $('FMP balance sheet').all();
const incomes = $('FMP income statement').all();

const num = (v, d = null) => {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const MAX_DEBT = num(cfg.maxDebtRatio, 0.3); // interest-bearing debt < 30% of market cap
const MAX_CASH = num(cfg.maxCashRatio, 0.3); // interest-bearing cash/securities < 30% of market cap
const MAX_IMPURE = num(cfg.maxInterestIncomeRatio, 0.05); // interest income < 5% of revenue
const TOP_N = Math.min(5, Math.max(1, Math.round(num(cfg.topN, 2))));

// Business-activity screen, the usual index-provider rules. Conservative: defence and entertainment are excluded too.
const EXCLUDED_SECTOR = /^financial services$/i;
const EXCLUDED_INDUSTRY =
  /bank|insurance|mortgage|credit services|capital markets|asset management|financial -|brewer|winer|distill|alcohol|tobacco|gambling|casino|adult|entertainment|aerospace & defense|defen[cs]e|weapon/i;

// Short, actionable reasons for the Telegram message instead of raw API errors.
const friendly = (text) => {
  const t = String(text || '');
  if (/payment required|\b402\b|subscription|premium|upgrade your plan/i.test(t)) return 'not in your FMP plan (the free plan covers a sample of large US tickers)';
  if (/authoriz|\b401\b|\b403\b|forbidden|invalid api ?key/i.test(t)) return 'FMP refused the key (check the "FMP API key" credential)';
  if (/too many requests|\b429\b|limit reach/i.test(t)) return 'FMP daily call limit reached';
  return t.slice(0, 160) || 'request failed';
};
// One FMP response (HTTP node in text mode, so one item per ticker) → rows, or a reason why there are none.
// A failed request arrives as { error: "text" } or { error: { message, description } }.
function parseFmp(item) {
  const j = (item && item.json) || {};
  if (j.error) {
    const e = j.error;
    return { error: friendly(typeof e === 'string' ? e : [e.message, e.description].filter(Boolean).join(': ')) };
  }
  let body = j.raw;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return { error: /premium|subscription/i.test(body) ? friendly(body) : 'response was not JSON' };
    }
  }
  if (body && !Array.isArray(body) && typeof body === 'object') {
    const m = body['Error Message'] || body.error || body.message;
    return { error: m ? friendly(m) : 'unexpected response' };
  }
  if (!Array.isArray(body) || body.length === 0) {
    return { error: 'no data (ticker may be outside your FMP plan)' };
  }
  return { rows: body };
}

const results = universe.map((symbol, i) => {
  // The profile alone decides ETFs and excluded businesses, even when the statements are missing (FMP has none for ETFs).
  const p = parseFmp(profiles[i]);
  if (p.error) return { symbol, status: 'no-data', reason: p.error };
  const prof = p.rows[0];
  if (prof.isEtf || prof.isFund) return { symbol, name: prof.companyName || symbol, status: 'fail', reason: 'ETF or fund, screen the holdings instead' };
  const sector = prof.sector || '';
  const industry = prof.industry || '';
  if (EXCLUDED_SECTOR.test(sector) || EXCLUDED_INDUSTRY.test(industry)) {
    return { symbol, name: prof.companyName || symbol, sector, industry, status: 'fail', reason: `business activity: ${industry || sector}` };
  }

  const b = parseFmp(balances[i]);
  const s = parseFmp(incomes[i]);
  const failed = [b, s].find((r) => r.error);
  if (failed) return { symbol, status: 'no-data', reason: failed.error };
  const bs = b.rows[0];
  const is0 = s.rows[0];
  const is1 = s.rows[1];

  const price = num(prof.price);
  const marketCap = num(prof.marketCap);
  const name = prof.companyName || symbol;
  const range = String(prof.range || '').split('-').map((v) => num(v));
  const low = range.length === 2 ? range[0] : null;
  const high = range.length === 2 ? range[1] : null;

  const debt = num(bs.totalDebt, 0);
  const cash =
    num(bs.cashAndShortTermInvestments) ?? num(bs.cashAndCashEquivalents, 0) + num(bs.shortTermInvestments, 0);
  const revenue = num(is0.revenue);
  const interestIncome = num(is0.interestIncome);
  const netIncome = num(is0.netIncome);
  const prevRevenue = is1 ? num(is1.revenue) : null;
  const fiscalYear = is0.fiscalYear || is0.calendarYear || String(is0.date || '').slice(0, 4);

  const base = { symbol, name, sector, industry, price, marketCap, changePct: num(prof.changePercentage), fiscalYear };

  if (!marketCap || marketCap <= 0 || !revenue || revenue <= 0) {
    return { ...base, status: 'no-data', reason: 'missing market cap or revenue' };
  }

  const debtRatio = debt / marketCap;
  const cashRatio = cash / marketCap;
  const impureRatio = interestIncome === null ? null : Math.max(0, interestIncome) / revenue;
  const checks = {
    debt: { value: debtRatio, limit: MAX_DEBT, pass: debtRatio < MAX_DEBT },
    cash: { value: cashRatio, limit: MAX_CASH, pass: cashRatio < MAX_CASH },
    interestIncome: { value: impureRatio, limit: MAX_IMPURE, pass: impureRatio === null ? true : impureRatio < MAX_IMPURE },
  };
  const failedChecks = Object.entries(checks).filter(([, c]) => !c.pass);
  const pctTxt = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  const metrics = {
    rangePosition: low !== null && high !== null && high > low && price ? (price - low) / (high - low) : null,
    revenueGrowth: prevRevenue && prevRevenue > 0 ? revenue / prevRevenue - 1 : null,
    netMargin: netIncome !== null ? netIncome / revenue : null,
    earningsYield: netIncome !== null ? netIncome / marketCap : null,
    low,
    high,
  };
  const notes = impureRatio === null ? ['interest income not reported, counted as 0'] : [];
  if (failedChecks.length) {
    const why = failedChecks.map(([k, c]) => `${k} ${pctTxt(c.value)} ≥ ${pctTxt(c.limit)}`).join(', ');
    return { ...base, status: 'fail', reason: `financial ratios: ${why}`, checks, metrics };
  }
  return { ...base, status: 'pass', checks, metrics, notes };
});

// Rank-normalised score (0..100) among the stocks that passed. Weights are deliberately simple and visible.
const passed = results.filter((r) => r.status === 'pass');
const WEIGHTS = { rangePosition: 0.35, revenueGrowth: 0.25, netMargin: 0.2, earningsYield: 0.2 };
function rankScores(key) {
  const vals = passed.map((r) => r.metrics[key]);
  const valid = vals.filter((v) => v !== null).sort((a, b) => a - b);
  return vals.map((v) => {
    if (v === null) return 0.5; // unknown → neutral
    if (valid.length <= 1) return 1;
    return valid.indexOf(v) / (valid.length - 1);
  });
}
const parts = Object.fromEntries(Object.keys(WEIGHTS).map((k) => [k, rankScores(k)]));
passed.forEach((r, idx) => {
  r.score = Math.round(100 * Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + w * parts[k][idx], 0));
});
passed.sort((a, b) => b.score - a.score);
const picks = passed.slice(0, TOP_N);

const asOf = $now.setZone('Africa/Lagos').toFormat('ccc d LLL yyyy');
const summary = {
  asOf,
  rules: { maxDebtRatio: MAX_DEBT, maxCashRatio: MAX_CASH, maxInterestIncomeRatio: MAX_IMPURE },
  checked: results.length,
  passedCount: passed.length,
  failed: results.filter((r) => r.status === 'fail').map((r) => ({ symbol: r.symbol, reason: r.reason })),
  noData: results.filter((r) => r.status === 'no-data').map((r) => ({ symbol: r.symbol, reason: r.reason })),
  picks,
  others: passed.slice(TOP_N).map((r) => ({ symbol: r.symbol, score: r.score })),
};

// Compact facts for the AI step (numbers only, no instructions from data sources).
const facts = picks.map((r) => ({
  symbol: r.symbol,
  name: r.name,
  industry: r.industry,
  score: r.score,
  price: r.price,
  dayChangePct: r.changePct,
  positionIn52wRangePct: r.metrics.rangePosition === null ? null : Math.round(r.metrics.rangePosition * 100),
  revenueGrowthPct: r.metrics.revenueGrowth === null ? null : Math.round(r.metrics.revenueGrowth * 1000) / 10,
  netMarginPct: r.metrics.netMargin === null ? null : Math.round(r.metrics.netMargin * 1000) / 10,
  peRatio: r.metrics.earningsYield > 0 ? Math.round(10 / r.metrics.earningsYield) / 10 : null,
  debtToMarketCapPct: Math.round(r.checks.debt.value * 1000) / 10,
  cashToMarketCapPct: Math.round(r.checks.cash.value * 1000) / 10,
  interestIncomeToRevenuePct:
    r.checks.interestIncome.value === null ? null : Math.round(r.checks.interestIncome.value * 1000) / 10,
}));

return [{ json: { ...summary, aiFacts: JSON.stringify(facts) } }];
