// sol_router.js — SOL-centric universal router
// Wallet cuma punya SOL. Start & end di SOL, tengah adapts ke misprice:
//   Kasus A (token X vs USDC misprice):
//     SOL->USDC -> X(buy murah) -> USDC(sell mahal) -> SOL
// Semua 1 atomic tx, fee=0, tip Jito 5000.
import { Connection, Keypair, PublicKey, SystemProgram, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { USDC, SOL, JITO_TIP_ACCOUNT, nextRpcUrl } from './config.js';
import { raydiumSwapIx, meteoraSwapIx, orcaSwapIx, jupiterSwapIx } from './dex_swap.js';
import { resolveMeteora, resolveOrca } from './pool_resolver.js';

let _raydium = null;
async function getRaydium() {
  if (_raydium) return _raydium;
  const { Raydium } = await import('@raydium-io/raydium-sdk-v2');
  const conn = new Connection(nextRpcUrl(), 'confirmed');
  const dummy = Keypair.generate();
  _raydium = await Raydium.load({ owner: dummy, connection: conn, cluster: 'mainnet', disableFeatureCheck: true, blockhashCommitment: 'confirmed' });
  return _raydium;
}

// Resolve Raydium pool by mints via public API (reliable, no SDK load)
async function resolveRaydiumHttp(tokenMint, quoteMint = USDC) {
  const url = `https://api-v3.raydium.io/pools/info/mint?mint1=${tokenMint}&mint2=${quoteMint}&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=10`;
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
  if (!r.ok) return null;
  const j = await r.json();
  const data = j?.data?.data || j?.data || [];
  if (!data.length) return null;
  return data[0].id;
}

// Resolve on-chain pool address untuk (token, USDC) di DEX tertentu
export async function resolvePoolForDex(dex, tokenMint) {
  const d = (dex || '').toLowerCase();
  if (d.includes('raydium')) {
    const raydium = await getRaydium();
    const res = await raydium.api.fetchPoolByMints({ mint1: tokenMint, mint2: USDC });
    const data = res?.data || (Array.isArray(res) ? res : []);
    return (data && data.length) ? data[0].id : null;
  }
  if (d.includes('meteora')) {
    const r = await resolveMeteora(tokenMint, USDC);
    return r ? r.address : null;
  }
  if (d.includes('orca')) {
    const r = await resolveOrca(tokenMint, USDC);
    return r ? r.address : 'jupiter'; // fallback to jupiter dexes[orca] if no on-chain pool
  }
  return null;
}

async function swapLeg(payer, dex, pool, inputMint, outputMint, amount) {
  const d = (dex || '').toLowerCase();
  if (pool === 'jupiter' || !pool) {
    return jupiterSwapIx(payer, inputMint, outputMint, amount, [d.replace(/[^a-z]/g, '')]);
  }
  if (d.includes('raydium')) {
    try { return await raydiumSwapIx(payer, pool, inputMint, amount); }
    catch (e) { return await jupiterSwapIx(payer, inputMint, outputMint, amount, ['raydium']); }
  }
  if (d.includes('orca')) {
    try { return await orcaSwapIx(payer, pool, inputMint, amount, true); }
    catch (e) { return await jupiterSwapIx(payer, inputMint, outputMint, amount, ['orca']); }
  }
  if (d.includes('meteora')) {
    try { return await meteoraSwapIx(payer, pool, inputMint, amount, true); }
    catch (e) { return await jupiterSwapIx(payer, inputMint, outputMint, amount, ['meteora']); }
  }
  return jupiterSwapIx(payer, inputMint, outputMint, amount, [d.replace(/[^a-z]/g, '')]);
}

// opp: { token_addr, dexA, dexB, priceA, priceB }
export async function buildSolRouter(opp, payer, solAmountLamports = 1_000_000, tipLamports = 5000) {
 try {
  const tokenMint = opp.token_addr;
  const buyDex = opp.priceA < opp.priceB ? opp.dexA : opp.dexB;
  const sellDex = opp.priceA < opp.priceB ? opp.dexB : opp.dexA;

  // SOL/USDC pool (raydium)
  const solUsdcPool = await resolvePoolForDex('raydium', SOL);
  if (!solUsdcPool) return { ok: false, reason: 'no SOL/USDC raydium pool' };

  // resolve pools on-chain (DexScreener pairAddress unreliable)
  const buyPool = await resolvePoolForDex(buyDex, tokenMint);
  if (!buyPool) return { ok: false, reason: `no ${buyDex} pool for token` };
  const sellPool = await resolvePoolForDex(sellDex, tokenMint);
  if (!sellPool) return { ok: false, reason: `no ${sellDex} pool for token` };

  const ixs = [];
  let s2u;
  try { s2u = await raydiumSwapIx(payer, solUsdcPool, SOL, solAmountLamports); }
  catch (e) { s2u = await jupiterSwapIx(payer, SOL, USDC, solAmountLamports, ['raydium']); }
  ixs.push(...s2u.ixs);
  const bLeg = await swapLeg(payer, buyDex, buyPool, USDC, tokenMint, s2u.outAmount);
  ixs.push(...bLeg.ixs);
  const sLeg = await swapLeg(payer, sellDex, sellPool, tokenMint, USDC, bLeg.outAmount);
  ixs.push(...sLeg.ixs);
  let u2s;
  try { u2s = await raydiumSwapIx(payer, solUsdcPool, USDC, sLeg.outAmount); }
  catch (e) { u2s = await jupiterSwapIx(payer, USDC, SOL, sLeg.outAmount, ['raydium']); }
  ixs.push(...u2s.ixs);

  const finalSol = BigInt(u2s.outAmount);
  const profit = Number(finalSol - BigInt(solAmountLamports)) / 1e9;
  if (profit <= 0) return { ok: false, reason: `no profit (${profit.toFixed(6)} SOL)`, profit_sol: profit };

  ixs.push(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(JITO_TIP_ACCOUNT), lamports: tipLamports }));
  const conn = new Connection(nextRpcUrl(), 'confirmed');
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message([]);
  const vtx = new VersionedTransaction(msg);
  vtx.sign([payer]);
  const raw = Buffer.from(vtx.serialize()).toString('base64');
  return { ok: true, raw, profit_sol: profit, engine: `sol->usdc->${buyDex}->${sellDex}->sol` };
 } catch(e) {
  return { ok: false, reason: 'builderr: ' + e.message?.slice(0, 60), profit_sol: 0 };
 }
}
