'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, ColorType, CrosshairMode } from 'lightweight-charts';

function priceDecimals(value) {
  const a = Math.abs(Number(value));
  if (!Number.isFinite(a) || a === 0) return 2;
  if (a >= 1000) return 1;
  if (a >= 100) return 1;
  if (a >= 10) return 2;
  if (a >= 1) return 3;
  if (a >= 0.1) return 5;
  if (a >= 0.01) return 5;
  if (a >= 0.001) return 6;
  if (a >= 0.0001) return 6;
  if (a >= 0.00001) return 7;
  return 8;
}

function formatPrice(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const v = Number(value);
  const a = Math.abs(v);
  const decimals = priceDecimals(v);
  let body;
  if (a >= 1000) {
    body = v.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals,
    });
  } else {
    body = v.toFixed(decimals);
    if (body.includes('.')) {
      body = body.replace(/0+$/, '').replace(/\.$/, '');
    }
  }
  return `$${body}`;
}

function MiniSpark({ points, stroke = '#4f8cff', height = 36 }) {
  const path = useMemo(() => {
    if (!points?.length) return '';
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;
    const w = 160;
    const h = height;
    return points
      .map((v, i) => {
        const x = (i / Math.max(points.length - 1, 1)) * w;
        const y = h - ((v - min) / span) * (h - 4) - 2;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [points, height]);
  if (!points?.length) {
    return <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>暂无序列</div>;
  }
  return (
    <svg viewBox={`0 0 160 ${height}`} className="mini-spark" preserveAspectRatio="none">
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" />
    </svg>
  );
}

function AreaSpark({ points, stroke = '#4f8cff', height = 120 }) {
  const path = useMemo(() => {
    if (!points?.length) return { line: '', area: '' };
    const vals = points.map((p) => (typeof p === 'number' ? p : Number(p.v ?? p.oiUsdt ?? 0)));
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const w = 320;
    const h = height;
    const coords = vals.map((v, i) => {
      const x = (i / Math.max(vals.length - 1, 1)) * w;
      const y = h - ((v - min) / span) * (h - 10) - 5;
      return [x, y];
    });
    const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = `${line} L${coords[coords.length - 1][0].toFixed(1)},${h} L${coords[0][0].toFixed(1)},${h} Z`;
    return { line, area };
  }, [points, height]);
  if (!points?.length) return <div className="empty" style={{ height }}>暂无持仓序列</div>;
  return (
    <svg viewBox={`0 0 320 ${height}`} className="oi-area" preserveAspectRatio="none">
      <path d={path.area} fill="rgba(79,140,255,.15)" />
      <path d={path.line} fill="none" stroke={stroke} strokeWidth="2" />
    </svg>
  );
}

function CandleChart({ candles, height = 280 }) {
  const wrapRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!wrapRef.current) return undefined;
    const el = wrapRef.current;
    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: '#080e18' },
        textColor: '#8b9bb4',
      },
      grid: {
        vertLines: { color: 'rgba(26,37,56,.7)' },
        horzLines: { color: 'rgba(26,37,56,.7)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#1a2538' },
      timeScale: { borderColor: '#1a2538', timeVisible: true, secondsVisible: false },
    });
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });
    const volSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    chartRef.current = { chart, candleSeries, volSeries };

    const onResize = () => {
      if (!wrapRef.current) return;
      chart.applyOptions({ width: wrapRef.current.clientWidth });
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    const ref = chartRef.current;
    if (!ref || !candles?.length) return;
    const data = candles
      .filter((c) => c && c.t && Number.isFinite(c.o))
      .map((c) => ({
        time: Math.floor(Number(c.t) / 1000),
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      }));
    const vols = candles
      .filter((c) => c && c.t)
      .map((c) => ({
        time: Math.floor(Number(c.t) / 1000),
        value: Number(c.v) || 0,
        color: c.c >= c.o ? 'rgba(34,197,94,.45)' : 'rgba(239,68,68,.45)',
      }));
    // dedupe times ascending
    const seen = new Set();
    const uniq = [];
    for (const d of data) {
      if (seen.has(d.time)) continue;
      seen.add(d.time);
      uniq.push(d);
    }
    const seenV = new Set();
    const uniqV = [];
    for (const d of vols) {
      if (seenV.has(d.time)) continue;
      seenV.add(d.time);
      uniqV.push(d);
    }
    const px = candles[candles.length - 1]?.c ?? candles[candles.length - 1]?.close ?? candles[0]?.c;
    const dec = priceDecimals(px);
    const minMove = Number((10 ** -dec).toFixed(Math.min(dec, 8)));
    ref.candleSeries.applyOptions({
      priceFormat: { type: 'price', precision: dec, minMove: minMove || 0.01 },
    });
    ref.candleSeries.setData(uniq);
    ref.volSeries.setData(uniqV);
    ref.chart.timeScale().fitContent();
  }, [candles]);

  if (!candles?.length) {
    return <div className="empty" style={{ height }}>暂无合约K线</div>;
  }
  return <div ref={wrapRef} className="lw-chart" style={{ height }} />;
}

function StatusTag({ status }) {
  if (status === 'placeholder') return <span className="tag dim">占位</span>;
  if (status === 'mixed') return <span className="tag dim">部分估</span>;
  if (status === 'live') return <span className="tag live">实盘</span>;
  return null;
}

function LiqMap({ map }) {
  const buckets = map?.buckets || [];
  const maxBar = Math.max(1, ...buckets.map((b) => Math.max(b.long || 0, b.short || 0)));
  if (map?.empty || !buckets.length) {
    return (
      <div className="empty" style={{ padding: 16 }}>
        {map?.note || '暂无清算数据'}
      </div>
    );
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 16, fontWeight: 800, marginBottom: 8, fontSize: 12 }}>
        <span className="down">多头清算 {map.longLiq}</span>
        <span className="up">空头清算 {map.shortLiq}</span>
      </div>
      <div className="liq-bars dense">
        {[...buckets].reverse().map((b) => (
          <div key={b.price} className="liq-row">
            <span className="muted">{formatPrice(b.price)}</span>
            <div className="liq-track dual">
              <div className="liq-long" style={{ width: `${((b.long || 0) / maxBar) * 50}%` }} title={`多 ${b.long}`} />
              <div className="liq-mid" />
              <div className="liq-short" style={{ width: `${((b.short || 0) / maxBar) * 50}%` }} title={`空 ${b.short}`} />
            </div>
          </div>
        ))}
      </div>
      <div className="muted" style={{ marginTop: 6, fontSize: 10 }}>{map.note}</div>
    </div>
  );
}

function LsMiniChart({ series, label }) {
  const longs = (series || []).map((d) => d.long);
  const latest = series?.length ? series[series.length - 1] : null;
  return (
    <div className="stat-card ls-card">
      <div className="label">{label}</div>
      <div className="stat-val" style={{ fontSize: 13 }}>
        {latest ? (
          <>
            <span className="up">{latest.long}%</span>
            <span className="muted"> / </span>
            <span className="down">{latest.short}%</span>
          </>
        ) : '暂无'}
      </div>
      <MiniSpark points={longs} stroke="#38bdf8" height={40} />
    </div>
  );
}

export default function CoinDetailPage({ params }) {
  const symbol = String(params?.symbol || '').toUpperCase();
  const [coin, setCoin] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [chartMode, setChartMode] = useState('perp');
  const [tf, setTf] = useState('15m');
  const [layerMode, setLayerMode] = useState('price'); // price | flow | cvd
  const [centerRange, setCenterRange] = useState('15m');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/v1/coins/${encodeURIComponent(symbol)}?tf=${encodeURIComponent(tf)}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        if (!cancelled) {
          setCoin(body.coin || null);
          setErr('');
        }
      } catch (e) {
        if (!cancelled) {
          setCoin(null);
          setErr(e.message || '加载失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (symbol) load();
    return () => { cancelled = true; };
  }, [symbol, tf]);

  const candles = chartMode === 'spot'
    ? (coin?.candles?.spot || [])
    : (coin?.candles?.perp || []);

  const oiCombined = coin?.oiSeriesFull?.combined?.length
    ? coin.oiSeriesFull.combined
    : (coin?.layers?.openInterest?.seriesPts || coin?.layers?.openInterest?.series || []);

  const layerSpark = useMemo(() => {
    if (!coin?.layers) return [];
    if (layerMode === 'cvd') return coin.layers.cvd?.series || [];
    if (layerMode === 'flow') return coin.layers.futuresNetFlow?.series || [];
    return coin.layers.price?.series || coin.chart?.perp || [];
  }, [coin, layerMode]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" /> EzRadar</div>
        <Link href="/?tab=radar" className="back-link">← 返回雷达</Link>
      </header>

      <div className="coin-page coin-magma">
        {loading ? <div className="empty">加载 {symbol}…</div> : null}
        {err ? (
          <div className="err coin-not-listed">
            <strong>{symbol}</strong> — {err}
            {err.includes('未在币安') ? <div className="muted" style={{ marginTop: 6 }}>该币种未在币安 USDT 永续上架，请换 BTC / ETH / WLD / ARKM 等。</div> : null}
          </div>
        ) : null}

        {coin ? (
          <>
            <section className="coin-compact-head">
              <div className="coin-sym-row">
                <h1>{coin.pair || `${coin.symbol}/USDT`}</h1>
                <span className="tag">{coin.instrument || '永续'}</span>
                {coin.category ? <span className="tag">{coin.category}</span> : null}
                <StatusTag status="live" />
              </div>
              <div className="coin-compact-price">
                <span className="coin-price">{formatPrice(coin.price)}</span>
                <span className={`coin-chg ${(coin.change24h || 0) >= 0 ? 'up' : 'down'}`}>
                  {coin.change24hDisplay || '—'} <span className="muted">24h</span>
                </span>
              </div>
            </section>

            <div className="coin-3col">
              {/* LEFT */}
              <div className="coin-col left">
                <section className="coin-panel">
                  <div className="col-head">
                    <h2>合约K线</h2>
                    <div className="seg">
                      <button type="button" className={chartMode === 'perp' ? 'active' : ''} onClick={() => setChartMode('perp')}>永续</button>
                      <button type="button" className={chartMode === 'spot' ? 'active' : ''} onClick={() => setChartMode('spot')}>现货</button>
                    </div>
                    <span className="grow" />
                    <div className="seg">
                      {['15m', '1h', '4h', '1d'].map((t) => (
                        <button key={t} type="button" className={tf === t ? 'active' : ''} onClick={() => setTf(t)}>{t}</button>
                      ))}
                    </div>
                  </div>
                  <div className="chart-body">
                    <CandleChart candles={candles} height={300} />
                    <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
                      {coin.candles?.note || coin.chart?.note} · {chartMode === 'perp' ? '永续' : '现货'} · {tf}
                    </div>
                  </div>
                </section>

                <section className="coin-panel">
                  <div className="col-head">
                    <h2>相对表现</h2>
                    <StatusTag status="live" />
                    <span className="grow" />
                    <span className="muted" style={{ fontSize: 11 }}>Start=100</span>
                  </div>
                  <div className="chart-body">
                    <AreaSpark points={coin.relativePerf?.series || coin.chart?.perp || []} stroke="#a78bfa" height={100} />
                    <div className="chips" style={{ marginTop: 8 }}>
                      <span className="chip">相对BTC <b>{coin.relativePerf?.vsBtc}</b></span>
                      <span className="chip">相对ETH <b>{coin.relativePerf?.vsEth}</b></span>
                      <span className="chip">窗口 <b>{coin.relativePerf?.windowPct || '—'}</b></span>
                    </div>
                    <div className="muted" style={{ marginTop: 4, fontSize: 10 }}>{coin.relativePerf?.note}</div>
                  </div>
                </section>

                <section className="coin-panel">
                  <div className="col-head">
                    <h2>清算地图</h2>
                    <StatusTag status={coin.liquidationMap?.empty ? 'mixed' : 'live'} />
                  </div>
                  <div className="chart-body">
                    <LiqMap map={coin.liquidationMap} />
                  </div>
                </section>
              </div>

              {/* CENTER */}
              <div className="coin-col center">
                <section className="coin-panel grow-panel">
                  <div className="col-head">
                    <h2>全市场分层</h2>
                    <div className="seg">
                      <button type="button" className="active">全市场</button>
                    </div>
                    <span className="grow" />
                    <div className="seg">
                      {['15m', '1h', '4h', '1d'].map((t) => (
                        <button
                          key={t}
                          type="button"
                          className={centerRange === t ? 'active' : ''}
                          onClick={() => { setCenterRange(t); setTf(t); }}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="layer-toggles">
                    {[
                      ['price', '价格'],
                      ['flow', '净流入'],
                      ['cvd', 'CVD'],
                    ].map(([k, lab]) => (
                      <button
                        key={k}
                        type="button"
                        className={layerMode === k ? 'active' : ''}
                        onClick={() => setLayerMode(k)}
                      >
                        {lab}
                      </button>
                    ))}
                  </div>
                  <div className="chart-body">
                    <AreaSpark
                      points={layerSpark}
                      stroke={layerMode === 'cvd' ? '#f59e0b' : layerMode === 'flow' ? '#22c55e' : '#4f8cff'}
                      height={110}
                    />
                  </div>
                  <div className="layers-stack">
                    {[
                      ['openInterest', '#4f8cff', '未平仓'],
                      ['spotNetFlow', '#a78bfa', '现货净流入'],
                      ['futuresNetFlow', '#22c55e', '合约净流入'],
                      ['fundingRate', '#f59e0b', '资金费率'],
                      ['basis', '#38bdf8', '基差'],
                    ].map(([key, color, fallbackLabel]) => {
                      const layer = coin.layers?.[key];
                      if (!layer) return null;
                      return (
                        <div className="layer-row" key={key}>
                          <div className="layer-meta">
                            <div className="label">{layer.label || fallbackLabel}{layer.note ? ` · ${layer.note}` : ''}</div>
                            <div className="stat-val">{layer.value}</div>
                            {layer.delta ? <div className="muted">{layer.delta}</div> : null}
                          </div>
                          <MiniSpark points={layer.series || []} stroke={color} height={42} />
                        </div>
                      );
                    })}
                  </div>
                  <div className="chart-body" style={{ paddingTop: 0 }}>
                    <div className="label">全网持仓序列</div>
                    <AreaSpark points={oiCombined} stroke="#4f8cff" height={120} />
                    <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
                      {coin.oiSeriesFull?.note || coin.layers?.openInterest?.note}
                    </div>
                  </div>
                </section>
              </div>

              {/* RIGHT */}
              <div className="coin-col right">
                <section className="coin-panel">
                  <div className="col-head">
                    <h2>BINANCE 多空比</h2>
                    <StatusTag status={coin.lsCharts?.globalAccount?.latest ? 'live' : 'mixed'} />
                  </div>
                  <div className="ls-stack">
                    <LsMiniChart
                      label={coin.lsCharts?.topAccount?.label || '账户多空比'}
                      series={coin.lsCharts?.topAccount?.series}
                    />
                    <LsMiniChart
                      label={coin.lsCharts?.topPosition?.label || '持仓多空比'}
                      series={coin.lsCharts?.topPosition?.series}
                    />
                    <LsMiniChart
                      label={coin.lsCharts?.globalAccount?.label || '全球多空比'}
                      series={coin.lsCharts?.globalAccount?.series}
                    />
                  </div>
                </section>

                <section className="coin-panel">
                  <div className="col-head">
                    <h2>分交易所未平仓</h2>
                    <StatusTag status="mixed" />
                  </div>
                  <div className="scroll">
                    <table className="coin-table">
                      <thead>
                        <tr>
                          <th>交易所</th>
                          <th>未平仓</th>
                          <th>占比</th>
                          <th>1小时</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(coin.oiByExchange || []).map((r) => (
                          <tr key={r.exchange} className={r.real ? '' : 'dim-row'}>
                            <td>{r.exchange}</td>
                            <td>{r.oiDisplay}</td>
                            <td>{r.shareDisplay ?? '—'}</td>
                            <td className={r.change1h == null ? '' : r.change1h >= 0 ? 'up' : 'down'}>
                              {r.change1hDisplay || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="muted" style={{ padding: '6px 10px', fontSize: 11 }}>
                      币安 / OKX / Gate 有公开数据则展示；其余标「暂无」，不伪造。
                    </div>
                  </div>
                </section>

                <section className="coin-panel">
                  <div className="col-head"><h2>近期异动 — {coin.symbol}</h2></div>
                  <div className="scroll" style={{ maxHeight: 220 }}>
                    {(coin.anomalies || []).length ? (
                      coin.anomalies.slice(0, 8).map((a) => (
                        <article key={a.id} className="card compact">
                          <div className="card-top">
                            <span className="card-time">{a.timeLabel || ''}</span>
                            <span className={`event ${a.side}`}>{a.eventLabel}</span>
                          </div>
                          <div className={`last-line ${a.side === 'up' ? 'up' : 'down'}`}>{a.lastLine}</div>
                        </article>
                      ))
                    ) : (
                      <div className="empty">该币种暂无近期异动。</div>
                    )}
                  </div>
                </section>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
