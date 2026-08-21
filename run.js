// run.js — loop otomatis detect -> execute
import { findOpportunity, executeOpportunity, loadKeypair, USE_JITO } from './executor.js';
import { WATCH_TOKENS } from './config.js';

async function loop() {
  console.log('='.repeat(60));
  console.log(' SOLANA ARBITRAGE EXECUTOR — auto loop (Node.js)');
  console.log('='.repeat(60));

  while (true) {
    try {
      const opp = await findOpportunity();
      if (opp) {
        const [o, pct] = opp;
        console.log(`\n[${new Date().toISOString()}] OPP ${o.type} ${o.token} ${pct}%`);
        console.log(`   route: ${o.route}`);
        if (o.token_addr && USE_JITO) {
          const [bid, info] = await executeOpportunity(o, 1_000_000);
          if (bid) console.log(`   [SUBMITTED] bundle ${bid} | profit~$${info.profit_usd}`);
          else console.log(`   [SKIP] ${info}`);
        }
      } else {
        console.log(`[${new Date().toISOString()}] no opp, waiting...`);
      }
    } catch (e) {
      console.log('   loop err:', String(e).slice(0, 80));
    }
    await new Promise(r => setTimeout(r, 15000));
  }
}

loop();
