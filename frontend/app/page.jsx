'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const DEMO_EMAIL = '';
const DEMO_PASSWORD = '';
const TABS = [
  { id: 'radar', label: '雷达' },
  { id: 'watch', label: '观察池' },
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

function signedPct(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const v = Number(value);
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

function remainText(sec) {
  const v = Math.max(0, Number(sec) || 0);
  if (v <= 0) return '已到期';
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(v % 60)}s`;
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


const WATCH_FILTERS = [
  { id: 'active', label: '活跃' },
  { id: 'setup', label: '构筑' },
  { id: 'armed', label: '待触发' },
  { id: 'triggered', label: '已触发' },
  { id: 'invalid', label: '失效' },
  { id: 'all', label: '全部' },
];

function WatchCard({ entry, active, onSelect }) {
  const plan = entry.plan || {};
  const side = plan.activeSide === 'short' ? 'short' : 'long';
  const p = plan[side] || {};
  const m = entry.metrics || {};
  const warn = (entry.warnings || [])[0];
  return (
    <button
      type="button"
      className={`watch-card watch-stage-${entry.stage} ${active ? 'selected' : ''}`}
      onClick={() => onSelect(entry.symbol)}
      aria-pressed={active}
    >
      <div className="watch-card-head">
        <span className={`watch-stage ${entry.stage}`}>{entry.stageLabel}</span>
        <span className="watch-sym">{entry.symbol}</span>
        <span className={`watch-bias ${entry.bias}`}>{entry.biasLabel}</span>
        <span className="grow" />
        <span className={`watch-grade ${entry.grade}`}>{entry.grade}</span>
        <span className="watch-score">{entry.score}</span>
      </div>
      <div className="watch-card-mid">
        <span className="watch-price">{formatPrice(m.price)}</span>
        <span className={m.priceSinceDetectPct >= 0 ? 'up' : 'down'}>{signedPct(m.priceSinceDetectPct)}</span>
        <span className="muted">侦测后</span>
        <span className="grow" />
        <span className="watch-oi">OI 保留 <b>{m.oiRetentionPct}%</b></span>
      </div>
      <div className="watch-plan-line">
        <span className={`watch-side-tag ${side}`}>{plan.activeSide === 'both' ? '双向' : p.sideLabel}</span>
        <span>触发 <b>{formatPrice(p.trigger)}</b></span>
        <span>止损 <b>{formatPrice(p.stop)}</b></span>
        <span>T1 <b>{formatPrice(p.target1)}</b></span>
        <span className="muted">RR {p.rr || 1.5}</span>
      </div>
      <div className="watch-tags">
        <span>量比 {m.volumeRatio}x</span>
        <span>FR {m.fundingDisplay}</span>
        <span>箱体 {m.boxWidthAtr} ATR</span>
        {warn ? <span className="watch-warn-inline" title={warn}>{warn}</span> : null}
      </div>
      {entry.triggered ? (
        <div className={`watch-triggered-note ${entry.outcome?.status || 'running'}`}>
          {entry.triggered.side === 'long' ? '多' : '空'}单已于 {clock(entry.triggered.at)} 触发 · {entry.outcome?.note || '持有观察'}
        </div>
      ) : null}
    </button>
  );
}

function WatchDetail({ entry, nowTs, onDismiss, dismissBusy }) {
  if (!entry) {
    return (
      <aside className="watch-side watch-intro">
        <h2>怎么用这个观察池</h2>
        <p>OI 异动只说明杠杆在进场或离场，<b>不直接给方向</b>。入池后先等 5 分钟，再等 20 分钟箱体收敛，最后等放量突破触发位。</p>
        <ol>
          <li><b>刚侦测</b>：只记录，不追第一根。</li>
          <li><b>确认中</b>：OI 没回吐、价格开始跟随。</li>
          <li><b>构筑中</b>：箱体收紧，算多空两套触发/止损。</li>
          <li><b>待触发</b>：价格靠近触发位，等放量。</li>
          <li><b>已触发</b>：按计划执行；失效就看 OI 回吐与价格破坏。</li>
        </ol>
        <p className="wd-note">仓位建议：单笔风险 0.5%–1% 账户权益；山寨币滑点大，触发后优先等回踩，不追已经离开触发位 0.5 ATR 的价格。</p>
      </aside>
    );
  }
  const m = entry.metrics || {};
  const plan = entry.plan || {};
  const p = plan[entry.triggered?.side || (entry.bias === 'short' ? 'short' : 'long')] || plan.long || {};
  return (
    <aside className="watch-side">
      <div className="wd-head">
        <div className="wd-title">
          <span className={`watch-stage ${entry.stage}`}>{entry.stageLabel}</span>
          <div className="wd-sym-row">
            <h2>{entry.symbol}</h2>
            <span className={`watch-bias ${entry.bias}`}>{entry.biasLabel}</span>
          </div>
          <span className="wd-name">{entry.name} · {entry.category}</span>
        </div>
        <div className={`wd-score ${entry.grade}`}>
          <b>{entry.score}</b>
          <span>{entry.grade}</span>
        </div>
      </div>
      <div className="wd-sub">
        <span>侦测 {clock(entry.createdAt)}</span>
        <span>已观察 {entry.ageMin} 分钟</span>
        <span>剩余 {remainText(Math.floor((entry.expiresAt - nowTs) / 1000))}</span>
      </div>

      {entry.triggered ? (
        <div className={`wd-triggered ${entry.outcome?.status || 'running'}`}>
          <b>{entry.triggered.side === 'long' ? '多单' : '空单'}已触发</b>
          <span>{clock(entry.triggered.at)} @ {formatPrice(entry.triggered.price)}</span>
          <span>{entry.outcome?.note || '持有观察'} · 最大有利 {signedPct(entry.outcome?.favorablePct)} / 最大不利 {signedPct(entry.outcome?.adversePct)}</span>
        </div>
      ) : null}

      <div className="wd-metrics">
        <div className="wd-metric"><span>现价</span><b>{formatPrice(m.price)}</b><i className={m.priceSinceDetectPct >= 0 ? 'up' : 'down'}>{signedPct(m.priceSinceDetectPct)}</i></div>
        <div className="wd-metric"><span>OI 保留</span><b>{m.oiRetentionPct}%</b><i>侦测后 {signedPct(m.oiSinceDetectPct)}</i></div>
        <div className="wd-metric"><span>资金费率</span><b>{m.fundingDisplay}</b><i>拥挤度参考</i></div>
        <div className="wd-metric"><span>量比</span><b>{m.volumeRatio}x</b><i>近 3 根 / 异动前</i></div>
        <div className="wd-metric"><span>触发量</span><b>{m.barVolumeRatio}x</b><i>前 20 根均量 · 0.9–1.5</i></div>
        <div className="wd-metric"><span>高周期</span><b>{m.tf15 === 'up' ? '多' : m.tf15 === 'down' ? '空' : '—'} / {m.tf1h === 'up' ? '多' : m.tf1h === 'down' ? '空' : '—'}</b><i>15m / 1h EMA8-21</i></div>
        <div className="wd-metric"><span>箱体</span><b>{formatPrice(m.boxLow)}–{formatPrice(m.boxHigh)}</b><i>{m.boxWidthAtr} ATR / {m.boxWidthPct}%</i></div>
        <div className="wd-metric"><span>ATR</span><b>{m.atrPct}%</b><i>5m · 止损基准</i></div>
        <div className="wd-metric"><span>VWAP</span><b>{formatPrice(m.vwap)}</b><i>现价偏离 {signedPct(m.vwapDistancePct)}</i></div>
        <div className="wd-metric"><span>24h 成交额</span><b>{m.quoteVolumeDisplay}</b><i>BTC 15m {signedPct(m.btc15mPct)}</i></div>
      </div>

      <div className="wd-section">
        <h3>双向入场计划 <span className="muted">触发后才执行，不提前埋伏</span></h3>
        <div className="wd-plans">
          {['long', 'short'].map((side) => {
            const q = plan[side];
            if (!q) return null;
            const isActive = entry.triggered ? entry.triggered.side === side : plan.activeSide === side;
            return (
              <div key={side} className={`wd-plan ${side} ${isActive ? 'active' : ''} ${q.valid ? '' : 'invalid'}`}>
                <div className="wd-plan-head">
                  <b>{q.sideLabel}计划</b>
                  <span>{q.valid ? '结构可用' : '暂不可用'}</span>
                </div>
                <div className="wd-levels">
                  <span>触发 <b>{formatPrice(q.trigger)}</b></span>
                  <span>止损 <b>{formatPrice(q.stop)}</b></span>
                  <span>T1 <b>{formatPrice(q.target1)}</b></span>
                  <span>T2 <b>{formatPrice(q.target2)}</b></span>
                </div>
                <div className="wd-plan-foot">
                  RR {q.rr}/{q.rr2} · 止损距离 {q.stopPct}% · 距触发 {signedPct(q.triggerDistancePct)}
                </div>
                <div className="wd-plan-note">{q.note}</div>
              </div>
            );
          })}
        </div>
      </div>

      {(entry.reasons || []).length ? (
        <div className="wd-section">
          <h3>入池理由</h3>
          <ul className="wd-list">
            {entry.reasons.slice(0, 5).map((r) => <li key={r}>{r}</li>)}
          </ul>
        </div>
      ) : null}

      {(entry.warnings || []).length ? (
        <div className="wd-section">
          <h3>风险提示</h3>
          <ul className="wd-list warn">
            {entry.warnings.slice(0, 5).map((r) => <li key={r}>{r}</li>)}
          </ul>
        </div>
      ) : null}

      <div className="wd-section">
        <h3>失效条件</h3>
        <ul className="wd-check">
          {(entry.invalidation || []).map((x) => (
            <li key={x.key} className={x.ok ? 'ok' : 'bad'}>
              <span>{x.ok ? '✓' : '✕'}</span>
              <b>{x.label}</b>
              <i>{x.detail}</i>
            </li>
          ))}
        </ul>
      </div>

      <div className="wd-section">
        <h3>阶段时间线</h3>
        <ol className="wd-timeline">
          {(entry.timeline || []).slice(-7).reverse().map((t, i) => (
            <li key={`${t.ts}-${i}`}>
              <span>{clock(t.ts)}</span>
              <b>{t.label}</b>
              <i>{t.note}</i>
            </li>
          ))}
        </ol>
      </div>

      <div className="wd-actions">
        <Link href={`/coin/${encodeURIComponent(entry.symbol)}`} className="btn ghost">币种详情</Link>
        <button type="button" className="btn ghost danger" disabled={dismissBusy === entry.symbol} onClick={() => onDismiss(entry.symbol)}>
          {dismissBusy === entry.symbol ? '…' : '移出观察池'}
        </button>
      </div>
      <p className="wd-note">更新 {clockFull(entry.updatedAt)} · 数据 {entry.source} · 规则辅助，不构成投资建议</p>
    </aside>
  );
}

function WatchView({ entries, meta, err, loaded, stage, setStage, q, setQ, selected, onSelect, nowTs, onDismiss, dismissBusy }) {
  const counts = meta?.counts || {};
  const updated = meta?.generatedAt ? clock(meta.generatedAt) : '—';
  return (
    <main className="watch-page">
      <div className="watch-top">
        <div className="watch-summary">
          <span><i className="dot active" />活跃 <b>{counts.active ?? 0}</b></span>
          <span><i className="dot armed" />待触发 <b>{counts.armed ?? 0}</b></span>
          <span><i className="dot hot" />已触发 <b>{counts.triggered ?? 0}</b></span>
          <span><i className="dot bad" />失效 <b>{(counts.invalid ?? 0) + (counts.expired ?? 0)}</b></span>
        </div>
        <div className="seg watch-seg">
          {WATCH_FILTERS.map((f) => (
            <button key={f.id} type="button" className={stage === f.id ? 'active' : ''} onClick={() => setStage(f.id)}>{f.label}</button>
          ))}
        </div>
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索币种" aria-label="搜索观察池" />
        <span className="muted watch-updated">更新 {updated} · {meta?.tickMs ? `${Math.round(meta.tickMs / 1000)}s` : '—'}</span>
      </div>
      {err ? <div className="err">{err}</div> : null}
      <div className="watch-body">
        <div className="watch-list">
          {entries.map((e) => (
            <WatchCard key={`${e.symbol}-${e.id}`} entry={e} active={selected === e.symbol} onSelect={onSelect} />
          ))}
          {!entries.length ? (
            <div className="watch-empty">
              <h3>{loaded ? '暂无观察中的币种' : '加载中…'}</h3>
              <p>OI 异动出现后会自动入池。若雷达暂时没有大额异动，这里保持为空是正常的，不硬推。</p>
            </div>
          ) : null}
        </div>
        <WatchDetail entry={selected} nowTs={nowTs} onDismiss={onDismiss} dismissBusy={dismissBusy} />
      </div>
    </main>
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

  const [watchStage, setWatchStage] = useState('active');
  const [watchQ, setWatchQ] = useState('');
  const [watch, setWatch] = useState([]);
  const [watchMeta, setWatchMeta] = useState(null);
  const [watchErr, setWatchErr] = useState('');
  const [watchLoaded, setWatchLoaded] = useState(false);
  const [watchSel, setWatchSel] = useState('');
  const [dismissBusy, setDismissBusy] = useState('');
  const watchReqRef = useRef(0);

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

  const loadWatch = useCallback(async () => {
    const reqId = watchReqRef.current + 1;
    watchReqRef.current = reqId;
    try {
      const qs = new URLSearchParams({ stage: watchStage });
      if (watchQ.trim()) qs.set('q', watchQ.trim());
      const res = await fetch(`/api/v1/watchlist?${qs}`, { headers: authHeader });
      const body = await res.json();
      if (watchReqRef.current !== reqId) return;
      if (!res.ok) throw new Error(body.error || `watchlist ${res.status}`);
      setWatch(Array.isArray(body.entries) ? body.entries : []);
      setWatchMeta(body.meta || null);
      setWatchErr('');
    } catch (err) {
      if (watchReqRef.current !== reqId) return;
      setWatchErr(err.message || '观察池加载失败');
    } finally {
      if (watchReqRef.current === reqId) setWatchLoaded(true);
    }
  }, [authHeader, watchQ, watchStage]);

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
    if (tab !== 'watch') return undefined;
    let cancelled = false;
    async function tick() {
      if (!cancelled) await loadWatch();
    }
    tick();
    const id = setInterval(tick, pollMs);
    return () => {
      cancelled = true;
      watchReqRef.current += 1;
      clearInterval(id);
    };
  }, [tab, loadWatch, pollMs]);

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

  async function handleDismissWatch(symbol) {
    setDismissBusy(symbol);
    try {
      const res = await fetch(`/api/v1/watchlist/${encodeURIComponent(symbol)}/dismiss`, {
        method: 'POST',
        headers: authHeader,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `dismiss ${res.status}`);
      if (watchSel === symbol) setWatchSel('');
      await loadWatch();
      setWatchErr('');
    } catch (err) {
      setWatchErr(err.message || '移出失败');
    } finally {
      setDismissBusy('');
    }
  }

  function handleLogout() {
    setToken('');
    setLoginError('');
  }

  const showLock = vipRequired && !token;
  const selectedWatch = useMemo(
    () => watch.find((e) => e.symbol === watchSel) || null,
    [watch, watchSel],
  );

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

      {tab === 'watch' ? (
        <WatchView
          entries={watch}
          meta={watchMeta}
          err={watchErr}
          loaded={watchLoaded}
          stage={watchStage}
          setStage={setWatchStage}
          q={watchQ}
          setQ={setWatchQ}
          selected={selectedWatch}
          onSelect={setWatchSel}
          nowTs={nowTs}
          onDismiss={handleDismissWatch}
          dismissBusy={dismissBusy}
        />
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
