// config.js — DEX program IDs, token watchlist, threshold
export const DEX_PROGRAM_IDS = {
  RAYDIUM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNunggAiXnqqN1DZG1fekEju6',
  METEORA_DLMM: 'LbVRzDTjHzY9fAPw7CcpQ5S9UfeCdXsB8oaR5wWn9jS',
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  JUPITER_V6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
};

// Threshold misprice antar DEX (persen). > ini = peluang.
export const MISPRICE_THRESHOLD_PCT = 3.0;

// Token lama yang di-track khusus (kasus AOW/USD2 style)
export const WATCH_TOKENS = {
  '9AwxXsDhtpey1xTPvWvJjXy1uJ9g6Kq3ZVZ8kZv9pump': 'AOW9',
  'CaNC8DjrRuY17zrqNyHKYD91pVofPsXchFr1kh2nsfUw': 'USD2',
};

export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOL = 'So11111111111111111111111111111111111111112';

// Jito tip account (standard)
export const JITO_TIP_ACCOUNT = 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY';
