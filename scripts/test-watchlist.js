'use strict';

const assert = require('assert');
const { createWatchlist, VOLUME_STRATEGY, RR_STRATEGY } = require('../api/src/watchlist');

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 10, 23, 8, 0, 0);

function barsAround({ start, count, base = 1, drift = 0, range = 0.01, vol = 1e6, breakoutAt = null }) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const ts = start + i * 5 * MIN;
    const c = base + drift * i;
    let high = c + range / 2;
    let low = c - range / 2;
    let qv = vol;
    if (breakoutAt != null && i === breakoutAt.idx) {
      high = breakoutAt.high;
      low = breakoutAt.low || c - range / 2;
      qv = vol * breakoutAt.volMultiplier;
    }
    out.push({
      ts,
      open: c,
      close: c,
      high,
      low,
      quoteVol: qv,
      takerBuyQuote: qv * 0.6,
    });
  }
  return out;
}

function rowFor({ symbol = 'ALT', price = 1, oiSeries, bars, funding = 0.01, quoteVol = 5e7, windows = {} }) {
  return {
    symbol,
    pair: `${symbol}USDT`,
    name: symbol,
    category: 'Layer1',
    price,
    change24h: 2,
    high24h: price * 1.08,
    low24h: price * 0.92,
    quoteVolume24h: quoteVol,
    oiUsdt: oiSeries[oiSeries.length - 1].oiUsdt,
    oiHist: { '5m': oiSeries },
    priceHist5m: bars,
    funding,
    windows: {
      '15m': { pricePct: 0.8, oiPct: 4, oiDelta: 2e6, flowEst: 1.2e6, spotEst: 8e5 },
      '1h': { pricePct: 1.2, oiPct: 6, oiDelta: 3e6, flowEst: 2e6, spotEst: 1e6 },
      ...windows,
    },
    source: 'test',
    lastUpdate: NOW,
  };
}

function anomalyAt(ts, { symbol = 'ALT', side = 'up', oiPct = 5.5, oiDeltaAbs = 2.8e6, price = 1 } = {}) {
  return {
    id: 'a-1',
    ts,
    symbol,
    name: symbol,
    category: 'Layer1',
    event: side === 'up' ? 'oi_surge' : 'oi_dump',
    eventLabel: side === 'up' ? 'OI暴增' : 'OI暴跌',
    eventKind: 'oi',
    side,
    window: '5m',
    price,
    pricePct: 0.8,
    oiDeltaAbs: side === 'up' ? oiDeltaAbs : -oiDeltaAbs,
    oiDeltaPct: side === 'up' ? oiPct : -oiPct,
    source: 'test',
  };
}

function testLowPricePrecision() {
  const at = NOW - 40 * MIN;
  const base = 0.0049;
  const bars = barsAround({ start: NOW - 180 * MIN, count: 28, base, drift: 0.000001, range: 0.00002 });
  for (let i = 1; i <= 7; i += 1) {
    bars.push({
      ts: at + i * 5 * MIN,
      open: base,
      close: base + 0.000002 * i,
      high: base + 0.00001,
      low: base - 0.00001,
      quoteVol: 8e5,
      takerBuyQuote: 5e5,
    });
  }
  const oiSeries = [];
  for (let i = 0; i < 48; i += 1) {
    const ts = NOW - 240 * MIN + i * 5 * MIN;
    oiSeries.push({ ts, oiUsdt: ts >= at ? 55.5e6 : 50e6 });
  }
  const row = rowFor({ symbol: 'PEPE', bars, oiSeries, price: base + 0.00001 });
  const engine = createWatchlist({ ttlMs: 6 * 60 * MIN });
  const w = engine.register(anomalyAt(at, { symbol: 'PEPE', price: base }), row, null, NOW);
  assert(w, 'low-price register should create an entry');
  assert(w.plan.long.trigger > w.plan.long.stop, 'low-price long trigger must be above stop');
  assert(w.plan.short.trigger < w.plan.short.stop, 'low-price short trigger must be below stop');
  assert(w.plan.long.risk > 0.000001, `low-price risk collapsed: ${w.plan.long.risk}`);
  assert(w.plan.long.stopPct > 0.2, `low-price stop too tight: ${w.plan.long.stopPct}%`);
  console.log('[lowprice]', `trigger=${w.plan.long.trigger}`, `stop=${w.plan.long.stop}`, `risk%=${w.plan.long.stopPct}`);
}

function testHappyPath() {
  const at = NOW - 40 * MIN;
  // 异动前：缓慢抬升，最后停在 1.021，避免和异动后的箱体重叠
  const bars = barsAround({ start: NOW - 180 * MIN, count: 28, base: 0.99, drift: 0.00115, range: 0.004 });
  // 异动后：横盘收敛箱体 1.00 – 1.006
  for (let i = 1; i <= 7; i += 1) {
    bars.push({
      ts: at + i * 5 * MIN,
      open: 1,
      close: 1.001 + i * 0.0005,
      high: 1.006,
      low: 0.999,
      quoteVol: 8e5,
      takerBuyQuote: 5e5,
    });
  }
  const oiSeries = [];
  for (let i = 0; i < 48; i += 1) {
    const ts = NOW - 240 * MIN + i * 5 * MIN;
    let oi = 50e6;
    if (ts >= at) oi = 55.5e6;
    if (ts >= at + 5 * MIN) oi = 58e6;
    oiSeries.push({ ts, oiUsdt: oi });
  }
  const row = rowFor({ bars, oiSeries, price: 1.001, windows: { '15m': { pricePct: 1.2, oiPct: 6, oiDelta: 3e6, flowEst: 1.2e6, spotEst: 6e5 } } });
  const engine = createWatchlist({ ttlMs: 6 * 60 * MIN });
  const w = engine.register(anomalyAt(at), row, null, NOW);
  assert(w, 'register should create an entry');
  assert.strictEqual(w.stage, 'detected');

  const r1 = engine.updateAll(new Map([['ALT', row]]), null, NOW);
  assert(r1.updated >= 1);
  const e1 = engine.get('ALT');
  assert(['setup', 'armed', 'triggered'].includes(e1.stage), `expected setup-ish, got ${e1.stage}`);
  assert(e1.plan.long.rr === 1.5 && e1.plan.short.rr === 1.5, 'RR must be 1.5 / 2.5');
  assert(e1.plan.long.trigger > e1.metrics.boxHigh, 'long trigger above box high');
  assert(e1.score > 0 && e1.score <= 100, 'score bounded');
  console.log('[happy] after update:', e1.stage, `score=${e1.score}`, `box=${e1.metrics.boxWidthAtr} ATR`);

  // 追加放量突破 K 线，并在同一次更新里触发
  row.price = 1.032;
  row.windows['15m'] = { pricePct: 2.4, oiPct: 6, oiDelta: 3e6, flowEst: 2.2e6, spotEst: 1.1e6 };
  row.priceHist5m = [
    ...row.priceHist5m,
    {
      ts: NOW - 2 * MIN,
      open: 1.004,
      close: 1.032,
      high: 1.034,
      low: 1.003,
      quoteVol: 3.2e6,
      takerBuyQuote: 2.2e6,
    },
  ];
  engine.updateAll(new Map([['ALT', row]]), null, NOW);
  const entry2 = engine.get('ALT');
  assert.strictEqual(entry2.stage, 'triggered', `breakout should trigger, got ${entry2.stage}`);
  assert(entry2.triggered && entry2.triggered.side === 'long', 'should trigger long');
  console.log('[happy] triggered:', entry2.triggered);

  // 触发后跌破止损
  const row2 = { ...row, price: entry2.plan.long.stop - 0.002 };
  row2.priceHist5m = [...row.priceHist5m, {
    ts: NOW + 10 * MIN,
    open: row.price,
    close: row2.price,
    high: row.price,
    low: row2.price,
    quoteVol: 2e6,
    takerBuyQuote: 5e5,
  }];
  engine.updateAll(new Map([['ALT', row2]]), null, NOW + 10 * MIN);
  const e3 = engine.get('ALT');
  assert.strictEqual(e3.stage, 'invalid', `stop should invalidate, got ${e3.stage}`);
  assert(e3.outcome && e3.outcome.status === 'stopped', 'outcome stopped');
  console.log('[happy] stopped ->', e3.stage, e3.outcome.status);
}

function testOiGiveback() {
  const at = NOW - 30 * MIN;
  const bars = barsAround({ start: NOW - 180 * MIN, count: 40, base: 1, range: 0.006 });
  const oiSeries = [];
  for (let i = 0; i < 48; i += 1) {
    const ts = NOW - 240 * MIN + i * 5 * MIN;
    oiSeries.push({ ts, oiUsdt: ts >= at ? 56e6 : 50e6 });
  }
  const row = rowFor({ bars, oiSeries, oiUsdt: 50.4e6, price: 1 });
  row.oiUsdt = 50.4e6; // 几乎全部回吐
  const engine = createWatchlist({ ttlMs: 6 * 60 * MIN });
  engine.register(anomalyAt(at), row, null, NOW);
  engine.updateAll(new Map([['ALT', row]]), null, NOW);
  const e = engine.get('ALT');
  console.log('[giveback]', e.stage, `retention=${e.metrics.oiRetentionPct}%`);
  assert.strictEqual(e.stage, 'invalid');
  assert(e.metrics.oiRetentionPct < 25);
}

function testExpiry() {
  const at = NOW - 30 * MIN;
  const bars = barsAround({ start: NOW - 80 * MIN, count: 16, base: 1, range: 0.004 });
  const oiSeries = [];
  for (let i = 0; i < 32; i += 1) {
    const ts = NOW - 80 * MIN + i * 5 * MIN;
    oiSeries.push({ ts, oiUsdt: ts >= at ? 58e6 : 50e6 });
  }
  const row = rowFor({ bars, oiSeries, price: 1.001 });
  const engine = createWatchlist({ ttlMs: 45 * MIN });
  engine.register(anomalyAt(at), row, null, NOW);
  engine.updateAll(new Map([['ALT', row]]), null, NOW + 20 * MIN);
  const e = engine.get('ALT');
  console.log('[expiry]', e.stage, e.timeLeftSec);
  assert(e.stage === 'expired' || e.timeLeftSec === 0, `expected expired, got ${e.stage}`);
}

function testPersistence() {
  const at = NOW - 10 * MIN;
  const bars = barsAround({ start: NOW - 60 * MIN, count: 12, base: 1, range: 0.004 });
  const oiSeries = [];
  for (let i = 0; i < 24; i += 1) {
    const ts = NOW - 60 * MIN + i * 5 * MIN;
    oiSeries.push({ ts, oiUsdt: ts >= at ? 58e6 : 50e6 });
  }
  const row = rowFor({ bars, oiSeries, price: 1.001 });
  const a = createWatchlist();
  // 持久化测试必须用真实当前时间；用固定 NOW 会在跨天后被 TTL 过滤，属于测试时间漂移。
  const liveNow = Date.now();
  a.register(anomalyAt(liveNow - 10 * MIN), row, null, liveNow);
  const dump = a.dump();
  const b = createWatchlist();
  const restored = b.restore(dump);
  assert.strictEqual(restored.restored, 1);
  const e = b.get('ALT');
  assert(e && e.symbol === 'ALT');
  console.log('[persistence] restored', restored.restored, e.stage);
}

function testOptimizedProfile() {
  const at = NOW - 40 * MIN;
  const bars = barsAround({ start: NOW - 180 * MIN, count: 28, base: 0.99, drift: 0.00115, range: 0.004 });
  for (let i = 1; i <= 7; i += 1) {
    bars.push({
      ts: at + i * 5 * MIN,
      open: 1,
      close: 1.001 + i * 0.0005,
      high: 1.006,
      low: 0.999,
      quoteVol: 8e5,
      takerBuyQuote: 5e5,
    });
  }
  const oiSeries = [];
  for (let i = 0; i < 48; i += 1) {
    const ts = NOW - 240 * MIN + i * 5 * MIN;
    let oi = 50e6;
    if (ts >= at) oi = 55.5e6;
    if (ts >= at + 5 * MIN) oi = 58e6;
    oiSeries.push({ ts, oiUsdt: oi });
  }
  const row = rowFor({ bars, oiSeries, price: 1.001, windows: { '15m': { pricePct: 1.2, oiPct: 6, oiDelta: 3e6, flowEst: 1.2e6, spotEst: 6e5 } } });
  const engine = createWatchlist({
    ttlMs: 6 * 60 * MIN,
    strategy: { stopAtr: 0.45, maxChaseAtr: 0.5, rr1: 2.0, rr2: 3.0, triggerMinScore: 62, setupMinBoxAtr: 0.6 },
  });
  const w = engine.register(anomalyAt(at), row, null, NOW);
  assert(w.plan.long.rr === 2 && w.plan.short.rr2 === 3, 'optimized profile RR should be 2 / 3');
  engine.updateAll(new Map([['ALT', row]]), null, NOW);

  // 收盘价已离触发位约 3.5 ATR：优化档应该拒绝追高
  row.price = 1.032;
  row.priceHist5m = [
    ...row.priceHist5m,
    { ts: NOW - 2 * MIN, open: 1.004, close: 1.032, high: 1.034, low: 1.003, quoteVol: 3.2e6, takerBuyQuote: 2.2e6 },
  ];
  engine.updateAll(new Map([['ALT', row]]), null, NOW);
  const chase = engine.get('ALT');
  assert(chase.triggered == null, `chase should be blocked, got ${chase.stage}`);
  console.log('[optimized] chase blocked, stage=', chase.stage, 'score=', chase.score);

  // 回落到触发位上方约 0.1 ATR，且收盘确认突破，才允许触发
  row.price = 1.008;
  row.priceHist5m = [
    ...row.priceHist5m,
    { ts: NOW - 1 * MIN, open: 1.004, close: 1.008, high: 1.012, low: 1.003, quoteVol: 3.2e6, takerBuyQuote: 2.2e6 },
  ];
  engine.updateAll(new Map([['ALT', row]]), null, NOW);
  const ok = engine.get('ALT');
  console.log('[optimized] near check:', ok.stage, {
    price: ok.metrics.price,
    trigger: ok.plan.long.trigger,
    lastHigh: ok.metrics.lastBarHigh,
    atr: ok.metrics.atr,
    vol: ok.metrics.volumeRatio,
    ret: ok.metrics.oiRetentionPct,
    score: ok.score,
    valid: ok.plan.long.valid,
  });
  assert(ok.triggered && ok.triggered.side === 'long', `near trigger should fire, got ${ok.stage}`);
  assert.ok(ok.plan.long.rr === 2.0, 'triggered plan keeps optimized RR');
  console.log('[optimized] near trigger fired:', ok.triggered.side, 'score=', ok.score);
}

function testVolumeProfile() {
  const at = NOW - 40 * MIN;
  const bars = barsAround({ start: NOW - 180 * MIN, count: 28, base: 0.99, drift: 0.00115, range: 0.004 });
  for (let i = 1; i <= 7; i += 1) {
    bars.push({
      ts: at + i * 5 * MIN,
      open: 1,
      close: 1.001 + i * 0.0005,
      high: 1.006,
      low: 0.999,
      quoteVol: 8e5,
      takerBuyQuote: 5e5,
    });
  }
  const oiSeries = [];
  for (let i = 0; i < 48; i += 1) {
    const ts = NOW - 240 * MIN + i * 5 * MIN;
    let oi = 50e6;
    if (ts >= at) oi = 55.5e6;
    if (ts >= at + 5 * MIN) oi = 58e6;
    oiSeries.push({ ts, oiUsdt: oi });
  }
  const row = rowFor({ bars, oiSeries, price: 1.001, windows: { '15m': { pricePct: 1.2, oiPct: 6, oiDelta: 3e6, flowEst: 1.2e6, spotEst: 6e5 } } });
  const engine = createWatchlist({
    ttlMs: 6 * 60 * MIN,
    strategy: { ...VOLUME_STRATEGY, setupMinBoxAtr: 0.6 },
  });
  const w = engine.register(anomalyAt(at), row, null, NOW);
  assert(w.plan.long.rr === 2 && w.plan.short.rr2 === 3, 'volume profile keeps optimized RR');
  engine.updateAll(new Map([['ALT', row]]), null, NOW);

  // 无量突破：触发 bar 量比 <0.9，不应触发
  row.price = 1.032;
  row.priceHist5m = [
    ...row.priceHist5m,
    { ts: NOW - 3 * MIN, open: 1.004, close: 1.032, high: 1.034, low: 1.003, quoteVol: 4e5, takerBuyQuote: 2.2e5 },
  ];
  engine.updateAll(new Map([['ALT', row]]), null, NOW);
  const lowVol = engine.get('ALT');
  assert(lowVol.triggered == null, `low volume should not trigger, got ${lowVol.stage}`);
  assert(lowVol.morphology.barVolumeRatio < 0.9, 'low volume ratio should be recorded');

  // 情绪高潮：触发 bar 量比 >1.5，也不应触发
  row.price = 1.010;
  row.priceHist5m = [
    ...row.priceHist5m,
    { ts: NOW - 2 * MIN, open: 1.004, close: 1.010, high: 1.012, low: 1.003, quoteVol: 3.2e6, takerBuyQuote: 2.2e6 },
  ];
  engine.updateAll(new Map([['ALT', row]]), null, NOW);
  const extreme = engine.get('ALT');
  assert(extreme.triggered == null, `extreme volume should not trigger, got ${extreme.stage}`);
  assert(extreme.morphology.barVolumeRatio > 1.5, 'extreme volume ratio should be recorded');

  // 温和放量：0.9–1.5x，应该触发
  row.priceHist5m = [
    ...row.priceHist5m,
    { ts: NOW - 1 * MIN, open: 1.004, close: 1.010, high: 1.012, low: 1.003, quoteVol: 1.1e6, takerBuyQuote: 7e5 },
  ];
  engine.updateAll(new Map([['ALT', row]]), null, NOW);
  const ok = engine.get('ALT');
  assert(ok.triggered && ok.triggered.side === 'long', `moderate volume should trigger, got ${ok.stage}`);
  const barVol = ok.triggered.morphology.barVolumeRatio;
  assert(barVol >= 0.9 && barVol <= 1.5, `trigger bar volume out of band: ${barVol}`);
  console.log('[volume] low blocked', lowVol.morphology.barVolumeRatio,
    'extreme blocked', extreme.morphology.barVolumeRatio,
    'triggered', barVol, 'stage=', ok.stage);
}

function testRRProfile() {
  assert.strictEqual(RR_STRATEGY.stopAtr, 0.55, 'rr profile should use 0.55 ATR stop');
  assert.strictEqual(RR_STRATEGY.rr1, 2.0, 'rr profile keeps T1 at 2R');
  assert.strictEqual(RR_STRATEGY.rr2, 3.0, 'rr profile keeps T2 at 3R');
  assert.strictEqual(RR_STRATEGY.triggerMinBarVolumeRatio, 0.9, 'rr profile keeps volume lower bound');
  assert.strictEqual(RR_STRATEGY.triggerMaxBarVolumeRatio, 1.5, 'rr profile keeps volume upper bound');
  console.log('[rr] profile config ok: stop=0.55 ATR, RR=2/3, volume=0.9-1.5x');
}

testLowPricePrecision();
testHappyPath();
testOptimizedProfile();
testVolumeProfile();
testRRProfile();
testOiGiveback();
testExpiry();
testPersistence();
console.log('watchlist engine tests passed');
