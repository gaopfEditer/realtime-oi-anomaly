'use strict';

/*
 * S1 质量分层组合。
 * 不是按板块/市值做宏大分层，只验证三个当下已知的入场特征：
 * - OI 方向 × 价格方向（quadrant）
 * - 4h 趋势
 * - UTC 时段
 * 选参仍看 train-45d，test-46d 只验证。
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

const hour = (e) => new Date(e.ts).getUTCHours();
const base = (e) => (e.tier === 'T2' || e.tier === 'T3') && (e.oiSide === 'up' || e.oiSide === 'down');

const PROFILES = [
  { tag: 'S1_current', filter: base },
  { tag: 'S1_trend_up', filter: (e) => base(e) && e.trend4h === 'up' },
  { tag: 'S1_quad_align', filter: (e) => base(e) && ((e.oiSide === 'up' && e.quadrant === 'up_up') || (e.oiSide === 'down' && e.quadrant === 'down_down')) },
  { tag: 'S1_quad_align_trend_up', filter: (e) => base(e) && e.trend4h === 'up' && ((e.oiSide === 'up' && e.quadrant === 'up_up') || (e.oiSide === 'down' && e.quadrant === 'down_down')) },
  { tag: 'S1_quad_align_trend_up_h18', filter: (e) => base(e) && e.trend4h === 'up' && hour(e) >= 18 && hour(e) < 24 && ((e.oiSide === 'up' && e.quadrant === 'up_up') || (e.oiSide === 'down' && e.quadrant === 'down_down')) },
  { tag: 'S1_trend_up_h18', filter: (e) => base(e) && e.trend4h === 'up' && hour(e) >= 18 && hour(e) < 24 },
  { tag: 'S1_vol25_35', filter: (e) => base(e) && e.volRatio >= 2.5 && e.volRatio < 3.5 },
  { tag: 'S1_range06_08', filter: (e) => base(e) && e.rangePos48 >= 0.6 && e.rangePos48 < 0.8 },
];

function runProfile(p, params) {
  const trades = runStrategy(events, loads, {
    filter: p.filter,
    side: (e) => (e.oiSide === 'up' ? 'long' : 'short'),
    stopAtr: params.stopAtr,
    rr: params.rr,
    holdBars: params.holdBars,
    cost: 0.0012,
  });
  const full = summarize(trades, p.tag);
  const train = summarize(trades.filter((t) => t.ts >= EVAL_START && t.ts < TRAIN_END), 'train');
  const test = summarize(trades.filter((t) => t.ts >= TRAIN_END && t.ts < EVAL_END), 'test');
  const wins = WINDOWS.map((w) => summarize(trades.filter((t) => t.ts >= w.start && t.ts < w.end), w.tag));
  return { tag: p.tag, params, full, train, test, windows: wins };
}

const rows = [];
for (const p of PROFILES) {
  rows.push(runProfile(p, { stopAtr: 1.0, rr: 2.5, holdBars: 48 }));
}
// 只对最有质量的组合再试两个止损/目标档，看是否叠加。
for (const p of PROFILES.filter((x) => x.tag === 'S1_quad_align_trend_up' || x.tag === 'S1_trend_up')) {
  rows.push(runProfile(p, { stopAtr: 2.0, rr: 3.0, holdBars: 24 }));
  rows.push(runProfile(p, { stopAtr: 2.0, rr: 4.0, holdBars: 24 }));
}

console.table(rows.map((r) => ({
  tag: r.tag,
  stop: r.params.stopAtr,
  rr: r.params.rr,
  hold: r.params.holdBars / 12,
  n: r.full.trades,
  win: r.full.winRate,
  avgR: r.full.avgR,
  avgU: r.full.avgU,
  totalU: r.full.totalU,
  ddU: r.full.maxDdU,
  trainN: r.train.trades,
  trainR: r.train.avgR,
  testN: r.test.trades,
  testR: r.test.avgR,
  w1: r.windows[0].avgR,
  w2: r.windows[1].avgR,
  w3: r.windows[2].avgR,
})));

fs.writeFileSync(path.join(OUT, 's1-quality-strategies.json'), JSON.stringify({
  meta: {
    selection: '特征来自 train-45d 分桶；test-46d 只验证',
    cost: '0.12% round trip',
    entry: 'next 5m open',
    caveat: 'S1_quad_align_trend_up 的 n 低于全样本，需继续做样本外和实盘 shadow',
  },
  rows,
}, null, 2));
console.log(`wrote ${path.join(OUT, 's1-quality-strategies.json')}`);
