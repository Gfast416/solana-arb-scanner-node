// dex_pool.js — cross-dex atomic via Jupiter dexes[] filter (per-DEX beneran, terbukti)
// buy@DEX_A, sell@DEX_B dalam 1 VersionedTransaction (atomic)
import { Connection, Keypair, PublicKey, SystemProgram, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { USDC, JITO_TIP_ACCOUNT, nextRpcUrl } from './config.js';
import { getQuote, buildAtomicTx } from './build_atomic_tx.js';

export async function buildCrossDexAtomic(opp, payer, amountInUsd = 1_000_000, tipLamports = 5000) {
  const tokenMint = opp.token_addr;
  if (!tokenMint) return { ok: false, reason: 'no token_addr' };
  const buyDex = opp.priceA < opp.priceB ? opp.dexA : opp.dexB;
  const sellDex = opp.priceA < opp.priceB ? opp.dexB : opp.dexA;

  // Quote per-DEX via Jupiter dexes[] filter
  const q1 = await getQuote(USDC, tokenMint, amountInUsd, 50, { dexes: [buyDex] });
  if (!q1 || !q1.outAmount) return { ok: false, reason: `no quote1 @${buyDex}` };
  const q2 = await getQuote(tokenMint, USDC, Math.floor(Number(q1.outAmount)), 50, { dexes: [sellDex] });
  if (!q2 || !q2.outAmount) return { ok: false, reason: `no quote2 @${sellDex}` };

  const out2 = Number(q2.outAmount);
  const profit = out2 - amountInUsd;
  if (profit <= 0) return { ok: false, reason: `no profit (${profit/1e6} USD)`, profit_usd: profit/1e6 };

  // 1 atomic tx (2 swaps + tip), fee=0
  const rpcUrl = nextRpcUrl();
  const conn = new Connection(rpcUrl, 'confirmed');
  const vtx = await buildAtomicTx([q1, q2], payer, conn, tipLamports);
  vtx.sign([payer]);
  const raw = Buffer.from(vtx.serialize()).toString('base64');

  return { ok: true, raw, buyDex, sellDex, profit_usd: profit/1e6, engine: 'jupiter-dexes' };
}
