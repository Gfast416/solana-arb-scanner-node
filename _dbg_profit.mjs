import { Keypair } from '@solana/web3.js';
import { pairsByToken, findMispricing } from './dexscreener.js';
import { meteoraSwapIx, orcaSwapIx } from './dex_swap.js';
import { USDC } from './config.js';
const payer = Keypair.generate();
const d = await pairsByToken('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN');
const opps = findMispricing(d.pairs, 3.0).filter(o => o.route.includes('meteora') && o.route.includes('orca'));
console.log('found opps:', opps.length);
for (const o of opps.slice(0,3)) {
  console.log(`\n${o.pct}% ${o.route} | priceA=${o.priceA} priceB=${o.priceB} | pairA=${o.pairA?.slice(0,10)} pairB=${o.pairB?.slice(0,10)}`);
  const buyDex = o.priceA < o.priceB ? o.dexA : o.dexB;
  const sellDex = o.priceA < o.priceB ? o.dexB : o.dexA;
  const buyPool = o.priceA < o.priceB ? o.pairA : o.pairB;
  const sellPool = o.priceA < o.priceB ? o.pairB : o.pairA;
  console.log('  buyDex', buyDex, 'sellDex', sellDex);
  try {
    const l1 = await meteoraSwapIx(payer, buyPool, USDC, 1_000_000, true);
    console.log('  leg1 meteora USDC->JUP out JUP:', l1.outAmount);
    const l2 = await orcaSwapIx(payer, sellPool, 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', l1.outAmount, false);
    console.log('  leg2 orca JUP->USDC out USDC:', l2.outAmount);
    const profit = Number(BigInt(l2.outAmount) - BigInt(1_000_000))/1e6;
    console.log('  profit USD:', profit.toFixed(6));
  } catch(e){ console.log('  ERR', e.message); }
}
