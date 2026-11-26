'use strict';

/*
 * 事件级策略模拟：不经过箱体/观察池状态机，直接从 OI 异动事件入场。
 *
 * 目的：验证“事件方向 + 币种规模/板块 + 4h/1h 趋势 + 量能/位置”里哪些组合
 * 在扣费后仍然有正期望，并且能在三个 30 天窗口里站住。
 *
 * 执行口径：
 * - 信号 bar 收盘后，下一根 5m bar 开盘入场；
 * - 同一币种不重叠持仓；
 * - 止损/目标都按入场时 ATR 固定；同一根 bar 止损优先；
 * - 往返成本 0.12%；
 * - 最多持有 holdBars 根 5m bar。
 */

const fs = require('fs');
const path = require('path');
const { loadSymbol } = require('./replay');
const { WINDOWS, PERIODS } = require('./config');

const MIN = 60 * 1000;
const COST = 0.0012;
const OUT = path.join(__dirname, '..', '..', 'backtest-results', 'event-study');
const EVENTS = path.join(OUT, 'events.json');

function round(n, p = 4) {
  const m = 10 ** p;
  return Math.round((Number(n) || 0) * m) / m;
}

function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pct(v) {
  return `${round(v, 3)}%`;
}

function summarize(trades, label) {
  const n = trades.length;
  const wins = trades.filter((t) => t.netR > 0).length;
  const totalR = trades.reduce((a, t) => a + t.netR, 0);
  const avgR = n ? totalR / n : 0;
  const totalU = trades.reduce((a, t) => a + t.pnlU, 0);
  const avgRisk = n ? mean(trades.map((t) => t.riskPct)) : 0;
  const avgNotional = n ? mean(trades.map((t) => t.netR * t.riskPct)) : 0;
  const winRs = trades.filter((t) => t.netR > 0).map((t) => t.netR);
  const lossRs = trades.filter((t) => t.netR <= 0).map((t) => t.netR);
  const grossWin = winRs.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(lossRs.reduce((a, b) => a + b, 0));
  const meanR = n ? trades.reduce((a, t) => a + t.netR, 0) / n : 0;
  const stdR = n > 1 ? Math.sqrt(trades.reduce((a, t) => a + (t.netR - meanR) ** 2, 0) / (n - 1)) : 0;
  const tStat = stdR > 0 ? meanR / (stdR / Math.sqrt(n)) : 0;
  let cum = 0;
  let peak = 0;
  let maxDdR = 0;
  let cumU = 0;
  let peakU = 0;
  let maxDdU = 0;
  const sorted = [...trades].sort((a, b) => a.exitTs - b.exitTs);
  for (const t of sorted) {
    cum += t.netR;
    peak = Math.max(peak, cum);
    maxDdR = Math.min(maxDdR, cum - peak);
    cumU += t.pnlU;
    peakU = Math.max(peakU, cumU);
    maxDdU = Math.min(maxDdU, cumU - peakU);
  }
  return {
    label,
    trades: n,
    wins,
    winRate: n ? round(wins / n, 4) : 0,
    stopRate: n ? round(trades.filter((t) => t.outcome === 'stop').length / n, 4) : 0,
    targetRate: n ? round(trades.filter((t) => t.outcome === 'target').length / n, 4) : 0,
    avgBarsHeld: n ? round(mean(trades.map((t) => t.barsHeld)), 1) : 0,
    medianBarsHeld: n ? round(median(trades.map((t) => t.barsHeld)), 0) : 0,
    firstBarRate: n ? round(trades.filter((t) => t.barsHeld === 1).length / n, 3) : 0,
    avgR: round(avgR, 4),
    totalR: round(totalR, 2),
    medianR: round(median(trades.map((t) => t.netR)), 3),
    avgRiskPct: round(avgRisk, 3),
    avgNotionalPct: round(avgNotional, 3),
    avgWinR: round(winRs.length ? grossWin / winRs.length : 0, 3),
    avgLossR: round(lossRs.length ? lossRs.reduce((a, b) => a + b, 0) / lossRs.length : 0, 3),
    profitFactor: round(grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0), 3),
    stdR: round(stdR, 3),
    tStat: round(tStat, 2),
    totalU: round(totalU, 3),
    avgU: round(n ? totalU / n : 0, 4),
    maxDdR: round(maxDdR, 2),
    maxDdU: round(maxDdU, 3),
  };
}

function windowTrades(trades, w) {
  return trades.filter((t) => t.ts >= w.start && t.ts < w.end);
}

function evaluateTrade({ ev, bars, i, side, stopAtr, rr, holdBars, cost = COST, entryDelayBars = 0, entrySlippagePct = 0 }) {
  const entryIdx = i + 1 + entryDelayBars;
  if (entryIdx >= bars.length) return null;
  const open = bars[entryIdx].open;
  if (!(open > 0)) return null;
  const entry = side === 'long' ? open * (1 + entrySlippagePct) : open * (1 - entrySlippagePct);
  const risk = stopAtr * ev.atr;
  if (!(entry > 0) || !(risk > 0)) return null;
  const stop = side === 'long' ? entry - risk : entry + risk;
  const target = side === 'long' ? entry + rr * risk : entry - rr * risk;
  let exit = 0;
  let exitTs = 0;
  let exitIdx = 0;
  let outcome = 'timeout';
  const lastIdx = Math.min(bars.length - 1, entryIdx + holdBars - 1);
  for (let j = entryIdx; j <= lastIdx; j += 1) {
    const b = bars[j];
    if (side === 'long') {
      if (b.low <= stop) {
        exit = stop;
        exitTs = b.ts;
        exitIdx = j;
        outcome = 'stop';
        break;
      }
      if (b.high >= target) {
        exit = target;
        exitTs = b.ts;
        exitIdx = j;
        outcome = 'target';
        break;
      }
    } else {
      if (b.high >= stop) {
        exit = stop;
        exitTs = b.ts;
        exitIdx = j;
        outcome = 'stop';
        break;
      }
      if (b.low <= target) {
        exit = target;
        exitTs = b.ts;
        exitIdx = j;
        outcome = 'target';
        break;
      }
    }
  }
  if (!exit) {
    exit = bars[lastIdx].close;
    exitTs = bars[lastIdx].ts;
    exitIdx = lastIdx;
  }
  const grossR = side === 'long' ? (exit - entry) / risk : (entry - exit) / risk;
  const costR = (entry * cost) / risk;
  const netR = grossR - costR;
  const riskPct = (risk / entry) * 100;
  // 过滤极小/极大止损距离：极小止损会被手续费和噪声放大，极大止损不适合山寨。
  if (!(riskPct >= 0.2 && riskPct <= 3.0)) return null;
  return {
    ts: ev.ts,
    entryTs: bars[entryIdx].ts,
    exitTs,
    symbol: ev.symbol,
    sector: ev.sector,
    tier: ev.tier,
    trend4h: ev.trend4h,
    side,
    entry,
    stop,
    target,
    risk,
    riskPct,
    barsHeld: exitIdx - entryIdx + 1,
    netR,
    outcome,
    pnlU: netR * (riskPct / 100) * 20,
  };
}

const STRATEGIES = [
  { tag: 'A_oi_up_long', side: 'long', filter: (e) => e.oiSide === 'up' },
  { tag: 'B_oi_down_short', side: 'short', filter: (e) => e.oiSide === 'down' },
  { tag: 'C_up_mixed_long', side: 'long', filter: (e) => (e.quadrant === 'up_up' || e.quadrant === 'up_flat') && e.trend4h === 'mixed' },
  { tag: 'D_up_down_up_long', side: 'long', filter: (e) => e.quadrant === 'up_down' && e.trend4h === 'up' },
  { tag: 'E_down_up_up_short', side: 'short', filter: (e) => e.quadrant === 'down_up' && e.trend4h === 'up' },
  { tag: 'F_down_down_up_short', side: 'short', filter: (e) => e.quadrant === 'down_down' && e.trend4h === 'up' },
  { tag: 'G_t1_meme_short', side: 'short', filter: (e) => e.tier === 'T1' && e.sector === 'meme' },
  { tag: 'H_t2_l2_long', side: 'long', filter: (e) => e.tier === 'T2' && e.sector === 'l2' },
  { tag: 'I_vol2_lowrange_short', side: 'short', filter: (e) => e.volRatio >= 2 && e.rangePos48 < 0.3 },
  { tag: 'J_oi5_long', side: 'long', filter: (e) => Math.abs(e.oiPct) >= 5 },
  { tag: 'K_t3_mixed_long', side: 'long', filter: (e) => e.tier === 'T3' && e.trend4h === 'mixed' },
  { tag: 'L_t1_meme_defi_short', side: 'short', filter: (e) => e.tier === 'T1' && (e.sector === 'meme' || e.sector === 'defi') },
  { tag: 'M_l2_long', side: 'long', filter: (e) => e.sector === 'l2' },
  { tag: 'N_meme_short', side: 'short', filter: (e) => e.sector === 'meme' },
  { tag: 'O_up_down_mixed_long', side: 'long', filter: (e) => e.quadrant === 'up_down' && e.trend4h === 'mixed' },
  { tag: 'P_down_all_up_short', side: 'short', filter: (e) => e.oiSide === 'down' && e.trend4h === 'up' },
  { tag: 'Q_up_all_mixed_long', side: 'long', filter: (e) => e.oiSide === 'up' && e.trend4h === 'mixed' && e.tier !== 'T1' },
  { tag: 'R_t1_up_short', side: 'short', filter: (e) => e.tier === 'T1' && e.trend4h === 'up' },
  { tag: 'S_down_down_mixed_short', side: 'short', filter: (e) => e.quadrant === 'down_down' && e.trend4h === 'mixed' },
  { tag: 'T_l2_mixed_long', side: 'long', filter: (e) => e.sector === 'l2' && e.trend4h === 'mixed' },
  { tag: 'A2_oi_up_long_t2t3', side: 'long', filter: (e) => e.oiSide === 'up' && (e.tier === 'T2' || e.tier === 'T3') },
  { tag: 'A3_oi_up_long_t2t3_mixed', side: 'long', filter: (e) => e.oiSide === 'up' && (e.tier === 'T2' || e.tier === 'T3') && e.trend4h === 'mixed' },
  { tag: 'A4_oi_up_long_t2t3_not_btcup', side: 'long', filter: (e) => e.oiSide === 'up' && (e.tier === 'T2' || e.tier === 'T3') && e.btcTrend4h !== 'up' },
  { tag: 'B2_oi_down_short_t2t3', side: 'short', filter: (e) => e.oiSide === 'down' && (e.tier === 'T2' || e.tier === 'T3') },
  { tag: 'B3_oi_down_short_t2t3_mixed', side: 'short', filter: (e) => e.oiSide === 'down' && (e.tier === 'T2' || e.tier === 'T3') && e.trend4h === 'mixed' },
  { tag: 'B4_oi_down_short_all_trendup', side: 'short', filter: (e) => e.oiSide === 'down' && e.trend4h === 'up' },
  { tag: 'D2_up_down_up_long_t2t3', side: 'long', filter: (e) => e.quadrant === 'up_down' && e.trend4h === 'up' && (e.tier === 'T2' || e.tier === 'T3') },
  { tag: 'E2_down_up_up_short_t2t3', side: 'short', filter: (e) => e.quadrant === 'down_up' && e.trend4h === 'up' && (e.tier === 'T2' || e.tier === 'T3') },
  { tag: 'F2_down_down_up_short_t2t3', side: 'short', filter: (e) => e.quadrant === 'down_down' && e.trend4h === 'up' && (e.tier === 'T2' || e.tier === 'T3') },
  { tag: 'O2_up_down_mixed_long_t2t3', side: 'long', filter: (e) => e.quadrant === 'up_down' && e.trend4h === 'mixed' && (e.tier === 'T2' || e.tier === 'T3') },
  { tag: 'S2_down_down_mixed_short_t2t3', side: 'short', filter: (e) => e.quadrant === 'down_down' && e.trend4h === 'mixed' && (e.tier === 'T2' || e.tier === 'T3') },
];

function runStrategy(events, loads, cfg) {
  const trades = [];
  const bySymbol = new Map();
  for (const ev of events) {
    if (!cfg.filter(ev)) continue;
    const load = loads.get(ev.symbol);
    if (!load) continue;
    if (!bySymbol.has(ev.symbol)) bySymbol.set(ev.symbol, []);
    bySymbol.get(ev.symbol).push(ev);
  }
  for (const [symbol, list] of bySymbol) {
    const load = loads.get(symbol);
    const barByTs = new Map(load.bars.map((b, i) => [b.ts, i]));
    let busyUntil = -1;
    for (const ev of list.sort((a, b) => a.ts - b.ts)) {
      const i = barByTs.get(ev.ts - 5 * MIN);
      if (i == null || i <= busyUntil) continue;
      const t = evaluateTrade({ ev, bars: load.bars, i, side: typeof cfg.side === 'function' ? cfg.side(ev) : cfg.side, stopAtr: cfg.stopAtr || 1.0, rr: cfg.rr || 2, holdBars: cfg.holdBars || 48, cost: cfg.cost, entryDelayBars: cfg.entryDelayBars || 0, entrySlippagePct: cfg.entrySlippagePct || 0 });
      if (!t) continue;
      trades.push(t);
      const exitIdx = barByTs.get(Math.floor(t.exitTs / (5 * MIN)) * (5 * MIN));
      busyUntil = exitIdx == null ? i + (cfg.holdBars || 48) : exitIdx;
    }
  }
  return trades;
}

function runGrid() {
  const events = JSON.parse(fs.readFileSync(EVENTS, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'backtest-cache', 'manifest.json'), 'utf8'));
  const loads = new Map();
  for (const symbol of manifest.symbols) loads.set(symbol, loadSymbol(symbol));

  const results = {};
  for (const cfg of STRATEGIES) {
    const trades = runStrategy(events, loads, cfg);
    const full = summarize(trades, 'full');
    const windows = WINDOWS.map((w) => summarize(windowTrades(trades, w), w.tag));
    const periods = PERIODS.map((p) => summarize(trades.filter((t) => t.ts >= p.start && t.ts < p.end), p.label));
    const bySide = ['long', 'short'].map((side) => summarize(trades.filter((t) => t.side === side), side));
    const bySector = [...new Set(trades.map((t) => t.sector || 'other'))].sort().map((v) => summarize(trades.filter((t) => (t.sector || 'other') === v), v));
    const byTier = ['T1', 'T2', 'T3', 'T4'].map((v) => summarize(trades.filter((t) => t.tier === v), v));
    const bySymbol = [...new Set(trades.map((t) => t.symbol))].sort().map((v) => summarize(trades.filter((t) => t.symbol === v), v));
    results[cfg.tag] = { cfg: { ...cfg, filter: undefined }, full, windows, periods, bySide, bySector, byTier, bySymbol };
    console.log(`${cfg.tag}\tn=${full.trades}\twin=${(full.winRate * 100).toFixed(1)}%\tavgR=${full.avgR}\ttotalR=${full.totalR}\t1u/20x=${full.totalU}u\tDD=${full.maxDdR}R/${full.maxDdU}u\tw=${windows.map((w) => `${w.trades}:${w.avgR}`).join(' / ')}`);
  }

  fs.writeFileSync(path.join(OUT, 'strategy-grid-default.json'), JSON.stringify({
    meta: {
      entry: '信号 bar 收盘后下一根 5m bar 开盘',
      noOverlap: true,
      cost: `${COST * 100}% round trip`,
      defaultStopAtr: 1.0,
      defaultRR: 2,
      defaultHoldBars: 48,
    },
    results,
  }, null, 2));
  console.log(`\nwrote ${path.join(OUT, 'strategy-grid-default.json')}`);
}

if (require.main === module) runGrid();

module.exports = { runStrategy, summarize, STRATEGIES, evaluateTrade };
