// dex_swap.js — per-DEX swap instruction builders (advanced, no aggregate)
// Engine: raydium (raw CPMM instruction, bypass ATA-check), orca (Whirlpools SDK), jupiter (dexes[] filter fallback)
import { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { Raydium, CurveCalculator, FeeOn, TxVersion, makeSwapCpmmBaseInInstruction, getPdaObservationId } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { getQuote } from './build_atomic_tx.js';
import { nextRpcUrl } from './config.js';

// -------- RAYDIUM (raw, bypass ATA-check) --------
let _raydium = null;
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
  const q = await getQuote(inputMint, outputMint, amount, 50, dexes ? { dexes } : {});
  if (!q || !q.outAmount) throw new Error('no jupiter quote');
  const r = await fetch('https://api.jup.ag/swap/v1/swap-instructions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: payer.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, useSharedAccounts: true, prioritizationFeeLamports: 0 }),
  }).then(res => res.json());
  if (r.error) throw new Error('jupiter swap err: ' + r.error);
  const { TransactionInstruction, PublicKey } = await import('@solana/web3.js');
  const ixs = [];
  // setup (ATA create, dll)
  for (const ins of (r.setupInstructions || [])) {
    ixs.push(new TransactionInstruction({
      programId: new PublicKey(ins.programId),
      keys: ins.accounts.map(a => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
      data: Buffer.from(ins.data, 'base64'),
    }));
  }
  // swap utama
  const si = r.swapInstruction;
  ixs.push(new TransactionInstruction({
    programId: new PublicKey(si.programId),
    keys: si.accounts.map(a => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(si.data, 'base64'),
  }));
  // cleanup (close WSOL)
  if (r.cleanupInstruction) {
    const ci = r.cleanupInstruction;
    ixs.push(new TransactionInstruction({
      programId: new PublicKey(ci.programId),
      keys: ci.accounts.map(a => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
      data: Buffer.from(ci.data, 'base64'),
    }));
  }
  return { ixs, outAmount: q.outAmount };
}
