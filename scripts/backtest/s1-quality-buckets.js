'use strict';

/*
 * S1 信号质量分桶：固定当前 1.0 ATR / 2.5R / 4h，只改变入场过滤，
 * 用 train-45d 看哪些特征真的有增量，test-46d 验证。
 */

const fs = require('fs');
const path = require('path');
const { runStrategy, summarize } = require('./strategy-sim');
const { loadSymbol } = require('./replay');
const { WINDOWS, EVAL_START, EVAL_END, TRAIN_END } = require('./config');

const CACHE = path.join(__dirname, '..', '..', 'backtest-cache');
const OUT = path.join(__dirname, '..', '..', 'backtest-results', 'event-study');
const events = JSON.parse(fs.readFileSync(path.join(OUT, 'events.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(CACHE, 'manifest.json'), 'utf8'));
const loads = new Map(manifest.symbols.map((s) => [s, loadSymbol(s)]));

const BASE = {
  stopAtr: 1.0,
  rr: 2.5,
  holdBars: 48,
  cost: 0.0012,
  side: (e) => (e.oiSide === 'up' ? 'long' : 'short'),
  filter: (e) => (e.tier === 'T2' || e.tier === 'T3') && (e.oiSide === 'up' || e.oiSide === 'down'),
};

const buckets = [];
function add(name, filter) { buckets.push({ name, filter }); }

const abs = (e) => Math.abs(e.oiPct);
add('all', () => true);
for (const [lo, hi] of [[0, 1.2], [1.2, 2], [2, 3], [3, 5], [5, 100]]) {
  add(`oiPct ${lo}-${hi}`, (e) => abs(e) >= lo && abs(e) < hi);
}
for (const q of ['up_up', 'up_down', 'down_up', 'down_down', 'up_flat', 'down_flat']) {
  add(`quadrant ${q}`, (e) => e.quadrant === q);
}
for (const t of ['up', 'mixed', 'down']) add(`trend4h ${t}`, (e) => e.trend4h === t);
for (const [lo, hi] of [[0, 1.5], [1.5, 2], [2, 2.5], [2.5, 3.5], [3.5, 99]]) {
  add(`volRatio ${lo}-${hi}`, (e) => e.volRatio >= lo && e.volRatio < hi);
}
for (const [lo, hi] of [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]]) {
  add(`rangePos48 ${lo}-${hi}`, (e) => e.rangePos48 >= lo && e.rangePos48 < hi);
}
for (const [lo, hi] of [[0, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]]) {
  add(`closeLocation ${lo}-${hi}`, (e) => e.closeLocation >= lo && e.closeLocation < hi);
}
for (const s of ['up', 'down']) add(`priceSide ${s}`, (e) => e.priceSide === s);
for (const [lo, hi] of [[0, 0.3], [0.3, 0.5], [0.5, 0.8], [0.8, 99]]) {
  add(`atrPct ${lo}-${hi}`, (e) => e.atrPct >= lo && e.atrPct < hi);
}
for (const t of ['up', 'mixed', 'down']) add(`btcTrend4h ${t}`, (e) => e.btcTrend4h === t);
for (const [lo, hi] of [[0, 0.35], [0.35, 0.55], [0.55, 1.01]]) {
  add(`breadth ${lo}-${hi}`, (e) => e.breadth >= lo && e.breadth < hi);
}
for (const [lo, hi] of [[0, 6], [6, 12], [12, 18], [18, 24]]) {
  add(`utcHour ${lo}-${hi}`, (e) => { const h = new Date(e.ts).getUTCHours(); return h >= lo && h < hi; });
}
for (const q of ['up_up', 'up_down', 'down_up', 'down_down']) {
  for (const t of ['up', 'mixed', 'down']) {
    add(`quadrant ${q} | trend ${t}`, (e) => e.quadrant === q && e.trend4h === t);
  }
}

const rows = [];
for (const b of buckets) {
  const cfg = { ...BASE, filter: (e) => BASE.filter(e) && b.filter(e) };
  const trades = runStrategy(events, loads, cfg);
  const full = summarize(trades, b.name);
  const train = summarize(trades.filter((t) => t.ts >= EVAL_START && t.ts < TRAIN_END), 'train');
  const test = summarize(trades.filter((t) => t.ts >= TRAIN_END && t.ts < EVAL_END), 'test');
  const wins = WINDOWS.map((w) => summarize(trades.filter((t) => t.ts >= w.start && t.ts < w.end), w.tag));
  rows.push({
    name: b.name,
    n: full.trades,
    win: full.winRate,
    avgR: full.avgR,
    avgU: full.avgU,
    totalU: full.totalU,
    ddU: full.maxDdU,
    winRate: full.winRate,
    trainN: train.trades,
    trainAvgR: train.avgR,
    testN: test.trades,
    testAvgR: test.avgR,
    w1: wins[0].avgR,
    w2: wins[1].avgR,
    w3: wins[2].avgR,
  });
}

const good = rows.filter((r) => r.n >= 100).sort((a, b) => b.trainAvgR - a.trainAvgR);
console.log('\nTop by train avgR (n>=100)');
console.table(good.slice(0, 20));
console.log('\nTop by full avgU (n>=100)');
console.table([...rows].filter((r) => r.n >= 100).sort((a, b) => b.avgU - a.avgU).slice(0, 15));

fs.writeFileSync(path.join(OUT, 's1-quality-buckets.json'), JSON.stringify({
  meta: {
    base: 'S1 1.0 ATR / 2.5R / 4h, T2/T3',
    selection: 'exploratory; rank by train avgR, test only validation',
    caveat: '多桶测试，需用 test 和窗口确认，不能只看 full',
  },
  rows,
}, null, 2));
console.log(`\nwrote ${path.join(OUT, 's1-quality-buckets.json')}`);
