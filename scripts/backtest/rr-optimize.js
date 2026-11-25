'use strict';

/*
 * 盈亏比控制实验：固定优化档的入场逻辑，只调整 T1/T2 的 R 倍数、
 * 止损 ATR、追高上限和退出方式，比较每笔名义收益、总 R 和回撤。
 *
 * 注意：这是样本内参数搜索，不是样本外验证。最后仍要按前后 45/46 天分段复核。
 */

const fs = require('fs');
const path = require('path');
const { run } = require('./replay');
const { PERIOD_LABEL } = require('./config');
const { OPTIMIZED_STRATEGY, VOLUME_STRATEGY } = require('../../api/src/watchlist');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'backtest-results', 'rr-optimize');
const BASE = OPTIMIZED_STRATEGY;

function maxDrawdownR(trades) {
  // run() 按币种累积交易，必须按触发时间重排，否则回撤是伪回撤。
  const ordered = trades
    .map((t) => ({ ...t, __ts: Date.parse(t.triggerAtIso || t.at || 0) || 0 }))
    .sort((a, b) => a.__ts - b.__ts);
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of ordered) {
    equity += Number(t.netR) || 0;
    if (equity > peak) peak = equity;
    const dd = equity - peak;
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd;
}

function summarize(result) {
  const trades = result.trades || [];
  const n = trades.length;
  const totalR = trades.reduce((a, t) => a + (Number(t.netR) || 0), 0);
  const avgNetR = n ? totalR / n : 0;
  const avgRiskPct = n
    ? trades.reduce((a, t) => a + (Number(t.riskPct) || 0), 0) / n
    : 0;
  const avgNotionalPct = n
    ? trades.reduce((a, t) => a + ((Number(t.netR) || 0) * (Number(t.riskPct) || 0) / 100), 0) / n
    : 0;
  const totalNotionalPct = trades.reduce(
    (a, t) => a + ((Number(t.netR) || 0) * (Number(t.riskPct) || 0) / 100),
    0
  );
  const wins = trades.filter((t) => (Number(t.netR) || 0) > 0);
  const losses = trades.filter((t) => (Number(t.netR) || 0) < 0);
  const avgWinR = wins.length
    ? wins.reduce((a, t) => a + Number(t.netR), 0) / wins.length
    : 0;
  const avgLossR = losses.length
    ? losses.reduce((a, t) => a + Number(t.netR), 0) / losses.length
    : 0;
  const o = result.summary.overall;
  return {
    trades: n,
    resolved: o.resolved,
    winRateT1: o.winRateT1,
    winRateT2: o.winRateT2,
    stopRate: o.stopRate,
    avgNetR,
    totalR,
    avgRiskPct,
    avgNotionalPct,
    totalNotionalPct,
    maxDrawdownR: maxDrawdownR(trades),
    avgWinR,
    avgLossR,
    timeoutRate: o.timeoutRate,
  };
}

function runVariant(label, patch = {}, exitMode = 't1', strategyBase = BASE) {
  const started = Date.now();
  const result = run({
    strategy: { ...strategyBase, ...patch },
    tag: label,
    quiet: true,
    write: false,
    exitMode,
  });
  const s = summarize(result);
  return {
    label,
    patch,
    exitMode,
    ...s,
    elapsedMs: Date.now() - started,
  };
}

function pct(v) {
  return `${(v * 100).toFixed(2)}%`;
}

function main() {
  const rows = [];

  // 第一轮：只动 T1/T2，观察盈亏比本身的边际。
  const rr1s = [1.5, 1.75, 2.0, 2.25, 2.5, 3.0];
  for (const rr1 of rr1s) {
    rows.push(runVariant(`rr-${rr1.toFixed(2)}`, { rr1, rr2: Math.max(rr1 + 1, 2.5) }));
  }

  // 第二轮：盈亏比 × 止损距离，看“更紧止损换更高 RR”是否成立。
  for (const rr1 of [2.0, 2.25, 2.5]) {
    for (const stopAtr of [0.35, 0.40, 0.45, 0.50, 0.55]) {
      if (rr1 === 2.0 && stopAtr === 0.45) continue; // 控制组已跑
      rows.push(runVariant(`rr-${rr1.toFixed(2)}-stop-${stopAtr.toFixed(2)}`, {
        rr1,
        rr2: Math.max(rr1 + 1, 3.0),
        stopAtr,
      }));
    }
  }

  // 第三轮：最佳候选的退出方式。partial = T1 平一半、T2 平剩余，
  // T1 后止损上移到开仓价；t2 = 一直拿到 T2 或止损。
  const bestR = rows.slice().sort((a, b) => b.avgNetR - a.avgNetR)[0];
  for (const exitMode of ['partial', 't2']) {
    rows.push(runVariant(`best-${exitMode}`, bestR.patch, exitMode));
  }

  // 第四轮：在最佳参数上叠加量能带，验证是否仍然成立。
  rows.push(runVariant('best-volume', bestR.patch, 't1', VOLUME_STRATEGY));

  rows.sort((a, b) => b.avgNetR - a.avgNetR);
  const payload = {
    generatedAt: new Date().toISOString(),
    period: PERIOD_LABEL,
    base: BASE,
    note: '固定优化档入场逻辑，只改 RR/止损/退出方式；样本内搜索，需分段验证',
    rows,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'grid.json'), JSON.stringify(payload, null, 2));

  console.log('\nlabel\ttrades\tT1\tT2\tstop\tavgR\ttotalR\tavgNotional%\tmaxDDR');
  for (const r of rows) {
    console.log([
      r.label,
      r.trades,
      pct(r.winRateT1),
      pct(r.winRateT2),
      pct(r.stopRate),
      r.avgNetR.toFixed(3),
      r.totalR.toFixed(2),
      (r.avgNotionalPct * 100).toFixed(3),
      r.maxDrawdownR.toFixed(2),
    ].join('\t'));
  }
  console.log(`\nwritten: ${path.join(OUT_DIR, 'grid.json')}`);
}

main();
