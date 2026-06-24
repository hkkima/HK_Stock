import { useState } from 'react';
import { useApp } from '../state/AppContext.jsx';
import { upsertStock, payDividend, adjustPrice, postNews, mintToHouse } from '../data/store.js';

function useAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const run = async (fn, okText) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); setMsg({ ok: true, text: okText ? okText(r) : '완료' }); }
    catch (e) { setMsg({ ok: false, text: e.message?.replace(/^.*?: /, '') || '실패' }); }
    finally { setBusy(false); }
  };
  return { busy, msg, run };
}

function StatusMsg({ msg }) {
  if (!msg) return null;
  return <p className={msg.ok ? 'ok' : 'err'} style={{ marginBottom: 0 }}>{msg.text}</p>;
}

function NewStock() {
  const [f, setF] = useState({ id: '', name: '', team: '', price: 1000, liq: 200 });
  const { busy, msg, run } = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="card">
      <h3>① 기업(종목) 상장</h3>
      <div className="row">
        <input placeholder="종목 ID (영문, 예: teamA)" value={f.id} onChange={set('id')} />
        <input placeholder="기업명" value={f.name} onChange={set('name')} />
        <input placeholder="팀/멤버" value={f.team} onChange={set('team')} />
        <input type="number" placeholder="시작가" value={f.price} onChange={set('price')} />
        <input type="number" placeholder="유동성 L" value={f.liq} onChange={set('liq')} />
        <button
          className="primary" disabled={busy}
          onClick={() => run(
            () => upsertStock({ id: f.id, name: f.name, team: f.team, price: Number(f.price), liq: Number(f.liq), status: 'closed' }),
            (r) => `상장 완료: ${r.id}`,
          )}
        >상장</button>
      </div>
      <p className="muted">시작가에는 펀더멘탈(강사 평가 등)을 반영해 주세요. 상장 후 거래는 '거래 열기'로 켭니다. 시세 변경은 ③ 시세조정으로만(총량 보존).</p>
      <StatusMsg msg={msg} />
    </div>
  );
}

function StockList() {
  const { stocks } = useApp();
  const { busy, msg, run } = useAction();
  const [liqEdit, setLiqEdit] = useState({});
  return (
    <div className="card">
      <h3>상장 종목</h3>
      {stocks.length === 0 ? <p className="muted">없음</p> : (
        <table className="tbl">
          <thead><tr><th>종목</th><th className="num">시세</th><th className="num">발행</th><th className="num">리저브</th><th>유동성</th><th>거래</th></tr></thead>
          <tbody>
            {stocks.map((s) => (
              <tr key={s.id}>
                <td>{s.name} <span className="muted">{s.team}</span></td>
                <td className="num mono">{(s.price || 0).toLocaleString()}</td>
                <td className="num mono">{(s.sharesOut || 0).toLocaleString()}</td>
                <td className="num mono">{(s.reserve || 0).toLocaleString()}</td>
                <td>
                  <input type="number" style={{ width: 70 }} value={liqEdit[s.id] ?? s.liq}
                    onChange={(e) => setLiqEdit({ ...liqEdit, [s.id]: e.target.value })} />
                  <button className="ghost" disabled={busy} style={{ marginLeft: 4 }}
                    onClick={() => run(() => upsertStock({ id: s.id, liq: Number(liqEdit[s.id] ?? s.liq) }), () => 'L 저장')}>저장</button>
                </td>
                <td>
                  <button className={s.status === 'open' ? 'sell' : 'buy'} disabled={busy}
                    onClick={() => run(() => upsertStock({ id: s.id, status: s.status === 'open' ? 'closed' : 'open' }), () => '상태 변경')}>
                    {s.status === 'open' ? '닫기' : '열기'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <StatusMsg msg={msg} />
    </div>
  );
}

function Fundamentals() {
  const { stocks } = useApp();
  const { busy, msg, run } = useAction();
  const [div, setDiv] = useState({ stockId: '', perShare: 10 });
  const [adj, setAdj] = useState({ stockId: '', newPrice: '', memo: '' });
  const opts = stocks.map((s) => <option key={s.id} value={s.id}>{s.name}</option>);

  return (
    <div className="card">
      <h3>② 배당 · ③ 시세조정 (펀더멘탈)</h3>

      <div className="section-title">배당 — 하우스 풀 → 보유자 (perShare × 보유주). 잘한 활동 보상.</div>
      <div className="row">
        <select value={div.stockId} onChange={(e) => setDiv({ ...div, stockId: e.target.value })}>
          <option value="">종목 선택</option>{opts}
        </select>
        <input type="number" value={div.perShare} onChange={(e) => setDiv({ ...div, perShare: e.target.value })} />
        <span className="muted">P / 주</span>
        <button className="primary" disabled={busy || !div.stockId}
          onClick={() => run(() => payDividend(div.stockId, Number(div.perShare)), (r) => `배당 지급: 총 ${r.total.toLocaleString()}P, ${r.count}명`)}>
          배당 지급
        </button>
      </div>

      <div className="section-title" style={{ marginTop: 16 }}>시세조정 — 좋은 펀더멘탈은 상향(↑), 지각·사고는 하향(↓). 잔액은 안 건드림.</div>
      <div className="row">
        <select value={adj.stockId} onChange={(e) => setAdj({ ...adj, stockId: e.target.value })}>
          <option value="">종목 선택</option>{opts}
        </select>
        <input type="number" placeholder="새 시세" value={adj.newPrice} onChange={(e) => setAdj({ ...adj, newPrice: e.target.value })} />
        <input placeholder="사유(메모)" value={adj.memo} onChange={(e) => setAdj({ ...adj, memo: e.target.value })} />
        <button className="primary" disabled={busy || !adj.stockId || !adj.newPrice}
          onClick={() => run(() => adjustPrice(adj.stockId, Number(adj.newPrice), adj.memo), (r) => `시세 ${r.oldPrice}→${r.newPrice} (정산 ${r.delta >= 0 ? '+' : ''}${r.delta.toLocaleString()}P)`)}>
          시세 변경
        </button>
      </div>
      <StatusMsg msg={msg} />
    </div>
  );
}

function NewsAndMint() {
  const { stocks } = useApp();
  const { busy, msg, run } = useAction();
  const [news, setNews] = useState({ text: '', stockId: '' });
  const [mint, setMint] = useState({ amount: 10000, memo: '' });
  return (
    <div className="card">
      <h3>④ 뉴스 · 하우스 풀 발행</h3>
      <div className="section-title">뉴스 (재미 요소). 시세 효과가 필요하면 ③에서 별도로.</div>
      <div className="row">
        <select value={news.stockId} onChange={(e) => setNews({ ...news, stockId: e.target.value })}>
          <option value="">전체</option>{stocks.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input placeholder="뉴스 내용" style={{ flex: 1, minWidth: 200 }} value={news.text} onChange={(e) => setNews({ ...news, text: e.target.value })} />
        <button className="primary" disabled={busy || !news.text.trim()}
          onClick={() => run(() => postNews(news.text, news.stockId || null), () => '게시됨')}>게시</button>
      </div>

      <div className="section-title" style={{ marginTop: 16 }}>하우스 풀 발행/소각 — 유일한 총량 변동 경로(인플레 조절). 음수=소각.</div>
      <div className="row">
        <input type="number" value={mint.amount} onChange={(e) => setMint({ ...mint, amount: e.target.value })} />
        <input placeholder="사유(메모)" value={mint.memo} onChange={(e) => setMint({ ...mint, memo: e.target.value })} />
        <button className="primary" disabled={busy}
          onClick={() => run(() => mintToHouse(Number(mint.amount), mint.memo), (r) => `하우스 풀 ${r.amount >= 0 ? '+' : ''}${r.amount.toLocaleString()}P`)}>
          발행
        </button>
      </div>
      <StatusMsg msg={msg} />
    </div>
  );
}

function Reconcile() {
  const { users, stocks, stockBoard } = useApp();
  const walletSum = users.reduce((s, u) => s + (u.balance || 0), 0);
  const reserveSum = stocks.reduce((s, st) => s + (st.reserve || 0), 0);
  const house = stockBoard?.housePool || 0;
  const total = walletSum + reserveSum + house;
  return (
    <div className="card">
      <h3>총량 점검 (지갑 + 리저브 + 하우스 = 전체)</h3>
      <div className="recon">
        <div className="box"><div className="k">Σ 학생 지갑</div><div className="v mono">{walletSum.toLocaleString()}</div></div>
        <div className="box"><div className="k">Σ AMM 리저브</div><div className="v mono">{reserveSum.toLocaleString()}</div></div>
        <div className="box"><div className="k">하우스 풀</div><div className="v mono">{house.toLocaleString()}</div></div>
        <div className="box"><div className="k">전체 포인트</div><div className="v mono" style={{ color: 'var(--accent)' }}>{total.toLocaleString()}</div></div>
      </div>
      <p className="muted">전체 포인트는 발행/소각(④)으로만 변합니다. 거래·배당·시세조정은 위 세 칸 사이의 이동일 뿐 합계 불변.</p>
    </div>
  );
}

export default function AdminPage() {
  return (
    <div>
      <Reconcile />
      <NewStock />
      <StockList />
      <Fundamentals />
      <NewsAndMint />
    </div>
  );
}
