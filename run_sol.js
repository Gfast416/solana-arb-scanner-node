// run_sol.js — SOL-centric live loop (cross-dex + circular), safer + faster + risk-managed
import 'dotenv/config';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { loadKeypair } from './executor.js';
import { WATCH_TOKENS, nextRpcUrl, SOL } from './config.js';
import { pairsByToken, findMispricing } from './dexscreener.js';
import { buildSolRouterFast } from './sol_router.js';
import { findCircular, buildCircularTx } from './circular.js';
import { scanAll, validateOnChain } from './multi_scanner.js';
import { simulateTx, getSolBalance, log, sleep } from './utils.js';
import * as risk from './risk.js';
import * as metrics from './metrics.js';

const DRY_RUN = (process.env.DRY_RUN || 'true') === 'true';
let MIN_PROFIT_PCT = parseFloat(process.env.MIN_PROFIT_PCT || '0.05');
const _modalSol = (parseInt(process.env.SOL_AMOUNT_LAMPORTS || '10000000')) / 1e9;
const _autoNet = _modalSol * (MIN_PROFIT_PCT / 100);
if (_autoNet > 0.000005) {
  MIN_PROFIT_PCT = Math.max(0.01, (0.000002 / _modalSol) * 100);
  console.log(`  ⚠️ MIN_PROFIT_PCT auto-clamp ke ${MIN_PROFIT_PCT.toFixed(2)}% (biar opp kecil gak false-skip)`);
}
const SOL_AMOUNT = parseInt(process.env.SOL_AMOUNT_LAMPORTS || '10000000');
const JITO_REGIONS = (process.env.JITO_REGIONS || 'frankfurt,nyc,amsterdam,tokyo').split(',').map(s => s.trim()).filter(Boolean);
const JITO_REGION = process.env.JITO_REGION || JITO_REGIONS[0];
const JITO_URL = `https://${JITO_REGION}.bundle-router.jito.wtf/api/v1/bundles`;
const LOOP_MS = parseInt(process.env.LOOP_MS || '4000'); // TURUN 12s -> 4s
const MAX_CANDIDATES = parseInt(process.env.MAX_CANDIDATES || '3'); // paralel N candidate
const MIN_WALLET_SOL = 0.02;

async function findSolOpps() {
  try {
    const cands = await scanAll(MIN_PROFIT_PCT);
    return cands.filter(c => !risk.isBlacklisted(c.token_addr)).slice(0, MAX_CANDIDATES);
  } catch (_) { return []; }
}

async function submitBundle(rawBase64, retries = 3) {
  let lastErr;
  // Coba semua region (fallback kalau 1 region unreachable)
  for (const region of JITO_REGIONS) {
    const url = `https://${region}.bundle-router.jito.wtf/api/v1/bundles`;
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [[rawBase64]] }),
          signal: AbortSignal.timeout(8000),
        });
        const j = await res.json();
        if (j?.result) { JITO_REGION = region; return j; } // sukses, update region
        if (j?.error) { lastErr = new Error(JSON.stringify(j.error).slice(0, 80)); continue; }
        return j;
      } catch (e) {
        lastErr = e;
        log(`[JITO ${region}] fetch failed (attempt ${i+1}/${retries}): ${e.message?.slice(0,40)}`, 'info');
        await sleep(800 * (i + 1));
      }
    }
  }
  throw lastErr || new Error('jito submit failed all regions');
}

async function safeExecute(rawBase64, profitSol, label, tokenAddr) {
  const vtx = VersionedTransaction.deserialize(Buffer.from(rawBase64, 'base64'));
  metrics.markStage('sim');
  const sim = await simulateTx(vtx);
  metrics.endStage('sim');
  if (!sim.ok) {
    const isRetryable = /6024|6025|0x1788|0x1789|InvalidSeeds|InvalidAccountData/.test(sim.err || '');
    if (isRetryable) { log(`[RETRY] slippage/stale: ${sim.err}`, 'info'); return { retry: true, reason: sim.err }; }
    log(`[SIM FAIL] ${label}: ${sim.err}`, 'err');
    if (sim.logs) console.log('  logs:', sim.logs.join(' | '));
    metrics.inc('simFail');
    return { retry: false };
  }
  metrics.inc('simOk');
  log(`[SIM OK] ${label} units=${sim.units} profit~${profitSol?.toFixed(6)} SOL`, 'ok');

  if (DRY_RUN) { log('[DRY_RUN] not submitting', 'info'); return { retry: false }; }

  const TIP = risk.dynamicTip();
  const MIN_NET = Math.max(TIP / 1e9, (_modalSol) * (MIN_PROFIT_PCT / 100)) * 0.5; // 0.5x epsilon
  if (profitSol <= MIN_NET) {
    log(`[SKIP] profit ${profitSol?.toFixed(6)} <= min net ${MIN_NET.toFixed(6)}`, 'err');
    return { retry: false };
  }

  let res;
  const USE_JITO = (process.env.USE_JITO || 'false') === 'true';
  if (USE_JITO) {
    try {
      res = await submitBundle(rawBase64);
      if (res?.result) {
        log(`[SUBMITTED] bundle ${res.result} tip=${TIP}`, 'ok');
        metrics.inc('submitted');
        const status = await pollBundleStatus(res.result);
        log(`[BUNDLE STATUS] ${status}`, 'info');
        if (status === 'confirmed' || status === 'finalized' || status === 'landed') {
          metrics.inc('landed');
          risk.recordSuccess(profitSol);
        } else {
          risk.recordFail(0);
          if (tokenAddr) risk.blacklistToken(tokenAddr);
        }
        return { retry: false };
      }
    } catch (e) {
      log(`[JITO FAIL] ${e.message?.slice(0, 50)} -> fallback RPC`, 'err');
    }
  }
  // DEFAULT: submit langsung lewat RPC + micro priority fee (cepat land, gas rendah)
  try {
    const conn = new Connection(nextRpcUrl(), 'confirmed');
    // skipPreflight=true biar gak nunggu, maxRetries=0 biar cepat (priority fee yg bikin land)
    const sig = await conn.sendRawTransaction(Buffer.from(rawBase64, 'base64'), {
      skipPreflight: true,
      maxRetries: 0,
      preflightCommitment: 'processed',
    });
    log(`[RPC SUBMITTED] ${sig.slice(0, 16)}... (micro priority, no Jito tip)`, 'ok');
    metrics.inc('submitted');
    risk.recordSuccess(profitSol);
    return { retry: false };
  } catch (e) {
    log(`[SUBMIT NET ERR] ${e.message?.slice(0, 50)} (retry next round)`, 'err');
    return { retry: false };
  }
}

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

async function tryCrossDex(o, payer) {
  metrics.inc('scanned');
  // On-chain double-check (kurangi DexScreener false positive)
  const ok = await validateOnChain(o).catch(() => true); // kalau RPC error, tetep lanjut (Jupiter yg validasi)
  if (!ok) { metrics.inc('falsePositive'); log(`[SKIP] onchain pool missing ${o.token} ${o.dexA}/${o.dexB}`, 'err'); return true; }
  let executed = false;
  for (let attempt = 0; attempt < 3 && !executed; attempt++) {
    if (attempt > 0) log(`  retry build (slippage) attempt ${attempt+1}/3...`);
    try {
      metrics.markStage('build');
      const r = await buildSolRouterFast(o, payer, SOL_AMOUNT, risk.dynamicTip());
      metrics.endStage('build');
      metrics.inc('built');
      const res = await safeExecute(r.raw, r.profitSol, r.engine, o.token_addr);
      if (res && res.retry) { await sleep(500); continue; }
      executed = true;
    } catch (e) {
      if (/6024|6025|0x1788|0x1789/.test(e.message || '')) { await sleep(500); continue; }
      // fetch failed = network error (RPC/Jito), BUKAN token error -> jangan blacklist, retry loop
      if (/fetch failed|network|ECONN|ETIMEDOUT|timeout/i.test(e.message || '')) { await sleep(800); continue; }
      metrics.inc('falsePositive');
      log(`[BUILD ERR] ${e.message?.slice(0, 70)}`, 'err');
      risk.blacklistToken(o.token_addr);
      break;
    }
  }
  return executed;
}

async function loop() {
  console.log('='.repeat(60));
  console.log(' SOL-CENTRIC ARB (cross-dex + circular) — v2 faster+risk');
  console.log('='.repeat(60));
  console.log(` DRY_RUN=${DRY_RUN} | MIN_PROFIT=${MIN_PROFIT_PCT}% | SOL/test=${SOL_AMOUNT / 1e9}`);
  console.log(` JITO=${JITO_REGION} | LOOP=${LOOP_MS}ms | PARALLEL=${MAX_CANDIDATES}`);
  const payer = loadKeypair(process.env.WALLET_PRIVATE_KEY);
  console.log(` WALLET: ${payer.publicKey.toBase58()}`);

  while (true) {
    try {
      // Circuit breaker
      const cb = risk.isCircuitOpen();
      if (cb.open) { log(`🛑 CIRCUIT OPEN: ${cb.reason}. Stop.`, 'err'); break; }

      const bal = await getSolBalance(payer.publicKey.toBase58());
      if (bal / 1e9 < MIN_WALLET_SOL) { log(`Wallet SOL terlalu rendah. Stop.`, 'err'); break; }

      // 1) Cross-dex (parallel N candidate)
      const found = await findSolOpps();
      if (found.length) {
        for (const o of found) {
          log(`OPP cross_dex ${o.token} ${o.pct}% ${o.dexA}->${o.dexB}`);
          await tryCrossDex(o, payer);
        }
      } else {
        // 2) Circular fallback
        const circ = await findCircular(SOL_AMOUNT);
        if (circ) {
          log(`OPP circular ${circ.path.map(p => p.slice(0, 4)).join('→')} +${circ.profit.toFixed(6)} SOL`);
          try {
            const tx = await buildCircularTx(circ, payer, risk.dynamicTip());
            if (tx.ok) await safeExecute(tx.raw, circ.profit, 'circular');
          } catch (e) { log(`circular build fail: ${e.message?.slice(0, 80)}`, 'err'); }
        } else {
          log('no opp, waiting...');
        }
      }
      // Metrics tiap loop
      if (Math.random() < 0.1) log(metrics.summary(), 'info');
    } catch (e) {
      log(`loop err: ${String(e).slice(0, 120)}`, 'err');
    }
    await sleep(LOOP_MS);
  }
}

loop();
