'use strict';

/* 检查放大目标 R 后，S1 是否还能容忍 5m 延迟。 */

const fs = require('fs');
const path = require('path');
const { runStrategy, summarize } = require('./strategy-sim');
const { loadSymbol } = require('./replay');

const CACHE = path.join(__dirname, '..', '..', 'backtest-cache');
const OUT = path.join(__dirname, '..', '..', 'backtest-results', 'event-study');
const events = JSON.parse(fs.readFileSync(path.join(OUT, 'events.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(CACHE, 'manifest.json'), 'utf8'));
const loads = new Map(manifest.symbols.map((s) => [s, loadSymbol(s)]));

const S1 = {
  side: (e) => (e.oiSide === 'up' ? 'long' : 'short'),
  filter: (e) => (e.tier === 'T2' || e.tier === 'T3') && (e.oiSide === 'up' || e.oiSide === 'down'),
};

const candidates = [
  { name: 'current 1.0/2.5/4h', stopAtr: 1.0, rr: 2.5, holdBars: 48 },
  { name: '1.5/3.5/4h', stopAtr: 1.5, rr: 3.5, holdBars: 48 },
  { name: '1.0/6/8h', stopAtr: 1.0, rr: 6, holdBars: 96 },
  { name: '1.2/5/8h', stopAtr: 1.2, rr: 5, holdBars: 96 },
  { name: '0.6/6/8h', stopAtr: 0.6, rr: 6, holdBars: 96 },
  { name: '2.0/6/2h', stopAtr: 2.0, rr: 6, holdBars: 24 },
  { name: '2.0/4/2h', stopAtr: 2.0, rr: 4, holdBars: 24 },
  { name: '2.0/3/2h', stopAtr: 2.0, rr: 3, holdBars: 24 },
];

const rows = [];
for (const c of candidates) {
  for (const delay of [0, 1, 2]) {
    const trades = runStrategy(events, loads, { ...S1, ...c, entryDelayBars: delay, cost: 0.0012 });
    const s = summarize(trades, `${c.name}@d${delay}`);
    rows.push({ name: c.name, delay, ...c, ...s });
  }
}

console.table(rows.map((r) => ({
  name: r.name,
  delay: r.delay,
  n: r.trades,
  win: r.winRate,
  target: r.targetRate,
  avgR: r.avgR,
  avgU: r.avgU,
  totalU: r.totalU,
  ddU: r.maxDdU,
})));
fs.writeFileSync(path.join(OUT, 's1-exit-delay.json'), JSON.stringify({ rows }, null, 2));
console.log(`wrote ${path.join(OUT, 's1-exit-delay.json')}`);
