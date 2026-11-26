'use strict';

/*
 * 分层回测的市场上下文标签。
 *
 * 这三个标签只用于回测归因，不改变线上观察池默认行为：
 * - liquidityTier: 用 24h 成交额 + OI 名义价值分 T1/T2/T3/T4，不用流通市值。
 * - sector: 板块标签，来自相对稳定的静态映射。
 * - regime: 由 layered.js 用 BTC 4h 趋势、alt 广度、波动率分位计算。
 */

const TIER_THRESHOLDS = Object.freeze({
  T1: { minAdvUsd: 5e8, minOiUsd: 1e8 },
  T2: { minAdvUsd: 1e8, minOiUsd: 3e7 },
  T3: { minAdvUsd: 2e7, minOiUsd: 5e6 },
});

// 板块分类用于回测，不追求学术严谨；同一币只归一个主板块。
const SECTOR_MAP = Object.freeze({
  SOLUSDT: 'l1',
  XRPUSDT: 'l1',
  DOGEUSDT: 'meme',
  ADAUSDT: 'l1',
  AVAXUSDT: 'l1',
  LINKUSDT: 'defi',
  SUIUSDT: 'l1',
  LTCUSDT: 'l1',
  DOTUSDT: 'l1',
  BCHUSDT: 'l1',
  TRXUSDT: 'l1',
  APTUSDT: 'l1',
  ARBUSDT: 'l2',
  OPUSDT: 'l2',
  NEARUSDT: 'l1',
  FILUSDT: 'other',
  WIFUSDT: 'meme',
  '1000PEPEUSDT': 'meme',
  ENAUSDT: 'defi',
  HBARUSDT: 'l1',
  ICPUSDT: 'l1',
  AAVEUSDT: 'defi',
  UNIUSDT: 'defi',
  INJUSDT: 'l1',
  STXUSDT: 'l2',
  SEIUSDT: 'l1',
  TIAUSDT: 'l1',
  JUPUSDT: 'defi',
  PYTHUSDT: 'defi',
  RENDERUSDT: 'ai',
  FETUSDT: 'ai',
  TAOUSDT: 'ai',
  KASUSDT: 'l1',
  '1000SHIBUSDT': 'meme',
  '1000FLOKIUSDT': 'meme',
  '1000BONKUSDT': 'meme',
  ORDIUSDT: 'other',
  ATOMUSDT: 'l1',
  ALGOUSDT: 'l1',
  VETUSDT: 'l1',
  GALAUSDT: 'gaming',
  THETAUSDT: 'gaming',
  AXSUSDT: 'gaming',
  CRVUSDT: 'defi',
  DYDXUSDT: 'defi',
  LDOUSDT: 'defi',
  WLDUSDT: 'ai',
  ONDOUSDT: 'defi',
  EIGENUSDT: 'defi',
  HYPEUSDT: 'l1',
  PENDLEUSDT: 'defi',
});

const SECTOR_LABELS = Object.freeze({
  l1: 'L1',
  l2: 'L2',
  defi: 'DeFi',
  ai: 'AI/叙事',
  meme: 'Meme',
  gaming: 'Gaming',
  other: '其他',
  new_listing: '新上线',
});

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function liquidityTierOf(row) {
  const adv = num(row && row.quoteVolume24h, 0);
  const oi = num(row && row.oiUsdt, 0);
  if (adv >= TIER_THRESHOLDS.T1.minAdvUsd && oi >= TIER_THRESHOLDS.T1.minOiUsd) return 'T1';
  if (adv >= TIER_THRESHOLDS.T2.minAdvUsd && oi >= TIER_THRESHOLDS.T2.minOiUsd) return 'T2';
  if (adv >= TIER_THRESHOLDS.T3.minAdvUsd && oi >= TIER_THRESHOLDS.T3.minOiUsd) return 'T3';
  return 'T4';
}

function sectorOf(symbol) {
  const key = String(symbol || '').toUpperCase();
  return SECTOR_MAP[key] || 'other';
}

function sectorSymbols(sector) {
  return Object.entries(SECTOR_MAP)
    .filter(([, value]) => value === sector)
    .map(([symbol]) => symbol);
}

module.exports = {
  TIER_THRESHOLDS,
  SECTOR_MAP,
  SECTOR_LABELS,
  liquidityTierOf,
  sectorOf,
  sectorSymbols,
};
