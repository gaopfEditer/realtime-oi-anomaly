'use strict';

/*
 * 只对 4 个最终候选做小网格，避免大规模调参过拟合。
 * 训练段：前 45 天；验证段：后 46 天。
 * 输出完整 train/test，不按 test 结果反选参数。
 */

const fs = require('fs');
const path = require('path');
const { runStrategy, summarize } = require('./strategy-sim');
const { loadSymbol } = require('./replay');

const MIN = 60 * 1000;
const CACHE = path.join(__dirname, '..', '..', 'backtest-cache');
const OUT = path.join(__dirname, '..', '..', 'backtest-results', 'event-study');
const EVENTS = path.join(OUT, 'events.json');

const START = Date.UTC(2026, 7, 24);
const TRAIN_END = Date.UTC(2026, 9, 8);
const END = Date.UTC(2026, 10, 23);

const FINALISTS = [
  {
    tag: 'S1_oi_direction_t2t3',
    parts: [
      {
        side: (e) => (e.oiSide === 'up' ? 'long' : 'short'),
        filter: (e) => (e.oiSide === 'up' || e.oiSide === 'down') && (e.tier === 'T2' || e.tier === 'T3'),
      },
    ],
  },
  {
    tag: 'S2_oi_absorb_long_t2t3',
    parts: [
      { side: 'long', filter: (e) => e.quadrant === 'up_down' && (e.trend4h === 'up' || e.trend4h === 'mixed') && (e.tier === 'T2' || e.tier === 'T3') },
    ],
  },
  {
    tag: 'S3_oi_flush_short',
    parts: [
      { side: 'short', filter: (e) => e.oiSide === 'down' && e.trend4h === 'up' },
    ],
  },
  {
    tag: 'S4_highvol_low_short',
    parts: [
      { side: 'short', filter: (e) => e.volRatio >= 2 && e.rangePos48 < 0.3 },
    ],
  },
  {
    tag: 'S3b_oi_flush_short_t2t3',
    parts: [
      { side: 'short', filter: (e) => e.oiSide === 'down' && e.trend4h === 'up' && (e.tier === 'T2' || e.tier === 'T3') },
    ],
  },
];

function mergeTrades(a, b) {
  return [...a, ...b].sort((x, y) => x.exitTs - y.exitTs);
}

function inWindow(trades, start, end) {
  return trades.filter((t) => t.ts >= start && t.ts < end);
}

function main() {
  const events = JSON.parse(fs.readFileSync(EVENTS, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(CACHE, 'manifest.json'), 'utf8'));
  const loads = new Map();
  for (const symbol of manifest.symbols) loads.set(symbol, loadSymbol(symbol));

  const rows = [];
  const results = {};
  for (const f of FINALISTS) {
    for (const stopAtr of [1.0, 1.2, 1.5]) {
      for (const rr of [1.5, 2, 2.5]) {
        for (const holdBars of [48, 96, 192]) {
          const trades = f.parts.flatMap((p) => runStrategy(events, loads, { ...p, stopAtr, rr, holdBars }));
          const combined = mergeTrades(trades, []);
          const full = summarize(combined, 'full');
          const train = summarize(inWindow(combined, START, TRAIN_END), 'train-45d');
          const test = summarize(inWindow(combined, TRAIN_END, END), 'test-46d');
          const row = { stopAtr, rr, holdBars, full, train, test };
          rows.push({ tag: f.tag, ...row });
          if (!results[f.tag]) results[f.tag] = [];
          results[f.tag].push(row);
        }
      }
    }
  }

  // 按 train avgR 排，避免用 test 挑参数；同时打印 test 供验证。
  for (const f of FINALISTS) {
    results[f.tag].sort((a, b) => b.train.avgR - a.train.avgR);
    console.log(`\n${f.tag} top by train avgR`);
    console.table(results[f.tag].slice(0, 6).map((r) => ({
      stop: r.stopAtr,
      rr: r.rr,
      hold: r.holdBars / 12,
      n: r.full.trades,
      win: r.full.winRate,
      avgR: r.full.avgR,
      totalR: r.full.totalR,
      u: r.full.totalU,
      dd: r.full.maxDdR,
      trainN: r.train.trades,
      trainR: r.train.avgR,
      testN: r.test.trades,
      testR: r.test.avgR,
    })));
  }

  fs.writeFileSync(path.join(OUT, 'final-param-grid.json'), JSON.stringify({
    meta: {
      selection: '按 train-45d avgR 排序，test-46d 只验证不做选择',
      start: new Date(START).toISOString(),
      trainEnd: new Date(TRAIN_END).toISOString(),
      end: new Date(END).toISOString(),
      cost: '0.12% round trip',
      noOverlap: true,
    },
    finalists: FINALISTS.map((f) => ({ tag: f.tag, parts: f.parts.length })),
    rows,
  }, null, 2));
  console.log(`\nwrote ${path.join(OUT, 'final-param-grid.json')}`);
}

if (require.main === module) main();

module.exports = { FINALISTS };
