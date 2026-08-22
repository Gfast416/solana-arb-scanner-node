// metrics.js — observability: latency per stage, success/fail rate, false-positive rate
const m = {
  scanned: 0,        // candidate dari scanner
  built: 0,          // berhasil build tx
  simOk: 0,          // simulate sukses
  simFail: 0,        // simulate gagal (slippage/build)
  submitted: 0,      // bundle terkirim
  landed: 0,         // bundle confirmed
  falsePositive: 0,  // candidate lolos scan tapi profit negatif / no quote
  lat: { detect: 0, build: 0, sim: 0 },
  _t: {},
};

export function markStage(name) { m._t[name] = Date.now(); }
export function endStage(name) {
  if (m._t[name]) { m.lat[name] = (m.lat[name] || 0) + (Date.now() - m._t[name]); m._t[name] = null; }
}
export function inc(key, n = 1) { m[key] = (m[key] || 0) + n; }

export function summary() {
  const avg = (k) => m[k] ? (m.lat[k] / Math.max(1, m['_' + k + 'cnt'] || m.built || 1)).toFixed(0) : '0';
  const fpRate = m.scanned ? ((m.falsePositive / m.scanned) * 100).toFixed(1) : '0';
  const landRate = m.submitted ? ((m.landed / m.submitted) * 100).toFixed(1) : '0';
  return `📊 metrics | scan=${m.scanned} build=${m.built} simOK=${m.simOk} simFail=${m.simFail} sub=${m.submitted} land=${m.landed} | FP=${fpRate}% land=${landRate}% | lat(build~${avg('build')}ms sim~${avg('sim')}ms)`;
}

export function reset() { /* keep cumulative, bisa di-reset manual */ }
