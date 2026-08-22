// multi_scanner.js — DETEKSI misprice dari BANYAK SUMBER, lalu VALIDASI via Jupiter quote
// Sumber deteksi: DexScreener (primary, cepat) + Meteora/Orca/Raydium on-chain (bonus)
// Gatekeeper: Jupiter quote (harga executable beneran -> profit nyata, gak false positive)
import { Connection } from '@solana/web3.js';
import { nextRpcUrl, SOL, WATCH_TOKEN_LIST, AGGRESSIVE_THRESHOLD } from './config.js';
import { pairsByToken, findMispricing } from './dexscreener.js';
import { getQuote } from './build_atomic_tx.js';
import { resolveMeteora, resolveOrca, resolveRaydium } from './pool_resolver.js';

const JUP_DEX = { raydium: 'raydium', orca: 'orca', meteora: 'meteora', whirlpool: 'orca' };
function toJupDex(d) { return JUP_DEX[(d || '').toLowerCase()] || null; }
export const DEX_LIST = ['meteora', 'orca', 'raydium'];

// ---- Kandidat dari DexScreener (cepat, parallel semua token) ----
// Langsung pakai dexId DexScreener (raydium/orca/meteora) — gak perlu resolve on-chain,
// Jupiter bisa quote langsung per-DEX.
async function scanDexScreener(minPct) {
  const out = [];
  const tokens = WATCH_TOKEN_LIST;
  await Promise.all(tokens.map(async ([mint, sym]) => {
    try {
      const d = await pairsByToken(mint);
      if (!d?.pairs) return;
      const opps = findMispricing(d.pairs, minPct).filter(o => o.token_addr && o.token_addr !== SOL);
      for (const o of opps) {
        // Normalisasi dexId ke Jupiter dex name
        const dexA = toJupDex(o.dexA) ? o.dexA : null;
        const dexB = toJupDex(o.dexB) ? o.dexB : null;
        if (!dexA || !dexB) continue; // skip dex yang Jupiter gak support
        out.push({ token: o.token, token_addr: o.token_addr, dexA, dexB, priceA: o.priceA, priceB: o.priceB, pct: o.pct, source: 'dexscreener' });
      }
    } catch (_) {}
  }));
  return out;
}

// ---- Kandidat on-chain (Meteora/Orca/Raydium) HANYA buat token yg dapet opp DexScreener ----
// Gak brute-force semua token (biar cepat). Cross-check harga SOL<->token di 2 DEX.
async function scanOnChainFor(tokenList) {
  const out = [];
  await Promise.all(tokenList.map(async ([tokenMint, sym]) => {
    if (!tokenMint || tokenMint === SOL) return;
    const pools = {};
    try { pools.meteora = await resolveMeteora(SOL, tokenMint); } catch {}
    try { pools.orca = await resolveOrca(SOL, tokenMint); } catch {}
    try { pools.raydium = await resolveRaydium(SOL, tokenMint); } catch {}
    const available = Object.entries(pools).filter(([k, v]) => v);
    if (available.length < 2) return;
    const prices = {};
    await Promise.all(available.map(async ([dex]) => {
      const jd = toJupDex(dex);
      try {
        const q = await getQuote(SOL, tokenMint, 10_000_000, 50, jd ? { dexes: [jd] } : {});
        if (q?.outAmount) prices[dex] = Number(q.outAmount);
      } catch {}
    }));
    const dexs = Object.keys(prices);
    for (let i = 0; i < dexs.length; i++) for (let j = i + 1; j < dexs.length; j++) {
      const a = dexs[i], b = dexs[j];
      const pa = prices[a], pb = prices[b];
      const diff = Math.abs(pa - pb) / Math.min(pa, pb) * 100;
      if (diff >= 0.3 && diff <= 50) {
        const buyDex = pa < pb ? a : b;
        const sellDex = pa < pb ? b : a;
        out.push({ token: sym, token_addr: tokenMint, dexA: buyDex, dexB: sellDex, priceA: pa, priceB: pb, pct: +diff.toFixed(2), source: 'onchain' });
      }
    }
  }));
  return out;
}

// ---- VALIDASI via Jupiter: beneran bisa eksekusi profit? ----
export async function validateWithJupiter(opp, solAmount = 10_000_000) {
  const tokenMint = opp.token_addr;
  const buyDex = toJupDex(opp.dexA);
  const sellDex = toJupDex(opp.dexB);
  try {
    const q1 = await getQuote(SOL, tokenMint, solAmount, 150, buyDex ? { dexes: [buyDex] } : {});
    if (!q1?.outAmount) return null;
    const q2 = await getQuote(tokenMint, SOL, Number(q1.outAmount), 150, sellDex ? { dexes: [sellDex] } : {});
    if (!q2?.outAmount) return null;
    const profitSol = (Number(q2.outAmount) - solAmount) / 1e9;
    return { ...opp, profitSol, quotes: [q1, q2], engine: `sol->${buyDex}->${sellDex}->sol`, token: opp.token };
  } catch { return null; }
}

// ---- Scan utama: DexScreener (parallel, semua DEX termasuk raydium) -> validate Jupiter ----
export async function scanAll(minPct = AGGRESSIVE_THRESHOLD) {
  const seen = new Map();
  const push = (o) => {
    const key = `${o.token_addr}:${o.dexA}:${o.dexB}`;
    if (!seen.has(key) || o.pct > seen.get(key).pct) seen.set(key, o);
  };
  const ds = await scanDexScreener(minPct); // parallel, ~5s, semua DEX (raydium/orca/meteora)
  ds.forEach(push);
  return [...seen.values()].sort((a, b) => b.pct - a.pct);
}
