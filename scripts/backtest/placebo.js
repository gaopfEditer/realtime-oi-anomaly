'use strict';

/*
 * 安慰剂测试：如果“每个 OI 异动都做多/做空”看起来很好，
 * 需要知道同期随机/全样本入场是不是也有同样的 1 ATR 止损、2R 目标命中率。
 * 这里每 4 小时取一个不重叠入场，长/空各跑一遍。
 */

const fs = require('fs');
const path = require('path');
const { loadSymbol } = require('./replay');

const MIN = 60 * 1000;
const COST = 0.0012;
const HOLD = 48;
const ATR_MULT = 1.0;
const RR = 2;
const CACHE = path.join(__dirname, '..', '..', 'backtest-cache');

function atrSeries(bars) {
  const atr = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i += 1) {
    const prev = i > 0 ? bars[i - 1].close : bars[i].open;
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prev), Math.abs(bars[i].low - prev));
    atr[i] = i === 0 ? tr : (atr[i - 1] * 13 + tr) / 14;
  }
  return atr;
}

function sim(bars, i, side, atr) {
  const entryIdx = i + 1;
  if (entryIdx >= bars.length) return null;
  const entry = bars[entryIdx].open;
  const risk = ATR_MULT * atr;
  if (!(entry > 0) || !(risk > 0)) return null;
  const stop = side === 'long' ? entry - risk : entry + risk;
  const target = side === 'long' ? entry + RR * risk : entry - RR * risk;
  const last = Math.min(bars.length - 1, entryIdx + HOLD - 1);
  let exit = 0;
  let exitTs = 0;
  let outcome = 'timeout';
  for (let j = entryIdx; j <= last; j += 1) {
    const b = bars[j];
    if (side === 'long') {
      if (b.low <= stop) { exit = stop; exitTs = b.ts; outcome = 'stop'; break; }
      if (b.high >= target) { exit = target; exitTs = b.ts; outcome = 'target'; break; }
    } else {
      if (b.high >= stop) { exit = stop; exitTs = b.ts; outcome = 'stop'; break; }
      if (b.low <= target) { exit = target; exitTs = b.ts; outcome = 'target'; break; }
    }
  }
  if (!exit) { exit = bars[last].close; exitTs = bars[last].ts; }
  const grossR = side === 'long' ? (exit - entry) / risk : (entry - exit) / risk;
  const riskPct = (risk / entry) * 100;
  if (!(riskPct >= 0.2 && riskPct <= 3.0)) return null;
  return {
    ts: bars[i].ts,
    exitTs,
    netR: grossR - (entry * COST) / risk,
    riskPct,
    outcome,
  };
}

function summarize(trades, label) {
  const n = trades.length;
  const wins = trades.filter((t) => t.netR > 0).length;
  const totalR = trades.reduce((a, t) => a + t.netR, 0);
  return {
    label,
    n,
    winRate: n ? wins / n : 0,
    avgR: n ? totalR / n : 0,
    totalR,
    stopRate: n ? trades.filter((t) => t.outcome === 'stop').length / n : 0,
  };
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(CACHE, 'manifest.json'), 'utf8'));
  const out = {};
  for (const side of ['long', 'short']) {
    const trades = [];
    for (const symbol of manifest.symbols) {
      const d = loadSymbol(symbol);
      if (!d.bars.length) continue;
      const atr = atrSeries(d.bars);
      let i = 0;
      while (i + HOLD + 1 < d.bars.length) {
        const t = sim(d.bars, i, side, atr[i]);
        if (t) {
          trades.push({ ...t, symbol });
          i = Math.max(i + 1, Math.floor((t.exitTs - d.bars[0].ts) / (5 * MIN)));
        } else i += 1;
      }
    }
    out[side] = summarize(trades, side);
    console.log(side, out[side]);
  }
  fs.writeFileSync(path.join(__dirname, '..', '..', 'backtest-results', 'event-study', 'placebo-4h.json'), JSON.stringify(out, null, 2));
}

if (require.main === module) main();
