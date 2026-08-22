// risk.js — risk management + dynamic tip
// Circuit breaker, max daily loss, max consecutive fail, token/pool blacklist, dynamic Jito tip.
import fs from 'fs';

const STATE_FILE = './.risk_state.json';
const MAX_DAILY_LOSS_SOL = parseFloat(process.env.MAX_DAILY_LOSS_SOL || '0.05'); // stop kalau rugi > 0.05 SOL/hari
const MAX_CONSEC_FAIL = parseInt(process.env.MAX_CONSEC_FAIL || '10'); // stop kalau 10x gagal berturut
const TIP_MIN = 5000;
const TIP_MAX = 50000;

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // reset kalau beda hari
    if (s.date !== new Date().toISOString().slice(0, 10)) {
      return { date: new Date().toISOString().slice(0, 10), dailyLoss: 0, consecFail: 0, landed: 0, blacklist: {} };
    }
    return s;
  } catch {
    return { date: new Date().toISOString().slice(0, 10), dailyLoss: 0, consecFail: 0, landed: 0, blacklist: {} };
  }
}

function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let _state = loadState();

export function resetDailyIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (_state.date !== today) {
    _state = { date: today, dailyLoss: 0, consecFail: 0, landed: 0, blacklist: {} };
    saveState(_state);
  }
}

export function isCircuitOpen() {
  resetDailyIfNeeded();
  if (_state.dailyLoss >= MAX_DAILY_LOSS_SOL) {
    return { open: true, reason: `daily loss ${_state.dailyLoss.toFixed(4)} >= ${MAX_DAILY_LOSS_SOL}` };
  }
  if (_state.consecFail >= MAX_CONSEC_FAIL) {
    return { open: true, reason: `consecutive fail ${_state.consecFail} >= ${MAX_CONSEC_FAIL}` };
  }
  return { open: false };
}

// Panggil kalau tx GAGAL di on-chain (rejected/slippage) — hitung kerugian + consec fail
export function recordFail(estLossSol = 0) {
  _state.consecFail += 1;
  _state.dailyLoss += Math.max(0, estLossSol);
  saveState(_state);
}

// Panggil kalau tx BERHASIL land — reset consec fail, catat profit
export function recordSuccess(profitSol = 0) {
  _state.consecFail = 0;
  _state.landed += 1;
  _state.dailyLoss = Math.max(0, _state.dailyLoss - Math.max(0, profitSol));
  saveState(_state);
}

// Blacklist token yg sering gagal build/sim (biar gak di-retry terus)
export function blacklistToken(tokenAddr) {
  _state.blacklist[tokenAddr] = (_state.blacklist[tokenAddr] || 0) + 1;
  saveState(_state);
}
export function isBlacklisted(tokenAddr) {
  return (_state.blacklist[tokenAddr] || 0) >= 5; // 5x gagal -> skip
}

// Dynamic tip: naik kalau sering gagal land, turun kalau lancar
export function dynamicTip() {
  const base = TIP_MIN + Math.min(_state.consecFail, 5) * 4000; // tiap fail +4000
  return Math.min(TIP_MAX, Math.max(TIP_MIN, base));
}

export function getStats() {
  return { ..._state, tip: dynamicTip(), maxDailyLoss: MAX_DAILY_LOSS_SOL, maxConsecFail: MAX_CONSEC_FAIL };
}
