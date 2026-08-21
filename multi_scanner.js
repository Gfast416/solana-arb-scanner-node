// multi_scanner.js — DETEKSI misprice dari BANYAK SUMBER, lalu VALIDASI via Jupiter quote
// Sumber deteksi: DexScreener + Meteora DLMM + Orca Whirlpool + Raydium CPMM (on-chain)
// Gatekeeper: Jupiter quote (harga executable beneran -> profit nyata, gak false positive)
import { Connection, PublicKey } from '@solana/web3.js';
import { nextRpcUrl, SOL, USDC, WATCH_TOKENS } from './config.js';
import { pairsByToken, findMispricing } from './dexscreener.js';
import { getQuote } from './build_atomic_tx.js';
import { resolveMeteora, resolveOrca } from './pool_resolver.js';

const JUP_DEX = { raydium: 'raydium', orca: 'orca', meteora: 'meteora', whirlpool: 'orca' };
function toJupDex(d) { return JUP_DEX[(d || '').toLowerCase()] || null; }

// ---- Kandidat dari DexScreener (cepat, gratis) ----
async function scanDexScreener(minPct) {
  const out = [];
  for (const tok of Object.keys(WATCH_TOKENS)) {
    try {
      const d = await pairsByToken(tok);
      if (!d?.pairs) continue;
      const opps = findMispricing(d.pairs, minPct).filter(o => o.token_addr && o.token_addr !== SOL);
      for (const o of opps) out.push({ token: o.token, token_addr: o.token_addr, dexA: o.dexA, dexB: o.dexB, priceA: o.priceA, priceB: o.priceB, pct: o.pct, source: 'dexscreener' });
    } catch (_) {}
  }
  return out;
}

// ---- Kandidat dari on-chain pool (Meteora / Orca / Raydium) ----
// Baca harga pool SOL<->token di 2 DEX beda, bandingin. Akurat (gak stale kayak DexScreener).
async function scanOnChain(minPct) {
  const out = [];
  const conn = new Connection(nextRpcUrl(), 'confirmed');
  for (const tok of Object.keys(WATCH_TOKENS)) {
    if (tok === SOL) continue;
    const tokenMint = WATCH_TOKENS[tok];
    if (!tokenMint || tokenMint === SOL) continue;
    // Resolve pool di tiap DEX
    const pools = {};
    try { pools.meteora = await resolveMeteora(SOL, tokenMint); } catch {}
    try { pools.orca = await resolveOrca(SOL, tokenMint); } catch {}
    // Raydium: resolve via Raydium SDK PDA (brute, optional)
    // (skip kalau SDK berat; DexScreener udah nutupin raydium)
    const available = Object.entries(pools).filter(([k, v]) => v);
    if (available.length < 2) continue;
    // Ambil price pool dari on-chain (amount out untuk 0.01 SOL)
    const prices = {};
    for (const [dex, pool] of available) {
      try {
        const q = await getQuote(SOL, tokenMint, 10_000_000, 50, { dexes: [toJupDex(dex)] });
        if (q?.outAmount) prices[dex] = Number(q.outAmount); // token per 0.01 SOL
      } catch {}
    }
    const dexs = Object.keys(prices);
    for (let i = 0; i < dexs.length; i++) for (let j = i + 1; j < dexs.length; j++) {
      const a = dexs[i], b = dexs[j];
      const pa = prices[a], pb = prices[b];
      const diff = Math.abs(pa - pb) / Math.min(pa, pb) * 100;
      if (diff >= minPct && diff <= 50) {
        // harga tinggi = jual disitu, rendah = beli disitu
        const buyDex = pa < pb ? a : b;
        const sellDex = pa < pb ? b : a;
        out.push({
          token: tok, token_addr: tokenMint,
          dexA: buyDex, dexB: sellDex,
          priceA: pa, priceB: pb,
          pct: +diff.toFixed(2), source: 'onchain'
        });
      }
    }
  }
  return out;
}

// ---- VALIDASI via Jupiter: beneran bisa eksekusi profit? ----
// Ini GATEKEEPER: cuma opp yang lolos ini yang di-execute.
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

// ---- Scan utama: gabungin semua sumber, dedupe, return kandidat ----
export async function scanAll(minPct = 0.3) {
  const seen = new Map();
  const push = (o) => {
    const key = `${o.token_addr}:${o.dexA}:${o.dexB}`;
    if (!seen.has(key) || o.pct > seen.get(key).pct) seen.set(key, o);
  };
  const [ds, oc] = await Promise.all([scanDexScreener(minPct), scanOnChain(minPct)]);
  ds.forEach(push); oc.forEach(push);
  return [...seen.values()].sort((a, b) => b.pct - a.pct);
}
