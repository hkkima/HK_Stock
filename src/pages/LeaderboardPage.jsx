import { useApp } from '../state/AppContext.jsx';
import { holdingValue } from '../domain/market.js';

export default function LeaderboardPage() {
  const { users, holdings, stocks, session } = useApp();
  const priceById = Object.fromEntries(stocks.map((s) => [s.id, s.price || 0]));

  // 유저별 보유 평가액 집계
  const stockValByUser = {};
  for (const h of holdings) {
    if ((h.shares || 0) <= 0) continue;
    stockValByUser[h.userId] = (stockValByUser[h.userId] || 0) + holdingValue(h.shares, priceById[h.stockId] || 0);
  }

  const rows = users
    .map((u) => {
      const cash = u.balance || 0;
      const stockVal = stockValByUser[u.id] || 0;
      return { id: u.id, name: u.name || u.id, cash, stockVal, net: cash + stockVal };
    })
    .sort((a, b) => b.net - a.net);

  return (
    <div className="card">
      <h3>리더보드 (순자산 = 현금 + 주식 평가액)</h3>
      {rows.length === 0
        ? <p className="muted">참가자가 없습니다.</p>
        : (
          <table className="tbl">
            <thead>
              <tr>
                <th>#</th><th>참가자</th>
                <th className="num">현금</th><th className="num">주식</th><th className="num">순자산</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} style={r.id === session.userId ? { background: 'var(--panel2)' } : undefined}>
                  <td className="mono">{i + 1}</td>
                  <td>{r.name}{r.id === session.userId && <span className="muted"> (나)</span>}</td>
                  <td className="num mono">{r.cash.toLocaleString()}</td>
                  <td className="num mono">{r.stockVal.toLocaleString()}</td>
                  <td className="num mono balance">{r.net.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );
}
