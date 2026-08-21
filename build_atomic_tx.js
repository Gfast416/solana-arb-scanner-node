// build_atomic_tx.js — 1 tx atomic via Jupiter /swap (base64) -> extract + merge
import {
  Connection, Keypair, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction, SystemProgram,
  Transaction, AddressLookupTableAccount,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { USDC, SOL, JITO_TIP_ACCOUNT, JUP_HEADERS } from './config.js';
import { nextRpcUrl } from './config.js';

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

// Ambil instructions dari Jupiter /swap (base64 tx) tanpa sign
// Pakai asLegacyTransaction:true biar gak ada ALT lookup (lebih robust)
export async function getSwapInstructionsRaw(quote, userPubkey, attempt = 0) {
  const r = await _postJson(JUP_SWAP, {
    quoteResponse: quote,
    userPublicKey: userPubkey,
    wrapAndUnwrapSol: false,
    dynamicComputeUnitLimit: true,
    useSharedAccounts: true,
    prioritizationFeeLamports: 0, // FEE OPT: priority fee 0
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

// Gabungin banyak swap jadi 1 atomic tx + Jito tip.
// 2-pass: (1) deserialize semua leg + kumpulkan ALT, (2) fetch ALT lalu extract + merge.
export async function buildAtomicTx(quotes, payer, connection, tipLamports = 5000) {
  const rpcUrl = nextRpcUrl();
  const conn = connection || new Connection(rpcUrl, 'confirmed');
  const user = payer.publicKey;
  const allIxs = [];
  const altSet = new Set();
  const legMsgs = [];

  // PASS 1: deserialize semua leg, kumpulkan ALT lookups
  for (const q of quotes) {
    const raw = await getSwapInstructionsRaw(q, user.toBase58());
    let msg;
    try {
      msg = VersionedTransaction.deserialize(raw).message;
    } catch {
      // legacy tx (asLegacyTransaction:true) -> extract langsung, preserve signer/writable
      const tx = Transaction.from(raw);
      for (const ix of tx.instructions) {
        if (ix.programId.toBase58() === 'ComputeBudget111111111111111111111111111111') continue;
        const keys = ix.keys.map(k => ({ pubkey: k.pubkey, isSigner: k.isSigner, isWritable: k.isWritable }));
        allIxs.push(new TransactionInstruction({ programId: ix.programId, keys, data: ix.data }));
      }
      continue;
    }
    for (const lk of msg.addressTableLookups) altSet.add(lk.accountKey.toBase58());
    legMsgs.push(msg);
  }

  // Fetch ALT on-chain (sekali untuk semua), pakai key dari legMsgs biar match reference
  const altByKey = {};
  const alts = [];
  for (const msg of legMsgs) {
    for (const lk of msg.addressTableLookups) {
      const k = lk.accountKey.toBase58();
      if (altByKey[k]) continue;
      try {
        const info = await conn.getAccountInfo(lk.accountKey);
        if (info) {
          const deser = AddressLookupTableAccount.deserialize(info.data);
          const addrs = deser.addresses || [];
          altByKey[k] = addrs;
          alts.push(new AddressLookupTableAccount({ key: lk.accountKey, state: { addresses: addrs, authority: undefined, deactivationSlot: 0n, lastExtendedSlot: 0n, lastExtendedSlotStartIndex: 0 } }));
        }
      } catch { /* skip */ }
    }
  }

  // PASS 2: extract compiled instructions tiap leg, resolve ALT manual
  for (const msg of legMsgs) {
    const accountKeys = msg.staticAccountKeys; // static keys
    for (const ci of msg.compiledInstructions) {
      const programId = accountKeys[ci.programIdIndex];
      if (programId.toBase58() === 'ComputeBudget111111111111111111111111111111') continue;
      const keys = [];
      let unresolved = false;
      for (const idx of ci.accountKeyIndexes) {
        let pk;
        if (idx < accountKeys.length) {
          pk = accountKeys[idx];
        } else {
          const altIdx = idx - accountKeys.length;
          let found = null;
          for (const lk of msg.addressTableLookups) {
            const wi = lk.writableIndexes || [];
            const ri = lk.readonlyIndexes || [];
            if (altIdx < wi.length) { found = altByKey[lk.accountKey.toBase58()]?.[wi[altIdx]]; break; }
            const roIdx = altIdx - wi.length;
            if (roIdx < ri.length) { found = altByKey[lk.accountKey.toBase58()]?.[ri[roIdx]]; break; }
          }
          pk = found;
        }
        if (!pk) { unresolved = true; break; }
        keys.push({ pubkey: pk, isSigner: msg.isAccountSigner(idx), isWritable: msg.isAccountWritable(idx) });
      }
      if (unresolved) continue;
      if (!keys.length) continue;
      allIxs.push(new TransactionInstruction({ programId, keys, data: ci.data || Buffer.alloc(0) }));
    }
  }

  // Jito tip
  allIxs.push(SystemProgram.transfer({
    fromPubkey: user, toPubkey: new PublicKey(JITO_TIP_ACCOUNT), lamports: tipLamports,
  }));

  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: user, recentBlockhash: blockhash, instructions: allIxs,
  }).compileToV0Message(alts);
  const vtx = new VersionedTransaction(msg);
  vtx.sign([payer]);
  return vtx;
}

export { USDC, SOL };
