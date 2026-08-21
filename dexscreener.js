// dexscreener.js — API DexScreener (gratis, no key)
const BASE = 'https://api.dexscreener.com/latest/dex';

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

// Cari peluang misprice antar DEX untuk 1 token
// Cap 50%: di atas itu biasanya price-feed error (decimal pool beda)
export function findMispricing(pairs, thresholdPct = 3.0) {
  if (!pairs || !pairs.length) return [];
  const valid = pairs.filter(p => {
    const pr = parseFloat(p.priceUsd);
    return p && p.dexId && !isNaN(pr) && pr > 0;
  });
  const out = [];
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i], b = valid[j];
      const pa = parseFloat(a.priceUsd), pb = parseFloat(b.priceUsd);
      const diff = Math.abs(pa - pb) / Math.min(pa, pb) * 100;
      if (diff >= thresholdPct && diff <= 50) {
        out.push({
          type: 'cross_dex',
          token: a.baseToken.symbol,
          dexA: a.dexId, priceA: pa,
          dexB: b.dexId, priceB: pb,
          pct: +diff.toFixed(2),
          route: `buy@${pa < pb ? a.dexId : b.dexId} -> sell@${pa < pb ? b.dexId : a.dexId}`,
          profit_pct: +diff.toFixed(2),
        });
      }
    }
  }
  return out.sort((x, y) => y.pct - x.pct);
}
