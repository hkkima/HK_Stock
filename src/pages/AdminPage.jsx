import { useState } from 'react';
import { useApp } from '../state/AppContext.jsx';
import { upsertStock, payDividend, adjustPrice, postNews, mintToHouse, delistStock } from '../data/store.js';

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
  const [f, setF] = useState({ id: '', name: '', team: '', base: 1000, slope: 5, totalShares: 1000 });
  const { busy, msg, run } = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="card">
      <h3>① 기업(종목) 상장</h3>
      <div className="row">
        <input placeholder="종목 ID (영문, 예: teamA)" value={f.id} onChange={set('id')} />
        <input placeholder="기업명" value={f.name} onChange={set('name')} />
        <input placeholder="팀/멤버" value={f.team} onChange={set('team')} />
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <label className="muted">시작가<input type="number" style={{ width: 90, marginLeft: 4 }} value={f.base} onChange={set('base')} /></label>
        <label className="muted">발행주식수<input type="number" style={{ width: 90, marginLeft: 4 }} value={f.totalShares} onChange={set('totalShares')} /></label>
        <label className="muted">변동성(주당)<input type="number" style={{ width: 70, marginLeft: 4 }} value={f.slope} onChange={set('slope')} /></label>
        <button
          className="primary" disabled={busy}
          onClick={() => run(
            () => upsertStock({ id: f.id, name: f.name, team: f.team, base: Number(f.base), slope: Number(f.slope), totalShares: Number(f.totalShares), status: 'closed' }),
            (r) => `상장 완료: ${r.id}`,
          )}
        >상장</button>
      </div>
      <p className="muted">
        발행주식수는 고정(무한발행 없음). <b>변동성</b>=1주 거래마다 시세가 움직이는 폭(클수록 출렁임 큼).
        예: 시작가 1000·변동성 5면 100주 매수 시 시세 약 1500. 시작가엔 펀더멘탈 반영. 시세 변경은 ③ 시세조정으로만.
      </p>
      <StatusMsg msg={msg} />
    </div>
  );
}

function StockList() {
  const { stocks } = useApp();
  const { busy, msg, run } = useAction();
  const [edit, setEdit] = useState({}); // { [id]: { slope, totalShares } }
  const ev = (s, k) => (edit[s.id]?.[k] ?? (k === 'slope' ? s.slope : s.totalShares));
  const setEv = (s, k) => (e) => setEdit({ ...edit, [s.id]: { ...edit[s.id], [k]: e.target.value } });

  function delist(s) {
    const def = String(s.price || 0);
    const input = window.prompt(
      `「${s.name}」 상장폐지\n보유자에게 지급할 정산가(P/주)를 입력하세요.\n현재가 ${def} = 졸업 매수 / 0 = 부도`,
      def,
    );
    if (input == null) return;
    const sp = Math.floor(Number(input));
    if (!(sp >= 0)) { window.alert('정산가는 0 이상이어야 합니다.'); return; }
    if (!window.confirm(`정말 「${s.name}」을(를) 상장폐지합니까?\n정산가 ${sp.toLocaleString()}P로 보유자에게 지급 후 종목이 삭제됩니다. 되돌릴 수 없습니다.`)) return;
    run(() => delistStock(s.id, sp), (r) => `상폐 완료: ${r.count}명에게 총 ${r.totalPayout.toLocaleString()}P 지급, 삭제됨`);
  }

  return (
    <div className="card">
      <h3>상장 종목</h3>
      {stocks.length === 0 ? <p className="muted">없음</p> : (
        <table className="tbl">
          <thead><tr><th>종목</th><th className="num">시세</th><th className="num">발행</th><th className="num">유통</th><th>변동성</th><th>거래</th><th>관리</th></tr></thead>
          <tbody>
            {stocks.map((s) => (
              <tr key={s.id}>
                <td>{s.name} <span className="muted">{s.team}</span></td>
                <td className="num mono">{(s.price || 0).toLocaleString()}</td>
                <td>
                  <input type="number" style={{ width: 70 }} value={ev(s, 'totalShares')} onChange={setEv(s, 'totalShares')} />
                </td>
                <td className="num mono">{(s.circulating || 0).toLocaleString()}</td>
                <td>
                  <input type="number" style={{ width: 56 }} value={ev(s, 'slope')} onChange={setEv(s, 'slope')} />
                  <button className="ghost" disabled={busy} style={{ marginLeft: 4 }}
                    onClick={() => run(() => upsertStock({ id: s.id, slope: Number(ev(s, 'slope')), totalShares: Number(ev(s, 'totalShares')) }), () => '저장')}>저장</button>
                </td>
                <td>
                  <button className={s.status === 'open' ? 'sell' : 'buy'} disabled={busy}
                    onClick={() => run(() => upsertStock({ id: s.id, status: s.status === 'open' ? 'closed' : 'open' }), () => '상태 변경')}>
                    {s.status === 'open' ? '닫기' : '열기'}
                  </button>
                </td>
                <td>
                  <button className="ghost danger" disabled={busy || s.status === 'open'}
                    title={s.status === 'open' ? '거래를 먼저 닫아야 상폐 가능' : '상장폐지(회사 삭제)'}
                    onClick={() => delist(s)}>상폐</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted">발행주식수·변동성은 수정 후 [저장]. 상폐는 거래를 닫은 뒤에만 — 정산가 × 보유주 지급(리저브 차액은 하우스 풀로) 후 종목 삭제. 자동 장운영: 매일 09:00 개장 / 18:00 마감.</p>
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
