#!/usr/bin/env python3
"""Download Binance USD-M futures daily archives and build replay CSVs.

Source: https://data.binance.vision/data/futures/um/daily/
No API key required. Files are public daily ZIPs.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone

DEFAULT_SYMBOLS = [
    "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT",
    "LINKUSDT", "SUIUSDT", "LTCUSDT", "DOTUSDT", "BCHUSDT",
    "TRXUSDT", "APTUSDT", "ARBUSDT", "OPUSDT", "NEARUSDT",
    "FILUSDT", "WIFUSDT", "1000PEPEUSDT", "ENAUSDT",
]
BASE = "https://data.binance.vision/data/futures/um/daily"
METRICS_HEADER = [
    "create_time", "symbol", "sum_open_interest", "sum_open_interest_value",
    "count_toptrader_long_short_ratio", "sum_toptrader_long_short_ratio",
    "count_long_short_ratio", "sum_taker_long_short_vol_ratio",
]
KLINES_HEADER = [
    "open_time", "open", "high", "low", "close", "volume", "close_time",
    "quote_volume", "count", "taker_buy_volume", "taker_buy_quote_volume", "ignore",
]


def parse_date(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def dates_between(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def fetch_bytes(url: str, retries: int = 3) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    last = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.35 * (attempt + 1))
    raise RuntimeError(f"download failed: {url}: {last}")


def csv_rows(zip_bytes: bytes, expected_header: list[str]) -> list[dict]:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
        if not names:
            raise RuntimeError("zip has no csv")
        text = zf.read(names[0]).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    fieldnames = reader.fieldnames or []
    if fieldnames != expected_header:
        # Binance occasionally ships header-less files; fall back to positional rows.
        rows = list(csv.reader(io.StringIO(text)))
        if rows and rows[0] and rows[0][0] == expected_header[0]:
            rows = rows[1:]
        return [dict(zip(expected_header, row)) for row in rows if row]
    return list(reader)


def write_csv(path: str, header: list[str], rows: list[dict]):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=header, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in header})


def process_symbol(symbol: str, days: list[date], out_root: str, with_metrics: bool = True) -> dict:
    metrics_rows: list[dict] = []
    kline_rows: list[dict] = []
    missing: list[str] = []
    symbol_dir = os.path.join(out_root, symbol)

    for d in days:
        ds = d.isoformat()
        if with_metrics:
            url = f"{BASE}/metrics/{symbol}/{symbol}-metrics-{ds}.zip"
            try:
                metrics_rows.extend(csv_rows(fetch_bytes(url), METRICS_HEADER))
            except Exception as exc:  # noqa: BLE001
                missing.append(f"metrics:{ds}:{exc}")
        url = f"{BASE}/klines/{symbol}/5m/{symbol}-5m-{ds}.zip"
        try:
            kline_rows.extend(csv_rows(fetch_bytes(url), KLINES_HEADER))
        except Exception as exc:  # noqa: BLE001
            missing.append(f"klines:{ds}:{exc}")

    if with_metrics:
        # Archives may be shuffled; replay requires strict chronological order.
        metrics_rows.sort(key=lambda r: r.get("create_time", ""))
        write_csv(os.path.join(symbol_dir, "metrics.csv"), METRICS_HEADER, metrics_rows)
    kline_rows.sort(key=lambda r: int(float(r.get("open_time", 0) or 0)))
    write_csv(os.path.join(symbol_dir, "klines.csv"), KLINES_HEADER, kline_rows)

    meta = {
        "symbol": symbol,
        "days": len(days),
        "metricsRows": len(metrics_rows),
        "klineRows": len(kline_rows),
        "missing": missing,
    }
    with open(os.path.join(symbol_dir, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)
    return meta


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-10-23")
    ap.add_argument("--end", default="2026-11-22")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "..", "backtest-cache"))
    ap.add_argument("--symbols", default=",".join(DEFAULT_SYMBOLS))
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    days = list(dates_between(parse_date(args.start), parse_date(args.end)))
    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    if "BTCUSDT" not in symbols:
        symbols_for_download = symbols + ["BTCUSDT"]
    else:
        symbols_for_download = symbols

    out_root = os.path.abspath(args.out)
    os.makedirs(out_root, exist_ok=True)
    print(f"download {len(symbols_for_download)} symbols x {len(days)} days -> {out_root}")

    metas = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {
            pool.submit(process_symbol, sym, days, out_root, True): sym
            for sym in symbols_for_download
        }
        for fut in as_completed(futures):
            sym = futures[fut]
            try:
                meta = fut.result()
                metas.append(meta)
                print(f"  {sym}: klines={meta['klineRows']} metrics={meta['metricsRows']} missing={len(meta['missing'])}")
            except Exception as exc:  # noqa: BLE001
                print(f"  {sym}: FAILED {exc}", file=sys.stderr)

    summary = {
        "start": args.start,
        "end": args.end,
        "symbols": symbols,
        "metas": sorted(metas, key=lambda m: m["symbol"]),
    }
    with open(os.path.join(out_root, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if len(metas) == len(symbols_for_download) else 1


if __name__ == "__main__":
    raise SystemExit(main())
