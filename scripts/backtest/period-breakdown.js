'use strict';

/*
 * 读取各档 trades.json，按时间窗口计算胜率、平均 R、总 R、名义收益和 1u/20x 盈亏。
 * 用法：node scripts/backtest/period-breakdown.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const RESULTS = path.join(ROOT, 'backtest-results');
const OUT = path.join(RESULTS, 'period-breakdown.json');

const PERIODS = [
  { label: 'full-91d', start: '2026-08-24', end: '2026-11-23' },
  { label: 'first-60d', start: '2026-08-24', end: '2026-10-23' },
  { label: 'last-31d', start: '2026-10-23', end: '2026-11-23' },
  { label: 'old-30d', start: '2026-10-24', end: '2026-11-23' },
  { label: 'w1-30d', start: '2026-08-24', end: '2026-09-23' },
  { label: 'w2-30d', start: '2026-09-23', end: '2026-10-23' },
  { label: 'w3-31d', start: '2026-10-23', end: '2026-11-23' },
];

const SOURCES = [
  { label: '91d-baseline', file: path.join(RESULTS, 'trades.json') },
  { label: '91d-optimized', file: path.join(RESULTS, 'optimized', 'trades.json') },
  { label: '91d-volume', file: path.join(RESULTS, 'volume', 'trades.json') },
  { label: '91d-rr', file: path.join(RESULTS, 'rr', 'trades.json') },
  { label: '30d-baseline', file: path.join(RESULTS, '30d', 'trades.json') },
  { label: '30d-optimized', file: path.join(RESULTS, '30d', 'optimized', 'trades.json') },
  { label: '30d-volume', file: path.join(RESULTS, '30d', 'volume', 'trades.json') },
  { label: '30d-rr', file: path.join(RESULTS, '30d', 'rr', 'trades.json') },
];

function load(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ts(v) {
  return Date.parse(v);
}

function pct(v) {
  return Number.isFinite(v) ? v : 0;
}

function stats(trades, start, end) {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  const rows = trades
    .filter((t) => {
      const at = ts(t.triggerAtIso || t.at || 0);
      return at >= from && at < to;
    })
    .sort((a, b) => ts(a.triggerAtIso || a.at || 0) - ts(b.triggerAtIso || b.at || 0));

  const n = rows.length;
  const resolved = rows.filter((t) => t.t1Win || t.t1Loss).length;
  const wins = rows.filter((t) => t.t1Win).length;
  let totalR = 0;
  let totalNotionalPct = 0;
  let totalMarginU = 0;
  let equityR = 0;
  let peakR = 0;
  let maxDdR = 0;
  let equityU = 0;
  let peakU = 0;
  let maxDdU = 0;

  for (const t of rows) {
    const r = Number(t.netR) || 0;
    const riskPct = Number(t.riskPct) || 0;
    const notionalPct = r * riskPct / 100;
    const marginU = notionalPct * 20;
    totalR += r;
    totalNotionalPct += notionalPct;
    totalMarginU += marginU;
    equityR += r;
    if (equityR > peakR) peakR = equityR;
    maxDdR = Math.min(maxDdR, equityR - peakR);
    equityU += marginU;
    if (equityU > peakU) peakU = equityU;
    maxDdU = Math.min(maxDdU, equityU - peakU);
  }

  return {
    trades: n,
    resolved,
    winRateT1: resolved ? wins / resolved : 0,
    avgNetR: n ? totalR / n : 0,
    totalR,
    avgNotionalPct: n ? totalNotionalPct / n : 0,
    totalNotionalPct,
    totalMarginU,
    avgMarginU: n ? totalMarginU / n : 0,
    maxDdR,
    maxDdU,
  };
}

const payload = {
  generatedAt: new Date().toISOString(),
  periods: PERIODS,
  rows: [],
};

for (const src of SOURCES) {
  const trades = load(src.file);
  for (const p of PERIODS) {
    payload.rows.push({
      source: src.label,
      period: p.label,
      ...stats(trades, p.start, p.end),
    });
  }
}

fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
console.log(`source\tperiod\ttrades\tT1\tavgR\ttotalR\tavgNotional%\ttotalMarginU\tavgMarginU\tmaxDdR\tmaxDdU`);
for (const r of payload.rows) {
  console.log([
    r.source,
    r.period,
    r.trades,
    `${(pct(r.winRateT1) * 100).toFixed(1)}%`,
    r.avgNetR.toFixed(3),
    r.totalR.toFixed(2),
    (r.avgNotionalPct * 100).toFixed(3),
    r.totalMarginU.toFixed(2),
    r.avgMarginU.toFixed(3),
    r.maxDdR.toFixed(2),
    r.maxDdU.toFixed(2),
  ].join('\t'));
}
console.log(`\nwrote ${OUT}`);
