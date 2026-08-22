// run_sol.js — SOL-centric live loop (cross-dex + circular, safer version)
import 'dotenv/config';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { loadKeypair, USE_JITO } from './executor.js';
import { WATCH_TOKENS, nextRpcUrl, SOL } from './config.js';
import { pairsByToken, findMispricing } from './dexscreener.js';
import { buildSolRouter } from './sol_router.js';
import { findCircular, buildCircularTx } from './circular.js';
import { scanAll, validateWithJupiter } from './multi_scanner.js';
import { simulateTx, getSolBalance, log, sleep } from './utils.js';

const DRY_RUN = (process.env.DRY_RUN || 'true') === 'true';
const MIN_PROFIT_PCT = parseFloat(process.env.MIN_PROFIT_PCT || '0.1');
const TIP = parseInt(process.env.JITO_TIP_LAMPORTS || '5000');
const SOL_AMOUNT = parseInt(process.env.SOL_AMOUNT_LAMPORTS || '10000000');
const JITO_REGION = process.env.JITO_REGION || 'frankfurt';
const JITO_URL = `https://${JITO_REGION}.bundle-router.jito.wtf/api/v1/bundles`;
const LOOP_MS = parseInt(process.env.LOOP_MS || '12000');
const MIN_WALLET_SOL = 0.02; // minimal SOL di wallet biar gak kehabisan fee

async function findSolOpp() {
  // Scan dari BANYAK sumber (DexScreener + on-chain Meteora/Orca/Raydium), lalu validasi Jupiter
  try {
    const cands = await scanAll(MIN_PROFIT_PCT);
    for (const c of cands) {
      const v = await validateWithJupiter(c, SOL_AMOUNT);
      if (v && v.profitSol > 0) return { type: 'cross_dex', opp: v };
    }
  } catch (_) {}
  return null;
}

async function submitBundle(rawBase64) {
  const res = await fetch(JITO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [[rawBase64]] }),
  });
  return res.json();
}

async function safeExecute(rawBase64, profitSol, label) {
  // 1. Deserialize & simulate
  const vtx = VersionedTransaction.deserialize(Buffer.from(rawBase64, 'base64'));
  const sim = await simulateTx(vtx);
  if (!sim.ok) {
    // 6024/6025 = slippage/stale quote -> caller bisa rebuild dari quote fresh
    // InvalidSeeds = ATA extract rusak (intermittent) -> rebuild juga bisa bener
    const isRetryable = /6024|6025|0x1788|0x1789|InvalidSeeds|InvalidAccountData/.test(sim.err || '');
    if (isRetryable) return { retry: true, reason: sim.err };
    log(`[SIM FAIL] ${label}: ${sim.err}`, 'err');
    if (sim.logs) console.log('  logs:', sim.logs.join(' | '));
    return { retry: false };
  }
  log(`[SIM OK] ${label} units=${sim.units} profit~${profitSol?.toFixed(6)} SOL`, 'ok');

  if (DRY_RUN) { log('[DRY_RUN] not submitting', 'info'); return { retry: false }; }

  // 2. Profit guard — persentase dari modal, floor cuma tip (biar opp kecil bisa execute)
  const MIN_NET = Math.max(TIP / 1e9, (SOL_AMOUNT / 1e9) * (MIN_PROFIT_PCT / 100));
  if (profitSol <= MIN_NET) {
    log(`[SKIP] profit ${profitSol?.toFixed(6)} <= min net ${MIN_NET.toFixed(6)} (${MIN_PROFIT_PCT}% dari modal)`, 'err');
    return { retry: false };
  }

  // 3. Submit + confirm via bundle status polling
  const res = await submitBundle(rawBase64);
  if (res?.result) {
    log(`[SUBMITTED] bundle ${res.result}`, 'ok');
    // Polling status (terkirim != sukses)
    const status = await pollBundleStatus(res.result);
    log(`[BUNDLE STATUS] ${status}`, 'info');
  } else {
    log(`[SUBMIT ERR] ${JSON.stringify(res).slice(0, 120)}`, 'err');
  }
  return { retry: false };
}

// Poll getBundleStatuses sampai landed/confirmed/rejected
async function pollBundleStatus(bundleId, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await fetch(JITO_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBundleStatuses', params: [[bundleId]] }),
      });
      const j = await r.json();
      const st = j?.result?.value?.[0]?.confirmationStatus;
      if (st && (st === 'confirmed' || st === 'finalized' || st === 'landed')) return st;
      if (st === 'rejected' || st === 'failed') return st;
    } catch (_) {}
    await sleep(2000);
  }
  return 'timeout';
}

async function loop() {
  console.log('='.repeat(60));
  console.log(' SOL-CENTRIC ARB (cross-dex + circular) — safer version');
  console.log('='.repeat(60));
  console.log(` DRY_RUN=${DRY_RUN} | MIN_PROFIT=${MIN_PROFIT_PCT}% | SOL/test=${SOL_AMOUNT / 1e9}`);
  console.log(` JITO=${JITO_REGION} | LOOP=${LOOP_MS}ms`);
  const payer = loadKeypair(process.env.WALLET_PRIVATE_KEY);
  console.log(` WALLET: ${payer.publicKey.toBase58()}`);

  while (true) {
    try {
      // Cek balance dulu
      const bal = await getSolBalance(payer.publicKey.toBase58());
      if (bal / 1e9 < MIN_WALLET_SOL) {
        log(`Wallet SOL terlalu rendah (${(bal / 1e9).toFixed(4)}). Stop.`, 'err');
        break;
      }

      // 1) Cross-dex — rebuild sampai 3x kalau kena slippage (quote stale)
      const found = await findSolOpp();
      if (found) {
        const o = found.opp;
        log(`OPP cross_dex ${o.token} ${o.pct}% ${o.route}`);
        let executed = false;
        for (let attempt = 0; attempt < 3 && !executed; attempt++) {
          if (attempt > 0) log(`  retry build (slippage) attempt ${attempt+1}/3...`);
          const r = await buildSolRouter(o, payer, SOL_AMOUNT, TIP);
          if (!r.ok) { log(`[SKIP] ${r.reason}`, 'err'); break; }
          const res = await safeExecute(r.raw, r.profit_sol, r.engine);
          if (res && res.retry) { await sleep(800); continue; } // quote stale -> rebuild fresh
          executed = true;
        }
      } else {
        // 2) Circular
        const circ = await findCircular(SOL_AMOUNT);
        if (circ) {
          log(`OPP circular ${circ.path.map(p => p.slice(0, 4)).join('→')} +${circ.profit.toFixed(6)} SOL`);
          try {
            const tx = await buildCircularTx(circ, payer, TIP);
            if (tx.ok) await safeExecute(tx.raw, circ.profit, 'circular');
          } catch (e) { log(`circular build fail: ${e.message?.slice(0, 80)}`, 'err'); }
        } else {
          log('no opp, waiting...');
        }
      }
    } catch (e) {
      log(`loop err: ${String(e).slice(0, 120)}`, 'err');
    }
    await sleep(LOOP_MS);
  }
}

loop();
