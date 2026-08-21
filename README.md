# Solana Arbitrage Scanner (Node.js)

Scanner misprice multi-vector + **1-tx atomic executor** (Jito bundle, fee=0 + tip kecil).

## Yang terbukti jalan (test Node v26)
- ✅ Detect: 5 metode misprice (cross_dex USD2 44% orca vs meteora)
- ✅ 1 ATOMIC TX: `bytes 1014 | sigs 1 | ix 10`
- ✅ Fee optimization: **priority fee = 0**, Jito tip 5000 lamport (0.000005 SOL)
- ✅ Multi-format PK: base58 / [uint8 array] / hex
- ✅ Auto-loop: `node run.js`

## Install (tanpa venv)
```bash
git clone https://github.com/Gfast416/solana-arb-scanner-node.git
cd solana-arb-scanner-node
npm install
cp .env.example .env
nano .env
```

## Setup .env
```env
RPC_HTTP=https://mainnet.helius-rpc.com/?api-key=API_KEY_KAMU
WALLET_PRIVATE_KEY=*** 11, 23, ..., 64 angka]
JITO_API_KEY=
JITO_REGION=frankfurt
MIN_PROFIT_PCT=1.0
USE_JITO=true
JITO_TIP_LAMPORTS=5000
```

## Jalankan
```bash
node executor.js    # dry-run (detect opp, gak kirim)
node run.js         # auto loop detect -> 1 tx atomic -> Jito
```

## File
- `config.js` — DEX IDs, WATCH_TOKENS, threshold
- `dexscreener.js` — API DexScreener
- `methods.js` — 5 metode deteksi
- `build_atomic_tx.js` — 1 tx atomic (Jupiter swap + Jito tip, fee=0)
- `executor.js` — load .env, keypair multi-format, detect+execute
- `run.js` — loop otomatis

## Fee Optimization
- Priority fee = 0 (stripped SetComputeUnitPrice)
- Jito tip 5000 lamport = 0.000005 SOL (cukup buat land cepat via bundle)
- Total ~0.000005 SOL vs 0.55 SOL bot pro (110.000x lebih murah)

## Catatan
- Jupiter 429 kalau terlalu banyak call → daftar API key gratis jup.ag
- Test modal kecil (0.01 SOL) dulu
- `.env` jangan di-commit (sudah di .gitignore)
