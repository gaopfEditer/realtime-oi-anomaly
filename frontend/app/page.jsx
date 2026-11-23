'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const DEMO_EMAIL = '';
const DEMO_PASSWORD = '';
const TABS = [
  { id: 'radar', label: '雷达' },
  { id: 'global', label: '全球' },
  { id: 'macro', label: '宏观' },
  { id: 'fund', label: '资金' },
];
const BOARD_WINDOWS = ['15m', '30m', '1h', '4h', '1d', '3d'];
const DEFAULT_POLL_MS = 10000;

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
  if (value == null || !Number.isFinite(Number(value))) return '••••';
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

function formatChange(value) {
  if (value == null) return '••••';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function clock(ts) {
  if (!ts) return '--:--';
  return new Date(ts).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Hong_Kong',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function clockFull(ts) {
  if (!ts) return '--:--:--';
  return new Date(ts).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Hong_Kong',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function TickerLink({ symbol, className = '' }) {
  if (!symbol || symbol === '••••') return <span className={className || 'ticker'}>{symbol || '—'}</span>;
  return (
    <Link href={`/coin/${encodeURIComponent(symbol)}`} className={`ticker-link ${className}`.trim()}>
      {symbol}
    </Link>
  );
}

function AuthBar({ token, email, password, loginBusy, loginError, onEmail, onPassword, onLogin, onLogout, vipRequired }) {
  return (
    <div className="auth">
      {!vipRequired ? <span className="debug-badge">VIP关</span> : null}
      {token ? (
        <>
          <span className="vip-badge">VIP</span>
          <button type="button" className="btn ghost" onClick={onLogout}>退出</button>
        </>
      ) : (
        <form
          className="auth"
          onSubmit={(e) => {
            e.preventDefault();
            onLogin();
          }}
        >
          <input type="email" value={email} onChange={(e) => onEmail(e.target.value)} placeholder="邮箱" aria-label="邮箱" />
          <input type="password" value={password} onChange={(e) => onPassword(e.target.value)} placeholder="密码" aria-label="密码" />
          <button type="submit" className="btn vip" disabled={loginBusy}>{loginBusy ? '…' : '登录'}</button>
          {loginError ? <span className="err" style={{ margin: 0, padding: '2px 6px' }}>{loginError}</span> : null}
        </form>
      )}
    </div>
  );
}

function ChipRow({ chips, resonance, resonanceLong }) {
  const items = [];
  if (chips?.self != null) items.push(['自身', chips.self]);
  if (chips?.mktStrength != null) items.push(['强度', chips.mktStrength]);
  if (chips?.mktValue != null) items.push(['市值', chips.mktValue]);
  const wins = [...(resonance || []), ...(resonanceLong || [])].slice(0, 6);
  if (!items.length && !wins.length) return null;
  return (
    <div className="chips">
      {items.map(([label, n]) => (
        <span key={label} className="chip">{label}<b>#{n}</b></span>
      ))}
      {wins.map((w) => (
        <span key={`r-${w}`} className="chip chip-win">{w}</span>
      ))}
    </div>
  );
}

function TickMarks({ ticks, side }) {
  const vals = Array.isArray(ticks) && ticks.length ? ticks : [0.3, 0.5, 0.4, 0.7, 0.45, 0.6];
  return (
    <div className="ticks" aria-hidden>
      {vals.slice(0, 6).map((t, i) => (
        <span
          key={i}
          className={`tick ${t >= 0.35 ? 'on' : ''} ${side || ''}`}
          style={{ height: `${Math.max(2, Math.round(Number(t) * 10))}px` }}
        />
      ))}
    </div>
  );
}

function AnomalyCol({ anomalies, meta, q, setQ, kind, setKind, showLock, onLoginFocus }) {
  const prevIds = useRef(new Set());
  const [flash, setFlash] = useState({});

  useEffect(() => {
    const nextFlash = {};
    const ids = new Set(anomalies.map((a) => a.id));
    for (const a of anomalies) {
      if (!prevIds.current.has(a.id)) nextFlash[a.id] = a.side;
    }
    prevIds.current = ids;
    if (Object.keys(nextFlash).length) {
      setFlash(nextFlash);
      const t = setTimeout(() => setFlash({}), 500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [anomalies]);

  const locked = Boolean(meta?.locked) && showLock;
  const hasLockedRows = showLock && anomalies.some((a) => a.locked);
  const visible = anomalies.filter((a) => {
    if (kind === 'oi') return a.eventKind === 'oi';
    if (kind === 'price') return a.eventKind === 'price';
    if (kind === 'state') return a.eventKind === 'state';
    return true;
  });

  return (
    <section className="col col-left">
      <div className="col-head">
        <h2>全市场扫描</h2>
        <span className="grow" />
        <div className="seg">
          <button type="button" className={kind === 'all' ? 'active' : ''} onClick={() => setKind('all')}>全部</button>
          <button type="button" className={kind === 'oi' ? 'active' : ''} onClick={() => setKind('oi')}>OI</button>
          <button type="button" className={kind === 'price' ? 'active' : ''} onClick={() => setKind('price')}>价格</button>
          <button type="button" className={kind === 'state' ? 'active' : ''} onClick={() => setKind('state')}>共振</button>
        </div>
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" />
      </div>
      <div className="scroll">
        {visible.map((a) => (
          <article
            key={a.id}
            className={`card ${a.eventKind === 'state' ? 'card-state' : ''} ${a.locked && showLock ? 'locked' : ''} ${flash[a.id] === 'up' ? 'flash-up' : ''} ${flash[a.id] === 'down' ? 'flash-down' : ''}`}
          >
            <div className="card-top">
              <span className="card-time">{a.timeLabel || clock(a.ts)}</span>
              <span className={`card-mark ${a.side}`} />
              <TickerLink symbol={a.symbol} />
              <span className={`event ${a.side}`}>{a.eventLabel}</span>
            </div>
            <div className={`last-line ${a.side === 'up' ? 'up' : a.side === 'down' ? 'down' : ''}`}>{a.lastLine}</div>
            <ChipRow chips={a.chips} />
          </article>
        ))}
        {!visible.length ? <div className="empty">暂无异动</div> : null}
        {(locked || hasLockedRows) ? (
          <div className="lock-overlay">
            <div className="lock-card">
              <h3>VIP 解锁完整 OI 异动</h3>
              <p>游客仅可预览部分异动。</p>
              <button type="button" className="btn vip" onClick={onLoginFocus}>VIP 登录</button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function HotBoardsCol({ boards, window, setWindow, boardMeta }) {
  const ttlSec = Math.round((boardMeta?.cacheTtlMs || boardMeta?.boardRefreshMs || 20000) / 1000);
  return (
    <section className="col col-center">
      <div className="col-head">
        <h2>热钱观察榜</h2>
        <span className="muted" style={{ fontSize: 11 }}>刷新≈{ttlSec}s · {boardMeta?.updatedAt ? clock(boardMeta.updatedAt) : '—'}</span>
        <span className="grow" />
        <div className="seg windows">
          {BOARD_WINDOWS.map((w) => (
            <button key={w} type="button" className={window === w ? 'active' : ''} onClick={() => setWindow(w)}>{w}</button>
          ))}
        </div>
      </div>
      <div className="scroll">
        <div className="boards-grid boards-4x4">
          {(boards || []).map((b) => (
            <div key={b.key} className="mini-board">
              <div className="mini-head">
                <h3 title={b.title}>{b.title}</h3>
                {b.note || b.estimated ? <span className="est-badge" title={b.note || '估算'}>估</span> : null}
              </div>
              {(b.rows || []).slice(0, 7).map((r) => {
                const isStr = b.metric === 'strength';
                const mainVal = isStr ? String(r.strength ?? r.display) : r.display;
                const aux = isStr ? r.auxDisplay : (r.strength != null ? r.strength : null);
                const winDots = [...(r.resonance || []), ...(r.resonanceLong || [])].slice(0, 6);
                return (
                <div key={`${b.key}-${r.symbol}`} className="mini-row">
                  <span className="rank">{r.rank}</span>
                  <div className="sym-cell">
                    <TickerLink symbol={r.symbol} />
                    {winDots.length ? (
                      <span className="res-dots" title={winDots.join(' · ')}>
                        {winDots.map((w) => <i key={w} className="res-dot" data-w={w} />)}
                      </span>
                    ) : null}
                  </div>
                  <span className="str muted">{aux != null ? aux : ''}</span>
                  <TickMarks ticks={r.ticks} side={r.side} />
                  <span className={`val ${r.side === 'up' ? 'up' : 'down'}`}>{mainVal}</span>
                </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FlowList({ title, rows, mode }) {
  return (
    <div className="rail-block">
      <div className="rb-head">{title}</div>
      {(rows || []).slice(0, 8).map((r) => {
        const flow = r.flow || '混合';
        const pillClass = flow === '流入' ? 'in' : flow === '流出' ? 'out' : 'mix';
        const n = r.N != null ? r.N : r.boardCount;
        return (
          <div key={`${title}-${r.symbol}-${r.rank}`} className="rail-row">
            <span className="rank">{r.rank}</span>
            <TickerLink symbol={r.symbol} />
            <span className="boards-n">{mode === 'intensity'
              ? (r.intensity != null ? `Str ${r.intensity}` : '')
              : (n != null ? `N=${n}` : '')}</span>
            <span className={`flow-pill ${pillClass}`}>{flow}</span>
          </div>
        );
      })}
      {!(rows || []).length ? <div className="empty" style={{ padding: 12 }}>暂无数据</div> : null}
    </div>
  );
}

function OverviewCol({ overview }) {
  const o = overview || {};
  const rows = o.marketRows || [];
  return (
    <section className="col col-right">
      <div className="col-head">
        <h2>市场动量</h2>
        <span className="muted">{o.updatedAt ? clock(o.updatedAt) : ''}</span>
      </div>
      <div className="scroll">
        <FlowList title="资金共振" rows={o.confluenceList} mode="confluence" />
        <FlowList title="流向强度" rows={o.forceList || o.intensityList} mode="intensity" />
        <div className="rail-block">
          <div className="rb-head">市场概览</div>
          {rows.map((r) => (
            <div key={r.key} className="mkt-row">
              <span className="lab">{r.label}</span>
              <span className={`num ${r.side === 'up' ? 'up' : r.side === 'down' ? 'down' : ''}`}>{r.value}</span>
              <div className="sub">
                <span><b>{r.regime || '—'}</b></span>
                <span>较上期 {r.vsPrior || '—'}</span>
              </div>
            </div>
          ))}
          {!rows.length ? <div className="empty" style={{ padding: 12 }}>暂无概览</div> : null}
        </div>
      </div>
    </section>
  );
}

export default function HomePage() {
  const initialTab = useMemo(() => {
    if (typeof window === 'undefined') return 'radar';
    const sp = new URLSearchParams(window.location.search);
    const t = sp.get('tab');
    return TABS.some((x) => x.id === t) ? t : 'radar';
  }, []);

  const [tab, setTab] = useState(initialTab);
  const [email, setEmail] = useState(DEMO_EMAIL);
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [token, setToken] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [vipRequired, setVipRequired] = useState(false);
  const [pollMs, setPollMs] = useState(DEFAULT_POLL_MS);
  const [nowTs, setNowTs] = useState(Date.now());

  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  const [anomalies, setAnomalies] = useState([]);
  const [anomMeta, setAnomMeta] = useState(null);
  const [anomErr, setAnomErr] = useState('');

  const [boardWindow, setBoardWindow] = useState('15m');
  const [boards, setBoards] = useState([]);
  const [boardMeta, setBoardMeta] = useState(null);
  const [overview, setOverview] = useState(null);

  const [coins, setCoins] = useState([]);
  const [coinsErr, setCoinsErr] = useState('');

  const authHeader = useMemo(
    () => (token ? { Authorization: `Bearer ${token}` } : {}),
    [token],
  );

  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/v1/config');
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled) return;
        setVipRequired(Boolean(body.vipRequired));
        if (body.pollHintMs) setPollMs(Number(body.pollHintMs) || DEFAULT_POLL_MS);
      } catch (_err) { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const switchTab = useCallback((id) => {
    setTab(id);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', id);
      window.history.replaceState({}, '', url);
    }
  }, []);

  const loadRadar = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ kind });
      if (q.trim()) qs.set('q', q.trim());
      const [aRes, bRes, oRes] = await Promise.all([
        fetch(`/api/v1/anomalies?${qs}`, { headers: authHeader }),
        fetch(`/api/v1/hot-boards?window=${boardWindow}`, { headers: authHeader }),
        fetch('/api/v1/overview', { headers: authHeader }),
      ]);
      const aBody = await aRes.json();
      const bBody = await bRes.json();
      const oBody = await oRes.json();
      if (!aRes.ok) throw new Error(aBody.error || `anomalies ${aRes.status}`);
      setAnomalies(Array.isArray(aBody.anomalies) ? aBody.anomalies : []);
      setAnomMeta(aBody.meta || null);
      if (typeof aBody.meta?.vipRequired === 'boolean') setVipRequired(aBody.meta.vipRequired);
      if (aBody.meta?.tickMs) setPollMs(Number(aBody.meta.tickMs) || DEFAULT_POLL_MS);
      setBoards(Array.isArray(bBody.boards) ? bBody.boards : []);
      setBoardMeta(bBody.meta || null);
      setOverview(oBody.overview || null);
      setAnomErr('');
    } catch (err) {
      setAnomErr(err.message || '雷达加载失败');
    }
  }, [authHeader, boardWindow, kind, q]);

  useEffect(() => {
    if (tab !== 'radar') return undefined;
    let cancelled = false;
    async function tick() {
      if (!cancelled) await loadRadar();
    }
    tick();
    const id = setInterval(tick, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tab, loadRadar, pollMs]);

  useEffect(() => {
    if (tab !== 'global') return undefined;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/v1/coins');
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        if (!cancelled) {
          setCoins(Array.isArray(body.coins) ? body.coins : []);
          setCoinsErr('');
        }
      } catch (err) {
        if (!cancelled) setCoinsErr(err.message || '币种加载失败');
      }
    }
    load();
    const id = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tab]);

  async function handleLogin() {
    setLoginBusy(true);
    setLoginError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || '登录失败');
      setToken(body.token);
    } catch (err) {
      setToken('');
      setLoginError(err.message || '登录失败');
    } finally {
      setLoginBusy(false);
    }
  }

  function handleLogout() {
    setToken('');
    setLoginError('');
  }

  const showLock = vipRequired && !token;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" /> EzRadar</div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => switchTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        {tab === 'radar' ? (
          <span className="top-live">
            <span className="live"><span className="live-dot" /> 实时</span>
            <span className="clock-now">{clockFull(nowTs)}</span>
            <span className="muted">更新于 {anomMeta?.updatedAt ? clock(anomMeta.updatedAt) : '—'}</span>
          </span>
        ) : null}
        <AuthBar
          token={token}
          email={email}
          password={password}
          loginBusy={loginBusy}
          loginError={loginError}
          onEmail={setEmail}
          onPassword={setPassword}
          onLogin={handleLogin}
          onLogout={handleLogout}
          vipRequired={vipRequired}
        />
      </header>

      {tab === 'radar' ? (
        <>
          {anomErr ? <div className="err">{anomErr}</div> : null}
          <div className="workspace">
            <AnomalyCol
              anomalies={anomalies}
              meta={anomMeta}
              q={q}
              setQ={setQ}
              kind={kind}
              setKind={setKind}
              showLock={showLock}
              onLoginFocus={() => {}}
            />
            <HotBoardsCol boards={boards} window={boardWindow} setWindow={setBoardWindow} boardMeta={boardMeta} />
            <OverviewCol overview={overview} />
          </div>
        </>
      ) : null}

      {tab === 'global' ? (
        <div className="simple-main">
          {coinsErr ? <div className="err">{coinsErr}</div> : null}
          <section className="col" style={{ overflow: 'auto', height: '100%' }}>
            <div className="col-head"><h2>全球币种（演示）</h2></div>
            <table className="coin-table">
              <thead>
                <tr>
                  <th>币种</th><th>名称</th><th>价格</th><th>24h成交量</th><th>涨跌</th>
                </tr>
              </thead>
              <tbody>
                {coins.map((c) => (
                  <tr key={c.id}>
                    <td><TickerLink symbol={c.id} /></td>
                    <td>{c.name}</td>
                    <td className="val">{formatPrice(c.price)}</td>
                    <td>{c.vol24h}</td>
                    <td className={c.change >= 0 ? 'up' : 'down'}>{formatChange(c.change)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      ) : null}

      {tab === 'macro' || tab === 'fund' ? (
        <div className="simple-main">
          <div className="empty">
            <h2>{tab === 'macro' ? '宏观' : '资金'} — 暂未开放</h2>
            <p>预留模块。当前以雷达 OI 异动台为主。</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
