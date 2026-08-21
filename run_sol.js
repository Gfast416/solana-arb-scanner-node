// run_sol.js — SOL-centric live loop (auto-adapt: SOL->...->SOL)
// Wallet cuma butuh SOL. Strategi adapts ke misprice:
//   token X vs USDC misprice -> SOL->USDC->X(buy)->USDC(sell)->SOL
// DRY_RUN=true (default): build + simulate, jangan submit. Set DRY_RUN=false di .env buat execute.
import 'dotenv/config';
import { Keypair, Connection, VersionedTransaction } from '@solana/web3.js';
import { loadKeypair, USE_JITO } from './executor.js';
import { WATCH_TOKENS, nextRpcUrl, JITO_TIP_ACCOUNT } from './config.js';
import { pairsByToken, findMispricing } from './dexscreener.js';
import { buildSolRouter } from './sol_router.js';

const DRY_RUN = (process.env.DRY_RUN || 'true') === 'true';
const MIN_PROFIT_PCT = parseFloat(process.env.MIN_PROFIT_PCT || '0.5');
const TIP = parseInt(process.env.JITO_TIP_LAMPORTS || '5000');
const SOL_AMOUNT = parseInt(process.env.SOL_AMOUNT_LAMPORTS || '10_000_000'); // 0.01 SOL default test

async function findSolOpp() {
  for (const tok of Object.keys(WATCH_TOKENS)) {
    const d = await pairsByToken(tok);
    const opps = findMispricing(d.pairs, MIN_PROFIT_PCT);
    if (opps.length) return opps[0];
  }
  return null;
}

async function executeSol(opp, payer) {
  const r = await buildSolRouter(opp, payer, SOL_AMOUNT, TIP);
  if (!r.ok) return console.log(`   [SKIP] ${r.reason}`);
  console.log(`   [BUILD OK] engine: ${r.engine} | sim profit: ${r.profit_sol?.toFixed(6)} SOL`);
  if (DRY_RUN) { console.log('   [DRY_RUN] not submitting (set DRY_RUN=false to execute)'); return; }
  // GUARD: cuma submit kalau profit nyata > tip + buffer (jangan rugi tip doang)
  const MIN_NET = (TIP + 2_000_000) / 1e9; // tip + 0.002 SOL buffer
  if (r.profit_sol <= MIN_NET) { console.log(`   [SKIP] profit ${r.profit_sol?.toFixed(6)} <= min net ${MIN_NET.toFixed(6)} SOL`); return; }
  // submit via Jito
  const fetchJITO = async (raw) => fetch(`https://frankfurt.bundle-router.jito.wtf/api/v1/bundles`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [[raw]] }),
  }).then(r => r.json());
  const res = await fetchJITO(r.raw);
  console.log(`   [SUBMITTED] bundle ${res?.result || JSON.stringify(res)?.slice(0,60)}`);
}

async function loop() {
  console.log('='.repeat(60));
  console.log(' SOL-CENTRIC ARB EXECUTOR (auto-adapt SOL->...->SOL)');
  console.log('='.repeat(60));
  console.log(` DRY_RUN: ${DRY_RUN} | MIN_PROFIT: ${MIN_PROFIT_PCT}% | SOL/test: ${SOL_AMOUNT/1e9}`);
  const payer = loadKeypair(process.env.WALLET_PRIVATE_KEY);
  console.log(` WALLET: ${payer.publicKey.toBase58()}`);
  while (true) {
    try {
      const opp = await findSolOpp();
      if (opp) {
        console.log(`\n[${new Date().toISOString()}] OPP cross_dex ${opp.token} ${opp.pct}%  ${opp.route}`);
        await executeSol(opp, payer);
      } else {
        console.log(`[${new Date().toISOString()}] no opp, waiting...`);
      }
    } catch (e) { console.log('   loop err:', String(e).slice(0, 100)); }
    await new Promise(r => setTimeout(r, 15000));
  }
}
loop();
