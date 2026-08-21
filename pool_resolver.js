// pool_resolver.js — resolve ON-CHAIN pool address dari (tokenA, tokenB) per DEX
// DexScreener pairAddress sering SALAH (bukan on-chain address) -> kita derive sendiri
import { PublicKey, Connection } from '@solana/web3.js';
import { nextRpcUrl } from './config.js';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';

const ap = fileURLToPath(new URL('./vendor/anchor29/dist/cjs/index.js', import.meta.url));
const a29 = createRequire(ap)(ap);
import meta from '@meteora-ag/dlmm-sdk';
const METEORA_IDL = JSON.parse(fs.readFileSync('./meteora_idl.json', 'utf8'));

export const METEORA_PROGRAM = new PublicKey(meta.LBCLMM_PROGRAM_IDS['mainnet-beta']);
const ORCA_PROGRAM = new PublicKey('whirLbMiicVdio4qvG2f3nNBdmdsTG4cYd8dQLfXJEu');
const ORCA_CONFIG = new PublicKey('2WBm6r2wQKf9o8WhHhR4sR8iHh9Y1q6VqLZJfYqH8XhZ'); // Orca whirlpool config (mainnet default)
const RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');

let _prov, _meteoraProgram;
async function getMeteoraProgram() {
  if (_meteoraProgram) return _meteoraProgram;
  const conn = new Connection(nextRpcUrl(), 'confirmed');
  const dummy = (await import('@solana/web3.js')).Keypair.generate();
  const wallet = { publicKey: dummy.publicKey, signTransaction: async t => t, signAllTransactions: async t => t };
  const provider = new a29.AnchorProvider(conn, wallet, { commitment: 'confirmed' });
  _meteoraProgram = new a29.Program(METEORA_IDL, METEORA_PROGRAM, provider);
  return _meteoraProgram;
}

const BIN_STEPS = [1, 5, 10, 20, 25, 50, 75, 100, 150, 200, 300, 340, 500, 1000];

function sortTokenMints(a, b) {
  const ab = a.toBuffer(), bb = b.toBuffer();
  return ab.compare(bb) < 0 ? [a, b] : [b, a];
}

// Resolve Meteora lbPair on-chain (manual PDA derivation, brute binStep)
export async function resolveMeteora(tokenA, tokenB) {
  const program = await getMeteoraProgram();
  const conn = program.provider.connection;
  const A = new PublicKey(tokenA), B = new PublicKey(tokenB);
  const [minKey, maxKey] = sortTokenMints(A, B);
  for (const bs of BIN_STEPS) {
    const [addr] = PublicKey.findProgramAddressSync(
      [minKey.toBuffer(), maxKey.toBuffer(), Buffer.from(new Uint16Array([bs]).buffer)],
      METEORA_PROGRAM
    );
    try {
      const lp = await program.account.lbPair.fetch(addr);
      const x = lp.tokenXMint.toString(), y = lp.tokenYMint.toString();
      if ((x === tokenA && y === tokenB) || (x === tokenB && y === tokenA)) {
        return { address: addr.toString(), binStep: bs, tokenX: x, tokenY: y };
      }
    } catch (e) { /* not this binStep */ }
  }
  return null;
}

const TICKS = [1, 2, 4, 8, 16, 32, 64, 96, 128, 256, 384, 512, 1024, 2048, 4096];

// Resolve Orca whirlpool on-chain (brute tickSpacing)
export async function resolveOrca(tokenA, tokenB) {
  const { PublicKey: PK } = await import('@solana/web3.js');
  const A = new PublicKey(tokenA), B = new PublicKey(tokenB);
  const [minMint, maxMint] = A.toBuffer().compare(B.toBuffer()) < 0 ? [A, B] : [B, A];
  for (const ts of TICKS) {
    const buf = new Uint8Array(2);
    new DataView(buf.buffer).setUint16(0, ts, true);
    const [addr] = PK.findProgramAddressSync(
      [ORCA_CONFIG.toBuffer(), minMint.toBuffer(), maxMint.toBuffer(), buf],
      ORCA_PROGRAM
    );
    const conn = new Connection(nextRpcUrl(), 'confirmed');
    try {
      const acc = await conn.getAccountInfo(addr);
      if (acc) return { address: addr.toString(), tickSpacing: ts };
    } catch (e) {}
  }
  return null;
}

// Resolve by DEX name
export async function resolvePool(dex, tokenA, tokenB) {
  const d = dex.toLowerCase();
  if (d.includes('meteora')) return resolveMeteora(tokenA, tokenB);
  if (d.includes('orca') || d.includes('whirlpool')) return resolveOrca(tokenA, tokenB);
  if (d.includes('raydium')) return resolveRaydium(tokenA, tokenB);
  return null;
}

// Resolve Raydium CPMM pool on-chain (PDA: [AMM_CONFIG, tokenX, tokenY])
const RAYDIUM_AMM_CONFIGS = [
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // V4 (legacy)
  'CPMMoo8L3F4NbTegBCKVNunggAiXnqqN1DZG1fekEju6', // CPMM
];
export async function resolveRaydium(tokenA, tokenB) {
  const A = new PublicKey(tokenA), B = new PublicKey(tokenB);
  const [minMint, maxMint] = A.toBuffer().compare(B.toBuffer()) < 0 ? [A, B] : [B, A];
  for (const cfg of RAYDIUM_AMM_CONFIGS) {
    const cfgKey = new PublicKey(cfg);
    const [addr] = PublicKey.findProgramAddressSync(
      [cfgKey.toBuffer(), minMint.toBuffer(), maxMint.toBuffer()],
      RAYDIUM_CPMM
    );
    try {
      const conn = new Connection(nextRpcUrl(), 'confirmed');
      const acc = await conn.getAccountInfo(addr);
      if (acc) return { address: addr.toString(), config: cfg };
    } catch (e) {}
  }
  return null;
}
