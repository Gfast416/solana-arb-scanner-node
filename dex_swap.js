// dex_swap.js — per-DEX swap instruction builders (advanced, no aggregate)
// Engine: raydium (raw CPMM), orca (raw Whirlpool), meteora (raw DLMM), jupiter (fallback)
import { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { Raydium, CurveCalculator, FeeOn, TxVersion, makeSwapCpmmBaseInInstruction, getPdaObservationId } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { getQuote } from './build_atomic_tx.js';
import { nextRpcUrl } from './config.js';
import meta from '@meteora-ag/dlmm-sdk';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { readFileSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// Vendored @coral-xyz/anchor@0.29.0 — Meteora DLMM needs this exact version,
// while Orca Whirlpools SDK needs anchor 0.32 (top-level). Loaded separately to avoid conflict.
const _anchor29Path = fileURLToPath(new URL('./vendor/anchor29/dist/cjs/index.js', import.meta.url));
const _require29 = createRequire(_anchor29Path);
const anchor29 = _require29(_anchor29Path);
const ABN = anchor29.BN;
const Prog29 = anchor29.Program;
const AP29 = anchor29.AnchorProvider;

// ---- Patched meteora swapQuote (normalize BN args) ----
const _origSwapQuote = meta.LBCLMM.prototype.swapQuote;
meta.LBCLMM.prototype.swapQuote = function (inAmount, swapForY, allowedSlippage, binArrays) {
  const amt = (inAmount && inAmount.isZero) ? inAmount : new ABN(inAmount.toString());
  const slip = (allowedSlippage && allowedSlippage.isZero) ? allowedSlippage : new ABN(allowedSlippage.toString());
  return _origSwapQuote.call(this, amt, swapForY, slip, binArrays);
};
const METEORA_IDL = JSON.parse(readFileSync(path.join(process.cwd(), 'meteora_idl.json'), 'utf8'));
let _meteoraProgram = null;
async function getMeteoraProgram() {
  if (_meteoraProgram) return _meteoraProgram;
  const conn = new Connection(nextRpcUrl(), 'confirmed');
  const dummy = Keypair.generate();
  const wallet = { publicKey: dummy.publicKey, signTransaction: async t => t, signAllTransactions: async t => t };
  const provider = new AP29(conn, wallet, { commitment: 'confirmed' });
  _meteoraProgram = new Prog29(METEORA_IDL, meta.LBCLMM_PROGRAM_IDS['mainnet-beta'], provider);
  return _meteoraProgram;
}

// -------- METEORA (raw DLMM, 100% bypass Jupiter) --------
// Meteora butuh anchor 0.29 (bundled di ./vendor/anchor29) biar gak konflik dgn orca (0.32)
export async function meteoraSwapIx(payer, poolAddrStr, inputMint, amount, aToB) {
  const program = await getMeteoraProgram();
  const conn = program.provider.connection;
  const poolAddr = new PublicKey(poolAddrStr);
  const lbPair = await program.account.lbPair.fetch(poolAddr);
  // Validasi: pool harus punya inputMint + USDC, kalau gak -> throw (skip, jangan rugi)
  const tokX = lbPair.tokenXMint.toString(), tokY = lbPair.tokenYMint.toString();
  const USDC_M = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  if (tokX !== inputMint && tokY !== inputMint) throw new Error('meteora pool token mismatch (input)');
  if (tokX !== USDC_M && tokY !== USDC_M) throw new Error('meteora pool token mismatch (USDC)');
  const tokenX = { publicKey: lbPair.tokenXMint, reserve: lbPair.tokenXVault, amount: lbPair.tokenXAmount, decimal: lbPair.tokenXDecimal };
  const tokenY = { publicKey: lbPair.tokenYMint, reserve: lbPair.tokenYVault, amount: lbPair.tokenYAmount, decimal: lbPair.tokenYDecimal };
  const dlmm = new meta.LBCLMM(poolAddr, program, lbPair, null, tokenX, tokenY, { cluster: 'mainnet-beta' });
  const binArrays = await dlmm.getBinArrays();
  const inMint = new PublicKey(inputMint);
  const swapForY = inMint.equals(new PublicKey(lbPair.tokenXMint));
  const quote = await dlmm.swapQuote(new ABN(amount.toString()), swapForY, 100, binArrays);
  const tx = await dlmm.swap({
    inToken: inMint,
    outToken: swapForY ? new PublicKey(lbPair.tokenYMint) : new PublicKey(lbPair.tokenXMint),
    inAmount: new ABN(amount.toString()),
    minOutAmount: quote.minOutAmount,
    lbPair: poolAddr,
    user: payer.publicKey,
    binArraysPubkey: quote.binArraysPubkey,
  });
  return { ixs: tx.instructions, outAmount: quote.minOutAmount.toString() };
}

// -------- RAYDIUM (raw, bypass ATA-check) --------
let _raydium = null;
const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
async function getRaydium(payer) {
  if (_raydium) return _raydium;
  const conn = new Connection(nextRpcUrl(), 'confirmed');
  _raydium = await Raydium.load({ owner: payer, connection: conn, cluster: 'mainnet', disableFeatureCheck: true, blockhashCommitment: 'confirmed' });
  return _raydium;
}

// poolId: Raydium CPMM pool address. inputMint: mint token masuk. returns { ixs, outAmount }
export async function raydiumSwapIx(payer, poolId, inputMint, amount, slippage = 0.001) {
  const raydium = await getRaydium(payer);
  const data = await raydium.api.fetchPoolById({ ids: poolId });
  const poolInfo = data[0];
  if (!poolInfo) throw new Error('pool not found');
  if (poolInfo.programId !== RAYDIUM_CPMM_PROGRAM) {
    throw new Error(`not CPMM pool (${poolInfo.programId?.slice(0,8)})`);
  }
  const rpcData = await raydium.cpmm.getRpcPoolInfo(poolInfo.id, true);
  const baseIn = inputMint === poolInfo.mintA.address;
  const inputAmount = new BN(amount.toString());
  const swapResult = CurveCalculator.swapBaseInput(
    inputAmount,
    baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
    baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
    rpcData.configInfo.tradeFeeRate, rpcData.configInfo.creatorFeeRate,
    rpcData.configInfo.protocolFeeRate, rpcData.configInfo.fundFeeRate,
    rpcData.feeOn === FeeOn.BothToken || rpcData.feeOn === FeeOn.OnlyTokenB
  );
  const poolKeys = await raydium.cpmm.getCpmmPoolKeys(poolId);
  const mintA = new PublicKey(poolInfo.mintA.address);
  const mintB = new PublicKey(poolInfo.mintB.address);
  const ataA = getAssociatedTokenAddressSync(mintA, payer.publicKey);
  const ataB = getAssociatedTokenAddressSync(mintB, payer.publicKey);
  const inputTokenProgram = new PublicKey(poolInfo.mintA.programId ?? TOKEN_PROGRAM_ID);
  const outputTokenProgram = new PublicKey(poolInfo.mintB.programId ?? TOKEN_PROGRAM_ID);
  const observationId = getPdaObservationId(new PublicKey(poolInfo.programId), new PublicKey(poolInfo.id)).publicKey;
  const swapIx = makeSwapCpmmBaseInInstruction(
    new PublicKey(poolInfo.programId), payer.publicKey,
    new PublicKey(poolKeys.authority), new PublicKey(poolKeys.config.id),
    new PublicKey(poolInfo.id),
    baseIn ? ataA : ataB, baseIn ? ataB : ataA,
    new PublicKey(poolKeys.vault[baseIn ? 'A' : 'B']), new PublicKey(poolKeys.vault[baseIn ? 'B' : 'A']),
    inputTokenProgram, outputTokenProgram,
    baseIn ? mintA : mintB, baseIn ? mintB : mintA,
    observationId,
    inputAmount, swapResult.outputAmount
  );
  // ATA setup (aman ditambah; kalau sudah ada on-chain, chain akan skip/no-op)
  const ixs = [
    createAssociatedTokenAccountInstruction(payer.publicKey, ataA, payer.publicKey, mintA),
    createAssociatedTokenAccountInstruction(payer.publicKey, ataB, payer.publicKey, mintB),
    swapIx,
  ];
  return { ixs, outAmount: swapResult.outputAmount.toString() };
}

// -------- ORCA (Whirlpools SDK raw, bypass aggregate) --------
export async function orcaSwapIx(payer, whirlpoolAddr, inputMint, amount, aToB) {
  const { WhirlpoolContext, WhirlpoolIx, swapQuoteByInputToken, buildDefaultAccountFetcher, buildWhirlpoolClient, PDAUtil } = await import('@orca-so/whirlpools-sdk');
  const { Percentage } = await import('@orca-so/common-sdk');
  const { Connection, PublicKey } = await import('@solana/web3.js');
  const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
  const BN = (await import('bn.js')).default;
  const conn = new Connection(nextRpcUrl(), 'confirmed');
  const fetcher = buildDefaultAccountFetcher(conn);
  const ctx = WhirlpoolContext.from(conn, payer, fetcher);
  const client = buildWhirlpoolClient(ctx);
  const poolAddr = new PublicKey(whirlpoolAddr);
  const pool = await client.getPool(poolAddr);
  const mintA = new PublicKey(pool.tokenAInfo.mint.toString());
  const mintB = new PublicKey(pool.tokenBInfo.mint.toString());
  const tokenMint = new PublicKey(inputMint);
  const aToBFinal = tokenMint.equals(mintA); // input di mintA -> aToB true
  const quote = await swapQuoteByInputToken(pool, tokenMint, new BN(amount.toString()), Percentage.fromFraction(1, 100), ctx.program.programId, fetcher);
  const ataA = getAssociatedTokenAddressSync(mintA, payer.publicKey);
  const ataB = getAssociatedTokenAddressSync(mintB, payer.publicKey);
  const vaultA = new PublicKey(pool.tokenVaultAInfo.address.toString());
  const vaultB = new PublicKey(pool.tokenVaultBInfo.address.toString());
  const oracle = PDAUtil.getOracle(ctx.program.programId, poolAddr).publicKey;
  const ixBuild = WhirlpoolIx.swapIx(ctx.program, {
    whirlpool: poolAddr, tokenAuthority: payer.publicKey,
    tokenOwnerAccountA: ataA, tokenOwnerAccountB: ataB,
    tokenVaultA: vaultA, tokenVaultB: vaultB, oracle, ...quote,
  });
  // ixBuild.instructions = array of TransactionInstruction
  const ixs = ixBuild.instructions || [ixBuild];
  return { ixs, outAmount: quote.estimatedAmountOut.toString() };
}

// -------- JUPITER (dexes[] filter fallback, format baru: instructions terpisah) --------
export async function jupiterSwapIx(payer, inputMint, outputMint, amount, dexes = null) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const q = await getQuote(inputMint, outputMint, amount, 50, dexes ? { dexes } : {});
      if (!q || !q.outAmount) throw new Error('no jupiter quote');
      const r = await fetch('https://api.jup.ag/swap/v1/swap-instructions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteResponse: q, userPublicKey: payer.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, useSharedAccounts: true, prioritizationFeeLamports: 0 }),
      }).then(res => res.json());
      if (r.error) throw new Error('jupiter swap err: ' + r.error);
      const { TransactionInstruction, PublicKey } = await import('@solana/web3.js');
      const ixs = [];
      const _ins = (ins) => {
        if (!ins || !ins.programId || typeof ins.programId !== 'string') return null;
        if (ins.accounts && !Array.isArray(ins.accounts)) return null;
        let data = Buffer.alloc(0);
        try { if (typeof ins.data === 'string' && ins.data.length) data = Buffer.from(ins.data, 'base64'); } catch (e) { return null; }
        try {
          return new TransactionInstruction({
            programId: new PublicKey(ins.programId),
            keys: (ins.accounts || []).filter(a => a && a.pubkey).map(a => ({ pubkey: new PublicKey(typeof a.pubkey === 'string' ? a.pubkey : a.pubkey.toBase58()), isSigner: !!a.isSigner, isWritable: !!a.isWritable })),
            data,
          });
        } catch (e) { return null; }
      };
      for (const ins of (r.computeBudgetInstructions || [])) { const ix = _ins(ins); if (ix) ixs.push(ix); }
      for (const ins of (r.setupInstructions || [])) { const ix = _ins(ins); if (ix) ixs.push(ix); }
      const swapIx = _ins(r.swapInstruction);
      if (!swapIx) throw new Error('jupiter swapInstruction invalid');
      ixs.push(swapIx);
      if (r.cleanupInstruction) { const ci = _ins(r.cleanupInstruction); if (ci) ixs.push(ci); }
      for (const ins of (r.otherInstructions || [])) { const ix = _ins(ins); if (ix) ixs.push(ix); }
      return { ixs, outAmount: q.outAmount };
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 400)); }
  }
  throw new Error(lastErr?.message || 'jupiterSwapIx failed');
}
