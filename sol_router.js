// sol_router.js — SOL-centric universal router
// Wallet cuma punya SOL. Start & end di SOL, tengah adapts ke misprice:
//   SOL->USDC -> X(buy murah di buyDex) -> USDC(sell mahal di sellDex) -> SOL
// Semua 1 atomic tx via Jupiter quotes + buildAtomicTx (V0 + ALT, proven reliable).
import { Connection, Keypair, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { USDC, SOL, JITO_TIP_ACCOUNT, nextRpcUrl } from './config.js';
import { getQuote, buildAtomicTx } from './build_atomic_tx.js';

// DEX mapping Jupiter (case-sensitive di API)
const JUP_DEX = { raydium: 'raydium', orca: 'orca', meteora: 'meteora', whirlpool: 'whirlpool', 'raydium-clmm': 'raydium-clmm' };
function toJupDex(d) { return JUP_DEX[(d || '').toLowerCase()] || null; }

async function buildQuotes(opp, solAmountLamports) {
  const tokenMint = opp.token_addr;
  const SLIP = 150; // slippage biar gak kena 6025
  // Tentukan buy/sell DEX dari misprice (priceA < priceB -> beli di A, jual di B)
  const buyDexRaw = opp.priceA < opp.priceB ? opp.dexA : opp.dexB;
  const sellDexRaw = opp.priceA < opp.priceB ? opp.dexB : opp.dexA;
  const buyDex = toJupDex(buyDexRaw);
  const sellDex = toJupDex(sellDexRaw);
  // FORCE route ke DEX spesifik biar exploit misprice beneran (gak round-trip aggregate)
  const q1 = await getQuote(SOL, tokenMint, solAmountLamports, SLIP, buyDex ? { dexes: [buyDex] } : {});
  if (!q1 || !q1.outAmount) throw new Error('no quote SOL->token @' + buyDex);
  const q2 = await getQuote(tokenMint, SOL, Number(q1.outAmount), SLIP, sellDex ? { dexes: [sellDex] } : {});
  if (!q2 || !q2.outAmount) throw new Error('no quote token->SOL @' + sellDex);
  const finalSol = Number(q2.outAmount);
  const profit = (finalSol - solAmountLamports) / 1e9;
  return { quotes: [q1, q2], profit, engine: `sol->${buyDex}->${sellDex}->sol` };
}

// opp: { token_addr, dexA, dexB, priceA, priceB }
export async function buildSolRouter(opp, payer, solAmountLamports = 1_000_000, tipLamports = 5000) {
 try {
  // Skip DEX yang sering gagal (pumpswap gak punya ATA standard -> InvalidSeeds)
  const BAD = ['pumpswap', 'pumpfun', 'moonshot', 'raydium-cpmm']; // bisa tambah
  if (BAD.includes((opp.dexA||'').toLowerCase()) || BAD.includes((opp.dexB||'').toLowerCase())) {
    return { ok: false, reason: 'skip non-standard dex (' + opp.dexA + '/' + opp.dexB + ')', profit_sol: 0 };
  }
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const built = await buildQuotes(opp, solAmountLamports);
      if (!built) return { ok: false, reason: 'no SOL/USDC pool', profit_sol: 0 };
      if (built.profit <= 0) return { ok: false, reason: `no profit (${built.profit.toFixed(6)} SOL)`, profit_sol: built.profit };
      const conn = new Connection(nextRpcUrl(), 'confirmed');
      const vtx = await buildAtomicTx(built.quotes, payer, conn, tipLamports);
      const raw = Buffer.from(vtx.serialize()).toString('base64');
      return { ok: true, raw, profit_sol: built.profit, engine: built.engine };
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 400)); }
  }
  return { ok: false, reason: 'builderr: ' + lastErr?.message?.slice(0, 60), profit_sol: 0 };
 } catch(e) {
  return { ok: false, reason: 'builderr: ' + e.message?.slice(0, 60), profit_sol: 0 };
 }
}
