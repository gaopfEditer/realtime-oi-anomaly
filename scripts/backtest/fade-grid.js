'use strict';

/* 事件后第一根 5m bar 的脉冲反转测试（等第一根走完再入场，适合有 5m 延迟的执行）。 */

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

function fade(threshold, stopAtr, rr) {
  return runStrategy(events, loads, {
    tag: `fade_${threshold}_${stopAtr}_${rr}`,
    filter: (e) => T2T3(e) && e.next1RetAtr != null && Math.abs(e.next1RetAtr) >= threshold,
    side: (e) => (e.next1RetAtr > 0 ? 'short' : 'long'),
    stopAtr,
    rr,
    holdBars: 48,
    entryDelayBars: 1,
    cost: 0.0012,
  });
}

const rows = [];
for (const threshold of [0.3, 0.5, 0.8, 1.2, 2.0]) {
  for (const stopAtr of [1.0, 1.2, 1.5]) {
    for (const rr of [1.5, 2.0, 2.5]) {
      const trades = fade(threshold, stopAtr, rr);
      const s = summarize(trades, `fade_${threshold}_${stopAtr}_${rr}`);
      rows.push({ threshold, stopAtr, rr, ...s });
    }
  }
}

rows.sort((a, b) => b.avgR - a.avgR);
const top = rows.slice(0, 10);
console.table(top.map((r) => ({ threshold: r.threshold, stop: r.stopAtr, rr: r.rr, n: r.trades, win: r.winRate, avgR: r.avgR, PF: r.profitFactor, u: r.totalU, DD: r.maxDdU })));
fs.writeFileSync(path.join(OUT, 'fade-grid.json'), JSON.stringify({ rows, top }, null, 2));
console.log(`wrote ${path.join(OUT, 'fade-grid.json')}`);
