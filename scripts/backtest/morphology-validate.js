'use strict';

/*
 * 对形态/多周期候选做全样本与前后 45/46 天分段验证。
 * 用法：node scripts/backtest/morphology-validate.js
 */

const fs = require('fs');
const path = require('path');
const { run } = require('./replay');
const { EVAL_START, TRAIN_END, EVAL_END, PERIOD_LABEL } = require('./config');
const { OPTIMIZED_STRATEGY } = require('../../api/src/watchlist');

const OUT = path.join(__dirname, '..', '..', 'backtest-results');

const candidates = [
  { tag: 'opt62-control', patch: {} },
  { tag: 'failed', patch: { blockFailedBreakout: true } },
  { tag: 'failed-long-only', patch: { blockFailedLongBreakout: true } },
  { tag: 'failed-short-only', patch: { blockFailedShortBreakout: true } },
  { tag: 'mtfBoth', patch: { mtfMode: 'both' } },
  { tag: 'failed+mtfBoth', patch: { blockFailedBreakout: true, mtfMode: 'both' } },
  { tag: 'failed+pin20', patch: { blockFailedBreakout: true, minFavorableWickPct: 0.2 } },
  { tag: 'vol10-13', patch: { triggerMinBarVolumeRatio: 1.0, triggerMaxBarVolumeRatio: 1.3 } },
  { tag: 'vol10-15', patch: { triggerMinBarVolumeRatio: 1.0, triggerMaxBarVolumeRatio: 1.5 } },
  { tag: 'vol10-13+failedLong', patch: { triggerMinBarVolumeRatio: 1.0, triggerMaxBarVolumeRatio: 1.3, blockFailedLongBreakout: true } },
  { tag: 'vol09-15', patch: { triggerMinBarVolumeRatio: 0.9, triggerMaxBarVolumeRatio: 1.5 } },
  { tag: 'vol10-16', patch: { triggerMinBarVolumeRatio: 1.0, triggerMaxBarVolumeRatio: 1.6 } },
  { tag: 'vol11-15', patch: { triggerMinBarVolumeRatio: 1.1, triggerMaxBarVolumeRatio: 1.5 } },
  { tag: 'vol10-14', patch: { triggerMinBarVolumeRatio: 1.0, triggerMaxBarVolumeRatio: 1.4 } },
  { tag: 'vol10-15+failedLong', patch: { triggerMinBarVolumeRatio: 1.0, triggerMaxBarVolumeRatio: 1.5, blockFailedLongBreakout: true } },
  { tag: 'vol10-15+failed', patch: { triggerMinBarVolumeRatio: 1.0, triggerMaxBarVolumeRatio: 1.5, blockFailedBreakout: true } },
];

function round(n, p = 2) {
  const m = 10 ** p;
  return Math.round((Number(n) || 0) * m) / m;
}

function stat(trades) {
  const resolved = trades.filter((t) => t.t1Win || t.t1Loss);
  const wins = trades.filter((t) => t.t1Win).length;
  const avgR = trades.length ? trades.reduce((a, t) => a + (Number(t.netR) || 0), 0) / trades.length : 0;
  return {
    trades: trades.length,
    resolved: resolved.length,
    t1Wins: wins,
    winRateT1: resolved.length ? round(wins / resolved.length, 4) : 0,
    avgNetR: round(avgR, 4),
    totalR: round(trades.reduce((a, t) => a + (Number(t.netR) || 0), 0), 2),
  };
}

function periodStats(strategy, tag, start, end) {
  const r = run({ strategy: { ...OPTIMIZED_STRATEGY, ...strategy }, start, end, quiet: true, write: false, tag });
  return stat(r.trades);
}

const rows = [];
const details = {};
for (const c of candidates) {
  const full = periodStats(c.patch, `${c.tag}-full`, EVAL_START, EVAL_END);
  const train = periodStats(c.patch, `${c.tag}-train`, EVAL_START, TRAIN_END);
  const test = periodStats(c.patch, `${c.tag}-test`, TRAIN_END, EVAL_END);
  const row = {
    tag: c.tag,
    patch: c.patch,
    full,
    train,
    test,
  };
  rows.push(row);
  details[c.tag] = row;
  console.log(`${c.tag}\tfull ${full.trades}/${(full.winRateT1 * 100).toFixed(1)}%/${full.avgNetR}R\t` +
    `train ${train.trades}/${(train.winRateT1 * 100).toFixed(1)}%/${train.avgNetR}R\t` +
    `test ${test.trades}/${(test.winRateT1 * 100).toFixed(1)}%/${test.avgNetR}R`);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'morphology-validate.json'), JSON.stringify({
  meta: { period: PERIOD_LABEL, train: '2026-08-24 ~ 2026-10-07', test: '2026-10-08 ~ 2026-11-22', base: 'opt62' },
  rows,
}, null, 2));
console.log(`\nwrote ${path.join(OUT, 'morphology-validate.json')}`);
