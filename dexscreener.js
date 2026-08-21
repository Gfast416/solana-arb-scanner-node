// dexscreener.js — API DexScreener (gratis, no key)
const BASE = 'https://api.dexscreener.com/latest/dex';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export async function _getJson(url, headers = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) return null;
  return r.json();
}

export async function pairsByToken(addr) {
  return _getJson(`${BASE}/tokens/${addr}`);
}

export async function searchToken(q, limit = 30) {
  const d = await _getJson(`${BASE}/search?q=${encodeURIComponent(q)}`);
  return (d && d.pairs) ? d.pairs.slice(0, limit) : [];
}

// Pair HARUS TOKEN vs USDC (bukan vs token lain seperti MET) biar price可比 & bisa di-execute
function isUsdcPair(p) {
  const b = (p.baseToken?.address || '').toLowerCase();
  const q = (p.quoteToken?.address || '').toLowerCase();
  const u = USDC_MINT.toLowerCase();
  return (b === u || q === u);
}

// DEX yang bisa di-execute via Jupiter dgn ATA standard (pumpswap sering gagal)
const ALLOWED_DEX = ['raydium', 'orca', 'meteora', 'whirlpool', 'raydium-clmm', 'raydium-cpmm'];
function isAllowedDex(d) { return ALLOWED_DEX.includes((d||'').toLowerCase()); }

// Cari peluang misprice antar DEX untuk 1 token
// Cap 50%: di atas itu biasanya price-feed error (decimal pool beda)
export function findMispricing(pairs, thresholdPct = 3.0) {
  if (!pairs || !pairs.length) return [];
  const valid = pairs.filter(p => {
    const pr = parseFloat(p.priceUsd);
    return p && p.dexId && !isNaN(pr) && pr > 0 && isUsdcPair(p) && isAllowedDex(p.dexId);
  });
  const out = [];
  // hitung median price buat filter outlier (price kotor dari pool decimal beda)
  const prices = valid.map(p => parseFloat(p.priceUsd)).sort((x, y) => x - y);
  const median = prices[Math.floor(prices.length / 2)] || 0;
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i], b = valid[j];
      // FILTER 1: DEX harus beda (gak bandingin meteora vs meteora)
      if (a.dexId === b.dexId) continue;
      const pa = parseFloat(a.priceUsd), pb = parseFloat(b.priceUsd);
      // FILTER 2: outlier — 1 price >10x median atau <0.1x median = price kotor
      if (median > 0 && (pa > median * 10 || pa < median * 0.1)) continue;
      if (median > 0 && (pb > median * 10 || pb < median * 0.1)) continue;
      // FILTER 3: likuiditas minimal $5000 biar gak false positive (USD2 dll likuiditas kecil)
      const liqA = Number(a.liquidity?.usd || 0);
      const liqB = Number(b.liquidity?.usd || 0);
      if (liqA < 5000 || liqB < 5000) continue;
      const diff = Math.abs(pa - pb) / Math.min(pa, pb) * 100;
      if (diff >= thresholdPct && diff <= 50) {
        out.push({
          type: 'cross_dex',
          token: a.baseToken.symbol,
          token_addr: a.baseToken.address,
          dexA: a.dexId, priceA: pa,
          dexB: b.dexId, priceB: pb,
          pairA: a.pairAddress, pairB: b.pairAddress,
          pct: +diff.toFixed(2),
          route: `buy@${pa < pb ? a.dexId : b.dexId} -> sell@${pa < pb ? b.dexId : a.dexId}`,
          profit_pct: +diff.toFixed(2),
        });
      }
    }
  }
  return out.sort((x, y) => y.pct - x.pct);
}
