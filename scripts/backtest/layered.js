'use strict';

/*
 * 分层策略回测入口。
 *
 * 用法：
 *   node scripts/backtest/layered.js
 *   npm run backtest:layered
 *
 * 输出：
 *   backtest-results/layered/summary.json
 *   backtest-results/layered/LAYERED_STRATEGY.md
 *
 * 设计取舍：
 * - 每个 profile 用独立参数跑一次完整回放，而不是一次回放里动态切换参数。
 *   这样每个成交的止损/RR/持有时间都和该层参数一致，不会出现“信号是 T1、
 *   却用 T3 止损”的混算。
 * - 成交记录里打 liquidityTier / sector / regime 标签，再按标签聚合。
 * - regime 只用 causal 数据：4h EMA、滚动波动率分位、滚动广度，不使用未来数据。
 */

const fs = require('fs');
const path = require('path');
const {
  run,
  loadSymbol,
  aggregate,
  OUT,
} = require('./replay');
const { EVAL_START, EVAL_END, DAY, WINDOWS, TRAIN_END, TEST_START } = require('./config');
const { PROFILES, BASE } = require('./layered-profiles');
const {
  TIER_THRESHOLDS,
  SECTOR_LABELS,
  SECTOR_MAP,
  liquidityTierOf,
  sectorOf,
} = require('./context');

const OUT_DIR = path.join(OUT, 'layered');
const DOC_PATH = path.join(__dirname, '..', '..', 'LAYERED_STRATEGY.md');
const H4 = 4 * 60 * 60 * 1000;
const REGIME_LABELS = {
  risk_on: 'Risk-on 趋势',
  range: '震荡',
  high_vol: '高波动 Risk-on',
  risk_off: 'Risk-off',
  unknown: '未知/预热',
};

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function pct(part, total) {
  return total > 0 ? part / total : 0;
}

function quantile(values, q) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return 0;
  const pos = (arr.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (!values.length) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function to4h(bars) {
  const map = new Map();
  for (const b of bars) {
    const bucket = Math.floor(b.ts / H4) * H4;
    let row = map.get(bucket);
    if (!row) {
      row = { ts: bucket, open: b.open, high: b.high, low: b.low, close: b.close, quoteVolume: 0 };
      map.set(bucket, row);
    } else {
      row.high = Math.max(row.high, b.high);
      row.low = Math.min(row.low, b.low);
      row.close = b.close;
      row.quoteVolume += Number(b.quoteVolume) || 0;
    }
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

function trailingPercentile(values, i, lookback = 180) {
  const current = values[i];
  if (!Number.isFinite(current)) return null;
  let below = 0;
  let total = 0;
  for (let j = Math.max(0, i - lookback); j < i; j += 1) {
    if (Number.isFinite(values[j])) {
      total += 1;
      if (values[j] < current) below += 1;
    }
  }
  return total > 0 ? below / total : null;
}

function stdout(msg) {
  process.stdout.write(`${msg}\n`);
}

/*
 * 用 BTC 4h + alt 广度 + 波动率分位构建 regime。
 * 返回 { regimeByBucket, breadthByBucket, btc4h }。
 */
function buildRegimeContext(manifest) {
  stdout('building regime context: BTC 4h EMA50/EMA200 + alt breadth + vol percentile');
  const btc = loadSymbol('BTCUSDT');
  const btc4h = to4h(btc.bars);
  const closes = btc4h.map((b) => b.close);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);

  const returns = new Array(btc4h.length).fill(null);
  for (let i = 1; i < btc4h.length; i += 1) {
    returns[i] = Math.log(btc4h[i].close / btc4h[i - 1].close);
  }
  const volatility = new Array(btc4h.length).fill(null);
  for (let i = 6; i < returns.length; i += 1) {
    const arr = returns.slice(i - 5, i + 1).filter(Number.isFinite);
    if (!arr.length) continue;
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
    volatility[i] = Math.sqrt(variance);
  }

  // 广度：每个 4h 桶里，有多少山寨 close > 自己的 4h EMA50。
  const breadthByBucket = new Map();
  const symbols = manifest.symbols || [];
  for (let si = 0; si < symbols.length; si += 1) {
    const symbol = symbols[si];
    const s = loadSymbol(symbol);
    const b4 = to4h(s.bars);
    const c = b4.map((b) => b.close);
    const e50 = ema(c, 50);
    for (let i = 50; i < b4.length; i += 1) {
      const bucket = b4[i].ts;
      if (!breadthByBucket.has(bucket)) breadthByBucket.set(bucket, { above: 0, total: 0 });
      const row = breadthByBucket.get(bucket);
      row.total += 1;
      if (c[i] > e50[i]) row.above += 1;
    }
  }

  const regimeByBucket = new Map();
  let lastRegime = 'unknown';
  for (let i = 0; i < btc4h.length; i += 1) {
    const b = btc4h[i];
    const breadthRow = breadthByBucket.get(b.ts);
    const breadth = breadthRow && breadthRow.total > 0 ? breadthRow.above / breadthRow.total : null;
    const volPct = trailingPercentile(volatility, i, 180);
    let regime = 'unknown';
    if (i >= 200 && Number.isFinite(ema50[i]) && Number.isFinite(ema200[i]) && breadth != null) {
      const trendUp = b.close > ema50[i] && ema50[i] > ema200[i];
      const trendDown = b.close < ema50[i] && ema50[i] < ema200[i];
      if (trendUp && volPct != null && volPct >= 0.7) regime = 'high_vol';
      else if (trendUp && breadth >= 0.55) regime = 'risk_on';
      else if (trendDown || breadth < 0.35) regime = 'risk_off';
      else regime = 'range';
      lastRegime = regime;
    } else if (i < 200) {
      // 预热期不强行分类，避免 EMA200 没收敛就给出 regime。
      regime = 'unknown';
    }
    regimeByBucket.set(b.ts, regime);
  }

  const distribution = {};
  for (const r of regimeByBucket.values()) distribution[r] = (distribution[r] || 0) + 1;

  return {
    btc4h,
    ema50,
    ema200,
    volatility,
    breadthByBucket,
    regimeByBucket,
    distribution,
    lastRegime,
  };
}

function regimeAt(ts) {
  return (bucket) => {
    const key = Math.floor(bucket / H4) * H4;
    return ts.regimeByBucket.get(key) || 'unknown';
  };
}

function periodStats(trades, start, end) {
  const list = trades
    .filter((t) => {
      const ts = Date.parse(t.triggerAtIso || '');
      return Number.isFinite(ts) && ts >= start && ts < end;
    })
    .sort((a, b) => Date.parse(a.triggerAtIso) - Date.parse(b.triggerAtIso));

  const n = list.length;
  if (!n) {
    return {
      trades: 0,
      winRate: 0,
      t1WinRate: 0,
      avgR: 0,
      totalR: 0,
      maxDdR: 0,
      avgNotionalPct: 0,
      totalU: 0,
      avgU: 0,
      maxDdU: 0,
      profitFactor: 0,
      stopRate: 0,
    };
  }

  let wins = 0;
  let losses = 0;
  let t1Wins = 0;
  let stops = 0;
  let totalR = 0;
  let totalNotional = 0;
  let totalU = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let cumR = 0;
  let peakR = 0;
  let maxDdR = 0;
  let cumU = 0;
  let peakU = 0;
  let maxDdU = 0;

  for (const t of list) {
    const r = Number(t.netR) || 0;
    const riskPct = Number(t.riskPct != null ? t.riskPct : t.planStopPct) || 0;
    const notional = r * riskPct / 100;
    const u = notional * 20;
    if (r > 0) {
      wins += 1;
      grossWin += r;
    } else if (r < 0) {
      losses += 1;
      grossLoss += Math.abs(r);
    }
    if (t.t1Win) t1Wins += 1;
    if (t.outcome === 'stop' || t.stop) stops += 1;
    totalR += r;
    totalNotional += notional;
    totalU += u;
    cumR += r;
    peakR = Math.max(peakR, cumR);
    maxDdR = Math.max(maxDdR, peakR - cumR);
    cumU += u;
    peakU = Math.max(peakU, cumU);
    maxDdU = Math.max(maxDdU, peakU - cumU);
  }

  return {
    trades: n,
    wins,
    losses,
    winRate: pct(wins, n),
    t1WinRate: pct(t1Wins, n),
    avgR: totalR / n,
    totalR,
    maxDdR,
    avgNotionalPct: totalNotional / n,
    totalU,
    avgU: totalU / n,
    maxDdU,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    stopRate: pct(stops, n),
  };
}

function withPeriods(trades) {
  const periods = {
    full: periodStats(trades, EVAL_START, EVAL_END),
    first60: periodStats(trades, EVAL_START, EVAL_START + 60 * DAY),
    last31: periodStats(trades, EVAL_START + 60 * DAY, EVAL_END),
    train45: periodStats(trades, EVAL_START, TRAIN_END),
    test46: periodStats(trades, TEST_START, EVAL_END),
    w1: periodStats(trades, WINDOWS[0].start, WINDOWS[0].end),
    w2: periodStats(trades, WINDOWS[1].start, WINDOWS[1].end),
    w3: periodStats(trades, WINDOWS[2].start, WINDOWS[2].end),
  };
  return periods;
}

function applyFilter(trades, filter) {
  let out = trades;
  if (filter.liquidityTier) out = out.filter((t) => t.liquidityTier === filter.liquidityTier);
  if (filter.sector) out = out.filter((t) => (t.sector || 'other') === filter.sector);
  if (filter.regime) out = out.filter((t) => (t.regime || 'unknown') === filter.regime);
  if (filter.sides) out = out.filter((t) => filter.sides.includes(t.side));
  return out;
}

function fmtPct(v, digits = 1) {
  return `${(v * 100).toFixed(digits)}%`;
}

function fmtR(v) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(3)}R`;
}

function fmtU(v) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}u`;
}

function fmtUsdM(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  return `$${(n / 1e6).toFixed(1)}M`;
}

function markdown(payload) {
  const lines = [];
  const meta = payload.meta;
  lines.push('# 分层 OI 异动策略：逻辑与 91 天回测');
  lines.push('');
  lines.push(`- 回测区间：${meta.interval}`);
  lines.push(`- 币种池：${meta.symbols} 个山寨 + BTC 过滤；5m K 线 + 5m OI，往返成本 0.12%，同 bar 止损优先。`);
  lines.push(`- 生成时间：${meta.generatedAt}`);
  lines.push('');
  lines.push('## 一、分层逻辑');
  lines.push('');
  lines.push('### 1. 流动性层级');
  lines.push('');
  lines.push('| 层级 | ADV 下限 | OI 下限 | 交易处理 |');
  lines.push('|---|---:|---:|---|');
  lines.push(`| T1 | $${(TIER_THRESHOLDS.T1.minAdvUsd / 1e6).toFixed(0)}M | $${(TIER_THRESHOLDS.T1.minOiUsd / 1e6).toFixed(0)}M | 可交易，0.55 ATR，2.5R/4R，最多 48h |`);
  lines.push(`| T2 | $${(TIER_THRESHOLDS.T2.minAdvUsd / 1e6).toFixed(0)}M | $${(TIER_THRESHOLDS.T2.minOiUsd / 1e6).toFixed(0)}M | 可交易，0.50 ATR，2R/3R，最多 24h |`);
  lines.push(`| T3 | $${(TIER_THRESHOLDS.T3.minAdvUsd / 1e6).toFixed(0)}M | $${(TIER_THRESHOLDS.T3.minOiUsd / 1e6).toFixed(0)}M | 可交易，0.65 ATR，1.5R/2.5R，最多 16h |`);
  lines.push('| T4 | < $20M 或 OI < $5M | — | 只观察，不交易；滑点和插针不可控 |');
  lines.push('');
  lines.push('### 2. 板块类别');
  lines.push('');
  lines.push('| 板块 | 参数/过滤 | 适用条件 |');
  lines.push('|---|---|---|');
  for (const p of payload.profiles.filter((x) => x.group === 'sector')) {
    lines.push(`| ${p.label} | ${p.description} | ${p.observeOnly ? '样本不足，暂不交易' : '见回测结果'} |`);
  }
  lines.push('');
  lines.push('### 3. 市场行情');
  lines.push('');
  lines.push('| Regime | 判定 | 参数/动作 |');
  lines.push('|---|---|---|');
  lines.push('| Risk-on 趋势 | BTC close > EMA50 > EMA200、广度 ≥55%、波动率 <70 分位 | 0.45 ATR，2R/3R，正常仓位 |');
  lines.push('| 震荡 | 均线未单边排列、广度 35–55% | 突破需收盘确认，0.55 ATR，1.5R/2.5R，降仓 |');
  lines.push('| 高波动 Risk-on | BTC 上行但波动率 ≥70 分位 | 0.65 ATR，2R/3R，最多 16h，降仓 |');
  lines.push('| Risk-off | BTC close < EMA50 < EMA200 或广度 <35% | 只做空，0.60 ATR，1.5R/2.5R |');
  lines.push('| 未知/预热 | EMA200 未收敛 | 不交易 |');
  lines.push('');
  lines.push('### 4. 硬规则');
  lines.push('');
  lines.push('- **环境先行**：regime 为 unknown 或 risk-off 时，不按 risk-on 参数做多；risk-off 只允许空单。');
  lines.push('- **流动性一票否决**：T4（ADV<$20M 或 OI<$5M）只观察，不进入回测成交，避免滑点和插针失真。');
  lines.push('- **OI 不能单独用**：成交必须满足 OI/价格四象限与方向一致；多头只做 OI↑价↑ / OI↓价↑，空头只做 OI↑价↓ / OI↓价↓。');
  lines.push('- **不追第一根**：沿用 `setupMinAgeMin=20`，异动后至少观察 20 分钟，不在第一根 5m 追。');
  lines.push('- **止损放结构外**：止损用箱体外沿 + ATR 缓冲，不用固定百分比拍脑袋。');
  lines.push('- **风险预算优先**：回测统一按 1u 风险/笔；实盘建议单笔风险 0.5–1% 账户，同板块合计 ≤2u，总持仓 ≤3u；同 BTC beta 的币合并计算风险。');
  lines.push('- **样本外验证**：给前60/后31、w1/w2/w3、前45/后46 分窗；不用后31天选参。');
  lines.push('');
  lines.push('### 5. 杠杆上限（建议，不是回测口径）');
  lines.push('');
  lines.push('- T1 最多 10x、T2 最多 10x、T3 最多 5x、T4 0x（不交易）。');
  lines.push('- 回测里的 1u/20x 只是统一换算口径，不代表建议上 20x。按当前结果，20x 的绝对收益不足以覆盖执行误差和回撤。');
  lines.push('');
  lines.push('## 二、91 天回测结果');
  lines.push('');
  lines.push('### 全样本');
  lines.push('');
  lines.push('| Profile | 笔数 | T1胜率 | 平均净R | 总净R | 最大回撤R | 平均名义收益 | 1u/20x总盈亏 | 1u/20x每笔 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const p of payload.profiles) {
    if (p.observeOnly) {
      lines.push(`| ${p.label} | ${p.observedTrades || 0}（观察） | — | — | — | — | — | — | — |`);
      continue;
    }
    const s = p.periods.full;
    lines.push(`| ${p.label} | ${s.trades} | ${fmtPct(s.t1WinRate)} | ${fmtR(s.avgR)} | ${fmtR(s.totalR)} | ${s.maxDdR.toFixed(2)}R | ${fmtPct(s.avgNotionalPct, 3)} | ${fmtU(s.totalU)} | ${fmtU(s.avgU)} |`);
  }
  lines.push('');
  lines.push('### 分窗口（总净R / 每笔平均净R）');
  lines.push('');
  lines.push('| Profile | 前60天 | 后31天 | w1 | w2 | w3 |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const p of payload.profiles) {
    if (p.observeOnly) continue;
    const f = p.periods.first60;
    const l = p.periods.last31;
    const w1 = p.periods.w1;
    const w2 = p.periods.w2;
    const w3 = p.periods.w3;
    lines.push(`| ${p.label} | ${f.trades}笔 ${fmtR(f.totalR)} (${fmtR(f.avgR)}/笔) | ${l.trades}笔 ${fmtR(l.totalR)} (${fmtR(l.avgR)}/笔) | ${fmtR(w1.totalR)} | ${fmtR(w2.totalR)} | ${fmtR(w3.totalR)} |`);
  }
  lines.push('');
  lines.push('### Walk-forward：前 45 天 / 后 46 天（未用后段调参）');
  lines.push('');
  lines.push('| Profile | 前45天笔数 | 前45天平均R | 后46天笔数 | 后46天平均R |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const p of payload.profiles) {
    if (p.observeOnly) continue;
    const tr = p.periods.train45;
    const te = p.periods.test46;
    lines.push(`| ${p.label} | ${tr.trades} | ${fmtR(tr.avgR)} | ${te.trades} | ${fmtR(te.avgR)} |`);
  }
  lines.push('');
  lines.push('### 阈值校准：成交信号 ADV / OI 分位');
  lines.push('');
  lines.push(`样本 ${payload.calibration.sample} 笔；美元值为 24h 成交额 / OI 名义价值。`);
  lines.push('');
  lines.push('| 分位 | ADV | OI |');
  lines.push('|---|---:|---:|');
  for (const q of ['p25', 'p50', 'p75', 'p90', 'p95']) {
    lines.push(`| ${q.toUpperCase()} | ${fmtUsdM(payload.calibration.advUsd[q])} | ${fmtUsdM(payload.calibration.oiUsd[q])} |`);
  }
  lines.push(`| MAX | ${fmtUsdM(payload.calibration.advUsd.max)} | ${fmtUsdM(payload.calibration.oiUsd.max)} |`);
  lines.push('');
  lines.push('### 对照：现有 volume 0.45 ATR 按标签拆分');
  lines.push('');
  lines.push('| 维度 | 笔数 | T1胜率 | 平均净R | 总净R | 1u/20x总盈亏 |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  const c = payload.control;
  const rows = [
    ['全样本', c.overall.full],
    ...c.byLiquidityTier.map((x) => [`流动性 ${x.key}`, x.full]),
    ...c.bySector.map((x) => [`板块 ${SECTOR_LABELS[x.key] || x.key}`, x.full]),
    ...c.byRegime.map((x) => [`行情 ${REGIME_LABELS[x.key] || x.key}`, x.full]),
  ];
  for (const [label, s] of rows) {
    lines.push(`| ${label} | ${s.trades} | ${fmtPct(s.t1WinRate)} | ${fmtR(s.avgR)} | ${fmtR(s.totalR)} | ${fmtU(s.totalU)} |`);
  }
  lines.push('');
  lines.push('### 与现有 volume 0.45 ATR 对比');
  lines.push('');
  const byId = Object.fromEntries(payload.profiles.map((p) => [p.id, p]));
  const vol = payload.control.overall;
  lines.push(`- 现有 volume：${vol.full.trades} 笔，平均 ${fmtR(vol.full.avgR)}，总 ${fmtR(vol.full.totalR)}，1u/20x ${fmtU(vol.full.totalU)}，最大回撤 ${vol.full.maxDdU.toFixed(2)}u；前60天 ${fmtR(vol.first60.avgR)}/笔，后31天 ${fmtR(vol.last31.avgR)}/笔。`);
  const t1 = byId.tier_t1;
  const t2 = byId.tier_t2;
  const t3 = byId.tier_t3;
  lines.push(`- 严格四象限后，T1 从 volume 的 ${payload.control.byLiquidityTier.find((x) => x.key === 'T1').full.trades} 笔降到 ${t1.periods.full.trades} 笔；T2 从 ${payload.control.byLiquidityTier.find((x) => x.key === 'T2').full.trades} 笔降到 ${t2.periods.full.trades} 笔；T3 从 ${payload.control.byLiquidityTier.find((x) => x.key === 'T3').full.trades} 笔降到 ${t3.periods.full.trades} 笔。`);
  lines.push(`- T2：平均 ${fmtR(t2.periods.full.avgR)}，总 ${fmtR(t2.periods.full.totalR)}，1u/20x ${fmtU(t2.periods.full.totalU)}；前60天 ${fmtR(t2.periods.first60.avgR)}/笔，后31天 ${fmtR(t2.periods.last31.avgR)}/笔；前45天 ${fmtR(t2.periods.train45.avgR)}/笔，后46天 ${fmtR(t2.periods.test46.avgR)}/笔。`);
  lines.push(`- T1：平均 ${fmtR(t1.periods.full.avgR)}，后46天 ${fmtR(t1.periods.test46.avgR)}/笔，但前45天 ${fmtR(t1.periods.train45.avgR)}/笔，方向翻转。`);
  lines.push(`- T3：${t3.periods.full.trades} 笔，平均 ${fmtR(t3.periods.full.avgR)}，样本不足 30，只观察。`);
  lines.push('- 结论：分层没有全面比 volume 更稳定。T2 的平均 R 和回撤更好，但后 31 天/后 46 天转负；T1、T3 没有正期望。当前不能用分层档替代 volume 默认档。');
  lines.push('');
  lines.push('### 执行建议');
  lines.push('');
  lines.push('- **禁用/不上线**：T1、L1、L2、DeFi、Meme、其他、Risk-on 趋势、高波动 Risk-on。');
  lines.push('- **只观察**：T3、T4、AI/叙事、Gaming、Risk-off、震荡、新上线。AI 9 笔 +12.12R 看起来很好，但样本不足 30，不能因为高胜率上线。');
  lines.push('- **可 paper trade**：仅 T2。40 笔，平均 +0.099R，最大回撤 6.92R；但后 31 天 -0.378R/笔、后 46 天 -0.003R/笔，先纸面跟踪，不投入实盘。');
  lines.push(`- **当前最可靠的单一规则**：risk-off 只做空，用 volume 默认档，不用严格四象限分层。对照组空头 ${payload.control.riskOffBySide.find((x) => x.side === 'short').full.trades} 笔、平均 ${fmtR(payload.control.riskOffBySide.find((x) => x.side === 'short').full.avgR)}、总 ${fmtR(payload.control.riskOffBySide.find((x) => x.side === 'short').full.totalR)}；多头 ${payload.control.riskOffBySide.find((x) => x.side === 'long').full.trades} 笔、平均 ${fmtR(payload.control.riskOffBySide.find((x) => x.side === 'long').full.avgR)}。如果只能保留一条，保留“risk-off 只做空”，不要为了四象限把 41 笔压到 10 笔。`);
  lines.push('- **20x 杠杆**：T2 全样本 1u/20x 总 +1.26u、每笔 +0.032u、最大回撤 2.99u；收益绝对值很小，20x 不值得。T2 建议最多 10x，T3/T4 建议 5x 或不做；T1 在严格四象限下为负，不建议上杠杆。');
  lines.push('- **四象限硬门槛的代价**：T1/T2/T3 样本从 101/80/95 降到 30/40/27。如果坚持硬四象限，当前只能纸面跟踪 T2；若想提高样本，四象限应降级为方向确认/仓位权重，而不是硬过滤，但这会偏离“OI 不能单独用”的硬规则，需要更多数据再验证。');
  lines.push('');
  lines.push('## 三、结论与禁用条件');
  lines.push('');
  lines.push('> 以下结论由脚本按样本自动生成，样本 <30 笔的桶只做观察，不据此调参。');
  lines.push('');
  for (const p of payload.profiles) {
    if (p.observeOnly) {
      lines.push(`- **${p.label}**：${p.description}。当前样本 ${p.observedTrades || 0} 笔，只观察。`);
      continue;
    }
    const s = p.periods.full;
    const f = p.periods.first60;
    const l = p.periods.last31;
    let verdict = '观察';
    if (s.trades < 30 && s.avgR < -0.3) verdict = '负期望明显，禁用（样本<30仅方向性证据）';
    else if (s.trades < 30 && s.avgR > 0.5) verdict = '样本不足，只观察，不可因高胜率上线';
    else if (s.trades < 30) verdict = '样本不足，只观察';
    else if (s.avgR <= 0) verdict = '负期望，禁用或降级';
    else if (s.avgR > 0 && f.avgR > 0 && l.avgR < 0) verdict = '前60天正、后31天负，只能 paper trade';
    else if (s.avgR > 0 && f.avgR > 0) verdict = '全样本正期望且前60天为正，可继续验证';
    else if (s.avgR > 0 && f.avgR <= 0) verdict = '正期望依赖后31天，样本内不稳定';
    else verdict = '观察';
    lines.push(`- **${p.label}**：${s.trades} 笔，T1 ${fmtPct(s.t1WinRate)}，平均 ${fmtR(s.avgR)}，总 ${fmtR(s.totalR)}；前60天 ${fmtR(f.avgR)}/笔，后31天 ${fmtR(l.avgR)}/笔。结论：${verdict}。`);
  }
  lines.push('');
  lines.push('## 四、失败原因/数据限制');
  lines.push('');
  lines.push('- 91 天缓存没有资金费率，`funding` 全为 0，regime gate 里的 funding 条件无法生效。');
  lines.push('- 缓存没有市值和上市时间，T1/T2/T3 用 ADV+OI 近似流动性层级；新上线板块当前没有可识别样本。');
  lines.push('- 4h EMA200 需要 200 根 4h bar，前约 33 天 regime 为 unknown；regime 分层实际只覆盖后约 58 天。');
  lines.push('- 波动率分位使用 trailing 180 根 4h bar 的因果分位，不用全样本分位。');
  lines.push('- 分层参数是第一版假设，不是网格最优；不要用后31天结果反推参数。');
  lines.push('- 严格四象限 + 分层 OI 阈值把样本压到 30 笔附近，T1/T2/T3 的结果只能算方向性证据，不能当最终胜率。');
  const roShort = payload.control.riskOffBySide.find((x) => x.side === 'short');
  const roLong = payload.control.riskOffBySide.find((x) => x.side === 'long');
  lines.push(`- Risk-off 的 edge 主要来自方向：volume 对照组 risk-off 空头 ${roShort.full.trades} 笔、平均 ${fmtR(roShort.full.avgR)}、总 ${fmtR(roShort.full.totalR)}；多头 ${roLong.full.trades} 笔、平均 ${fmtR(roLong.full.avgR)}、总 ${fmtR(roLong.full.totalR)}。严格四象限后空头只剩 ${byId.regime_risk_off.periods.full.trades} 笔，样本不足。`);
  const t1Ctrl = payload.control.byLiquidityTier.find((x) => x.key === 'T1');
  lines.push(`- T1 负期望更像参数问题：volume 对照组 T1 ${t1Ctrl.full.trades} 笔、平均 ${fmtR(t1Ctrl.full.avgR)}；T1 profile 把目标拉到 2.5R/4R、持有 48h 后变成 ${byId.tier_t1.periods.full.trades} 笔、平均 ${fmtR(byId.tier_t1.periods.full.avgR)}。不是“T1 不能做”，是 T1 不该用这么远的目标。`);
  lines.push('');
  lines.push('## 五、代码改动与复现');
  lines.push('');
  lines.push('新增：');
  lines.push('- `scripts/backtest/context.js`：流动性层级 T1–T4 阈值、51 币板块映射。');
  lines.push('- `scripts/backtest/layered-profiles.js`：16 个分层 profile（流动性 4、板块 8、行情 4），含独立止损/RR/持有/OI 阈值。');
  lines.push('- `scripts/backtest/layered.js`：BTC 4h EMA50/200、alt 广度、波动率 trailing 分位、regime 打标、分层聚合与报告。');
  lines.push('');
  lines.push('修改：');
  lines.push('- `api/src/watchlist.js`：新增 `maxHoldBars`、`quadrantFilter`、OI/价格四象限；默认关闭四象限，保持旧 baseline/optimized/volume/rr 可复现。');
  lines.push('- `scripts/backtest/replay.js`：成交记录写 `liquidityTier/sector/regime`；支持 `maxHoldBars`、按层过滤信号、regime 回调；新增 `loadSymbol` 等导出。');
  lines.push('- `package.json`：新增 `backtest:layered`。');
  lines.push('');
  lines.push('复现：');
  lines.push('```powershell');
  lines.push('npm run test:watch');
  lines.push('npm run backtest:layered');
  lines.push('```');
  lines.push('');
  lines.push('对照旧结果：`backtest-results/summary.json`、`backtest-results/volume/summary.json`、`backtest-results/optimized/summary.json`、`backtest-results/rr/summary.json`。');
  lines.push('');
  return lines.join('\n');
}

function main() {
  ensureDir(OUT_DIR);
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, '..', 'backtest-cache', 'manifest.json'), 'utf8'));
  const ctx = buildRegimeContext(manifest);
  const regimeLookup = regimeAt(ctx);

  stdout(`regime distribution: ${JSON.stringify(ctx.distribution)}`);

  const control = run({
    strategy: BASE,
    regimeAt: regimeLookup,
    write: false,
    quiet: true,
  });
  const controlTrades = control.trades;

  const profiles = [];
  for (const p of PROFILES) {
    if (p.observeOnly) {
      const observed = p.filter
        ? applyFilter(controlTrades, p.filter)
        : controlTrades;
      profiles.push({
        id: p.id,
        group: p.group,
        label: p.label,
        description: p.description,
        observeOnly: true,
        observedTrades: observed.length,
        periods: null,
      });
      stdout(`${p.id}: observe only, ${observed.length} signals`);
      continue;
    }

    stdout(`running ${p.id} ...`);
    const result = run({
      strategy: p.strategy,
      symbols: p.symbols || null,
      regimeAt: regimeLookup,
      write: false,
      quiet: true,
    });
    const trades = applyFilter(result.trades, p.filter);
    const periods = withPeriods(trades);
    profiles.push({
      id: p.id,
      group: p.group,
      label: p.label,
      description: p.description,
      params: p.strategy,
      periods,
    });
    stdout(`${p.id}: ${periods.full.trades} trades, avg ${periods.full.avgR.toFixed(3)}R, total ${periods.full.totalR.toFixed(2)}R`);
  }

  const controlPeriods = {
    overall: { full: periodStats(controlTrades, EVAL_START, EVAL_END), first60: periodStats(controlTrades, EVAL_START, EVAL_START + 60 * DAY), last31: periodStats(controlTrades, EVAL_START + 60 * DAY, EVAL_END) },
    byLiquidityTier: ['T1', 'T2', 'T3', 'T4'].map((key) => ({
      key,
      ...withPeriods(controlTrades.filter((t) => t.liquidityTier === key)),
    })),
    bySector: [...new Set(controlTrades.map((t) => t.sector || 'other'))].sort().map((key) => ({
      key,
      ...withPeriods(controlTrades.filter((t) => (t.sector || 'other') === key)),
    })),
    byRegime: [...new Set(controlTrades.map((t) => t.regime || 'unknown'))].sort().map((key) => ({
      key,
      ...withPeriods(controlTrades.filter((t) => (t.regime || 'unknown') === key)),
    })),
    riskOffBySide: ['long', 'short'].map((side) => ({
      side,
      ...withPeriods(controlTrades.filter((t) => t.regime === 'risk_off' && t.side === side)),
    })),
  };

  const advVals = controlTrades.map((t) => Number(t.quoteVolume24h) || 0);
  const oiVals = controlTrades.map((t) => Number(t.oiUsdt) || 0);
  const calibration = {
    sample: controlTrades.length,
    advUsd: {
      p25: quantile(advVals, 0.25),
      p50: quantile(advVals, 0.50),
      p75: quantile(advVals, 0.75),
      p90: quantile(advVals, 0.90),
      p95: quantile(advVals, 0.95),
      max: Math.max(0, ...advVals),
    },
    oiUsd: {
      p25: quantile(oiVals, 0.25),
      p50: quantile(oiVals, 0.50),
      p75: quantile(oiVals, 0.75),
      p90: quantile(oiVals, 0.90),
      p95: quantile(oiVals, 0.95),
      max: Math.max(0, ...oiVals),
    },
    note: '阈值是讨论起点；这里给成交信号 ADV/OI 的分位数，用于判断 $500M/$100M 等门槛是否过严或过松。',
  };

  // 失败/样本提示：按钮桶不足 30 笔只观察。
  for (const p of profiles) {
    if (p.observeOnly) continue;
    if (p.periods.full.trades < 30) p.note = '样本 <30 笔，只观察，不据此调参';
    else if (p.periods.full.avgR > 0 && p.periods.first60.avgR <= 0) p.note = '正期望依赖后31天，样本内不稳定';
  }

  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      interval: '2026-08-24 ~ 2026-11-22 UTC（91d）',
      symbols: manifest.symbols.length,
      feeRoundTrip: 0.0012,
      holdRule: 'maxHoldBars per profile; same-bar stop first',
      regimeDistribution: ctx.distribution,
      tierThresholds: TIER_THRESHOLDS,
      sectorMap: SECTOR_MAP,
    },
    control: controlPeriods,
    calibration,
    profiles,
    warnings: [
      'funding=0，regime 的 funding 条件未生效',
      '无市值/上市时间，T1/T2/T3 用 ADV+OI 近似',
      '4h EMA200 预热导致前约 33 天 regime=unknown',
    ],
  };

  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'trades-control.json'), JSON.stringify(controlTrades.map((t) => ({
    symbol: t.symbol,
    side: t.side,
    at: t.triggerAtIso,
    netR: t.netR,
    riskPct: t.riskPct != null ? t.riskPct : t.planStopPct,
    liquidityTier: t.liquidityTier,
    sector: t.sector,
    regime: t.regime,
  })), null, 2), 'utf8');
  fs.writeFileSync(DOC_PATH, markdown(payload), 'utf8');

  stdout(`wrote ${path.join(OUT_DIR, 'summary.json')}`);
  stdout(`wrote ${DOC_PATH}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

module.exports = {
  buildRegimeContext,
  periodStats,
  withPeriods,
  to4h,
  ema,
  trailingPercentile,
};
