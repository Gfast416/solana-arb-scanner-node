// token_source.js — DYNAMIC token list (gak terbatas list statis).
// Pakai DexScreener /search?q= dengan multi-query (a-z, 0-9) buat dapet banyak token.
// Return Set of [mint, symbol] yang aktif/likuid.
import { _getJson } from './dexscreener.js';
const BASE = 'https://api.dexscreener.com/latest/dex';

export async function fetchDynamicTokens(limit = 150) {
  const tokens = new Map();
  const queries = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
  await Promise.all(queries.map(async (q) => {
    try {
      const d = await _getJson(`${BASE}/search?q=${q}`);
      for (const p of (d?.pairs || [])) {
        if (p.chainId === 'solana' && p.baseToken?.address) {
          tokens.set(p.baseToken.address, p.baseToken.symbol || '?');
        }
      }
    } catch {}
  }));
  // Juga tambah top SOL & USDC pairs (paling likuid)
  for (const base of ['So11111111111111111111111111111111111111112','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']) {
    try {
      const d = await _getJson(`${BASE}/tokens/${base}`);
      for (const p of (d?.pairs || []).slice(0, 50)) {
        if (p.chainId === 'solana' && p.baseToken?.address && p.baseToken.address !== base) {
          tokens.set(p.baseToken.address, p.baseToken.symbol || '?');
        }
      }
    } catch {}
  }
  return [...tokens.entries()].slice(0, limit);
}
