'use strict';

/*
 * 真实历史回放：用项目现有 watchlist 引擎，逐根 5m K 线重放。
 *
 * 数据：Binance USD-M 永续官方日归档（5m K 线 + 5m OI metrics）
 * 口径：信号 bar 收盘后决策，下一根 bar 开始计算止损/目标，避免未来函数。
 * 费用：开平各 0.04% taker + 各 0.02% 滑点，合计 0.12% 往返。
 */

const fs = require('fs');
const path = require('path');
const { createWatchlist, STAGE_DEFS } = require('../../api/src/watchlist');

const MIN = 60 * 1000;
const TTL = 6 * 60 * MIN;
const HOLD_BARS = 288; // 24h
const FEE_ROUND_TRIP = 0.0012; // 0.12%
const EVAL_START = Date.UTC(2026, 9, 24, 0, 0, 0); // 2026-10-24
const EVAL_END = Date.UTC(2026, 10, 23, 0, 0, 0); // 2026-11-23 exclusive
const CACHE = path.join(__dirname, '..', '..', 'backtest-cache');
const OUT = path.join(__dirname, '..', '..', 'backtest-results');

function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return text.split(/\r?\n/).filter(Boolean);
}

function parseKlines(file) {
  const lines = readCsv(file);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const c = lines[i].split(',');
    if (c.length < 12) continue;
    const ts = Number(c[0]);
    const open = Number(c[1]);
    const high = Number(c[2]);
    const low = Number(c[3]);
    const close = Number(c[4]);
    if (!(ts > 0) || !(open > 0) || !(high > 0) || !(low > 0) || !(close > 0)) continue;
    rows.push({
      ts,
      open,
      high,
      low,
      close,
      volume: Number(c[5]) || 0,
      quoteVol: Number(c[7]) || 0,
      takerBuyQuote: Number(c[10]) || 0,
    });
  }
  rows.sort((a, b) => a.ts - b.ts);
  const out = [];
  for (const r of rows) {
    if (out.length && out[out.length - 1].ts === r.ts) out[out.length - 1] = r;
    else out.push(r);
  }
  return out;
}

function parseMetrics(file) {
  const lines = readCsv(file);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const c = lines[i].split(',');
    if (c.length < 4) continue;
    const ts = Date.parse(`${c[0].replace(' ', 'T')}Z`);
    const oiUsdt = Number(c[3]);
    if (!(ts > 0) || !(oiUsdt > 0)) continue;
    rows.push({ ts, oiUsdt });
  }
  rows.sort((a, b) => a.ts - b.ts);
  const out = [];
  for (const r of rows) {
    if (out.length && out[out.length - 1].ts === r.ts) out[out.length - 1] = r;
    else out.push(r);
  }
  return out;
}

function qualifiesOiAnomaly(absPct, absDelta) {
  if (!(absDelta > 0) || !Number.isFinite(absPct)) return false;
  if (absPct < 0.5) return false;
  if (absPct < 1.2 && absDelta < 3e6) return false;
  if (absPct >= 2.0 && absDelta >= 3e5) return true;
  if (absDelta >= 2e6 && absPct >= 0.8) return true;
  if (absPct >= 4.0 && absDelta >= 2e5) return true;
  return false;
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

function window15(bars, i) {
  if (i < 3 || !(bars[i - 3].close > 0)) return { pricePct: 0 };
  return { pricePct: ((bars[i].close - bars[i - 3].close) / bars[i - 3].close) * 100 };
}

function buildRow(symbol, bars, oi, i, oiIdx, quotePrefix) {
  const bar = bars[i];
  const knownBars = bars.slice(Math.max(0, i - 199), i + 1);
  const knownOi = oi.slice(Math.max(0, oiIdx - 99), oiIdx + 1);
  const w15 = window15(bars, i);
  const oiNow = oi[oiIdx] ? oi[oiIdx].oiUsdt : 0;
  const oi3 = oi[oiIdx - 3] ? oi[oiIdx - 3].oiUsdt : oiNow;
  const oi15Pct = oi3 > 0 ? ((oiNow - oi3) / oi3) * 100 : 0;
  const close24 = bars[i - 288] ? bars[i - 288].close : bars[0].close;
  return {
    symbol,
    name: symbol.replace('USDT', ''),
    pair: symbol,
    category: '永续',
    source: 'binance-vision',
    price: bar.close,
    change24h: close24 > 0 ? ((bar.close - close24) / close24) * 100 : 0,
    quoteVolume24h: rollingSum(quotePrefix, i, 288),
    funding: 0,
    priceHist5m: knownBars,
    oiHist: { '5m': knownOi },
    oiUsdt: oiNow,
    windows: {
      '15m': {
        pricePct: w15.pricePct,
        oiPct: oi15Pct,
        oiDelta: oiNow - oi3,
      },
    },
  };
}

function buildBtcRow(btcBar) {
  if (!btcBar) return null;
  return {
    symbol: 'BTCUSDT',
    name: 'BTC',
    category: '主流',
    price: btcBar.close,
    windows: { '15m': { pricePct: btcBar.pricePct || 0 } },
  };
}

function wilson(wins, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function aggregate(trades, label = '') {
  const resolved = trades.filter((t) => t.t1Win || t.t1Loss);
  const t1Wins = trades.filter((t) => t.t1Win).length;
  const t1Losses = trades.filter((t) => t.t1Loss).length;
  const target2 = trades.filter((t) => t.outcome === 'target2').length;
  const t1ThenStop = trades.filter((t) => t.outcome === 't1_then_stop').length;
  const timeouts = trades.filter((t) => t.outcome === 'timeout').length;
  const netRs = trades.map((t) => t.netR).filter((x) => Number.isFinite(x));
  const ci = wilson(t1Wins, resolved.length);
  return {
    label,
    trades: trades.length,
    resolved: resolved.length,
    t1Wins,
    t1Losses,
    target2,
    t1ThenStop,
    timeouts,
    winRateT1: resolved.length ? t1Wins / resolved.length : 0,
    winRateT1Ci95: ci,
    winRateT2: resolved.length ? target2 / resolved.length : 0,
    stopRate: resolved.length ? t1Losses / resolved.length : 0,
    timeoutRate: trades.length ? timeouts / trades.length : 0,
    avgNetR: netRs.length ? netRs.reduce((a, b) => a + b, 0) / netRs.length : 0,
    medianNetR: median(netRs),
  };
}

function evaluateTrade(t, bars, barByTs) {
  const side = t.side;
  const i = barByTs.get(t.triggerBarTs);
  if (i == null) {
    return { ...t, outcome: 'no_data', t1Win: false, t1Loss: false, netR: 0, exitPrice: 0, exitTs: 0 };
  }
  const entry = t.entryPrice;
  const risk = Math.abs(entry - t.stop);
  let t1 = false;
  let t2 = false;
  let stop = false;
  let exitPrice = 0;
  let exitTs = 0;
  let firstT1At = 0;
  const end = Math.min(bars.length - 1, i + HOLD_BARS);
  for (let j = i + 1; j <= end; j += 1) {
    const b = bars[j];
    if (side === 'long') {
      if (b.low <= t.stop) { stop = true; exitPrice = t.stop; exitTs = b.ts; break; }
      if (b.high >= t.target2) { t2 = true; exitPrice = t.target2; exitTs = b.ts; break; }
      if (!t1 && b.high >= t.target1) { t1 = true; firstT1At = b.ts; }
    } else {
      if (b.high >= t.stop) { stop = true; exitPrice = t.stop; exitTs = b.ts; break; }
      if (b.low <= t.target2) { t2 = true; exitPrice = t.target2; exitTs = b.ts; break; }
      if (!t1 && b.low <= t.target1) { t1 = true; firstT1At = b.ts; }
    }
  }
  if (!exitPrice) {
    const last = bars[end];
    exitPrice = last.close;
    exitTs = last.ts;
  }

  let outcome;
  if (t2) outcome = 'target2';
  else if (stop && t1) outcome = 't1_then_stop';
  else if (stop) outcome = 'stopped';
  else if (t1) outcome = 't1_hold';
  else outcome = 'timeout';

  // T1 策略按第一目标全平；t1_then_stop 对 T1 策略仍算赢，但单列提示。
  if (t2 || t1) exitPrice = side === 'long' ? t.target1 : t.target1;
  const grossR = risk > 0 ? (side === 'long' ? (exitPrice - entry) / risk : (entry - exitPrice) / risk) : 0;
  const costR = risk > 0 ? (entry * FEE_ROUND_TRIP) / risk : 0;
  const netR = grossR - costR;

  return {
    ...t,
    triggerAtIso: new Date(t.at).toISOString(),
    firstT1At: firstT1At ? new Date(firstT1At).toISOString() : null,
    exitAtIso: exitTs ? new Date(exitTs).toISOString() : null,
    outcome,
    t1Hit: t1 || t2,
    t2Hit: t2,
    t1Win: t1 || t2,
    t1Loss: stop && !t1 && !t2,
    grossR,
    netR,
    riskPct: entry > 0 ? (risk / entry) * 100 : 0,
  };
}

function loadSymbol(symbol) {
  const dir = path.join(CACHE, symbol);
  const klines = parseKlines(path.join(dir, 'klines.csv'));
  const metrics = fs.existsSync(path.join(dir, 'metrics.csv')) ? parseMetrics(path.join(dir, 'metrics.csv')) : [];
  return { symbol, bars: klines, oi: metrics };
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(CACHE, 'manifest.json'), 'utf8'));
  const symbols = manifest.symbols;
  const btc = loadSymbol('BTCUSDT');
  const btcByTs = new Map();
  const btcQuotePrefix = prefixSums(btc.bars, 'quoteVol');
  for (let i = 0; i < btc.bars.length; i += 1) {
    btcByTs.set(btc.bars[i].ts, buildRow('BTCUSDT', btc.bars, [], i, 0, btcQuotePrefix));
  }

  const allEntries = [];
  const allTrades = [];
  const allSignals = [];
  const perSymbol = [];

  for (const symbol of symbols) {
    const s = loadSymbol(symbol);
    if (!s.bars.length || !s.oi.length) continue;
    const quotePrefix = prefixSums(s.bars, 'quoteVol');
    const barByTs = new Map(s.bars.map((b, i) => [b.ts, i]));
    const watch = createWatchlist({ ttlMs: TTL, maxEntries: 80 });
    const entryMeta = new Map();
    const tradeMeta = new Map();
    let signals = 0;
    let oiCursor = -1;

    for (let i = 0; i < s.bars.length; i += 1) {
      const bar = s.bars[i];
      const t = bar.ts + 5 * MIN;
      if (t < EVAL_START) continue;
      if (t >= EVAL_END) break;
      while (oiCursor + 1 < s.oi.length && s.oi[oiCursor + 1].ts <= t) oiCursor += 1;
      if (oiCursor < 1) continue;
      const oiNow = s.oi[oiCursor];
      const oiPrev = s.oi[oiCursor - 1];
      const hasNewOi = oiNow.ts === t;

      const row = buildRow(symbol, s.bars, s.oi, i, oiCursor, quotePrefix);
      const btcRow = buildBtcRow(btcByTs.get(bar.ts));

      const delta = oiNow.oiUsdt - oiPrev.oiUsdt;
      const absDelta = Math.abs(delta);
      const pct = oiPrev.oiUsdt > 0 ? (delta / oiPrev.oiUsdt) * 100 : 0;
      const absPct = Math.abs(pct);
      let anomaly = null;
      if (hasNewOi
        && oiNow.ts - oiPrev.ts <= 10 * MIN
        && qualifiesOiAnomaly(absPct, absDelta)
        && absPct <= 25
        && !(absPct > 18 && oiNow.oiUsdt < 5e8)
        && !(absDelta > oiNow.oiUsdt * 0.35 && absPct > 15)) {
        const side = delta > 0 ? 'up' : 'down';
        anomaly = {
          id: `bt-${symbol}-${t}`,
          ts: t,
          symbol,
          name: row.name,
          category: '永续',
          event: side === 'up' ? 'oi_surge' : 'oi_dump',
          eventLabel: side === 'up' ? 'OI 急增' : 'OI 急减',
          eventKind: 'oi',
          side,
          window: '5m',
          price: bar.close,
          pricePct: row.windows['15m'].pricePct,
          oiDeltaAbs: Math.round(delta),
          oiDeltaPct: Number(pct.toFixed(2)),
          source: 'binance-vision',
        };
        const ret = watch.register(anomaly, row, btcRow, t);
        if (ret) {
          signals += 1;
          allSignals.push({ symbol, ts: t, side, pct: anomaly.oiDeltaPct, absDelta });
        }
        if (ret && !entryMeta.has(ret.id)) {
          entryMeta.set(ret.id, {
            id: ret.id,
            symbol,
            maxStage: STAGE_DEFS[ret.stage].rank,
            createdAt: ret.createdAt,
            score: ret.score,
            grade: ret.grade,
          });
        }
      }

      watch.updateAll(new Map([[symbol, row]]), btcRow, t);
      const snaps = watch.list({ stage: 'all', limit: 100 });
      for (const e of snaps) {
        let meta = entryMeta.get(e.id);
        if (!meta) {
          meta = { id: e.id, symbol, maxStage: 0, createdAt: e.createdAt, score: e.score, grade: e.grade };
          entryMeta.set(e.id, meta);
        }
        const rank = STAGE_DEFS[e.stage] ? STAGE_DEFS[e.stage].rank : 0;
        if (rank <= 4 && rank > meta.maxStage) meta.maxStage = rank;
        if (e.triggered && !tradeMeta.has(e.id)) {
          tradeMeta.set(e.id, {
            id: e.id,
            symbol,
            side: e.triggered.side,
            at: e.triggered.at,
            triggerBarTs: e.triggered.at - 5 * MIN,
            entryPrice: e.triggered.price,
            trigger: e.triggered.trigger,
            stop: e.triggered.stop,
            target1: e.triggered.target1,
            target2: e.triggered.target2,
            volumeRatio: e.triggered.volumeRatio,
            score: e.score,
            grade: e.grade,
            bias: e.bias,
            oiRetentionPct: e.metrics.oiRetentionPct,
            boxWidthAtr: e.metrics.boxWidthAtr,
            atr: e.metrics.atr,
            planStopPct: e.plan ? e.plan[e.triggered.side].stopPct : 0,
          });
        }
      }
    }

    const entries = [...entryMeta.values()];
    allEntries.push(...entries);
    for (const t of tradeMeta.values()) {
      const ev = evaluateTrade(t, s.bars, barByTs);
      allTrades.push(ev);
    }
    const symTrades = allTrades.filter((t) => t.symbol === symbol);
    perSymbol.push({
      symbol,
      bars: s.bars.length,
      oiPoints: s.oi.length,
      signals,
      entries: entries.length,
      setup: entries.filter((e) => e.maxStage >= 2).length,
      armed: entries.filter((e) => e.maxStage >= 3).length,
      triggered: symTrades.length,
      ...aggregate(symTrades, symbol),
    });
    process.stdout.write(`[${symbol}] signals=${signals} entries=${entries.length} trades=${symTrades.length}\n`);
  }

  const overall = aggregate(allTrades, 'all');
  const byGrade = ['A', 'B', 'C'].map((g) => aggregate(allTrades.filter((t) => t.grade === g), g));
  const bySide = ['long', 'short'].map((s) => aggregate(allTrades.filter((t) => t.side === s), s));
  const summary = {
    meta: {
      period: '2026-10-24 ~ 2026-11-22 UTC',
      evalDays: 30,
      symbols,
      dataSource: 'Binance USD-M futures daily archive (5m klines + 5m metrics)',
      funding: '归档不含资金费率，回放中按 0 处理；|funding|<0.12% 门槛实际未过滤',
      execution: '信号 5m bar 收盘决策，下一根 bar 开始检查止损/目标；止损与目标同 bar 时止损优先',
      costs: 'taker 0.04% + 滑点 0.02% 每边，往返 0.12%',
      hold: '触发后最多 24h',
      winDefinition: 'T1 在止损前触及；T2 单列；timeout 不计入胜率分母',
    },
    funnel: {
      signals: allSignals.length,
      entries: allEntries.length,
      setup: allEntries.filter((e) => e.maxStage >= 2).length,
      armed: allEntries.filter((e) => e.maxStage >= 3).length,
      triggered: allTrades.length,
    },
    overall,
    byGrade,
    bySide,
    bySymbol: perSymbol,
  };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, 'trades.json'), JSON.stringify(allTrades, null, 2));
  fs.writeFileSync(path.join(OUT, 'signals.json'), JSON.stringify(allSignals, null, 2));
  console.log(JSON.stringify({
    funnel: summary.funnel,
    overall: {
      trades: overall.trades,
      resolved: overall.resolved,
      t1Wins: overall.t1Wins,
      t1Losses: overall.t1Losses,
      target2: overall.target2,
      t1ThenStop: overall.t1ThenStop,
      timeouts: overall.timeouts,
      winRateT1: overall.winRateT1,
      winRateT1Ci95: overall.winRateT1Ci95,
      winRateT2: overall.winRateT2,
      avgNetR: overall.avgNetR,
      medianNetR: overall.medianNetR,
    },
    byGrade,
    bySide,
  }, null, 2));
}

main();
