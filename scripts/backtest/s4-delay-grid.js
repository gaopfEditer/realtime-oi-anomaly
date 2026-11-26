'use strict';

/* S4 高量低位空：等第一根 5m bar 走完再入场，看还能不能留下正期望。 */

const fs = require('fs');
const path = require('path');
const { runStrategy, summarize } = require('./strategy-sim');
const { loadSymbol } = require('./replay');
const { WINDOWS, PERIODS } = require('./config');

const CACHE = path.join(__dirname, '..', '..', 'backtest-cache');
const OUT = path.join(__dirname, '..', '..', 'backtest-results', 'event-study');
const manifest = JSON.parse(fs.readFileSync(path.join(CACHE, 'manifest.json'), 'utf8'));
const events = JSON.parse(fs.readFileSync(path.join(OUT, 'events.json'), 'utf8'));
const loads = new Map(manifest.symbols.map((s) => [s, loadSymbol(s)]));

const T2T4 = (e) => e.tier === 'T2' || e.tier === 'T3' || e.tier === 'T4';

function run({ vol, pos, stopAtr, rr, delay }) {
  const tag = `s4_d${delay}_v${vol}_p${pos}_s${stopAtr}_r${rr}`;
  const trades = runStrategy(events, loads, {
    tag,
    filter: (e) => T2T4(e) && e.volRatio >= vol && e.rangePos48 < pos,
    side: 'short',
    stopAtr,
    rr,
    holdBars: 48,
    entryDelayBars: delay,
    cost: 0.0012,
  });
  const full = summarize(trades, tag);
  const period = {};
  for (const p of PERIODS) period[p.label] = summarize(trades.filter((t) => t.ts >= p.start && t.ts < p.end), p.label);
  const win = {};
  for (const w of WINDOWS) win[w.tag] = summarize(trades.filter((t) => t.ts >= w.start && t.ts < w.end), w.tag);
  return { tag, vol, pos, stopAtr, rr, delay, ...full, period, win };
}

const rows = [];
for (const vol of [1.5, 2.0, 2.5, 3.0]) {
  for (const pos of [0.2, 0.3, 0.4]) {
    for (const stopAtr of [0.8, 1.0, 1.2]) {
      for (const rr of [1.5, 2.0, 2.5]) {
        rows.push(run({ vol, pos, stopAtr, rr, delay: 1 }));
      }
    }
  }
}
rows.sort((a, b) => b.avgR - a.avgR);
const top = rows.filter((r) => r.trades >= 150).slice(0, 12);
console.table(top.map((r) => ({
  vol: r.vol,
  pos: r.pos,
  stop: r.stopAtr,
  rr: r.rr,
  n: r.trades,
  win: r.winRate,
  avgR: r.avgR,
  PF: r.profitFactor,
  u: r.totalU,
  w1: r.win.w1.avgR,
  w2: r.win.w2.avgR,
  w3: r.win.w3.avgR,
  train: r.period['train-45d'].avgR,
  test: r.period['test-46d'].avgR,
})));
fs.writeFileSync(path.join(OUT, 's4-delay-grid.json'), JSON.stringify({ rows, top }, null, 2));
console.log(`wrote ${path.join(OUT, 's4-delay-grid.json')}`);
