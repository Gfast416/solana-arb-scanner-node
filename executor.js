// executor.js — load .env, keypair multi-format, detect + execute atomic
import 'dotenv/config';
import fs from 'fs';
import bs58 from 'bs58';
import { Keypair, Connection, VersionedTransaction } from '@solana/web3.js';
import { runAllMethods } from './methods.js';
import { buildAtomicTx, getQuote, USDC, SOL } from './build_atomic_tx.js';
import { WATCH_TOKENS } from './config.js';
import { getRpcUrls, nextRpcUrl } from './config.js';

const RPC_URLS = getRpcUrls();
const RPC_HTTP = RPC_URLS[0];
const WALLET_PK = process.env.WALLET_PRIVATE_KEY;
const USE_JITO = (process.env.USE_JITO || 'true') === 'true';
export { USE_JITO };
const MIN_PROFIT = parseFloat(process.env.MIN_PROFIT_PCT || '1.0');
const JITO_TIP = parseInt(process.env.JITO_TIP_LAMPORTS || '5000');
const JITO_REGION = process.env.JITO_REGION || 'frankfurt';
const JITO_URL = `https://${JITO_REGION}.bundle-router.jito.wtf/api/v1/bundles`;

// load keypair: support base58 / [uint8 array] / hex
export function loadKeypair(pkStr) {
  pkStr = pkStr.trim();
  if (pkStr.startsWith('[')) {
    const arr = JSON.parse(pkStr);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  if (/^[0-9a-fA-F]{128}$/.test(pkStr)) {
    return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(pkStr, 'hex')));
  }
  // base58
  return Keypair.fromSecretKey(bs58.decode(pkStr));
}

export async function findOpportunity() {
  const opps = await runAllMethods(MIN_PROFIT);
  return opps.length ? [opps[0], opps[0].profit_pct] : null;
}

// Execute opp: cross_dex & triangular sama2 = USDC->TOKEN->USDC via Jupiter, 1 ATOMIC tx
export async function executeOpportunity(opp, amountIn = 1_000_000) {
  const tokenMint = opp.token_addr;
  if (!tokenMint) return [null, 'no token_addr'];
  const rpcUrl = nextRpcUrl();
  const conn = new Connection(rpcUrl, 'confirmed');
  const payer = loadKeypair(WALLET_PK);
  const q1 = await getQuote(USDC, tokenMint, amountIn);
  if (!q1 || !q1.outAmount) return [null, 'no quote1'];
  const q2 = await getQuote(tokenMint, USDC, Math.floor(Number(q1.outAmount)));
  if (!q2 || !q2.outAmount) return [null, 'no quote2'];
  const out2 = Number(q2.outAmount);
  const profit = out2 - amountIn;
  if (profit <= 0) return [null, `no profit (${(profit/1e6).toFixed(4)} USD)`];

  const vtx = await buildAtomicTx([q1, q2], payer, conn, JITO_TIP);
  vtx.sign([payer]);
  const raw = Buffer.from(vtx.serialize()).toString('base64');

  if (USE_JITO) {
    const r = await fetchJITO(raw);
    return [r?.result, { profit_usd: profit/1e6, bundle: r?.result }];
  } else {
    const sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: true });
    return [sig, { profit_usd: profit/1e6, sig }];
  }
}

async function fetchJITO(rawTx) {
  try {
    const r = await fetch(JITO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [[rawTx]] }),
    });
    return await r.json();
  } catch (e) { return { error: String(e) }; }
}

// dry-run
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    console.log('RPC     :', RPC_HTTP.slice(0, 45), '...');
    console.log('WALLET  :', loadKeypair(WALLET_PK).publicKey.toBase58());
    console.log('USE_JITO:', USE_JITO, '| MIN_PROFIT:', MIN_PROFIT, '%');
    const opp = await findOpportunity();
    if (opp) console.log(`[OPP] ${opp[0].type} ${opp[0].token} ${opp[0].profit_pct}% -> ${opp[0].route}`);
    else console.log('[no opp found]');
  })();
}
