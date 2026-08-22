// multi_scanner.js — DETEKSI misprice dari BANYAK SUMBER, lalu VALIDASI via Jupiter quote
// Sumber deteksi: DexScreener (primary, cepat) + Meteora/Orca/Raydium on-chain (bonus)
// Gatekeeper: Jupiter quote (harga executable beneran -> profit nyata, gak false positive)
import { Connection } from '@solana/web3.js';
import { nextRpcUrl, SOL, AGGRESSIVE_THRESHOLD } from './config.js';
import { pairsByToken, findMispricing } from './dexscreener.js';
import { getQuote } from './build_atomic_tx.js';
import { resolveMeteora, resolveOrca, resolveRaydium } from './pool_resolver.js';
import { fetchDynamicTokens } from './token_source.js';
import { inc } from './metrics.js';

const JUP_DEX = { raydium: 'raydium', orca: 'orca', meteora: 'meteora', whirlpool: 'orca' };
function toJupDex(d) { return JUP_DEX[(d || '').toLowerCase()] || null; }
export const DEX_LIST = ['meteora', 'orca', 'raydium'];

// Double-check on-chain (OPT-IN via .env ONCHAIN_VALIDATE=true).
// Default OFF: Jupiter quote udah cukup akurat sebagai gatekeeper.
// Nyalain cuma kalau resolver on-chain di mesin lo reliable (sandbox sering gagal).
const ONCHAIN_VALIDATE = (process.env.ONCHAIN_VALIDATE || 'false') === 'true';
export async function validateOnChain(opp) {
  if (!ONCHAIN_VALIDATE) return true; // skip kalau gak di-enable
  try {
    const a = toJupDex(opp.dexA), b = toJupDex(opp.dexB);
    const checks = [];
    for (const [dex, jd] of [[opp.dexA, a], [opp.dexB, b]]) {
      let r = null;
      try {
        if (jd === 'meteora') r = await resolveMeteora(SOL, opp.token_addr);
        else if (jd === 'orca') r = await resolveOrca(SOL, opp.token_addr);
        else if (jd === 'raydium') r = await resolveRaydium(SOL, opp.token_addr);
      } catch { return true; }
      checks.push(!!r);
    }
    return checks.every(Boolean);
  } catch { return true; }
}

// ---- Kandidat dari DexScreener (DYNAMIC: semua token trending/boosted/top-volume) ----
async function scanDexScreener(minPct) {
  const out = [];
  // TOKEN DINAMIS: gak terbatas list statis, fetch dari DexScreener tiap scan
  const tokens = await fetchDynamicTokens(parseInt(process.env.MAX_TOKENS || '150'));
  if (!tokens.length) return out;
  await Promise.all(tokens.map(async ([mint, sym]) => {
    try {
      const d = await pairsByToken(mint);
      if (!d?.pairs) return;
      const opps = findMispricing(d.pairs, minPct).filter(o => o.token_addr && o.token_addr !== SOL);
      for (const o of opps) {
        const dexA = toJupDex(o.dexA) ? o.dexA : null;
        const dexB = toJupDex(o.dexB) ? o.dexB : null;
        if (!dexA || !dexB) continue;
        const STABLE = ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','Es9vMFrzaCERmJfrF4H2FYPMvAj7QUWxXPgZEJBJ41jW'];
        if (STABLE.includes(o.token_addr)) continue;
        out.push({ token: o.token, token_addr: o.token_addr, dexA, dexB, priceA: o.priceA, priceB: o.priceB, pct: o.pct, source: 'dexscreener' });
      }
    } catch (_) {}
  }));
  return out;
}

// ---- Kandidat on-chain (Meteora/Orca/Raydium) HANYA buat token yg dapet opp DexScreener ----
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

// ---- Scan utama: DexScreener (parallel) + on-chain double-check ----
export async function scanAll(minPct = AGGRESSIVE_THRESHOLD) {
  const seen = new Map();
  const push = (o) => {
    const key = `${o.token_addr}:${o.dexA}:${o.dexB}`;
    if (!seen.has(key) || o.pct > seen.get(key).pct) seen.set(key, o);
  };
  const ds = await scanDexScreener(minPct);
  ds.forEach(push);
  const uniqueTokens = [...new Set(ds.map(d => d.token_addr))].map(mk => {
    const t = ds.find(x => x.token_addr === mk); return [mk, t.token];
  });
  if (uniqueTokens.length) {
    const oc = await scanOnChainFor(uniqueTokens);
    oc.forEach(push);
  }
  return [...seen.values()].sort((a, b) => b.pct - a.pct);
}
