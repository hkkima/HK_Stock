import { useState } from 'react';
import { useApp } from '../state/AppContext.jsx';
import { trade } from '../data/store.js';
import { holdingValue, quoteSell } from '../domain/market.js';

function HoldingRow({ r, stock }) {
  const { session } = useApp();
  const [qty, setQty] = useState(r.shares);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const open = stock?.status === 'open';
  const sellable = r.shares - (r.locked || 0); // 스톡옵션(locked)은 매도 불가
  const q = Math.floor(Number(qty)) || 0;
  let proceeds = null;
  try { if (q > 0 && stock) proceeds = quoteSell(stock, q).proceeds; } catch { proceeds = null; }
  const canSell = open && q > 0 && q <= sellable;

  async function sell() {
    setBusy(true); setMsg(null);
    try {
      const res = await trade({ userId: session.userId, pinHash: session.pinHash, stockId: r.stockId, side: 'sell', qty: q });
      setMsg({ ok: true, text: `매도 +${res.cash.toLocaleString()}P` });
    } catch (e) { setMsg({ ok: false, text: e.message?.replace(/^.*?: /, '') || '실패' }); }
    finally { setBusy(false); }
  }

  return (
    <tr>
      <td>{r.name}{(r.locked || 0) > 0 && <span className="co-tag" title="스톡옵션(거래금지)">잠금 {r.locked}</span>}</td>
      <td className="num mono">{r.shares.toLocaleString()}</td>
      <td className="num mono">{Math.round(r.avgCost).toLocaleString()}</td>
      <td className="num mono">{r.price.toLocaleString()}</td>
      <td className="num mono">{r.value.toLocaleString()}</td>
      <td className={`num mono ${r.pl >= 0 ? 'up' : 'down'}`}>{r.pl >= 0 ? '+' : ''}{r.pl.toLocaleString()}</td>
      <td>
        <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
          <input type="number" min="1" max={sellable} style={{ width: 64 }} value={qty} onChange={(e) => setQty(e.target.value)} aria-label="매도 수량" />
          <button className="sell" disabled={!canSell || busy} onClick={sell}>매도</button>
        </div>
        {proceeds != null && open && <div className="muted mono" style={{ fontSize: 11, textAlign: 'right' }}>+{proceeds.toLocaleString()}P</div>}
        {(r.locked || 0) > 0 && <div className="muted" style={{ fontSize: 11, textAlign: 'right' }}>매도가능 {sellable}</div>}
        {msg && <div className={msg.ok ? 'ok' : 'err'} style={{ fontSize: 11, textAlign: 'right' }}>{msg.text}</div>}
      </td>
    </tr>
  );
}

export default function PortfolioPage() {
  const { myUser, myHoldings, stocks } = useApp();
  const stockById = Object.fromEntries(stocks.map((s) => [s.id, s]));
  const cash = myUser?.balance || 0;

  const rows = myHoldings.map((h) => {
    const s = stockById[h.stockId];
    const price = s?.price || 0;
    const value = holdingValue(h.shares, price);
    const cost = Math.round((h.avgCost || 0) * h.shares);
    const pl = value - cost;
    return { ...h, name: s?.name || h.stockId, price, value, avgCost: h.avgCost || 0, pl };
  });
  const holdingsValue = rows.reduce((s, r) => s + r.value, 0);
  const net = cash + holdingsValue;

  return (
    <div>
      <div className="card">
        <h3>내 자산</h3>
        <div className="recon">
          <div className="box"><div className="k">현금</div><div className="v mono">{cash.toLocaleString()}</div></div>
          <div className="box"><div className="k">주식 평가액</div><div className="v mono">{holdingsValue.toLocaleString()}</div></div>
          <div className="box"><div className="k">순자산</div><div className="v mono" style={{ color: 'var(--accent)' }}>{net.toLocaleString()}</div></div>
        </div>
      </div>

      <div className="card">
        <h3>보유 종목</h3>
        {rows.length === 0
          ? <p className="muted">보유 중인 주식이 없습니다. [시세]에서 매수해 보세요.</p>
          : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>종목</th><th className="num">보유</th><th className="num">평단</th>
                  <th className="num">현재가</th><th className="num">평가액</th><th className="num">평가손익</th><th className="num">매도</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => <HoldingRow key={r.stockId} r={r} stock={stockById[r.stockId]} />)}
              </tbody>
            </table>
          )}
      </div>
    </div>
  );
}
