// dex_swap.js — per-DEX swap instruction builders (advanced, no aggregate)
// Engine: raydium (SDK V2), orca (Whirlpools SDK), jupiter (dexes[] filter fallback)
import { Connection, Keypair, PublicKey, TransactionInstruction, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { Raydium, CurveCalculator, FeeOn, TxVersion } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import { getQuote } from './build_atomic_tx.js';
import { nextRpcUrl } from './config.js';

// -------- RAYDIUM --------
let _raydium = null;
async function getRaydium(payer) {
  if (_raydium) return _raydium;
  const conn = new Connection(nextRpcUrl(), 'confirmed');
  _raydium = await Raydium.load({ owner: payer, connection: conn, cluster: 'mainnet', disableFeatureCheck: true, blockhashCommitment: 'confirmed' });
  return _raydium;
}

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
  const { transaction } = await raydium.cpmm.swap({
    poolInfo, inputAmount, swapResult, slippage, baseIn, txVersion: TxVersion.V0,
  });
  // transaction = VersionedTransaction utuh (termasuk setup ATA)
  const msg = transaction.message;
  const ixs = msg.compiledInstructions
    .filter(ci => msg.staticAccountKeys[ci.programIdIndex].toBase58() !== 'ComputeBudget111111111111111111111111111111')
    .map(ci => {
      const programId = msg.staticAccountKeys[ci.programIdIndex];
      const keys = ci.accountKeyIndexes.map(idx => ({ pubkey: msg.staticAccountKeys[idx], isSigner: false, isWritable: false }));
      return new TransactionInstruction({ programId, keys, data: ci.data });
    });
  return { ixs, outAmount: swapResult.outputAmount.toString() };
}

// -------- ORCA --------
export async function orcaSwapIx(payer, whirlpoolAddr, amount, aToB = true) {
  const { WhirlpoolContext, ORCA_WHIRLPOOL_PROGRAM_ID, buildWhirlpoolClient, buildDefaultAccountFetcher, swapQuoteByInputToken } = await import('@orca-so/whirlpools-sdk');
  const { Percentage } = await import('@orca-so/common-sdk');
  const conn = new Connection(nextRpcUrl(), 'confirmed');
  const ctx = WhirlpoolContext.from(conn, payer, ORCA_WHIRLPOOL_PROGRAM_ID);
  ctx.fetcher = buildDefaultAccountFetcher(conn);
  const client = buildWhirlpoolClient(ctx);
  const pool = await client.getPool(new PublicKey(whirlpoolAddr));
  const quote = await swapQuoteByInputToken(ctx, pool, BigInt(amount), Percentage.fromFraction(1, 100), aToB);
  const txData = await pool.swap(quote, payer.publicKey, aToB);
  // txData = { instructions, signers } atau tx builder; extract
  if (txData.instructions) {
    return { ixs: txData.instructions, outAmount: quote.estimatedAmountOut.toString() };
  }
  // fallback: txData adalah Transaction/VersionedTransaction
  return { tx: txData, outAmount: quote.estimatedAmountOut.toString() };
}

// -------- JUPITER (dexes[] filter fallback) --------
export async function jupiterSwapIx(payer, inputMint, outputMint, amount, dexes = null) {
  const q = await getQuote(inputMint, outputMint, amount, 50, dexes ? { dexes } : {});
  if (!q || !q.outAmount) throw new Error('no jupiter quote');
  const r = await fetch('https://api.jup.ag/swap/v1/swap-instructions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: payer.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, useSharedAccounts: true, prioritizationFeeLamports: 0 }),
  }).then(res => res.json());
  if (r.error) throw new Error('jupiter swap err: ' + r.error);
  const conn = new Connection(nextRpcUrl(), 'confirmed');
  const vtx = VersionedTransaction.deserialize(Buffer.from(r.swapTransaction, 'base64'));
  const msg = vtx.message;
  const ixs = msg.compiledInstructions.map(ci => {
    const programId = msg.staticAccountKeys[ci.programIdIndex];
    const keys = ci.accountKeyIndexes.map(idx => ({ pubkey: msg.staticAccountKeys[idx], isSigner: false, isWritable: false }));
    return new TransactionInstruction({ programId, keys, data: ci.data });
  });
  return { ixs, outAmount: q.outAmount };
}
