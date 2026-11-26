'use strict';

/*
 * 最终 OI 事件策略：4 个具体 profile，固定 1 ATR 止损、2.5R 目标、4h 持有。
 * 参数不是全市场扫出来的，而是先看事件特征，再用前 45 天选、后 46 天验证。
 */

const fs = require('fs');
const path = require('path');
const { runStrategy, summarize } = require('./strategy-sim');
const { loadSymbol } = require('./replay');
const { WINDOWS, PERIODS } = require('./config');

const MIN = 60 * 1000;
const CACHE = path.join(__dirname, '..', '..', 'backtest-cache');
const OUT = path.join(__dirname, '..', '..', 'backtest-results', 'event-study');
const EVENTS = path.join(OUT, 'events.json');

const T2T3 = (e) => e.tier === 'T2' || e.tier === 'T3';
const T2T3T4 = (e) => e.tier === 'T2' || e.tier === 'T3' || e.tier === 'T4';

const PROFILES = [
  {
    tag: 'S1_oi_direction_t2t3',
    label: 'OI 方向脉冲（T2/T3）',
    side: (e) => (e.oiSide === 'up' ? 'long' : 'short'),
    filter: (e) => T2T3(e) && (e.oiSide === 'up' || e.oiSide === 'down'),
  },
  {
    tag: 'S2_oi_absorb_long_t2t3',
    label: 'OI 增、价跌吸收（T2/T3，4h 非下跌）',
    side: 'long',
    filter: (e) => T2T3(e) && e.quadrant === 'up_down' && (e.trend4h === 'up' || e.trend4h === 'mixed'),
  },
  {
    tag: 'S3_oi_flush_short_t2t3',
    label: 'OI 减、4h 上涨中反抽（T2/T3）',
    side: 'short',
    filter: (e) => T2T3(e) && e.oiSide === 'down' && e.trend4h === 'up',
  },
  {
    tag: 'S4_highvol_low_short_t2t4',
    label: '高量低位破位（T2/T3/T4，下一根开盘入场）',
    side: 'short',
    filter: (e) => T2T3T4(e) && e.volRatio >= 2 && e.rangePos48 < 0.3,
  },
  {
    tag: 'S4D_highvol_low_short_delay1',
    label: '高量低位破位（等第一根 5m 走完再空）',
    side: 'short',
    filter: (e) => T2T3T4(e) && e.volRatio >= 2.5 && e.rangePos48 < 0.2,
    params: { stopAtr: 1.2, rr: 2.5, holdBars: 48, entryDelayBars: 1 },
  },
];

const PARAMS = { stopAtr: 1.0, rr: 2.5, holdBars: 48, cost: 0.0012 };

function inWindow(trades, start, end) {
  return trades.filter((t) => t.ts >= start && t.ts < end);
}

function concurrency(trades) {
  const points = [];
  for (const t of trades) {
    points.push([t.entryTs, 1]);
    points.push([t.exitTs, -1]);
  }
  points.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  let active = 0;
  let maxActive = 0;
  for (const [, delta] of points) {
    active += delta;
    maxActive = Math.max(maxActive, active);
  }
  return { maxConcurrent: maxActive, avgConcurrent: trades.length ? trades.reduce((a, t) => a + (t.exitTs - t.entryTs), 0) / (91 * 24 * 60 * MIN) : 0 };
}

function profileResult(trades, params) {
  const full = summarize(trades, 'full');
  return {
    params,
    full,
    windows: WINDOWS.map((w) => summarize(inWindow(trades, w.start, w.end), w.tag)),
    periods: PERIODS.map((p) => summarize(inWindow(trades, p.start, p.end), p.label)),
    bySide: ['long', 'short'].map((side) => summarize(trades.filter((t) => t.side === side), side)),
    bySector: [...new Set(trades.map((t) => t.sector || 'other'))].sort().map((v) => summarize(trades.filter((t) => (t.sector || 'other') === v), v)),
    byTier: ['T1', 'T2', 'T3', 'T4'].map((v) => summarize(trades.filter((t) => t.tier === v), v)),
    bySymbol: [...new Set(trades.map((t) => t.symbol))].sort().map((v) => summarize(trades.filter((t) => t.symbol === v), v)),
    concurrency: concurrency(trades),
  };
}

function main() {
  const events = JSON.parse(fs.readFileSync(EVENTS, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(CACHE, 'manifest.json'), 'utf8'));
  const loads = new Map();
  for (const symbol of manifest.symbols) loads.set(symbol, loadSymbol(symbol));

  const results = {};
  for (const p of PROFILES) {
    const cfg = { ...p, ...PARAMS, ...(p.params || {}) };
    const trades = runStrategy(events, loads, cfg);
    const result = profileResult(trades, {
      stopAtr: cfg.stopAtr,
      rr: cfg.rr,
      holdBars: cfg.holdBars,
      cost: cfg.cost,
      entryDelayBars: cfg.entryDelayBars || 0,
    });
    results[p.tag] = {
      ...p,
      filter: `${p.filter}`,
      ...result,
    };
    console.log(`\n${p.tag} (${p.label})`);
    console.log(`n=${result.full.trades} win=${(result.full.winRate * 100).toFixed(1)}% avgR=${result.full.avgR} totalR=${result.full.totalR} totalU=${result.full.totalU} DD=${result.full.maxDdR}R/${result.full.maxDdU}u maxConcurrent=${result.concurrency.maxConcurrent}`);
    console.table(result.windows.map((w) => ({ window: w.label, n: w.trades, win: w.winRate, avgR: w.avgR, totalR: w.totalR, u: w.totalU })));
  }

  // 成本敏感性：0.12% / 0.24% / 0.40% 往返。
  const costs = {};
  for (const cost of [0.0012, 0.0024, 0.004]) {
    costs[cost] = {};
    for (const p of PROFILES) {
      const base = { ...p, ...PARAMS, ...(p.params || {}) };
      const trades = runStrategy(events, loads, { ...base, cost });
      costs[cost][p.tag] = summarize(trades, `${p.tag}@${cost}`);
    }
  }
  results.costSensitivity = costs;

  // 入场延迟敏感性：0=下一根开盘，1=等 5 分钟后的开盘，2=等 10 分钟。
  const delays = {};
  for (const delay of [0, 1, 2]) {
    delays[delay] = {};
    for (const p of PROFILES) {
      const base = { ...p, ...PARAMS, ...(p.params || {}) };
      const trades = runStrategy(events, loads, { ...base, entryDelayBars: delay });
      delays[delay][p.tag] = summarize(trades, `${p.tag}@delay${delay}`);
    }
  }
  results.entryDelaySensitivity = delays;

  // 入场滑点敏感性：在下一根开盘价基础上，做多买贵/做空卖便宜。
  const slips = {};
  for (const slip of [0.0005, 0.001, 0.002, 0.005]) {
    slips[slip] = {};
    for (const p of PROFILES) {
      const base = { ...p, ...PARAMS, ...(p.params || {}) };
      const trades = runStrategy(events, loads, { ...base, entrySlippagePct: slip });
      slips[slip][p.tag] = summarize(trades, `${p.tag}@slip${slip}`);
    }
  }
  results.entrySlippageSensitivity = slips;

  fs.writeFileSync(path.join(OUT, 'final-oi-strategies.json'), JSON.stringify({
    meta: {
      period: '2026-08-24 ~ 2026-11-22 UTC (91d)',
      entry: '5m OI 异动信号收盘，下一根 5m 开盘',
      noOverlap: '同一币种不重叠持仓',
      stop: '1.0 ATR',
      target: '2.5R',
      hold: '4h（48 根 5m）',
      cost: '0.12% round trip',
      benchmark: '同期 BTC -20.6%，51 山寨多数下跌',
    },
    profiles: results,
  }, null, 2));
  console.log(`\nwrote ${path.join(OUT, 'final-oi-strategies.json')}`);
}

if (require.main === module) main();

module.exports = { PROFILES, PARAMS };
