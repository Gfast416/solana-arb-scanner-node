// onchain_scanner.js — DETEKSI misprice via ON-CHAIN RESERVES (bukan DexScreener API)
// Bot pro profit 30 SOL pakai ini: baca reserve pool REAL-TIME, hitung harga sendiri.
// Kita: fetch pool list (Raydium API) -> baca reserve on-chain -> bandingin harga antar DEX.
import { Connection, PublicKey } from '@solana/web3.js';
import { nextRpcUrl, SOL, USDC } from './config.js';
import { getQuote } from './build_atomic_tx.js';

const RAYDIUM_POOLS_API = 'https://api.raydium.io/v2/main/pools';

// Struct Raydium V4 AMM state (offset ke reserve)
// baseReserve: u64 @ 213, quoteReserve: u64 @ 221 (standard Raydium V4 layout)
function parseRaydiumV4(data) {
  const baseReserve = data.readBigUInt64LE(213);
  const quoteReserve = data.readBigUInt64LE(221);
  const baseDecimals = data.readUInt8(205);
  const quoteDecimals = data.readUInt8(206);
  return { baseReserve, quoteReserve, baseDecimals, quoteDecimals };
}

// Ambil semua pool Raydium (filter SOL/USDC quoted)
export async function fetchRaydiumPools() {
  try {
    const r = await fetch(RAYDIUM_POOLS_API);
    const j = await r.json();
    const pools = (j?.official || j?.pools || []).filter(p =>
      (p.baseMint === SOL || p.quoteMint === SOL || p.baseMint === USDC || p.quoteMint === USDC) &&
      p.lpMint && p.version === 'v4'
    );
    return pools;
  } catch { return []; }
}

// Baca reserve on-chain, hitung harga (quote per base)
export async function getPoolPrice(conn, poolAddr, baseMint) {
  try {
    const info = await conn.getAccountInfo(new PublicKey(poolAddr));
    if (!info) return null;
    const { baseReserve, quoteReserve, baseDecimals, quoteDecimals } = parseRaydiumV4(info.data);
    if (baseReserve === 0n || quoteReserve === 0n) return null;
    // price = quoteReserve/baseReserve * 10^(baseDec-quoteDec)  (quote per base)
    const price = Number(quoteReserve) / Number(baseReserve) * Math.pow(10, baseDecimals - quoteDecimals);
    return price; // quote per base (misal USDC per SOL)
  } catch { return null; }
}

// Scan misprice: bandingin harga pool Raydium vs Jupiter quote (gatekeeper)
export async function scanOnChain(minPct = 0.5, limit = 30) {
  const conn = new Connection(nextRpcUrl(), 'confirmed');
  const pools = (await fetchRaydiumPools()).slice(0, limit);
  const opps = [];
  await Promise.all(pools.map(async (p) => {
    try {
      const isSolBase = p.baseMint === SOL;
      const tokenMint = isSolBase ? p.quoteMint : p.baseMint;
      const onchainPrice = await getPoolPrice(conn, p.lpMint || p.id, p.baseMint);
      if (!onchainPrice) return;
      // Harga on-chain = quote per base. Kalau base=SOL -> harga token in SOL = 1/onchainPrice*...
      // Bandingin dgn Jupiter mid price (SOL->token)
      const q = await getQuote(SOL, tokenMint, 10_000_000, 50, {});
      if (!q?.outAmount) return;
      const jupPrice = Number(q.outAmount) / 1e7; // token per SOL
      const onchainPriceTokenPerSol = isSolBase ? (1 / onchainPrice) : onchainPrice; // approx
      const diff = Math.abs(jupPrice - onchainPriceTokenPerSol) / Math.min(jupPrice, onchainPriceTokenPerSol) * 100;
      if (diff >= minPct && diff <= 50) {
        opps.push({
          token: p.name || tokenMint.slice(0, 6),
          token_addr: tokenMint,
          dexA: 'raydium',
          dexB: 'jupiter-agg',
          pct: +diff.toFixed(2),
          onchainPrice, jupPrice,
          source: 'onchain-raydium',
        });
      }
    } catch {}
  }));
  return opps.sort((a, b) => b.pct - a.pct);
}
