'use strict';

/* 5m 延迟后仍可执行的 OI 方向策略：多周期趋势 + 第一根脉冲大小过滤。 */

const fs = require('fs');
const path = require('path');
const { runStrategy, summarize } = require('./strategy-sim');
const { loadSymbol } = require('./replay');

const CACHE = path.join(__dirname, '..', '..', 'backtest-cache');
const OUT = path.join(__dirname, '..', '..', 'backtest-results', 'event-study');
const manifest = JSON.parse(fs.readFileSync(path.join(CACHE, 'manifest.json'), 'utf8'));
const events = JSON.parse(fs.readFileSync(path.join(OUT, 'events.json'), 'utf8'));
const loads = new Map(manifest.symbols.map((s) => [s, loadSymbol(s)]));
const T2T3 = (e) => e.tier === 'T2' || e.tier === 'T3';

function run({ tag, extra }) {
  const trades = runStrategy(events, loads, {
    tag,
    filter: (e) => T2T3(e) && extra(e),
    side: (e) => (e.oiSide === 'up' ? 'long' : 'short'),
    stopAtr: 1.0,
    rr: 2.5,
    holdBars: 48,
    entryDelayBars: 1,
    cost: 0.0012,
  });
  return { tag, ...summarize(trades, tag) };
}

const rows = [];
const trends = ['up', 'mixed', 'down'];
for (const t4 of trends) {
  for (const t1 of trends) {
    rows.push(run({ tag: `d1_${t4}_${t1}`, extra: (e) => e.trend4h === t4 && e.trend1h === t1 }));
  }
}

// 第一根脉冲不要太大，避免延迟 5 分钟后追在脉冲尾端。
for (const maxPulse of [0.3, 0.5, 0.8, 1.2]) {
  rows.push(run({ tag: `d1_pulse<${maxPulse}`, extra: (e) => e.next1RetAtr != null && Math.abs(e.next1RetAtr) <= maxPulse }));
  for (const t4 of trends) {
    rows.push(run({ tag: `d1_pulse<${maxPulse}_${t4}`, extra: (e) => e.next1RetAtr != null && Math.abs(e.next1RetAtr) <= maxPulse && e.trend4h === t4 }));
  }
}

rows.sort((a, b) => b.avgR - a.avgR);
console.table(rows.map((r) => ({ tag: r.tag, n: r.trades, win: r.winRate, avgR: r.avgR, PF: r.profitFactor, u: r.totalU, DD: r.maxDdU })));
fs.writeFileSync(path.join(OUT, 'delay-grid.json'), JSON.stringify({ rows }, null, 2));
console.log(`wrote ${path.join(OUT, 'delay-grid.json')}`);
