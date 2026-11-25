'use strict';

/*
 * 回测区间统一配置。
 *
 * 评估：2026-08-24 00:00 UTC ～ 2026-11-23 00:00 UTC（91 个完整交易日）
 * 下载：多下 2026-08-23 作为 24h 指标和 OI 窗口预热，不纳入评估。
 *
 * 注意：90 天是自然语言口径；实际评估窗口为 91 天，因为首尾都按 UTC 日界对齐。
 */

const DAY = 24 * 60 * 60 * 1000;

const EVAL_START = Date.UTC(2026, 7, 24, 0, 0, 0); // 2026-08-24
const EVAL_END = Date.UTC(2026, 10, 23, 0, 0, 0); // 2026-11-23 exclusive
const TRAIN_END = Date.UTC(2026, 9, 8, 0, 0, 0); // 2026-10-08，前 45 天
const TEST_START = TRAIN_END;

const PERIOD_LABEL = '2026-08-24 ~ 2026-11-22 UTC（91d）';
const FULL_LABEL = 'full-91d';

const WINDOWS = [
  { tag: 'w1', label: 'w1-30d', start: EVAL_START, end: Date.UTC(2026, 8, 23, 0, 0, 0), period: '2026-08-24 ~ 2026-09-22' },
  { tag: 'w2', label: 'w2-30d', start: Date.UTC(2026, 8, 23, 0, 0, 0), end: Date.UTC(2026, 9, 23, 0, 0, 0), period: '2026-09-23 ~ 2026-10-22' },
  { tag: 'w3', label: 'w3-31d', start: Date.UTC(2026, 9, 23, 0, 0, 0), end: EVAL_END, period: '2026-10-23 ~ 2026-11-22' },
];

const PERIODS = [
  { label: FULL_LABEL, start: EVAL_START, end: EVAL_END, period: PERIOD_LABEL },
  { label: 'train-45d', start: EVAL_START, end: TRAIN_END, period: '2026-08-24 ~ 2026-10-07' },
  { label: 'test-46d', start: TEST_START, end: EVAL_END, period: '2026-10-08 ~ 2026-11-22' },
];

module.exports = {
  DAY,
  EVAL_START,
  EVAL_END,
  TRAIN_END,
  TEST_START,
  PERIOD_LABEL,
  FULL_LABEL,
  WINDOWS,
  PERIODS,
};
