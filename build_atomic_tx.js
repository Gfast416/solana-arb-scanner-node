// build_atomic_tx.js — 1 tx atomic via Jupiter /swap (V0+ALT) -> extract robust + Jito tip
import {
  Connection, Keypair, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction, SystemProgram,
  Transaction, AddressLookupTableAccount, ComputeBudgetProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';
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

// Ambil instructions dari Jupiter /swap (base64 tx) tanpa sign
// V0+ALT (default) biar support >256 accounts
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

// Gabungin banyak swap jadi 1 atomic tx (V0+ALT) + Jito tip.
// Pakai getAccountKeys(alts) utk resolve (cara web3.js resmi) -> robust, gak InvalidSeeds.
export async function buildAtomicTx(quotes, payer, connection, tipLamports = 5000) {
  const rpcUrl = nextRpcUrl();
  const conn = connection || new Connection(rpcUrl, 'confirmed');
  const user = payer.publicKey;
  const allIxs = [];
  const altSet = new Set();
  const legMsgs = [];

  // PASS 1: deserialize semua leg, kumpulkan ALT
  for (const q of quotes) {
    const raw = await getSwapInstructionsRaw(q, user.toBase58());
    let msg;
    try {
      msg = VersionedTransaction.deserialize(raw).message;
    } catch {
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
    for (const lk of msg.addressTableLookups) altSet.add(lk.accountKey.toBase58());
    legMsgs.push(msg);
  }

  // Fetch ALT on-chain (sekali)
  const alts = [];
  const altByKey = {};
  for (const addr of altSet) {
    try {
      const info = await conn.getAccountInfo(new PublicKey(addr));
      if (info) {
        const deser = AddressLookupTableAccount.deserialize(info.data);
        const addrs = deser.state?.addresses || deser.addresses || [];
        altByKey[addr] = addrs;
        alts.push(new AddressLookupTableAccount({ key: new PublicKey(addr), state: { addresses: addrs, authority: undefined, deactivationSlot: 0n, lastExtendedSlot: 0n, lastExtendedSlotStartIndex: 0 } }));
      }
    } catch { /* skip */ }
  }

  // PASS 2: extract + resolve pakai getAccountKeys (resmi)
  for (const msg of legMsgs) {
    let resolved;
    try { resolved = msg.getAccountKeys(alts); }
    catch { resolved = null; }
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

  // ComputeBudget: priority fee mikro (bikin cepat land, gas tetap rendah)
  // unitPrice ~1000 microlamport/CU, limit ~200k CU -> ~0.000002 SOL total
  const MICRO_PRIORITY = parseInt(process.env.MICRO_PRIORITY_MICRO || '1000');
  allIxs.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: MICRO_PRIORITY }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 250000 })
  );

  // Jito tip (cuma kalau USE_JITO=true, default skip biar gas rendah)
  if ((process.env.USE_JITO || 'false') === 'true') {
    allIxs.push(SystemProgram.transfer({
      fromPubkey: user, toPubkey: new PublicKey(JITO_TIP_ACCOUNT), lamports: tipLamports,
    }));
  }

  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: user, recentBlockhash: blockhash, instructions: allIxs,
  }).compileToV0Message(alts);
  const vtx = new VersionedTransaction(msg);
  vtx.sign([payer]);
  return vtx;
}

export { USDC, SOL };
