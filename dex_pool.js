// dex_pool.js — cross-dex atomic: raydium/orca via RAW SDK, meteora via Jupiter dexes[] filter
// beli di DEX_A, jual di DEX_B, 1 VersionedTransaction
import { Connection, Keypair, PublicKey, SystemProgram, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { USDC, JITO_TIP_ACCOUNT, nextRpcUrl } from './config.js';
import { raydiumSwapIx, orcaSwapIx, meteoraSwapIx, jupiterSwapIx } from './dex_swap.js';

function dexEngine(dex) {
  const d = (dex || '').toLowerCase();
  if (d.includes('raydium')) return 'raydium';
  if (d.includes('orca')) return 'orca';
  if (d.includes('meteora')) return 'meteora';
  return null;
}

// opp: { token_addr, dexA, dexB, priceA, priceB, pairA, pairB }
// pairA/pairB = pool address (DexScreener pairAddress) untuk DEX masing-masing
export async function buildCrossDexAtomic(opp, payer, amountInUsd = 1_000_000, tipLamports = 5000) {
  const tokenMint = opp.token_addr;
  if (!tokenMint) return { ok: false, reason: 'no token_addr' };
  const buyDex = opp.priceA < opp.priceB ? opp.dexA : opp.dexB;
  const sellDex = opp.priceA < opp.priceB ? opp.dexB : opp.dexA;
  const buyPool = opp.priceA < opp.priceB ? opp.pairA : opp.pairB;
  const sellPool = opp.priceA < opp.priceB ? opp.pairB : opp.pairA;

  const eBuy = dexEngine(buyDex), eSell = dexEngine(sellDex);
  if (!eBuy || !eSell) return { ok: false, reason: `unsupported dex pair: ${buyDex}/${sellDex}` };

  // Leg 1: USDC -> TOKEN @ buyDex
  let leg1;
  try {
    if (eBuy === 'raydium') leg1 = await raydiumSwapIx(payer, buyPool, USDC, amountInUsd);
    else if (eBuy === 'orca') leg1 = await orcaSwapIx(payer, buyPool, USDC, amountInUsd, USDC === 'So11111111111111111111111111111111111111112' ? false : true);
    else if (eBuy === 'meteora') leg1 = await meteoraSwapIx(payer, buyPool, USDC, amountInUsd, true);
    else leg1 = await jupiterSwapIx(payer, USDC, tokenMint, amountInUsd, ['meteora']);
  } catch (e) { return { ok: false, reason: `leg1 ${eBuy} failed: ${e.message}` }; }

  // Leg 2: TOKEN -> USDC @ sellDex (pakai output leg1)
  let leg2;
  try {
    if (eSell === 'raydium') leg2 = await raydiumSwapIx(payer, sellPool, tokenMint, leg1.outAmount);
    else if (eSell === 'orca') leg2 = await orcaSwapIx(payer, sellPool, tokenMint, leg1.outAmount, tokenMint === 'So11111111111111111111111111111111111111112' ? true : false);
    else if (eSell === 'meteora') leg2 = await meteoraSwapIx(payer, sellPool, tokenMint, leg1.outAmount, false);
    else leg2 = await jupiterSwapIx(payer, tokenMint, USDC, leg1.outAmount, ['meteora']);
  } catch (e) { return { ok: false, reason: `leg2 ${eSell} failed: ${e.message}` }; }

  const outUsdc = BigInt(leg2.outAmount);
  const profit = Number(outUsdc - BigInt(amountInUsd));
  if (profit <= 0) return { ok: false, reason: `no profit (${profit / 1e6} USD)`, profit_usd: profit / 1e6 };

  // Gabungin SEMUA ix (ATA + swap A + swap B) + Jito tip = 1 atomic tx
  const ixs = [...leg1.ixs, ...leg2.ixs, SystemProgram.transfer({
    fromPubkey: payer.publicKey, toPubkey: new PublicKey(JITO_TIP_ACCOUNT), lamports: tipLamports,
  })];

  const rpcUrl = nextRpcUrl();
  const conn = new Connection(rpcUrl, 'confirmed');
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message([]);
  const vtx = new VersionedTransaction(msg);
  vtx.sign([payer]);
  const raw = Buffer.from(vtx.serialize()).toString('base64');

  return { ok: true, raw, buyDex, sellDex, profit_usd: profit / 1e6, engine: `${eBuy}-${eSell}` };
}
