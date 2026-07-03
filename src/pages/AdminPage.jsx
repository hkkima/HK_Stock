import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../state/AppContext.jsx';
import { upsertStock, payDividend, adjustPrice, mintToHouse, delistStock, setAutoNews, triggerNews, grantOption, marketReprice, postImpactNews, scheduleNews, cancelScheduledNews, postInstructorEvent, postInstructorEventsBatch, getInstructorEventLog } from '../data/store.js';
import { EVENT_CATEGORIES, EVENT_PRESETS, renderEventHeadline, eventCategoryMeta } from '../domain/events.js';

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

function parseTraits(s) {
  return String(s || '').split(',').map((t) => t.trim()).filter(Boolean);
}

function NewStock() {
  const [f, setF] = useState({ id: '', name: '', team: '', base: 1000, slope: 5, totalShares: 1000, sector: '', traits: '' });
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
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <input placeholder="업종 (공개·1개, 예: 게임)" value={f.sector} onChange={set('sector')} />
        <input placeholder="특성 (비공개·쉼표로 n개, 예: AI,적자,루키)" style={{ flex: 1, minWidth: 220 }} value={f.traits} onChange={set('traits')} />
        <button
          className="primary" disabled={busy}
          onClick={() => run(
            () => upsertStock({ id: f.id, name: f.name, team: f.team, base: Number(f.base), slope: Number(f.slope), totalShares: Number(f.totalShares), sector: f.sector, traits: parseTraits(f.traits), status: 'closed' }),
            (r) => `상장 완료: ${r.id}`,
          )}
        >상장</button>
      </div>
      <p className="muted">
        발행주식수는 고정(무한발행 없음). <b>변동성</b>=1주 거래마다 시세가 움직이는 폭(클수록 출렁임 큼).
        예: 시작가 1000·변동성 5면 100주 매수 시 시세 약 1500. 시세 변경은 ③ 시세조정으로만.
        <b>업종</b>은 공개(학생도 봄), <b>특성</b>은 비공개(운영자만·뉴스 타겟용)라 학생 화면엔 안 보입니다.
      </p>
      <StatusMsg msg={msg} />
    </div>
  );
}

function StockList() {
  const { stocks, traitsByStock } = useApp();
  const { busy, msg, run } = useAction();
  const [edit, setEdit] = useState({}); // { [id]: { slope, totalShares, sector, traits } }
  const dflt = (s, k) => {
    if (k === 'slope') return s.slope;
    if (k === 'totalShares') return s.totalShares;
    if (k === 'sector') return s.sector || '';
    return (traitsByStock[s.id] || []).join(', '); // traits
  };
  const ev = (s, k) => (edit[s.id]?.[k] ?? dflt(s, k));
  const setEv = (s, k) => (e) => setEdit({ ...edit, [s.id]: { ...edit[s.id], [k]: e.target.value } });
  const saveRow = (s) => upsertStock({
    id: s.id,
    slope: Number(ev(s, 'slope')),
    totalShares: Number(ev(s, 'totalShares')),
    sector: ev(s, 'sector'),
    traits: parseTraits(ev(s, 'traits')),
  });

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
          <thead><tr><th>종목</th><th className="num">시세</th><th className="num">발행</th><th className="num">유통</th><th>변동성</th><th>업종(공개)</th><th>특성(비공개)</th><th>거래</th><th>관리</th></tr></thead>
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
                </td>
                <td><input style={{ width: 80 }} value={ev(s, 'sector')} onChange={setEv(s, 'sector')} placeholder="게임" /></td>
                <td>
                  <input style={{ width: 130 }} value={ev(s, 'traits')} onChange={setEv(s, 'traits')} placeholder="AI,적자" />
                  <button className="ghost" disabled={busy} style={{ marginLeft: 4 }}
                    onClick={() => run(() => saveRow(s), () => '저장')}>저장</button>
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

// ── 강사 이벤트 — 출결·과제·프로젝트 등 강사가 직접 주무르는 펀더멘탈 레버 ──
//   자동 랜덤 뉴스와 분리. 프리셋 원클릭 → 팀 주가에 즉시 호재/악재 반영(동기부여·분위기).
function InstructorEvents() {
  const { stocks, stockBoard } = useApp();
  const { busy, msg, run } = useAction();
  const [stockId, setStockId] = useState('');
  const [cat, setCat] = useState(EVENT_CATEGORIES[0].id);
  const [sel, setSel] = useState(null); // 선택한 프리셋 key
  const [text, setText] = useState('');
  const [pct, setPct] = useState(0);
  const [when, setWhen] = useState('');

  const stock = stocks.find((s) => s.id === stockId);
  const presets = EVENT_PRESETS.filter((p) => p.cat === cat);
  const recent = (stockBoard?.news || []).filter((n) => n.kind === 'instructor').slice(0, 6);
  const ready = !!stockId && !!text.trim();

  const pickStock = (e) => { setStockId(e.target.value); setSel(null); setText(''); setPct(0); };
  const applyPreset = (p) => {
    setSel(p.key);
    setText(renderEventHeadline(p, stock?.name || ''));
    setPct(p.pct);
  };
  const clearSel = () => { setSel(null); setText(''); setPct(0); };

  const post = () => run(
    () => postInstructorEvent({ stockId, presetKey: sel, pct: Number(pct), text }),
    (r) => `발행: ${stock?.name} ${r.pct >= 0 ? '+' : ''}${r.pct}%`,
  );
  const schedule = () => run(
    () => scheduleNews({
      text, scope: 'stock', target: stockId, pct: Number(pct),
      publishAt: new Date(when).getTime(), kind: 'instructor',
      category: (EVENT_PRESETS.find((p) => p.key === sel)?.cat) || 'custom',
    }),
    () => `예약 완료: ${new Date(when).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
  );

  return (
    <div className="card">
      <h3>📣 강사 이벤트 — 동기부여 · 분위기</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        출결·과제·프로젝트 퀄리티 등 <b>강사가 직접 판단하는 활동</b>을 팀 주가에 바로 반영합니다.
        프리셋을 누르면 헤드라인·기본 시세%가 채워지고, 수정 후 [발행]. 자동 랜덤 뉴스와 별개로 <b>📣강사</b> 뱃지로 표시됩니다.
      </p>

      <div className="row">
        <select value={stockId} onChange={pickStock}>
          <option value="">팀(종목) 선택</option>
          {stocks.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {stock && <span className="muted">현재가 <b className="mono">{(stock.price || 0).toLocaleString()}</b>P</span>}
      </div>

      <div className="evt-tabs" style={{ marginTop: 10 }}>
        {EVENT_CATEGORIES.map((c) => (
          <button key={c.id} className={`evt-tab${cat === c.id ? ' active' : ''}`} onClick={() => setCat(c.id)}>
            {c.icon} {c.label}
          </button>
        ))}
      </div>

      <div className="evt-chips" style={{ marginTop: 10 }}>
        {presets.map((p) => (
          <button
            key={p.key}
            className={`evt-chip ${p.pct >= 0 ? 'good' : 'bad'}${sel === p.key ? ' sel' : ''}`}
            disabled={!stockId}
            title={renderEventHeadline(p, stock?.name || '{기업}')}
            onClick={() => applyPreset(p)}
          >
            {p.label} <span className="evt-pct">{p.pct >= 0 ? '+' : ''}{p.pct}%</span>
          </button>
        ))}
      </div>
      {!stockId && <p className="muted" style={{ marginTop: 6 }}>먼저 팀(종목)을 선택하세요.</p>}

      <div className="row" style={{ marginTop: 10 }}>
        <input placeholder="헤드라인(프리셋 선택 시 자동 입력·수정 가능)" style={{ flex: 1, minWidth: 260 }} value={text} onChange={(e) => setText(e.target.value)} />
        <label className="muted">시세<input type="number" style={{ width: 64, marginLeft: 4 }} value={pct} onChange={(e) => setPct(e.target.value)} />%</label>
        {sel && <button className="ghost" onClick={clearSel}>지우기</button>}
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={busy || !ready} onClick={post}>지금 발행</button>
        <label className="muted">예약<input type="datetime-local" style={{ marginLeft: 4 }} value={when} onChange={(e) => setWhen(e.target.value)} /></label>
        <button className="ghost" disabled={busy || !ready || !when} onClick={schedule}>예약 발행</button>
      </div>
      <p className="muted">양수=호재(팀 주가↑·하우스 풀 충당)·음수=악재(↓)·0=헤드라인만. 시세 효과는 해당 팀 종목에만 적용됩니다.</p>

      {recent.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 14 }}>최근 강사 이벤트</div>
          {recent.map((n, i) => {
            const up = n.polarity === 'good'; const down = n.polarity === 'bad';
            const meta = eventCategoryMeta(n.category);
            return (
              <div className="news-item" key={i}>
                <span className="evt-badge">📣 {meta.label}</span>
                {(up || down) && <span className={up ? 'up' : 'down'} style={{ fontWeight: 700, marginRight: 4 }}>{up ? '▲' : '▼'}</span>}
                {n.badge && <span className="co-tag" style={{ marginRight: 6 }}>{n.badge}</span>}
                {n.text}
                <span className="when"> · {new Date(n.at).toLocaleString('ko-KR')}</span>
              </div>
            );
          })}
        </>
      )}
      <StatusMsg msg={msg} />
    </div>
  );
}

// ── 주간 일괄 출결/평가 — 한 카테고리를 여러 팀에 한 번에 발행 ──
function WeeklyBatch() {
  const { stocks } = useApp();
  const { busy, msg, run } = useAction();
  const [cat, setCat] = useState('attendance');
  const [rows, setRows] = useState({}); // { [stockId]: presetKey | '' }

  const presets = EVENT_PRESETS.filter((p) => p.cat === cat);
  const setRow = (id, key) => setRows({ ...rows, [id]: key });
  const items = stocks.filter((s) => rows[s.id]).map((s) => ({ stockId: s.id, presetKey: rows[s.id] }));
  const changeCat = (id) => { setCat(id); setRows({}); };
  const catMeta = eventCategoryMeta(cat);

  const submit = () => run(
    () => postInstructorEventsBatch(items),
    (r) => `일괄 발행: ${r.count}팀${r.failed ? ` · 실패 ${r.failed}` : ''}`,
  );

  return (
    <div className="card">
      <h3>🗓 주간 일괄 출결 · 평가</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        한 카테고리를 <b>여러 팀에 한 번에</b> 발행합니다. 팀별 결과를 고르고(없으면 건너뜀) [일괄 발행].
        각 팀 주가에 즉시 반영되고 <b>📣강사</b>로 기록됩니다.
      </p>
      <div className="evt-tabs">
        {EVENT_CATEGORIES.map((c) => (
          <button key={c.id} className={`evt-tab${cat === c.id ? ' active' : ''}`} onClick={() => changeCat(c.id)}>
            {c.icon} {c.label}
          </button>
        ))}
      </div>
      <table className="tbl" style={{ marginTop: 10 }}>
        <thead><tr><th>팀</th><th className="num">현재가</th><th>{catMeta.label} 결과</th></tr></thead>
        <tbody>
          {stocks.map((s) => (
            <tr key={s.id}>
              <td>{s.name} <span className="muted">{s.team}</span></td>
              <td className="num mono">{(s.price || 0).toLocaleString()}</td>
              <td>
                <select value={rows[s.id] || ''} onChange={(e) => setRow(s.id, e.target.value)}>
                  <option value="">건너뜀</option>
                  {presets.map((p) => <option key={p.key} value={p.key}>{p.label} ({p.pct >= 0 ? '+' : ''}{p.pct}%)</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={busy || items.length === 0} onClick={submit}>일괄 발행 ({items.length}팀)</button>
        {items.length > 0 && <button className="ghost" disabled={busy} onClick={() => setRows({})}>초기화</button>}
      </div>
      <StatusMsg msg={msg} />
    </div>
  );
}

// ── 팀별 강사 이벤트 대시보드(공정성·가시성) — ledger 집계, 읽기 전용 ──
function InstructorDashboard() {
  const { stocks } = useApp();
  const [log, setLog] = useState(null);
  const [days, setDays] = useState(7); // 7=이번 주, 0=전체
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try { setLog(await getInstructorEventLog()); }
    catch (e) { setErr(e.message || '불러오기 실패'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const nameById = Object.fromEntries(stocks.map((s) => [s.id, s.name]));
  const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
  const entries = (log || []).filter((e) => !cutoff || (e.at && e.at >= cutoff));

  const agg = {};
  for (const e of entries) {
    const a = (agg[e.stockId] ||= { good: 0, bad: 0, flat: 0, net: 0 });
    if (e.pct > 0) a.good += 1; else if (e.pct < 0) a.bad += 1; else a.flat += 1;
    a.net += e.pct;
  }
  const rows = Object.entries(agg)
    .map(([id, a]) => ({ id, name: nameById[id] || id, ...a }))
    .sort((x, y) => y.net - x.net);

  return (
    <div className="card">
      <h3>📊 팀별 강사 이벤트 (공정성 점검)</h3>
      <div className="row">
        <button className={`evt-tab${days === 7 ? ' active' : ''}`} onClick={() => setDays(7)}>이번 주(7일)</button>
        <button className={`evt-tab${days === 0 ? ' active' : ''}`} onClick={() => setDays(0)}>전체</button>
        <button className="ghost" disabled={loading} onClick={load}>{loading ? '…' : '새로고침'}</button>
      </div>
      {err && <p className="err">{err}</p>}
      {rows.length === 0 ? (
        <p className="muted" style={{ marginTop: 8 }}>{loading ? '불러오는 중…' : '해당 기간 강사 이벤트가 없습니다.'}</p>
      ) : (
        <table className="tbl" style={{ marginTop: 8 }}>
          <thead><tr><th>팀</th><th className="num">호재</th><th className="num">악재</th><th className="num">중립</th><th className="num">순 %합</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td className="num mono up">{r.good || ''}</td>
                <td className="num mono down">{r.bad || ''}</td>
                <td className="num mono muted">{r.flat || ''}</td>
                <td className={`num mono ${r.net > 0 ? 'up' : r.net < 0 ? 'down' : ''}`}>{r.net > 0 ? '+' : ''}{r.net}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted">순 %합 = 발행한 시세%의 누적(대략적 편중 지표). 한 팀에 호재/악재가 쏠렸는지 확인해 균형을 맞추세요. (ledger 집계 · 비실시간)</p>
    </div>
  );
}

function NewsAndMint() {
  const { stocks, stockBoard, traitsByStock, scheduledNews } = useApp();
  const { busy, msg, run } = useAction();
  const [imp, setImp] = useState({ text: '', scope: 'all', target: '', pct: 0, publishAt: '' });
  const [mint, setMint] = useState({ amount: 10000, memo: '' });
  const autoOn = !!stockBoard?.autoNewsEnabled;
  const sectors = [...new Set(stocks.map((s) => s.sector).filter(Boolean))];
  const traits = [...new Set(Object.values(traitsByStock).flat())];
  const setI = (k) => (e) => setImp({ ...imp, [k]: e.target.value });
  const targetOk = imp.scope === 'all' || !!imp.target;
  const pending = (scheduledNews || []).filter((n) => n.status === 'pending');
  const fmtWhen = (ms) => new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const scopeLabel = (n) => (n.scope === 'all' ? '전체' : n.scope === 'trait' ? '테마' : (n.target || n.scope));
  return (
    <div className="card">
      <h3>④ 뉴스 · 하우스 풀 발행</h3>

      <div className="section-title">자동 뉴스(테마주) — 장중 랜덤 2~3회/일, 호재·악재 ±3~8% 시세 넛지.</div>
      <div className="row">
        <span className="pill" style={{ color: autoOn ? 'var(--open)' : 'var(--muted)', borderColor: autoOn ? 'var(--open)' : 'var(--line)' }}>
          {autoOn ? '자동 ON' : '자동 OFF'}
        </span>
        <button className={autoOn ? 'sell' : 'buy'} disabled={busy}
          onClick={() => run(() => setAutoNews(!autoOn), (r) => `자동 뉴스 ${r.autoNewsEnabled ? 'ON' : 'OFF'}`)}>
          {autoOn ? '끄기' : '켜기'}
        </button>
        <button className="ghost" disabled={busy}
          onClick={() => run(() => triggerNews(), (r) => r.skipped ? '대상 없음' : `발행: [${r.scope}] ${r.text}${r.applied ? '' : ' (헤드라인만)'}`)}>
          지금 랜덤 뉴스 1건
        </button>
      </div>

      <div className="section-title" style={{ marginTop: 16 }}>뉴스 작성 + 시세 조작 — 대상(종목/업종/테마)에 시세 효과 동시 적용.</div>
      <div className="row">
        <select value={imp.scope} onChange={(e) => setImp({ ...imp, scope: e.target.value, target: '' })}>
          <option value="all">전체 시장</option>
          <option value="stock">특정 종목</option>
          <option value="sector">업종(공개)</option>
          <option value="trait">테마(특성·비공개)</option>
        </select>
        {imp.scope === 'stock' && (
          <select value={imp.target} onChange={setI('target')}>
            <option value="">종목 선택</option>{stocks.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        {imp.scope === 'sector' && (
          <select value={imp.target} onChange={setI('target')}>
            <option value="">업종 선택</option>{sectors.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        )}
        {imp.scope === 'trait' && (
          <select value={imp.target} onChange={setI('target')}>
            <option value="">특성 선택</option>{traits.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        )}
        <label className="muted">시세<input type="number" style={{ width: 64, marginLeft: 4 }} value={imp.pct} onChange={setI('pct')} />%</label>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <input placeholder="뉴스 내용(헤드라인)" style={{ flex: 1, minWidth: 240 }} value={imp.text} onChange={setI('text')} />
        <button className="primary" disabled={busy || !imp.text.trim() || !targetOk}
          onClick={() => run(() => postImpactNews({ text: imp.text, scope: imp.scope, target: imp.target || null, pct: Number(imp.pct) }), (r) => `게시: ${r.count}종목 ${r.pct >= 0 ? '+' : ''}${r.pct}%`)}>지금 게시</button>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <label className="muted">예약 시각<input type="datetime-local" style={{ marginLeft: 4 }} value={imp.publishAt} onChange={setI('publishAt')} /></label>
        <button className="ghost" disabled={busy || !imp.text.trim() || !targetOk || !imp.publishAt}
          onClick={() => run(
            () => scheduleNews({ text: imp.text, scope: imp.scope, target: imp.target || null, pct: Number(imp.pct), publishAt: new Date(imp.publishAt).getTime() }),
            (r) => `예약 완료: ${fmtWhen(r.publishAt)}`,
          )}>예약</button>
        <span className="muted">위 내용·대상·시세%를 지정 시각에 자동 발행.</span>
      </div>
      <p className="muted">시세 %는 양수=호재(하우스 풀 충당)·음수=악재·0=헤드라인만. 업종/테마 선택 시 해당 종목 전체에 동반 적용.</p>

      {pending.length > 0 && (
        <table className="tbl" style={{ marginTop: 8 }}>
          <thead><tr><th>예약 시각</th><th>대상</th><th className="num">시세%</th><th>내용</th><th></th></tr></thead>
          <tbody>
            {pending.map((n) => (
              <tr key={n.id}>
                <td className="mono">{fmtWhen(n.publishAt)}</td>
                <td>{scopeLabel(n)}</td>
                <td className="num mono">{n.pct >= 0 ? '+' : ''}{n.pct}%</td>
                <td>{n.text}</td>
                <td><button className="ghost danger" disabled={busy} onClick={() => run(() => cancelScheduledNews(n.id), () => '취소됨')}>취소</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

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
  const { busy, msg, run } = useAction();
  const [pct, setPct] = useState(-20);
  const walletSum = users.reduce((s, u) => s + (u.balance || 0), 0);
  const reserveSum = stocks.reduce((s, st) => s + (st.reserve || 0), 0);
  const house = stockBoard?.housePool || 0;
  const total = walletSum + reserveSum + house;
  const mcap = stocks.reduce((s, st) => s + (st.price || 0) * (st.totalShares || 0), 0);

  function reprice() {
    const p = Number(pct);
    if (!window.confirm(`전체 ${stocks.length}종목 시세를 ${p}% 일괄 조정합니다. 되돌리려면 반대 %로 다시. 진행할까요?`)) return;
    run(() => marketReprice(p), (r) => `시장 ${r.pct}% 조정 완료 (${r.count}종목)`);
  }

  return (
    <div className="card">
      <h3>총량 점검 · 시장 통제</h3>
      <div className="recon">
        <div className="box"><div className="k">Σ 학생 지갑</div><div className="v mono">{walletSum.toLocaleString()}</div></div>
        <div className="box"><div className="k">Σ AMM 리저브</div><div className="v mono">{reserveSum.toLocaleString()}</div></div>
        <div className="box"><div className="k">하우스 풀</div><div className="v mono">{house.toLocaleString()}</div></div>
        <div className="box"><div className="k">전체 포인트</div><div className="v mono" style={{ color: 'var(--accent)' }}>{total.toLocaleString()}</div></div>
        <div className="box"><div className="k">시가총액 합(발행)</div><div className="v mono">{mcap.toLocaleString()}</div></div>
      </div>
      <p className="muted">전체 포인트(돈)는 발행/소각(④)으로만 변하고, <b>users는 베팅판과 공유</b>라 베팅 지급도 반영됩니다. 시가총액(자산값)은 시세 상승으로 커집니다.</p>

      <div className="section-title">시장 전체 일괄 조정 — 자산 인플레/디플레 통합 레버. 음수=전체 하락.</div>
      <div className="row">
        <input type="number" style={{ width: 80 }} value={pct} onChange={(e) => setPct(e.target.value)} /><span className="muted">%</span>
        <button className="primary" disabled={busy} onClick={reprice}>전체 적용</button>
        <span className="muted">예: −20 → 모든 종목 시세 20% 하향(차액은 하우스 풀로, 총량 보존).</span>
      </div>
      <StatusMsg msg={msg} />
    </div>
  );
}

function MembersOptions() {
  const { stocks, users } = useApp();
  const { busy, msg, run } = useAction();
  const nameById = Object.fromEntries(users.map((u) => [u.id, u.name || u.id]));
  const idByName = Object.fromEntries(users.map((u) => [(u.name || '').trim(), u.id]));
  const [memEdit, setMemEdit] = useState({}); // {stockId: "이름,이름"}
  const [grant, setGrant] = useState({ stockId: '', userId: '', qty: 10 });

  const memText = (s) => (memEdit[s.id] ?? (s.members || []).map((id) => nameById[id] || id).join(', '));
  function saveMembers(s) {
    const names = String(memEdit[s.id] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const ids = names.map((n) => idByName[n]).filter(Boolean);
    const unknown = names.filter((n) => !idByName[n]);
    return run(() => upsertStock({ id: s.id, members: ids }), () => `멤버 ${ids.length}명 저장${unknown.length ? ` (못 찾음: ${unknown.join(',')})` : ''}`);
  }

  const grantStock = stocks.find((s) => s.id === grant.stockId);
  const grantMembers = (grantStock?.members || []);

  return (
    <div className="card">
      <h3>⑤ 멤버 · 스톡옵션 (자사주)</h3>

      <div className="section-title">기업 멤버 지정 — 멤버는 자사주를 매수할 수 없습니다. 이름을 쉼표로.</div>
      <table className="tbl">
        <thead><tr><th>종목</th><th>멤버(이름, 쉼표 구분)</th><th></th></tr></thead>
        <tbody>
          {stocks.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td><input style={{ width: '100%', minWidth: 220 }} value={memText(s)} onChange={(e) => setMemEdit({ ...memEdit, [s.id]: e.target.value })} placeholder="김민성, 이예성" /></td>
              <td><button className="ghost" disabled={busy} onClick={() => saveMembers(s)}>저장</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="section-title" style={{ marginTop: 16 }}>스톡옵션 지급 — 멤버에게 거래금지 자사주를 발행(하우스 풀 대납, 매도 불가).</div>
      <div className="row">
        <select value={grant.stockId} onChange={(e) => setGrant({ ...grant, stockId: e.target.value, userId: '' })}>
          <option value="">종목 선택</option>
          {stocks.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={grant.userId} onChange={(e) => setGrant({ ...grant, userId: e.target.value })} disabled={!grant.stockId}>
          <option value="">멤버 선택</option>
          {grantMembers.map((id) => <option key={id} value={id}>{nameById[id] || id}</option>)}
        </select>
        <input type="number" min="1" style={{ width: 80 }} value={grant.qty} onChange={(e) => setGrant({ ...grant, qty: e.target.value })} />
        <span className="muted">주</span>
        <button className="primary" disabled={busy || !grant.stockId || !grant.userId}
          onClick={() => run(() => grantOption(grant.stockId, grant.userId, Number(grant.qty)), (r) => `지급: ${r.qty}주 (공급가 ${r.cost.toLocaleString()}P 대납)`)}>
          스톡옵션 지급
        </button>
      </div>
      {grantStock && grantMembers.length === 0 && <p className="muted">먼저 위에서 이 종목의 멤버를 지정하세요.</p>}
      <StatusMsg msg={msg} />
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
      <InstructorEvents />
      <WeeklyBatch />
      <InstructorDashboard />
      <MembersOptions />
      <NewsAndMint />
    </div>
  );
}
