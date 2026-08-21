// utils.js — shared helpers
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { nextRpcUrl } from './config.js';

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function withRetry(fn, retries = 4, baseMs = 400) {
  let last;
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const wait = baseMs * Math.pow(1.6, i) + Math.random() * 200;
      await sleep(wait);
    }
  }
  throw last;
}

/** Create ATA only if missing (idempotent) — accept PublicKey or string mint.
 *  Skip WSOL (So111...11112) karena WSOL ATA tidak lewat Associated Token program. */
export function createAtaIdempotent(payer, mint) {
  const WSOL = 'So11111111111111111111111111111111111111112';
  const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
  if (mintStr === WSOL) return null;
  const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const ata = getAssociatedTokenAddressSync(mintPk, payer.publicKey);
  return createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey, ata, payer.publicKey, mintPk
  );
}

export async function getSolBalance(pubkey) {
  const conn = new Connection(nextRpcUrl(), 'confirmed');
  return conn.getBalance(new PublicKey(pubkey));
}

/** Simulate VersionedTransaction, return { ok, err, units } */
export async function simulateTx(vtx, commitment = 'processed') {
  const conn = new Connection(nextRpcUrl(), commitment);
  try {
    const sim = await conn.simulateTransaction(vtx, { sigVerify: false, commitment });
    if (sim.value.err) {
      return { ok: false, err: JSON.stringify(sim.value.err), logs: sim.value.logs?.slice(-8) };
    }
    return { ok: true, units: sim.value.unitsConsumed, logs: sim.value.logs?.slice(-5) };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

export function log(msg, level = 'info') {
  const ts = new Date().toISOString();
  const prefix = level === 'err' ? '❌' : level === 'ok' ? '✅' : 'ℹ️';
  console.log(`[${ts}] ${prefix} ${msg}`);
}
