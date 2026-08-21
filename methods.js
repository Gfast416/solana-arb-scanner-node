// methods.js — 5 metode deteksi misprice
import { pairsByToken, searchToken, findMispricing } from './dexscreener.js';
import { USDC, SOL, WATCH_TOKENS } from './config.js';

const JUP_QUOTE = 'https://api.jup.ag/swap/v1/quote';
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=solana,usd-coin&vs_currencies=usd';

async function _getJson(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

// 1. Cross-DEX: bandingkan harga 1 token di multi DEX (DexScreener)
export function methodCrossDex(addr, label = '', threshold = 3.0) {
  return pairsByToken(addr).then(d => {
    if (!d || !d.pairs) return [];
    return findMispricing(d.pairs, threshold).map(o => ({ ...o, token: label || o.token, token_addr: addr }));
  }).catch(() => []);
}

// 2. Triangular: USDC -> TOKEN -> USDC via Jupiter quote
export async function methodTriangular(tokenMint, amountIn = 1_000_000, threshold = 0.5) {
  try {
    const q1 = await _getJson(`${JUP_QUOTE}?inputMint=${USDC}&outputMint=${tokenMint}&amount=${amountIn}&slippageBps=50`);
    if (!q1 || !q1.outAmount) return [];
    const out1 = Number(q1.outAmount);
    const q2 = await _getJson(`${JUP_QUOTE}?inputMint=${tokenMint}&outputMint=${USDC}&amount=${Math.floor(out1)}&slippageBps=50`);
    if (!q2 || !q2.outAmount) return [];
    const out2 = Number(q2.outAmount);
    const profit = (out2 - amountIn) / amountIn * 100;
    if (profit > threshold) {
      return [{
        type: 'triangular', token: '', token_addr: tokenMint,
        pct: +profit.toFixed(2), profit_pct: +profit.toFixed(2),
        route: `USDC->${tokenMint}->USDC`,
      }];
    }
    return [];
  } catch { return []; }
}

// 3. CEX-DEX: harga DEX vs agregat CEX (CoinGecko)
export async function methodCexDex(addr, label = '', threshold = 3.0) {
  try {
    const pairs = await pairsByToken(addr);
    if (!pairs || !pairs.pairs) return [];
    const cg = await _getJson(COINGECKO);
    if (!cg) return [];
    const p = pairs.pairs.find(x => x.priceUsd);
    if (!p) return [];
    const dexPrice = parseFloat(p.priceUsd);
    // pakai price CEX sbg reference (cg solana/usd-coin relatif)
    const ref = cg['usd-coin']?.usd ?? 1;
    const diff = Math.abs(dexPrice - ref) / Math.min(dexPrice, ref) * 100;
    if (diff >= threshold && diff <= 50) {
      return [{
        type: 'cex_dex', token: label || p.baseToken.symbol, token_addr: addr,
        pct: +diff.toFixed(2), profit_pct: +diff.toFixed(2),
        route: `dex(${dexPrice}) vs cex(${ref})`,
      }];
    }
    return [];
  } catch { return []; }
}

// 4. Oracle deviation (CoinGecko sebagai reference)
export async function methodOracle(addr, label = '', threshold = 3.0) {
  return methodCexDex(addr, label, threshold);
}

// 5. Extreme ratio: pool baru dengan 1 sisi likuiditas nyaris 0
export async function methodExtremeRatio(limit = 20, threshold = 50.0) {
  try {
    const pairs = await searchToken('pump', limit);
    return pairs.filter(p => {
      const liq = Number(p.liquidity?.usd || 0);
      const vol = Number(p.volume?.h24 || 0);
      return liq > 0 && vol > liq * 5; // volume >> likuiditas = rasio kacau
    }).map(p => ({
      type: 'extreme_ratio', token: p.baseToken.symbol, token_addr: p.baseToken.address,
      pct: +((Number(p.volume?.h24 || 0) / Math.max(Number(p.liquidity?.usd || 1), 1)) * 100).toFixed(2),
      profit_pct: 0, route: `pool ${p.dexId} vol/liq tinggi`,
    }));
  } catch { return []; }
}

export const ALL_METHODS = {
  cross_dex: methodCrossDex,
  triangular: methodTriangular,
  cex_dex: methodCexDex,
  oracle: methodOracle,
  extreme_ratio: methodExtremeRatio,
};

export async function runAllMethods(threshold = 3.0) {
  const results = [];
  for (const [addr, sym] of Object.entries(WATCH_TOKENS)) {
    const dx = await methodCrossDex(addr, sym, threshold);
    results.push(...dx);
    const tri = await methodTriangular(addr);
    results.push(...tri);
    const ce = await methodCexDex(addr, sym, threshold);
    results.push(...ce);
  }
  const er = await methodExtremeRatio();
  results.push(...er);
  return results.sort((a, b) => b.profit_pct - a.profit_pct);
}
