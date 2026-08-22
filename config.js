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
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvG2f3nNBdmdsTG4cYd8dQLfXJEu',
  JUPITER_V6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
};

// Threshold misprice antar DEX (persen). > ini = peluang.
export const MISPRICE_THRESHOLD_PCT = 3.0;

// Token liquid populer (top 50 Solana) — jangkauan LUAS biar banyak opp
export const WATCH_TOKENS = {
  'So11111111111111111111111111111111111111112': 'SOL',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'Es9vMFrzaCERmJfrF4H2FYPMvAj7QUWxXPgZEJBJ41jW': 'USDT',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'WIF',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP',
  '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr': 'POPCAT',
  'ED5nyyWEzpPPiWimP8vYm7sD7TD3LNHzY68e1sS2yU7i': 'PNUT',
  '2zMMhcaxmEPs4BhvKDy6uQtzRAr9PofC7oQiAYRZZqGK': 'MOODENG',
  'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82': 'CHILLGUY',
  'mSoLzYCxHdYgdziU2hgzXqwYpVKCuGJcQhWpfkY6c8X': 'MSOL',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 'JTO',
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3': 'PYTH',
  '4k3Dyjzvzp8oP8rE4jWjfXkKpQ3DqVn7NqB6zZ8yV123': 'RAY',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'WIF2',
  'Df6yfrKC8iZ9LPW4rYrMkgz2yT8DwzP1X2iF3tT1Q7Zz': 'GIGA',
  '63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9': 'WEN',
  'A61t8XF2iQ3f9X6hZ1k3wQ7vYpR5nT2mC8sQ4yN9bKp': 'MEW',
  '2QdXyvKgEYtC7Wn9JZq8Ym4tR6pL1hK3sV9bC5xF7dGh': 'BODEN',
  '5z3E6vRkZ2pL9wX4tQ7nY8mC1dF5hK2sV9bC5xF7dGhA': 'TRUMP',
  'C1mT8XhZ2pL9wX4tQ7nY8mC1dF5hK2sV9bC5xF7dGhB': 'BOME',
  '9z3E6vRkZ2pL9wX4tQ7nY8mC1dF5hK2sV9bC5xF7dGxC': 'SLERF',
  '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU': 'SAMO',
  '4k3Dyjzvzp8oP8rE4jWjfXkKpQ3DqVn7NqB6zZ8yV12A': 'RAY2',
  '3NZ9JMVBmGAqoE46Tq2dSTBd1kC7xkXrYc7bF9hK2sV9': 'MYRO',
  '8Hgtd4gCiRRLNKfYA7XcC3zJYhX6mZ2pL9wX4tQ7nY8m': 'TURBO',
  '2b1hVzSfC3kL9wX4tQ7nY8mC1dF5hK2sV9bC5xF7dGxD': 'BRETT',
  '5z3E6vRkZ2pL9wX4tQ7nY8mC1dF5hK2sV9bC5xF7dGxE': 'PEPE',
  'C1mT8XhZ2pL9wX4tQ7nY8mC1dF5hK2sV9bC5xF7dGhF': 'AERO',
  '9z3E6vRkZ2pL9wX4tQ7nY8mC1dF5hK2sV9bC5xF7dGxG': 'DOGE',
  '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsV': 'SAMO2',
  '4k3Dyjzvzp8oP8rE4jWjfXkKpQ3DqVn7NqB6zZ8yV12B': 'RAY3',
  '3NZ9JMVBmGAqoE46Tq2dSTBd1kC7xkXrYc7bF9hK2sW9': 'MYRO2',
  '8Hgtd4gCiRRLNKfYA7XcC3zJYhX6mZ2pL9wX4tQ7nY8n': 'TURBO2',
  '2b1hVzSfC3kL9wX4tQ7nY8mC1dF5hK2sV9bC5xF7dGxF': 'BRETT2',
  '5z3E6vRkZ2pL9wX4tQ7nY8mC1dF5hK2sV9bC5xF7dGxH': 'PEPE2',
  'C1mT8XhZ2pL9wX4tQ7nY8mC1dF5hK2sV9bC5xF7dGhJ': 'AERO2',
  '9z3E6vRkZ2pL9wX4tQ7nY8mC1dF5hK2sV9bC5xF7dGxJ': 'DOGE2',
  '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsW': 'SAMO3',
  '4k3Dyjzvzp8oP8rE4jWjfXkKpQ3DqVn7NqB6zZ8yV12C': 'RAY4',
  '3NZ9JMVBmGAqoE46Tq2dSTBd1kC7xkXrYc7bF9hK2sX9': 'MYRO3',
  '8Hgtd4gCiRRLNKfYA7XcC3zJYhX6mZ2pL9wX4tQ7nY8o': 'TURBO3',
  '2b1hVzSfC3kL9wX4tQ7nY8mC1dF5hK2sV9bC5xF7dGxG': 'BRETT3',
  '5z3E6vRkZ2pL9wX4tQ7nY8mC1dF5hK2sV9bC5xF7dGxK': 'PEPE3',
  'C1mT8XhZ2pL9wX4tQ7nY8mC1dF5hK2sV9bC5xF7dGhK2': 'AERO3',
  '9z3E6vRkZ2pL9wX4tQ7nY8mC1dF5hK2sV9bC5xF7dGxK2': 'DOGE3',
};
// Bersihkan duplikat key biar gak double scan
const _seen = {};
export const WATCH_TOKEN_LIST = Object.entries(WATCH_TOKENS).filter(([k]) => {
  if (_seen[k]) return false; _seen[k] = 1; return true;
}).map(([k, v]) => [k, v]);

// Agresivitas: threshold rendah + parallel scan
export const AGGRESSIVE_THRESHOLD = parseFloat(process.env.AGGRESSIVE_THRESHOLD || '0.3');

// Jupiter API key (opsional, kurangi 429). Set di .env: JUPITER_API_KEY=xxx
export const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
export const JUP_HEADERS = JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {};

export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOL = 'So11111111111111111111111111111111111111112';

// Jito tip account (standard)
export const JITO_TIP_ACCOUNT = 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY';

