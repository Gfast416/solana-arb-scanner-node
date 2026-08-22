// sol_router.js — SOL-centric FAST router (SINGLE-QUOTE path, <2s per opp)
// Alur: detect misprice -> 1x quote forced-dex -> build -> simulate -> (submit)
// Gak ada validate terpisah biar cepat (misprice gak telat).
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { SOL, nextRpcUrl } from './config.js';
import { getQuote, buildAtomicTx } from './build_atomic_tx.js';

const JUP_DEX = { raydium: 'raydium', orca: 'orca', meteora: 'meteora', whirlpool: 'orca', 'raydium-clmm': 'raydium-clmm' };
function toJupDex(d) { return JUP_DEX[(d || '').toLowerCase()] || null; }
const SLIP = 150;

// Build 1x quote (forced-dex) + tx langsung. Return {raw, profitSol, engine} atau throw.
export async function buildSolRouterFast(opp, payer, solAmountLamports = 10_000_000, tipLamports = 5000) {
  const tokenMint = opp.token_addr;
  const buyDexRaw = opp.priceA < opp.priceB ? opp.dexA : opp.dexB;
  const sellDexRaw = opp.priceA < opp.priceB ? opp.dexB : opp.dexA;
  const buyDex = toJupDex(buyDexRaw);
  const sellDex = toJupDex(sellDexRaw);
  const BAD = ['pumpswap', 'pumpfun', 'moonshot'];
  if (BAD.includes(buyDexRaw.toLowerCase()) || BAD.includes(sellDexRaw.toLowerCase())) {
    throw new Error('skip non-standard dex');
  }
  // 1x quote aja (forced dex) — ini yang bikin cepat
  let q1, q2;
  try {
    q1 = await getQuote(SOL, tokenMint, solAmountLamports, SLIP, buyDex ? { dexes: [buyDex] } : {});
    if (!q1?.outAmount) throw new Error('no quote SOL->token @' + buyDex);
    q2 = await getQuote(tokenMint, SOL, Number(q1.outAmount), SLIP, sellDex ? { dexes: [sellDex] } : {});
    if (!q2?.outAmount) throw new Error('no quote token->SOL @' + sellDex);
  } catch (e) { throw e; }

  const engine = `sol->${buyDex}->${sellDex}->sol`;
  const conn = new Connection(nextRpcUrl(), 'confirmed');
  try {
    const vtx = await buildAtomicTx([q1, q2], payer, conn, tipLamports);
    const profitSol = (Number(q2.outAmount) - solAmountLamports) / 1e9;
    return { raw: Buffer.from(vtx.serialize()).toString('base64'), profitSol, engine };
  } catch (e) {
    // Kalau forced-dex gagal extract (ALT unresolved), fallback ke aggregate quote (gak dex filter)
    if (/BUILD EMPTY|ALT/i.test(e.message || '')) {
      const q1b = await getQuote(SOL, tokenMint, solAmountLamports, SLIP, {});
      const q2b = await getQuote(tokenMint, SOL, Number(q1b.outAmount), SLIP, {});
      const vtx = await buildAtomicTx([q1b, q2b], payer, conn, tipLamports);
      const profitSol = (Number(q2b.outAmount) - solAmountLamports) / 1e9;
      return { raw: Buffer.from(vtx.serialize()).toString('base64'), profitSol, engine: `sol->aggregate->sol (fallback)` };
    }
    throw e;
  }
}

// Backward-compat wrapper (buat circular/jitcaller kalau ada)
export async function buildSolRouter(opp, payer, solAmountLamports = 10_000_000, tipLamports = 5000) {
  const r = await buildSolRouterFast(opp, payer, solAmountLamports, tipLamports);
  return { ok: true, raw: r.raw, profit_sol: r.profitSol, engine: r.engine };
}
