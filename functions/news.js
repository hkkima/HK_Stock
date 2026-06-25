// ─────────────────────────────────────────────────────────────
// 자동 뉴스(테마주) 엔진. index.js(배포)와 test-harness(검증)가 함께 import.
//   개별/업종(공개 sector)/특성(비공개 trait) 타겟 + 호재/악재/중립.
//   호재·악재는 ±3~8% 시세 넛지(곡선 평행이동 = base 시프트), reserve↔housePool 로 총량 보존.
//   db, FieldValue 를 인자로 받아 Admin SDK(배포·하니스) 어디서나 동작.
// ─────────────────────────────────────────────────────────────
export const NEWS_TICK_PROB = 0.14; // 장중 30분 슬롯(18틱) × 0.14 ≈ 2.5건/일
const PRICE_MIN = 0.03; const PRICE_MAX = 0.08;
const SCOPE_W = [['individual', 0.4], ['sector', 0.3], ['trait', 0.3]];
const POLARITY_W = [['good', 0.3], ['bad', 0.5], ['flat', 0.2]]; // 상승 편향 보정: 악재 비중 ↑
const HIST_CAP = 60;

export const TPL = {
  individual: {
    good: ['{기업}, 신작 대박 조짐에 매수세 몰려', '{기업} 깜짝 흑자 전환', '{기업} 대형 계약 수주', '{기업} 신규 팬덤 형성', '{기업}, 강사 극찬 후기 확산'],
    bad: ['{기업} 서버 대란에 이용자 이탈', '{기업} 핵심 멤버 잠적설', '{기업} 과제 마감 펑크 논란', '{기업} 결과물 혹평', '{기업}, 지각 이슈로 신뢰도 흔들', '{기업} 자금난설에 투자 경고', '{기업} 핵심 기능 먹통', '{기업} 평판 악화로 매도 행렬', '{기업} 내부 갈등 표면화', '{기업} 출시 연기 발표', '{기업} 어닝 쇼크', '{기업} 표절 의혹 제기'],
    flat: ['{기업} 신규 로고 공개', '{기업} 사내 간식 교체 화제', '{기업} 워크숍 단체사진 공개'],
  },
  sector: {
    good: ['{업종} 업종, 정책 호재에 동반 강세', '{업종} 시장 깜짝 성장 전망', '{업종} 테마로 자금 유입'],
    bad: ['{업종} 업종 규제 우려 확산', '{업종} 시장 위축 신호', '{업종} 테마 차익실현 매물 출회', '{업종} 업종 투자심리 급랭', '{업종} 대장주 부진에 동반 하락', '{업종} 업종 거품 논란'],
    flat: ['{업종} 업종 컨퍼런스 개최 소식'],
  },
  trait: {
    good: ['정체불명 매수세, 일부 종목 동반 급등', '숨은 테마 부각되며 특정 종목군 강세', '큰손 매집 포착, 일부 종목 들썩'],
    bad: ['특정 테마 악재설에 일부 종목 동반 약세', '소문성 매도에 일부 종목군 출렁', '갑작스런 투매로 특정 종목들 휘청', '대형 매물 출회로 일부 종목 급락', '루머 확산에 특정 종목군 패닉셀', '차익실현 쏟아지며 일부 종목 약세'],
    flat: ['일부 종목 거래량만 소폭 증가'],
  },
};

function weighted(pairs) {
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  const r = Math.random() * total; let c = 0;
  for (const [k, w] of pairs) { c += w; if (r <= c) return k; }
  return pairs[pairs.length - 1][0];
}
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function appendHist(hist, p) { const arr = Array.isArray(hist) ? hist : []; return [...arr, { p, t: Date.now() }].slice(-HIST_CAP); }

// 뉴스 1건 생성·적용. 호출 측이 토글/확률을 판단하고, 여기선 무조건 1건 생성한다.
export async function generateNews(db, FieldValue) {
  const stocksSnap = await db.collection('stocks').get();
  if (stocksSnap.empty) return { skipped: 'no-stocks' };
  const stocks = stocksSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const traitsSnap = await db.collection('stockTraits').get();
  const traitsById = Object.fromEntries(traitsSnap.docs.map((d) => [d.id, d.data().traits || []]));

  let scope = weighted(SCOPE_W);
  const polarity = weighted(POLARITY_W);

  let targets = []; let label = null; let badge = null;
  if (scope === 'sector') {
    const groups = {};
    for (const s of stocks) if (s.sector) (groups[s.sector] ||= []).push(s);
    const keys = Object.keys(groups);
    if (keys.length) { const k = pick(keys); targets = groups[k]; label = k; badge = k; }
  } else if (scope === 'trait') {
    const groups = {};
    for (const s of stocks) for (const t of (traitsById[s.id] || [])) (groups[t] ||= []).push(s);
    const keys = Object.keys(groups);
    if (keys.length) { const k = pick(keys); targets = groups[k]; label = k; badge = '테마'; } // 특성명은 숨김
  }
  if (targets.length === 0) { scope = 'individual'; targets = [pick(stocks)]; label = targets[0].name; badge = targets[0].name; }
  const tplScope = targets.length > 1 ? scope : 'individual';
  const text = pick(TPL[tplScope][polarity]).replace('{기업}', targets[0].name).replace('{업종}', label || '');
  const dir = polarity === 'good' ? 1 : polarity === 'bad' ? -1 : 0;

  const boardRef = db.doc('meta/stockBoard');
  return db.runTransaction(async (tx) => {
    const refs = targets.map((t) => db.doc(`stocks/${t.id}`));
    const [bSnap, ...sSnaps] = await Promise.all([tx.get(boardRef), ...refs.map((r) => tx.get(r))]);
    let house = bSnap.exists ? (bSnap.data().housePool || 0) : 0;
    const news = (bSnap.exists && Array.isArray(bSnap.data().news)) ? bSnap.data().news : [];
    const r = PRICE_MIN + Math.random() * (PRICE_MAX - PRICE_MIN);
    const moves = []; let totalDelta = 0;
    sSnaps.forEach((snap, i) => {
      if (!snap.exists) return;
      const s = snap.data(); const circ = s.circulating || 0;
      const cur = s.base + s.slope * circ;
      const np = dir === 0 ? cur : Math.max(1, Math.round(cur * (1 + dir * r)));
      const delta = (np - cur) * circ;
      moves.push({ ref: refs[i], s, cur, np, delta }); totalDelta += delta;
    });
    let applied = dir !== 0;
    if (dir > 0 && totalDelta > house) applied = false; // 하우스 부족 → 헤드라인만
    if (applied) {
      for (const m of moves) {
        tx.update(m.ref, { base: m.s.base + (m.np - m.cur), centerBase: (m.s.centerBase ?? m.s.base) + (m.np - m.cur), price: m.np, reserve: (m.s.reserve || 0) + m.delta, priceHistory: appendHist(m.s.priceHistory, m.np) });
      }
    }
    const entry = { text, polarity: applied ? polarity : 'flat', scope, badge, stockIds: targets.map((t) => t.id), at: Date.now() };
    // housePool 은 increment 로(틱과 충돌 방지). news 배열만 절대값 갱신.
    tx.set(boardRef, { news: [entry, ...news].slice(0, 50), housePool: FieldValue.increment(applied ? -totalDelta : 0) }, { merge: true });
    tx.set(db.collection('ledger').doc(), { type: 'news', polarity, scope, label, applied, totalDelta: applied ? totalDelta : 0, ts: FieldValue.serverTimestamp() });
    return { text, polarity: entry.polarity, scope, targets: targets.length, applied, totalDelta: applied ? totalDelta : 0 };
  });
}
