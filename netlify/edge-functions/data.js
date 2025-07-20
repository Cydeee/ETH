// netlify/edge-functions/data.js

export default async (request) => {
  // ─── Change symbol to ETHUSDT ───────────────────────────────────────────
  const SYMBOL = 'ETHUSDT';
  const LIMIT  = 250;

  const result = {
    dataA: {},
    dataB: null,
    dataD: null,
    dataE: null,
    errors: []
  };

  // ─── Indicator helpers (no changes) ─────────────────────────────────────
  function sma(a, p) { /* … */ }
  function std(a, p) { /* … */ }
  function ema(a, p) { /* … */ }
  function rsi(a, p) { /* … */ }
  function atr(h, l, c, p) { /* … */ }

  // ─── BLOCK A: Price / Volatility / Trend ────────────────────────────────
  for (const tf of ['15m', '1h', '4h', '1d']) {
    try {
      const rows = await fetch(
        `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${LIMIT}`
      ).then(r => r.json());
      /* … rest unchanged … */
    } catch (e) {
      result.errors.push(`A[${tf}]: ${e.message}`);
    }
  }

  // ─── BLOCK B: Derivatives Positioning ──────────────────────────────────────
  try {
    /* fundingRate, openInterest calls all use SYMBOL so they auto-switch to ETHUSDT */
  } catch (e) {
    result.errors.push(`B: ${e.message}`);
  }

  // ─── BLOCK D: Sentiment ──────────────────────────────────────────────────────
  try {
    // ← change “bitcoin” to “ethereum”
    const cg = await fetch(
      'https://api.coingecko.com/api/v3/coins/ethereum'
    ).then(r => r.json());
    const upPct =
      cg.sentiment_votes_up_percentage ??
      cg.community_data?.sentiment_votes_up_percentage;
    if (upPct == null) throw new Error('Missing sentiment_votes_up_percentage');

    const fg = await fetch(
      'https://api.alternative.me/fng/?limit=1'
    ).then(r => r.json());
    /* … rest unchanged … */

  } catch (e) {
    result.errors.push(`D: ${e.message}`);
  }

  // ─── BLOCK E: Macro Risk Context ─────────────────────────────────────────────
  try {
    /* unchanged – we still report ETH dominance alongside BTC */
  } catch (e) {
    result.errors.push(`E: ${e.message}`);
  }

  // ─── Return JSON ────────────────────────────────────────────────────────────
  return new Response(
    JSON.stringify({ ...result, timestamp: Date.now() }),
    { headers: { 'Content-Type': 'application/json' } }
  );
};
