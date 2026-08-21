// circular.js — CIRCULAR ARB (metode #5): SOL -> A -> B -> C -> SOL
// Cari loop tertutup max-profit di antara token set liquid, build 1 atomic tx.
// Pakai Jupiter quote API (bypass DEX langsung, tapi 1 atomic tx tetap).
import { Keypair, Connection, SystemProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getQuote } from './build_atomic_tx.js';
import { SOL, USDC, nextRpcUrl, JITO_TIP_ACCOUNT } from './config.js';

// Token set liquid (bisa di-expand)
export const TOKEN_SET = [
  SOL,
  USDC,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
];

// Cari 1 loop SOL->A->B->C->SOL dgn profit max (3-hop). Return path + quotes.
export async function findCircular(solAmount = 10_000_000) {
  const tokens = TOKEN_SET.filter(t => t !== SOL);
  let best = null;
  for (const A of tokens) {
    const q1 = await getQuote(SOL, A, solAmount, 50, {}).catch(() => null);
    if (!q1 || !q1.outAmount) continue;
    for (const B of tokens) {
      if (B === A) continue;
      const q2 = await getQuote(A, B, Math.floor(Number(q1.outAmount)), 50, {}).catch(() => null);
      if (!q2 || !q2.outAmount) continue;
      const q3 = await getQuote(B, SOL, Math.floor(Number(q2.outAmount)), 50, {}).catch(() => null);
      if (!q3 || !q3.outAmount) continue;
      const finalSol = Number(q3.outAmount);
      const profit = (finalSol - solAmount) / 1e9;
      if (profit > 0 && (!best || profit > best.profit)) {
        best = { path: [SOL, A, B, SOL], quotes: [q1, q2, q3], profit, finalSol };
      }
    }
  }
  return best;
}

// Build 1 atomic tx dari loop (pakai Jupiter quotes + buildAtomicTx V0+ALT, proven reliable)
export async function buildCircularTx(loop, payer, tipLamports = 5000, retries = 3) {
  const { path, quotes } = loop;
  const { buildAtomicTx } = await import('./build_atomic_tx.js');
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const { Connection } = await import('@solana/web3.js');
      const conn = new Connection(nextRpcUrl(), 'confirmed');
      const vtx = await buildAtomicTx(quotes, payer, conn, tipLamports);
      const raw = Buffer.from(vtx.serialize()).toString('base64');
      return { ok: true, raw, profit_sol: loop.profit, path: loop.path.map(p => p.slice(0, 4)) };
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 400)); }
  }
  throw new Error('buildCircularTx failed: ' + lastErr?.message);
}
