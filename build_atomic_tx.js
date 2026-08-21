// build_atomic_tx.js — 1 tx atomic via Jupiter /swap (base64) -> extract + merge
import {
  Connection, Keypair, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction, SystemProgram,
  AddressLookupTableAccount,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { USDC, SOL, JITO_TIP_ACCOUNT } from './config.js';
import { nextRpcUrl } from './config.js';

const JUP_QUOTE = 'https://api.jup.ag/swap/v1/quote';
const JUP_SWAP = 'https://api.jup.ag/swap/v1/swap';

async function _postJson(url, payload, headers = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', ...headers },
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
        if (useFilter && extra.dexes) extra.dexes.forEach(d => params.append('dexes[]', d));
        const r = await fetch(`${JUP_QUOTE}?${params}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } });
        if (r.ok) {
          const j = await r.json();
          if (j && j.outAmount) return j;
        }
      } catch (e) { /* retry */ }
      await new Promise(res => setTimeout(res, 600 * (attempt + 1)));
    }
    return null;
  }
  // Coba dengan filter dexes dulu, kalau gagal fallback no-filter
  let q = extra.dexes ? await _try(true) : null;
  if (!q) q = await _try(false);
  return q;
}

// Ambil compiled instructions dari Jupiter /swap (base64 tx) tanpa sign
async function getSwapInstructionsRaw(quote, userPubkey) {
  const r = await _postJson(JUP_SWAP, {
    quoteResponse: quote,
    userPublicKey: userPubkey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    useSharedAccounts: true,
    prioritizationFeeLamports: 0, // FEE OPT: priority fee 0
  });
  if (r.error) throw new Error('swap err: ' + r.error);
  return Buffer.from(r.swapTransaction, 'base64');
}

// Gabungin banyak swap jadi 1 VersionedTransaction (V0 + ALT) + Jito tip
export async function buildAtomicTx(quotes, payer, connection, tipLamports = 5000) {
  const rpcUrl = nextRpcUrl();
  const conn = connection || new Connection(rpcUrl, 'confirmed');
  const user = payer.publicKey;
  const allIxs = [];
  const altMap = new Map(); // key -> AddressLookupTableAccount

  for (const q of quotes) {
    const raw = await getSwapInstructionsRaw(q, user.toBase58());
    const vtx = VersionedTransaction.deserialize(raw);
    const msg = vtx.message;
    // resolve ALT state map dulu
    const altStates = {};
    for (const lookup of msg.addressTableLookups) {
      const k = lookup.accountKey.toBase58();
      if (!altMap.has(k)) {
        try {
          const info = await connection.getAccountInfo(lookup.accountKey);
          if (info) {
            const deser = AddressLookupTableAccount.deserialize(info.data);
            altMap.set(k, deser.state ? deser : { key: lookup.accountKey, state: { addresses: deser.addresses } });
          }
        } catch { /* skip */ }
      }
      altStates[k] = altMap.get(k)?.state?.addresses || [];
    }
    // extract compiled instructions -> TransactionInstruction
    for (const ci of msg.compiledInstructions) {
      const programId = msg.staticAccountKeys[ci.programIdIndex];
      // STRIP priority fee (ComputeBudget111...SetComputeUnitPrice) -> fee = 0
      if (programId.toBase58() === 'ComputeBudget111111111111111111111111111111') continue;
      const keys = ci.accountKeyIndexes.map(idx => {
        let pubkey;
        if (idx < msg.staticAccountKeys.length) pubkey = msg.staticAccountKeys[idx];
        else {
          // ALT lookup: cari di altStates
          const altIdx = idx - msg.staticAccountKeys.length;
          const lookup = msg.addressTableLookups.find(l => true);
          const st = altStates[lookup.accountKey.toBase58()] || [];
          pubkey = st[altIdx] || msg.staticAccountKeys[idx];
        }
        return { pubkey, isSigner: false, isWritable: false };
      });
      allIxs.push(new TransactionInstruction({ programId, keys, data: ci.data }));
    }
  }

  // Jito tip
  allIxs.push(SystemProgram.transfer({
    fromPubkey: user, toPubkey: new PublicKey(JITO_TIP_ACCOUNT), lamports: tipLamports,
  }));

  const alts = [...altMap.values()];
  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: user, recentBlockhash: blockhash, instructions: allIxs,
  }).compileToV0Message(alts.length ? alts : []);
  return new VersionedTransaction(msg);
}

export { USDC, SOL };
