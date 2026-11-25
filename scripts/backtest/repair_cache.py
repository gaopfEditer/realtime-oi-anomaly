#!/usr/bin/env python3
"""Repair single-day kline gaps and rebuild the backtest manifest.

Why: Binance archive occasionally returns 404 for one daily kline ZIP even though
neighboring days exist. A missing 288-bar day creates a time gap that breaks the
24h lookback. For those days only, insert flat zero-volume bars at the previous
close so timestamps remain continuous. OI metrics are not synthesized.

Usage:
  python scripts/backtest/repair_cache.py
"""
from __future__ import annotations

import csv
import io
import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
from fetch_history import DEFAULT_SYMBOLS, KLINES_HEADER, parse_date  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CACHE = os.path.join(ROOT, "backtest-cache")
START = parse_date("2026-08-23")
END = parse_date("2026-11-22")
EXPECTED_DAYS = (END - START).days + 1
EXPECTED_ROWS = EXPECTED_DAYS * 288


def read_rows(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def write_rows(path: str, rows: list[dict]) -> None:
    with open(path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=KLINES_HEADER, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def flat_bar(open_time: int, price: float) -> dict:
    return {
        "open_time": str(open_time),
        "open": f"{price:.8f}",
        "high": f"{price:.8f}",
        "low": f"{price:.8f}",
        "close": f"{price:.8f}",
        "volume": "0",
        "close_time": str(open_time + 299999),
        "quote_volume": "0",
        "count": "0",
        "taker_buy_volume": "0",
        "taker_buy_quote_volume": "0",
        "ignore": "0",
    }


def repair_symbol(symbol: str) -> dict:
    symbol_dir = os.path.join(CACHE, symbol)
    meta_path = os.path.join(symbol_dir, "meta.json")
    kline_path = os.path.join(symbol_dir, "klines.csv")
    if not os.path.exists(meta_path) or not os.path.exists(kline_path):
        return {"symbol": symbol, "status": "missing"}

    with open(meta_path, "r", encoding="utf-8") as fh:
        meta = json.load(fh)
    rows = read_rows(kline_path)
    missing_kline_days = []
    for item in meta.get("missing", []):
        if item.startswith("klines:"):
            missing_kline_days.append(item.split(":", 2)[1])

    for ds in sorted(set(missing_kline_days)):
        day = parse_date(ds)
        day_start = int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp() * 1000)
        idx = next((i for i, r in enumerate(rows) if int(float(r["open_time"])) >= day_start), len(rows))
        if idx > 0:
            price = float(rows[idx - 1]["close"])
        elif idx < len(rows):
            price = float(rows[idx]["open"])
        else:
            price = 0.0
        if not (price > 0):
            return {"symbol": symbol, "status": "unrepairable", "reason": f"no reference price for {ds}"}
        if idx < len(rows) and int(float(rows[idx]["open_time"])) == day_start:
            continue
        for i in range(288):
            rows.insert(idx + i, flat_bar(day_start + i * 5 * 60 * 1000, price))

    rows.sort(key=lambda r: int(float(r["open_time"])))
    write_rows(kline_path, rows)
    meta["klineRows"] = len(rows)
    meta["missing"] = [m for m in meta.get("missing", []) if not m.startswith("klines:")]
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)
    return {
        "symbol": symbol,
        "status": "ok",
        "filledDays": sorted(set(missing_kline_days)),
        "klineRows": len(rows),
        "metricsRows": meta.get("metricsRows", 0),
    }


def main() -> int:
    results = []
    for symbol in DEFAULT_SYMBOLS:
        r = repair_symbol(symbol)
        results.append(r)
        print(f"{symbol}: {r}")

    metas = []
    manifest_symbols = []
    for symbol in DEFAULT_SYMBOLS:
        meta_path = os.path.join(CACHE, symbol, "meta.json")
        if not os.path.exists(meta_path):
            continue
        with open(meta_path, "r", encoding="utf-8") as fh:
            meta = json.load(fh)
        # Symbols with incomplete OI cannot produce OI-anomaly signals reliably.
        if meta.get("klineRows", 0) != EXPECTED_ROWS or meta.get("metricsRows", 0) != EXPECTED_ROWS:
            print(
                f"exclude {symbol}: klines={meta.get('klineRows')} metrics={meta.get('metricsRows')} "
                f"expected={EXPECTED_ROWS}"
            )
            continue
        metas.append(meta)
        manifest_symbols.append(symbol)

    with open(os.path.join(CACHE, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(
            {
                "start": START.isoformat(),
                "end": END.isoformat(),
                "symbols": manifest_symbols,
                "metas": sorted(metas, key=lambda m: m["symbol"]),
            },
            fh,
            ensure_ascii=False,
            indent=2,
        )
    print(f"\nmanifest: {len(manifest_symbols)} symbols, rows={EXPECTED_ROWS}, days={EXPECTED_DAYS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
