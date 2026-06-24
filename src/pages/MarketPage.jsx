import { useState } from 'react';
import { useApp } from '../state/AppContext.jsx';
import { trade } from '../data/store.js';
import { quoteBuy, quoteSell, quoteLadder } from '../domain/market.js';

// 시세 그래프 — priceHistory(최근 60틱)를 인라인 SVG 라인으로.
function Sparkline({ history }) {
  const pts = (history || []).map((h) => h.p);
  if (pts.length < 2) {
    return <div className="muted spark-empty">시세 기록 누적 중…</div>;
  }
  const W = 240; const H = 44;
  const min = Math.min(...pts); const max = Math.max(...pts);
  const range = max - min || 1;
  const stepX = W / (pts.length - 1);
  const coords = pts.map((p, i) => `${(i * stepX).toFixed(1)},${(H - ((p - min) / range) * (H - 8) - 4).toFixed(1)}`);
  const up = pts[pts.length - 1] >= pts[0];
  return (
    <svg className="spark" width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="시세 그래프">
      <polyline points={coords.join(' ')} fill="none" stroke={up ? 'var(--up)' : 'var(--down)'} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// 호가 사다리(AMM) — 수량별 체결액·체결 후 시세.
function OrderLadder({ stock }) {
  let rows = [];
  try { rows = quoteLadder(stock, [1, 5, 10]); } catch { rows = []; }
  if (rows.length === 0) return null;
  return (
    <table className="tbl ladder">
      <thead>
        <tr><th>수량</th><th className="num">매수액</th><th className="num">→시세</th><th className="num">매도액</th><th className="num">→시세</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.qty}>
            <td className="mono">{r.qty}</td>
            <td className="num mono">{r.buyCost.toLocaleString()}</td>
            <td className="num mono up">{r.buyTo.toLocaleString()}</td>
            <td className="num mono">{r.sellGet.toLocaleString()}</td>
            <td className="num mono down">{r.sellTo.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TradeCard({ stock }) {
  const { session, myUser, myHoldings } = useApp();
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [showLadder, setShowLadder] = useState(false);

  const isParticipant = session.role === 'participant';
  const open = stock.status === 'open';
  const held = myHoldings.find((h) => h.stockId === stock.id)?.shares || 0;
  const balance = myUser?.balance || 0;
  const q = Math.floor(Number(qty)) || 0;

  let preview = null;
  try {
    if (q > 0) {
      const b = quoteBuy(stock, q); const s = quoteSell(stock, q);
      preview = { cost: b.cost, proceeds: s.proceeds, upTo: b.newPrice, downTo: s.newPrice };
    }
  } catch { preview = null; }

  const canBuy = isParticipant && open && q > 0 && preview && preview.cost <= balance;
  const canSell = isParticipant && open && q > 0 && q <= held;

  async function go(side) {
    setBusy(true); setMsg(null);
    try {
      const r = await trade({ userId: session.userId, pinHash: session.pinHash, stockId: stock.id, side, qty: q });
      setMsg({ ok: true, text: side === 'buy' ? `매수 체결 −${(-r.cash).toLocaleString()}P` : `매도 체결 +${r.cash.toLocaleString()}P` });
    } catch (e) {
      setMsg({ ok: false, text: e.message?.replace(/^.*?: /, '') || '실패' });
    } finally { setBusy(false); }
  }

  return (
    <div className="stock">
      <div className="hd">
        <span className="nm">{stock.name}</span>
        {stock.team && <span className="team">{stock.team}</span>}
        <div className="spacer" />
        <span className={`pill ${open ? 'open' : 'closed'}`}>{open ? '거래중' : '마감'}</span>
      </div>
      <div className="px mono">{(stock.price || 0).toLocaleString()} P</div>
      <Sparkline history={stock.priceHistory} />
      <div className="meta mono">
        발행 {(stock.sharesOut || 0).toLocaleString()}주 · 유동성 L={stock.liq}
        {isParticipant && held > 0 && <> · 내 보유 <b className="up">{held}</b>주</>}
      </div>

      {isParticipant && (
        <>
          <div className="actions">
            <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} aria-label="수량" />
            <button className="buy" disabled={!canBuy || busy} onClick={() => go('buy')}>매수</button>
            <button className="sell" disabled={!canSell || busy} onClick={() => go('sell')}>매도</button>
          </div>
          {preview && open && (
            <div className="meta mono" style={{ marginTop: 6 }}>
              매수 −{preview.cost.toLocaleString()}P (→{preview.upTo.toLocaleString()}) ·
              매도 +{preview.proceeds.toLocaleString()}P (→{preview.downTo.toLocaleString()})
            </div>
          )}
          {msg && <p className={msg.ok ? 'ok' : 'err'} style={{ marginBottom: 0 }}>{msg.text}</p>}
        </>
      )}

      <button className="link-btn" onClick={() => setShowLadder((v) => !v)}>
        {showLadder ? '호가 닫기 ▲' : '호가 보기 ▼'}
      </button>
      {showLadder && <OrderLadder stock={stock} />}
    </div>
  );
}

export default function MarketPage() {
  const { stocks, session, stockBoard } = useApp();
  const sorted = [...stocks].sort((a, b) => (a.team || '').localeCompare(b.team || '') || a.name.localeCompare(b.name));
  const news = stockBoard?.news || [];

  return (
    <div>
      {session.role === 'guest' && (
        <div className="banner">👀 보기 전용입니다. 거래하려면 [로그인] 후 이용하세요.</div>
      )}

      {news.length > 0 && (
        <div className="card">
          <h3>📰 뉴스</h3>
          {news.slice(0, 5).map((n, i) => (
            <div className="news-item" key={i}>
              {n.text}
              <span className="when"> · {new Date(n.at).toLocaleString('ko-KR')}</span>
            </div>
          ))}
        </div>
      )}

      {sorted.length === 0
        ? <div className="card muted">아직 상장된 기업이 없습니다. 운영자가 종목을 만들면 여기에 표시됩니다.</div>
        : <div className="grid">{sorted.map((s) => <TradeCard key={s.id} stock={s} />)}</div>}
    </div>
  );
}
