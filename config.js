// config.js — DEX program IDs, token watchlist, threshold, multi-RPC

// Multi-RPC: pisahkan dengan koma di .env (RPC_URLS=a,b,c)
// Atau RPC_HTTP single (backward compatible)
export function getRpcUrls() {
  if (process.env.RPC_URLS) {
    return process.env.RPC_URLS.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (process.env.RPC_HTTP) return [process.env.RPC_HTTP.trim()];
  return ['https://api.mainnet-beta.solana.com'];
}

// Round-robin + failover RPC manager
let _idx = 0;
export function nextRpcUrl() {
  const urls = getRpcUrls();
  const u = urls[_idx % urls.length];
  _idx = (_idx + 1) % urls.length;
  return u;
}

export const DEX_PROGRAM_IDS = {
  RAYDIUM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNunggAiXnqqN1DZG1fekEju6',
  METEORA_DLMM: 'LbVRzDTjHzY9fAPw7CcpQ5S9UfeCdXsB8oaR5wWn9jS',
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  JUPITER_V6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
};

// Threshold misprice antar DEX (persen). > ini = peluang.
export const MISPRICE_THRESHOLD_PCT = 3.0;

// Token lama yang di-track khusus (kasus AOW/USD2 style) + token liquid buat execute
export const WATCH_TOKENS = {
  '9AwxXsDhtpey1xTPvWvJjXy1uJ9g6Kq3ZVZ8kZv9pump': 'AOW9',
  'CaNC8DjrRuY17zrqNyHKYD91pVofPsXchFr1kh2nsfUw': 'USD2',
  // Token liquid (Jupiter bisa route) — biar execute beneran jalan
  'So11111111111111111111111111111111111111112': 'SOL',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'WIF',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP',
};

export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOL = 'So11111111111111111111111111111111111111112';

// Jito tip account (standard)
export const JITO_TIP_ACCOUNT = 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY';
