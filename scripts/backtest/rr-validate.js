'use strict';

/*
 * 对盈亏比候选做分段验证：
 * - 全样本 91 天
 * - 前后各 45/46 天
 * - 三个 30/31 天窗口
 * 只改参数，不改回测口径。
 */

const fs = require('fs');
const path = require('path');
const { run } = require('./replay');
const { EVAL_START, EVAL_END, TRAIN_END, PERIOD_LABEL, WINDOWS: SPLIT_WINDOWS } = require('./config');
const { OPTIMIZED_STRATEGY, VOLUME_STRATEGY } = require('../../api/src/watchlist');

const OUT_DIR = path.join(__dirname, '..', '..', 'backtest-results', 'rr-optimize');
const FULL = {
  start: EVAL_START,
  end: EVAL_END,
};
const WINDOWS = [
  { label: 'full-91d', start: FULL.start, end: FULL.end },
  { label: 'train-45d', start: FULL.start, end: TRAIN_END },
  { label: 'test-46d', start: TRAIN_END, end: FULL.end },
  ...SPLIT_WINDOWS.map((w) => ({ label: w.label, start: w.start, end: w.end })),
];

const CANDIDATES = [
  { label: 'control-opt-2.0-0.45', base: OPTIMIZED_STRATEGY, patch: { rr1: 2.0, rr2: 3.0, stopAtr: 0.45 } },
  { label: 'opt-2.0-stop-0.55', base: OPTIMIZED_STRATEGY, patch: { rr1: 2.0, rr2: 3.0, stopAtr: 0.55 } },
  { label: 'opt-2.5-stop-0.55', base: OPTIMIZED_STRATEGY, patch: { rr1: 2.5, rr2: 3.5, stopAtr: 0.55 } },
  { label: 'vol-control-2.0-0.45', base: VOLUME_STRATEGY, patch: { rr1: 2.0, rr2: 3.0, stopAtr: 0.45 } },
  { label: 'vol-2.0-stop-0.55', base: VOLUME_STRATEGY, patch: { rr1: 2.0, rr2: 3.0, stopAtr: 0.55 } },
  { label: 'vol-2.5-stop-0.55', base: VOLUME_STRATEGY, patch: { rr1: 2.5, rr2: 3.5, stopAtr: 0.55 } },
];

function maxDrawdownR(trades) {
  const ordered = trades
    .map((t) => ({ ...t, __ts: Date.parse(t.triggerAtIso || t.at || 0) || 0 }))
    .sort((a, b) => a.__ts - b.__ts);
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of ordered) {
    equity += Number(t.netR) || 0;
    if (equity > peak) peak = equity;
    const dd = equity - peak;
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd;
}

function summarize(result) {
  const trades = result.trades || [];
  const n = trades.length;
  const totalR = trades.reduce((a, t) => a + (Number(t.netR) || 0), 0);
  const avgNetR = n ? totalR / n : 0;
  const avgNotionalPct = n
    ? trades.reduce((a, t) => a + ((Number(t.netR) || 0) * (Number(t.riskPct) || 0) / 100), 0) / n
    : 0;
  const o = result.summary.overall;
  return {
    trades: n,
    winRateT1: o.winRateT1,
    winRateT2: o.winRateT2,
    stopRate: o.stopRate,
    avgNetR,
    totalR,
    avgNotionalPct,
    maxDrawdownR: maxDrawdownR(trades),
  };
}

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

function main() {
  const rows = [];
  for (const c of CANDIDATES) {
    for (const w of WINDOWS) {
      const r = run({
        start: w.start,
        end: w.end,
        strategy: { ...c.base, ...c.patch },
        tag: `${c.label}-${w.label}`,
        quiet: true,
        write: false,
        exitMode: 't1',
      });
      rows.push({
        candidate: c.label,
        window: w.label,
        ...summarize(r),
      });
    }
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'validation.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    period: PERIOD_LABEL,
    rows,
  }, null, 2));

  console.log('\ncandidate\twindow\ttrades\tT1\tavgR\ttotalR\tavgNotional%\tmaxDDR');
  for (const r of rows) {
    console.log([
      r.candidate,
      r.window,
      r.trades,
      pct(r.winRateT1),
      r.avgNetR.toFixed(3),
      r.totalR.toFixed(2),
      (r.avgNotionalPct * 100).toFixed(3),
      r.maxDrawdownR.toFixed(2),
    ].join('\t'));
  }
  console.log(`\nwritten: ${path.join(OUT_DIR, 'validation.json')}`);
}

main();
