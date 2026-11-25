'use strict';

/*
 * 对“温和放量”候选做三个连续 10 天窗口，检查是否只靠某一段行情。
 * 用法：node scripts/backtest/morphology-windows.js
 */

const fs = require('fs');
const path = require('path');
const { run, wilson } = require('./replay');
const { WINDOWS } = require('./config');
const { OPTIMIZED_STRATEGY } = require('../../api/src/watchlist');

const OUT = path.join(__dirname, '..', '..', 'backtest-results');
const DAY = 24 * 60 * 60 * 1000;

const candidates = [
  { tag: 'opt62-control', patch: {} },
  { tag: 'vol09-15', patch: { triggerMinBarVolumeRatio: 0.9, triggerMaxBarVolumeRatio: 1.5 } },
  { tag: 'vol10-14', patch: { triggerMinBarVolumeRatio: 1.0, triggerMaxBarVolumeRatio: 1.4 } },
  { tag: 'vol10-15', patch: { triggerMinBarVolumeRatio: 1.0, triggerMaxBarVolumeRatio: 1.5 } },
  { tag: 'vol11-15', patch: { triggerMinBarVolumeRatio: 1.1, triggerMaxBarVolumeRatio: 1.5 } },
];

const windows = WINDOWS;

function stat(trades) {
  const resolved = trades.filter((t) => t.t1Win || t.t1Loss);
  const wins = trades.filter((t) => t.t1Win).length;
  const avgR = trades.length ? trades.reduce((a, t) => a + (Number(t.netR) || 0), 0) / trades.length : 0;
  return {
    trades: trades.length,
    resolved: resolved.length,
    t1Wins: wins,
    winRateT1: resolved.length ? Math.round((wins / resolved.length) * 10000) / 10000 : 0,
    winRateT1Ci95: resolved.length ? wilson(wins, resolved.length) : [0, 0],
    avgNetR: Math.round(avgR * 10000) / 10000,
    totalR: Math.round(trades.reduce((a, t) => a + (Number(t.netR) || 0), 0) * 100) / 100,
  };
}

const rows = [];
for (const c of candidates) {
  const row = { tag: c.tag, patch: c.patch, windows: {} };
  for (const w of windows) {
    const start = w.start;
    const end = w.end;
    const r = run({
      strategy: { ...OPTIMIZED_STRATEGY, ...c.patch },
      start,
      end,
      quiet: true,
      write: false,
      tag: `${c.tag}-${w.tag}`,
    });
    row.windows[w.tag] = stat(r.trades);
  }
  rows.push(row);
  const parts = Object.entries(row.windows).map(([k, v]) =>
    `${k} ${v.trades}/${(v.winRateT1 * 100).toFixed(1)}%/${v.avgNetR}R`);
  console.log(`${c.tag}\t${parts.join('\t')}`);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'morphology-windows.json'), JSON.stringify({
  meta: { windows: windows.map((w) => `${w.period} (${w.label})`), base: 'opt62' },
  rows,
}, null, 2));
console.log(`\nwrote ${path.join(OUT, 'morphology-windows.json')}`);
