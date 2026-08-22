// build_atomic_tx.js — 1 tx atomic via Jupiter /swap (V0, ALT tolerant) -> merge + priority fee
// ALT-tolerant: pakai getAccountKeys() default (Jupiter SOL<->JUP gak pakai ALT, ALT:0).
// VERIFY: throw kalau gak ada swap instruction (biar gak submit tx kosong).
import {
  Connection, Keypair, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction, SystemProgram, Transaction,
  ComputeBudgetProgram, AddressLookupTableAccount,
} from '@solana/web3.js';
import { USDC, SOL, JITO_TIP_ACCOUNT, JUP_HEADERS, nextRpcUrl } from './config.js';

const JUP_QUOTE = 'https://api.jup.ag/swap/v1/quote';
const JUP_SWAP = 'https://api.jup.ag/swap/v1/swap';

async function _postJson(url, payload, headers = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', ...JUP_HEADERS, ...headers },
    body: JSON.stringify(payload),
  });
  return r.json();
}

export async function getQuote(inputMint, outputMint, amount, slippageBps = 50, extra = {}) {
  async function _try(useFilter) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const params = new URLSearchParams({
          inputMint, outputMint, amount: String(amount), slippageBps: String(slippageBps),
        });
        if (useFilter && extra.dexes && extra.dexes.length) extra.dexes.filter(Boolean).forEach(d => params.append('dexes[]', d));
        const r = await fetch(`${JUP_QUOTE}?${params}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', ...JUP_HEADERS } });
        if (r.ok) {
          const j = await r.json();
          if (j && j.outAmount) return j;
        }
      } catch (e) { /* retry */ }
      await new Promise(res => setTimeout(res, 600 * (attempt + 1)));
    }
    return null;
  }
  let q = extra.dexes ? await _try(true) : null;
  if (!q) q = await _try(false);
  return q;
}

// Ambil instructions dari Jupiter /swap (V0, default — ALT handled by getAccountKeys)
export async function getSwapInstructionsRaw(quote, userPubkey, attempt = 0) {
  const r = await _postJson(JUP_SWAP, {
    quoteResponse: quote,
    userPublicKey: userPubkey,
    wrapAndUnwrapSol: false,
    dynamicComputeUnitLimit: true,
    useSharedAccounts: false,
    prioritizationFeeLamports: 0,
  });
  if (r.error) {
    if (attempt < 3) { await new Promise(res => setTimeout(res, 1500 * (attempt + 1))); return getSwapInstructionsRaw(quote, userPubkey, attempt + 1); }
    throw new Error('swap err: ' + JSON.stringify(r.error).slice(0, 80));
  }
  if (!r.swapTransaction) {
    const isTransient = r.code === 429 || (r.message && /rate|timeout|too many|try again/i.test(r.message));
    if (attempt < 4 && isTransient) { await new Promise(res => setTimeout(res, 2000 * (attempt + 1))); return getSwapInstructionsRaw(quote, userPubkey, attempt + 1); }
    console.error('[getSwapInstructionsRaw] no swapTransaction. code=', r.code, 'msg=', r.message?.slice?.(0,120));
    throw new Error('no swapTransaction in jupiter response');
  }
  return Buffer.from(r.swapTransaction, 'base64');
}

// Gabungin banyak swap jadi 1 atomic tx (V0) + micro priority fee.
export async function buildAtomicTx(quotes, payer, connection, tipLamports = 5000) {
  const rpcUrl = nextRpcUrl();
  const conn = connection || new Connection(rpcUrl, 'confirmed');
  const user = payer.publicKey;
  const allIxs = [];
  const legMsgs = [];

  // PASS 1: deserialize semua leg + fetch ALT (resmi via getAddressLookupTable)
  const altsResolved = [];
  for (const q of quotes) {
    const raw = await getSwapInstructionsRaw(q, user.toBase58());
    let msg;
    try { msg = VersionedTransaction.deserialize(raw).message; }
    catch {
      const tx = Transaction.from(raw);
      for (const ix of tx.instructions) {
        if (ix.programId.toBase58() === 'ComputeBudget111111111111111111111111111111') continue;
        const keys = ix.keys.map(k => ({ pubkey: k.pubkey, isSigner: k.isSigner, isWritable: k.isWritable }));
        if (ix.programId.toBase58() === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL') {
          const WSOL = 'So11111111111111111111111111111111111111112';
          if (keys[1]?.pubkey?.toBase58() === WSOL) continue;
        }
        allIxs.push(new TransactionInstruction({ programId: ix.programId, keys, data: ix.data }));
      }
      continue;
    }
    // Fetch ALT on-chain (resmi)
    for (const lk of msg.addressTableLookups) {
      try {
        const acc = await conn.getAddressLookupTable(lk.accountKey, 'confirmed');
        if (acc?.value) altsResolved.push(acc.value);
      } catch { /* skip */ }
    }
    legMsgs.push(msg);
  }

  // PASS 2: extract pakai getAccountKeys dengan ALT yang di-fetch
  for (const msg of legMsgs) {
    let resolved;
    try { resolved = msg.getAccountKeys({ usable: altsResolved }); } catch { resolved = null; }
    for (const ci of msg.compiledInstructions) {
      const programId = msg.staticAccountKeys[ci.programIdIndex];
      if (programId.toBase58() === 'ComputeBudget111111111111111111111111111111') continue;
      const keys = [];
      let unresolved = false;
      for (const idx of ci.accountKeyIndexes) {
        let pk = resolved ? resolved.get(idx) : null;
        if (!pk && idx < msg.staticAccountKeys.length) pk = msg.staticAccountKeys[idx];
        if (!pk) { unresolved = true; break; }
        keys.push({ pubkey: pk, isSigner: msg.isAccountSigner(idx), isWritable: msg.isAccountWritable(idx) });
      }
      if (unresolved || !keys.length) continue;
      if (programId.toBase58() === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL') {
        const WSOL = 'So11111111111111111111111111111111111111112';
        if (keys[1]?.pubkey?.toBase58() === WSOL) continue;
      }
      allIxs.push(new TransactionInstruction({ programId, keys, data: ci.data || Buffer.alloc(0) }));
    }
  }

  // VERIFY: harus ada minimal 1 swap (bukan cuma compute budget)
  const SKIP = ['ComputeBudget111111111111111111111111111111','11111111111111111111111111111111','TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'];
  const hasSwap = allIxs.some(ix => !SKIP.includes(ix.programId.toBase58()));
  if (!hasSwap) throw new Error('BUILD EMPTY: no swap instruction (ALT resolve failed?)');

  // Micro priority fee (cepat land, gas rendah)
  const MICRO_PRIORITY = parseInt(process.env.MICRO_PRIORITY_MICRO || '1000');
  allIxs.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: MICRO_PRIORITY }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 })
  );

  if ((process.env.USE_JITO || 'false') === 'true') {
    allIxs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: new PublicKey(JITO_TIP_ACCOUNT), lamports: tipLamports }));
  }

  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: allIxs }).compileToV0Message([]);
  const vtx = new VersionedTransaction(msg);
  vtx.sign([payer]);
  return vtx;
}

export { USDC, SOL };
