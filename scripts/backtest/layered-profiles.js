'use strict';

/*
 * 分层策略 profile。
 *
 * 这里只定义回测参数，不直接改线上默认。每个 profile 都有：
 * - strategy: 参数覆盖
 * - filter: 成交后归因过滤条件
 * - symbols: 可选的币种池
 *
 * 参数是 2026-11-24 讨论后的第一版假设，不是最终最优值；回测结果用于判断
 * 哪些分层值得继续做，哪些应该禁用。
 */

const { VOLUME_STRATEGY } = require('../../api/src/watchlist');
const { sectorSymbols } = require('./context');

const BASE = VOLUME_STRATEGY;
const LAYER = Object.freeze({
  ...BASE,
  // 分层回测强制 OI/价格四象限与方向一致；旧 baseline/optimized 不启用。
  quadrantFilter: true,
  oiTriggerMinPct: 2.0,
  oiTriggerMinAbsUsd: 1e6,
});

const TIER_T1 = Object.freeze({
  ...LAYER,
  stopAtr: 0.55,
  rr1: 2.5,
  rr2: 4.0,
  maxChaseAtr: 0.6,
  triggerMinBarVolumeRatio: 1.0,
  triggerMaxBarVolumeRatio: 2.0,
  triggerMinScore: 60,
  maxStopPct: 3.0,
  maxHoldBars: 576, // 48h，深流动性给趋势更多时间
  allowedLiquidityTiers: ['T1'],
  oiTriggerMinPct: 1.5,
  oiTriggerMinAbsUsd: 5e6,
});

const TIER_T2 = Object.freeze({
  ...LAYER,
  stopAtr: 0.50,
  rr1: 2.0,
  rr2: 3.0,
  maxChaseAtr: 0.5,
  triggerMinBarVolumeRatio: 0.9,
  triggerMaxBarVolumeRatio: 1.6,
  triggerMinScore: 60,
  maxStopPct: 2.8,
  maxHoldBars: 288,
  allowedLiquidityTiers: ['T2'],
  oiTriggerMinPct: 2.0,
  oiTriggerMinAbsUsd: 2e6,
});

const TIER_T3 = Object.freeze({
  ...LAYER,
  stopAtr: 0.65,
  rr1: 1.5,
  rr2: 2.5,
  maxChaseAtr: 0.4,
  triggerMinBarVolumeRatio: 1.0,
  triggerMaxBarVolumeRatio: 1.8,
  maxAdverseWickPct: 0.75,
  minCloseLocation: 0.55,
  triggerMinScore: 62,
  maxStopPct: 3.0,
  maxHoldBars: 192, // 16h，中小市值不隔太久
  allowedLiquidityTiers: ['T3'],
  oiTriggerMinPct: 2.5,
  oiTriggerMinAbsUsd: 5e5,
});

const SECTOR_L1 = Object.freeze({
  ...LAYER,
  stopAtr: 0.55,
  rr1: 2.0,
  rr2: 3.0,
  maxChaseAtr: 0.5,
  triggerMinBarVolumeRatio: 0.9,
  triggerMaxBarVolumeRatio: 1.7,
  mtfMode: '1h',
  triggerMinScore: 60,
  maxHoldBars: 288,
  allowedSectors: ['l1'],
});

const SECTOR_L2 = Object.freeze({
  ...LAYER,
  stopAtr: 0.55,
  rr1: 2.0,
  rr2: 3.0,
  maxChaseAtr: 0.45,
  triggerMinBarVolumeRatio: 0.9,
  triggerMaxBarVolumeRatio: 1.6,
  triggerMinScore: 60,
  maxHoldBars: 288,
  allowedSectors: ['l2'],
});

const SECTOR_DEFI = Object.freeze({
  ...LAYER,
  stopAtr: 0.55,
  rr1: 2.0,
  rr2: 3.0,
  maxChaseAtr: 0.45,
  triggerMinBarVolumeRatio: 0.9,
  triggerMaxBarVolumeRatio: 1.6,
  maxAdverseWickPct: 0.8,
  triggerMinScore: 60,
  maxHoldBars: 288,
  allowedSectors: ['defi'],
});

const SECTOR_AI = Object.freeze({
  ...LAYER,
  stopAtr: 0.60,
  rr1: 2.0,
  rr2: 3.0,
  maxChaseAtr: 0.45,
  triggerMinBarVolumeRatio: 1.0,
  triggerMaxBarVolumeRatio: 1.8,
  mtfMode: '15m',
  triggerMinScore: 62,
  maxHoldBars: 288,
  allowedSectors: ['ai'],
});

const SECTOR_MEME = Object.freeze({
  ...LAYER,
  stopAtr: 0.70,
  rr1: 1.5,
  rr2: 2.5,
  maxChaseAtr: 0.35,
  triggerMinBarVolumeRatio: 1.0,
  triggerMaxBarVolumeRatio: 2.0,
  maxAdverseWickPct: 0.65,
  minCloseLocation: 0.60,
  blockFailedBreakout: true,
  triggerMinScore: 65,
  maxHoldBars: 96, // 8h，meme 不做隔夜趋势
  allowedSectors: ['meme'],
});

const SECTOR_GAMING = Object.freeze({
  ...LAYER,
  stopAtr: 0.65,
  rr1: 1.5,
  rr2: 2.5,
  maxChaseAtr: 0.4,
  triggerMinBarVolumeRatio: 0.9,
  triggerMaxBarVolumeRatio: 1.5,
  triggerMinScore: 62,
  maxHoldBars: 192,
  allowedSectors: ['gaming'],
});

const SECTOR_OTHER = Object.freeze({
  ...LAYER,
  stopAtr: 0.55,
  rr1: 2.0,
  rr2: 3.0,
  maxChaseAtr: 0.45,
  triggerMinScore: 60,
  maxHoldBars: 288,
  allowedSectors: ['other'],
});

const REGIME_RISK_ON = Object.freeze({
  ...LAYER,
  stopAtr: 0.45,
  rr1: 2.0,
  rr2: 3.0,
  maxChaseAtr: 0.5,
  triggerMinScore: 60,
  maxHoldBars: 288,
  allowedRegimes: ['risk_on'],
});

const REGIME_RANGE = Object.freeze({
  ...LAYER,
  stopAtr: 0.55,
  rr1: 1.5,
  rr2: 2.5,
  maxChaseAtr: 0.35,
  requireCloseBeyondTrigger: true,
  triggerMinBarVolumeRatio: 1.0,
  triggerMaxBarVolumeRatio: 1.6,
  triggerMinScore: 62,
  maxHoldBars: 288,
  allowedRegimes: ['range'],
});

const REGIME_HIGH_VOL = Object.freeze({
  ...LAYER,
  stopAtr: 0.65,
  rr1: 2.0,
  rr2: 3.0,
  maxChaseAtr: 0.3,
  triggerMinBarVolumeRatio: 1.0,
  triggerMaxBarVolumeRatio: 2.0,
  maxAdverseWickPct: 0.8,
  triggerMinScore: 62,
  maxHoldBars: 192,
  allowedRegimes: ['high_vol'],
});

const REGIME_RISK_OFF = Object.freeze({
  ...LAYER,
  stopAtr: 0.60,
  rr1: 1.5,
  rr2: 2.5,
  maxChaseAtr: 0.3,
  triggerMinBarVolumeRatio: 1.0,
  triggerMaxBarVolumeRatio: 1.6,
  triggerMinScore: 62,
  maxHoldBars: 192,
  allowedRegimes: ['risk_off'],
  allowedSides: ['short'],
});

const PROFILES = [
  {
    id: 'tier_t1',
    group: 'liquidity',
    label: 'T1 深流动性',
    description: 'ADV≥$500M 且 OI≥$100M；0.55 ATR 止损，2.5R/4R，最多 48h',
    strategy: TIER_T1,
    filter: { liquidityTier: 'T1' },
  },
  {
    id: 'tier_t2',
    group: 'liquidity',
    label: 'T2 主流山寨',
    description: 'ADV $100–500M 且 OI $30–100M；0.50 ATR 止损，2R/3R',
    strategy: TIER_T2,
    filter: { liquidityTier: 'T2' },
  },
  {
    id: 'tier_t3',
    group: 'liquidity',
    label: 'T3 中小山寨',
    description: 'ADV $20–100M 且 OI $5–30M；0.65 ATR 止损，1.5R/2.5R，最多 16h',
    strategy: TIER_T3,
    filter: { liquidityTier: 'T3' },
  },
  {
    id: 'tier_t4',
    group: 'liquidity',
    label: 'T4 微流动性',
    description: 'ADV<$20M 或 OI<$5M；只观察，不交易',
    strategy: null,
    observeOnly: true,
    filter: { liquidityTier: 'T4' },
  },
  {
    id: 'sector_l1',
    group: 'sector',
    label: 'L1',
    description: 'L1 趋势延续；0.55 ATR，2R/3R，1h 共振',
    strategy: SECTOR_L1,
    symbols: sectorSymbols('l1'),
    filter: { sector: 'l1' },
  },
  {
    id: 'sector_l2',
    group: 'sector',
    label: 'L2',
    description: 'ARB/OP/STX；0.55 ATR，2R/3R',
    strategy: SECTOR_L2,
    symbols: sectorSymbols('l2'),
    filter: { sector: 'l2' },
  },
  {
    id: 'sector_defi',
    group: 'sector',
    label: 'DeFi',
    description: 'DeFi/预言机/RWA；0.55 ATR，2R/3R，影线过滤',
    strategy: SECTOR_DEFI,
    symbols: sectorSymbols('defi'),
    filter: { sector: 'defi' },
  },
  {
    id: 'sector_ai',
    group: 'sector',
    label: 'AI/叙事',
    description: 'AI 叙事；0.60 ATR，2R/3R，15m 共振',
    strategy: SECTOR_AI,
    symbols: sectorSymbols('ai'),
    filter: { sector: 'ai' },
  },
  {
    id: 'sector_meme',
    group: 'sector',
    label: 'Meme',
    description: 'Meme 只做流动性和插针确认；0.70 ATR，1.5R/2.5R，最多 8h',
    strategy: SECTOR_MEME,
    symbols: sectorSymbols('meme'),
    filter: { sector: 'meme' },
  },
  {
    id: 'sector_gaming',
    group: 'sector',
    label: 'Gaming',
    description: 'Gaming；0.65 ATR，1.5R/2.5R，最多 16h',
    strategy: SECTOR_GAMING,
    symbols: sectorSymbols('gaming'),
    filter: { sector: 'gaming' },
  },
  {
    id: 'sector_other',
    group: 'sector',
    label: '其他',
    description: 'FIL/ORDI 等未归类板块；0.55 ATR，2R/3R',
    strategy: SECTOR_OTHER,
    symbols: sectorSymbols('other'),
    filter: { sector: 'other' },
  },
  {
    id: 'sector_new_listing',
    group: 'sector',
    label: '新上线',
    description: '上线不足 2–4 周，不纳入 OI 异动回测',
    strategy: null,
    observeOnly: true,
    filter: { sector: 'new_listing' },
  },
  {
    id: 'regime_risk_on',
    group: 'regime',
    label: 'Risk-on 趋势',
    description: 'BTC>EMA50>EMA200、广度≥55%、波动率<70 分位；0.45 ATR，2R/3R',
    strategy: REGIME_RISK_ON,
    filter: { regime: 'risk_on' },
  },
  {
    id: 'regime_range',
    group: 'regime',
    label: '震荡',
    description: 'BTC 均线纠缠、广度 35–55%；突破需收盘确认，1.5R/2.5R',
    strategy: REGIME_RANGE,
    filter: { regime: 'range' },
  },
  {
    id: 'regime_high_vol',
    group: 'regime',
    label: '高波动 Risk-on',
    description: 'BTC 上行但波动率≥70 分位；0.65 ATR，2R/3R，最多 16h',
    strategy: REGIME_HIGH_VOL,
    filter: { regime: 'high_vol' },
  },
  {
    id: 'regime_risk_off',
    group: 'regime',
    label: 'Risk-off',
    description: 'BTC<EMA50<EMA200 或广度<35%；只做空，0.60 ATR，1.5R/2.5R',
    strategy: REGIME_RISK_OFF,
    filter: { regime: 'risk_off', sides: ['short'] },
  },
];

module.exports = {
  BASE,
  PROFILES,
  TIER_T1,
  TIER_T2,
  TIER_T3,
  SECTOR_L1,
  SECTOR_L2,
  SECTOR_DEFI,
  SECTOR_AI,
  SECTOR_MEME,
  SECTOR_GAMING,
  SECTOR_OTHER,
  REGIME_RISK_ON,
  REGIME_RANGE,
  REGIME_HIGH_VOL,
  REGIME_RISK_OFF,
};
