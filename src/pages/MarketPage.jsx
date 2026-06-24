import { useState, useMemo, useEffect } from 'react';
import { useApp } from '../state/AppContext.jsx';
import { trade } from '../data/store.js';
import { quoteBuy, quoteSell, quoteLadder } from '../domain/market.js';

const LOGO_COLORS = ['#5dcaa5', '#85b7eb', '#f0997b', '#ed93b1', '#fac775', '#97c459', '#afa9ec', '#f09595'];
function logoColor(id) {
  let h = 0; for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return LOGO_COLORS[h % LOGO_COLORS.length];
}
function pctChange(stock) {
  const prev = stock.prevClose;
  if (!prev) return null;
  return ((stock.price - prev) / prev) * 100;
}
function ChgPill({ pct }) {
  if (pct == null) return null;
  const up = pct >= 0;
  return <span className={`chg-pill ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {Math.abs(pct).toFixed(2)}%</span>;
}

// 큰 시세 차트 — priceHistory(최근 60틱) + 전일종가 점선.
function BigChart({ stock }) {
  const pts = (stock.priceHistory || []).map((h) => h.p);
  if (pts.length < 2) return <div className="bigchart-empty muted">거래가 시작되면 차트가 그려집니다.</div>;
  const W = 620; const H = 220; const pad = 18;
  const prev = stock.prevClose;
  const all = prev != null ? [...pts, prev] : pts;
  const min = Math.min(...all); const max = Math.max(...all); const range = max - min || 1;
  const x = (i) => (i / (pts.length - 1)) * (W - 2 * pad) + pad;
  const y = (p) => H - pad - ((p - min) / range) * (H - 2 * pad);
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p).toFixed(1)}`).join(' ');
  const area = `${line} L ${x(pts.length - 1).toFixed(1)} ${H - pad} L ${x(0).toFixed(1)} ${H - pad} Z`;
  const up = pts[pts.length - 1] >= (prev ?? pts[0]);
  const color = up ? 'var(--up)' : 'var(--down)';
  return (
    <svg className="bigchart" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="시세 차트">
      {prev != null && (
        <>
          <line x1={pad} x2={W - pad} y1={y(prev)} y2={y(prev)} stroke="var(--muted)" strokeWidth="1" strokeDasharray="4 4" />
          <text x={W - pad} y={y(prev) - 4} textAnchor="end" className="caxis">전일 {prev.toLocaleString()}</text>
        </>
      )}
      <path d={area} fill={color} opacity="0.1" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" />
      <text x={pad} y={14} className="caxis">{max.toLocaleString()}</text>
      <text x={pad} y={H - 4} className="caxis">{min.toLocaleString()}</text>
    </svg>
  );
}

function OrderLadder({ stock }) {
  let rows = [];
  try { rows = quoteLadder(stock, [1, 5, 10]); } catch { rows = []; }
  if (rows.length === 0) return null;
  return (
    <table className="tbl ladder">
      <thead><tr><th>수량</th><th className="num">매수액</th><th className="num">→시세</th><th className="num">매도액</th><th className="num">→시세</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.qty}>
            <td className="mono">{r.qty}</td>
            <td className="num mono">{r.buy ? r.buy.cost.toLocaleString() : '—'}</td>
            <td className="num mono up">{r.buy ? r.buy.to.toLocaleString() : '—'}</td>
            <td className="num mono">{r.sell ? r.sell.get.toLocaleString() : '—'}</td>
            <td className="num mono down">{r.sell ? r.sell.to.toLocaleString() : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TradePanel({ stock }) {
  const { session, myUser, myHoldings } = useApp();
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const open = stock.status === 'open';
  const held = myHoldings.find((h) => h.stockId === stock.id)?.shares || 0;
  const balance = myUser?.balance || 0;
  const q = Math.floor(Number(qty)) || 0;

  let buyQ = null; let sellQ = null;
  try { if (q > 0) buyQ = quoteBuy(stock, q); } catch { buyQ = null; }
  try { if (q > 0) sellQ = quoteSell(stock, q); } catch { sellQ = null; }

  const canBuy = open && q > 0 && buyQ && buyQ.cost <= balance;
  const canSell = open && q > 0 && sellQ && q <= held;

  async function go(side) {
    setBusy(true); setMsg(null);
    try {
      const r = await trade({ userId: session.userId, pinHash: session.pinHash, stockId: stock.id, side, qty: q });
      setMsg({ ok: true, text: side === 'buy' ? `매수 체결 −${(-r.cash).toLocaleString()}P` : `매도 체결 +${r.cash.toLocaleString()}P` });
    } catch (e) { setMsg({ ok: false, text: e.message?.replace(/^.*?: /, '') || '실패' }); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div className="actions">
        <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} aria-label="수량" />
        <button className="buy" disabled={!canBuy || busy} onClick={() => go('buy')}>매수</button>
        <button className="sell" disabled={!canSell || busy} onClick={() => go('sell')}>매도</button>
        <span className="muted mono">보유 {held}주 · 현금 {balance.toLocaleString()}P</span>
      </div>
      {open && q > 0 && (
        <div className="meta mono" style={{ marginTop: 6 }}>
          {buyQ ? `매수 −${buyQ.cost.toLocaleString()}P (→${buyQ.newPrice.toLocaleString()})` : '매수 불가(발행 초과)'} ·
          {sellQ ? ` 매도 +${sellQ.proceeds.toLocaleString()}P (→${sellQ.newPrice.toLocaleString()})` : ' 매도 불가'}
        </div>
      )}
      {!open && <p className="muted" style={{ marginTop: 6 }}>장 마감 상태입니다. 09:00~18:00 자동 개장.</p>}
      {msg && <p className={msg.ok ? 'ok' : 'err'} style={{ marginBottom: 0 }}>{msg.text}</p>}
    </div>
  );
}

function DetailPanel({ stock }) {
  const { session, myHoldings } = useApp();
  const pct = pctChange(stock);
  const open = stock.status === 'open';
  const held = myHoldings.find((h) => h.stockId === stock.id)?.shares || 0;
  const marketCap = (stock.price || 0) * (stock.circulating || 0);
  return (
    <div className="card detail">
      <div className="d-hd">
        <span className="d-nm">{stock.name}</span>
        {stock.team && <span className="d-team">{stock.team}</span>}
        <div className="spacer" />
        <span className={`pill ${open ? 'open' : 'closed'}`}>{open ? '거래중' : '마감'}</span>
      </div>
      <div className="d-px mono">{(stock.price || 0).toLocaleString()} P</div>
      {pct != null && (
        <span className={`chg ${pct >= 0 ? 'up' : 'down'}`}>
          {pct >= 0 ? '▲' : '▼'} {Math.abs(pct).toFixed(2)}% · 전일 {(stock.prevClose || 0).toLocaleString()}
        </span>
      )}
      <BigChart stock={stock} />
      <div className="stat-row">
        <div className="s"><div className="k">발행</div><div className="v mono">{(stock.totalShares || 0).toLocaleString()}</div></div>
        <div className="s"><div className="k">유통</div><div className="v mono">{(stock.circulating || 0).toLocaleString()}</div></div>
        <div className="s"><div className="k">시가총액</div><div className="v mono">{marketCap.toLocaleString()}</div></div>
        <div className="s"><div className="k">변동성(주당)</div><div className="v mono">{stock.slope}</div></div>
        {session.role === 'participant' && <div className="s"><div className="k">내 보유</div><div className="v mono up">{held}</div></div>}
      </div>
      {session.role === 'participant'
        ? <TradePanel stock={stock} />
        : <p className="muted" style={{ marginTop: 10 }}>거래하려면 [로그인] 후 이용하세요.</p>}
      <details style={{ marginTop: 8 }}>
        <summary className="link-btn" style={{ listStyle: 'none' }}>호가 사다리 보기</summary>
        <OrderLadder stock={stock} />
      </details>
    </div>
  );
}

function CompanyList({ stocks, selectedId, onSelect }) {
  return (
    <div className="card" style={{ padding: 6 }}>
      <div className="co-list">
        {stocks.map((s) => {
          const pct = pctChange(s);
          return (
            <div key={s.id} className={`co ${s.id === selectedId ? 'sel' : ''}`} onClick={() => onSelect(s.id)}>
              <div className="logo" style={{ background: logoColor(s.id) }}>{(s.name || '?')[0]}</div>
              <div>
                <div className="co-nm">{s.name}{s.status !== 'open' && <span className="co-tag">마감</span>}</div>
                <div className="co-sub">{s.team || s.id}</div>
              </div>
              <div className="co-px">
                <div className="p mono">{(s.price || 0).toLocaleString()}</div>
                <ChgPill pct={pct} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function MarketPage() {
  const { stocks, session, stockBoard } = useApp();
  const sorted = useMemo(
    () => [...stocks].sort((a, b) => (a.team || '').localeCompare(b.team || '') || a.name.localeCompare(b.name)),
    [stocks],
  );
  const [selectedId, setSelectedId] = useState(null);
  useEffect(() => {
    if (sorted.length === 0) { setSelectedId(null); return; }
    if (!selectedId || !sorted.some((s) => s.id === selectedId)) setSelectedId(sorted[0].id);
  }, [sorted, selectedId]);

  const selected = sorted.find((s) => s.id === selectedId);
  const news = stockBoard?.news || [];

  if (sorted.length === 0) {
    return <div className="card muted">아직 상장된 기업이 없습니다. 운영자가 종목을 만들면 여기에 표시됩니다.</div>;
  }

  return (
    <div>
      {session.role === 'guest' && <div className="banner">👀 보기 전용입니다. 거래하려면 [로그인] 후 이용하세요.</div>}
      {news.length > 0 && (
        <div className="card">
          <h3>📰 뉴스</h3>
          {news.slice(0, 4).map((n, i) => (
            <div className="news-item" key={i}>{n.text}<span className="when"> · {new Date(n.at).toLocaleString('ko-KR')}</span></div>
          ))}
        </div>
      )}
      <div className="market-layout">
        {selected ? <DetailPanel stock={selected} /> : <div className="card muted">종목을 선택하세요.</div>}
        <CompanyList stocks={sorted} selectedId={selectedId} onSelect={setSelectedId} />
      </div>
    </div>
  );
}
