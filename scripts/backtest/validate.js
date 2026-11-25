'use strict';

/*
 * 分段稳定性检查：把 91 天拆成前半段/后半段，避免只看全样本最优。
 * 注意：这是同一市场样本内的分段验证，不是严格的样本外 walk-forward。
 */

const fs = require('fs');
const path = require('path');
const { run } = require('./replay');
const { PERIODS } = require('./config');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'backtest-results', 'validate.json');
const DAY = 24 * 60 * 60 * 1000;

const BASE = { stopAtr: 0.45, maxChaseAtr: 0.5, rr1: 2.0, rr2: 3.0 };
const CONFIGS = [
  { label: 'baseline', strategy: {}, exitMode: 't1' },
  { label: 'opt60', strategy: { ...BASE, triggerMinScore: 60 }, exitMode: 't1' },
  { label: 'opt62', strategy: { ...BASE, triggerMinScore: 62 }, exitMode: 't1' },
  { label: 'opt65', strategy: { ...BASE, triggerMinScore: 65 }, exitMode: 't1' },
  { label: 'opt60-partial', strategy: { ...BASE, triggerMinScore: 60 }, exitMode: 'partial' },
  { label: 'opt62-partial', strategy: { ...BASE, triggerMinScore: 62 }, exitMode: 'partial' }
];

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

function main() {
  const rows = [];
  for (const p of PERIODS) {
    for (const c of CONFIGS) {
      const tag = `${c.label}-${p.label}`;
      const { summary } = run({
        start: p.start,
        end: p.end,
        strategy: c.strategy,
        exitMode: c.exitMode,
        tag,
        outDir: path.join(ROOT, 'backtest-results', 'validate', tag),
        quiet: true,
      });
      const o = summary.overall;
      rows.push({
        period: p.label,
        config: c.label,
        exitMode: c.exitMode,
        trades: o.trades,
        winRateT1: o.winRateT1,
        winRateT2: o.winRateT2,
        stopRate: o.stopRate,
        avgNetR: o.avgNetR,
        totalR: o.avgNetR * o.trades,
      });
      process.stdout.write(`${p.label} ${c.label}: ${o.trades} trades, T1 ${pct(o.winRateT1)}, avg ${o.avgNetR.toFixed(3)}R\n`);
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
  console.log(`\nwritten: ${OUT}`);
}

main();
