'use strict';

/*
 * 形态/多周期候选过滤器评估。
 *
 * 用法：
 *   node scripts/backtest/morphology.js stats
 *   node scripts/backtest/morphology.js grid
 *
 * stats 只跑控制组，输出触发样本的特征分桶；
 * grid 逐变体重放，输出胜率、平均 R、笔数和分段结果。
 */

const fs = require('fs');
const path = require('path');
const { run } = require('./replay');
const { OPTIMIZED_STRATEGY } = require('../../api/src/watchlist');

const OUT = path.join(__dirname, '..', '..', 'backtest-results');
const GRID_FILE = path.join(OUT, 'morphology-grid.json');

function round(n, p = 2) {
  const m = 10 ** p;
  return Math.round((Number(n) || 0) * m) / m;
}

function stat(trades) {
  const resolved = trades.filter((t) => t.t1Win || t.t1Loss);
  const wins = trades.filter((t) => t.t1Win).length;
  const avgR = trades.length ? trades.reduce((a, t) => a + (Number(t.netR) || 0), 0) / trades.length : 0;
  return {
    n: trades.length,
    resolved: resolved.length,
    t1Wins: wins,
    winRateT1: resolved.length ? round(wins / resolved.length, 4) : 0,
    avgNetR: round(avgR, 4),
    totalR: round(trades.reduce((a, t) => a + (Number(t.netR) || 0), 0), 2),
  };
}

function featureSummary(trades) {
  const sideDir = (t) => (t.side === 'long' ? 'up' : 'down');
  const adverse = (t) => (t.side === 'long'
    ? Number(t.morphology && t.morphology.upperWickRatio)
    : Number(t.morphology && t.morphology.lowerWickRatio));
  const closeLoc = (t) => (t.side === 'long'
    ? Number(t.morphology && t.morphology.closeLocation)
    : Number(t.morphology && t.morphology.shortCloseLocation));
  const failed = (t) => (t.side === 'long'
    ? !!(t.morphology && t.morphology.failedLongBreakout)
    : !!(t.morphology && t.morphology.failedShortBreakout));
  const favorable = (t) => (t.side === 'long'
    ? Number(t.morphology && t.morphology.lowerWickRatio)
    : Number(t.morphology && t.morphology.upperWickRatio));

  function buckets(label, get, bands) {
    const out = [];
    for (const [lo, hi] of bands) {
      const selected = trades.filter((t) => {
        const v = get(t);
        return (lo === null || v >= lo) && (hi === null || v < hi);
      });
      out.push({ band: `${lo ?? '-inf'}~${hi ?? 'inf'}`, ...stat(selected) });
    }
    console.log(`\n${label}`);
    console.table(out);
  }

  console.log('\ncontrol', stat(trades));
  buckets('adverse wick ratio', adverse, [[0, 0.4], [0.4, 0.55], [0.55, 0.7], [0.7, null]]);
  buckets('favorable pin wick ratio', favorable, [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.45], [0.45, null]]);
  buckets('directional close location', closeLoc, [[0, 0.4], [0.4, 0.6], [0.6, 0.75], [0.75, null]]);
  buckets('trigger bar volume ratio', (t) => Number(t.morphology && t.morphology.barVolumeRatio), [[0, 1], [1, 1.3], [1.3, 1.6], [1.6, 2], [2, null]]);
  buckets('pre-breakout volume ratio', (t) => Number(t.morphology && t.morphology.preBreakoutVolumeRatio), [[0, 0.8], [0.8, 1], [1, 1.2], [1.2, null]]);

  const groups = {
    'failed breakout': trades.filter(failed),
    'close beyond trigger': trades.filter((t) => !failed(t)),
    '15m aligned': trades.filter((t) => t.morphology && t.morphology.tf15 === sideDir(t)),
    '15m opposite': trades.filter((t) => t.morphology && t.morphology.tf15 !== sideDir(t)),
    '1h aligned': trades.filter((t) => t.morphology && t.morphology.tf1h === sideDir(t)),
    '1h opposite': trades.filter((t) => t.morphology && t.morphology.tf1h !== sideDir(t)),
    '15m+1h aligned': trades.filter((t) => t.morphology && t.morphology.resonance === t.side),
    '15m+1h not aligned': trades.filter((t) => t.morphology && t.morphology.resonance !== t.side),
  };
  console.log('\ncategorical');
  console.table(Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, stat(v)])));
}

const variants = [
  { tag: 'opt62-control', patch: {} },
  { tag: 'vol15', patch: { triggerMinBarVolumeRatio: 1.5 } },
  { tag: 'vol20', patch: { triggerMinBarVolumeRatio: 2.0 } },
  { tag: 'wick50', patch: { maxAdverseWickPct: 0.5 } },
  { tag: 'wick55', patch: { maxAdverseWickPct: 0.55 } },
  { tag: 'close60', patch: { minCloseLocation: 0.6 } },
  { tag: 'pin20', patch: { minFavorableWickPct: 0.2 } },
  { tag: 'pin30', patch: { minFavorableWickPct: 0.3 } },
  { tag: 'failed', patch: { blockFailedBreakout: true } },
  { tag: 'vol15+wick50', patch: { triggerMinBarVolumeRatio: 1.5, maxAdverseWickPct: 0.5 } },
  { tag: 'vol15+failed', patch: { triggerMinBarVolumeRatio: 1.5, blockFailedBreakout: true } },
  { tag: 'vol15+close60', patch: { triggerMinBarVolumeRatio: 1.5, minCloseLocation: 0.6 } },
  { tag: 'vol15+wick50+close60', patch: { triggerMinBarVolumeRatio: 1.5, maxAdverseWickPct: 0.5, minCloseLocation: 0.6 } },
  { tag: 'mtf15', patch: { mtfMode: '15m' } },
  { tag: 'mtf1h', patch: { mtfMode: '1h' } },
  { tag: 'mtfBoth', patch: { mtfMode: 'both' } },
  { tag: 'vol15+wick50+mtfBoth', patch: { triggerMinBarVolumeRatio: 1.5, maxAdverseWickPct: 0.5, mtfMode: 'both' } },
  { tag: 'vol15+wick50+failed+mtfBoth', patch: { triggerMinBarVolumeRatio: 1.5, maxAdverseWickPct: 0.5, blockFailedBreakout: true, mtfMode: 'both' } },
];

function runGrid() {
  const rows = [];
  const results = {};
  for (const v of variants) {
    const strategy = { ...OPTIMIZED_STRATEGY, ...v.patch };
    const r = run({ strategy, quiet: true, write: false, tag: v.tag });
    const row = {
      tag: v.tag,
      patch: v.patch,
      ...stat(r.trades),
      funnel: r.summary.funnel,
    };
    rows.push(row);
    results[v.tag] = {
      overall: row,
      bySide: r.summary.bySide,
      byGrade: r.summary.byGrade,
    };
    console.log(`${v.tag}\t${row.n} trades\tT1 ${(row.winRateT1 * 100).toFixed(1)}%\tavg ${row.avgNetR}R\ttotal ${row.totalR}R`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(GRID_FILE, JSON.stringify({ meta: { start: '2026-10-24', end: '2026-11-22', base: 'opt62' }, rows, results }, null, 2));
  console.log(`\nwrote ${GRID_FILE}`);
}

function main() {
  const mode = process.argv[2] || 'stats';
  if (mode === 'grid') {
    runGrid();
    return;
  }
  const r = run({ strategy: OPTIMIZED_STRATEGY, quiet: true, write: false, tag: 'morph-stats' });
  featureSummary(r.trades);
}

main();
