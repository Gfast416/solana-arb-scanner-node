// build_cross_dex.js — advanced per-DEX: beli di DEX_A, jual di DEX_B, 1 atomic tx
// Engine: raydium/orca SDK (per-DEX beneran), jupiter dexes[] (fallback)
import { Connection, Keypair, PublicKey, SystemProgram, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { USDC, JITO_TIP_ACCOUNT, nextRpcUrl } from './config.js';
import { dexSwapIx } from './dex_pool.js';

// opp: { token_addr, dexA, dexB, priceA, priceB, pairA, pairB }
// pairA/pairB = pool address di DexScreener (pairAddress)
export async function buildCrossDexTx(opp, payer, amountInUsd = 1_000_000, tipLamports = 5000) {
  const tokenMint = opp.token_addr;
  if (!tokenMint) throw new Error('no token_addr');

  const buyDex = opp.priceA < opp.priceB ? opp.dexA : opp.dexB;
  const sellDex = opp.priceA < opp.priceB ? opp.dexB : opp.dexA;
  const buyPool = opp.priceA < opp.priceB ? opp.pairA : opp.pairB;
  const sellPool = opp.priceA < opp.priceB ? opp.pairB : opp.pairA;

  // Leg 1: USDC -> TOKEN di buyDex (pool buyPool)
  const leg1 = await dexSwapIx(payer, buyDex, buyPool, USDC, tokenMint, amountInUsd);
  // Leg 2: TOKEN -> USDC di sellDex (pool sellPool)
  const leg2 = await dexSwapIx(payer, sellDex, sellPool, tokenMint, USDC, leg1.outAmount);

  const outUsdc = BigInt(leg2.outAmount);
  const profit = Number(outUsdc - BigInt(amountInUsd));
  if (profit <= 0) return { ok: false, reason: `no profit (${profit/1e6} USD)`, profit_usd: profit / 1e6 };

  // setup ATA (USDC + TOKEN) biar swap gak gagal "no token account"
  const ixs = [];
  for (const m of [USDC, tokenMint]) {
    const ata = getAssociatedTokenAddressSync(new PublicKey(m), payer.publicKey);
    ixs.push(createAssociatedTokenAccountInstruction(payer.publicKey, ata, payer.publicKey, new PublicKey(m)));
  }
  ixs.push(...leg1.ixs, ...leg2.ixs);
  ixs.push(SystemProgram.transfer({
    fromPubkey: payer.publicKey, toPubkey: new PublicKey(JITO_TIP_ACCOUNT), lamports: tipLamports,
  }));

  const rpcUrl = nextRpcUrl();
  const conn = new Connection(rpcUrl, 'confirmed');
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message([]);
  const vtx = new VersionedTransaction(msg);
  vtx.sign([payer]);
  const raw = Buffer.from(vtx.serialize()).toString('base64');

  return { ok: true, raw, buyDex, sellDex, profit_usd: profit / 1e6 };
}
