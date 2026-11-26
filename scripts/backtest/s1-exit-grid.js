'use strict';

/*
 * S1 止盈/止损/持有时间网格。
 * 目标是看“笔均盈利”能不能在不牺牲 train/test 稳定性的前提下提高。
 * 选参按 train-45d，test-46d 只验证；同时输出三个 30 天窗口，避免只看全样本。
 */

const fs = require('fs');
const path = require('path');
const { runStrategy, summarize } = require('./strategy-sim');
const { loadSymbol } = require('./replay');
const { WINDOWS, PERIODS } = require('./config');

const CACHE = path.join(__dirname, '..', '..', 'backtest-cache');
const OUT = path.join(__dirname, '..', '..', 'backtest-results', 'event-study');
const EVENTS = path.join(OUT, 'events.json');

const events = JSON.parse(fs.readFileSync(EVENTS, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(CACHE, 'manifest.json'), 'utf8'));
const loads = new Map(manifest.symbols.map((s) => [s, loadSymbol(s)]));

const S1 = {
  tag: 'S1',
  side: (e) => (e.oiSide === 'up' ? 'long' : 'short'),
  filter: (e) => (e.tier === 'T2' || e.tier === 'T3') && (e.oiSide === 'up' || e.oiSide === 'down'),
};

function run(stopAtr, rr, holdBars) {
  const trades = runStrategy(events, loads, {
    ...S1, stopAtr, rr, holdBars, cost: 0.0012,
  });
  const full = summarize(trades, 'full');
  const period = {};
  for (const p of PERIODS) period[p.label] = summarize(trades.filter((t) => t.ts >= p.start && t.ts < p.end), p.label);
  const win = {};
  for (const w of WINDOWS) win[w.tag] = summarize(trades.filter((t) => t.ts >= w.start && t.ts < w.end), w.tag);
  return { stopAtr, rr, holdBars, ...full, period, win };
}

const rows = [];
for (const stopAtr of [0.6, 0.8, 1.0, 1.2, 1.5, 2.0]) {
  for (const rr of [2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0]) {
    for (const holdBars of [24, 48, 96]) {
      rows.push(run(stopAtr, rr, holdBars));
    }
  }
}

// 按 train 的笔均 u 排，避免用 test 反选。
const byTrainU = [...rows].sort((a, b) => b.period['train-45d'].avgU - a.period['train-45d'].avgU);
const byTrainR = [...rows].sort((a, b) => b.period['train-45d'].avgR - a.period['train-45d'].avgR);
const top = byTrainU.slice(0, 12);

console.log('\nTop by train avgU');
console.table(top.map((r) => ({
  stop: r.stopAtr,
  rr: r.rr,
  hold: r.holdBars / 12,
  n: r.trades,
  win: r.winRate,
  avgR: r.avgR,
  avgU: r.avgU,
  totalU: r.totalU,
  ddU: r.maxDdU,
  trainU: r.period['train-45d'].avgU,
  testU: r.period['test-46d'].avgU,
  w1: r.win.w1.avgR,
  w2: r.win.w2.avgR,
  w3: r.win.w3.avgR,
})));

console.log('\nTop by train avgR');
console.table(byTrainR.slice(0, 8).map((r) => ({
  stop: r.stopAtr,
  rr: r.rr,
  hold: r.holdBars / 12,
  n: r.trades,
  win: r.winRate,
  avgR: r.avgR,
  avgU: r.avgU,
  totalU: r.totalU,
  trainR: r.period['train-45d'].avgR,
  testR: r.period['test-46d'].avgR,
  w1: r.win.w1.avgR,
  w2: r.win.w2.avgR,
  w3: r.win.w3.avgR,
})));

fs.writeFileSync(path.join(OUT, 's1-exit-grid.json'), JSON.stringify({
  meta: {
    selection: '按 train-45d avgU/avgR 排序，test-46d 只验证',
    cost: '0.12% round trip',
    entry: 'next 5m open',
    filter: 'T2/T3, OI up long / OI down short',
  },
  topByTrainU: top,
  topByTrainR: byTrainR.slice(0, 8),
  rows,
}, null, 2));
console.log(`\nwrote ${path.join(OUT, 's1-exit-grid.json')}`);
