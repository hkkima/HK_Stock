import { useApp } from '../state/AppContext.jsx';
import { holdingValue } from '../domain/market.js';

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
                  <th>종목</th>
                  <th className="num">보유</th>
                  <th className="num">평단</th>
                  <th className="num">현재가</th>
                  <th className="num">평가액</th>
                  <th className="num">평가손익</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.stockId}>
                    <td>{r.name}</td>
                    <td className="num mono">{r.shares.toLocaleString()}</td>
                    <td className="num mono">{Math.round(r.avgCost).toLocaleString()}</td>
                    <td className="num mono">{r.price.toLocaleString()}</td>
                    <td className="num mono">{r.value.toLocaleString()}</td>
                    <td className={`num mono ${r.pl >= 0 ? 'up' : 'down'}`}>
                      {r.pl >= 0 ? '+' : ''}{r.pl.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  );
}
