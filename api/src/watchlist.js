'use strict';

/*
 * 异动后观察引擎
 * -----------------
 * 输入：OI 异动事件 + 当前 market row（价格、5m K 线、OI 序列、资金费率、成交额）
 * 输出：观察池条目（阶段、评分、结构指标、双向入场计划、失效条件、时间线）
 *
 * 设计原则：
 * 1. OI 只说明“杠杆在进场/离场”，不直接给方向；方向必须由价格结构确认。
 * 2. 异动后先观察，不追第一根；等 OI 保留 + 箱体收敛 + 触发位放量。
 * 3. 多空两套计划同时给出，谁先被放量突破就激活谁，避免先入为主。
 * 4. 所有阈值都是可解释的规则，不是“AI 预测”；数据缺失时降级而不是编造。
 */

const STAGE_DEFS = {
  detected: { label: '刚侦测', rank: 0, tone: 'neutral', desc: '异动刚出现，至少等 5 分钟，不进场' },
  confirming: { label: '确认中', rank: 1, tone: 'watch', desc: 'OI 未明显回吐、价格开始跟随，继续等结构' },
  setup: { label: '构筑中', rank: 2, tone: 'setup', desc: '箱体收敛，正在计算触发位/止损位' },
  armed: { label: '待触发', rank: 3, tone: 'armed', desc: '价格靠近触发位，等放量确认' },
  triggered: { label: '已触发', rank: 4, tone: 'hot', desc: '已突破触发位，按计划执行或等回踩' },
  invalid: { label: '已失效', rank: 5, tone: 'bad', desc: 'OI 回吐或价格破坏，放弃本次观察' },
  expired: { label: '已过期', rank: 6, tone: 'muted', desc: '超时未触发，移出观察池' },
  dismissed: { label: '已移除', rank: 7, tone: 'muted', desc: '手动移出观察池' },
};

const TERMINAL = new Set(['invalid', 'expired', 'dismissed']);
const ALT_MAJORS = new Set(['BTC', 'ETH', 'BNB']);

// 策略参数集中在这里。默认值 = 线上当前规则；回测/调参时只覆盖需要变的部分。
const DEFAULT_STRATEGY = Object.freeze({
  triggerAtr: 0.12,
  triggerMinPct: 0.0005,
  stopAtr: 0.25,
  stopMinPct: 0.0005,
  rr1: 1.5,
  rr2: 2.5,
  lateAtr: 0.5,
  setupMinAgeMin: 20,
  setupMinRetentionPct: 60,
  setupMinBoxAtr: 0.7,
  setupMaxBoxAtr: 5.2,
  setupMaxBoxPct: 4.2,
  setupMaxFundingPct: 0.12,
  triggerMinVolumeRatio: 0.9,
  triggerMinRetentionPct: 40,
  triggerNearAtr: 0.35,
  triggerMinScore: 0,
  // 突破后价格离触发位超过该 ATR 倍数则不追；Infinity = 不限制（旧行为）
  maxChaseAtr: Infinity,
  // 是否要求信号 bar 收盘价也站在触发位之外，过滤“插针后收回”的假突破
  requireCloseBeyondTrigger: false,
  // 信号 bar 形态：逆向影线占比上限（1 = 不过滤），收盘位置要求（0 = 不过滤）
  maxAdverseWickPct: 1,
  minCloseLocation: 0,
  // 顺势插针：多头要求下影线、空头要求上影线至少占 bar 振幅该比例（0 = 不过滤）
  minFavorableWickPct: 0,
  // 最高价/最低价穿过触发位、收盘又收回箱体，视为插针假突破
  blockFailedBreakout: false,
  // 也可只对单边要求收盘确认，便于回测多空差异
  blockFailedLongBreakout: false,
  blockFailedShortBreakout: false,
  // 触发 bar 相对前 20 根均量的放量倍数（0 = 不过滤）
  triggerMinBarVolumeRatio: 0,
  // 放量上限：超过该倍数视为情绪高潮，反而容易衰竭（Infinity = 不过滤）
  triggerMaxBarVolumeRatio: Infinity,
  // 突破前 3 根是否缩量（0 = 不过滤；例如 0.8 表示必须低于均量 0.8）
  maxPreBreakoutVolumeRatio: 0,
  // 多周期共振：none / 15m / 1h / both
  mtfMode: 'none',
  maxStopPct: 2.6,
  armMinScore: 55,
  btcBlockPct: 1.2,
  gradeA: 75,
  gradeB: 58,
  minOiInvalidPct: 25,
  minOiInvalidAgeMin: 10
});

function resolveStrategy(overrides = {}) {
  if (overrides && overrides.__resolved) return overrides;
  return { ...DEFAULT_STRATEGY, ...(overrides || {}), __resolved: true };
}

// 2026-10 回测后的优化档：放宽止损、限制追高、提高 RR、只做评分 ≥62 的触发。
// DEFAULT_STRATEGY 保留为旧规则，便于 A/B 回测；线上默认使用 OPTIMIZED_STRATEGY。
const OPTIMIZED_STRATEGY = Object.freeze({
  ...DEFAULT_STRATEGY,
  stopAtr: 0.45,
  maxChaseAtr: 0.5,
  rr1: 2.0,
  rr2: 3.0,
  triggerMinScore: 62
});

// 2026-11 形态/量能测试后的默认档：
// 5m 触发 bar 相对前 20 根均量的 0.9–1.5x 为“有效放量”；
// <0.9x 多为无量假突破，>1.5x 多为情绪高潮/衰竭。多周期趋势过滤未通过分段验证。
const VOLUME_STRATEGY = Object.freeze({
  ...OPTIMIZED_STRATEGY,
  triggerMinBarVolumeRatio: 0.9,
  triggerMaxBarVolumeRatio: 1.5
});

// 2026-11 盈亏比实验档：
// 保持 T1/T2 = 2R/3R，不把目标继续推高；把止损从 0.45 ATR 放宽到 0.55 ATR，
// 降低被插针扫损的概率，同时保留量能带。回测 29 笔，T1 57.1%、平均 +0.601R、
// 最大回撤 -2.19R；相比 volume 档单笔名义收益从 0.978% 提升到 1.155%。
// 这是样本内候选档，默认仍是 volume，需用 WATCH_STRATEGY_PROFILE=rr 显式切换。
const RR_STRATEGY = Object.freeze({
  ...VOLUME_STRATEGY,
  stopAtr: 0.55
});

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function round(n, digits = 4) {
  const p = 10 ** digits;
  return Math.round(num(n) * p) / p;
}

// 低价币（PEPE/SHIB 等）不能统一按 4 位小数取整，否则触发位、止损位会被抹平。
function priceDigits(price) {
  const p = Math.abs(num(price));
  if (p >= 1) return 4;
  if (p >= 0.01) return 6;
  if (p >= 0.0001) return 8;
  return 10;
}

function roundPrice(n, price) {
  return round(n, priceDigits(price));
}

function fmtUsd(n, { signed = false } = {}) {
  const abs = Math.abs(num(n));
  const sign = n < 0 ? '-' : signed && n > 0 ? '+' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtPct(n, digits = 2) {
  const v = num(n);
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

function fmtFunding(n) {
  const v = num(n);
  return `${v >= 0 ? '+' : ''}${v.toFixed(4)}%`;
}

function barTs(b) {
  return num(b && (b.ts ?? b.openTime), 0);
}

function barHigh(b) {
  if (!b) return 0;
  const h = num(b.high, NaN);
  if (Number.isFinite(h) && h > 0) return h;
  return Math.max(num(b.open), num(b.close));
}

function barLow(b) {
  if (!b) return 0;
  const l = num(b.low, NaN);
  if (Number.isFinite(l) && l > 0) return l;
  const o = num(b.open);
  const c = num(b.close);
  if (o > 0 && c > 0) return Math.min(o, c);
  return l > 0 ? l : 0;
}

function barClose(b) {
  if (!b) return 0;
  const c = num(b.close, NaN);
  if (Number.isFinite(c) && c > 0) return c;
  return num(b.open);
}

function normalizeBars(klines) {
  if (!Array.isArray(klines)) return [];
  return klines.filter((b) => barTs(b) > 0 && barClose(b) > 0);
}

function atrFromBars(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < 2) return 0;
  const slice = bars.slice(-(period + 1));
  const trs = [];
  for (let i = 1; i < slice.length; i += 1) {
    const h = barHigh(slice[i]);
    const l = barLow(slice[i]);
    const pc = barClose(slice[i - 1]);
    if (!(h > 0) || !(l > 0) || !(pc > 0)) continue;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (!trs.length) return 0;
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function vwapOf(bars) {
  let pv = 0;
  let vv = 0;
  for (const b of bars) {
    const price = (barHigh(b) + barLow(b) + barClose(b)) / 3;
    const volume = num(b.quoteVol, 0) || num(b.volume, 0);
    if (!(price > 0) || !(volume > 0)) continue;
    pv += price * volume;
    vv += volume;
  }
  if (vv > 0) return pv / vv;
  if (!bars.length) return 0;
  const closes = bars.map(barClose).filter((x) => x > 0);
  return closes.length ? closes.reduce((a, b) => a + b, 0) / closes.length : 0;
}

function meanQuoteVol(bars) {
  if (!bars.length) return 0;
  const vals = bars.map((b) => num(b.quoteVol, 0) || num(b.volume, 0)).filter((x) => x > 0);
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function barOpen(b) {
  if (!b) return 0;
  const o = num(b.open, NaN);
  if (Number.isFinite(o) && o > 0) return o;
  return barClose(b);
}

function barVolume(b) {
  return num(b && b.quoteVol, 0) || num(b && b.volume, 0);
}

// 把 5m K 线聚合成 15m / 1h。只保留在信号 bar 收盘时已经完整走完的桶，
// 避免把当前未走完的高周期 bar 当成已知信息。
function aggregateTf(bars, bucketMs, signalCloseTs) {
  const groups = [];
  let cur = null;
  for (const b of bars) {
    const ts = barTs(b);
    if (!(ts > 0)) continue;
    const start = Math.floor(ts / bucketMs) * bucketMs;
    if (!cur || cur.ts !== start) {
      cur = {
        ts: start,
        open: barOpen(b),
        high: barHigh(b),
        low: barLow(b),
        close: barClose(b),
        quoteVol: 0,
      };
      groups.push(cur);
    }
    cur.high = Math.max(cur.high, barHigh(b));
    cur.low = Math.min(cur.low, barLow(b));
    cur.close = barClose(b);
    cur.quoteVol += barVolume(b);
  }
  return groups.filter((g) => g.ts + bucketMs <= signalCloseTs);
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return 0;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i += 1) e = values[i] * k + e * (1 - k);
  return e;
}

function tfTrend(bars) {
  const closes = bars.map((b) => barClose(b)).filter((x) => x > 0);
  if (closes.length < 23) return { trend: 'unknown', bars: closes.length };
  const fast = ema(closes, 8);
  const slow = ema(closes, 21);
  if (!(fast > 0) || !(slow > 0)) return { trend: 'unknown', bars: closes.length };
  return { trend: fast > slow ? 'up' : 'down', bars: closes.length, fast: round(fast, 6), slow: round(slow, 6) };
}

function findOiBaseline(oiSeries, atTs, fallback) {
  if (!Array.isArray(oiSeries) || !oiSeries.length) return fallback;
  let prev = null;
  for (const p of oiSeries) {
    if (!(num(p.oiUsdt) > 0)) continue;
    if (num(p.ts) < atTs) prev = p;
    else break;
  }
  if (prev) return num(prev.oiUsdt, fallback);
  return num(oiSeries[0].oiUsdt, fallback);
}

function oiExtremeSince(oiSeries, atTs, fallback, side) {
  const marks = (Array.isArray(oiSeries) ? oiSeries : [])
    .filter((p) => num(p.ts) >= atTs && num(p.oiUsdt) > 0)
    .map((p) => num(p.oiUsdt));
  if (!marks.length) return fallback;
  return side === 'up' ? Math.max(...marks, fallback) : Math.min(...marks, fallback);
}

function priceExtremes(bars) {
  if (!bars.length) return { high: 0, low: 0 };
  return {
    high: Math.max(...bars.map(barHigh).filter((x) => x > 0)),
    low: Math.min(...bars.map(barLow).filter((x) => x > 0)),
  };
}

function buildPlan(side, boxHigh, boxLow, atr, price, strategy = DEFAULT_STRATEGY) {
  const s = strategy;
  const buffer = Math.max(atr * s.triggerAtr, price * s.triggerMinPct);
  const trigger = side === 'long' ? boxHigh + buffer : boxLow - buffer;
  const stop = side === 'long'
    ? boxLow - Math.max(atr * s.stopAtr, price * s.stopMinPct)
    : boxHigh + Math.max(atr * s.stopAtr, price * s.stopMinPct);
  const risk = Math.abs(trigger - stop);
  const target1 = side === 'long' ? trigger + risk * s.rr1 : trigger - risk * s.rr1;
  const target2 = side === 'long' ? trigger + risk * s.rr2 : trigger - risk * s.rr2;
  const widthAtr = atr > 0 ? (boxHigh - boxLow) / atr : 0;
  const widthPct = boxLow > 0 ? ((boxHigh - boxLow) / boxLow) * 100 : 0;
  const stopPct = trigger > 0 ? (risk / trigger) * 100 : 0;
  const distancePct = price > 0 ? ((trigger - price) / price) * 100 : 0;
  const late = side === 'long' ? price > trigger + atr * s.lateAtr : price < trigger - atr * s.lateAtr;
  const valid = boxHigh > boxLow && risk > 0
    && widthAtr <= s.setupMaxBoxAtr
    && widthPct <= s.setupMaxBoxPct
    && stopPct <= s.maxStopPct;
  const pd = priceDigits(price);
  let note = '';
  if (late) note = '价格已离开触发位，等回踩，不追';
  else if (widthAtr > s.setupMaxBoxAtr) note = '箱体过宽，等待收敛';
  else if (widthPct > s.setupMaxBoxPct) note = '箱体宽度偏大，盈亏比不稳定';
  else if (stopPct > s.maxStopPct) note = '止损距离过宽，需降低仓位';
  else if (widthAtr < 0.8) note = '箱体偏窄，注意假突破';
  else note = '等待放量突破触发位';
  return {
    side,
    sideLabel: side === 'long' ? '多' : '空',
    trigger: round(trigger, pd),
    stop: round(stop, pd),
    target1: round(target1, pd),
    target2: round(target2, pd),
    risk: round(risk, pd),
    rr: s.rr1,
    rr2: s.rr2,
    stopPct: round(stopPct, 2),
    triggerDistancePct: round(distancePct, 2),
    widthAtr: round(widthAtr, 2),
    widthPct: round(widthPct, 2),
    late,
    valid,
    note,
  };
}

/**
 * 计算一次完整分析。
 * @param {object} entry 观察条目（含 anomalyTs / refs / impulse / triggered）
 * @param {object} row 当前 market row
 * @param {object|null} btcRow BTC row
 * @param {Array} bars normalized 5m klines
 * @param {number} now
 */
function analyze(entry, row, btcRow, bars, now, strategy = DEFAULT_STRATEGY) {
  const s = strategy;
  const price = num(row && row.price, 0) || num(entry.impulse.priceAtDetect, 0);
  const atr = atrFromBars(bars, 14) || num(entry.refs.atr, 0) || price * 0.004;
  const atTs = entry.anomalyTs;
  // 箱体只使用已收盘的 5m K 线；最新一根可能还在形成/正在突破，不能被算进箱体
  const closed = bars.filter((b) => barTs(b) <= now - 5 * 60 * 1000);
  const boxBase = closed.length >= 2 ? closed : bars.slice(0, -1);
  const after = boxBase.filter((b) => barTs(b) >= atTs);
  const post = boxBase.filter((b) => barTs(b) >= atTs + 5 * 60 * 1000);
  const boxBars = (post.length >= 3 ? post : after.length >= 2 ? after : boxBase).slice(-48);
  const ext = priceExtremes(boxBars);
  let boxHigh = ext.high || price + atr * 0.3;
  let boxLow = ext.low || price - atr * 0.3;
  if (boxHigh <= 0 || boxLow <= 0 || boxHigh <= boxLow) {
    boxHigh = price + atr * 0.3;
    boxLow = price - atr * 0.3;
  }
  const boxMid = (boxHigh + boxLow) / 2;
  const boxWidthPct = boxLow > 0 ? ((boxHigh - boxLow) / boxLow) * 100 : 0;
  const boxWidthAtr = atr > 0 ? (boxHigh - boxLow) / atr : 0;

  const liveAfter = bars.filter((b) => barTs(b) >= atTs);
  const recentBars = (liveAfter.length ? liveAfter : bars).slice(-3);
  const preBars = bars.filter((b) => barTs(b) < atTs).slice(-12);
  const recentVol = meanQuoteVol(recentBars);
  const baseVol = meanQuoteVol(preBars) || meanQuoteVol(bars.slice(0, Math.max(1, Math.min(12, bars.length))));
  const volumeRatio = baseVol > 0 ? recentVol / baseVol : 0;

  const signalBar = bars[bars.length - 1] || null;
  const prior20Bars = bars.slice(Math.max(0, bars.length - 21), Math.max(0, bars.length - 1));
  const prior20Vol = meanQuoteVol(prior20Bars);
  const signalVol = barVolume(signalBar);
  const barVolumeRatio = prior20Vol > 0 ? signalVol / prior20Vol : 0;
  const pre3Bars = bars.slice(Math.max(0, bars.length - 4), Math.max(0, bars.length - 1));
  const pre3Vol = meanQuoteVol(pre3Bars);
  const preBreakoutVolumeRatio = prior20Vol > 0 ? pre3Vol / prior20Vol : 0;

  const vwap = vwapOf((after.length >= 3 ? after : bars).slice(-36)) || price;
  const vwapDistancePct = vwap > 0 ? ((price - vwap) / vwap) * 100 : 0;

  const oiNow = num(row && row.oiUsdt, 0) || num(entry.impulse.oiAtDetect, 0);
  const baseOi = num(entry.refs.baselineOi, 0) || num(entry.impulse.oiAtDetect, 0) - num(entry.impulse.oiDeltaAbs, 0);
  const oiAtDetect = num(entry.impulse.oiAtDetect, 0) || oiNow;
  const extreme = entry.oiSide === 'up'
    ? Math.max(num(entry.refs.peakOi, oiNow), oiNow)
    : Math.min(num(entry.refs.troughOi, oiNow), oiNow);
  const denom = entry.oiSide === 'up' ? extreme - baseOi : baseOi - extreme;
  let retention = denom > 0
    ? (entry.oiSide === 'up' ? (oiNow - baseOi) / denom : (baseOi - oiNow) / denom) * 100
    : 100;
  retention = clamp(retention, 0, 150);
  const oiSinceDetectPct = oiAtDetect > 0 ? ((oiNow - oiAtDetect) / oiAtDetect) * 100 : 0;
  const oiFromExtremePct = extreme > 0 ? ((oiNow - extreme) / extreme) * 100 : 0;

  const priceSinceDetectPct = entry.impulse.priceAtDetect > 0
    ? ((price - entry.impulse.priceAtDetect) / entry.impulse.priceAtDetect) * 100
    : 0;
  const w15 = (row && row.windows && row.windows['15m']) || {};
  const price15mPct = num(w15.pricePct, 0);
  const btc15mPct = num(btcRow && btcRow.windows && btcRow.windows['15m'] && btcRow.windows['15m'].pricePct, 0);
  const relBtcPct = price15mPct - btc15mPct;

  const takerBuy = recentBars.reduce((a, b) => a + num(b.takerBuyQuote, 0), 0);
  const takerTotal = recentBars.reduce((a, b) => a + (num(b.quoteVol, 0) || num(b.volume, 0)), 0);
  const takerBuyRatio = takerTotal > 0 ? takerBuy / takerTotal : 0.5;

  const funding = num(row && row.funding, 0);
  const quoteVol = num(row && row.quoteVolume24h, 0);

  const aboveVwap = price >= vwap;
  const longPts = [
    aboveVwap,
    priceSinceDetectPct > 0.15,
    relBtcPct > 0,
    takerBuyRatio > 0.52,
  ].filter(Boolean).length;
  const shortPts = [
    !aboveVwap,
    priceSinceDetectPct < -0.15,
    relBtcPct < 0,
    takerBuyRatio < 0.48,
  ].filter(Boolean).length;
  let bias = 'neutral';
  if (longPts >= 3 && longPts >= shortPts + 1) bias = 'long';
  else if (shortPts >= 3 && shortPts >= longPts + 1) bias = 'short';

  const longPlan = buildPlan('long', boxHigh, boxLow, atr, price, s);
  const shortPlan = buildPlan('short', boxHigh, boxLow, atr, price, s);
  const activeSide = entry.triggered ? entry.triggered.side : bias === 'short' ? 'short' : bias === 'long' ? 'long' : 'both';

  // 信号 bar 形态：影线、收盘位置、插针假突破、触发 bar 放量、多周期趋势。
  const sigHigh = signalBar ? barHigh(signalBar) : 0;
  const sigLow = signalBar ? barLow(signalBar) : 0;
  const sigOpen = signalBar ? barOpen(signalBar) : 0;
  const sigClose = signalBar ? barClose(signalBar) : 0;
  const sigRange = Math.max(0, sigHigh - sigLow);
  const bodyHigh = Math.max(sigOpen, sigClose);
  const bodyLow = Math.min(sigOpen, sigClose);
  const upperWickPct = sigRange > 0 ? clamp((sigHigh - bodyHigh) / sigRange, 0, 1) : 0;
  const lowerWickPct = sigRange > 0 ? clamp((bodyLow - sigLow) / sigRange, 0, 1) : 0;
  const closeLocation = sigRange > 0 ? clamp((sigClose - sigLow) / sigRange, 0, 1) : 0.5;
  const bodyPct = sigRange > 0 ? clamp(Math.abs(sigClose - sigOpen) / sigRange, 0, 1) : 0;

  const signalCloseTs = barTs(signalBar) + 5 * 60 * 1000;
  const tf15 = tfTrend(aggregateTf(bars, 15 * 60 * 1000, signalCloseTs));
  const tf1h = tfTrend(aggregateTf(bars, 60 * 60 * 1000, signalCloseTs));
  const mtfResonance = tf15.trend === 'up' && tf1h.trend === 'up'
    ? 'long'
    : tf15.trend === 'down' && tf1h.trend === 'down'
      ? 'short'
      : 'none';

  const failedLongBreakout = !!(signalBar && longPlan.trigger > 0
    && sigHigh >= longPlan.trigger && sigClose < longPlan.trigger);
  const failedShortBreakout = !!(signalBar && shortPlan.trigger > 0
    && sigLow <= shortPlan.trigger && sigClose > shortPlan.trigger);

  const morphology = {
    upperWickPct: round(upperWickPct * 100, 1),
    lowerWickPct: round(lowerWickPct * 100, 1),
    upperWickRatio: round(upperWickPct, 3),
    lowerWickRatio: round(lowerWickPct, 3),
    bodyPct: round(bodyPct * 100, 1),
    closeLocation: round(closeLocation, 2),
    shortCloseLocation: round(1 - closeLocation, 2),
    barVolumeRatio: round(barVolumeRatio, 2),
    preBreakoutVolumeRatio: round(preBreakoutVolumeRatio, 2),
    failedLongBreakout,
    failedShortBreakout,
    tf15: tf15.trend,
    tf1h: tf1h.trend,
    tf15Bars: tf15.bars,
    tf1hBars: tf1h.bars,
    resonance: mtfResonance,
  };

  // 评分：0–100，只用于排序与“值不值得继续看”，不是胜率
  const parts = {};
  parts.impulse = clamp(Math.abs(num(entry.impulse.oiPct, 0)) / 8, 0, 1) * 15
    + clamp((Math.log10(Math.abs(num(entry.impulse.oiDeltaAbs, 0)) + 1) - 4) / 3, 0, 1) * 10;
  parts.retention = (clamp(retention, 0, 100) / 100) * 20;
  const moveScore = clamp(Math.abs(priceSinceDetectPct) / 1.5, 0, 1) * 6;
  const vwapScore = bias === 'long' ? (aboveVwap ? 4 : 0) : bias === 'short' ? (!aboveVwap ? 4 : 0) : 2;
  const relScore = clamp(relBtcPct / 1.5, -1, 1) * 5;
  parts.price = clamp(moveScore + vwapScore + relScore, 0, 15);
  const flowRaw = bias === 'short' ? 0.5 - takerBuyRatio : takerBuyRatio - 0.5;
  parts.flow = clamp(flowRaw * 20, 0, 10);
  const crowd = bias === 'short' ? -funding : bias === 'long' ? funding : Math.abs(funding);
  parts.funding = 10 - clamp((crowd - 0.01) / 0.08, 0, 1) * 10;
  parts.liquidity = clamp((Math.log10(Math.max(quoteVol, 1)) - 5) / 3, 0, 1) * 10;
  const btcAligned = bias === 'long' ? btc15mPct >= -0.2 : bias === 'short' ? btc15mPct <= 0.2 : true;
  const btcOpposed = bias === 'long' ? btc15mPct < -1.2 : bias === 'short' ? btc15mPct > 1.2 : false;
  parts.btc = btcOpposed ? 0 : btcAligned ? 5 : 2.5;
  const score = Math.round(clamp(Object.values(parts).reduce((a, b) => a + b, 0), 0, 100));
  const grade = score >= s.gradeA ? 'A' : score >= s.gradeB ? 'B' : 'C';

  const warnings = [];
  if (retention < 50) warnings.push(`OI 已回吐，结构保留 ${retention.toFixed(0)}%`);
  if (funding > 0.06) warnings.push(`资金费率 ${fmtFunding(funding)}，多头偏拥挤`);
  if (funding < -0.06) warnings.push(`资金费率 ${fmtFunding(funding)}，空头偏拥挤`);
  if (quoteVol > 0 && quoteVol < 5e6) warnings.push(`24h 成交额 ${fmtUsd(quoteVol)}，流动性偏薄`);
  if (boxWidthAtr > s.setupMaxBoxAtr) warnings.push(`箱体宽度 ${boxWidthAtr.toFixed(1)} ATR，尚未收敛`);
  if (btcOpposed) warnings.push(`BTC 15m ${fmtPct(btc15mPct)}，方向逆风`);
  if (longPlan.late || shortPlan.late) warnings.push('价格已离开触发位，勿追，等回踩');
  if (Math.abs(priceSinceDetectPct) > 3) warnings.push(`侦测后已波动 ${fmtPct(priceSinceDetectPct)}，追高风险`);
  if (upperWickPct >= 0.5) warnings.push(`信号 bar 上影线 ${(upperWickPct * 100).toFixed(0)}%，向上突破有插针回落风险`);
  if (lowerWickPct >= 0.5) warnings.push(`信号 bar 下影线 ${(lowerWickPct * 100).toFixed(0)}%，向下突破有插针收回风险`);
  if (failedLongBreakout || failedShortBreakout) warnings.push('触发位出现插针后收回，假突破风险');

  const reasons = [
    `OI ${fmtPct(num(entry.impulse.oiPct, 0))} / ${fmtUsd(num(entry.impulse.oiDeltaAbs, 0), { signed: true })}（5m）`,
    `OI 结构保留 ${retention.toFixed(0)}%`,
    `价格较侦测 ${fmtPct(priceSinceDetectPct)}，${aboveVwap ? '在' : '低于'} VWAP`,
    `主动买入占比 ${(takerBuyRatio * 100).toFixed(1)}%，15m 相对 BTC ${fmtPct(relBtcPct)}`,
    `资金费率 ${fmtFunding(funding)}，24h 额 ${fmtUsd(quoteVol)}`,
    `BTC 15m ${fmtPct(btc15mPct)}`,
    `信号 bar 上影 ${(upperWickPct * 100).toFixed(0)}% / 下影 ${(lowerWickPct * 100).toFixed(0)}%，量比 ${barVolumeRatio.toFixed(2)}x，15m ${tf15.trend} / 1h ${tf1h.trend}`,
  ];

  const impulseLow = num(entry.refs.impulseLow, boxLow);
  const impulseHigh = num(entry.refs.impulseHigh, boxHigh);
  const invalidation = [
    {
      key: 'oi',
      label: 'OI 结构保留 ≥ 25%',
      ok: retention >= 25,
      detail: `当前 ${retention.toFixed(0)}%`,
    },
    {
      key: 'price',
      label: bias === 'short'
        ? '价格未突破异动高点 + 0.4 ATR'
        : '价格未跌破异动低点 − 0.4 ATR',
      ok: bias === 'short'
        ? price <= impulseHigh + atr * 0.4
        : price >= impulseLow - atr * 0.4,
      detail: bias === 'short'
        ? `高点 ${impulseHigh.toFixed(4)} / 现价 ${price.toFixed(4)}`
        : `低点 ${impulseLow.toFixed(4)} / 现价 ${price.toFixed(4)}`,
    },
    {
      key: 'time',
      label: '6 小时内触发',
      ok: now < entry.expiresAt,
      detail: `${Math.max(0, Math.ceil((entry.expiresAt - now) / 60000))} 分钟剩余`,
    },
  ];

  const ageMin = Math.max(0, (now - entry.createdAt) / 60000);
  const timeLeftSec = Math.max(0, Math.floor((entry.expiresAt - now) / 1000));
  const pd = priceDigits(price);
  const liveBar = bars[bars.length - 1] || boxBars[boxBars.length - 1] || null;

  return {
    price,
    atr: round(atr, pd),
    atrPct: price > 0 ? round((atr / price) * 100, 2) : 0,
    vwap: round(vwap, pd),
    vwapDistancePct: round(vwapDistancePct, 2),
    boxHigh: round(boxHigh, pd),
    boxLow: round(boxLow, pd),
    boxMid: round(boxMid, pd),
    boxWidthPct: round(boxWidthPct, 2),
    boxWidthAtr: round(boxWidthAtr, 2),
    volumeRatio: round(volumeRatio, 2),
    morphology,
    takerBuyRatio: round(takerBuyRatio * 100, 1),
    oiNow: round(oiNow, 0),
    oiRetentionPct: round(retention, 0),
    oiSinceDetectPct: round(oiSinceDetectPct, 2),
    oiFromExtremePct: round(oiFromExtremePct, 2),
    priceSinceDetectPct: round(priceSinceDetectPct, 2),
    price15mPct: round(price15mPct, 2),
    dayPct: round(num(row && row.change24h, 0), 2),
    relBtcPct: round(relBtcPct, 2),
    btc15mPct: round(btc15mPct, 2),
    funding: round(funding, 4),
    fundingDisplay: fmtFunding(funding),
    quoteVolume24h: quoteVol,
    quoteVolumeDisplay: fmtUsd(quoteVol),
    bias,
    biasLabel: bias === 'long' ? '偏多' : bias === 'short' ? '偏空' : '方向待定',
    score,
    grade,
    scoreParts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v, 1)])),
    plan: { long: longPlan, short: shortPlan, activeSide },
    reasons,
    warnings,
    invalidation,
    ageMin: round(ageMin, 1),
    timeLeftSec,
    lastBarHigh: liveBar ? round(barHigh(liveBar), pd) : 0,
    lastBarLow: liveBar ? round(barLow(liveBar), pd) : 0,
  };
}

function decisionFor(entry, a, bars, now, strategy = DEFAULT_STRATEGY) {
  const s = strategy;
  if (TERMINAL.has(entry.stage)) return { stage: entry.stage, note: '' };

  if (entry.stage === 'triggered') {
    const outcome = evaluateOutcome(entry, a, bars, now);
    if (outcome && outcome.status === 'stopped') {
      return { stage: 'invalid', note: `触发后触及止损 ${fmtPct(a.plan[entry.triggered.side].stopPct)}`, outcome };
    }
    return { stage: 'triggered', note: '', outcome };
  }

  const hardFail = a.invalidation.find((x) => x.key !== 'time' && !x.ok);
  if (hardFail) return { stage: 'invalid', note: `失效：${hardFail.label}（${hardFail.detail}）` };
  if (now >= entry.expiresAt) return { stage: 'expired', note: '6 小时未触发，移出观察池' };
  if (a.oiRetentionPct < s.minOiInvalidPct && a.ageMin > s.minOiInvalidAgeMin) {
    return { stage: 'invalid', note: `OI 结构保留仅 ${a.oiRetentionPct}%，异动已回吐` };
  }

  const setupOk = a.ageMin >= s.setupMinAgeMin
    && a.oiRetentionPct >= s.setupMinRetentionPct
    && a.boxWidthAtr >= s.setupMinBoxAtr
    && a.boxWidthAtr <= s.setupMaxBoxAtr
    && a.boxWidthPct <= s.setupMaxBoxPct
    && Math.abs(a.funding) < s.setupMaxFundingPct;

  const near = (plan) => a.atr > 0 && Math.abs(a.price - plan.trigger) <= a.atr * s.triggerNearAtr;

  const morphologyOk = (side) => {
    if (side === 'both') return morphologyOk('long') && morphologyOk('short');
    const m = a.morphology || {};
    if (s.maxAdverseWickPct < 1) {
      const adverse = side === 'long' ? num(m.upperWickRatio, 1) : num(m.lowerWickRatio, 1);
      if (adverse > s.maxAdverseWickPct) return false;
    }
    if (s.minCloseLocation > 0) {
      const loc = side === 'long' ? num(m.closeLocation, 0.5) : num(m.shortCloseLocation, 0.5);
      if (loc < s.minCloseLocation) return false;
    }
    if (s.minFavorableWickPct > 0) {
      const favorable = side === 'long' ? num(m.lowerWickRatio, 0) : num(m.upperWickRatio, 0);
      if (favorable < s.minFavorableWickPct) return false;
    }
    if (s.blockFailedBreakout || (side === 'long' && s.blockFailedLongBreakout)) {
      if (side === 'long' && m.failedLongBreakout) return false;
    }
    if (s.blockFailedBreakout || (side === 'short' && s.blockFailedShortBreakout)) {
      if (side === 'short' && m.failedShortBreakout) return false;
    }
    return true;
  };

  const mtfOk = (side) => {
    const m = a.morphology || {};
    if (s.mtfMode === 'none') return true;
    const dir = side === 'long' ? 'up' : 'down';
    const ok15 = m.tf15 === dir;
    const ok1h = m.tf1h === dir;
    if (s.mtfMode === '15m') return ok15;
    if (s.mtfMode === '1h') return ok1h;
    if (s.mtfMode === 'both') return ok15 && ok1h;
    return true;
  };

  const barVolumeOk = !(s.triggerMinBarVolumeRatio > 0)
    || num(a.morphology && a.morphology.barVolumeRatio, 0) >= s.triggerMinBarVolumeRatio;
  const barVolumeCapOk = !(Number.isFinite(s.triggerMaxBarVolumeRatio) && s.triggerMaxBarVolumeRatio > 0)
    || num(a.morphology && a.morphology.barVolumeRatio, 0) <= s.triggerMaxBarVolumeRatio;
  const preVolumeOk = !(s.maxPreBreakoutVolumeRatio > 0)
    || num(a.morphology && a.morphology.preBreakoutVolumeRatio, 0) <= s.maxPreBreakoutVolumeRatio;

  if (entry.stage === 'setup' || entry.stage === 'armed') {
    if (!setupOk) {
      if (a.boxWidthAtr > s.setupMaxBoxAtr) return { stage: 'confirming', note: '箱体变宽，回到确认阶段等收敛' };
      return { stage: 'setup', note: '' };
    }
    const volumeOk = a.volumeRatio >= s.triggerMinVolumeRatio;
    const oiOk = a.oiRetentionPct >= s.triggerMinRetentionPct;
    const longPlan = a.plan.long;
    const shortPlan = a.plan.short;
    const maxChase = Number.isFinite(s.maxChaseAtr) ? a.atr * s.maxChaseAtr : Infinity;
    const longCloseOk = !s.requireCloseBeyondTrigger || a.price >= longPlan.trigger;
    const shortCloseOk = !s.requireCloseBeyondTrigger || a.price <= shortPlan.trigger;
    const longHit = longPlan.valid
      && morphologyOk('long')
      && mtfOk('long')
      && a.lastBarHigh >= longPlan.trigger
      && a.price >= longPlan.trigger - a.atr * s.triggerNearAtr
      && a.price <= longPlan.trigger + maxChase
      && longCloseOk;
    const shortHit = shortPlan.valid
      && morphologyOk('short')
      && mtfOk('short')
      && a.lastBarLow <= shortPlan.trigger
      && a.price <= shortPlan.trigger + a.atr * s.triggerNearAtr
      && a.price >= shortPlan.trigger - maxChase
      && shortCloseOk;
    if (volumeOk && barVolumeOk && barVolumeCapOk && preVolumeOk && oiOk && a.score >= s.triggerMinScore && (longHit || shortHit)) {
      let side = longHit && shortHit ? (a.price >= a.boxMid ? 'long' : 'short') : longHit ? 'long' : 'short';
      if (a.bias === 'long' && !longHit && shortHit) side = 'short';
      if (a.bias === 'short' && longHit && !shortHit) side = 'long';
      const btcBlock = side === 'long' ? a.btc15mPct < -s.btcBlockPct : a.btc15mPct > s.btcBlockPct;
      if (!btcBlock) {
        const plan = a.plan[side];
        return {
          stage: 'triggered',
          note: `${side === 'long' ? '向上' : '向下'}放量突破 ${plan.trigger}（量比 ${a.volumeRatio}x）`,
          triggeredSide: side,
        };
      }
      return { stage: 'armed', note: '已到触发位，但 BTC 逆风，暂不触发' };
    }
    if (near(a.plan.long) || near(a.plan.short)) {
      const why = [];
      if (!volumeOk) why.push('放量不足');
      if (!barVolumeOk) why.push('触发 bar 量比不足');
      if (!barVolumeCapOk) why.push('触发 bar 放量过度');
      if (!preVolumeOk) why.push('突破前未缩量');
      if (!morphologyOk(a.bias === 'long' ? 'long' : a.bias === 'short' ? 'short' : 'both')) why.push('信号 bar 形态未确认');
      return { stage: 'armed', note: `价格接近触发位${why.length ? `，${why.join('、')}` : ''}` };
    }
    return { stage: 'setup', note: '' };
  }

  if (setupOk) {
    if (a.score >= s.armMinScore && (near(a.plan.long) || near(a.plan.short))) {
      return { stage: 'armed', note: '价格进入触发区，等放量确认' };
    }
    return { stage: 'setup', note: '箱体已收敛，计算双向触发位' };
  }
  if (a.ageMin >= 5 && a.oiRetentionPct >= 45) {
    return { stage: 'confirming', note: 'OI 未明显回吐，等价格结构' };
  }
  return { stage: 'detected', note: '' };
}

function evaluateOutcome(entry, a, bars, now) {
  if (!entry.triggered) return null;
  if (entry.outcome && entry.outcome.status === 'target2') return entry.outcome;
  const side = entry.triggered.side;
  const plan = a.plan[side];
  const since = bars.filter((b) => barTs(b) >= entry.triggered.at - 5 * 60 * 1000);
  const ext = priceExtremes(since.length ? since : bars.slice(-4));
  const mfe = side === 'long' ? ext.high : ext.low;
  const mae = side === 'long' ? ext.low : ext.high;
  const favorablePct = entry.triggered.price > 0
    ? side === 'long'
      ? ((mfe - entry.triggered.price) / entry.triggered.price) * 100
      : ((entry.triggered.price - mfe) / entry.triggered.price) * 100
    : 0;
  const adversePct = entry.triggered.price > 0
    ? side === 'long'
      ? ((entry.triggered.price - mae) / entry.triggered.price) * 100
      : ((mae - entry.triggered.price) / entry.triggered.price) * 100
    : 0;

  let status = 'running';
  if (side === 'long') {
    if (ext.low > 0 && ext.low <= plan.stop) status = 'stopped';
    else if (ext.high >= plan.target2) status = 'target2';
    else if (ext.high >= plan.target1) status = 'target1';
  } else {
    if (ext.high > 0 && ext.high >= plan.stop) status = 'stopped';
    else if (ext.low <= plan.target2) status = 'target2';
    else if (ext.low <= plan.target1) status = 'target1';
  }
  return {
    status,
    sinceTs: entry.triggered.at,
    price: entry.triggered.price,
    favorablePct: round(favorablePct, 2),
    adversePct: round(adversePct, 2),
    note: status === 'stopped' ? '触发后触及止损' : status === 'target1' ? '已到 T1' : status === 'target2' ? '已到 T2' : '持有观察',
    updatedAt: now,
  };
}

function createWatchlist({ ttlMs = 6 * 60 * 60 * 1000, maxEntries = 80, maxEvents = 40, strategy = {} } = {}) {
  const entries = new Map();
  const events = [];
  const cfg = resolveStrategy(strategy);
  let seq = 1;

  function makeId() {
    return `w-${seq++}`;
  }

  function pushEvent(entry, from, to, note, now) {
    events.unshift({
      id: `we-${seq++}`,
      symbol: entry.symbol,
      name: entry.name,
      from,
      to,
      toLabel: STAGE_DEFS[to] ? STAGE_DEFS[to].label : to,
      note: note || '',
      score: entry.analysis ? entry.analysis.score : 0,
      ts: now,
    });
    while (events.length > maxEvents) events.pop();
  }

  function setStage(entry, stage, note, now) {
    if (!STAGE_DEFS[stage] || entry.stage === stage) return;
    const from = entry.stage;
    entry.previousStage = from;
    entry.stage = stage;
    entry.stageLabel = STAGE_DEFS[stage].label;
    entry.stageChangedAt = now;
    entry.updatedAt = now;
    entry.timeline.push({
      ts: now,
      stage,
      label: STAGE_DEFS[stage].label,
      note: note || STAGE_DEFS[stage].desc,
    });
    while (entry.timeline.length > 12) entry.timeline.shift();
    if (stage === 'triggered' || stage === 'invalid' || stage === 'expired' || stage === 'armed') {
      pushEvent(entry, from, stage, note, now);
    }
  }

  function register(anomaly, row, btcRow, now = Date.now()) {
    if (!anomaly || !row) return null;
    if (anomaly.eventKind !== 'oi') return null;
    if (!anomaly.side || !['up', 'down'].includes(anomaly.side)) return null;
    if (String(row.category || '') === '美股') return null;
    const atTs = num(anomaly.ts, now);
    if (now - atTs > 45 * 60 * 1000) return null;
    if (atTs > now + 60 * 1000) return null;

    const symbol = String(anomaly.symbol || row.symbol || '').toUpperCase();
    if (!symbol) return null;

    const existing = entries.get(symbol);
    if (existing && !TERMINAL.has(existing.stage)) {
      const sameSide = existing.oiSide === anomaly.side;
      if (sameSide) {
        const newPct = Math.abs(num(anomaly.oiDeltaPct, 0));
        if (newPct >= Math.abs(existing.impulse.oiPct) * 1.15) {
          existing.impulse.oiPct = num(anomaly.oiDeltaPct, existing.impulse.oiPct);
          existing.impulse.oiDeltaAbs = Math.abs(num(anomaly.oiDeltaAbs, existing.impulse.oiDeltaAbs));
          existing.reinforced += 1;
          existing.updatedAt = now;
          existing.timeline.push({
            ts: now,
            stage: existing.stage,
            label: '异动强化',
            note: `同向 OI ${fmtPct(num(anomaly.oiDeltaPct, 0))}，观察继续`,
          });
          while (existing.timeline.length > 12) existing.timeline.shift();
        }
        return serialize(existing, now);
      }
      setStage(existing, 'invalid', '反方向 OI 异动，旧观察失效', now);
    }

    const price = num(row.price, 0) || num(anomaly.price, 0);
    if (!(price > 0)) return null;

    const bars = normalizeBars(row.priceHist5m);
    const atr = atrFromBars(bars, 14) || price * 0.004;
    const around = bars.filter((b) => barTs(b) >= atTs - 20 * 60 * 1000 && barTs(b) <= atTs + 20 * 60 * 1000);
    const impulseBars = around.length ? around : bars.slice(-6);
    const impulseExt = priceExtremes(impulseBars);
    const preBars = bars.filter((b) => barTs(b) < atTs).slice(-12);
    const preExt = priceExtremes(preBars);

    const oiSeries = Array.isArray(row.oiHist && row.oiHist['5m']) ? row.oiHist['5m'] : [];
    const oiAtDetect = num(row.oiUsdt, 0)
      || (oiSeries.length ? num(oiSeries[oiSeries.length - 1].oiUsdt, 0) : 0);
    const baselineOi = findOiBaseline(oiSeries, atTs, oiAtDetect - num(anomaly.oiDeltaAbs, 0));
    const extremeOi = oiExtremeSince(oiSeries, atTs, oiAtDetect, anomaly.side);

    const entry = {
      id: makeId(),
      symbol,
      name: anomaly.name || row.name || symbol,
      category: row.category || anomaly.category || '永续',
      pair: row.pair || `${symbol}USDT`,
      isAlt: !ALT_MAJORS.has(symbol) && row.category !== '美股',
      createdAt: atTs,
      anomalyTs: atTs,
      detectedAt: now,
      updatedAt: now,
      expiresAt: atTs + ttlMs,
      stage: 'detected',
      stageLabel: STAGE_DEFS.detected.label,
      previousStage: null,
      stageChangedAt: now,
      anomalyId: anomaly.id || null,
      oiSide: anomaly.side,
      anomaly: {
        event: anomaly.event,
        eventLabel: anomaly.eventLabel,
        side: anomaly.side,
        ts: atTs,
        window: anomaly.window || '5m',
        oiPct: round(num(anomaly.oiDeltaPct, 0), 2),
        oiDeltaAbs: round(num(anomaly.oiDeltaAbs, 0), 0),
        oiDeltaDisplay: fmtUsd(num(anomaly.oiDeltaAbs, 0), { signed: true }),
        pricePct: round(num(anomaly.pricePct, 0), 2),
      },
      impulse: {
        oiPct: round(num(anomaly.oiDeltaPct, 0), 2),
        oiDeltaAbs: round(Math.abs(num(anomaly.oiDeltaAbs, 0)), 0),
        priceAtDetect: round(num(anomaly.price, 0) || price),
        pricePct: round(num(anomaly.pricePct, 0), 2),
        quoteVol: num(row.quoteVolume24h, 0),
        funding: round(num(row.funding, 0), 4),
        oiAtDetect: round(oiAtDetect, 0),
      },
      refs: {
        baselineOi: round(baselineOi, 0),
        peakOi: anomaly.side === 'up' ? round(Math.max(extremeOi, oiAtDetect), 0) : round(extremeOi, 0),
        troughOi: anomaly.side === 'down' ? round(Math.min(extremeOi, oiAtDetect), 0) : round(extremeOi, 0),
        impulseHigh: round(impulseExt.high || price, 6),
        impulseLow: round(impulseExt.low || price, 6),
        preHigh: round(preExt.high || price, 6),
        preLow: round(preExt.low || price, 6),
        atr: round(atr, 6),
      },
      reinforced: 0,
      triggered: null,
      outcome: null,
      timeline: [{
        ts: now,
        stage: 'detected',
        label: STAGE_DEFS.detected.label,
        note: `OI ${fmtPct(num(anomaly.oiDeltaPct, 0))}，进入观察，不追第一根`,
      }],
      analysis: null,
      source: row.source || anomaly.source || 'binance',
    };

    entry.analysis = analyze(entry, row, btcRow, bars, now, cfg);
    entries.set(symbol, entry);
    trimEntries(now);
    return serialize(entry, now);
  }

  function updateAll(market, btcRow, now = Date.now()) {
    if (!market || typeof market.get !== 'function') return { updated: 0 };
    let updated = 0;
    for (const entry of entries.values()) {
      if (TERMINAL.has(entry.stage)) continue;
      const row = market.get(entry.symbol);
      if (!row || !(num(row.price) > 0)) continue;
      const bars = normalizeBars(row.priceHist5m);
      const a = analyze(entry, row, btcRow, bars, now, cfg);
      entry.analysis = a;
      entry.updatedAt = now;
      const d = decisionFor(entry, a, bars, now, cfg);
      if (d.stage === 'triggered' && !entry.triggered && d.triggeredSide) {
        const plan = a.plan[d.triggeredSide];
        entry.triggered = {
          side: d.triggeredSide,
          at: now,
          price: a.price,
          trigger: plan.trigger,
          stop: plan.stop,
          target1: plan.target1,
          target2: plan.target2,
          volumeRatio: a.volumeRatio,
          morphology: a.morphology,
        };
      }
      if (d.outcome) entry.outcome = d.outcome;
      setStage(entry, d.stage, d.note, now);
      updated += 1;
    }
    trimEntries(now);
    return { updated, total: entries.size };
  }

  function trimEntries(now) {
    if (entries.size <= maxEntries) return;
    const sorted = [...entries.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const e of sorted) {
      if (entries.size <= maxEntries) break;
      if (TERMINAL.has(e.stage) || now - e.createdAt > ttlMs) entries.delete(e.symbol);
    }
  }

  function serialize(entry, now = Date.now()) {
    const a = entry.analysis || {};
    return {
      id: entry.id,
      symbol: entry.symbol,
      name: entry.name,
      category: entry.category,
      pair: entry.pair,
      isAlt: entry.isAlt,
      createdAt: entry.createdAt,
      detectedAt: entry.detectedAt,
      updatedAt: now,
      expiresAt: entry.expiresAt,
      ageMin: round(Math.max(0, (now - entry.createdAt) / 60000), 1),
      timeLeftSec: Math.max(0, Math.floor((entry.expiresAt - now) / 1000)),
      stage: entry.stage,
      stageLabel: STAGE_DEFS[entry.stage] ? STAGE_DEFS[entry.stage].label : entry.stage,
      previousStage: entry.previousStage,
      stageChangedAt: entry.stageChangedAt,
      oiSide: entry.oiSide,
      reinforced: entry.reinforced,
      anomaly: entry.anomaly,
      impulse: entry.impulse,
      bias: a.bias || 'neutral',
      biasLabel: a.biasLabel || '方向待定',
      score: a.score || 0,
      grade: a.grade || 'C',
      metrics: {
        price: a.price || entry.impulse.priceAtDetect,
        priceSinceDetectPct: a.priceSinceDetectPct || 0,
        price15mPct: a.price15mPct || 0,
        dayPct: a.dayPct || 0,
        relBtcPct: a.relBtcPct || 0,
        btc15mPct: a.btc15mPct || 0,
        atr: a.atr || 0,
        atrPct: a.atrPct || 0,
        vwap: a.vwap || 0,
        vwapDistancePct: a.vwapDistancePct || 0,
        boxHigh: a.boxHigh || 0,
        boxLow: a.boxLow || 0,
        boxWidthPct: a.boxWidthPct || 0,
        boxWidthAtr: a.boxWidthAtr || 0,
        oiNow: a.oiNow || 0,
        oiRetentionPct: a.oiRetentionPct || 0,
        oiSinceDetectPct: a.oiSinceDetectPct || 0,
        oiFromExtremePct: a.oiFromExtremePct || 0,
        funding: a.funding || 0,
        fundingDisplay: a.fundingDisplay || fmtFunding(entry.impulse.funding),
        volumeRatio: a.volumeRatio || 0,
        barVolumeRatio: a.morphology ? a.morphology.barVolumeRatio : 0,
        upperWickPct: a.morphology ? a.morphology.upperWickPct : 0,
        lowerWickPct: a.morphology ? a.morphology.lowerWickPct : 0,
        tf15: a.morphology ? a.morphology.tf15 : 'unknown',
        tf1h: a.morphology ? a.morphology.tf1h : 'unknown',
        takerBuyRatio: a.takerBuyRatio || 0,
        lastBarHigh: a.lastBarHigh || 0,
        lastBarLow: a.lastBarLow || 0,
        quoteVolume24h: a.quoteVolume24h || entry.impulse.quoteVol,
        quoteVolumeDisplay: a.quoteVolumeDisplay || fmtUsd(entry.impulse.quoteVol),
      },
      plan: a.plan || null,
      morphology: a.morphology || null,
      scoreParts: a.scoreParts || {},
      reasons: a.reasons || [],
      warnings: a.warnings || [],
      invalidation: a.invalidation || [],
      timeline: entry.timeline,
      triggered: entry.triggered,
      outcome: entry.outcome,
      source: entry.source,
    };
  }

  function list({ stage = 'all', q = '', limit = 50 } = {}) {
    const now = Date.now();
    const needle = String(q || '').trim().toUpperCase();
    let rows = [...entries.values()];
    if (stage === 'active') rows = rows.filter((e) => !TERMINAL.has(e.stage));
    else if (stage && stage !== 'all') rows = rows.filter((e) => e.stage === stage);
    if (needle) {
      rows = rows.filter((e) => e.symbol.includes(needle) || String(e.name).toUpperCase().includes(needle));
    }
    rows.sort((a, b) => {
      const ar = STAGE_DEFS[a.stage]?.rank ?? 9;
      const br = STAGE_DEFS[b.stage]?.rank ?? 9;
      if (ar !== br) return br - ar;
      const as = a.analysis?.score || 0;
      const bs = b.analysis?.score || 0;
      if (as !== bs) return bs - as;
      return b.updatedAt - a.updatedAt;
    });
    const max = clamp(num(limit, 50), 1, 100);
    return rows.slice(0, max).map((e) => serialize(e, now));
  }

  function get(symbol) {
    const entry = entries.get(String(symbol || '').toUpperCase());
    return entry ? serialize(entry, Date.now()) : null;
  }

  function dismiss(symbol, now = Date.now()) {
    const entry = entries.get(String(symbol || '').toUpperCase());
    if (!entry) return null;
    setStage(entry, 'dismissed', '手动移出观察池', now);
    return serialize(entry, now);
  }

  function stats() {
    const counts = { total: entries.size, active: 0 };
    for (const key of Object.keys(STAGE_DEFS)) counts[key] = 0;
    for (const e of entries.values()) {
      counts[e.stage] = (counts[e.stage] || 0) + 1;
      if (!TERMINAL.has(e.stage)) counts.active += 1;
    }
    return counts;
  }

  function recentEvents(limit = 20) {
    return events.slice(0, clamp(num(limit, 20), 1, 50));
  }

  function stageCatalog() {
    return Object.entries(STAGE_DEFS).map(([key, v]) => ({ key, ...v }));
  }

  function dump() {
    return {
      version: 1,
      savedAt: Date.now(),
      seq,
      entries: [...entries.values()],
      events,
    };
  }

  function restore(data) {
    if (!data || data.version !== 1 || !Array.isArray(data.entries)) return { restored: 0 };
    const now = Date.now();
    let restored = 0;
    for (const raw of data.entries) {
      if (!raw || !raw.symbol || !raw.createdAt) continue;
      if (now - raw.createdAt > ttlMs) continue;
      const entry = { ...raw };
      entry.timeline = Array.isArray(entry.timeline) ? entry.timeline.slice(-12) : [];
      entries.set(entry.symbol, entry);
      restored += 1;
    }
    if (Array.isArray(data.events)) {
      events.length = 0;
      events.push(...data.events.slice(0, maxEvents));
    }
    seq = Math.max(num(data.seq, 1), seq);
    return { restored };
  }

  return {
    register,
    updateAll,
    list,
    get,
    dismiss,
    stats,
    recentEvents,
    stageCatalog,
    dump,
    restore,
    ttlMs,
    maxEntries,
  };
}

module.exports = {
  createWatchlist,
  STAGE_DEFS,
  DEFAULT_STRATEGY,
  OPTIMIZED_STRATEGY,
  VOLUME_STRATEGY,
  RR_STRATEGY,
  resolveStrategy,
  // 导出纯函数，便于单测与后续复用
  analyze,
  decisionFor,
  buildPlan,
  atrFromBars,
  vwapOf,
  fmtUsd,
  fmtPct,
};
