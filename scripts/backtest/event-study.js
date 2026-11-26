'use strict';

/*
 * OI 异动事件级研究。
 *
 * 与 replay.js 的“箱体+触发”回放不同，这里直接从 5m OI 异动信号出发，
 * 记录事件当时的币种规模、板块、4h/1h 趋势、BTC 环境、量能、插针、区间位置，
 * 并统计下一根 bar 开盘入场后 15m ~ 24h 的多空前瞻收益。
 *
 * 目的：先看数据里到底哪些局部条件有可重复收益，再决定策略；
 * 不是先画一个分层框架再硬套。
 */

const fs = require('fs');
const path = require('path');
const { loadSymbol } = require('./replay');
const { EVAL_START, EVAL_END, WINDOWS, PERIODS } = require('./config');
const { liquidityTierOf, sectorOf } = require('./context');

const MIN = 60 * 1000;
const H1 = 60 * MIN;
const H4 = 4 * H1;
const COST_PCT = 0.12;
const CACHE = path.join(__dirname, '..', '..', 'backtest-cache');
const OUT = path.join(__dirname, '..', '..', 'backtest-results', 'event-study');
const SIGNALS = path.join(__dirname, '..', '..', 'backtest-results', 'signals.json');
const HORIZONS = [
  { bars: 3, label: '15m' },
  { bars: 6, label: '30m' },
  { bars: 12, label: '1h' },
  { bars: 24, label: '2h' },
  { bars: 48, label: '4h' },
  { bars: 96, label: '8h' },
  { bars: 144, label: '12h' },
  { bars: 288, label: '24h' },
];

function round(n, p = 4) {
  const m = 10 ** p;
  return Math.round((Number(n) || 0) * m) / m;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const avg = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - avg) ** 2, 0) / (arr.length - 1));
}

function quantile(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function prefixSums(bars, key) {
  const sums = [0];
  for (let i = 0; i < bars.length; i += 1) sums.push(sums[i] + (Number(bars[i][key]) || 0));
  return sums;
}

function rollingSum(prefix, i, n) {
  const from = Math.max(0, i - n + 1);
  return prefix[i + 1] - prefix[from];
}

function resample(bars, ms) {
  const map = new Map();
  for (const b of bars) {
    const bucket = Math.floor(b.ts / ms) * ms;
    let r = map.get(bucket);
    if (!r) {
      r = { ts: bucket, open: b.open, high: b.high, low: b.low, close: b.close, quoteVol: 0 };
      map.set(bucket, r);
    }
    r.high = Math.max(r.high, b.high);
    r.low = Math.min(r.low, b.low);
    r.close = b.close;
    r.quoteVol += Number(b.quoteVol) || 0;
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

function ema(values, period) {
  const out = new Array(values.length).fill(0);
  if (!values.length) return out;
  const k = 2 / (period + 1);
  out[0] = values[0];
  for (let i = 1; i < values.length; i += 1) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

function buildTrend(bars) {
  const atr = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i += 1) {
    const prev = i > 0 ? bars[i - 1].close : bars[i].open;
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prev), Math.abs(bars[i].low - prev));
    atr[i] = i === 0 ? tr : (atr[i - 1] * 13 + tr) / 14;
  }

  const h4 = resample(bars, H4);
  const h4Ema50 = ema(h4.map((x) => x.close), 50);
  const h4Ema200 = ema(h4.map((x) => x.close), 200);
  const h4ByTs = new Map();
  for (let i = 0; i < h4.length; i += 1) {
    h4ByTs.set(h4[i].ts, {
      ts: h4[i].ts,
      close: h4[i].close,
      ema50: h4Ema50[i],
      ema200: h4Ema200[i],
    });
  }

  const h1 = resample(bars, H1);
  const h1Ema20 = ema(h1.map((x) => x.close), 20);
  const h1Ema50 = ema(h1.map((x) => x.close), 50);
  const h1ByTs = new Map();
  for (let i = 0; i < h1.length; i += 1) {
    h1ByTs.set(h1[i].ts, {
      ts: h1[i].ts,
      close: h1[i].close,
      ema20: h1Ema20[i],
      ema50: h1Ema50[i],
    });
  }

  const quotePrefix = prefixSums(bars, 'quoteVol');
  return { bars, atr, h4ByTs, h1ByTs, quotePrefix };
}

function lastCompleted(map, ts, ms) {
  return map.get(Math.floor((ts - 1) / ms) * ms) || null;
}

function trendLabel(close, fast, slow) {
  if (!(close > 0) || !(fast > 0) || !(slow > 0)) return 'unknown';
  if (close > fast && fast > slow) return 'up';
  if (close < fast && fast < slow) return 'down';
  return 'mixed';
}

function buildBreadth(loads) {
  const countByBucket = new Map();
  const aboveByBucket = new Map();
  for (const load of loads.values()) {
    for (const [bucket, h4] of load.trend.h4ByTs) {
      if (!(h4.ema50 > 0)) continue;
      countByBucket.set(bucket, (countByBucket.get(bucket) || 0) + 1);
      if (h4.close > h4.ema50) aboveByBucket.set(bucket, (aboveByBucket.get(bucket) || 0) + 1);
    }
  }
  const out = new Map();
  for (const [bucket, count] of countByBucket) {
    if (count >= 10) out.set(bucket, (aboveByBucket.get(bucket) || 0) / count);
  }
  return out;
}

function breadthAt(map, ts) {
  return map.get(Math.floor((ts - 1) / H4) * H4) ?? null;
}

function bucketOf(v, bands) {
  for (const [label, lo, hi] of bands) {
    if ((lo === null || v >= lo) && (hi === null || v < hi)) return label;
  }
  return bands[bands.length - 1][0];
}

function sideOfPrice(v) {
  if (v > 0.05) return 'up';
  if (v < -0.05) return 'down';
  return 'flat';
}

function horizonValue(event, hLabel, side) {
  const f = event.fwd[hLabel];
  if (!f) return null;
  return side === 'long' ? f.long : f.short;
}

function stat(rows, hLabel, side) {
  const vals = rows.map((e) => horizonValue(e, hLabel, side)).filter((x) => Number.isFinite(x));
  if (!vals.length) {
    return { n: 0, mean: 0, median: 0, winRate: 0, std: 0, t: 0 };
  }
  const avg = mean(vals);
  const sd = stdev(vals);
  return {
    n: vals.length,
    mean: round(avg, 3),
    median: round(median(vals), 3),
    winRate: round(vals.filter((x) => x > 0).length / vals.length, 4),
    std: round(sd, 3),
    t: sd > 0 ? round(avg / (sd / Math.sqrt(vals.length)), 2) : 0,
  };
}

function group(events, keyFn, label, hLabel = '4h') {
  const map = new Map();
  for (const e of events) {
    const k = keyFn(e);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  const rows = [];
  for (const [k, list] of map) {
    if (list.length < 20) continue;
    const long = stat(list, hLabel, 'long');
    const short = stat(list, hLabel, 'short');
    const w1 = stat(list.filter((e) => e.ts >= WINDOWS[0].start && e.ts < WINDOWS[0].end), hLabel, 'long');
    const w2 = stat(list.filter((e) => e.ts >= WINDOWS[1].start && e.ts < WINDOWS[1].end), hLabel, 'long');
    const w3 = stat(list.filter((e) => e.ts >= WINDOWS[2].start && e.ts < WINDOWS[2].end), hLabel, 'long');
    rows.push({
      label,
      bucket: k,
      n: list.length,
      longMean: long.mean,
      longWin: long.winRate,
      longT: long.t,
      shortMean: short.mean,
      shortWin: short.winRate,
      shortT: short.t,
      longW1: w1.mean,
      longW2: w2.mean,
      longW3: w3.mean,
      shortW1: w1.n ? stat(list.filter((e) => e.ts >= WINDOWS[0].start && e.ts < WINDOWS[0].end), hLabel, 'short').mean : 0,
      shortW2: w2.n ? stat(list.filter((e) => e.ts >= WINDOWS[1].start && e.ts < WINDOWS[1].end), hLabel, 'short').mean : 0,
      shortW3: w3.n ? stat(list.filter((e) => e.ts >= WINDOWS[2].start && e.ts < WINDOWS[2].end), hLabel, 'short').mean : 0,
    });
  }
  rows.sort((a, b) => Math.max(a.longMean, a.shortMean) - Math.max(b.longMean, b.shortMean));
  return rows;
}

function printTable(title, rows, limit = 12) {
  console.log(`\n=== ${title} ===`);
  const top = [...rows].sort((a, b) => Math.max(a.longMean, a.shortMean) - Math.max(b.longMean, b.shortMean)).slice(-limit).reverse();
  console.table(top.map((r) => ({
    bucket: r.bucket,
    n: r.n,
    long: r.longMean,
    longWin: r.longWin,
    short: r.shortMean,
    shortWin: r.shortWin,
    w1: r.longW1,
    w2: r.longW2,
    w3: r.longW3,
    sw1: r.shortW1,
    sw2: r.shortW2,
    sw3: r.shortW3,
  })));
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(CACHE, 'manifest.json'), 'utf8'));
  const symbols = manifest.symbols;
  const loads = new Map();
  for (const symbol of [...symbols, 'BTCUSDT']) {
    const data = loadSymbol(symbol);
    if (!data.bars.length) continue;
    loads.set(symbol, { ...data, trend: buildTrend(data.bars) });
  }
  if (!loads.has('BTCUSDT')) throw new Error('BTC cache missing');
  const breadth = buildBreadth(loads);
  const signals = JSON.parse(fs.readFileSync(SIGNALS, 'utf8'));

  const events = [];
  for (const sig of signals) {
    const load = loads.get(sig.symbol);
    if (!load) continue;
    const barByTs = new Map(load.bars.map((b, i) => [b.ts, i]));
    const i = barByTs.get(sig.ts - 5 * MIN);
    if (i == null || i < 50 || i + 1 >= load.bars.length) continue;
    const bar = load.bars[i];
    const next = load.bars[i + 1];
    const next1 = load.bars[i + 1];
    const atr = load.trend.atr[i];
    const px = bar.close;
    if (!(px > 0) || !next || !(next.open > 0) || !(atr > 0)) continue;

    const prev3 = i >= 3 ? load.bars[i - 3].close : bar.open;
    const prev6 = i >= 6 ? load.bars[i - 6].close : prev3;
    const priceRet1 = ((bar.close - bar.open) / bar.open) * 100;
    const priceRet3 = ((bar.close - prev3) / prev3) * 100;
    const priceRet6 = ((bar.close - prev6) / prev6) * 100;
    const range = Math.max(bar.high - bar.low, 1e-9);
    const bodyPct = (Math.abs(bar.close - bar.open) / range) * 100;
    const upperWickRatio = (bar.high - Math.max(bar.open, bar.close)) / range;
    const lowerWickRatio = (Math.min(bar.open, bar.close) - bar.low) / range;
    const closeLocation = (bar.close - bar.low) / range;
    const volBase = mean(load.bars.slice(Math.max(0, i - 20), i).map((b) => b.quoteVol || 0));
    const volRatio = volBase > 0 ? (bar.quoteVol || 0) / volBase : 1;

    const high48 = Math.max(...load.bars.slice(Math.max(0, i - 47), i + 1).map((b) => b.high));
    const low48 = Math.min(...load.bars.slice(Math.max(0, i - 47), i + 1).map((b) => b.low));
    const rangePos48 = high48 > low48 ? (bar.close - low48) / (high48 - low48) : 0.5;

    const h4 = lastCompleted(load.trend.h4ByTs, sig.ts, H4);
    const h1 = lastCompleted(load.trend.h1ByTs, sig.ts, H1);
    const btc = loads.get('BTCUSDT');
    const btcH4 = lastCompleted(btc.trend.h4ByTs, sig.ts, H4);
    const btcH1 = lastCompleted(btc.trend.h1ByTs, sig.ts, H1);
    const btcI = new Map(btc.bars.map((b, idx) => [b.ts, idx])).get(sig.ts - 5 * MIN);
    const btcRet15m = btcI != null && btcI >= 3 ? ((btc.bars[btcI].close - btc.bars[btcI - 3].close) / btc.bars[btcI - 3].close) * 100 : 0;
    const btcRet1h = btcI != null && btcI >= 12 ? ((btc.bars[btcI].close - btc.bars[btcI - 12].close) / btc.bars[btcI - 12].close) * 100 : 0;

    const adv = rollingSum(load.trend.quotePrefix, i, 288);
    // OI 绝对值从 metrics 读取，使用事件时间点最后一条。
    const oiPoint = load.oi.reduce((best, p) => (p.ts <= sig.ts ? p : best), null);
    const oiNow = oiPoint ? oiPoint.oiUsdt : 0;
    const tier = liquidityTierOf({ quoteVolume24h: adv, oiUsdt: oiNow });
    const sector = sectorOf(sig.symbol);
    const trend4h = h4 ? trendLabel(px, h4.ema50, h4.ema200) : 'unknown';
    const trend1h = h1 ? trendLabel(px, h1.ema20, h1.ema50) : 'unknown';
    const btcTrend4h = btcH4 ? trendLabel(btcH4.close, btcH4.ema50, btcH4.ema200) : 'unknown';
    const btcTrend1h = btcH1 ? trendLabel(btcH1.close, btcH1.ema20, btcH1.ema50) : 'unknown';
    const breadthValue = breadthAt(breadth, sig.ts);
    const oiSide = sig.side === 'up' ? 'up' : 'down';
    const priceSide = sideOfPrice(priceRet3);
    const quadrant = `${oiSide}_${priceSide}`;

    const fwd = {};
    for (const h of HORIZONS) {
      const j = i + h.bars;
      if (j >= load.bars.length) {
        fwd[h.label] = null;
        continue;
      }
      const exit = load.bars[j].close;
      if (!(exit > 0)) {
        fwd[h.label] = null;
        continue;
      }
      fwd[h.label] = {
        long: ((exit - next.open) / next.open) * 100 - COST_PCT,
        short: ((next.open - exit) / next.open) * 100 - COST_PCT,
      };
    }

    events.push({
      ts: sig.ts,
      symbol: sig.symbol,
      sector,
      tier,
      entry: round(next.open, 6),
      atr: round(atr, 6),
      oiSide,
      oiPct: Number(sig.pct) || 0,
      oiAbsDelta: Number(sig.absDelta) || 0,
      oiUsd: oiNow,
      adv,
      priceRet1: round(priceRet1, 3),
      priceRet3: round(priceRet3, 3),
      priceRet6: round(priceRet6, 3),
      bodyPct: round(bodyPct, 1),
      upperWickRatio: round(upperWickRatio, 3),
      lowerWickRatio: round(lowerWickRatio, 3),
      closeLocation: round(closeLocation, 3),
      volRatio: round(volRatio, 3),
      atrPct: round((atr / px) * 100, 3),
      rangePos48: round(rangePos48, 3),
      trend4h,
      trend1h,
      btcTrend4h,
      btcTrend1h,
      btcRet15m: round(btcRet15m, 3),
      btcRet1h: round(btcRet1h, 3),
      breadth: breadthValue == null ? null : round(breadthValue, 3),
      priceSide,
      quadrant,
      next1RetPct: next ? round(((next.close - next.open) / next.open) * 100, 3) : null,
      next1RetAtr: next && atr > 0 ? round((next.close - next.open) / atr, 3) : null,
      next1CloseLoc: next ? round((next.close - next.low) / Math.max(next.high - next.low, 1e-9), 3) : null,
      next1VolRatio: next && volBase > 0 ? round((next.quoteVol || 0) / volBase, 3) : null,
      fwd,
    });
  }

  const stats = {
    meta: {
      period: `${new Date(EVAL_START).toISOString().slice(0, 10)} ~ ${new Date(EVAL_END - 1).toISOString().slice(0, 10)} UTC`,
      events: events.length,
      symbols: symbols.length,
      entry: '信号 5m bar 收盘后，下一根 bar 开盘入场',
      costs: `往返 ${COST_PCT}%`,
      horizons: HORIZONS.map((h) => h.label),
      caveat: '未计资金费率、盘口冲击；4h/1h 趋势只使用已完成 bar',
    },
    overall: {
      long4h: stat(events, '4h', 'long'),
      short4h: stat(events, '4h', 'short'),
      long1h: stat(events, '1h', 'long'),
      short1h: stat(events, '1h', 'short'),
    },
    groups: {},
  };

  const defs = [
    ['oiSide', (e) => e.oiSide],
    ['quadrant', (e) => e.quadrant],
    ['tier', (e) => e.tier],
    ['sector', (e) => e.sector],
    ['oiPctBucket', (e) => bucketOf(Math.abs(e.oiPct), [['0.5~1.2', 0.5, 1.2], ['1.2~2', 1.2, 2], ['2~3', 2, 3], ['3~5', 3, 5], ['5+', 5, null]])],
    ['volBucket', (e) => bucketOf(e.volRatio, [['<0.9', null, 0.9], ['0.9~1.5', 0.9, 1.5], ['1.5~2', 1.5, 2], ['2+', 2, null]])],
    ['trend4h', (e) => e.trend4h],
    ['trend1h', (e) => e.trend1h],
    ['btcTrend4h', (e) => e.btcTrend4h],
    ['closeLocation', (e) => bucketOf(e.closeLocation, [['0~0.4', 0, 0.4], ['0.4~0.6', 0.4, 0.6], ['0.6~0.8', 0.6, 0.8], ['0.8~1', 0.8, 1.01]])],
    ['rangePos48', (e) => bucketOf(e.rangePos48, [['0~0.2', 0, 0.2], ['0.2~0.4', 0.2, 0.4], ['0.4~0.6', 0.4, 0.6], ['0.6~0.8', 0.6, 0.8], ['0.8~1', 0.8, 1.01]])],
    ['breadth', (e) => (e.breadth == null ? 'null' : bucketOf(e.breadth, [['low<0.35', null, 0.35], ['mid0.35~0.55', 0.35, 0.55], ['high>0.55', 0.55, null]]))],
    ['btcRet15m', (e) => bucketOf(e.btcRet15m, [['<-1', null, -1], ['-1~0', -1, 0], ['0~1', 0, 1], ['>1', 1, null]])],
  ];

  for (const [name, fn] of defs) {
    const rows = group(events, fn, name, '4h');
    stats.groups[name] = rows;
    printTable(name, rows);
  }

  // 关键组合：OI 方向 + 价格方向 + 4h 趋势；规模 + 趋势；量能 + 区间位置。
  const combos = [
    ['quadrant_trend4h', (e) => `${e.quadrant}|${e.trend4h}`],
    ['tier_trend4h', (e) => `${e.tier}|${e.trend4h}`],
    ['tier_sector', (e) => `${e.tier}|${e.sector}`],
    ['vol_rangePos', (e) => `${bucketOf(e.volRatio, [['<0.9', null, 0.9], ['0.9~1.5', 0.9, 1.5], ['1.5~2', 1.5, 2], ['2+', 2, null]])}|${bucketOf(e.rangePos48, [['low<0.3', null, 0.3], ['mid0.3~0.7', 0.3, 0.7], ['high>0.7', 0.7, null]])}`],
    ['btcTrend_breadth', (e) => `${e.btcTrend4h}|${e.breadth == null ? 'null' : bucketOf(e.breadth, [['low<0.35', null, 0.35], ['mid0.35~0.55', 0.35, 0.55], ['high>0.55', 0.55, null]])}`],
  ];
  for (const [name, fn] of combos) {
    const rows = group(events, fn, name, '4h');
    stats.groups[name] = rows;
    printTable(name, rows);
  }

  // 额外输出 1h 和 24h 的头部组合，避免只看 4h。
  for (const [name, fn] of [
    ['quadrant_trend4h_1h', (e) => `${e.quadrant}|${e.trend4h}`],
    ['quadrant_trend4h_24h', (e) => `${e.quadrant}|${e.trend4h}`],
  ]) {
    const hLabel = name.endsWith('_1h') ? '1h' : '24h';
    const rows = group(events, fn, name, hLabel);
    stats.groups[name] = rows;
    printTable(name, rows);
  }

  fs.writeFileSync(path.join(OUT, 'events.json'), JSON.stringify(events));
  fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify(stats, null, 2));
  console.log(`\nevents=${events.length}`);
  console.log(`wrote ${path.join(OUT, 'events.json')}`);
  console.log(`wrote ${path.join(OUT, 'stats.json')}`);
}

if (require.main === module) main();

module.exports = { main, buildTrend, stat, group };
