'use strict';

/*
 * 参数消融：同一段真实历史、同一套引擎，只改一个/几个策略参数，比较结果。
 * 目的不是“挑一个最好看的”，而是看哪些改动有稳定方向、哪些只是样本噪声。
 */

const fs = require('fs');
const path = require('path');
const { run } = require('./replay');
const { PERIOD_LABEL } = require('./config');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'backtest-results', 'optimize-grid.json');

const BEST = { stopAtr: 0.45, maxChaseAtr: 0.5, rr1: 2.0, rr2: 3.0 };

const VARIANTS = [
  { label: 'baseline', strategy: {} },
  { label: 'baseline-partial', strategy: {}, exitMode: 'partial' },
  { label: 'baseline-t2', strategy: {}, exitMode: 't2' },
  { label: 'stop-035', strategy: { stopAtr: 0.35 } },
  { label: 'stop-045', strategy: { stopAtr: 0.45 } },
  { label: 'stop-055', strategy: { stopAtr: 0.55 } },
  { label: 'chase-050', strategy: { maxChaseAtr: 0.5 } },
  { label: 'chase-075', strategy: { maxChaseAtr: 0.75 } },
  { label: 'close-confirm', strategy: { requireCloseBeyondTrigger: true } },
  { label: 'close+chase050', strategy: { requireCloseBeyondTrigger: true, maxChaseAtr: 0.5 } },
  { label: 'stop045+chase050', strategy: { stopAtr: 0.45, maxChaseAtr: 0.5 } },
  { label: 'rr2', strategy: { rr1: 2.0, rr2: 3.0 } },
  { label: 'stop045+rr2', strategy: { stopAtr: 0.45, rr1: 2.0, rr2: 3.0 } },
  { label: 'best', strategy: BEST },
  { label: 'best-partial', strategy: BEST, exitMode: 'partial' },
  { label: 'best-t2', strategy: BEST, exitMode: 't2' },
  { label: 'best-score058', strategy: { ...BEST, triggerMinScore: 58 } },
  { label: 'best-score060', strategy: { ...BEST, triggerMinScore: 60 } },
  { label: 'best-stop040', strategy: { ...BEST, stopAtr: 0.4 } },
  { label: 'best-stop050', strategy: { ...BEST, stopAtr: 0.5 } },
  { label: 'best-rr18', strategy: { ...BEST, rr1: 1.8, rr2: 2.8 } },
  { label: 'best-rr22', strategy: { ...BEST, rr1: 2.2, rr2: 3.2 } },
  { label: 'best-chase040', strategy: { ...BEST, maxChaseAtr: 0.4 } },
  { label: 'best-chase060', strategy: { ...BEST, maxChaseAtr: 0.6 } },
  { label: 'score058', strategy: { triggerMinScore: 58 } },
  { label: 'chase050+score058', strategy: { maxChaseAtr: 0.5, triggerMinScore: 58 } },
  { label: 'retention-080', strategy: { setupMinRetentionPct: 80 } },
  { label: 'box-10-35', strategy: { setupMinBoxAtr: 1.0, setupMaxBoxAtr: 3.5 } },
  { label: 'btc-block-080', strategy: { btcBlockPct: 0.8 } },
  { label: 'vol-120', strategy: { triggerMinVolumeRatio: 1.2 } },
  { label: 'max-stop-22', strategy: { maxStopPct: 2.2 } },
  { label: 'close+stop035', strategy: { requireCloseBeyondTrigger: true, stopAtr: 0.35 } },
  { label: 'chase050+box10-35', strategy: { maxChaseAtr: 0.5, setupMinBoxAtr: 1.0, setupMaxBoxAtr: 3.5 } }
];

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

function main() {
  const rows = [];
  for (const v of VARIANTS) {
    process.stdout.write(`running ${v.label} ... `);
    const started = Date.now();
    const { summary } = run({
      strategy: v.strategy,
      tag: v.label,
      outDir: path.join(ROOT, 'backtest-results', 'variants', v.label),
      exitMode: v.exitMode || 't1',
      quiet: true,
    });
    const o = summary.overall;
    const row = {
      label: v.label,
      strategy: v.strategy,
      exitMode: v.exitMode || 't1',
      trades: o.trades,
      resolved: o.resolved,
      winRateT1: o.winRateT1,
      winRateT2: o.winRateT2,
      stopRate: o.stopRate,
      avgNetR: o.avgNetR,
      medianNetR: o.medianNetR,
      totalR: o.avgNetR * o.trades,
      elapsedMs: Date.now() - started,
    };
    rows.push(row);
    process.stdout.write(`${row.trades} trades, T1 ${pct(row.winRateT1)}, avg ${row.avgNetR.toFixed(3)}R\n`);
  }

  rows.sort((a, b) => b.avgNetR - a.avgNetR);
  const payload = {
    generatedAt: new Date().toISOString(),
    period: PERIOD_LABEL,
    note: '同一段样本内参数消融；优先看 avgNetR + 交易数，不把单次最优当样本外结论',
    rows,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

  console.log('\nlabel\ttrades\tT1\tT2\tstop\tavgNetR\ttotalR');
  for (const r of rows) {
    console.log([
      r.label,
      r.trades,
      pct(r.winRateT1),
      pct(r.winRateT2),
      pct(r.stopRate),
      r.avgNetR.toFixed(3),
      r.totalR.toFixed(1),
    ].join('\t'));
  }
  console.log(`\nwritten: ${OUT}`);
}

main();
