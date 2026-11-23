'use strict';

const assert = require('assert');
const { createWatchlist } = require('../api/src/watchlist');

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
  const w = a.register(anomalyAt(at), row, null, NOW);
  const dump = a.dump();
  const b = createWatchlist();
  const restored = b.restore(dump);
  assert.strictEqual(restored.restored, 1);
  const e = b.get('ALT');
  assert(e && e.symbol === 'ALT');
  console.log('[persistence] restored', restored.restored, e.stage);
}

testHappyPath();
testOiGiveback();
testExpiry();
testPersistence();
console.log('watchlist engine tests passed');
