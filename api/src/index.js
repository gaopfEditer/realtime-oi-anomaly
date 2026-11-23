const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { createWatchlist, DEFAULT_STRATEGY, OPTIMIZED_STRATEGY, VOLUME_STRATEGY } = require('./watchlist');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const VIP_REQUIRED = String(process.env.VIP_REQUIRED || 'false').toLowerCase() === 'true';
const FAPI = process.env.BINANCE_FAPI || 'https://fapi.binance.com';

const DEMO_USER = { email: 'demo@local.dev', password: 'demo123', vip: true };

const EVENT_TYPES = {
  price_surge: { key: 'price_surge', label: '价格急涨', kind: 'price', side: 'up' },
  price_dump: { key: 'price_dump', label: '价格急跌', kind: 'price', side: 'down' },
  oi_surge: { key: 'oi_surge', label: 'OI暴增', kind: 'oi', side: 'up' },
  oi_dump: { key: 'oi_dump', label: 'OI暴跌', kind: 'oi', side: 'down' },
};

/** Display ticker → Binance futures pair (1000* memes keep short label) */
const CURATED = [
  { symbol: 'BTC', pair: 'BTCUSDT', name: 'Bitcoin', category: '主流' },
  { symbol: 'ETH', pair: 'ETHUSDT', name: 'Ethereum', category: '主流' },
  { symbol: 'SOL', pair: 'SOLUSDT', name: 'Solana', category: 'Layer1' },
  { symbol: 'XRP', pair: 'XRPUSDT', name: 'XRP', category: '主流' },
  { symbol: 'BNB', pair: 'BNBUSDT', name: 'BNB', category: '主流' },
  { symbol: 'DOGE', pair: 'DOGEUSDT', name: 'Dogecoin', category: 'Meme' },
  { symbol: 'PEPE', pair: '1000PEPEUSDT', name: 'Pepe', category: 'Meme' },
  { symbol: 'WIF', pair: 'WIFUSDT', name: 'dogwifhat', category: 'Meme' },
  { symbol: 'BONK', pair: '1000BONKUSDT', name: 'Bonk', category: 'Meme' },
  { symbol: 'FLOKI', pair: '1000FLOKIUSDT', name: 'FLOKI', category: 'Meme' },
  { symbol: 'AVAX', pair: 'AVAXUSDT', name: 'Avalanche', category: 'Layer1' },
  { symbol: 'LINK', pair: 'LINKUSDT', name: 'Chainlink', category: 'DeFi' },
  { symbol: 'UNI', pair: 'UNIUSDT', name: 'Uniswap', category: 'DeFi' },
  { symbol: 'AAVE', pair: 'AAVEUSDT', name: 'Aave', category: 'DeFi' },
  { symbol: 'CRV', pair: 'CRVUSDT', name: 'Curve DAO', category: 'DeFi' },
  { symbol: 'ARB', pair: 'ARBUSDT', name: 'Arbitrum', category: 'Layer2' },
  { symbol: 'OP', pair: 'OPUSDT', name: 'Optimism', category: 'Layer2' },
  { symbol: 'SUI', pair: 'SUIUSDT', name: 'Sui', category: 'Layer1' },
  { symbol: 'APT', pair: 'APTUSDT', name: 'Aptos', category: 'Layer1' },
  { symbol: 'NEAR', pair: 'NEARUSDT', name: 'NEAR', category: 'AI' },
  { symbol: 'FET', pair: 'FETUSDT', name: 'Fetch.ai', category: 'AI' },
  { symbol: 'TAO', pair: 'TAOUSDT', name: 'Bittensor', category: 'AI' },
  { symbol: 'RENDER', pair: 'RENDERUSDT', name: 'Render', category: 'AI' },
  { symbol: 'IMX', pair: 'IMXUSDT', name: 'Immutable', category: 'GameFi' },
  { symbol: 'GALA', pair: 'GALAUSDT', name: 'Gala', category: 'GameFi' },
  { symbol: 'INJ', pair: 'INJUSDT', name: 'Injective', category: 'DeFi' },
  { symbol: 'TIA', pair: 'TIAUSDT', name: 'Celestia', category: 'Layer1' },
  { symbol: 'SEI', pair: 'SEIUSDT', name: 'Sei', category: 'Layer1' },
  { symbol: 'ORDI', pair: 'ORDIUSDT', name: 'ORDI', category: 'Meme' },
  { symbol: 'WLD', pair: 'WLDUSDT', name: 'Worldcoin', category: 'AI' },
  { symbol: 'FIL', pair: 'FILUSDT', name: 'Filecoin', category: '存储' },
  { symbol: 'ATOM', pair: 'ATOMUSDT', name: 'Cosmos', category: 'Layer1' },
  { symbol: 'DOT', pair: 'DOTUSDT', name: 'Polkadot', category: 'Layer1' },
  { symbol: 'LTC', pair: 'LTCUSDT', name: 'Litecoin', category: '主流' },
  { symbol: 'ADA', pair: 'ADAUSDT', name: 'Cardano', category: 'Layer1' },
  { symbol: 'TRX', pair: 'TRXUSDT', name: 'TRON', category: '主流' },
  { symbol: 'BCH', pair: 'BCHUSDT', name: 'Bitcoin Cash', category: '主流' },
  { symbol: 'ETC', pair: 'ETCUSDT', name: 'Ethereum Classic', category: '主流' },
  { symbol: 'ENA', pair: 'ENAUSDT', name: 'Ethena', category: 'DeFi' },
  { symbol: 'W', pair: 'WUSDT', name: 'Wormhole', category: '基础设施' },
  { symbol: 'JUP', pair: 'JUPUSDT', name: 'Jupiter', category: 'DeFi' },
  { symbol: 'ONDO', pair: 'ONDOUSDT', name: 'Ondo', category: 'RWA' },
  { symbol: 'PENDLE', pair: 'PENDLEUSDT', name: 'Pendle', category: 'DeFi' },
  { symbol: 'ETHFI', pair: 'ETHFIUSDT', name: 'ether.fi', category: 'DeFi' },
  { symbol: 'EIGEN', pair: 'EIGENUSDT', name: 'EigenLayer', category: '基础设施' },
  { symbol: 'ZK', pair: 'ZKUSDT', name: 'ZKsync', category: 'Layer2' },
  { symbol: 'STRK', pair: 'STRKUSDT', name: 'Starknet', category: 'Layer2' },
  { symbol: 'PIXEL', pair: 'PIXELUSDT', name: 'Pixels', category: 'GameFi' },
  { symbol: 'MANTA', pair: 'MANTAUSDT', name: 'Manta', category: 'Layer2' },
  { symbol: 'ALT', pair: 'ALTUSDT', name: 'AltLayer', category: '基础设施' },
  { symbol: 'DYM', pair: 'DYMUSDT', name: 'Dymension', category: 'Layer1' },
  { symbol: 'BLUR', pair: 'BLURUSDT', name: 'Blur', category: 'NFT' },
  { symbol: 'STX', pair: 'STXUSDT', name: 'Stacks', category: 'Layer2' },
  { symbol: 'CFX', pair: 'CFXUSDT', name: 'Conflux', category: 'Layer1' },
  { symbol: 'SAND', pair: 'SANDUSDT', name: 'The Sandbox', category: 'GameFi' },
  { symbol: 'AXS', pair: 'AXSUSDT', name: 'Axie Infinity', category: 'GameFi' },
  { symbol: 'APE', pair: 'APEUSDT', name: 'ApeCoin', category: 'NFT' },
  { symbol: 'COMP', pair: 'COMPUSDT', name: 'Compound', category: 'DeFi' },
  { symbol: 'SNX', pair: 'SNXUSDT', name: 'Synthetix', category: 'DeFi' },
  { symbol: 'DYDX', pair: 'DYDXUSDT', name: 'dYdX', category: 'DeFi' },
  { symbol: 'GMX', pair: 'GMXUSDT', name: 'GMX', category: 'DeFi' },
  { symbol: 'LDO', pair: 'LDOUSDT', name: 'Lido DAO', category: 'DeFi' },
  { symbol: 'SSV', pair: 'SSVUSDT', name: 'SSV Network', category: '基础设施' },
  { symbol: 'ARKM', pair: 'ARKMUSDT', name: 'Arkham', category: 'AI' },
  { symbol: 'BOME', pair: 'BOMEUSDT', name: 'BOOK OF MEME', category: 'Meme' },
  { symbol: 'NOT', pair: 'NOTUSDT', name: 'Notcoin', category: 'Meme' },
  { symbol: 'MOVE', pair: 'MOVEUSDT', name: 'Movement', category: 'Layer1' },
  { symbol: 'ME', pair: 'MEUSDT', name: 'Magic Eden', category: 'NFT' },
  { symbol: 'VIRTUAL', pair: 'VIRTUALUSDT', name: 'Virtuals', category: 'AI' },
  { symbol: 'TRUMP', pair: 'TRUMPUSDT', name: 'Official Trump', category: 'Meme' },
  { symbol: 'HYPE', pair: 'HYPEUSDT', name: 'Hyperliquid', category: 'DeFi' },
  // Binance TradFi US equity perpetuals — always keep hot names in board universe
  { symbol: 'TSLA', pair: 'TSLAUSDT', name: 'Tesla', category: '美股' },
  { symbol: 'NVDA', pair: 'NVDAUSDT', name: 'NVIDIA', category: '美股' },
  { symbol: 'AAPL', pair: 'AAPLUSDT', name: 'Apple', category: '美股' },
  { symbol: 'META', pair: 'METAUSDT', name: 'Meta', category: '美股' },
  { symbol: 'AMZN', pair: 'AMZNUSDT', name: 'Amazon', category: '美股' },
  { symbol: 'GOOGL', pair: 'GOOGLUSDT', name: 'Alphabet', category: '美股' },
  { symbol: 'MSFT', pair: 'MSFTUSDT', name: 'Microsoft', category: '美股' },
  { symbol: 'NFLX', pair: 'NFLXUSDT', name: 'Netflix', category: '美股' },
  { symbol: 'AMD', pair: 'AMDUSDT', name: 'AMD', category: '美股' },
  { symbol: 'COIN', pair: 'COINUSDT', name: 'Coinbase', category: '美股' },
  { symbol: 'MSTR', pair: 'MSTRUSDT', name: 'MicroStrategy', category: '美股' },
  { symbol: 'PLTR', pair: 'PLTRUSDT', name: 'Palantir', category: '美股' },
  { symbol: 'HOOD', pair: 'HOODUSDT', name: 'Robinhood', category: '美股' },
  { symbol: 'SMCI', pair: 'SMCIUSDT', name: 'Super Micro', category: '美股' },
  { symbol: 'ARM', pair: 'ARMUSDT', name: 'Arm', category: '美股' },
  { symbol: 'CRCL', pair: 'CRCLUSDT', name: 'Circle', category: '美股' },
  { symbol: 'INTC', pair: 'INTCUSDT', name: 'Intel', category: '美股' },
  { symbol: 'MU', pair: 'MUUSDT', name: 'Micron', category: '美股' },
  { symbol: 'AVGO', pair: 'AVGOUSDT', name: 'Broadcom', category: '美股' },
  { symbol: 'ORCL', pair: 'ORCLUSDT', name: 'Oracle', category: '美股' },
  { symbol: 'TSM', pair: 'TSMUSDT', name: 'TSMC', category: '美股' },
  { symbol: 'BABA', pair: 'BABAUSDT', name: 'Alibaba', category: '美股' },
  { symbol: 'PDD', pair: 'PDDUSDT', name: 'PDD', category: '美股' },
  { symbol: 'UBER', pair: 'UBERUSDT', name: 'Uber', category: '美股' },
  { symbol: 'COST', pair: 'COSTUSDT', name: 'Costco', category: '美股' },
  { symbol: 'CRM', pair: 'CRMUSDT', name: 'Salesforce', category: '美股' },
  { symbol: 'QCOM', pair: 'QCOMUSDT', name: 'Qualcomm', category: '美股' },
  { symbol: 'DIS', pair: 'DISUSDT', name: 'Disney', category: '美股' },
  { symbol: 'JPM', pair: 'JPMUSDT', name: 'JPMorgan', category: '美股' },
];

const BOARD_WINDOWS = ['15m', '30m', '1h', '4h', '1d', '3d'];
const BOARD_KINDS = [
  { key: 'gainers_value', title: '▲ 涨幅榜 / 按涨跌幅 (%)', side: 'up', metric: 'pct', unit: '%' },
  { key: 'losers_value', title: '▼ 跌幅榜 / 按涨跌幅 (%)', side: 'down', metric: 'pct', unit: '%' },
  { key: 'gainers_strength', title: '▲ 涨幅榜 / 按强度 (Str)', side: 'up', metric: 'strength', unit: 'Str', strengthOf: 'pct' },
  { key: 'losers_strength', title: '▼ 跌幅榜 / 按强度 (Str)', side: 'down', metric: 'strength', unit: 'Str', strengthOf: 'pct' },
  { key: 'oi_up_value', title: '▲ 未平仓 / 按金额 (USDT)', side: 'up', metric: 'value', unit: 'USDT' },
  { key: 'oi_down_value', title: '▼ 未平仓 / 按金额 (USDT)', side: 'down', metric: 'value', unit: 'USDT' },
  { key: 'oi_up_strength', title: '▲ 未平仓 / 按强度 (Str)', side: 'up', metric: 'strength', unit: 'Str', strengthOf: 'oi' },
  { key: 'oi_down_strength', title: '▼ 未平仓 / 按强度 (Str)', side: 'down', metric: 'strength', unit: 'Str', strengthOf: 'oi' },
  { key: 'perp_in_value', title: '▲ 永续流入 / 按金额 (USDT)', side: 'up', metric: 'value', unit: 'USDT', estimated: true },
  { key: 'perp_out_value', title: '▼ 永续流出 / 按金额 (USDT)', side: 'down', metric: 'value', unit: 'USDT', estimated: true },
  { key: 'perp_in_strength', title: '▲ 永续流入 / 按强度 (Str)', side: 'up', metric: 'strength', unit: 'Str', strengthOf: 'flow', estimated: true },
  { key: 'perp_out_strength', title: '▼ 永续流出 / 按强度 (Str)', side: 'down', metric: 'strength', unit: 'Str', strengthOf: 'flow', estimated: true },
  { key: 'spot_in_value', title: '▲ 现货流入 / 按金额 (USDT)', side: 'up', metric: 'value', unit: 'USDT', estimated: true },
  { key: 'spot_out_value', title: '▼ 现货流出 / 按金额 (USDT)', side: 'down', metric: 'value', unit: 'USDT', estimated: true },
  { key: 'spot_in_strength', title: '▲ 现货流入 / 按强度 (Str)', side: 'up', metric: 'strength', unit: 'Str', strengthOf: 'flow', estimated: true },
  { key: 'spot_out_strength', title: '▼ 现货流出 / 按强度 (Str)', side: 'down', metric: 'strength', unit: 'Str', strengthOf: 'flow', estimated: true },
];

const WINDOW_TO_PERIOD = {
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '3d': '1d', // 3d = ~3 daily OI bars (from→to span)
};

/*
 * Radar timing / board stability knobs (document for operators):
 * - POLL_HINT_MS: frontend poll interval hint
 * - TICKER_TTL_MS: Binance 24h ticker + live pricePct patch cadence
 * - OI_POLL_MS: OI hist + 5m klines (anomaly source); slower to respect rate limits
 * - BOARD_REFRESH_MS: full board recompute (price+OI+flow); lower = more real-time
 * - BOARD_STR_POOL: widen |%|/$ candidates before re-ranking by strength (divergence)
 * - BOARD_STICKY_BLEND: 0..1 weight of previous rank when merging (anti batch-jump)
 * - BOARD_HYSTERESIS_*: adjacent-swap sticky thresholds after blend
 */
const POLL_HINT_MS = 10000;
const TICKER_TTL_MS = 8000;
const OI_POLL_MS = 40000;
const BOARD_REFRESH_MS = 20000;
const WATCH_TICK_MS = 20000; // 观察池阶段机更新频率
const WATCH_TTL_MS = 6 * 60 * 60 * 1000; // 异动后最多观察 6 小时
const WATCH_PROFILE = process.env.WATCH_STRATEGY_PROFILE || 'volume';
const WATCH_STRATEGY = WATCH_PROFILE === 'legacy'
  ? DEFAULT_STRATEGY
  : WATCH_PROFILE === 'optimized'
    ? OPTIMIZED_STRATEGY
    : VOLUME_STRATEGY;
const WATCH_STORE_PATH = process.env.WATCH_STORE_PATH || path.join(__dirname, '..', 'data', 'watchlist.json'); // boards recompute ~20s (was 45s)
const TARGET_FEED = 100; // denser feed (~mercu anomaly-v4 size)
const BOARD_VALUE_N = 7;
const BOARD_STR_N = 8;
const BOARD_STR_POOL = 30; // top-N by |%| or $| then re-sort by strength
const BOARD_STICKY_BLEND = 0.42; // keep ~42% previous rank weight
const BOARD_HYSTERESIS_RANK = 2; // ignore 1-rank swaps
const BOARD_HYSTERESIS_PCT = 0.22; // % pts — keep old order if delta smaller
const BOARD_HYSTERESIS_USD_RATIO = 0.15; // relative value change for USD boards
const SPOT_API = process.env.BINANCE_SPOT || 'https://data-api.binance.vision';
const OTHER_EXCHANGES = ['OKX', 'Bybit', 'Bitget', 'HTX', 'Gate'];
const MAJOR_SYMBOLS = new Set(['BTC', 'ETH', 'BNB']);
const UNIVERSE_TOP_N = 180; // top USDT-M by 24h quote volume (+ curated crypto/美股)
const STABLE_BASES = new Set([
  'USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI', 'USDE', 'USD1', 'USDD', 'USDP', 'EUR', 'AEUR',
]);

/** Binance TradFi equity bases — used to tag category and force-include liquid names */
const US_STOCK_BASES = new Set(
  CURATED.filter((c) => c.category === '美股').map((c) => c.symbol)
);
const US_STOCK_MIN_QV = 5e6; // also pull other TradFi equities with ≥$5M 24h quote vol

// Hot boards — prefer ≥minPct for price value boards; backfill to VN with smaller |%| if needed
// Strength boards keep stricter quality (primary ≥minPct pool)
const BOARD_PRICE_MIN_PCT = { '15m': 1.0, '30m': 1.0, '1h': 0.9, '4h': 0.8, '1d': 0.7, '3d': 0.7 };
const BOARD_PRICE_DUST_PCT = 0.05; // backfill floor — skip pure noise |%| < 0.05%
const BOARD_PRICE_BACKFILL_MIN_QV = 5e4; // skip illiquid dust when backfilling
const BOARD_OI_MIN_DELTA = 1e5; // $100K min for OI value boards

// Anomaly thresholds — LARGE moves only (noise like −0.7% / +0.08% dropped)
const OI_PCT_SOFT_CAP = 8; // rarer above this (window soft-shrink)
const PRICE_ALT_MIN_PCT = 1.5; // mercu-like ~1.5%+ with notional quality
const PRICE_MAJOR_MIN_PCT = 1.0; // BTC/ETH/BNB
const PRICE_MAJOR_RELAX_PCT = 1.2;
const PRICE_NOTIONAL_MIN = 1e6; // ≥$1M for mid band
const PRICE_FORCE_PCT = 3.0;
const PRICE_ALT_FORCE_NOTIONAL = 5e5; // non-majors still need ≥$500K at |pct|≥3%
const OI_STRONG_PCT = 2.0;
const OI_STRONG_DELTA = 3e5; // $300K
const OI_DOLLAR_ONLY = 2e6; // $2M + ≥0.8%
const OI_SMALLCAP_PCT = 4.0;
const OI_SMALLCAP_DELTA = 2e5; // $200K
const OI_SKIP_PCT = 1.2; // skip micro-% unless huge $
const OI_SKIP_DELTA_OVERRIDE = 3e6;
const FLOW_BOARD_KEYS = [
  'oi_up_value', 'oi_down_value', 'perp_in_value', 'perp_out_value', 'spot_in_value', 'spot_out_value',
];
const STRENGTH_BOARD_KEYS = [
  'gainers_strength', 'losers_strength', 'oi_up_strength', 'oi_down_strength',
  'perp_in_strength', 'perp_out_strength', 'spot_in_strength', 'spot_out_strength',
];

function rand(min, max) { return Math.random() * (max - min) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/** $6.6M / $980.5K / +$6.6M — 1 decimal for K/M, + for positive */
function formatUsd(n, { signed = false } = {}) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : signed && n > 0 ? '+' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
function formatPct(n) {
  const sign = n > 0 ? '+' : '';
  return `${sign}${Number(n).toFixed(2)}%`;
}

/** mercu-style OI sentence units: +1.3亿 / -240万 */
function formatOiCn(n, { signed = true } = {}) {
  const abs = Math.abs(Number(n) || 0);
  const sign = n < 0 ? '-' : signed && n > 0 ? '+' : '';
  if (abs >= 1e8) {
    const v = abs / 1e8;
    const s = v >= 10 ? v.toFixed(0) : v.toFixed(1);
    return `${sign}${s.replace(/\.0$/, '')}亿`;
  }
  if (abs >= 1e4) return `${sign}${Math.round(abs / 1e4)}万`;
  return `${sign}${Math.round(abs)}`;
}

function dollarImpact(pricePct, quoteVol) {
  return (Math.abs(Number(pricePct) || 0) / 100) * Math.max(Number(quoteVol) || 0, 0);
}

function qualifiesPriceAnomaly(symbol, absPct, notional) {
  if (!(absPct > 0) || !Number.isFinite(absPct)) return false;
  const isMajor = MAJOR_SYMBOLS.has(symbol);
  const isBtcEth = symbol === 'BTC' || symbol === 'ETH';
  const n = Number(notional) || 0;
  // Drop under 2% unless BTC/ETH with abs>=1.5% AND huge volume
  if (absPct < PRICE_ALT_MIN_PCT) {
    if (!(isBtcEth && absPct >= PRICE_MAJOR_RELAX_PCT && n >= PRICE_NOTIONAL_MIN * 2)) {
      if (!(isMajor && absPct >= PRICE_MAJOR_MIN_PCT && n >= PRICE_NOTIONAL_MIN)) {
        return false;
      }
    }
  }
  // |pct|≥3%: majors ok; alts still need meaningful notional (anti tiny-alt spam)
  if (absPct >= PRICE_FORCE_PCT) {
    if (isMajor) return true;
    return n >= PRICE_ALT_FORCE_NOTIONAL;
  }
  if (n >= PRICE_NOTIONAL_MIN) return true;
  return false;
}

function qualifiesOiAnomaly(absPct, absDelta, symbol = '') {
  if (!(absDelta > 0) || !Number.isFinite(absPct)) return false;
  // Microscopic % is never an 异动 even with huge $ (BTC 0.08% noise)
  if (absPct < 0.5) return false;
  if (absPct < OI_SKIP_PCT && absDelta < OI_SKIP_DELTA_OVERRIDE) return false;
  if (absPct >= OI_STRONG_PCT && absDelta >= OI_STRONG_DELTA) return true;
  // Dollar-heavy majors: need ~1%+ band (not sub-1% noise) and >=$3M
  if (absDelta >= OI_DOLLAR_ONLY && absPct >= 0.8 && MAJOR_SYMBOLS.has(symbol)) return true;
  if (absDelta >= OI_DOLLAR_ONLY && absPct >= 0.8) return true;
  if (absPct >= OI_SMALLCAP_PCT && absDelta >= OI_SMALLCAP_DELTA) return true;
  // $5M override still needs meaningful % (>=0.5 already gated)
  if (absDelta >= OI_SKIP_DELTA_OVERRIDE && MAJOR_SYMBOLS.has(symbol)) return true;
  return false;
}

function anomalyMagnitude(a) {
  if (!a) return 0;
  if (a.eventKind === 'price') {
    const n = Math.abs(Number(a.notional) || 0);
    const p = Math.abs(Number(a.pricePct) || 0);
    // Prefer $ impact so liquid names outrank tiny-alt % spikes in TARGET_FEED
    if (n > 0) return Math.log10(n + 1) * 10 + p;
    return p;
  }
  const d = Math.abs(Number(a.oiDeltaAbs) || 0);
  if (d > 0) return Math.log10(d + 1) * 10 + Math.abs(Number(a.oiDeltaPct) || 0);
  return Math.abs(Number(a.oiDeltaPct) || 0);
}

function hhmm(ts) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Hong_Kong',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ts));
}
function effectiveVip(req) {
  if (!VIP_REQUIRED) return true;
  return Boolean(req.vip);
}

const bySymbol = new Map(CURATED.map((c) => [c.symbol, c]));
const byPair = new Map(CURATED.map((c) => [c.pair, c]));

function findMeta(symbol) {
  const s = String(symbol || '').toUpperCase();
  return bySymbol.get(s) || byPair.get(s) || byPair.get(`${s}USDT`) || null;
}

function bareBaseFromPair(pair) {
  let base = String(pair || '').toUpperCase().replace(/USDT$/, '');
  if (base.startsWith('1000000')) base = base.slice(7);
  else if (base.startsWith('1000')) base = base.slice(4);
  return base;
}

function registerUniverseMeta(pair, hint = null) {
  const existing = byPair.get(pair);
  if (existing) {
    if (hint?.category && existing.category === '永续') existing.category = hint.category;
    if (hint?.name && existing.name === existing.symbol) existing.name = hint.name;
    return existing;
  }
  let symbol = bareBaseFromPair(pair);
  if (bySymbol.has(symbol) && bySymbol.get(symbol).pair !== pair) {
    symbol = String(pair).toUpperCase().replace(/USDT$/, '');
  }
  const isStock = US_STOCK_BASES.has(symbol) || hint?.category === '美股';
  const meta = {
    symbol,
    pair,
    name: hint?.name || symbol,
    category: hint?.category || (isStock ? '美股' : '永续'),
  };
  if (isStock) US_STOCK_BASES.add(symbol);
  bySymbol.set(symbol, meta);
  byPair.set(pair, meta);
  return meta;
}

function activeMetas() {
  const map = new Map();
  for (const m of byPair.values()) map.set(m.pair, m);
  return [...map.values()];
}

// ——— live market state ———
/** @type {Map<string, object>} */
const market = new Map(); // symbol → live snapshot
let dataSource = 'seed'; // 'binance' | 'seed' | 'mixed'
let lastTickerAt = 0;
let lastOiPollAt = 0;
let boardsUpdatedAt = Date.now();
let anomalySeq = 1;
const anomalies = [];
const hotBoards = {};
/** @type {Record<string, Record<string, string[]>>} win → boardKey → ordered symbols */
const prevBoardSymbols = {};
const prevBoardRows = {}; // full prior rows for sticky blend
let lastBoardRebuildAt = 0;
let overview = {};
/** @type {null | {perpNet:number,spotNet:number,oiNet:number,upPct:number}} */
let summaryPrevSnap = null;
const seenAnomalyKeys = new Set(); // dedupe key: symbol|kind|bucketTs
/** per-symbol coin detail enrichment cache */
const coinEnrichCache = new Map(); // symbol → { at, data }
const COIN_ENRICH_TTL_MS = 30000;

/**
 * 异动后观察池：OI 异动自动入池，阶段机 + 双向入场计划 + 失效条件。
 * 纯内存运行；每 60s 落盘一次，重启后可恢复 6 小时内的观察。
 */
const watchlist = createWatchlist({ ttlMs: WATCH_TTL_MS, strategy: WATCH_STRATEGY });
let lastWatchSaveAt = 0;

function loadWatchStore() {
  try {
    if (!fs.existsSync(WATCH_STORE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(WATCH_STORE_PATH, 'utf8'));
    const out = watchlist.restore(raw);
    if (out.restored > 0) console.log(`[watch] restored ${out.restored} entries from ${WATCH_STORE_PATH}`);
  } catch (err) {
    console.warn('[watch] restore failed:', err.message);
  }
}

function saveWatchStore(force = false) {
  const now = Date.now();
  if (!force && now - lastWatchSaveAt < 60000) return;
  lastWatchSaveAt = now;
  try {
    fs.mkdirSync(path.dirname(WATCH_STORE_PATH), { recursive: true });
    fs.writeFileSync(WATCH_STORE_PATH, JSON.stringify(watchlist.dump()), 'utf8');
  } catch (err) {
    console.warn('[watch] save failed:', err.message);
  }
}

// Binance 在部分地区/网络下不可达：连续失败后短路一段时间，避免启动被上百个超时拖死
let binanceCooldownUntil = 0;
let binanceFailStreak = 0;
const BINANCE_FAIL_LIMIT = 3;
const BINANCE_COOLDOWN_MS = 45000;

function binanceCoolingDown() {
  return Date.now() < binanceCooldownUntil;
}

async function fetchJson(url, { timeoutMs = 8000 } = {}) {
  const isFapi = String(url).startsWith(FAPI);
  if (isFapi && binanceCoolingDown()) throw new Error('binance cooldown');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'EzRadar/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    if (isFapi) binanceFailStreak = 0;
    return await res.json();
  } catch (err) {
    const networkish = err && (
      err.name === 'AbortError'
      || err instanceof TypeError
      || /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|socket|network/i.test(err.message || '')
      || /^HTTP (403|451|5\d\d)/.test(err.message || '')
    );
    if (isFapi && networkish) {
      binanceFailStreak += 1;
      if (binanceFailStreak >= BINANCE_FAIL_LIMIT) binanceCooldownUntil = Date.now() + BINANCE_COOLDOWN_MS;
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        results[idx] = { error: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function ensureMarketRow(meta) {
  let row = market.get(meta.symbol);
  if (!row) {
    row = {
      symbol: meta.symbol,
      pair: meta.pair,
      name: meta.name,
      category: meta.category,
      region: null,
      price: 0,
      change24h: 0,
      quoteVolume24h: 0,
      high24h: 0,
      low24h: 0,
      oiUsdt: 0,
      oiHist: {}, // period → [{ts, oiUsdt}]
      priceHist5m: [], // [{ts, close}]
      funding: 0,
      markPrice: 0,
      // window metrics
      windows: {},
      lastUpdate: 0,
      source: 'seed',
    };
    market.set(meta.symbol, row);
  }
  return row;
}

function seedFallbackUniverse() {
  const seeds = {
    BTC: [82800, 7.6e9], ETH: [2440, 3.2e9], SOL: [178, 1.1e9], XRP: [0.55, 4.5e8],
    BNB: [610, 4.2e8], DOGE: [0.17, 3.8e8], PEPE: [0.0095, 2.8e8], WIF: [1.8, 1.5e8],
    CRV: [0.45, 9e7], ARB: [0.35, 1.4e8], SUI: [2.4, 3.5e8], LINK: [14.5, 1.8e8],
  };
  for (const meta of CURATED) {
    const row = ensureMarketRow(meta);
    const [p, oi] = seeds[meta.symbol] || [rand(0.05, 80), rand(2e7, 2.5e8)];
    row.price = p;
    row.change24h = Number(rand(-4, 4).toFixed(2));
    row.quoteVolume24h = oi * rand(0.4, 1.8);
    row.oiUsdt = oi;
    row.source = 'seed';
    for (const win of BOARD_WINDOWS) {
      const sign = Math.random() > 0.5 ? 1 : -1;
      const pct = Number((rand(0.3, 3.2) * sign).toFixed(2));
      // 15m OI delta: K–tens of M, not hundreds of M for midcaps
      const oiScale = Math.min(oi * 0.02, meta.symbol === 'BTC' || meta.symbol === 'ETH' ? 4e7 : 2.5e7);
      const oiDelta = Math.round(rand(0.15, 1) * oiScale) * sign;
      const oiPct = Number(((oiDelta / Math.max(oi, 1)) * 100).toFixed(2));
      const flow = Math.round(oiDelta * rand(0.4, 0.9));
      row.windows[win] = {
        pricePct: pct,
        oiDelta,
        oiPct: clamp(oiPct, -6, 6),
        flowEst: flow,
        spotEst: Math.round(flow * rand(0.35, 0.7)),
      };
    }
  }
  dataSource = 'seed';
}

/**
 * Patch short-window pricePct from live lastPrice vs kline anchor.
 * Lets 15m boards / anomalies move between slow OI+kline polls.
 */
function patchLiveWindowPrices() {
  for (const row of market.values()) {
    const live = Number(row.price) || 0;
    const hist5 = row.priceHist5m || [];
    if (!(live > 0) || hist5.length < 2) continue;
    for (const win of ['15m', '30m', '1h', '4h']) {
      const bars = windowBars(win);
      const from = hist5[Math.max(0, hist5.length - 1 - bars)] || hist5[0];
      if (!from?.close || !(from.close > 0)) continue;
      const pricePct = Number((((live - from.close) / from.close) * 100).toFixed(2));
      if (!row.windows[win]) {
        row.windows[win] = { pricePct, oiDelta: 0, oiPct: 0, flowEst: 0, spotEst: 0 };
      } else {
        row.windows[win].pricePct = pricePct;
      }
    }
  }
}

/** Emit price anomalies from live ticker vs last closed 5m open (fast path). */
function scanLivePriceAnomalies() {
  let added = 0;
  for (const row of market.values()) {
    const live = Number(row.price) || 0;
    const hist5 = row.priceHist5m || [];
    if (!(live > 0) || hist5.length < 1) continue;
    const cur = hist5[hist5.length - 1];
    const open = Number(cur?.open) || Number(cur?.close) || 0;
    if (!(open > 0)) continue;
    const pct = ((live - open) / open) * 100;
    const absPct = Math.abs(pct);
    if (absPct > 15) continue;
    const impact = dollarImpact(pct, row.quoteVolume24h);
    const candleQuote = Number(cur.quoteVol) || 0;
    const notional = Math.max(impact, candleQuote);
    if (!qualifiesPriceAnomaly(row.symbol, absPct, notional)) continue;
    const side = pct > 0 ? 'up' : 'down';
    const ev = EVENT_TYPES[side === 'up' ? 'price_surge' : 'price_dump'];
    const ts = cur.ts || Date.now();
    const ok = pushAnomaly({
      ts,
      symbol: row.symbol,
      name: row.name,
      category: row.category,
      region: null,
      event: ev.key,
      eventLabel: ev.label,
      eventKind: 'price',
      side,
      window: '5m',
      price: live,
      pricePct: Number(pct.toFixed(2)),
      oiDeltaAbs: row.windows['15m']?.oiDelta || 0,
      oiDeltaAbsDisplay: formatUsd(row.windows['15m']?.oiDelta || 0, { signed: true }),
      oiDeltaPct: row.windows['15m']?.oiPct || 0,
      notional: Math.round(notional),
      chips: {},
      source: row.source,
    });
    if (ok) {
      added += 1;
      anomalies[0].chips = makeChips(row, ev);
    }
  }
  if (added > 0) {
    trimAnomaliesToTarget();
    anomalies.sort((a, b) => {
      const td = b.ts - a.ts;
      if (td !== 0) return td;
      return anomalyMagnitude(b) - anomalyMagnitude(a);
    });
  }
  return added;
}

async function refreshTickers() {
  const now = Date.now();
  if (now - lastTickerAt < TICKER_TTL_MS) return;
  if (binanceCoolingDown()) {
    if (market.size === 0) seedFallbackUniverse();
    return;
  }
  try {
    const [tickers, premiums] = await Promise.all([
      fetchJson(`${FAPI}/fapi/v1/ticker/24hr`),
      fetchJson(`${FAPI}/fapi/v1/premiumIndex`),
    ]);
    if (!Array.isArray(tickers)) throw new Error('ticker not array');
    const premMap = new Map();
    if (Array.isArray(premiums)) {
      for (const p of premiums) premMap.set(p.symbol, p);
    }

    // Expand universe: top USDT-M by quote volume (exclude stables) ∪ curated
    const byTickerPair = new Map(tickers.map((t) => [t.symbol, t]));
    const usdtRanked = tickers
      .filter((t) => typeof t.symbol === 'string' && t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .filter((t) => {
        const bare = bareBaseFromPair(t.symbol);
        const raw = t.symbol.replace(/USDT$/, '');
        if (STABLE_BASES.has(bare) || STABLE_BASES.has(raw)) return false;
        return (Number(t.quoteVolume) || 0) > 0;
      })
      .sort((a, b) => (Number(b.quoteVolume) || 0) - (Number(a.quoteVolume) || 0));

    const selectedPairs = new Set();
    for (const meta of CURATED) {
      selectedPairs.add(meta.pair);
      registerUniverseMeta(meta.pair, meta);
    }
    // Extra liquid TradFi equities not already curated (auto-tag 美股)
    for (const t of usdtRanked) {
      const bare = bareBaseFromPair(t.symbol);
      const qv = Number(t.quoteVolume) || 0;
      // Heuristic: curated stock list ∪ high-vol tickers already known as 美股
      if (!US_STOCK_BASES.has(bare)) continue;
      if (qv < US_STOCK_MIN_QV && !CURATED.some((c) => c.pair === t.symbol)) continue;
      selectedPairs.add(t.symbol);
      registerUniverseMeta(t.symbol, { category: '美股', name: bare });
    }
    for (const t of usdtRanked) {
      if (selectedPairs.size >= UNIVERSE_TOP_N) break;
      selectedPairs.add(t.symbol);
      const bare = bareBaseFromPair(t.symbol);
      registerUniverseMeta(
        t.symbol,
        US_STOCK_BASES.has(bare) ? { category: '美股', name: bare } : null
      );
    }

    let hit = 0;
    for (const pair of selectedPairs) {
      const t = byTickerPair.get(pair);
      if (!t) continue;
      const meta = byPair.get(pair) || registerUniverseMeta(pair);
      const row = ensureMarketRow(meta);
      row.price = Number(t.lastPrice);
      row.change24h = Number(t.priceChangePercent);
      row.quoteVolume24h = Number(t.quoteVolume);
      row.high24h = Number(t.highPrice);
      row.low24h = Number(t.lowPrice);
      const prem = premMap.get(pair);
      if (prem) {
        row.funding = Number(prem.lastFundingRate) * 100; // to %
        row.markPrice = Number(prem.markPrice);
      }
      row.lastUpdate = now;
      row.source = 'binance';
      hit += 1;
    }
    lastTickerAt = now;
    if (hit > 0) dataSource = dataSource === 'seed' ? 'binance' : dataSource;
    if (hit > 40) dataSource = 'binance';
  } catch (err) {
    console.warn('[binance] ticker failed:', err.message);
    if (market.size === 0) seedFallbackUniverse();
  }
}

async function fetchOiHist(pair, period, limit = 12) {
  const url = `${FAPI}/futures/data/openInterestHist?symbol=${pair}&period=${period}&limit=${limit}`;
  const data = await fetchJson(url);
  if (!Array.isArray(data)) throw new Error('oi hist bad');
  return data.map((d) => ({
    ts: Number(d.timestamp),
    oiUsdt: Number(d.sumOpenInterestValue),
    oiContracts: Number(d.sumOpenInterest),
  }));
}

async function fetchKlines5m(pair, limit = 24) {
  const url = `${FAPI}/fapi/v1/klines?symbol=${pair}&interval=5m&limit=${limit}`;
  const data = await fetchJson(url);
  if (!Array.isArray(data)) throw new Error('klines bad');
  return data.map((k) => ({
    ts: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    quoteVol: Number(k[7]),
    takerBuyQuote: Number(k[10]),
  }));
}

function windowBars(win) {
  if (win === '15m') return 3;
  if (win === '30m') return 6;
  if (win === '1h') return 12;
  if (win === '4h') return 48;
  if (win === '1d') return 288;
  if (win === '3d') return 864;
  return 3;
}

function computeWindowMetrics(row) {
  const hist5 = row.priceHist5m || [];
  const oi5 = row.oiHist['5m'] || [];
  for (const win of BOARD_WINDOWS) {
    const bars = windowBars(win);
    let pricePct = 0;
    let oiDelta = 0;
    let oiPct = 0;
    let flowEst = 0;

    if (hist5.length >= 2 && hist5.length > bars) {
      const from = hist5[Math.max(0, hist5.length - 1 - bars)];
      const to = hist5[hist5.length - 1];
      if (from && to && from.close > 0) {
        pricePct = Number((((to.close - from.close) / from.close) * 100).toFixed(2));
      }
      // net aggressive buy estimate over window
      let buy = 0;
      let vol = 0;
      for (let i = Math.max(0, hist5.length - bars); i < hist5.length; i += 1) {
        buy += hist5[i].takerBuyQuote || 0;
        vol += hist5[i].quoteVol || 0;
      }
      flowEst = Math.round(2 * buy - vol); // positive = net buy pressure
    } else if (hist5.length >= 2 && (win === '15m' || win === '30m' || win === '1h' || win === '4h')) {
      // partial history: use widest available span
      const from = hist5[0];
      const to = hist5[hist5.length - 1];
      if (from && to && from.close > 0) {
        pricePct = Number((((to.close - from.close) / from.close) * 100).toFixed(2));
      }
      let buy = 0;
      let vol = 0;
      for (const k of hist5) {
        buy += k.takerBuyQuote || 0;
        vol += k.quoteVol || 0;
      }
      flowEst = Math.round(2 * buy - vol);
    } else if (win === '1d' || win === '3d') {
      // 5m hist cannot cover 1d/3d — use 24h ticker change (3d: no fake multiplier)
      pricePct = Number((row.change24h || 0).toFixed(2));
    }

    const period = WINDOW_TO_PERIOD[win];
    const oiSeries = row.oiHist[period] || oi5;
    if (oiSeries.length >= 2) {
      let fromOi;
      const toOi = oiSeries[oiSeries.length - 1];
      if (win === '3d' && oiSeries.length >= 4) {
        fromOi = oiSeries[oiSeries.length - 4]; // ~3 daily bars back
      } else if ((win === '15m' || win === '30m') && oiSeries.length >= 2) {
        fromOi = oiSeries[oiSeries.length - 2]; // derived 2-point window series
      } else if (oiSeries.length >= 2) {
        // 1h/4h/1d native period series: previous bar → current = one period
        fromOi = oiSeries[oiSeries.length - 2];
      }
      if (fromOi && toOi) {
        oiDelta = Math.round(toOi.oiUsdt - fromOi.oiUsdt);
        oiPct = fromOi.oiUsdt > 0 ? Number(((oiDelta / fromOi.oiUsdt) * 100).toFixed(2)) : 0;
        row.oiUsdt = toOi.oiUsdt;
      }
    }

    // Soft-cap absurd spikes from bad/missing hist (keep real if within soft band)
    if (Math.abs(oiPct) > 12) {
      // likely bad compare — shrink toward soft band while keeping sign
      oiPct = Number((Math.sign(oiPct) * clamp(Math.abs(oiPct) * 0.35, 1.2, OI_PCT_SOFT_CAP)).toFixed(2));
      oiDelta = Math.round((oiPct / 100) * Math.max(row.oiUsdt, 1));
    }

    // Spot estimate: weaker proxy from funding + flow (labeled 估算)
    const spotEst = Math.round(flowEst * 0.45 + (row.funding || 0) * (row.quoteVolume24h || 0) * 0.002);

    row.windows[win] = { pricePct, oiDelta, oiPct, flowEst, spotEst };
  }
}

async function refreshOiAndKlines() {
  const now = Date.now();
  if (now - lastOiPollAt < OI_POLL_MS - 2000 && lastOiPollAt > 0) return;
  if (binanceCoolingDown()) return;
  const metas = activeMetas().filter((m) => market.has(m.symbol));
  if (!metas.length) {
    for (const m of CURATED) ensureMarketRow(m);
  }
  const list = activeMetas().filter((m) => market.has(m.symbol));

  // 5m OI (60 pts → 4h), native 1h/4h/1d OI, 5m klines
  await mapPool(list, 6, async (meta) => {
    const row = ensureMarketRow(meta);
    try {
      const [oi5, oi1h, oi4h, oi1d, klines] = await Promise.all([
        fetchOiHist(meta.pair, '5m', 60),
        fetchOiHist(meta.pair, '1h', 8),
        fetchOiHist(meta.pair, '4h', 6),
        fetchOiHist(meta.pair, '1d', 5),
        fetchKlines5m(meta.pair, 360),
      ]);
      row.oiHist['5m'] = oi5;
      row.oiHist['1d'] = oi1d;
      // short windows from 5m endpoints; 1h/4h prefer native period series
      const derive = (bars) => {
        if (oi5.length <= bars) return oi5.length >= 2 ? [oi5[0], oi5[oi5.length - 1]] : oi5;
        return [oi5[oi5.length - 1 - bars], oi5[oi5.length - 1]];
      };
      row.oiHist['15m'] = derive(3);
      row.oiHist['30m'] = derive(6);
      row.oiHist['1h'] = oi1h && oi1h.length >= 2 ? oi1h : derive(12);
      row.oiHist['4h'] = oi4h && oi4h.length >= 2 ? oi4h : derive(48);
      row.priceHist5m = klines;
      if (oi5.length) row.oiUsdt = oi5[oi5.length - 1].oiUsdt;
      else if (oi1h?.length) row.oiUsdt = oi1h[oi1h.length - 1].oiUsdt;
      row.source = 'binance';
      computeWindowMetrics(row);
    } catch (err) {
      // Keep prior windows on fetch failure — NEVER invent random movers (causes batch jumps)
      if (!row.windows['15m']) {
        const z = { pricePct: 0, oiDelta: 0, oiPct: 0, flowEst: 0, spotEst: 0 };
        for (const w of BOARD_WINDOWS) {
          if (!row.windows[w]) row.windows[w] = { ...z };
        }
      }
    }
  });

  lastOiPollAt = Date.now();
  if ([...market.values()].some((r) => r.source === 'binance')) {
    dataSource = [...market.values()].every((r) => r.source === 'binance') ? 'binance' : 'mixed';
  }
}

function volFactor(quoteVol) {
  return clamp(Math.log10(Math.max(quoteVol || 0, 1e4)) / 9, 0.55, 1.1);
}
/** log-dollar core so BTC-scale $ outranks tiny-cap noise */
function dollarStrength(absUsd) {
  const logD = Math.log10(Math.max(Math.abs(absUsd) || 0, 1));
  // ~$1e5→12, $1e6→28, $1e7→44, $1e8→60, $1e9→76
  return clamp((logD - 4.2) * 16, 0, 78);
}
/**
 * Strength is intentionally NOT monotonic with |pct| or raw $| alone.
 * Value boards rank by |%| / |$|; Str boards emphasize $ notional impact + liquidity
 * (and for OI, oiPct), so high-% illiquids and high-strength liquids diverge.
 */
function strengthFromPct(pct, quoteVol = 0) {
  const a = Math.abs(Number(pct) || 0);
  const impact = dollarImpact(a, quoteVol);
  const d = dollarStrength(impact); // log-$ of %-move × 24h quote
  const liq = clamp((Math.log10(Math.max(quoteVol || 0, 1e5)) - 5) * 14, -12, 36);
  const q = quoteVol || 0;
  const illiquidPenalty = q < 1.2e7 ? 14 : (q < 4e7 ? 6 : 0);
  // Soft |pct| term so Str ≠ value sort (was a*7.5 dominating)
  const pctPart = clamp(a * 3.6, 0, 24);
  return Math.round(clamp(18 + d * 0.62 + pctPart + liq * 0.42 - illiquidPenalty, 14, 92));
}
function strengthFromOi(oiPct, oiDelta, quoteVol = 0) {
  const d = dollarStrength(oiDelta);
  // Heavier oiPct vs raw $ so Str surfaces different names than oi value boards
  const p = clamp(Math.abs(Number(oiPct) || 0) * 5.8, 0, 34);
  const liq = clamp((Math.log10(Math.max(quoteVol || 0, 1e5)) - 6) * 5, -8, 14);
  return Math.round(clamp(20 + d * 0.45 + p + liq, 14, 92));
}
function strengthFromFlow(flow, quoteVol = 0) {
  const d = dollarStrength(flow);
  const liq = clamp((Math.log10(Math.max(quoteVol || 0, 1e5)) - 6) * 6, -8, 16);
  // Mild inverse-size tilt: same $ on smaller book scores a bit higher
  const conc = clamp(14 - (Math.log10(Math.max(quoteVol || 0, 1e6)) - 6) * 4, -4, 12);
  return Math.round(clamp(24 + d * 0.58 + liq * 0.55 + conc * 0.35, 14, 88));
}

/** Deterministic tick marks — avoid random flicker on every poll */
function stableTicks(symbol, side, n = 6) {
  let h = 2166136261;
  const s = `${symbol}|${side}`;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Array.from({ length: n }, (_, i) => {
    const v = ((h >>> (i * 4)) & 15) / 15;
    return Number((0.22 + v * 0.72).toFixed(2));
  });
}
function makeTicks(side, n = 6, symbol = 'X') {
  return stableTicks(symbol, side, n);
}

/**
 * Blend previous top-N with new ranking so boards don't flash a wholly new set.
 * Candidates = new top (keepN*2) ∪ previous top keepN; score = blend(newRank, oldRank).
 * Drop only if new rank fell beyond keepN*2.5 (or missing from new list).
 */
function mergeStickyBoard(rawRows, prevRows, { keepN = BOARD_VALUE_N } = {}) {
  if (!Array.isArray(rawRows) || !rawRows.length) return [];
  const capped = rawRows.map((r, i) => ({ ...r, rank: i + 1 }));
  if (!Array.isArray(prevRows) || prevRows.length < 1) {
    return capped.slice(0, keepN).map((r, i) => ({ ...r, rank: i + 1 }));
  }
  const bySym = new Map(capped.map((r) => [r.symbol, r]));
  const newIdx = new Map(capped.map((r, i) => [r.symbol, i]));
  const prevIdx = new Map(prevRows.map((r, i) => [r.symbol, i]));
  const cand = new Set([
    ...capped.slice(0, Math.max(keepN * 2, keepN + 4)).map((r) => r.symbol),
    ...prevRows.slice(0, keepN).map((r) => r.symbol),
  ]);
  const blend = clamp(BOARD_STICKY_BLEND, 0, 0.75);
  const scored = [];
  for (const sym of cand) {
    const r = bySym.get(sym);
    if (!r) continue; // left universe / failed filter — allow drop
    const ni = newIdx.get(sym);
    const pi = prevIdx.has(sym) ? prevIdx.get(sym) : keepN + 3;
    if (ni >= keepN * 2.5 && !prevIdx.has(sym)) continue;
    if (ni >= keepN * 3) continue; // fallen far — drop even if previously shown
    const sticky = ni * (1 - blend) + pi * blend;
    scored.push({ r, sticky, ni });
  }
  // Ensure we still fill from pure new order if blend filtered too hard
  if (scored.length < Math.min(keepN, capped.length)) {
    for (const r of capped) {
      if (scored.some((x) => x.r.symbol === r.symbol)) continue;
      scored.push({ r, sticky: r.rank + 50, ni: r.rank });
      if (scored.length >= keepN) break;
    }
  }
  scored.sort((a, b) => a.sticky - b.sticky || a.ni - b.ni);
  return scored.slice(0, keepN).map((x, i) => ({ ...x.r, rank: i + 1 }));
}

/** Keep adjacent ranks sticky unless move ≥2 places or value moved enough */
function applyRankHysteresis(rawRows, prevSymbols, { isPct = false } = {}) {
  if (!Array.isArray(rawRows) || !rawRows.length) return rawRows || [];
  if (!Array.isArray(prevSymbols) || prevSymbols.length < 2) {
    return rawRows.map((r, i) => ({ ...r, rank: i + 1 }));
  }
  const bySym = new Map(rawRows.map((r) => [r.symbol, r]));
  const newOrder = rawRows.map((r) => r.symbol);
  const prevIdx = new Map(prevSymbols.map((s, i) => [s, i]));

  // Sticky score = newIndex, but penalize tiny adjacent swaps back to prev order
  const scored = rawRows.map((r) => {
    const ni = newOrder.indexOf(r.symbol);
    const pi = prevIdx.has(r.symbol) ? prevIdx.get(r.symbol) : ni + 3;
    let sticky = ni;
    if (Math.abs(ni - pi) === 1) {
      const otherSym = prevSymbols[ni];
      const other = otherSym ? bySym.get(otherSym) : null;
      if (other && other.symbol !== r.symbol) {
        const gap = Math.abs(Number(r.value) - Number(other.value));
        const need = isPct
          ? BOARD_HYSTERESIS_PCT
          : Math.max(Math.abs(Number(r.value)), Math.abs(Number(other.value)), 1) * BOARD_HYSTERESIS_USD_RATIO;
        if (gap < need) sticky = pi; // prefer old position
      }
    }
    return { r, sticky, ni };
  });
  scored.sort((a, b) => a.sticky - b.sticky || a.ni - b.ni);
  return scored.map((x, i) => ({ ...x.r, rank: i + 1 }));
}

function rebuildHotBoards() {
  const rows = [...market.values()].filter((r) => r.price > 0 || r.windows['15m']);
  if (!rows.length) return;

  for (const win of BOARD_WINDOWS) {
    if (!hotBoards[win]) hotBoards[win] = {};
    if (!prevBoardSymbols[win]) prevBoardSymbols[win] = {};
    const scored = rows.map((r) => {
      const w = r.windows[win] || r.windows['15m'] || {
        pricePct: 0, oiDelta: 0, oiPct: 0, flowEst: 0, spotEst: 0,
      };
      return { r, w };
    });

    function topBy(pred, sortKey, limit = 8) {
      return scored
        .filter(pred)
        .sort((a, b) => sortKey(b) - sortKey(a))
        .slice(0, limit);
    }

    // Value boards prefer ≥minPct movers; backfill to VN with smaller |%| (skip dust)
    const minPct = BOARD_PRICE_MIN_PCT[win] || 1.0;
    const VN = BOARD_VALUE_N;
    const SN = BOARD_STR_N;
    const POOL = BOARD_STR_POOL;

    function pickPctBoard(side) {
      const wantPos = side === 'up';
      const sortPct = (a, b) => Math.abs(b.w.pricePct) - Math.abs(a.w.pricePct)
        || (b.r.quoteVolume24h || 0) - (a.r.quoteVolume24h || 0);
      const primary = scored
        .filter((x) => (wantPos ? x.w.pricePct > 0 : x.w.pricePct < 0)
          && Math.abs(x.w.pricePct) >= minPct)
        .sort(sortPct);
      const picked = primary.slice(0, VN);
      if (picked.length < VN) {
        const have = new Set(picked.map((x) => x.r.symbol));
        const fillers = scored
          .filter((x) => (wantPos ? x.w.pricePct > 0 : x.w.pricePct < 0)
            && !have.has(x.r.symbol)
            && Math.abs(x.w.pricePct) >= BOARD_PRICE_DUST_PCT
            && (x.r.quoteVolume24h || 0) >= BOARD_PRICE_BACKFILL_MIN_QV)
          .sort(sortPct);
        for (const x of fillers) {
          if (picked.length >= VN) break;
          picked.push(x);
        }
      }
      // Strength pool stays stricter: prefer ≥minPct, then widen with value-board rows
      const pool = primary.slice(0, POOL);
      if (pool.length < Math.min(POOL, 12)) {
        const have = new Set(pool.map((x) => x.r.symbol));
        for (const x of picked) {
          if (pool.length >= POOL) break;
          if (!have.has(x.r.symbol)) {
            pool.push(x);
            have.add(x.r.symbol);
          }
        }
      }
      return { rows: picked, pool };
    }

    // Gainers/Losers「按涨跌幅」: always try to fill VN (<% OK via dust floor); Str uses quality pool
    const gainerPick = pickPctBoard('up');
    const gainers = gainerPick.rows;
    const gainersPool = gainerPick.pool;
    const gainerValSet = new Set(gainers.map((x) => x.r.symbol));
    const loserPick = pickPctBoard('down');
    // Avoid duplicate symbols already on gainer value board (rare: sign conflict)
    const losers = loserPick.rows.filter((x) => !gainerValSet.has(x.r.symbol)).slice(0, VN);
    if (losers.length < VN) {
      const have = new Set([...gainerValSet, ...losers.map((x) => x.r.symbol)]);
      const fillers = scored
        .filter((x) => x.w.pricePct < 0
          && !have.has(x.r.symbol)
          && Math.abs(x.w.pricePct) >= BOARD_PRICE_DUST_PCT
          && (x.r.quoteVolume24h || 0) >= BOARD_PRICE_BACKFILL_MIN_QV)
        .sort((a, b) => Math.abs(b.w.pricePct) - Math.abs(a.w.pricePct)
          || (b.r.quoteVolume24h || 0) - (a.r.quoteVolume24h || 0));
      for (const x of fillers) {
        if (losers.length >= VN) break;
        losers.push(x);
        have.add(x.r.symbol);
      }
    }
    const losersPool = loserPick.pool.filter((x) => !gainerValSet.has(x.r.symbol)).slice(0, POOL);

    const oiUpAll = scored
      .filter((x) => x.w.oiDelta > 0 && Math.abs(x.w.oiDelta) >= BOARD_OI_MIN_DELTA)
      .sort((a, b) => b.w.oiDelta - a.w.oiDelta);
    const oiUp = oiUpAll.slice(0, VN);
    const oiUpPool = oiUpAll.slice(0, POOL);
    const oiUpSet = new Set(oiUp.map((x) => x.r.symbol));
    const oiDownAll = scored
      .filter((x) => x.w.oiDelta < 0 && !oiUpSet.has(x.r.symbol) && Math.abs(x.w.oiDelta) >= BOARD_OI_MIN_DELTA)
      .sort((a, b) => a.w.oiDelta - b.w.oiDelta);
    const oiDown = oiDownAll.slice(0, VN);
    const oiDownPool = oiDownAll.slice(0, POOL);

    const perpInAll = scored.filter((x) => x.w.flowEst > 0).sort((a, b) => b.w.flowEst - a.w.flowEst);
    const perpIn = perpInAll.slice(0, VN);
    const perpInPool = perpInAll.slice(0, POOL);
    const perpInSet = new Set(perpIn.map((x) => x.r.symbol));
    const perpOutAll = scored.filter((x) => x.w.flowEst < 0 && !perpInSet.has(x.r.symbol)).sort((a, b) => a.w.flowEst - b.w.flowEst);
    const perpOut = perpOutAll.slice(0, VN);
    const perpOutPool = perpOutAll.slice(0, POOL);

    const spotInAll = scored.filter((x) => x.w.spotEst > 0).sort((a, b) => b.w.spotEst - a.w.spotEst);
    const spotIn = spotInAll.slice(0, VN);
    const spotInPool = spotInAll.slice(0, POOL);
    const spotInSet = new Set(spotIn.map((x) => x.r.symbol));
    const spotOutAll = scored.filter((x) => x.w.spotEst < 0 && !spotInSet.has(x.r.symbol)).sort((a, b) => a.w.spotEst - b.w.spotEst);
    const spotOut = spotOutAll.slice(0, VN);
    const spotOutPool = spotOutAll.slice(0, POOL);

    function toPctRows(list, side) {
      return list.map((x, i) => {
        const str = strengthFromPct(x.w.pricePct, x.r.quoteVolume24h);
        const impact = dollarImpact(x.w.pricePct, x.r.quoteVolume24h);
        return {
          symbol: x.r.symbol,
          name: x.r.name,
          category: x.r.category,
          region: null,
          value: x.w.pricePct, // hysteresis by %
          display: formatPct(x.w.pricePct),
          auxDisplay: formatUsd(impact),
          pct: x.w.pricePct,
          mag: Math.abs(x.w.pricePct),
          impact,
          strength: str,
          bar: str,
          ticks: makeTicks(side, 6, x.r.symbol),
          side,
          rank: i + 1,
          resonance: [],
          resonanceLong: [],
        };
      });
    }
    function toOiValueRows(list, side) {
      return list.map((x, i) => {
        const str = strengthFromOi(x.w.oiPct, x.w.oiDelta, x.r.quoteVolume24h);
        return {
          symbol: x.r.symbol,
          name: x.r.name,
          category: x.r.category,
          region: null,
          value: x.w.oiDelta,
          display: formatUsd(x.w.oiDelta, { signed: true }),
          mag: Math.abs(x.w.oiDelta),
          strength: str,
          bar: str,
          ticks: makeTicks(side, 6, x.r.symbol),
          side,
          rank: i + 1,
          resonance: [],
          resonanceLong: [],
        };
      });
    }
    function toStrengthRows(list, side, kind) {
      return list.map((x, i) => {
        let str;
        let auxDisplay;
        if (kind === 'pct') {
          str = strengthFromPct(x.w.pricePct, x.r.quoteVolume24h);
          auxDisplay = formatPct(x.w.pricePct);
        } else if (kind === 'oi') {
          str = strengthFromOi(x.w.oiPct, x.w.oiDelta, x.r.quoteVolume24h);
          auxDisplay = formatUsd(x.w.oiDelta, { signed: true });
        } else if (kind === 'spot') {
          str = strengthFromFlow(x.w.spotEst, x.r.quoteVolume24h);
          auxDisplay = formatUsd(x.w.spotEst, { signed: true });
        } else {
          str = strengthFromFlow(x.w.flowEst, x.r.quoteVolume24h);
          auxDisplay = formatUsd(x.w.flowEst, { signed: true });
        }
        return {
          symbol: x.r.symbol,
          name: x.r.name,
          category: x.r.category,
          region: null,
          value: str * (side === 'down' ? -1 : 1),
          display: String(str),
          auxDisplay,
          strength: str,
          bar: str,
          ticks: makeTicks(side, 6, x.r.symbol),
          side,
          rank: i + 1,
          resonance: [],
          resonanceLong: [],
        };
      });
    }
    function toFlowValueRows(list, side, field) {
      return list.map((x, i) => {
        const v = field === 'spot' ? x.w.spotEst : x.w.flowEst;
        const str = strengthFromFlow(v, x.r.quoteVolume24h);
        return {
          symbol: x.r.symbol,
          name: x.r.name,
          category: x.r.category,
          region: null,
          value: v,
          display: formatUsd(v, { signed: true }),
          mag: Math.abs(v),
          strength: str,
          bar: str,
          ticks: makeTicks(side, 6, x.r.symbol),
          side,
          rank: i + 1,
          estimated: true,
          resonance: [],
          resonanceLong: [],
        };
      });
    }

    // Strength boards: WIDER pool (top POOL by |%|/$), then re-rank by strength → take SN
    // This is what makes Str diverge from value (same 7 re-sorted → identical lists).
    const gainersByStr = [...gainersPool]
      .sort((a, b) => strengthFromPct(b.w.pricePct, b.r.quoteVolume24h) - strengthFromPct(a.w.pricePct, a.r.quoteVolume24h))
      .slice(0, SN);
    const losersByStr = [...losersPool]
      .sort((a, b) => strengthFromPct(b.w.pricePct, b.r.quoteVolume24h) - strengthFromPct(a.w.pricePct, a.r.quoteVolume24h))
      .slice(0, SN);
    const oiUpByStr = [...oiUpPool]
      .sort((a, b) => strengthFromOi(b.w.oiPct, b.w.oiDelta, b.r.quoteVolume24h) - strengthFromOi(a.w.oiPct, a.w.oiDelta, a.r.quoteVolume24h))
      .slice(0, SN);
    const oiDownByStr = [...oiDownPool]
      .sort((a, b) => strengthFromOi(b.w.oiPct, b.w.oiDelta, b.r.quoteVolume24h) - strengthFromOi(a.w.oiPct, a.w.oiDelta, a.r.quoteVolume24h))
      .slice(0, SN);
    const perpInByStr = [...perpInPool]
      .sort((a, b) => strengthFromFlow(b.w.flowEst, b.r.quoteVolume24h) - strengthFromFlow(a.w.flowEst, a.r.quoteVolume24h))
      .slice(0, SN);
    const perpOutByStr = [...perpOutPool]
      .sort((a, b) => strengthFromFlow(Math.abs(b.w.flowEst), b.r.quoteVolume24h) - strengthFromFlow(Math.abs(a.w.flowEst), a.r.quoteVolume24h))
      .slice(0, SN);
    const spotInByStr = [...spotInPool]
      .sort((a, b) => strengthFromFlow(Math.abs(b.w.spotEst), b.r.quoteVolume24h) - strengthFromFlow(Math.abs(a.w.spotEst), a.r.quoteVolume24h))
      .slice(0, SN);
    const spotOutByStr = [...spotOutPool]
      .sort((a, b) => strengthFromFlow(Math.abs(b.w.spotEst), b.r.quoteVolume24h) - strengthFromFlow(Math.abs(a.w.spotEst), a.r.quoteVolume24h))
      .slice(0, SN);

    const builders = {
      gainers_value: () => toPctRows(gainers, 'up'),
      losers_value: () => toPctRows(losers, 'down'),
      gainers_strength: () => toStrengthRows(gainersByStr, 'up', 'pct'),
      losers_strength: () => toStrengthRows(losersByStr, 'down', 'pct'),
      oi_up_value: () => toOiValueRows(oiUp, 'up'),
      oi_down_value: () => toOiValueRows(oiDown, 'down'),
      oi_up_strength: () => toStrengthRows(oiUpByStr, 'up', 'oi'),
      oi_down_strength: () => toStrengthRows(oiDownByStr, 'down', 'oi'),
      perp_in_value: () => toFlowValueRows(perpIn, 'up', 'perp'),
      perp_out_value: () => toFlowValueRows(perpOut, 'down', 'perp'),
      perp_in_strength: () => toStrengthRows(perpInByStr, 'up', 'flow'),
      perp_out_strength: () => toStrengthRows(perpOutByStr, 'down', 'flow'),
      spot_in_value: () => toFlowValueRows(spotIn, 'up', 'spot'),
      spot_out_value: () => toFlowValueRows(spotOut, 'down', 'spot'),
      spot_in_strength: () => toStrengthRows(spotInByStr, 'up', 'spot'),
      spot_out_strength: () => toStrengthRows(spotOutByStr, 'down', 'spot'),
    };

    if (!prevBoardRows[win]) prevBoardRows[win] = {};
    for (const kind of BOARD_KINDS) {
      let list = (builders[kind.key] || (() => []))();
      const isPct = kind.metric === 'pct' || kind.strengthOf === 'pct';
      const keepN = kind.metric === 'strength' ? SN : VN;
      // 1) sticky blend vs previous snapshot (anti batch-jump)
      list = mergeStickyBoard(list, prevBoardRows[win][kind.key], { keepN });
      // 2) adjacent-swap hysteresis on blended list
      list = applyRankHysteresis(list, prevBoardSymbols[win][kind.key], { isPct });
      prevBoardSymbols[win][kind.key] = list.map((r) => r.symbol);
      prevBoardRows[win][kind.key] = list;
      hotBoards[win][kind.key] = {
        ...kind,
        window: win,
        rows: list,
        updatedAt: Date.now(),
        note: kind.estimated ? '估算（主动买卖/资金费率代理）' : undefined,
      };
    }
  }
  attachBoardResonance();
  boardsUpdatedAt = Date.now();
  lastBoardRebuildAt = boardsUpdatedAt;
  emitResonanceAnomalies();
}

/** Cross-window same-side presence → resonance[] / resonanceLong[] */
function attachBoardResonance() {
  const shortWins = ['15m', '30m', '1h', '4h'];
  const longWins = ['1d', '3d'];
  for (const win of BOARD_WINDOWS) {
    for (const kind of BOARD_KINDS) {
      const board = hotBoards[win]?.[kind.key];
      if (!board?.rows) continue;
      for (const row of board.rows) {
        const short = [];
        const long = [];
        for (const other of BOARD_WINDOWS) {
          if (other === win) continue;
          const ob = hotBoards[other]?.[kind.key];
          if (!ob?.rows) continue;
          const hit = ob.rows.some((r) => r.symbol === row.symbol && r.side === row.side);
          if (!hit) continue;
          if (longWins.includes(other)) long.push(other);
          else if (shortWins.includes(other)) short.push(other);
        }
        row.resonance = short;
        row.resonanceLong = long;
      }
    }
  }
}

/** Bull/bear resonance cards when symbol hits ≥3 same-side flow boards on 15m */
function emitResonanceAnomalies() {
  const boardWin = hotBoards['15m'] || {};
  const map = new Map();
  for (const key of FLOW_BOARD_KEYS) {
    const b = boardWin[key];
    if (!b?.rows) continue;
    for (const row of b.rows.slice(0, 7)) {
      const cur = map.get(row.symbol) || { symbol: row.symbol, name: row.name, category: row.category, up: 0, down: 0 };
      if (row.side === 'up') cur.up += 1;
      else cur.down += 1;
      map.set(row.symbol, cur);
    }
  }
  const now = Date.now();
  for (const s of map.values()) {
    const bull = s.up >= 3 && s.up > s.down;
    const bear = s.down >= 3 && s.down > s.up;
    if (!bull && !bear) continue;
    const side = bull ? 'up' : 'down';
    const label = bull ? '多头共振' : '空头共振';
    const event = bull ? 'bull_resonance' : 'bear_resonance';
    const row = market.get(s.symbol);
    pushAnomaly({
      ts: now - (now % (5 * 60 * 1000)),
      symbol: s.symbol,
      name: s.name || s.symbol,
      category: s.category || row?.category || '永续',
      region: null,
      event,
      eventLabel: label,
      eventKind: 'state',
      side,
      window: '5m',
      price: row?.price || 0,
      pricePct: row?.windows?.['15m']?.pricePct || 0,
      oiDeltaAbs: row?.windows?.['15m']?.oiDelta || 0,
      oiDeltaAbsDisplay: formatUsd(row?.windows?.['15m']?.oiDelta || 0, { signed: true }),
      oiDeltaPct: row?.windows?.['15m']?.oiPct || 0,
      boardHits: bull ? s.up : s.down,
      chips: {},
      source: row?.source || dataSource,
    });
  }
}

function makeChips(row, ev) {
  // Self rank = position among universe by |metric|; hide if absurd
  const all = [...market.values()];
  let selfRank = null;
  if (ev.kind === 'oi') {
    const sorted = [...all].sort((a, b) => Math.abs((b.windows['15m']?.oiPct) || 0) - Math.abs((a.windows['15m']?.oiPct) || 0));
    const idx = sorted.findIndex((x) => x.symbol === row.symbol);
    if (idx >= 0 && idx < 48) selfRank = idx + 1;
  } else {
    const sorted = [...all].sort((a, b) => Math.abs((b.windows['15m']?.pricePct) || 0) - Math.abs((a.windows['15m']?.pricePct) || 0));
    const idx = sorted.findIndex((x) => x.symbol === row.symbol);
    if (idx >= 0 && idx < 48) selfRank = idx + 1;
  }
  const chips = {};
  if (selfRank != null) chips.self = selfRank;
  // market strength / value ranks from board presence
  const board = hotBoards['15m'];
  if (board) {
    let mktS = null;
    let mktV = null;
    for (const k of BOARD_KINDS) {
      const b = board[k.key];
      if (!b) continue;
      const found = (b.rows || []).findIndex((r) => r.symbol === row.symbol);
      if (found >= 0) {
        if (k.metric === 'strength' && mktS == null) mktS = found + 1;
        if (k.metric !== 'strength' && mktV == null) mktV = found + 1;
      }
    }
    if (mktS != null) chips.mktStrength = mktS;
    if (mktV != null) chips.mktValue = mktV;
  }
  return chips;
}

function buildLastLine(a) {
  if (a.eventKind === 'state') {
    const n = a.boardHits || 0;
    return `5 分钟内 ${a.eventLabel || '共振'} · ${n} 榜同向`;
  }
  if (a.eventKind === 'price') {
    const p = Number(a.pricePct) || 0;
    return `5 分钟内 价格 ${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
  }
  // OI primary as Chinese $ sentence; optional pct
  const oiPart = formatOiCn(a.oiDeltaAbs, { signed: true });
  const pct = Number(a.oiDeltaPct);
  const pctPart = Number.isFinite(pct) && Math.abs(pct) >= 0.3 ? ` (${formatPct(pct)})` : '';
  return `5 分钟内 oi ${oiPart}${pctPart}`;
}

function trimAnomaliesToTarget() {
  if (anomalies.length <= TARGET_FEED) return;
  // Keep highest $ impact; then re-order newest first for UI
  anomalies.sort((a, b) => anomalyMagnitude(b) - anomalyMagnitude(a) || b.ts - a.ts);
  anomalies.length = TARGET_FEED;
  anomalies.sort((a, b) => {
    const td = b.ts - a.ts;
    if (td !== 0) return td;
    return anomalyMagnitude(b) - anomalyMagnitude(a);
  });
}

function pushAnomaly(partial) {
  const bucket = Math.floor(partial.ts / (5 * 60 * 1000)); // 5m bucket
  const key = `${partial.symbol}|${partial.event}|${bucket}`;
  if (seenAnomalyKeys.has(key)) return false;
  seenAnomalyKeys.add(key);
  const a = {
    id: `a-${anomalySeq++}`,
    ...partial,
    ageSec: Math.max(0, Math.floor((Date.now() - partial.ts) / 1000)),
    timeLabel: hhmm(partial.ts),
  };
  a.lastLine = buildLastLine(a);
  anomalies.unshift(a);
  if (anomalies.length > TARGET_FEED) trimAnomaliesToTarget();
  // OI 异动自动进入观察池；价格异动只进异动流，不单独开观察
  if (a.eventKind === 'oi') {
    try {
      watchlist.register(a, market.get(a.symbol), market.get('BTC'));
    } catch (err) {
      console.warn('[watch] register failed:', err.message);
    }
  }
  return true;
}

/** Scan OI 5m hist + price klines — LARGE moves only; immutable once emitted */
function scanForAnomalies({ bootstrap = false } = {}) {
  let added = 0;
  const maxBootstrap = bootstrap ? TARGET_FEED : 28;

  for (const row of market.values()) {
    const oi5 = row.oiHist['5m'] || [];
    // Walk recent consecutive OI points (more history on bootstrap to fill large-only feed)
    const start = bootstrap ? Math.max(1, oi5.length - 36) : Math.max(1, oi5.length - 4);
    for (let i = start; i < oi5.length; i += 1) {
      if (added >= maxBootstrap) break;
      const prev = oi5[i - 1];
      const cur = oi5[i];
      if (!prev?.oiUsdt || !cur?.oiUsdt) continue;
      const delta = cur.oiUsdt - prev.oiUsdt;
      const absDelta = Math.abs(delta);
      const pct = (delta / prev.oiUsdt) * 100;
      const absPct = Math.abs(pct);
      if (!qualifiesOiAnomaly(absPct, absDelta, row.symbol)) continue;
      // Sanity: skip absurd midcap spikes / data glitches
      if (absPct > 25) continue;
      if (absPct > 18 && row.oiUsdt < 5e8) continue;
      if (absDelta > row.oiUsdt * 0.35 && absPct > 15) continue;

      const side = delta > 0 ? 'up' : 'down';
      const ev = EVENT_TYPES[side === 'up' ? 'oi_surge' : 'oi_dump'];
      const ok = pushAnomaly({
        ts: cur.ts,
        symbol: row.symbol,
        name: row.name,
        category: row.category,
        region: null,
        event: ev.key,
        eventLabel: ev.label,
        eventKind: 'oi',
        side,
        window: '5m',
        price: row.price,
        pricePct: row.windows['15m']?.pricePct || 0,
        oiDeltaAbs: Math.round(delta),
        oiDeltaAbsDisplay: formatUsd(delta, { signed: true }),
        oiDeltaPct: Number(pct.toFixed(2)),
        chips: {},
        source: row.source,
      });
      if (ok) {
        added += 1;
        const a = anomalies[0];
        a.chips = makeChips(row, ev);
      }
    }

    // Price 5m moves from klines — large amplitude + notional only
    const kl = row.priceHist5m || [];
    const kStart = bootstrap ? Math.max(1, kl.length - 36) : Math.max(1, kl.length - 4);
    for (let i = kStart; i < kl.length; i += 1) {
      if (added >= maxBootstrap) break;
      const prev = kl[i - 1];
      const cur = kl[i];
      if (!prev?.open || !cur?.close) continue;
      const pct = ((cur.close - prev.open) / prev.open) * 100;
      const absPct = Math.abs(pct);
      if (absPct > 15) continue; // glitch guard
      const impact = dollarImpact(pct, row.quoteVolume24h);
      const candleQuote = Number(cur.quoteVol) || 0;
      const notional = Math.max(impact, candleQuote);
      if (!qualifiesPriceAnomaly(row.symbol, absPct, notional)) continue;

      const side = pct > 0 ? 'up' : 'down';
      const ev = EVENT_TYPES[side === 'up' ? 'price_surge' : 'price_dump'];
      const ok = pushAnomaly({
        ts: cur.ts,
        symbol: row.symbol,
        name: row.name,
        category: row.category,
        region: null,
        event: ev.key,
        eventLabel: ev.label,
        eventKind: 'price',
        side,
        window: '5m',
        price: cur.close,
        pricePct: Number(pct.toFixed(2)),
        oiDeltaAbs: row.windows['15m']?.oiDelta || 0,
        oiDeltaAbsDisplay: formatUsd(row.windows['15m']?.oiDelta || 0, { signed: true }),
        oiDeltaPct: row.windows['15m']?.oiPct || 0,
        notional: Math.round(notional),
        chips: {},
        source: row.source,
      });
      if (ok) {
        added += 1;
        anomalies[0].chips = makeChips(row, ev);
      }
    }
  }

  // Prefer $ impact when over target; display newest first
  trimAnomaliesToTarget();
  anomalies.sort((a, b) => {
    const td = b.ts - a.ts;
    if (td !== 0) return td;
    return anomalyMagnitude(b) - anomalyMagnitude(a);
  });
  return added;
}

/** Update only age/timeLabel + live price on cards — NEVER mutate historical % / OI deltas */
function refreshAnomalyMeta() {
  const now = Date.now();
  for (const a of anomalies) {
    a.ageSec = Math.max(0, Math.floor((now - a.ts) / 1000));
    a.timeLabel = hhmm(a.ts);
    const row = market.get(a.symbol);
    if (row?.price) a.price = row.price;
  }
}

function scoreBoardKeys(keys, { topN = 7 } = {}) {
  const boardWin = hotBoards['15m'] || {};
  const map = new Map();
  for (const key of keys) {
    const b = boardWin[key];
    if (!b?.rows) continue;
    for (const row of b.rows.slice(0, topN)) {
      const cur = map.get(row.symbol) || {
        symbol: row.symbol,
        name: row.name,
        boardCount: 0,
        up: 0,
        down: 0,
        strengthSum: 0,
      };
      cur.boardCount += 1;
      if (row.side === 'up') cur.up += 1;
      else cur.down += 1;
      cur.strengthSum += Math.abs(Number(row.strength) || 0);
      map.set(row.symbol, cur);
    }
  }
  return [...map.values()];
}

function flowLabel(item) {
  if (item.up >= item.down + 1) return '流入';
  if (item.down >= item.up + 1) return '流出';
  return '混合';
}

function flowSide(item) {
  const lab = flowLabel(item);
  if (lab === '流出') return 'down';
  if (lab === '流入') return 'up';
  return 'flat';
}

function rebuildOverview() {
  let breadthUp = 0;
  let breadthDown = 0;
  let perpFlowSum = 0;
  let spotFlowSum = 0;
  let perpInTotal = 0;
  let perpOutTotal = 0;
  let spotInTotal = 0;
  let spotOutTotal = 0;
  let oiIncTotal = 0;
  let oiDecTotal = 0;
  for (const r of market.values()) {
    if (r.change24h > 0) breadthUp += 1;
    else if (r.change24h < 0) breadthDown += 1;
    const w = r.windows['15m'];
    if (!w) continue;
    const f = w.flowEst || 0;
    const s = w.spotEst || 0;
    const oi = w.oiDelta || 0;
    perpFlowSum += f;
    spotFlowSum += s;
    if (f > 0) perpInTotal += f; else perpOutTotal += -f;
    if (s > 0) spotInTotal += s; else spotOutTotal += -s;
    if (oi > 0) oiIncTotal += oi; else oiDecTotal += -oi;
  }
  const oiNet = oiIncTotal - oiDecTotal;
  const upPct = breadthUp + breadthDown
    ? Math.round((breadthUp / (breadthUp + breadthDown)) * 100)
    : 50;

  // Confluence = co-occurrence on FLOW value boards only (N≈2–3 like mercu)
  const flowScored = scoreBoardKeys(FLOW_BOARD_KEYS, { topN: 7 })
    .filter((s) => s.boardCount >= 2)
    .sort((a, b) => b.boardCount - a.boardCount || b.strengthSum - a.strengthSum)
    .slice(0, 7);
  const confluenceList = flowScored.map((s, i) => ({
    rank: i + 1,
    symbol: s.symbol,
    boardCount: s.boardCount,
    N: s.boardCount,
    flow: flowLabel(s),
    side: flowSide(s),
    divergent: Math.abs(s.up - s.down) <= 1 && s.up > 0 && s.down > 0,
  }));

  // Intensity / force = strength-board co-occurrence
  const strScored = scoreBoardKeys(STRENGTH_BOARD_KEYS, { topN: 8 })
    .filter((s) => s.boardCount >= 2)
    .map((s) => ({
      ...s,
      intensity: Number((s.strengthSum / Math.max(1, s.boardCount)).toFixed(0)),
    }))
    .sort((a, b) => b.intensity - a.intensity || b.boardCount - a.boardCount)
    .slice(0, 7);
  const intensityList = strScored.map((s, i) => ({
    rank: i + 1,
    symbol: s.symbol,
    boardCount: s.boardCount,
    N: s.boardCount,
    intensity: s.intensity,
    flow: flowLabel(s),
    side: flowSide(s),
    divergent: Math.abs(s.up - s.down) <= 1 && s.up > 0 && s.down > 0,
  }));

  const inCount = confluenceList.filter((x) => x.flow === '流入').length;
  const outCount = confluenceList.filter((x) => x.flow === '流出').length;
  let bias = '混合';
  if (inCount >= outCount + 2) bias = '流入';
  else if (outCount >= inCount + 2) bias = '流出';

  // Regime labels tied to each metric — never tag +perp net as 避险
  const flowRegime = (net) => {
    if (net > 2e6) return '净流入';
    if (net < -2e6) return '净流出';
    return '平衡';
  };
  const oiRegime = oiNet >= 0 ? '扩张' : '收缩';
  const breadthRegime = upPct >= 55 ? '偏多' : upPct <= 45 ? '偏空' : '中性';

  const intensityAvg = intensityList.length
    ? Number((intensityList.reduce((s, x) => s + x.intensity, 0) / intensityList.length).toFixed(1))
    : 0;

  const summary = {
    perpNet: Math.round(perpFlowSum),
    perpInTotal: Math.round(perpInTotal),
    perpOutTotal: Math.round(perpOutTotal),
    spotNet: Math.round(spotFlowSum),
    spotInTotal: Math.round(spotInTotal),
    spotOutTotal: Math.round(spotOutTotal),
    oiNet: Math.round(oiNet),
    oiIncTotal: Math.round(oiIncTotal),
    oiDecTotal: Math.round(oiDecTotal),
    upPct,
  };
  const prev = summaryPrevSnap;
  const vsPriorDollar = (cur, key) => {
    if (!prev || prev[key] == null) return '—';
    return formatUsd(cur - prev[key], { signed: true });
  };
  const vsPriorPctPts = (cur) => {
    if (!prev || prev.upPct == null) return '—';
    const d = cur - prev.upPct;
    return `${d > 0 ? '+' : ''}${d.toFixed(0)}pct`;
  };

  overview = {
    updatedAt: Date.now(),
    dataSource,
    summary,
    summaryPrev: prev,
    flowBias: {
      label: bias,
      confluence: `${Math.max(inCount, outCount)}/${confluenceList.length || 7}`,
      intensity: intensityAvg,
      boards: BOARD_KINDS.length,
      inflowBoards: BOARD_KINDS.filter((k) => k.side === 'up').length,
      outflowBoards: BOARD_KINDS.filter((k) => k.side === 'down').length,
      bias,
    },
    confluenceList,
    intensityList,
    forceList: intensityList, // alias mercu "force"
    market: {
      perpNetInflow: summary.perpNet,
      perpNetInflowDisplay: formatUsd(summary.perpNet, { signed: true }),
      perpRegime: flowRegime(summary.perpNet),
      perpVsPrior: vsPriorDollar(summary.perpNet, 'perpNet'),
      spotNetInflow: summary.spotNet,
      spotNetInflowDisplay: formatUsd(summary.spotNet, { signed: true }),
      spotRegime: flowRegime(summary.spotNet),
      spotVsPrior: vsPriorDollar(summary.spotNet, 'spotNet'),
      oiNetChange: summary.oiNet,
      oiNetChangeDisplay: formatUsd(summary.oiNet, { signed: true }),
      oiNetSide: summary.oiNet >= 0 ? 'up' : 'down',
      oiRegime,
      oiVsPrior: vsPriorDollar(summary.oiNet, 'oiNet'),
      breadthUp,
      breadthDown,
      breadthRatio: upPct,
      breadthDisplay: `${breadthUp}↑ / ${breadthDown}↓`,
      breadthRegime,
      breadthVsPrior: vsPriorPctPts(upPct),
      regime: breadthRegime,
      vsPrior: vsPriorPctPts(upPct),
      upPct,
    },
    marketRows: [
      {
        key: 'perp',
        label: '永续净流入(估)',
        value: formatUsd(summary.perpNet, { signed: true }),
        side: summary.perpNet >= 0 ? 'up' : 'down',
        regime: flowRegime(summary.perpNet),
        vsPrior: vsPriorDollar(summary.perpNet, 'perpNet'),
      },
      {
        key: 'spot',
        label: '现货净流入(估)',
        value: formatUsd(summary.spotNet, { signed: true }),
        side: summary.spotNet >= 0 ? 'up' : 'down',
        regime: flowRegime(summary.spotNet),
        vsPrior: vsPriorDollar(summary.spotNet, 'spotNet'),
      },
      {
        key: 'oi',
        label: 'OI净变化',
        value: formatUsd(summary.oiNet, { signed: true }),
        side: summary.oiNet >= 0 ? 'up' : 'down',
        regime: oiRegime,
        vsPrior: vsPriorDollar(summary.oiNet, 'oiNet'),
      },
      {
        key: 'breadth',
        label: '上涨占比',
        value: `${upPct}%`,
        side: upPct >= 55 ? 'up' : upPct <= 45 ? 'down' : 'flat',
        regime: breadthRegime,
        vsPrior: vsPriorPctPts(upPct),
      },
    ],
    oiNetChange: summary.oiNet,
    oiNetChangeDisplay: formatUsd(summary.oiNet, { signed: true }),
    oiNetSide: summary.oiNet >= 0 ? 'up' : 'down',
    breadthUp,
    breadthDown,
    stats: {
      oiSurges: anomalies.filter((a) => a.event === 'oi_surge').length,
      oiDumps: anomalies.filter((a) => a.event === 'oi_dump').length,
      priceMoves: anomalies.filter((a) => a.eventKind === 'price').length,
      resonance: anomalies.filter((a) => a.eventKind === 'state').length,
    },
  };
  summaryPrevSnap = summary;

}

function sparklineFromKlines(klines, n = 36) {
  if (!klines?.length) return null;
  return klines.slice(-n).map((k) => k.close);
}

function seriesFromOi(oiHist, n = 24) {
  if (!oiHist?.length) return [];
  return oiHist.slice(-n).map((d) => Number(d.oiUsdt) || 0);
}

async function fetchKlinesInterval(pair, interval, limit = 48) {
  const url = `${FAPI}/fapi/v1/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;
  const data = await fetchJson(url);
  if (!Array.isArray(data)) throw new Error('klines bad');
  return data.map((k) => ({
    ts: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    quoteVol: Number(k[7]),
    takerBuyQuote: Number(k[10]),
  }));
}

function candlesFromKlines(klines) {
  if (!klines?.length) return [];
  return klines.map((k) => ({
    t: k.ts,
    o: k.open,
    h: k.high,
    l: k.low,
    c: k.close,
    v: k.quoteVol != null ? k.quoteVol : (k.volume || 0),
  }));
}

async function fetchSpotKlines(pair, interval, limit = 48) {
  // Spot public via data-api (often works where fapi is geo-blocked)
  const url = `${SPOT_API}/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;
  try {
    const data = await fetchJson(url, { timeoutMs: 10000 });
    if (!Array.isArray(data)) return null;
    return data.map((k) => ({
      ts: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      quoteVol: Number(k[7]),
    }));
  } catch (_e) {
    return null;
  }
}

async function fetchSpotTicker(pair) {
  try {
    const url = `${SPOT_API}/api/v3/ticker/24hr?symbol=${pair}`;
    const t = await fetchJson(url, { timeoutMs: 8000 });
    if (!t || t.code) return null;
    return {
      price: Number(t.lastPrice),
      change24h: Number(t.priceChangePercent),
      quoteVolume: Number(t.quoteVolume),
    };
  } catch (_e) {
    return null;
  }
}

function parseLsRow(d) {
  if (!d) return null;
  const longAccount = Number(d.longAccount);
  const shortAccount = Number(d.shortAccount);
  let long = Number.isFinite(longAccount) ? Number((longAccount * 100).toFixed(1)) : null;
  let short = Number.isFinite(shortAccount) ? Number((shortAccount * 100).toFixed(1)) : null;
  const ratio = Number(d.longShortRatio);
  if (long == null || short == null) {
    if (!Number.isFinite(ratio) || ratio <= 0) return null;
    long = Number(((ratio / (1 + ratio)) * 100).toFixed(1));
    short = Number((100 - long).toFixed(1));
  }
  return { long, short, ratio: Number.isFinite(ratio) ? ratio : null, ts: Number(d.timestamp) };
}

async function fetchLongShortRatio(pair, period = '15m') {
  const url = `${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${pair}&period=${period}&limit=1`;
  try {
    const data = await fetchJson(url, { timeoutMs: 8000 });
    if (!Array.isArray(data) || !data.length) return null;
    return parseLsRow(data[data.length - 1]);
  } catch (_e) {
    return null;
  }
}

async function fetchLsSeries(pair, kind = 'globalAccount', period = '1h', limit = 48) {
  const path = kind === 'topAccount'
    ? 'topLongShortAccountRatio'
    : kind === 'topPosition'
      ? 'topLongShortPositionRatio'
      : 'globalLongShortAccountRatio';
  const url = `${FAPI}/futures/data/${path}?symbol=${pair}&period=${period}&limit=${limit}`;
  try {
    const data = await fetchJson(url, { timeoutMs: 10000 });
    if (!Array.isArray(data)) return [];
    return data.map(parseLsRow).filter(Boolean);
  } catch (_e) {
    return [];
  }
}

async function fetchFundingHist(pair, limit = 24) {
  try {
    const url = `${FAPI}/fapi/v1/fundingRate?symbol=${pair}&limit=${limit}`;
    const data = await fetchJson(url, { timeoutMs: 8000 });
    if (!Array.isArray(data)) return [];
    return data.map((d) => ({
      ts: Number(d.fundingTime),
      rate: Number(d.fundingRate) * 100, // %
    }));
  } catch (_e) {
    return [];
  }
}

async function fetchPremium(pair) {
  try {
    const url = `${FAPI}/fapi/v1/premiumIndex?symbol=${pair}`;
    const d = await fetchJson(url, { timeoutMs: 8000 });
    if (!d || d.code) return null;
    return {
      markPrice: Number(d.markPrice),
      indexPrice: Number(d.indexPrice),
      lastFundingRate: Number(d.lastFundingRate) * 100,
    };
  } catch (_e) {
    return null;
  }
}


async function fetchOkxOiSeries(base, limit = 48) {
  const instId = `${String(base).toUpperCase()}-USDT-SWAP`;
  const url = `https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-history?instId=${encodeURIComponent(instId)}&period=5m`;
  try {
    const data = await fetchJson(url, { timeoutMs: 10000 });
    const rows = Array.isArray(data?.data) ? data.data : [];
    // OKX returns newest-first: [ts, oi(contracts), oiCcy, oiUsd]
    const series = rows
      .map((r) => ({
        t: Number(r[0]),
        oiUsdt: Number(r[3]) || 0,
      }))
      .filter((d) => Number.isFinite(d.t) && d.oiUsdt > 0)
      .sort((a, b) => a.t - b.t)
      .slice(-limit);
    const current = series.length ? series[series.length - 1].oiUsdt : null;
    return { exchange: 'OKX', series, current, real: series.length > 0, note: series.length ? 'OKX 合约 OI' : '暂无' };
  } catch (_e) {
    return { exchange: 'OKX', series: [], current: null, real: false, note: '暂无', placeholder: true };
  }
}

async function fetchOkxOiCurrent(base) {
  const instId = `${String(base).toUpperCase()}-USDT-SWAP`;
  try {
    const url = `https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${encodeURIComponent(instId)}`;
    const data = await fetchJson(url, { timeoutMs: 8000 });
    const d = data?.data?.[0];
    if (!d) return null;
    return Number(d.oiUsd) || null;
  } catch (_e) {
    return null;
  }
}

async function fetchGateOi(base, limit = 48) {
  const contract = `${String(base).toUpperCase()}_USDT`;
  try {
    const url = `https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${encodeURIComponent(contract)}&interval=5m&limit=${limit}`;
    const data = await fetchJson(url, { timeoutMs: 10000 });
    if (!Array.isArray(data) || !data.length) {
      return { exchange: 'Gate', series: [], current: null, real: false, note: '暂无', placeholder: true };
    }
    const series = data
      .map((d) => ({
        t: Number(d.time) * (String(d.time).length <= 10 ? 1000 : 1),
        oiUsdt: Number(d.open_interest_usd) || 0,
      }))
      .filter((d) => d.oiUsdt > 0)
      .sort((a, b) => a.t - b.t);
    const current = series.length ? series[series.length - 1].oiUsdt : null;
    return { exchange: 'Gate', series, current, real: series.length > 0, note: series.length ? 'Gate 合约 OI' : '暂无' };
  } catch (_e) {
    return { exchange: 'Gate', series: [], current: null, real: false, note: '暂无', placeholder: true };
  }
}

async function fetchBybitOiCurrent(base) {
  // Often geo-blocked; keep honest fallback
  try {
    const url = `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${encodeURIComponent(String(base).toUpperCase() + 'USDT')}&intervalTime=5min&limit=1`;
    const data = await fetchJson(url, { timeoutMs: 8000 });
    const row = data?.result?.list?.[0];
    if (!row) return null;
    return Number(row.openInterest) || null; // may be contracts; treat carefully
  } catch (_e) {
    return null;
  }
}

async function fetchOkxLiquidations(base, markPrice) {
  const uly = `${String(base).toUpperCase()}-USDT`;
  try {
    const [inst, liq] = await Promise.all([
      fetchJson(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(uly + '-SWAP')}`, { timeoutMs: 8000 }).catch(() => null),
      fetchJson(`https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly=${encodeURIComponent(uly)}&state=filled`, { timeoutMs: 10000 }),
    ]);
    const ctVal = Number(inst?.data?.[0]?.ctVal) || 0.01;
    const details = [];
    for (const block of (liq?.data || [])) {
      for (const d of (block.details || [])) details.push(d);
    }
    const events = [];
    for (const d of details) {
      const px = Number(d.bkPx);
      const sz = Number(d.sz);
      if (!(px > 0) || !(sz > 0)) continue;
      const notional = sz * ctVal * px; // USD approx
      const side = String(d.posSide || '').toLowerCase() === 'long' || String(d.side || '').toLowerCase() === 'sell'
        ? 'long' : 'short';
      // OKX: long liquidated → sell; short liquidated → buy
      const isLongLiq = String(d.posSide).toLowerCase() === 'long'
        || (String(d.side).toLowerCase() === 'sell' && String(d.posSide).toLowerCase() !== 'short');
      events.push({
        price: px,
        notional,
        side: isLongLiq ? 'long' : 'short',
        ts: Number(d.ts || d.time) || Date.now(),
        exchange: 'OKX',
      });
    }
    return events;
  } catch (_e) {
    return [];
  }
}

async function fetchBinanceForceOrders(pair) {
  // Often geo-blocked; try anyway — production VPS may allow
  try {
    const url = `${FAPI}/fapi/v1/allForceOrders?symbol=${pair}&limit=100`;
    const data = await fetchJson(url, { timeoutMs: 8000 });
    if (!Array.isArray(data)) return [];
    return data.map((d) => {
      const px = Number(d.price || d.averagePrice);
      const qty = Number(d.origQty || d.executedQty);
      const notional = px * qty;
      const side = String(d.side).toUpperCase() === 'SELL' ? 'long' : 'short'; // sell = long liq
      return { price: px, notional, side, ts: Number(d.time), exchange: 'Binance' };
    }).filter((e) => e.price > 0 && e.notional > 0);
  } catch (_e) {
    return [];
  }
}

function buildLiqMap(events, markPrice, { buckets = 16, rangePct = 0.08 } = {}) {
  const mark = Number(markPrice) || 0;
  if (!(mark > 0)) {
    return {
      note: '无标记价，无法构建清算地图',
      placeholder: false,
      empty: true,
      longLiq: '$0',
      shortLiq: '$0',
      longLiqRaw: 0,
      shortLiqRaw: 0,
      buckets: [],
      sources: [],
    };
  }
  if (!events?.length) {
    return {
      note: '近期公开清算数据暂无（已尝试币安强平 / OKX 清算）',
      placeholder: false,
      empty: true,
      longLiq: '$0',
      shortLiq: '$0',
      longLiqRaw: 0,
      shortLiqRaw: 0,
      buckets: [],
      sources: [],
    };
  }
  const lo = mark * (1 - rangePct);
  const hi = mark * (1 + rangePct);
  const step = (hi - lo) / buckets;
  const rows = Array.from({ length: buckets }, (_, i) => ({
    price: Number((lo + step * (i + 0.5)).toPrecision(mark >= 1 ? 6 : 4)),
    priceLo: lo + step * i,
    priceHi: lo + step * (i + 1),
    long: 0,
    short: 0,
  }));
  let longTot = 0;
  let shortTot = 0;
  const sources = new Set();
  for (const e of events) {
    if (e.price < lo || e.price > hi) continue;
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((e.price - lo) / step)));
    if (e.side === 'long') {
      rows[idx].long += e.notional;
      longTot += e.notional;
    } else {
      rows[idx].short += e.notional;
      shortTot += e.notional;
    }
    if (e.exchange) sources.add(e.exchange);
  }
  const hasAny = rows.some((r) => r.long > 0 || r.short > 0);
  return {
    note: hasAny
      ? `清算热力 · 来源 ${[...sources].join('/') || '聚合'} · 标记价附近 ±${Math.round(rangePct * 100)}%`
      : '有清算记录但不在标记价附近区间',
    placeholder: false,
    empty: !hasAny,
    longLiq: formatUsd(longTot),
    shortLiq: formatUsd(shortTot),
    longLiqRaw: longTot,
    shortLiqRaw: shortTot,
    markPrice: mark,
    buckets: rows.map((r) => ({
      price: r.price,
      long: Math.round(r.long),
      short: Math.round(r.short),
    })),
    sources: [...sources],
  };
}

const TF_TO_INTERVAL = {
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

function buildCoinDetailBase(symbol) {
  const meta = findMeta(symbol);
  if (!meta) return null;
  const row = market.get(meta.symbol) || ensureMarketRow(meta);
  const w = row.windows['1d'] || row.windows['15m'] || {
    pricePct: row.change24h, oiDelta: 0, oiPct: 0, flowEst: 0, spotEst: 0,
  };
  const w1h = row.windows['1h'] || w;
  const oi = row.oiUsdt || 0;
  const oiDelta24h = (row.oiHist['1d'] || []).length >= 2
    ? row.oiHist['1d'][row.oiHist['1d'].length - 1].oiUsdt - row.oiHist['1d'][0].oiUsdt
    : w.oiDelta;

  const relatedAnomalies = anomalies
    .filter((a) => a.symbol === meta.symbol)
    .slice(0, 12)
    .map((a) => ({
      id: a.id,
      eventLabel: a.eventLabel,
      eventKind: a.eventKind,
      side: a.side,
      lastLine: a.lastLine,
      ageSec: a.ageSec,
      timeLabel: a.timeLabel,
      ts: a.ts,
      oiDeltaAbsDisplay: a.oiDeltaAbsDisplay,
      oiDeltaPct: a.oiDeltaPct,
      pricePct: a.pricePct,
      chips: a.chips,
    }));

  const relatedRanks = [];
  for (const kind of BOARD_KINDS) {
    const board = hotBoards['15m']?.[kind.key];
    if (!board) continue;
    const found = (board.rows || []).find((r) => r.symbol === meta.symbol);
    if (found) {
      relatedRanks.push({
        boardKey: kind.key,
        boardTitle: kind.title,
        window: '15m',
        rank: found.rank,
        display: found.display,
        auxDisplay: found.auxDisplay,
        strength: found.strength,
        side: found.side,
      });
    }
  }

  const chartFallback = sparklineFromKlines(row.priceHist5m, 48)
    || Array.from({ length: 36 }, (_, i) => row.price * (1 + Math.sin(i / 5) * 0.008));

  const basisPct = row.markPrice && row.price
    ? Number((((row.markPrice - row.price) / row.price) * 100).toFixed(4))
    : 0;

  const oiSeries = seriesFromOi(row.oiHist['5m'] || row.oiHist['15m'] || [], 36);
  const flowSeries = (row.priceHist5m || []).slice(-36).map((k) => {
    const buy = k.takerBuyQuote || 0;
    const vol = k.quoteVol || 0;
    return Math.round(2 * buy - vol);
  });

  return {
    symbol: meta.symbol,
    pair: `${meta.symbol}/USDT`,
    binancePair: meta.pair,
    name: meta.name,
    category: meta.category,
    region: null,
    instrument: '永续',
    price: row.price,
    change24h: row.change24h,
    change24hDisplay: formatPct(row.change24h),
    dataSource: row.source,
    stats: {
      oi,
      oiDisplay: formatUsd(oi),
      oiDelta24h,
      oiDelta24hDisplay: formatUsd(oiDelta24h, { signed: true }),
      oiDelta24hPct: oi > 0 ? Number(((oiDelta24h / Math.max(oi - oiDelta24h, oi, 1)) * 100).toFixed(2)) : 0,
      perpVolume: row.quoteVolume24h,
      perpVolumeDisplay: formatUsd(row.quoteVolume24h),
      spotVolume: null,
      spotVolumeDisplay: '—',
      spotVolumeNote: '待拉现货',
      funding: row.funding,
      fundingDisplay: `${row.funding >= 0 ? '+' : ''}${Number(row.funding || 0).toFixed(4)}%`,
      basis: basisPct,
      basisDisplay: formatPct(basisPct),
      spotNetFlow: w.spotEst,
      futuresNetFlow: w.flowEst,
      high24h: row.high24h,
      low24h: row.low24h,
    },
    chart: {
      perp: chartFallback,
      spot: null,
      byTf: {},
      activeTf: '15m',
      timeframes: ['5m', '15m', '1h', '4h', '1d'],
      note: '永续 K 线（币安）',
    },
    relativePerf: {
      vsBtc: (() => {
        const btc = market.get('BTC');
        if (!btc) return '—';
        return formatPct(Number((row.change24h - btc.change24h).toFixed(2)));
      })(),
      vsEth: (() => {
        const eth = market.get('ETH');
        if (!eth) return '—';
        return formatPct(Number((row.change24h - eth.change24h).toFixed(2)));
      })(),
      vsSector: '—',
      note: '相对表现按 24h 涨跌差',
    },
    liquidationMap: {
      note: '清算地图加载中…',
      placeholder: false,
      empty: true,
      longLiq: '$0',
      shortLiq: '$0',
      buckets: [],
    },
    layers: {
      openInterest: {
        label: '未平仓',
        value: formatUsd(oi),
        delta: formatUsd(oiDelta24h, { signed: true }),
        series: oiSeries,
        note: oiSeries.length ? '币安 OI 历史' : '暂无序列',
      },
      spotNetFlow: {
        label: '现货净流入',
        value: formatUsd(w.spotEst, { signed: true }),
        note: '估算',
        series: [],
      },
      futuresNetFlow: {
        label: '合约净流入',
        value: formatUsd(w.flowEst, { signed: true }),
        note: '估算（主动买卖）',
        series: flowSeries,
      },
      fundingRate: {
        label: '资金费率',
        value: `${row.funding >= 0 ? '+' : ''}${Number(row.funding || 0).toFixed(4)}%`,
        series: [],
        note: '待拉历史',
      },
      basis: {
        label: '基差',
        value: formatPct(basisPct),
        note: '标记价相对最新价',
        series: [],
      },
    },
    lsRatios: [
      { exchange: 'Binance', long: null, short: null, note: '加载中', placeholder: true },
      ...OTHER_EXCHANGES.map((ex) => ({ exchange: ex, long: null, short: null, note: '暂无', placeholder: true })),
    ],
    oiByExchange: [
      {
        exchange: 'Binance',
        oi,
        oiDisplay: formatUsd(oi),
        share: null,
        shareDisplay: '已知',
        change1h: w1h.oiPct || 0,
        change1hDisplay: formatPct(w1h.oiPct || 0),
        real: true,
      },
      ...OTHER_EXCHANGES.map((ex) => ({
        exchange: ex,
        oi: null,
        oiDisplay: '暂无',
        share: null,
        shareDisplay: '—',
        change1h: null,
        change1hDisplay: '—',
        placeholder: true,
        note: '暂无公开聚合',
      })),
    ],
    modules: [
      { key: 'chart', title: '图表', status: 'live' },
      { key: 'relative', title: '相对表现', status: 'live' },
      { key: 'liquidation', title: '清算地图', status: 'placeholder' },
      { key: 'layers', title: '全市场分层', status: 'mixed' },
      { key: 'ls', title: '多空比', status: 'mixed' },
      { key: 'oiEx', title: '分交易所未平仓', status: 'mixed' },
      { key: 'anomalies', title: '近期异动', status: 'live' },
      { key: 'hotRanks', title: '热钱榜排名', status: 'live' },
    ],
    anomalies: relatedAnomalies,
    hotRanks: relatedRanks,
    updatedAt: Date.now(),
    boardCacheTtlMs: BOARD_REFRESH_MS,
  };
}

async function enrichCoinDetail(symbol, { tf = '15m' } = {}) {
  const base = buildCoinDetailBase(symbol);
  if (!base) return null;
  const meta = findMeta(symbol);
  const cacheKey = `${meta.symbol}|${tf}`;
  const cached = coinEnrichCache.get(cacheKey);
  if (cached && Date.now() - cached.at < COIN_ENRICH_TTL_MS) {
    return {
      ...base,
      ...cached.data,
      chart: { ...base.chart, ...cached.data.chart },
      candles: cached.data.candles || base.candles,
      oiSeriesFull: cached.data.oiSeriesFull || base.oiSeriesFull,
      liquidationMap: cached.data.liquidationMap || base.liquidationMap,
      stats: { ...base.stats, ...cached.data.stats },
      layers: { ...base.layers, ...cached.data.layers },
      lsRatios: cached.data.lsRatios || base.lsRatios,
      lsCharts: cached.data.lsCharts || base.lsCharts,
      oiByExchange: cached.data.oiByExchange || base.oiByExchange,
      relativePerf: cached.data.relativePerf || base.relativePerf,
      updatedAt: Date.now(),
    };
  }

  const interval = TF_TO_INTERVAL[tf] || '15m';
  const pair = meta.pair;
  const baseAsset = meta.symbol;
  const row = market.get(meta.symbol);
  const lsPeriod = ['5m', '15m', '1h', '4h', '1d'].includes(tf) ? (tf === '5m' ? '15m' : tf) : '1h';

  const [
    perpKl, spotKl, spotTk, ls, fundingHist, premium, oi15,
    okxOi, gateOi, binanceForce, okxLiq,
    lsGlobalSeries, lsTopAcctSeries, lsTopPosSeries,
  ] = await Promise.all([
    fetchKlinesInterval(pair, interval, 120).catch(() => null),
    fetchSpotKlines(pair, interval, 120),
    fetchSpotTicker(pair),
    fetchLongShortRatio(pair, '15m'),
    fetchFundingHist(pair, 36),
    fetchPremium(pair),
    fetchOiHist(pair, '15m', 48).catch(() => null),
    fetchOkxOiSeries(baseAsset, 48),
    fetchGateOi(baseAsset, 48),
    fetchBinanceForceOrders(pair),
    fetchOkxLiquidations(baseAsset, row?.markPrice || row?.price),
    fetchLsSeries(pair, 'globalAccount', lsPeriod, 48),
    fetchLsSeries(pair, 'topAccount', lsPeriod, 48),
    fetchLsSeries(pair, 'topPosition', lsPeriod, 48),
  ]);

  const perpCandles = candlesFromKlines(perpKl);
  const spotCandles = candlesFromKlines(spotKl);
  const perpSeries = perpCandles.length ? perpCandles.map((k) => k.c) : base.chart.perp;
  const spotSeries = spotCandles.length ? spotCandles.map((k) => k.c) : null;

  // Relative performance indexed to 100
  let relativeSeries = null;
  let vsBtc = base.relativePerf.vsBtc;
  let vsEth = base.relativePerf.vsEth;
  if (perpKl?.length >= 2) {
    const from = perpKl[0].open || perpKl[0].close;
    const to = perpKl[perpKl.length - 1].close;
    const selfPct = from > 0 ? ((to - from) / from) * 100 : 0;
    relativeSeries = perpKl.map((k) => {
      const basePx = from > 0 ? from : k.close;
      return Number(((k.close / basePx) * 100).toFixed(3));
    });
    const btc = market.get('BTC');
    const eth = market.get('ETH');
    const btcWin = btc?.windows?.[tf === '5m' ? '15m' : tf];
    const ethWin = eth?.windows?.[tf === '5m' ? '15m' : tf];
    if (btcWin && Number.isFinite(btcWin.pricePct)) {
      vsBtc = formatPct(Number((selfPct - btcWin.pricePct).toFixed(2)));
    }
    if (ethWin && Number.isFinite(ethWin.pricePct)) {
      vsEth = formatPct(Number((selfPct - ethWin.pricePct).toFixed(2)));
    }
    base.relativePerf = {
      ...base.relativePerf,
      vsBtc,
      vsEth,
      windowPct: formatPct(Number(selfPct.toFixed(2))),
      series: relativeSeries,
      note: `相对表现 · Start=100 · 窗口 ${tf}`,
    };
  }

  let basisPct = base.stats.basis;
  let markPrice = row?.markPrice || row?.price || base.price;
  if (premium?.markPrice && premium?.indexPrice) {
    basisPct = Number((((premium.markPrice - premium.indexPrice) / premium.indexPrice) * 100).toFixed(4));
    markPrice = premium.markPrice;
    if (row) {
      row.markPrice = premium.markPrice;
      if (Number.isFinite(premium.lastFundingRate)) row.funding = premium.lastFundingRate;
    }
  }

  const fundingSeries = (fundingHist || []).map((d) => d.rate);
  const fundingSeriesPts = (fundingHist || []).map((d) => ({ t: d.ts, v: d.rate }));
  const binanceOiSeries = (oi15 || []).map((d) => ({ t: d.ts, oiUsdt: d.oiUsdt }));
  const oiSeries = binanceOiSeries.length
    ? binanceOiSeries.map((d) => d.oiUsdt)
    : base.layers.openInterest.series;

  let flowEst = base.stats.futuresNetFlow;
  let cvdSeries = [];
  if (perpKl?.length) {
    let buy = 0;
    let vol = 0;
    let cvd = 0;
    for (const k of perpKl) {
      const net = Math.round(2 * (k.takerBuyQuote || 0) - (k.quoteVol || 0));
      buy += k.takerBuyQuote || 0;
      vol += k.quoteVol || 0;
      cvd += net;
      cvdSeries.push(cvd);
    }
    flowEst = Math.round(2 * buy - vol);
  }

  // Multi-exchange OI
  const binanceOiCurrent = binanceOiSeries.length
    ? binanceOiSeries[binanceOiSeries.length - 1].oiUsdt
    : (row?.oiUsdt || base.stats.oi || 0);
  const exRows = [
    {
      exchange: 'Binance',
      oi: binanceOiCurrent,
      oiDisplay: formatUsd(binanceOiCurrent),
      series: binanceOiSeries,
      real: binanceOiSeries.length > 0 || binanceOiCurrent > 0,
      note: binanceOiSeries.length ? '币安 OI 历史' : '币安当前 OI',
      change1h: row?.windows?.['1h']?.oiPct ?? null,
      change1hDisplay: row?.windows?.['1h'] ? formatPct(row.windows['1h'].oiPct || 0) : '—',
    },
    {
      exchange: 'OKX',
      oi: okxOi?.current ?? null,
      oiDisplay: okxOi?.current != null ? formatUsd(okxOi.current) : '暂无',
      series: okxOi?.series || [],
      real: !!okxOi?.real,
      note: okxOi?.note || '暂无',
      placeholder: !okxOi?.real,
      change1h: null,
      change1hDisplay: '—',
    },
    {
      exchange: 'Gate',
      oi: gateOi?.current ?? null,
      oiDisplay: gateOi?.current != null ? formatUsd(gateOi.current) : '暂无',
      series: gateOi?.series || [],
      real: !!gateOi?.real,
      note: gateOi?.note || '暂无',
      placeholder: !gateOi?.real,
      change1h: null,
      change1hDisplay: '—',
    },
    ...['Bybit', 'Bitget', 'HTX'].map((ex) => ({
      exchange: ex,
      oi: null,
      oiDisplay: '暂无',
      series: [],
      real: false,
      placeholder: true,
      note: '暂无公开聚合',
      change1h: null,
      change1hDisplay: '—',
    })),
  ];
  const knownSum = exRows.reduce((s, r) => s + (Number(r.oi) || 0), 0);
  for (const r of exRows) {
    if (r.oi != null && knownSum > 0) {
      r.share = Number(((r.oi / knownSum) * 100).toFixed(1));
      r.shareDisplay = `${r.share}%`;
    } else {
      r.share = null;
      r.shareDisplay = r.real ? '—' : '—';
    }
  }

  const oiSeriesFull = {
    exchanges: exRows.map((r) => ({
      exchange: r.exchange,
      series: r.series,
      current: r.oi,
      real: r.real,
      note: r.note,
    })),
    combined: binanceOiSeries.length
      ? binanceOiSeries.map((d) => ({ t: d.t, oiUsdt: d.oiUsdt }))
      : [],
    note: '全网持仓以币安序列为主；OKX/Gate 有则叠加展示',
  };

  // Liquidation map
  const liqEvents = [...(binanceForce || []), ...(okxLiq || [])];
  const liquidationMap = buildLiqMap(liqEvents, markPrice, { buckets: 18, rangePct: 0.06 });

  const lsCharts = {
    exchange: 'Binance',
    period: lsPeriod,
    globalAccount: {
      label: '全球多空比',
      latest: ls || (lsGlobalSeries.length ? lsGlobalSeries[lsGlobalSeries.length - 1] : null),
      series: lsGlobalSeries,
      note: 'globalLongShortAccountRatio',
    },
    topAccount: {
      label: '账户多空比',
      latest: lsTopAcctSeries.length ? lsTopAcctSeries[lsTopAcctSeries.length - 1] : null,
      series: lsTopAcctSeries,
      note: 'topLongShortAccountRatio',
    },
    topPosition: {
      label: '持仓多空比',
      latest: lsTopPosSeries.length ? lsTopPosSeries[lsTopPosSeries.length - 1] : null,
      series: lsTopPosSeries,
      note: 'topLongShortPositionRatio',
    },
  };

  const lsRatios = [];
  if (ls) {
    lsRatios.push({
      exchange: 'Binance',
      long: ls.long,
      short: ls.short,
      ratio: ls.ratio,
      note: '全球账户多空比',
      real: true,
    });
  } else {
    lsRatios.push({ exchange: 'Binance', long: null, short: null, note: '暂无/接口不可用', placeholder: true });
  }
  for (const ex of OTHER_EXCHANGES) {
    lsRatios.push({ exchange: ex, long: null, short: null, note: '暂无', placeholder: true });
  }

  const fundingVal = row?.funding ?? base.stats.funding;
  const patch = {
    candles: {
      perp: perpCandles,
      spot: spotCandles,
      interval,
      note: perpCandles.length
        ? (spotCandles.length ? '永续+现货 OHLC（币安）' : '永续 OHLC（币安）；现货暂无')
        : 'K 线暂无',
    },
    chart: {
      perp: perpSeries,
      spot: spotSeries,
      byTf: {
        [tf]: { perp: perpSeries, spot: spotSeries, candles: { perp: perpCandles, spot: spotCandles } },
      },
      activeTf: tf,
      timeframes: ['15m', '1h', '4h', '1d', '5m'],
      note: perpCandles.length ? '合约 K 线' : '永续 K 线暂无',
    },
    oiSeriesFull,
    liquidationMap,
    oiByExchange: exRows.map((r) => ({
      exchange: r.exchange,
      oi: r.oi,
      oiDisplay: r.oiDisplay,
      share: r.share,
      shareDisplay: r.shareDisplay,
      change1h: r.change1h,
      change1hDisplay: r.change1hDisplay,
      real: r.real,
      placeholder: r.placeholder,
      note: r.note,
    })),
    lsCharts,
    stats: {
      ...base.stats,
      spotVolume: spotTk?.quoteVolume ?? null,
      spotVolumeDisplay: spotTk ? formatUsd(spotTk.quoteVolume) : '暂无',
      spotVolumeNote: spotTk ? '币安现货 24h' : '暂无现货成交额',
      basis: basisPct,
      basisDisplay: formatPct(basisPct),
      futuresNetFlow: flowEst,
      funding: fundingVal,
      fundingDisplay: `${fundingVal >= 0 ? '+' : ''}${Number(fundingVal || 0).toFixed(4)}%`,
      longShort: ls ? `${ls.long}/${ls.short}` : null,
      longShortDisplay: ls ? `多 ${ls.long}% / 空 ${ls.short}%` : '暂无',
      markPrice,
    },
    layers: {
      ...base.layers,
      openInterest: {
        ...base.layers.openInterest,
        value: formatUsd(binanceOiCurrent),
        series: oiSeries,
        seriesPts: binanceOiSeries.map((d) => ({ t: d.t, v: d.oiUsdt })),
        note: oiSeries?.length ? '币安 OI 历史' : base.layers.openInterest.note,
      },
      futuresNetFlow: {
        ...base.layers.futuresNetFlow,
        value: formatUsd(flowEst, { signed: true }),
        series: perpKl?.length
          ? perpKl.map((k) => Math.round(2 * (k.takerBuyQuote || 0) - (k.quoteVol || 0)))
          : base.layers.futuresNetFlow.series,
        note: '估算（主动买卖）',
      },
      fundingRate: {
        ...base.layers.fundingRate,
        value: `${fundingVal >= 0 ? '+' : ''}${Number(fundingVal || 0).toFixed(4)}%`,
        series: fundingSeries,
        seriesPts: fundingSeriesPts,
        note: fundingSeries.length ? '资金费率历史（币安）' : '暂无历史',
      },
      basis: {
        ...base.layers.basis,
        value: formatPct(basisPct),
        note: '币安标记价 − 指数价',
        series: [],
      },
      spotNetFlow: {
        ...base.layers.spotNetFlow,
        value: formatUsd(base.stats.spotNetFlow, { signed: true }),
        note: '估算',
      },
      cvd: {
        label: 'CVD',
        value: cvdSeries.length ? formatUsd(cvdSeries[cvdSeries.length - 1], { signed: true }) : '—',
        series: cvdSeries,
        note: '累计主动买卖差（估算）',
      },
      price: {
        label: '价格',
        value: base.price,
        series: perpSeries || [],
        note: `窗口 ${tf}`,
      },
    },
    lsRatios,
    relativePerf: base.relativePerf,
    modules: [
      { key: 'chart', title: '合约K线', status: perpCandles.length ? 'live' : 'mixed' },
      { key: 'relative', title: '相对表现', status: 'live' },
      { key: 'liquidation', title: '清算地图', status: liquidationMap.empty ? 'mixed' : 'live' },
      { key: 'layers', title: '全市场分层', status: 'mixed' },
      { key: 'ls', title: '多空比', status: ls ? 'live' : 'mixed' },
      { key: 'oiEx', title: '分交易所未平仓', status: 'mixed' },
    ],
  };

  coinEnrichCache.set(cacheKey, { at: Date.now(), data: patch });

  return {
    ...base,
    ...patch,
    chart: patch.chart,
    candles: patch.candles,
    oiSeriesFull: patch.oiSeriesFull,
    liquidationMap: patch.liquidationMap,
    oiByExchange: patch.oiByExchange,
    stats: patch.stats,
    layers: patch.layers,
    lsRatios: patch.lsRatios,
    lsCharts: patch.lsCharts,
    relativePerf: patch.relativePerf,
    modules: patch.modules,
    updatedAt: Date.now(),
  };
}

function buildCoinDetail(symbol) {
  return buildCoinDetailBase(symbol);
}

async function bootstrap() {
  console.log('[EzRadar] bootstrapping market data…');
  // Clear any stale feed so new thresholds don't keep tiny cards
  anomalies.length = 0;
  seenAnomalyKeys.clear();
  anomalySeq = 1;
  summaryPrevSnap = null;
  loadWatchStore();
  seedFallbackUniverse();
  try {
    await refreshTickers();
    await refreshOiAndKlines();
    rebuildHotBoards();
    scanForAnomalies({ bootstrap: true });
    // refill chips now that boards exist
    for (const a of anomalies) {
      const row = market.get(a.symbol);
      if (row) a.chips = makeChips(row, EVENT_TYPES[a.event] || EVENT_TYPES.oi_surge);
    }
    rebuildOverview();
    watchlist.updateAll(market, market.get('BTC'));
    saveWatchStore(true);
    console.log(`[EzRadar] ready source=${dataSource} symbols=${market.size} anomalies=${anomalies.length} watch=${watchlist.stats().active}`);
  } catch (err) {
    console.warn('[EzRadar] bootstrap partial:', err.message);
    rebuildHotBoards();
    rebuildOverview();
  }
}

// Periodic refresh — no random metronome cards
setInterval(async () => {
  try {
    await refreshTickers();
    patchLiveWindowPrices();
    const liveN = scanLivePriceAnomalies();
    refreshAnomalyMeta();
    // Light board refresh on ticker cadence when due (price boards feel live)
    if (Date.now() - lastBoardRebuildAt >= BOARD_REFRESH_MS - 500) {
      rebuildHotBoards();
      rebuildOverview();
    }
    if (liveN > 0) console.log(`[EzRadar] +${liveN} live price anomalies`);
  } catch (e) {
    console.warn(e.message);
  }
}, TICKER_TTL_MS);

setInterval(async () => {
  try {
    await refreshOiAndKlines();
    // Do NOT rebuild boards here — OI/kline refresh is noisy; boards use BOARD_REFRESH_MS cache
    const n = scanForAnomalies({ bootstrap: false });
    refreshAnomalyMeta();
    if (n > 0) console.log(`[EzRadar] +${n} anomalies source=${dataSource}`);
  } catch (e) {
    console.warn('[oi poll]', e.message);
  }
}, OI_POLL_MS);

setInterval(() => {
  // Board snapshot every BOARD_REFRESH_MS (~20s); sticky blend avoids full-grid wipe
  rebuildHotBoards();
  rebuildOverview();
  // 观察池与榜单同频更新：OI 保留、箱体、触发位、评分都随时间变化
  try {
    watchlist.updateAll(market, market.get('BTC'));
    saveWatchStore();
  } catch (err) {
    console.warn('[watch] update failed:', err.message);
  }
  console.log(`[EzRadar] boards refreshed source=${dataSource} at=${new Date(boardsUpdatedAt).toISOString()}`);
}, BOARD_REFRESH_MS);

setInterval(() => {
  refreshAnomalyMeta();
}, 30000);

const corsOrigins = (
  process.env.CORS_ORIGINS ||
  'http://localhost:3000,http://127.0.0.1:3000,http://localhost:3002,http://127.0.0.1:3002,https://smart.b.ezcoin.ink,http://smart.b.ezcoin.ink'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(express.json());

function vipFromToken(req, _res, next) {
  req.vip = false;
  req.user = null;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    req.vip = Boolean(decoded.vip);
  } catch (_err) {
    req.vip = false;
  }
  return next();
}
app.use(vipFromToken);

app.get('/', (_req, res) => {
  res.json({
    message: 'EzRadar API',
    status: 'online',
    product: 'OI 异动雷达',
    dataSource,
    vipRequired: VIP_REQUIRED,
    pollHintMs: POLL_HINT_MS,
    symbols: market.size,
    watchlistActive: watchlist.stats().active,
  });
});

app.get('/api/v1/config', (_req, res) => {
  res.json({
    vipRequired: VIP_REQUIRED,
    pollHintMs: POLL_HINT_MS,
    boardRefreshMs: BOARD_REFRESH_MS,
    boardWindows: BOARD_WINDOWS,
    boardKinds: BOARD_KINDS.map((k) => ({ key: k.key, title: k.title, estimated: !!k.estimated })),
    watch: {
      tickMs: WATCH_TICK_MS,
      ttlHours: Math.round(WATCH_TTL_MS / 3600000),
      profile: WATCH_PROFILE,
      strategy: WATCH_STRATEGY,
      stages: watchlist.stageCatalog(),
    },
    dataSource,
  });
});

app.get('/api/v1/coins', async (_req, res) => {
  await refreshTickers();
  const coins = [...market.values()]
    .filter((r) => r.price > 0)
    .sort((a, b) => (b.quoteVolume24h || 0) - (a.quoteVolume24h || 0))
    .slice(0, 40)
    .map((r) => ({
      id: r.symbol,
      name: r.name,
      price: r.price,
      vol24h: formatUsd(r.quoteVolume24h),
      change: Number(r.change24h.toFixed(2)),
      category: r.category,
      oi: formatUsd(r.oiUsdt),
      source: r.source,
    }));
  res.json({ coins, dataSource });
});

app.get('/api/v1/coins/:symbol', async (req, res) => {
  await refreshTickers();
  const tfRaw = typeof req.query.tf === 'string' ? req.query.tf : '15m';
  const tf = ['5m', '15m', '1h', '4h', '1d'].includes(tfRaw) ? tfRaw : '15m';
  try {
    const detail = await enrichCoinDetail(req.params.symbol, { tf });
    if (!detail) return res.status(404).json({ error: '未在币安合约上架', code: 'NOT_LISTED' });
    return res.json({
      coin: detail,
      meta: { tf, enrichCacheTtlMs: COIN_ENRICH_TTL_MS, boardCacheTtlMs: BOARD_REFRESH_MS },
    });
  } catch (err) {
    const fallback = buildCoinDetail(req.params.symbol);
    if (!fallback) return res.status(404).json({ error: '未在币安合约上架', code: 'NOT_LISTED' });
    return res.json({ coin: fallback, meta: { tf, degraded: true, error: String(err.message || err) } });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (email === DEMO_USER.email && password === DEMO_USER.password) {
    const token = jwt.sign({ email: DEMO_USER.email, vip: true }, JWT_SECRET, { expiresIn: '12h' });
    return res.json({ token, vip: true, email: DEMO_USER.email });
  }
  return res.status(400).json({ error: '账号或密码错误' });
});

app.get('/api/v1/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未授权' });
  return res.json({ email: req.user.email, vip: req.vip, vipRequired: VIP_REQUIRED });
});

app.get('/api/v1/oi-moves', (req, res) => {
  const vip = effectiveVip(req);
  const direction = ['all', 'up', 'down'].includes(req.query.direction) ? req.query.direction : 'all';
  let rows = anomalies
    .filter((a) => a.eventKind === 'oi')
    .map((a) => ({
      id: a.id,
      symbol: a.symbol,
      name: a.name,
      category: a.category,
      interval: a.window,
      price: a.price,
      change24h: a.pricePct,
      oiDeltaAbs: a.oiDeltaAbs,
      oiDeltaAbsDisplay: a.oiDeltaAbsDisplay,
      oiDeltaPct: a.oiDeltaPct,
      intensity: Math.abs(a.oiDeltaPct) >= 5 ? 'strong' : Math.abs(a.oiDeltaPct) >= 2.5 ? 'medium' : 'weak',
      intensityLabel: Math.abs(a.oiDeltaPct) >= 5 ? '强' : Math.abs(a.oiDeltaPct) >= 2.5 ? '中' : '弱',
      direction: a.event,
      directionLabel: a.eventLabel,
      directionSide: a.side,
      ageSec: a.ageSec,
      timeLabel: a.timeLabel,
      ts: a.ts,
    }));
  if (direction === 'up') rows = rows.filter((r) => r.oiDeltaPct > 0);
  if (direction === 'down') rows = rows.filter((r) => r.oiDeltaPct < 0);
  if (vip) {
    return res.json({
      meta: { vip: true, vipRequired: VIP_REQUIRED, total: rows.length, generatedAt: Date.now(), dataSource },
      moves: rows,
    });
  }
  const preview = rows.slice(0, 8).map((row, i) =>
    i < 3
      ? { ...row, locked: false }
      : { ...row, locked: true, price: null, oiDeltaAbsDisplay: '••••', oiDeltaPct: null, name: '••••', directionLabel: '•••' },
  );
  return res.json({
    meta: { vip: false, vipRequired: VIP_REQUIRED, locked: true, total: rows.length, previewTotal: preview.length, generatedAt: Date.now(), dataSource },
    moves: preview,
  });
});

const WATCH_STAGE_KEYS = new Set(['all', 'active', ...watchlist.stageCatalog().map((x) => x.key)]);

app.get('/api/v1/watchlist', (req, res) => {
  const vip = effectiveVip(req);
  const stage = WATCH_STAGE_KEYS.has(req.query.stage) ? req.query.stage : 'active';
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toUpperCase() : '';
  const limit = Math.min(Number(req.query.limit) || 50, vip ? 100 : 3);
  const entries = watchlist.list({ stage, q, limit });
  const counts = watchlist.stats();
  return res.json({
    meta: {
      vip,
      vipRequired: VIP_REQUIRED,
      locked: !vip,
      generatedAt: Date.now(),
      tickMs: WATCH_TICK_MS,
      ttlHours: Math.round(WATCH_TTL_MS / 3600000),
      stage,
      stages: watchlist.stageCatalog(),
      counts,
      events: watchlist.recentEvents(12),
      dataSource,
      riskNote: '规则辅助观察，不构成投资建议；小市值币种滑点与假突破风险更高。',
      strategy: {
        profile: WATCH_PROFILE,
        minConfirmMin: 5,
        minSetupMin: WATCH_STRATEGY.setupMinAgeMin,
        minOiRetentionPct: WATCH_STRATEGY.setupMinRetentionPct,
        maxBoxAtr: WATCH_STRATEGY.setupMaxBoxAtr,
        maxBoxPct: WATCH_STRATEGY.setupMaxBoxPct,
        triggerVolumeRatio: WATCH_STRATEGY.triggerMinVolumeRatio,
        triggerBarVolumeRatio: [WATCH_STRATEGY.triggerMinBarVolumeRatio, WATCH_STRATEGY.triggerMaxBarVolumeRatio],
        triggerMinScore: WATCH_STRATEGY.triggerMinScore,
        stopAtr: WATCH_STRATEGY.stopAtr,
        maxChaseAtr: WATCH_STRATEGY.maxChaseAtr,
        rr: [WATCH_STRATEGY.rr1, WATCH_STRATEGY.rr2],
        riskPerTrade: '账户权益的 0.5%–1%',
      },
    },
    entries,
  });
});

app.get('/api/v1/watchlist/:symbol', (req, res) => {
  const entry = watchlist.get(req.params.symbol);
  if (!entry) return res.status(404).json({ error: '观察池里没有这个币种' });
  return res.json({
    meta: {
      vip: effectiveVip(req),
      generatedAt: Date.now(),
      tickMs: WATCH_TICK_MS,
      dataSource,
      riskNote: '规则辅助观察，不构成投资建议。',
    },
    entry,
  });
});

app.post('/api/v1/watchlist/:symbol/dismiss', (req, res) => {
  if (VIP_REQUIRED && !req.vip) return res.status(403).json({ error: '需要 VIP' });
  const entry = watchlist.dismiss(req.params.symbol);
  if (!entry) return res.status(404).json({ error: '观察池里没有这个币种' });
  saveWatchStore(true);
  return res.json({ entry });
});

app.get('/api/v1/anomalies', (req, res) => {
  const vip = effectiveVip(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toUpperCase() : '';
  const kind = typeof req.query.kind === 'string' ? req.query.kind : 'all';
  let rows = [...anomalies];
  if (q) rows = rows.filter((a) => a.symbol.includes(q) || a.name.toUpperCase().includes(q));
  if (kind === 'oi') rows = rows.filter((a) => a.eventKind === 'oi');
  else if (kind === 'price') rows = rows.filter((a) => a.eventKind === 'price');
  else if (kind === 'state') rows = rows.filter((a) => a.eventKind === 'state');
  // kind=all → price + oi + state

  const meta = {
    vip,
    vipRequired: VIP_REQUIRED,
    live: true,
    updatedAt: Date.now(),
    tickMs: POLL_HINT_MS,
    total: rows.length,
    dataSource,
  };

  if (vip) return res.json({ meta: { ...meta, locked: false }, anomalies: rows });

  const preview = rows.slice(0, 10).map((a, i) => {
    if (i < 3) return { ...a, locked: false };
    return {
      ...a,
      locked: true,
      price: null,
      pricePct: null,
      oiDeltaAbs: null,
      oiDeltaAbsDisplay: '••••',
      oiDeltaPct: null,
      lastLine: '近5分钟  ••••••',
      chips: {},
      name: '••••',
    };
  });
  return res.json({
    meta: { ...meta, locked: true, unlockHint: '登录 VIP 解锁完整异动流' },
    anomalies: preview,
  });
});

app.get('/api/v1/hot-boards', (req, res) => {
  const vip = effectiveVip(req);
  const window = BOARD_WINDOWS.includes(req.query.window) ? req.query.window : '15m';
  const boards = hotBoards[window] || {};
  const list = BOARD_KINDS.map((k) => boards[k.key]).filter(Boolean);
  return res.json({
    meta: {
      window,
      windows: BOARD_WINDOWS,
      vip,
      vipRequired: VIP_REQUIRED,
      updatedAt: boardsUpdatedAt,
      boardRefreshMs: BOARD_REFRESH_MS,
      cacheTtlMs: BOARD_REFRESH_MS,
      dataSource,
    },
    boards: list,
  });
});

app.get('/api/v1/overview', (req, res) => {
  const vip = effectiveVip(req);
  const payload = { ...overview, vip, vipRequired: VIP_REQUIRED, dataSource };
  if (!vip) {
    payload.oiNetChangeDisplay = '••••';
    payload.oiNetChange = null;
    if (payload.market) {
      payload.market = {
        ...payload.market,
        perpNetInflowDisplay: '••••',
        spotNetInflowDisplay: '••••',
        oiNetChangeDisplay: '••••',
        breadthDisplay: '••••',
      };
    }
    payload.marketRows = (payload.marketRows || []).map((r, i) =>
      i < 1 ? r : { ...r, value: '••••', vsPrior: '••••' },
    );
    payload.confluenceList = (payload.confluenceList || []).map((r, i) =>
      i < 2 ? r : { ...r, symbol: '••••', flow: '••' },
    );
    payload.intensityList = (payload.intensityList || []).map((r, i) =>
      i < 2 ? r : { ...r, symbol: '••••', flow: '••', intensity: '••' },
    );
  }
  return res.json({ overview: payload });
});

app.get('/api/v1/rankings', (req, res) => {
  const vip = effectiveVip(req);
  if (!vip) return res.status(403).json({ error: '需要 VIP' });
  const board = hotBoards['15m']?.oi_up_value;
  const rankings = (board?.rows || []).slice(0, 10).map((r, i) => ({
    rank: i + 1,
    id: r.symbol,
    name: r.name,
    score: r.strength,
    flow: r.side === 'up' ? 'in' : 'out',
    mentions: Math.round(Math.abs(r.value) / 1e5),
  }));
  return res.json({ rankings, dataSource });
});

// 先起 HTTP，避免数据源不可达时整站打不开；bootstrap 在后台补齐真实数据
seedFallbackUniverse();
rebuildHotBoards();
rebuildOverview();

app.listen(PORT, () => {
  console.log(`EzRadar API listening on :${PORT} (VIP_REQUIRED=${VIP_REQUIRED} TZ=${process.env.TZ || 'unset'})`);
});

bootstrap()
  .then(() => console.log(`[EzRadar] bootstrap finished source=${dataSource}`))
  .catch((err) => console.warn('[EzRadar] bootstrap failed:', err.message));
